const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const gst = require('../controllers/gstReportController');
const schedules = require('../controllers/reportScheduleController');

// GST / Tally exports and emailed report schedules. Export aids only (not a
// tax filing tool). Admin-only, same plan gate as analytics.
router.use(protect, adminOnly, attachTenant, featureGate('revenueAnalytics'));

router.get('/gst/summary', gst.gstSummary);
router.get('/gst/config', gst.getConfig);
router.put('/gst/config', gst.updateConfig);
router.get('/tally/export', gst.tallyExport);

router.get('/schedules', schedules.list);
router.post('/schedules', schedules.create);
router.patch('/schedules/:id', schedules.update);
router.delete('/schedules/:id', schedules.remove);

module.exports = router;
