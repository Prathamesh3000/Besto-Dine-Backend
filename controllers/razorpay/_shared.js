// Shared helpers for the Razorpay controller modules (split out of the former
// controllers/razorpayController.js — behaviour unchanged). Order settlement,
// gateway fetch, loyalty and broadcast helpers used by more than one module.

const Razorpay = require('razorpay');
const crypto = require('crypto');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const Transaction = require('../../models/transaction');
const EVENTS = require('../../realtime/events');
const logger = require('../../utils/logger');
const idGen = require('../../utils/idGenerator');
const paymentState = require('../../utils/paymentState');
const rzpMock = require('../../utils/razorpayMock');
const { getIO, emitToStaff, emitToAdmin } = require('../../utils/socket');
const { getSettings } = require('../../utils/settingsCache');
const { tenantId } = require('../../utils/tenantScope');
const { resolveLoyaltySettings } = require('../../utils/paymentDefaults');
const { createTipForPaidOrder } = require('../../utils/tipHelpers');
const { releaseTableIfSettled } = require('../../utils/tableOccupancy');
const { verifyTypedToken, TOKEN_TYPES } = require('../../middlewares/authMiddleware');
const { roundPaise } = require('../../utils/orderRefund');

// Verified guest scan-session id from X-Scan-Token (never trusted raw).
// Used to stamp / match the payer of a guest Razorpay checkout.
function verifiedScanSessionId(req) {
    const token = req.headers?.['x-scan-token'];
    if (!token) return null;
    try {
        const decoded = verifyTypedToken(token, TOKEN_TYPES.SCAN);
        const tenant = tenantId(req);
        if (tenant && decoded.restaurantId && String(decoded.restaurantId) !== String(tenant)) return null;
        return decoded.sessionId ? String(decoded.sessionId) : null;
    } catch {
        return null;
    }
}

// DEV-ONLY: mock Razorpay orders minted by createRazorpayOrder in mock
// mode, so a mock payment can report the amount (and notes) its checkout
// was opened for. In-process and bounded; never used outside mock mode.
const mockOrderRegistry = new Map();
const MOCK_REGISTRY_MAX = 1000;
function rememberMockOrder(order) {
    if (!order?.id) return;
    if (mockOrderRegistry.size >= MOCK_REGISTRY_MAX) {
        mockOrderRegistry.delete(mockOrderRegistry.keys().next().value);
    }
    mockOrderRegistry.set(order.id, { amount: order.amount, notes: order.notes || {} });
}

// Fetch a payment + its Razorpay order. Throws on any gateway failure so
// callers fail CLOSED (bug #10) instead of trusting client data.
async function fetchPaymentAndOrder(paymentId, razorpayOrderId) {
    // Mock payments exist only in this process — the real gateway has
    // never heard of them, so fetching would 401. Synthesise the
    // captured-payment shape the callers assert on, including the amount
    // the mock checkout was opened for (without it the amount checks
    // refuse every mock payment). Gated on the `_mock_` id prefixes, so
    // a real payment is always fetched for real even while mock mode is on.
    if (rzpMock.isMockEnabled() && rzpMock.isMockPaymentId(paymentId)) {
        const minted = razorpayOrderId ? mockOrderRegistry.get(razorpayOrderId) : null;
        return {
            payment: {
                id: paymentId,
                entity: 'payment',
                status: 'captured',
                order_id: razorpayOrderId || null,
                method: 'mock',
                captured: true,
                amount: minted ? minted.amount : undefined,
                currency: 'INR',
                notes: minted ? minted.notes : {},
                created_at: Math.floor(Date.now() / 1000),
            },
            rzpOrder: razorpayOrderId
                ? {
                    id: razorpayOrderId,
                    entity: 'order',
                    status: 'paid',
                    amount: minted ? minted.amount : undefined,
                    amount_paid: minted ? minted.amount : 0,
                    notes: minted ? minted.notes : {},
                }
                : null,
        };
    }

    const payment = await razorpay.payments.fetch(paymentId);
    const orderId = razorpayOrderId || payment?.order_id;
    const rzpOrder = orderId ? await razorpay.orders.fetch(orderId) : null;
    return { payment, rzpOrder };
}

