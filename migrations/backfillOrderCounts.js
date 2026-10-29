/**
 * backfillOrderCounts.js
 *
 * One-shot — recomputes MenuItem.orderCount from every existing order's
 * line items. The counter is normally kept up to date by
 * orderController.bumpMenuItemOrderCounts on every order create /
 * append, so this script only needs to be run once after the
 * orderCount field is added to the schema (or any time the counts get
 * out of sync, e.g. after a manual data edit).
 *
 * Strategy:
 *   1. Reset every MenuItem's orderCount to 0 (per tenant).
 *   2. Aggregate orders → group by items.menuItem → sum quantity.
 *   3. Push the totals back to each MenuItem with a bulkWrite.
 *
 * Run:
 *   cd Backend && node migrations/backfillOrderCounts.js
 *   # optional: TENANT_SLUG=<slug>  (limits to one tenant)
 *   # optional: ALL_TENANTS=true    (fans out across every restaurant)
 *   # default = first Restaurant doc by createdAt
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const MenuItem = require('../models/menuItem');
const Order = require('../models/order');

async function backfillForTenant(tenant) {
    console.log(`\nBackfilling: ${tenant.name} (${tenant.slug || tenant._id})`);

    // 1. Reset every menu item's count for this tenant. Without this step
    // a partial earlier backfill would compound on top of itself.
    await MenuItem.updateMany(
        { restaurant: tenant._id },
        { $set: { orderCount: 0 } },
    );

    // 2. Aggregate orders → tally per menuItem id. Excludes cancelled
    // orders so a customer cancelling their order doesn't get them
    // ranked as a bestseller. (You can flip the cancelled filter if
    // your business prefers gross-orders ranking.)
    const tally = await Order.aggregate([
        { $match: {
            restaurant: tenant._id,
            status: { $ne: 'cancelled' },
        } },
        { $unwind: '$items' },
        { $match: {
            'items.menuItem': { $exists: true, $nin: [null, ''] },
        } },
        { $group: {
            _id: '$items.menuItem',
            qty: { $sum: { $ifNull: ['$items.quantity', 1] } },
        } },
    ]);

    if (tally.length === 0) {
        console.log('  (no orders — every item left at 0)');
        return { items: 0, orders: 0 };
    }

    // 3. Push the totals back. Filter out invalid ObjectIds (mock IDs,
    // legacy customisation rows that stored a non-id string).
    const ops = [];
    for (const row of tally) {
        if (!mongoose.Types.ObjectId.isValid(row._id)) continue;
        ops.push({
            updateOne: {
                filter: { _id: row._id, restaurant: tenant._id },
                update: { $set: { orderCount: row.qty } },
            },
        });
    }
    if (ops.length === 0) {
        console.log('  (no valid menuItem ids in orders — left at 0)');
        return { items: 0, orders: 0 };
    }
    const result = await MenuItem.bulkWrite(ops, { ordered: false });
    console.log(`  matched ${result.matchedCount}, modified ${result.modifiedCount} item(s) across ${ops.length} unique menuItem(s)`);
    return { items: ops.length, orders: tally.length };
}

(async () => {
    try {
        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not set in Backend/.env');
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB');

        let tenants;
        if (process.env.ALL_TENANTS === 'true') {
            tenants = await Restaurant.find({}).sort({ createdAt: 1 });
        } else if (process.env.TENANT_SLUG) {
            const t = await Restaurant.findOne({ slug: process.env.TENANT_SLUG });
            if (!t) throw new Error(`No restaurant found with slug "${process.env.TENANT_SLUG}".`);
            tenants = [t];
        } else {
            const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
            if (!t) throw new Error('No Restaurant doc exists.');
            tenants = [t];
        }

        let totalItems = 0;
        for (const t of tenants) {
            const r = await backfillForTenant(t);
            totalItems += r.items;
        }

        console.log(`\nDone. Updated ${totalItems} menu item(s) across ${tenants.length} tenant(s).`);
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Backfill error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
})();
