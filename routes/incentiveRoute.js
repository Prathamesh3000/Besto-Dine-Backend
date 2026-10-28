const express = require('express');
const router = express.Router();
const { protect, adminOnly, restrictTo, checkPermission } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const { validate, objectIdParam } = require('../middlewares/validate');
const incentiveController = require('../controllers/incentiveController');

// Staff incentives are the `incentives` plan module (default off, sold as an
// add-on). Every route is gated; a locked tenant gets 403 FEATURE_LOCKED.
const idRules = validate([objectIdParam('id', 'Invalid campaign id')]);

// Captain / waiter: their OWN figures only (controllers filter on req.user._id).
const staffGate = [protect, restrictTo('captain', 'waiter'), attachTenant, featureGate('incentives')];
router.get('/me', ...staffGate, incentiveController.getMyIncentives);
router.get('/items', ...staffGate, incentiveController.getEligibleItems);
router.get('/entries', ...staffGate, incentiveController.getMyEntries);

// Admin / manager with the `incentives` permission (admins bypass it).
const adminGate = [protect, adminOnly, checkPermission('incentives'), attachTenant, featureGate('incentives')];
router.get('/campaigns', ...adminGate, incentiveController.listCampaigns);
router.post('/campaigns', ...adminGate, incentiveController.createCampaign);
router.put('/campaigns/:id', ...adminGate, idRules, incentiveController.updateCampaign);
router.delete('/campaigns/:id', ...adminGate, idRules, incentiveController.deleteCampaign);
router.get('/report', ...adminGate, incentiveController.getReport);
router.get('/report.csv', ...adminGate, incentiveController.exportReportCsv);

module.exports = router;
