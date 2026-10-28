const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const {
    getAllMenuItems,
    getMenuItem,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    searchMenuItems,
    getTrendingItems,
    getItemCustomizations,
    getBranchPrices,
    setBranchPrices,
    importMenuItemsCsv,
    downloadMenuItemTemplate,
} = require('../controllers/menuController');
const { protect, adminOnly, adminExclusive, checkPermission } = require('../middlewares/authMiddleware');
const { makeLimiter } = require('../utils/rateLimitStore');
const { ipKeyGenerator } = require('express-rate-limit');
const { scanMenu } = require('../controllers/menuScanController');
const { clearMenu } = require('../controllers/menuClearController');
const { validate, body, isObjectIdLike, objectIdParam, optionalObjectId } = require('../middlewares/validate');

// ── Request validation (BUGS_REPORT #33) ────────────────────────────────
// AddMenuItemModal sends JSON (images are uploaded separately and arrive
// as URL strings). Required-ness and enums stay with the Mongoose schema
// (the controller already turns those into 400s); these chains reject
// wrong types / absurd values before they reach the model.
const MENU_UNITS = ['pieces', 'plate', 'bowl', 'glass', 'bottle', 'kg', 'gm', 'liter', 'ml', 'serving', 'slice', 'cup', 'portion'];
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_PRICE = 10000000;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const menuIdParam = objectIdParam('id', 'Invalid menu item id');
const optStr = (field, max, label = field) => body(field).optional({ values: 'null' })
    .isString().withMessage(`${label} must be text`).bail()
    .isLength({ max }).withMessage(`${label} is too long`);
const optStrArray = (field, maxItems, maxLen) => [
    body(field).optional({ values: 'null' }).isArray({ max: maxItems }).withMessage(`${field} must be a list`),
    body(`${field}.*`).isString().withMessage(`${field} entries must be text`).bail()
        .isLength({ max: maxLen }).withMessage(`${field} entry is too long`),
];
// Availability window bound: '' (no window) or a 00:00–23:59 time.
// "9:00" is normalised to "09:00" — utils/menuAvailability compares
// HH:MM strings, so an unpadded value would sort after "17:00".
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const optTime = (field) => body(field).optional({ values: 'null' })
    .isString().withMessage(`${field} must be text`).bail()
    .custom((v) => v.trim() === '' || TIME_RE.test(v.trim()))
    .withMessage(`${field} must be a time between 00:00 and 23:59 (HH:MM)`).bail()
    .customSanitizer((v) => {
        const m = TIME_RE.exec(String(v).trim());
        return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
    });
const optBool = (field) => body(field).optional({ values: 'null' }).isBoolean().withMessage(`${field} must be true or false`);

const menuItemRules = [
    optStr('name', 200, 'Item name'),
    optStr('description', 5000, 'Description'),
    body('category').optional({ values: 'falsy' }).custom(isObjectIdLike).withMessage('Invalid category'),
    optionalObjectId('body', 'branch', 'Invalid branch id'),
    body('basePrice').optional({ values: 'null' }).isFloat({ min: 0, max: MAX_PRICE }).withMessage('Base price must be a number 0 or greater'),
    body('offerPercentage').optional({ values: 'null' }).isFloat({ min: 0, max: 100 }).withMessage('Offer percentage must be between 0 and 100'),
    body('prepTimeMinutes').optional({ values: 'null' }).isFloat({ min: 0, max: 240 }).withMessage('Prep time must be between 0 and 240 minutes'),
    body('offerExpiryDate').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid offer expiry date'),
    optStr('cookingTime', 100),
    optStr('serveUpto', 100),
    optTime('startTime'),
    optTime('endTime'),
    optStr('healthLevel', 100),
    optStr('inactivationReason', 1000),
    body('vegType').optional().isIn(['veg', 'non-veg']).withMessage('Invalid veg type'),
    body('prepStation').optional().isIn(['kitchen', 'bar', 'counter']).withMessage('Invalid prep station'),
    body('unit').optional().isIn(MENU_UNITS).withMessage('Invalid unit'),
    body('status').optional().isIn(['active', 'draft', 'archived']).withMessage('Invalid status'),
    optBool('isFeatured'),
    optBool('isHealthy'),
    optBool('inStock'),
    ...optStrArray('images', 50, 2048),
    ...optStrArray('ingredients', 200, 200),
    ...optStrArray('healthTags', 100, 100),
    ...optStrArray('healthyIngredients', 200, 200),
    body('availableDays').optional({ values: 'null' }).isArray({ max: 7 }).withMessage('availableDays must be a list'),
    body('availableDays.*').isIn(WEEK_DAYS).withMessage('Invalid day in availableDays'),
    body('sizes').optional({ values: 'null' }).isArray({ max: 50 }).withMessage('sizes must be a list'),
    body('sizes.*').custom(isPlainObject).withMessage('Invalid size entry'),
    body('sizes.*.price').optional({ values: 'null' }).isFloat({ min: 0, max: MAX_PRICE }).withMessage('Size price must be 0 or greater'),
    body('toppings').optional({ values: 'null' }).isArray({ max: 100 }).withMessage('toppings must be a list'),
    body('toppings.*').custom(isPlainObject).withMessage('Invalid topping entry'),
    body('toppings.*.price').optional({ values: 'null' }).isFloat({ min: 0, max: MAX_PRICE }).withMessage('Topping price must be 0 or greater'),
    body('nutritionalInfo').optional({ values: 'null' }).custom(isPlainObject).withMessage('nutritionalInfo must be an object'),
    // MenuManagement inactivation modal (update only; harmless on create).
    body('inactivationDuration').optional({ values: 'null' }).isIn(['24h', '1w', 'permanent', 'custom'])
        .withMessage('Invalid inactivation duration'),
    body('inactivationDateRange').optional({ values: 'null' }).custom(isPlainObject)
        .withMessage('inactivationDateRange must be an object'),
];

