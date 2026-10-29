const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const { checkDeclared, SHARP_DECODABLE } = require('../utils/imageSniff');

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

// Content check (plan 3A.3). fileFilter above only sees the filename and the
// client-declared MIME, which an attacker controls. After multer has buffered
// the file this verifies the leading magic bytes really are a supported image
// and agree with the declared extension / MIME, and (for formats sharp can
// decode) that the image actually decodes. HEIC / BMP / ICO are signature-
// checked only: sharp's prebuilt binary cannot decode them, Cloudinary does.
const badUpload = (message) => {
    const err = new Error(message);
    err.status = 400;
    err.expose = true;
    return err;
};

const verifyImageContent = async (req, res, next) => {
    const files = req.file ? [req.file] : (Array.isArray(req.files) ? req.files : []);
    try {
        for (const file of files) {
            const check = checkDeclared(file, file.buffer);
            if (!check.ok) return next(badUpload(check.reason));
            if (SHARP_DECODABLE.has(check.type)) {
                try {
                    // Shrink-on-load decode — cheap, but fails on truncated / corrupt data.
                    await sharp(file.buffer, { failOn: 'error' }).rotate().resize({ width: 64, withoutEnlargement: true }).png().toBuffer();
                } catch (_e) {
                    return next(badUpload('Image could not be read. Please upload a valid image file.'));
                }
            }
        }
    } catch (_e) {
        return next(badUpload('Invalid image upload'));
    }
    return next();
};

// upload.single(field) is now [multer, content check]; Express flattens the
// array, so every existing `upload.single('image')` route is covered unchanged.
const multerSingle = upload.single.bind(upload);
upload.single = (field) => [multerSingle(field), verifyImageContent];

module.exports = upload;
module.exports.isImageUpload = isImageUpload;
module.exports.verifyImageContent = verifyImageContent;
