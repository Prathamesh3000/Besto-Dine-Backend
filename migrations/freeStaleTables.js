/**
 * freeStaleTables.js — one-shot cleanup
 *
 * Walks every table in the active tenant whose status is 'occupied' or
 * 'merged' and decides if it should actually be free. A table is
 * considered stuck if any of:
 *   • activeOrder is null/missing
 *   • activeOrder points to a non-existent doc (deleted)
 *   • the linked order is already (served && Paid)
 *   • the linked order is cancelled
 *
 * For each stuck table we run freeTableOrUnmergeGroup — same helper the
 * order flow uses — so single tables and merged groups are handled
 * uniformly. Read-only mode available with --dry to preview the list
 * before writing anything.
 *
 *   node migrations/freeStaleTables.js              # do it
 *   node migrations/freeStaleTables.js --dry        # preview only
 *   TENANT_SLUG=<slug> node migrations/freeStaleTables.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Table = require('../models/table');
const Order = require('../models/order');
const { freeTableOrUnmergeGroup } = require('../utils/tableMerge');

const DRY = process.argv.includes('--dry');

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant with slug "${slug}"`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant doc exists');
    return t;
}

async function main() {
    if (!process.env.MONGO_URL) { console.error('MONGO_URL missing'); process.exit(1); }
    await mongoose.connect(process.env.MONGO_URL);
    const tenant = await resolveTenant();
    console.log(`\n📋 Tenant: ${tenant.name}\n${DRY ? '🧪 DRY RUN — no writes\n' : ''}`);

    const tables = await Table.find({
        restaurant: tenant._id,
        status: { $in: ['occupied', 'merged'] },
    }).lean();
    console.log(`Found ${tables.length} table(s) in occupied/merged state`);

    if (tables.length === 0) { await mongoose.disconnect(); return; }

    const tf = { restaurant: tenant._id };
    const stuckList = [];
    const okList = [];

    for (const t of tables) {
        const reasons = [];

        if (!t.activeOrder) {
            reasons.push('no activeOrder linked');
        } else {
            const order = await Order.findOne({ _id: t.activeOrder, ...tf })
                .select('orderId status paymentStatus')
                .lean();
            if (!order) reasons.push('activeOrder doc missing');
            else if (order.status === 'cancelled') reasons.push(`order ${order.orderId} cancelled`);
            else if (order.status === 'served' && order.paymentStatus === 'Paid')
                reasons.push(`order ${order.orderId} served + Paid`);
        }

        if (reasons.length > 0) stuckList.push({ table: t, reasons });
        else okList.push(t);
    }

    console.log(`  • ${stuckList.length} stuck (will be freed)`);
    console.log(`  • ${okList.length} legitimately occupied (skipped)\n`);

    if (stuckList.length === 0) { await mongoose.disconnect(); return; }

    for (const { table, reasons } of stuckList) {
        console.log(`  ↳ ${table.name}  (${table.status})  — ${reasons.join(', ')}`);
    }

    if (DRY) {
        console.log('\n🧪 Dry run — re-run without --dry to apply.');
        await mongoose.disconnect();
        return;
    }

    console.log('\nFreeing stuck tables…');
    let freedCount = 0;
    for (const { table } of stuckList) {
        try {
            const { freedIds } = await freeTableOrUnmergeGroup(table._id, tf);
            freedCount += (freedIds.length || 1);
        } catch (err) {
            console.warn(`  ⚠ Failed to free ${table.name}: ${err.message}`);
        }
    }

    console.log(`\n✅ Freed ${freedCount} table id(s) across ${stuckList.length} group(s).`);
    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('freeStaleTables failed:', err);
    try { await mongoose.disconnect(); } catch { }
    process.exit(1);
});
