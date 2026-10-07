const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const { ipKeyGenerator } = require('express-rate-limit');
const orderController = require('../controllers/orderController');
const { protect, staffOnly, optionalAuth, checkPermission, restrictTo, adminOnly } = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');
const { idempotency } = require('../middlewares/idempotency');

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

// CRIT-13 — per-table / per-user rate limit on POST /orders.
// The global 200/min limiter is per-IP and too generous for guest
// traffic on a QR flow where one scanToken could be shared (or leaked)
// across devices. This keyed limiter caps to 5 order creates per minute
// per logical actor: authenticated users by userId (trusted), guests by
// the tableId they're ordering for. Covers both dine-in table spam and
// takeaway-from-guest scenarios.
//
// Still memory-backed — Redis-backed clustering is Phase 8 (op infra).
// In a multi-node deploy each node enforces 5/min independently, which
// is still dramatically tighter than no per-actor cap.
const orderCreateLimiter = makeLimiter({
    name: 'order-create',
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?._id) return 'user:' + String(req.user._id);
        const tableId = req.body?.tableId || req.body?.table;
        if (tableId) return 'table:' + String(tableId);
        // IPv6-safe fallback. Raw req.ip would let an attacker rotate the
        // low 64 bits of an IPv6 address to bypass the limit; the helper
        // normalises to a /56 CIDR block per express-rate-limit v8.
        return 'ip:' + ipKeyGenerator(req.ip);
    },
    message: {
        success: false,
        code: 'ORDER_RATE_LIMIT',
        message: 'Too many orders in a short time. Please wait a moment before trying again.',
    },
});

// Customer-facing (createOrder allows guest orders via QR scan, so no strict auth)
// Bug #13 — `Idempotency-Key` header replays the first response on a
// retry (placed after optionalAuth so the key can be scoped per caller).
// The body `clientIdempotencyKey` is the second, DB-level safety net.
router.post('/', orderCreateLimiter, optionalAuth, idempotency(), dynamicOrderGate, orderController.createOrder);

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
router.post('/delivery-quote', optionalAuth, deliveryQuoteLimiter, featureGate('takeaway'), require('../controllers/deliveryController').getDeliveryQuote);

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
router.patch('/:id/status', protect, staffOnly, allowStatusUpdateOrFloorCancel, orderController.updateOrderStatus);
// Pickup is a waiter/captain duty (ready → served). It's not order creation,
// so `addOrders` was semantically wrong — waiters without that flag ticked
// were locked out of their core serving workflow. Role-gate instead, matching
// the /append route below.
router.patch('/:id/pickup', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), orderController.pickupOrder);

// Home-delivery dispatch lifecycle (assign partner, mark out-for-delivery
// / delivered). Supervisory task — captain/admin/manager, not plain waiter.
router.patch('/:id/delivery', protect, restrictTo('captain', 'admin', 'manager'), orderController.updateDeliveryStatus);

// Admin-only: bulk-cancel takeaway orders stuck in 'ready' (abandoned pickups).
// Accepts { minutesOld, type, dryRun } — see controller for details.
router.post('/admin/cleanup-stale', protect, adminOnly, orderController.cleanupStaleReadyOrders);

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
    orderController.applyCouponToOrder
);

// Re-fire the KOT socket event for an existing order — used by the
// Admin "KOT" drawer button to re-alert the kitchen without modifying
// the order. Same audience as appendItems.
router.post(
    '/:id/reprint-kot',
    protect,
    restrictTo('waiter', 'captain', 'admin', 'manager'),
    orderController.reprintKOT
);

// Authenticated customer routes
router.get('/my-orders', protect, orderController.getMyOrders);

// Order detail — optionalAuth so guests can track via QR session,
// but the controller enforces ownership for authenticated users
router.get('/:id/detail', optionalAuth, orderController.getOrderById);

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
router.patch('/:id/payment', optionalAuth, idempotency(), orderController.customerPayment);

// Customer requests "settle at counter" — flags the order for the
// admin table drawer's red alert banner so a waiter can be sent with
// a bill slip. optionalAuth keeps it usable from the guest QR flow.
router.post('/:id/request-counter-payment', optionalAuth, orderController.requestCounterPayment);

// Cancel, rate & repeat — optionalAuth so guests can still operate via QR session,
// controller enforces ownership for authenticated users
router.patch('/:id/cancel', optionalAuth, orderController.cancelOrder);
router.patch('/:id/rating', optionalAuth, orderController.rateOrder);
router.post('/:orderId/repeat/:itemId', optionalAuth, idempotency(), orderController.repeatOrderItem);
// Repeat an entire past order in one shot (customer "Repeat Order" button).
router.post('/:id/repeat-all',           optionalAuth, idempotency(), orderController.repeatOrderAllItems);

module.exports = router;
