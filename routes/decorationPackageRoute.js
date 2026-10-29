const express = require('express');
const router = express.Router();
const decorationPackageController = require('../controllers/decorationPackageController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');
const { csvUpload } = require('../middlewares/csvUpload');
const ov = require('../validators/ops');

// Phase 2.5: decoration packages are part of the hall-booking flow.
// Gate all reads (customer + admin) and mutations behind
// `advanceBookingHall` so tenants without the feature can't see or
// manage them.
const hallGate = featureGate('advanceBookingHall');

// Public — booking flow reads (gated by hall feature)
router.get('/', hallGate, decorationPackageController.getDecorationPackages);

// IMPORTANT — /template and /import MUST be mounted BEFORE the `/:id`
// patterns so Express doesn't try to interpret "template" / "import"
// as an ObjectId param. Same ordering rule as tableRoute / staffRoute.
router.get('/template', protect, adminOnly, hallGate, decorationPackageController.downloadDecorationPackageTemplate);
router.post('/import',  protect, adminOnly, hallGate, csvUpload.single('file'), decorationPackageController.importDecorationPackagesCsv);

router.get('/:id', hallGate, decorationPackageController.getDecorationPackageById);

// Admin only
router.post('/',            protect, adminOnly, hallGate, ov.decorCreate, decorationPackageController.createDecorationPackage);
router.put('/:id',          protect, adminOnly, hallGate, ov.decorUpdate, decorationPackageController.updateDecorationPackage);
router.delete('/:id',       protect, adminOnly, hallGate, ov.decorIdOnly, decorationPackageController.deleteDecorationPackage);
router.patch('/:id/status', protect, adminOnly, hallGate, ov.decorIdOnly, decorationPackageController.toggleStatus);

module.exports = router;
