/**
 * Drop the legacy `{ slug, restaurant }` unique index on the `addons`
 * collection and replace it with `{ slug, restaurant, branch }`.
 *
 * Same shape as `migrations/migrateCategoryIndex.js`. Idempotent — safe to
 * re-run; fresh DBs pick up the new index from the schema on first
 * connect and skip the drop step here.
 *
 * Run: node migrations/migrateAddonIndex.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Addon = require('../models/addon');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const coll = Addon.collection;
    const indexes = await coll.indexes();
    console.log('Current indexes:');
    indexes.forEach(i => console.log(' -', i.name, JSON.stringify(i.key), 'unique?', !!i.unique));

    const legacy = indexes.find(i =>
        i.unique &&
        i.key &&
        Object.keys(i.key).length === 2 &&
        i.key.slug === 1 &&
        i.key.restaurant === 1
    );
    if (legacy) {
        console.log(`Dropping legacy index "${legacy.name}"...`);
        await coll.dropIndex(legacy.name);
        console.log('  → dropped.');
    } else {
        console.log('No legacy { slug, restaurant } unique index — nothing to drop.');
    }

    console.log('Ensuring { slug, restaurant, branch } unique index...');
    await Addon.syncIndexes();
    const after = await coll.indexes();
    console.log('Indexes after migration:');
    after.forEach(i => console.log(' -', i.name, JSON.stringify(i.key), 'unique?', !!i.unique));

    await mongoose.disconnect();
    console.log('Done.');
})().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
