// ADM-049 — refund-request workflow routes.
//
// Customer endpoints (authenticated):
//   POST /api/v1/refund-requests          — create a request for own paid order
//   GET  /api/v1/refund-requests/mine     — list own requests
//
// Admin endpoints:
//   GET  /api/v1/refund-requests           — list/filter all requests
//   POST /api/v1/refund-requests/:id/approve
//   POST /api/v1/refund-requests/:id/reject

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/refundRequestController');
const { protect, adminOnly, restrictTo } = require('../middlewares/authMiddleware');
const { validate, body, objectIdParam } = require('../middlewares/validate');

// BUGS_REPORT #33 — shape checks only; balance / status / duplicate rules
// (and "orderId is required") stay in the controller.
const optionalText = (field, max) => body(field)
    .optional({ values: 'null' })
    .isString().withMessage(`${field} must be text`).bail()
    .isLength({ max }).withMessage(`${field} is too long (max ${max} characters)`);

const createValidation = validate([
    // Mongo _id or human orderId; an object would act as a query operator.
    body('orderId')
        .optional({ values: 'falsy' })
        .custom((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 100)
        .withMessage('Invalid orderId'),
    optionalText('reason', 1000),
    // Omitted amount → controller uses the full refundable balance. A
    // supplied amount must be a positive number (0 / negative / junk → 400).
    body('amount')
        .optional({ values: 'null' })
        .custom((v) => v !== '').withMessage('Refund amount must be a positive number').bail()
        .isFloat({ gt: 0, max: 10000000 }).withMessage('Refund amount must be a positive number'),
]);

const decisionValidation = validate([
    objectIdParam('id', 'Invalid refund request id'),
    optionalText('note', 1000),
]);

// ── Customer endpoints ────────────────────────────────────────────────────
router.post('/', protect, restrictTo('customer'), createValidation, ctrl.createRefundRequest);
router.get('/mine', protect, restrictTo('customer'), ctrl.listMyRefundRequests);

// ── Admin endpoints ───────────────────────────────────────────────────────
router.get('/', protect, adminOnly, ctrl.listRefundRequests);
router.post('/:id/approve', protect, adminOnly, decisionValidation, ctrl.approveRefundRequest);
router.post('/:id/reject',  protect, adminOnly, decisionValidation, ctrl.rejectRefundRequest);

module.exports = router;
