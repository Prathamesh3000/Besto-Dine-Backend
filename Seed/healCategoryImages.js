/**
 * healCategoryImages.js — manual one-off run of the category image
 * auto-healer (the same logic that runs on a 24h schedule in server.js).
 *
 * Does a LIVE HEAD check on every category's image across all tenants and
 * CLEARS any dead (HTTP 404/410) or legacy-placeholder image so the admin
 * UI shows a blank box. Empty images are left alone and nothing is ever
 * filled in (no stock photos since 2026-10-28). Never touches a working
 * image or an admin upload.
 *
 * Usage:
 *   cd Backend
 *   node Seed/healCategoryImages.js          # apply fixes
 *   node Seed/healCategoryImages.js --dry     # preview, no writes
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { runCategoryImageHeal } = require('../utils/categoryImageHealer');

const DRY = process.argv.includes('--dry');

(async () => {
    try {
        if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set in Backend/.env');
        await mongoose.connect(process.env.MONGO_URL);
        console.log(`Connected to MongoDB${DRY ? ' (DRY RUN — no writes)' : ''}`);

        const { scanned, healed, skipped } = await runCategoryImageHeal({ dry: DRY });
        console.log(`\nScanned: ${scanned} | Healed: ${healed} | Skipped (already OK): ${skipped}`);

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Heal error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
})();
