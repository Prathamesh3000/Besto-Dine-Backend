const multer = require('multer');
const path = require('path');

// Shared CSV upload middleware — same config we use for Tables and Staff
// bulk-add: memory storage (no disk writes), 1 MB cap, .csv extension OR
// a CSV-ish mime type. Centralised here so the Bookings bulk-add routes
// (Event Types / Packages / Halls / Decoration Packages) and any future
// bulk-import flows share the exact same validation surface.
//
// Usage:
//   const { csvUpload } = require('../middlewares/csvUpload');
//   router.post('/import', protect, adminOnly, csvUpload.single('file'), ctrl.importCsv);
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const okExt = path.extname(file.originalname).toLowerCase() === '.csv';
        const okMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
            .includes(file.mimetype);
        if (okExt || okMime) return cb(null, true);
        // Marked as a client error so the global handler answers 400 with
        // this message instead of a generic 500 (app.js maps MulterError
        // size/field limits the same way).
        const err = new Error('Only .csv files are allowed');
        err.status = 400;
        err.expose = true;
        cb(err, false);
    },
});

module.exports = { csvUpload };
