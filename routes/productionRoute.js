const express = require('express');
const router = express.Router();
const pc = require('../controllers/productionController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

router.use(protect, adminOnly, attachTenant, featureGate('inventory'));

router.get('/summary', pc.summary);
router.get('/', pc.list);
router.post('/', pc.create);

module.exports = router;
