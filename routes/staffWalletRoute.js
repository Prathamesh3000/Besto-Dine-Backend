const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const ctrl = require('../controllers/staffWalletController');
const { protect, adminOnly, restrictTo } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// Strict limiter on the withdraw endpoint — a buggy / malicious client
// shouldn't be able to spam the admin's pending queue. 5 / min / IP is
// in line with the tip settle limiter (the tip module's sibling).
const withdrawLimiter = makeLimiter({ name: 'staff-withdraw',
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many withdrawal requests. Please wait a minute and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Wallet endpoints share the same plan gate as tip management — the
// feature is one cohesive product unit (tip → wallet → withdrawal).
const adminGate = [protect, adminOnly, attachTenant, featureGate('tipManagement')];
const staffGate = [protect, restrictTo('waiter', 'captain'), attachTenant, featureGate('tipManagement')];

// ─── Waiter / Captain ────────────────────────────────────────────────────
router.get('/me',                             ...staffGate, ctrl.getMyWallet);
router.post('/withdraw',     withdrawLimiter, ...staffGate, ctrl.requestWithdrawal);

// ─── Admin ───────────────────────────────────────────────────────────────
router.get('/withdrawals',                    ...adminGate, ctrl.listWithdrawals);
router.post('/withdrawals/:id/approve',       ...adminGate, ctrl.approveWithdrawal);
router.post('/withdrawals/:id/reject',        ...adminGate, ctrl.rejectWithdrawal);

module.exports = router;
