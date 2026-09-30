/**
 * orderController — thin HTTP layer for /api/v1/orders (BUGS_REPORT #31).
 *
 * Every handler parses nothing itself: it hands `req` to a service in
 * Backend/services/ and sends what comes back. The services own the
 * business logic (they never touch `res`):
 *
 *   orderCreateService    POST /                       (createOrder pipeline)
 *   orderPricingService   cart pricing, coupon/points/wallet/delivery, tax,
 *                         append-items bill recompute
 *   orderItemsService     append items, repeat item / repeat order
 *   orderStatusService    status / payment PATCH, pickup, delivery dispatch
 *   orderPaymentService   paid-order ledger, customer payment, counter
 *                         payment request, apply coupon
 *   orderLifecycleService customer cancel, rating, admin cleanups
 *   orderQueryService     live / past / refunds / table / detail / my-orders
 *                         / kiosk tracking reads
 *   kitchenService        chef KDS, completed list, KOT reprint
 *   orderNotifications    notification + socket fan-out
 *   orderFormatters       response-row shapes (frontend contract)
 *   orderHelpers, orderAccess, orderErrors — shared building blocks
 *
 * Handler names, routes and response bodies are unchanged; each handler
 * keeps its original 500 log line and body.
 */
const logger = require('../utils/logger');
const { runAfterResponse } = require('../services/orderHelpers');
const { isOrderHttpError } = require('../services/orderErrors');
const orderCreateService = require('../services/orderCreateService');
const orderQueryService = require('../services/orderQueryService');
const kitchenService = require('../services/kitchenService');
const orderStatusService = require('../services/orderStatusService');
const orderLifecycleService = require('../services/orderLifecycleService');
const orderPaymentService = require('../services/orderPaymentService');
const orderItemsService = require('../services/orderItemsService');

// ── Thin-controller plumbing ────────────────────────────────────────
// Services return { status, body, after } (services/orderErrors.reply)
// or throw an OrderHttpError for an early 4xx exit. `after` holds
// post-response tasks (notifications / socket fan-out) that run once
// the response has gone out, exactly as the inline handlers did.
function sendResult(res, result) {
  res.status(result.status).json(result.body);
  for (const [label, task] of result.after || []) runAfterResponse(label, task);
}

// Run a service call; OrderHttpErrors are sent verbatim, anything else
// goes to the handler's own (unchanged) 500 path.
async function run(res, work, onError) {
  try {
    sendResult(res, await work());
  } catch (error) {
    if (isOrderHttpError(error)) return res.status(error.status).json(error.body);
    return onError(error);
  }
}

// Create a new order — see services/orderCreateService.js
exports.createOrder = (req, res) => run(res, () => orderCreateService.createOrder(req), (error) => {
  // One_active_order_per_table unique index — only reachable from
  // here when the pre-save reconciliation block missed the existing
  // order (e.g. a concurrent create slipped between the findOne and
  // save) or when the caller is staff. Staff have their own /append
  // route so we still return 409 with a clear code rather than
  // silently appending. Customers/guests should not reach this branch
  // under normal flow.
  if (error && error.code === 11000 && /one_active_order_per_table/.test(error.message || '')) {
    return res.status(409).json({
      success: false,
      code: 'ACTIVE_ORDER_EXISTS',
      message: 'This table already has an active order. Please ask staff to add items to it.',
    });
  }
  logger.error('Error creating order:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to create order', error: error.message });
});

// Kiosk order tracking (X-Kiosk-Token) — see services/orderQueryService.js
exports.trackKioskOrder = (req, res) => run(res, () => orderQueryService.trackKioskOrder(req), (error) => {
  logger.error('trackKioskOrder error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Could not load order status.' });
});

exports.getLiveOrders = (req, res) => run(res, () => orderQueryService.getLiveOrders(req), () => {
  res.status(500).json({ success: false, message: 'Failed to fetch active orders' });
});

// GET /orders/past — see services/orderQueryService.js
exports.getPastOrders = (req, res) => run(res, () => orderQueryService.getPastOrders(req), (error) => {
  logger.error('getPastOrders failed', { error: error.message, stack: error.stack });
  res.status(500).json({ success: false, message: 'Failed to fetch past orders' });
});

// GET /orders/refunds — admin Refunds dashboard feed
exports.getRefunds = (req, res) => run(res, () => orderQueryService.getRefunds(req), (error) => {
  logger.error('Get Refunds Error', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch refunds' });
});

// Delivery dispatch lifecycle — PATCH /:id/delivery
exports.updateDeliveryStatus = (req, res) => run(res, () => orderStatusService.updateDeliveryStatus(req), (error) => {
  logger.error('updateDeliveryStatus failed:', error);
  return res.status(500).json({ success: false, message: error.message });
});

// Staff status / payment update — see services/orderStatusService.js
exports.updateOrderStatus = (req, res) => run(res, () => orderStatusService.updateOrderStatus(req), (error) => {
  logger.error('Update Order Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to update order' });
});

