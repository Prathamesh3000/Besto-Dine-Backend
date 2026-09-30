const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');

// All analytics routes are admin-only
router.use(protect, adminOnly);

router.get('/sales-history', analyticsController.getSalesHistory);
router.get('/peak-hours', analyticsController.getPeakHours);
router.get('/top-items', analyticsController.getTopItems);
router.get('/summary', analyticsController.getSummaryReport);

module.exports = router;
