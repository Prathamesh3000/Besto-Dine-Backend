#!/usr/bin/env node
/**
 * push-publicApi-to-plans.js - add the `publicApi` feature key (API keys,
 * public API, webhooks) to the Gold / Premium / Enterprise plans and to the
 * plan snapshots existing tenants already carry.
 *
 * Why: tenants keep the features snapshot they signed up with
 * (subscription.features); plans created before `publicApi` existed have no
 * such key, so utils/featureAccess falls back to "off" for them. This is a
 * narrow, additive version of the superadmin "push plan to tenants" action
 * (controllers/superadmin/plans.js pushPlanToTenants): it sets ONLY
 * `publicApi: true`, and ONLY where the key is missing. It never overwrites
 * other features, limits, prices, per-tenant featureOverrides or add-ons,
 * and a tenant/plan that already has an explicit publicApi value (true OR
 * false) is left alone - so re-running is a no-op (idempotent).
 *
 * Targets (slug): gold, premium, enterprise
 *   - SubscriptionPlan docs                       features.publicApi
 *   - Restaurants whose subscription.plan = it    subscription.features.publicApi
 *   - their pendingUpgrade / scheduledDowngrade   <...>.features.publicApi
 *
 * Usage (from Backend/):
 *   node scripts/push-publicApi-to-plans.js            dry run (default, writes nothing)
 *   node scripts/push-publicApi-to-plans.js --apply    write
 *
 * Safety: reads MONGO_URL from the environment / Backend/.env and REFUSES to
 * run (even as a dry run) unless it points at the staging database
 * (utils/stagingGuard). To run against anything else you must pass
 * --i-know-this-is-production AND review the dry run first.
 *
 * Note: if the Silver/Gold/Premium lineup migration has not been run, the
 * slug `premium` is still the OLD premium plan - check the plan names the
 * dry run prints before applying.
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isStagingMongoUrl, redactMongoUrl } = require('../utils/stagingGuard');

const TARGET_SLUGS = ['gold', 'premium', 'enterprise'];

async function main() {
    const argv = process.argv.slice(2);
    const apply = argv.includes('--apply');
    const prodOk = argv.includes('--i-know-this-is-production');
    const url = process.env.MONGO_URL;

    if (!url) {
        console.error('MONGO_URL is not set.');
        process.exit(1);
    }
    if (!isStagingMongoUrl(url) && !prodOk) {
        console.error(
            'REFUSING TO RUN: MONGO_URL is not the staging database.\n'
            + `  MONGO_URL = ${redactMongoUrl(url)}\n`
            + '  Pass --i-know-this-is-production to run against it (dry run first).',
        );
        process.exit(1);
    }

    console.log(`${apply ? 'APPLY' : 'DRY RUN'} against ${redactMongoUrl(url)}`);
    await mongoose.connect(url);
    try {
        // Native collections: plans are global and this must not depend on
        // request-scoped tenant plugins.
        const Plans = require('../models/subscriptionPlan').collection;
        const Restaurants = require('../models/restaurant').collection;

        const plans = await Plans.find({ slug: { $in: TARGET_SLUGS } }).toArray();
        if (!plans.length) console.log('No gold/premium/enterprise plans found - nothing to do.');

        const totals = { plans: 0, tenants: 0, pendingUpgrades: 0, scheduledDowngrades: 0 };
        for (const plan of plans) {
            const missing = { $exists: false };
            console.log(`\nPlan "${plan.name}" (slug ${plan.slug}, price ${plan.price}, id ${plan._id})`);

            const planNeeds = plan.features && plan.features.publicApi !== undefined ? 0 : 1;
            const tenantFilter = { 'subscription.plan': plan._id, 'subscription.features.publicApi': missing };
            const upFilter = { 'subscription.pendingUpgrade.plan': plan._id, 'subscription.pendingUpgrade.features.publicApi': missing };
            const downFilter = { 'subscription.scheduledDowngrade.plan': plan._id, 'subscription.scheduledDowngrade.features.publicApi': missing };

            const [tenants, ups, downs] = await Promise.all([
                Restaurants.countDocuments(tenantFilter),
                Restaurants.countDocuments(upFilter),
                Restaurants.countDocuments(downFilter),
            ]);
            console.log(`  plan doc missing key: ${planNeeds ? 'yes' : 'no'} | tenants: ${tenants} | pending upgrades: ${ups} | scheduled downgrades: ${downs}`);

            if (apply) {
                if (planNeeds) await Plans.updateOne({ _id: plan._id, 'features.publicApi': missing }, { $set: { 'features.publicApi': true } });
                if (tenants) await Restaurants.updateMany(tenantFilter, { $set: { 'subscription.features.publicApi': true } });
                if (ups) await Restaurants.updateMany(upFilter, { $set: { 'subscription.pendingUpgrade.features.publicApi': true } });
                if (downs) await Restaurants.updateMany(downFilter, { $set: { 'subscription.scheduledDowngrade.features.publicApi': true } });
            }
            totals.plans += planNeeds;
            totals.tenants += tenants;
            totals.pendingUpgrades += ups;
            totals.scheduledDowngrades += downs;
        }

        console.log(`\n${apply ? 'Updated' : 'Would update'}: ${totals.plans} plan doc(s), ${totals.tenants} tenant(s), `
            + `${totals.pendingUpgrades} pending upgrade(s), ${totals.scheduledDowngrades} scheduled downgrade(s).`);
        if (!apply) console.log('Dry run only - re-run with --apply to write.');
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
