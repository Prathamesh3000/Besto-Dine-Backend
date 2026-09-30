/**
 * orderAccess — who may see / act on an order.
 *
 * Extracted verbatim from controllers/orderController.js (BUGS_REPORT #31):
 * caller ↔ order access check, staff branch scoping for list queries, and
 * the guest scan-session scoping used by the table-order lookups.
 */
const mongoose = require('mongoose');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const { pinnedBranchId } = require('../utils/tenantScope');

// ── Caller ↔ order access check (bugs #5 / #7) ──────────────────────
// Used by customer-facing mutation endpoints that are mounted with
// optionalAuth (cancel, payment). The tenant is already enforced by the
// order lookup. A caller may act on the order when they are:
//   • staff of the tenant (any order),
//   • the logged-in owner (order.user === caller), or
//   • holding an X-Scan-Token whose sessionId matches the order's
//     scanSessionId — only for orders with NO owner (guest orders). A
//     table-level match is not enough: two parties can share a table.
const ORDER_STAFF_ROLES = new Set(['admin', 'manager', 'captain', 'waiter', 'chef', 'superadmin']);
function orderAccessForCaller(req, order) {
  const caller = req.user || null;
  if (caller && ORDER_STAFF_ROLES.has(caller.role)) {
    return { allowed: true, isStaff: true };
  }
  if (order.user) {
    const owns = !!caller && String(order.user) === String(caller._id);
    return { allowed: owns, isStaff: false };
  }
  // Ownerless (guest) order — must prove the same scan session.
  const scanToken = req.headers['x-scan-token'];
  if (!scanToken || !order.scanSessionId) {
    return { allowed: false, isStaff: false, reason: scanToken ? 'SCAN_SESSION_MISMATCH' : 'SCAN_TOKEN_REQUIRED' };
  }
  try {
    const decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
    const tenantOk = !decoded.restaurantId || !order.restaurant
      || String(decoded.restaurantId) === String(order.restaurant);
    const sessionOk = !!decoded.sessionId && String(decoded.sessionId) === String(order.scanSessionId);
    return { allowed: tenantOk && sessionOk, isStaff: false, reason: 'SCAN_SESSION_MISMATCH' };
  } catch (err) {
    return { allowed: false, isStaff: false, reason: err.name === 'TokenExpiredError' ? 'SCAN_TOKEN_EXPIRED' : 'SCAN_TOKEN_INVALID' };
  }
}

/**
 * Phase 6 step 4 — staff branch-scoping helper.
 *
 * If the logged-in staff user has been pinned to a specific branch
 * (req.user.branch is set), every list/dashboard query auto-filters
 * orders to that branch. Tenant-level staff (req.user.branch = null)
 * see everything at the tenant — same behaviour as before this step.
 *
 * The filter always INCLUDES tenant-level orders (branch: null) too,
 * so legacy orders created before Phase 6 and orders created on
 * tenant-level tables still show up on a branch-pinned staff's
 * dashboard. The effect is "everything at my branch + shared."
 *
 * Admin is intentionally NOT exempt — a chain with per-branch admins
 * will want them to see only their branch. If a tenant needs a
 * cross-branch admin, they leave the branch field null.
 */
function staffBranchFilter(req) {
  // Branch ids are returned as `mongoose.Types.ObjectId` instances (not
  // plain strings) because this filter also feeds the `$match` stages of
  // aggregation pipelines (Refund summary cards, Tip dashboards, etc.).
  // Unlike `.find()`, `$match` does NOT auto-cast strings to ObjectId
  // via the schema — so a raw string here silently matches zero rows
  // and every aggregated card reads ₹0 while the row list (which uses
  // `.find()`) still shows real data. That was the Refunds-tab "Today
  // ₹0 / This Week ₹0 / This Month ₹0" mismatch.

  // Branch-pinned staff (Sub Admins) see ONLY their own branch's orders.
  // We do NOT include `{ branch: null }` here — for orders, null means
  // "unassigned legacy data", not "shared". Mixing the two leaked every
  // pre-branch order to every Sub Admin (the data migration in
  // Seed/migrateLegacyBranchNulls.js fixes existing nulls).
  const pinned = pinnedBranchId(req);
  if (pinned) {
    const id = pinned._id || pinned;
    return { branch: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
  }

  // Unpinned admin (tenant owner) using the AdminBranchContext switcher
  // — they pass `?branch=<id>` to scope to one branch's orders, or
  // `?branch=all` to explicitly opt back into "see everything". Typos
  // and unrecognised values fall through to "see everything" so a bad
  // URL never silently empties the dashboard.
  const raw = req?.query?.branch;
  if (raw === 'all') return {};
  if (raw === 'tenant-only' || raw === 'none') return { branch: null };
  if (raw && mongoose.Types.ObjectId.isValid(raw)) {
    return { branch: new mongoose.Types.ObjectId(String(raw)) };
  }
  return {};                                     // tenant owner: see everything
}

// Extract the scanSessionId carried by a guest's X-Scan-Token, or null
// if absent / invalid / expired. Used to scope a guest's table-order
// queries to THEIR own scan session so a previous diner's orphaned
// unpaid orders never leak into a fresh guest who scanned the same QR.
const scanSessionFromReq = (req) => {
  const token = req.headers['x-scan-token'];
  if (!token) return null;
  try {
    return verifyTypedToken(token, TOKEN_TYPES.SCAN).sessionId || null;
  } catch {
    return null;
  }
};

// Narrow a table-order filter to the caller's own session. Staff
// (waiter / captain / admin / manager / chef) are returned unchanged —
// they MUST see every still-occupied order on a table to settle or
// clear it. A guest is scoped to their scanToken's scanSessionId
// (fail-closed: no/invalid token → an impossible sentinel so they see
// nothing rather than the whole table). A logged-in customer is scoped
// to orders they own. This is the session boundary that the bare
// `table + unpaid` filter was missing — see the cross-session leak
// where Guest B's fresh scan saw Guest A's served-but-unpaid order.
const applySessionScope = (filter, req) => {
  if (req.user && req.user.role !== 'customer') return filter; // staff: full view
  if (!req.user) {
    filter.scanSessionId = scanSessionFromReq(req) || '__no_session__';
  } else {
    filter.user = req.user._id; // logged-in customer: own orders only
  }
  return filter;
};

module.exports = {
  ORDER_STAFF_ROLES,
  orderAccessForCaller,
  staffBranchFilter,
  scanSessionFromReq,
  applySessionScope,
};
