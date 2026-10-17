const multer = require('multer');
const path = require('path');

// Buffer the upload in memory instead of writing to local disk.
// We push the compressed buffer straight to Cloudinary via the helper
// in utils/cloudinaryUploader, so the deploy host never needs a
// writable persistent volume.
const storage = multer.memoryStorage();

// Any image format is accepted. Every upload is re-encoded to JPG / PNG /
// WebP by utils/cloudinaryUploader before it is stored, so exotic inputs
// (HEIC from iPhones, GIF, BMP, TIFF, AVIF, SVG, ICO…) never reach a page
// as-is. A file counts as an image when the browser says image/* OR the
// extension is a known image type (Windows browsers send HEIC/HEIF with
// an empty or application/octet-stream type).
const IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp', '.png', '.webp', '.gif', '.bmp',
    '.tif', '.tiff', '.svg', '.heic', '.heif', '.avif', '.ico',
]);

const isImageUpload = (file) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return false;          // evil.exe / page.html / no extension
    return mime.startsWith('image/') || mime === '' || mime === 'application/octet-stream';
};

const fileFilter = (req, file, cb) => {
    if (isImageUpload(file)) return cb(null, true);
    // Client error (400 with this message), not a server fault.
    const err = new Error('Only image files are allowed!');
    err.status = 400;
    err.expose = true;
    cb(err, false);
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: fileFilter
});

module.exports = upload;
module.exports.isImageUpload = isImageUpload;
