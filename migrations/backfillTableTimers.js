/**
 * backfillTableTimers.js
 *
 * Gives tables that are occupied RIGHT NOW (with confirmed open orders) a
 * table timer, after the table-timer feature is deployed: sets
 * Table.sessionStartedAt to the createdAt of the earliest open confirmed
 * order with items (awaiting-payment / cancelled / empty orders ignored) and
 * creates the matching TableSession row.
 *
 * DRY RUN by default - prints what it would do and writes nothing.
 *
 * Run:
 *   cd Backend && node migrations/backfillTableTimers.js            # dry run
 *   cd Backend && node migrations/backfillTableTimers.js --apply    # write
 *   # optional: TENANT_SLUG=<slug> limits to one tenant
 *
 * Idempotent: tables that already carry a timer are skipped. Take a
 * mongodump before --apply on production.
 */
const path = require('path');
const mongoose = require('mongoose');

const OPEN_STATUSES = ['new', 'preparing', 'ready', 'served'];

/**
 * @param {{ apply?: boolean, restaurantId?: any }} opts
 * @returns {Promise<{ apply: boolean, scanned: number, planned: number, written: number, plans: object[] }>}
 */
async function backfillTableTimers({ apply = false, restaurantId = null } = {}) {
    const Table = require('../models/table');
    const Order = require('../models/order');
    const TableSession = require('../models/tableSession');
    const { planBackfill } = require('../utils/tableTimer');

    const tableFilter = {
        status: { $in: ['occupied', 'merged', 'alert'] },
        isDeleted: { $ne: true },
        sessionStartedAt: null,
        ...(restaurantId ? { restaurant: restaurantId } : {}),
    };
    // Backfill is a platform task: read across tenants explicitly.
    const { runAsSystem } = require('../utils/tenantSafe');
    return runAsSystem('backfill table timers (migration)', async () => {
        const tables = await Table.find(tableFilter).select('+sessionStartedAt restaurant branch status mergedWith').lean();
        const out = { apply: !!apply, scanned: tables.length, planned: 0, written: 0, plans: [] };
        const done = new Set();
        for (const t of tables) {
            if (done.has(String(t._id))) continue;
            const group = [t._id, ...(t.mergedWith || [])];
            group.forEach((g) => done.add(String(g)));
            const orders = await Order.find({
                table: { $in: group }, restaurant: t.restaurant, status: { $in: OPEN_STATUSES },
            }).select('status items createdAt').lean();
            const plan = planBackfill(t, orders);
            if (!plan) continue;
            out.planned += 1;
            out.plans.push({ table: String(t._id), startedAt: plan.startedAt, orderCount: plan.orderCount });
            if (!apply) continue;
            try {
                const _id = new mongoose.Types.ObjectId();
                await TableSession.create({
                    _id, restaurant: t.restaurant, branch: t.branch || null, table: t._id,
                    startedAt: plan.startedAt, firstOrder: plan.firstOrder, orderCount: plan.orderCount,
                });
                const upd = await Table.updateOne(
                    { _id: t._id, sessionStartedAt: null },
                    { $set: { sessionStartedAt: plan.startedAt, tableSession: _id } },
                );
                if (upd.modifiedCount) out.written += 1;
                else await TableSession.deleteOne({ _id, restaurant: t.restaurant });
            } catch (err) {
                if (err && err.code !== 11000) throw err; // an open session already exists: skip
            }
        }
        return out;
    });
}

module.exports = { backfillTableTimers };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
    const apply = process.argv.includes('--apply');
    (async () => {
        await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);
        let restaurantId = null;
        if (process.env.TENANT_SLUG) {
            const Restaurant = require('../models/restaurant');
            const r = await Restaurant.findOne({ slug: process.env.TENANT_SLUG }).select('_id').lean();
            if (!r) throw new Error(`Unknown TENANT_SLUG ${process.env.TENANT_SLUG}`);
            restaurantId = r._id;
        }
        const res = await backfillTableTimers({ apply, restaurantId });
        console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: scanned ${res.scanned} occupied tables, ${res.planned} need a timer, ${res.written} written`);
        for (const p of res.plans) console.log(`  table ${p.table}: start ${new Date(p.startedAt).toISOString()} (${p.orderCount} orders)`);
        if (!apply) console.log('Nothing written. Re-run with --apply to write.');
        await mongoose.disconnect();
    })().catch((e) => { console.error(e); process.exit(1); });
}
