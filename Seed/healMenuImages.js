/**
 * healMenuImages.js — manual one-off run of the menu-item + combo image
 * auto-healer (the same logic that runs on a 24h schedule in server.js).
 *
 * Does a LIVE HEAD check on every menu item's and combo's first image
 * across all tenants and CLEARS any dead (HTTP 404/410) or legacy-
 * placeholder image so the admin UI shows a blank box. Empty images are
 * left alone and nothing is ever filled in (no stock photos since
 * 2026-10-28). Never touches a working image or an admin upload.
 *
 * To strip the stock pool photos written before 2026-10-28, see
 * Seed/clearStockImages.js (dry run by default).
 *
 * Usage:
 *   cd Backend
 *   node Seed/healMenuImages.js          # apply fixes
 *   node Seed/healMenuImages.js --dry     # preview, no writes
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { runMenuItemImageHeal } = require('../utils/menuItemImageHealer');

const DRY = process.argv.includes('--dry');

(async () => {
    try {
        if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set in Backend/.env');
        await mongoose.connect(process.env.MONGO_URL);
        console.log(`Connected to MongoDB${DRY ? ' (DRY RUN — no writes)' : ''}`);

        const r = await runMenuItemImageHeal({ dry: DRY });
        console.log(`\nMenu items — scanned ${r.items.scanned}, healed ${r.items.healed}, skipped ${r.items.skipped}`);
        console.log(`Combos     — scanned ${r.combos.scanned}, healed ${r.combos.healed}, skipped ${r.combos.skipped}`);

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Heal error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
})();
