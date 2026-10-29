const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const { ipKeyGenerator } = require('express-rate-limit');
const orderController = require('../controllers/orderController');
const { protect, staffOnly, optionalAuth, checkPermission, restrictTo, adminOnly, noWaiterBilling, noWaiterBillingFields } = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');
const { idempotency } = require('../middlewares/idempotency');
const ov = require('../validators/ops');

// Phase 2.5: createOrder accepts both dine-in and takeaway, so the
// feature gate is picked dynamically from `req.body.type`. Tenants on a
// plan without the relevant feature get a clean 403 ("This restaurant
// doesn't offer takeaway ordering") instead of a silent order create.
const dynamicOrderGate = (req, res, next) => {
    const isTakeaway = req.body?.type === 'takeaway';
    const feature = isTakeaway ? 'takeaway' : 'dineIn';
    return featureGate(feature)(req, res, (err) => {
        if (err) return next(err);
        // Self-order kiosk is its own paid module. orderCreateService only
        // honours source='kiosk' from an unauthenticated caller, so that's
        // exactly the set of requests that must carry the kiosk feature.
        if (req.body?.source === 'kiosk' && !req.user) return kioskGate(req, res, next);
        return next();
    });
};
const kioskGate = featureGate('kiosk');
const kitchenGate = featureGate('kitchenDisplay');

// CRIT-13 — per-actor rate limit on POST /orders (5/min customers,
// guests by tableId, anonymous by IP; 60/min per staff user). Lives in
// middlewares/orderCreateLimiter.js so the tiers are unit-testable; it
// MUST sit after optionalAuth so `req.user` is populated when the key
// and the tier are chosen.
const { orderCreateLimiter } = require('../middlewares/orderCreateLimiter');

// Customer-facing (createOrder allows guest orders via QR scan, so no strict auth)
// Bug #13 — `Idempotency-Key` header replays the first response on a
// retry (placed after optionalAuth so the key can be scoped per caller).
// The body `clientIdempotencyKey` is the second, DB-level safety net.
router.post('/', optionalAuth, orderCreateLimiter, ov.orderCreate, idempotency({ required: true }), dynamicOrderGate, orderController.createOrder);

// Home-delivery distance + fee quote for the takeaway checkout. Guests
// allowed (takeaway supports guest checkout); rate-limited because an
// address-only quote may call the external geocoder.
const deliveryQuoteLimiter = makeLimiter({
    name: 'delivery-quote',
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?._id ? 'user:' + String(req.user._id) : 'ip:' + ipKeyGenerator(req.ip)),
    message: { success: false, code: 'DELIVERY_QUOTE_RATE_LIMIT', message: 'Too many delivery checks. Please wait a moment.' },
});
router.post('/delivery-quote', optionalAuth, deliveryQuoteLimiter, ov.orderDeliveryQuote, featureGate('takeaway'), require('../controllers/deliveryController').getDeliveryQuote);

// Staff-only routes
router.get('/live', protect, staffOnly, orderController.getLiveOrders);
router.get('/past', protect, staffOnly, orderController.getPastOrders);
router.get('/refunds', protect, staffOnly, orderController.getRefunds);
router.get('/kitchen', protect, staffOnly, kitchenGate, checkPermission('accessKitchen'), orderController.getKitchenOrders);
// Completed list behind the chef dashboard's "Completed" badge. That
// badge was a read-only count with nothing to open — the chef could
// see that 34 orders went out but not which.
router.get('/kitchen/completed', protect, staffOnly, kitchenGate, checkPermission('accessKitchen'), orderController.getCompletedKitchenOrders);
// Floor staff may CANCEL without the general `updateOrderStatus` flag.
// Waiters ship with updateOrderStatus=false (they shouldn't be moving
// kitchen state or marking bills paid), so the waiter app's Cancel
// button hit a flat 403 "Missing permission: updateOrderStatus" on
// every tap. A body that is purely a cancellation (status + optional
// reason, no payment fields) is let through for waiter/captain; the
// controller's lifecycle rules (reason for prepared food, captain for
// served orders, branch pin) still apply.
const CANCEL_ONLY_KEYS = new Set(['status', 'cancellationReason']);
const allowStatusUpdateOrFloorCancel = (req, res, next) => {
    const body = req.body || {};
    const isPureCancel = body.status === 'cancelled'
        && Object.keys(body).every((k) => CANCEL_ONLY_KEYS.has(k));
    if (isPureCancel && ['waiter', 'captain'].includes(req.user?.role)) return next();
    return checkPermission('updateOrderStatus')(req, res, next);
};
// Marking an order Paid (paymentStatus / amountPaid in the body) moves money, so
// it needs an Idempotency-Key (enforced once IDEMPOTENCY_ENFORCE is on).
// Ordinary status changes (preparing/ready/served/cancel) stay key-optional.
const settlesPaymentViaStatus = (req) => {
    const b = req.body || {};
    return b.paymentStatus !== undefined || b.amountPaid !== undefined || b.payments !== undefined;
};
router.patch('/:id/status', protect, staffOnly, noWaiterBillingFields, allowStatusUpdateOrFloorCancel, ov.orderStatus, idempotency({ requiredWhen: settlesPaymentViaStatus }), orderController.updateOrderStatus);
// Pickup is a waiter/captain duty (ready → served). It's not order creation,
// so `addOrders` was semantically wrong — waiters without that flag ticked
// were locked out of their core serving workflow. Role-gate instead, matching
// the /append route below.
router.patch('/:id/pickup', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), ov.orderIdOnly, orderController.pickupOrder);

