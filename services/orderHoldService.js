/**
 * Held pay-first orders (OPERATIONS_CONTROL_PANEL_DESIGN.md §6).
 *
 * A restaurant whose operations profile says "customers pay first"
 * (payment.holdUntilPaid) creates an order the customer has not paid for
 * yet — cash at the counter, an online payment the gateway could not
 * confirm, a wallet debit still to come — with status 'awaiting-payment'.
 * The counter can find it; the kitchen cannot (every kitchen query is a
 * whitelist of the other statuses) and nothing is printed or deducted.
 *
 * releaseHeldOrder() is the ONLY way out of that state besides
 * cancellation. Every payment path calls it after it has recorded the
 * payment (staff "Mark paid", Razorpay verify / webhook / reconciliation,
 * wallet pay). It is idempotent: the status flip is one atomic update
 * pinned on 'awaiting-payment', so two cashiers or webhook + verify
 * release an order exactly once.
 *
 * completeWithoutKitchen() handles restaurants with no kitchen screen and
 * nobody serving (e.g. modules 1 + 5): the order is done as soon as it is
 * paid and the KOT is sent, so it goes straight to 'served' — with the
 * stock deduction the 'preparing' step would normally have done.
 */
const Order = require('../models/order');
const Restaurant = require('../models/restaurant');
const EVENTS = require('../realtime/events');
const logger = require('../utils/logger');

const HELD = 'awaiting-payment';

async function loadOps(restaurantId) {
    const { resolveOperations } = require('../utils/operationsProfile');
    if (!restaurantId) return resolveOperations(null);
    const r = await Restaurant.findById(restaurantId)
        .select('subscription featureOverrides addons operations').lean();
    return resolveOperations(r);
}

/** No kitchen screen and nobody serving → an order is complete once released. */
function completesWithoutKitchen(ops) {
    return !ops.orderFlow.kitchenDisplay && !ops.orderFlow.servedStep;
}

async function deductStock(order) {
    try {
        const { deductInventoryForOrder } = require('../controllers/inventoryController');
        const result = await deductInventoryForOrder(order, order.restaurant, null);
        if (result?.errors?.length) logger.warn(`Inventory deduction warnings for ${order.orderId}:`, result.errors);
    } catch (err) {
        logger.warn(`Inventory deduction failed for ${order.orderId}: ${err.message}`);
    }
}

/**
 * Mark an order complete without a kitchen screen or a serving step.
 * Atomic on the order still being open, so it never runs twice.
 */
async function completeWithoutKitchen(order) {
    const done = await Order.findOneAndUpdate(
        { _id: order._id, restaurant: order.restaurant, status: { $in: ['new', 'ready'] } },
        { $set: { status: 'served', servedAt: new Date() } },
        { returnDocument: 'after' },
    );
    if (!done) return order;
    // 'preparing' (where stock is normally deducted) was skipped.
    // deductInventoryForOrder is idempotent on order.inventoryDeducted.
    await deductStock(done);
    try {
        const { releaseTableIfSettled } = require('../utils/tableOccupancy');
        if (done.table) {
            await releaseTableIfSettled(done, { restaurant: done.restaurant }, {
                branch: done.branch || null, restaurant: done.restaurant,
            });
        }
    } catch (err) {
        logger.warn(`Table release after auto-complete failed for ${done.orderId}: ${err.message}`);
    }
    try {
        const { getIO } = require('../utils/socket');
        const io = getIO();
        const payload = { orderId: done.orderId, status: 'served', restaurant: String(done.restaurant) };
        io.to(`order:${done.orderId}`).emit(EVENTS.ORDER_UPDATED, payload);
        if (done.user) io.to(String(done.user)).emit(EVENTS.ORDER_UPDATED, payload);
    } catch { /* socket not critical */ }
    return done;
}

