const multer = require('multer');
const path = require('path');

// Buffer the upload in memory instead of writing to local disk.
// We push the compressed buffer straight to Cloudinary via the helper
// in utils/cloudinaryUploader, so the deploy host never needs a
// writable persistent volume.
const storage = multer.memoryStorage();

// File filter to allow only images
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        // Client error (400 with this message), not a server fault.
        const err = new Error('Only image files (jpg, jpeg, png, webp) are allowed!');
        err.status = 400;
        err.expose = true;
        cb(err, false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: fileFilter
});

module.exports = upload;
