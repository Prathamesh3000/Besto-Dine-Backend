/**
 * orderStatusService — staff-side order state changes: PATCH /:id/status
 * (updateOrderStatus), PATCH /:id/pickup and PATCH /:id/delivery.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31). The
 * ~640-line updateOrderStatus handler is now the short pipeline at the
 * bottom of this file over the step functions below. Rules, side-effect
 * order and response bodies are unchanged.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const Notification = require('../models/notification');
const logger = require('../utils/logger');
const { getSettings } = require('../utils/settingsCache');
const { getIO, emitToWaiter } = require('../utils/socket');
const { verifyUserToken, loadUserForToken } = require('../middlewares/authMiddleware');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { releaseTableIfSettled } = require('../utils/tableOccupancy');
const { createTipForPaidOrder } = require('../utils/tipHelpers');
const {
  VALID_TRANSITIONS,
  canTransition,
  CANCEL_REQUIRES_REASON,
  CANCEL_PRIVILEGED_ROLES,
  CANCEL_PRIVILEGED_STATES,
  STATUS_TIMESTAMP_FIELD,
} = require('../utils/orderLifecycle');
const { httpError, reply } = require('./orderErrors');
const { emitOrderEvent } = require('./orderHelpers');
const { notifyStatusTransition, emitStatusUpdateEvents, notify } = require('./orderNotifications');
const { recordPaidOrderLedger } = require('./orderPaymentService');

// Optionally extract the calling user from token (for chef assignment).
async function resolveCallerFromHeader(req) {
  if (!req.user) {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer')) {
        const token = authHeader.split(' ')[1];
        const decoded = verifyUserToken(token);
        req.user = await loadUserForToken(decoded);
      }
    } catch { /* no valid token — continue without user */ }
  }
}

// Status transition rules (L6 state machine + late-cancellation guard +
// per-status timestamps). Mutates updateData.
function applyStatusTransition(req, oldOrder, status, updateData) {
  if (status) {
    // L6: Enforce valid status transitions
    const allowed = VALID_TRANSITIONS[oldOrder.status];
    if (allowed && !allowed.includes(status)) {
      throw httpError(409, {
        success: false,
        code: 'INVALID_TRANSITION',
        message: `Cannot transition from "${oldOrder.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`
      });
    }

    // ── Late cancellation guard ─────────────────────────────────
    // Cancelling from 'ready'/'served' writes off food that was
    // actually made. Require a reason and a privileged role so the
    // void is attributable; an ordinary waiter must escalate.
    if (status === 'cancelled' && CANCEL_REQUIRES_REASON.has(oldOrder.status)) {
      const reason = String(req.body.cancellationReason || '').trim();
      // 'ready' → any floor staff with a reason; 'served' → captain+.
      if (CANCEL_PRIVILEGED_STATES.has(oldOrder.status) && !CANCEL_PRIVILEGED_ROLES.has(req.user?.role)) {
        throw httpError(403, {
          success: false,
          code: 'CANCEL_REQUIRES_PRIVILEGE',
          message: `An order that is already ${oldOrder.status} can only be cancelled by a captain or manager.`,
        });
      }
      if (reason.length < 3) {
        throw httpError(400, {
          success: false,
          code: 'CANCEL_REASON_REQUIRED',
          message: 'Give a reason for cancelling an order that has already been prepared.',
        });
      }
      updateData.cancellationReason = reason;
      updateData.cancelledBy = req.user._id;
      updateData.cancelledAt = new Date();
    } else if (status === 'cancelled') {
      // Early cancellation (new/preparing) — no food lost, so no
      // reason demanded, but still record who and when.
      updateData.cancellationReason = String(req.body.cancellationReason || '').trim() || undefined;
      updateData.cancelledBy = req.user?._id;
      updateData.cancelledAt = new Date();
    }

    // ── Per-status timestamps ───────────────────────────────────
    // `updatedAt` is bumped by ANY save, so it cannot answer "how
    // long has this been ready?". The chef's Ready-for-Pickup timer
    // was reading createdAt and therefore showed total order age.
    // Stamp the real transition moments instead.
    const stampField = STATUS_TIMESTAMP_FIELD[status];
    // Only stamp the FIRST time a status is entered — a re-save of an
    // already-served order must not reset its clock.
    if (stampField && !oldOrder[stampField]) {
      updateData[stampField] = new Date();
    }

    updateData.status = status;
  }
}

