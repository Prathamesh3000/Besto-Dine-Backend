const express = require('express');
const router = express.Router();
const pc = require('../controllers/purchaseController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const v = require('../validators/money');

router.use(protect, adminOnly, attachTenant, featureGate('inventory'));

// Named routes BEFORE /:id so literal segments aren't parsed as an ObjectId.
router.get('/summary', pc.summary);
router.get('/next-number', pc.nextNumber);
router.get('/reports/purchase', pc.purchaseReport);
router.get('/reports/payments', pc.paymentReport);

router.get('/', pc.list);
router.post('/', v.purchaseCreate, pc.create);
router.get('/:id', pc.getOne);
router.put('/:id', v.purchaseUpdate, pc.update);
router.post('/:id/receive', v.purchaseReceive, pc.receive);
router.post('/:id/payment', v.purchasePayment, pc.recordPayment);
router.patch('/:id/cancel', v.purchaseIdOnly, pc.cancel);

module.exports = router;
