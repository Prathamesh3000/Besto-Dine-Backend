const mongoose = require('mongoose');

/**
 * MarketingSetting — platform-global, editable content for the standalone
 * marketing site (BestoDine-Marketing). A SINGLETON: there is exactly one
 * document, pinned by `key: 'global'`. The Super Admin edits it; the
 * marketing site reads it (unauthenticated) via GET /public/site-config.
 *
 * Tenant-agnostic by design (the marketing site belongs to no tenant), so
 * this is exempt from the tenant-isolation audit.
 *
 * NOTE: TEXT / link content lives here — brand name, contact details, social
 * links, hero copy — plus a couple of editable MEDIA URLs (navbar logo, demo
 * video). Decorative images (hero.jpg, screenshots, etc.) stay as static
 * assets in the marketing project and are intentionally NOT editable here.
 */
const marketingSettingSchema = new mongoose.Schema({
    key: { type: String, default: 'global', unique: true, immutable: true },

    // Brand / identity. brandName is the navbar text; logoUrl (if set) shows
    // an image logo in the navbar instead of the text.
    brandName:   { type: String, trim: true, maxlength: 60,  default: 'BestoDine' },
    tagline:     { type: String, trim: true, maxlength: 160, default: '' },
    logoUrl:     { type: String, trim: true, maxlength: 500, default: '' },

    // Product walkthrough video for the "See it in action" section. Accepts a
    // YouTube/Vimeo embed URL or a direct .mp4/.webm file URL. Blank = the
    // play button opens the lead form instead.
    demoVideoUrl: { type: String, trim: true, maxlength: 500, default: '' },

    // Optional hero copy overrides (blank = use the site's built-in copy)
    heroHeadline: { type: String, trim: true, maxlength: 160, default: '' },
    heroSubtitle: { type: String, trim: true, maxlength: 400, default: '' },

    // "A LOOK INSIDE THE PLATFORM" screenshots (Features page). Editable here so
    // the Super Admin can swap product shots without a redeploy. Each entry has
    // a hosted image URL (uploaded to Cloudinary or pasted) + caption. EMPTY
    // array = the marketing site falls back to its built-in static screenshots.
    platformShots: {
        type: [{
            _id:   false,
            url:   { type: String, trim: true, maxlength: 500, default: '' },
            title: { type: String, trim: true, maxlength: 80,  default: '' },
            desc:  { type: String, trim: true, maxlength: 200, default: '' },
        }],
        default: [],
    },

    // Contact
    supportPhone:   { type: String, trim: true, maxlength: 30,  default: '+91 84596 51600' },
    supportEmail:   { type: String, trim: true, maxlength: 120, default: 'support@bestodine.com' },
    whatsappNumber: { type: String, trim: true, maxlength: 20,  default: '+918459651600' },
    address:        { type: String, trim: true, maxlength: 200, default: 'Pune, Maharashtra, India' },

    // Social links (blank = hide / no-op)
    social: {
        instagram: { type: String, trim: true, maxlength: 200, default: '' },
        facebook:  { type: String, trim: true, maxlength: 200, default: '' },
        linkedin:  { type: String, trim: true, maxlength: 200, default: '' },
        youtube:   { type: String, trim: true, maxlength: 200, default: '' },
        twitter:   { type: String, trim: true, maxlength: 200, default: '' },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

/**
 * Return the singleton, creating it with defaults on first access.
 */
marketingSettingSchema.statics.getSingleton = async function () {
    // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
    let doc = await this.findOne({ key: 'global' });
    if (!doc) doc = await this.create({ key: 'global' });
    return doc;
};

module.exports = mongoose.model('MarketingSetting', marketingSettingSchema);
