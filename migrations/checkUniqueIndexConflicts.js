/**
 * checkUniqueIndexConflicts.js — READ-ONLY pre-deploy check (2026-10).
 *
 * The 2026-10 bug fixes added unique indexes that Mongoose builds on the
 * next boot. If the live data already contains duplicates, the index
 * build fails and the race the index guards against stays open:
 *
 *   - tips    { order, restaurant } unique
 *               → one tip per order (concurrent createTipForPaidOrder)
 *   - shifts  { restaurant, staff } unique where status = 'active'
 *               → one open shift per staff member (concurrent clock-ins)
 *
 * This script only REPORTS the conflicting groups so an operator can
 * resolve them (e.g. keep the settled/oldest tip, close the extra
 * shifts). It never modifies data.
 *
 * Run from the Backend directory:
 *
 *     node migrations/checkUniqueIndexConflicts.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const CHECKS = [
    {
        collection: 'tips',
        label: 'tips sharing an order',
        match: {},
        groupBy: { order: '$order', restaurant: '$restaurant' },
    },
    {
        collection: 'shifts',
        label: 'staff with more than one active shift',
        match: { status: 'active' },
        groupBy: { restaurant: '$restaurant', staff: '$staff' },
    },
];

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    const db = mongoose.connection.db;
    let conflicts = 0;

    for (const { collection, label, match, groupBy } of CHECKS) {
        const groups = await db.collection(collection).aggregate([
            { $match: match },
            { $group: { _id: groupBy, count: { $sum: 1 }, ids: { $push: '$_id' } } },
            { $match: { count: { $gt: 1 } } },
        ]).toArray();

        if (!groups.length) {
            console.log(`✔ ${collection}: no ${label}`);
            continue;
        }
        conflicts += groups.length;
        console.log(`! ${collection}: ${groups.length} group(s) of ${label}`);
        for (const g of groups.slice(0, 50)) {
            console.log(`    ${JSON.stringify(g._id)} → ${g.count} docs: ${g.ids.join(', ')}`);
        }
        if (groups.length > 50) console.log(`    … and ${groups.length - 50} more`);
    }

    await mongoose.disconnect();
    if (conflicts) {
        console.log('\nResolve the groups above before deploying, otherwise the unique index build fails.');
        process.exit(2);
    }
    console.log('\n✔ No conflicts — the new unique indexes can be built.');
}

run().catch((err) => {
    console.error('Check failed:', err);
    process.exit(1);
});
