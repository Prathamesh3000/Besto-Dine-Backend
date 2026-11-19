// Refunds: admin order refund and guest orphan-payment refund.

const mongoose = require('mongoose');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const Transaction = require('../../models/transaction');
const logger = require('../../utils/logger');
const idGen = require('../../utils/idGenerator');
const AdvanceBooking = require('../../models/advanceBooking');
const { notify } = require('../../services/notificationService');
const { getSettings } = require('../../utils/settingsCache');
const { tenantFilter, tenantId, strictBranchFilter } = require('../../utils/tenantScope');
const { resolveLoyaltySettings } = require('../../utils/paymentDefaults');
const { revokeTipsForOrder } = require('../../utils/tipHelpers');
const { checkOrphanRefundEligibility, isValidCheckoutSignature } = require('../../utils/paymentChecks');
const { claimPayment, releaseClaim, findClaim } = require('../../utils/paymentClaim');
const { roundPaise, processOrderRefund } = require('../../utils/orderRefund');
const { describeRazorpayError } = require('../../utils/razorpayErrors');
const {
    verifiedScanSessionId,
    fetchPaymentAndOrder,
    razorpay,
    broadcastPaymentEvent,
} = require('./_shared');

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
        const { orderId, amount } = req.body;
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Order ID is required' });
        }
        if (!reason) {
            return res.status(400).json({ success: false, code: 'REASON_REQUIRED', message: 'A refund reason is required' });
        }
        // Validate amount — required, must be a positive finite number
        if (amount === undefined || amount === null || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Refund amount is required and must be a positive number' });
        }

        // Tenant + branch scope: a branch-pinned admin only refunds orders of
        // their own branch (same rule as approving a refund request).
        const tf = { ...tenantFilter(req), ...strictBranchFilter(req) };
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

        // ── Process refund based on settings and payment method (per-tenant) ──
        // The shared helper reserves the amount atomically, calls the gateway
        // for the online leg, credits the wallet for the wallet leg, and
        // records the refund (with its destination) on the order.
        const settings = await getSettings(req);
        const loyalty = resolveLoyaltySettings(settings);
        const refundMode = loyalty.refundMode;
        const beforeStatus = order.paymentStatus;
        const result = await processOrderRefund(order, {
            amount: refundAmount,
            reason,
            settings,
            tenantId: tenantId(req),
            actor: { _id: req.user?._id || req.user?.id || null, name: req.user?.name || '' },
            source: 'admin',
        });
        if (!result.success) {
            const message = result.code === 'GATEWAY_FAILED'
                ? 'Refund could not be processed via payment gateway. Please try again or contact support.'
                : result.code === 'NO_PAYMENT_ID'
                    ? 'Online payment record has no transaction ID to refund'
                    : (result.error || 'Refund could not be processed');
            return res.status(result.status || 400).json({ success: false, message });
        }
        const razorpayRefundId = result.razorpayRefundId || null;
        // A full refund gives the coupon use back (once, whichever terminal path got there first).
        if (order.paymentStatus === 'Refunded') {
            try { await require('../../services/orderCancelReversal').releaseCouponUseOnce(order); } catch { /* never fails the refund */ }
        }
        const walletRefund = (result.legs || []).some((l) => l.destination === 'wallet');

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
        require('../../services/tenantAuditHooks').auditRefund(req, order, { amount: refundAmount, reason, mode: refundMode, beforeStatus });

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
