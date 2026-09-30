/**
 * orderPaymentService — payment-side order flows: the staff "mark paid"
 * ledger (loyalty points + transactions), the customer payment endpoint,
 * counter-payment requests and applying a coupon to an open order.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31).
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const Table = require('../models/table');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const idGen = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { getSettings } = require('../utils/settingsCache');
const { tenantFilter, tenantId } = require('../utils/tenantScope');
const { freeTableOrUnmergeGroup } = require('../utils/tableMerge');
const { resolveLoyaltySettings } = require('../utils/paymentDefaults');
const { httpError, reply } = require('./orderErrors');
const { emitOrderEvent, emitStaffTable, runAfterResponse } = require('./orderHelpers');
const { orderAccessForCaller } = require('./orderAccess');
const { notifyCounterPaymentRequested, notifyPaymentConfirmed } = require('./orderNotifications');

// updateOrderStatus: an order just became Paid and has an owner — award
// loyalty points, write the points + payment ledger rows and send the
// payment notifications. Returns the tenant settings it read (the caller
// reuses them for the order-ready gate).
async function recordPaidOrderLedger(req, order, tf) {
  // M6: Read loyalty config from Settings instead of hardcoding (per-tenant)
  const settings = await getSettings(req);
  const loyalty = resolveLoyaltySettings(settings);
  const earnedPoints = (loyalty.enableLoyalty && order.total >= loyalty.minBillToEarn)
    ? Math.floor(order.total * loyalty.pointsPerRupee)
    : 0;

  // Atomic wallet points award using $inc (prevents race conditions)
  const tenant = tenantId(req);
  const walletFilter = { user: order.user, ...tf };
  let wallet = await Wallet.findOneAndUpdate(
    walletFilter,
    { $inc: { loyaltyPoints: earnedPoints }, $setOnInsert: { balance: 0, restaurant: tenant } },
    { upsert: true, returnDocument: 'after' }
  );

  const pointsBefore = wallet.loyaltyPoints - earnedPoints;
  const balanceBefore = wallet.balance;
  const isWalletPayment = order.paymentMethod?.toLowerCase() === 'wallet';

  // Record Points Transaction + Payment Transaction in parallel
  // NOTE: Balance was already deducted in walletController.payWithWallet() via atomic operation.
  // Do NOT deduct again here to avoid double-charging the customer.
  await Promise.all([
    new Transaction({
      user: order.user, order: order._id, type: 'points_earned',
      restaurant: tenant,
      branch: order.branch || null,
      amount: earnedPoints, paymentMethod: 'points', transactionId: idGen.transactionId(),
      description: `Earned from Order ${order.orderId}`,
      balanceBefore: pointsBefore, balanceAfter: wallet.loyaltyPoints
    }).save(),
    new Transaction({
      user: order.user, order: order._id, type: 'order_payment',
      restaurant: tenant,
      branch: order.branch || null,
      amount: isWalletPayment ? -order.total : order.total,
      paymentMethod: order.paymentMethod?.toLowerCase() || 'cash', transactionId: idGen.transactionId(),
      description: `Payment for Order ${order.orderId}`,
      balanceBefore: balanceBefore, balanceAfter: wallet.balance
    }).save()
  ]);

  // Payment notifications: admin bell + toast, customer points row,
  // customer payment row + toast (services/orderNotifications).
  if (order.paymentStatus === 'Paid') {
    await notifyPaymentConfirmed({ order, restaurant: tenant, earnedPoints, includePointsRow: true });
  }
  return settings;
}

// Customer-initiated counter-payment request.
// ---------------------------------------------
// Dine-in customer taps "Pay at Counter" on the bill preview. We
// don't try to settle anything here — admin / waiter does that
// physically. The endpoint just:
//   1. Stamps `counterPaymentRequestedAt` on the order so the admin
//      table drawer can show a red alert banner with a one-tap
//      "Mark Paid · Cash" button.
//   2. Creates a high-priority Notification for the admin/waiter
//      role rooms scoped to the order's branch.
//   3. Emits a `counter-payment:requested` socket event with the
//      table number + amount + orderId for live dashboard updates.
//
// Idempotent — re-tapping the button on the customer side just
// refreshes the timestamp; no duplicate notifications because we
// gate the create on transition (existing flag absent).
async function requestCounterPayment(req) {
  const { id } = req.params;
  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!order) order = await Order.findOne({ orderId: id, ...tf });
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  if (order.paymentStatus === 'Paid') {
    throw httpError(400, {
      success: false,
      code: 'ALREADY_PAID',
      message: 'This bill is already paid.',
    });
  }
  if (order.status === 'cancelled') {
    throw httpError(400, {
      success: false,
      code: 'ORDER_CANCELLED',
      message: 'Cannot request payment on a cancelled order.',
    });
  }

  const wasAlreadyRequested = !!order.counterPaymentRequestedAt;
  order.counterPaymentRequestedAt = new Date();
  // Stamp the requested method so the table drawer's "Mark Paid"
  // button defaults to cash. Customer can still pick a different
  // method at the counter — admin overrides on settle.
  order.paymentMethod = 'cash';
  await order.save();

  // Bill-consistency: the customer bill, admin drawer, and waiter settle
  // screen all show the WHOLE table's bill — so the cash-collect amount
  // must be the table's aggregated payable, not just this one round.
  // Sum every unpaid round's stored total (which already bakes in that
  // round's taxes/tip/coupon/points) and subtract any manual discount.
  // Falls back to the single order when it has no table (defensive).
  let payableTotal = Number(order.total) || 0;
  if (order.table) {
    try {
      const tableRounds = await Order.find({
        table: order.table,
        status: { $in: ['new', 'preparing', 'ready', 'served'] },
        paymentStatus: { $ne: 'Paid' },
        ...tf,
      }).select('total manualDiscount').lean();
      if (tableRounds.length) {
        payableTotal = Math.round(
          tableRounds.reduce((s, o) => s + (Number(o.total) || 0) - (Number(o.manualDiscount) || 0), 0) * 100,
        ) / 100;
      }
    } catch { /* fall back to single-order total */ }
  }

  // Pull the table name lazily so the notification description
  // can read "Table 5 wants to settle bill — ₹500" instead of an
  // opaque ObjectId. Best-effort; falls back to "this table".
  let tableLabel = 'this table';
  let tableAreaName = null;
  let tableWaiterId = null;
  if (order.table) {
    try {
      const t = await Table.findOne({ _id: order.table, ...tf })
        .select('name area assignedWaiter')
        .populate('area', 'name')
        .lean();
      if (t?.name) tableLabel = `Table ${t.name}`;
      tableAreaName = t?.area?.name || null;
      tableWaiterId = t?.assignedWaiter || null;
    } catch { /* non-fatal */ }
  }
  // The ONE waiter responsible for this table: whoever took/served the
  // order, else the table's assigned waiter. Payment requests used to be
  // broadcast to every waiter at the branch (role-wide Notification +
  // emitToWaiter), so any waiter on the floor — including ones with no
  // connection to the table — got "collect ₹X cash" straight from the
  // customer. Settlement belongs to the counter (admin/manager) and the
  // captain, who owns billing; the table's own waiter is the only floor
  // waiter who needs to know.
  const responsibleWaiterId = order.waiter || tableWaiterId || null;

  // Skip the notification + socket emit on a duplicate request
  // (customer tapped twice / page reload). The timestamp refresh
  // above is enough to keep the drawer alert active.
  if (!wasAlreadyRequested) {
    await notifyCounterPaymentRequested(req, { order, payableTotal, tableLabel, tableAreaName, responsibleWaiterId });
  }

  return reply(200, { success: true, order: { orderId: order.orderId, counterPaymentRequestedAt: order.counterPaymentRequestedAt } });
}

