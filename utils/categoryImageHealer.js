// Category image auto-heal.
//
// Does a LIVE HTTP HEAD check on every category image (all tenants) and
// CLEARS any that are definitively dead (HTTP 404 / 410) or still the
// legacy '/uploads/Thumbnil.png' placeholder, so the admin UI shows a
// blank box instead of a broken picture.
//
// It never fills an image in. Until 2026-10-28 a dead, empty or
// placeholder category image was re-pointed to a stock Unsplash photo
// from a hard-coded per-category map; the admin asked that categories
// they never gave a photo stay blank, so that map is gone and an EMPTY
// image is left alone.
//
// Safety rules that keep this from ever clobbering good data:
//   - Only a DEFINITIVE dead signal (HTTP 404 / 410) triggers a clear.
//     A timeout, network blip, or 5xx is treated as "unknown" and left
//     untouched — a flaky scan must never erase a working image.
//   - Admin-uploaded local images (/uploads/… that aren't the legacy
//     placeholder) are assumed alive and never touched.
//   - URL liveness is cached per run (utils/imageLiveness.js), so we hit
//     each distinct URL once.
//
// Wired into server.js as a scheduled job. Disable on multi-instance
// setups via CATEGORY_IMAGE_HEAL_DISABLED=true and poke
// runCategoryImageHeal() from an external cron instead. Interval via
// CATEGORY_IMAGE_HEAL_HOURS (default 24h).

const Category = require('../models/category');
const logger = require('./logger');
const { urlStatus, resetLivenessCache } = require('./imageLiveness');

const PLACEHOLDER = '/uploads/Thumbnil.png';

// Decide whether a category's image must be CLEARED. True only when we're
// confident it won't render as a real photo: the legacy placeholder, or
// an external URL that returns a definitive 404/410. Empty is the intended
// "no image" state and is left alone.
async function needsClear(image) {
    const img = (image || '').trim();
    if (!img) return false;                        // empty — intended blank
    if (img === PLACEHOLDER) return true;          // legacy placeholder
    if (img.startsWith('/uploads/')) return false; // admin-uploaded local asset — assume alive
    if (/^https?:\/\//i.test(img)) {
        return (await urlStatus(img)) === 'dead';  // only definitive 404/410
    }
    return false; // unrecognised shape — leave it
}

/**
 * Scan every category (all tenants) and clear dead / placeholder images.
 * Idempotent and safe to run repeatedly. Never fills an image in.
 *
 * @param {{ dry?: boolean }} opts
 * @returns {Promise<{ scanned:number, healed:number, skipped:number }>}
 */
async function runCategoryImageHeal({ dry = false } = {}) {
    resetLivenessCache();
    const cats = await Category.find({}).select('name image restaurant').lean();
    let healed = 0, skipped = 0;

    for (const cat of cats) {
        if (!(await needsClear(cat.image))) { skipped++; continue; }

        if (!dry) {
            await Category.updateOne({ _id: cat._id }, { $set: { image: '' } });
        }
        healed++;
        logger.info(`category image heal: "${cat.name}" ${cat.image} → (cleared)`);
    }

    if (healed > 0 || dry) {
        logger.info(`category image heal: scanned ${cats.length}, healed ${healed}, skipped ${skipped}${dry ? ' (dry run)' : ''}`);
    }
    return { scanned: cats.length, healed, skipped };
}

const INTERVAL_HOURS = Number(process.env.CATEGORY_IMAGE_HEAL_HOURS) || 24;
const DELAY_MS = 45 * 1000; // first run ~45s after boot (let DB warm up)
let _timer = null;

function startScheduledCategoryImageHeal() {
    if (_timer) return;
    if (process.env.CATEGORY_IMAGE_HEAL_DISABLED === 'true') {
        logger.info('category image heal disabled via CATEGORY_IMAGE_HEAL_DISABLED');
        return;
    }
    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    // #35 — cluster-locked; scheduler logs errors.
    _timer = require('./scheduler').scheduleJob('category-image-heal', intervalMs, () => runCategoryImageHeal(), { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled category image heal every ${INTERVAL_HOURS}h (first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    runCategoryImageHeal,
    startScheduledCategoryImageHeal,
    // exported for tests / manual use
    urlStatus,
};