// Payment / tip / manual-discount fields + bill-paid auto-close.
function applyPaymentFields(oldOrder, body, updateData) {
  const { paymentStatus, paymentMethod, amountPaid, tipAmount, manualDiscount } = body;
  if (paymentStatus) updateData.paymentStatus = paymentStatus;
  if (paymentMethod) updateData.paymentMethod = paymentMethod;
  if (amountPaid !== undefined) updateData.amountPaid = amountPaid;
  // Captain/admin settles the bill with an explicit tip line — accept
  // the body field so createTipForPaidOrder (called below after save)
  // produces a Tip record and the waiter's tip dashboard reflects the
  // earning. Clamp to non-negative; falsy values leave order.tipAmount
  // untouched so partial PATCH callers don't accidentally zero it out.
  if (tipAmount !== undefined && Number.isFinite(Number(tipAmount))) {
    updateData.tipAmount = Math.max(0, Number(tipAmount));
  }
  // Manual discount applied by the admin/waiter from the table drawer.
  // Persisted so the customer's bill-preview reflects it before they pay
  // (emitted via order:updated below → the customer bill refetches).
  if (manualDiscount !== undefined && Number.isFinite(Number(manualDiscount))) {
    updateData.manualDiscount = Math.max(0, Number(manualDiscount));
  }
  if (paymentStatus === 'Paid' && oldOrder.paymentStatus !== 'Paid' && !oldOrder.paidAt) {
    updateData.paidAt = new Date();
  }

  // Marking Paid NEVER rewrites order.total.
  //
  // It used to (`total = amountPaid`), which let any settle screen
  // silently re-price the bill — a typo'd or discounted cash amount
  // became the order's total, and the stamped GST / charges no longer
  // added up to it. The bill is now fixed by the order; settlement only
  // records what was collected:
  //   • amountPaid below what is due (total − manualDiscount − already
  //     paid, ₹1 rounding tolerance) → 400 AMOUNT_TOO_LOW. A deliberate
  //     reduction must go through the Discount option (manualDiscount),
  //     which is recorded on the order.
  //   • amountPaid at or above due → recorded as paid; any overpayment
  //     or tip is carried by amountPaid / tipAmount as before.
  if (paymentStatus === 'Paid' && amountPaid !== undefined && amountPaid !== null && amountPaid !== '') {
    const paid = Number(amountPaid);
    const effectiveManualDiscount = updateData.manualDiscount !== undefined
      ? updateData.manualDiscount
      : Math.max(0, Number(oldOrder.manualDiscount) || 0);
    const alreadyPaid = Math.max(0, Number(oldOrder.amountPaid) || 0);
    const due = Math.round(Math.max(0,
      (Number(oldOrder.total) || 0) - effectiveManualDiscount - alreadyPaid) * 100) / 100;
    if (!Number.isFinite(paid) || paid < 0) {
      throw httpError(400, { success: false, code: 'INVALID_AMOUNT', message: 'Amount paid must be a non-negative number.' });
    }
    if (paid < due - 1) {
      throw httpError(400, {
        success: false,
        code: 'AMOUNT_TOO_LOW',
        message: `Amount paid ₹${paid.toFixed(2)} is less than the amount due ₹${due.toFixed(2)}. `
          + 'Marking an order Paid cannot reduce the bill — use the Discount option to give a discount, then settle.',
        amountDue: due,
      });
    }
  }

  // Bill-paid auto-close for dine-in.
  //
  // The waiter's PaymentOption flow sends only payment fields (no
  // status) when settling a bill. Treat "fully paid on a dine-in
  // order" as the end of the service: promote it to 'served' so it
  // leaves the waiter's pickup queue. (The table itself is released by
  // releaseTableIfDone on payment regardless of kitchen status.)
  // Idempotent: if the order is already 'served' or 'cancelled', we
  // leave the status alone (payment still updates).
  //
  // Only when the state machine allows → served: a 'new' order (paid
  // up-front) must still go through the kitchen — it stays on the KDS.
  if (
    paymentStatus === 'Paid' &&
    oldOrder.type === 'dine-in' &&
    !updateData.status &&
    oldOrder.status !== 'served' &&
    canTransition(oldOrder.status, 'served')
  ) {
    updateData.status = 'served';
    // The auto-promotion never passes through applyKitchenStamps' body
    // status, so stamp servedAt here (first entry only).
    if (!oldOrder.servedAt) updateData.servedAt = new Date();
  }
}