// Free a dine-in table (and every merged sibling) once payment lands.
// Table-status rule (utils/tableOccupancy.releaseTableIfSettled): the
// table turns Free as soon as no order on it / its merge group is
// unsettled — kitchen status no longer matters (a paid order still being
// cooked stays on the KDS). Another party's unpaid order keeps it
// occupied (activeOrder repointed). Tenant scope comes from the order's
// own `restaurant` field — never from the request — so a webhook / the
// reconciliation job (no req.user) still scopes and emits correctly.
async function freeTableIfReady(order) {
    if (!order || !order.table) return;
    if (order.paymentStatus !== 'Paid' && order.paymentStatus !== 'Refunded') return;
    try {
        const tf = order.restaurant ? { restaurant: order.restaurant } : {};
        await releaseTableIfSettled(order, tf, { branch: order.branch || null, restaurant: order.restaurant });
    } catch (err) {
        logger.warn('Razorpay path failed to free table:', err.message);
    }
}

// Settle the OTHER unpaid rounds on a dine-in table when the customer
// pays the aggregated bill. The bill-preview sums every unpaid round on
// the table (independent-orders model), so a single Razorpay capture
// covers the whole table — we must not leave the sibling rounds showing
// "Unpaid". The combined capture is recorded on the order the customer
// paid against (above); siblings are marked Paid with amountPaid 0 (their
// share is already inside that capture) so table revenue isn't
// double-counted. Dine-in only. Best-effort — never block the primary
// settlement on a sibling failure.
async function settleSiblingDineInRounds(order, paymentMethod) {
    if (!order || !order.table || order.type !== 'dine-in') return;
    // Pay-first: every round pays for itself (there is no aggregated table
    // bill), so this capture never covers another round. Decided per
    // ROUND (utils/operationsProfile.orderIsPayFirst): the order's recorded
    // channel first — an 'either' tenant mixes both kinds on one table —
    // then the tenant's dine-in mode for orders without one. Skip when the
    // paid order was held or is pay-first; skip pay-first siblings below.
    if (order.holdReason) return;
    const { orderIsPayFirst } = require('../../utils/operationsProfile');
    let ops = null;
    try {
        const { loadOps } = require('../../services/orderHoldService');
        ops = await loadOps(order.restaurant);
    } catch (err) {
        // A failed profile lookup must not change how a pay-after tenant
        // settles: fall through to today's default (aggregated table
        // bill → settle the siblings) exactly as before the ops profile.
        logger.warn('settleSiblingDineInRounds: operations profile lookup failed — continuing with the default (pay-after) behaviour', { error: err.message, orderId: order.orderId });
    }
    if (orderIsPayFirst(order, ops)) return;
    try {
        const tf = order.restaurant ? { restaurant: order.restaurant } : {};
        const siblings = await Order.find({
            table: order.table,
            _id: { $ne: order._id },
            // 'awaiting-payment' (held pay-first rounds) deliberately
            // excluded: the customer's table bill doesn't include them
            // (orderQueryService), so this capture doesn't cover them —
            // each is paid and released on its own (orderHoldService).
            status: { $in: ['new', 'preparing', 'ready', 'served'] },
            paymentStatus: { $ne: 'Paid' },
            ...tf,
        });
        let settled = 0;
        for (const sib of siblings) {
            if (orderIsPayFirst(sib, ops)) continue;   // pays for itself
            sib.paymentStatus = 'Paid';
            sib.paymentMethod = paymentMethod || order.paymentMethod || 'online';
            sib.amountPaid = 0; // covered by the combined capture on `order`
            if (!sib.paidAt) sib.paidAt = new Date();
            await sib.save();
            settled += 1;
            try { require('../../utils/webhookService').emitOrderPaid(sib); } catch { /* never affects settlement */ }
            try { await createTipForPaidOrder(sib, sib.restaurant || order.restaurant); } catch { /* tip best-effort */ }
        }
        if (settled) {
            logger.info(`Settled ${settled} sibling dine-in round(s) with ${order.orderId} on table ${order.table}`);
        }
    } catch (err) {
        logger.warn('Failed to settle sibling dine-in rounds:', err.message);
    }
}

