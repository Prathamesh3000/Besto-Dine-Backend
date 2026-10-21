/**
 * Token-number mode (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2).
 *
 * A restaurant whose operations profile says `tables.useTables:false`
 * does not seat people at numbered tables: a dine-in order is placed
 * without a table and the customer collects it by a token number
 * ("Your token: T-042"). This module owns:
 *
 *   nextTokenNumber(restaurantId, branchId, date)
 *     → 'T-001', 'T-002', … per branch per server-local day, from one
 *       atomic $inc on models/orderTokenCounter (collection
 *       order_token_counters). Two orders placed at the same instant
 *       can never share a token.
 *
 *   isTokenMode(ops) / tokenModeFor(req)
 *     → does this RESOLVED profile / this request's tenant run without
 *       tables? Read from the same resolver the pay-first rules use
 *       (utils/operationsProfile.resolveOperations, with the caller's
 *       branch), so a per-branch override is honoured. A tenant with no
 *       profile, or with tables on, is never in token mode.
 *
 *   tablesDisabledError()
 *     → the 400 TABLES_DISABLED body table-only endpoints (assign /
 *       merge / free / claim seat / reservation hold) answer with.
 *
 * Takeaway and kiosk orders keep their ORT- / KSK- order ids; only
 * table-less dine-in orders carry a token.
 */

const TOKEN_PREFIX = 'T';
const TOKEN_PAD = 3;

/** 'YYYY-MM-DD' of `date` in the server's local time. */
function localDayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** 1 → 'T-001'; 1000 → 'T-1000' (never truncated). */
function formatTokenNumber(seq) {
    return `${TOKEN_PREFIX}-${String(seq).padStart(TOKEN_PAD, '0')}`;
}

/**
 * Allocate the next token for `restaurantId` / `branchId` on the day of
 * `date` (a Date, or a 'YYYY-MM-DD' day key — tests inject the day).
 * `branchId` null = tenant-level orders. Throws when no restaurant is
 * given: a token without a tenant is meaningless.
 */
async function nextTokenNumber(restaurantId, branchId = null, date = new Date()) {
    if (!restaurantId) throw new Error('nextTokenNumber: restaurantId is required');
    const OrderTokenCounter = require('../models/orderTokenCounter');
    const day = typeof date === 'string' ? date : localDayKey(date);
    const counter = await OrderTokenCounter.findOneAndUpdate(
        { restaurant: restaurantId, branch: branchId || null, day },
        { $inc: { seq: 1 }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
    ).lean();
    return formatTokenNumber(counter.seq);
}

/** Is this RESOLVED operations profile (resolveOperations) in token mode? */
function isTokenMode(ops) {
    return !!ops && !!ops.tables && ops.tables.useTables === false;
}

/**
 * The branch the resolver should read overrides for: a branch-pinned
 * staff member's own branch, else the request's active branch (X-Branch-Id
 * / scanned table), else the tenant's main branch.
 */
function requestBranchId(req) {
    const pinned = req?.user?.branch;
    if (pinned) return pinned._id || pinned;
    if (req?.branch?._id) return req.branch._id;
    return req?.mainBranchId || null;
}

/** Resolve the request tenant's operations profile (null without a tenant). */
function resolveRequestOps(req) {
    if (!req || !req.restaurant) return null;
    const { resolveOperations } = require('./operationsProfile');
    return resolveOperations(req.restaurant, { branchId: requestBranchId(req) });
}

/** Does the request's tenant (for the caller's branch) run without tables? */
function tokenModeFor(req) {
    // A tenant that never set up a profile keeps today's behaviour; no
    // resolver call at all so the fast path stays exactly as it was.
    if (!req?.restaurant?.operations) return false;
    try {
        return isTokenMode(resolveRequestOps(req));
    } catch {
        return false;
    }
}

/** 400 body for a table-only action on a restaurant that does not use tables. */
function tablesDisabledError() {
    return {
        success: false,
        code: 'TABLES_DISABLED',
        message: 'This restaurant does not use table numbers — orders are served by token number.',
    };
}

module.exports = {
    TOKEN_PREFIX,
    localDayKey,
    formatTokenNumber,
    nextTokenNumber,
    isTokenMode,
    requestBranchId,
    resolveRequestOps,
    tokenModeFor,
    tablesDisabledError,
};
