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
const { tenantFilter, tenantId } = require('../../utils/tenantScope');
const { resolveLoyaltySettings } = require('../../utils/paymentDefaults');
const { revokeTipsForOrder } = require('../../utils/tipHelpers');
const { checkOrphanRefundEligibility, isValidCheckoutSignature } = require('../../utils/paymentChecks');
const { claimPayment, releaseClaim, findClaim } = require('../../utils/paymentClaim');
const { roundPaise, isWalletPaid, ledgerPaymentMethod, loyaltyPointsToClawBack } = require('../../utils/orderRefund');
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
        require('../../services/tenantAuditHooks').auditRefund(req, order, { amount: refundAmount, reason, mode: refundMode });
        try {
            require('../../utils/webhookService').emitRefundCreated(order, {
                amount: refundAmount, mode: razorpayRefundId ? 'original' : (walletRefund ? 'wallet' : 'manual'), refundedAmount: order.refundedAmount,
            });
        } catch { /* webhooks never affect the refund */ }

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
