const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect, adminOnly, checkPermission } = require('../middlewares/authMiddleware');

// Admin payment view — requires 'viewPayments' permission
router.get('/admin/all', protect, adminOnly, checkPermission('viewPayments'), paymentController.getAllPayments);

module.exports = router;
