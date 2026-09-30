const express = require('express');
const router = express.Router();
const promotionController = require('../controllers/promotionController');
const { protect, optionalAuth, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');

// ─── Validation (BUGS_REPORT #33) ─────────────────────────────────────
// Mirrors promotionController. Business rules (date order, % <= 100,
// discountValue > 0, max-cap sanity) stay in validateCouponBody so its
// messages keep reaching the Offers page; these chains reject wrong
// types / malformed ids that would otherwise crash (`code.toUpperCase()`
// on a non-string → 500) or reach Mongo as operator objects.
const optStr = (field, max, label = field) =>
    body(field).optional({ values: 'null' })
        .isString().withMessage(`${label} must be text`).bail()
        .isLength({ max }).withMessage(`${label} cannot exceed ${max} characters`);

// Optional non-negative number (JSON number or numeric string; '' is
// let through like the controller does — Mongoose casts it to null).
const optNonNeg = (field, message) =>
    body(field).optional({ values: 'null' })
        .custom((v) => v === '' || ((typeof v === 'number' || typeof v === 'string') && Number.isFinite(+v) && +v >= 0))
        .withMessage(message);

// Optional date: '' / null pass (Mongoose casts '' → null), anything
// else must parse.
const optDate = (field) =>
    body(field).optional({ values: 'falsy' })
        .custom((v) => (typeof v === 'string' || typeof v === 'number') && !Number.isNaN(new Date(v).getTime()))
        .withMessage(`${field} must be a valid date`);

const optBool = (field) =>
    body(field).optional().isBoolean().withMessage(`${field} must be true or false`);

const optEnum = (field, values, message) =>
    body(field).optional().isIn(values).withMessage(message || `Invalid ${field}`);

const couponChains = () => [
    optStr('code', 100, 'Coupon code'),
    optStr('title', 200, 'Title'),
    optStr('description', 2000, 'Description'),
    // Same enum + message as validateCouponBody / Coupon model.
    optEnum('discountType', ['percentage', 'fixed_amount', 'shipping_discount', 'bogo'],
        'Discount type must be "percentage" or "fixed_amount"'),
    // discountValue > 0 / <= 100 is enforced by the controller.
    body('discountValue').optional({ values: 'null' })
        .custom((v) => (typeof v === 'number' || typeof v === 'string') && v !== '' && Number.isFinite(+v))
        .withMessage('Discount value must be greater than 0'),
    optNonNeg('minOrderValue', 'Minimum order value cannot be negative'),
    optNonNeg('maxDiscountAmount', 'Max discount cap cannot be negative'),
    optNonNeg('usageLimit', 'Usage limit cannot be negative'),
    optNonNeg('usagePerUser', 'Usage per user cannot be negative'),
    optDate('startDate'),
    optDate('endDate'),
    optStr('startTime', 10, 'Start time'),
    optStr('endTime', 10, 'End time'),
    optEnum('couponCategory', ['all', 'specific_item', 'specific_category', 'first_order', 'specific_user']),
    optEnum('scope', ['all', 'food', 'beverages']),
    optBool('isActive'),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];

const createCouponRules = validate(couponChains());
const updateCouponRules = validate([objectIdParam('id', 'Invalid coupon id'), ...couponChains()]);
const deleteCouponRules = validate([objectIdParam('id', 'Invalid coupon id')]);

const createPromotionRules = validate([
    optStr('title', 200, 'Title'),
    optStr('description', 2000, 'Description'),
    optStr('image', 2048, 'Image'),
    optStr('link', 2048, 'Link'),
    optEnum('type', ['banner', 'popup', 'featured_item', 'offer']),
    optEnum('targetAudience', ['all', 'new_customers', 'loyal_customers', 'membership_holders']),
    optDate('startDate'),
    optDate('endDate'),
    optBool('isActive'),
    body('displayOrder').optional({ values: 'null' })
        .custom((v) => (typeof v === 'number' || typeof v === 'string') && v !== '' && Number.isFinite(+v))
        .withMessage('displayOrder must be a number'),
    optionalObjectId('body', 'branch', 'Invalid branch'),
]);

// Required-ness of code / orderValue stays with the controller (its
// messages are shown in the Cart). A non-string code used to 500 on
// `code.toUpperCase()`; an object orderValue compared oddly.
const applyCouponRules = validate([
    body('code').optional({ values: 'falsy' })
        .isString().withMessage('Please provide a coupon code').bail()
        .isLength({ max: 100 }).withMessage('Invalid or inactive coupon code'),
    body('orderValue').optional({ values: 'falsy' })
        .custom((v) => (typeof v === 'number' || typeof v === 'string') && Number.isFinite(+v))
        .withMessage('Invalid order value'),
    body('items').optional({ values: 'null' })
        .isArray({ max: 500 }).withMessage('items must be a list'),
]);

// Phase 2.5: customer-facing promotion reads and coupon application are
// gated behind `couponPromotions`. A Basic-plan tenant's customers get a
// clean "This restaurant doesn't offer coupons and promotions" 403 instead
// of seeing coupons they can't redeem or silently failing at apply-time.
const customerCouponGate = featureGate('couponPromotions');

// Public routes (customer-facing, gated)
router.get('/',               customerCouponGate, promotionController.getActivePromotions);
router.get('/coupons/active', customerCouponGate, promotionController.getActiveCoupons);

// Apply-coupon is logged-in customer ONLY. Guests (QR-scan diners with
// no JWT) get a 401 — coupon redemption needs an identity to enforce
// per-user usage limits + abuse tracking. The Cart UI already hides
// the coupon section for guests; this is the defence-in-depth gate.
router.post('/apply-coupon',    protect, customerCouponGate, applyCouponRules, promotionController.applyCoupon);
router.get('/customer/:userId', protect, customerCouponGate, promotionController.getCustomerCRM);

// Admin-only routes — gated behind `couponPromotions`.
// Specific paths must remain BEFORE the generic /coupons route.
const couponGate = [protect, adminOnly, attachTenant, featureGate('couponPromotions')];
router.get('/coupons/redemptions', ...couponGate, promotionController.getRedemptions);
router.get('/coupons/performance', ...couponGate, promotionController.getPerformanceStats);
router.post('/coupons',            ...couponGate, createCouponRules, promotionController.createCoupon);
router.get('/coupons',             ...couponGate, promotionController.getAllCoupons);
router.put('/coupons/:id',         ...couponGate, updateCouponRules, promotionController.updateCoupon);
router.delete('/coupons/:id',      ...couponGate, deleteCouponRules, promotionController.deleteCoupon);
router.post('/',                   ...couponGate, createPromotionRules, promotionController.createPromotion);

module.exports = router;