// Cancel an order (customer-facing)
exports.cancelOrder = (req, res) => run(res, () => orderLifecycleService.cancelOrder(req), (error) => {
  logger.error('Cancel Order Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to cancel order', error: error.message });
});

// Every active unpaid order on a table (independent-orders model)
exports.getActiveOrdersListByTable = (req, res) => run(res, () => orderQueryService.getActiveOrdersListByTable(req), (error) => {
  logger.error('Get Active Orders List By Table Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch active orders' });
});

// Active order for a table (includes served but unpaid orders)
exports.getActiveOrderByTable = (req, res) => run(res, () => orderQueryService.getActiveOrderByTable(req), (error) => {
  logger.error('Get Active Order By Table Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch active order' });
});

// Customer "Pay at Counter" request
exports.requestCounterPayment = (req, res) => run(res, () => orderPaymentService.requestCounterPayment(req), (error) => {
  logger.error('requestCounterPayment error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to request counter payment' });
});

// Pick up an order (Waiter marks as served) and frees the table
exports.pickupOrder = (req, res) => run(res, () => orderStatusService.pickupOrder(req), (error) => {
  logger.error('Pickup Order Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to pick up order', error: error.message });
});

exports.repeatOrderItem = (req, res) => run(res, () => orderItemsService.repeatOrderItem(req), (error) => {
  logger.error('Repeat Order Item Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to repeat item' });
});

// Repeat ALL items from a past order in a single call
exports.repeatOrderAllItems = (req, res) => run(res, () => orderItemsService.repeatOrderAllItems(req), (error) => {
  if (error && error.code === 11000 && /one_active_order_per_table/.test(error.message || '')) {
    return res.status(409).json({
      success: false,
      code: 'ACTIVE_ORDER_EXISTS',
      message: 'This table already has an active order. Please ask staff to add items to it.',
    });
  }
  logger.error('Repeat Order All Items Error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to repeat order' });
});

// Re-fire a KOT to the kitchen — see services/kitchenService.js
exports.reprintKOT = (req, res) => run(res, () => kitchenService.reprintKOT(req), (error) => {
  logger.error('Reprint KOT Error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to reprint KOT' });
});

// Append items to an existing active order (second / third KOT round)
exports.appendOrderItems = (req, res) => run(res, () => orderItemsService.appendOrderItems(req), (error) => {
  logger.error('Append Order Items Error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to add items to order' });
});

// Apply (or clear) a coupon on an existing active order
exports.applyCouponToOrder = (req, res) => run(res, () => orderPaymentService.applyCouponToOrder(req), (error) => {
  logger.error('applyCouponToOrder error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to apply coupon' });
});

// Single order by ID (customer tracking)
exports.getOrderById = (req, res) => run(res, () => orderQueryService.getOrderById(req), (error) => {
  logger.error('Get Order By ID Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch order' });
});

// Orders for the logged-in customer
exports.getMyOrders = (req, res) => run(res, () => orderQueryService.getMyOrders(req), (error) => {
  logger.error('Get My Orders Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch your orders' });
});

// Kitchen orders (chef dashboard) — see services/kitchenService.js
exports.getKitchenOrders = (req, res) => run(res, () => kitchenService.getKitchenOrders(req), (error) => {
  logger.error('Kitchen Orders Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to fetch kitchen orders' });
});

// Customer payment intent / wallet finalize — see services/orderPaymentService.js
exports.customerPayment = (req, res) => run(res, () => orderPaymentService.customerPayment(req), (error) => {
  logger.error('Customer Payment Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to process payment' });
});

// PATCH /orders/:id/rating
exports.rateOrder = (req, res) => run(res, () => orderLifecycleService.rateOrder(req), (error) => {
  logger.error('Rate Order Error:', { error: error.message });
  res.status(500).json({ success: false, message: 'Failed to submit rating' });
});

// Admin: bulk-cancel stale "ready" orders — see services/orderLifecycleService.js
exports.cleanupStaleReadyOrders = (req, res) => run(res, () => orderLifecycleService.cleanupStaleReadyOrders(req), (error) => {
  logger.error('Cleanup Stale Ready Orders Error:', { error: error.message, stack: error.stack });
  res.status(500).json({ success: false, message: 'Failed to clean up stale orders' });
});

// Admin: run the empty-order sweep now (scoped to the caller's tenant)
exports.cleanupEmptyOrdersNow = (req, res) => run(res, () => orderLifecycleService.cleanupEmptyOrdersNow(req), (error) => {
  logger.error('Cleanup Empty Orders Error:', { error: error.message });
  return res.status(500).json({ success: false, message: 'Failed to run empty-order cleanup' });
});

// GET /orders/kitchen/completed
exports.getCompletedKitchenOrders = (req, res) => run(res, () => kitchenService.getCompletedKitchenOrders(req), (error) => {
  logger.error('getCompletedKitchenOrders failed:', error);
  res.status(500).json({ success: false, message: 'Failed to fetch completed orders' });
});
