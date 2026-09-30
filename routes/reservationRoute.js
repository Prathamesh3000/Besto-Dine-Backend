const express = require('express');
const router = express.Router();
const { protect, adminOnly, staffOnly, checkPermission } = require('../middlewares/authMiddleware');
const {
    validate,
    body,
    objectIdParam,
    optionalObjectId,
} = require('../middlewares/validate');

// ── Request validation (BUGS_REPORT #33) ────────────────────────────────
// Presence checks stay in the controller ("All fields except notes are
// required", "Guest count must be between 1 and 200", date checks) —
// these chains only reject wrong types / malformed ids (which used to
// CastError into a 500). AddReservationModal sends { guestName, contactNo,
// date:'YYYY-MM-DD', time, guestCount:number, selectedArea, selectedTable, notes }.
const RESERVATION_STATUSES = ['Pending', 'Approved', 'Rejected', 'Seated', 'Cancelled', 'Completed'];
const reservationIdParam = objectIdParam('id', 'Invalid reservation id');
const optText = (field, max, label = field) => body(field).optional({ values: 'null' })
    .isString().withMessage(`${label} must be text`).bail()
    .isLength({ max }).withMessage(`${label} is too long`);

const tableReservationRules = [
    optText('contactNo', 30, 'Contact number'),
    optText('time', 50, 'Time'),
    optText('notes', 2000, 'Notes'),
    body('guestCount').optional({ values: 'falsy' }).isFloat({ min: 1, max: 200 })
        .withMessage('Guest count must be between 1 and 200'),
    optionalObjectId('body', 'selectedArea', 'Invalid area'),
    optionalObjectId('body', 'selectedTable', 'Invalid table'),
];
// Staff route additionally takes the guest identity from the body.
const staffReservationRules = validate([
    optText('guestName', 200, 'Guest name'),
    ...tableReservationRules,
    // bookedBy is ignored — the controller always uses req.user.
]);
// Customer route: guestName / bookedBy are overwritten from the session.
const customerReservationRules = validate(tableReservationRules);

const {
    createReservation,
    createCustomerReservation,
    getReservations,
    cancelReservation,
    updateReservationStatus,
    applyLateDeduction
} = require('../controllers/reservationController');

// Public — customer can view reservation list (filtered by their own)
router.get('/', protect, getReservations);

// Customer books their own table. Identity is taken from the session
// inside the handler, never from the body, so a customer cannot book
// in someone else's name. Kept OFF the staff route below, which stays
// staffOnly because it trusts an arbitrary guestName/contactNo.
router.post('/customer', protect, customerReservationRules, createCustomerReservation);

// Staff/Admin create and manage reservations — require 'reservation' permission
router.post('/', protect, staffOnly, checkPermission('reservation'), staffReservationRules, createReservation);
// POST /advanced was removed: it trusted a client-supplied total and marked
// non-cash bookings as paid. Advance bookings go through
// /advance-booking/create, which verifies the payment server-side.
router.put('/:id/status', protect, staffOnly, checkPermission('reservation'), validate([
    reservationIdParam,
    body('status').isIn(RESERVATION_STATUSES).withMessage('Invalid reservation status'),
]), updateReservationStatus);
router.put('/:id/cancel', protect, staffOnly, checkPermission('reservation'), validate([reservationIdParam]), cancelReservation);
router.patch('/:id/late-deduction', protect, adminOnly, validate([
    reservationIdParam,
    body('deductionAmount').isFloat({ gt: 0, max: 10000000 }).withMessage('Deduction amount must be positive'),
]), applyLateDeduction);

module.exports = router;
