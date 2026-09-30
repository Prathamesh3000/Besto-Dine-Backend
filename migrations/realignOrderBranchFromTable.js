/**
 * realignOrderBranchFromTable.js
 *
 * One-shot repair for dashboards where the branch filter (e.g. "Wakad")
 * surfaces orders that clearly belong to a different branch. The usual
 * root cause is that `migrateLegacyBranchNulls.js` ran when only one
 * branch existed, sweeping every legacy null-branch order into that
 * first branch — so after a second branch was added, the first branch's
 * filter still shows all the legacy activity.
 *
 * This script uses the TABLE as the source of truth for dine-in orders:
 *
 *   If an order's table has `table.branch == X` and the order's
 *   `order.branch != X`, we set `order.branch = X`.
 *
 *   Takeaway orders (no table) are left untouched — there's no table to
 *   derive from, so their branch is whatever was stamped at creation.
 *
 * Idempotent: running it twice is a no-op.
 *
 * Usage (from the Backend/ directory):
 *     node migrations/realignOrderBranchFromTable.js          # apply
 *     node migrations/realignOrderBranchFromTable.js --dry    # preview counts only
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Order = require('../models/order');
const Table = require('../models/table');

const DRY = process.argv.includes('--dry');

async function run() {
    if (!process.env.MONGO_URL) {
        console.error('MONGO_URL not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB' + (DRY ? ' (dry-run)' : ''));

    // Pull every table with a branch assigned, build an id-to-branch map.
    const tables = await Table.find({ branch: { $ne: null } })
        .select('_id branch restaurant')
        .lean();

    const tableBranchMap = new Map(
        tables.map(t => [String(t._id), { branch: String(t.branch), restaurant: String(t.restaurant) }])
    );
    console.log(`Indexed ${tableBranchMap.size} tables with a branch`);

    // Walk every dine-in-ish order (has a table) in batches.
    const cursor = Order.find({ table: { $ne: null } })
        .select('_id table branch restaurant')
        .cursor();

    let inspected = 0;
    let changed = 0;
    const perTenantChanges = new Map(); // tenantId → count

    const BATCH = 500;
    let pending = [];
    const flush = async () => {
        if (!pending.length || DRY) { pending = []; return; }
        await Order.bulkWrite(pending, { ordered: false });
        pending = [];
    };

    for await (const o of cursor) {
        inspected++;
        const tblEntry = tableBranchMap.get(String(o.table));
        if (!tblEntry) continue;
        // Safety: never reassign across tenants.
        if (tblEntry.restaurant !== String(o.restaurant)) continue;

        const currentBranch = o.branch ? String(o.branch) : null;
        if (currentBranch === tblEntry.branch) continue;

        changed++;
        perTenantChanges.set(tblEntry.restaurant, (perTenantChanges.get(tblEntry.restaurant) || 0) + 1);

        pending.push({
            updateOne: {
                filter: { _id: o._id },
                update: { $set: { branch: new mongoose.Types.ObjectId(tblEntry.branch) } },
            },
        });

        if (pending.length >= BATCH) await flush();
    }
    await flush();

    console.log('\nSummary');
    console.log(`  inspected:   ${inspected}`);
    console.log(`  realigned:   ${changed}${DRY ? ' (dry — no writes)' : ''}`);
    for (const [tenant, n] of perTenantChanges) {
        console.log(`    tenant ${tenant}: ${n}`);
    }

    await mongoose.disconnect();
    console.log(DRY ? '\nDry run complete. Re-run without --dry to apply.' : '\nDone.');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
