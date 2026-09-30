/**
 * closeStaleTableRequests.js
 *
 * One-shot cleanup for service requests (Water / Call Waiter / Bill /
 * Other) that are stuck in pending/accepted state on tables that are
 * already FREE. The dashboard's Customer Requests card pulls every
 * pending+accepted request regardless of table status, so these orphans
 * show up there forever with timestamps like "9899 min ago".
 *
 * Forward fix already landed in utils/tableMerge.js — every future
 * table-free path now soft-closes its outstanding requests. This script
 * just sweeps the docs that pre-date that fix.
 *
 * Soft-close semantics: status → 'completed', completedAt → now. Matches
 * the runtime cleanup so the audit trail stays consistent (who asked,
 * who attended, when it was wrapped).
 *
 * Idempotent: running it twice is a no-op once every free table's
 * requests are completed.
 *
 * Usage:
 *   cd Backend && node migrations/closeStaleTableRequests.js          # apply
 *   cd Backend && node migrations/closeStaleTableRequests.js --dry    # preview only
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Restaurant = require('../models/restaurant');
const Table      = require('../models/table');
const Request    = require('../models/request');

const DRY = process.argv.includes('--dry');

async function run() {
    if (!process.env.MONGO_URL) {
        console.error('❌ MONGO_URL not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✓ Connected to MongoDB');
    console.log(DRY ? '🔍 DRY RUN — no writes will be made\n' : '✏️  APPLYING changes\n');

    const tenants = await Restaurant.find({}).select('_id name').lean();
    console.log(`Found ${tenants.length} tenant(s).\n`);

    const summary = [];

    for (const t of tenants) {
        // Tables that are currently free (i.e. nobody is sitting at
        // them, so any open service request is by definition stale).
        const freeTables = await Table.find({
            restaurant: t._id,
            status: 'free',
        }).select('_id name').lean();

        if (freeTables.length === 0) {
            console.log(`— "${t.name}": no free tables, skipping.`);
            summary.push({ tenant: t.name, freeTables: 0, closed: 0 });
            continue;
        }

        const tableIds = freeTables.map(x => x._id);

        // Find the stuck requests so we can show what we're closing.
        const stale = await Request.find({
            restaurant: t._id,
            table: { $in: tableIds },
            status: { $in: ['pending', 'accepted'] },
        })
            .select('_id type status table createdAt')
            .populate('table', 'name')
            .lean();

        console.log(`▶ "${t.name}": ${freeTables.length} free tables, ${stale.length} stale request(s)`);
        for (const r of stale) {
            const ageMs = Date.now() - new Date(r.createdAt).getTime();
            const ageHours = (ageMs / 1000 / 60 / 60).toFixed(1);
            console.log(`      · ${(r.type || '').padEnd(7)} on ${r.table?.name || '—'} (${r.status}, ${ageHours}h old)`);
        }

        if (stale.length === 0) {
            summary.push({ tenant: t.name, freeTables: freeTables.length, closed: 0 });
            console.log();
            continue;
        }

        if (DRY) {
            console.log(`    would close ${stale.length}`);
        } else {
            const r = await Request.updateMany(
                {
                    restaurant: t._id,
                    table: { $in: tableIds },
                    status: { $in: ['pending', 'accepted'] },
                },
                { $set: { status: 'completed', completedAt: new Date() } }
            );
            console.log(`    ✓ closed ${r.modifiedCount}`);
        }

        summary.push({
            tenant: t.name,
            freeTables: freeTables.length,
            closed: stale.length,
        });
        console.log();
    }

    console.log('━'.repeat(60));
    console.log('SUMMARY');
    console.log('━'.repeat(60));
    for (const s of summary) {
        console.log(`  ${s.tenant.padEnd(30)} free-tables=${s.freeTables} closed=${s.closed}`);
    }
    if (DRY) console.log('\n🔍 DRY RUN — re-run without --dry to apply.');

    await mongoose.disconnect();
}

run().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
