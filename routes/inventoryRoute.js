const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const ic = require('../controllers/inventoryController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');

// All inventory endpoints require login + the `inventory` plan feature.
// adminOnly is applied PER-ROUTE below rather than as a blanket here, so
// the recipe-building surface can be opened to a chef (who is not in
// adminOnly's allowlist) without exposing item CRUD / stock / reports.
router.use(protect, attachTenant, featureGate('inventory'));

// allow(...keys) — admin/manager always pass (same reach as the old blanket
// adminOnly); other staff pass if they hold ANY of the listed granular
// permission flags. Lets us open narrow slices of inventory to a chef
// without exposing item CRUD / imports / cost reports. Note: unlike
// `checkPermission`, manager is whitelisted directly — managers default to
// these flags but pre-existing records may not carry them, and inventory
// access is part of their admin-parity.
const allow = (...keys) => (req, res, next) => {
    if (req.user && ['admin', 'manager'].includes(req.user.role)) return next();
    const perms = req.user?.permissions || {};
    if (keys.some((k) => perms[k] === true)) return next();
    return res.status(403).json({
        success: false,
        message: `Access denied. Missing permission: ${keys.join(' or ')}`,
    });
};

// Recipe-build surface (view + save recipes). `manageRecipe`.
const recipeAccess = allow('manageRecipe');
// Stock VIEW surface — read levels, low-stock alerts, summary. `manageStock`
// is read-only: stock ADJUSTMENTS (PATCH /:id/adjust) stay adminOnly so only
// admins/managers can change quantities. A chef can monitor stock but not
// mutate it.
const stockAccess = allow('manageStock');
// Inventory item list (GET /) is shared: the recipe ingredient picker needs
// it AND the stock view needs it, so either flag grants read.
const inventoryListAccess = allow('manageRecipe', 'manageStock');

// ADM-083 — CSV-only multer (memory) for the bulk import endpoint. Same
// shape as menuRoute's csvUpload — kept local rather than centralised
// because there are only two CSV import surfaces and colocating with
// the route keeps the constraint readable.
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    fileFilter: (req, file, cb) => {
        const okExt = path.extname(file.originalname).toLowerCase() === '.csv';
        const okMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
            .includes(file.mimetype);
        if (okExt || okMime) return cb(null, true);
        const err = new Error('Only .csv files are allowed');
        err.status = 400;
        err.expose = true;
        cb(err, false);
    },
});

// ── Inventory CRUD ─────────────────────────────────────────────────
// GET / (item list) is shared read: the RecipeModal ingredient picker
// (manageRecipe) and the chef stock view (manageStock) both need it. It
// stays read-only — create/update/delete below remain adminOnly.
// summary + alerts power the chef stock view's counts / low-stock banner,
// so they open to manageStock (admin/manager always pass).
router.get('/',          inventoryListAccess, ic.getAllItems);
router.get('/summary',   stockAccess, ic.getSummary);
router.get('/alerts',    stockAccess, ic.getAlerts);
router.get('/next-id',   adminOnly, ic.getNextId);

// ── Recipe management ──────────────────────────────────────────────
// Bulk import (template + upload) must come BEFORE /recipes/:menuItemId
// so the literal "template" / "import" path segments aren't matched as
// an ObjectId. View + save are recipeAccess (chef-reachable); the bulk
// CSV import and recipe delete stay adminOnly.
router.get('/recipes/template',  adminOnly, ic.downloadRecipesTemplate);
router.post('/recipes/import',   adminOnly, csvUpload.single('file'), ic.importRecipesCsv);
router.get('/recipes',               recipeAccess, ic.getRecipes);
router.get('/recipes/:menuItemId',   recipeAccess, ic.getRecipeByMenuItem);
router.post('/recipes',              recipeAccess, ic.saveRecipe);
router.delete('/recipes/:menuItemId', adminOnly, ic.deleteRecipe);

// ── Analytics ──────────────────────────────────────────────────────
router.get('/food-cost',             adminOnly, ic.getFoodCostReport);
router.get('/actual-vs-theoretical', adminOnly, ic.getActualVsTheoretical);
// Stock + consumption reports (10.8.1 / 10.8.2)
router.get('/reports/stock',         adminOnly, ic.getStockReport);
router.get('/reports/consumption',   adminOnly, ic.getConsumptionReport);
// Per-menu-item inventory issues (out/low/config) for the Menu page alerts.
router.get('/menu-issues',           adminOnly, ic.getMenuItemIssues);

// ── Bulk import (must come before /:id to avoid being matched as an id)
router.get('/template', adminOnly, ic.downloadInventoryTemplate);
router.post('/import', adminOnly, csvUpload.single('file'), ic.importItemsCsv);

// ── Single item (must come after named routes) ─────────────────────
router.get('/:id',       adminOnly, ic.getItemById);
router.post('/',         adminOnly, ic.createItem);
router.put('/:id',       adminOnly, ic.updateItem);
// Stock adjustment (usage / waste / restock) — adminOnly. Chefs get a
// read-only stock view via manageStock; changing quantities is reserved
// for admins / managers.
router.patch('/:id/adjust', adminOnly, ic.adjustStock);
router.delete('/:id',    adminOnly, ic.deleteItem);

module.exports = router;