/** Side effects an order normally gets at creation, run at release time. */
async function runReleaseSideEffects(order, ops) {
    const hasKitchenWork = order.status === 'new';

    // Live updates: kitchen (if it cooks this), dashboards, the customer.
    try {
        const { getIO, emitToKitchen, emitToAdmin } = require('../utils/socket');
        const io = getIO();
        const payload = {
            orderId: order.orderId,
            type: order.type,
            table: order.table || null,
            restaurant: String(order.restaurant),
        };
        if (hasKitchenWork && ops.orderFlow.kitchenDisplay) {
            emitToKitchen(io, order.branch || null, EVENTS.ORDER_NEW, payload);
        }
        emitToAdmin(io, order.branch || null, EVENTS.ORDER_UPDATED, { ...payload, status: order.status });
        io.to(`order:${order.orderId}`).emit(EVENTS.ORDER_UPDATED, { orderId: order.orderId, status: order.status });
        if (order.user) io.to(String(order.user)).emit(EVENTS.ORDER_UPDATED, { orderId: order.orderId, status: order.status });
    } catch { /* socket not critical */ }

    // Thermal KOT — held orders were never printed.
    try {
        const { enqueueKotJobs } = require('./printService');
        await enqueueKotJobs({ order, items: order.items, reason: 'create' });
    } catch (err) {
        logger.warn(`KOT print on release failed for ${order.orderId}: ${err.message}`);
    }

    // Counter-only items skip 'preparing', where stock is normally deducted.
    if (!hasKitchenWork) await deductStock(order);
}

/**
 * Release a held order to the kitchen. Call it AFTER the payment has been
 * recorded on the order. Returns the up-to-date order (released, or as
 * found when it was not held / already released / cancelled).
 *
 * Also releases the counter half of a split cart (splitParent) — it was
 * paid by the same checkout.
 */
async function releaseHeldOrder(orderOrId, { ops: knownOps } = {}) {
    const id = orderOrId?._id || orderOrId;
    if (!id) return null;
    const current = await Order.findById(id);
    if (!current) return null;
    if (current.status !== HELD) return current;

    const nextStatus = current.holdReleaseStatus || 'new';
    const released = await Order.findOneAndUpdate(
        { _id: id, restaurant: current.restaurant, status: HELD },
        { $set: { status: nextStatus, releasedAt: new Date() }, $unset: { holdExpiresAt: 1 } },
        { returnDocument: 'after' },
    );
    if (!released) return Order.findById(id);   // someone else released / cancelled it

    const ops = knownOps || await loadOps(released.restaurant);
    await runReleaseSideEffects(released, ops);
    let out = released;
    if (completesWithoutKitchen(ops)) out = await completeWithoutKitchen(released);

    // The counter half of a mixed cart is released only once IT is paid
    // (an online checkout settles both; a wallet pay of the primary
    // alone does not) — otherwise unpaid items would leave the counter.
    if (!released.splitParent) {
        const siblings = await Order.find({
            restaurant: released.restaurant, splitParent: released._id, status: HELD, paymentStatus: 'Paid',
        }).select('_id');
        for (const s of siblings) await releaseHeldOrder(s._id, { ops });
    }

    logger.info(`order ${released.orderId} released from hold → ${out.status}`);
    return out;
}

/** A failed online attempt gives the customer this long to retry before the hold expires. */
const ONLINE_FAILED_GRACE_MS = 15 * 60 * 1000;
/** An online hold that never heard from the gateway at all is given up after this long. */
const ONLINE_HOLD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const SWEEP_FIELDS = '_id orderId type status paymentStatus user table branch restaurant holdReason razorpayOrderId razorpayOrderIds total amountPaid walletAmountPaid paidAt onlinePaymentFailedAt createdAt';

/**
 * Razorpay reported `payment.failed` for a held online order. The order
 * stays held (the customer can retry from the same page) but now has a
 * short deadline: holdExpiresAt = now + 15 min, after which the sweeper
 * may cancel it — provided reconciliation finds no capture (see
 * cancelExpiredHolds). No-op unless the order is held with holdReason
 * 'online', so pay-after tenants (never held) are untouched.
 */
