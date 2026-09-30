const express = require('express');
const router = express.Router();
const controller = require('../controllers/advanceBookingController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const {
    validate, body, objectIdParam, optionalObjectId, isObjectIdLike,
} = require('../middlewares/validate');

// All endpoints start with /api/advance-booking (as registered in server.js)

// Phase 2.5: customer-facing routes are now gated by feature flags too.
// `POST /create` can book either a table or a hall, so we pick the
// feature to check dynamically from `req.body.bookingType`. Customers
// of a Basic-plan tenant get a clean "This restaurant doesn't offer
// advance table bookings" 403 instead of succeeding silently.
const dynamicAdvanceBookingGate = (req, res, next) => {
    const isHall = req.body?.bookingType === 'hall';
    const feature = isHall ? 'advanceBookingHall' : 'advanceBookingTable';
    return featureGate(feature)(req, res, next);
};

// BUGS_REPORT #33 — shape checks for POST /create. The payload is the
// whole multi-step wizard state (lots of display-only extras), so only
// the fields that reach Mongo queries / schema-cast fields are checked.
// Business rules (required date, guest range, hall duration, capacity…)
// stay in the controller so its messages reach the UI unchanged.
const optionalIdList = (field, max = 100) => body(field)
    .optional({ values: 'null' })
    .custom((v) => Array.isArray(v) && v.length <= max && v.every(isObjectIdLike))
    .withMessage(`${field} must be a list of valid ids`);
const optionalShortString = (field, max) => body(field)
    .optional({ values: 'null' })
    .isString().withMessage(`${field} must be a string`).bail()
    .isLength({ max }).withMessage(`${field} is too long`);

const createBookingValidation = validate([
    body('bookingType')
        .isIn(['table', 'hall']).withMessage('Booking type must be "table" or "hall"'),
    optionalObjectId('body', 'selectedHallId', 'Invalid hall selected'),
    optionalIdList('selectedTableIds'),
    // selectedTypes[0] becomes AdvanceBooking.area (ObjectId).
    optionalIdList('selectedTypes', 50),
    optionalObjectId('body', 'areaId'),
    body('selectedTimeType')
        .optional({ values: 'falsy' })
        .isIn(['Lunch', 'Dinner']).withMessage('Time slot must be Lunch or Dinner'),
    optionalShortString('selectedTime', 50),
    body('walletPointsUsed')
        .optional({ values: 'falsy' })
        .isFloat({ min: 0, max: 10000000 }).withMessage('Invalid wallet points amount'),
    // couponCode feeds a Coupon lookup — must be a plain string.
    optionalShortString('couponCode', 64),
    optionalShortString('paymentMethod', 50),
    optionalShortString('specialMessage', 1000),
    optionalShortString('razorpayPaymentId', 200),
    optionalShortString('razorpay_order_id', 200),
    optionalShortString('razorpay_signature', 512),
]);

// Create a new booking (Logged in users only)
router.post('/create', protect, dynamicAdvanceBookingGate, createBookingValidation, controller.createAdvanceBooking);

// Get bookings for the logged-in customer — gated by the base advance
// booking feature. A customer of a tenant without the feature has
// nothing to list anyway, so returning 403 is the right behavior.
// (must be BEFORE admin-only routes because of the /:id catch-all)
router.get('/my-bookings', protect, featureGate('advanceBookingTable'), controller.getMyBookings);

// Customer-initiated "pay the remaining balance before event" flow.
// Both endpoints validate that the booking belongs to req.user inside
// the controller — no adminOnly guard. The customer router segment
// MUST come before the /:id admin routes because of the path overlap.
router.post('/:id/create-remaining-payment',
    protect, featureGate('advanceBookingTable'), validate([objectIdParam('id', 'Invalid booking id')]), controller.createRemainingPaymentOrder);
router.post('/:id/verify-remaining-payment',
    protect, featureGate('advanceBookingTable'), validate([objectIdParam('id', 'Invalid booking id')]), controller.verifyRemainingPayment);

