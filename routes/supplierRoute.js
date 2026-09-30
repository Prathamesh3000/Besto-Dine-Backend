const express = require('express');
const router = express.Router();
const sc = require('../controllers/supplierController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// Suppliers ride the same `inventory` plan feature as the rest of the
// procurement module.
router.use(protect, adminOnly, attachTenant, featureGate('inventory'));

router.get('/next-code', sc.nextCode);
router.get('/', sc.list);
router.get('/:id', sc.getOne);
router.post('/', sc.create);
router.put('/:id', sc.update);
router.delete('/:id', sc.remove);

module.exports = router;
