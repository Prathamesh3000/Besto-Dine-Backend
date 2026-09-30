/**
 * listMenuWithRecipes.js — diagnostic
 *
 * Lists every menu item in the active tenant grouped by category, and
 * shows whether each item has a recipe (✓) or not (✗). Use this to
 * pick a real item name for testing the recipe → deduction pipeline.
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const MenuItem   = require('../models/menuItem');
const Recipe     = require('../models/recipe');
require('../models/category'); // register schema for populate

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    const t = slug
        ? await Restaurant.findOne({ slug })
        : await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No tenant found');
    return t;
}

async function main() {
    await mongoose.connect(process.env.MONGO_URL);
    const tenant = await resolveTenant();
    console.log(`\n📋 Tenant: ${tenant.name}\n`);

    const items = await MenuItem.find({ restaurant: tenant._id })
        .populate('category', 'name')
        .sort({ name: 1 })
        .lean();

    const recipes = await Recipe.find({ restaurant: tenant._id }).select('menuItem ingredients').lean();
    const recipeMap = new Map(recipes.map(r => [r.menuItem.toString(), r]));

    // Group by category
    const byCategory = {};
    for (const m of items) {
        const cat = m.category?.name || '(no category)';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(m);
    }

    let total = 0, withRecipe = 0;
    for (const cat of Object.keys(byCategory).sort()) {
        console.log(`━━━ ${cat} ━━━`);
        for (const m of byCategory[cat]) {
            const r = recipeMap.get(m._id.toString());
            const mark = r ? '✓' : '✗';
            const ingCount = r ? `${r.ingredients?.length || 0} ing` : '—';
            console.log(`  ${mark} ${m.name.padEnd(40)} ₹${m.basePrice}   ${ingCount}`);
            total += 1;
            if (r) withRecipe += 1;
        }
        console.log('');
    }

    console.log(`📊 ${total} menu items · ${withRecipe} have recipes (${total - withRecipe} without)`);
    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('listMenuWithRecipes failed:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
