const mongoose = require('mongoose');
const Order = require('../models/order');
const Table = require('../models/table');
const MenuItem = require('../models/menuItem');
const Reservation = require('../models/reservation');
const AdvanceBooking = require('../models/advanceBooking');
const Promotion = require('../models/promotion');
const Coupon = require('../models/coupon');
const Request = require('../models/request');
const logger = require('../utils/logger');

const { tenantFilter, analyticsBranchFilter, pinnedBranchId, strictBranchFilter } = require('../utils/tenantScope');
const { tenantLookup } = require('../utils/tenantSafe');
const { sendServerError } = require('../utils/httpErrors');
const { featureTier } = require('../utils/featureAccess');

// Basic-tier revenue analytics covers short windows only (a month);
// Standard and above get the full 2-year range.
const BASIC_REPORT_MAX_DAYS = 31;

// Pay-first orders held from the kitchen until paid ('awaiting-payment',
// services/orderHoldService.js) are not orders yet: never in an order
// count, earnings, item sales or "today" figure. NOT_A_SALE is used by
// every earnings / items aggregation; HELD_STATUS where cancelled orders
// still count (order totals, cancellation rate).
const HELD_STATUS = 'awaiting-payment';
const NOT_A_SALE = ['cancelled', HELD_STATUS];

// Reports roll up by local-business-day / local-business-hour, not UTC.
// Without this, MongoDB's $hour/$dayOfMonth/$dateToString run in UTC and a
// cafe serving an 11 AM IST customer sees that order in "hour 5" (5:30 AM
// UTC) — which our 9–23 hour window silently drops from the hourly chart.
// Each tenant is reported in its own Restaurant.timezone (captured at
// onboarding, editable in Settings); ANALYTICS_TIMEZONE / Asia/Kolkata is
// the fallback when the tenant has none or it is not a valid IANA zone.
const DEFAULT_REPORT_TZ = process.env.ANALYTICS_TIMEZONE || 'Asia/Kolkata';

function reportTz(req) {
  const tz = typeof req?.restaurant?.timezone === 'string' ? req.restaurant.timezone.trim() : '';
  if (!tz) return DEFAULT_REPORT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_REPORT_TZ;
  }
}

// Start of "today" in REPORT_TZ, returned as a UTC Date for Mongo queries.
// Avoids pulling in moment/luxon just for this single call site.
function startOfLocalDay(tz = DEFAULT_REPORT_TZ, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const y = get('year'), m = get('month'), d = get('day');
  const hh = get('hour'), mm = get('minute'), ss = get('second');
  // `now` in tz reads as y-m-d hh:mm:ss. Strip the elapsed-today seconds
  // from the UTC instant to land on tz-midnight expressed in UTC ms.
  const elapsedMs = ((hh * 60 + mm) * 60 + ss) * 1000;
  return new Date(now.getTime() - elapsedMs);
}

