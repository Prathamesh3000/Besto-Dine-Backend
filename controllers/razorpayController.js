const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/order');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { invalidateTenant } = require('../middlewares/tenantContext');
const Restaurant = require('../models/restaurant');
const AuditLog = require('../models/auditLog');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const logger = require('../utils/logger');
const { getIO, emitToStaff, emitToAdmin } = require('../utils/socket');
const idGen = require('../utils/idGenerator');
const { getSettings } = require('../utils/settingsCache');
// Phase 4 step 4 — fire email alerts on subscription lifecycle events.
// Imported lazily-safe: utils/alerts.js catches all its own errors so
// failed alert sends can never break webhook processing.
const { notifyTenantHalted, notifyTenantCancelled } = require('../utils/alerts');

const { tenantFilter, tenantId } = require('../utils/tenantScope');
const { resolveLoyaltySettings } = require('../utils/paymentDefaults');
const { createTipForPaidOrder, revokeTipsForOrder } = require('../utils/tipHelpers');
const { releaseTableIfSettled } = require('../utils/tableOccupancy');
const {
    applyPendingUpgrade,
    applyPaidPlanUpgrade,
    applyScheduledDowngrade,
    pendingPaymentMismatch,
    localYmd,
} = require('../utils/planPaymentApply');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const AdvanceBooking = require('../models/advanceBooking');
const paymentState = require('../utils/paymentState');
const {
    checkWalletRechargePayment,
    checkOrderPaymentBinding,
    orderCheckoutIds,
    checkCaptureCoversDue,
    orderAmountDue,
    checkOrphanRefundEligibility,
    isValidCheckoutSignature,
    paiseToRupees,
} = require('../utils/paymentChecks');
const { claimPayment, releaseClaim, findClaim } = require('../utils/paymentClaim');
const {
    roundPaise,
    isWalletPaid,
    ledgerPaymentMethod,
    loyaltyPointsToClawBack,
} = require('../utils/orderRefund');

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
    const { orderIsPayFirst } = require('../utils/operationsProfile');
    let ops = null;
    try {
        const { loadOps } = require('../services/orderHoldService');
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
            // A split doc still held from the kitchen until paid (pay-first,
            // services/orderHoldService.js) is paid now — release it the
            // one supported way so it reaches the kitchen / KOT / stock.
            // Usually releaseHeldOrder(primary) already did; idempotent.
            if (updated.status === 'awaiting-payment') {
                try {
                    const { releaseHeldOrder } = require('../services/orderHoldService');
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
    // Keep the settling checkout in the order's checkout history (4a).
    if (razorpayOrderId) update.$addToSet = { razorpayOrderIds: razorpayOrderId };
    const paid = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: { $nin: ['Paid', 'Refunded'] } },
        update,
        { returnDocument: 'after' }
    );
    // A pay-first order held from the kitchen until its payment was
    // confirmed (operations profile) goes to the kitchen now. Verify,
    // webhook and reconciliation all settle through here.
    if (paid && paid.status === 'awaiting-payment') {
        const { releaseHeldOrder } = require('../services/orderHoldService');
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
            const { queueRefundRequestOnCancel } = require('../services/orderLifecycleService');
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
        const { customerOpsFor } = require('../services/orderNotifications');
        const { customerEventPayload } = require('../utils/customerTrackingPolicy');
        customerOpsFor(order).then((ops) => {
            const customerPayload = customerEventPayload(payload, ops);
            if (order.user) io.to(String(order.user)).emit(EVENTS.ORDER_UPDATED, customerPayload);
            if (order.orderId) io.to(`order:${order.orderId}`).emit(EVENTS.ORDER_UPDATED, customerPayload);
        }).catch((err) => logger.warn('Socket.io customer broadcast failed:', { error: err?.message }));
    } catch (socketError) {
        logger.warn('Socket.io broadcast failed:', { error: socketError.message });
    }
}

// ─── POST /api/razorpay/create-order ────────────────────────────────────────
// Creates a Razorpay order for the given amount. The frontend uses this
// orderId to open the Razorpay checkout modal.
//
// Request body: { amount (in ₹), cafeOrderId (our Order _id), receipt? }
// Response:     { success, razorpayOrder }

const { describeRazorpayError } = require('../utils/razorpayErrors');
const rzpMock = require('../utils/razorpayMock');

/** Razorpay rejects any receipt longer than this. */
const RAZORPAY_RECEIPT_MAX = 40;

/**
 * Build a receipt that fits Razorpay's 40-char limit.
 *
 * Keeps the TAIL of the order id rather than the head: the last hex
 * digits of a Mongo ObjectId are the counter/random section, so they
 * vary between adjacent orders, whereas the leading bytes are a shared
 * timestamp. Truncating from the front would make receipts collide.
 */
function buildReceipt(explicit, cafeOrderId) {
    if (explicit) return String(explicit).slice(0, RAZORPAY_RECEIPT_MAX);
    const id = String(cafeOrderId || 'new');
    const stamp = Date.now().toString(36);          // 8 chars, not 13
    const prefix = 'rcpt_';
    const budget = RAZORPAY_RECEIPT_MAX - prefix.length - 1 - stamp.length;
    return `${prefix}${id.slice(-budget)}_${stamp}`;
}

// Resolve a tenant-owned order by _id / orderId and mark its payment failed.
// Best-effort; never throws.
async function failOrderPayment(req, cafeOrderId, { reason, reference, requireReference = false }) {
    try {
        const tf = tenantFilter(req);
        let order = null;
        if (mongoose.Types.ObjectId.isValid(cafeOrderId)) order = await Order.findOne({ _id: cafeOrderId, ...tf }).select('_id table branch restaurant').lean();
        if (!order) order = await Order.findOne({ orderId: cafeOrderId, ...tf }).select('_id table branch restaurant').lean();
        if (!order) return false;
        const filter = { _id: order._id, ...tf };
        if (requireReference) filter['payment.reference'] = reference;
        const changed = await paymentState.markPaymentFailed(filter, { reason, reference });
        if (changed) paymentState.emitBillingState(order);
        return changed;
    } catch (err) {
        logger.warn('failOrderPayment failed (non-fatal)', { error: err.message });
        return false;
    }
}

exports.createRazorpayOrder = async (req, res) => {
    try {
        const { amount, cafeOrderId, receipt } = req.body;

        // Validate amount — must be a positive finite number within Razorpay limits
        // Razorpay refuses orders under 100 paise — reject before the gateway.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > 10_000_000) {
            return res.status(400).json({ success: false, message: 'Amount must be a valid number between ₹1 and ₹1,00,00,000' });
        }

        // ── R-04: tenant-ownership gate ──────────────────────────────────
        // The webhook handler below uses `payment.notes.cafeOrderId` to
        // locate our Order. If we let any caller pass *any* cafeOrderId
        // through unchecked, a malicious customer could create a Razorpay
        // order whose notes point at a DIFFERENT tenant's order _id, pay
        // ₹1, and the webhook would flip that foreign order to `Paid`.
        //
        // Two defences here:
        //   (a) When a cafeOrderId is supplied, verify it actually
        //       belongs to the caller's tenant before proceeding.
        //   (b) Stamp `notes.restaurantId` so the webhook can cross-
        //       check tenant consistency even on paths that don't hit
        //       the new `razorpayOrderId` lookup.
        //
        // Deferred-order flows (advance booking, late-create takeaway)
        // legitimately have no cafeOrderId — accept those with just the
        // tenant stamp. Tenant itself is required (attachTenant sets
        const tenant = tenantId(req);
        if (!tenant) {
            return res.status(400).json({
                success: false,
                code: 'TENANT_REQUIRED',
                message: 'Restaurant context is required to create a payment.',
            });
        }
        let ownedOrder = null;
        if (cafeOrderId && cafeOrderId !== 'none') {
            const tf = tenantFilter(req);
            const fields = '_id orderId total amountPaid paymentStatus status razorpayOrderId table branch';
            if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
                ownedOrder = await Order.findOne({ _id: cafeOrderId, ...tf }).select(fields).lean();
            }
            if (!ownedOrder) {
                ownedOrder = await Order.findOne({ orderId: cafeOrderId, ...tf }).select(fields).lean();
            }
            if (!ownedOrder) {
                logger.warn('createRazorpayOrder: cafeOrderId not owned by caller — blocking', {
                    cafeOrderId,
                    tenant: String(tenant),
                    userId: req.user?._id || null,
                });
                return res.status(404).json({
                    success: false,
                    code: 'ORDER_NOT_FOUND',
                    message: 'Order not found for this restaurant.',
                });
            }
            // Decision 4b: never open a checkout the customer could pay
            // for an order that can no longer take the money — verify
            // would refuse it and the customer would be charged for
            // nothing. Refused before the gateway is called.
            if (ownedOrder.paymentStatus === 'Paid' || ownedOrder.paymentStatus === 'Refunded') {
                return res.status(409).json({
                    success: false,
                    code: 'ORDER_ALREADY_PAID',
                    message: 'This order is already paid.',
                });
            }
            if (ownedOrder.status === 'cancelled') {
                return res.status(409).json({
                    success: false,
                    code: 'ORDER_CANCELLED',
                    message: 'This order has been cancelled and cannot be paid.',
                });
            }
            // Compare with what is still DUE (total − a prior wallet part),
            // the same rule verify-payment applies to the capture.
            const { due } = orderAmountDue(ownedOrder);
            if (typeof ownedOrder.total === 'number' && amount < due - 1) {
                return res.status(400).json({
                    success: false,
                    code: 'AMOUNT_MISMATCH',
                    message: `Payment amount ₹${amount} does not cover the amount due ₹${due}.`,
                });
            }
        }

        const options = {
            amount: Math.round(amount * 100), // Razorpay expects paise
            currency: 'INR',
            // Razorpay caps `receipt` at 40 characters and rejects the
            // whole order with a 400 when it's longer. The old template
            // was rcpt_ (5) + ObjectId (24) + _ (1) + Date.now() (13)
            // = 43, so EVERY order carrying a cafeOrderId failed. Build
            // it within budget and clamp as a belt-and-braces guard in
            // case a caller passes a long `receipt` of their own.
            receipt: buildReceipt(receipt, cafeOrderId),
            notes: {
                cafeOrderId: cafeOrderId || 'none',
                // R-04: authoritative tenant marker for the webhook.
                restaurantId: String(tenant),
                purpose: 'cafe_order',
            },
        };
        // Bugs #4 / #10 — stamp WHO is paying so verify (deferred
        // binding) and orphan-refund can prove the payment belongs to
        // the caller. Razorpay notes values must be strings.
        const payerId = req.user?._id || req.user?.id;
        if (payerId) {
            options.notes.userId = String(payerId);
            options.notes.payerRole = String(req.user?.role || '');
        }
        const scanSessionId = verifiedScanSessionId(req);
        if (scanSessionId) options.notes.scanSessionId = scanSessionId;

        // DEV-ONLY mock gateway. Returns the same shape the real API
        // would, so nothing downstream knows the difference. Hard-off in
        // production — see utils/razorpayMock.js for the three guards.
        let razorpayOrder;
        if (rzpMock.isMockEnabled()) {
            razorpayOrder = rzpMock.createMockOrder(options);
            rememberMockOrder(razorpayOrder);
            logger.warn('⚠️  MOCK PAYMENT — no money moves. RAZORPAY_MOCK=true', {
                rzpOrderId: razorpayOrder.id,
                amountPaise: options.amount,
            });
        } else {
            razorpayOrder = await razorpay.orders.create(options);
        }

        // R-04: immediately stamp `razorpayOrderId` onto the cafe order
        // under tenant scope. That makes the globally-unique Razorpay ID
        // the authoritative lookup key in the webhook handler — which no
        // longer has to trust the client-supplied notes.cafeOrderId to
        // find the right order. Wrapped so a stamp failure never blocks
        // the checkout; webhook still has `notes.restaurantId` as backup.
        //
        // Decision 4a: the new checkout is ADDED to the order's checkout
        // history (razorpayOrderIds) instead of replacing the previous
        // one, so a payment through an older, still-open checkout of the
        // same order is still accepted by verify / webhook. A legacy
        // order's single razorpayOrderId is carried into the history.
        if (ownedOrder) {
            await paymentState.markPaymentPending(
                { _id: ownedOrder._id, ...tenantFilter(req) },
                { amount, method: 'online', reference: razorpayOrder.id, userId: req.user?._id || null },
            );
            paymentState.emitBillingState({ ...ownedOrder, restaurant: tenantId(req) });
            try {
                const history = [ownedOrder.razorpayOrderId, razorpayOrder.id].filter(Boolean);
                await Order.updateOne(
                    { _id: ownedOrder._id, ...tenantFilter(req) },
                    {
                        $set: { razorpayOrderId: razorpayOrder.id },
                        $addToSet: { razorpayOrderIds: { $each: history } },
                    }
                );
            } catch (stampErr) {
                logger.warn('Failed to stamp razorpayOrderId on cafe order (non-fatal)', {
                    cafeOrderId,
                    rzpOrderId: razorpayOrder.id,
                    error: stampErr.message,
                });
            }
        }

        logger.info(`Razorpay order created: amount=₹${amount}, cafeOrderId=${cafeOrderId || 'none'}, rzpOrderId=${razorpayOrder.id}, tenant=${tenant}`);

        return res.status(200).json({
            success: true,
            razorpayOrder: {
                id: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                receipt: razorpayOrder.receipt,
            },
            // Tells the client to bypass Razorpay's hosted checkout.
            // Absent (undefined) on every real order.
            mock: razorpayOrder.mock === true || undefined,
            key: process.env.RAZORPAY_KEY_ID, // frontend needs this to open checkout
        });
    } catch (err) {
        logger.error('Razorpay create order error:', describeRazorpayError(err));
        return res.status(500).json({ success: false, message: 'Failed to create payment order' });
    }
};

