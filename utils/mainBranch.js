/**
 * Main-branch inheritance helpers.
 *
 * "Main branch" = the tenant's primary location. Resolution order:
 *   1. The branch with `slug === 'main'` (auto-provisioned by
 *      utils/createMainBranch.js on tenant signup) — this is the
 *      authoritative marker for new tenants and any tenant repaired
 *      by migrations/backfillMainBranch.js.
 *   2. Fallback: the oldest active branch (legacy convention used by
 *      migrations/migrateLegacyBranchNulls.js — kept for tenants that
 *      pre-date the auto-Main feature and have not been backfilled).
 *
 * Sub-branches inherit shared config (Offers, wallet/tax/reservation
 * Settings, CRM visibility) from this branch; the tenant owner is not
 * affected.
 */

const Branch = require('../models/branch');
const { tenantId, pinnedBranchId } = require('./tenantScope');

// Resolve the main branch id for the current request's tenant.
// Cached on req so a single HTTP request never issues this lookup
// more than once.
async function getMainBranchId(req) {
    if (req && req._mainBranchIdCached !== undefined) {
        return req._mainBranchIdCached;
    }
    const rid = tenantId(req);
    if (!rid) {
        if (req) req._mainBranchIdCached = null;
        return null;
    }
    // Prefer the explicitly-marked main branch.
    let main = await Branch.findOne({
        restaurant: rid,
        isActive: true,
        slug: 'main',
    }).select('_id').lean();
    // Legacy fallback — oldest active branch (for tenants that
    // existed before the auto-Main feature and weren't backfilled).
    if (!main) {
        main = await Branch.findOne({
            restaurant: rid,
            isActive: true,
        }).sort({ createdAt: 1 }).select('_id').lean();
    }
    const id = main?._id || null;
    if (req) req._mainBranchIdCached = id;
    return id;
}

// Merged branch filter for reads: a sub-branch caller sees both their
// own branch's docs AND the main branch's docs. Tenant owner (unpinned)
// returns `{}` (no branch filter — they see everything). Use this for
// Offer/Coupon admin reads and CRM scoping so sub-branches inherit
// from main while still seeing their own local data.
async function mergedBranchFilter(req) {
    const pinned = pinnedBranchId(req);
    if (!pinned) return {};
    const main = await getMainBranchId(req);
    if (main && String(main) !== String(pinned)) {
        return { branch: { $in: [pinned, main] } };
    }
    return { branch: pinned };
}

// Customer-side merged filter: like mergedBranchFilter, but also
// handles the guest/customer case where the branch is resolved from
// req.branch (X-Branch-Id header) instead of a staff pin.
async function mergedCustomerBranchFilter(req) {
    const pinned = pinnedBranchId(req);
    if (pinned) {
        const main = await getMainBranchId(req);
        if (main && String(main) !== String(pinned)) {
            return { branch: { $in: [pinned, main] } };
        }
        return { branch: pinned };
    }
    const role = req?.user?.role;
    const isStaff = role && role !== 'customer';
    if (!isStaff && req?.branch?._id) {
        const selected = req.branch._id;
        const main = await getMainBranchId(req);
        if (main && String(main) !== String(selected)) {
            return { branch: { $in: [selected, main] } };
        }
        return { branch: selected };
    }
    return {};
}

// True when the caller is pinned to a branch that is NOT the main
// branch. Used by Settings to decide whether to inherit or to write
// to the caller's own doc.
async function isSubBranchCaller(req) {
    const pinned = pinnedBranchId(req);
    if (!pinned) return false;
    const main = await getMainBranchId(req);
    if (!main) return false;
    return String(pinned) !== String(main);
}

module.exports = {
    getMainBranchId,
    mergedBranchFilter,
    mergedCustomerBranchFilter,
    isSubBranchCaller,
};
