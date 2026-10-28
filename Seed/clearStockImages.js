/**
 * clearStockImages.js — one-off cleanup after the 2026-10-28 decision that
 * menu items, combos and categories the admin never gave a photo must stay
 * BLANK (no stock picture, no placeholder).
 *
 * Until then the CSV importer, the scheduled image healers and the
 * applyMenuImages seed filled such rows with curated Unsplash photos, and
 * categories defaulted to '/uploads/Thumbnil.png'. This script clears:
 *
 *   - any image whose Unsplash photo id is in Seed/stockPhotoIds.json
 *     (every id the removed pools — utils/menuImagePool.js,
 *     utils/dishImagePicker.js, categoryImageHealer, seedFullMenu,
 *     seedNonVegMenu — ever handed out; generated before they were deleted)
 *   - the '/uploads/Thumbnil.png' placeholder
 *   - known-dead placeholder hosts (picsum / source.unsplash, see utils/deadImage.js)
 *
 * Admin uploads (/uploads/<file>) and external URLs that are NOT in the
 * stock pools are never touched.
 *
 * Usage (dry run by default — prints what would change, writes nothing):
 *   cd Backend
 *   node scripts/with-env.js .env.staging node Seed/clearStockImages.js            # staging, preview
 *   node scripts/with-env.js .env.staging node Seed/clearStockImages.js --apply    # staging, write
 *   node Seed/clearStockImages.js --apply --restaurant <slug>                      # .env DB, one tenant
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Same workaround as server.js: some LAN DNS servers refuse the SRV lookup
// a mongodb+srv:// Atlas URL needs (querySrv ECONNREFUSED). Use public DNS.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');
const Category = require('../models/category');
const Restaurant = require('../models/restaurant');
const { isDeadImage } = require('../utils/deadImage');

const APPLY = process.argv.includes('--apply');
const restaurantArgIdx = process.argv.indexOf('--restaurant');
const RESTAURANT_SLUG = restaurantArgIdx !== -1 ? process.argv[restaurantArgIdx + 1] : null;

const PLACEHOLDER = '/uploads/Thumbnil.png';
// Every Unsplash photo id the (now deleted) stock pools ever handed out.
const STOCK_PHOTO_IDS = require('./stockPhotoIds.json');

function loadStockPhotoIds() {
    if (!Array.isArray(STOCK_PHOTO_IDS)) throw new Error('Seed/stockPhotoIds.json must be an array of photo ids');
    return new Set(STOCK_PHOTO_IDS.map((id) => String(id).trim()).filter(Boolean));
}

// Only ever applied to a non-empty URL: an EMPTY image is "nothing to
// clear", even though isDeadImage('') is true for the importers.
function isStock(url, stockIds) {
    const u = String(url || '').trim();
    if (!u) return false;
    if (u === PLACEHOLDER || u.endsWith(PLACEHOLDER)) return true;
    if (isDeadImage(u)) return true;
    const m = u.match(/images\.unsplash\.com\/(photo-[0-9]+-[0-9a-f]+)/);
    return !!(m && stockIds.has(m[1]));
}

(async () => {
    try {
        if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set');
        await mongoose.connect(process.env.MONGO_URL);

        const stockIds = loadStockPhotoIds();
        console.log(`${stockIds.size} stock Unsplash photo ids loaded. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

        const scope = {};
        if (RESTAURANT_SLUG) {
            const r = await Restaurant.findOne({ slug: RESTAURANT_SLUG }).select('_id name').lean();
            if (!r) throw new Error(`No restaurant with slug "${RESTAURANT_SLUG}"`);
            scope.restaurant = r._id;
            console.log(`Scoped to restaurant "${r.name}" (${RESTAURANT_SLUG})`);
        }

        const report = { items: 0, combos: 0, categories: 0, samples: [] };
        const note = (kind, name, url) => { if (report.samples.length < 15) report.samples.push(`${kind} "${name}": ${url}`); };

        // Menu items + combos: images[] → [] when the FIRST image is stock.
        for (const [kind, Model] of [['item', MenuItem], ['combo', Combo]]) {
            const rows = await Model.find(scope).select('name images').lean();
            for (const row of rows) {
                const first = row.images?.[0];
                if (!isStock(first, stockIds)) continue;
                // Keep any admin-provided images that follow the stock one.
                const kept = (row.images || []).slice(1).filter((u) => u && !isStock(u, stockIds));
                note(kind, row.name, first);
                if (APPLY) await Model.updateOne({ _id: row._id }, { $set: { images: kept } });
                report[kind === 'item' ? 'items' : 'combos'] += 1;
            }
        }

        // Categories: image → '' when stock / placeholder.
        const cats = await Category.find(scope).select('name image').lean();
        for (const cat of cats) {
            if (!isStock(cat.image, stockIds)) continue;
            note('category', cat.name, cat.image);
            if (APPLY) await Category.updateOne({ _id: cat._id }, { $set: { image: '' } });
            report.categories += 1;
        }

        console.log(`\n${APPLY ? 'Cleared' : 'Would clear'}: ${report.items} menu items, ${report.combos} combos, ${report.categories} categories`);
        if (report.samples.length) {
            console.log('Examples:');
            for (const s of report.samples) console.log('  - ' + s);
        }
        if (!APPLY) console.log('\nRe-run with --apply to write these changes.');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('clearStockImages failed:', err.message);
        try { await mongoose.disconnect(); } catch { /* ignore */ }
        process.exit(1);
    }
})();