// ─── POST /api/razorpay/verify-payment ──────────────────────────────────────
// Verifies the Razorpay payment signature, then updates the cafe order's
// payment status to 'Paid' and triggers loyalty point earning.
//
// Request body: {
//   razorpay_order_id, razorpay_payment_id, razorpay_signature,
//   cafeOrderId (our Order _id)
// }
exports.verifyPayment = async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            cafeOrderId,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Payment details are required' });
        }

        // ── Signature verification ────────────────────────────────────────
        // A mock payment has no real signature to check. The bypass is
        // deliberately narrow: mock mode must be on AND both ids must
        // carry the `_mock_` prefixes this server minted. So a genuine
        // Razorpay payment is still verified normally even in mock mode,
        // and a forged signature on a real order id is still rejected.
        const isMockPayment = rzpMock.shouldBypassSignature(razorpay_order_id, razorpay_payment_id);

        if (isMockPayment) {
            logger.warn('⚠️  MOCK PAYMENT accepted without signature verification', {
                rzpOrderId: razorpay_order_id,
                rzpPaymentId: razorpay_payment_id,
            });
        } else {
            const body = razorpay_order_id + '|' + razorpay_payment_id;
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(body)
                .digest('hex');

            if (!safeEqual(expectedSignature, razorpay_signature)) {
                // Phase 4: surface the failure on the order, but only when
                // the caller names the checkout that is pending on it (an
                // unauthenticated forged call cannot fail an unrelated order).
                if (cafeOrderId) {
                    await failOrderPayment(req, cafeOrderId, {
                        reason: 'Invalid signature', reference: razorpay_order_id, requireReference: true,
                    });
                }
                return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
            }
        }

        // No cafe order to settle (e.g. advance-booking pre-check): the
        // signature check above is the whole contract. Nothing is marked
        // paid here — the booking endpoint re-verifies server-side.
        if (!cafeOrderId) {
            return res.status(200).json({
                success: true,
                message: 'Payment verified successfully',
                paymentId: razorpay_payment_id,
            });
        }

        // ── Locate the cafe order (tenant-scoped) ─────────────────────────
        const tf = tenantFilter(req);
        let order = null;
        if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
            order = await Order.findOne({ _id: cafeOrderId, ...tf });
        }
        if (!order) {
            order = await Order.findOne({ orderId: cafeOrderId, ...tf });
        }
        if (!order) {
            return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found for this restaurant.' });
        }

        // Idempotent replay: the same payment already settled this order
        // (earlier verify, webhook or reconciliation).
        if (order.paymentStatus === 'Paid') {
            if (order.razorpayPaymentId === razorpay_payment_id) {
                return res.status(200).json({
                    success: true,
                    message: 'Payment verified successfully',
                    paymentId: razorpay_payment_id,
                });
            }
            return res.status(409).json({
                success: false,
                code: 'ORDER_ALREADY_PAID',
                message: 'This order is already paid. Please contact staff about this payment.',
            });
        }

        // ── Bug #10: fetch from Razorpay — fail CLOSED ────────────────────
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, razorpay_order_id));
        } catch (fetchErr) {
            logger.error('verifyPayment: Razorpay fetch failed — refusing to mark order paid', {
                razorpay_payment_id,
                orderId: order.orderId,
                error: fetchErr.message,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_UNAVAILABLE',
                message: 'Could not confirm the payment with the gateway. Please try again in a moment.',
            });
        }

        const binding = checkOrderPaymentBinding({
            order,
            payment,
            rzpOrder,
            razorpayOrderId: razorpay_order_id,
            tenant: tenantId(req),
        });
        if (!binding.ok) {
            logger.warn('verifyPayment: payment/order binding rejected', {
                code: binding.code,
                orderId: order.orderId,
                razorpay_order_id,
                razorpay_payment_id,
            });
            await paymentState.markPaymentFailed(
                { _id: order._id, ...tf },
                { reason: binding.code, reference: razorpay_order_id },
            );
            paymentState.emitBillingState(order);
            return res.status(binding.status).json({ success: false, code: binding.code, message: binding.message });
        }

        // ── Payment id is single-use across orders ────────────────────────
        // Legacy guard for payments settled before the claim ledger.
        const usedElsewhere = await Order.exists({
            razorpayPaymentId: razorpay_payment_id,
            _id: { $ne: order._id },
        });
        if (usedElsewhere) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used for another order.' });
        }
        const claim = await claimPayment(razorpay_payment_id, {
            purpose: 'order_payment',
            ref: String(order._id),
            razorpayOrderId: razorpay_order_id,
            restaurant: order.restaurant || tenantId(req) || null,
            user: order.user || null,
            amount: binding.amount,
        });
        if (!claim.claimed) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
        }

        // Atomic Paid transition: a concurrent verify of the same payment
        // (a claim replay) loses here and skips the side effects, so
        // loyalty points are awarded once.
        let paidOrder;
        try {
            paidOrder = await markOrderPaidAtomically(order, {
                paymentId: razorpay_payment_id,
                razorpayOrderId: razorpay_order_id,
                capturedAmount: binding.amount,
                priorPaid: binding.priorPaid,
            });
        } catch (saveErr) {
            if (!claim.replay) {
                await releaseClaim(razorpay_payment_id, { purpose: 'order_payment', ref: String(order._id) });
            }
            throw saveErr;
        }
        if (!paidOrder) {
            const current = await Order.findById(order._id).select('razorpayPaymentId').lean();
            if (current && current.razorpayPaymentId === razorpay_payment_id) {
                return res.status(200).json({
                    success: true,
                    message: 'Payment verified successfully',
                    paymentId: razorpay_payment_id,
                });
            }
            if (!claim.replay) {
                await releaseClaim(razorpay_payment_id, { purpose: 'order_payment', ref: String(order._id) });
            }
            return res.status(409).json({
                success: false,
                code: 'ORDER_ALREADY_PAID',
                message: 'This order is already paid. Please contact staff about this payment.',
            });
        }
        order = paidOrder;

        // Captured after the order was cancelled: payment recorded and a
        // refund request queued (markOrderPaidAtomically) — not a sale.
        if (order.paidAfterCancel) {
            return res.status(409).json({
                success: false,
                code: 'ORDER_CANCELLED_REFUND_REQUESTED',
                refundRequested: true,
                message: PAID_AFTER_CANCEL_MESSAGE,
            });
        }

        // ── Side effects — best effort; the order is already settled ─────
        try {
            await awardLoyaltyPoints(order);

            // Record the waiter's tip (idempotent). Must run on this path
            // too — otherwise Razorpay-paid orders bypass the PATCH status
            // handler and never produce a Tip.
            await createTipForPaidOrder(order, order.restaurant || tenantId(req));

            // Aggregated dine-in bill: this capture covers every unpaid
            // round on the table, so settle the siblings too.
            await settleSiblingDineInRounds(order, 'online');

            // Mixed-cart checkout: the linked counter-side split doc(s).
            await settleSplitSiblings(order, 'online');

            // Release the table now that the bill is settled.
            await freeTableIfReady(order);

            // Persist only — the live events go out via broadcastPaymentEvent.
            await notify({
                restaurant: order.restaurant || tenantId(req),
                branch: order.branch || null,
                notification: {
                    recipientRole: 'admin',
                    title: 'Payment Confirmed',
                    description: `Online payment of ₹${order.total} received for order ${order.orderId}`,
                    category: 'Payment',
                    priority: 'medium',
                    meta: { orderId: order.orderId, amount: order.total },
                },
            });

            broadcastPaymentEvent(order, 'Payment Confirmed',
                `Online payment of ₹${order.total} received for ${order.orderId}`);
        } catch (sideErr) {
            logger.warn('verifyPayment: post-payment side effect failed (order already Paid)', {
                orderId: order.orderId,
                error: sideErr.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Payment verified successfully',
            paymentId: razorpay_payment_id,
        });
    } catch (err) {
        logger.error('Razorpay verify error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Payment verification failed' });
    }
};

