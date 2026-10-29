// Inter-branch stock transfers + valuation report. Mounted at /api/inventory
// BEFORE inventoryRoute. Guards are per-route so any other /inventory path
// falls through untouched. Same gate as inventory writes: admin/manager
// (adminOnly), plan feature `inventory`.
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const c = require('../controllers/stockTransferController');

const guard = [protect, attachTenant, featureGate('inventory'), adminOnly];

router.get('/transfers',                  ...guard, c.listTransfers);
router.post('/transfers',                 ...guard, c.createTransfer);
router.get('/transfers/:id',              ...guard, c.getTransfer);
router.post('/transfers/:id/send',        ...guard, c.sendTransfer);
router.post('/transfers/:id/receive',     ...guard, c.receiveTransfer);
router.post('/transfers/:id/cancel',      ...guard, c.cancelTransfer);
router.get('/reports/valuation',          ...guard, c.getValuation);

module.exports = router;
