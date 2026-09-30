const express = require('express');
const router = express.Router();
const captainController = require('../controllers/captainController');
const { protect, captainOrAdmin } = require('../middlewares/authMiddleware');

// All captain floor-control endpoints are captain-or-admin (waiters excluded).
// Manager + admin pass via the same allowlist as captainOrAdmin.
router.get('/floor-overview', protect, captainOrAdmin, captainController.getFloorOverview);
router.get('/waiters', protect, captainOrAdmin, captainController.getAssignableWaiters);
router.post('/escalate', protect, captainOrAdmin, captainController.escalateToAdmin);

module.exports = router;
