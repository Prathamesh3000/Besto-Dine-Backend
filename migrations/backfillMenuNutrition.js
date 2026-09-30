// Populate nutritionalInfo + healthTags + healthLevel on existing menu
// items that were seeded before those fields were part of the seed.
//
// Why: the Home page HealthMenuItem card and the ProductDetails
// nutrition strip read `item.nutritionalInfo.{calories,protein,fat,
// carbs,fibre,iron}`. Without values the card renders all zeros
// ("0g Protein", "0g Fats", ...), which looks broken even though the
// code path is correct.
//
// Safe to re-run: only touches items whose `nutritionalInfo.calories`
// is missing or 0 (admin-populated values are preserved). Skips items
// that already carry real nutrition data.
//
// Usage:
//   cd Backend && node migrations/backfillMenuNutrition.js

require('dotenv').config();
const mongoose = require('mongoose');
const MenuItem = require('../models/menuItem');

function randomNutrition() {
    const calories = 150 + Math.floor(Math.random() * 400);   // 150-550
    const protein  = 5   + Math.floor(Math.random() * 25);    // 5-30
    const fat      = 3   + Math.floor(Math.random() * 22);    // 3-25
    const carbs    = 10  + Math.floor(Math.random() * 50);    // 10-60
    const fibre    = 1   + Math.floor(Math.random() * 10);    // 1-11
    const iron     = Math.floor(Math.random() * 5);           // 0-5
    return { calories, protein, fat, carbs, fibre, iron };
}

function deriveTags(n) {
    const tags = [];
    if (n.protein >= 15)   tags.push('High Protein');
    if (n.fat <= 12)       tags.push('Healthy Fats');
    if (n.calories <= 350) tags.push('Balanced Calories');
    if (n.fibre >= 6)      tags.push('High Fibre');
    return tags;
}

function deriveLevel(n) {
    if (n.calories <= 300) return 'High';
    if (n.calories <= 450) return 'Medium';
    return 'Low';
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL not set. Aborting.');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected. Scanning menu items…');

    // Items with missing or zero calories get the full rebuild — this
    // is how "empty" looks in both Mongoose defaults and post-seed rows.
    const query = {
        $or: [
            { nutritionalInfo: { $exists: false } },
            { 'nutritionalInfo.calories': { $in: [null, 0, undefined] } },
        ],
    };

    const items = await MenuItem.find(query).select('_id name').lean();
    console.log(`Found ${items.length} items needing nutrition backfill.`);

    let updated = 0;
    for (const item of items) {
        const n = randomNutrition();
        await MenuItem.updateOne(
            { _id: item._id },
            {
                $set: {
                    nutritionalInfo: n,
                    healthTags: deriveTags(n),
                    healthLevel: deriveLevel(n),
                },
            }
        );
        updated++;
    }

    console.log(`Backfilled ${updated} items.`);
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
