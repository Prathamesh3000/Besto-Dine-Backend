// Stocktakes + inventory deduction health. Mounted at /api/inventory BEFORE
// inventoryRoute. Guards are per-route (not router.use) so any other
// /inventory path falls through untouched to inventoryRoute.
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const st = require('../controllers/stocktakeController');
const dh = require('../controllers/deductionHealthController');

// Same gate as inventoryRoute: login + tenant + `inventory` plan feature.
const guard = [protect, attachTenant, featureGate('inventory')];

// Same `allow` rule as inventoryRoute: admin/manager, or the manageStock flag for read access.
const allow = (...keys) => (req, res, next) => {
    if (req.user && ['admin', 'manager'].includes(req.user.role)) return next();
    const perms = req.user?.permissions || {};
    if (keys.some((k) => perms[k] === true)) return next();
    return res.status(403).json({ success: false, message: `Access denied. Missing permission: ${keys.join(' or ')}` });
};
const stockAccess = allow('manageStock');

router.get('/stocktakes',             ...guard, stockAccess, st.listStocktakes);
router.post('/stocktakes',            ...guard, adminOnly, st.createStocktake);
router.get('/stocktakes/:id',         ...guard, stockAccess, st.getStocktake);
router.put('/stocktakes/:id/counts',  ...guard, adminOnly, st.updateCounts);
router.post('/stocktakes/:id/submit', ...guard, adminOnly, st.submitStocktake);
router.post('/stocktakes/:id/apply',  ...guard, adminOnly, st.applyStocktake);

router.get('/reports/deduction-health',        ...guard, stockAccess, dh.getDeductionHealth);
router.post('/reports/deduction-health/retry', ...guard, adminOnly, dh.retryDeduction);

module.exports = router;
