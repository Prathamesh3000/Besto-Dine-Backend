const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const campaignController = require('../controllers/campaignController');

// Marketing campaigns are part of the `couponPromotions` feature bundle.
router.use(auth.protect, auth.adminOnly, attachTenant, featureGate('couponPromotions'));

router.get('/',             campaignController.getCampaigns);
router.get('/stats',        campaignController.getCampaignStats);
router.post('/',            campaignController.createCampaign);
router.patch('/:id/toggle', campaignController.toggleCampaign);
router.put('/:id',          campaignController.updateCampaign);
router.delete('/:id',       campaignController.deleteCampaign);

module.exports = router;