// Kitchen timestamps (preparing / ready / served) + chef assignment.
function applyKitchenStamps(req, oldOrder, status, updateData) {
  // ── FIX: cooking-start timestamp, decoupled from the chef-role gate ──
  // Previously this was nested inside `req.user.role === 'chef'`, so
  // any transition to 'preparing' triggered by a non-chef (captain,
  // admin, manager — all of whom can legitimately advance the kitchen
  // flow per the permission catalog), or by a request where req.user
  // failed to resolve (expired/missing token on that specific call),
  // silently skipped the stamp. ChefOrderCard then fell back to
  // `updatedAt`, which can already be several minutes stale — e.g. a
  // scheduled takeaway that the releaser job bumped 8 minutes earlier
  // when moving it out of "Upcoming" — so the chef's timer opened
  // already several minutes in instead of at 0:00.
  //
  // Guarded by `!oldOrder.preparationStartedAt` (first entry only,
  // matches the pattern used for preparationCompletedAt/servedAt below)
  // AND `!updateData.preparationStartedAt` so this never double-writes
  // if STATUS_TIMESTAMP_FIELD in orderLifecycle.js also happens to map
  // 'preparing' → 'preparationStartedAt' via the generic block above.
  if (
    status === 'preparing' &&
    oldOrder.status !== 'preparing' &&
    !oldOrder.preparationStartedAt &&
    !updateData.preparationStartedAt
  ) {
    updateData.preparationStartedAt = new Date();
  }

  // Chef assignment stays role-gated — only an actual chef "owns" the
  // card for the preparing-column visibility filter in getKitchenOrders.
  if (status === 'preparing' && req.user && req.user.role === 'chef') {
    updateData.chef = req.user._id;
  }

  // Record completion time when chef marks order ready
  if (status === 'ready' && oldOrder.status === 'preparing') {
    updateData.preparationCompletedAt = new Date();
  }

  // Stamp servedAt the first time an order transitions to 'served'.
  // Idempotent: re-saves of an already-served order leave the existing
  // timestamp alone so we don't keep moving it forward.
  if (status === 'served' && oldOrder.status !== 'served' && !oldOrder.servedAt) {
    updateData.servedAt = new Date();
  }
}

// Atomic status transition — 409 when someone else won the race.
async function commitStatusUpdate(oldOrder, updateData, tf) {
  // Atomic status transition — when we are changing the status, include
  // the *source* status in the filter so two chefs tapping Start on the
  // same card can't both succeed. Mongo's findOneAndUpdate is a single
  // atomic op; the loser's filter no longer matches and the returned
  // doc is null. Payment-only updates skip the status pin so a
  // concurrent status change from the kitchen doesn't fail the payment.
  const atomicFilter = { _id: oldOrder._id, ...tf };
  if (updateData.status) atomicFilter.status = oldOrder.status;
  // The not-Paid → Paid transition is pinned too, so of two concurrent
  // mark-paid taps only one commits it (and runs the ledger / tip /
  // notification side effects); the other gets a 409.
  const claimsPaid = updateData.paymentStatus === 'Paid' && oldOrder.paymentStatus !== 'Paid';
  if (claimsPaid) atomicFilter.paymentStatus = { $ne: 'Paid' };

  const order = await Order.findOneAndUpdate(atomicFilter, updateData, { returnDocument: 'after' });
  if (!order) {
    if (claimsPaid && !updateData.status) {
      throw httpError(409, {
        success: false,
        code: 'ALREADY_PAID',
        message: 'This order was already marked paid. Please refresh.',
      });
    }
    throw httpError(409, {
      success: false,
      code: 'INVALID_TRANSITION',
      message: 'This order was updated by someone else. Please refresh.',
    });
  }
  return order;
}

// Served / cancelled → delete the waiter's now-stale order alerts.
async function clearFloorAlertsOnClose(status, oldOrder, order, tf) {
  // ── Auto-clear stale floor-staff alerts ───────────────────────────
  // Once an order is served (picked up) or cancelled, the "New order" /
  // "Order ready for pickup" notifications sent to waiters/captains are no
  // longer actionable — delete them so they auto-disappear from the
  // waiter's notification list instead of lingering. The order:updated
  // emit below makes the floor app refetch immediately; the 15s poll is a
  // backstop. Best-effort: a cleanup failure never blocks the status update.
  if ((status === 'served' || status === 'cancelled') && order.status !== oldOrder.status) {
    try {
      await Notification.deleteMany({
        ...tf,
        category: 'Order',
        recipientRole: 'waiter',
        'meta.orderId': order.orderId,
      });
    } catch (err) {
      logger.warn(`Notification cleanup failed for ${order.orderId}: ${err.message}`);
    }
  }
}

