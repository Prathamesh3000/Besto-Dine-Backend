const express = require('express');
const router = express.Router();
const sc = require('../controllers/supplierInvoiceController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// Supplier invoices + payments (Plan 3B.3): part of the procurement module, same gate as purchase orders.
router.use(protect, adminOnly, attachTenant, featureGate('inventory'));

// Named routes BEFORE /:id.
router.get('/reports/outstanding', sc.outstanding);
router.get('/reports/three-way-match', sc.threeWay);

router.get('/', sc.list);
router.post('/', sc.create);
router.get('/:id', sc.getOne);
router.post('/:id/payments', sc.recordPayment);

module.exports = router;
