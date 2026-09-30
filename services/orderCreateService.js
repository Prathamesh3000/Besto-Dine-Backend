/**
 * orderCreateService — POST /orders (createOrder), split into phases.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31). The
 * former ~1,530-line handler is now a short pipeline (createOrder at the
 * bottom) over the phase functions below. Business rules, validation
 * order, response bodies and side effects are unchanged: each phase is
 * the original block moved verbatim, with `return res.status(4xx).json(…)`
 * turned into `throw httpError(4xx, …)` (see services/orderErrors.js).
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const Table = require('../models/table');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const MenuItem = require('../models/menuItem');
const CouponRedemption = require('../models/couponRedemption');
const idGen = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { getSettings } = require('../utils/settingsCache');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { resolveMergeLeader, freeTableOrUnmergeGroup } = require('../utils/tableMerge');
const { callerPartyKeys, checkTableCapacity, tableUnavailableError } = require('../utils/tableOccupancy');
const { httpError, reply } = require('./orderErrors');
const {
  isValidObjectId,
  bumpMenuItemOrderCounts,
  emitStaffTable,
  signKioskTrackingToken,
} = require('./orderHelpers');
const pricing = require('./orderPricingService');
const { buildCreateOrderNotificationTasks } = require('./orderNotifications');

// Channels we accept on createOrder. Kept narrow so a tampered client
// can't claim arbitrary strings; anything outside this set is rejected
// and falls back to inference.
const VALID_ORDER_SOURCES = new Set(['web-customer', 'qr-scan', 'kiosk', 'staff', 'pos', 'admin']);
const STAFF_ORDERER_ROLES = new Set(['waiter', 'captain']);
const DINE_IN_ALLOWED = new Set(['waiter', 'captain', 'admin', 'manager', 'customer']);

// ── Phase: idempotency short-circuit ────────────────────────────────
// Returns { clientIdempotencyKey, replay } — `replay` is the original
// order's response when this key was already used.
async function checkIdempotency(req, rawIdempotencyKey) {
  // ── Idempotency short-circuit ─────────────────────────────────────
  // The client can supply a UUID that survives retries. If we've
  // already created an order under this (tenant, key) pair, return
  // the original instead of creating a duplicate in the kitchen
  // queue. This is the safety net that keeps "Razorpay paid but
  // /orders POST timed out → user retries" from producing twins.
  let clientIdempotencyKey = null;
  if (typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.trim()) {
    const k = rawIdempotencyKey.trim();
    // 16–80 chars, ascii-safe — bounds protect the index from abuse.
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(k)) {
      throw httpError(400, {
        success: false,
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'clientIdempotencyKey must be 16–80 url-safe characters.',
      });
    }
    clientIdempotencyKey = k;
    const tenant = tenantId(req);
    if (tenant) {
      const existing = await Order.findOne({
        restaurant: tenant,
        clientIdempotencyKey,
      });
      if (existing) {
        const trackingToken = existing.source === 'kiosk'
          ? signKioskTrackingToken(existing.orderId, tenant)
          : undefined;
        return {
          clientIdempotencyKey,
          replay: reply(200, {
            success: true,
            order: existing,
            idempotent: true,
            trackingToken,
          }),
        };
      }
    }
  }
  return { clientIdempotencyKey, replay: null };
}

// ── Phase: channel + request-shape validation ───────────────────────
function validateOrderShape(req) {
  const { type, tableId, items, total, pickupLocation, branch: legacyBranchParam, source: rawSource, delivery: deliveryReq } = req.body;
  // Resolve source. Trust an explicit valid value; otherwise infer
  // from the caller's identity so dashboards still get an accurate
  // channel label even on legacy clients that don't send `source`.
  //
  // Bug #16 — a client-claimed source is only honoured when it fits the
  // caller. There is no kiosk credential (the kiosk runs as an anonymous
  // device), so 'kiosk' is accepted only from an unauthenticated caller
  // and — enforced below — only for table-less orders; it can therefore
  // never be used to skip the table scan check. Staff-channel labels
  // require a staff caller.
  const CLAIMED_STAFF_SOURCES = new Set(['staff', 'pos', 'admin']);
  const STAFF_CALLER_ROLES = new Set(['waiter', 'captain', 'manager', 'admin', 'superadmin']);
  const sourceClaimOk = typeof rawSource === 'string' && VALID_ORDER_SOURCES.has(rawSource) && (
    rawSource === 'kiosk' ? !req.user
      : CLAIMED_STAFF_SOURCES.has(rawSource) ? !!(req.user && STAFF_CALLER_ROLES.has(req.user.role))
        : true
  );
  let resolvedSource;
  if (sourceClaimOk) {
    resolvedSource = rawSource;
  } else if (req.user && ['waiter', 'captain', 'manager'].includes(req.user.role)) {
    resolvedSource = 'staff';
  } else if (req.user && ['admin', 'superadmin'].includes(req.user.role)) {
    resolvedSource = 'admin';
  } else if (!req.user && req.headers['x-scan-token']) {
    resolvedSource = 'qr-scan';
  } else if (req.user && req.user.role === 'customer') {
    resolvedSource = 'web-customer';
  } else {
    resolvedSource = 'web-customer';
  }

  // Phase 6 step 4 — the legacy `branch` body param was a free-text
  // label for the takeaway pickup location. Clients still send it
  // under that key; accept either name and map to the renamed
  // `pickupLocation` field on the Order document. A separate
  // optional `branchId` maps to the new Branch ObjectId ref.
  const resolvedPickupLocation = pickupLocation ?? legacyBranchParam;

  // Basic input validation (H3)
  if (!type || !['dine-in', 'takeaway'].includes(type)) {
    throw httpError(400, { success: false, message: 'Order type must be "dine-in" or "takeaway"' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw httpError(400, { success: false, message: 'Order must have at least one item' });
  }
  if (!total || typeof total !== 'number' || total <= 0) {
    throw httpError(400, { success: false, message: 'Total must be a positive number' });
  }

  // Price-tamper validation deferred — see the authoritative
  // recomputation block below, which runs after the canonical menu
  // docs + coupon + wallet have been fetched. Trusting the client's
  // item.price (as the old computedTotal check did) let a tampered
  // cart slip through with price:1 on a ₹1000 item.

  // ── Home delivery intent ─────────────────────────────────────────
  // A delivery order is a takeaway the customer wants brought to their
  // address. Validate the shape here; the authoritative fee is looked
  // up from Settings.delivery.slabs after the settings fetch below
  // (never trust the client's charge). Delivery is dine-in-incompatible
  // and requires an address.
  const wantsDelivery = !!(deliveryReq && deliveryReq.requested);
  const cleanDeliveryAddress = wantsDelivery
    ? String(deliveryReq.address || '').replace(/[\x00-\x1F\x7F]/g, '').trim()
    : '';
  if (wantsDelivery) {
    if (type !== 'takeaway') {
      throw httpError(400, { success: false, code: 'DELIVERY_TAKEAWAY_ONLY', message: 'Home delivery is only available for takeaway orders.' });
    }
    if (!cleanDeliveryAddress) {
      throw httpError(400, { success: false, code: 'DELIVERY_ADDRESS_REQUIRED', message: 'A delivery address is required for home delivery.' });
    }
    if (cleanDeliveryAddress.length > 500) {
      throw httpError(400, { success: false, message: 'Delivery address cannot exceed 500 characters.' });
    }
  }

  // Takeaway-specific validation: require a pickup location label.
  // Delivery orders are exempt — the customer isn't collecting, so the
  // address (validated above) stands in for the pickup location.
  if (type === 'takeaway' && !wantsDelivery && !resolvedPickupLocation) {
    throw httpError(400, { success: false, message: 'Branch / pickup location is required for takeaway orders' });
  }
  // Takeaway orders must not have a table
  if (type === 'takeaway' && tableId) {
    throw httpError(400, { success: false, message: 'Takeaway orders cannot be assigned to a table' });
  }
  // Dine-in orders MUST have a table. Without this guard a staff
  // member could fill the create-order form, leave the table picker
  // blank, and submit — resulting in a ghost dine-in order whose
  // card rendered "Takeaway" text AND a "Dine-In" badge side-by-side
  // because the UI couldn't reconcile the inconsistent data (the
  // ORD-260519-7DE0A6 bug). Hard-reject at the boundary so the data
  // never reaches the DB in this invalid state.
  //
  // EXEMPTION — kiosk source. A kiosk is a physical device at the
  // counter; "Eat Here" dine-in orders have no table assignment
  // because the customer picks up at the kiosk counter (just like
  // takeaway, but consumed on-premises). The downstream scan-token
  // guard already honours this exemption (see line ~534). Skipping
  // here too keeps kiosk Eat Here checkout from 400'ing after
  // payment success — the failure mode the customer sees as
  // "Payment received — please show the screen at the counter" on
  // PayOption's paid-recovery screen.
  // Kiosk orders are table-less by definition — a 'kiosk' claim that
  // names a table is an attempt to bypass the scan-token check.
  if (resolvedSource === 'kiosk' && tableId) {
    throw httpError(400, {
      success: false,
      code: 'KIOSK_NO_TABLE',
      message: 'Kiosk orders cannot be assigned to a table.',
    });
  }
  if (type === 'dine-in' && !tableId && resolvedSource !== 'kiosk') {
    throw httpError(400, {
      success: false,
      code: 'TABLE_REQUIRED',
      message: 'Dine-in orders require a table. Pick a table or switch to Takeaway.',
    });
  }
  return { resolvedSource, resolvedPickupLocation, wantsDelivery, cleanDeliveryAddress };
}

// ── Phase: customer / waiter attribution + dine-in role gate ────────
function resolveAttribution(req) {
  const { type, userId, tableId } = req.body;
  // Customer attribution.
  //
  // Bug #17 — the body `userId` is NEVER trusted: a client could attach
  // an order (and its loyalty points / wallet checks) to any customer.
  // The customer is always the authenticated caller; staff-placed and
  // guest orders stay unlinked.
  void userId;
  const validUserId = (req.user && req.user.role === 'customer' && req.user._id) ? req.user._id : null;
  const validTableId = isValidObjectId(tableId) ? tableId : null;
  // Waiter attribution (drives tips routing + per-staff reports).
  //
  // Bug #17 — the body `waiterId` is ignored (it let any client route
  // tips to any waiter). The waiter of record is the staff caller
  // themselves, otherwise the table's assigned waiter (resolved from
  // the Table doc further down).
  let validWaiterId = (req.user && STAFF_ORDERER_ROLES.has(req.user.role)) ? req.user._id : null;

  // ── Dine-in staff hardening ─────────────────────────────────────
  // Dine-in orders created by an authenticated user must come from a
  // role that's actually allowed to take orders at a table. Without
  // this, any logged-in customer / chef / superadmin could POST here
  // with a tableId and create phantom orders. Guest (req.user = null)
  // dine-in orders still flow through the existing scanToken gate
  // below — they're checked separately.
  if (type === 'dine-in' && req.user && !DINE_IN_ALLOWED.has(req.user.role)) {
    throw httpError(403, {
      success: false,
      code: 'ROLE_NOT_ALLOWED',
      message: 'Your role is not permitted to place dine-in orders.',
    });
  }
  return { validUserId, validTableId, validWaiterId };
}

// ── Phase: guest contact field normalisation (CRIT-14) ──────────────
function normaliseContactFields(req) {
  const { customerName, phone } = req.body;
  // CRIT-14 — validate and normalise guest-supplied contact fields so
  // a malicious client can't poison the CRM aggregation or inject
  // control characters into SMS / email downstream. Logged-in users
  // inherit from their User doc and skip the guest fields; guests
  // must use a safe subset.
  let cleanCustomerName;
  let cleanPhone;
  if (customerName != null) {
    const raw = String(customerName).trim();
    // Strip control chars; allow letters, digits, spaces, common name punctuation.
    const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, '');
    if (stripped.length > 80) {
      throw httpError(400, { success: false, message: 'Customer name cannot exceed 80 characters.' });
    }
    if (stripped && !/^[\p{L}\p{M}0-9 .'\-]+$/u.test(stripped)) {
      throw httpError(400, { success: false, message: 'Customer name contains invalid characters.' });
    }
    cleanCustomerName = stripped || undefined;
  }
  // Defensive fallback paired with the validUserId fallback above —
  // if the body omits `customerName` but the request carries a valid
  // customer JWT, use the registered name from the User record so
  // the order doesn't fall back to the literal "Guest" label
  // downstream (line 1150 / 1222). Keeps CRM aggregation and the
  // customer's own /my-orders view labelled with their real name.
  if (!cleanCustomerName && req.user && req.user.role === 'customer' && req.user.name) {
    cleanCustomerName = String(req.user.name).trim().slice(0, 80) || undefined;
  }
  if (phone != null) {
    const rawPhone = String(phone).trim();
    if (rawPhone) {
      // Accept optional leading +, digits, spaces, dashes, parens — normalise to digits + leading +.
      if (!/^\+?[\d\s\-()]{7,20}$/.test(rawPhone)) {
        throw httpError(400, { success: false, message: 'Please provide a valid phone number.' });
      }
      const digits = rawPhone.replace(/[^\d+]/g, '');
      if (digits.replace(/^\+/, '').length < 7 || digits.replace(/^\+/, '').length > 15) {
        throw httpError(400, { success: false, message: 'Phone number must be between 7 and 15 digits.' });
      }
      cleanPhone = digits;
    }
  }
  return { cleanCustomerName, cleanPhone };
}

// ── Phase: dine-in scan-token proof ─────────────────────────────────
// Guest dine-in orders must prove they actually scanned this table.
// A signed X-Scan-Token (issued by GET /tables/scan/:qrToken) binds
// the browser session to one physical table. Without this guard any
// guest could POST /orders with a tableId they never scanned and
// hijack another table's order in the same tenant.
//
// EXEMPTION — kiosk source (no QR scan, no table binding).
// Bug #16 — logged-in CUSTOMERS get the same check as guests: an
// account alone doesn't prove the diner is sitting at that table.
// Only staff roles place dine-in orders without a scan.
//
// Returns the scan session id (CRIT-12 — stamped on the order for
// socket-room gating) or null.
function verifyDineInScan(req, { type, isKioskOrder, validTableId }) {
  let scanSessionId = null;
  const needsScanToken = (!req.user || req.user.role === 'customer') && type === 'dine-in' && !isKioskOrder;
  if (needsScanToken) {
    if (!validTableId) {
      throw httpError(400, { success: false, message: 'Dine-in orders require a table.' });
    }
    const scanToken = req.headers['x-scan-token'];
    if (!scanToken) {
      throw httpError(401, { success: false, code: 'SCAN_TOKEN_REQUIRED', message: 'Please re-scan the table QR code to place an order.' });
    }
    // Only the verification itself maps to 401 — the mismatch checks
    // below are 403s (they used to sit in the same try, returning early).
    let decoded;
    try {
      decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      throw httpError(401, {
        success: false,
        code: expired ? 'SCAN_TOKEN_EXPIRED' : 'SCAN_TOKEN_INVALID',
        message: expired ? 'Your table session has expired. Please re-scan the QR code.' : 'Invalid table session. Please re-scan the QR code.',
      });
    }
    if (String(decoded.tableId) !== String(validTableId)) {
      throw httpError(403, { success: false, code: 'SCAN_TOKEN_MISMATCH', message: 'Scan token does not match this table. Re-scan the QR code.' });
    }
    const currentTenant = tenantId(req);
    if (currentTenant && decoded.restaurantId && String(decoded.restaurantId) !== String(currentTenant)) {
      throw httpError(403, { success: false, code: 'SCAN_TOKEN_MISMATCH', message: 'Scan token does not match this restaurant.' });
    }
    scanSessionId = decoded.sessionId || null;
  }
  return scanSessionId;
}

// ── Phase: merge-group redirect ─────────────────────────────────────
async function resolveLeaderTable(req, type, validTableId) {
  // Merge-group redirect — dine-in writes always land on the leader.
  //
  // If the caller passed a tableId for a table that's part of a merge
  // group (e.g. waiter tapped Table 6 in a merged 5+6+7 group), swap
  // in the leader's _id here so:
  //   • the order's `table` field points at the canonical group holder
  //     — the "one active order per table" unique index then naturally
  //     blocks creating a second order on another sibling,
  //   • Payments, pickup, KOT reprint, etc. all find the right order
  //     when a customer/chef references any sibling's table.
  //
  // For guest flows the scanToken is already bound to the leader
  // (see tableController.getTableByToken), so validTableId will
  // usually already equal leader._id. The redirect is defensive —
  // picks up pre-fix tokens and staff-originated creates.
  let resolvedTableId = validTableId;
  if (type === 'dine-in' && validTableId) {
    try {
      const leader = await resolveMergeLeader(validTableId, tenantFilter(req));
      if (leader && leader._id) {
        resolvedTableId = leader._id;
      }
    } catch (err) {
      logger.warn('Merge leader resolution failed; proceeding with scanned tableId:', err.message);
    }
  }
  return resolvedTableId;
}

// ── Phase: out-of-stock menu check + canonical menu fetch ───────────
async function loadCartMenu(req, items) {
  // Check stock availability for all ordered menu items
  const menuItemIds = items
    .map(i => i.menuItem)
    .filter(id => id && mongoose.Types.ObjectId.isValid(id));
  if (menuItemIds.length > 0) {
    const outOfStock = await MenuItem.find(
      { _id: { $in: menuItemIds }, inStock: false, ...tenantFilter(req) },
      'name'
    ).lean();
    if (outOfStock.length > 0) {
      const names = outOfStock.map(m => m.name).join(', ');
      throw httpError(400, { success: false, message: `The following item(s) are currently out of stock: ${names}` });
    }
  }

  // Batch-fetch every menu item referenced in the cart. Doing this in
  // one query avoids N+1 round-trips AND gives us the authoritative
  // toppings/prices we need to validate the cart against tampering.
  const menuDocs = menuItemIds.length
    ? await MenuItem.find(
      { _id: { $in: menuItemIds }, ...tenantFilter(req) }
    ).populate('category', 'name').lean()
    : [];
  const menuById = new Map(menuDocs.map(m => [String(m._id), m]));
  return menuById;
}

// ── Phase: branch assignment + table availability / capacity ────────
async function resolvePlacement(req, { type, resolvedTableId, scanSessionId, branchId, isKioskOrder, validWaiterId }) {
  // Phase 6 step 4 — branch assignment rules.
  //
  //   dine-in : inherit from the table's branch (authoritative — the
  //             physical table IS at a specific location). Fall back
  //             to the customer's X-Branch-Id only when the table has
  //             no branch assigned (legacy data).
  //
  //   takeaway: customer selected the branch explicitly at
  //             /branch-selection. Resolution priority, in order:
  //               1. `branchId` in the request body (frontend's
  //                  explicit, most-recent signal from the cart)
  //               2. `X-Branch-Id` header (survives page reloads via
  //                  the tenant.js cache)
  //               3. null — tenant-level fallback, but only for
  //                  legacy single-location tenants. Multi-branch
  //                  tenants must see a branch OR we reject below.
  //
  // A branch candidate is only accepted after verifying it belongs
  // to the caller's tenant AND is still active — prevents a stale
  // cached id from routing an order to a disabled branch.
  let inheritedBranchId = null;
  // Pulled from the same Table lookup below so the waiter `order:new`
  // emit can include the area id — the home page uses it to bump the
  // table's area to the first position in the area chips strip.
  let resolvedAreaId = null;
  // Captured for the admin "New Order" toast so it can read
  // "Dine-in · Table PD-01 · …" instead of just an order id.
  let resolvedTableName = null;
  if (type === 'dine-in' && resolvedTableId) {
    // This lookup used to be wrapped in a bare try/catch that
    // swallowed a missing table entirely, so an order against a
    // table the admin had deleted saved happily with a dangling
    // reference. The table's existence is a precondition for a
    // dine-in order, not an optional enrichment — a miss is a hard
    // failure now.
    const t = await Table.findOne({ _id: resolvedTableId, ...tenantFilter(req) })
      .select('branch area name capacity isDeleted isActive status mergedWith assignedWaiter').lean();

    const unavailable = tableUnavailableError(t);
    if (unavailable) throw httpError(unavailable.status, unavailable.body);

    // ── Table capacity enforcement ──────────────────────────────
    // A table seats `capacity` diners (summed across a merge group).
    // Count the distinct ordering PARTIES currently seated — one per
    // logged-in customer / guest scan session, plus one for staff
    // walk-in orders — and refuse a NEW party once the table is full.
    // A party that already has a live order can keep ordering (the
    // old check counted orders, so one diner's 5th round tripped it
    // while five separate phones on a 2-seater did not). Staff are
    // never blocked: they seat walk-ins at their own discretion.
    const capacityCheck = await checkTableCapacity(t, tenantFilter(req), callerPartyKeys(req, scanSessionId));
    if (!capacityCheck.ok) throw httpError(capacityCheck.status, capacityCheck.body);

    if (t.branch) inheritedBranchId = t.branch;
    if (!validWaiterId && t.assignedWaiter) validWaiterId = t.assignedWaiter;
    if (t.area) resolvedAreaId = t.area;
    if (t.name) resolvedTableName = t.name;
  } else if (type === 'takeaway') {
    try {
      const Branch = require('../models/branch');
      // Priority: body.branchId → X-Branch-Id header (req.branch).
      const candidates = [];
      if (branchId && isValidObjectId(branchId)) candidates.push(branchId);
      if (req.branch?._id) candidates.push(req.branch._id);
      for (const candidate of candidates) {
        const exists = await Branch.exists({ _id: candidate, ...tenantFilter(req), isActive: true });
        if (exists) { inheritedBranchId = candidate; break; }
      }
    } catch { /* ignore — order still saves without branch */ }
  }
  // dine-in customers (QR) without a table-resolved branch can also
  // fall back to their X-Branch-Id. Staff dine-in orders always have
  // a table, so this only kicks in for the rare guest path.
  if (!inheritedBranchId && type === 'dine-in' && req.branch?._id && !req.user?.role?.match(/admin|waiter|captain|chef|manager/)) {
    inheritedBranchId = req.branch._id;
  }

  // Kiosk fallback — a self-service kiosk is a physical device at a
  // specific location. It has no QR table to inherit a branch from,
  // and kioskState.js intentionally wipes activeBranchId on every
  // landing (so a previous staff/customer session can't leak the
  // wrong X-Branch-Id). Without this fallback, every kiosk order
  // saved with branch:null and disappeared from branch-pinned Sub
  // Admin / Manager views — only the tenant owner could see them.
  // Resolve to the tenant's first active branch so kiosk orders show
  // up in the admin Orders tab even for multi-branch tenants. For
  // multi-kiosk setups the operator can bind a device by passing
  // ?branchId=… on the kiosk URL (consumed earlier by the kiosk's
  // X-Branch-Id header), which wins over this fallback.
  if (!inheritedBranchId && isKioskOrder) {
    try {
      const Branch = require('../models/branch');
      // Prefer the branch whose slug is literally "main" — that's the
      // tenant-owner-default branch that AdminBranchContext also
      // hydrates to. Falls back to the oldest active branch (lowest
      // createdAt) so we still pick a deterministic location even if
      // the tenant never set up a main-slugged branch.
      const candidates = await Branch
        .find({ ...tenantFilter(req), isActive: true })
        .sort({ createdAt: 1 })
        .select('_id slug').lean();
      const main = candidates.find(b => b.slug === 'main');
      const chosen = main || candidates[0];
      if (chosen?._id) inheritedBranchId = chosen._id;
    } catch { /* ignore — order still saves without branch */ }
  }

  // ── HARD ENFORCEMENT ────────────────────────────────────────────
  // A branch-pinned staff user (Sub Admin) always creates orders at
  // their own branch. If they somehow picked a table/branchId from
  // another branch, we refuse instead of silently moving the order.
  const pinned = pinnedBranchId(req);
  if (pinned) {
    if (inheritedBranchId && String(inheritedBranchId) !== String(pinned)) {
      throw httpError(403, {
        success: false,
        code: 'BRANCH_SCOPE_VIOLATION',
        message: 'You can only create orders for your assigned branch.',
      });
    }
    inheritedBranchId = pinned;
  }
  return { inheritedBranchId, resolvedAreaId, resolvedTableName, validWaiterId };
}

