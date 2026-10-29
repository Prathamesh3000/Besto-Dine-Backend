/**
 * Reusable order-refund helper.
 *
 * Encapsulates the payment-gateway call, wallet credit, loyalty-point
 * rollback, and Transaction-log entry that a refund needs, so BOTH the
 * admin "Refund" endpoint (razorpayController.refundPayment) AND the
 * customer-initiated cancel path (orderController.cancelOrder) can
 * share the same, audited implementation.
 *
 * Behaviour summary:
 *
 *   - Online payment + refund-mode = "original"
 *       → Razorpay payments.refund() (real money back to the card/UPI)
 *   - Wallet payment, OR refund-mode = "wallet"
 *       → credit the refund amount back to the user's Wallet balance
 *   - Cash payment
 *       → just record the refund on the order + a Transaction row;
 *         the admin dashboard shows "manual refund required" so staff
 *         can hand cash back at the counter.
 *
 * Returns a plain result object instead of throwing / 500'ing so the
 * caller can decide how to surface failures (admin endpoint returns
 * HTTP error, cancel flow logs + notifies admin to handle manually).
 */

const mongoose = require('mongoose');
const Razorpay = require('razorpay');

const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const logger = require('./logger');
const idGen = require('./idGenerator');
const { resolveLoyaltySettings } = require('./paymentDefaults');
const { revokeTipsForOrder } = require('./tipHelpers');
const { describeRazorpayError } = require('./razorpayErrors');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Money is stored in rupees with paise precision; round every derived
// amount so float drift (512.4 - 100.1 = 412.29999…) never blocks an
// exact remainder or keeps a fully refunded order 'Paid'.
function roundPaise(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// Wallet payments are stored as 'wallet' (POST /wallet/pay); legacy rows
// may carry 'Wallet'. Compare case-insensitively.
function isWalletPaid(order) {
    return String(order?.paymentMethod || '').toLowerCase() === 'wallet';
}

// Order.paymentMethod is free text ('online', 'mixed', 'counter',
// 'Not selected', …) but Transaction.paymentMethod is an enum
// (upi/card/wallet/cash/points). Map onto the enum so the refund ledger
// row never fails validation.
const LEDGER_PAYMENT_METHODS = {
    online: 'upi',
    upi: 'upi',
    card: 'card',
    wallet: 'wallet',
    cash: 'cash',
    points: 'points',
    mixed: 'upi',      // wallet + online split — the online leg dominates
    counter: 'cash',   // paid at the counter
};
function ledgerPaymentMethod(paymentMethod) {
    return LEDGER_PAYMENT_METHODS[String(paymentMethod || '').toLowerCase()] || 'cash';
}

// Loyalty points to claw back for a refund: a share of what THIS order
// earned, proportional to the refunded fraction of the amount paid —
// never points the customer earned elsewhere. The points_earned ledger
// rows are authoritative; orders without one (legacy data) fall back to
// what the earn rule would have given the order.
async function loyaltyPointsToClawBack(order, refundAmount, loyalty, session = null) {
    if (!order?.user) return 0;
    const rows = await Transaction.find({
        order: order._id,
        type: 'points_earned',
        ...(order.restaurant ? { restaurant: order.restaurant } : {}),
    }).select('amount').session(session).lean();
    let earned;
    if (rows.length) {
        earned = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    } else {
        const total = Number(order.total) || 0;
        earned = (loyalty.enableLoyalty && total >= loyalty.minBillToEarn)
            ? Math.floor(total * (loyalty.pointsPerRupee || 0))
            : 0;
    }
    const base = Number(order.amountPaid) || Number(order.total) || 0;
    if (!(earned > 0) || !(base > 0)) return 0;
    const share = Math.min(1, Number(refundAmount) / base);
    // + epsilon: refund === base must give exactly `earned`, not earned - 1.
    return Math.min(earned, Math.floor(earned * share + 1e-9));
}

/**
 * Process a refund for one order.
 *
 * @param {Object} order  — Mongoose Order document (already loaded, will be mutated + saved)
 * @param {Object} opts
 * @param {Number} opts.amount     — refund amount (₹); must be ≤ unrefunded balance
 * @param {String} opts.reason     — human-readable reason (notes + transaction desc)
 * @param {Object} opts.settings   — tenant settings blob (for loyalty + refundMode)
 * @param {String|ObjectId} opts.tenantId — tenant scope for the Transaction row
 *
 * @returns {Promise<{
 *   success: boolean,
 *   error?:  string,
 *   refundedAmount?: number,       // running total on the order after this refund
 *   razorpayRefundId?: string|null,
 *   mode?: 'original' | 'wallet' | 'manual',
 * }>}
 */
async function processOrderRefund(order, opts = {}) {
    const { amount, reason, settings, tenantId } = opts;

    // ── Guards ─────────────────────────────────────────────────────────
    if (!order) {
        return { success: false, error: 'Order not found' };
    }
    if (order.paymentStatus !== 'Paid') {
        return { success: false, error: 'Only paid orders can be refunded' };
    }

    const rawAmount = Number(amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
        return { success: false, error: 'Refund amount must be a positive number' };
    }
    const refundAmount = roundPaise(rawAmount);

    const alreadyRefunded = roundPaise(order.refundedAmount);
    const maxRefundable = roundPaise(Number(order.amountPaid || 0) - alreadyRefunded);
    if (refundAmount > maxRefundable + 0.001) {  // tiny epsilon for float compare
        return {
            success: false,
            error: `Refund amount exceeds refundable balance (₹${maxRefundable.toFixed(2)})`,
        };
    }

    const loyalty = resolveLoyaltySettings(settings);
    const refundMode = loyalty.refundMode;         // 'original' | 'wallet'
    const payMethod  = order.paymentMethod;
    const isOnline   = payMethod === 'online';
    const hasRzpId   = Boolean(order.razorpayPaymentId);
    let razorpayRefundId = null;

    // Figure out which channel this refund is going through BEFORE we
    // make any external/DB writes so the log/transaction is accurate.
    let mode = 'manual';
    if (isOnline && hasRzpId && refundMode === 'original') {
        mode = 'original';
    } else if (order.user && (isWalletPaid(order) || refundMode === 'wallet')) {
        mode = 'wallet';
    }

    // ── Step 1: External API call (if needed), OUTSIDE the DB session ──
    // Razorpay refunds can't be rolled back, so we make this call first
    // and only commit DB changes after it succeeds.
    if (mode === 'original') {
        try {
            // SDK 2.9.x exposes refunds via payments.refund(paymentId, …);
            // there is no refunds.create.
            const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
                amount: Math.round(refundAmount * 100),  // paise
                notes: { reason: reason || 'Refund', orderId: order.orderId },
            });
            razorpayRefundId = refund.id;
            logger.info(`Razorpay refund ${razorpayRefundId} created for ${order.orderId} (₹${refundAmount})`);
        } catch (rzpErr) {
            logger.error('Razorpay refund API failed', {
                orderId: order.orderId,
                ...describeRazorpayError(rzpErr),
            });
            return {
                success: false,
                error: 'Payment gateway refund failed. Please try again or contact support.',
            };
        }
    }

    // Online-paid order without a stored razorpay id is a data bug — we
    // can't route it through the gateway. Bail loudly so admin knows.
    if (isOnline && !hasRzpId && refundMode === 'original') {
        return {
            success: false,
            error: 'Online payment record has no Razorpay transaction id — cannot auto-refund',
        };
    }

    // ── Step 2: Transactional DB writes ────────────────────────────────
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // Order totals
            order.refundedAmount = roundPaise(alreadyRefunded + refundAmount);
            order.paymentStatus  = order.refundedAmount >= Number(order.amountPaid || 0) ? 'Refunded' : 'Paid';
            await order.save({ session });

            // Wallet credit (if refunding to wallet)
            if (mode === 'wallet' && order.user) {
                const walletScope = { user: order.user, restaurant: order.restaurant };
                await Wallet.findOneAndUpdate(
                    walletScope,
                    { $inc: { balance: refundAmount }, $setOnInsert: { restaurant: order.restaurant } },
                    { upsert: true, returnDocument: 'after', session },
                );
                logger.info(`Wallet refund +₹${refundAmount} to user ${order.user} (${order.orderId})`);
            }

            // Proportional loyalty deduction — user is returning the
            // purchase so they shouldn't keep the points they earned
            // from it. Silent no-op if they've already spent them.
            if (order.user) {
                const pointsToDeduct = await loyaltyPointsToClawBack(order, refundAmount, loyalty, session);
                if (pointsToDeduct > 0) {
                    await Wallet.findOneAndUpdate(
                        {
                            user: order.user,
                            restaurant: order.restaurant,
                            loyaltyPoints: { $gte: pointsToDeduct },
                        },
                        { $inc: { loyaltyPoints: -pointsToDeduct } },
                        { session },
                    );
                }
            }

            // Transaction audit row (only for registered users — guests
            // don't have a Transaction history to append to).
            if (order.user) {
                const wallet = await Wallet.findOne({
                    user: order.user,
                    restaurant: order.restaurant,
                }).session(session);
                const currentBalance = wallet ? wallet.balance : 0;
                const balanceBefore  = mode === 'wallet' ? currentBalance - refundAmount : currentBalance;

                await Transaction.create([{
                    user: order.user,
                    restaurant: order.restaurant || tenantId,
                    order: order._id,
                    type: 'refund',
                    amount: refundAmount,
                    paymentMethod: ledgerPaymentMethod(payMethod),
                    status: 'completed',
                    description: `Refund of ₹${refundAmount} for ${order.orderId}: ${reason || 'No reason'}`,
                    transactionId: idGen.transactionId(),
                    balanceBefore,
                    balanceAfter: currentBalance,
                }], { session });
            }
        });
    } catch (err) {
        logger.error('DB transaction for refund failed', { orderId: order.orderId, error: err.message });
        return { success: false, error: 'Refund bookkeeping failed. Please retry.' };
    } finally {
        await session.endSession();
    }

    // Revoke any still-pending tip(s) for this order so the waiter isn't
    // paid out for a refunded transaction. Already-settled tips are left
    // alone — recovering them requires manual admin action since cash has
    // physically moved. Done outside the txn (best-effort) — a failure
    // here logs but does not reverse the already-successful refund.
    await revokeTipsForOrder(order, { reason: `refund: ${reason || 'no reason'}` });

    // Webhook `refund.created` (one event per refund: keyed on order + running total).
    try {
        require('./webhookService').emitRefundCreated(order, {
            amount: refundAmount, mode, refundRequestId: opts.refundRequestId, refundedAmount: order.refundedAmount,
        });
    } catch { /* webhooks never affect the refund */ }

    return {
        success: true,
        refundedAmount: order.refundedAmount,
        razorpayRefundId,
        mode,
    };
}

module.exports = {
    processOrderRefund,
    roundPaise,
    isWalletPaid,
    ledgerPaymentMethod,
    loyaltyPointsToClawBack,
};