// Settling one dine-in round settles the table's other unpaid rounds.
async function settleSiblingDineInRounds(req, paymentStatus, oldOrder, order, tf) {
  // Pay-first (operations profile): every round pays for itself, so
  // paying one round (e.g. a held counter-cash order) must not mark the
  // table's other unpaid rounds Paid with amountPaid 0.
  if (oldOrder.holdReason) return;
  if (req.restaurant) {
    const { resolveOperations } = require('../utils/operationsProfile');
    if (resolveOperations(req.restaurant).payment.dineIn === 'payFirst') return;
  }
  // Aggregated dine-in bill: settling one round's payment clears the
  // WHOLE table's bill (the waiter / customer bill sums every unpaid
  // round on the table — independent-orders model). So when this update
  // marks a dine-in order Paid for the first time, settle the sibling
  // unpaid rounds too — otherwise they'd linger as "Unpaid" and the
  // table would never free. The amount is recorded on the round that was
  // settled; siblings are marked Paid with amountPaid 0 so revenue isn't
  // double-counted. Mirrors razorpayController.settleSiblingDineInRounds.
  if (paymentStatus === 'Paid' && oldOrder.paymentStatus !== 'Paid'
    && order.type === 'dine-in' && order.table) {
    try {
      const siblings = await Order.find({
        table: order.table,
        _id: { $ne: order._id },
        status: { $in: ['new', 'preparing', 'ready', 'served'] },
        paymentStatus: { $ne: 'Paid' },
        ...tf,
      });
      for (const sib of siblings) {
        sib.paymentStatus = 'Paid';
        sib.paymentMethod = order.paymentMethod || 'cash';
        sib.amountPaid = 0; // covered by the settled round's amount
        if (!sib.paidAt) sib.paidAt = new Date();
        // Same rule as the settled round: a round still 'new' stays in
        // the kitchen; only rounds the state machine lets reach 'served'
        // are closed.
        if (sib.status !== 'served' && canTransition(sib.status, 'served')) {
          sib.status = 'served';
          if (!sib.servedAt) sib.servedAt = new Date();
        }
        await sib.save();
      }
    } catch (err) {
      logger.warn('Sibling dine-in round settle (staff path) failed:', err.message);
    }
  }
}

// Inventory deduct on → preparing; restore on cancel after deduction.
function runInventoryHooks(req, status, oldOrder, order) {
  // ── Auto-deduct inventory when order moves to "preparing" ────────
  // Only fires on the first transition to 'preparing' (not re-entry).
  // Runs in the background — a deduction failure does NOT block the
  // order status update. Results are logged AND broadcast to the
  // admin room as an `inventory:alert` so a silent unit-mismatch /
  // missing-recipe / insufficient-stock failure surfaces in the UI
  // instead of only landing in `logs/combined.log`.
  if (status === 'preparing' && oldOrder.status !== 'preparing') {
    try {
      const { deductInventoryForOrder } = require('../controllers/inventoryController');
      const restaurantId = tenantId(req);
      if (restaurantId) {
        deductInventoryForOrder(order, restaurantId, req.user?._id)
          .then(result => {
            if (result.errors.length > 0) {
              logger.warn(`Inventory deduction warnings for ${order.orderId}:`, result.errors);
              try {
                const { getIO, emitToAdmin } = require('../utils/socket');
                emitToAdmin(getIO(), order.branch || null, 'inventory:alert', {
                  severity: 'deduction-failed',
                  orderId: order.orderId,
                  errors: result.errors,
                  trigger: `Order ${order.orderId}`,
                });
              } catch { /* socket best-effort */ }
            }
            if (result.deducted.length > 0) {
              logger.info(`Inventory deducted for ${order.orderId}: ${result.deducted.length} items`);
            }
          })
          .catch(err => logger.warn(`Inventory deduction failed for ${order.orderId}: ${err.message}`));
      }
    } catch (err) { logger.warn('Inventory deduction setup failed:', err.message); }
  }

  // ── Restore inventory when an already-deducted order is cancelled ─
  // If the chef had started preparing (so deduction ran) and the order
  // then flips to cancelled, put the stock back with a `type: 'return'`
  // adjustment. Idempotent via the order.inventoryDeducted flag.
  if (status === 'cancelled' && oldOrder.status !== 'cancelled' && order.inventoryDeducted) {
    try {
      const { restoreInventoryForOrder } = require('../controllers/inventoryController');
      const restaurantId = tenantId(req);
      if (restaurantId) {
        restoreInventoryForOrder(order, restaurantId, req.user?._id)
          .then(result => {
            if (result.errors.length > 0) {
              logger.warn(`Inventory restore warnings for ${order.orderId}:`, result.errors);
            }
            if (result.restored.length > 0) {
              logger.info(`Inventory restored for cancelled ${order.orderId}: ${result.restored.length} items`);
            }
          })
          .catch(err => logger.warn(`Inventory restore failed for ${order.orderId}: ${err.message}`));
      }
    } catch (err) { logger.warn('Inventory restore setup failed:', err.message); }
  }
}