// ── Phase: pre-flight stock check ───────────────────────────────────
// Block the order at placement time when a recipe ingredient is
// out of stock, instead of letting it slip through and failing
// silently when the chef hits "Start Preparing". Items without a
// recipe are skipped (treated as "no inventory tracked") so menus
// that haven't been wired to inventory yet keep working unchanged.
async function preflightStockCheck(req, enrichedItems, inheritedBranchId) {
  let failureBody = null;
  try {
    const { checkInventoryForOrder } = require('../controllers/inventoryController');
    const stockCheck = await checkInventoryForOrder(
      enrichedItems,
      tenantId(req),
      inheritedBranchId,
    );
    if (!stockCheck.ok) failureBody = pricing.insufficientStockBody(stockCheck);
  } catch (err) {
    // The check itself failing is not a reason to drop the order —
    // we'd rather take the customer's money and surface a deduction
    // warning later than reject every order on a transient DB blip.
    logger.warn('Pre-flight stock check failed (allowing order):', err.message);
  }
  if (failureBody) throw httpError(400, failureBody);
}

// ── Phase: detach a stale paid bill from the table ──────────────────
async function detachStalePaidBill(req, type, resolvedTableId) {
  // ── Independent-orders model (was: auto-append) ──────────────────
  // Each customer "Place Order" tap creates a fresh Order document
  // — no auto-append into an existing active order on the same
  // table. Why: chef wants each Place Order as its own KDS card so
  // the next batch of items doesn't silently piggy-back on a card
  // that may already be "ready" or in progress. The previous diner's
  // half-cooked work + the new diner's items being on one card was
  // also a bill-reconciliation hazard.
  //
  // Stale paid bill is the one auto-resolve we keep: the previous
  // bill is detached from the table and the table is freed so the
  // new order's foreign-key references are clean. (Same as before;
  // this was Case A in the old comment.)
  if (type === 'dine-in' && resolvedTableId) {
    try {
      const stalePaid = await Order.findOne({
        table: resolvedTableId,
        status: { $in: ['new', 'preparing', 'ready', 'served'] },
        paymentStatus: 'Paid',
        ...tenantFilter(req),
      });
      if (stalePaid) {
        stalePaid.table = null;
        await stalePaid.save();
        await freeTableOrUnmergeGroup(resolvedTableId, tenantFilter(req));
      }
    } catch (err) {
      logger.warn('Stale paid-bill detach skipped:', err.message);
    }
    // Multiple unpaid active orders on the same table are now
    // explicitly allowed — they aggregate at bill-pay time.
  }
}

