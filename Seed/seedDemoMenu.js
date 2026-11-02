/**
 * seedDemoMenu.js — add a small sample menu to ONE existing demo tenant.
 *
 *   node Seed/seedDemoMenu.js <restaurant-slug>            (dry run: prints the plan)
 *   node Seed/seedDemoMenu.js <restaurant-slug> --confirm  (writes)
 *
 * Reads MONGO_URL from Backend/.env. Only ever INSERTS: a category or item
 * whose name already exists for that tenant is skipped, nothing is updated
 * or deleted, except `--fix-existing`, which moves this script's earlier
 * branch-less items onto the branch. Items go on the tenant's Main branch (the
 * oldest one, or --branch=<id>): the admin dashboard's menu KPI counts only
 * items owned by the selected branch, so branch-less items showed as 0.
 * No images are set (blank-image rule).
 */
require('dotenv').config();
// Some local resolvers refuse the SRV lookup behind mongodb+srv:// URLs
// (querySrv ECONNREFUSED). Ask public resolvers directly for this script.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

const MENU = [
    // [category, kind, name, vegType, basePrice, prepStation, extra]
    ['Starters', 'food', 'Paneer Tikka', 'veg', 220, 'kitchen', { isFeatured: true }],
    ['Starters', 'food', 'Chicken 65', 'non-veg', 260, 'kitchen', {}],
    ['Starters', 'food', 'Veg Spring Rolls', 'veg', 180, 'kitchen', {}],
    ['Mains', 'food', 'Dal Makhani', 'veg', 240, 'kitchen', {}],
    ['Mains', 'food', 'Butter Chicken', 'non-veg', 340, 'kitchen', { isFeatured: true }],
    ['Mains', 'food', 'Veg Biryani', 'veg', 260, 'kitchen', { sizes: [{ name: 'Half', price: 160 }, { name: 'Full', price: 260 }] }],
    ['Breads', 'food', 'Butter Naan', 'veg', 50, 'kitchen', {}],
    ['Breads', 'food', 'Garlic Naan', 'veg', 60, 'kitchen', {}],
    ['Beverages', 'beverages', 'Masala Chai', 'veg', 40, 'counter', {}],
    ['Beverages', 'beverages', 'Cold Coffee', 'veg', 120, 'counter', {}],
];

(async () => {
    const slug = process.argv[2];
    const confirm = process.argv.includes('--confirm');
    if (!slug || slug.startsWith('--')) {
        console.error('Usage: node Seed/seedDemoMenu.js <restaurant-slug> [--confirm]');
        process.exit(1);
    }
    if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set in Backend/.env');

    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000, family: 4, autoIndex: false });
    const restaurant = await Restaurant.findOne({ slug }).lean();
    if (!restaurant) throw new Error(`No restaurant with slug "${slug}" in database "${mongoose.connection.name}"`);
    console.log(`Database: ${mongoose.connection.name}\nTenant:   ${restaurant.name} (${restaurant.slug})\nMode:     ${confirm ? 'WRITE' : 'dry run (add --confirm to write)'}\n`);

    const branchArg = (process.argv.find((a) => a.startsWith('--branch=')) || '').slice(9);
    const branch = branchArg
        ? await Branch.findOne({ _id: branchArg, restaurant: restaurant._id }).lean()
        : await Branch.findOne({ restaurant: restaurant._id }).sort({ createdAt: 1 }).lean();
    if (!branch) throw new Error('No branch found for this tenant');
    console.log(`Branch:   ${branch.name} (${branch._id})
`);

    const cats = {};
    let order = 1;
    for (const [catName, kind] of [...new Set(MENU.map((m) => `${m[0]}|${m[1]}`))].map((s) => s.split('|'))) {
        let cat = await Category.findOne({ restaurant: restaurant._id, name: catName });
        if (cat) {
            console.log(`category exists:  ${catName}`);
        } else if (confirm) {
            cat = await Category.create({ restaurant: restaurant._id, branch: null, name: catName, kind, displayOrder: order });
            console.log(`category created: ${catName}`);
        } else {
            console.log(`would create category: ${catName}`);
        }
        cats[catName] = cat;
        order += 1;
    }

    for (const [catName, , name, vegType, basePrice, prepStation, extra] of MENU) {
        const cat = cats[catName];
        const exists = cat && await MenuItem.findOne({ restaurant: restaurant._id, category: cat._id, name });
        if (exists) {
            if (process.argv.includes('--fix-existing') && !exists.branch) {
                if (confirm) await MenuItem.updateOne({ _id: exists._id }, { $set: { branch: branch._id } });
                console.log(`${confirm ? 'moved to branch' : 'would move to branch'}: ${name}`);
            } else {
                console.log(`item exists:      ${name}`);
            }
            continue;
        }
        if (!confirm) { console.log(`would create item: ${name} (₹${basePrice})`); continue; }
        await MenuItem.create({
            restaurant: restaurant._id,
            branch: branch._id,
            category: cat._id,
            name,
            description: `${name} — demo item`,
            vegType,
            basePrice,
            prepStation,
            prepTimeMinutes: prepStation === 'kitchen' ? 20 : 5,
            inStock: true,
            status: 'active',
            ...extra,
        });
        console.log(`item created:     ${name} (₹${basePrice})`);
    }
    await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
