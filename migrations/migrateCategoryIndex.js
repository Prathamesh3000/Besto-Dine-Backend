/**
 * Drop the legacy `{ name: 1, restaurant: 1 }` unique index on the
 * `categories` collection and replace it with `{ name, restaurant, branch }`.
 *
 * Why: Per-branch isolation requires each branch to own its own copy of
 * shared categories ("Beverages" at FC Road is independent from
 * "Beverages" at Wakad). The old index blocked that.
 *
 * Idempotent — safe to re-run. The Mongoose schema also declares the new
 * index, so a fresh DB picks it up on first connect; this script handles
 * the migration path for tenants whose DB pre-dates the change.
 *
 * Run: node migrations/migrateCategoryIndex.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/category');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const coll = Category.collection;

    // List current indexes
    const indexes = await coll.indexes();
    console.log('Current indexes:');
    indexes.forEach(i => console.log(' -', i.name, JSON.stringify(i.key), 'unique?', !!i.unique));

    // Drop the legacy unique index if present (Mongo named it
    // `name_1_restaurant_1` by default).
    const legacy = indexes.find(i =>
        i.unique &&
        i.key &&
        Object.keys(i.key).length === 2 &&
        i.key.name === 1 &&
        i.key.restaurant === 1
    );
    if (legacy) {
        console.log(`Dropping legacy index "${legacy.name}"...`);
        await coll.dropIndex(legacy.name);
        console.log('  → dropped.');
    } else {
        console.log('No legacy { name, restaurant } unique index found — nothing to drop.');
    }

    // Ensure the new index exists. syncIndexes() reads the schema's
    // declared indexes and creates anything missing.
    console.log('Ensuring { name, restaurant, branch } unique index...');
    await Category.syncIndexes();
    const after = await coll.indexes();
    console.log('Indexes after migration:');
    after.forEach(i => console.log(' -', i.name, JSON.stringify(i.key), 'unique?', !!i.unique));

    await mongoose.disconnect();
    console.log('Done.');
})().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
