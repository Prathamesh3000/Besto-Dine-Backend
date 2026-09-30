const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetryController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');

// @route   GET /api/telemetry/stats
// @access  Private/Admin
router.get('/stats', protect, adminOnly, telemetryController.getStats);

// @route   GET /api/telemetry/reports
// @desc    Historical earnings + most-selling-item report over a date range
// @access  Private/Admin
router.get('/reports', protect, adminOnly, telemetryController.getReports);

// @route   GET /api/telemetry/forecast
// @desc    Future earnings forecast (linear trend + weekday seasonality)
// @access  Private/Admin
router.get('/forecast', protect, adminOnly, telemetryController.getForecast);

module.exports = router;