// Release the table once every order on it is settled.
//
// Table-status rule (utils/tableOccupancy.releaseTableIfSettled): a
// dine-in table turns Free the moment no order on it (or its merge
// group) is unsettled — kitchen status no longer matters. So the table
// is re-checked whenever this update
//   • cancelled the order,
//   • settled it (→ Paid / Refunded), or
//   • served an order that was already paid (pay-first orders keep the
//     table until the food is on it; also drops the seat reservations
//     freeTableOrUnmergeGroup kept while that order was cooking).
// A paid order still in the kitchen stays on the KDS as before. When
// another party's order is still unpaid the table stays occupied and
// activeOrder is repointed to that order. The helper emits
// `table:updated` for every freed id.
async function releaseTableIfDone(oldOrder, order, tf) {
  if (!order.table) return;
  const SETTLED = ['Paid', 'Refunded'];
  const nowSettled = SETTLED.includes(order.paymentStatus);
  const justCancelled = order.status === 'cancelled' && oldOrder.status !== 'cancelled';
  const justSettled = nowSettled && !SETTLED.includes(oldOrder.paymentStatus);
  const justServedPaid = nowSettled && order.status === 'served' && oldOrder.status !== 'served';
  if (!justCancelled && !justSettled && !justServedPaid) return;
  try {
    await releaseTableIfSettled(order, tf, { branch: order.branch || null, restaurant: order.restaurant });
  } catch (err) { logger.warn('Failed to free table on status change:', err.message); }
}

