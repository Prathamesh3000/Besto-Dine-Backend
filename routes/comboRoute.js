const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const {
    getCombos,
    getComboById,
    createCombo,
    updateCombo,
    deleteCombo,
    downloadComboTemplate,
    importCombosCsv,
} = require('../controllers/comboController');

const { protect, adminOnly, checkPermission } = require('../middlewares/authMiddleware');

// CSV-only multer (memory) for the bulk import endpoint. Mirrors the
// shape used by menuRoute / inventoryRoute so admins get a single
// consistent constraint for every CSV-import surface.
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

// IMPORTANT — keep /template and /import BEFORE the /:id routes below
// so the parser doesn't try to treat the literal segments as ObjectIds.
router.get('/template', protect, adminOnly, checkPermission('editMenu'), downloadComboTemplate);
router.post(
    '/import',
    protect,
    adminOnly,
    checkPermission('editMenu'),
    csvUpload.single('file'),
    importCombosCsv,
);

router.route('/')
    .get(getCombos)
    .post(protect, adminOnly, checkPermission('editMenu'), createCombo);

router.route('/:id')
    .get(getComboById)
    .put(protect, adminOnly, checkPermission('editMenu'), updateCombo)
    .delete(protect, adminOnly, checkPermission('editMenu'), deleteCombo);

module.exports = router;
