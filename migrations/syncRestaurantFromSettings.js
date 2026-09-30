/**
 * syncRestaurantFromSettings.js — one-shot backfill.
 *
 * Copies tenant-level Settings.general (cafeName, contactNumber, email)
 * into the matching Restaurant doc's (name, contactPhone, contactEmail)
 * for every tenant.
 *
 * Needed because Settings updates historically never touched the
 * Restaurant doc, so the Super Admin portal kept showing the original
 * seeded values (e.g. "Default Restaurant", "admin@cafe.com",
 * "1234567890") even after the tenant admin edited their Cafe
 * Information. The controller now syncs on every save — this script
 * patches existing rows.
 *
 * Idempotent — running it twice is a no-op.
 *
 *     cd Backend && node migrations/syncRestaurantFromSettings.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Settings = require('../models/settings');
const Restaurant = require('../models/restaurant');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    // Only tenant-level Settings rows (branch=null). Branch-scoped ones
    // belong to the Branch doc, not the Restaurant.
    const tenantSettings = await Settings.find({ branch: null }).lean();
    console.log(`Found ${tenantSettings.length} tenant-level Settings documents.\n`);

    let patched = 0;
    let skipped = 0;

    for (const s of tenantSettings) {
        if (!s.restaurant) { skipped++; continue; }
        const g = s.general || {};

        const update = {};
        if (typeof g.cafeName === 'string' && g.cafeName.trim()) {
            update.name = g.cafeName.trim();
        }
        if (typeof g.contactNumber === 'string' && g.contactNumber.trim()) {
            update.contactPhone = g.contactNumber.trim();
        }
        if (typeof g.email === 'string' && g.email.trim()) {
            const clean = g.email.trim().toLowerCase();
            if (EMAIL_REGEX.test(clean)) update.contactEmail = clean;
        }
        if (Object.keys(update).length === 0) { skipped++; continue; }

        const r = await Restaurant.findById(s.restaurant).select('name contactPhone contactEmail slug').lean();
        if (!r) { skipped++; continue; }

        // Skip when already in sync — keeps the log clean and the
        // script truly idempotent.
        const alreadyInSync =
            (update.name === undefined        || update.name === r.name) &&
            (update.contactPhone === undefined || update.contactPhone === (r.contactPhone || '')) &&
            (update.contactEmail === undefined || update.contactEmail === (r.contactEmail || ''));
        if (alreadyInSync) { skipped++; continue; }

        await Restaurant.findByIdAndUpdate(s.restaurant, { $set: update });
        patched++;
        console.log(`  + ${r.slug}: ${JSON.stringify(update)}`);
    }

    console.log(`\n✔ Done. patched=${patched} skipped=${skipped}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('\nBackfill failed:', err);
    process.exit(1);
});