async function updateOrderStatus(req) {
  const { id } = req.params;
  const { status, paymentStatus } = req.body;

  await resolveCallerFromHeader(req);

  // Support both MongoDB _id and human-readable orderId (e.g. ORD-0001).
  // All lookups are scoped to the current tenant.
  const tf = tenantFilter(req);
  let oldOrder = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!oldOrder) {
    oldOrder = await Order.findOne({ orderId: id, ...tf });
  }
  if (!oldOrder) throw httpError(404, { success: false, message: 'Order not found' });

  // ── R-07: branch-pinned staff enforcement ───────────────────────
  // Any staff user whose `user.branch` is set is confined to orders
  // from that branch, regardless of what fields the request is
  // updating (status, paymentStatus, paymentMethod, amountPaid, or
  // any combination). The kitchen / waiter / admin list queries
  // already scope by branch, so this gate only fires on a hand-
  // crafted request targeting another branch's order _id.
  //
  // The earlier version of this check was role-gated to `chef` only,
  // which missed the real attack vector: a branch-pinned waiter /
  // captain at Branch A could PATCH `{ paymentStatus: 'Paid' }` on a
  // Branch-B order (stealing settlement credit, corrupting per-branch
  // revenue analytics, triggering a misrouted tip). The fix is role-
  // agnostic — every pinned staff member must match the order's
  // branch. Tenant-level staff (user.branch = null) remain
  // unrestricted by design — that's how tenant owners operate.
  //
  // Tenant-level orders (order.branch = null, legacy single-location
  // data) are reachable by any pinned staff, same as the list-query
  // behavior in staffBranchFilter — so we only reject when BOTH
  // sides have a branch AND they disagree.
  const callerBranch = pinnedBranchId(req);
  if (req.user && callerBranch && oldOrder.branch
    && String(oldOrder.branch) !== String(callerBranch)) {
    logger.warn('updateOrderStatus: cross-branch update blocked', {
      userId: req.user._id || req.user.id,
      role: req.user.role,
      callerBranch: String(callerBranch),
      orderBranch: String(oldOrder.branch),
      orderId: oldOrder.orderId,
      attemptedFields: Object.keys(req.body || {}),
    });
    throw httpError(403, {
      success: false,
      code: 'BRANCH_MISMATCH',
      message: 'You can only update orders from your assigned branch.',
    });
  }

  const updateData = {};
  applyStatusTransition(req, oldOrder, status, updateData);
  applyPaymentFields(oldOrder, req.body, updateData);
  applyKitchenStamps(req, oldOrder, status, updateData);

  let order = await commitStatusUpdate(oldOrder, updateData, tf);

  // Staff "Mark paid" on a held pay-first order (cash at the counter):
  // the payment is recorded, now release it to the kitchen.
  if (order && order.status === 'awaiting-payment' && order.paymentStatus === 'Paid') {
    const { releaseHeldOrder } = require('./orderHoldService');
    order = (await releaseHeldOrder(order)) || order;
  }

  // Nobody serves at the table (operations profile, servedStep off): the
  // chef pressing Ready completes the order — no one will mark it served.
  if (order && order.status === 'ready' && oldOrder.status !== 'ready' && req.restaurant) {
    const { resolveOperations } = require('../utils/operationsProfile');
    if (!resolveOperations(req.restaurant).orderFlow.servedStep) {
      const { completeWithoutKitchen } = require('./orderHoldService');
      order = await completeWithoutKitchen(order);
    }
  }

  await clearFloorAlertsOnClose(status, oldOrder, order, tf);
  await settleSiblingDineInRounds(req, paymentStatus, oldOrder, order, tf);
  runInventoryHooks(req, status, oldOrder, order);
  await releaseTableIfDone(oldOrder, order, tf);
  await notifyStatusTransition({ status, oldOrder, order });

  const justPaid = order.paymentStatus === 'Paid' && oldOrder.paymentStatus !== 'Paid';

  // Side Effect: Record Tip if tipAmount > 0 and status is Paid.
  // Delegated to the shared helper so every payment entry point
  // (this PATCH, razorpay verifyPayment, razorpay webhook) produces
  // the same Tip record. Runs for walk-in orders (no customer) too —
  // the waiter earned the tip either way.
  if (justPaid) {
    await createTipForPaidOrder(order, tenantId(req));
    // Optional auto bill on settlement (Settings → Printers → "Bill when
    // paid", off by default). Cash at the counter also pops the drawer.
    require('./printService').enqueueBillJob({
      order, reason: 'paid', openDrawer: /cash/i.test(String(order.paymentMethod || '')),
    }).catch(() => {});
  }

  // Side Effect: Record transaction if status changes to 'Paid' and wasn't before
  if (justPaid && order.user) {
    const settings = await recordPaidOrderLedger(req, order, tf, oldOrder);

    // Socket.io — notify dashboards + the owning customer of status change.
    // Scoped emit (staff rooms + order owner + per-order guest room) replaces
    // the old global broadcast that leaked other customers' payment state.
    try {
      await emitStatusUpdateEvents({ io: getIO(), status, order, settings });
    } catch { /* socket not critical */ }

    return reply(200, { success: true, order });
  }

  // Handle normal status update without payment change (status was already Paid or user is null)
  try {
    const settings = await getSettings(req);
    const io = getIO();
    await emitStatusUpdateEvents({ io, status, order, settings });
  } catch { }
  return reply(200, { success: true, order });
}