// ─── Deferred checkout → POST /orders (decision 4c) ─────────────────────────
// "Pay first, then order" (takeaway / kiosk): the browser holds the
// checkout result BEFORE the cafe order exists. services/orderCreateService
// calls this when POST /orders carries that result, so the payment is
// linked to the order the moment the order is written — after which
// /razorpay/orphan-refund refuses it (the food was ordered).
//
// `order` is the order-to-be: { _id, orderId, restaurant, user, total,
// amountPaid }. Returns
//   { ok: true, confirmed: true,  razorpayOrderId, paymentId, amount }
//   { ok: true, confirmed: false, razorpayOrderId, paymentId }
//        — signature valid but the gateway could not be reached: the
//          ids are still stamped (so the webhook / reconciliation can
//          settle it and orphan-refund refuses it) but nothing is
//          claimed; verify-payment does the full check later.
//   { ok: false, status, code, message }  — refuse the order.
const CHECKOUT_ID_RE = /^[A-Za-z0-9_]{1,64}$/;
exports.verifyCheckoutForNewOrder = async (req, { checkout, order }) => {
    const razorpayOrderId = checkout?.razorpay_order_id;
    const paymentId = checkout?.razorpay_payment_id;
    const signature = checkout?.razorpay_signature;
    if (typeof razorpayOrderId !== 'string' || !CHECKOUT_ID_RE.test(razorpayOrderId)
        || typeof paymentId !== 'string' || !CHECKOUT_ID_RE.test(paymentId)
        || typeof signature !== 'string' || signature.length > 256) {
        return { ok: false, status: 400, code: 'PAYMENT_DETAILS_INVALID', message: 'Payment details are invalid.' };
    }
    const isMock = rzpMock.shouldBypassSignature(razorpayOrderId, paymentId);
    if (!isMock && !isValidCheckoutSignature({
        razorpayOrderId,
        razorpayPaymentId: paymentId,
        signature,
        secret: process.env.RAZORPAY_KEY_SECRET,
    })) {
        return { ok: false, status: 400, code: 'PAYMENT_SIGNATURE_INVALID', message: 'Payment verification failed — invalid signature.' };
    }

    let payment;
    let rzpOrder;
    try {
        ({ payment, rzpOrder } = await fetchPaymentAndOrder(paymentId, razorpayOrderId));
    } catch (fetchErr) {
        logger.warn('Order create: gateway unreachable — linking the signed checkout unconfirmed', {
            razorpayOrderId, paymentId, error: fetchErr.message,
        });
        return { ok: true, confirmed: false, razorpayOrderId, paymentId };
    }

    const binding = checkOrderPaymentBinding({
        order, payment, rzpOrder, razorpayOrderId, tenant: tenantId(req),
    });
    if (!binding.ok) {
        logger.warn('Order create: checkout refused for the new order', {
            code: binding.code, razorpayOrderId, paymentId,
        });
        return binding;
    }
    return { ok: true, confirmed: true, razorpayOrderId, paymentId, amount: binding.amount };
};

// ─── POST /api/razorpay/webhook ────────────────────────────────────────────
// Server-to-server webhook called by Razorpay. Handles payment.captured and
// payment.failed events. This catches payments where the frontend crashed
// after Razorpay debited the customer but before verifyPayment was called.
//
/**
 * ── WEBHOOK HANDLER (ROBUST SAFETY NET) ──────────────────────────────
 * Ensures DB is updated even if user closes tab after payment.
 */
