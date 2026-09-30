const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { protect, adminOnly, optionalAuth } = require('../middlewares/authMiddleware');

// Authenticated routes
router.get('/my-invoices', protect, invoiceController.getMyInvoices);

// Guests need to view their bill too, so login is optional — but the
// controller only returns the customer's name / email / mobile to the
// owner (login or matching scan session) or staff; others get it redacted.
router.get('/:id', optionalAuth, invoiceController.getInvoice);

// Admin-only routes
router.post('/generate/:orderId', protect, adminOnly, invoiceController.generateInvoice);

module.exports = router;
