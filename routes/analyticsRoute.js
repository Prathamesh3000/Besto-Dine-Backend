const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// All analytics routes are admin-only and need the revenueAnalytics plan
// feature (any tier other than 'none').
router.use(protect, adminOnly, attachTenant, featureGate('revenueAnalytics'));

router.get('/sales-history', analyticsController.getSalesHistory);
router.get('/peak-hours', analyticsController.getPeakHours);
router.get('/top-items', analyticsController.getTopItems);
router.get('/summary', analyticsController.getSummaryReport);

module.exports = router;