exports.getStats = async (req, res) => {
  try {
    const REPORT_TZ = reportTz(req);
    const { earningsPeriod = 'daily', bookingTime = 'today' } = req.query;
    const tf = tenantFilter(req);
    // Phase 6 step 6 — branch filter applied to every Order/Table aggregation.
    // STRICT scope (no null fallback): "this branch's data only".
    const bf = analyticsBranchFilter(req);
    const tfb = { ...tf, ...bf };

    // Resolve the active branch from pin > query > none. Cast to a real
    // ObjectId — every consumer of this value spreads it into either a
    // .find() query (where Mongoose schema casting works) OR an
    // aggregation $match (where it doesn't). A plain string would
    // silently drop every row in the latter — that's the bug where
    // tenant-owner's Main dashboard showed 0 earnings / 0 top items
    // despite 66 paid orders in the DB.
    const pinned = pinnedBranchId(req);
    const queryBranch = req.query.branch;
    const rawActiveBranch = pinned
      // Only a well-formed 24-hex id; a typo / keyword ('all', 'abc', …)
      // means "no active branch" instead of a BSONError → 500.
      || (typeof queryBranch === 'string' && /^[a-f\d]{24}$/i.test(queryBranch) ? queryBranch : null);
    const activeBranch = rawActiveBranch
      ? (rawActiveBranch instanceof mongoose.Types.ObjectId
          ? rawActiveBranch
          : new mongoose.Types.ObjectId(String(rawActiveBranch)))
      : null;

    // STRICT scope for the Menu count: pinned admin sees items their
    // branch directly owns PLUS items they were opted into via
    // initializeBranchMenu. Tenant owner with `?branch=<id>` from the
    // header switcher gets the same strict view of that branch.
    // Bug fix 2026-05-20: dropped the `branch: null` fallback for the
    // tenant-owner-with-switcher path. After the null→Main migration
    // those records belong to Main, so including `null` was either a
    // no-op (already migrated) or a leak (older deploys still mid-
    // migration). Branches that never opted into "Copy menu from Main"
    // now correctly show 0.
    const menuBranchFilter = pinned
      ? { $or: [{ branch: pinned }, { 'branchPrices.branch': pinned }] }
      : (activeBranch
          ? { $or: [{ branch: activeBranch }, { 'branchPrices.branch': activeBranch }] }
          : {});
    const tfbMenu = { ...tf, ...menuBranchFilter };

    // STRICT for Coupons — branch admin sees only their own branch's
    // active offers. Tenant owner via switcher also gets strict scope
    // (`?branch=<id>` honored); without this, picking a sub-branch
    // still surfaced Main's 6 active offers in the dashboard count.
    const couponBranchFilter = activeBranch ? { branch: activeBranch } : {};
    const tfbCoupon = { ...tf, ...couponBranchFilter };

    // Validate query params
    if (!['daily', 'weekly', 'monthly'].includes(earningsPeriod)) {
      return res.status(400).json({ success: false, message: 'earningsPeriod must be daily, weekly, or monthly' });
    }

    const now = new Date();
    // today/tomorrow are the tz-local business-day window expressed in
    // UTC ms — the same window the operator thinks in when they read
    // "Today's Earnings" at the top of the dashboard.
    const today = startOfLocalDay(REPORT_TZ, now);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    // Month-to-date start, expressed in REPORT_TZ then lifted to UTC ms.
    // Used by the "Most Selling Items" card so the operator sees
    // cumulative day-by-day sales from the 1st of the current month
    // through today, not just today in isolation.
    const monthDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const monthParts = monthDayFmt.formatToParts(today);
    const todayDayOfMonth = Number(monthParts.find(x => x.type === 'day').value);
    const monthStart = new Date(today.getTime() - (todayDayOfMonth - 1) * 86400000);

    // ── Run independent queries in parallel ──────────────────────────────
    const [
      todayOrderStats,
      pendingBreakdown,
      totalTables,
      activeTables,
      totalMenuItems,
      activeMenuItems,
      todayReservations,
      activeOffers,
      topSellingItems,
      liveOrders,
      earningsData,
      activeRequests,
      upcomingBookings
    ] = await Promise.all([
      // 1. Today's orders stats — single aggregation (per-tenant + branch)
      Order.aggregate([
        { $match: { createdAt: { $gte: today }, status: { $ne: HELD_STATUS }, ...tfb } },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          earnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ne: ['$status', 'cancelled'] }] }, '$total', 0] } }
        }}
      ]),

      // 2. Pending orders breakdown (per-tenant + branch)
      Order.aggregate([
        { $match: { status: { $in: ['new', 'preparing', 'ready'] }, ...tfb } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),

      // 3-4. Table counts (per-tenant + branch)
      Table.countDocuments(tfb),
      Table.countDocuments({ status: 'occupied', ...tfb }),

      // 5-6. Menu counts — STRICT for pinned admin (own branch items
      // + shared items opted-in via branchPrices). Was inclusive-with-
      // tenant-null — fixed per user report ("dashboard menu tab leak").
      MenuItem.countDocuments(tfbMenu),
      MenuItem.countDocuments({ status: 'active', ...tfbMenu }),

      // 7. Today's reservations — branch-pinned admin sees only their
      // branch's reservations (Reservation now has a branch field).
      Reservation.countDocuments({ date: { $gte: today, $lt: tomorrow }, ...tf, ...strictBranchFilter(req) }),

      // 8. Active offers — count COUPONS, not Promotion docs. The admin
      // "Offers & Promotions" page (Pages/Admin/Offers.jsx) is a coupon
      // manager — every card the user sees there is a Coupon row — and
      // its "Active" stat counts coupons where isActive=true AND today
      // is within startDate..endDate. The Dashboard card needs to match
      // that source of truth or the two screens disagree (e.g. page
      // says 6, dashboard said 10 because Promotion is a different
      // collection seeded with banner-style records).
      //
      // INCLUSIVE scope (shared null + selected branch) so tenant-wide
      // coupons (branch:null) still surface when an operator picks one
      // sub-branch from the dropdown — without this, a tenant whose
      // coupons all live at branch:null would see "Active Offers: 0"
      // the moment they switched away from "All branches".
      Coupon.countDocuments({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        ...tfbCoupon,
      }),

      // 9. Top selling items — month-to-date (1st of current month through
      // today) so the card accumulates day by day instead of resetting at
      // midnight. A fresh tenant on day 3 of the month sees the popular
      // items from days 1+2+3 combined, not just day 3's orders.
      Order.aggregate([
        { $match: { createdAt: { $gte: monthStart }, status: { $nin: NOT_A_SALE }, ...tfb } },
        { $unwind: '$items' },
        { $group: { _id: { name: '$items.name', menuItem: '$items.menuItem' }, count: { $sum: '$items.quantity' } } },
        { $sort: { count: -1 } },
        { $limit: 7 },
      ]),

      // 10. Live orders (limited to 6) — when a specific branch is
      // selected, we match on the TABLE's current branch (for dine-in)
      // OR the order's stamped branch (for takeaway / tables without a
      // branch). This avoids leaks from orders whose `branch` field was
      // wrongly set by an earlier migration and doesn't rely on a data
      // backfill to be run first.
      //
      // Window: today only. Without the createdAt clamp the card carried
      // forward last week's served/cancelled rows on a quiet day, which
      // made "Live" misleading — operators want a today-only snapshot
      // that resets at midnight.
      (async () => {
        const base = {
          status: { $in: ['new', 'preparing', 'ready', 'served', 'cancelled'] },
          createdAt: { $gte: today, $lt: tomorrow },
          ...tf,
        };
        // activeBranch resolved above: null when the operator selected
        // "All branches" or there's no pin. In that case we don't need
        // the $lookup — just apply tfb (which collapses to tf only).
        if (!activeBranch) {
          return Order.find({ ...base, ...bf })
            .populate('table', 'name')
            .sort({ createdAt: -1 })
            .limit(6)
            .lean();
        }
        const branchObj = new mongoose.Types.ObjectId(String(activeBranch));
        const rows = await Order.aggregate([
          { $match: base },
          // Tenant-matched inside the $lookup sub-pipeline (tenantFilter(req) carries the restaurant).
          tf.restaurant
            ? tenantLookup({ from: 'tables', localField: 'table', foreignField: '_id', as: 'tableDoc' }, tf.restaurant)
            : { $lookup: { from: 'tables', localField: 'table', foreignField: '_id', as: 'tableDoc' } }, // AUDIT-EXEMPT: no tenant on this request (superadmin); base $match is unscoped too
          { $addFields: { tableDoc: { $arrayElemAt: ['$tableDoc', 0] } } },
          { $match: {
              $or: [
                  // Dine-in WITH table: the order's table must be on this
                  // branch. We do NOT fall back to order.branch when the
                  // table exists but has no branch set — that fallback was
                  // letting wrongly-migrated orders leak through.
                  { 'tableDoc.branch': branchObj },
                  // No table (takeaway OR kiosk Eat Here): use order.branch
                  // directly. Kiosk dine-in orders have type='dine-in' and
                  // table=null because the customer picks up at the kiosk
                  // counter — without this branch they never surfaced on
                  // the Live Orders card.
                  { $and: [
                      { tableDoc: null },
                      { branch: branchObj },
                  ]},
              ],
          }},
          { $sort: { createdAt: -1 } },
          { $limit: 6 },
          { $project: {
              orderId: 1, type: 1, status: 1, total: 1, createdAt: 1,
              customerName: 1, items: 1, paymentMethod: 1, paymentStatus: 1,
              table: { _id: '$tableDoc._id', name: '$tableDoc.name' },
          }},
        ]);
        return rows;
      })(),

      // 11. Earnings aggregation — done in DB, not JS loops (per-tenant + branch)
      buildEarningsAggregation(earningsPeriod, today, tfb, REPORT_TZ),

      // 12. Customer requests — scoped to today AND to the selected
      // branch. createRequest stamps `branch` from the request's table
      // at creation time so this filter Just Works; tfb collapses to
      // `tf` (no branch filter) when the operator picked "All branches".
      // Window: today only. Same rationale as Live Orders above — a
      // request that's been pending since last week is no longer "live"
      // operational data, it's a hygiene problem. The forward fix in
      // utils/tableMerge.js auto-closes requests when a table goes free,
      // but the today-only clamp is a belt-and-braces guard against
      // anything that slips through.
      Request.find({
        status: { $in: ['pending', 'accepted'] },
        createdAt: { $gte: today, $lt: tomorrow },
        ...tfb,
      })
        .populate({ path: 'table', populate: { path: 'area', select: 'name' }, select: 'name area' })
        .populate('waiter', 'name')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      // 13. Bookings Overview — scope to the selected branch (same rule
      // as Live Orders). AdvanceBooking has a `branch` field since
      // Phase 6; without this filter, selecting "Wakad" on the
      // dashboard still leaked main-branch bookings into the card.
      AdvanceBooking.find({
        status: { $in: ['Pending', 'Confirmed'] },
        bookingDate: bookingTime === 'today' ? { $gte: today, $lt: tomorrow } : { $gte: tomorrow },
        ...tfb,
      })
        .populate('user', 'name mobile')
        .populate('hall', 'name')
        .populate('tables', 'name')
        .sort({ bookingDate: 1 })
        .limit(10)
        .lean()
    ]);

    // ── Format results ──────────────────────────────────────────────────
    const orderStats = todayOrderStats[0] || { count: 0, earnings: 0 };

    const pendingMap = {};
    pendingBreakdown.forEach(p => { pendingMap[p._id] = p.count });
    const pendingNew = pendingMap['new'] || 0;
    const pendingPreparing = pendingMap['preparing'] || 0;
    const pendingReady = pendingMap['ready'] || 0;
    const pendingOrdersCount = pendingNew + pendingPreparing + pendingReady;

    const freeTables = totalTables - activeTables;

    const topItemColors = ['#A855F7', '#C084FC', '#D8B4FE', '#E9D5FF', '#F3E8FF', '#A855F7', '#C084FC'];
    const formattedTopItems = (topSellingItems || []).map((item, i) => ({
      name: item._id.name || 'Unknown',
      count: item.count,
      color: topItemColors[i] || '#E9D5FF'
    }));
    const topItemsScope = 'monthToDate';

    const formattedLiveOrders = liveOrders.map(o => ({
      id: o._id,
      table: o.table?.name || 'Takeaway',
      orderId: o.orderId,
      items: (o.items || []).length,
      price: (o.total || 0).toFixed(2),
      status: o.status === 'new' ? 'New' :
              o.status === 'preparing' ? 'Preparing' :
              o.status === 'ready' ? 'Ready' :
              o.status === 'served' ? 'Served' : 'Cancelled',
      time: getTimeAgo(o.createdAt)
    }));

    const TYPE_LABELS = {
      water:  'Water',
      waiter: 'Call Waiter',
      bill:   'Bill',
      other:  'Assistance',
    };
    const formattedRequests = activeRequests.map(r => {
      const minAgo = Math.floor((Date.now() - new Date(r.createdAt)) / 60000);
      return {
        id: r._id,
        // tableId so the dashboard can deep-link to the right table drawer
        // when admin clicks "Assign to waiter".
        tableId: r.table?._id || null,
        table: r.table?.name || '?',
        location: r.table?.area?.name || '',
        type: r.type,
        typeLabel: TYPE_LABELS[r.type] || (r.type.charAt(0).toUpperCase() + r.type.slice(1)),
        status: r.status,
        waiterName: r.waiter?.name || null,
        isOverdue: r.status === 'pending' && minAgo > 5,
        time: minAgo < 1 ? 'Just now' : `${minAgo} min ago`,
        priority: r.priority
      };
    });

    const formattedBookings = upcomingBookings.map(b => {
      const tableName = b.tables?.length > 0 ? b.tables.map(t => t.name).join(', ') : (b.hall?.name || 'TBD');
      return {
        id: b._id,
        customer: b.user?.name || 'Guest',
        initial: b.user?.name ? b.user.name.split(' ').map(w => w[0]).join('').toUpperCase() : '?',
        contactNumber: b.user?.mobile || '',
        table: tableName,
        type: b.bookingType === 'hall' ? 'Event' : 'Table',
        status: b.status === 'Confirmed' ? 'Upcoming' : b.status,
        guests: b.guestCount,
        date: new Date(b.bookingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: b.bookingTime,
        notes: b.notes || 'No notes added',
        payment: {
          total: b.payment?.totalAmount || 0,
          advance: b.payment?.advancePaid || 0,
          balance: (b.payment?.totalAmount || 0) - (b.payment?.advancePaid || 0)
        }
      };
    });

    res.json({
      success: true,
      stats: {
        todayOrders: orderStats.count,
        todayEarnings: `₹${orderStats.earnings.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        pendingOrders: pendingOrdersCount,
        activeTables,
        freeTables,
        totalMenu: totalMenuItems,
        activeMenu: activeMenuItems,
        inactiveMenu: totalMenuItems - activeMenuItems,
        todayReservations,
        activeOffers
      },
      topItems: formattedTopItems,
      topItemsScope,
      liveOrders: formattedLiveOrders,
      tablesChartData: [
        { value: totalTables > 0 ? Math.round((activeTables / totalTables) * 100) : 0, color: '#007AFF' },
        { value: totalTables > 0 ? Math.round((freeTables / totalTables) * 100) : 100, color: '#E5E7EB' }
      ],
      pendingChartData: [
        { value: pendingNew, color: '#007AFF', label: 'New' },
        { value: pendingReady, color: '#22C55E', label: 'Ready' },
        { value: pendingPreparing, color: '#FF8800', label: 'Preparing' },
      ],
      earningsData: earningsData.data,
      earningsLabel: earningsData.label,
      earningsSummary: earningsData.summary,
      customerRequests: formattedRequests,
      bookings: formattedBookings
    });
  } catch (error) {
    logger.error('Telemetry Error:', { error: error.message });
    sendServerError(res, error, 'telemetryController.getStats');
  }
};

// ── Business Reports — historical earnings + top-selling over a date range ──
// The Dashboard cards only ever show the *current* window (today / month-to-
// date) and reset at the period boundary, so last month's numbers vanish from
// the operator's view even though the orders persist. This endpoint lets the
// admin pick any [from, to] range and pull the same two business signals —
// Earnings (bucketed) and Most Selling Items — for that historical window, so
// the record is always retrievable for analysis / export.

// Local-midnight (REPORT_TZ) of a given Y-M-D, expressed as a UTC Date for
// Mongo. Mirrors startOfLocalDay() but for an arbitrary calendar date rather
// than "the day containing now". DST-safe (offset is computed at the target).
function localMidnightUTC(y, m, d, tz = DEFAULT_REPORT_TZ) {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(guess);
  const gv = (t) => Number(parts.find(p => p.type === t).value);
  const asLocal = Date.UTC(gv('year'), gv('month') - 1, gv('day'), gv('hour'), gv('minute'), gv('second'));
  const offset = asLocal - guess.getTime();          // tz offset in ms
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset);
}

// Parse a 'YYYY-MM-DD' string → { y, m, d } or null if malformed.
function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

// Build the earnings series for an arbitrary [fromUTC, toExclUTC) window.
// Bucket granularity auto-scales with the span so the chart stays readable:
//   single day  → hourly (9am–11pm, same window as the live dashboard)
//   ≤ 92 days   → one point per calendar day
//   longer      → one point per calendar month
async function buildRangeEarnings(fromUTC, toExclUTC, tf = {}, REPORT_TZ = DEFAULT_REPORT_TZ) {
  const spanDays = Math.round((toExclUTC.getTime() - fromUTC.getTime()) / 86400000);
  const matchPaid = { createdAt: { $gte: fromUTC, $lt: toExclUTC }, paymentStatus: 'Paid', status: { $nin: NOT_A_SALE }, ...tf };

  if (spanDays <= 1) {
    // Hourly — reuse the same 9–23 window the dashboard uses.
    const result = await Order.aggregate([
      { $match: matchPaid },
      { $group: { _id: { $hour: { date: '$createdAt', timezone: REPORT_TZ } }, total: { $sum: '$total' } } },
    ]);
    const hourMap = Object.fromEntries(result.map(r => [r._id, r.total]));
    const data = [];
    for (let hour = 9; hour <= 23; hour++) {
      data.push({ label: formatHourLabel(hour), value: Math.round(hourMap[hour] || 0) });
    }
    return { bucket: 'Hourly', data, summary: summarize(data) };
  }

  if (spanDays <= 92) {
    // Daily — one labelled point per calendar day in the range.
    const result = await Order.aggregate([
      { $match: matchPaid },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TZ } },
        total: { $sum: '$total' },
      }},
    ]);
    const map = Object.fromEntries(result.map(r => [r._id, r.total]));
    const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const labelFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, month: 'short', day: 'numeric' });
    const data = [];
    for (let t = fromUTC.getTime(); t < toExclUTC.getTime(); t += 86400000) {
      const day = new Date(t);
      const p = keyFmt.formatToParts(day);
      const key = `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
      data.push({ label: labelFmt.format(day), value: Math.round(map[key] || 0) });
    }
    return { bucket: 'Daily', data, summary: summarize(data) };
  }

  // Monthly — one labelled point per calendar month in the range.
  const result = await Order.aggregate([
    { $match: matchPaid },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: REPORT_TZ } },
      total: { $sum: '$total' },
    }},
  ]);
  const map = Object.fromEntries(result.map(r => [r._id, r.total]));
  const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit' });
  const labelFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, month: 'short', year: '2-digit' });
  const data = [];
  // Walk month by month from the from-date to the to-date (mid-month probe
  // avoids the 28/30/31 day boundary trap).
  let cursor = new Date(fromUTC.getTime());
  const seen = new Set();
  while (cursor.getTime() < toExclUTC.getTime()) {
    const p = keyFmt.formatToParts(cursor);
    const key = `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}`;
    if (!seen.has(key)) {
      seen.add(key);
      data.push({ label: labelFmt.format(cursor), value: Math.round(map[key] || 0) });
    }
    cursor = new Date(cursor.getTime() + 28 * 86400000);
  }
  return { bucket: 'Monthly', data, summary: summarize(data) };
}

