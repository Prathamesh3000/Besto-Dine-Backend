const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const tipController = require('../controllers/tipController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

const tipSettleLimiter = makeLimiter({ name: 'tip-settle',
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many settlement requests. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Tip management is gated behind the `tipManagement` plan feature.
// We attach the tenant on every protected route so the gate can resolve,
// but the gate only fires on the admin endpoints — waiters need to see
// their own tips regardless of plan tier.
router.get('/my',      protect, tipController.getMyTips);

const tipAdminGate = [protect, adminOnly, attachTenant, featureGate('tipManagement')];
router.get('/pending', ...tipAdminGate, tipController.getPendingTipsByWaiter);
router.post('/settle', tipSettleLimiter, ...tipAdminGate, tipController.settleTips);
router.get('/history', ...tipAdminGate, tipController.getSettlementHistory);

module.exports = router;
