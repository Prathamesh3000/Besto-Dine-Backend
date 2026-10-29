// Reconciliation: manual endpoint, scheduled job and single-order recovery.

const Order = require('../../models/order');
const Restaurant = require('../../models/restaurant');
const logger = require('../../utils/logger');
const { tenantFilter } = require('../../utils/tenantScope');
const { orderCheckoutIds, checkCaptureCoversDue, paiseToRupees } = require('../../utils/paymentChecks');
const { claimPayment } = require('../../utils/paymentClaim');
const { describeRazorpayError } = require('../../utils/razorpayErrors');
const {
    freeTableIfReady,
    settleSplitSiblings,
    markOrderPaidAtomically,
    razorpay,
    awardLoyaltyPoints,
} = require('./_shared');

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
