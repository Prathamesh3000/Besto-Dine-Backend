const express = require('express');
const router = express.Router();
const { protect, adminExclusive } = require('../middlewares/authMiddleware');
const { exportTenantData } = require('../controllers/tenantExportController');

router.get('/', protect, adminExclusive, exportTenantData);

module.exports = router;