// Settle the linked split doc(s) of the same checkout. A mixed cart
// (kitchen + counter items) is saved as two orders — the counter doc
// carries `splitParent` = the primary doc's _id (orderCreateService).
// The customer pays the whole checkout once, against the primary doc, so
// verify-payment / the webhook / reconciliation used to leave the counter
// doc "Unpaid". Same convention as settleSiblingDineInRounds: the capture
// stays recorded on the primary doc and the split doc is marked Paid with
// amountPaid 0 (its share is inside that capture) so revenue isn't
// double-counted.
//
// Only when the money collected on the primary doc covers the split
// doc(s) too (₹1 rounding tolerance): a payment made for the primary
// doc alone (e.g. the staff screen settling just that order) must not
// give the counter items away. Best-effort — never blocks the primary
// settlement.
async function settleSplitSiblings(order, paymentMethod) {
    if (!order || !order._id) return;
    try {
        const tf = order.restaurant ? { restaurant: order.restaurant } : {};
        const splits = await Order.find({
            splitParent: order._id,
            status: { $ne: 'cancelled' },
            paymentStatus: { $nin: ['Paid', 'Refunded'] },
            ...tf,
        });
        if (!splits.length) return;
        const dueOf = (o) => Math.max(0, (Number(o.total) || 0) - (Number(o.manualDiscount) || 0) - (Number(o.amountPaid) || 0));
        const needed = Math.max(0, (Number(order.total) || 0) - (Number(order.manualDiscount) || 0))
            + splits.reduce((s, o) => s + dueOf(o), 0);
        const collected = Number(order.amountPaid) || 0;
        if (collected < roundPaise(needed) - 1) {
            logger.warn('Split checkout: payment covers only the primary order — linked split order(s) left unpaid', {
                orderId: order.orderId,
                collected,
                needed: roundPaise(needed),
                splitOrderIds: splits.map((s) => s.orderId),
            });
            return;
        }
        for (const sib of splits) {
            const updated = await Order.findOneAndUpdate(
                { _id: sib._id, paymentStatus: { $nin: ['Paid', 'Refunded'] } },
                {
                    $set: {
                        paymentStatus: 'Paid',
                        paymentMethod: paymentMethod || order.paymentMethod || 'online',
                        amountPaid: Number(sib.amountPaid) || 0, // capture recorded on `order`
                        paidAt: sib.paidAt || order.paidAt || new Date(),
                    },
                },
                { returnDocument: 'after' }
            );
            if (!updated) continue;
            try { require('../../utils/webhookService').emitOrderPaid(updated); } catch { /* never affects settlement */ }
            // A split doc still held from the kitchen until paid (pay-first,
            // services/orderHoldService.js) is paid now — release it the
            // one supported way so it reaches the kitchen / KOT / stock.
            // Usually releaseHeldOrder(primary) already did; idempotent.
            if (updated.status === 'awaiting-payment') {
                try {
                    const { releaseHeldOrder } = require('../../services/orderHoldService');
                    await releaseHeldOrder(updated);
                } catch (err) {
                    logger.warn(`Release of held split order ${updated.orderId} failed: ${err.message}`);
                }
            }
            try { await createTipForPaidOrder(updated, updated.restaurant || order.restaurant); } catch { /* tip best-effort */ }
        }
        logger.info(`Settled ${splits.length} linked split order(s) with ${order.orderId}`);
    } catch (err) {
        logger.warn('Failed to settle linked split orders:', err.message);
    }
}

