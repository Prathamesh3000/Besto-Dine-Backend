/**
 * kitchenService — chef KDS reads + KOT reprint.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31).
 */
const Order = require('../models/order');
const Table = require('../models/table');
const logger = require('../utils/logger');
const { getIO, emitToAdmin, emitToKitchen } = require('../utils/socket');
const { tenantFilter } = require('../utils/tenantScope');
const { getMergeGroupNames } = require('../utils/tableMerge');
const { httpError, reply } = require('./orderErrors');
const { staffBranchFilter } = require('./orderAccess');
const { formatKitchenOrder, sortKitchenOrders, formatCompletedKitchenOrder } = require('./orderFormatters');

// "This order involved the kitchen": at least one kitchen/bar line, or a
// legacy order whose items predate the prepStation field.
function buildKitchenInvolvementFilter() {
  return {
    $or: [
      { 'items.prepStation': { $in: ['kitchen', 'bar'] } },
      { 'items.prepStation': { $exists: false } },
    ],
  };
}

// ── Kitchen Orders (Chef Dashboard) ─────────────────────────────────────────
// Returns orders filtered by the logged-in chef's kitchenResponsibility.
// Chef with 'veg' only sees orders that have at least one veg item, etc.
async function getKitchenOrders(req) {
  const chefUser = req.user;
  const responsibility = chefUser?.kitchenResponsibility || 'both';

  const activeStatuses = ['new', 'preparing', 'ready'];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);
  // Counter-only orders (water, packaged ice cream, etc.) skip the
  // chef workflow — they're saved as `status: 'ready'` with every
  // item marked `prepStation: 'counter'`. Filter them out of the
  // chef KDS so a chef doesn't see a card they have nothing to do on.
  //
  // Correct semantics: "at least one item needs the kitchen". $ne on
  // an array field rejects docs where ANY element equals 'counter',
  // which would wrongly hide MIXED orders too — chef must see those.
  // Use $in over the kitchen+bar set, OR-ed with a legacy-data clause
  // (orders saved before the prepStation field existed don't have
  // it on their items and would otherwise vanish from the KDS).
  const kitchenInvolvementFilter = buildKitchenInvolvementFilter();
  // Nested populate for table.area.name so the chef UI can display a
  // proper floor/section label instead of the raw ObjectId. The
  // `completedToday` tally is a pure count — no need to format those
  // rows, so we only fetch the minimum (_id + updatedAt) for it.
  const [liveOrders, servedTodayCount] = await Promise.all([
    Order.find({ status: { $in: activeStatuses }, ...tf, ...sbf, ...kitchenInvolvementFilter })
      .populate({ path: 'table', select: 'name area mergedWith', populate: { path: 'area', select: 'name' } })
      .populate('chef', 'name')
      .sort({ createdAt: -1 }),
    // Same window as getCompletedKitchenOrders (servedAt, falling back to
    // updatedAt for legacy rows) so the badge count matches the drawer.
    Order.countDocuments({
      status: 'served',
      ...tf,
      ...sbf,
      $and: [
        { $or: [
          { servedAt: { $gte: todayStart } },
          { servedAt: { $exists: false }, updatedAt: { $gte: todayStart } },
        ] },
        kitchenInvolvementFilter,
      ],
    }),
  ]);

  // For orders whose leader table has siblings (merged group), batch-
  // fetch every sibling's name so the kitchen sees "Table 5, 6, 7"
  // instead of just the leader. Doing it as one collated find avoids
  // N+1 queries on a busy board.
  const mergedSiblingIds = new Set();
  for (const o of liveOrders) {
    if (o.table?.mergedWith?.length) {
      for (const sid of o.table.mergedWith) mergedSiblingIds.add(String(sid));
    }
  }
  const siblingNames = new Map();
  if (mergedSiblingIds.size > 0) {
    const siblings = await Table.find(
      { _id: { $in: [...mergedSiblingIds] }, ...tf },
      'name'
    ).lean();
    for (const s of siblings) siblingNames.set(String(s._id), s.name);
  }
  const mergedLabelFor = (tableDoc) => {
    if (!tableDoc?.mergedWith?.length) return tableDoc?.name || null;
    const names = [tableDoc.name, ...tableDoc.mergedWith.map(id => siblingNames.get(String(id))).filter(Boolean)];
    return names.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })).join(', ');
  };

  // Kanban board only ever renders new / preparing / ready. Previously
  // we also merged `servedToday` into this list "just in case the UI
  // wants them" — but nothing renders them, and keeping them in the
  // response created a class of "count says N but no cards" bugs where
  // filtering logic upstream of the buckets miscounted served rows.
  let orders = liveOrders;

  // Filter by chef's kitchen responsibility (veg/nonveg/both)
  if (responsibility !== 'both' && chefUser?.role === 'chef') {
    const targetVegType = responsibility === 'veg' ? 'veg' : 'non-veg';
    orders = orders.filter(o => {
      // Show order if it has at least one item matching the chef's responsibility
      // Also show orders with no vegType set (legacy data) and orders already assigned to this chef
      if (o.chef && o.chef._id?.toString() === chefUser._id.toString()) return true;
      return o.items.some(item => !item.vegType || item.vegType === targetVegType);
    });
  }

  // For 'preparing' orders assigned to another chef, hide them
  orders = orders.filter(o => {
    if (o.status === 'preparing' && o.chef && chefUser?.role === 'chef') {
      return o.chef._id?.toString() === chefUser._id.toString() || o.chef.toString() === chefUser._id.toString();
    }
    return true;
  });

  // Scheduled-takeaway orders are NOT hidden anymore — the chef
  // dashboard now has an "Upcoming Orders" column so the kitchen
  // can see future pickups at a glance. The bucket assignment
  // below distinguishes scheduled from ready_to_prepare and the
  // UI files them into the right column. Items the chef has
  // already started (status >= preparing) always show regardless.

  const now = Date.now();
  const formattedOrders = orders.map((o) => formatKitchenOrder(o, now, mergedLabelFor));
  sortKitchenOrders(formattedOrders);

  // Count today's completed
  const completedToday = servedTodayCount;

  // serverTime anchors the client-side elapsed timer. The chef dashboard
  // subtracts (Date.now() - serverTime) from `now` on every tick, so a
  // tablet with a skewed clock still shows the true age of each order.
  return reply(200, {
    success: true,
    orders: formattedOrders,
    completedToday,
    serverTime: new Date().toISOString(),
  });
}