exports.handleWebhook = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.headers['x-razorpay-signature'];

        // ── R-03: webhook retry-storm protection ────────────────────────
        // Razorpay retries any non-2xx response for up to 24 hours with
        // exponential backoff. A single bad webhook (invalid signature,
        // malformed body, missing header) previously returned 4xx and
        // produced a retry flood that spammed logs and the DB.
        //
        // Policy going forward:
        //   - Receipt-layer failures (bad sig / bad JSON / missing
        //     header) → log at ERROR (so ops see them) and return 200.
        //     Razorpay retrying won't help — the next delivery will
        //     fail identically, and a real attacker can't brute-force
        //     HMAC-SHA256 anyway.
        //   - Only a MISSING `RAZORPAY_WEBHOOK_SECRET` env var returns
        //     500, because that IS a transient ops issue that benefits
        //     from Razorpay's retry window to not lose events while
        //     the secret is being deployed.
        //
        // Forensic context is included in every drop log so a security
        // team can pivot on: remote IP, signature length, body size,
        // event ID (when parseable). That's enough to correlate with
        // upstream logs without leaking internal state back to callers.
        const forensic = {
            remoteIp: req.ip,
            bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : null,
            sigLen: typeof signature === 'string' ? signature.length : null,
            userAgent: req.headers['user-agent'] || null,
        };

        // 1. Signature Verification — MANDATORY when secret is configured
        if (!webhookSecret) {
            // Keep the 5xx here: we WANT Razorpay to retry until ops
            // rolls out the secret; otherwise we permanently lose the
            // event. Razorpay's 24h retry window covers most incidents.
            logger.error('RAZORPAY_WEBHOOK_SECRET not configured — rejecting webhook', forensic);
            return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
        }
        if (!signature) {
            // No sig header at all → almost certainly not Razorpay (or a
            // broken proxy stripping headers). Drop with 200 + error log.
            logger.error('Webhook received without x-razorpay-signature header — dropping (not retrying)', forensic);
            return res.status(200).json({ status: 'ok' });
        }

        // server.js mounts express.raw() for this route so req.body is a
        // Buffer containing the exact bytes Razorpay signed. Fall back to
        // JSON.stringify only if some reverse-proxy layer parsed ahead of
        // us — warn loudly because that path is signature-fragile.
        let rawBody;
        let parsed;
        if (Buffer.isBuffer(req.body)) {
            rawBody = req.body.toString('utf8');
            try { parsed = JSON.parse(rawBody); }
            catch (e) {
                // Malformed JSON — retrying won't fix it. Log and drop.
                logger.error('Webhook body not valid JSON — dropping (not retrying)', {
                    ...forensic,
                    parseError: e.message,
                });
                return res.status(200).json({ status: 'ok' });
            }
        } else {
            logger.warn('Webhook body was parsed before signature verification — check express.raw() mount', forensic);
            parsed = req.body;
            rawBody = JSON.stringify(req.body);
        }

        const expectedSig = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (!safeEqual(expectedSig, signature)) {
            // Signature mismatch. Retry won't help (HMAC is deterministic),
            // and a brute-force attacker against SHA-256 isn't a real
            // threat. Log at ERROR so ops SIEM pipelines catch it —
            // sustained mismatches indicate either a rotated secret that
            // wasn't deployed, a misconfigured reverse proxy mangling the
            // body, or a real probe/attack. Whichever it is, replying 200
            // prevents the retry storm; the log is the signal.
            logger.error('Webhook signature mismatch — dropping (not retrying)', {
                ...forensic,
                event: parsed?.event || null,
                eventId: parsed?.id || null,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Route by event family. Payment events (`payment.*`,
        //    `refund.*`) are about per-order transactions and look at
        //    payload.payment.entity. Subscription events (`subscription.*`)
        //    are about SaaS billing and look at payload.subscription.entity.
        const event = parsed.event;

        if (event && event.startsWith('subscription.')) {
            await handleSubscriptionEvent(event, parsed.payload);
            return res.json({ status: 'ok' });
        }

        // 3. Payment / refund events (existing flow)
        const payment = parsed.payload?.payment?.entity;
        if (!payment) return res.status(200).json({ status: 'ok' });

        // ADM-105 / ADM-106 — fallback-orders subscription path.
        // When the Subscriptions API isn't enabled on the Razorpay
        // account, tenantBillingController.upgradePlan falls back to
        // a one-time Orders API call stamped with notes.type ===
        // 'plan_payment'. Those payments don't belong to any cafe
        // Order, so they need a dedicated branch BEFORE the
        // order-lookup code below runs (which would 404 and skip the
        // invoice creation entirely).
        if (event === 'payment.captured' && payment.notes?.type === 'plan_payment') {
            await handlePlanPaymentCaptured(payment, parsed);
            return res.json({ status: 'ok' });
        }

        const cafeOrderId = payment.notes?.cafeOrderId || payment.notes?.orderId;
        // R-04 — authoritative tenant tag stamped at createRazorpayOrder
        // time. Absent on payments created before this fix shipped; those
        // fall back to the razorpayOrderId-only path below.
        const notesRestaurantId = payment.notes?.restaurantId || null;
        const rzpOrderId = payment.order_id;

        // ── R-04: safe, tenant-aware order lookup ────────────────────────
        // The old flow searched globally by cafeOrderId, then by orderId
        // string, then by razorpayOrderId. A malicious customer could
        // create a Razorpay order whose `notes.cafeOrderId` pointed at
        // ANOTHER tenant's order _id, pay a nominal amount, and the
        // webhook would happily flip that foreign order to Paid.
        //
        // New lookup order, safest first:
        //   1. `razorpayOrderId` — globally unique across our entire
        //      platform Razorpay account. Stamped onto the cafe order
        //      inside createRazorpayOrder under tenant scope, so a match
        //      here is canonically the right order.
        //   2. `_id` or `orderId` string via notes, BUT ONLY if the
        //      payment's notes carry a `restaurantId` that matches the
        //      found order's tenant. Without that tag, we refuse — the
        //      webhook can't tell a legitimate tenant-A payment from an
        //      attacker who guessed tenant-B's _id.
        //
        // Every failure path returns 200 per R-03 so Razorpay doesn't
        // retry-storm; the logs carry the forensics.
        let order = null;
        let lookupPath = null;

        if (rzpOrderId) {
            // Decision 4a: the checkout may be an older one of the order
            // (razorpayOrderIds history), not only the latest.
            order = await Order.findOne({
                $or: [{ razorpayOrderId: rzpOrderId }, { razorpayOrderIds: rzpOrderId }],
            });
            if (order) lookupPath = 'razorpayOrderId';
        }

        if (!order && cafeOrderId && cafeOrderId !== 'none') {
            if (!notesRestaurantId || !mongoose.Types.ObjectId.isValid(notesRestaurantId)) {
                // Legacy pre-R-04 payment (no tenant tag) AND the cafe
                // order doesn't have razorpayOrderId stamped yet. Refuse
                // rather than risk cross-tenant misapplication. Admin can
                // reconcile manually from the Razorpay dashboard.
                logger.error('Webhook: refusing cafeOrderId lookup without notes.restaurantId — cannot safely disambiguate tenant', {
                    cafeOrderId,
                    rzpOrderId,
                    event: parsed.event,
                });
            } else {
                const scopedFilter = { restaurant: notesRestaurantId };
                if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
                    order = await Order.findOne({ _id: cafeOrderId, ...scopedFilter });
                    if (order) lookupPath = '_id+notes.restaurantId';
                }
                if (!order) {
                    order = await Order.findOne({ orderId: cafeOrderId, ...scopedFilter });
                    if (order) lookupPath = 'orderId+notes.restaurantId';
                }
            }
        }

        if (!order) {
            logger.warn('Webhook: no order match after all lookups', {
                rzpOrderId,
                cafeOrderId,
                notesRestaurantId,
                event: parsed.event,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // ── Tenant consistency (defense-in-depth) ────────────────────────
        // Even on the "authoritative" razorpayOrderId path, if the payment
        // carries a `notes.restaurantId` it MUST match order.restaurant.
        // Catches the (very) unlikely case where a prior bug wrote the
        // wrong razorpayOrderId onto a cafe order, or where a future
        // payment ID collision could occur.
        if (notesRestaurantId && order.restaurant && String(order.restaurant) !== String(notesRestaurantId)) {
            logger.error('Webhook: tenant mismatch between order and payment notes — rejecting', {
                orderId: order.orderId,
                orderTenant: String(order.restaurant),
                notesTenant: String(notesRestaurantId),
                rzpOrderId,
                lookupPath,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // Razorpay order_id consistency — the order's stored razorpayOrderId
        // (if any) must agree with what the webhook claims. Mismatch means
        // we found the order via notes.cafeOrderId but it's been linked to
        // a different Razorpay checkout, so this webhook isn't for this
        // order. Drop quietly.
        const linkedCheckouts = orderCheckoutIds(order);
        if (linkedCheckouts.length && rzpOrderId && !linkedCheckouts.includes(rzpOrderId)) {
            logger.warn('Webhook: Razorpay order_id mismatch with stored value — rejecting', {
                orderId: order.orderId,
                expected: order.razorpayOrderId,
                got: rzpOrderId,
                lookupPath,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // 4. Handle Events
        if (event === 'payment.captured' && order.paymentStatus !== 'Paid') {
            const capturedAmount = paiseToRupees(payment.amount);

            // Same coverage rule as verify-payment: an underpaid capture
            // (e.g. a stale checkout after items were added) must not
            // close the bill. Leave the order unpaid for staff to resolve.
            const cover = checkCaptureCoversDue({ order, amount: capturedAmount });
            if (!cover.ok) {
                logger.error('Webhook: captured amount does not cover the amount due — not settling order', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                    captured: capturedAmount,
                    total: order.total,
                    amountPaid: order.amountPaid,
                });
                if (await paymentState.markPaymentFailed(
                    { _id: order._id, ...(order.restaurant ? { restaurant: order.restaurant } : {}) },
                    { reason: 'AMOUNT_MISMATCH', reference: rzpOrderId || '', amount: capturedAmount },
                )) paymentState.emitBillingState(order);
                return res.status(200).json({ status: 'ok' });
            }

            // Bug #10 — a payment id settles at most one order. If it was
            // already claimed for something else, don't apply it here.
            const whClaim = await claimPayment(payment.id, {
                purpose: 'order_payment',
                ref: String(order._id),
                razorpayOrderId: rzpOrderId || null,
                restaurant: order.restaurant || null,
                user: order.user || null,
                amount: capturedAmount,
            });
            if (!whClaim.claimed) {
                logger.error('Webhook: payment already claimed elsewhere — not applying to order', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                    claimPurpose: whClaim.claim?.purpose,
                    claimRef: whClaim.claim?.ref,
                });
                return res.status(200).json({ status: 'ok' });
            }

            // Atomic Paid transition — a concurrent duplicate delivery (a
            // claim replay) or a racing verify-payment loses here and runs
            // no side effects. order.total is never rewritten.
            // Status stays 'new' on payment — chef decides when to start
            // cooking via the KDS.
            const paidOrder = await markOrderPaidAtomically(order, {
                paymentId: payment.id,
                razorpayOrderId: rzpOrderId || null,
                capturedAmount,
                priorPaid: cover.priorPaid,
                paidAt: payment.created_at ? new Date(payment.created_at * 1000) : null,
            });
            if (!paidOrder) {
                logger.info('Webhook: order already settled by a concurrent request — skipping side effects', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                });
                return res.status(200).json({ status: 'ok' });
            }
            // Captured after the order was cancelled: recorded + refund
            // request queued (markOrderPaidAtomically); no sale side effects.
            if (paidOrder.paidAfterCancel) {
                logger.warn('Webhook: capture on a cancelled order — refund request queued', {
                    paymentId: payment.id,
                    orderId: paidOrder.orderId,
                });
                return res.status(200).json({ status: 'ok' });
            }

            await awardLoyaltyPoints(paidOrder);

            // Webhook is the safety net when the user closed the tab
            // before verifyPayment ran. Without this call the tip on
            // those orders was never recorded. Idempotent.
            await createTipForPaidOrder(paidOrder, paidOrder.restaurant);

            // Aggregated dine-in bill — same as verifyPayment: this
            // capture covers every unpaid round on the table.
            await settleSiblingDineInRounds(paidOrder, 'online');

            // Mixed-cart checkout: the linked counter-side split doc(s).
            await settleSplitSiblings(paidOrder, 'online');

            // Same table-release path verifyPayment uses. Required here
            // too because the webhook is the only signal we get when the
            // customer's browser tab dies between paying and the verify
            // call landing — without it the table sits stuck at occupied.
            await freeTableIfReady(paidOrder);

            broadcastPaymentEvent(paidOrder, 'Payment Confirmed (Webhook)',
                `₹${paidOrder.amountPaid} payment verified for order ${paidOrder.orderId}`);

        } else if (event === 'payment.failed') {
            // Order.paymentStatus has no 'Failed' state. A failed attempt
            // leaves the order as it was (the customer can retry) — just
            // record it in the log.
            logger.info(`Webhook: Payment failed for order ${order.orderId}`, {
                paymentId: payment.id,
                paymentStatus: order.paymentStatus,
                errorCode: payment.error_code || null,
                errorDescription: payment.error_description || null,
            });
            // Phase 4: reflect it on the payment state block (never
            // downgrades an already-paid order).
            if (await paymentState.markPaymentFailed(
                // Reference-bound: a late failure for an older checkout must not
                // overwrite a newer pending attempt.
                { _id: order._id, ...(order.restaurant ? { restaurant: order.restaurant } : {}),
                    ...(payment.order_id ? { 'payment.reference': payment.order_id } : {}) },
                { reason: payment.error_code || 'payment.failed', reference: payment.order_id || '' },
            )) paymentState.emitBillingState(order);
            // A pay-first order held from the kitchen on an 'online'
            // promise (operations profile) now has a 15-minute retry
            // window before the sweeper may cancel it. No-op for every
            // other order (never held).
            try {
                const { noteOnlinePaymentFailed } = require('../services/orderHoldService');
                await noteOnlinePaymentFailed(order);
            } catch (holdErr) {
                logger.warn(`Webhook: could not stamp payment failure on held order ${order.orderId}: ${holdErr.message}`);
            }
        } else if (event === 'refund.processed') {
            const refundEntity = parsed.payload?.refund?.entity || null;
            // The refund's own amount — payload.payment.entity.amount is the
            // ORIGINAL capture and would turn every partial refund into a full one.
            const refundAmount = refundEntity ? paiseToRupees(refundEntity.amount) : 0;
            const refundId = refundEntity?.id || null;
            if (!(refundAmount > 0) || !refundId) {
                logger.warn('Webhook: refund.processed without a usable refund entity — ignoring', {
                    orderId: order.orderId,
                    refundId,
                });
                return res.json({ status: 'ok' });
            }
            // Atomic dedupe: the push + increment only applies when this
            // refund id is not yet recorded, so concurrent duplicate
            // deliveries (and refunds already recorded by the admin path)
            // count once.
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, 'refunds.razorpayRefundId': { $ne: refundId } },
                {
                    $inc: { refundedAmount: refundAmount },
                    $push: {
                        refunds: {
                            amount: refundAmount,
                            reason: refundEntity?.notes?.reason || 'Razorpay refund',
                            razorpayRefundId: refundId,
                            source: 'webhook',
                            createdAt: new Date(),
                        },
                    },
                },
                { returnDocument: 'after' }
            );
            if (updated) {
                // Round the running total to paise and flip to Refunded once
                // fully refunded. Conditional on the value we just produced,
                // so a concurrent refund's own pass handles the final state.
                const rounded = roundPaise(updated.refundedAmount);
                const set = { refundedAmount: rounded };
                if (updated.paymentStatus === 'Paid' && rounded >= roundPaise(updated.amountPaid)) {
                    set.paymentStatus = 'Refunded';
                }
                await Order.updateOne(
                    { _id: order._id, refundedAmount: updated.refundedAmount },
                    { $set: set }
                );
            }
            // Revoke still-pending tips so the waiter isn't settled for
            // a refunded transaction. Settled tips are left alone.
            await revokeTipsForOrder(order, { reason: 'razorpay refund webhook' });
            logger.info(`Webhook: refund.processed for order ${order.orderId}, amount ₹${refundAmount}${updated ? '' : ' (already recorded)'}`);
        }

        return res.json({ status: 'ok' });
    } catch (err) {
        logger.error('Webhook handler error:', { error: err.message });
        // Always return 200 to prevent Razorpay retries on our errors
        return res.json({ status: 'ok' });
    }
};

// ─── Subscription webhook handler ──────────────────────────────────────
//
// Handles the SaaS billing lifecycle events fired by Razorpay:
//
//   subscription.charged    — a recurring charge succeeded. Update the
//                             denormalised `currentPeriodEnd`, stamp
//                             `lastChargedAt`, and if the tenant was
//                             previously suspended for non-payment,
//                             automatically reactivate them.
//
//   subscription.halted     — Razorpay gave up retrying a failed charge.
//                             Suspend the tenant so their staff is
//                             locked out until they pay.
//
//   subscription.cancelled  — the customer (or Super Admin) cancelled.
//                             Mark status but DO NOT suspend — they may
//                             still have paid time remaining.
//
//   subscription.completed  — all billing cycles finished. Treat the
//                             same as cancelled.
//
//   subscription.pending / subscription.authenticated — just sync status.
//
// We never THROW out of the event handler — all paths return so the
// outer webhook handler can still respond 200 to Razorpay (Razorpay
// retries aggressively on non-200s and we don't want a DB hiccup to
// cause a retry storm).
// ADM-105 / ADM-106 — fallback-orders plan payment confirmation.
//
// When Razorpay's Subscriptions API is disabled on the merchant
// account, tenantBillingController.upgradePlan falls back to a
// one-time Razorpay Order stamped with notes.type === 'plan_payment'.
// That order has no matching cafe Order doc, so the generic
// payment.captured handler in handleWebhook would 404 it and skip
// applying the plan + creating an invoice — which is exactly the
// "invoice not generating even after payment" symptom in ADM-106.
//
// This handler:
//   1. Looks up the tenant from notes.restaurantId.
//   2. Applies the stashed pendingUpgrade — same path the
//      subscription.charged handler uses.
//   3. Creates a SubscriptionInvoice so /admin/subscription can show
//      the receipt and the user can download a PDF.
async function handlePlanPaymentCaptured(payment, parsed) {
    try {
        const notesRestaurantId = payment.notes?.restaurantId;
        if (!notesRestaurantId || !mongoose.Types.ObjectId.isValid(notesRestaurantId)) {
            logger.warn('plan-payment webhook: missing or invalid notes.restaurantId', {
                paymentId: payment.id,
                notes: payment.notes,
            });
            return;
        }

        const restaurant = await Restaurant.findById(notesRestaurantId);
        if (!restaurant) {
            logger.warn(`plan-payment webhook: no restaurant ${notesRestaurantId} for payment ${payment.id}`);
            return;
        }

        await applyPaidPlanUpgrade({
            restaurant,
            payment,
            logTag: 'plan-payment webhook',
        });
    } catch (err) {
        logger.error(`plan-payment webhook handler error: ${err.message}`);
    }
}

async function handleSubscriptionEvent(event, payload) {
    const sub = payload?.subscription?.entity;
    if (!sub) {
        logger.warn(`Webhook ${event}: no subscription entity in payload`);
        return;
    }

    const subscriptionId = sub.id;
    // Look up the restaurant by the LIVE subscriptionId or by the
    // pending upgrade's subscriptionId — for a fresh upgrade the
    // pending block holds the new sub id (the live field still points
    // at the old / empty sub).
    const restaurant = await Restaurant.findOne({
        $or: [
            { 'subscription.razorpaySubscriptionId': subscriptionId },
            { 'subscription.pendingUpgrade.razorpaySubscriptionId': subscriptionId },
        ],
    });
    if (!restaurant) {
        logger.warn(`Webhook ${event}: no restaurant matches subscription ${subscriptionId}`);
        return;
    }

    const previousStatus = restaurant.status;
    const previousRzpStatus = restaurant.subscription?.razorpayStatus;

    // Always sync the most recent Razorpay-reported status.
    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayStatus = sub.status || event.replace('subscription.', '');

    switch (event) {
        case 'subscription.charged': {
            // ADM-105 — first-charge confirmation. Apply the pending
            // plan upgrade now that the customer has actually paid.
            // Safe to call repeatedly (no-op once pendingUpgrade is
            // cleared, so retried webhooks don't double-apply).
            // The charge must actually pay for the pending plan (amount ≥
            // plan price, right order) — otherwise a cheaper charge would
            // unlock whatever plan is pending. Checked when Razorpay sends
            // the payment entity (it normally does on subscription.charged).
            const chargedPayment = payload?.payment?.entity || null;
            const upgradeMismatch = chargedPayment
                ? pendingPaymentMismatch(restaurant.subscription?.pendingUpgrade, chargedPayment)
                : '';
            let upgradeApplied = false;
            if (upgradeMismatch) {
                logger.error(`Subscription charged: payment ${chargedPayment.id} NOT applied to pending upgrade for ${restaurant.slug}: ${upgradeMismatch}`);
            } else {
                upgradeApplied = applyPendingUpgrade(restaurant);
            }
            if (upgradeApplied) {
                logger.info(`Subscription charged: applied pending upgrade for ${restaurant.slug} → ${restaurant.subscription.planName}`);
            }

            // `current_end` is a unix seconds timestamp of the next billing date.
            if (sub.current_end) {
                restaurant.subscription.currentPeriodEnd = new Date(sub.current_end * 1000);
            }
            restaurant.subscription.lastChargedAt = new Date();
            // If the tenant was previously suspended for non-payment
            // (razorpayStatus === 'halted'), auto-reactivate now that
            // the charge has gone through.
            // Also covers the 24h grace period (decision 5): a tenant still
            // `past_due` after a halt is restored, and the scheduled lockout
            // and halt counters are cleared.
            const inHaltGrace = restaurant.status === 'past_due' && previousRzpStatus === 'halted';
            const suspendedForHalt = restaurant.status === 'suspended' && previousRzpStatus === 'halted';
            if (inHaltGrace || suspendedForHalt) {
                restaurant.status = restaurant.subscription.trialEndDate && restaurant.subscription.trialEndDate > new Date()
                    ? 'trial'
                    : 'active';
                restaurant.suspendedAt = undefined;
                restaurant.suspendedReason = '';
            }
            restaurant.subscription.haltedCount = 0;
            restaurant.subscription.firstHaltedAt = undefined;
            restaurant.subscription.scheduledSuspendAt = undefined;
            logger.info(`Subscription charged for ${restaurant.slug}: next ${sub.current_end ? new Date(sub.current_end * 1000).toISOString() : 'n/a'}`);

            // Phase 5 step 5 — persist the charge as a
            // SubscriptionInvoice row so the tenant (and Super Admin)
            // can list / download it later as a PDF.
            //
            // Razorpay's subscription.charged payload includes BOTH
            // `payload.subscription.entity` (which we're already using
            // via `sub`) AND `payload.payment.entity` with the actual
            // charge details. We best-effort create the invoice here —
            // if it fails (missing payment entity, DB error, unique
            // collision from a retried webhook), we log and continue
            // without breaking the webhook response.
            try {
                const pmt = payload?.payment?.entity;
                if (pmt && pmt.id) {
                    // Per-day, per-tenant invoice counter. Cheap
                    // enough to just count existing rows for today —
                    // we're nowhere near scale where this would be a
                    // hotspot.
                    const startOfDay = new Date();
                    startOfDay.setHours(0, 0, 0, 0);
                    const todayCount = await SubscriptionInvoice.countDocuments({
                        restaurant: restaurant._id,
                        createdAt: { $gte: startOfDay },
                    });
                    // Local calendar date — the same basis as the local
                    // midnight `startOfDay` (toISOString() gave the UTC
                    // date, i.e. yesterday east of UTC).
                    const ymd = localYmd(startOfDay);

                    // Period end the charge paid for is the
                    // `sub.current_end` we just set. Period start is
                    // the previous period end if we have one on file
                    // (the old value of currentPeriodEnd before the
                    // update above — we kept it in `previousRzpStatus`
                    // case but not here; read it off the doc fresh).
                    // Fallback to sub.start_at or the charge time.
                    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
                    const periodStart = sub.start_at ? new Date(sub.start_at * 1000) : new Date();

                    // countDocuments + 1 races with a concurrent invoice for
                    // the same tenant/day: on an invoiceNumber E11000 take the
                    // next slot (bounded, same as applyPaidPlanUpgrade). A
                    // razorpayPaymentId E11000 falls through to the outer
                    // catch as the expected retried-webhook no-op.
                    let invoiceNumber = '';
                    let saved = null;
                    for (let attempt = 0, seq = todayCount + 1; attempt < 50 && !saved; attempt++, seq++) {
                        invoiceNumber = `INV-${ymd}-${String(seq).padStart(4, '0')}`;
                        try {
                            saved = await SubscriptionInvoice.create({
                                restaurant: restaurant._id,
                                restaurantName: restaurant.name,
                                invoiceNumber,
                                planName: restaurant.subscription?.planName || '',
                                planSlug: restaurant.subscription?.planSlug || '',
                                amount: pmt.amount || 0,
                                currency: pmt.currency || 'INR',
                                periodStart,
                                periodEnd,
                                razorpayPaymentId: pmt.id,
                                razorpaySubscriptionId: sub.id,
                                status: 'paid',
                                paidAt: pmt.created_at ? new Date(pmt.created_at * 1000) : new Date(),
                            });
                        } catch (insertErr) {
                            if (insertErr?.code === 11000 && /invoiceNumber/.test(insertErr.message || '')) {
                                logger.info(`SubscriptionInvoice number ${invoiceNumber} race-lost for ${restaurant.slug}, retrying`);
                                continue;
                            }
                            throw insertErr;
                        }
                    }
                    if (!saved) {
                        throw new Error(`Could not allocate a unique invoiceNumber after 50 attempts (tenant ${restaurant.slug})`);
                    }
                    logger.info(`SubscriptionInvoice created for ${restaurant.slug}: ${invoiceNumber}`);
                } else {
                    logger.warn(`subscription.charged for ${restaurant.slug} had no payment entity — skipping invoice creation`);
                }
            } catch (invoiceErr) {
                // E11000 on razorpayPaymentId unique index is the
                // expected no-op when Razorpay retries a webhook.
                // Anything else is unexpected and should be logged.
                if (invoiceErr?.code === 11000) {
                    logger.info(`SubscriptionInvoice already exists for payment ${payload?.payment?.entity?.id} — retry deduped`);
                } else {
                    logger.error(`SubscriptionInvoice create failed for ${restaurant.slug}: ${invoiceErr.message}`);
                }
            }
            break;
        }

        case 'subscription.halted': {
            // Decision 5 (2026-10, CRIT-18): no instant lockout. The tenant
            // goes `past_due` (still fully usable) and is suspended 24h
            // after the FIRST halt of this streak by
            // utils/haltedSubscriptionSuspender unless a charge lands first.
            // A redelivered / repeated halt never extends the deadline, and
            // a tenant already suspended for another reason stays suspended.
            const { scheduledSuspendAtFor } = require('../utils/haltedSubscriptionSuspender');
            const now = new Date();
            restaurant.subscription.haltedCount = (Number(restaurant.subscription.haltedCount) || 0) + 1;
            if (!restaurant.subscription.firstHaltedAt) restaurant.subscription.firstHaltedAt = now;
            if (!restaurant.subscription.scheduledSuspendAt) {
                restaurant.subscription.scheduledSuspendAt = scheduledSuspendAtFor(restaurant.subscription.firstHaltedAt);
            }
            if (restaurant.status !== 'suspended') restaurant.status = 'past_due';
            logger.warn(`Subscription halted for ${restaurant.slug} — past_due, suspension scheduled for ${restaurant.subscription.scheduledSuspendAt.toISOString()}`);
            break;
        }

        case 'subscription.cancelled':
        case 'subscription.completed': {
            // Don't auto-suspend. The tenant may still have paid access
            // until `currentPeriodEnd`. An operator can choose to
            // explicitly suspend via the Super Admin portal.
            restaurant.subscription.razorpayStatus = 'cancelled';
            logger.info(`Subscription ${event} for ${restaurant.slug} — keeping access until period end`);

            // ADM-106 follow-up — if this cancellation/completion was
            // driven by a scheduled downgrade (we cancelled with
            // cancel_at_cycle_end:true after approving a downgrade
            // request), apply the new plan now. `force: true` because
            // we trust the Razorpay event timing — Razorpay only
            // fires `completed` once the actual cycle has ended.
            if (event === 'subscription.completed' && restaurant.subscription?.scheduledDowngrade?.planSlug) {
                const result = applyScheduledDowngrade(restaurant, { force: true });
                if (result.applied) {
                    logger.info(`Scheduled downgrade applied for ${restaurant.slug} → ${restaurant.subscription.planName}`);
                }
            }
            break;
        }

        case 'subscription.pending':
        case 'subscription.authenticated':
        case 'subscription.activated':
            // Status already synced above — nothing extra to do.
            break;

        default:
            logger.info(`Webhook ${event} for ${restaurant.slug} — no action`);
    }

    await restaurant.save();
    // Status may have flipped (e.g. subscription.halted → suspended):
    // drop the cached tenant so the next request sees it immediately.
    invalidateTenant(restaurant._id);

    // Webhook events have no authenticated user — write a system audit
    // entry with `actor: null` and a synthetic origin tag so operators
    // can still trace what happened. Failure here must never break
    // webhook processing.
    try {
        await AuditLog.create({
            actor: null,
            actorEmail: 'razorpay-webhook',
            actorRole: 'system',
            action: event,
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                subscriptionId,
                razorpayStatus: restaurant.subscription.razorpayStatus,
                previousStatus,
                newStatus: restaurant.status,
            },
            userAgent: 'Razorpay-Webhook',
        });
    } catch (auditErr) {
        logger.warn(`Audit write failed for ${event}: ${auditErr.message}`);
    }

    // Phase 4 step 4 — fire alert emails AFTER the tenant has been
    // persisted and audited, so recipients see the final state. Both
    // notifiers are idempotent (cooldown window via the audit log) so
    // retried webhooks can't spam. Any failure is swallowed inside
    // utils/alerts.js — it must never break webhook processing.
    if (event === 'subscription.halted') {
        notifyTenantHalted(restaurant).catch(() => {});
    } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
        notifyTenantCancelled(restaurant).catch(() => {});
    }
}

// ─── POST /api/razorpay/refund ─────────────────────────────────────────────
// Processes a refund for a paid order. Supports full and partial refunds.
// - Online payments: refund via Razorpay API
// - Wallet payments: credit back to wallet
// - Cash payments: just marks order as refunded (manual cash handling)
//
// Request body: { orderId, amount, reason }
// Access: Admin only

exports.refundPayment = async (req, res) => {
    try {
        const { orderId, amount, reason } = req.body;

        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Order ID is required' });
        }
        // Validate amount — required, must be a positive finite number
        if (amount === undefined || amount === null || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Refund amount is required and must be a positive number' });
        }

        const tf = tenantFilter(req);
        let order = mongoose.Types.ObjectId.isValid(orderId)
            ? await Order.findOne({ _id: orderId, ...tf })
            : null;
        if (!order) order = await Order.findOne({ orderId, ...tf });

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (order.paymentStatus !== 'Paid') {
            return res.status(400).json({ success: false, message: 'Only paid orders can be refunded' });
        }

        // Paise-rounded so an exact remainder is never lost to float drift.
        const refundAmount = roundPaise(amount);
        const alreadyRefunded = roundPaise(order.refundedAmount);
        const maxRefundable = roundPaise(order.amountPaid - alreadyRefunded);

        if (refundAmount <= 0 || refundAmount > maxRefundable) {
            return res.status(400).json({
                success: false,
                message: `Refund amount must be between ₹1 and ₹${maxRefundable}`
            });
        }

        let razorpayRefundId = null;

        // ── Process refund based on settings and payment method (per-tenant) ──
        const settings = await getSettings(req);
        const loyalty = resolveLoyaltySettings(settings);
        const refundMode = loyalty.refundMode;
        const walletRefund = !!order.user && (isWalletPaid(order) || refundMode === 'wallet');

        // Step 1: External API call (Razorpay) — must happen OUTSIDE the DB session
        //         because we can't roll back an external API call.
        if (order.paymentMethod === 'online' && order.razorpayPaymentId && refundMode === 'original') {
            try {
                // SDK 2.9.x: refunds go through payments.refund(); there is
                // no refunds.create.
                const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
                    amount: Math.round(refundAmount * 100),
                    notes: { reason: reason || 'Refund', orderId: order.orderId },
                });
                razorpayRefundId = refund.id;
                logger.info(`Razorpay refund initiated: ${razorpayRefundId} for ₹${refundAmount}`);
            } catch (rzpErr) {
                logger.error('Razorpay API Refund Error:', describeRazorpayError(rzpErr));
                return res.status(400).json({
                    success: false,
                    message: 'Refund could not be processed via payment gateway. Please try again or contact support.'
                });
            }
        } else if (order.paymentMethod === 'online' && !order.razorpayPaymentId) {
            return res.status(400).json({ success: false, message: 'Online payment record has no transaction ID to refund' });
        } else if (walletRefund && !order.restaurant) {
            return res.status(400).json({ success: false, message: 'Cannot process wallet refund — order has no restaurant context' });
        }

        // Step 2: All DB writes in a transaction session for atomicity.
        //         If any write fails, everything rolls back.
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                // ── Update order ──────────────────────────────────────────
                order.refundedAmount = roundPaise(alreadyRefunded + refundAmount);
                order.paymentStatus = order.refundedAmount >= order.amountPaid ? 'Refunded' : 'Paid';
                order.refunds = order.refunds || [];
                order.refunds.push({
                    amount: refundAmount,
                    reason: reason || '',
                    razorpayRefundId: razorpayRefundId || null,
                    actor: req.user?._id || req.user?.id || null,
                    actorName: req.user?.name || '',
                    source: 'admin',
                    createdAt: new Date(),
                });
                await order.save({ session });

                // ── Credit wallet if wallet refund ────────────────────────
                if (walletRefund) {
                    const walletScope = { user: order.user, restaurant: order.restaurant };
                    await Wallet.findOneAndUpdate(
                        walletScope,
                        { $inc: { balance: refundAmount }, $setOnInsert: { restaurant: order.restaurant } },
                        { upsert: true, returnDocument: 'after', session }
                    );
                    logger.info(`Wallet refund credited: ₹${refundAmount} to user ${order.user}`);
                }

                // ── Deduct loyalty points proportionally ──────────────────
                if (order.user) {
                    // Only a share of what THIS order earned.
                    const pointsToDeduct = await loyaltyPointsToClawBack(order, refundAmount, loyalty, session);
                    if (pointsToDeduct > 0) {
                        await Wallet.findOneAndUpdate(
                            { user: order.user, loyaltyPoints: { $gte: pointsToDeduct }, ...tf },
                            { $inc: { loyaltyPoints: -pointsToDeduct } },
                            { session }
                        );
                    }
                }

                // ── Record transaction ────────────────────────────────────
                if (order.user) {
                    const wallet = await Wallet.findOne({ user: order.user, ...tf }).session(session);
                    const currentBalance = wallet ? wallet.balance : 0;
                    const balanceBefore = walletRefund ? roundPaise(currentBalance - refundAmount) : currentBalance;

                    await Transaction.create([{
                        user: order.user,
                        restaurant: order.restaurant || tenantId(req),
                        order: order._id,
                        type: 'refund',
                        amount: refundAmount,
                        paymentMethod: ledgerPaymentMethod(order.paymentMethod),
                        status: 'completed',
                        description: `Refund of ₹${refundAmount} for order ${order.orderId}: ${reason || 'No reason'}`,
                        transactionId: idGen.transactionId(),
                        balanceBefore,
                        balanceAfter: currentBalance,
                    }], { session });
                }
            });
        } finally {
            await session.endSession();
        }

        // Revoke still-pending tips so the waiter isn't settled for a
        // refunded transaction. Settled tips are left alone.
        await revokeTipsForOrder(order, { reason: `admin refund: ${reason || 'no reason'}` });

        // Step 3: Notifications — outside the session (non-critical, best-effort)
        const notifTenant = order.restaurant || tenantId(req);
        // Persist only — the live events go out via broadcastPaymentEvent.
        await notify({
            restaurant: notifTenant,
            branch: order.branch || null,
            notification: {
                recipientRole: 'admin',
                title: 'Refund Processed',
                description: `₹${refundAmount} refunded for order ${order.orderId}`,
                category: 'Payment',
                priority: 'medium',
                meta: { orderId: order.orderId, amount: refundAmount },
            },
        });

        if (order.user) {
            await notify({
                restaurant: notifTenant,
                branch: null,
                notification: {
                    recipient: order.user,
                    recipientRole: 'customer',
                    title: 'Refund Processed',
                    description: `₹${refundAmount} has been refunded to your ${walletRefund ? 'wallet' : 'original payment method'}.`,
                    category: 'Wallet',
                    priority: 'medium',
                    meta: { orderId: order.orderId, amount: refundAmount },
                },
            });
        }

        broadcastPaymentEvent(order, 'Refund Processed',
            `₹${refundAmount} refunded for ${order.orderId}. Mode: ${refundMode}`);

        return res.status(200).json({
            success: true,
            message: `₹${refundAmount} refunded successfully`,
            refundedAmount: order.refundedAmount,
            razorpayRefundId,
        });
    } catch (err) {
        logger.error('Refund error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to process refund' });
    }
};