// @desc    Historical business report (earnings + top items) for a date range
// @route   GET /api/v1/telemetry/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=<id>
// @access  Private/Admin (viewPayments-gated on the frontend nav)
exports.getReports = async (req, res) => {
  try {
    const REPORT_TZ = reportTz(req);
    const tf = tenantFilter(req);
    const bf = analyticsBranchFilter(req);
    const tfb = { ...tf, ...bf };

    // Resolve the [from, to] window. Defaults to the current calendar month
    // (1st → today) when the client sends nothing, matching the dashboard's
    // "Most Selling" month-to-date framing.
    const now = new Date();
    const todayStart = startOfLocalDay(REPORT_TZ, now);
    const monthFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const tp = monthFmt.formatToParts(todayStart);
    const ty = Number(tp.find(x => x.type === 'year').value);
    const tm = Number(tp.find(x => x.type === 'month').value);
    const td = Number(tp.find(x => x.type === 'day').value);

    const fromParsed = parseYmd(req.query.from);
    const toParsed = parseYmd(req.query.to);

    const fromUTC = fromParsed
      ? localMidnightUTC(fromParsed.y, fromParsed.m, fromParsed.d, REPORT_TZ)
      : localMidnightUTC(ty, tm, 1, REPORT_TZ);
    // `to` is inclusive of the whole day, so the exclusive upper bound is the
    // start of the day AFTER `to`.
    const toBase = toParsed ? toParsed : { y: ty, m: tm, d: td };
    const toExclUTC = new Date(localMidnightUTC(toBase.y, toBase.m, toBase.d, REPORT_TZ).getTime() + 86400000);

    if (toExclUTC.getTime() <= fromUTC.getTime()) {
      return res.status(400).json({ success: false, message: 'Invalid date range: "from" must be on or before "to".' });
    }
    // Guardrail — cap at ~2 years so a fat-fingered range can't melt Mongo.
    if (toExclUTC.getTime() - fromUTC.getTime() > 760 * 86400000) {
      return res.status(400).json({ success: false, message: 'Date range too large (max 2 years).' });
    }

    const rangeMatch = { createdAt: { $gte: fromUTC, $lt: toExclUTC }, status: { $ne: HELD_STATUS }, ...tfb };
    const spanMs = toExclUTC.getTime() - fromUTC.getTime();
    const rangeDays = Math.max(1, Math.round(spanMs / 86400000));

    if (req.restaurant && featureTier(req.restaurant, 'revenueAnalytics') === 'basic'
        && rangeDays > BASIC_REPORT_MAX_DAYS) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_LOCKED',
        feature: 'revenueAnalytics',
        requiredTier: 'standard',
        currentTier: 'basic',
        maxDays: BASIC_REPORT_MAX_DAYS,
        currentPlan: req.restaurant.subscription?.planName || 'Unknown',
        message: `Your plan's reports cover up to ${BASIC_REPORT_MAX_DAYS} days at a time. Upgrade for longer date ranges.`,
      });
    }
    // Earned = Paid and not cancelled (cancelled-but-unrefunded orders keep 'Paid').
    const PAID = { $and: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ne: ['$status', 'cancelled'] }] };

    // Previous equal-length window, immediately before `from` — powers the
    // period-over-period trend (is the business up or down vs last time?).
    const prevFromUTC = new Date(fromUTC.getTime() - spanMs);
    const prevRangeMatch = { createdAt: { $gte: prevFromUTC, $lt: fromUTC }, status: { $ne: HELD_STATUS }, ...tfb };

    const [earnings, itemFacetArr, orderFacetArr, prevAgg] = await Promise.all([
      // 1. Earnings time-series (auto-bucketed by span) — the headline trend.
      buildRangeEarnings(fromUTC, toExclUTC, tfb, REPORT_TZ),

      // 2. Item-level analytics in one pass (unwound line items, non-cancelled).
      Order.aggregate([
        { $match: { ...rangeMatch, status: { $nin: NOT_A_SALE } } },
        { $unwind: '$items' },
        { $facet: {
          topItems: [
            { $group: {
              _id: { name: '$items.name' },
              count: { $sum: '$items.quantity' },
              revenue: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.price', 0] }] } },
              category: { $first: { $ifNull: ['$items.category', ''] } },
            }},
            { $sort: { count: -1 } },
            { $limit: 15 },
          ],
          byCategory: [
            { $group: {
              _id: { $ifNull: ['$items.category', ''] },
              count: { $sum: '$items.quantity' },
              revenue: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.price', 0] }] } },
            }},
            { $sort: { revenue: -1 } },
          ],
          byVegType: [
            { $group: { _id: { $ifNull: ['$items.vegType', ''] }, count: { $sum: '$items.quantity' } } },
          ],
          itemsTotal: [
            { $group: { _id: null, qty: { $sum: '$items.quantity' } } },
          ],
        }},
      ]),

      // 3. Order-level analytics in one pass (every order in range). A
      //    computed `_channel` collapses delivery (takeaway + delivery.requested)
      //    into its own bucket so dine-in / takeaway / delivery split cleanly.
      Order.aggregate([
        { $match: rangeMatch },
        { $addFields: { _channel: { $cond: [{ $eq: ['$delivery.requested', true] }, 'delivery', '$type'] } } },
        { $facet: {
          totals: [
            { $group: {
              _id: null,
              orders: { $sum: 1 },
              paidOrders: { $sum: { $cond: [PAID, 1, 0] } },
              earnings: { $sum: { $cond: [PAID, '$total', 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
              tips: { $sum: { $ifNull: ['$tipAmount', 0] } },
              discounts: { $sum: { $add: [{ $ifNull: ['$couponDiscount', 0] }, { $ifNull: ['$manualDiscount', 0] }] } },
              refunded: { $sum: { $ifNull: ['$refundedAmount', 0] } },
              ratingSum: { $sum: { $ifNull: ['$rating', 0] } },
              ratingCount: { $sum: { $cond: [{ $gt: ['$rating', 0] }, 1, 0] } },
            }},
          ],
          byWeekday: [
            { $match: { paymentStatus: 'Paid', status: { $nin: NOT_A_SALE } } },
            { $group: { _id: { $dayOfWeek: { date: '$createdAt', timezone: REPORT_TZ } }, orders: { $sum: 1 }, earnings: { $sum: '$total' } } },
          ],
          byHour: [
            { $match: { paymentStatus: 'Paid', status: { $nin: NOT_A_SALE } } },
            { $group: { _id: { $hour: { date: '$createdAt', timezone: REPORT_TZ } }, orders: { $sum: 1 }, earnings: { $sum: '$total' } } },
          ],
          byChannel: [
            { $group: { _id: '$_channel', orders: { $sum: 1 }, earnings: { $sum: { $cond: [PAID, '$total', 0] } } } },
          ],
          bySource: [
            { $group: { _id: '$source', orders: { $sum: 1 }, earnings: { $sum: { $cond: [PAID, '$total', 0] } } } },
          ],
          byPayment: [
            { $match: { paymentStatus: 'Paid', status: { $nin: NOT_A_SALE } } },
            { $group: { _id: '$paymentMethod', orders: { $sum: 1 }, earnings: { $sum: '$total' } } },
          ],
          byDay: [
            { $match: { paymentStatus: 'Paid', status: { $nin: NOT_A_SALE } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TZ } }, earnings: { $sum: '$total' }, orders: { $sum: 1 } } },
            { $sort: { earnings: -1 } },
          ],
        }},
      ]),

      // 4. Previous-period totals (for the trend deltas).
      Order.aggregate([
        { $match: prevRangeMatch },
        { $group: {
          _id: null,
          orders: { $sum: 1 },
          paidOrders: { $sum: { $cond: [PAID, 1, 0] } },
          earnings: { $sum: { $cond: [PAID, '$total', 0] } },
        }},
      ]),
    ]);

    const itemFacet = itemFacetArr[0] || {};
    const orderFacet = orderFacetArr[0] || {};

    // ── Top items (+ revenue share of total item revenue) ──────────────────
    const topItemColors = ['#A855F7', '#C084FC', '#D8B4FE', '#E9D5FF', '#F3E8FF'];
    const categoryRows = (itemFacet.byCategory || []).map(c => ({ category: c._id || 'Uncategorised', count: c.count, revenue: Math.round(c.revenue || 0) }));
    const totalItemRevenue = categoryRows.reduce((s, c) => s + c.revenue, 0) || 0;
    const formattedTopItems = (itemFacet.topItems || []).map((item, i) => ({
      name: item._id.name || 'Unknown',
      count: item.count,
      revenue: Math.round(item.revenue || 0),
      category: item.category || '',
      revenueSharePct: totalItemRevenue > 0 ? Math.round((item.revenue / totalItemRevenue) * 1000) / 10 : 0,
      color: topItemColors[i % topItemColors.length],
    }));

    // ── Headline totals ────────────────────────────────────────────────────
    const t = (orderFacet.totals && orderFacet.totals[0]) || {};
    const earningsTotal = Math.round(t.earnings || 0);
    const paidOrders = t.paidOrders || 0;
    const ordersTotal = t.orders || 0;
    const cancelled = t.cancelled || 0;
    const avgOrderValue = paidOrders > 0 ? Math.round(earningsTotal / paidOrders) : 0;
    const itemsSold = (itemFacet.itemsTotal && itemFacet.itemsTotal[0]?.qty) || 0;

    const totals = {
      earnings: earningsTotal,
      orders: ordersTotal,
      paidOrders,
      cancelledOrders: cancelled,
      cancellationRate: ordersTotal > 0 ? Math.round((cancelled / ordersTotal) * 1000) / 10 : 0,
      avgOrderValue,
      itemsSold,
      tips: Math.round(t.tips || 0),
      discounts: Math.round(t.discounts || 0),
      refunds: Math.round(t.refunded || 0),
      avgDailyEarnings: Math.round(earningsTotal / rangeDays),
      avgRating: t.ratingCount > 0 ? Math.round((t.ratingSum / t.ratingCount) * 10) / 10 : 0,
      ratingCount: t.ratingCount || 0,
    };

    // ── Trend vs previous equal-length period ──────────────────────────────
    const prev = prevAgg[0] || { orders: 0, paidOrders: 0, earnings: 0 };
    const prevEarnings = Math.round(prev.earnings || 0);
    const prevAov = prev.paidOrders > 0 ? Math.round(prevEarnings / prev.paidOrders) : 0;
    const pct = (cur, base) => (base > 0 ? Math.round(((cur - base) / base) * 1000) / 10 : (cur > 0 ? null : 0));
    const trend = {
      prev: {
        from: null, to: null,             // filled below
        earnings: prevEarnings,
        orders: prev.orders || 0,
        avgOrderValue: prevAov,
      },
      earningsChangePct: pct(earningsTotal, prevEarnings),
      ordersChangePct: pct(ordersTotal, prev.orders || 0),
      aovChangePct: pct(avgOrderValue, prevAov),
    };

    // ── Pattern shaping (labels in REPORT_TZ) ──────────────────────────────
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // $dayOfWeek: 1=Sun..7=Sat
    const wkMap = Object.fromEntries((orderFacet.byWeekday || []).map(r => [r._id, r]));
    const byWeekday = WEEKDAYS.map((label, i) => {
      const row = wkMap[i + 1] || {};
      return { label, orders: row.orders || 0, earnings: Math.round(row.earnings || 0) };
    });

    const hourMap = Object.fromEntries((orderFacet.byHour || []).map(r => [r._id, r]));
    const byHour = [];
    for (let h = 0; h < 24; h++) {
      const row = hourMap[h];
      if (row) byHour.push({ hour: h, label: formatHourLabel(h), orders: row.orders, earnings: Math.round(row.earnings || 0) });
    }

    const shapeGroup = (rows, fallback = 'Unknown') => (rows || [])
      .map(r => ({ label: r._id || fallback, orders: r.orders || 0, earnings: Math.round(r.earnings || 0) }))
      .sort((a, b) => b.earnings - a.earnings);

    const byDayRows = orderFacet.byDay || [];
    const bestDay = byDayRows[0] ? { date: byDayRows[0]._id, earnings: Math.round(byDayRows[0].earnings), orders: byDayRows[0].orders } : null;
    const worstDay = byDayRows.length > 1 ? (() => {
      const w = byDayRows[byDayRows.length - 1];
      return { date: w._id, earnings: Math.round(w.earnings), orders: w.orders };
    })() : null;

    const vegMap = Object.fromEntries((itemFacet.byVegType || []).map(r => [r._id || 'unspecified', r.count]));

    // Echo the resolved range back as YYYY-MM-DD (REPORT_TZ).
    const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const fmtKey = (d) => {
      const p = dayKeyFmt.formatToParts(d);
      return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
    };
    trend.prev.from = fmtKey(prevFromUTC);
    trend.prev.to = fmtKey(new Date(fromUTC.getTime() - 86400000));

    res.json({
      success: true,
      range: {
        from: fmtKey(fromUTC),
        to: fmtKey(new Date(toExclUTC.getTime() - 86400000)),
        days: rangeDays,
      },
      earnings: { data: earnings.data, bucket: earnings.bucket, summary: earnings.summary },
      topItems: formattedTopItems,
      totals,
      trend,
      patterns: {
        byWeekday,
        byHour,
        byChannel: shapeGroup(orderFacet.byChannel),
        bySource: shapeGroup(orderFacet.bySource),
        byPayment: shapeGroup(orderFacet.byPayment, 'Not selected'),
        byCategory: categoryRows,
        byVegType: {
          veg: vegMap['veg'] || 0,
          nonVeg: vegMap['non-veg'] || 0,
          unspecified: (vegMap['unspecified'] || 0) + (vegMap[''] || 0),
        },
        bestDay,
        worstDay,
      },
    });
  } catch (error) {
    logger.error('Telemetry Reports Error:', { error: error.message });
    sendServerError(res, error, 'telemetryController.getReports');
  }
};

