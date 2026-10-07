const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const campaignController = require('../controllers/campaignController');
const { validate, objectIdParam } = require('../middlewares/validate');

// Malformed :id → 400 here instead of a CastError 500 in the controller.
const idRules = validate([objectIdParam('id', 'Invalid campaign id')]);

// Marketing campaigns are their own module (`campaigns`). Tenants whose
// plan snapshot pre-dates that key fall back to `couponPromotions`, which
// used to cover campaigns (utils/featureAccess LEGACY_FALLBACK).
router.use(auth.protect, auth.adminOnly, attachTenant, featureGate('campaigns'));

router.get('/',             campaignController.getCampaigns);
router.get('/stats',        campaignController.getCampaignStats);
router.post('/',            campaignController.createCampaign);
router.patch('/:id/toggle', idRules, campaignController.toggleCampaign);
router.put('/:id',          idRules, campaignController.updateCampaign);
router.delete('/:id',       idRules, campaignController.deleteCampaign);

module.exports = router;
