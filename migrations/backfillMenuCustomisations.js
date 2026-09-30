// Backfill sizes + toppings for existing menu items that were seeded
// before customisations were part of seedMenuItems.js.
//
// - Items with NON-empty `sizes` or `toppings` are left alone.
// - Everything else gets a sensible 3-size ladder (Regular / Medium /
//   Large) priced off the item's basePrice, plus 2–4 random veg toppings
//   from a shared pool so the customer Product Details page has real
//   data to render instead of falling back to the "no customisations"
//   empty state.
//
// Usage:
//   cd Backend && node migrations/backfillMenuCustomisations.js
//
// Re-runnable: items already carrying sizes/toppings are skipped, so it's
// safe to run multiple times.

require('dotenv').config();
const mongoose = require('mongoose');
const MenuItem = require('../models/menuItem');

const TOPPING_POOL = [
    { name: 'Extra Cheese',  price: 49, type: 'veg' },
    { name: 'Lettuce',       price: 39, type: 'veg' },
    { name: 'Cheese Slice',  price: 49, type: 'veg' },
    { name: 'Olives',        price: 35, type: 'veg' },
    { name: 'Chilli Flakes', price: 10, type: 'veg' },
    { name: 'Mushroom',      price: 45, type: 'veg' },
    { name: 'Paneer',        price: 60, type: 'veg' },
    { name: 'Jalapeños',     price: 30, type: 'veg' },
];

function buildSizesFor(basePrice) {
    const base = Number(basePrice) || 100;
    return [
        { name: 'Regular', price: base,       quantity: '1' },
        { name: 'Medium',  price: base + 150, quantity: '2' },
        { name: 'Large',   price: base + 300, quantity: '3' },
    ];
}

function pickToppings() {
    const count = 2 + Math.floor(Math.random() * 3); // 2..4
    return [...TOPPING_POOL].sort(() => Math.random() - 0.5).slice(0, count);
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL not set. Aborting.');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected. Scanning menu items…');

    // Only touch items that actually lack customisations; saves the admin's
    // curated work on items they've already edited.
    const query = {
        $or: [
            { sizes: { $exists: false } },
            { sizes: { $size: 0 } },
            { toppings: { $exists: false } },
            { toppings: { $size: 0 } },
        ],
    };

    const items = await MenuItem.find(query).select('_id name basePrice sizes toppings').lean();
    console.log(`Found ${items.length} items needing backfill.`);

    let updated = 0;
    for (const item of items) {
        const update = {};
        if (!Array.isArray(item.sizes) || item.sizes.length === 0) {
            update.sizes = buildSizesFor(item.basePrice);
        }
        if (!Array.isArray(item.toppings) || item.toppings.length === 0) {
            update.toppings = pickToppings();
        }
        if (Object.keys(update).length === 0) continue;
        await MenuItem.updateOne({ _id: item._id }, { $set: update });
        updated++;
    }

    console.log(`Backfilled ${updated} items.`);
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
