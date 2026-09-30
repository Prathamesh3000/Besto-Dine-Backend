/**
 * Re-stamp tenant-null catalog records onto each tenant's Main branch.
 *
 * Why: Legacy data was seeded with `branch: null` ("shared with all
 * branches"). After moving to strict per-branch isolation, that "shared
 * shelf" no longer surfaces in any branch's view — but the records
 * themselves are still referenced by Main's tables (e.g. Main tables
 * point at null-branch areas, so the Tables tab shows tables with no
 * matching Area row in the Areas tab).
 *
 * The fix: those tenant-null records were originally Main's data.
 * Re-stamp them with `branch: mainId` so Main's tables, menu items, etc.
 * resolve properly. Other branches stay clean — they only see the data
 * they explicitly opted into via "Copy from Main" at branch create.
 *
 * Models touched (only catalog-style records, NOT operational ones like
 * orders/reservations/refunds/notifications):
 *   Area, Hall, Category, Combo, Coupon, Promotion, Campaign,
 *   EventType, Package, DecorationPackage, Addon
 *
 * Idempotent — safe to re-run; no-ops after the first successful pass.
 * Skips tenants that don't have a Main branch.
 *
 * Run: node migrations/migrateNullCatalogsToMain.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');

const Area = require('../models/area');
const Hall = require('../models/hall');
const Category = require('../models/category');
const Combo = require('../models/combo');
const Coupon = require('../models/coupon');
const Promotion = require('../models/promotion');
const Campaign = require('../models/campaign');
const EventType = require('../models/eventType');
const Package = require('../models/package');
const DecorationPackage = require('../models/decorationPackage');
const Addon = require('../models/addon');
const MenuItem = require('../models/menuItem');
const AdvanceBooking = require('../models/advanceBooking');
const Notification = require('../models/notification');
const Request = require('../models/request');
const Transaction = require('../models/transaction');

const MODELS = [
    { name: 'Area',              Model: Area },
    { name: 'Hall',              Model: Hall },
    { name: 'Category',          Model: Category },
    { name: 'Combo',             Model: Combo },
    { name: 'Coupon',            Model: Coupon },
    { name: 'Promotion',         Model: Promotion },
    { name: 'Campaign',          Model: Campaign },
    { name: 'EventType',         Model: EventType },
    { name: 'Package',           Model: Package },
    { name: 'DecorationPackage', Model: DecorationPackage },
    { name: 'Addon',             Model: Addon },
    // MenuItem added 2026-05-20 — original migration omitted it, so
    // 172 null-branch menu items were still leaking into every branch
    // view (dashboard menu count, customer-facing /menu, etc.). After
    // the re-stamp they belong to Main, and per-branch admins only
    // see them via explicit branchPrices opt-in (Copy from Main).
    { name: 'MenuItem',          Model: MenuItem },
    // AdvanceBooking added 2026-05-20 — Main dashboard's "Bookings"
    // panel was empty because 8 of 9 bookings were still at
    // branch:null. Re-stamping to Main makes them visible in Main's
    // dashboard like other historical Main data.
    { name: 'AdvanceBooking',    Model: AdvanceBooking },
    // Operational tables — pre-Phase-6 records were written without a
    // branch field. Re-stamp them to Main so the tenant owner's
    // historical view actually reflects what happened. Branch-pinned
    // admins are unaffected (their pin is server-authoritative and
    // these records weren't tagged to their branches anyway).
    { name: 'Notification',      Model: Notification },
    { name: 'Request',           Model: Request },
    { name: 'Transaction',       Model: Transaction },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URL);

    const tenants = await Restaurant.find().select('_id name slug').lean();
    console.log(`Found ${tenants.length} tenants. Restamping null catalogs onto each tenant's Main branch...\n`);

    for (const t of tenants) {
        const main = await Branch.findOne({ restaurant: t._id, slug: 'main', isActive: true }).select('_id').lean();
        if (!main) {
            console.log(`⚠️  ${t.slug || t._id} — no Main branch, skipping`);
            continue;
        }

        console.log(`Tenant: ${t.name} (${t.slug || t._id})`);
        console.log(`  Main branch: ${main._id}`);

        for (const { name, Model } of MODELS) {
            const res = await Model.updateMany(
                { restaurant: t._id, branch: null },
                { $set: { branch: main._id } }
            );
            if (res.modifiedCount > 0) {
                console.log(`  ${name.padEnd(20)} ${res.modifiedCount} record(s) → Main`);
            }
        }
        console.log('');
    }

    await mongoose.disconnect();
    console.log('Done.');
})().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