async function noteOnlinePaymentFailed(order, { now = new Date() } = {}) {
    if (!order || order.status !== HELD || order.holdReason !== 'online') return false;
    const res = await Order.updateOne(
        { _id: order._id, restaurant: order.restaurant, status: HELD, holdReason: 'online' },
        { $set: { onlinePaymentFailedAt: now, holdExpiresAt: new Date(now.getTime() + ONLINE_FAILED_GRACE_MS) } },
    );
    if (res.modifiedCount) {
        logger.info(`order ${order.orderId}: online payment failed while held — hold now expires in 15 min unless paid`);
    }
    return !!res.modifiedCount;
}

/**
 * Cancel one held order with the same side effects a manual cancel has
 * (orderStatusService): status flip pinned on 'awaiting-payment' and
 * unpaid, counter-payment alert cleared, stale staff notification rows
 * deleted, order:cancelled + order:updated to the staff rooms, the
 * order's room and the customer's room, table released, one log line.
 * Returns true when THIS call cancelled it.
 */
async function cancelHeldOrder(o, { now = new Date(), reason = 'payment-timeout', note = 'Pay-first order was not paid in time', by = 'held-order sweeper' } = {}) {
    const res = await Order.updateOne(
        { _id: o._id, restaurant: o.restaurant, status: HELD, paymentStatus: { $nin: ['Paid', 'Partially Paid'] } },
        { $set: {
            status: 'cancelled',
            cancelReason: reason,
            cancelReasonNote: note,
            cancelledAt: now,
        }, $unset: { holdExpiresAt: 1, counterPaymentRequestedAt: 1 } },
    );
    if (!res.modifiedCount) return false;

    // Counter "Mark paid" alerts and waiter / captain rows for this order
    // are no longer actionable (same cleanup as a manual cancel, plus the
    // counter-payment rows a held cash order created).
    try {
        const Notification = require('../models/notification');
        await Notification.deleteMany({
            restaurant: o.restaurant,
            'meta.orderId': o.orderId,
            recipientRole: { $in: ['admin', 'waiter', 'captain'] },
        });
    } catch (err) {
        logger.warn(`Notification cleanup after hold cancel failed for ${o.orderId}: ${err.message}`);
    }

    // Live updates — same audience as a manual cancel: staff rooms
    // (emitToStaff), the per-order room and the customer's own room.
    try {
        const { emitOrderEvent } = require('./orderHelpers');
        const base = {
            orderId: o.orderId, status: 'cancelled', paymentStatus: o.paymentStatus || 'Pending',
            cancelReason: reason, table: o.table || null, restaurant: String(o.restaurant),
        };
        emitOrderEvent(EVENTS.ORDER_CANCELLED, base, o);
        emitOrderEvent(EVENTS.ORDER_UPDATED, base, o);
    } catch { /* socket not critical */ }

    if (o.table) {
        try {
            const { releaseTableIfSettled } = require('../utils/tableOccupancy');
            await releaseTableIfSettled(o, { restaurant: o.restaurant }, { branch: o.branch || null, restaurant: o.restaurant });
        } catch (err) {
            logger.warn(`Table release after hold expiry failed for ${o.orderId}: ${err.message}`);
        }
    }

    logger.info(`order ${o.orderId} cancelled by ${by} (${reason})`, {
        orderId: o.orderId, restaurant: String(o.restaurant), holdReason: o.holdReason || null, cancelReason: reason,
    });
    return true;
}

