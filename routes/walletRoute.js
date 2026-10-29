const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const auth = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');
const { idempotency } = require('../middlewares/idempotency');
const walletController = require('../controllers/walletController');
const { validate, body, optionalObjectId } = require('../middlewares/validate');

// Phase 2.5: wallet is gated by `walletLoyalty` for both customer and
// admin routes. If a tenant is on a plan without the feature, none of
// these endpoints respond — customers see a clean "this restaurant
// doesn't offer wallet and loyalty points" 403.
const walletGate = featureGate('walletLoyalty');

// Rate limiter for wallet mutation endpoints (pay, redeem)
const walletMutationLimiter = makeLimiter({ name: 'wallet-mutation',
    windowMs: 60 * 1000,   // 1 minute
    max: 10,               // 10 mutations per minute per IP
    message: { success: false, message: 'Too many wallet requests. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// BUGS_REPORT #33 — request shape checks. They mirror what the controller
// already accepts; required-field / business messages stay in the
// controller (the UI toasts them), these only stop wrong types and
// malformed ids from reaching Mongo (CastError 500s, $-operator objects).
const optionalDescription = () => body('description')
    .optional({ values: 'null' })
    .isString().withMessage('Description must be text').bail()
    .isLength({ max: 500 }).withMessage('Description is too long (max 500 characters)');

const addPointsValidation = validate([
    optionalObjectId('body', 'targetUserId', 'Invalid targetUserId'),
    optionalDescription(),
]);

// Frontend sends a JSON number. A numeric string can never succeed here
// (Mongo compares loyaltyPoints:{$gte:"100"} by type), so require a number.
const redeemPointsValidation = validate([
    body('points')
        .custom((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10000000)
        .withMessage('Invalid points amount'),
]);

// orderId / amount are validated inside payWithWallet (ORDER_REQUIRED /
// AMOUNT_INVALID codes the checkout reads) — only the free-text field here.
const payValidation = validate([optionalDescription()]);

const adjustValidation = validate([
    // Missing → controller's "Missing required fields".
    optionalObjectId('body', 'targetUserId', 'Invalid targetUserId'),
    body('amount')
        .optional({ values: 'null' })
        .isFloat({ gt: 0, max: 10000000 }).withMessage('Amount must be a positive number'),
    body('type')
        .optional({ values: 'falsy' })
        .isIn(['points', 'balance']).withMessage('type must be "points" or "balance"'),
    body('action')
        .optional({ values: 'falsy' })
        .isIn(['add', 'deduct']).withMessage('action must be "add" or "deduct"'),
    optionalDescription(),
]);

const setStatusValidation = validate([
    // Missing → controller's "targetUserId is required"; status enum is
    // checked (case-insensitively) by the controller.
    optionalObjectId('body', 'targetUserId', 'Invalid targetUserId'),
    body('status')
        .optional({ values: 'null' })
        .isString().withMessage('status must be one of: active, blocked, suspended'),
]);

// User routes
router.get('/', auth.protect, walletGate, walletController.getWallet);
// Bug #2 — manual point credits are an admin operation. Customers earn
// points only via server-computed payment paths.
router.post('/points/add', walletMutationLimiter, auth.protect, auth.adminOnly, walletGate, addPointsValidation, walletController.addPoints);
router.post('/points/redeem', walletMutationLimiter, auth.protect, walletGate, redeemPointsValidation, walletController.redeemPoints);
router.post('/pay', walletMutationLimiter, auth.protect, walletGate, payValidation, idempotency({ required: true }), walletController.payWithWallet);

// Admin routes
router.get('/admin/stats', auth.protect, auth.adminOnly, walletGate, walletController.getAdminWalletStats);
router.get('/admin/customers', auth.protect, auth.adminOnly, walletGate, walletController.searchWalletCustomers);
router.get('/admin/manual-history', auth.protect, auth.adminOnly, walletGate, walletController.getManualPointsHistory);
router.get('/admin/reports', auth.protect, auth.adminOnly, walletGate, walletController.getWalletReports);
router.post('/admin/adjust', walletMutationLimiter, auth.protect, auth.adminOnly, walletGate, adjustValidation, walletController.adjustWallet);
router.post('/admin/set-status', walletMutationLimiter, auth.protect, auth.adminOnly, walletGate, setStatusValidation, walletController.setWalletStatus);

module.exports = router;
