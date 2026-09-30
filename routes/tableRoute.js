const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const {
    createTable,
    getTables,
    getBookableTables,
    getTableByToken,
    updateTable,
    deleteTable,
    regenerateQrToken,
    mergeTables,
    unmergeTables,
    assignWaiter,
    freeTable,
    claimTable,
    downloadTablesTemplate,
    importTablesCsv,
} = require('../controllers/tableController');
const { protect, adminOnly, captainOrAdmin, staffOnly, checkPermission } = require('../middlewares/authMiddleware');
const {
    validate,
    body,
    isObjectIdLike,
    objectIdParam,
    requiredObjectId,
    optionalObjectId,
    optionalObjectIdArray,
} = require('../middlewares/validate');

// ── Request validation (BUGS_REPORT #33) ────────────────────────────────
// Mirrors what tableController already accepts: AddTableModal sends
// { name, capacity:int, area:id, branch:id|'' }; the floor views send
// partial { status } / { status, isActive } updates.
const TABLE_STATUSES = ['free', 'occupied', 'reserved', 'merged', 'alert', 'disabled'];
const nonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;
// updateTable only accepts an explicit allowlist (utils/bodyAllowlist.js):
// { name, capacity, area, branch, status, isActive }. Anything else —
// qrToken, soft-delete / merge state, diner snapshot, alerts, activeOrder,
// assignedWaiter (use PUT /:id/assign), restaurant — is refused with a
// 400 so a caller never believes an ignored field was saved.
const { TABLE_UPDATE_FIELDS, disallowedKeys } = require('../utils/bodyAllowlist');

const tableIdParam = objectIdParam('id', 'Invalid table id');

const createTableRules = validate([
    body('name').custom(nonBlankString).withMessage('Table name is required').bail()
        .isLength({ max: 100 }).withMessage('Table name is too long'),
    body('capacity').isInt({ min: 1, max: 1000 }).withMessage('Capacity must be a whole number between 1 and 1000'),
    requiredObjectId('body', 'area', 'Area is required'),
    optionalObjectId('body', 'branch', 'Invalid branch id'),
]);

const updateTableRules = validate([
    tableIdParam,
    body().custom((b) => {
        const bad = disallowedKeys(b, TABLE_UPDATE_FIELDS);
        if (bad.length) throw new Error(`These fields cannot be changed here: ${bad.join(', ')}`);
        return true;
    }),
    body('name').optional().custom(nonBlankString).withMessage('Table name cannot be empty').bail()
        .isLength({ max: 100 }).withMessage('Table name is too long'),
    body('capacity').optional().isInt({ min: 1, max: 1000 }).withMessage('Capacity must be a whole number between 1 and 1000'),
    body('area').optional().custom(isObjectIdLike).withMessage('Invalid area'),
    optionalObjectId('body', 'branch', 'Invalid branch id'),
    body('status').optional().isIn(TABLE_STATUSES).withMessage('Invalid table status'),
    body('isActive').optional().isBoolean().withMessage('isActive must be true or false'),
]);

// CSV-only multer (memory storage) for the bulk-import endpoint. Mirrors
// the menu route's pattern so we don't reuse the image-only upload middleware.
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 }, // 1 MB — generous; tables CSVs are tiny
    fileFilter: (req, file, cb) => {
        const okExt = path.extname(file.originalname).toLowerCase() === '.csv';
        const okMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
            .includes(file.mimetype);
        if (okExt || okMime) return cb(null, true);
        cb(new Error('Only .csv files are allowed'), false);
    },
});

// Public route (customer QR scan)
router.get('/scan/:qrToken', getTableByToken);

// Customer-facing bookable table list. MUST stay above the staff
// `GET /` so the narrow projection is what the booking flow reaches.
// `protect` only — any logged-in user may browse tables to book one;
// the staff listing below keeps `staffOnly` because it exposes the
// seated diner's contact details.
router.get('/bookable', protect, getBookableTables);

// Protected routes (waiter floor view)
router.get('/', protect, staffOnly, getTables);

// Customer claim — logged-in customer attaches themselves to the table
// they QR-scanned, so the admin drawer renders the real diner instead
// of "Walk-in Guest" while they browse the menu pre-order.
router.post('/:id/claim', protect, validate([tableIdParam]), claimTable);

// IMPORTANT — keep /template and /import BEFORE the /:id routes below so the
// parser doesn't try to treat the literal path segment as an ObjectId.
router.get('/template', protect, adminOnly, downloadTablesTemplate);
router.post(
    '/import',
    protect,
    adminOnly,
    csvUpload.single('file'),
    importTablesCsv,
);

// Protected routes — merge/unmerge require 'tables' permission
router.post('/merge', protect, staffOnly, checkPermission('tables'), validate([
    // Missing / <2 entries keeps the controller's own message.
    optionalObjectIdArray('body', 'tableIds', 'tableIds must be a list of valid table ids').bail()
        .custom((v) => v.length <= 50).withMessage('Cannot merge more than 50 tables'),
]), mergeTables);
router.post('/unmerge', protect, staffOnly, checkPermission('tables'), validate([
    requiredObjectId('body', 'tableId', 'A valid tableId is required'),
]), unmergeTables);
// Captain (head waiter) reassigns tables to waiters as part of floor
// control — captainOrAdmin, not adminOnly. The controller is tenant- and
// branch-scoped, so a branch-pinned captain can only touch their own tables.
router.put('/:id/assign', protect, captainOrAdmin, validate([
    tableIdParam,
    // null / '' clears the assignment.
    optionalObjectId('body', 'waiterId', 'Invalid waiter id'),
]), assignWaiter);
router.post('/', protect, adminOnly, createTableRules, createTable);
router.put('/:id', protect, captainOrAdmin, updateTableRules, updateTable);
router.post('/:id/free', protect, captainOrAdmin, validate([
    tableIdParam,
    body('force').optional({ values: 'null' }).isBoolean().withMessage('force must be true or false'),
]), freeTable);
router.delete('/:id', protect, adminOnly, validate([tableIdParam]), deleteTable);
router.post('/:id/qr-token', protect, adminOnly, validate([tableIdParam]), regenerateQrToken);

module.exports = router;
