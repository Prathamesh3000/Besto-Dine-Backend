/**
 * Backfill `subscription.billingCycle = 'monthly'` on every tenant that has no
 * billing cycle yet (everything created before annual billing). Annual /
 * 2-year terms are only ever written by a paid checkout, so 'monthly' is
 * always the right value for existing tenants.
 *
 *   cd Backend && node migrations/backfillBillingCycle.js --dry-run
 *   cd Backend && node migrations/backfillBillingCycle.js
 *
 * Idempotent: only touches tenants where the field is missing/null/empty.
 * (Readers already treat a missing cycle as monthly, so running this is
 * optional hygiene, not a prerequisite for deploying.)
 */
const NEEDS_CYCLE = {
    $or: [
        { 'subscription.billingCycle': { $exists: false } },
        { 'subscription.billingCycle': null },
        { 'subscription.billingCycle': '' },
    ],
    'subscription.plan': { $exists: true },
};

async function backfillBillingCycle({ Restaurant }, { dryRun = false, log = console.log } = {}) {
    const count = await Restaurant.countDocuments(NEEDS_CYCLE);
    log(`• ${count} tenant(s) without subscription.billingCycle`);
    if (!dryRun && count > 0) {
        await Restaurant.updateMany(NEEDS_CYCLE, { $set: { 'subscription.billingCycle': 'monthly' } });
    }
    return { matched: count, updated: dryRun ? 0 : count };
}

module.exports = { backfillBillingCycle };

if (require.main === module) {
    const mongoose = require('mongoose');
    require('dotenv').config();
    const Restaurant = require('../models/restaurant');
    const dryRun = process.argv.includes('--dry-run');

    (async () => {
        const uri = process.env.MONGO_URL;
        if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
        console.log(`Connected${dryRun ? ' (DRY RUN - no writes)' : ''}`);
        console.log(JSON.stringify(await backfillBillingCycle({ Restaurant }, { dryRun }), null, 2));
        await mongoose.disconnect();
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
}
