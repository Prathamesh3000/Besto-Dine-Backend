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

/**
 * Cancel held orders nobody paid for before holdExpiresAt (cash promised
 * at the counter that never arrived, an abandoned checkout). Nothing was
 * cooked, printed or deducted, so this is a plain cancel + table release.
 */
async function cancelExpiredHolds({ now = new Date(), limit = 200 } = {}) {
    // Online holds are NOT expired here: the customer may already have
    // been charged and the gateway confirmation is just late — the
    // webhook / reconciliation releases it, or the orphan-refund path
    // returns the money. Cancelling it would leave a paid, cancelled
    // order. Only cash / wallet promises expire.
    // AUDIT-EXEMPT: system sweep across every tenant (no request context); each write below is pinned to the order's own restaurant.
    const expired = await Order.find({ status: HELD, holdReason: { $ne: 'online' }, holdExpiresAt: { $lte: now } })
        .select('_id orderId table branch restaurant')
        .limit(limit);
    let cancelled = 0;
    for (const o of expired) {
        const res = await Order.updateOne(
            { _id: o._id, restaurant: o.restaurant, status: HELD, paymentStatus: { $nin: ['Paid', 'Partially Paid'] } },
            { $set: {
                status: 'cancelled',
                cancelReason: 'payment-timeout',
                cancelReasonNote: 'Pay-first order was not paid in time',
                cancelledAt: now,
            }, $unset: { holdExpiresAt: 1 } },
        );
        if (!res.modifiedCount) continue;
        cancelled += 1;
        if (o.table) {
            try {
                const { releaseTableIfSettled } = require('../utils/tableOccupancy');
                await releaseTableIfSettled(o, { restaurant: o.restaurant }, { branch: o.branch || null, restaurant: o.restaurant });
            } catch (err) {
                logger.warn(`Table release after hold expiry failed for ${o.orderId}: ${err.message}`);
            }
        }
    }
    return { scanned: expired.length, cancelled };
}

module.exports = {
    HELD,
    releaseHeldOrder,
    completeWithoutKitchen,
    completesWithoutKitchen,
    cancelExpiredHolds,
    loadOps,
};
