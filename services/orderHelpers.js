/**
 * orderHelpers — small shared building blocks for the order services.
 *
 * Extracted verbatim from controllers/orderController.js (BUGS_REPORT #31).
 * Pure line-item helpers, the bestseller counter, the order-scoped socket
 * fan-out helpers, the post-response task runner and the kiosk tracking
 * token signer. No request/response handling lives here.
 */
const mongoose = require('mongoose');
const MenuItem = require('../models/menuItem');
const logger = require('../utils/logger');
const { getIO, emitToStaff } = require('../utils/socket');
const { signTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const { lineItemsSubtotal } = require('./orderBillMath');
const { httpError } = require('./orderErrors');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Bestseller counter — bumps MenuItem.orderCount by the quantity of
// each line item every time an order is created or items are appended.
// Used by the customer/admin menu list to sort bestsellers to the top.
//
// Notes:
//   - `items` may contain mock IDs / customisations whose menuItem field
//     isn't a valid ObjectId. We silently skip those.
//   - Wrapped in try/catch so a counter-update failure NEVER fails the
//     order itself. The order has already been saved by the time we get
//     here; losing a count update is preferable to losing the sale.
//   - Tenant-scoped — the filter prevents cross-tenant inc in the very
//     unlikely case a stray order item carries a foreign menuItem id.
async function bumpMenuItemOrderCounts(items, restaurantId) {
  if (!Array.isArray(items) || items.length === 0 || !restaurantId) return;
  const tally = new Map();
  for (const it of items) {
    if (!it || !it.menuItem || !mongoose.Types.ObjectId.isValid(it.menuItem)) continue;
    const qty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
    const key = String(it.menuItem);
    tally.set(key, (tally.get(key) || 0) + qty);
  }
  if (tally.size === 0) return;
  const ops = Array.from(tally, ([id, qty]) => ({
    updateOne: {
      filter: { _id: id, restaurant: restaurantId },
      update: { $inc: { orderCount: qty } },
    },
  }));
  try {
    await MenuItem.bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.warn(`bumpMenuItemOrderCounts failed: ${err.message}`);
  }
}

// Helper — when items are appended to an active order, revert the
// status so the chef KDS picks the order back up out of the "Ready"
// (or "Served") column. Without this, new items silently piggy-back
// on a card that's already finished and the chef never cooks them.
//
// Mutates the order in place but does NOT save — callers save once
// after their own field updates so we don't trigger two save()s for
// the same append.
function revertStatusOnAppend(order) {
  if (!order) return;
  if (order.status === 'served') {
    order.status = 'new';
    order.servedAt = undefined;
  } else if (order.status === 'ready') {
    order.status = 'preparing';
    order.preparationCompletedAt = undefined;
  }
  // 'preparing' / 'new' stay as-is — already in the kitchen's queue.
}

// Identity key for "is this the same orderable line?". Two lines merge
// only when the dish, unit price, and special instructions all match — so
// "Paneer Tikka" and "Paneer Tikka (no onion)" stay distinct, and a
// size/topping change (which moves the price) also stays distinct.
//
// `prepStation` is deliberately NOT part of the key: it's an internal
// routing detail and the repeat-order partition step can re-derive it by
// name heuristic (e.g. stamping a "Coffee" line 'bar' even though the
// original was stored 'kitchen'). Including it would wrongly keep two
// otherwise-identical lines split. The merged line keeps the existing
// line's prepStation.
function orderLineKey(it) {
  return [
    String(it?.name || '').trim().toLowerCase(),
    Number(it?.price) || 0,
    String(it?.instructions || '').trim().toLowerCase(),
  ].join('|');
}

// Append `incoming` line items into an order's `items` array, MERGING into
// an existing identical line (bump its quantity) instead of pushing a
// duplicate row. Without this, repeating / re-adding the same dish renders
// as "Sample soup x3" + "Sample soup x1" across the bill, KDS, and waiter
// views; with it, the same dish collapses to a single "x4" line everywhere
// (one source of truth — no per-view display merge needed). The matched
// line keeps its original `addedAt`, so it stays in its original timeline
// bucket. Genuinely different new items still append as their own line
// (and keep the "added later" highlight).
//
// A merged line may hold up to MAX_LINE_QUANTITY (999 — the same per-item
// limit createOrder enforces). It used to be silently capped at 99, which
// shrank a 150-portion line (and its bill) on "one more". A merge that
// would exceed the limit now refuses the whole batch (400
// QUANTITY_EXCEEDED) BEFORE anything is mutated.
// Mutates `targetItems` in place; the caller saves.
const MAX_LINE_QUANTITY = 999;
function appendItemsMerging(targetItems, incoming) {
  // Plan first (so a refusal leaves targetItems untouched), then apply.
  const planned = new Map(); // matched line → new quantity
  const pushes = [];
  for (const inc of incoming) {
    const incQty = Math.max(1, Math.floor(Number(inc?.quantity) || 1));
    const match = targetItems.find(t => orderLineKey(t) === orderLineKey(inc))
      || pushes.find(t => orderLineKey(t) === orderLineKey(inc));
    if (match) {
      const current = planned.has(match) ? planned.get(match) : (Number(match.quantity) || 0);
      const next = current + incQty;
      if (next > MAX_LINE_QUANTITY) {
        throw httpError(400, {
          success: false,
          code: 'QUANTITY_EXCEEDED',
          message: `Quantity ${next} for "${match.name || inc?.name || 'item'}" exceeds the per-item limit of ${MAX_LINE_QUANTITY}.`,
        });
      }
      planned.set(match, next);
    } else {
      pushes.push(inc);
    }
  }
  for (const [line, qty] of planned) line.quantity = qty;
  for (const inc of pushes) targetItems.push(inc);
}

// True when a menu item can be ordered right now: status 'active' (a
// missing status is legacy data and counts as active) and inside its
// availability schedule (availableDays / startTime–endTime, ADM-043 —
// same semantics as utils/menuAvailability.buildAvailabilityFilter,
// including overnight windows). Returns null when orderable, otherwise a
// short reason for the 400 message.
function menuItemUnavailableReason(menu, now = new Date()) {
  if (!menu) return 'not on the menu';
  if (menu.status && menu.status !== 'active') return 'no longer available';
  const { currentDayShort, currentTimeHHMM } = require('../utils/menuAvailability');
  const days = Array.isArray(menu.availableDays) ? menu.availableDays : [];
  if (days.length && !days.includes(currentDayShort(now))) return 'not available today';
  const pad = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t || '').trim();
  };
  const start = pad(menu.startTime);
  const end = pad(menu.endTime);
  if (start && end) {
    const hhmm = currentTimeHHMM(now);
    const inWindow = start <= end
      ? (hhmm >= start && hhmm <= end)
      : (hhmm >= start || hhmm <= end);
    if (!inWindow) return `only available ${start}–${end}`;
  }
  return null;
}

