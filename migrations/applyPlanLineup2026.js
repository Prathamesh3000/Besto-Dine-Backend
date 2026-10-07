/**
 * Move the plan catalog to the Silver / Gold / Premium line-up
 * (config/planLineup.js, PRICING_PACKAGING.md §4).
 *
 *   cd Backend && node migrations/applyPlanLineup2026.js --dry-run
 *   cd Backend && node migrations/applyPlanLineup2026.js
 *
 * What it does (idempotent — safe to re-run):
 *   1. First run only (no `silver` plan yet): the old Basic / Standard /
 *      Premium plans become hidden legacy plans. Old `premium` is renamed
 *      to `premium-legacy` so the new Premium can use the slug. Tenants on
 *      them keep their modules, limits and price; only the plan name/slug
 *      labels on their subscription follow the rename. Legacy plans get
 *      the new `campaigns` key set to whatever couponPromotions was (that
 *      bundle used to include campaigns) and the other new keys off.
 *   2. Creates (or refreshes) Silver, Gold and Premium from the line-up.
 *   3. Enterprise gets the new module keys switched on; its price and
 *      limits are left alone.
 *
 * Existing tenants are NOT moved to the new plans — that is a commercial
 * decision per tenant (Super Admin → Restaurants → assign plan).
 */
const { LINEUP, LEGACY_PLANS } = require('../config/planLineup');

const NEW_KEYS = ['campaigns', 'aggregatorOrders', 'accountingExport', 'eInvoice', 'whiteLabelBranding'];

async function applyPlanLineup({ SubscriptionPlan, Restaurant }, { dryRun = false, log = console.log } = {}) {
    const report = { legacy: [], created: [], refreshed: [], enterprise: null };
    const alreadyApplied = !!(await SubscriptionPlan.exists({ slug: 'silver' }));

    // ── 1. Retire the old line-up (first run only) ───────────────────
    if (!alreadyApplied) {
        for (const legacy of LEGACY_PLANS) {
            const plan = await SubscriptionPlan.findOne({ slug: legacy.slug }).lean();
            if (!plan) continue;

            const set = {
                name: legacy.newName,
                slug: legacy.newSlug,
                isPublic: false,
                highlight: false,
                'features.campaigns': plan.features?.couponPromotions === true,
            };
            for (const k of NEW_KEYS) if (k !== 'campaigns') set[`features.${k}`] = false;

            const tenantCount = await Restaurant.countDocuments({ 'subscription.plan': plan._id });
            report.legacy.push({ from: legacy.slug, to: legacy.newSlug, tenants: tenantCount });
            log(`• legacy: ${legacy.slug} → ${legacy.newSlug} ("${legacy.newName}"), hidden; ${tenantCount} tenant(s) keep it`);
            if (dryRun) continue;

            await SubscriptionPlan.updateOne({ _id: plan._id }, { $set: set });
            const label = (prefix) => ({
                [`${prefix}.planSlug`]: legacy.newSlug,
                [`${prefix}.planName`]: legacy.newName,
            });
            await Restaurant.updateMany({ 'subscription.plan': plan._id }, { $set: label('subscription') });
            await Restaurant.updateMany({ 'subscription.pendingUpgrade.plan': plan._id }, { $set: label('subscription.pendingUpgrade') });
            await Restaurant.updateMany({ 'subscription.scheduledDowngrade.plan': plan._id }, { $set: label('subscription.scheduledDowngrade') });
        }
    } else {
        log('• line-up already applied (silver exists) — legacy rename skipped');
    }

    // ── 2. Silver / Gold / Premium ────────────────────────────────────
    for (const spec of LINEUP) {
        if (spec.slug === 'enterprise') continue;
        const existing = await SubscriptionPlan.findOne({ slug: spec.slug }).lean();
        if (existing) {
            report.refreshed.push(spec.slug);
            log(`• refresh: ${spec.slug}`);
            if (!dryRun) {
                await SubscriptionPlan.updateOne({ _id: existing._id }, { $set: {
                    name: spec.name, description: spec.description, price: spec.price,
                    billingCycle: spec.billingCycle, trialDays: spec.trialDays, sortOrder: spec.sortOrder,
                    isPublic: spec.isPublic, highlight: spec.highlight, isActive: true,
                    features: spec.features, limits: spec.limits,
                } });
            }
        } else {
            report.created.push(spec.slug);
            log(`• create: ${spec.slug} (₹${spec.price}/mo)`);
            if (!dryRun) await SubscriptionPlan.create(spec);
        }
    }

    // ── 3. Enterprise — new modules on, everything else untouched ────
    const enterprise = await SubscriptionPlan.findOne({ slug: 'enterprise' }).lean();
    if (enterprise) {
        const set = {};
        for (const k of NEW_KEYS) set[`features.${k}`] = true;
        report.enterprise = 'updated';
        log('• enterprise: new module keys switched on');
        if (!dryRun) await SubscriptionPlan.updateOne({ _id: enterprise._id }, { $set: set });
    } else {
        const spec = LINEUP.find(p => p.slug === 'enterprise');
        report.enterprise = 'created';
        log('• create: enterprise');
        if (!dryRun) await SubscriptionPlan.create(spec);
    }

    return report;
}

module.exports = { applyPlanLineup };

if (require.main === module) {
    const mongoose = require('mongoose');
    require('dotenv').config();
    const SubscriptionPlan = require('../models/subscriptionPlan');
    const Restaurant = require('../models/restaurant');
    const dryRun = process.argv.includes('--dry-run');

    (async () => {
        const uri = process.env.MONGO_URL;
        if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
        console.log(`✔ Connected${dryRun ? ' (DRY RUN — no writes)' : ''}`);
        const report = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { dryRun });
        console.log(JSON.stringify(report, null, 2));
        await mongoose.disconnect();
        console.log('✔ Done');
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
}