// GET /api/v1/orders/kitchen/completed
//
// The chef dashboard showed a "Completed" tally as a read-only <div>
// badge. Tapping it did nothing, because there was no completed-orders
// view to open and no endpoint behind one — the count was the entire
// feature. A chef who wanted to check what had already gone out (did
// table 7's order actually leave? what did we send at 1pm?) had no way
// to look.
//
// Mirrors getKitchenOrders' tenant/branch/kitchen-involvement scoping
// exactly, so the list and the count can never disagree about what
// "completed" means.
async function getCompletedKitchenOrders(req) {
  const tf = tenantFilter(req);
  const sbf = staffBranchFilter(req);

  // Same "this order involved the kitchen" rule as the live board.
  // Orders that were entirely counter-side (a bottled drink) never
  // appeared on the chef's board, so they must not appear in its
  // completed list either.
  const kitchenInvolvementFilter = buildKitchenInvolvementFilter();

  // Default window is today — the chef's question is almost always
  // "what have we sent out this shift", not "this month". `days`
  // widens it for the occasional lookback.
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 1, 1), 30);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  // Hard cap: this is a glanceable list on a kitchen tablet, not a
  // report. An unbounded find here would ship thousands of rows to a
  // device that can render a few dozen.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  // Both the date window and the kitchen-involvement rule are `$or`
  // clauses. They were previously spread into the same object literal,
  // so kitchenInvolvementFilter's `$or` silently overwrote the date
  // window — the drawer ignored Today / 3 days / Week and listed every
  // served order ever (with a total that never matched the board's
  // "Completed N" badge). `$and` keeps both.
  const query = {
    status: 'served',
    ...tf,
    ...sbf,
    $and: [
      {
        $or: [
          { servedAt: { $gte: since } },
          { servedAt: { $exists: false }, updatedAt: { $gte: since } },
        ],
      },
      kitchenInvolvementFilter,
    ],
  };

  const [orders, total] = await Promise.all([
    Order.find(query)
      .select('orderId type status total items table customerName createdAt updatedAt servedAt preparationStartedAt preparationCompletedAt')
      .populate({ path: 'table', select: 'name area', populate: { path: 'area', select: 'name' } })
      .sort({ servedAt: -1, updatedAt: -1 })
      .limit(limit)
      .lean(),
    Order.countDocuments(query),
  ]);

  return reply(200, {
    success: true,
    serverTime: new Date().toISOString(),
    total,
    orders: orders.map(formatCompletedKitchenOrder),
  });
}