// Short, human-readable line-item summary for notifications/toasts —
// e.g. "Sample soup ×2, Cold Coffee ×1 +2 more". Caps at `max` items so
// a big order doesn't blow out a toast; the rest collapse to "+N more".
function summariseItems(items = [], max = 3) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '';
  const head = list.slice(0, max)
    .map(i => `${i.name}${(Number(i.quantity) || 1) > 1 ? ` ×${i.quantity}` : ''}`)
    .join(', ');
  const rest = list.length - max;
  return rest > 0 ? `${head} +${rest} more` : head;
}

// Build the admin "New Order" toast/notification line: order type, the
// table for dine-in, and a short item list — what an admin glancing at
// the toast actually needs. Takeaway/kiosk omit the table.
function newOrderAdminDescription(order, tableName) {
  const typeLabel = order?.type === 'dine-in' ? 'Dine-in' : 'Takeaway';
  const tablePart = (order?.type === 'dine-in' && tableName) ? ` · Table ${tableName}` : '';
  const itemsPart = summariseItems(order?.items);
  return `${typeLabel}${tablePart}${itemsPart ? ` · ${itemsPart}` : ''}`;
}

// Partition a list of order line items into counter vs kitchen/bar
// groups using each item's stored `prepStation`, falling back to the
// name/category heuristic for items that pre-date the field. Used by
// the repeat-order endpoints so a "Repeat Order" containing a bottled
// water + a curry doesn't drag the bottle through the chef KDS.
function partitionItemsByStation(items) {
  const { resolveOrderItemStation } = require('../utils/prepStationInfer');
  const enriched = (items || []).map((it) => {
    const stored = it && it.prepStation ? String(it.prepStation).toLowerCase() : null;
    let station;
    if (stored === 'counter' || stored === 'bar') {
      station = stored; // admin / earlier inference already classified — trust it
    } else {
      // Either unset or stuck on the schema default 'kitchen'. Re-run
      // the heuristic so older items repeated for the first time get
      // upgraded (Bisleri, Coca-Cola, Red Bull, etc.).
      station = resolveOrderItemStation({
        fallbackName: it?.name,
        fallbackCategory: it?.category,
      });
    }
    return { ...it, prepStation: station };
  });
  const counterItems = enriched.filter((it) => it.prepStation === 'counter');
  const kitchenItems = enriched.filter((it) => it.prepStation !== 'counter');
  return { enriched, counterItems, kitchenItems };
}