// ── Phase: build the Order document(s) (kitchen bypass + mixed split) ─
function buildOrderDocs(req, ctx) {
  const {
    enrichedItems, authoritativeTotal, type, orderId, inheritedBranchId, validUserId,
    resolvedSource, clientIdempotencyKey, resolvedTableId, cleanCustomerName, cleanPhone,
    note, paymentMethod, pickupTime, resolvedPickupLocation, scanSessionId, validWaiterId,
    authoritativeTip, authoritativeCouponCode, authoritativeCouponDiscount,
    authoritativePointsRedeemed, authoritativeWalletPaid, taxBreakdown, wantsDelivery,
    cleanDeliveryAddress, authoritativeDeliverySlab, authoritativeDeliveryFee,
    authoritativeDeliveryDistance, authoritativeDeliveryCoords,
  } = ctx;
  // Kitchen-bypass + mixed-cart split.
  //
  // Counter items (Coca-Cola, water, packaged ice cream) are
  // ready-to-serve — they don't need the chef. Kitchen / bar items
  // do. When a SINGLE cart contains BOTH kinds, the previous logic
  // dragged the counter items through the chef KDS along with the
  // kitchen ones because there was only one Order doc and the
  // chef's "is anything to cook" check was OR-based.
  //
  // The fix: if the cart is mixed, split into TWO Order docs.
  //   • Counter doc — just the counter items, status='ready' from
  //                   the start, status-pinged to the waiter so the
  //                   bottle / packaged item is delivered while the
  //                   kitchen still cooks. Bare item subtotal — no
  //                   tax / discount / tip allocation here, those
  //                   stay attached to the kitchen doc so the bill
  //                   aggregation produces the same grand total.
  //   • Kitchen doc — kitchen items + all the tax / discount / tip /
  //                   coupon / wallet allocation. Normal new →
  //                   preparing → ready → served flow.
  //
  // The customer's Orders tab + admin drawer + bill aggregation
  // already handle multiple orders per table (independent-orders
  // model from the previous refactor), so the split surfaces
  // cleanly without further plumbing.
  let counterItems = enrichedItems.filter(it => (it.prepStation || 'kitchen').toLowerCase() === 'counter');
  let kitchenItems = enrichedItems.filter(it => (it.prepStation || 'kitchen').toLowerCase() !== 'counter');
  const isMixedCart = counterItems.length > 0 && kitchenItems.length > 0;

  // For the SINGLE-order path (everything counter, or everything
  // kitchen), these variables drive the existing block. They stay
  // `let` because the split path further down rebinds them to the
  // kitchen subset before the main `new Order({...})` runs.
  let primaryItems = enrichedItems;
  let primaryTotal = authoritativeTotal;
  let hasKitchenWork = enrichedItems.some(it => {
    const station = (it.prepStation || 'kitchen').toLowerCase();
    return station === 'kitchen' || station === 'bar';
  });
  let initialStatus = hasKitchenWork ? 'new' : 'ready';
  // ── Mixed-cart split ─────────────────────────────────────────────
  // If the cart has BOTH counter and kitchen items, a counter-side
  // Order doc is created alongside the primary one. It saves as
  // status='ready' so the waiter pulls the bottle / packaged item from
  // the cooler while the chef still cooks the rest. The primary
  // Order's items are trimmed to just the kitchen subset and its total
  // adjusted so the two docs still sum to the cart's grand total.
  let counterDocData = null;
  if (isMixedCart) {
    const counterSubtotal = counterItems.reduce((sum, item) => {
      const toppings = Array.isArray(item.selectedToppings)
        ? item.selectedToppings.reduce((s, t) => s + (Number(t.price) || 0), 0)
        : 0;
      return sum + ((Number(item.price) || 0) + toppings) * (Number(item.quantity) || 1);
    }, 0);
    const counterTotal = Math.round(counterSubtotal * 100) / 100;
    const counterOrderIdValue = type === 'takeaway' ? idGen.takeawayOrderId() : idGen.orderId();

    counterDocData = {
      orderId: counterOrderIdValue,
      restaurant: tenantId(req),
      branch: inheritedBranchId,
      user: validUserId,
      type,
      source: resolvedSource,
      // No idempotency key on the counter side — the kitchen doc owns
      // it, and both are now written in the same transaction so a
      // replay can't produce a lone counter doc either.
      table: resolvedTableId,
      customerName: cleanCustomerName || 'Guest',
      phone: cleanPhone,
      items: counterItems,
      total: counterTotal,
      status: 'ready',
      preparationCompletedAt: new Date(),
      paymentMethod: paymentMethod || 'Not selected',
      pickupTime: type === 'takeaway' ? (pickupTime || null) : undefined,
      pickupLocation: type === 'takeaway' ? (resolvedPickupLocation || null) : undefined,
      scanSessionId,
      note: '',
      // No tax / discount / tip on the counter doc — those stay on the
      // kitchen doc so the bill aggregation still matches the cart.
    };

    primaryItems = kitchenItems;
    primaryTotal = Math.round((authoritativeTotal - counterTotal) * 100) / 100;
    hasKitchenWork = true;
    initialStatus = 'new';
  }

  const primaryDocData = {
    orderId,
    restaurant: tenantId(req),
    branch: inheritedBranchId,   // null for takeaway and for tenant-level dine-in tables
    user: validUserId, // Authenticated customer only (bug #17)
    type,
    source: resolvedSource,
    clientIdempotencyKey,        // null if the client didn't supply one
    table: resolvedTableId,
    customerName: cleanCustomerName || 'Guest',
    phone: cleanPhone,
    items: primaryItems,
    total: primaryTotal,
    note,
    paymentMethod: paymentMethod || 'Not selected',
    tipAmount: authoritativeTip,                  // R-01: clamped ≥ 0
    couponCode: authoritativeCouponCode,          // R-01: validated against Coupon doc
    couponDiscount: authoritativeCouponDiscount,  // R-01: recomputed from coupon + subtotal
    pointsRedeemed: authoritativePointsRedeemed,  // R-01: clamped to wallet.loyaltyPoints
    walletAmountPaid: authoritativeWalletPaid,    // split-rail wallet rupee portion
    // Server-computed tax breakdown. Immutable record of what this
    // order was actually charged — see utils/billing.js. Notably
    // serviceCharge is 0 here for takeaway/delivery/kiosk.
    ...taxBreakdown,
    waiter: validWaiterId,
    pickupTime: type === 'takeaway' ? (pickupTime || null) : undefined,
    pickupLocation: type === 'takeaway' ? (resolvedPickupLocation || null) : undefined,
    // Home delivery snapshot — only set when the customer asked for it.
    // fee is folded into `total` (client total covered serverMinTotal
    // which now includes it) AND stored on its own so the bill can show
    // the delivery line and reports can sum delivery revenue separately.
    delivery: wantsDelivery ? {
      requested: true,
      address: cleanDeliveryAddress,
      slab: authoritativeDeliverySlab,
      fee: authoritativeDeliveryFee,
      distanceKm: authoritativeDeliveryDistance,
      location: authoritativeDeliveryCoords,
      status: 'pending',
    } : undefined,
    scanSessionId,  // CRIT-12 — set for guests / scanned customers, null for staff
    // Kitchen-bypass: counter-only carts get status='ready' so they
    // skip the chef KDS entirely and land directly in the waiter
    // pickup queue. preparationCompletedAt is also stamped so the
    // customer tracking timeline shows a clean "Ready" timestamp
    // instead of a blank step.
    status: initialStatus,
    preparationCompletedAt: !hasKitchenWork ? new Date() : undefined,
  };
  return { primaryDocData, counterDocData, hasKitchenWork };
}