/**
 * Before an ONLINE hold is cancelled: ask Razorpay whether a capture
 * exists on any checkout opened for the order. Found → the capture is
 * settled exactly as reconciliation does (claim, Paid, releaseHeldOrder).
 *   { outcome: 'none' }       no capture — safe to cancel
 *   { outcome: 'released' }   captured → order released, do NOT cancel
 *   { outcome: 'unknown' }    gateway unreachable / payment claimed elsewhere
 *                             / underpaid — leave the hold alone this round
 */
async function recoverOnlineHold(o) {
    try {
        const { recoverCapturedPaymentForOrder } = require('../controllers/razorpayController');
        const r = await recoverCapturedPaymentForOrder(o);
        if (r.status === 'none') return { outcome: 'none' };
        if (r.status === 'recovered' || r.status === 'already_settled') return { outcome: 'released', detail: r.status };
        return { outcome: 'unknown', detail: r.status };
    } catch (err) {
        logger.warn(`Held-order sweeper: could not verify online payment for ${o.orderId} — keeping the hold: ${err.message}`);
        return { outcome: 'unknown', detail: 'error' };
    }
}

/**
 * Cancel held orders nobody paid for before holdExpiresAt (cash promised
 * at the counter that never arrived, an abandoned checkout). Nothing was
 * cooked, printed or deducted, so this is a cancel + table release.
 *
 * Online holds (holdReason 'online'): the customer MAY already have been
 * charged and the gateway confirmation is just late, so they are never
 * cancelled on holdExpiresAt alone. One is considered only when
 *   (a) Razorpay reported payment.failed (onlinePaymentFailedAt set) and
 *       the 15-minute retry window (holdExpiresAt) has passed, or
 *   (b) the hold is older than 2 hours,
 * and even then it is cancelled only after reconciliation
 * (recoverOnlineHold) found no capture on any of its checkouts. A capture
 * found there releases the order instead (same path as verify-payment);
 * a gateway error leaves it for the next sweep.
 */
async function cancelExpiredHolds({ now = new Date(), limit = 200 } = {}) {
    // AUDIT-EXEMPT: system sweep across every tenant (no request context); each write below is pinned to the order's own restaurant.
    const expired = await Order.find({ status: HELD, holdReason: { $ne: 'online' }, holdExpiresAt: { $lte: now } })
        .select(SWEEP_FIELDS)
        .limit(limit)
        .lean();
    let cancelled = 0;
    for (const o of expired) {
        if (await cancelHeldOrder(o, { now })) cancelled += 1;
    }

    // AUDIT-EXEMPT: system sweep across every tenant (no request context); each write below is pinned to the order's own restaurant.
    const onlineDue = await Order.find({
        status: HELD,
        holdReason: 'online',
        $or: [
            { onlinePaymentFailedAt: { $ne: null }, holdExpiresAt: { $lte: now } },
            { createdAt: { $lte: new Date(now.getTime() - ONLINE_HOLD_MAX_AGE_MS) } },
        ],
    }).select(SWEEP_FIELDS).limit(limit).lean();
    let released = 0;
    let kept = 0;
    for (const o of onlineDue) {
        const { outcome } = await recoverOnlineHold(o);
        if (outcome === 'none') {
            const why = o.onlinePaymentFailedAt ? 'online payment failed and was not retried in time' : 'online payment never confirmed';
            if (await cancelHeldOrder(o, { now, note: `Pay-first order was not paid in time (${why})` })) cancelled += 1;
        } else if (outcome === 'released') {
            released += 1;
            logger.info(`Held-order sweeper: ${o.orderId} had a captured online payment — released instead of cancelled`);
        } else kept += 1;
    }
    return { scanned: expired.length + onlineDue.length, cancelled, released, kept };
}

module.exports = {
    HELD,
    releaseHeldOrder,
    completeWithoutKitchen,
    completesWithoutKitchen,
    cancelExpiredHolds,
    cancelHeldOrder,
    noteOnlinePaymentFailed,
    ONLINE_FAILED_GRACE_MS,
    ONLINE_HOLD_MAX_AGE_MS,
    loadOps,
};
