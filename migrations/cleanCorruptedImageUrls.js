/**
 * One-shot — repair corrupted image URLs across MenuItem, Category, and Combo.
 *
 * Two corruption patterns observed in production data:
 *
 *   1) "double-scheme prefix"
 *      https://backendhost.example.comhttps://res.cloudinary.com/foo.jpg
 *      → keep only the second URL (real image)
 *
 *   2) "colon-stripped scheme"
 *      https//res.cloudinary.com/foo.jpg
 *      → patch back to https://res.cloudinary.com/foo.jpg
 *
 * The frontend already repairs these defensively on render, but the
 * stored data should be clean too so other consumers (admin export,
 * future SSR, image CDN warmers) get correct URLs.
 *
 * Usage:
 *   node migrations/cleanCorruptedImageUrls.js            # DRY-RUN — reports only, no writes
 *   node migrations/cleanCorruptedImageUrls.js --apply    # WRITE — persists repairs
 *
 * Safe to run multiple times — clean URLs are no-ops.
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Combo = require('../models/combo');

const APPLY = process.argv.includes('--apply');

// Mirror of Frontend/src/utils/image.js#resolveImageUrl repair logic.
// Returns { repaired: string, changed: boolean } — never returns null
// so we can detect "should have been an image but value was junk" cases
// separately from "no repair needed".
function repairUrl(url) {
    if (!url || typeof url !== 'string') return { repaired: url, changed: false };
    const original = url;
    let trimmed = url.trim();
    if (!trimmed) return { repaired: url, changed: false };

    // Pattern 1: double-scheme prefix — cut everything before the second http
    const doubleSchemeMatch = trimmed.match(/^https?:\/\/[^/]+(https?[/:].+)$/i);
    if (doubleSchemeMatch) trimmed = doubleSchemeMatch[1];

    // Pattern 2: colon-stripped scheme — `https//` → `https://`
    trimmed = trimmed.replace(/^(https?)\/\//i, '$1://');

    return { repaired: trimmed, changed: trimmed !== original };
}

function repairArray(arr) {
    if (!Array.isArray(arr)) return { repaired: arr, changed: false, fixedCount: 0 };
    let fixedCount = 0;
    const repaired = arr.map((u) => {
        const r = repairUrl(u);
        if (r.changed) fixedCount += 1;
        return r.repaired;
    });
    return { repaired, changed: fixedCount > 0, fixedCount };
}

async function scanMenuItems() {
    const items = await MenuItem.find({}, { name: 1, images: 1 }).lean();
    const repairs = [];
    for (const it of items) {
        const r = repairArray(it.images);
        if (r.changed) {
            repairs.push({ _id: it._id, name: it.name, before: it.images, after: r.repaired, fixedCount: r.fixedCount });
        }
    }
    return repairs;
}

async function scanCategories() {
    const cats = await Category.find({}, { name: 1, image: 1 }).lean();
    const repairs = [];
    for (const c of cats) {
        const r = repairUrl(c.image);
        if (r.changed) {
            repairs.push({ _id: c._id, name: c.name, before: c.image, after: r.repaired });
        }
    }
    return repairs;
}

async function scanCombos() {
    const combos = await Combo.find({}, { name: 1, image: 1, images: 1 }).lean();
    const repairs = [];
    for (const c of combos) {
        const out = { _id: c._id, name: c.name };
        let any = false;
        if (c.image) {
            const r = repairUrl(c.image);
            if (r.changed) { out.imageBefore = c.image; out.imageAfter = r.repaired; any = true; }
        }
        if (Array.isArray(c.images)) {
            const r = repairArray(c.images);
            if (r.changed) { out.imagesBefore = c.images; out.imagesAfter = r.repaired; any = true; }
        }
        if (any) repairs.push(out);
    }
    return repairs;
}

async function applyMenuItemFixes(repairs) {
    for (const r of repairs) {
        await MenuItem.updateOne({ _id: r._id }, { $set: { images: r.after } });
    }
}

async function applyCategoryFixes(repairs) {
    for (const r of repairs) {
        await Category.updateOne({ _id: r._id }, { $set: { image: r.after } });
    }
}

async function applyComboFixes(repairs) {
    for (const r of repairs) {
        const $set = {};
        if (r.imageAfter !== undefined) $set.image = r.imageAfter;
        if (r.imagesAfter !== undefined) $set.images = r.imagesAfter;
        if (Object.keys($set).length) await Combo.updateOne({ _id: r._id }, { $set });
    }
}

async function main() {
    if (!process.env.MONGO_URL) {
        console.error('Missing MONGO_URL in Backend/.env');
        process.exit(1);
    }
    console.log(`Mode: ${APPLY ? 'APPLY (writes will persist)' : 'DRY-RUN (no writes — re-run with --apply to persist)'}`);
    await mongoose.connect(process.env.MONGO_URL);

    const [menuRepairs, categoryRepairs, comboRepairs] = await Promise.all([
        scanMenuItems(),
        scanCategories(),
        scanCombos(),
    ]);

    console.log('\n=== MenuItem repairs ===');
    console.log(`Items needing repair: ${menuRepairs.length}`);
    for (const r of menuRepairs.slice(0, 5)) {
        console.log(`  ${r.name} (${r._id})`);
        console.log(`    before: ${JSON.stringify(r.before)}`);
        console.log(`    after:  ${JSON.stringify(r.after)}`);
    }
    if (menuRepairs.length > 5) console.log(`  ... and ${menuRepairs.length - 5} more`);

    console.log('\n=== Category repairs ===');
    console.log(`Categories needing repair: ${categoryRepairs.length}`);
    for (const r of categoryRepairs.slice(0, 5)) {
        console.log(`  ${r.name} (${r._id})`);
        console.log(`    before: ${r.before}`);
        console.log(`    after:  ${r.after}`);
    }
    if (categoryRepairs.length > 5) console.log(`  ... and ${categoryRepairs.length - 5} more`);

    console.log('\n=== Combo repairs ===');
    console.log(`Combos needing repair: ${comboRepairs.length}`);
    for (const r of comboRepairs.slice(0, 5)) {
        console.log(`  ${r.name} (${r._id})`);
        if (r.imageBefore) console.log(`    image before: ${r.imageBefore}\n    image after:  ${r.imageAfter}`);
        if (r.imagesBefore) console.log(`    images before: ${JSON.stringify(r.imagesBefore)}\n    images after:  ${JSON.stringify(r.imagesAfter)}`);
    }
    if (comboRepairs.length > 5) console.log(`  ... and ${comboRepairs.length - 5} more`);

    const total = menuRepairs.length + categoryRepairs.length + comboRepairs.length;
    console.log(`\nTotal documents to repair: ${total}`);

    if (APPLY && total > 0) {
        console.log('\nApplying repairs...');
        await Promise.all([
            applyMenuItemFixes(menuRepairs),
            applyCategoryFixes(categoryRepairs),
            applyComboFixes(comboRepairs),
        ]);
        console.log('Done. All documents repaired.');
    } else if (!APPLY && total > 0) {
        console.log('\nDRY-RUN complete. Re-run with --apply to persist changes.');
    } else {
        console.log('\nNothing to do — database is already clean.');
    }

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