// Re-fire a KOT to the kitchen for an existing order.
//
// Used by the Admin "KOT" drawer button (Tables dashboard) when staff
// need to re-alert the chef — e.g. a kitchen tablet rebooted and the
// order card fell off the board, or the admin wants to explicitly
// signal "look at this table's order now". Does NOT mutate the order;
// it only re-emits the `order:kot-reprint` socket event + writes an
// admin-side Notification so the reprint is auditable.
async function reprintKOT(req) {
  const { id } = req.params;

  const order = await Order.findOne({ _id: id, ...tenantFilter(req) })
    .populate('table', 'name mergedWith status')
    .lean();
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // Terminal orders don't need a KOT — the chef doesn't act on them.
  if (['cancelled'].includes(order.status)) {
    throw httpError(400, {
      success: false,
      code: 'ORDER_TERMINAL',
      message: `Cannot reprint KOT for a ${order.status} order.`,
    });
  }

  // For merged groups, show "Table 5, 6, 7" on the KOT so the chef
  // knows the food is going to the whole combined party, not just
  // the leader table. Falls back to the single table name for
  // non-merged orders.
  let kotTableLabel = order.table?.name || null;
  try {
    if (order.table?._id) {
      const names = await getMergeGroupNames(order.table._id, tenantFilter(req));
      if (names.length > 1) kotTableLabel = names.join(', ');
    }
  } catch { /* fall back to single name */ }

  try {
    const io = getIO();
    emitToKitchen(io, order.branch, 'order:kot-reprint', {
      orderId: order.orderId,
      _id: String(order._id),
      table: kotTableLabel,
      type: order.type,
      items: order.items.map(i => ({
        name: i.name,
        quantity: i.quantity,
        vegType: i.vegType || '',
        instructions: i.instructions || '',
      })),
      reprintedAt: new Date().toISOString(),
    });
    // Also nudge the admin audience so another admin viewing the
    // dashboard sees the reprint event in their notifications bell.
    emitToAdmin(io, order.branch, 'notification:new', {
      title: 'KOT Reprinted',
      description: `KOT for order ${order.orderId} was re-sent to the kitchen.`,
    });
  } catch { /* socket not critical */ }

  logger.info(`KOT reprinted for ${order.orderId} by ${req.user?._id || 'unknown'}`);

  return reply(200, {
    success: true,
    message: 'KOT re-sent to the kitchen.',
    order: {
      _id: order._id,
      orderId: order.orderId,
      table: kotTableLabel,
      items: order.items,
      type: order.type,
      customerName: order.customerName,
      createdAt: order.createdAt,
    },
  });
}

module.exports = {
  buildKitchenInvolvementFilter,
  getKitchenOrders,
  getCompletedKitchenOrders,
  reprintKOT,
};
