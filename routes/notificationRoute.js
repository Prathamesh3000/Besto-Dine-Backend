const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect, staffOnly } = require('../middlewares/authMiddleware');
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');

// ─── Validation (BUGS_REPORT #33) ─────────────────────────────────────
// Mirrors notificationController.createNotification + the Notification
// model enums. title/description required-ness stays in the controller
// (same messages); here we only ensure they are strings so `.trim()`
// can't 500, and that enums / ids are valid before reaching notify().
// Falsy enum values pass — the controller substitutes its defaults.
const optEnum = (field, values) =>
    body(field).optional({ values: 'falsy' }).isIn(values)
        .withMessage(`${field} must be one of: ${values.join(', ')}`);

const createNotificationRules = validate([
    body('title').optional({ values: 'falsy' })
        .isString().withMessage('Title is required').bail()
        .isLength({ max: 500 }).withMessage('Title cannot exceed 500 characters'),
    body('description').optional({ values: 'falsy' })
        .isString().withMessage('Description is required').bail()
        .isLength({ max: 5000 }).withMessage('Description cannot exceed 5000 characters'),
    optionalObjectId('body', 'recipient', 'Invalid recipient ID'),
    optEnum('recipientRole', ['admin', 'chef', 'waiter', 'captain', 'customer', 'all']),
    optEnum('category', ['Order', 'Wallet', 'Points', 'Offer', 'Reward', 'Payment', 'Service', 'System']),
    optEnum('priority', ['low', 'medium', 'high', 'urgent']),
    optionalObjectId('body', 'branch', 'Invalid branch ID'),
    body('meta').optional({ values: 'null' })
        .custom((v) => typeof v === 'object' && !Array.isArray(v))
        .withMessage('meta must be an object'),
]);

const notificationId = validate([objectIdParam('id', 'Invalid notification ID')]);

// Fetch notifications for current user/role
router.get('/', protect, notificationController.getNotifications);

// Create notification — staff only. Customers must never be able to
// inject entries into the admin / staff bell panels (phishing vector);
// server-side flows create notifications directly via the model.
router.post('/', protect, staffOnly, createNotificationRules, notificationController.createNotification);

// Mark all as read — MUST come BEFORE /:id/read to avoid "all" matching as an ID
router.put('/all/read', protect, notificationController.markAllRead);

// Mark single notification as read
router.put('/:id/read', protect, notificationId, notificationController.markRead);

// Clear all notifications for current user/role
router.delete('/clear', protect, notificationController.clearAll);

// Delete single notification
router.delete('/:id', protect, notificationId, notificationController.deleteOne);

module.exports = router;
