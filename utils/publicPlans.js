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
    const plans = await SubscriptionPlan.find({ isPublic: true, isActive: true })
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
    publicPlanShape,
    loadPublicPlans,
    publicPlansCache,
    getPublicPlans: () => publicPlansCache.get(),
};
