// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const crypto = require('crypto');

// ─── Validation helpers ──────────────────────────────────────────────────

const EMAIL_REGEX   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_REGEX    = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PINCODE_REGEX = /^[0-9]{6}$/;
const FSSAI_REGEX   = /^[0-9]{14}$/;
const GSTIN_REGEX   = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX     = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

function slugify(input = '') {
    return String(input)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Generate a cryptographically random temporary password that satisfies the
 * password complexity rules used by the auth controller.
 */
function generateTempPassword(length = 14) {
    const upper    = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower    = 'abcdefghijklmnopqrstuvwxyz';
    const digits   = '0123456789';
    const specials = '!@#$%^&*_-+=<>?';
    const all      = upper + lower + digits + specials;

    const mandatory = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        specials[crypto.randomInt(specials.length)],
    ];
    const remaining = Array.from({ length: length - mandatory.length }, () =>
        all[crypto.randomInt(all.length)]
    );
    const chars = [...mandatory, ...remaining];
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// Pull a plain object snapshot of the plan's features/limits — used when a
// plan is assigned so the tenant's contract doesn't drift if the plan is
// edited later.
// Monthly revenue from a tenant's active paid add-ons (aggregation
// expression). Added on top of the plan price in every MRR figure.
const ADDON_MRR_EXPR = {
    $sum: {
        $map: {
            input: {
                $filter: {
                    input: { $ifNull: ['$addons', []] },
                    as: 'a',
                    cond: {
                        $and: [
                            { $eq: ['$$a.status', 'active'] },
                            { $or: [{ $not: ['$$a.endDate'] }, { $gt: ['$$a.endDate', '$$NOW'] }] },
                        ],
                    },
                },
            },
            as: 'a',
            in: { $ifNull: ['$$a.price', 0] },
        },
    },
};

function snapshotPlan(plan) {
    return {
        plan: plan._id,
        planName: plan.name,
        planSlug: plan.slug,
        price: typeof plan.price === 'number' ? plan.price : 0,
        features: plan.features ? plan.features.toObject ? plan.features.toObject() : { ...plan.features } : {},
        limits:   plan.limits   ? plan.limits.toObject   ? plan.limits.toObject()   : { ...plan.limits }   : {},
    };
}

function buildRestaurantPayload(r) {
    if (!r) return null;
    return {
        _id: r._id,
        name: r.name,
        slug: r.slug,
        contactEmail: r.contactEmail,
        contactPhone: r.contactPhone,
        city: r.city,
        address: r.address || {},
        legal: r.legal || {},
        timezone: r.timezone || 'Asia/Kolkata',
        logo: r.logo,
        status: r.status,
        owner: r.owner,
        subscription: r.subscription,
        featureOverrides: r.featureOverrides || {},
        addons: r.addons || [],
        suspendedAt: r.suspendedAt,
        suspendedReason: r.suspendedReason,
        signupSource: r.signupSource || 'admin',
        signupStatus: r.signupStatus || 'approved',
        signupNote: r.signupNote || '',
        signupRejectedReason: r.signupRejectedReason || '',
        signupReviewedAt: r.signupReviewedAt,
        paymentStatus: r.paymentStatus || 'na',
        paymentMethod: r.paymentMethod || '',
        paymentConfirmedAt: r.paymentConfirmedAt,
        paymentNote: r.paymentNote || '',
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
}

function buildPlanPayload(p) {
    if (!p) return null;
    return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        price: p.price,
        currency: p.currency,
        billingCycle: p.billingCycle,
        trialDays: p.trialDays,
        limits: p.limits,
        features: p.features,
        isActive: p.isActive,
        isPublic: p.isPublic !== false,
        highlight: p.highlight === true,
        sortOrder: p.sortOrder,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
}

module.exports = {
    EMAIL_REGEX,
    SLUG_REGEX,
    PINCODE_REGEX,
    FSSAI_REGEX,
    GSTIN_REGEX,
    PAN_REGEX,
    slugify,
    generateTempPassword,
    ADDON_MRR_EXPR,
    snapshotPlan,
    buildRestaurantPayload,
    buildPlanPayload,
};
