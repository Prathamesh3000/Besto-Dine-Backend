// Menu-item + combo image auto-heal — the scheduled, live-checking
// counterpart to Seed/applyMenuImages.js.
//
// applyMenuImages.js only refreshes images matching a HARDCODED list of
// known-bad URL patterns (DEAD_IMAGE_PATTERNS), so a photo that 404s
// *after* it shipped stays broken until a human adds the id. This module
// does a LIVE HTTP HEAD check on every menu-item and combo image, so ANY
// dead URL (present or future) is detected automatically and re-pointed
// to an accurate, name-matched, HEAD-verified replacement.
//
// Shares its curated image pool with applyMenuImages.js
// (utils/menuImagePool.js) and its liveness check with the category
// healer (utils/imageLiveness.js).
//
// Safety (identical to the category healer):
//   - Only HTTP 404 / 410 triggers a heal. Timeouts / rate-limits / 5xx
//     are 'unknown' and left untouched — a flaky scan never overwrites a
//     working image.
//   - Admin-uploaded local images (/uploads/… not the placeholder) are
//     assumed alive and never touched.
//   - The replacement is itself HEAD-verified before being written, so a
//     dead exact-name match degrades to the next-best keyword candidate
//     rather than swapping one broken URL for another.
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
const { pickImageCandidates, pickComboCandidates } = require('./menuImagePool');

const PLACEHOLDER = '/uploads/Thumbnil.png';

// Does the current first image need healing? True only when we're
// confident it won't render: empty, the bare placeholder, or an external
// URL that returns a definitive 404/410. Local uploads are assumed alive.
async function needsHeal(image) {
    const img = (image || '').trim();
    if (!img) return true;
    if (img === PLACEHOLDER) return true;
    if (img.startsWith('/uploads/')) return false;
    if (/^https?:\/\//i.test(img)) {
        return (await urlStatus(img)) === 'dead';
    }
    return false;
}

// First HEAD-verified-alive candidate from the ordered list, else the
// placeholder (so the field stays consistent if nothing verifies this run).
async function firstAlive(candidates) {
    for (const url of candidates) {
        if (url === PLACEHOLDER) return PLACEHOLDER;
        if ((await urlStatus(url)) === 'alive') return url;
    }
    return PLACEHOLDER;
}

/**
 * Scan every menu item + combo (all tenants) and heal dead / empty /
 * placeholder images. Idempotent and safe to run repeatedly.
 *
 * @param {{ dry?: boolean }} opts
 */
async function runMenuItemImageHeal({ dry = false } = {}) {
    resetLivenessCache();

    const items = await MenuItem.find({}).populate('category', 'name').select('name images vegType category').lean();
    let itemsHealed = 0, itemsSkipped = 0;
    for (const item of items) {
        const current = (item.images?.[0] || '').trim();
        if (!(await needsHeal(current))) { itemsSkipped++; continue; }
        const newUrl = await firstAlive(pickImageCandidates(item));
        if (newUrl === current) { itemsSkipped++; continue; }
        if (!dry) await MenuItem.updateOne({ _id: item._id }, { $set: { images: [newUrl] } });
        itemsHealed++;
        logger.info(`menu image heal: item "${item.name}" ${current || '(empty)'} → ${newUrl}`);
    }

    const combos = await Combo.find({}).select('name images vegType').lean();
    let combosHealed = 0, combosSkipped = 0;
    for (const combo of combos) {
        const current = (combo.images?.[0] || '').trim();
        if (!(await needsHeal(current))) { combosSkipped++; continue; }
        const newUrl = await firstAlive(pickComboCandidates(combo));
        if (newUrl === current) { combosSkipped++; continue; }
        if (!dry) await Combo.updateOne({ _id: combo._id }, { $set: { images: [newUrl] } });
        combosHealed++;
        logger.info(`menu image heal: combo "${combo.name}" ${current || '(empty)'} → ${newUrl}`);
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
