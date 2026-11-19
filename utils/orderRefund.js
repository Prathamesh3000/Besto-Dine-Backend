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

const Order = require('../models/order');
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
async function loyaltyPointsToClawBack(order, refundAmount, loyalty, session = null, priorRefunded = null) {
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
    // Cumulative share: points owed after THIS refund minus points owed after
    // the refunds before it, so two halves of a fully refunded order claw
    // back everything (flooring each refund would strand a point).
    const prior = Math.max(0, Number(priorRefunded == null ? order.refundedAmount : priorRefunded) || 0);
    const owed = (refunded) => Math.min(earned, Math.floor(earned * Math.min(1, refunded / base) + 1e-9));
    return Math.max(0, owed(prior + Number(refundAmount)) - owed(prior));
}

// Atomic, paise-rounded refundedAmount += delta (pipeline update, so float
// drift like 300.29999999999995 never reaches the stored value).
function addRefunded(delta) {
    return [{ $set: { refundedAmount: { $round: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, delta] }, 2] } } }];
}

// Split an amount over the legs it must be refunded through.
//   - wallet-paid order                       -> wallet
//   - online / mixed order                    -> gateway for the online part
//                                                (a mixed order's wallet part -> wallet)
//   - 'wallet' refund mode + a customer       -> wallet (all of it)
//   - guest online payment in 'wallet' mode   -> gateway (a guest has no wallet)
//   - cash / other                            -> wallet in 'wallet' mode with a
//                                                customer, else manual cash hand-back
// Returns { legs: [{ destination, method, amount }] } or { error }.
function planRefundLegs(order, refundAmount, refundMode) {
    const payMethod = String(order.paymentMethod || '').toLowerCase();
    const hasUser = !!order.user;
    const hasRzpId = Boolean(order.razorpayPaymentId);
    const isOnline = payMethod === 'online';
    const isMixed = payMethod === 'mixed';
    const leg = (destination, amount) => ({
        destination,
        method: destination === 'gateway' ? 'original' : destination === 'wallet' ? 'wallet' : 'manual',
        amount: roundPaise(amount),
    });

    if (isWalletPaid(order)) {
        if (!hasUser) return { error: 'Wallet-paid order has no customer wallet to credit' };
        return { legs: [leg('wallet', refundAmount)] };
    }
    if (isOnline || isMixed) {
        if (refundMode === 'wallet' && hasUser) return { legs: [leg('wallet', refundAmount)] };
        let gateway = refundAmount;
        if (isMixed) {
            const walletPaid = Math.min(roundPaise(order.walletAmountPaid), roundPaise(order.amountPaid));
            const onlinePaid = roundPaise(Number(order.amountPaid || 0) - walletPaid);
            const gatewayRefunded = (order.refunds || [])
                .filter((r) => r.destination === 'gateway' || (!r.destination && r.razorpayRefundId))
                .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
            gateway = Math.min(refundAmount, Math.max(0, roundPaise(onlinePaid - gatewayRefunded)));
            // Legacy mixed order with no gateway payment id: only its wallet part can be refunded.
            if (!hasRzpId) {
                const walletRefunded = (order.refunds || [])
                    .filter((r) => r.destination === 'wallet')
                    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
                const walletLeft = Math.max(0, roundPaise(walletPaid - walletRefunded));
                gateway = 0;
                if (hasUser && refundAmount <= walletLeft) return { legs: [leg('wallet', refundAmount)] };
            }
        }
        const rest = roundPaise(refundAmount - gateway);
        if (rest > 0 && !hasUser) return { error: 'Refund exceeds the online part of this payment and there is no wallet to credit' };
        if ((gateway > 0 || isMixed) && !hasRzpId) return { code: 'NO_PAYMENT_ID', error: 'Online payment record has no Razorpay transaction id — cannot auto-refund' };
        const legs = [];
        if (gateway > 0) legs.push(leg('gateway', gateway));
        if (rest > 0) legs.push(leg('wallet', rest));
        return { legs };
    }
    if (hasUser && refundMode === 'wallet') return { legs: [leg('wallet', refundAmount)] };
    return { legs: [leg('cash', refundAmount)] };
}

