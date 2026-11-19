/**
 * orderCancelReversal — give back what a cancelled order had consumed:
 *   • the coupon use (Coupon.usageCount, taken at order create / coupon apply)
 *   • the loyalty points redeemed at checkout (debited at order create)
 *   • a still-pending waiter tip on a paid order that is being voided
 *
 * Called once, by whichever path wins the atomic status → 'cancelled' write
 * (staff PATCH /:id/status, customer PATCH /:id/cancel). Never throws: a
 * reversal failure is logged, it must not fail the cancel.
 *
 * Idempotency: the coupon use is released only when it can be claimed (the
 * order's CouponRedemption row is deleted, or — for orders with no row —
 * usageCount > 0); points are restored only when no positive
 * 'points_redeemed' ledger row already exists for the order.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const Coupon = require('../models/coupon');
const CouponRedemption = require('../models/couponRedemption');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const Tip = require('../models/tip');
const idGen = require('../utils/idGenerator');
const logger = require('../utils/logger');

async function releaseCouponUse(order) {
  if (!order || !order.couponCode || !(Number(order.couponDiscount) > 0)) return false;
  const restaurant = order.restaurant;
  let couponId = null;
  const row = await CouponRedemption.findOneAndDelete({ order: order._id, restaurant });
  if (row) {
    couponId = row.coupon;
  } else {
    // Order placed before redemption rows existed (or written directly):
    // find the coupon by code, preferring the order's own branch.
    const candidates = await Coupon.find({
      code: String(order.couponCode).toUpperCase(),
      restaurant: order.restaurant,
      branch: { $in: order.branch ? [null, order.branch] : [null] },
    }).select('_id branch').lean();
    const hit = candidates.find((c) => c.branch && String(c.branch) === String(order.branch)) || candidates[0];
    couponId = hit ? hit._id : null;
  }
  if (!couponId) return false;
  const res = await Coupon.updateOne(
    { _id: couponId, restaurant: order.restaurant, usageCount: { $gt: 0 } },
    { $inc: { usageCount: -1 } },
  );
  return (res.modifiedCount || 0) > 0;
}

// Terminal paths (cancel, full refund) release the coupon use exactly once:
// the first to claim couponReleasedAt does the release.
async function releaseCouponUseOnce(order) {
  if (!order || !order.couponCode || !(Number(order.couponDiscount) > 0)) return false;
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, restaurant: order.restaurant, couponReleasedAt: null },
    { $set: { couponReleasedAt: new Date() } },
    { returnDocument: 'after' },
  ).select('_id').lean();
  if (!claimed) return false;
  try {
    const released = await releaseCouponUse(order);
    if (!released) {
      await Order.updateOne({ _id: order._id, restaurant: order.restaurant }, { $set: { couponReleasedAt: null } });
    }
    return released;
  } catch (err) {
    await Order.updateOne({ _id: order._id, restaurant: order.restaurant }, { $set: { couponReleasedAt: null } }).catch(() => {});
    throw err;
  }
}

async function restoreRedeemedPoints(order) {
  const points = Math.floor(Number(order && order.pointsRedeemed) || 0);
  if (!order || !order.user || points <= 0) return 0;
  const restaurant = order.restaurant;
  const already = await Transaction.exists({
    order: order._id, restaurant, type: 'points_redeemed', amount: { $gt: 0 },
  });
  if (already) return 0;
  const wallet = await Wallet.findOneAndUpdate(
    { user: order.user, restaurant },
    { $inc: { loyaltyPoints: points }, $setOnInsert: { balance: 0, restaurant } },
    { upsert: true, returnDocument: 'after' },
  );
  await Transaction.create({
    restaurant,
    branch: order.branch || null,
    user: order.user,
    order: order._id,
    type: 'points_redeemed',
    amount: points,
    paymentMethod: 'points',
    transactionId: idGen.transactionId(),
    description: `Redeemed points returned: order ${order.orderId} cancelled`,
    balanceBefore: wallet.loyaltyPoints - points,
    balanceAfter: wallet.loyaltyPoints,
  });
  return points;
}

async function revokePendingTips(order) {
  // The waiter must not be settled for a voided sale. (Settled tips stay.)
  const res = await Tip.updateMany(
    { order: order._id, restaurant: order.restaurant, status: 'pending' },
    { $set: { status: 'refunded' } },
  );
  return res.modifiedCount || 0;
}

async function reverseCouponAndPoints(order) {
  const out = { coupon: false, points: 0, tips: 0 };
  if (!order || !mongoose.isValidObjectId(String(order._id))) return out;
  try { out.coupon = await releaseCouponUseOnce(order); }
  catch (err) { logger.warn(`Coupon reversal failed for ${order.orderId}: ${err.message}`); }
  try { out.tips = await revokePendingTips(order); }
  catch (err) { logger.warn(`Tip revoke failed for ${order.orderId}: ${err.message}`); }
  try { out.points = await restoreRedeemedPoints(order); }
  catch (err) { logger.warn(`Loyalty points restore failed for ${order.orderId}: ${err.message}`); }
  return out;
}

module.exports = { reverseCouponAndPoints, releaseCouponUse, releaseCouponUseOnce, restoreRedeemedPoints };
