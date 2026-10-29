// Tenant audit log (task 2.1). Admin / manager only; managers are further
// restricted to their own actions in the controller.
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/auditController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');

router.get('/', protect, adminOnly, ctrl.listAudit);
router.get('/export', protect, adminOnly, ctrl.exportAudit);

module.exports = router;
