// Assign the tenant's main branch to any Coupon whose `branch` is null.
//
// Why: the current createCoupon flow stamps `branch = mainBranchId` when
// the tenant owner creates a coupon without a specific branch pin, so
// branch-scoped customer reads (mergedCustomerBranchFilter) match it.
// Coupons that pre-date that logic are still stored with `branch: null`
// and therefore never show up for a customer who has picked a branch
// — the Cart's "Available Coupons" section silently stays empty.
//
// Runs per-tenant so each legacy coupon is pointed at THAT tenant's
// main branch (not a cross-tenant shared branch id). Re-runnable: only
// touches coupons where branch is null.
//
// Usage:
//   cd Backend && node migrations/backfillCouponBranch.js

require('dotenv').config();
const mongoose = require('mongoose');
const Coupon = require('../models/coupon');
const Branch = require('../models/branch');

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL not set. Aborting.');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected. Scanning coupons with branch=null…');

    // Unique tenants that still own null-branch coupons.
    const tenantIds = await Coupon.distinct('restaurant', { branch: null });
    console.log(`Found ${tenantIds.length} tenant(s) with legacy coupons to backfill.`);

    let totalUpdated = 0;
    for (const tenantId of tenantIds) {
        // Resolve THIS tenant's main branch (slug='main' preferred, else
        // oldest active branch — same semantics as utils/mainBranch.js).
        let main = await Branch.findOne({
            restaurant: tenantId,
            isActive: true,
            slug: 'main',
        }).select('_id').lean();
        if (!main) {
            main = await Branch.findOne({
                restaurant: tenantId,
                isActive: true,
            }).sort({ createdAt: 1 }).select('_id').lean();
        }
        if (!main) {
            console.warn(`Tenant ${tenantId}: no active branch found — skipping.`);
            continue;
        }

        const result = await Coupon.updateMany(
            { restaurant: tenantId, branch: null },
            { $set: { branch: main._id } }
        );
        console.log(`Tenant ${tenantId} → branch ${main._id}: updated ${result.modifiedCount} coupon(s).`);
        totalUpdated += result.modifiedCount;
    }

    console.log(`Done. Total coupons backfilled: ${totalUpdated}.`);
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