// Pick up an order (Waiter marks as served) and frees the table
async function pickupOrder(req) {
  const { id } = req.params;

  // Find order first to validate status transition (scoped to tenant)
  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : await Order.findOne({ orderId: id, ...tf });

  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // Enforce valid status transition — usually 'ready' -> 'served'
  // but sometimes 'preparing' -> 'served' if waiter picks it up early.
  const allowed = VALID_TRANSITIONS[order.status];

  // Idempotency: If already served, just return success
  if (order.status === 'served') {
    return reply(200, { success: true, order, message: 'Order is already served' });
  }

  // No kitchen screen but waiters on (operations profile: chef module
  // off): nobody presses Preparing / Ready, so the order sits at 'new'
  // until the waiter serves it. Allow new → served on THIS path only;
  // the state machine (VALID_TRANSITIONS) is unchanged for everyone else.
  let servedWithoutKitchen = false;
  if (order.status === 'new' && req.restaurant) {
    // Profile only (no plan intersection): a tenant that never set a
    // profile keeps today's rule even if its plan lacks the KDS.
    const { profileFlow } = require('../utils/operationsProfile');
    servedWithoutKitchen = profileFlow(req.restaurant).orderFlow.kitchenDisplay === false;
  }

  if (!servedWithoutKitchen && (!allowed || !allowed.includes('served'))) {
    throw httpError(400, {
      success: false,
      message: `Cannot mark as served from "${order.status}". Order must be in "ready" or "preparing" state.`
    });
  }

  order.status = 'served';
  if (!order.servedAt) order.servedAt = new Date();

  // Attribute the tip to the staff member who actually picked the
  // order up.
  //
  // Customer-placed takeaway orders are saved with `waiter: null` (no
  // waiter is involved at order-create time — the customer placed it
  // through their own app). Without an attribution here, the Tip
  // record never gets created (createTipForPaidOrder gates on
  // `order.waiter`), and the picker's tip history stays empty even
  // when the customer paid a tip.
  //
  // Captain override: when a captain performs the pickup we ALWAYS
  // re-attribute, even if a waiter was previously stamped at order-
  // create time. A captain pickup is the service event for that
  // order, so any customer tip belongs to the captain and must show
  // up in the captain's tip settlement. For waiter pickups we keep
  // the existing "first waiter wins" attribution between waiters.
  const TIP_EARNING_ROLES = new Set(['waiter', 'captain']);
  if (req.user && TIP_EARNING_ROLES.has(req.user.role)) {
    if (req.user.role === 'captain' || !order.waiter) {
      order.waiter = req.user._id;
    }
  }

  await order.save();

  // 'preparing' (where stock is normally deducted) was skipped — deduct
  // now. deductInventoryForOrder is idempotent on order.inventoryDeducted.
  if (servedWithoutKitchen) {
    try {
      const { deductInventoryForOrder } = require('../controllers/inventoryController');
      const result = await deductInventoryForOrder(order, tenantId(req) || order.restaurant, req.user?._id);
      if (result?.errors?.length) logger.warn(`Inventory deduction warnings for ${order.orderId}:`, result.errors);
    } catch (err) {
      logger.warn(`Inventory deduction on serve-without-kitchen failed for ${order.orderId}: ${err.message}`);
    }
  }

  // Auto-clear the floor-staff "order ready / new order" alerts now that
  // this order is served. The waiter/captain Pick Up / Serve action goes
  // through THIS path (pickupOrder), not updateOrderStatus, so without
  // this the ready-notifications lingered in the waiter's list after the
  // order was completed. Mirrors the cleanup in updateOrderStatus.
  // Best-effort: a cleanup failure never blocks the pickup.
  try {
    await Notification.deleteMany({
      ...tf,
      category: 'Order',
      recipientRole: 'waiter',
      'meta.orderId': order.orderId,
    });
  } catch (err) {
    logger.warn(`Notification cleanup failed for ${order.orderId}: ${err.message}`);
  }

  // Free the table when the bill has already been settled (pay-first
  // order now served). Unpaid → the diners are still eating and owe the
  // bill, so the table stays occupied. releaseTableIfSettled also keeps
  // the table occupied while another party's order is unpaid, and emits
  // `table:updated` for every freed table.
  const settled = order.paymentStatus === 'Paid' || order.paymentStatus === 'Refunded';
  if (order.table && settled) {
    try { await releaseTableIfSettled(order, tf, { branch: order.branch || null, restaurant: order.restaurant }); }
    catch (err) { logger.warn('Failed to free table on pickup:', err.message); }
  }

  // Tip recording — now that the waiter is stamped (and the order is
  // already paid for the takeaway flow), create the Tip record so it
  // appears in the waiter's tip history. Helper is idempotent and a
  // no-op when there's no tip / waiter / paid status.
  try {
    await createTipForPaidOrder(order, tenantId(req));
  } catch (err) { logger.warn('Tip creation on pickup failed (non-fatal):', err.message); }

  // Socket.io — notify dashboards + the owning customer of pickup.
  // (The table-freed event comes from releaseTableIfSettled, only when
  // it actually freed the table.) Include servedAt in the payload so the customer tracking timeline
  // can update its "Served" step optimistically without a refetch.
  try {
    emitOrderEvent(
      'order:updated',
      {
        orderId: order.orderId,
        status: 'served',
        paymentStatus: order.paymentStatus,
        servedAt: order.servedAt,
      },
      order
    );
  } catch { /* socket not critical */ }

  return reply(200, { success: true, order });
}

