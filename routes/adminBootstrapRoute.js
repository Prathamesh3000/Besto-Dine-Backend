const express = require('express');
const router = express.Router();
const { getAdminBootstrap } = require('../controllers/adminBootstrapController');
const { protect, staffOnly } = require('../middlewares/authMiddleware');

// Single round-trip bundle for the admin first-paint. Restricted to
// authenticated staff — the sub-queries (staff list, settings) are
// already protected by their own controllers, but no point in even
// hitting Mongo for an anonymous caller.
router.get('/', protect, staffOnly, getAdminBootstrap);

module.exports = router;
