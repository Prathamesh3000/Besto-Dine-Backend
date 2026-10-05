/**
 * setRefundModeOriginal.js — one-shot settings migration (Decision 1, 2026-10).
 *
 * Product decision: refunds go back to the customer's ORIGINAL payment
 * method by default (Razorpay refund for online payments) instead of
 * being credited to the BestoDine wallet. models/settings.js now defaults
 * wallet.refundMode to 'original', but every tenant created before the
 * change already has 'wallet' STORED (the old schema default was written
 * on create), so the new default never reaches them. This script sets
 *
 *     wallet.refundMode = 'original'
 *
 * on every settings document (tenant-level AND branch-level) where it is
 * 'wallet' or missing.
 *
 * WARNING — it cannot tell the old default apart from a deliberate choice.
 * A tenant who picked "wallet" on purpose in Admin → Settings is flipped
 * too. To keep such tenants on wallet refunds, list their Restaurant ids
 * (comma-separated) in the EXCLUDE_RESTAURANTS environment variable or
 * the --exclude= flag; their settings documents (all branches) are
 * left untouched:
 *
 *     node migrations/setRefundModeOriginal.js --exclude=64f0...a1,64f0...b2
 *     EXCLUDE_RESTAURANTS=64f0...a1 node migrations/setRefundModeOriginal.js
 *
 * Run --dry-run first: it only reports how many documents (and which
 * restaurants) would change, and writes nothing.
 *
 * This script is FULLY IDEMPOTENT — re-running it after it has applied is
 * a no-op (0 matched).
 *
 * Run from the Backend directory:
 *
 *     node migrations/setRefundModeOriginal.js --dry-run
 *     node migrations/setRefundModeOriginal.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

function parseExcludes() {
    const flag = process.argv.find(a => a.startsWith('--exclude='));
    const raw = [flag ? flag.slice('--exclude='.length) : '', process.env.EXCLUDE_RESTAURANTS || '']
        .join(',')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const bad = raw.filter(id => !mongoose.Types.ObjectId.isValid(id));
    if (bad.length) {
        console.error(`Invalid restaurant id(s) in exclude list: ${bad.join(', ')}`);
        process.exit(1);
    }
    return [...new Set(raw)].map(id => new mongoose.Types.ObjectId(id));
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }
    const excludes = parseExcludes();

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log(`✔ Connected to MongoDB${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}\n`);

    const settings = mongoose.connection.db.collection('settings');

    const filter = {
        $or: [
            { 'wallet.refundMode': 'wallet' },
            { 'wallet.refundMode': { $exists: false } },
            { 'wallet.refundMode': null },
        ],
    };
    if (excludes.length) filter.restaurant = { $nin: excludes };

    const total = await settings.countDocuments({});
    const already = await settings.countDocuments({ 'wallet.refundMode': 'original' });
    const storedWallet = await settings.countDocuments({ 'wallet.refundMode': 'wallet', ...(excludes.length ? { restaurant: { $nin: excludes } } : {}) });
    const toChange = await settings.countDocuments(filter);
    const excludedCount = excludes.length
        ? await settings.countDocuments({ restaurant: { $in: excludes } })
        : 0;

    console.log(`settings documents:            ${total}`);
    console.log(`already 'original':            ${already}`);
    console.log(`stored 'wallet' (not excluded): ${storedWallet}`);
    console.log(`missing / null (not excluded):  ${toChange - storedWallet}`);
    console.log(`excluded (left untouched):      ${excludedCount}${excludes.length ? `  [${excludes.join(', ')}]` : ''}`);
    console.log(`→ to set 'original':            ${toChange}\n`);

    if (DRY_RUN) {
        const sample = await settings
            .find(filter, { projection: { restaurant: 1, branch: 1, 'wallet.refundMode': 1 } })
            .limit(50)
            .toArray();
        for (const s of sample) {
            console.log(`  would change restaurant=${s.restaurant} branch=${s.branch || 'tenant'} refundMode=${s.wallet?.refundMode ?? '(missing)'}`);
        }
        if (toChange > sample.length) console.log(`  … and ${toChange - sample.length} more`);
        console.log('\n✔ Dry run complete — no changes written.');
    } else if (toChange === 0) {
        console.log('= Nothing to do — every settings document is already on original refunds.');
    } else {
        const res = await settings.updateMany(filter, { $set: { 'wallet.refundMode': 'original' } });
        console.log(`+ matched ${res.matchedCount}, modified ${res.modifiedCount}`);
        console.log('\n✔ Done. Refunds now go back to the original payment method for these tenants.');
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
