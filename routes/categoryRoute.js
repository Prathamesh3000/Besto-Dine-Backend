const express = require('express');
const router = express.Router();
const {
    getCategories,
    getCategory,
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories
} = require('../controllers/categoryController');
const { protect, adminOnly, checkPermission } = require('../middlewares/authMiddleware');
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');

// ── Request validation (BUGS_REPORT #33) ────────────────────────────────
// AddCategoryModal sends { name, displayOrder, image:url|null, showOnKiosk, kind }
// on create, { name, image, showOnKiosk, kind } or { status } on update. Name
// required-ness stays with the schema (controller returns its 400).
const categoryIdParam = objectIdParam('id', 'Invalid category id');
const categoryBodyRules = [
    body('name').optional().isString().withMessage('Category name must be text').bail()
        .isLength({ max: 200 }).withMessage('Category name is too long'),
    body('displayOrder').optional({ values: 'null' }).isFloat({ min: 0, max: 100000 })
        .withMessage('displayOrder must be a number 0 or greater'),
    body('image').optional({ values: 'null' }).isString().withMessage('Invalid image').bail()
        .isLength({ max: 4096 }).withMessage('Image URL is too long'),
    body('status').optional().isIn(['active', 'inactive']).withMessage('Invalid status'),
    body('showOnKiosk').optional({ values: 'null' }).isBoolean().withMessage('showOnKiosk must be true or false'),
    // Decision 6 — Food / Drink per category; values match Coupon.scope.
    body('kind').optional().isIn(['food', 'beverages']).withMessage('Category type must be food or beverages'),
    optionalObjectId('body', 'branch', 'Invalid branch id'),
];

router.route('/')
    .get(getCategories)
    .post(protect, adminOnly, checkPermission('editMenu'), validate(categoryBodyRules), createCategory);

router.put('/reorder', protect, adminOnly, checkPermission('editMenu'), validate([
    // Missing / empty array and per-entry id / displayOrder checks keep
    // the controller's own messages; only guard shapes that would crash it.
    body('categories').optional({ values: 'null' }).isArray({ max: 1000 }).withMessage('categories must be a non-empty array'),
    body('categories.*').custom((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
        .withMessage('Each category entry must be an object'),
]), reorderCategories);

router.route('/:id')
    .get(validate([categoryIdParam]), getCategory)
    .put(protect, adminOnly, checkPermission('editMenu'), validate([categoryIdParam, ...categoryBodyRules]), updateCategory)
    .delete(protect, adminOnly, checkPermission('editMenu'), validate([categoryIdParam]), deleteCategory);

module.exports = router;
