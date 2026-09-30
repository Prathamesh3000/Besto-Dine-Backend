const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { compressAndUpload } = require('../utils/cloudinaryUploader');
const { sendServerError } = require('../utils/httpErrors');

// @route   POST api/v1/upload
// @desc    Upload an image (compressed → Cloudinary)
// @access  Private/Admin
router.post('/', protect, adminOnly, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload a file' });
        }

        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/uploads',
            maxWidth:     1200,
        });

        // Persist the full Cloudinary URL — host-independent, CDN-cached
        // globally. Frontend's resolveImageUrl passes any URL not
        // starting with /uploads/ through unchanged.
        res.status(200).json({
            success:  true,
            message:  'Image uploaded successfully',
            url:      result.secure_url,
            filename: result.public_id,
        });
    } catch (error) {
        sendServerError(res, error, 'uploadRoute.POST /', 'Image upload failed. Please try again or use a different image.');
    }
});

module.exports = router;