// @desc    Advance a delivery order's dispatch lifecycle + assign a
//          delivery person. Layered on top of the normal kitchen flow:
//          the order still cooks (new → preparing → ready) via the KDS;
//          this drives delivery.status (pending → assigned →
//          out-for-delivery → delivered). When it reaches 'delivered'
//          the order's top-level status is moved to 'served'.
// @route   PATCH /api/v1/orders/:id/delivery
// @access  Admin / Manager / Captain
async function updateDeliveryStatus(req) {
  const { id } = req.params;
  const { status, partnerName } = req.body;

  const DELIVERY_FLOW = ['pending', 'assigned', 'out-for-delivery', 'delivered'];
  if (status && !DELIVERY_FLOW.includes(status)) {
    throw httpError(400, { success: false, message: `Invalid delivery status. Allowed: ${DELIVERY_FLOW.join(', ')}` });
  }

  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!order) order = await Order.findOne({ orderId: id, ...tf });
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // Branch-pinned staff confined to their own branch (mirrors
  // updateOrderStatus). Only reject when both sides carry a branch
  // and they disagree.
  const callerBranch = pinnedBranchId(req);
  if (callerBranch && order.branch && String(order.branch) !== String(callerBranch)) {
    throw httpError(403, { success: false, code: 'BRANCH_SCOPE_VIOLATION', message: 'You can only manage deliveries for your assigned branch.' });
  }

  if (!order.delivery || !order.delivery.requested) {
    throw httpError(400, { success: false, code: 'NOT_A_DELIVERY_ORDER', message: 'This order is not a home-delivery order.' });
  }
  if (order.status === 'cancelled') {
    throw httpError(400, { success: false, message: 'Cannot update delivery on a cancelled order.' });
  }

  // Optional delivery-person name (free-text, Phase 1 — no role yet).
  if (partnerName != null) {
    const clean = String(partnerName).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80);
    order.delivery.partnerName = clean;
    // Naming a person implies they've taken ownership — bump status to
    // at least 'assigned' if it's still pending.
    if (clean && order.delivery.status === 'pending' && !status) {
      order.delivery.status = 'assigned';
      order.delivery.assignedAt = new Date();
    }
  }

  if (status) {
    const now = new Date();
    order.delivery.status = status;
    if (status === 'assigned' && !order.delivery.assignedAt) order.delivery.assignedAt = now;
    if (status === 'out-for-delivery') {
      order.delivery.outForDeliveryAt = now;
      if (!order.delivery.assignedAt) order.delivery.assignedAt = now;
    }
    if (status === 'delivered') {
      order.delivery.deliveredAt = now;
      // Handing the food off completes the order — move the top-level
      // status to 'served' (the terminal "done" state takeaway uses)
      // so it leaves the active/live queues.
      order.status = 'served';
      if (!order.servedAt) order.servedAt = now;
    }
  }

  await order.save();

  // Delivered = terminal → clear the floor-staff alerts for this order so
  // they auto-disappear from the waiter's notification list.
  if (order.delivery.status === 'delivered') {
    try {
      await Notification.deleteMany({
        ...tenantFilter(req),
        category: 'Order',
        recipientRole: 'waiter',
        'meta.orderId': order.orderId,
      });
    } catch (err) {
      logger.warn(`Notification cleanup failed for ${order.orderId}: ${err.message}`);
    }
  }

  // Notify the customer + floor staff of the delivery progress.
  try {
    const io = getIO();
    const payload = {
      orderId: order.orderId,
      deliveryStatus: order.delivery.status,
      partnerName: order.delivery.partnerName || '',
    };
    emitToWaiter(io, order.branch || null, 'order:updated', payload);
    io.to(`order:${order.orderId}`).emit('order:updated', payload);
    if (order.user) io.to(order.user.toString()).emit('order:updated', payload);

    const labels = {
      assigned: 'A delivery partner has been assigned to your order.',
      'out-for-delivery': 'Your order is out for delivery!',
      delivered: 'Your order has been delivered. Enjoy!',
    };
    if (order.user && labels[order.delivery.status]) {
      // Bell row only — the live update is the order:updated emit above.
      await notify({
        restaurant: tenantId(req),
        branch: order.branch || null,
        recipients: [order.user],
        event: null,
        notification: {
          title: order.delivery.status === 'delivered' ? 'Order Delivered' : 'Delivery Update',
          description: labels[order.delivery.status],
          category: 'Order',
          // Addressed to the customer. Customer reads match on
          // recipient = their user id; the admin bell only shows
          // recipient-less role broadcasts, so it never surfaces this.
          recipientRole: 'customer',
          priority: 'high',
          meta: { orderId: order.orderId, deliveryStatus: order.delivery.status },
        },
      });
    }
  } catch { /* socket / notification best-effort */ }

  return reply(200, { success: true, order });
}

module.exports = {
  updateOrderStatus,
  pickupOrder,
  updateDeliveryStatus,
  // steps exported for unit tests
  applyStatusTransition,
  applyPaymentFields,
  applyKitchenStamps,
};
