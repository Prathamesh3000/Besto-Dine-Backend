const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { optionalAuth, protect, adminOnly } = require('../middlewares/authMiddleware');
const { body, param, isObjectIdLike } = require('../middlewares/validate');
const { validationResult } = require('express-validator');

// BUGS_REPORT #33 — settings bodies are large nested objects whose field
// rules (email/phone/GSTIN/delivery slabs, schema min/max) already live in
// the controller + Mongoose schema. These chains only check top-level
// section shapes and the schema enums, so a wrong type is a clean 400
// instead of a cast error / 500.
//
// Error shape: Admin Settings.jsx reads `errors` as a { field: message }
// map (Object.values(errors)[0] → toast), matching the controller's own
// ValidationError response — so this route uses a local terminal handler
// that emits that map instead of the shared array format.
function handleSettingsValidation(req, res, next) {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const errors = {};
    for (const e of result.array()) {
        const field = e.path || 'body';
        if (!(field in errors)) errors[field] = String(e.msg || 'Invalid value');
    }
    const first = Object.values(errors)[0] || 'Validation failed';
    return res.status(400).json({ success: false, message: first, errors });
}
const settingsValidate = (chains) => [...chains, handleSettingsValidation];

const OBJECT_SECTIONS = ['general', 'taxes', 'notifications', 'reservation', 'delivery', 'wallet', 'landingPage'];
const ARRAY_SECTIONS = ['operatingHours', 'branches'];
const VALID_SECTIONS = [...OBJECT_SECTIONS, ...ARRAY_SECTIONS];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── landingPage helpers ─────────────────────────────────────────────
const LANDING_SECTION_KEYS = ['featured', 'about', 'hours', 'location', 'branches', 'gallery'];
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const WHATSAPP_PHONE_RE = /^\+?[0-9][0-9\s-]{6,19}$/;
function isHttpUrl(v, max) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s || s.length > max) return false;
    try {
        const u = new URL(s);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
        return false;
    }
}
const optString = (chain, max, label) => chain.optional({ values: 'null' })
    .isString().withMessage(`${label} must be text`).bail()
    .custom((v) => v.trim().length <= max).withMessage(`${label} cannot exceed ${max} characters`);

