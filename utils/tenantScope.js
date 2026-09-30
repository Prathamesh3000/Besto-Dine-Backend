/**
 * Shared tenant-scope helpers used by every tenant-aware controller.
 *
 * Phase 1 migration originally copy-pasted these two one-liners into
 * each controller. Phase 3 hardening centralized them here so the
 * eventual strict-mode flip is a one-line change (`tenantFilter` throws
 * instead of returning `{}`) instead of a 27-file edit.
 *
 *   tenantFilter(req)
 *     → { restaurant: req.restaurant._id }  when a tenant is resolved
 *     → {}                                  when req.restaurant is null
 *
 *   The empty-object fallback is the Phase 1 compromise that keeps
 *   legacy single-tenant and public-endpoint flows working. Phase 3
 *   step 1 added telemetry so we can confirm nothing still depends on
 *   this before flipping it to throw.
 *
 *   tenantId(req)
 *     → req.restaurant._id  when a tenant is resolved
 *     → null                otherwise (caller decides what to do with null)
 *
 * Usage in a controller:
 *   const { tenantFilter, tenantId } = require('../utils/tenantScope');
 *   const items = await Item.find({ status: 'active', ...tenantFilter(req) });
 *   const doc   = await Item.create({ ...req.body, restaurant: tenantId(req) });
 */

const mongoose = require('mongoose');
const logger = require('./logger');

// BUGS_REPORT #30 — an empty tenantFilter on a non-superadmin request
// means the query spans EVERY tenant. We warn (deduped per route: 1st,
// 10th, 100th, … hit) instead of throwing; throwing is the eventual
// strict-mode flip once the logs stay quiet.
const _noTenantHits = new Map();
function warnMissingTenant(req) {
    const key = `${req?.method || ''} ${req?.baseUrl || ''}${req?.route?.path || req?.path || ''}`;
    const n = (_noTenantHits.get(key) || 0) + 1;
    _noTenantHits.set(key, n);
    if (_noTenantHits.size > 200) _noTenantHits.delete(_noTenantHits.keys().next().value);
    if (n !== 1 && !Number.isInteger(Math.log10(n))) return;
    logger.warn('tenantScope.tenantFilter.no-tenant', {
        route: key,
        role: req?.user?.role || 'anonymous',
        occurrences: n,
    });
}

const tenantFilter = (req) => {
    if (req && req.restaurant) return { restaurant: req.restaurant._id };
    if (req?.user?.role !== 'superadmin') warnMissingTenant(req);
    return {};
};
const tenantId     = (req) => req.restaurant?._id || null;

/**
 * Branch-pin helpers (Phase 6 — isolation hardening).
 *
 * A Sub Admin is a staff user with `role: 'admin'` AND `user.branch`
 * set to an ObjectId. The tenant owner has `branch: null`. Any staff
 * user with `branch` set is considered "branch-pinned" — they must
 * only see / write data for that branch, and the backend enforces
 * it regardless of what the client sends in query or body params.
 *
 *   isBranchPinned(req)
 *     → true when req.user has a branch ObjectId assigned
 *
 *   pinnedBranchId(req)
 *     → ObjectId | null. Prefer this over req.user.branch directly —
 *       it tolerates both populated ({_id}) and raw-ObjectId shapes.
 */
function pinnedBranchId(req) {
    const b = req?.user?.branch;
    if (!b) return null;
    return b._id || b; // populated doc vs raw ObjectId
}
const isBranchPinned = (req) => !!pinnedBranchId(req);

/**
 * Phase 6 step 6 — analytics-style branch filter.
 *
 * Translates a `?branch=<value>` query param into a Mongoose filter
 * fragment that the caller can spread into an aggregation $match or
 * find() filter. The Phase 6 step 5 staff branch (req.branch) is the
 * fallback when no explicit query value is provided, so a manager
 * pinned to "Downtown" sees the Downtown dashboard by default.
 *
 *   ?branch=<ObjectId>   → { branch: ObjectId } — filter to that branch
 *   ?branch=all          → {} — explicit "all branches" override
 *   ?branch=tenant-only  → { branch: null } — only tenant-level orders
 *   ?branch=none         → alias for tenant-only
 *   (omitted)            → fall back to req.branch?._id (staff pin)
 *                          OR {} (no filter) if no staff branch
 *
 * Returns `{}` (no filter) on any unrecognised value so a typo in
 * the URL never accidentally hides every order from the dashboard.
 *
 * Usage:
 *   const aggMatch = { ...tenantFilter(req), ...analyticsBranchFilter(req) };
 *   await Order.aggregate([{ $match: aggMatch }, ...]);
 */
function analyticsBranchFilter(req) {
    // ── HARD ENFORCEMENT ────────────────────────────────────────────
    // When the caller is a branch-pinned staff user, they cannot widen
    // their scope via ?branch=all or ?branch=<otherId>. Their pin is
    // authoritative — the query param is ignored entirely. This is the
    // difference between "best-effort default" and "security boundary".
    //
    // Branch ids are returned as `mongoose.Types.ObjectId` (not plain
    // strings) because this filter feeds into `$match` stages of
    // aggregation pipelines, which — unlike .find() — do NOT auto-cast
    // strings to ObjectId via the schema. Without the cast, every
    // dashboard aggregation silently returned 0 rows for tenant owners
    // who passed `?branch=<id>` from the admin switcher.
    const pinned = pinnedBranchId(req);
    if (pinned) {
        const id = pinned._id || pinned;
        return { branch: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
    }

    const raw = req?.query?.branch;
    if (raw === 'all') return {};                     // explicit "show all"
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) return { branch: new mongoose.Types.ObjectId(String(raw)) };

    // No explicit query — fall back to the staff branch pin from
    // Phase 6 step 5. Tenant-level admins see everything (no filter).
    if (req?.branch?._id) {
        const id = req.branch._id;
        return { branch: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
    }
    return {};
}

/**
 * Strict per-collection branch filter for collections where `branch: null`
 * means "legacy / unassigned" (NOT "shared with all branches").
 *
 * Use this for: Order, Table, Inventory, Wallet, Staff lists, etc.
 * Do NOT use this for MenuItem — there `branch: null` legitimately means
 * "shared across all branches" (use buildBranchFilter from menuController
 * instead).
 *
 *   - Pinned caller (Sub Admin)  → { branch: pinned } (their branch only)
 *   - Non-pinned (tenant owner)  → respect ?branch=<id|all|tenant-only>
 *   - No query, no pin            → {} (everything in tenant)
 */
function strictBranchFilter(req) {
    // Same ObjectId-casting concern as analyticsBranchFilter — this
    // helper is sometimes consumed by aggregation pipelines (Tip
    // dashboards, CRM order lookups, etc.) where Mongoose's schema
    // casting doesn't apply. Returning a real ObjectId keeps both
    // .find() and .aggregate({ $match }) call sites correct.
    const pinned = pinnedBranchId(req);
    if (pinned) {
        const id = pinned._id || pinned;
        return { branch: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
    }

    const raw = req?.query?.branch;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none' || raw === 'shared') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) return { branch: new mongoose.Types.ObjectId(String(raw)) };

    if (req?.branch?._id) {
        const id = req.branch._id;
        return { branch: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
    }
    return {};
}

module.exports = {
    tenantFilter,
    tenantId,
    analyticsBranchFilter,
    strictBranchFilter,
    isBranchPinned,
    pinnedBranchId,
};