// Atomically flip an order to Paid for a captured Razorpay payment.
// The filter only matches an order that is not yet Paid/Refunded, so of
// several concurrent settlers (double-tapped verify, duplicate webhook
// deliveries, verify racing the webhook) exactly one wins and runs the
// side effects (loyalty, tip, siblings). Returns the updated order, or
// null when someone else already settled it.
//
// A prior partial payment (wallet) is kept: amountPaid = prior + captured,
// walletAmountPaid = prior, method 'mixed'. order.total is never touched.
async function markOrderPaidAtomically(order, { paymentId, razorpayOrderId, capturedAmount, priorPaid = 0, paidAt }) {
    const total = roundPaise(order.total);
    const set = { paymentStatus: 'Paid', razorpayPaymentId: paymentId };
    if (razorpayOrderId) set.razorpayOrderId = razorpayOrderId;
    if (priorPaid > 0 && priorPaid < total) {
        set.paymentMethod = 'mixed';
        set.amountPaid = roundPaise(priorPaid + capturedAmount);
        set.walletAmountPaid = priorPaid;
    } else {
        set.paymentMethod = 'online';
        set.amountPaid = roundPaise(capturedAmount);
    }
    set.paidAt = order.paidAt || paidAt || new Date();
    // Payment state block (Phase 4): verified path => 'paid'.
    Object.assign(set, paymentState.paidSet({
        method: set.paymentMethod, amount: capturedAmount, reference: paymentId,
    }));
    const update = { $set: set };
    // Tender line (task 2.3): the gateway capture, appended with the claim.
    update.$push = { payments: { method: 'razorpay', amount: roundPaise(capturedAmount), reference: String(paymentId || ''), at: new Date(), source: 'razorpay' } };
    // Keep the settling checkout in the order's checkout history (4a).
    if (razorpayOrderId) update.$addToSet = { razorpayOrderIds: razorpayOrderId };
    const paid = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: { $nin: ['Paid', 'Refunded'] } },
        update,
        { returnDocument: 'after' }
    );
    // Webhook `order.paid` (one event per order, see webhookService.emitOrderPaid).
    if (paid) { try { require('../../utils/webhookService').emitOrderPaid(paid); } catch { /* never affects settlement */ } }
    // A pay-first order held from the kitchen until its payment was
    // confirmed (operations profile) goes to the kitchen now. Verify,
    // webhook and reconciliation all settle through here.
    if (paid && paid.status === 'awaiting-payment') {
        const { releaseHeldOrder } = require('../../services/orderHoldService');
        return (await releaseHeldOrder(paid)) || paid;
    }
    // The order was cancelled before the gateway confirmed the capture
    // (e.g. a held pay-first 'online' order cancelled by the customer or
    // the hold-expiry sweep). The money is real, so the payment stays
    // recorded (Paid) — but it must not become a silent Paid+cancelled
    // order: queue a refund request exactly like cancelling a paid order
    // does. Callers check paidAfterCancel and skip the sale side effects
    // (loyalty, tip, sibling settlement, table release).
    if (paid && paid.status === 'cancelled') {
        try {
            const { queueRefundRequestOnCancel } = require('../../services/orderLifecycleService');
            await queueRefundRequestOnCancel(paid, 'Payment captured after the order was cancelled');
        } catch (err) {
            logger.error('Refund request for a payment on a cancelled order failed', { orderId: paid.orderId, error: err.message });
        }
        paid.paidAfterCancel = true;   // in-memory flag only (not in the schema)
    }
    return paid;
}

// Response / log text when a capture landed on an already-cancelled order.
const PAID_AFTER_CANCEL_MESSAGE = 'This order was cancelled before your payment was confirmed. A refund has been requested and will be processed by the restaurant.';