// ─── POST /api/razorpay/orphan-refund ──────────────────────────────────────
// Refund a Razorpay payment that was captured but for which no cafe Order
// document exists (because order creation failed AFTER charge — typically
// a stock shortage, total tampering check, or coupon expiry that fires
// inside POST /orders). Without this endpoint the customer is left with a
// charge on their card and no order, and our prior UX told them to copy a
// raw Razorpay payment_id and email it to support.
//
// Flow:
//   1. Verify the payment belongs to the caller's tenant via the
//      `notes.restaurantId` we stamped in createRazorpayOrder.
//   2. Verify it was captured and isn't already refunded.
//   3. Issue a full refund through Razorpay.
//   4. Notify admin (high-priority Payment notification + socket push)
//      so staff know to investigate the underlying cause (stock, etc.).
//
// Body: { razorpay_payment_id, reason? }
// Access: optionalAuth — guests on QR scan need this path too.
exports.refundOrphanPayment = async (req, res) => {
    try {
        const { razorpay_payment_id, reason } = req.body;
        if (!razorpay_payment_id || typeof razorpay_payment_id !== 'string') {
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_ID_REQUIRED',
                message: 'Payment id is required',
            });
        }

        const tenant = tenantId(req);
        if (!tenant) {
            return res.status(400).json({
                success: false,
                code: 'TENANT_REQUIRED',
                message: 'Restaurant context is required to issue a refund.',
            });
        }

        // Pull the payment AND its Razorpay order so we can (a) confirm
        // tenancy + payer via the server-set notes we stamped at
        // create-order time, and (b) read the captured amount + any prior
        // refunds. Both are needed to bound the refund and stop
        // double-refunds on retry.
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, null));
        } catch (fetchErr) {
            logger.warn('Orphan-refund: failed to fetch payment from Razorpay', {
                payment_id: razorpay_payment_id,
                error: fetchErr.message,
            });
            return res.status(404).json({
                success: false,
                code: 'PAYMENT_NOT_FOUND',
                message: 'Payment record could not be located.',
            });
        }

        // Bug #4 — the caller must prove the payment is theirs: a valid
        // checkout signature (only the paying browser has it), or the
        // payer identity stamped in the order notes (logged-in user id /
        // verified guest scan session). Also: same tenant, a cafe-order
        // checkout that was never bound to an order, and recent.
        const { razorpay_order_id: bodyOrderId, razorpay_signature: bodySignature } = req.body || {};
        const signatureValid = !!(bodyOrderId && bodySignature
            && payment?.order_id === bodyOrderId
            && isValidCheckoutSignature({
                razorpayOrderId: bodyOrderId,
                razorpayPaymentId: razorpay_payment_id,
                signature: bodySignature,
                secret: process.env.RAZORPAY_KEY_SECRET,
            }));
        const eligibility = checkOrphanRefundEligibility({
            payment,
            rzpOrder,
            tenant,
            caller: {
                userId: req.user?._id || req.user?.id || null,
                scanSessionId: verifiedScanSessionId(req),
            },
            signatureValid,
        });
        if (!eligibility.ok) {
            logger.warn('Orphan-refund: refused', {
                payment_id: razorpay_payment_id,
                code: eligibility.code,
                tenant: String(tenant),
            });
            return res.status(eligibility.status).json({
                success: false,
                code: eligibility.code,
                message: eligibility.message,
            });
        }

        if (payment.status !== 'captured') {
            // 'authorized' / 'created' / 'failed' / 'refunded' — only a
            // captured payment is refundable. If it's already refunded
            // (status 'refunded'), we still return success so the client
            // can show its "refund underway" message idempotently.
            if (payment.status === 'refunded' || (payment.amount_refunded || 0) >= payment.amount) {
                return res.status(200).json({
                    success: true,
                    alreadyRefunded: true,
                    refundedAmount: (payment.amount_refunded || payment.amount) / 100,
                });
            }
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_NOT_REFUNDABLE',
                message: `Payment is in '${payment.status}' state and cannot be refunded.`,
            });
        }

        const refundableAmount = Math.max(0, (payment.amount || 0) - (payment.amount_refunded || 0));
        if (refundableAmount <= 0) {
            return res.status(200).json({
                success: true,
                alreadyRefunded: true,
                refundedAmount: (payment.amount_refunded || 0) / 100,
            });
        }

        // Bug #4 — an "orphan" must really be an orphan: refuse if ANY
        // order, wallet transaction, advance booking or payment claim
        // references this payment (or its Razorpay order). Otherwise a
        // customer could pay, eat, and refund themselves.
        const rzpOrderId = payment.order_id || null;
        const orderRefs = [{ razorpayPaymentId: razorpay_payment_id }];
        if (rzpOrderId) {
            orderRefs.push({ razorpayOrderId: rzpOrderId });
            orderRefs.push({ razorpayOrderIds: rzpOrderId });
        }
        const bookingRefs = [{ 'payment.razorpayPaymentId': razorpay_payment_id }];
        if (rzpOrderId) {
            bookingRefs.push({ 'payment.razorpayOrderId': rzpOrderId });
            bookingRefs.push({ 'payment.remainingRazorpayOrderId': rzpOrderId });
        }
        const txnRefs = [{ razorpayPaymentId: razorpay_payment_id }];
        if (rzpOrderId) txnRefs.push({ razorpayOrderId: rzpOrderId });
        const [orderRef, txnRef, bookingRef, existingClaim] = await Promise.all([
            Order.exists({ $or: orderRefs }),
            Transaction.exists({ $or: txnRefs }),
            AdvanceBooking.exists({ $or: bookingRefs }),
            findClaim(razorpay_payment_id),
        ]);
        if (orderRef || txnRef || bookingRef || (existingClaim && existingClaim.purpose !== 'orphan_refund')) {
            logger.warn('Orphan-refund: payment is referenced — refusing', {
                payment_id: razorpay_payment_id,
                order: !!orderRef, transaction: !!txnRef, booking: !!bookingRef,
                claim: existingClaim?.purpose || null,
            });
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_IN_USE',
                message: 'This payment is linked to an order or booking. Please contact staff.',
            });
        }
        // Claim the payment for the refund so a concurrent verify /
        // booking / recharge can't spend it while the refund is in flight.
        const refundClaim = await claimPayment(razorpay_payment_id, {
            purpose: 'orphan_refund',
            ref: razorpay_payment_id,
            razorpayOrderId: rzpOrderId,
            restaurant: tenant,
            user: req.user?._id || null,
            amount: refundableAmount / 100,
        });
        if (!refundClaim.claimed) {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_IN_USE',
                message: 'This payment is linked to an order or booking. Please contact staff.',
            });
        }

        // Issue the refund. Notes carry our reason + tenant + the
        // friendlier user-supplied cause so the audit log on the
        // Razorpay dashboard reads like a story instead of a guid.
        let refund;
        try {
            refund = await razorpay.payments.refund(razorpay_payment_id, {
                amount: refundableAmount, // paise
                notes: {
                    type: 'orphan_refund',
                    reason: String(reason || 'Order creation failed after payment'),
                    restaurantId: String(tenant),
                },
            });
        } catch (rzpErr) {
            await releaseClaim(razorpay_payment_id, { purpose: 'orphan_refund', ref: razorpay_payment_id });
            logger.error('Orphan-refund: Razorpay refund call failed', {
                payment_id: razorpay_payment_id,
                error: rzpErr.message,
                description: rzpErr.description,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_REFUND_FAILED',
                message: 'Refund could not be processed via the payment gateway. Please contact support.',
            });
        }

        const refundedRupees = refundableAmount / 100;

        // Admin notification — high priority, Payment category, so the
        // alert surfaces in the existing admin notification stream. The
        // staff need to investigate WHY the order failed (out-of-stock,
        // mispriced item, tampered total) so the next customer doesn't
        // hit the same dead end. Wrapped so notification failure can't
        // hide the refund success from the customer.
        await notify({
            restaurant: tenant,
            branch: req.branch?._id || null,
            audience: 'admin',
            notification: {
                recipient: null,                 // tenant-wide admin alert
                recipientRole: 'admin',
                category: 'Payment',
                priority: 'high',
                title: 'Order failed after payment — auto-refund issued',
                description:
                    `A customer was charged ₹${refundedRupees.toFixed(2)} but the order could not be saved` +
                    `${reason ? ` (${reason})` : ''}. Razorpay refund initiated automatically. ` +
                    'Check inventory / pricing — the next customer will hit the same block.',
                meta: {
                    amount: refundedRupees,
                    orderId: refund.id,         // refund id stands in for orderId in the meta slot
                },
            },
            payload: {
                title: 'Order failed after payment',
                description: `₹${refundedRupees.toFixed(2)} auto-refunded. Investigate cause.`,
                category: 'Payment',
                priority: 'high',
            },
        });

        logger.info('Orphan-refund issued', {
            payment_id: razorpay_payment_id,
            refund_id: refund.id,
            amount: refundedRupees,
            tenant: String(tenant),
            reason: reason || '(none)',
        });

        return res.status(200).json({
            success: true,
            refundedAmount: refundedRupees,
            refundId: refund.id,
        });
    } catch (err) {
        logger.error('Orphan-refund error:', { error: err.message, stack: err.stack });
        return res.status(500).json({
            success: false,
            code: 'REFUND_FAILED',
            message: 'We could not start the automatic refund. Please contact support.',
        });
    }
};

