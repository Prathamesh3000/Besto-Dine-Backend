// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const MarketingSetting = require('../../models/marketingSetting');
const { compressAndUpload } = require('../../utils/cloudinaryUploader');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// GET /api/v1/superadmin/marketing
exports.getMarketingSettings = async (_req, res) => {
    try {
        // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
        const settings = await MarketingSetting.getSingleton();
        return res.status(200).json({ success: true, data: settings });
    } catch (err) {
        logger.error('getMarketingSettings error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load marketing settings' });
    }
};

// PUT /api/v1/superadmin/marketing
exports.updateMarketingSettings = async (req, res) => {
    try {
        // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
        const settings = await MarketingSetting.getSingleton();

        // Track field-level changes so the audit log records *what* the Super
        // Admin actually edited (old → new), not just the brand name.
        const changes = {};
        // Short values render inline in the audit diff; long ones (hero copy,
        // URLs) are truncated so the payload stays readable.
        const previewVal = (v) => {
            const s = String(v ?? '');
            return s.length > 120 ? s.slice(0, 117) + '…' : s;
        };
        const noteChange = (field, oldVal, newVal) => {
            if (String(oldVal ?? '') === String(newVal ?? '')) return;
            changes[field] = { from: previewVal(oldVal), to: previewVal(newVal) };
        };

        const STR_FIELDS = [
            'brandName', 'tagline', 'logoUrl', 'demoVideoUrl',
            'heroHeadline', 'heroSubtitle',
            'supportPhone', 'supportEmail', 'whatsappNumber', 'address',
        ];
        for (const f of STR_FIELDS) {
            if (req.body[f] !== undefined) {
                const next = String(req.body[f]).trim();
                noteChange(f, settings[f], next);
                settings[f] = next;
            }
        }

        if (req.body.social && typeof req.body.social === 'object') {
            settings.social = settings.social || {};
            for (const k of ['instagram', 'facebook', 'linkedin', 'youtube', 'twitter']) {
                if (req.body.social[k] !== undefined) {
                    const next = String(req.body.social[k]).trim();
                    noteChange(`social.${k}`, settings.social[k], next);
                    settings.social[k] = next;
                }
            }
        }

        // Platform screenshots — keep only rows with an image URL, cap at 8.
        if (Array.isArray(req.body.platformShots)) {
            const prevCount = Array.isArray(settings.platformShots) ? settings.platformShots.length : 0;
            settings.platformShots = req.body.platformShots
                .filter(s => s && typeof s === 'object' && String(s.url || '').trim())
                .slice(0, 8)
                .map(s => ({
                    url:   String(s.url   || '').trim().slice(0, 500),
                    title: String(s.title || '').trim().slice(0, 80),
                    desc:  String(s.desc  || '').trim().slice(0, 200),
                }));
            if (prevCount !== settings.platformShots.length) {
                changes.platformShots = { from: `${prevCount} screenshot(s)`, to: `${settings.platformShots.length} screenshot(s)` };
            }
        }

        settings.updatedBy = req.user._id;
        await settings.save();

        const changedFields = Object.keys(changes);
        await recordAudit(req, {
            action: 'marketing.update',
            targetType: 'platform',
            targetName: 'Marketing site content',
            details: {
                brandName: settings.brandName,
                changedFields,
                ...(changedFields.length ? { changes } : { note: 'Saved with no field changes' }),
            },
        });

        return res.status(200).json({ success: true, data: settings, message: 'Marketing content updated' });
    } catch (err) {
        logger.error('updateMarketingSettings error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update marketing settings' });
    }
};

// POST /api/v1/superadmin/marketing/logo  (multipart field: image)
// Uploads a logo image to Cloudinary and returns its URL. The client then
// saves it as logoUrl via the normal PUT /marketing — so the field accepts
// either a pasted URL or an uploaded file.
exports.uploadMarketingLogo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an image file' });
        }
        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/marketing',
            maxWidth:     600,
        });
        return res.status(200).json({ success: true, url: result.secure_url, message: 'Logo uploaded' });
    } catch (err) {
        logger.error('uploadMarketingLogo error: ' + err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to upload logo' });
    }
};

// POST /api/v1/superadmin/marketing/screenshot  (multipart field: image)
// Uploads a "platform screenshot" to Cloudinary and returns its URL. Same flow
// as the logo upload but kept wider (1280px) since these render large in the
// "A LOOK INSIDE THE PLATFORM" grid. The client saves the URL into one
// platformShots row, then persists via the normal PUT /marketing.
exports.uploadMarketingScreenshot = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an image file' });
        }
        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/marketing',
            maxWidth:     1280,
        });
        return res.status(200).json({ success: true, url: result.secure_url, message: 'Screenshot uploaded' });
    } catch (err) {
        logger.error('uploadMarketingScreenshot error: ' + err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to upload screenshot' });
    }
};
