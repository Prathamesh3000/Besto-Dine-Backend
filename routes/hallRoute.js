const express = require('express');
const router = express.Router();
const hallController = require('../controllers/hallController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const { csvUpload } = require('../middlewares/csvUpload');

const hallGate = featureGate('advanceBookingHall');

// Phase 2.5: customer-facing GET / is now also gated. If the tenant
// doesn't have hall bookings enabled, the customer gets an empty list
// with a clear 403 message instead of seeing halls they can't book.
router.get('/', hallGate, hallController.getHalls);

// IMPORTANT — /template and /import MUST be mounted BEFORE the `/:id`
// patterns below so Express doesn't try to interpret "template" /
// "import" as an ObjectId param. Same ordering rule as tableRoute /
// staffRoute.
router.get('/template', protect, adminOnly, attachTenant, hallGate, hallController.downloadHallTemplate);
router.post('/import',  protect, adminOnly, attachTenant, hallGate, csvUpload.single('file'), hallController.importHallsCsv);

router.post('/',          protect, adminOnly, attachTenant, hallGate, hallController.createHall);
router.post('/admin',     protect, adminOnly, attachTenant, hallGate, hallController.createHall); // legacy alias
router.put('/:id',        protect, adminOnly, attachTenant, hallGate, hallController.updateHall);
router.delete('/:id',     protect, adminOnly, attachTenant, hallGate, hallController.deleteHall);

module.exports = router;
