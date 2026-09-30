const express = require('express');
const router = express.Router();
const requestController = require('../controllers/requestController');
const { protect, staffOnly, checkPermission } = require('../middlewares/authMiddleware');
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');

// BUGS_REPORT #33 — shape checks. Required / enum messages for tableId,
// type, priority and status stay in the controller (the QR page and the
// waiter app toast them); these stop malformed ids (CastError → 500) and
// junk item rows from reaching Mongo.
const createValidation = validate([
    // Missing → controller's "Table ID is required".
    optionalObjectId('body', 'tableId', 'Invalid table. Please re-scan the QR code at your table.'),
    body('items')
        .optional({ values: 'falsy' })
        .isArray().withMessage('Items must be an array').bail()
        .custom((v) => v.length <= 50).withMessage('Too many items (max 50)'),
    body('items.*.label')
        .optional({ values: 'null' })
        .isString().withMessage('Item label must be text').bail()
        .isLength({ max: 200 }).withMessage('Item label is too long'),
    body('items.*.qty')
        .optional({ values: 'null' })
        .isFloat({ min: 0, max: 1000 }).withMessage('Item quantity must be between 0 and 1000'),
]);

const statusValidation = validate([
    objectIdParam('id', 'Invalid request id'),
    // Status enum / transition rules live in the controller.
    optionalObjectId('body', 'waiterId', 'Invalid waiterId'),
]);

// Customer creates request (via QR scan — no auth needed)
router.post('/', createValidation, requestController.createRequest);

// Customer polls the status of requests at their table (no auth — tenant
// comes from X-Restaurant-Slug set by the QR scan flow). Declared BEFORE
// the staff /:id/status route so the path matches correctly.
router.get('/active/table/:tableId', requestController.getActiveRequestsForTable);

// Staff reads and updates customer service requests (water / waiter-call /
// bill / clean). Gated by `viewCustomerRequests` — the permission flag
// granted to Waiter, Captain, and Manager in the staff matrix. Chefs
// (accessKitchen: true) intentionally do NOT see this feed; their queue is
// the kitchen order list.
router.get('/', protect, staffOnly, checkPermission('viewCustomerRequests'), requestController.getRequests);
router.put('/:id/status', protect, staffOnly, checkPermission('viewCustomerRequests'), statusValidation, requestController.updateRequestStatus);

module.exports = router;
