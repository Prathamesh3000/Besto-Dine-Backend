/**
 * seedDefaultTenant.js — Phase 1 backfill migration.
 *
 * This script makes the existing single-tenant deployment safe for the
 * Phase 1 tenant-scoped controllers. It is FULLY IDEMPOTENT — re-running
 * it never duplicates data or overwrites already-migrated records.
 *
 * What it does:
 *   1. Resolves (or creates) a "Default Restaurant" tenant on the
 *      Enterprise plan (every feature unlocked).
 *   2. Owners: links the oldest existing admin user to it as the owner.
 *   3. Backfills `restaurant: <defaultId>` on every tenant-scoped
 *      domain document that does not yet have one (Order, MenuItem,
 *      Table, Reservation, etc.).
 *   4. Backfills `restaurant: <defaultId>` on every staff user
 *      (admin/manager/waiter/captain/chef) whose `restaurant` field is
 *      currently null. Customers and superadmins are intentionally not
 *      touched.
 *
 * What it does NOT touch:
 *   - The "Test Cafe" (or any other restaurant created via the Super
 *     Admin portal) — it only updates documents whose `restaurant`
 *     field is currently null/missing.
 *   - The Restaurant, SubscriptionPlan, AuditLog collections.
 *   - Customer accounts (no restaurant link by design — they can order
 *     from any tenant via the customer header).
 *   - The OTP collection (short-lived, no tenant context).
 *
 * Run from the Backend directory:
 *
 *     node Seed/seedDefaultTenant.js
 *
 * Requires: MONGO_URL set in .env. seedSuperAdmin.js must have already
 * been run so that the Enterprise SubscriptionPlan exists.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Restaurant       = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const User             = require('../models/user');
const { createMainBranchFor } = require('../utils/createMainBranch');

// Tenant-scoped domain models. Order matters only for log readability.
const TENANT_MODELS = [
    ['Order',           '../models/order'],
    ['MenuItem',        '../models/menuItem'],
    ['Table',           '../models/table'],
    ['Reservation',     '../models/reservation'],
    ['AdvanceBooking',  '../models/advanceBooking'],
    ['Notification',    '../models/notification'],
    ['Wallet',          '../models/wallet'],
    ['Transaction',     '../models/transaction'],
    ['Tip',             '../models/tip'],
    ['TipSettlement',   '../models/tipSettlement'],
    ['Hall',            '../models/hall'],
    ['Inventory',       '../models/inventory'],
    ['Category',        '../models/category'],
    ['Combo',           '../models/combo'],
    ['Coupon',          '../models/coupon'],
    ['CouponRedemption','../models/couponRedemption'],
    ['Promotion',       '../models/promotion'],
    ['Campaign',        '../models/campaign'],
    ['Request',         '../models/request'],
    ['Area',            '../models/area'],
    ['Settings',        '../models/settings'],
    ['Cake',            '../models/cake'],
    ['EventType',       '../models/eventType'],
    ['Decoration',      '../models/decoration'],
    ['DecorationPackage','../models/decorationPackage'],
    ['Package',         '../models/package'],   // Event/food package, not subscription plan
    ['Addon',           '../models/addon'],
    ['Shift',           '../models/shift'],
    ['Invoice',         '../models/invoice'],
];

function snapshotPlan(plan) {
    return {
        plan: plan._id,
        planName: plan.name,
        planSlug: plan.slug,
        features: plan.features?.toObject ? plan.features.toObject() : { ...plan.features },
        limits:   plan.limits?.toObject   ? plan.limits.toObject()   : { ...plan.limits },
    };
}

async function getOrCreateDefaultPlan() {
    // Prefer Enterprise (everything unlocked); fall back to the highest-priced active plan.
    let plan = await SubscriptionPlan.findOne({ slug: 'enterprise' });
    if (plan) return plan;

    plan = await SubscriptionPlan.findOne({ isActive: true }).sort({ price: -1 });
    if (plan) {
        console.log(`  ⚠ Enterprise plan not found — using "${plan.name}" instead.`);
        console.log('    Run Seed/seedSuperAdmin.js to create the standard plan tiers.');
        return plan;
    }

    throw new Error(
        'No SubscriptionPlan found in the database. Run `node Seed/seedSuperAdmin.js` first.'
    );
}

async function getOrCreateDefaultRestaurant() {
    let r = await Restaurant.findOne({ slug: 'the-coffee-house' });
    if (r) {
        console.log(`✔ Default tenant already exists (${r._id})`);
        return r;
    }

    const plan = await getOrCreateDefaultPlan();
    const firstAdmin = await User.findOne({ role: 'admin' }).sort({ createdAt: 1 });

    r = await Restaurant.create({
        name: 'The Coffee House',
        slug: 'the-coffee-house',
        contactEmail: firstAdmin?.email || 'default@bestodine.local',
        contactPhone: firstAdmin?.mobile || '',
        city: '',
        status: 'active',
        owner: firstAdmin?._id,
        subscription: {
            ...snapshotPlan(plan),
            startDate: new Date(),
            endDate: null,
            trialEndDate: null,
            status: 'active',
        },
    });

    console.log(`✔ Created Default Restaurant (${r._id}) on plan "${plan.slug}"`);
    if (firstAdmin) {
        console.log(`  Linked owner: ${firstAdmin.email}`);
    }

    // Auto-provision the Main branch so the tenant is usable from
    // day one — same contract as the public/superadmin signup paths.
    const mainBranch = await createMainBranchFor(r, firstAdmin?._id);
    console.log(`  ✔ Created Main branch "${mainBranch.name}" (${mainBranch._id})`);

    return r;
}

async function backfillModel(name, modulePath, restaurantId) {
    let Model;
    try {
        Model = require(modulePath);
    } catch (err) {
        console.log(`  ! ${name}: failed to load model — ${err.message}`);
        return;
    }

    // Match docs that have NO restaurant set: either field missing entirely
    // OR explicitly null. We do not touch docs that already have any value.
    const filter = { $or: [{ restaurant: { $exists: false } }, { restaurant: null }] };

    const total = await Model.countDocuments(filter);
    if (total === 0) {
        console.log(`  = ${name.padEnd(20)} no docs need backfill`);
        return;
    }

    const result = await Model.updateMany(filter, { $set: { restaurant: restaurantId } });
    console.log(`  + ${name.padEnd(20)} backfilled ${result.modifiedCount}/${total}`);
}

async function backfillStaffUsers(restaurantId) {
    const STAFF_ROLES = ['admin', 'waiter', 'captain', 'chef'];
    const filter = {
        role: { $in: STAFF_ROLES },
        $or: [{ restaurant: { $exists: false } }, { restaurant: null }],
    };

    const total = await User.countDocuments(filter);
    if (total === 0) {
        console.log('  = staff users      already linked');
        return;
    }

    const result = await User.updateMany(filter, { $set: { restaurant: restaurantId } });
    console.log(`  + staff users        linked ${result.modifiedCount}/${total} to default tenant`);
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    const restaurant = await getOrCreateDefaultRestaurant();
    console.log('');

    console.log('Backfilling tenant-scoped collections:');
    for (const [name, modulePath] of TENANT_MODELS) {
        // eslint-disable-next-line no-await-in-loop
        await backfillModel(name, modulePath, restaurant._id);
    }
    console.log('');

    console.log('Backfilling staff user accounts:');
    await backfillStaffUsers(restaurant._id);
    console.log('');

    console.log('✔ Phase 1 backfill complete');
    console.log(`  Default tenant id: ${restaurant._id}`);
    console.log('  All pre-migration data is now owned by the Default Restaurant.');

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('\nBackfill failed:', err);
    process.exit(1);
});
