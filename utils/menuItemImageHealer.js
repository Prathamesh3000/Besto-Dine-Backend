// Menu-item + combo image auto-heal — scheduled, live-checking.
//
// Does a LIVE HTTP HEAD check on every menu-item and combo image and
// CLEARS any that are definitively dead (404/410) or still the legacy
// '/uploads/Thumbnil.png' placeholder, so the admin UI shows a blank box
// instead of a broken picture.
//
// It no longer writes stock Unsplash photos. Until 2026-10-28 an empty,
// placeholder or dead image was re-pointed to a name-matched pool photo
// (a curated pool, since removed); the admin asked that items they never
// gave a photo stay blank, so an EMPTY image is now left alone and nothing
// is ever filled in. The pool and its seed script no longer exist;
// Seed/clearStockImages.js removes pool photos written before the change.
//
// Safety (identical to the category healer):
//   - Only HTTP 404 / 410 triggers a clear. Timeouts / rate-limits / 5xx
//     are 'unknown' and left untouched — a flaky scan never erases a
//     working image.
//   - Admin-uploaded local images (/uploads/… not the placeholder) are
//     assumed alive and never touched.
//
// Wired into server.js as a setInterval scheduler. Disable on multi-
// instance setups via MENU_IMAGE_HEAL_DISABLED=true and poke
// runMenuItemImageHeal() from an external cron. Interval via
// MENU_IMAGE_HEAL_HOURS (default 24h).

const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');
require('../models/category'); // register schema for populate('category')
const logger = require('./logger');
const { urlStatus, resetLivenessCache } = require('./imageLiveness');

const PLACEHOLDER = '/uploads/Thumbnil.png';

// Does the current first image need clearing? True only when we're
// confident it won't render as a real photo: the legacy placeholder, or
// an external URL that returns a definitive 404/410. Empty is left alone
// (blank box is the intended state) and local uploads are assumed alive.
async function needsClear(image) {
    const img = (image || '').trim();
    if (!img) return false;
    if (img === PLACEHOLDER) return true;
    if (img.startsWith('/uploads/')) return false;
    if (/^https?:\/\//i.test(img)) {
        return (await urlStatus(img)) === 'dead';
    }
    return false;
}

/**
 * Scan every menu item + combo (all tenants) and clear dead / placeholder
 * images. Idempotent and safe to run repeatedly. Never fills an image in.
 *
 * @param {{ dry?: boolean }} opts
 */
async function runMenuItemImageHeal({ dry = false } = {}) {
    resetLivenessCache();

    const items = await MenuItem.find({}).select('name images').lean();
    let itemsHealed = 0, itemsSkipped = 0;
    for (const item of items) {
        const current = (item.images?.[0] || '').trim();
        if (!(await needsClear(current))) { itemsSkipped++; continue; }
        if (!dry) await MenuItem.updateOne({ _id: item._id }, { $set: { images: [] } });
        itemsHealed++;
        logger.info(`menu image heal: item "${item.name}" ${current} → (cleared)`);
    }

    const combos = await Combo.find({}).select('name images').lean();
    let combosHealed = 0, combosSkipped = 0;
    for (const combo of combos) {
        const current = (combo.images?.[0] || '').trim();
        if (!(await needsClear(current))) { combosSkipped++; continue; }
        if (!dry) await Combo.updateOne({ _id: combo._id }, { $set: { images: [] } });
        combosHealed++;
        logger.info(`menu image heal: combo "${combo.name}" ${current} → (cleared)`);
    }

    const healed = itemsHealed + combosHealed;
    if (healed > 0 || dry) {
        logger.info(`menu image heal: items ${itemsHealed}/${items.length}, combos ${combosHealed}/${combos.length} healed${dry ? ' (dry run)' : ''}`);
    }
    return { items: { scanned: items.length, healed: itemsHealed, skipped: itemsSkipped }, combos: { scanned: combos.length, healed: combosHealed, skipped: combosSkipped } };
}

const INTERVAL_HOURS = Number(process.env.MENU_IMAGE_HEAL_HOURS) || 24;
const DELAY_MS = 60 * 1000; // first run ~60s after boot (after the category healer)
let _timer = null;

function startScheduledMenuItemImageHeal() {
    if (_timer) return;
    if (process.env.MENU_IMAGE_HEAL_DISABLED === 'true') {
        logger.info('menu image heal disabled via MENU_IMAGE_HEAL_DISABLED');
        return;
    }
    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    // #35 — cluster-locked; scheduler logs errors.
    _timer = require('./scheduler').scheduleJob('menu-image-heal', intervalMs, () => runMenuItemImageHeal(), { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled menu image heal every ${INTERVAL_HOURS}h (first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    runMenuItemImageHeal,
    startScheduledMenuItemImageHeal,
};