// ─── POST /api/razorpay/create-wallet-recharge ─────────────────────────────
// Creates a Razorpay order for wallet recharge (adding money to wallet).
// Similar to create-order but with purpose = 'wallet_recharge'.
//
// Request body: { amount }
// Access: Authenticated users

exports.createWalletRechargeOrder = async (req, res) => {
    try {
        const { amount } = req.body;

        // Razorpay refuses orders under 100 paise — reject before the gateway.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1) {
            return res.status(400).json({ success: false, message: 'Amount must be at least ₹1' });
        }
        if (amount > 10000) {
            return res.status(400).json({ success: false, message: 'Maximum recharge amount is ₹10,000' });
        }

        const userId = String(req.user.id || req.user._id);
        // Razorpay caps `receipt` at 40 chars. A 24-char Mongo ObjectId +
        // the wrc_/_/Date.now() scaffolding overflowed to 42, so every
        // wallet top-up failed with BAD_REQUEST_ERROR. Keep the last 6
        // hex chars of the user id for traceability and use base36 time
        // so the whole string fits in ~22 chars.
        const shortUid = userId.slice(-6);
        const shortTs = Date.now().toString(36);
        const options = {
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `wrc_${shortUid}_${shortTs}`,
            // Bug #3 — verifyWalletRecharge only credits payments whose
            // server-set order notes carry this purpose + the SAME user
            // (+ tenant), so these notes are the binding contract.
            notes: {
                purpose: 'wallet_recharge',
                userId,
                ...(tenantId(req) ? { restaurantId: String(tenantId(req)) } : {}),
            },
        };

        const razorpayOrder = await razorpay.orders.create(options);
        logger.info(`Wallet recharge order created: amount=₹${amount}, userId=${userId}, rzpOrderId=${razorpayOrder.id}`);

        return res.status(200).json({
            success: true,
            razorpayOrder: {
                id: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                receipt: razorpayOrder.receipt,
            },
            key: process.env.RAZORPAY_KEY_ID,
        });
    } catch (err) {
        // Razorpay client throws a structured error — surface as much
        // of it as possible so we can debug "Failed to create recharge
        // order" instead of guessing at .env / key issues.
        logger.error(`Wallet recharge order error: ${err?.message || err} | statusCode=${err?.statusCode} | desc=${err?.error?.description || ''} | code=${err?.error?.code || ''}`);
        return res.status(500).json({ success: false, message: 'Failed to create recharge order' });
    }
};

