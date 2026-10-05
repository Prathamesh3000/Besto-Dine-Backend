/**
 * orderQueryService — read-only order endpoints (live / past / refunds /
 * table lookups / detail / my-orders / kiosk tracking).
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31). Query
 * logic unchanged; response rows are shaped by services/orderFormatters.js.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const logger = require('../utils/logger');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { httpError, reply } = require('./orderErrors');
const { staffBranchFilter, applySessionScope } = require('./orderAccess');
const {
  formatLiveOrder,
  formatPastOrder,
  formatOrderDetail,
  formatMyOrder,
} = require('./orderFormatters');

// ─── Kiosk order tracking ────────────────────────────────────────────
// Lightweight, polling-friendly endpoint that returns just the fields
// a kiosk's OrderToken screen needs to render live progress (status,
// payment status, prep timestamps). Authorisation is via a JWT issued
// at order creation time; the token is bound to the orderId so it
// can't be reused against another order.
//
// Returns 404 (not 401/403) on token failures so a guessed orderId
// can't be confirmed via timing.
async function trackKioskOrder(req) {
  const { orderId } = req.params;
  if (!orderId) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  const rawHeader = req.headers['x-kiosk-token'] || req.headers['authorization'] || '';
  const token = String(rawHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  let decoded;
  try {
    decoded = verifyTypedToken(token, TOKEN_TYPES.KIOSK);
  } catch {
    throw httpError(404, { success: false, message: 'Order not found' });
  }
  if (decoded?.kind !== 'kiosk-track' || String(decoded.orderId) !== String(orderId)) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  // Tenant guard: the lookup is scoped to the tenant the token was
  // issued for (bound at order creation), falling back to the request's
  // tenant context. A token presented on another tenant's host 404s.
  // Belt-and-braces — `orderId` already has a unique index globally,
  // but two tenants could theoretically have the same human-readable
  // ID under different schemas in future.
  const requestTenant = tenantId(req);
  if (requestTenant && decoded.restaurant && String(decoded.restaurant) !== String(requestTenant)) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }
  const order = await Order.findOne({ orderId, restaurant: decoded.restaurant || requestTenant || null }).lean();
  if (!order) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }
  if (decoded.restaurant && String(decoded.restaurant) !== String(order.restaurant || '')) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }
  if (order.source !== 'kiosk') {
    // Token is valid for this orderId but the order isn't a kiosk
    // order — refuse anyway, this token shouldn't exist.
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  return reply(200, {
    success: true,
    order: {
      orderId: order.orderId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      type: order.type,
      total: order.total,
      pickupLocation: order.pickupLocation,
      createdAt: order.createdAt,
      preparationStartedAt: order.preparationStartedAt || null,
      preparationCompletedAt: order.preparationCompletedAt || null,
      cancelledAt: order.cancelledAt || null,
    },
  });
}

async function getLiveOrders(req) {
  const { floor } = req.query;
  const activeStatuses = ['new', 'preparing', 'ready'];

  // Include today's served orders so WaiterOrders "Served" tab is populated
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Populate table with both name and area (area ObjectId) for floor filtering.
  // Phase 6 step 4: staffBranchFilter auto-scopes to the logged-in
  // staff's pinned branch (+ tenant-level orders). Tenant-level
  // staff see everything.
  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);
  // Floor staff must ALSO see takeaway/counter-pickup orders that carry no
  // branch routing (`branch: null`). staffBranchFilter pins a branch-locked
  // waiter to `{ branch: <id> }` and deliberately excludes null (legacy
  // dine-in data), but an un-routed takeaway counter order belongs to
  // whoever's on the floor — otherwise a branch-pinned waiter never sees
  // takeaways. So when a branch pin is active, widen the scope to
  // "(my branch) OR (any takeaway with no branch)".
  const branchScope = Object.keys(sbf).length
    ? { $or: [sbf, { type: 'takeaway', branch: null }] }
    : {};
  const [liveOrders, servedToday] = await Promise.all([
    Order.find({ status: { $in: activeStatuses }, ...tf, ...branchScope })
      .populate('table', 'name area assignedWaiter')
      .sort({ createdAt: -1 })
      .lean(),
    Order.find({ status: 'served', updatedAt: { $gte: todayStart }, ...tf, ...branchScope })
      .populate('table', 'name area assignedWaiter')
      .sort({ createdAt: -1 })
      .lean()
  ]);

  let orders = [...liveOrders, ...servedToday];

  // Filter by floor (area ID) if provided — always include takeaway orders (no table)
  if (floor) {
    orders = orders.filter(o => !o.table || (o.table.area && o.table.area.toString() === floor));
  }

  const formattedOrders = orders.map(formatLiveOrder);

  return reply(200, { success: true, orders: formattedOrders });
}

// Build a createdAt range filter for the Past Orders dashboard.
// Accepts either explicit `from`/`to` ISO strings OR a `dateRange` preset.
// Presets are evaluated in the server's local timezone — matches how the
// admin filter labels read ("Today", "Yesterday", "Last 7 Days", etc.).
function buildPastOrdersDateFilter({ dateRange, from, to }) {
  if (from || to) {
    const range = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) range.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) range.$lte = d;
    }
    return Object.keys(range).length ? range : null;
  }
  if (!dateRange) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  switch (dateRange) {
    case 'today':
      return { $gte: startOfToday };
    case 'yesterday': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 1);
      return { $gte: start, $lt: startOfToday };
    }
    case 'last7': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 6); // includes today → 7 days
      return { $gte: start };
    }
    case 'last30': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 29); // includes today → 30 days
      return { $gte: start };
    }
    default:
      return null;
  }
}

/**
 * GET /api/v1/orders/past
 *
 * Past orders feed for the admin dashboard + waiter history.
 *
 *   Query params (all optional):
 *     page, limit     — pagination (limit capped at 200)
 *     status          — 'served' | 'cancelled' (default: both)
 *     type            — 'dine-in' | 'takeaway'
 *     dateRange       — 'today' | 'yesterday' | 'last7' | 'last30'
 *     from, to        — ISO date strings (override dateRange)
 *     search          — matches orderId or customerName (case-insensitive)
 *     branch          — handled by staffBranchFilter (Sub Admins auto-scoped)
 *
 *   Response shape:
 *     { success, orders, pagination: { page, limit, total, pages },
 *       summary: { total, served, cancelled, revenue } }
 *
 *   The summary is computed over the FULL filtered set (not just the
 *   current page) so the admin stat cards render correct totals even
 *   when paginating.
 */
