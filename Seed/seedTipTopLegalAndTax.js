/**
 * seedTipTopLegalAndTax.js — populate Business licenses + Tax config
 * for the "Hotel Tip Top" tenant (slug: hotel-tip-top).
 *
 * Writes:
 *   1. Restaurant.legal — legalBusinessName, fssaiLicense, gstin, pan
 *   2. Settings(branch=null).general.legal — mirror of the above so the
 *      tenant admin's Settings UI shows the same values.
 *   3. Settings(branch=null).taxes — GST, service charge, packaging fee.
 *
 * Idempotent by default: skips fields that already have a value.
 * Pass `--force` to overwrite existing values:
 *
 *     cd Backend && node Seed/seedTipTopLegalAndTax.js          (safe)
 *     cd Backend && node Seed/seedTipTopLegalAndTax.js --force  (overwrite)
 *
 * NOTE: The license / tax identifiers below are DEMO placeholders that
 * pass the model's regex validators. Replace with the tenant's real
 * documents before going to production.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Restaurant = require('../models/restaurant');
const Settings   = require('../models/settings');

const TENANT_SLUG = 'hotel-tip-top';
const FORCE = process.argv.includes('--force');

// Demo values — all pass the validators in models/restaurant.js
const LEGAL = {
    legalBusinessName: 'Hotel Tip Top Hospitality Pvt Ltd',
    fssaiLicense:      '12345678901234',   // 14 digits
    gstin:             '27AAAPL1234C1Z5',  // 15-char GSTIN, MH state code 27
    pan:               'AAAPL1234C',       // 10-char PAN (matches GSTIN block 3-12)
};

const TAXES = {
    serviceCharge: { enabled: true, value: 5 },
    gst:           { enabled: true, value: 5 },   // restaurant GST in India is 5% (no ITC)
    additionalCharges: [
        { name: 'Packaging Fee', value: 15, type: 'Flat', enabled: true },
    ],
};

function pickWritable(target, source) {
    // Returns { update, skipped } where update only contains keys whose
    // current target value is empty (unless --force).
    const update = {};
    const skipped = {};
    for (const [k, v] of Object.entries(source)) {
        const current = target?.[k];
        const isEmpty = current === undefined || current === null || current === '';
        if (FORCE || isEmpty) update[k] = v;
        else skipped[k] = current;
    }
    return { update, skipped };
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB');
    if (FORCE) console.log('  --force passed: existing values will be overwritten\n');
    else console.log('  (idempotent mode: existing values preserved — use --force to overwrite)\n');

    // 1. Resolve tenant
    const restaurant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!restaurant) {
        console.error(`✗ No tenant with slug "${TENANT_SLUG}" found.`);
        await mongoose.disconnect();
        process.exit(1);
    }
    console.log(`✔ Found tenant: ${restaurant.name} (${restaurant._id})`);

    // 2. Patch Restaurant.legal — use $set on the specific paths so we
    //    only validate the legal subdoc, not unrelated pre-existing
    //    fields (e.g. an over-long `city`) that would block .save().
    const { update: legalUpdate, skipped: legalSkipped } = pickWritable(
        restaurant.legal?.toObject ? restaurant.legal.toObject() : restaurant.legal,
        LEGAL,
    );
    if (Object.keys(legalUpdate).length > 0) {
        const setOps = {};
        for (const [k, v] of Object.entries(legalUpdate)) setOps[`legal.${k}`] = v;
        await Restaurant.findByIdAndUpdate(
            restaurant._id,
            { $set: setOps },
            { runValidators: true },
        );
        console.log(`  + Restaurant.legal updated:`, legalUpdate);
    } else {
        console.log('  = Restaurant.legal already populated — nothing to write');
    }
    if (Object.keys(legalSkipped).length > 0) {
        console.log('    (kept existing:', legalSkipped, ')');
    }

    // 3. Patch / create tenant-level Settings (branch=null)
    let settings = await Settings.findOne({ restaurant: restaurant._id, branch: null });
    if (!settings) {
        settings = new Settings({
            restaurant: restaurant._id,
            branch: null,
            general: { cafeName: restaurant.name },
        });
        console.log('  + Creating tenant-level Settings document');
    }

    // 3a. legal mirror
    settings.general = settings.general || {};
    settings.general.legal = settings.general.legal || {};
    const { update: settingsLegalUpdate } = pickWritable(
        settings.general.legal?.toObject ? settings.general.legal.toObject() : settings.general.legal,
        LEGAL,
    );
    Object.assign(settings.general.legal, settingsLegalUpdate);
    if (Object.keys(settingsLegalUpdate).length > 0) {
        console.log('  + Settings.general.legal updated:', settingsLegalUpdate);
    } else {
        console.log('  = Settings.general.legal already populated');
    }

    // 3b. taxes — only overwrite if section is empty or --force
    const taxesEmpty =
        !settings.taxes ||
        (settings.taxes.serviceCharge?.value === undefined &&
         settings.taxes.gst?.value === undefined &&
         (!settings.taxes.additionalCharges || settings.taxes.additionalCharges.length === 0));

    if (FORCE || taxesEmpty) {
        settings.taxes = TAXES;
        console.log('  + Settings.taxes set:', JSON.stringify(TAXES));
    } else {
        console.log('  = Settings.taxes already configured — preserved');
    }

    await settings.save();

    console.log('\n✔ Done.');
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('\nSeed failed:', err);
    process.exit(1);
});
