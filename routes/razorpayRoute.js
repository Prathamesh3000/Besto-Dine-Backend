const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const {
    createRazorpayOrder,
    verifyPayment,
    handleWebhook,
    refundPayment,
    refundOrphanPayment,
    createWalletRechargeOrder,
    verifyWalletRecharge,
    reconcilePayments,
} = require('../controllers/razorpayController');
const { optionalAuth, protect, adminOnly, checkPermission, noWaiterBilling } = require('../middlewares/authMiddleware');
const { idempotency } = require('../middlewares/idempotency');
const { featureGate } = require('../middlewares/featureGate');
const { validate, body } = require('../middlewares/validate');

// BUGS_REPORT #33 — request shape checks. Amount rules / required-field
// messages stay in the controller (the checkout UI toasts them); these
// only reject wrong types before they reach Mongo lookups (an object
// cafeOrderId / orderId would otherwise act as a query operator) or the
// HMAC code. Validation runs before idempotency() so a malformed body
// doesn't burn / cache an Idempotency-Key. The /webhook route is
// deliberately NOT validated — its raw body must reach the signature
// check untouched.

// Order reference: Mongo _id or human orderId (string; tolerate numbers).
const optionalOrderRef = (field) => body(field)
    .optional({ values: 'falsy' })
    .custom((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 100)
    .withMessage(`Invalid ${field}`);

const optionalText = (field, max) => body(field)
    .optional({ values: 'null' })
    .isString().withMessage(`${field} must be text`).bail()
    .isLength({ max }).withMessage(`${field} is too long`);

// Checkout triple: missing → same message the controller uses; present
// → must be a non-empty string of sane length (format not constrained).
const razorpayField = (field, message = 'Payment details are required', max = 256) => body(field)
    .exists({ values: 'falsy' }).withMessage(message).bail()
    .isString().withMessage(`Invalid ${field}`).bail()
    .isLength({ min: 1, max }).withMessage(`Invalid ${field}`);
const optionalRazorpayField = (field, max = 256) => body(field)
    .optional({ values: 'falsy' })
    .isString().withMessage(`Invalid ${field}`).bail()
    .isLength({ max }).withMessage(`Invalid ${field}`);

const createOrderValidation = validate([
    optionalOrderRef('cafeOrderId'),
    optionalText('receipt', 100),
]);

const verifyPaymentValidation = validate([
    razorpayField('razorpay_order_id'),
    razorpayField('razorpay_payment_id'),
    razorpayField('razorpay_signature'),
    optionalOrderRef('cafeOrderId'),
]);

const refundValidation = validate([
    // Missing → controller's "Order ID is required"; amount type/range is
    // enforced by the controller against the order's refundable balance.
    optionalOrderRef('orderId'),
    optionalText('reason', 1000),
]);

const orphanRefundValidation = validate([
    // Missing / non-string id → controller's PAYMENT_ID_REQUIRED response.
    optionalRazorpayField('razorpay_order_id'),
    optionalRazorpayField('razorpay_signature'),
    optionalText('reason', 1000),
]);

const verifyWalletRechargeValidation = validate([
    razorpayField('razorpay_order_id'),
    razorpayField('razorpay_payment_id'),
    razorpayField('razorpay_signature'),
]);

// Rate limiters for payment endpoints
const paymentCreateLimiter = makeLimiter({ name: 'rzp-create',
    windowMs: 60 * 1000,   // 1 minute
    max: 10,               // 10 order creations per minute per IP
    message: { success: false, message: 'Too many payment requests. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const paymentVerifyLimiter = makeLimiter({ name: 'rzp-verify',
    windowMs: 60 * 1000,
    max: 20,               // 20 verifications per minute per IP
    message: { success: false, message: 'Too many verification attempts. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const refundLimiter = makeLimiter({ name: 'rzp-refund',
    windowMs: 60 * 1000,
    max: 5,                // 5 refunds per minute per IP
    message: { success: false, message: 'Too many refund requests. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Public — guest checkout support (rate limited)
// Plan gate: starting a NEW online payment needs the paymentGateway module.
// Verify / webhook / refund endpoints are deliberately left open so a
// payment already in flight (or money already taken) can always settle.
const gatewayGate = featureGate('paymentGateway');
router.post('/create-order', paymentCreateLimiter, optionalAuth, noWaiterBilling, gatewayGate, createOrderValidation, createRazorpayOrder);
// CRIT-16 — verify / refund endpoints are idempotent. Clients send a stable
// Idempotency-Key (e.g. the Razorpay order_id); retries replay the cached
// response. { required: true } makes the key mandatory once env flag
// IDEMPOTENCY_ENFORCE is on (default off until all clients ship) and makes
// the record store fail CLOSED when a key is present.
router.post('/verify-payment', paymentVerifyLimiter, optionalAuth, noWaiterBilling, verifyPaymentValidation, idempotency({ required: true }), verifyPayment);

// Webhook — called by Razorpay server-to-server (no auth, signature verified in handler)
router.post('/webhook', handleWebhook);

// Refund — admin/staff with refund permission only (rate limited)
router.post('/refund', refundLimiter, protect, adminOnly, checkPermission('refund'), refundValidation, idempotency({ required: true }), refundPayment);

// Auto-refund for the "charged but order failed" edge case. The customer
// (or guest, on QR scan) calls this from their payment-handler catch
// block when POST /orders rejected after Razorpay captured. Tenant-gated
// inside the controller via the notes.restaurantId stamp we put on the
// Razorpay order at create-order time. Rate-limited with the refund
// limiter so a misbehaving client can't grind us into Razorpay's API.
router.post('/orphan-refund', refundLimiter, optionalAuth, orphanRefundValidation, idempotency({ required: true }), refundOrphanPayment);

// Wallet recharge via Razorpay — authenticated users (rate limited)
router.post('/create-wallet-recharge', paymentCreateLimiter, protect, featureGate('walletLoyalty'), gatewayGate, createWalletRechargeOrder);
router.post('/verify-wallet-recharge', paymentVerifyLimiter, protect, verifyWalletRechargeValidation, idempotency({ required: true }), verifyWalletRecharge);

// Payment reconciliation — admin only
router.get('/reconcile', protect, adminOnly, reconcilePayments);

module.exports = router;