async function getPastOrders(req) {
  const pastStatuses = ['served', 'cancelled'];
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);
  // Mongoose find() auto-casts strings to ObjectId, but aggregate $match
  // does not — normalise any string ObjectId in the branch filter so the
  // list query and the summary aggregate match the same documents.
  if (typeof sbf.branch === 'string' && mongoose.Types.ObjectId.isValid(sbf.branch)) {
    sbf.branch = new mongoose.Types.ObjectId(sbf.branch);
  }

  // Base filter — everything EXCEPT the status constraint. We apply
  // status separately so the summary aggregate can count served vs
  // cancelled independently without the frontend having to round-trip.
  const base = { ...tf, ...sbf };

  const { type, search } = req.query;
  if (type === 'dine-in' || type === 'takeaway') {
    base.type = type;
  }

  const dateFilter = buildPastOrdersDateFilter(req.query);
  if (dateFilter) base.createdAt = dateFilter;

  if (search && String(search).trim()) {
    // Escape regex metacharacters so a stray "(" in search doesn't 500 Mongo.
    const safe = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = { $regex: safe, $options: 'i' };
    base.$or = [{ orderId: rx }, { customerName: rx }];
  }

  // Apply the caller's status filter on top of the base for the list
  // query; the aggregate below uses `base` + `$in: pastStatuses` so
  // the summary always reflects served+cancelled counts in the window.
  const listFilter = { ...base };
  const requestedStatus = req.query.status;
  if (requestedStatus && pastStatuses.includes(requestedStatus)) {
    listFilter.status = requestedStatus;
  } else {
    listFilter.status = { $in: pastStatuses };
  }

  const aggregateMatch = { ...base, status: { $in: pastStatuses } };

  const [orders, total, summaryAgg] = await Promise.all([
    Order.find(listFilter)
      .populate('table', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(listFilter),
    Order.aggregate([
      { $match: aggregateMatch },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$total', 0] } },
        },
      },
    ]),
  ]);

  // Shape the aggregate rows into the summary the UI consumes.
  // `total` / `revenue` in the summary cover BOTH statuses in the
  // filtered window — the listFilter's status clause only narrows
  // the paginated list, not the stat cards.
  const summary = { total: 0, served: 0, cancelled: 0, revenue: 0 };
  for (const row of summaryAgg) {
    const count = row.count || 0;
    summary.total += count;
    summary.revenue += row.revenue || 0;
    if (row._id === 'served') summary.served = count;
    else if (row._id === 'cancelled') summary.cancelled = count;
  }

  const formattedOrders = orders.map(formatPastOrder);

  return reply(200, {
    success: true,
    orders: formattedOrders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    summary,
  });
}