// @desc    Future earnings forecast (next N days) — a transparent, explainable
//          prediction model: linear trend (least-squares regression on the
//          recent daily-earnings series) modulated by per-weekday seasonality
//          factors. NOT a black-box ML model — every number is reproducible
//          from the returned history, which matters for a figure the owner
//          will plan spend against.
// @route   GET /api/v1/telemetry/forecast?lookback=60&horizon=30&branch=<id>
// @access  Private/Admin
exports.getForecast = async (req, res) => {
  try {
    const REPORT_TZ = reportTz(req);
    const tf = tenantFilter(req);
    const bf = analyticsBranchFilter(req);
    const tfb = { ...tf, ...bf };

    const lookbackDays = Math.min(180, Math.max(14, parseInt(req.query.lookback, 10) || 60));
    const horizonDays = Math.min(60, Math.max(7, parseInt(req.query.horizon, 10) || 30));

    const now = new Date();
    const todayStart = startOfLocalDay(REPORT_TZ, now);              // local midnight today (UTC instant)
    const histStart = new Date(todayStart.getTime() - (lookbackDays - 1) * 86400000);
    const histEndExcl = new Date(todayStart.getTime() + 86400000);   // include all of today

    // Daily PAID earnings over the lookback window.
    const result = await Order.aggregate([
      { $match: { createdAt: { $gte: histStart, $lt: histEndExcl }, paymentStatus: 'Paid', status: { $nin: NOT_A_SALE }, ...tfb } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TZ } },
        total: { $sum: '$total' },
      }},
    ]);
    const map = Object.fromEntries(result.map(r => [r._id, r.total]));

    const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const labelFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, month: 'short', day: 'numeric' });
    const wkFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, weekday: 'short' });
    const keyOf = (d) => {
      const p = keyFmt.formatToParts(d);
      return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
    };

    // Dense daily history (zero-filled) — the regression input.
    const history = [];
    for (let i = 0; i < lookbackDays; i++) {
      const d = new Date(histStart.getTime() + i * 86400000);
      const key = keyOf(d);
      history.push({ date: key, label: labelFmt.format(d), weekday: wkFmt.format(d), value: Math.round(map[key] || 0) });
    }

    // ── Model: weekday-DESEASONALISED linear trend ─────────────────────────
    // The naive "fit a line straight through daily totals" model overshot
    // badly: one big Saturday bends the whole trend line. Here we (1) learn a
    // per-weekday factor, (2) divide it out to get a smooth "level" series,
    // (3) fit the line to that level, (4) re-apply the weekday factor when
    // projecting. The slope is damped so long horizons can't run away. Defined
    // as a reusable closure so the back-test below fits the SAME model on a
    // training slice.
    const fitModel = (slice) => {
      const m = slice.length;
      const sum = slice.reduce((s, h) => s + h.value, 0);
      const avg = m > 0 ? sum / m : 0;
      const wkS = {}; const wkC = {};
      slice.forEach(h => { wkS[h.weekday] = (wkS[h.weekday] || 0) + h.value; wkC[h.weekday] = (wkC[h.weekday] || 0) + 1; });
      const wf = {};
      Object.keys(wkS).forEach(w => { const a = wkS[w] / wkC[w]; wf[w] = avg > 0 ? Math.max(0.3, Math.min(2.5, a / avg)) : 1; });
      const des = slice.map(h => { const f = wf[h.weekday] || 1; return f > 0 ? h.value / f : h.value; });
      const sx = (m * (m - 1)) / 2;
      const sxx = des.reduce((s, _v, i) => s + i * i, 0);
      const sxy = des.reduce((s, v, i) => s + i * v, 0);
      const sd = des.reduce((s, v) => s + v, 0);
      const den = (m * sxx - sx * sx) || 1;
      let slope = (m * sxy - sd * sx) / den;
      const maxStep = avg * 0.03;                 // ≤3% of an average day, per day
      if (maxStep > 0) slope = Math.max(-maxStep, Math.min(maxStep, slope));
      const intercept = (sd - slope * sx) / m;
      return { m, avg, wf, slope, levelAt: (t) => intercept + slope * t };
    };
    const projectWith = (model, startIdx, weekdays) =>
      weekdays.map((w, k) => Math.max(0, Math.round(model.levelAt(startIdx + k) * (model.wf[w] ?? 1))));

    const n = history.length;
    const ys = history.map(h => h.value);
    const model = fitModel(history);
    const overallAvg = model.avg;

    // Future calendar days for the horizon (today = index n-1; tomorrow = n).
    const futureDates = [];
    const futureWeekdays = [];
    for (let k = 0; k < horizonDays; k++) {
      const d = new Date(histEndExcl.getTime() + k * 86400000);
      futureDates.push(d);
      futureWeekdays.push(wkFmt.format(d));
    }
    const projected = projectWith(model, n, futureWeekdays);
    const forecast = projected.map((v, k) => ({
      date: keyOf(futureDates[k]), label: labelFmt.format(futureDates[k]), weekday: futureWeekdays[k], value: v,
    }));

    const sumSlice = (arr, k) => Math.round(arr.slice(0, k).reduce((s, x) => s + x.value, 0));
    const next7 = sumSlice(forecast, 7);
    const next15 = sumSlice(forecast, 15);
    const next30 = sumSlice(forecast, 30);
    const avgDailyForecast = forecast.length ? Math.round(forecast.reduce((s, x) => s + x.value, 0) / forecast.length) : 0;

    // ── Back-test for an HONEST accuracy figure ────────────────────────────
    // Hold out the most recent slice, fit the model on everything before it,
    // predict the held-out days, and measure mean error vs what actually
    // happened (MAPE → accuracy = 100 − MAPE). This is a real, reproducible
    // number — not a marketing claim.
    let accuracy = null; let mape = null;
    const holdout = Math.min(14, Math.floor(n / 3));
    if (n >= 21 && holdout >= 5) {
      const train = history.slice(0, n - holdout);
      const test = history.slice(n - holdout);
      const bm = fitModel(train);
      const preds = projectWith(bm, train.length, test.map(h => h.weekday));
      const errs = [];
      test.forEach((h, i) => { if (h.value > 0) errs.push(Math.abs(h.value - preds[i]) / h.value); });
      if (errs.length) {
        mape = Math.round((errs.reduce((s, v) => s + v, 0) / errs.length) * 1000) / 10;
        accuracy = Math.max(0, Math.min(100, Math.round((100 - mape) * 10) / 10));
      }
    }

    // Projected current-month close = month-to-date actual + forecast for the
    // days remaining in this calendar month.
    const tp = keyFmt.formatToParts(todayStart);
    const ty = Number(tp.find(x => x.type === 'year').value);
    const tm = Number(tp.find(x => x.type === 'month').value);
    const tdy = Number(tp.find(x => x.type === 'day').value);
    const monthPrefix = `${tp.find(x => x.type === 'year').value}-${tp.find(x => x.type === 'month').value}`;
    const daysInMonth = new Date(ty, tm, 0).getDate();
    const remainingDays = Math.max(0, daysInMonth - tdy);
    const monthToDate = Math.round(history.filter(h => h.date.startsWith(monthPrefix)).reduce((s, h) => s + h.value, 0));
    const monthRemainingForecast = sumSlice(forecast, remainingDays);
    const projectedMonthEnd = monthToDate + monthRemainingForecast;

    // Weekly % drift (more intuitive than per-day) and a deadbanded direction.
    const trendPctPerWeek = overallAvg > 0 ? Math.round((model.slope * 7 / overallAvg) * 1000) / 10 : 0;
    const direction = model.slope > overallAvg * 0.005 ? 'up' : model.slope < -overallAvg * 0.005 ? 'down' : 'flat';

    // Confidence prefers the measured back-test accuracy; falls back to data
    // volume when there isn't enough history to back-test.
    const activeDays = ys.filter(v => v > 0).length;
    const confidence = accuracy != null
      ? (accuracy >= 85 ? 'high' : accuracy >= 70 ? 'medium' : 'low')
      : (activeDays < 10 ? 'low' : activeDays < 25 ? 'medium' : 'high');

    // Chart series = recent actual tail + forecast, with a boundary marker so
    // the UI can render "you are here / forecast begins" on one LineChart.
    const tailLen = Math.min(14, lookbackDays);
    const tail = history.slice(-tailLen).map(h => ({ label: h.label, value: h.value }));
    const chartData = [...tail, ...forecast.map(f => ({ label: f.label, value: f.value }))];

    res.json({
      success: true,
      model: 'weekday-deseasonalised linear trend (back-tested)',
      lookbackDays,
      horizonDays,
      history: history.map(h => ({ date: h.date, label: h.label, value: h.value })),
      forecast,
      chart: { data: chartData, boundaryIndex: tail.length - 1 },
      summary: {
        next7,
        next15,
        next30,
        avgDailyForecast,
        monthToDate,
        monthRemainingForecast,
        projectedMonthEnd,
        remainingDaysInMonth: remainingDays,
        trendPctPerWeek,
        direction,
        confidence,
        accuracy,
        mape,
        activeDays,
        lookbackDays,
      },
    });
  } catch (error) {
    logger.error('Telemetry Forecast Error:', { error: error.message });
    sendServerError(res, error, 'telemetryController.getForecast');
  }
};