// ── Phase: atomic write (bug #14) ───────────────────────────────────
// Returns { savedOrder, counterSideOrder } — or { replay } when a
// concurrent create with the same idempotency key won the race.
async function persistOrderDocs(req, ctx) {
  const {
    primaryDocData, counterDocData, validUserId, clientIdempotencyKey, authoritativeSubtotal,
    authoritativePointsRedeemed, authoritativeCouponCode, authoritativeCouponDiscount,
  } = ctx;
  let counterSideOrder = null;
  // ── Atomic write (bug #14) ───────────────────────────────────────
  // Order doc(s) + loyalty-points debit + its ledger Transaction +
  // coupon usage/redemption commit together or not at all. If the
  // points can no longer be debited (spent concurrently) or the coupon
  // hit its usage limit in the meantime, the WHOLE order is rolled back
  // with a 409 — an order must never keep a discount it didn't pay for.
  // Notifications / socket emits happen after the response.
  const TXN_CONFLICT = Symbol('txnConflict');
  let savedOrder;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Docs are rebuilt on every attempt so a transient-error retry
      // starts from clean (isNew) documents.
      counterSideOrder = counterDocData
        ? await new Order(counterDocData).save({ session })
        : null;
      savedOrder = await new Order(primaryDocData).save({ session });

      // ── Loyalty Points Debit (CRIT-01) ─────────────────────────────
      if (authoritativePointsRedeemed > 0 && validUserId) {
        const updatedWallet = await Wallet.findOneAndUpdate(
          { user: validUserId, ...tenantFilter(req), loyaltyPoints: { $gte: authoritativePointsRedeemed } },
          { $inc: { loyaltyPoints: -authoritativePointsRedeemed } },
          { returnDocument: 'after', session }
        );
        if (!updatedWallet) {
          const e = new Error('Loyalty points are no longer available.');
          e[TXN_CONFLICT] = {
            code: 'POINTS_UNAVAILABLE',
            message: 'Your loyalty points balance changed and could not cover this redemption. Please review your cart and try again.',
          };
          throw e;
        }
        const pointsAfter = updatedWallet.loyaltyPoints;
        await Transaction.create([{
          restaurant: tenantId(req),
          branch: savedOrder.branch || null,
          user: validUserId,
          order: savedOrder._id,
          type: 'points_redeemed',
          amount: -authoritativePointsRedeemed,
          paymentMethod: 'points',
          transactionId: idGen.transactionId(),
          balanceBefore: pointsAfter + authoritativePointsRedeemed,
          balanceAfter: pointsAfter,
          note: `Redeemed ${authoritativePointsRedeemed} points on order ${savedOrder.orderId}`,
        }], { session });
      }

      // ── Coupon redemption recording ────────────────────────────────
      // Atomically increment the coupon's global usageCount and write
      // a CouponRedemption row (user null = guest / staff-placed).
      if (authoritativeCouponCode && authoritativeCouponDiscount > 0) {
        const Coupon = require('../models/coupon');
        const coupon = await Coupon.findOneAndUpdate(
          {
            code: authoritativeCouponCode,
            isActive: true,
            ...tenantFilter(req),
            $or: [
              { usageLimit: { $lte: 0 } },          // unlimited
              { $expr: { $lt: ['$usageCount', '$usageLimit'] } },
            ],
          },
          { $inc: { usageCount: 1 } },
          { returnDocument: 'after', session }
        );
        if (!coupon) {
          const e = new Error('Coupon usage limit reached.');
          e[TXN_CONFLICT] = {
            code: 'COUPON_UNAVAILABLE',
            message: 'This coupon has reached its usage limit or is no longer active. Please remove it and try again.',
          };
          throw e;
        }
        await CouponRedemption.create([{
          coupon: coupon._id,
          couponCode: coupon.code,
          couponTitle: coupon.title,
          user: validUserId || null,
          order: savedOrder._id,
          restaurant: tenantId(req),
          branch: coupon.branch || null,
          orderValue: authoritativeSubtotal,
          discountAmount: authoritativeCouponDiscount,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
        }], { session });
      }
    });
  } catch (err) {
    if (err && err[TXN_CONFLICT]) {
      throw httpError(409, { success: false, ...err[TXN_CONFLICT] });
    }
    // Concurrent create with the same idempotency key (Razorpay
    // double-callback, page reload during slow POST, etc.). Refetch
    // the original and return that instead of bubbling a 500.
    if (err && err.code === 11000 && /idempotency_per_tenant/.test(err.message || '') && clientIdempotencyKey) {
      const existing = await Order.findOne({
        restaurant: tenantId(req),
        clientIdempotencyKey,
      });
      if (existing) {
        const trackingToken = existing.source === 'kiosk'
          ? signKioskTrackingToken(existing.orderId, existing.restaurant)
          : undefined;
        return {
          replay: reply(200, {
            success: true,
            order: existing,
            idempotent: true,
            trackingToken,
          }),
        };
      }
    }
    throw err;
  } finally {
    session.endSession();
  }
  return { savedOrder, counterSideOrder };
}

