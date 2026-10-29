// Order payment: create-order, verify-payment and the create-order checkout check.

const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../../models/order');
const logger = require('../../utils/logger');
const paymentState = require('../../utils/paymentState');
const rzpMock = require('../../utils/razorpayMock');
const { notify } = require('../../services/notificationService');
const { tenantFilter, tenantId } = require('../../utils/tenantScope');
const { createTipForPaidOrder } = require('../../utils/tipHelpers');
const { checkOrderPaymentBinding, orderAmountDue, isValidCheckoutSignature } = require('../../utils/paymentChecks');
const { claimPayment, releaseClaim } = require('../../utils/paymentClaim');
const { describeRazorpayError } = require('../../utils/razorpayErrors');
const {
    verifiedScanSessionId,
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
} = require('./_shared');

// ─── POST /api/razorpay/create-order ────────────────────────────────────────
// Creates a Razorpay order for the given amount. The frontend uses this
// orderId to open the Razorpay checkout modal.
//
// Request body: { amount (in ₹), cafeOrderId (our Order _id), receipt? }
// Response:     { success, razorpayOrder }


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
