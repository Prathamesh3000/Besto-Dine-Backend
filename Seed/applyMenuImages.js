/**
 * applyMenuImages.js — refresh menu item + combo photos (manual run).
 *
 * The seed data shipped with the demo tenant points at a handful of
 * Unsplash photos that have since 404'd (Unsplash periodically reaps
 * unused photos). The customer-facing UI then renders broken thumbnails
 * across Home / Cart / Search / Orders.
 *
 * This script picks an appropriate image per menu item from a curated
 * pool of verified Unsplash URLs (see utils/menuImagePool.js — the
 * single source of truth, shared with the scheduled
 * utils/menuItemImageHealer.js). Items already pointing at a working
 * image are left alone unless `--force` is supplied.
 *
 * Usage:
 *     cd Backend
 *     node Seed/applyMenuImages.js              # only fix items + combos with no/dead image
 *     node Seed/applyMenuImages.js --force      # overwrite every menu item AND combo
 *     node Seed/applyMenuImages.js --dry        # preview without writes
 *
 * What counts as "dead" here (refresh trigger): the known-bad URL
 * patterns in DEAD_IMAGE_PATTERNS (legacy 404'd ids, picsum.photos, the
 * deprecated source.unsplash.com). For LIVE 404 detection of arbitrary
 * URLs that die later, the scheduled menuItemImageHealer (HEAD-checks
 * every image) is the automatic counterpart — run on a 24h timer.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');
require('../models/category'); // register schema for populate('category')

// Curated pool + scorer live in one shared module (also used by the
// scheduled healer) so the image data never drifts between the two.
const {
    COMBO_NAME_MAP,
    normaliseNameKey,
    pickImage,
} = require('../utils/menuImagePool');

const FORCE = process.argv.includes('--force');
const DRY   = process.argv.includes('--dry');

// Refresh trigger list. Each pattern matches a known-bad image source:
//   1. The two original 404'd Unsplash IDs the demo seed shipped with.
//   2. picsum.photos — random-image CDN seeded by name; produces galaxy /
//      bridge shots for "Aloo Tikki" etc. and was used by the menu /
//      combo master CSV templates before 2026-05-27.
//   3. source.unsplash.com — the Unsplash Source endpoint, deprecated
//      mid-2024 and now redirects to login on most requests, so any
//      menu item still pointing there shows a broken thumbnail.
const DEAD_IMAGE_PATTERNS = [
    /^https?:\/\/images\.unsplash\.com\/photo-(1567620905732-2d1ec7bb7445|1484723088339-323833995221)/i,
    /^https?:\/\/(?:[a-z0-9-]+\.)?picsum\.photos\//i,
    /^https?:\/\/source\.unsplash\.com\//i,
];

function needsRefresh(currentImages) {
    if (FORCE) return true;
    const first = Array.isArray(currentImages) ? currentImages[0] : null;
    if (!first || typeof first !== 'string') return true;
    return DEAD_IMAGE_PATTERNS.some((re) => re.test(first));
}

async function main() {
    if (!process.env.MONGO_URL) {
        console.error('FATAL: MONGO_URL is not set');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL, { family: 4 });
    console.log('Connected.');
    console.log(FORCE ? 'FORCE — overwriting every item\n' : 'Selective — only items with missing/dead images will be touched\n');
    if (DRY) console.log('DRY RUN — no writes will be made\n');

    const items = await MenuItem.find({}).populate('category', 'name').lean();
    console.log(`Scanning ${items.length} menu item(s)…\n`);

    let updated = 0;
    let skipped = 0;

    for (const item of items) {
        if (!needsRefresh(item.images)) {
            skipped++;
            continue;
        }
        const newUrl = pickImage(item);
        const before = item.images?.[0] || '(none)';
        console.log(`  + ${item.name.padEnd(32)} | ${before.slice(-50).padStart(50)} → ${newUrl.slice(-50)}`);
        if (!DRY) {
            await MenuItem.updateOne(
                { _id: item._id },
                { $set: { images: [newUrl] } }
            );
        }
        updated++;
    }

    // ── Combos ─────────────────────────────────────────────────────
    // Combos share the same images[] field shape and the same dead-
    // URL problem (the master template seeded picsum/source-unsplash).
    // Prefer the exact combo-name override; otherwise the keyword
    // scorer collapses every combo to the same "platter" fallback.
    const combos = await Combo.find({}).lean();
    console.log(`\nScanning ${combos.length} combo(s)…\n`);
    let comboUpdated = 0;
    let comboSkipped = 0;
    for (const combo of combos) {
        if (!needsRefresh(combo.images)) { comboSkipped++; continue; }
        const comboKey = normaliseNameKey(combo.name);
        let newUrl = COMBO_NAME_MAP[comboKey];
        if (!newUrl) {
            const synthetic = {
                name: combo.name,
                category: { name: 'combo platter meal feast' },
                vegType: combo.vegType,
            };
            newUrl = pickImage(synthetic);
        }
        const before = combo.images?.[0] || '(none)';
        console.log(`  + ${combo.name.padEnd(32)} | ${before.slice(-50).padStart(50)} → ${newUrl.slice(-50)}`);
        if (!DRY) {
            await Combo.updateOne(
                { _id: combo._id },
                { $set: { images: [newUrl] } }
            );
        }
        comboUpdated++;
    }

    console.log('—');
    console.log(`Menu items — Updated: ${updated}, Skipped: ${skipped}`);
    console.log(`Combos    — Updated: ${comboUpdated}, Skipped: ${comboSkipped}`);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('applyMenuImages failed:', err);
    process.exit(1);
});