// ── Phase: mark the dine-in table occupied ──────────────────────────
async function occupyTableForNewOrder(req, savedOrder, type, resolvedTableId) {
  // If dine-in, update the table's state (scoped to tenant). For merged
  // groups we flip the LEADER's activeOrder — siblings keep status
  // 'merged' + their mergedWith array intact so the group renders as
  // one card. We don't overwrite a 'merged' status with 'occupied'
  // either; the merged pill is what the UI keys off of.
  if (type === 'dine-in' && resolvedTableId) {
    const leaderTable = await Table.findOne({ _id: resolvedTableId, ...tenantFilter(req) }).select('status currentDiner');
    const shouldKeepMerged = leaderTable?.status === 'merged';

    // Clear any pending service alerts on the table — once the
    // customer placed a fresh order the "waiting for water / waiter"
    // ping is implicitly satisfied (the kitchen + waiter are now
    // engaged via the order itself). The admin drawer flips from
    // "alert" back to "occupied" because of this.
    const tableUpdate = shouldKeepMerged
      ? { activeOrder: savedOrder._id, alerts: [] }
      : { status: 'occupied', activeOrder: savedOrder._id, alerts: [] };

    // Stamp the diner snapshot from the order so the admin drawer can
    // show the real customer (registered or guest) instead of "Walk-in
    // Guest". Skip when the table already has a diner snapshot for the
    // SAME user — avoids stomping a fresher claimedAt with an older
    // order timestamp on appended-items / waiter-side flows.
    const orderUserId = savedOrder.user ? String(savedOrder.user) : null;
    const dinerUserId = leaderTable?.currentDiner?.user ? String(leaderTable.currentDiner.user) : null;
    if (orderUserId !== dinerUserId) {
      tableUpdate.currentDiner = {
        user: savedOrder.user || null,
        name: savedOrder.customerName || (savedOrder.user ? '' : 'Guest'),
        phone: savedOrder.phone || '',
        isRegistered: !!savedOrder.user,
        claimedAt: new Date(),
      };
    }

    await Table.findOneAndUpdate(
      { _id: resolvedTableId, ...tenantFilter(req) },
      tableUpdate
    );
    emitStaffTable(
      'table:updated',
      { tableId: resolvedTableId, status: shouldKeepMerged ? 'merged' : 'occupied' },
      savedOrder.branch
    );
  }
}