/**
 * Process a refund for one order.
 *
 * Money safety:
 *   1. The refund amount is RESERVED atomically on the order
 *      (refundedAmount += amount, guarded by amountPaid) BEFORE any gateway
 *      call, so concurrent refunds can never both reach the gateway for the
 *      same balance. The reservation is released on failure.
 *   2. If the gateway succeeds but the bookkeeping transaction fails, the
 *      reservation is KEPT and the gateway refund id is persisted on the
 *      order (refunds[]), so a retry cannot pay the customer twice.
 *
 * @param {Object} order  - Mongoose Order document (already loaded; its
 *                          refundedAmount / paymentStatus / refunds are updated in memory)
 * @param {Object} opts
 * @param {Number} opts.amount     - refund amount (Rs); must be <= unrefunded balance
 * @param {String} opts.reason     - human-readable reason (notes + transaction desc)
 * @param {Object} opts.settings   - tenant settings blob (for loyalty + refundMode)
 * @param {String|ObjectId} opts.tenantId - tenant scope for the Transaction row
 * @param {Object} [opts.actor]    - { _id, name } of whoever decided the refund
 * @param {String} [opts.source]   - refunds[] source ('admin')
 *
 * @returns {Promise<{
 *   success: boolean,
 *   error?:  string,
 *   status?: number,               // suggested HTTP status for a failure
 *   refundedAmount?: number,       // running total on the order after this refund
 *   razorpayRefundId?: string|null,
 *   mode?: 'original' | 'wallet' | 'manual',
 *   legs?: Array<{destination, method, amount}>,
 *   warning?: string,
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

    // Which channel(s) the money goes back through - decided BEFORE any
    // external/DB write.
    const plan = planRefundLegs(order, refundAmount, refundMode);
    if (plan.error) return { success: false, code: plan.code, error: plan.error };
    const { legs } = plan;
    const gatewayLeg = legs.find((l) => l.destination === 'gateway') || null;
    const walletLeg = legs.find((l) => l.destination === 'wallet') || null;
    const mode = gatewayLeg ? 'original' : walletLeg ? 'wallet' : 'manual';
    if (walletLeg && !order.restaurant) {
        return { success: false, error: 'Cannot process wallet refund — order has no restaurant context' };
    }
    const scope = { _id: order._id, ...(order.restaurant ? { restaurant: order.restaurant } : {}) };

    // ── Step 0: reserve the amount atomically ──────────────────────────
    const reserved = await Order.findOneAndUpdate(
        {
            ...scope,
            paymentStatus: 'Paid',
            $expr: { $lte: [
                { $add: [{ $ifNull: ['$refundedAmount', 0] }, refundAmount] },
                { $add: [{ $ifNull: ['$amountPaid', 0] }, 0.005] },
            ] },
        },
        addRefunded(refundAmount),
        { returnDocument: 'after', updatePipeline: true },
    );
    if (!reserved) {
        return { success: false, error: 'Refund amount exceeds the refundable balance (another refund may be in progress)' };
    }
    const release = async (amt) => {
        try {
            await Order.updateOne(scope, addRefunded(-amt), { updatePipeline: true });
        } catch (relErr) {
            logger.error('Refund reservation could not be released — refundedAmount is overstated', {
                orderId: order.orderId, amount: amt, error: relErr.message,
            });
        }
    };
    const reservedTotal = roundPaise(reserved.refundedAmount);
    const priorRefunded = roundPaise(reservedTotal - refundAmount);
    const fullyRefunded = reservedTotal >= roundPaise(reserved.amountPaid) - 0.005;
    const actorId = opts.actor?._id || opts.actor?.id || null;
    const actorName = opts.actor?.name || '';
    const entryFor = (l, rzpId) => ({
        amount: l.amount,
        reason: reason || '',
        razorpayRefundId: rzpId || null,
        actor: actorId,
        actorName,
        source: opts.source || 'admin',
        destination: l.destination,
        method: l.method,
        createdAt: new Date(),
    });

    // ── Step 1: external API call (if needed), OUTSIDE the DB session ──
    // Razorpay refunds can't be rolled back, so this runs on the reserved
    // amount and DB changes are committed only after it succeeds.
    let razorpayRefundId = null;
    if (gatewayLeg) {
        try {
            // SDK 2.9.x exposes refunds via payments.refund(paymentId, …);
            // there is no refunds.create.
            const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
                amount: Math.round(gatewayLeg.amount * 100),  // paise
                notes: { reason: reason || 'Refund', orderId: order.orderId },
            });
            razorpayRefundId = refund.id;
            logger.info(`Razorpay refund ${razorpayRefundId} created for ${order.orderId} (₹${gatewayLeg.amount})`);
        } catch (rzpErr) {
            await release(refundAmount);
            logger.error('Razorpay refund API failed', {
                orderId: order.orderId,
                ...describeRazorpayError(rzpErr),
            });
            return {
                success: false,
                code: 'GATEWAY_FAILED',
                error: 'Payment gateway refund failed. Please try again or contact support.',
            };
        }
    }

    // ── Step 2: Transactional DB writes ────────────────────────────────
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // refunds[] entries (one per leg); flip to Refunded only when the
            // reservation made the order fully refunded (never back to Paid).
            const update = { $push: { refunds: { $each: legs.map((l) => entryFor(l, l === gatewayLeg ? razorpayRefundId : null)) } } };
            if (fullyRefunded) update.$set = { paymentStatus: 'Refunded' };
            await Order.updateOne(scope, update, { session });

            // Wallet credit (wallet leg)
            let creditedBalance = null;
            if (walletLeg && order.user) {
                const walletScope = { user: order.user, restaurant: order.restaurant };
                const w = await Wallet.findOneAndUpdate(
                    walletScope,
                    { $inc: { balance: walletLeg.amount }, $setOnInsert: { restaurant: order.restaurant } },
                    { upsert: true, returnDocument: 'after', session },
                );
                creditedBalance = w ? w.balance : null;
                logger.info(`Wallet refund +₹${walletLeg.amount} to user ${order.user} (${order.orderId})`);
            }

            // Proportional loyalty deduction — user is returning the
            // purchase so they shouldn't keep the points they earned
            // from it. Silent no-op if they've already spent them.
            let pointsDeducted = 0;
            if (order.user) {
                const pointsToDeduct = await loyaltyPointsToClawBack(order, refundAmount, loyalty, session, priorRefunded);
                if (pointsToDeduct > 0) {
                    const hit = await Wallet.findOneAndUpdate(
                        {
                            user: order.user,
                            restaurant: order.restaurant,
                            loyaltyPoints: { $gte: pointsToDeduct },
                        },
                        { $inc: { loyaltyPoints: -pointsToDeduct } },
                        { session },
                    );
                    if (hit) pointsDeducted = pointsToDeduct;
                }
            }

            // Transaction audit rows (only for registered users — guests
            // don't have a Transaction history to append to).
            if (order.user) {
                const wallet = await Wallet.findOne({
                    user: order.user,
                    restaurant: order.restaurant,
                }).session(session);
                const currentBalance = creditedBalance != null ? creditedBalance : (wallet ? wallet.balance : 0);
                const balanceBefore  = walletLeg ? roundPaise(currentBalance - walletLeg.amount) : currentBalance;

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

                // Points reversal row so the loyalty history reconciles.
                if (pointsDeducted > 0) {
                    await Transaction.create([{
                        user: order.user,
                        restaurant: order.restaurant || tenantId,
                        order: order._id,
                        type: 'points_redeemed',
                        amount: pointsDeducted,
                        paymentMethod: 'points',
                        status: 'completed',
                        description: `Reversed ${pointsDeducted} points for refund on ${order.orderId}`,
                        transactionId: idGen.transactionId(),
                    }], { session });
                }
            }
        });
    } catch (err) {
        logger.error('DB transaction for refund failed', { orderId: order.orderId, error: err.message });
        if (!gatewayLeg) {
            // Nothing irreversible happened: roll the reservation back.
            await release(refundAmount);
            return { success: false, status: 500, error: 'Refund bookkeeping failed. Please retry.' };
        }
        // The gateway ALREADY paid the customer. Keep that part reserved and
        // persist its refund id on the order so a retry cannot pay again;
        // release only the part that never moved.
        const unmoved = roundPaise(refundAmount - gatewayLeg.amount);
        try {
            const upd = { $push: { refunds: entryFor(gatewayLeg, razorpayRefundId) } };
            if (fullyRefunded && unmoved <= 0) upd.$set = { paymentStatus: 'Refunded' };
            await Order.updateOne(scope, upd);
            if (unmoved > 0) await Order.updateOne(scope, addRefunded(-unmoved), { updatePipeline: true });
        } catch (persistErr) {
            logger.error('GATEWAY REFUND MADE BUT NOT RECORDED — reconcile manually', {
                orderId: order.orderId, razorpayRefundId, amount: gatewayLeg.amount, error: persistErr.message,
            });
        }
        if (unmoved > 0) {
            return {
                success: false,
                status: 500,
                error: `Online part (₹${gatewayLeg.amount}) was refunded through the gateway but the wallet part could not be credited. Please refund the remaining ₹${unmoved} separately.`,
                razorpayRefundId,
            };
        }
        order.refundedAmount = reservedTotal;
        return {
            success: true,
            refundedAmount: reservedTotal,
            razorpayRefundId,
            mode,
            legs,
            warning: 'Refund was sent to the payment gateway; bookkeeping (ledger / loyalty) is incomplete and has been logged.',
        };
    } finally {
        await session.endSession();
    }

    // Keep the caller's in-memory document in step with what was written.
    order.refundedAmount = reservedTotal;
    if (fullyRefunded) order.paymentStatus = 'Refunded';
    order.refunds = [...(order.refunds || []), ...legs.map((l) => entryFor(l, l === gatewayLeg ? razorpayRefundId : null))];

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
        legs,
    };
}

module.exports = {
    processOrderRefund,
    roundPaise,
    isWalletPaid,
    planRefundLegs,
    ledgerPaymentMethod,
    loyaltyPointsToClawBack,
};
