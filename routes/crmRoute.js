const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crmController');
const { protect, adminOnly, checkPermission } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// Admin CRM routes — gated behind the `crm` subscription feature.
// `checkPermission('crm')` is the *granular* per-staff permission flag
// (set by the restaurant admin); `featureGate('crm')` is the *plan-level*
// gate set by the Super Admin. Both must pass.
router.get('/customers',
    protect, adminOnly, attachTenant, featureGate('crm'), checkPermission('crm'),
    crmController.getAllCustomers);
router.get('/customers/:id',
    protect, adminOnly, attachTenant, featureGate('crm'), checkPermission('crm'),
    crmController.getCustomerDetail);

module.exports = router;