// ─── Razorpay instance ──────────────────────────────────────────────────────
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Constant-time HMAC compare — prevents timing-oracle attacks on the
// signature check. Used by verify-payment, verify-wallet-recharge, and
// the webhook handler.
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ─── Helper: Award loyalty points for a paid order ─────────────────────────
// Tenant context is taken from the order itself (order.restaurant), since
// the create-order flow stamps every order with the active tenant. This
// keeps the helper callable from background reconciliation jobs that
// don't have an Express req object.
async function awardLoyaltyPoints(order) {
    if (!order.user) return;
    const restaurantId = order.restaurant || null;
    const settings = await getSettings(restaurantId);
    const loyalty = resolveLoyaltySettings(settings);
    const { enableLoyalty, minBillToEarn: minBill, pointsPerRupee } = loyalty;

    const pointsEarned = (enableLoyalty && order.total >= minBill)
        ? Math.floor(order.total * pointsPerRupee)
        : 0;

    if (pointsEarned > 0) {
        // Atomic $inc to prevent race conditions with concurrent payments
        const walletFilter = restaurantId ? { user: order.user, restaurant: restaurantId } : { user: order.user };
        const wallet = await Wallet.findOneAndUpdate(
            walletFilter,
            { $inc: { loyaltyPoints: pointsEarned }, $setOnInsert: { balance: 0, restaurant: restaurantId } },
            { upsert: true, returnDocument: 'after' }
        );

        await Transaction.create({
            user: order.user,
            restaurant: restaurantId,
            order: order._id,
            type: 'points_earned',
            amount: pointsEarned,
            paymentMethod: 'points',
            status: 'completed',
            description: `Earned ${pointsEarned} points for order ${order.orderId}`,
            transactionId: idGen.transactionId(),
            balanceBefore: wallet.loyaltyPoints - pointsEarned,
            balanceAfter: wallet.loyaltyPoints,
        });
    }
}

// ─── Helper: Broadcast payment event to the right audience ────────────────
// order:updated goes to staff dashboards + the owning customer's room + the
// per-order room that guest trackers subscribe to. Prevents leaking one
// customer's payment status to every other connected browser.
function broadcastPaymentEvent(order, title, description) {
    try {
        const io = getIO();
        const branchId = order.branch || null;
        // Tenant hint so webhook / background callers (no request
        // context) aren't dropped by the socket tenant guard.
        const restaurant = order.restaurant ? String(order.restaurant) : undefined;
        emitToAdmin(io, branchId, EVENTS.NOTIFICATION_NEW, { title, description, restaurant });
        if (order.user) {
            io.to(order.user.toString()).emit(EVENTS.NOTIFICATION_NEW, {
                title,
                description: description || `Your refund for ${order.orderId} has been processed.`
            });
        }
        const payload = {
            orderId: order.orderId,
            status: order.status,
            paymentStatus: order.paymentStatus
        };
        emitToStaff(io, branchId, EVENTS.ORDER_UPDATED, { ...payload, restaurant });
        // Customer rooms: a payment event always reaches them, but with the
        // kitchen status collapsed when the order's branch has customer
        // tracking off (§12.3). Tracking on (the default) → the same
        // payload as before. The profile read is async and best-effort.
        const { customerOpsFor } = require('../../services/orderNotifications');
        const { customerEventPayload } = require('../../utils/customerTrackingPolicy');
        customerOpsFor(order).then((ops) => {
            const customerPayload = customerEventPayload(payload, ops);
            if (order.user) io.to(String(order.user)).emit(EVENTS.ORDER_UPDATED, customerPayload);
            if (order.orderId) io.to(`order:${order.orderId}`).emit(EVENTS.ORDER_UPDATED, customerPayload);
        }).catch((err) => logger.warn('Socket.io customer broadcast failed:', { error: err?.message }));
    } catch (socketError) {
        logger.warn('Socket.io broadcast failed:', { error: socketError.message });
    }
}


module.exports = {
    verifiedScanSessionId,
    mockOrderRegistry,
    rememberMockOrder,
    fetchPaymentAndOrder,
    freeTableIfReady,
    settleSiblingDineInRounds,
    settleSplitSiblings,
    markOrderPaidAtomically,
    PAID_AFTER_CANCEL_MESSAGE,
    razorpay,
    safeEqual,
    awardLoyaltyPoints,
    broadcastPaymentEvent,
};
