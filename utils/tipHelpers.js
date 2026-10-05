/**
 * Tip lifecycle helpers.
 *
 * Tips were previously created inline inside orderController.updateOrderStatus
 * only — which meant the Razorpay verifyPayment + webhook payment.captured
 * paths silently skipped tip creation whenever they marked an order Paid
 * without going through the shared PATCH handler. Refunds had the mirror
 * problem: the Tip record stayed 'pending' after an order was refunded, and
 * the admin would happily settle it to the waiter — paying them for a
 * cancelled transaction.
 *
 * These two helpers centralise the logic so every payment / refund entry
 * point stays consistent:
 *
 *   - createTipForPaidOrder : idempotent create, safe to call from
 *                             anywhere that just transitioned an order
 *                             into paymentStatus='Paid'.
 *   - revokeTipsForOrder    : flip all non-settled tips for an order to
 *                             status='refunded' so they drop out of the
 *                             admin settlement queue and the waiter's
 *                             "pending" totals.
 */

const Tip = require('../models/tip');
const logger = require('./logger');

/**
 * Create a Tip record for an order that was just paid.
 * Idempotent — re-running is a no-op thanks to the find-first guard plus
 * the unique { order, restaurant } index on Tip (concurrent inserts lose
 * with E11000 and fall back to the winner's row).
 *
 * @param {Object} order              Mongoose Order document (already saved)
 * @param {String|ObjectId} restaurantId  Tenant id to stamp on the Tip
 * @returns {Promise<Object|null>}    Created Tip doc, existing Tip doc, or null if no tip applicable
 */
async function createTipForPaidOrder(order, restaurantId) {
    if (!order) return null;
    if (order.paymentStatus !== 'Paid') return null;
    if (!order.tipAmount || order.tipAmount <= 0) return null;
    if (!order.waiter) return null;

    try {
        // Tenant-scoped lookup so a hypothetical cross-tenant order id
        // collision can't return someone else's tip.
        let existing = await Tip.findOne({ order: order._id, restaurant: restaurantId });
        if (!existing) {
            try {
                const tip = await new Tip({
                    restaurant: restaurantId,
                    waiter: order.waiter,
                    order: order._id,
                    amount: order.tipAmount,
                    status: 'pending',
                }).save();
                logger.info(`Tip created ₹${order.tipAmount} for waiter ${order.waiter} on order ${order.orderId}`);
                return tip;
            } catch (err) {
                // Unique { order, restaurant } index: a concurrent caller
                // inserted first — fall through and treat theirs as existing.
                if (err?.code !== 11000) throw err;
                existing = await Tip.findOne({ order: order._id, restaurant: restaurantId });
                if (!existing) throw err;
            }
        }
        let dirty = false;
        // If a previous flow revoked this tip but the order was
        // re-paid (rare — manual admin action), revive it.
        if (existing.status === 'refunded') {
            existing.status = 'pending';
            existing.amount = order.tipAmount;   // re-sync in case amount changed
            existing.settlement = undefined;
            dirty = true;
        }
        // Re-attribute when order.waiter has changed since this Tip
        // was first created — e.g. a captain picked up the order
        // after it was already paid, so pickupOrder re-stamped the
        // waiter field. Only pending tips are touched; settled tips
        // have been paid out and reversing them needs a manual
        // admin decision.
        if (existing.status === 'pending' && String(existing.waiter) !== String(order.waiter)) {
            existing.waiter = order.waiter;
            dirty = true;
        }
        if (dirty) await existing.save();
        return existing;
    } catch (err) {
        // Tip creation must never block the payment itself.
        logger.warn(`createTipForPaidOrder failed for ${order.orderId}: ${err.message}`);
        return null;
    }
}

/**
 * Mark every pending/settled-in-limbo tip for an order as 'refunded'.
 * Settled tips are LEFT ALONE — the waiter has already been paid for
 * them; reversing would require reclaiming cash and is a manual decision.
 *
 * @param {Object|String|ObjectId} orderOrId  Order document or id
 * @param {Object} [opts]
 * @param {String} [opts.reason]   Optional log reason (cancel, refund, webhook)
 * @returns {Promise<{ updated: number }>}
 */
async function revokeTipsForOrder(orderOrId, opts = {}) {
    const orderId = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
    if (!orderId) return { updated: 0 };
    try {
        const result = await Tip.updateMany(
            { order: orderId, status: 'pending' },
            { $set: { status: 'refunded' } }
        );
        const n = result.modifiedCount || 0;
        if (n > 0) {
            logger.info(`Tip(s) revoked for order ${orderOrId.orderId || orderId}: ${n} doc(s)${opts.reason ? ` (${opts.reason})` : ''}`);
        }
        return { updated: n };
    } catch (err) {
        logger.warn(`revokeTipsForOrder failed for ${orderOrId.orderId || orderId}: ${err.message}`);
        return { updated: 0 };
    }
}

module.exports = { createTipForPaidOrder, revokeTipsForOrder };