// Schema enums (models/settings.js), keyed by owning section. For PUT the
// fields sit under `<section>.`; for PATCH the body IS the section and
// `cond` limits the rules to the section named in the URL (`.if()` must
// come first in a chain to gate the validators after it).
const field = (path, cond) => (cond ? body(path).if(cond) : body(path));
const SECTION_FIELD_RULES = {
    reservation: (p, c) => [
        field(`${p}gracePeriod`, c).optional({ values: 'null' })
            .isIn(['5 min', '10 min', '15 min', '30 min', '60 min'])
            .withMessage('Grace period must be one of: 5 min, 10 min, 15 min, 30 min, 60 min'),
        field(`${p}deductionType`, c).optional({ values: 'null' })
            .isIn(['flat', 'percentage']).withMessage('Deduction type must be flat or percentage'),
    ],
    wallet: (p, c) => [
        field(`${p}refundMode`, c).optional({ values: 'null' })
            .isIn(['wallet', 'original']).withMessage('Refund mode must be wallet or original'),
        field(`${p}branchRefundMode`, c).optional({ values: 'null' })
            .isIn(['global', 'per_branch']).withMessage('Branch refund mode must be global or per_branch'),
    ],
    taxes: (p, c) => [
        field(`${p}additionalCharges`, c).optional({ values: 'null' })
            .isArray({ max: 100 }).withMessage('Additional charges must be a list'),
        field(`${p}additionalCharges.*.type`, c).optional({ values: 'null' })
            .isIn(['Flat', 'Percentage']).withMessage('Charge type must be Flat or Percentage'),
    ],
    delivery: (p, c) => [
        field(`${p}slabs`, c).optional({ values: 'null' })
            .isArray({ max: 100 }).withMessage('Delivery ranges must be a list'),
    ],
    // Public landing page (models/settings.js `landingPage`). Limits
    // mirror the schema; featuredItems tenant ownership is checked in
    // settingsController (needs the DB).
    landingPage: (p, c) => [
        field(`${p}enabled`, c).optional({ values: 'null' })
            .isBoolean({ strict: true }).withMessage('enabled must be true or false'),
        optString(field(`${p}tagline`, c), 120, 'Tagline'),
        optString(field(`${p}about`, c), 2000, 'About'),
        field(`${p}coverImages`, c).optional({ values: 'null' })
            .isArray({ max: 6 }).withMessage('At most 6 cover images are allowed'),
        field(`${p}coverImages.*`, c)
            .custom((v) => isHttpUrl(v, 2000)).withMessage('Each cover image must be an http(s) URL'),
        field(`${p}social`, c).optional({ values: 'null' })
            .custom(isPlainObject).withMessage('social must be an object'),
        ...['instagram', 'facebook', 'website', 'googleMapsUrl'].map((k) =>
            field(`${p}social.${k}`, c).optional({ values: 'falsy' })
                .custom((v) => isHttpUrl(v, 300)).withMessage(`${k} must be an http(s) URL of at most 300 characters`)),
        field(`${p}social.whatsapp`, c).optional({ values: 'falsy' })
            .custom((v) => typeof v === 'string' && v.trim().length <= 300
                && (WHATSAPP_PHONE_RE.test(v.trim()) || isHttpUrl(v, 300)))
            .withMessage('WhatsApp must be a phone number or an http(s) link'),
        field(`${p}featuredItems`, c).optional({ values: 'null' })
            .isArray({ max: 8 }).withMessage('At most 8 featured items are allowed'),
        field(`${p}featuredItems.*`, c)
            .custom(isObjectIdLike).withMessage('Each featured item must be a valid menu item id'),
        field(`${p}sections`, c).optional({ values: 'null' })
            .custom(isPlainObject).withMessage('sections must be an object'),
        ...LANDING_SECTION_KEYS.map((k) =>
            field(`${p}sections.${k}`, c).optional({ values: 'null' })
                .isBoolean({ strict: true }).withMessage(`sections.${k} must be true or false`)),
        field(`${p}accentColor`, c).optional({ values: 'falsy' })
            .custom((v) => typeof v === 'string' && HEX_COLOR_RE.test(v.trim()))
            .withMessage('Accent colour must be a hex code like #FE8301'),
    ],
};

const putValidation = settingsValidate([
    body().custom(isPlainObject).withMessage('Settings payload must be an object'),
    ...OBJECT_SECTIONS.map((s) => body(s)
        .optional({ values: 'null' })
        .custom(isPlainObject).withMessage(`${s} must be an object`)),
    ...ARRAY_SECTIONS.map((s) => body(s)
        .optional({ values: 'null' })
        .isArray({ max: 500 }).withMessage(`${s} must be a list`)),
    ...Object.entries(SECTION_FIELD_RULES).flatMap(([s, rules]) => rules(`${s}.`)),
]);

const patchValidation = settingsValidate([
    param('section').isIn(VALID_SECTIONS)
        .withMessage((v) => `Invalid section: ${v}. Valid sections: ${VALID_SECTIONS.join(', ')}`)
        .bail(),
    body().custom((v, { req }) => (ARRAY_SECTIONS.includes(req.params.section)
        ? Array.isArray(v) && v.length <= 500
        : isPlainObject(v)))
        .withMessage((v, { req }) => (ARRAY_SECTIONS.includes(req.params.section)
            ? `${req.params.section} must be a list`
            : `${req.params.section} settings must be an object`)),
    // Section-specific enums, applied only to the section being patched.
    ...Object.entries(SECTION_FIELD_RULES).flatMap(([s, rules]) =>
        rules('', (v, { req }) => req.params.section === s)),
]);

// @route   GET /api/settings
// @access  Public / Optional Auth
router.get('/', optionalAuth, settingsController.getSettings);

// @route   PUT /api/settings
// @access  Private/Admin
router.put('/', protect, adminOnly, putValidation, settingsController.updateSettings);

// @route   PATCH /api/settings/:section
// @access  Private/Admin
router.patch('/:section', protect, adminOnly, patchValidation, settingsController.updateSettingsSection);

module.exports = router;
