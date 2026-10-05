const express = require('express');
const router = express.Router();
const { protect, adminExclusive } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const { exportTenantData } = require('../controllers/tenantExportController');

// dataExport is a sellable plan feature — gate it like every other one.
router.get('/', protect, adminExclusive, attachTenant, featureGate('dataExport'), exportTenantData);

module.exports = router;