// Home-delivery dispatch lifecycle (assign partner, mark out-for-delivery
// / delivered). Supervisory task — captain/admin/manager, not plain waiter.
router.patch('/:id/delivery', protect, restrictTo('captain', 'admin', 'manager'), ov.orderDelivery, orderController.updateDeliveryStatus);

// Admin-only: bulk-cancel takeaway orders stuck in 'ready' (abandoned pickups).
// Accepts { minutesOld, type, dryRun } — see controller for details.
router.post('/admin/cleanup-stale', protect, adminOnly, ov.orderCleanup, orderController.cleanupStaleReadyOrders);

// Admin-only: force-run the empty-order sweep right now. Same logic
// as the scheduled version, just triggered on demand so an operator
// can unstick a table without waiting for the next interval.
router.post('/admin/cleanup-empty', protect, adminOnly, orderController.cleanupEmptyOrdersNow);

// Append items to an existing active dine-in order (second / third KOT round).
// Captain and waiter only — chef and other staff roles don't place orders.
router.post(
    '/:id/append',
    protect,
    restrictTo('waiter', 'captain', 'admin', 'manager'),
    ov.orderAppend,
    idempotency(),
    orderController.appendOrderItems
);

// Apply / clear a coupon on an existing active order. Persists
// couponCode + couponDiscount on the order doc and emits `order:updated`
// so the admin drawer, waiter bill and customer bill preview all
// refresh to the new total in one shot. Staff-only; customers apply
// coupons at the /promotions/apply-coupon stage before checkout.
router.patch(
    '/:id/coupon',
    protect,
    restrictTo('waiter', 'captain', 'admin', 'manager'),
    noWaiterBilling,
    ov.orderCoupon,
    orderController.applyCouponToOrder
);

// Bill workspace (Phase 3, D4): Save Bill (draft | final), Reopen (captain+
// with a reason) and Bill Preview (the exact slip the printer would get).
router.post('/:id/bill/save', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, ov.orderBillSave, orderController.saveBill);
router.post('/:id/bill/reopen', protect, restrictTo('captain', 'admin', 'manager'), ov.orderBillReopen, orderController.reopenBill);
router.get('/:id/bill/preview', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, orderController.previewBill);
// UPI QR for the amount due now (restaurant's own UPI id). Captain/admin/manager; waiters get 403 BILLING_CAPTAIN_ONLY.
router.get('/:id/upi-qr', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, orderController.upiQr);

// Re-fire the KOT socket event for an existing order — used by the
// Admin "KOT" drawer button to re-alert the kitchen without modifying
// the order. Same audience as appendItems.
router.post(
    '/:id/reprint-kot',
    protect,
    restrictTo('waiter', 'captain', 'admin', 'manager'),
    ov.orderIdOnly,
    orderController.reprintKOT
);

// Authenticated customer routes
router.get('/my-orders', protect, orderController.getMyOrders);

// Order detail — optionalAuth so guests can track via QR session,
// but the controller enforces ownership for authenticated users
router.get('/:id/detail', optionalAuth, orderController.getOrderById);
// KOT rounds of an order (second / third KOT) — staff only.
router.get('/:id/kots', protect, staffOnly, orderController.getOrderKots);

// Kiosk-only order tracking. The kiosk has no auth and no scan token,
// so getOrderById would 404 it. The token returned at create time
// (X-Kiosk-Token) is the credential here. Returns minimal status
// fields only (no PII), suitable for a 5-second polling loop.
router.get('/track/:orderId', orderController.trackKioskOrder);
router.get('/active/table/:tableId', optionalAuth, orderController.getActiveOrderByTable);
// Independent-orders model — `/active/table/:id` still returns ONE
// (the most recent) for backwards-compat with single-order callers.
// New callers that need to render every unpaid order on the table
// (admin drawer, dine-in bill aggregation, customer "all my orders
// on this table" view) hit `/active-list` and get an array instead.
router.get('/active-list/table/:tableId', optionalAuth, orderController.getActiveOrdersListByTable);

// Customer payment — controller enforces ownership
router.patch('/:id/payment', optionalAuth, ov.orderPayment, idempotency({ required: true }), orderController.customerPayment);

// Customer requests "settle at counter" — flags the order for the
// admin table drawer's red alert banner so a waiter can be sent with
// a bill slip. optionalAuth keeps it usable from the guest QR flow.
router.post('/:id/request-counter-payment', optionalAuth, ov.orderIdOnly, orderController.requestCounterPayment);

// Cancel, rate & repeat — optionalAuth so guests can still operate via QR session,
// controller enforces ownership for authenticated users
router.patch('/:id/cancel', optionalAuth, ov.orderIdOnly, orderController.cancelOrder);
router.patch('/:id/rating', optionalAuth, ov.orderRating, orderController.rateOrder);
router.post('/:orderId/repeat/:itemId', optionalAuth, ov.orderRepeatItem, idempotency(), orderController.repeatOrderItem);
// Repeat an entire past order in one shot (customer "Repeat Order" button).
router.post('/:id/repeat-all',           optionalAuth, ov.orderRepeatAll, idempotency(), orderController.repeatOrderAllItems);

module.exports = router;
