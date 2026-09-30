const express = require('express');
const router = express.Router();
const pc = require('../controllers/purchaseController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

router.use(protect, adminOnly, attachTenant, featureGate('inventory'));

// Named routes BEFORE /:id so literal segments aren't parsed as an ObjectId.
router.get('/summary', pc.summary);
router.get('/next-number', pc.nextNumber);
router.get('/reports/purchase', pc.purchaseReport);
router.get('/reports/payments', pc.paymentReport);

router.get('/', pc.list);
router.post('/', pc.create);
router.get('/:id', pc.getOne);
router.put('/:id', pc.update);
router.post('/:id/receive', pc.receive);
router.post('/:id/payment', pc.recordPayment);
router.patch('/:id/cancel', pc.cancel);

module.exports = router;
