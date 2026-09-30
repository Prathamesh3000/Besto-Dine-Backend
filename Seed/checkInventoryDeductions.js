/**
 * checkInventoryDeductions.js — diagnostic script.
 *
 * Walks the active tenant and reports:
 *   1. Recent orders + their inventoryDeducted flag
 *   2. Inventory items whose adjustmentHistory contains a 'usage' entry
 *      (= auto-deduction fired) — newest first, with which order
 *      triggered each deduction.
 *
 * Read-only. Safe to run any time. No side effects.
 *
 *     node Seed/checkInventoryDeductions.js
 *     TENANT_SLUG=<slug> node Seed/checkInventoryDeductions.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Inventory = require('../models/inventory');
const Order = require('../models/order');

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}"`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant doc exists.');
    return t;
}

async function main() {
    if (!process.env.MONGO_URL) {
        console.error('MONGO_URL not set'); process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    const tenant = await resolveTenant();
    console.log(`\n📋 Tenant: ${tenant.name} (${tenant.slug || tenant._id})\n`);

    // ── 1) Recent orders ──────────────────────────────────────────────
    const orders = await Order.find({ restaurant: tenant._id })
        .sort({ createdAt: -1 })
        .limit(15)
        .select('orderId status type total inventoryDeducted inventoryDeductedAt items createdAt')
        .lean();

    console.log('━━━ Recent orders (latest 15) ━━━');
    if (orders.length === 0) {
        console.log('  (no orders for this tenant)\n');
    } else {
        for (const o of orders) {
            const flag = o.inventoryDeducted ? '✅ deducted' : '⛔ not yet';
            const when = o.inventoryDeductedAt ? new Date(o.inventoryDeductedAt).toLocaleString() : '—';
            const itemsSummary = (o.items || []).map(i => `${i.name}×${i.quantity}`).join(', ');
            console.log(`  ${o.orderId}  status=${o.status}  ${flag}  at ${when}`);
            console.log(`     items: ${itemsSummary}`);
        }
        console.log('');
    }

    // ── 2) Inventory rows with usage history ──────────────────────────
    const invs = await Inventory.find({
        restaurant: tenant._id,
        'adjustmentHistory.type': 'usage',
    }).lean();

    console.log('━━━ Inventory items with auto-deductions ━━━');
    if (invs.length === 0) {
        console.log('  ⚠ No inventory item has a `type: usage` history entry yet.');
        console.log('     → deduction has never fired for this tenant.\n');
    } else {
        // Sort by most recent usage
        const sorted = invs
            .map(inv => {
                const usages = (inv.adjustmentHistory || []).filter(a => a.type === 'usage');
                const latest = usages.reduce((max, u) => (!max || u.date > max.date ? u : max), null);
                return { inv, usages, latest };
            })
            .sort((a, b) => (b.latest?.date || 0) - (a.latest?.date || 0));

        for (const { inv, usages, latest } of sorted) {
            console.log(`  • ${inv.name}  current=${inv.currentStock} ${inv.unit}  status=${inv.status}`);
            console.log(`     ${usages.length} usage event(s); latest at ${new Date(latest.date).toLocaleString()}`);
            // Show last 3 usage events
            for (const u of usages.slice(-3).reverse()) {
                console.log(`       - ${new Date(u.date).toLocaleString()}  −${u.quantity} ${inv.unit}  (${u.previousStock}→${u.newStock})  ${u.reason || ''}`);
            }
        }
        console.log('');
    }

    // ── 3) Summary ────────────────────────────────────────────────────
    const totalUsageEvents = invs.reduce((sum, i) =>
        sum + (i.adjustmentHistory || []).filter(a => a.type === 'usage').length, 0);
    const ordersDeducted = orders.filter(o => o.inventoryDeducted).length;

    console.log('📊 Summary');
    console.log(`   Recent orders:           ${orders.length}`);
    console.log(`   ↳ with inventoryDeducted=true: ${ordersDeducted}`);
    console.log(`   Inventory items hit:     ${invs.length}`);
    console.log(`   Total usage events:      ${totalUsageEvents}`);

    if (orders.length > 0 && ordersDeducted === 0) {
        console.log('\n⚠ No order has triggered deduction. Possible reasons:');
        console.log('     - The chef hasn\'t pressed "Start Preparing" on any order yet.');
        console.log('     - The order moved straight from `new` → `served` (skipping `preparing`).');
        console.log('     - Backend wasn\'t restarted after the recent code changes.');
    } else if (orders.length === 0) {
        console.log('\nℹ No orders exist. Place a test order, move it to "preparing", then re-run.');
    } else if (totalUsageEvents > 0) {
        console.log('\n✅ Auto-deduction is working — recipe → inventory pipeline is live.');
    }

    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('checkInventoryDeductions failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
