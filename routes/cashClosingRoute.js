const express = require('express');
const router = express.Router();
const cc = require('../controllers/cashClosingController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');

// Daily cash closing (Plan 3B.5). Admin / manager; amending a CLOSED day is admin-role only (checked in the controller).
router.use(protect, adminOnly, attachTenant);

router.get('/preview', cc.preview);
router.post('/open', cc.open);
router.post('/close', cc.close);
router.get('/', cc.list);
router.get('/:id', cc.getOne);
router.patch('/:id', cc.amend);

module.exports = router;