// ─── POST /api/razorpay/verify-wallet-recharge ─────────────────────────────
// Verifies a Razorpay payment for wallet recharge and credits the wallet.
//
// Request body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount }
// Access: Authenticated users

exports.verifyWalletRecharge = async (req, res) => {
    try {
        // `amount` from the body is accepted for back-compat but IGNORED
        // for crediting (bug #3): the credit is what Razorpay settled.
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Payment details are required' });
        }

        // ── Signature verification ───────────────────────────────────────
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (!safeEqual(expectedSignature, razorpay_signature)) {
            return res.status(400).json({ success: false, message: 'Payment verification failed' });
        }

        const userId = String(req.user.id || req.user._id);
        const tf = tenantFilter(req);

        // ── Bug #3: server-side truth from Razorpay (fail closed) ────────
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, razorpay_order_id));
        } catch (fetchErr) {
            logger.error('Wallet recharge verify: Razorpay fetch failed', {
                razorpay_payment_id,
                error: fetchErr.message,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_UNAVAILABLE',
                message: 'Could not confirm the payment with the gateway. Please try again in a moment.',
            });
        }

        const check = checkWalletRechargePayment({
            payment,
            rzpOrder,
            razorpayOrderId: razorpay_order_id,
            userId,
            tenant: tenantId(req),
        });
        if (!check.ok) {
            logger.warn('Wallet recharge verify rejected', { code: check.code, userId, razorpay_payment_id });
            return res.status(check.status).json({ success: false, code: check.code, message: check.message });
        }
        const amount = check.amount;

        // ── Single-use payment id ────────────────────────────────────────
        const claim = await claimPayment(razorpay_payment_id, {
            purpose: 'wallet_recharge',
            ref: userId,
            razorpayOrderId: razorpay_order_id,
            restaurant: tenantId(req) || null,
            user: userId,
            amount,
        });
        if (!claim.claimed) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
        }
        if (claim.replay) {
            // Same user retrying the same recharge. The claim is only kept
            // once the wallet was credited (it is released on a failed
            // credit), so a replay must never credit again.
            const already = await Transaction.findOne({ razorpayPaymentId: razorpay_payment_id }).lean();
            const current = await Wallet.findOne({ user: userId, ...tf }).select('balance').lean();
            return res.status(200).json({
                success: true,
                alreadyCredited: true,
                message: `₹${already ? already.amount : amount} added to wallet`,
                newBalance: current ? current.balance : (already ? already.balanceAfter : 0),
            });
        }

        // ── Credit wallet (per-tenant, atomic) ────────────────────────────
        let wallet;
        try {
            wallet = await Wallet.findOneAndUpdate(
                { user: userId, ...tf },
                { $inc: { balance: amount }, $setOnInsert: { loyaltyPoints: 0, restaurant: tenantId(req) } },
                { upsert: true, returnDocument: 'after' }
            );
        } catch (walletErr) {
            await releaseClaim(razorpay_payment_id, { purpose: 'wallet_recharge', ref: userId });
            throw walletErr;
        }
        const balanceBefore = Math.round((wallet.balance - amount) * 100) / 100;

        // ── Record transaction ───────────────────────────────────────────
        // The partial unique index on Transaction.razorpayPaymentId is the
        // second line of defence against a double credit.
        try {
            await Transaction.create({
                user: userId,
                restaurant: tenantId(req),
                type: 'wallet_recharge',
                amount: amount,
                currency: 'INR',
                paymentMethod: 'upi',
                status: 'completed',
                description: `Wallet recharge of ₹${amount}`,
                transactionId: idGen.transactionId(),
                balanceBefore,
                balanceAfter: wallet.balance,
                razorpayPaymentId: razorpay_payment_id,
                razorpayOrderId: razorpay_order_id,
            });
        } catch (txnErr) {
            if (txnErr?.code === 11000 && /razorpayPaymentId/.test(String(txnErr.message))) {
                // Lost a race with a concurrent credit of the same payment —
                // undo our increment.
                await Wallet.findOneAndUpdate({ user: userId, ...tf }, { $inc: { balance: -amount } });
                const current = await Wallet.findOne({ user: userId, ...tf }).select('balance').lean();
                return res.status(200).json({
                    success: true,
                    alreadyCredited: true,
                    message: `₹${amount} added to wallet`,
                    newBalance: current ? current.balance : wallet.balance - amount,
                });
            }
            logger.error('Wallet recharge: transaction record failed (wallet already credited)', {
                userId, razorpay_payment_id, amount, error: txnErr.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: `₹${amount} added to wallet`,
            newBalance: wallet.balance,
        });
    } catch (err) {
        logger.error('Wallet recharge verify error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to verify wallet recharge' });
    }
};