// Helper — emit an order-scoped event to only the parties that should see it:
//   1. staff at the ORDER'S BRANCH (admin / waiter / kitchen). Multi-branch
//      tenants must not leak orders from one branch's kitchen to another —
//      a chef at "Durga 1" should never see orders from "Durga 2".
//   2. the logged-in owner, if any (joins their userId room in NotificationContext)
//   3. a per-order room `order:<orderId>` that guest trackers also subscribe to
function emitOrderEvent(event, payload, order) {
  try {
    const io = getIO();
    const branchId = order && order.branch ? order.branch : null;
    emitToStaff(io, branchId, event, payload);
    if (order && order.user) {
      io.to(String(order.user)).emit(event, payload);
    }
    if (order && order.orderId) {
      io.to(`order:${order.orderId}`).emit(event, payload);
    }
  } catch { /* socket not critical */ }
}

// Helper — table state changes are staff-only concerns.
// Pass the branchId of the table/order so branch-pinned staff only hear
// about their own branch's tables.
function emitStaffTable(event, payload, branchId = null) {
  try {
    const io = getIO();
    emitToStaff(io, branchId, event, payload);
  } catch { /* ignore */ }
}

// Fire-and-forget wrapper for post-response side effects (notifications,
// socket emits). Runs on the next tick so the HTTP response is never
// held up by — or failed by — a notification write.
function runAfterResponse(label, fn) {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => logger.warn(`${label} failed (non-fatal):`, { error: err?.message }));
  });
}

// Sign a short-lived tracking token so a kiosk (no auth, no scan token)
// can poll its own order status. The token is bound to the orderId +
// tenant so it can't be repurposed against another order.
function signKioskTrackingToken(orderId, restaurantId) {
  return signTypedToken(
    TOKEN_TYPES.KIOSK,
    { kind: 'kiosk-track', orderId: String(orderId), restaurant: String(restaurantId || '') },
    { expiresIn: '2h' }    // longer than the longest realistic prep + pickup window
  );
}

module.exports = {
  isValidObjectId,
  bumpMenuItemOrderCounts,
  revertStatusOnAppend,
  orderLineKey,
  appendItemsMerging,
  MAX_LINE_QUANTITY,
  menuItemUnavailableReason,
  summariseItems,
  newOrderAdminDescription,
  partitionItemsByStation,
  emitOrderEvent,
  emitStaffTable,
  runAfterResponse,
  signKioskTrackingToken,
  lineItemsSubtotal,
};
