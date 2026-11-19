/**
 * backfillPlanTiers.js — give every existing SubscriptionPlan the public-card
 * fields added by TRIAL_SIGNUP_AND_LEADS_PLAN §2:
 *
 *   tier   — numeric rank. Missing → slug map (free 0, silver 10, gold 20,
 *            premium 25, enterprise 30), else sortOrder × 10.
 *   trial  — { enabled, durationDays }. Missing → from the legacy trialDays
 *            (enabled = trialDays > 0; durationDays = trialDays, or 14 when
 *            the plan had no trial so switching it on later offers 14 days).
 *
 * Plans that already carry both fields are left alone, so the script is
 * idempotent. Run it BEFORE applyPlanLineup2026.js (deployment order, plan
 * §10); the line-up then overwrites Silver / Gold / Premium / Enterprise
 * with their canonical values anyway.
 *
 * Usage (dry run by default — prints what would change, writes nothing):
 *   cd Backend
 *   node migrations/backfillPlanTiers.js                                        # .env DB, preview
 *   node migrations/backfillPlanTiers.js --apply                                # .env DB, write
 *   node scripts/with-env.js .env.staging node migrations/backfillPlanTiers.js  # staging, preview
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Same workaround as server.js: some LAN DNS servers refuse the SRV lookup
// a mongodb+srv:// Atlas URL needs (querySrv ECONNREFUSED). Use public DNS.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const SubscriptionPlan = require('../models/subscriptionPlan');

const APPLY = process.argv.includes('--apply');

const SLUG_TIERS = { free: 0, silver: 10, gold: 20, premium: 25, enterprise: 30 };
const DEFAULT_TRIAL_DAYS = 14;

/** Rank for a plan lacking `tier`: slug map first, else sortOrder × 10. */
function tierFor(plan) {
    const slug = String(plan.slug || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SLUG_TIERS, slug)) return SLUG_TIERS[slug];
    const so = Number(plan.sortOrder);
    return Number.isFinite(so) && so > 0 ? Math.round(so * 10) : 0;
}

/** `trial` for a plan lacking it, derived from the legacy trialDays. */
function trialFor(plan) {
    const days = Number(plan.trialDays) || 0;
    return { enabled: days > 0, durationDays: days > 0 ? days : DEFAULT_TRIAL_DAYS };
}

const hasTier = (plan) => Number.isFinite(Number(plan.tier)) && plan.tier !== null && plan.tier !== undefined;
const hasTrial = (plan) => !!plan.trial && typeof plan.trial === 'object'
    && typeof plan.trial.enabled === 'boolean' && Number.isFinite(Number(plan.trial.durationDays));

/**
 * Compute and (when apply) write the backfill. Exported so a test can run it
 * against mongodb-memory-server with the real model.
 * @returns {Promise<{ scanned: number, changed: Array<{slug:string, set:object}> }>}
 */
async function backfillPlanTiers({ model = SubscriptionPlan, apply = false, log = console.log } = {}) {
    // AUDIT-EXEMPT: platform-global plan catalogue — no tenant scope.
    const plans = await model.find({}).lean();
    const changed = [];
    for (const plan of plans) {
        const set = {};
        if (!hasTier(plan)) set.tier = tierFor(plan);
        if (!hasTrial(plan)) set.trial = trialFor(plan);
        if (!Object.keys(set).length) continue;
        changed.push({ slug: plan.slug, set });
        log(`• ${plan.slug}: ${JSON.stringify(set)}${apply ? '' : '  (dry run)'}`);
        if (apply) await model.updateOne({ _id: plan._id }, { $set: set });
    }
    return { scanned: plans.length, changed };
}

module.exports = { backfillPlanTiers, tierFor, trialFor, SLUG_TIERS };

if (require.main === module) {
    (async () => {
        const uri = process.env.MONGO_URL;
        if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
        console.log(`✔ Connected${APPLY ? '' : ' (DRY RUN — pass --apply to write)'}`);
        const report = await backfillPlanTiers({ apply: APPLY });
        console.log(`${report.changed.length} of ${report.scanned} plan(s) ${APPLY ? 'updated' : 'would change'}`);
        await mongoose.disconnect();
        console.log('✔ Done');
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
}