// Create a new order
async function createOrder(req) {
  // (customer / contact / source / table fields are read by the phases below)
  const { type, items, total, note, paymentMethod, pickupTime, branchId, clientIdempotencyKey: rawIdempotencyKey, delivery: deliveryReq } = req.body;

  const { clientIdempotencyKey, replay } = await checkIdempotency(req, rawIdempotencyKey);
  if (replay) return replay;

  const { resolvedSource, resolvedPickupLocation, wantsDelivery, cleanDeliveryAddress } = validateOrderShape(req);
  const attribution = resolveAttribution(req);
  const { validUserId, validTableId } = attribution;
  const { cleanCustomerName, cleanPhone } = normaliseContactFields(req);

  const isKioskOrder = resolvedSource === 'kiosk';
  const scanSessionId = verifyDineInScan(req, { type, isKioskOrder, validTableId });
  const resolvedTableId = await resolveLeaderTable(req, type, validTableId);

  // Generate Order ID — structured, human-readable.
  // Kiosk-originated orders get their own KSK prefix (regardless of
  // dine-in vs takeaway) so staff can spot them in the admin Orders
  // tab and the customer-facing token (last 4 chars) starts with K.
  const orderId = isKioskOrder
    ? idGen.kioskOrderId()
    : (type === 'takeaway' ? idGen.takeawayOrderId() : idGen.orderId());

  const menuById = await loadCartMenu(req, items);
  pricing.validateSelectedToppings(items, menuById);

  // ── R-01: authoritative money-field recomputation ──────────────
  // The client sends items[].price, total, couponCode, couponDiscount,
  // and pointsRedeemed. We trust NONE of those dollar values; every
  // money field is recomputed from canonical server state (see
  // services/orderPricingService.js). The client total is only checked
  // against the server bill (TOTAL_TAMPERED / TOTAL_MISMATCH); the stored
  // total is the server bill (kiosk: the amount it already charged).
  const authoritativeSubtotal = pricing.priceCartItems(items, menuById, req.branch?._id || null);

  // Fetch tenant settings once — needed for the loyalty-points rupee
  // conversion below and reused for the notification gate further down.
  // getSettings() is cache-backed so repeat calls are cheap.
  const settings = await getSettings(req);

  const {
    authoritativeDeliveryFee, authoritativeDeliverySlab, authoritativeDeliveryDistance, authoritativeDeliveryCoords,
  } = await pricing.resolveDeliveryFee(req, { wantsDelivery, deliveryReq, branchId, cleanDeliveryAddress, settings, authoritativeSubtotal });
  const { authoritativeCouponCode, authoritativeCouponDiscount } = await pricing.resolveCartCoupon(req, { items, menuById, authoritativeSubtotal });
  const { authoritativePointsRedeemed, authoritativePointsValue } = await pricing.resolvePointsRedemption(req, {
    validUserId, settings, authoritativeSubtotal, authoritativeCouponDiscount,
  });
  // ── Tip (clamped, not discount-protected) ───────────────────────
  const authoritativeTip = Math.max(0, Number(req.body.tipAmount) || 0);
  const authoritativeWalletPaid = await pricing.resolveWalletPayment(req, { validUserId });
  const { serverMinTotal, authoritativeTotal: clientBoundTotal, clientTotal } = pricing.checkClientTotal({
    total, authoritativeSubtotal, authoritativeCouponDiscount, authoritativePointsValue, authoritativeTip, authoritativeDeliveryFee,
  });
  const { taxBreakdown, authoritativeTotal } = await pricing.computeTaxBreakdown(req, {
    type, deliveryReq, resolvedSource, authoritativeSubtotal, authoritativeTotal: clientBoundTotal,
    authoritativeCouponDiscount, authoritativePointsValue, authoritativeTip, authoritativeDeliveryFee, serverMinTotal,
    clientTotal,
  });

  const enrichedItems = pricing.enrichCartItems(items, menuById);

  const { inheritedBranchId, resolvedAreaId, resolvedTableName, validWaiterId } = await resolvePlacement(req, {
    type, resolvedTableId, scanSessionId, branchId, isKioskOrder, validWaiterId: attribution.validWaiterId,
  });
  await preflightStockCheck(req, enrichedItems, inheritedBranchId);
  await detachStalePaidBill(req, type, resolvedTableId);

  const { primaryDocData, counterDocData, hasKitchenWork } = buildOrderDocs(req, {
    enrichedItems, authoritativeTotal, type, orderId, inheritedBranchId, validUserId,
    resolvedSource, clientIdempotencyKey, resolvedTableId, cleanCustomerName, cleanPhone,
    note, paymentMethod, pickupTime, resolvedPickupLocation, scanSessionId, validWaiterId,
    authoritativeTip, authoritativeCouponCode, authoritativeCouponDiscount,
    authoritativePointsRedeemed, authoritativeWalletPaid, taxBreakdown, wantsDelivery,
    cleanDeliveryAddress, authoritativeDeliverySlab, authoritativeDeliveryFee,
    authoritativeDeliveryDistance, authoritativeDeliveryCoords,
  });

  const persisted = await persistOrderDocs(req, {
    primaryDocData, counterDocData, validUserId, clientIdempotencyKey, authoritativeSubtotal,
    authoritativePointsRedeemed, authoritativeCouponCode, authoritativeCouponDiscount,
  });
  if (persisted.replay) return persisted.replay;
  const { savedOrder, counterSideOrder } = persisted;

  bumpMenuItemOrderCounts(savedOrder.items, savedOrder.restaurant);

  // Counter-side follow-ups (committed above together with the
  // primary doc). Inventory deduct runs now because the counter doc
  // skips 'preparing', where the normal deduction fires.
  if (counterSideOrder) {
    bumpMenuItemOrderCounts(counterSideOrder.items, counterSideOrder.restaurant);
    try {
      const { deductInventoryForOrder } = require('../controllers/inventoryController');
      deductInventoryForOrder(counterSideOrder, tenantId(req), req.user?._id)
        .catch(err => logger.warn(`Counter-split inventory deduct failed for ${counterSideOrder.orderId}: ${err.message}`));
    } catch (err) { logger.warn('Counter-split inventory setup failed:', err.message); }
  }

  // Everything below is notification / socket fan-out. It is queued
  // and run AFTER the response is sent so a slow or failing
  // Notification write can never delay or fail a committed order.
  const postResponseTasks = buildCreateOrderNotificationTasks({
    savedOrder, counterSideOrder, settings, hasKitchenWork, type, validTableId,
    resolvedTableId, resolvedAreaId, resolvedTableName, authoritativeTotal,
  });

  // Inventory deduction for the kitchen-bypass path. The normal flow
  // runs deductInventoryForOrder when status transitions to
  // 'preparing'. Counter-only orders skip that transition (they're
  // saved as 'ready' from the start), so without this they'd never
  // decrement stock — bottles of water would never tick down.
  if (!hasKitchenWork) {
    try {
      const { deductInventoryForOrder } = require('../controllers/inventoryController');
      const restaurantId = tenantId(req);
      if (restaurantId) {
        deductInventoryForOrder(savedOrder, restaurantId, req.user?._id)
          .then(result => {
            if (result.errors.length > 0) {
              logger.warn(`Inventory deduction warnings for ${savedOrder.orderId}:`, result.errors);
            }
          })
          .catch(err => logger.warn(`Inventory deduction failed for ${savedOrder.orderId}: ${err.message}`));
      }
    } catch (err) { logger.warn('Inventory deduction setup failed:', err.message); }
  }

  await occupyTableForNewOrder(req, savedOrder, type, resolvedTableId);

  // Issue a kiosk-only tracking token so the kiosk's OrderToken
  // screen can poll status without auth or scan token. Other channels
  // already have proper auth paths to /orders/:id/detail.
  const trackingToken = savedOrder.source === 'kiosk'
    ? signKioskTrackingToken(savedOrder.orderId, savedOrder.restaurant)
    : undefined;

  // Split-cart response — frontend pushes BOTH orders to localStorage
  // so the customer's Orders tab renders each as its own card.
  return reply(201, {
    success: true,
    order: savedOrder,                   // primary (kitchen) doc
    splitOrder: counterSideOrder || null, // counter-side doc when cart was mixed
    isSplit: !!counterSideOrder,
    trackingToken,
  }, postResponseTasks.map(([label, task]) => [`createOrder ${label}`, task]));
}

module.exports = {
  createOrder,
  // phases exported for unit tests / reuse
  checkIdempotency,
  validateOrderShape,
  resolveAttribution,
  normaliseContactFields,
  verifyDineInScan,
  buildOrderDocs,
  VALID_ORDER_SOURCES,
};