// ── Earnings aggregation — computed in MongoDB, not JS loops (per-tenant) ──
// All bucketing ($hour / $dayOfMonth / $dateToString) runs in REPORT_TZ so
// orders land in the business day the operator actually saw them placed.
function formatHourLabel(hour) {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
}

// Summary stats attached to every earnings payload. Keeps the frontend
// from re-deriving peak / average / total from the buckets.
function summarize(data, currentIndex = null) {
  const values = data.map(d => d.value);
  const total = values.reduce((s, v) => s + v, 0);
  const active = values.filter(v => v > 0);
  const avg = active.length ? Math.round(total / active.length) : 0;
  let peakIndex = -1;
  let peakValue = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peakValue) { peakValue = values[i]; peakIndex = i; }
  }
  return {
    total: Math.round(total),
    average: avg,
    peakIndex,
    peakLabel: peakIndex >= 0 ? data[peakIndex].label : null,
    peakValue,
    currentIndex,
  };
}

async function buildEarningsAggregation(period, today, tf = {}, REPORT_TZ = DEFAULT_REPORT_TZ) {
  if (period === 'weekly') {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    const result = await Order.aggregate([
      { $match: { createdAt: { $gte: weekStart }, paymentStatus: 'Paid', status: { $nin: NOT_A_SALE }, ...tf } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TZ } },
        total: { $sum: '$total' }
      }},
      { $sort: { _id: 1 } }
    ]);
    const map = Object.fromEntries(result.map(r => [r._id, r.total]));
    const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, weekday: 'short' });
    const data = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart.getTime() + d * 86400000);
      const parts = dayKeyFmt.formatToParts(day);
      const key = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
      data.push({
        label: weekdayFmt.format(day),
        value: Math.round(map[key] || 0),
      });
    }
    const todayKeyParts = dayKeyFmt.formatToParts(new Date());
    const todayKey = `${todayKeyParts.find(p => p.type === 'year').value}-${todayKeyParts.find(p => p.type === 'month').value}-${todayKeyParts.find(p => p.type === 'day').value}`;
    const todayIdxKey = data.findIndex((_, i) => {
      const day = new Date(weekStart.getTime() + i * 86400000);
      const p = dayKeyFmt.formatToParts(day);
      return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}` === todayKey;
    });
    return { label: 'Daily', data, summary: summarize(data, todayIdxKey >= 0 ? todayIdxKey : null) };
  }

  if (period === 'monthly') {
    // Month start in REPORT_TZ — reuse today's date string, swap day to 01.
    const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = dayKeyFmt.formatToParts(today);
    const y = Number(p.find(x => x.type === 'year').value);
    const m = Number(p.find(x => x.type === 'month').value);
    const todayDay = Number(p.find(x => x.type === 'day').value);
    // Approximate month-start by pulling back (todayDay - 1) days from today.
    const monthStart = new Date(today.getTime() - (todayDay - 1) * 86400000);
    const result = await Order.aggregate([
      { $match: { createdAt: { $gte: monthStart }, paymentStatus: 'Paid', status: { $nin: NOT_A_SALE }, ...tf } },
      { $group: {
        _id: { $dayOfMonth: { date: '$createdAt', timezone: REPORT_TZ } },
        total: { $sum: '$total' }
      }},
      { $sort: { _id: 1 } }
    ]);
    const daysInMonth = new Date(y, m, 0).getDate();
    const dayMap = Object.fromEntries(result.map(r => [r._id, r.total]));
    const data = [];
    for (let d = 1; d <= daysInMonth; d++) {
      data.push({ label: `${d}`, value: Math.round(dayMap[d] || 0) });
    }
    return { label: 'Daily', data, summary: summarize(data, todayDay - 1) };
  }

  // daily — hourly breakdown in REPORT_TZ
  const result = await Order.aggregate([
    { $match: { createdAt: { $gte: today }, paymentStatus: 'Paid', status: { $nin: NOT_A_SALE }, ...tf } },
    { $group: {
      _id: { $hour: { date: '$createdAt', timezone: REPORT_TZ } },
      total: { $sum: '$total' }
    }},
    { $sort: { _id: 1 } }
  ]);
  const hourMap = Object.fromEntries(result.map(r => [r._id, r.total]));
  const data = [];
  for (let hour = 9; hour <= 23; hour++) {
    data.push({
      label: formatHourLabel(hour),
      value: Math.round(hourMap[hour] || 0),
      hour,
    });
  }
  // Current hour in REPORT_TZ for the "you are here" marker.
  const nowHourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).find(p => p.type === 'hour').value;
  const nowHour = Number(nowHourStr);
  const currentIndex = nowHour >= 9 && nowHour <= 23 ? nowHour - 9 : null;
  return { label: 'Hourly', data, summary: summarize(data, currentIndex) };
}

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return new Date(date).toLocaleDateString();
}