// ADM-041 — CSV-only multer (memory storage) for the bulk import endpoint.
// The shared uploadMiddleware is image-only, so this lives next to the
// route to keep the constraint colocated.
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB — generous for menu sizes
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

// Scan my menu — photos / PDF of a menu card in, DRAFT rows out (nothing is
// saved; the owner confirms and the rows go through POST /import). Image and
// PDF only, memory storage, and a small per-restaurant budget because every
// scan is a paid AI call.
const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 6 },
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) return cb(null, true);
        const err = new Error('Only JPG, PNG, WebP or PDF files are allowed');
        err.status = 400;
        err.expose = true;
        cb(err, false);
    },
});
const scanLimiter = makeLimiter({
    name: 'menu-scan',
    windowMs: 60 * 60 * 1000,
    max: 15,
    keyGenerator: (req) => String(req.restaurant?._id || req.user?.restaurant || ipKeyGenerator(req.ip)),
    message: { success: false, code: 'SCAN_LIMIT', message: 'You have scanned a lot of menus this hour. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
router.post('/scan', protect, adminOnly, checkPermission('editMenu'), scanLimiter, scanUpload.array('files', 6), scanMenu);
// Clear full menu — owner only, dry run for counts, typed confirmation to delete.
router.post('/clear', protect, adminExclusive, checkPermission('editMenu'), clearMenu);

// Public routes — specific paths BEFORE /:id param route
router.get('/search', searchMenuItems);
router.get('/trending', getTrendingItems);
// IMPORTANT — keep /template BEFORE the /:id GET so the parser routes
// the literal path here rather than treating "template" as an id.
router.get('/template', protect, adminOnly, checkPermission('editMenu'), downloadMenuItemTemplate);
router.get('/', getAllMenuItems);
router.get('/:id', validate([menuIdParam]), getMenuItem);
router.get('/:id/customizations', validate([menuIdParam]), getItemCustomizations);

// Protected Admin routes — require 'editMenu' permission
router.post('/', protect, adminOnly, checkPermission('editMenu'), validate(menuItemRules), createMenuItem);
// IMPORTANT — keep /import BEFORE the /:id PUT below so the parser routes
// the literal path here rather than treating "import" as an id.
router.post(
    '/import',
    protect,
    adminOnly,
    checkPermission('editMenu'),
    csvUpload.single('file'),
    importMenuItemsCsv,
);
router.put('/:id', protect, adminOnly, checkPermission('editMenu'), validate([menuIdParam, ...menuItemRules]), updateMenuItem);
router.delete('/:id', protect, adminOnly, checkPermission('editMenu'), validate([menuIdParam]), deleteMenuItem);

// Phase C — branch-specific pricing (admin-only, owner-level)
router.get('/:id/branch-prices', protect, adminOnly, validate([menuIdParam]), getBranchPrices);
router.put('/:id/branch-prices', protect, adminExclusive, validate([
    menuIdParam,
    // The controller silently skips entries with a bad branch / price;
    // only reject shapes that would crash it (non-object entries).
    body('branchPrices').isArray({ max: 500 }).withMessage('branchPrices must be an array.'),
    body('branchPrices.*').custom(isPlainObject).withMessage('Each branch price must be an object'),
    // offerPercentage is clamped to 0..100 by the controller — only the
    // expiry date (stored raw, would CastError → 500) is checked here.
    body('branchPrices.*.offerExpiryDate').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid offer expiry date'),
]), setBranchPrices);

module.exports = router;