/**
 * GET /api/orders/refunds
 *
 * Admin Refunds Dashboard feed. Returns three buckets in a single call
 * so the UI can render stats + table without round-tripping multiple
 * endpoints:
 *
 *   - orders  : list of refund-relevant orders (already refunded OR
 *               cancelled-but-paid awaiting manual handling).
 *   - summary : counts + totals broken down by mode / status / today /
 *               this-week / this-month.
 *
 * Filters (query params, all optional):
 *   ?status      = refunded | partial | pending-manual | all (default all)
 *   ?method      = online | Wallet | Cash (raw payment method)
 *   ?from, ?to   = ISO date strings — inclusive
 *   ?page, ?limit= pagination (default 1, 20)
 *
 * Access: staff-only, branch-scoped.
 */
async function getRefunds(req) {
  const { status = 'all', method, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);

  // "Refund-relevant" — a refund has either already happened OR is
  // pending on a cancelled+paid order that the auto-refund couldn't
  // complete (cash, or gateway failure flagged to admin).
  const refundRelevant = {
    $or: [
      { refundedAmount: { $gt: 0 } },
      { status: 'cancelled', paymentStatus: 'Paid', amountPaid: { $gt: 0 } },
    ],
  };

  // Apply specific status filter from query (narrower view).
  const statusFilter = {};
  if (status === 'refunded') {
    statusFilter.paymentStatus = 'Refunded';
  } else if (status === 'partial') {
    statusFilter.$expr = {
      $and: [
        { $gt: ['$refundedAmount', 0] },
        { $lt: ['$refundedAmount', '$amountPaid'] },
      ]
    };
  } else if (status === 'pending-manual') {
    // Cancelled + paid + nothing refunded yet = admin needs to action.
    statusFilter.status = 'cancelled';
    statusFilter.paymentStatus = 'Paid';
    statusFilter.refundedAmount = { $in: [0, null, undefined] };
  }

  const methodFilter = method ? { paymentMethod: method } : {};

  // Unparseable dates are ignored (same as buildPastOrdersDateFilter) —
  // an Invalid Date would CastError the whole query into a 500.
  const dateFilter = {};
  const asDate = (v) => {
    if (!v || typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const fromDate = asDate(from);
  const toDate = asDate(to);
  if (fromDate) dateFilter.$gte = fromDate;
  if (toDate) dateFilter.$lte = toDate;
  const updatedAtFilter = Object.keys(dateFilter).length ? { updatedAt: dateFilter } : {};

  const finalQuery = {
    ...tf, ...sbf,
    ...refundRelevant,
    ...statusFilter,
    ...methodFilter,
    ...updatedAtFilter,
  };

  const [orders, total] = await Promise.all([
    Order.find(finalQuery)
      .select('orderId status paymentStatus paymentMethod total amountPaid refundedAmount razorpayPaymentId customerName phone type user branch createdAt updatedAt note')
      .populate('user', 'name email mobile')
      .populate('branch', 'name slug')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(finalQuery),
  ]);

  // ── Summary aggregation — always computed against the full
  //    refund-relevant set (ignores the status/method/date filters
  //    so the header cards don't move when the user filters below).
  const summaryMatch = { ...tf, ...sbf, ...refundRelevant };
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [agg] = await Order.aggregate([
    { $match: summaryMatch },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalRefunded: { $sum: { $ifNull: ['$refundedAmount', 0] } },
              fullCount: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Refunded'] }, 1, 0] } },
              partialCount: {
                $sum: {
                  $cond: [{
                    $and: [
                      { $gt: ['$refundedAmount', 0] },
                      { $lt: ['$refundedAmount', '$amountPaid'] },
                    ]
                  }, 1, 0]
                }
              },
              pendingManualCount: {
                $sum: {
                  $cond: [{
                    $and: [
                      { $eq: ['$status', 'cancelled'] },
                      { $eq: ['$paymentStatus', 'Paid'] },
                      { $gt: ['$amountPaid', 0] },
                      { $in: ['$refundedAmount', [0, null]] },
                    ]
                  }, 1, 0]
                }
              },
            },
          },
        ],
        today: [
          { $match: { updatedAt: { $gte: startOfDay } } },
          { $group: { _id: null, amount: { $sum: { $ifNull: ['$refundedAmount', 0] } }, count: { $sum: 1 } } },
        ],
        week: [
          { $match: { updatedAt: { $gte: startOfWeek } } },
          { $group: { _id: null, amount: { $sum: { $ifNull: ['$refundedAmount', 0] } }, count: { $sum: 1 } } },
        ],
        month: [
          { $match: { updatedAt: { $gte: startOfMonth } } },
          { $group: { _id: null, amount: { $sum: { $ifNull: ['$refundedAmount', 0] } }, count: { $sum: 1 } } },
        ],
      },
    },
  ]);

  const summary = {
    totalRefunded: agg?.totals?.[0]?.totalRefunded || 0,
    fullCount: agg?.totals?.[0]?.fullCount || 0,
    partialCount: agg?.totals?.[0]?.partialCount || 0,
    pendingManualCount: agg?.totals?.[0]?.pendingManualCount || 0,
    today: { amount: agg?.today?.[0]?.amount || 0, count: agg?.today?.[0]?.count || 0 },
    week: { amount: agg?.week?.[0]?.amount || 0, count: agg?.week?.[0]?.count || 0 },
    month: { amount: agg?.month?.[0]?.amount || 0, count: agg?.month?.[0]?.count || 0 },
  };

  return reply(200, {
    success: true,
    orders,
    summary,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// Get every active unpaid order on a table — independent-orders model.
// Returns an array sorted by createdAt asc so the admin / bill UI can
// list them in placement order ("Order #1", "Order #2", ...). Used by
// the admin Tables drawer, the customer bill preview, and the chef
// dashboard for the table-aggregation views.
async function getActiveOrdersListByTable(req) {
  const { tableId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(tableId)) {
    throw httpError(400, { success: false, message: 'Invalid table ID' });
  }
  const isGuestOrCustomer = !req.user || req.user.role === 'customer';
  const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;

  const filter = {
    table: tableId,
    status: { $in: ['new', 'preparing', 'ready', 'served'] },
    paymentStatus: { $ne: 'Paid' },
    ...tenantFilter(req),
  };
  if (isGuestOrCustomer) {
    filter.createdAt = { $gte: new Date(Date.now() - SESSION_WINDOW_MS) };
    // Session boundary — a guest sees only their own scan session's
    // orders; a logged-in customer only their own. Stops a previous
    // diner's served-but-unpaid order leaking into a fresh scan.
    applySessionScope(filter, req);
  }

  const orders = await Order.find(filter)
    .populate('items.menuItem', 'name image vegType')
    .populate({
      path: 'table',
      select: 'name area',
      populate: { path: 'area', select: 'name' },
    })
    .sort({ createdAt: 1 })
    .lean();

  return reply(200, { success: true, orders });
}

// Get active order for a specific table (includes served but unpaid orders)
async function getActiveOrderByTable(req) {
  const { tableId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(tableId)) {
    throw httpError(400, { success: false, message: 'Invalid table ID' });
  }

  const activeStatuses = ['new', 'preparing', 'ready', 'served'];

  // Rolling 12-hour window for guests / customers ONLY — stops a
  // yesterday's "served-but-never-paid" order from leaking to today's
  // fresh guest who just scanned the same QR. Staff (admin / waiter /
  // captain / chef) MUST see every still-occupied order regardless of
  // age so they can settle or clear stuck tables; capping their view
  // would break the admin's TablesDashboard drawer for any table whose
  // active order is more than 12 hours old.
  const isGuestOrCustomer = !req.user || req.user.role === 'customer';

  // `includePaid=true` lets the customer/guest order-tracking poller
  // see the order AFTER payment lands so the "Make Payment" button can
  // flip to "Paid · Thank you!" and the guest auto-exit timer kicks
  // in. Default behavior still drops paid orders so callers like Cart
  // / NotificationContext / admin TablesDashboard don't see stale
  // settled rows when they ask "is this table still active".
  const includePaid = String(req.query.includePaid || '').toLowerCase() === 'true';

  const findFilter = {
    table: tableId,
    status: { $in: activeStatuses },
    ...(includePaid ? {} : { paymentStatus: { $ne: 'Paid' } }),
    ...tenantFilter(req),
  };
  if (isGuestOrCustomer) {
    const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;
    findFilter.createdAt = { $gte: new Date(Date.now() - SESSION_WINDOW_MS) };
    // Session boundary — scope to the caller's own scan session
    // (guest) or own orders (customer) so a previous diner's
    // served-but-unpaid order can't surface on a fresh scan.
    applySessionScope(findFilter, req);
  }

  const order = await Order.findOne(findFilter)
    .populate('items.menuItem', 'name image vegType')
    .populate({
      path: 'table',
      select: 'name area',
      populate: { path: 'area', select: 'name' }
    })
    .sort({ createdAt: -1 })
    .lean();

  if (!order) {
    return reply(200, { success: true, order: null });
  }

  // Ownership: authenticated customers can only see orders linked to them
  // Guests at this table (no req.user) are allowed via QR session
  if (req.user && req.user.role === 'customer' && order.user && order.user.toString() !== req.user.id.toString()) {
    throw httpError(403, { success: false, message: 'Not authorized to view this order' });
  }

  return reply(200, { success: true, order });
}

// Get single order by ID (for customer tracking)
async function getOrderById(req) {
  const { id } = req.params;

  // Accept both MongoDB _id and orderId string (e.g. ORD-0001) — scoped to tenant.
  // Branch is populated with the customer-visible location fields so the
  // tracking page can render Pickup Details (name + address + phone)
  // without a second round-trip. Email is intentionally omitted.
  const tf = tenantFilter(req);
  const branchFields = 'name addressLine1 addressLine2 city state postalCode country contactPhone';
  let order;
  if (mongoose.Types.ObjectId.isValid(id)) {
    order = await Order.findOne({ _id: id, ...tf })
      .populate('table', 'name')
      .populate('branch', branchFields);
  }
  if (!order) {
    order = await Order.findOne({ orderId: id, ...tf })
      .populate('table', 'name')
      .populate('branch', branchFields);
  }

  if (!order) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  // ── R-06: authorization gate ─────────────────────────────────────
  // This endpoint is `optionalAuth` (so guests can track QR orders),
  // which previously meant a guest with no credentials could fetch
  // ANY order in the tenant — including paid receipts from other
  // tables — just by knowing the orderId / _id. Leaks PII
  // (customerName, phone, line-items, total, payment method).
  //
  // Three legitimate caller shapes after this fix:
  //   1. Staff of this tenant — any order, existing behavior.
  //   2. Logged-in customer — only orders they placed (order.user).
  //   3. Guest / post-login-guest — must present an X-Scan-Token
  //      whose sessionId matches the order's `scanSessionId` stamped
  //      at creation. Mirrors the socket-room CRIT-12 gate, so HTTP
  //      and WebSocket access rules agree.
  //
  // Orders created before CRIT-12 shipped have `scanSessionId = null`
  // and are therefore unreachable to the guest path — the privacy-safe
  // default. Logged-in customers who claim such orders reach them via
  // the owner check above.
  const STAFF_ROLES_SET = new Set(['admin', 'manager', 'captain', 'waiter', 'chef', 'superadmin']);
  const caller = req.user || null;
  let authorized = false;
  let branchBlocked = false;

  if (caller && STAFF_ROLES_SET.has(caller.role)) {
    // Staff of the tenant — tenant match is already enforced by the
    // query above; role gives them view rights on any order, except
    // that branch-pinned staff only see their own branch's orders
    // (same rule as the list queries and PATCH /:id/status).
    const pinned = pinnedBranchId(req);
    const orderBranch = order.branch?._id || order.branch;
    if (pinned && orderBranch && String(orderBranch) !== String(pinned)) {
      branchBlocked = true;
    } else {
      authorized = true;
    }
  } else if (caller && caller.role === 'customer' && order.user
    && String(order.user) === String(caller.id)) {
    // Logged-in customer reading their own order.
    authorized = true;
  }

  // Fallback — scanToken path. Legitimate for pure guests AND for a
  // customer who placed their order as a guest and only logged in
  // afterwards (order.user is null but they still hold the session's
  // scanToken). Strict match on sessionId; tenant also cross-checked.
  if (!authorized && !branchBlocked && order.scanSessionId) {
    const scanToken = req.headers['x-scan-token'];
    if (scanToken) {
      try {
        const decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
        const tenant = tenantId(req);
        const tenantMatch = !tenant || !decoded.restaurantId
          || String(decoded.restaurantId) === String(tenant);
        if (
          tenantMatch
          && decoded.sessionId
          && String(decoded.sessionId) === String(order.scanSessionId)
        ) {
          authorized = true;
        }
      } catch { /* invalid / expired scanToken → stay denied */ }
    }
  }

  if (!authorized) {
    logger.warn('getOrderById: unauthorized access blocked', {
      orderId: order.orderId,
      callerRole: caller?.role || 'guest',
      callerId: caller?.id || null,
      hasScanToken: Boolean(req.headers['x-scan-token']),
    });
    // 404 (not 403) so the response doesn't confirm existence of an
    // order whose id the caller guessed. Matches the socket-room gate
    // which silently drops unauthorised joins.
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  const formatted = formatOrderDetail(order);

  return reply(200, { success: true, order: formatted });
}

// Get orders for the logged-in customer
async function getMyOrders(req) {
  const userId = req.user.id;
  // Validate + clamp pagination
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  // Phase 6 branch-scoping: customer's reorder history is filtered
  // by their active branch (if any) so they only see orders from
  // the location they're currently at + tenant-level orders.
  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);
  const scope = { user: userId, ...tf, ...sbf };
  const [orders, totalCount] = await Promise.all([
    Order.find(scope)
      .populate('table', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(scope)
  ]);

  const formattedOrders = orders.map(formatMyOrder);

  return reply(200, { success: true, orders: formattedOrders, pagination: { page, limit, total: totalCount, pages: Math.ceil(totalCount / limit) } });
}

module.exports = {
  trackKioskOrder,
  getLiveOrders,
  buildPastOrdersDateFilter,
  getPastOrders,
  getRefunds,
  getActiveOrdersListByTable,
  getActiveOrderByTable,
  getOrderById,
  getMyOrders,
};