// Apply (or clear) a coupon on an existing active order. Used by the
// waiter / admin "Apply Coupon" flow so the discount persists on the
// order doc and every audience (admin drawer, waiter bill, customer
// bill preview) sees the same total without any client-side drift.
// Emits `order:updated` so all three views refresh live.
async function applyCouponToOrder(req) {
  const { id } = req.params;
  const { code } = req.body || {};

  const order = await Order.findOne({ _id: id, ...tenantFilter(req) });
  if (!order) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }
  if (order.paymentStatus === 'Paid' || order.status === 'cancelled') {
    throw httpError(400, {
      success: false,
      code: 'ORDER_LOCKED',
      message: 'Cannot modify coupon on a paid or cancelled order',
    });
  }

  // Empty / null code → clear the coupon on the order.
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    order.couponCode = '';
    order.couponDiscount = 0;
    await order.save();
    emitOrderEvent(
      'order:updated',
      { orderId: order.orderId, couponCode: '', couponDiscount: 0 },
      order
    );
    return reply(200, { success: true, order, discount: 0, message: 'Coupon removed' });
  }

  // Validate the coupon against the current order state. We deliberately
  // re-run validation here (not just trust a client-provided discount)
  // so a waiter can't punch in a hand-edited amount.
  const Coupon = require('../models/coupon');
  const coupon = await Coupon.findOne({
    code: trimmed.toUpperCase(),
    isActive: true,
    ...tenantFilter(req),
  });
  if (!coupon) {
    throw httpError(404, { success: false, message: 'Invalid or inactive coupon code' });
  }

  const now = new Date();
  if (coupon.startDate && now < coupon.startDate) {
    throw httpError(400, { success: false, message: 'Coupon is not yet active' });
  }
  if (coupon.endDate && now > coupon.endDate) {
    throw httpError(400, { success: false, message: 'Coupon has expired' });
  }

  const subtotal = (order.items || []).reduce((acc, i) => acc + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  if (coupon.minOrderValue && subtotal < coupon.minOrderValue) {
    throw httpError(400, {
      success: false,
      message: `Minimum order value of ₹${coupon.minOrderValue} required for this coupon`,
    });
  }

  // ADM-064 — order.items[].prepStation was snapshotted at order
  // create time, so the helper can classify directly without a
  // MenuItem lookup.
  const { computeCouponDiscount } = require('../utils/couponScope');
  const { discount, eligibleSubtotal: eligible } = computeCouponDiscount(coupon, order.items || []);
  if (coupon.scope && coupon.scope !== 'all' && eligible <= 0) {
    throw httpError(400, {
      success: false,
      message: coupon.scope === 'food'
        ? 'This coupon only applies to food items and none are in this order.'
        : 'This coupon only applies to beverages and none are in this order.',
    });
  }
  const finalDiscount = Math.min(discount, subtotal);

  order.couponCode = coupon.code;
  order.couponDiscount = finalDiscount;
  await order.save();

  emitOrderEvent(
    'order:updated',
    { orderId: order.orderId, couponCode: coupon.code, couponDiscount: finalDiscount },
    order
  );

  return reply(200, {
    success: true,
    order,
    discount: finalDiscount,
    coupon: { code: coupon.code, title: coupon.title, scope: coupon.scope || 'all' },
    message: 'Coupon applied',
  });
}

