/**
 * Write the default operations profile (OPERATIONS_CONTROL_PANEL_DESIGN.md
 * §7) to every restaurant that does not have one yet.
 *
 *   cd Backend && node migrations/applyOperationsDefaults.js --dry-run
 *   cd Backend && node migrations/applyOperationsDefaults.js
 *
 * The default profile reproduces today's behaviour exactly (every module
 * in use, dine-in pay after the meal), so this changes nothing about how
 * any restaurant works. It only makes the profile visible and auditable
 * in Super Admin → Restaurant → Operations. A restaurant without the
 * field already resolves to the same defaults (utils/operationsProfile).
 *
 * Idempotent: restaurants that already have `operations` are skipped, so
 * a profile the Super Admin has set is never overwritten. Plans, add-ons,
 * overrides and prices are not touched.
 */
const { DEFAULT_PROFILE } = require('../utils/operationsProfile');

// "No profile yet": the field is missing OR stored as null (an explicit
// `operations: null` is how a cleared profile looks). `$exists: false`
// alone never matches null, so the write below would silently skip it.
const NO_PROFILE_FILTER = { $or: [{ operations: { $exists: false } }, { operations: null }] };

/**
 * Report:
 *   scanned     restaurants looked at
 *   alreadySet  had a profile object → skipped
 *   written     dry run: would be written; real run: actually modified
 *   raced       real run only: a profile appeared between the read and
 *               the guarded write, so nothing was written for it
 */
async function applyOperationsDefaults({ Restaurant }, { dryRun = false, log = console.log } = {}) {
    const report = { scanned: 0, alreadySet: 0, written: 0, raced: 0 };

    const restaurants = await Restaurant.find({}).select('_id name operations').lean();
    for (const r of restaurants) {
        report.scanned += 1;
        if (r.operations && typeof r.operations === 'object') {
            report.alreadySet += 1;
            continue;
        }
        log(`• default profile: ${r.name || r._id}`);
        if (dryRun) { report.written += 1; continue; }
        // Guard on the field still being missing / null, so a profile saved
        // by the Super Admin between the read and this write is never
        // clobbered — and count only what the database really changed.
        const res = await Restaurant.updateOne(
            { _id: r._id, ...NO_PROFILE_FILTER },
            { $set: { operations: { ...JSON.parse(JSON.stringify(DEFAULT_PROFILE)), updatedAt: new Date() } } },
        );
        const modified = res && typeof res.modifiedCount === 'number' ? res.modifiedCount : (res?.nModified ?? 1);
        if (modified > 0) report.written += 1;
        else report.raced += 1;
    }

    return report;
}

module.exports = { applyOperationsDefaults, NO_PROFILE_FILTER };

if (require.main === module) {
    const mongoose = require('mongoose');
    require('dotenv').config();
    const Restaurant = require('../models/restaurant');
    const dryRun = process.argv.includes('--dry-run');

    (async () => {
        const uri = process.env.MONGO_URL;
        if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
        console.log(`✔ Connected${dryRun ? ' (DRY RUN — no writes)' : ''}`);
        const report = await applyOperationsDefaults({ Restaurant }, { dryRun });
        console.log(JSON.stringify(report, null, 2));
        await mongoose.disconnect();
        console.log('✔ Done');
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
}
