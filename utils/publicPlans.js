/**
 * Public plan catalogue — GET /public/plans (platform home / hotel
 * signup pricing). Only `isPublic && isActive` plans, public-safe fields
 * only (no Razorpay ids, no internal limits like apiRateLimit /
 * auditRetentionDays). Cached 5 minutes; Super Admin plan writes call
 * `publicPlansCache.invalidate()`.
 */
'use strict';

const SubscriptionPlan = require('../models/subscriptionPlan');
const listCache = require('./listCache');
const { priceForPlan, buildCycleRows, gstRate } = require('./billingCycles');

const PUBLIC_PLANS_TTL_MS = 5 * 60 * 1000;

function toPlain(v) {
    if (!v) return {};
    return v.toObject ? v.toObject() : { ...v };
}

/**
 * `{ enabled, durationDays }` for any plan document — also for rows written
 * before the `trial` object existed (derived from the legacy trialDays) and
 * for lean rows where the sub-document has no defaults applied.
 */
function trialShape(p) {
    const t = p?.trial && typeof p.trial === 'object' ? p.trial : null;
    const legacyDays = Number(p?.trialDays) || 0;
    const enabled = t && typeof t.enabled === 'boolean' ? t.enabled : legacyDays > 0;
    const durationDays = t && Number.isFinite(Number(t.durationDays))
        ? Number(t.durationDays)
        : (legacyDays > 0 ? legacyDays : 14);
    return { enabled, durationDays };
}

/** Numeric rank; 0 is valid, missing (pre-migration row) reads as 0. */
function tierOf(p) {
    const n = Number(p?.tier);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function highlightsOf(p) {
    return Array.isArray(p?.highlights)
        ? p.highlights.filter((h) => typeof h === 'string' && h.trim()).map((h) => h.trim())
        : [];
}

function publicPlanShape(p) {
    const limits = toPlain(p.limits);
    const features = toPlain(p.features);
    delete features._id;
    return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        description: p.description || '',
        price: p.price,
        // Per-cycle list prices, BEFORE GST (null = cycle not sold), the GST
        // rate (percent) added at checkout, and ready-made rows for a pricing
        // table: { cycle, months, price, gst, total, perMonthEquivalent, savingsPctVsMonthly }.
        prices: {
            monthly:  priceForPlan(p, 'monthly'),
            annual:   priceForPlan(p, 'annual'),
            biennial: priceForPlan(p, 'biennial'),
        },
        gstRate: gstRate(),
        cycles: buildCycleRows(p),
        currency: p.currency || 'INR',
        billingCycle: p.billingCycle,
        trialDays: p.trialDays || 0,
        // Card fields (TRIAL_SIGNUP_AND_LEADS_PLAN §2): rank for upgrade /
        // downgrade and the "Contact Sales" CTA, trial switch, badge, bullets.
        tier: tierOf(p),
        trial: trialShape(p),
        badge: typeof p.badge === 'string' ? p.badge : '',
        highlights: highlightsOf(p),
        features,
        limits: {
            branches: limits.maxBranches ?? null,
            tables: limits.maxTables ?? null,
            staff: limits.maxStaff ?? null,
            menuItems: limits.maxMenuItems ?? null,
        },
        highlight: p.highlight === true,
    };
}

async function loadPublicPlans() {
    // AUDIT-EXEMPT: platform-global plan catalogue — no tenant scope.
    // Plans created before isPublic / isActive existed have no such field; the
    // schema default for both is true, so only an explicit false hides a plan.
    const plans = await SubscriptionPlan.find({ isPublic: { $ne: false }, isActive: { $ne: false } })
        .sort({ sortOrder: 1, price: 1, name: 1 })
        .lean();
    return plans.map(publicPlanShape);
}

const publicPlansCache = listCache.create({
    name: 'public-plans',
    // Always the single global key — never key by the request tenant.
    loader: () => loadPublicPlans(),
    ttlMs: PUBLIC_PLANS_TTL_MS,
    maxEntries: 1,
});

module.exports = {
    PUBLIC_PLANS_TTL_MS,
    trialShape,
    tierOf,
    highlightsOf,
    publicPlanShape,
    loadPublicPlans,
    publicPlansCache,
    getPublicPlans: () => publicPlansCache.get(),
};
