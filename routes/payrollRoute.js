const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const ctrl = require('../controllers/payrollController');

// Simple payroll (attendance + wallet payout; not statutory payroll). Admin /
// owner only. It pays out through the staff wallet, so it shares the
// `tipManagement` plan gate with the wallet module (no new plan key).
const gate = [protect, restrictTo('admin'), attachTenant, featureGate('tipManagement')];

router.get('/profiles', ...gate, ctrl.listProfiles);
router.put('/profiles/:staffId', ...gate, ctrl.upsertProfile);

router.get('/runs', ...gate, ctrl.listRuns);
router.post('/runs', ...gate, ctrl.createRun);
router.get('/runs/:id', ...gate, ctrl.getRun);
router.put('/runs/:id/adjustments', ...gate, ctrl.updateAdjustments);
router.post('/runs/:id/finalize', ...gate, ctrl.finalize);
router.post('/runs/:id/pay', ...gate, ctrl.pay);
router.get('/runs/:id/export.csv', ...gate, ctrl.exportCsv);
router.get('/runs/:id/payslip/:staffId', ...gate, ctrl.payslip);

module.exports = router;