// CUS-075 — customer self-cancellation with refund-per-policy.
// Preview is GET so the modal can render the exact refund tier before
// the customer commits; cancel is POST to do the work.
router.get('/:id/cancel-preview',
    protect, featureGate('advanceBookingTable'), validate([objectIdParam('id', 'Invalid booking id')]), controller.previewCancellation);
router.post('/:id/cancel',
    protect, featureGate('advanceBookingTable'), validate([objectIdParam('id', 'Invalid booking id')]), controller.cancelMyBooking);

// Admin management — gated behind `advanceBookingTable`
router.get('/all',          protect, adminOnly, attachTenant, featureGate('advanceBookingTable'), controller.getAdvanceBookings);
const bookingIdParam = validate([objectIdParam('id', 'Invalid booking id')]);
router.get('/:id',          protect, adminOnly, attachTenant, featureGate('advanceBookingTable'), bookingIdParam, controller.getBookingById);
router.patch('/:id/status', protect, adminOnly, attachTenant, featureGate('advanceBookingTable'), validate([
    objectIdParam('id', 'Invalid booking id'),
    body('status').isIn(['Pending', 'Confirmed', 'Completed', 'Cancelled'])
        .withMessage('Invalid status. Must be one of: Pending, Confirmed, Completed, Cancelled'),
]), controller.updateStatus);
router.delete('/:id',       protect, adminOnly, attachTenant, featureGate('advanceBookingTable'), bookingIdParam, controller.deleteBooking);

// Admin "Edit booking" (BookingDrawer). Explicit allowlist — any other
// body key is rejected so this can never rewrite dates, tables, payment
// references or status. Pricing is recomputed server-side from the
// difference of each edited component (utils/advanceBookingPricing).
const DETAILS_KEYS = new Set(['cakes', 'addons', 'parking', 'discount']);
const detailsValidation = validate([
    objectIdParam('id', 'Invalid booking id'),
    body().custom((b) => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Invalid request body');
        const extra = Object.keys(b).filter((k) => !DETAILS_KEYS.has(k));
        if (extra.length) throw new Error(`Field(s) not editable: ${extra.join(', ')}`);
        if (!Object.keys(b).length) throw new Error('Nothing to update');
        return true;
    }),
    body('cakes').optional().isArray({ max: 20 }).withMessage('cakes must be a list (max 20)'),
    body('cakes.*.name').isString().withMessage('Cake name is required').bail()
        .trim().isLength({ min: 1, max: 100 }).withMessage('Cake name must be 1-100 characters'),
    body('cakes.*.price').isFloat({ min: 0, max: 1000000 }).withMessage('Cake price must be between 0 and 1000000'),
    body('cakes.*.quantity').isInt({ min: 1, max: 100 }).withMessage('Cake quantity must be between 1 and 100'),
    body('addons').optional().isArray({ max: 30 }).withMessage('addons must be a list (max 30)'),
    body('addons.*.title').isString().withMessage('Add-on name is required').bail()
        .trim().isLength({ min: 1, max: 100 }).withMessage('Add-on name must be 1-100 characters'),
    body('addons.*.price').isFloat({ min: 0, max: 1000000 }).withMessage('Add-on price must be between 0 and 1000000'),
    body('parking').optional().custom((v) => v && typeof v === 'object' && !Array.isArray(v)).withMessage('Invalid parking details'),
    body('parking.vehicleCount').if(body('parking').exists()).isInt({ min: 0, max: 500 }).withMessage('Vehicle count must be between 0 and 500'),
    body('parking.hours').if(body('parking').exists()).isInt({ min: 0, max: 48 }).withMessage('Parking hours must be between 0 and 48'),
    body('discount').optional().isFloat({ min: 0, max: 100000000 }).withMessage('Discount must be 0 or more'),
]);
router.patch('/:id/details', protect, adminOnly, attachTenant, featureGate('advanceBookingTable'), detailsValidation, controller.updateBookingDetails);

module.exports = router;
