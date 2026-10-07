const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetryController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');

// @route   GET /api/telemetry/stats
// @access  Private/Admin
router.get('/stats', protect, adminOnly, telemetryController.getStats);

// @route   GET /api/telemetry/reports
// @desc    Historical earnings + most-selling-item report over a date range
// @access  Private/Admin
// Plan gate: any revenueAnalytics tier. The Basic tier is further capped
// to short date ranges inside the controller (BASIC_REPORT_MAX_DAYS).
router.get('/reports', protect, adminOnly, featureGate('revenueAnalytics'), telemetryController.getReports);

// @route   GET /api/telemetry/forecast
// @desc    Future earnings forecast (linear trend + weekday seasonality)
// @access  Private/Admin
// Forecasting is an Advanced-tier analytics feature.
router.get('/forecast', protect, adminOnly, featureGate('revenueAnalytics', { minTier: 'advanced' }), telemetryController.getForecast);

module.exports = router;