// ── Customer Payment Update ────────────────────────────────────────────────
// Customer-facing payment endpoint (optionalAuth). Bug #5 hardening:
//
//   * The customer can only record INTENT — e.g. which method they plan to
//     use (`paymentMethod`). paymentStatus 'Paid', `amountPaid` and `total`
//     are NEVER taken from the body. Money is settled only by the server
//     paths that actually move it: Razorpay verify / webhook, staff
//     mark-paid, or POST /wallet/pay (walletController.payWithWallet),
//     which debits the wallet against the server-side order total and
//     flips the order to Paid itself.
//   * `paymentStatus: 'Paid'` is still accepted as a "finalize" signal for
//     a wallet-settled order: once payWithWallet has marked the order Paid,
//     this call runs the post-payment bookkeeping (loyalty points,
//     notifications, table release) exactly once. It changes no money
//     fields and 409s if the order isn't actually paid.
//   * Ownership: owner, staff, or — for ownerless guest orders — a caller
//     whose scan session matches the order's scanSessionId.
const CUSTOMER_PAYMENT_INTENTS = new Set(['cash', 'counter', 'online', 'wallet', 'card', 'upi']);
async function customerPayment(req) {
  const { id } = req.params;
  const { paymentStatus, paymentMethod } = req.body || {};
  // `amountPaid` / `total` in the body are deliberately ignored.

  const validPaymentStatuses = ['Pending', 'Paid'];
  if (paymentStatus && !validPaymentStatuses.includes(paymentStatus)) {
    throw httpError(400, { success: false, message: 'Invalid payment status' });
  }
  let intentMethod = null;
  if (paymentMethod !== undefined && paymentMethod !== null && paymentMethod !== '') {
    if (typeof paymentMethod !== 'string' || !CUSTOMER_PAYMENT_INTENTS.has(paymentMethod.toLowerCase())) {
      throw httpError(400, { success: false, message: 'Invalid payment method' });
    }
    intentMethod = paymentMethod.toLowerCase();
  }

  // Find order by _id or orderId string (scoped to tenant)
  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : await Order.findOne({ orderId: id, ...tf });
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // ── Ownership / authorization ──────────────────────────────────────
  const access = orderAccessForCaller(req, order);
  if (!access.allowed) {
    if (!req.user) {
      throw httpError(401, {
        success: false,
        code: access.reason || 'SCAN_TOKEN_REQUIRED',
        message: 'Please re-scan the table QR code (or log in) to continue.',
      });
    }
    throw httpError(403, { success: false, message: 'You can only pay for your own orders' });
  }

  // ── Finalize a wallet-settled order ────────────────────────────────
  if (paymentStatus === 'Paid') {
    if (!req.user) {
      throw httpError(401, { success: false, message: 'Log in to complete this payment.' });
    }
    if (order.paymentStatus !== 'Paid') {
      throw httpError(409, {
        success: false,
        code: 'PAYMENT_NOT_SETTLED',
        message: 'Payment has not been received for this order yet.',
      });
    }
    if (String(order.paymentMethod || '').toLowerCase() !== 'wallet') {
      // Paid by Razorpay / staff — those paths already did the
      // bookkeeping. Nothing to do; report the current state.
      return reply(200, { success: true, order });
    }
    // Staff mark-paid (updateOrderStatus) already awards points; never
    // do it twice.
    const alreadyAwarded = await Transaction.exists({ order: order._id, type: 'points_earned' });
    if (alreadyAwarded) {
      return reply(200, { success: true, order });
    }
    // Atomically claim the one-time finalize.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, ...tf, paymentStatus: 'Paid', customerPaymentFinalizedAt: null },
      { $set: { customerPaymentFinalizedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!claimed) {
      return reply(200, { success: true, order });
    }
    await finalizeCustomerPaidOrder(req, claimed, tf);
    return reply(200, { success: true, order: claimed });
  }

  // ── Intent only ───────────────────────────────────────────────────
  // Don't allow re-payment on already paid orders
  if (order.paymentStatus === 'Paid') {
    throw httpError(400, { success: false, message: 'Order is already paid' });
  }

  const updateData = {};
  if (intentMethod) updateData.paymentMethod = intentMethod;
  const updatedOrder = Object.keys(updateData).length
    ? await Order.findOneAndUpdate({ _id: order._id, ...tf }, updateData, { returnDocument: 'after' })
    : order;

  return reply(200, { success: true, order: updatedOrder });
}

// Post-payment bookkeeping for a wallet-settled order: release the table
// when the order was already served, award loyalty points, and notify.
// Money fields are untouched — payWithWallet owns those.
async function finalizeCustomerPaidOrder(req, updatedOrder, tf) {
  // ── Free the table on terminal payment ───────────────────────────
  // Mirror updateOrderStatus: "served + Paid → release table".
  if (updatedOrder.status === 'served' && updatedOrder.table) {
    try {
      const { freedIds } = await freeTableOrUnmergeGroup(updatedOrder.table, tf);
      const ids = freedIds.length ? freedIds : [updatedOrder.table];
      for (const tid of ids) {
        emitStaffTable('table:updated', { tableId: tid, status: 'free' }, updatedOrder.branch);
      }
    } catch (err) {
      logger.warn('Failed to free table after customer payment:', err.message);
    }
  }

  if (!updatedOrder.user) return;

  const settings = await getSettings(req);
  const walletEnabled = settings?.wallet?.enableLoyalty !== false;
  const minBill = settings?.wallet?.minBillToEarn || 100;
  const pointsPerRupee = settings?.wallet?.pointsPerRupee || 1;
  const earnedPoints = (walletEnabled && updatedOrder.total >= minBill)
    ? Math.floor(updatedOrder.total * pointsPerRupee)
    : 0;

  if (earnedPoints > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { user: updatedOrder.user, ...tf },
      { $inc: { loyaltyPoints: earnedPoints }, $setOnInsert: { balance: 0, restaurant: tenantId(req) } },
      { upsert: true, returnDocument: 'after' }
    );
    await new Transaction({
      user: updatedOrder.user,
      order: updatedOrder._id,
      restaurant: tenantId(req),
      branch: updatedOrder.branch || null,
      type: 'points_earned',
      amount: earnedPoints,
      paymentMethod: 'points',
      transactionId: idGen.transactionId(),
      description: `Earned from Order ${updatedOrder.orderId}`,
      balanceBefore: wallet.loyaltyPoints - earnedPoints,
      balanceAfter: wallet.loyaltyPoints,
    }).save();
  }

  // Notifications + socket emits — after the response, never fatal.
  runAfterResponse('customerPayment notifications', async () => {
    await notifyPaymentConfirmed({
      order: updatedOrder, restaurant: updatedOrder.restaurant, earnedPoints, includePointsRow: false,
    });
    emitOrderEvent(
      'order:updated',
      { orderId: updatedOrder.orderId, status: updatedOrder.status, paymentStatus: updatedOrder.paymentStatus },
      updatedOrder
    );
  });
}
module.exports = {
  recordPaidOrderLedger,
  requestCounterPayment,
  applyCouponToOrder,
  customerPayment,
  finalizeCustomerPaidOrder,
  CUSTOMER_PAYMENT_INTENTS,
};