// ─── GET /api/razorpay/reconcile ───────────────────────────────────────────
// Finds orders stuck in 'Pending' for too long and checks Razorpay for the
// actual payment status. Auto-updates orders if payment was captured.
//
// Access: Admin only

// Payments across EVERY checkout opened for the order (decision 4a) —
// a capture on an older checkout is recovered too.
async function fetchOrderCheckoutPayments(order) {
    const items = [];
    for (const id of orderCheckoutIds(order)) {
        const res = await razorpay.orders.fetchPayments(id);
        for (const p of res?.items || []) items.push({ ...p, order_id: p.order_id || id });
    }
    return { items };
}

// Apply one captured payment found by reconciliation. Same rules as
// verify-payment / the webhook: the capture must cover what is due, the
// payment id is claimed once, and the Paid transition is atomic.
async function settleReconciledCapture(order, captured) {
    const capturedAmount = paiseToRupees(captured.amount);
    const cover = checkCaptureCoversDue({ order, amount: capturedAmount });
    if (!cover.ok) {
        return { status: 'underpaid', amount: capturedAmount };
    }
    const reconClaim = await claimPayment(captured.id, {
        purpose: 'order_payment',
        ref: String(order._id),
        razorpayOrderId: captured.order_id || order.razorpayOrderId,
        restaurant: order.restaurant || null,
        user: order.user || null,
        amount: capturedAmount,
    });
    if (!reconClaim.claimed) {
        return { status: 'payment_used_elsewhere' };
    }
    // Status stays as-is — chef owns the new→preparing transition.
    const paidOrder = await markOrderPaidAtomically(order, {
        paymentId: captured.id,
        razorpayOrderId: captured.order_id || order.razorpayOrderId,
        capturedAmount,
        priorPaid: cover.priorPaid,
        paidAt: captured.created_at ? new Date(captured.created_at * 1000) : null,
    });
    if (!paidOrder) {
        return { status: 'already_settled' };
    }
    // Captured after the order was cancelled: recorded + refund request
    // queued (markOrderPaidAtomically); no sale side effects.
    if (paidOrder.paidAfterCancel) {
        return { status: 'cancelled_refund_requested', amount: paidOrder.amountPaid };
    }
    await awardLoyaltyPoints(paidOrder);
    await settleSplitSiblings(paidOrder, 'online');
    // Settled → free the dine-in table (no-op while another order on it
    // is unpaid).
    await freeTableIfReady(paidOrder);
    return { status: 'recovered', amount: paidOrder.amountPaid };
}

exports.reconcilePayments = async (req, res) => {
    try {
        const staleMinutes = Math.max(1, Math.min(1440, parseInt(req.query.minutes) || 30));
        const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

        // Admin-triggered reconciliation — scoped to tenant.
        const staleOrders = await Order.find({
            paymentStatus: 'Pending',
            razorpayOrderId: { $exists: true, $ne: null },
            createdAt: { $lt: cutoff },
            ...tenantFilter(req),
        });

        const results = [];

        for (const order of staleOrders) {
            try {
                // Fetch payments for this Razorpay order
                const payments = await fetchOrderCheckoutPayments(order);
                const captured = payments.items?.find(p => p.status === 'captured');
                const outcome = captured ? await settleReconciledCapture(order, captured) : { status: 'still_pending' };
                results.push({ orderId: order.orderId, ...outcome });
                if (outcome.status === 'recovered') {
                    logger.info(`Reconciled: order ${order.orderId} marked as Paid`);
                }
            } catch (fetchErr) {
                results.push({ orderId: order.orderId, status: 'error', error: fetchErr.message });
                logger.warn(`Reconcile error for ${order.orderId}:`, { error: fetchErr.message });
            }
        }

        return res.status(200).json({
            success: true,
            checked: staleOrders.length,
            results,
        });
    } catch (err) {
        logger.error('Reconciliation error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Reconciliation failed' });
    }
};

// ─── Scheduled reconciliation (runs every 30 minutes) ──────────────────────
// Called from server.js via setInterval. Not an HTTP handler.

exports.runScheduledReconciliation = async () => {
    try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);

        // Scope by restaurant to respect tenant isolation and use per-tenant Razorpay keys if needed.
        const restaurants = await Restaurant.find({ status: { $in: ['active', 'trial'] } }).select('_id slug').lean();

        let totalChecked = 0;
        for (const restaurant of restaurants) {
            try {
                const staleOrders = await Order.find({
                    restaurant: restaurant._id,
                    paymentStatus: 'Pending',
                    razorpayOrderId: { $exists: true, $ne: null },
                    createdAt: { $lt: cutoff },
                });

                for (const order of staleOrders) {
                    try {
                        const payments = await fetchOrderCheckoutPayments(order);
                        const captured = payments.items?.find(p => p.status === 'captured');
                        if (!captured) continue;
                        const outcome = await settleReconciledCapture(order, captured);
                        if (outcome.status === 'payment_used_elsewhere') {
                            logger.warn(`Auto-reconcile: payment ${captured.id} already claimed elsewhere — skipping ${order.orderId}`);
                        } else if (outcome.status === 'underpaid') {
                            logger.warn(`Auto-reconcile: payment ${captured.id} (₹${outcome.amount}) does not cover ${order.orderId} — left unpaid`);
                        } else if (outcome.status === 'recovered') {
                            logger.info(`Auto-reconciled: order ${order.orderId} (${restaurant.slug}) marked as Paid`);
                        }
                    } catch (fetchErr) {
                        logger.warn(`Auto-reconcile error for ${order.orderId}:`, describeRazorpayError(fetchErr));
                    }
                }
                totalChecked += staleOrders.length;
            } catch (restaurantErr) {
                logger.warn(`Reconciliation error for restaurant ${restaurant.slug}:`, { error: restaurantErr.message });
            }
        }

        if (totalChecked > 0) {
            logger.info(`Reconciliation complete: checked ${totalChecked} stale orders across ${restaurants.length} restaurants`);
        }
    } catch (err) {
        logger.error('Scheduled reconciliation error:', { error: err.message });
    }
};

/**
 * Held-order sweeper seam (services/orderHoldService.cancelExpiredHolds):
 * before an ONLINE hold is cancelled, look for a capture on any checkout
 * opened for the order and, if there is one, settle it exactly as
 * reconciliation does (claim → Paid → releaseHeldOrder). Returns
 * { status: 'none' } when Razorpay knows no captured payment, otherwise
 * settleReconciledCapture's outcome ('recovered', 'already_settled',
 * 'underpaid', 'payment_used_elsewhere', 'cancelled_refund_requested').
 * Throws when the gateway cannot be reached — the caller keeps the hold.
 */
exports.recoverCapturedPaymentForOrder = async (order) => {
    if (!order) return { status: 'none' };
    if (!orderCheckoutIds(order).length) return { status: 'none' };
    const payments = await fetchOrderCheckoutPayments(order);
    const captured = payments.items?.find(p => p.status === 'captured');
    if (!captured) return { status: 'none' };
    return settleReconciledCapture(order, captured);
};

// Test seam: sibling settlement helpers (heldOrderAudit.test.js).
exports._settleSplitSiblings = settleSplitSiblings;
exports._settleSiblingDineInRounds = settleSiblingDineInRounds;
