const crypto = require('crypto');
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const User = require('../models/user');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const Table = require('../models/table');
const Branch = require('../models/branch');
const PlanChangeRequest = require('../models/planChangeRequest');
const Lead = require('../models/lead');
const MarketingSetting = require('../models/marketingSetting');
const AuditLog = require('../models/auditLog');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const { compressAndUpload } = require('../utils/cloudinaryUploader');
const { recordAudit } = require('../utils/audit');
const { sendEmail } = require('../utils/email');
const {
    restaurantWelcome,
    restaurantSuspended,
    restaurantReactivated,
    signupRejected,
} = require('../utils/emailTemplates');
const {
    isBillingConfigured,
    ensureRazorpayPlan,
    ensureRazorpayCustomer,
    createRazorpaySubscription,
    cancelRazorpaySubscription,
} = require('../utils/razorpayBilling');
const logger = require('../utils/logger');
const { invalidateTenant } = require('../middlewares/tenantContext');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { isReservedSlug, checkExplicitRestaurantSlug } = require('../utils/reservedSlugs');
const { publicPlansCache } = require('../utils/publicPlans');
const { SELF_SIGNUP_TRIAL_DAYS } = require('../utils/selfSignup');
const { normalizeMobile } = require('../utils/mobile');

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

// ═══════════════════════════════════════════════════════════════════════
// RESTAURANTS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v1/superadmin/restaurants
exports.listRestaurants = async (req, res) => {
    try {
        const { status, q, plan, page = 1, limit = 25 } = req.query;
        const filter = {};
        if (status && status !== 'all') filter.status = status;
        if (plan) filter['subscription.plan'] = plan;
        if (q && q.trim()) {
            const safe = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { name: { $regex: safe, $options: 'i' } },
                { slug: { $regex: safe, $options: 'i' } },
                { contactEmail: { $regex: safe, $options: 'i' } },
                { city: { $regex: safe, $options: 'i' } },
            ];
        }

        const pageNum  = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

        // Server-side sort (whitelisted columns only).
        const SORT_FIELDS = { createdAt: 'createdAt', name: 'name', status: 'status' };
        const sortField = SORT_FIELDS[req.query.sort] || 'createdAt';
        const sortOrder = req.query.order === 'asc' ? 1 : -1;

        const [items, total, plans, summaryAgg] = await Promise.all([
            Restaurant.find(filter)
                .sort({ [sortField]: sortOrder })
                .skip((pageNum - 1) * pageSize)
                .limit(pageSize)
                .lean(),
            Restaurant.countDocuments(filter),
            // Plan price map for per-row plan price + MRR.
            SubscriptionPlan.find({}).select('price').lean(),
            // Platform summary across ALL tenants (independent of filters/page):
            // status breakdown + MRR (sum of active tenants' plan prices).
            Restaurant.aggregate([
                {
                    $lookup: {
                        from: 'subscriptionplans',
                        localField: 'subscription.plan',
                        foreignField: '_id',
                        as: 'planDoc',
                    },
                },
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 },
                        mrr: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$status', 'active'] },
                                    // Agreed (snapshot) price first; live plan price only as a legacy fallback.
                                    // Plus any active paid add-ons.
                                    { $add: [
                                        { $ifNull: ['$subscription.price', { $ifNull: [{ $arrayElemAt: ['$planDoc.price', 0] }, 0] }] },
                                        ADDON_MRR_EXPR,
                                    ] },
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]),
        ]);

        const priceById = new Map(plans.map(p => [String(p._id), p.price || 0]));

        // Branch counts for just the current page's tenants — one aggregation.
        const ids = items.map(i => i._id);
        const branchAgg = ids.length
            ? await Branch.aggregate([
                { $match: { restaurant: { $in: ids } } },
                {
                    $group: {
                        _id: '$restaurant',
                        total: { $sum: 1 },
                        active: { $sum: { $cond: ['$isActive', 1, 0] } },
                    },
                },
            ])
            : [];
        const branchById = new Map(branchAgg.map(b => [String(b._id), b]));

        const summary = { total: 0, active: 0, trial: 0, suspended: 0, cancelled: 0, past_due: 0, mrr: 0 };
        for (const g of summaryAgg) {
            summary.total += g.count;
            if (summary[g._id] !== undefined) summary[g._id] = g.count;
            summary.mrr += g.mrr || 0;
        }

        const data = items.map(r => {
            const base = buildRestaurantPayload(r);
            const planId = r.subscription?.plan ? String(r.subscription.plan) : null;
            const b = branchById.get(String(r._id));
            return {
                ...base,
                planPrice: planId ? (priceById.get(planId) || 0) : 0,
                branchCount: b?.total || 0,
                activeBranchCount: b?.active || 0,
            };
        });

        return res.status(200).json({
            success: true,
            data,
            summary,
            pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
        });
    } catch (err) {
        logger.error('listRestaurants error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list restaurants' });
    }
};

// GET /api/v1/superadmin/restaurants/:id
exports.getRestaurant = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }

        const restaurant = await Restaurant.findById(id).lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        // Phase 4 step 5: richer usage metrics on the tenant detail
        // page so the operator can spot "paid plan, but no activity"
        // or "huge menu, no orders" misalignments at a glance. All
        // counts are scoped to this restaurant; no PII fields are
        // returned from any of these queries.
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [
            staffCount,
            orderCount,
            orderCount30d,
            lastOrder,
            menuItemCount,
            tableCount,
            owner,
            branches,
            pendingPlanChange,
            invoices,
        ] = await Promise.all([
            User.countDocuments({ restaurant: restaurant._id, role: { $ne: 'customer' } }),
            Order.countDocuments({ restaurant: restaurant._id }).catch(() => 0),
            Order.countDocuments({
                restaurant: restaurant._id,
                createdAt: { $gte: thirtyDaysAgo },
            }).catch(() => 0),
            Order.findOne({ restaurant: restaurant._id })
                .sort({ createdAt: -1 })
                .select('createdAt')
                .lean()
                .catch(() => null),
            MenuItem.countDocuments({ restaurant: restaurant._id }).catch(() => 0),
            Table.countDocuments({ restaurant: restaurant._id }).catch(() => 0),
            restaurant.owner ? User.findById(restaurant.owner).select('name email mobile').lean() : null,
            Branch.find({ restaurant: restaurant._id })
                .select('name slug addressLine1 addressLine2 city state postalCode country contactPhone contactEmail isActive sortOrder createdAt')
                .sort({ isActive: -1, sortOrder: 1, createdAt: 1 })
                .lean()
                .catch(() => []),
            PlanChangeRequest.findOne({ restaurant: restaurant._id, status: 'pending' })
                .lean()
                .catch(() => null),
            // This tenant's subscription charge ledger (most recent first).
            SubscriptionInvoice.find({ restaurant: restaurant._id })
                .sort({ createdAt: -1 })
                .limit(12)
                .lean()
                .catch(() => []),
        ]);

        const branchCount = branches.length;
        const activeBranchCount = branches.filter(b => b.isActive).length;

        return res.status(200).json({
            success: true,
            data: {
                ...buildRestaurantPayload(restaurant),
                metrics: {
                    staffCount,
                    orderCount,
                    orderCount30d,
                    lastOrderAt: lastOrder?.createdAt || null,
                    menuItemCount,
                    tableCount,
                    branchCount,
                    activeBranchCount,
                },
                ownerProfile: owner || null,
                branches,
                pendingPlanChange,
                invoices: (invoices || []).map(i => ({
                    _id: i._id,
                    invoiceNumber: i.invoiceNumber,
                    planName: i.planName,
                    amount: i.amount,
                    currency: i.currency,
                    status: i.status,
                    periodStart: i.periodStart,
                    periodEnd: i.periodEnd,
                    paidAt: i.paidAt,
                    createdAt: i.createdAt,
                    razorpayPaymentId: i.razorpayPaymentId,
                })),
            },
        });
    } catch (err) {
        logger.error('getRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch restaurant' });
    }
};

// POST /api/v1/superadmin/restaurants
// Body: {
//   name, contactEmail, contactPhone?, city?, ownerName,
//   addressLine1, addressLine2?, state, pincode, country?,
//   legalBusinessName, fssaiLicense, gstin?, pan?,
//   timezone?, planId, trialDays?,
//   priceOverride?, paymentReceived?, paymentMethod?, paymentNote?
// }
//
// Offline payment capture (walk-in onboarding): when the owner pays the
// Super Admin directly (cash / UPI / etc.) at registration, the operator
// can record it inline — `paymentReceived` marks it collected, with the
// `paymentMethod` and an optional `paymentNote`. `priceOverride` lets the
// operator agree a custom price instead of the plan's catalog price.
exports.createRestaurant = async (req, res) => {
    try {
        const {
            name, contactEmail, contactPhone, city, ownerName,
            addressLine1, addressLine2, state, pincode, country,
            legalBusinessName, fssaiLicense, gstin, pan,
            timezone,
            planId, trialDays,
            priceOverride, paymentReceived, paymentMethod, paymentNote,
        } = req.body;

        // ── Validation ─────────────────────────────────────────────────
        // Length caps mirror the Restaurant model (which is itself
        // bounded by Branch's stricter caps so the auto-Main branch
        // can never throw ValidationError on copy). Catching long
        // values here gives Super Admin a clear field-level error
        // rather than a generic 500.
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Restaurant name is required' });
        }
        if (name.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'name', message: 'Restaurant name cannot exceed 80 characters' });
        }
        if (!contactEmail || !EMAIL_REGEX.test(contactEmail.trim())) {
            return res.status(400).json({ success: false, message: 'Valid contact email is required' });
        }
        if (contactEmail.trim().length > 120) {
            return res.status(400).json({ success: false, field: 'contactEmail', message: 'Email cannot exceed 120 characters' });
        }
        if (contactPhone && String(contactPhone).trim().length > 30) {
            return res.status(400).json({ success: false, field: 'contactPhone', message: 'Phone number cannot exceed 30 characters' });
        }
        if (!ownerName || !ownerName.trim()) {
            return res.status(400).json({ success: false, message: 'Owner name is required' });
        }
        if (ownerName.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'ownerName', message: 'Owner name cannot exceed 80 characters' });
        }
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'A valid subscription plan is required' });
        }

        // ── Address (required) ─────────────────────────────────────────
        if (!addressLine1 || !addressLine1.trim()) {
            return res.status(400).json({ success: false, message: 'Address line 1 is required' });
        }
        if (addressLine1.trim().length > 200) {
            return res.status(400).json({ success: false, field: 'addressLine1', message: 'Address line 1 cannot exceed 200 characters' });
        }
        if (addressLine2 && String(addressLine2).trim().length > 200) {
            return res.status(400).json({ success: false, field: 'addressLine2', message: 'Address line 2 cannot exceed 200 characters' });
        }
        if (!city || !city.trim()) {
            return res.status(400).json({ success: false, message: 'City is required' });
        }
        if (city.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'city', message: 'City cannot exceed 80 characters' });
        }
        if (!state || !state.trim()) {
            return res.status(400).json({ success: false, message: 'State is required' });
        }
        if (state.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'state', message: 'State cannot exceed 80 characters' });
        }
        if (!pincode || !PINCODE_REGEX.test(String(pincode).trim())) {
            return res.status(400).json({ success: false, message: 'Pincode must be a 6-digit number' });
        }
        if (country && String(country).trim().length > 80) {
            return res.status(400).json({ success: false, field: 'country', message: 'Country cannot exceed 80 characters' });
        }

        // ── Licenses ───────────────────────────────────────────────────
        if (!legalBusinessName || !legalBusinessName.trim()) {
            return res.status(400).json({ success: false, message: 'Legal business name is required' });
        }
        const cleanFssai = (fssaiLicense || '').trim();
        if (!cleanFssai || !FSSAI_REGEX.test(cleanFssai)) {
            return res.status(400).json({ success: false, message: 'FSSAI license must be a 14-digit number' });
        }
        const cleanGstin = (gstin || '').trim().toUpperCase();
        if (cleanGstin && !GSTIN_REGEX.test(cleanGstin)) {
            return res.status(400).json({ success: false, message: 'GSTIN must be a valid 15-character identifier' });
        }
        const cleanPan = (pan || '').trim().toUpperCase();
        if (cleanPan && !PAN_REGEX.test(cleanPan)) {
            return res.status(400).json({ success: false, message: 'PAN must be a valid 10-character identifier' });
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // ── Offline payment / price-override capture ───────────────────
        // Optional. `priceOverride` (when a finite, non-negative number)
        // replaces the plan's catalog price for this tenant's snapshot.
        let effectivePrice = typeof plan.price === 'number' ? plan.price : 0;
        if (priceOverride !== undefined && priceOverride !== null && priceOverride !== '') {
            const n = Number(priceOverride);
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ success: false, field: 'priceOverride', message: 'Price must be a non-negative number' });
            }
            effectivePrice = Math.round(n);
        }

        const VALID_PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'];
        const cleanMethod = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : '';
        if (paymentMethod && !cleanMethod) {
            return res.status(400).json({ success: false, field: 'paymentMethod', message: 'Invalid payment method' });
        }
        const markPaid = paymentReceived === true || paymentReceived === 'true';
        const cleanPaymentNote = (paymentNote || '').toString().trim().slice(0, 500);
        // received → operator collected it now; pending → paid plan still
        // owing (shows in the offline-payments queue); na → nothing to collect.
        const resolvedPaymentStatus = markPaid
            ? 'received'
            : (effectivePrice > 0 ? 'pending' : 'na');

        // ── Slug uniqueness ────────────────────────────────────────────
        // Generate a slug from the restaurant name and append a short
        // suffix if it already exists to avoid blocking onboarding.
        // Capped at 55 so a "-xxxx" collision suffix still fits the 2-60
        // char range the tenant resolver accepts (tenantContext SLUG_REGEX)
        // — a longer slug would make the restaurant's /r/<slug> link dead.
        //
        // Reserved slugs (utils/reservedSlugs.js) would collide with a
        // top-level frontend route at /<slug>: an explicit `slug` is
        // refused (400 SLUG_RESERVED), a generated one is auto-suffixed
        // exactly like a uniqueness collision.
        let slug;
        if (req.body.slug !== undefined && req.body.slug !== null && req.body.slug !== '') {
            const checked = checkExplicitRestaurantSlug(req.body.slug);
            if (checked.error) {
                return res.status(checked.error.status).json({
                    success: false, field: 'slug', code: checked.error.code, message: checked.error.message,
                });
            }
            slug = checked.slug;
            if (await Restaurant.exists({ slug })) {
                return res.status(400).json({
                    success: false, field: 'slug', code: 'SLUG_TAKEN',
                    message: 'A restaurant with this slug already exists',
                });
            }
        } else {
            slug = slugify(name).slice(0, 55).replace(/-+$/, '');
            if (!SLUG_REGEX.test(slug) || slug.length < 2) {
                slug = `restaurant-${crypto.randomBytes(3).toString('hex')}`;
            }
            if (isReservedSlug(slug) || await Restaurant.exists({ slug })) {
                slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
            }
        }

        // ── Duplicate owner email guard ────────────────────────────────
        const cleanEmail = contactEmail.toLowerCase().trim();
        const existingUser = await User.findOne({ email: cleanEmail });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'A user with this email already exists. Use a different email or transfer ownership manually.'
            });
        }

        // ── Build subscription snapshot ────────────────────────────────
        const startDate = new Date();
        const trialPeriod = Number.isFinite(+trialDays) ? Math.max(0, +trialDays) : (plan.trialDays || 0);
        const trialEndDate = trialPeriod > 0
            ? new Date(startDate.getTime() + trialPeriod * 24 * 60 * 60 * 1000)
            : null;

        const subscription = {
            ...snapshotPlan(plan),
            price: effectivePrice,
            startDate,
            endDate: null,
            trialEndDate,
            status: trialPeriod > 0 ? 'trial' : 'active',
        };

        // ── Create restaurant + admin user ─────────────────────────────
        // We do not use a multi-document transaction here because the
        // existing deployment uses a single MongoDB Atlas connection
        // without an explicit replica session — instead we roll back
        // on failure manually.
        const restaurant = await Restaurant.create({
            name: name.trim(),
            slug,
            contactEmail: cleanEmail,
            contactPhone: (contactPhone || '').trim(),
            city: city.trim(),
            address: {
                line1: addressLine1.trim(),
                line2: (addressLine2 || '').trim(),
                state: state.trim(),
                pincode: String(pincode).trim(),
                country: (country || 'India').trim(),
            },
            legal: {
                legalBusinessName: legalBusinessName.trim(),
                fssaiLicense: cleanFssai,
                gstin: cleanGstin,
                pan: cleanPan,
            },
            timezone: (timezone || 'Asia/Kolkata').trim(),
            status: trialPeriod > 0 ? 'trial' : 'active',
            subscription,
            paymentStatus: resolvedPaymentStatus,
            paymentMethod: markPaid ? cleanMethod : '',
            paymentNote: cleanPaymentNote,
            paymentConfirmedAt: markPaid ? new Date() : undefined,
            paymentConfirmedBy: markPaid ? req.user._id : undefined,
            createdBy: req.user._id,
        });

        let adminUser;
        const tempPassword = generateTempPassword();
        try {
            adminUser = await User.create({
                name: ownerName.trim(),
                email: cleanEmail,
                password: tempPassword,
                mobile: (contactPhone || '').trim(),
                role: 'admin',
                restaurant: restaurant._id,
                // CRIT-06 — THIS user is the tenant owner. Sub-admins
                // created later via /staff must NOT inherit this flag.
                isTenantOwner: true,
                mustChangePassword: true,
                status: 'active',
            });
            restaurant.owner = adminUser._id;
            await restaurant.save();
        } catch (innerErr) {
            // Roll back the restaurant if user creation failed
            await Restaurant.findByIdAndDelete(restaurant._id).catch(() => {});
            invalidateTenant(restaurant._id);
            throw innerErr;
        }

        // ── Auto-provision the "Main" branch ──────────────────────────
        // Every tenant starts with one Branch document representing the
        // original/HQ location. Future sub-branches added by the owner
        // become siblings of Main, leaving Main's data untouched.
        // Failure here is non-fatal: the backfill script can be re-run
        // to repair the tenant later.
        try {
            await createMainBranchFor(restaurant, adminUser._id);
        } catch (branchErr) {
            logger.error(`superadmin.createRestaurant: createMainBranchFor failed for ${restaurant.slug}: ${branchErr.message}`);
        }

        await recordAudit(req, {
            action: 'restaurant.create',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                plan: plan.slug,
                trialDays: trialPeriod,
                ownerEmail: cleanEmail,
                price: effectivePrice,
                paymentStatus: resolvedPaymentStatus,
                paymentMethod: markPaid ? cleanMethod : undefined,
            },
        });

        // Fire-and-forget welcome email. We do NOT await this inside
        // the critical path — if the email provider is slow or flaky,
        // the super admin's "create restaurant" request must still
        // return quickly. `sendEmail` catches all errors internally
        // and logs them, so a rejected promise is never thrown here.
        const emailResult = await sendEmail({
            to: cleanEmail,
            ...restaurantWelcome({
                restaurantName: restaurant.name,
                ownerName: adminUser.name,
                email: cleanEmail,
                tempPassword,
                planName: plan.name,
                trialDays: trialPeriod,
            }),
        });

        await recordAudit(req, {
            action: 'restaurant.welcome_email',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { provider: emailResult.provider, sent: emailResult.sent, dev: emailResult.dev },
        });

        return res.status(201).json({
            success: true,
            data: {
                restaurant: buildRestaurantPayload(restaurant),
                admin: {
                    _id: adminUser._id,
                    name: adminUser.name,
                    email: adminUser.email,
                    mustChangePassword: true,
                },
                // The temporary password is returned once so the operator
                // can hand it to the customer through a secure channel.
                // It is intentionally NOT persisted anywhere readable.
                temporaryPassword: tempPassword,
                email: {
                    sent: emailResult.sent,
                    provider: emailResult.provider,
                    dev: emailResult.dev,
                },
            },
            message: emailResult.sent
                ? `Restaurant created. Welcome email sent to ${cleanEmail}.`
                : 'Restaurant created. Share the temporary password with the owner via a secure channel.',
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'Restaurant slug or owner email already exists' });
        }
        logger.error('createRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create restaurant' });
    }
};

// PATCH /api/v1/superadmin/restaurants/:id
// Body may include: {
//   name, contactPhone, city, logo, featureOverrides,
//   address: { line1, line2, state, pincode, country },
//   legal:   { legalBusinessName, fssaiLicense, gstin, pan },
//   timezone,
// }
//
// `address` / `legal` / `timezone` were originally only collected at
// onboarding. They are editable here so Super Admin can fill them in
// for tenants that came through the self-signup flow (which doesn't
// capture compliance fields) or fix typos post-hoc.
exports.updateRestaurant = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }

        const restaurant = await Restaurant.findById(id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        // featureOverrides: { [moduleKey]: true | false } — tiered keys may
        // also carry a level. Anything else would silently become a
        // module gate nobody can see, so reject it.
        if (req.body.featureOverrides !== undefined) {
            const ov = req.body.featureOverrides;
            if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
                return res.status(400).json({ success: false, message: 'featureOverrides must be an object' });
            }
            const known = new Set([...SubscriptionPlan.FEATURE_KEYS, 'revenueAnalytics']);
            for (const [k, v] of Object.entries(ov)) {
                const tierOk = k === 'revenueAnalytics' && ['none', 'basic', 'standard', 'advanced'].includes(v);
                if (!known.has(k) || !(typeof v === 'boolean' || tierOk)) {
                    return res.status(400).json({ success: false, message: `Invalid feature override "${k}"` });
                }
            }
        }

        const allowed = ['name', 'contactPhone', 'city', 'logo', 'featureOverrides'];
        const before = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                before[key] = restaurant[key];
                restaurant[key] = req.body[key];
            }
        }

        // ── Address (nested, optional) ─────────────────────────────────
        if (req.body.address && typeof req.body.address === 'object') {
            const a = req.body.address;
            const cleanPincode = (a.pincode ?? '').toString().trim();
            if (cleanPincode && !PINCODE_REGEX.test(cleanPincode)) {
                return res.status(400).json({ success: false, message: 'Pincode must be a 6-digit number' });
            }
            before.address = restaurant.address ? { ...restaurant.address.toObject?.() ?? restaurant.address } : {};
            const next = restaurant.address || {};
            if (a.line1   !== undefined) next.line1   = String(a.line1   || '').trim();
            if (a.line2   !== undefined) next.line2   = String(a.line2   || '').trim();
            if (a.state   !== undefined) next.state   = String(a.state   || '').trim();
            if (a.pincode !== undefined) next.pincode = cleanPincode;
            if (a.country !== undefined) next.country = String(a.country || '').trim() || 'India';
            restaurant.address = next;
        }

        // ── Legal identifiers (nested, optional) ───────────────────────
        if (req.body.legal && typeof req.body.legal === 'object') {
            const l = req.body.legal;
            const cleanFssai = (l.fssaiLicense ?? '').toString().trim();
            if (cleanFssai && !FSSAI_REGEX.test(cleanFssai)) {
                return res.status(400).json({ success: false, message: 'FSSAI license must be a 14-digit number' });
            }
            const cleanGstin = (l.gstin ?? '').toString().trim().toUpperCase();
            if (cleanGstin && !GSTIN_REGEX.test(cleanGstin)) {
                return res.status(400).json({ success: false, message: 'GSTIN must be a valid 15-character identifier' });
            }
            const cleanPan = (l.pan ?? '').toString().trim().toUpperCase();
            if (cleanPan && !PAN_REGEX.test(cleanPan)) {
                return res.status(400).json({ success: false, message: 'PAN must be a valid 10-character identifier' });
            }
            before.legal = restaurant.legal ? { ...restaurant.legal.toObject?.() ?? restaurant.legal } : {};
            const next = restaurant.legal || {};
            if (l.legalBusinessName !== undefined) next.legalBusinessName = String(l.legalBusinessName || '').trim();
            if (l.fssaiLicense      !== undefined) next.fssaiLicense      = cleanFssai;
            if (l.gstin             !== undefined) next.gstin             = cleanGstin;
            if (l.pan               !== undefined) next.pan               = cleanPan;
            restaurant.legal = next;
        }

        // ── Timezone (scalar) ──────────────────────────────────────────
        if (req.body.timezone !== undefined) {
            before.timezone = restaurant.timezone;
            restaurant.timezone = String(req.body.timezone || '').trim() || 'Asia/Kolkata';
        }

        await restaurant.save();

        // Tenant === Main contract: mirror name / contactPhone / city /
        // address fields onto the Main branch so the customer-facing
        // picker and branch-aware UIs stay aligned with the tenant
        // identity. Sub-branches are independent and unaffected.
        //
        // Restaurant fields have looser limits than Branch fields, so
        // each value is clamped to Branch's maxlength before mirroring
        // (otherwise legacy long values would throw ValidationError
        // and break the sync silently).
        const clampMain = (v, max) => {
            const s = String(v ?? '').trim();
            return s.length > max ? s.slice(0, max) : s;
        };
        const mainSync = {};
        if (req.body.name !== undefined)         mainSync.name         = clampMain(restaurant.name, 80);
        if (req.body.contactPhone !== undefined) mainSync.contactPhone = clampMain(restaurant.contactPhone, 30);
        if (req.body.city !== undefined)         mainSync.city         = clampMain(restaurant.city, 80);
        if (req.body.address && typeof req.body.address === 'object') {
            const a = req.body.address;
            if (a.line1   !== undefined) mainSync.addressLine1 = clampMain(restaurant.address?.line1,   200);
            if (a.line2   !== undefined) mainSync.addressLine2 = clampMain(restaurant.address?.line2,   200);
            if (a.state   !== undefined) mainSync.state        = clampMain(restaurant.address?.state,    80);
            if (a.pincode !== undefined) mainSync.postalCode   = clampMain(restaurant.address?.pincode,  20);
            if (a.country !== undefined) mainSync.country      = clampMain(restaurant.address?.country || 'India', 80);
        }
        if (Object.keys(mainSync).length > 0) {
            const Branch = require('../models/branch');
            await Branch.updateOne(
                { restaurant: restaurant._id, slug: 'main' },
                { $set: mainSync }
            );
        }

        await recordAudit(req, {
            action: 'restaurant.update',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { before, after: req.body },
        });

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('updateRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update restaurant' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/assign-plan
// Body: { planId, trialDays? }
//
// Phase 2 SaaS billing: for paid plans, this also creates a Razorpay
// Subscription and stores the short_url the owner can visit to
// authorize recurring payments. Grandfathering rules:
//   - Free plans (price === 0) never get a Razorpay subscription.
//   - If Razorpay isn't configured (keys missing), fall back to the
//     legacy "manual comp" flow — tenant still gets the plan's
//     features immediately, just without auto-charging.
//   - If the tenant already has an active Razorpay subscription, it
//     is cancelled immediately before the new one is created
//     (upgrade/downgrade path).
exports.assignPlan = async (req, res) => {
    try {
        const { id } = req.params;
        const { planId, trialDays } = req.body;

        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant or plan id' });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(id),
            SubscriptionPlan.findById(planId),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (!plan || !plan.isActive) return res.status(400).json({ success: false, message: 'Plan unavailable' });

        const previousPlanSlug = restaurant.subscription?.planSlug || null;
        const previousSubId = restaurant.subscription?.razorpaySubscriptionId || null;
        const previousCustomerId = restaurant.subscription?.razorpayCustomerId || '';
        const startDate = new Date();
        const trialPeriod = Number.isFinite(+trialDays) ? Math.max(0, +trialDays) : 0;

        // Build the fresh subscription snapshot. We preserve the Razorpay
        // customerId across reassignments (one customer per tenant) but
        // reset the subscription-level fields.
        restaurant.subscription = {
            ...snapshotPlan(plan),
            startDate,
            endDate: null,
            trialEndDate: trialPeriod > 0
                ? new Date(startDate.getTime() + trialPeriod * 24 * 60 * 60 * 1000)
                : null,
            status: trialPeriod > 0 ? 'trial' : 'active',
            razorpayCustomerId: previousCustomerId,
            razorpaySubscriptionId: '',
            shortUrl: '',
            razorpayStatus: '',
            currentPeriodEnd: undefined,
            lastChargedAt: undefined,
        };
        if (restaurant.status === 'trial' && trialPeriod === 0) restaurant.status = 'active';

        // ── Razorpay billing flow ───────────────────────────────────
        let billingResult = { configured: false, subscriptionCreated: false };

        if (isBillingConfigured() && plan.price > 0) {
            try {
                // 1. Cancel the old subscription if there is one.
                if (previousSubId) {
                    try {
                        await cancelRazorpaySubscription(previousSubId, false);
                        logger.info(`Cancelled previous Razorpay subscription ${previousSubId}`);
                    } catch (cancelErr) {
                        // Log but don't fail — the old sub might already be cancelled/halted.
                        logger.warn(`Could not cancel previous subscription ${previousSubId}: ${cancelErr.message}`);
                    }
                }

                // 2. Ensure the plan exists in Razorpay (may fail with
                //    401 if Subscriptions product isn't enabled — that's
                //    OK, createRazorpaySubscription will catch the 401
                //    and fall back to the Orders API).
                try {
                    await ensureRazorpayPlan(plan);
                } catch (planErr) {
                    if (planErr?.statusCode !== 401) throw planErr;
                    // 401 → Subscriptions not enabled; fall through to
                    // createRazorpaySubscription which handles the fallback.
                }

                // 3. Ensure the restaurant has a Razorpay customer.
                const owner = restaurant.owner ? await User.findById(restaurant.owner) : null;
                const customerId = await ensureRazorpayCustomer(restaurant, owner);

                // 4. Create the subscription (or fallback order if
                //    Subscriptions API returns 401).
                const sub = await createRazorpaySubscription({ plan, restaurant, customerId });

                if (sub.fallbackOrder) {
                    // Fallback: Razorpay Order created instead of
                    // Subscription. The plan features are still applied
                    // immediately; the order can be paid via Checkout.
                    restaurant.subscription.razorpayStatus = 'pending_payment';
                    billingResult = {
                        configured: true,
                        subscriptionCreated: false,
                        fallbackOrder: true,
                        orderId: sub.orderId,
                        amount: sub.amount,
                        currency: sub.currency,
                        key: sub.key,
                        status: 'pending_payment',
                    };
                    logger.info(`Razorpay fallback order for ${restaurant.slug}: ${sub.orderId}`);
                } else {
                    restaurant.subscription.razorpaySubscriptionId = sub.id;
                    restaurant.subscription.shortUrl = sub.short_url || '';
                    restaurant.subscription.razorpayStatus = sub.status || 'created';
                    billingResult = {
                        configured: true,
                        subscriptionCreated: true,
                        subscriptionId: sub.id,
                        shortUrl: sub.short_url,
                        status: sub.status,
                    };
                    logger.info(`Razorpay subscription created for ${restaurant.slug}: ${sub.id}`);
                }
            } catch (billingErr) {
                // Billing failure must NOT block plan assignment — the
                // Super Admin can retry later via the detail page. We
                // save the restaurant without a subscription id and
                // surface the error in the response so the UI can show it.
                //
                // Razorpay SDK errors come in several shapes depending
                // on the failure class:
                //   { error: { description, code, field } }  — API rejection (validation, perms)
                //   { error: 'Unauthorized', statusCode: 401 } — auth failure (bad keys)
                //   { message: '...' }                        — network / timeout / SDK bug
                //   string                                    — fallback
                // We normalise all of these into a single readable
                // description + an actionable hint for the common ones.
                const normaliseError = (err) => {
                    if (!err) return 'Unknown error';
                    if (typeof err === 'string') return err;
                    // Nested API rejection object
                    if (err.error && typeof err.error === 'object' && err.error.description) {
                        return err.error.description;
                    }
                    // Flat auth error — err.error is a string like "Unauthorized"
                    if (typeof err.error === 'string') {
                        return err.error;
                    }
                    if (err.message) return err.message;
                    try { return JSON.stringify(err); } catch { return String(err); }
                };

                const errDescription = normaliseError(billingErr);
                const statusCode     = billingErr?.statusCode || billingErr?.error?.code || null;

                // Map common status codes to actionable hints so the
                // operator doesn't have to Google what Razorpay meant.
                //
                // IMPORTANT: a 401 on the Subscriptions/Plans API does
                // NOT always mean bad credentials — it often means the
                // "Subscriptions" product module is not activated on the
                // Razorpay account. The Orders API works fine with the
                // same keys in that case.
                let hint = '';
                if (statusCode === 401) {
                    hint = 'Razorpay returned 401 on the Subscriptions API. This usually means the "Subscriptions" product is not enabled on your Razorpay account (your API keys may still be valid for regular payments). Go to dashboard.razorpay.com → left sidebar → "Subscriptions" or "Product Configuration" → enable the Subscriptions product. If you\'ve already enabled it, then check that RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are a matching pair from the same account.';
                } else if (statusCode === 400 && /subscription/i.test(errDescription)) {
                    hint = 'Razorpay rejected the subscription request. Make sure the Subscriptions feature is enabled in your Razorpay dashboard under Account & Settings → Feature Activation.';
                } else if (statusCode === 403) {
                    hint = 'Your Razorpay account does not have permission for this operation. For Subscriptions, complete KYC and enable the Subscriptions feature in the Razorpay dashboard.';
                } else if (statusCode === 429) {
                    hint = 'Razorpay rate-limited the request. Wait a minute and retry.';
                }

                logger.error(`Razorpay billing setup failed for ${restaurant.slug}`, {
                    description: errDescription,
                    statusCode,
                    hint,
                    raw: billingErr?.error || null,
                });

                billingResult = {
                    configured: true,
                    subscriptionCreated: false,
                    error: errDescription,
                    statusCode: statusCode || undefined,
                    hint: hint || undefined,
                    rejectedField: billingErr?.error?.field || undefined,
                };
            }
        }

        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.plan.assign',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                from: previousPlanSlug,
                to: plan.slug,
                trialDays: trialPeriod,
                billing: billingResult,
            },
        });

        return res.status(200).json({
            success: true,
            data: buildRestaurantPayload(restaurant),
            billing: billingResult,
        });
    } catch (err) {
        logger.error('assignPlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to assign plan' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/cancel-subscription
// Body: { immediate? } — default is "at cycle end" so the tenant
//                        keeps access until the current period expires.
//
// This does NOT immediately suspend the tenant — the suspension only
// happens when Razorpay later fires `subscription.halted` (if payment
// actually fails) or when the natural cycle ends. For an immediate
// lockout, use the dedicated /suspend endpoint instead.
exports.cancelSubscription = async (req, res) => {
    try {
        const { id } = req.params;
        const immediate = req.body?.immediate === true;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }

        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

        const subId = restaurant.subscription?.razorpaySubscriptionId;
        if (!subId) {
            return res.status(400).json({ success: false, message: 'This restaurant has no active Razorpay subscription.' });
        }
        if (!isBillingConfigured()) {
            return res.status(503).json({ success: false, message: 'Razorpay billing is not configured.' });
        }

        try {
            await cancelRazorpaySubscription(subId, !immediate);
        } catch (err) {
            logger.error(`cancelSubscription failed for ${restaurant.slug}: ${err.message}`);
            return res.status(502).json({ success: false, message: `Razorpay rejected the cancellation: ${err.message}` });
        }

        restaurant.subscription.razorpayStatus = 'cancelled';
        if (immediate) {
            restaurant.subscription.razorpaySubscriptionId = '';
            restaurant.subscription.shortUrl = '';
        }
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.subscription.cancel',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { subscriptionId: subId, immediate },
        });

        return res.status(200).json({
            success: true,
            data: buildRestaurantPayload(restaurant),
            message: immediate
                ? 'Subscription cancelled immediately.'
                : 'Subscription will cancel at the end of the current billing cycle.',
        });
    } catch (err) {
        logger.error('cancelSubscription error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/suspend
// Body: { reason }  — reason is REQUIRED so the audit log always carries
// the "why". UI enforces it too, but we re-validate here for safety.
exports.suspendRestaurant = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Suspension reason is required' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

        restaurant.status = 'suspended';
        restaurant.suspendedAt = new Date();
        restaurant.suspendedReason = reason;
        await restaurant.save();
        invalidateTenant(restaurant._id);

        await recordAudit(req, {
            action: 'restaurant.suspend',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { reason: restaurant.suspendedReason },
        });

        // ── Notify the tenant owner ──────────────────────────────
        // Fire-and-forget: sendEmail catches its own errors and the
        // audit trail above is the source of truth for "what changed".
        // Failure to deliver must never roll back the suspension.
        const owner = restaurant.owner ? await User.findById(restaurant.owner).select('name email').lean() : null;
        const recipient = owner?.email || restaurant.contactEmail;
        if (recipient) {
            try {
                const emailResult = await sendEmail({
                    to: recipient,
                    ...restaurantSuspended({
                        restaurantName: restaurant.name,
                        ownerName: owner?.name || '',
                        reason,
                    }),
                });
                await recordAudit(req, {
                    action: 'restaurant.suspend_email',
                    targetType: 'restaurant',
                    targetId: restaurant._id,
                    targetName: restaurant.name,
                    details: { to: recipient, provider: emailResult.provider, sent: emailResult.sent, dev: emailResult.dev },
                });
            } catch (mailErr) {
                logger.warn(`suspend email failed for ${recipient}: ${mailErr.message}`);
            }
        }

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('suspendRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to suspend restaurant' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/reactivate
// Body: { reason }  — required so the audit trail explains why staff
// access was restored.
exports.reactivateRestaurant = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Reactivation reason is required' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

        restaurant.status = restaurant.subscription?.trialEndDate && restaurant.subscription.trialEndDate > new Date()
            ? 'trial'
            : 'active';
        restaurant.suspendedAt = undefined;
        restaurant.suspendedReason = '';
        await restaurant.save();
        invalidateTenant(restaurant._id);

        await recordAudit(req, {
            action: 'restaurant.reactivate',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { reason },
        });

        // ── Notify the tenant owner ──────────────────────────────
        const owner = restaurant.owner ? await User.findById(restaurant.owner).select('name email').lean() : null;
        const recipient = owner?.email || restaurant.contactEmail;
        if (recipient) {
            try {
                const emailResult = await sendEmail({
                    to: recipient,
                    ...restaurantReactivated({
                        restaurantName: restaurant.name,
                        ownerName: owner?.name || '',
                        reason,
                    }),
                });
                await recordAudit(req, {
                    action: 'restaurant.reactivate_email',
                    targetType: 'restaurant',
                    targetId: restaurant._id,
                    targetName: restaurant.name,
                    details: { to: recipient, provider: emailResult.provider, sent: emailResult.sent, dev: emailResult.dev },
                });
            } catch (mailErr) {
                logger.warn(`reactivate email failed for ${recipient}: ${mailErr.message}`);
            }
        }

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('reactivateRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reactivate restaurant' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/resend-invitation
//
// Regenerates the owner admin's temporary password and re-sends the
// welcome email. Used when the original email bounced, the owner lost
// it, or the delivery provider was misconfigured the first time.
//
// Since the original temp password was never stored in plain text (only
// a bcrypt hash), this is effectively an invitation reset: a NEW temp
// password is generated, the owner's password is updated, and the
// mustChangePassword flag is set again. This matches how most SaaS
// platforms handle "resend invitation" — the old password is invalidated.
exports.resendRestaurantInvitation = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }

        const restaurant = await Restaurant.findById(id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        if (!restaurant.owner) {
            return res.status(400).json({
                success: false,
                message: 'This restaurant has no owner account linked. Contact support.',
            });
        }

        const owner = await User.findById(restaurant.owner);
        if (!owner) {
            return res.status(400).json({
                success: false,
                message: 'The owner account no longer exists.',
            });
        }

        // Generate a fresh temp password and force a change on first login.
        const tempPassword = generateTempPassword();
        owner.password = tempPassword;       // hashed by pre-save hook
        owner.mustChangePassword = true;
        await owner.save();

        // Figure out the plan name and trial days for the email body.
        const planName = restaurant.subscription?.planName || 'Trial';
        const trialEnd = restaurant.subscription?.trialEndDate
            ? new Date(restaurant.subscription.trialEndDate)
            : null;
        const trialDays = trialEnd && trialEnd > new Date()
            ? Math.ceil((trialEnd - new Date()) / (24 * 60 * 60 * 1000))
            : 0;

        const emailResult = await sendEmail({
            to: owner.email,
            ...restaurantWelcome({
                restaurantName: restaurant.name,
                ownerName: owner.name,
                email: owner.email,
                tempPassword,
                planName,
                trialDays,
            }),
        });

        await recordAudit(req, {
            action: 'restaurant.resend_invitation',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                ownerEmail: owner.email,
                provider: emailResult.provider,
                sent: emailResult.sent,
                dev: emailResult.dev,
            },
        });

        return res.status(200).json({
            success: true,
            data: {
                email: owner.email,
                // Only return the temp password in dev mode (no provider
                // configured). In production — when the email was actually
                // sent — the operator should not see it on screen.
                temporaryPassword: emailResult.sent ? null : tempPassword,
                sent: emailResult.sent,
                provider: emailResult.provider,
                dev: emailResult.dev,
            },
            message: emailResult.sent
                ? `Invitation email sent to ${owner.email}. Old password is now invalid.`
                : 'Invitation regenerated. Share the temporary password securely — email provider not configured.',
        });
    } catch (err) {
        logger.error('resendRestaurantInvitation error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to resend invitation' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIPTION PLANS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v1/superadmin/plans
exports.listPlans = async (req, res) => {
    try {
        const includeArchived = req.query.includeArchived === 'true';
        const filter = includeArchived ? {} : { isActive: true };
        const plans = await SubscriptionPlan.find(filter)
            .sort({ sortOrder: 1, price: 1 })
            .lean();
        return res.status(200).json({ success: true, data: plans.map(buildPlanPayload) });
    } catch (err) {
        logger.error('listPlans error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list plans' });
    }
};

// POST /api/v1/superadmin/plans
exports.createPlan = async (req, res) => {
    try {
        const { name, slug, description, price, billingCycle, trialDays, limits, features, sortOrder, isPublic } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Plan name is required' });
        }
        if (price === undefined || price === null || isNaN(+price) || +price < 0) {
            return res.status(400).json({ success: false, message: 'Plan price is required and must be >= 0' });
        }
        const finalSlug = slug ? slugify(slug) : slugify(name);
        if (!SLUG_REGEX.test(finalSlug)) {
            return res.status(400).json({ success: false, message: 'Invalid plan slug' });
        }
        if (await SubscriptionPlan.exists({ slug: finalSlug })) {
            return res.status(400).json({ success: false, message: 'A plan with this slug already exists' });
        }

        const plan = await SubscriptionPlan.create({
            name: name.trim(),
            slug: finalSlug,
            description: (description || '').trim(),
            price: +price,
            billingCycle: billingCycle || 'monthly',
            trialDays: Number.isFinite(+trialDays) ? +trialDays : 0,
            limits: limits || {},
            features: features || {},
            sortOrder: Number.isFinite(+sortOrder) ? +sortOrder : 0,
            isPublic: isPublic !== false,
            highlight: req.body.highlight === true,
        });

        await recordAudit(req, {
            action: 'plan.create',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, price: plan.price },
        });

        publicPlansCache.invalidate();
        return res.status(201).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'Plan slug already exists' });
        }
        logger.error('createPlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create plan' });
    }
};

// PUT /api/v1/superadmin/plans/:id
exports.updatePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        // Slug is immutable once created (it's referenced by tenant snapshots).
        const editable = ['name', 'description', 'price', 'billingCycle', 'trialDays', 'limits', 'features', 'sortOrder', 'isActive', 'isPublic', 'highlight'];
        // Capture what actually changed (old → new) for the audit log. Objects
        // (limits/features) are compared by JSON so a nested tweak still shows.
        const changes = {};
        const previewVal = (v) => {
            const s = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
            return s.length > 120 ? s.slice(0, 117) + '…' : s;
        };
        for (const key of editable) {
            if (req.body[key] === undefined) continue;
            const before = plan[key];
            const after = req.body[key];
            const beforeCmp = (before && typeof before === 'object') ? JSON.stringify(before) : String(before ?? '');
            const afterCmp = (after && typeof after === 'object') ? JSON.stringify(after) : String(after ?? '');
            if (beforeCmp !== afterCmp) changes[key] = { from: previewVal(before), to: previewVal(after) };
            plan[key] = after;
        }
        await plan.save();

        const changedFields = Object.keys(changes);
        await recordAudit(req, {
            action: 'plan.update',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: {
                slug: plan.slug,
                changedFields,
                ...(changedFields.length ? { changes } : { note: 'Saved with no field changes' }),
            },
        });

        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        logger.error('updatePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update plan' });
    }
};

// PATCH /api/v1/superadmin/plans/:id/archive
exports.archivePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        plan.isActive = false;
        await plan.save();

        await recordAudit(req, {
            action: 'plan.archive',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, isActive: false },
        });
        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        logger.error('archivePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to archive plan' });
    }
};

// DELETE /api/v1/superadmin/plans/:id
// Permanently removes a plan. Blocked when any tenant is currently on it —
// deleting a live plan would orphan their billing reference. The caller is
// told the count so it can suggest "Archive instead".
exports.deletePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        // Safety check on live state: don't delete a plan tenants are using.
        const assignedCount = await Restaurant.countDocuments({ 'subscription.plan': plan._id });
        if (assignedCount > 0) {
            return res.status(400).json({
                success: false,
                code: 'PLAN_IN_USE',
                message: `${assignedCount} restaurant(s) are currently on "${plan.name}". Move them to another plan or Archive this one instead of deleting.`,
                assignedCount,
            });
        }

        await plan.deleteOne();

        await recordAudit(req, {
            action: 'plan.delete',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, price: plan.price },
        });
        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, message: 'Plan deleted' });
    } catch (err) {
        logger.error('deletePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete plan' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM ANALYTICS  (aggregated only — never raw tenant PII)
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v1/superadmin/analytics
//
// Platform overview. Aggregates only — no tenant PII ever leaks into
// this response. Surfaced signals:
//
//   restaurants          — total / active / trial / suspended counts
//   branches             — total + active branches across all tenants
//   pendingApprovals     — signups / plan changes / payments queues
//   mrr                  — current MRR + MoM delta (+/−%)
//   growth               — new signups this month, net change, conversion rate
//   trialsExpiringSoon   — small watchlist of tenants whose trial ends soon
//   today                — last-24h activity feed (signups, plan changes, suspends)
//   systemHealth         — email provider, Razorpay webhook, DB response
//   topTenants           — busiest tenants by 30-day order volume
//   atRiskTenants        — active/trial tenants with 0 orders in last 14d
//   geoDistribution      — top cities by tenant count
//   plansByUsage         — tenant distribution across plans
//   recentActivity       — last 10 audit-log entries (no PII)
exports.getPlatformAnalytics = async (_req, res) => {
    const dbStart = Date.now();
    try {
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const day = 24 * 60 * 60 * 1000;
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        const ninetyDaysAgo = new Date(now.getTime() - 90 * day);
        const fourteenDaysAgo = new Date(now.getTime() - 14 * day);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * day);
        const twentyFourHoursAgo = new Date(now.getTime() - day);

        // ─── Shared MRR aggregation pipeline ──────────────────────────
        // Computes { amount, paidTenants } for any filter. Reused for
        // "current MRR" and "last-month MRR" to get the MoM delta.
        const mrrPipeline = (match) => [
            { $match: match },
            {
                $lookup: {
                    from: 'subscriptionplans',
                    localField: 'subscription.plan',
                    foreignField: '_id',
                    as: '_plan',
                },
            },
            { $unwind: { path: '$_plan', preserveNullAndEmptyArrays: true } },
            // Revenue = the price the tenant AGREED to (snapshot), not the
            // live catalog price — so editing a plan never retroactively
            // moves MRR. Legacy tenants (no snapshot price) fall back to the
            // current plan price.
            {
                $addFields: {
                    _agreedPrice: { $add: [
                        { $ifNull: ['$subscription.price', { $ifNull: ['$_plan.price', 0] }] },
                        // Active paid add-ons count toward MRR too.
                        ADDON_MRR_EXPR,
                    ] },
                },
            },
            {
                $group: {
                    _id: null,
                    amount: { $sum: '$_agreedPrice' },
                    paidTenants: { $sum: { $cond: [{ $gt: ['$_agreedPrice', 0] }, 1, 0] } },
                },
            },
        ];

        const [
            totalRestaurants,
            activeRestaurants,
            trialRestaurants,
            suspendedRestaurants,
            totalBranches,
            activeBranches,
            pendingSignups,
            pendingPlanChanges,
            pendingPayments,
            plansByUsage,
            mrrAgg,
            mrrLastMonthAgg,
            trialsExpiringList,
            signupsThisMonth,
            signupsLastMonth,
            cancelsThisMonth,
            trialsStarted90d,
            convertedTrials90d,
            last24hAuditRaw,
            topTenantsAgg,
            liveTenantsForRisk,
            ordersByTenant14d,
            geoAgg,
            lastRazorpayAudit,
        ] = await Promise.all([
            Restaurant.countDocuments({}),
            Restaurant.countDocuments({ status: 'active' }),
            Restaurant.countDocuments({ status: 'trial' }),
            Restaurant.countDocuments({ status: 'suspended' }),
            Branch.countDocuments({}),
            Branch.countDocuments({ isActive: true }),
            Restaurant.countDocuments({ signupStatus: 'pending' }),
            PlanChangeRequest.countDocuments({ status: 'pending' }),
            Restaurant.countDocuments({ paymentStatus: 'pending' }),
            Restaurant.aggregate([
                { $match: { 'subscription.planSlug': { $ne: '' } } },
                { $group: { _id: '$subscription.planSlug', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),

            // Current MRR — tenants currently active (ignoring suspended/cancelled).
            Restaurant.aggregate(mrrPipeline({ status: 'active' })),

            // Last-month MRR approximation — tenants that were already
            // created before end of last month AND are still active OR
            // were cancelled AFTER end of last month. Without historical
            // snapshots this is directional (good enough for %-change).
            Restaurant.aggregate(mrrPipeline({
                createdAt: { $lte: endOfLastMonth },
                $or: [
                    { status: 'active' },
                    { status: { $in: ['cancelled', 'suspended'] }, updatedAt: { $gt: endOfLastMonth } },
                ],
            })),

            // Trials expiring within 7 days
            Restaurant.find({
                status: 'trial',
                'subscription.trialEndDate': { $exists: true, $ne: null, $lte: weekFromNow, $gte: now },
            })
                .select('name slug subscription.trialEndDate subscription.planName')
                .sort({ 'subscription.trialEndDate': 1 })
                .limit(25)
                .lean(),

            // ── Growth metrics ───────────────────────────────────────
            Restaurant.countDocuments({ createdAt: { $gte: startOfMonth } }),
            Restaurant.countDocuments({
                createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
            }),
            Restaurant.countDocuments({
                status: { $in: ['cancelled', 'suspended'] },
                updatedAt: { $gte: startOfMonth },
            }),

            // Conversion rate — trials that STARTED in the last 90 days
            // and whether they're now active (paid). Proxy: tenants
            // created 90 days ago with a trialEndDate set.
            Restaurant.countDocuments({
                createdAt: { $gte: ninetyDaysAgo },
                'subscription.trialEndDate': { $exists: true, $ne: null },
            }),
            Restaurant.countDocuments({
                createdAt: { $gte: ninetyDaysAgo },
                'subscription.trialEndDate': { $exists: true, $ne: null },
                status: 'active',
            }),

            // Last-24h activity — from audit log, privileged actions only
            AuditLog.find({ createdAt: { $gte: twentyFourHoursAgo } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),

            // Top tenants by 30-day order count
            Order.aggregate([
                { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                { $group: { _id: '$restaurant', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
            ]),

            // At-risk universe — active/trial tenants, then cross-ref
            // orders in last 14d to find the silent ones.
            Restaurant.find({ status: { $in: ['active', 'trial'] } })
                .select('name slug status subscription.planName city createdAt')
                .lean(),
            Order.aggregate([
                { $match: { createdAt: { $gte: fourteenDaysAgo } } },
                { $group: { _id: '$restaurant', count: { $sum: 1 } } },
            ]),

            // Geographic distribution — top 5 cities
            Restaurant.aggregate([
                { $match: { city: { $ne: '' }, status: { $ne: 'cancelled' } } },
                { $group: { _id: '$city', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
            ]),

            // System health — when did we last see a Razorpay webhook?
            AuditLog.findOne({ actorEmail: 'razorpay-webhook' })
                .sort({ createdAt: -1 })
                .select('createdAt action')
                .lean(),
        ]);

        const recentActivity = await AuditLog.find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        // ── Post-process: MRR + MoM delta ───────────────────────────
        const mrrRow = mrrAgg[0] || { amount: 0, paidTenants: 0 };
        const mrrLastRow = mrrLastMonthAgg[0] || { amount: 0, paidTenants: 0 };
        const mrrDelta = mrrRow.amount - mrrLastRow.amount;
        const mrrDeltaPct = mrrLastRow.amount > 0
            ? Math.round((mrrDelta / mrrLastRow.amount) * 100)
            : (mrrRow.amount > 0 ? 100 : 0);

        // ── Post-process: trials expiring ────────────────────────────
        const trialsExpiringSoon = {
            count: trialsExpiringList.length,
            tenants: trialsExpiringList.map(t => {
                const trialEnd = t.subscription?.trialEndDate;
                const daysLeft = trialEnd
                    ? Math.max(0, Math.ceil((new Date(trialEnd).getTime() - now.getTime()) / day))
                    : null;
                return {
                    _id: t._id,
                    name: t.name,
                    slug: t.slug,
                    planName: t.subscription?.planName || '',
                    trialEndDate: trialEnd,
                    daysLeft,
                };
            }),
        };

        // ── Post-process: Growth ─────────────────────────────────────
        const signupsDeltaPct = signupsLastMonth > 0
            ? Math.round(((signupsThisMonth - signupsLastMonth) / signupsLastMonth) * 100)
            : (signupsThisMonth > 0 ? 100 : 0);

        const conversionRate = trialsStarted90d > 0
            ? Math.round((convertedTrials90d / trialsStarted90d) * 100)
            : 0;

        // ── Post-process: Top tenants ────────────────────────────────
        const topTenantIds = topTenantsAgg.map(t => t._id).filter(Boolean);
        const topTenantDocs = topTenantIds.length > 0
            ? await Restaurant.find({ _id: { $in: topTenantIds } })
                .select('name slug subscription.planName status')
                .lean()
            : [];
        const topTenantMap = new Map(topTenantDocs.map(t => [t._id.toString(), t]));
        const topTenants = topTenantsAgg
            .map(row => {
                const t = topTenantMap.get(row._id?.toString());
                if (!t) return null;
                return {
                    _id: t._id,
                    name: t.name,
                    slug: t.slug,
                    planName: t.subscription?.planName || '',
                    status: t.status,
                    orderCount30d: row.count,
                };
            })
            .filter(Boolean);

        // ── Post-process: At-risk tenants (0 orders in 14 days) ──────
        const orderedSet = new Set(
            ordersByTenant14d
                .filter(r => r._id)
                .map(r => r._id.toString())
        );
        const atRiskList = liveTenantsForRisk
            .filter(t => !orderedSet.has(t._id.toString()))
            .filter(t => {
                // Don't flag brand-new tenants (<3 days old) as at-risk — they haven't had time.
                const age = now.getTime() - new Date(t.createdAt).getTime();
                return age > 3 * day;
            })
            .map(t => ({
                _id: t._id,
                name: t.name,
                slug: t.slug,
                status: t.status,
                planName: t.subscription?.planName || '',
            }));
        const atRiskTenants = {
            count: atRiskList.length,
            tenants: atRiskList.slice(0, 10),
        };

        // ── Post-process: Last-24h feed ──────────────────────────────
        // Filter down to operator-interesting actions; strip verbose details.
        const INTERESTING_24H = new Set([
            'restaurant.create',
            'restaurant.self_signup',
            'restaurant.signup_approve',
            'restaurant.signup_reject',
            'restaurant.suspend',
            'restaurant.reactivate',
            'restaurant.payment_confirm',
            'plan_change.request',
            'plan_change.approve',
            'plan_change.reject',
            'plan.create',
            'plan.archive',
        ]);
        const today = last24hAuditRaw
            .filter(a => INTERESTING_24H.has(a.action))
            .slice(0, 10)
            .map(a => ({
                _id: a._id,
                action: a.action,
                actorEmail: a.actorEmail,
                targetName: a.targetName,
                createdAt: a.createdAt,
            }));

        // ── Post-process: Geography ──────────────────────────────────
        const geoDistribution = geoAgg.map(row => ({
            city: row._id,
            count: row.count,
        }));

        // ── Post-process: System health ──────────────────────────────
        const emailConfigured = Boolean(process.env.EMAIL_PROVIDER);
        const razorpayConfigured = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
        const lastWebhookAt = lastRazorpayAudit?.createdAt || null;
        const lastWebhookAgeHours = lastWebhookAt
            ? Math.round((now.getTime() - new Date(lastWebhookAt).getTime()) / (60 * 60 * 1000))
            : null;
        const systemHealth = {
            db: {
                ok: true,
                responseMs: Date.now() - dbStart,
            },
            email: {
                configured: emailConfigured,
                provider: process.env.EMAIL_PROVIDER || 'none',
            },
            razorpay: {
                configured: razorpayConfigured,
                lastWebhookAt,
                lastWebhookAgeHours,
            },
            frontendUrl: process.env.FRONTEND_URL || '',
        };

        return res.status(200).json({
            success: true,
            data: {
                restaurants: {
                    total: totalRestaurants,
                    active: activeRestaurants,
                    trial: trialRestaurants,
                    suspended: suspendedRestaurants,
                },
                branches: {
                    total: totalBranches,
                    active: activeBranches,
                },
                pendingApprovals: {
                    signups: pendingSignups,
                    planChanges: pendingPlanChanges,
                    payments: pendingPayments,
                    total: pendingSignups + pendingPlanChanges + pendingPayments,
                },
                mrr: {
                    amount: mrrRow.amount,
                    currency: 'INR',
                    paidTenants: mrrRow.paidTenants,
                    previousAmount: mrrLastRow.amount,
                    deltaAmount: mrrDelta,
                    deltaPct: mrrDeltaPct,
                },
                growth: {
                    signupsThisMonth,
                    signupsLastMonth,
                    signupsDeltaPct,
                    cancelsThisMonth,
                    netTenantsThisMonth: signupsThisMonth - cancelsThisMonth,
                    conversion: {
                        trialsStarted90d,
                        convertedToPaid: convertedTrials90d,
                        ratePct: conversionRate,
                    },
                },
                today,
                systemHealth,
                topTenants,
                atRiskTenants,
                geoDistribution,
                trialsExpiringSoon,
                plansByUsage,
                recentActivity: recentActivity.map(a => ({
                    _id: a._id,
                    action: a.action,
                    actorEmail: a.actorEmail,
                    targetType: a.targetType,
                    targetName: a.targetName,
                    createdAt: a.createdAt,
                })),
                generatedAt: new Date(),
            },
        });
    } catch (err) {
        logger.error('getPlatformAnalytics error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load analytics' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════

// Shared filter-builder for both the paginated list and the CSV
// export. Keeping it in one place means we can't drift into "list
// shows X but export shows Y" bugs under the same filters.
function buildAuditLogFilter(query) {
    const { action, targetType, targetId, actor, from, to } = query;
    const filter = {};
    if (action)     filter.action = action;
    if (targetType) filter.targetType = targetType;
    if (targetId && mongoose.isValidObjectId(targetId)) filter.targetId = targetId;
    if (actor && mongoose.isValidObjectId(actor)) filter.actor = actor;
    // Phase 4 step 3 — optional date-range filter for compliance
    // exports. Accepts ISO strings or anything Date() can parse.
    // Silently ignores unparseable values rather than 400ing so a
    // bad bookmark doesn't break the list page.
    if (from || to) {
        filter.createdAt = {};
        if (from) {
            const d = new Date(from);
            if (!Number.isNaN(d.getTime())) filter.createdAt.$gte = d;
        }
        if (to) {
            const d = new Date(to);
            if (!Number.isNaN(d.getTime())) filter.createdAt.$lte = d;
        }
        if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }
    return filter;
}

// GET /api/v1/superadmin/audit-logs
exports.listAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const filter = buildAuditLogFilter(req.query);

        const pageNum  = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

        const [items, total] = await Promise.all([
            AuditLog.find(filter)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * pageSize)
                .limit(pageSize)
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            data: items,
            pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
        });
    } catch (err) {
        logger.error('listAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list audit logs' });
    }
};

// GET /api/v1/superadmin/audit-logs/export
//
// Compliance-friendly CSV export of audit log entries. Accepts the
// same filter query params as the list endpoint (action, targetType,
// targetId, actor) plus optional `from` / `to` date range. Returns
// up to EXPORT_CAP rows sorted oldest-first (chronological order is
// what compliance workflows expect).
//
// We don't stream row-by-row — the cap is small enough that building
// the whole payload in memory is fine and keeps the code simple.
// If this grows past ~50k rows per export, switch to a cursor +
// res.write() flush.
exports.exportAuditLogs = async (req, res) => {
    const EXPORT_CAP = 10000;
    try {
        const filter = buildAuditLogFilter(req.query);
        const items = await AuditLog.find(filter)
            .sort({ createdAt: 1 })    // chronological for compliance
            .limit(EXPORT_CAP)
            .lean();

        // ── CSV escape helper ────────────────────────────────────────
        // RFC 4180: fields containing commas, quotes, or newlines must
        // be wrapped in double quotes, with any internal quotes doubled.
        // Dates are ISO 8601 for deterministic sorting in Excel/Sheets.
        const esc = (v) => {
            if (v === null || v === undefined) return '';
            let s = typeof v === 'string' ? v : String(v);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
                s = '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        };

        const header = [
            'createdAt',
            'action',
            'actorEmail',
            'actorRole',
            'actorLevel',
            'targetType',
            'targetId',
            'targetName',
            'ip',
            'userAgent',
            'details',
        ].join(',');

        const rows = items.map(a => [
            a.createdAt ? new Date(a.createdAt).toISOString() : '',
            esc(a.action),
            esc(a.actorEmail),
            esc(a.actorRole),
            esc(a.actorLevel),
            esc(a.targetType),
            esc(a.targetId?.toString?.() || ''),
            esc(a.targetName),
            esc(a.ip),
            esc(a.userAgent),
            // details is a free-form object — JSON-stringify then
            // CSV-escape. Empty objects collapse to {}, which is
            // harmless in a spreadsheet.
            esc(JSON.stringify(a.details || {})),
        ].join(','));

        // UTF-8 BOM so Excel opens the file with the right encoding
        // (otherwise non-ASCII tenant names appear mojibake).
        const body = '\uFEFF' + header + '\n' + rows.join('\n') + '\n';

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="audit-logs-${stamp}.csv"`
        );
        if (items.length === EXPORT_CAP) {
            // Surface the truncation to the client via a response
            // header so the UI can warn the user that they need to
            // narrow the date range for a complete export.
            res.setHeader('X-Export-Truncated', 'true');
            logger.warn(`audit-logs export capped at ${EXPORT_CAP} rows`, {
                filter,
            });
        }
        return res.status(200).send(body);
    } catch (err) {
        logger.error('exportAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to export audit logs' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// AUDIT LOG RETENTION (Phase 7.5)
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/superadmin/audit-logs/purge
 *
 * Deletes audit log entries that are older than each tenant's plan-
 * level retention window (`limits.auditRetentionDays`). Entries with
 * `targetType !== 'restaurant'` or a missing targetId are never
 * purged — they're platform-level records (plan edits, superadmin
 * CRUD, etc.) that don't belong to any tenant.
 *
 * Body (optional):
 *   { dryRun: true }  — returns the counts without actually deleting.
 *                       Default is false (real delete). Always run a
 *                       dry-run first to verify the numbers.
 *
 * Returns: { purged: N, byTenant: [{ slug, purged, retentionDays }] }
 */
exports.purgeExpiredAuditLogs = async (req, res) => {
    try {
        const dryRun = req.body?.dryRun === true;

        // 1. Load every restaurant with its plan's retention window.
        //    We need the denormalised limits from the subscription
        //    snapshot (not the SubscriptionPlan doc) because that's
        //    what the tenant is actually on — plan edits don't silently
        //    change retention on existing tenants.
        const restaurants = await Restaurant.find({})
            .select('slug subscription.limits')
            .lean();

        let totalPurged = 0;
        const byTenant = [];

        for (const r of restaurants) {
            const days = r.subscription?.limits?.auditRetentionDays;
            // 0 or undefined/null = unlimited retention → skip
            if (!days || days <= 0) continue;

            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            if (dryRun) {
                const count = await AuditLog.countDocuments({
                    targetType: 'restaurant',
                    targetId: r._id,
                    createdAt: { $lt: cutoff },
                });
                if (count > 0) {
                    byTenant.push({ slug: r.slug, purged: count, retentionDays: days });
                    totalPurged += count;
                }
            } else {
                const result = await AuditLog.deleteMany({
                    targetType: 'restaurant',
                    targetId: r._id,
                    createdAt: { $lt: cutoff },
                });
                if (result.deletedCount > 0) {
                    byTenant.push({ slug: r.slug, purged: result.deletedCount, retentionDays: days });
                    totalPurged += result.deletedCount;
                }
            }
        }

        logger.info(`audit-logs purge ${dryRun ? '(dry-run) ' : ''}purged=${totalPurged} tenants=${byTenant.length}`);

        return res.json({
            success: true,
            dryRun,
            purged: totalPurged,
            byTenant,
        });
    } catch (err) {
        logger.error('purgeExpiredAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to purge audit logs' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PENDING APPROVALS — three queues surfaced through one page:
//   1. Self-signup tenants  (signupStatus: 'pending')
//   2. Plan-change requests (PlanChangeRequest, status: 'pending')
//   3. Payment-pending      (paymentStatus: 'pending')
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v1/superadmin/pending-approvals
// Returns all three queues in a single payload so the frontend page
// can render its three tabs without three separate round-trips.
exports.listPendingApprovals = async (_req, res) => {
    try {
        const [signups, planChanges, paymentPending, plans] = await Promise.all([
            Restaurant.find({ signupStatus: 'pending' })
                .select('name slug contactEmail contactPhone city signupNote subscription.planName requestedPlan signupMeta owner createdAt')
                .populate({ path: 'owner', select: 'name' })
                .sort({ createdAt: -1 })
                .lean()
                // Flat, display-ready shape for the Pending Approvals page.
                .then(list => list.map(r => ({
                    _id: r._id,
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    contactPhone: r.contactPhone || '',
                    contactEmail: r.contactEmail || '',
                    ownerName: r.signupMeta?.ownerName || r.owner?.name || '',
                    requestedPlan: r.requestedPlan?.plan
                        ? { _id: r.requestedPlan.plan, name: r.requestedPlan.planName || '' }
                        : null,
                    signupMeta: {
                        source:      r.signupMeta?.source || '',
                        utmSource:   r.signupMeta?.utmSource || '',
                        utmMedium:   r.signupMeta?.utmMedium || '',
                        utmCampaign: r.signupMeta?.utmCampaign || '',
                        utmTerm:     r.signupMeta?.utmTerm || '',
                        utmContent:  r.signupMeta?.utmContent || '',
                        termsAcceptedAt: r.signupMeta?.termsAcceptedAt || null,
                    },
                    signupNote: r.signupNote || '',
                    subscription: { planName: r.subscription?.planName || '' },
                    createdAt: r.createdAt,
                }))),
            // Pull price + name for both sides so the frontend can
            // detect "this is a downgrade" and tweak the approve
            // dialog copy ("scheduled" vs "immediate"). currentPlan
            // is the ObjectId of the plan they had at request-time.
            PlanChangeRequest.find({ status: 'pending' })
                .populate({ path: 'restaurant', select: 'name slug contactEmail' })
                .populate({ path: 'currentPlan',   select: 'name price' })
                .populate({ path: 'requestedPlan', select: 'name price' })
                .sort({ createdAt: -1 })
                .lean()
                .then(list => list.map(r => ({
                    ...r,
                    // Flatten so the frontend doesn't have to dig into populated docs
                    currentPlanPrice:   r.currentPlan?.price   ?? null,
                    requestedPlanPrice: r.requestedPlan?.price ?? r.requestedPlanPrice ?? null,
                }))),
            Restaurant.find({ paymentStatus: 'pending' })
                .select('name slug contactEmail contactPhone city subscription.planName subscription.plan subscription.price paymentNote status updatedAt')
                .sort({ updatedAt: -1 })
                .lean(),
            // Plan price map so the offline-payments queue can show the
            // operator exactly how much to collect.
            SubscriptionPlan.find({}).select('price currency').lean(),
        ]);

        // Agreed snapshot price first (priceOverride at create time) —
        // same amount getPaymentApprovalDetail shows; catalogue price is
        // only a fallback for legacy rows without a snapshot.
        const priceById = new Map(plans.map(p => [String(p._id), p.price || 0]));
        const paymentPendingEnriched = paymentPending.map(r => ({
            ...r,
            planPrice: typeof r.subscription?.price === 'number'
                ? r.subscription.price
                : (r.subscription?.plan ? (priceById.get(String(r.subscription.plan)) || 0) : 0),
        }));

        return res.status(200).json({
            success: true,
            data: {
                signups,
                planChanges,
                paymentPending: paymentPendingEnriched,
                counts: {
                    signups: signups.length,
                    planChanges: planChanges.length,
                    paymentPending: paymentPending.length,
                    total: signups.length + planChanges.length + paymentPending.length,
                },
            },
        });
    } catch (err) {
        logger.error('listPendingApprovals error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load pending approvals' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/approve-signup
// Approves a self-signup. Flips signupStatus → approved, releases the
// suspension lock, and sends the welcome email so the owner knows they
// can log in.
exports.approveSignup = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.signupStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot approve — signup is already '${restaurant.signupStatus}'.`,
            });
        }

        // Restart the trial clock from the approval date — a hotel must
        // not lose trial days while its application waits for review.
        // Length = the snapshot plan's trialDays, else the self-signup
        // default (SELF_SIGNUP_TRIAL_DAYS, 14).
        const now = new Date();
        let trialDays = SELF_SIGNUP_TRIAL_DAYS;
        if (restaurant.subscription?.plan) {
            const snapPlan = await SubscriptionPlan.findById(restaurant.subscription.plan).select('trialDays').lean();
            if (snapPlan && Number(snapPlan.trialDays) > 0) trialDays = Number(snapPlan.trialDays);
        }
        restaurant.subscription.startDate = now;
        restaurant.subscription.trialStartDate = now;
        restaurant.subscription.trialEndDate = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
        restaurant.subscription.status = 'trial';

        restaurant.signupStatus = 'approved';
        restaurant.signupReviewedAt = now;
        restaurant.signupReviewedBy = req.user._id;
        restaurant.status = 'trial';
        restaurant.suspendedAt = undefined;
        restaurant.suspendedReason = '';
        await restaurant.save();
        // Drop the cached (suspended) tenant so the public landing page
        // and staff requests see the unlocked tenant immediately.
        invalidateTenant(restaurant._id);

        await recordAudit(req, {
            action: 'restaurant.signup_approve',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { newStatus: restaurant.status, trialDays, trialEndDate: restaurant.subscription.trialEndDate },
        });

        // Welcome email — uses self-signup template (no temp password,
        // they set their own). trialDays = the full, freshly started trial.
        try {
            const { restaurantSelfSignupWelcome } = require('../utils/emailTemplates');
            await sendEmail({
                to: restaurant.contactEmail,
                ...restaurantSelfSignupWelcome({
                    restaurantName: restaurant.name,
                    ownerName: restaurant.signupMeta?.ownerName || '',
                    email: restaurant.contactEmail,
                    planName: restaurant.subscription?.planName || '',
                    trialDays,
                    // Email carries the staff login URL and the public
                    // page URL (<FRONTEND_URL>/<slug>).
                    slug: restaurant.slug,
                }),
            });
        } catch (mailErr) {
            logger.warn(`approve-signup email failed for ${restaurant.contactEmail}: ${mailErr.message}`);
        }

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('approveSignup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to approve signup' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/reject-signup
// Body: { reason }  — required
// Marks the signup rejected. Tenant stays suspended forever (we keep
// the document for audit). Sends the owner a polite rejection email.
exports.rejectSignup = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }
        if (reason.length > 500) {
            return res.status(400).json({ success: false, message: 'Rejection reason cannot exceed 500 characters' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.signupStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject — signup is already '${restaurant.signupStatus}'.`,
            });
        }

        restaurant.signupStatus = 'rejected';
        restaurant.signupRejectedReason = reason;
        restaurant.signupReviewedAt = new Date();
        restaurant.signupReviewedBy = req.user._id;
        restaurant.suspendedReason = `Signup rejected: ${reason}`;
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.signup_reject',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { reason },
        });

        res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });

        // Owner rejection email — after the response; a mail failure
        // never affects the (already committed) rejection.
        const to = restaurant.contactEmail;
        const mail = signupRejected({
            restaurantName: restaurant.name,
            ownerName: restaurant.signupMeta?.ownerName || '',
            reason,
        });
        setImmediate(() => {
            Promise.resolve()
                .then(() => sendEmail({ to, ...mail }))
                .catch((mailErr) => logger.warn(`reject-signup email failed for ${to}: ${mailErr.message}`));
        });
        return undefined;
    } catch (err) {
        logger.error('rejectSignup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reject signup' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/confirm-payment
// Body: { note? }  — optional context
// Marks an offline payment as received and unlocks the tenant.
exports.confirmPayment = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.paymentStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm — payment status is '${restaurant.paymentStatus}'.`,
            });
        }

        const trialStillValid = restaurant.subscription?.trialEndDate
            && new Date(restaurant.subscription.trialEndDate) > new Date();

        restaurant.paymentStatus = 'received';
        restaurant.paymentConfirmedAt = new Date();
        restaurant.paymentConfirmedBy = req.user._id;
        restaurant.paymentNote = (req.body?.note || '').trim();
        // Only flip status from suspended → trial/active if the
        // suspension was specifically due to payment-pending. Don't
        // accidentally unsuspend a tenant suspended for ToS violation.
        if (restaurant.status === 'suspended' && /payment/i.test(restaurant.suspendedReason || '')) {
            restaurant.status = trialStillValid ? 'trial' : 'active';
            restaurant.suspendedAt = undefined;
            restaurant.suspendedReason = '';
        }
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.payment_confirm',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { note: restaurant.paymentNote },
        });

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('confirmPayment error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to confirm payment' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/plan-change-request
// Body: { planId, note? }
// Records that the tenant wants to switch plans, awaiting offline
// payment confirmation. Approval runs the existing assignPlan flow.
exports.createPlanChangeRequest = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const { planId, note } = req.body || {};
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'A valid plan id is required' });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(id),
            SubscriptionPlan.findById(planId),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // Block stacking — at most one pending request per tenant.
        const existing = await PlanChangeRequest.findOne({
            restaurant: restaurant._id,
            status: 'pending',
        }).lean();
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'A pending plan change already exists for this tenant. Approve or reject it first.',
            });
        }

        const request = await PlanChangeRequest.create({
            restaurant: restaurant._id,
            requestedPlan: plan._id,
            requestedPlanName: plan.name,
            requestedPlanPrice: plan.price,
            currentPlan: restaurant.subscription?.plan || null,
            currentPlanName: restaurant.subscription?.planName || '',
            note: (note || '').trim(),
            requestedBy: req.user._id,
            requestedByEmail: req.user.email,
        });

        await recordAudit(req, {
            action: 'plan_change.request',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { from: request.currentPlanName, to: request.requestedPlanName, requestId: request._id },
        });

        return res.status(201).json({ success: true, data: request });
    } catch (err) {
        logger.error('createPlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create plan change request' });
    }
};

// POST /api/v1/superadmin/plan-change-requests/:requestId/approve
// Behaviour depends on whether this is an UPGRADE or a DOWNGRADE:
//
//   Upgrade / same-tier operator-recorded swap (operator-source or
//     tenant-source where target plan >= current price):
//       Plan is applied immediately — same as before. Operator's
//       offline payment is the source of truth.
//
//   Tenant-source DOWNGRADE (target plan price < current price):
//       Plan is NOT applied now. Instead we schedule the switch for
//       the end of the current billing cycle so the tenant keeps the
//       features they already paid for. Razorpay subscription is
//       cancelled with cancel_at_cycle_end:true; the
//       subscription.completed webhook (or a lazy check at page load
//       for the fallback Orders path) applies the new plan when the
//       cycle ends. Zero refunds, zero proration math.
exports.approvePlanChangeRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!mongoose.isValidObjectId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const request = await PlanChangeRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request already '${request.status}'.` });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(request.restaurant),
            SubscriptionPlan.findById(request.requestedPlan),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant no longer exists' });
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Plan no longer available — reject this request and create a new one.' });
        }

        // Is this an actual downgrade? Compare new plan price against
        // the current plan's snapshotted price on the restaurant. We
        // only schedule downgrades for tenant-source requests; the
        // operator path is for offline-payment swaps that the operator
        // wants to apply right away.
        // Prefer the snapshot (what the tenant pays); the catalogue price
        // may have been edited since. Fall back to it only for legacy
        // tenants without a snapshotted price.
        let currentPrice = 0;
        if (typeof restaurant.subscription?.price === 'number') {
            currentPrice = restaurant.subscription.price;
        } else if (restaurant.subscription?.plan) {
            const currentPlanDoc = await SubscriptionPlan.findById(restaurant.subscription.plan).select('price');
            currentPrice = currentPlanDoc?.price ?? 0;
        }
        const isDowngrade = request.requestSource === 'tenant'
            && currentPrice > 0
            && plan.price < currentPrice;

        // A tenant request is only ever a downgrade. Anything else
        // (same price or pricier) must go through paid self-service
        // upgrade — approving it here would hand out the plan for free.
        if (request.requestSource === 'tenant' && !isDowngrade) {
            return res.status(400).json({
                success: false,
                code: 'NOT_A_DOWNGRADE',
                message: `${plan.name} is not cheaper than what this tenant currently pays — reject this request; upgrades must be paid via self-service.`,
            });
        }

        if (isDowngrade) {
            // ── Schedule, don't swap ────────────────────────────────
            // Cancel the live Razorpay subscription with cycle-end
            // timing. Razorpay will keep charging until the cycle
            // ends (if applicable) and then stop. The
            // subscription.completed webhook will apply the new plan
            // server-side.
            const currentPeriodEnd = restaurant.subscription?.currentPeriodEnd;
            const effectiveAt = currentPeriodEnd
                ? new Date(currentPeriodEnd)
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // safety fallback: +30d

            const liveSubId = restaurant.subscription?.razorpaySubscriptionId;
            let cancelResult = { attempted: false, ok: false };
            if (liveSubId && isBillingConfigured()) {
                try {
                    await cancelRazorpaySubscription(liveSubId, true /* cancelAtCycleEnd */);
                    cancelResult = { attempted: true, ok: true };
                    logger.info(`Scheduled cancel-at-cycle-end for ${restaurant.slug} sub ${liveSubId}`);
                } catch (cancelErr) {
                    // Non-fatal — record the failure but still schedule
                    // the local downgrade. Operator can manually cancel
                    // in the Razorpay dashboard if needed.
                    cancelResult = { attempted: true, ok: false, error: cancelErr?.message || 'cancel failed' };
                    logger.warn(`Failed to cancel Razorpay sub ${liveSubId}: ${cancelErr.message}`);
                }
            }

            restaurant.subscription = restaurant.subscription || {};
            restaurant.subscription.scheduledDowngrade = {
                plan: plan._id,
                planName: plan.name,
                planSlug: plan.slug,
                price: typeof plan.price === 'number' ? plan.price : 0,
                features: plan.features?.toObject ? plan.features.toObject() : { ...(plan.features || {}) },
                limits:   plan.limits?.toObject   ? plan.limits.toObject()   : { ...(plan.limits   || {}) },
                effectiveAt,
                requestId: request._id,
                fromPlanName: restaurant.subscription.planName || request.currentPlanName || '',
                scheduledAt: new Date(),
            };
            await restaurant.save();

            request.status = 'approved';
            request.reviewedAt = new Date();
            request.reviewedBy = req.user._id;
            request.reviewedByEmail = req.user.email;
            await request.save();

            await recordAudit(req, {
                action: 'plan_change.approve.scheduled',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: {
                    from: request.currentPlanName,
                    to: request.requestedPlanName,
                    requestId: request._id,
                    effectiveAt,
                    razorpayCancel: cancelResult,
                },
            });

            return res.status(200).json({
                success: true,
                data: {
                    request,
                    restaurant: buildRestaurantPayload(restaurant),
                    scheduled: true,
                    effectiveAt,
                    razorpayCancel: cancelResult,
                },
            });
        }

        // ── Same-tier or upgrade swap (operator path) ───────────────
        // Apply the plan snapshot immediately. We deliberately do NOT
        // touch the Razorpay subscription here — the operator's
        // offline payment is the source of truth for this flow.
        const trialEndDate = (plan.trialDays || 0) > 0
            ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000)
            : null;
        restaurant.subscription = {
            ...(restaurant.subscription?.toObject ? restaurant.subscription.toObject() : restaurant.subscription || {}),
            ...snapshotPlan(plan),
            startDate: new Date(),
            endDate: null,
            trialEndDate,
            status: trialEndDate ? 'trial' : 'active',
        };
        if (trialEndDate) restaurant.status = 'trial';
        else restaurant.status = restaurant.status === 'suspended' ? 'active' : restaurant.status;
        await restaurant.save();

        request.status = 'approved';
        request.reviewedAt = new Date();
        request.reviewedBy = req.user._id;
        request.reviewedByEmail = req.user.email;
        await request.save();

        await recordAudit(req, {
            action: 'plan_change.approve',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { from: request.currentPlanName, to: request.requestedPlanName, requestId: request._id },
        });

        return res.status(200).json({ success: true, data: { request, restaurant: buildRestaurantPayload(restaurant), scheduled: false } });
    } catch (err) {
        logger.error('approvePlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to approve plan change' });
    }
};

// POST /api/v1/superadmin/plan-change-requests/:requestId/reject
// Body: { reason }  — required
exports.rejectPlanChangeRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!mongoose.isValidObjectId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }
        const request = await PlanChangeRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request already '${request.status}'.` });
        }

        request.status = 'rejected';
        request.rejectedReason = reason;
        request.reviewedAt = new Date();
        request.reviewedBy = req.user._id;
        request.reviewedByEmail = req.user.email;
        await request.save();

        await recordAudit(req, {
            action: 'plan_change.reject',
            targetType: 'restaurant',
            targetId: request.restaurant,
            targetName: request.currentPlanName + ' → ' + request.requestedPlanName,
            details: { reason, requestId: request._id },
        });

        return res.status(200).json({ success: true, data: request });
    } catch (err) {
        logger.error('rejectPlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reject plan change' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// APPROVAL DETAIL PAGES — read-only drill-downs behind each row of the
// Pending Approvals queues (plus the internal signup review note).
//
//   GET   /superadmin/approvals/signups/:id
//   PATCH /superadmin/approvals/signups/:id/note        (superAdminFull)
//   GET   /superadmin/approvals/plan-changes/:requestId
//   GET   /superadmin/approvals/payments/:id
//
// Platform-wide by design (Super Admin). Every tenant-owned collection
// is still queried with an explicit `restaurant:` filter for the tenant
// under review. Payloads are hand-built: no password hashes, tokens,
// Razorpay secrets or raw user documents ever leave this section.
// ═══════════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_LIST_CAP = 10;
const APPROVAL_LIMIT_KEYS = ['maxBranches', 'maxTables', 'maxStaff', 'maxMenuItems', 'apiRateLimit', 'auditRetentionDays'];
const LIMIT_LABELS = {
    maxBranches: 'Branches',
    maxTables: 'Tables',
    maxStaff: 'Staff',
    maxMenuItems: 'Menu items',
    apiRateLimit: 'API rate limit',
    auditRetentionDays: 'Audit retention (days)',
};
// Staff roles counted against `maxStaff` (mirrors staffController).
const STAFF_ROLES = ['admin', 'manager', 'waiter', 'captain', 'chef'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactCI = (s) => new RegExp(`^${escapeRegex(String(s).trim())}$`, 'i');
const toPlain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : (v || {}));

// Regex that matches a stored phone whose digits end in the given
// normalised 10-digit mobile, tolerating spaces / hyphens / brackets and
// any +91 / 0 prefix. Candidates are re-checked with normalizeMobile.
function phoneRegex(norm) {
    return new RegExp(`${norm.split('').join('[\\s\\-()]*')}\\s*$`);
}

function planPublicShape(p) {
    if (!p) return null;
    return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        price: typeof p.price === 'number' ? p.price : null,
        currency: p.currency || 'INR',
        billingCycle: p.billingCycle || 'monthly',
        trialDays: p.trialDays || 0,
        isActive: p.isActive !== false,
        features: toPlain(p.features),
        limits: toPlain(p.limits),
    };
}

// Compact, human-readable one-liner from a free-form audit `details`
// object — only primitive values, secrets never reach here (recordAudit
// already strips them on write).
function summarizeAuditDetails(details) {
    if (!details || typeof details !== 'object') return '';
    const parts = [];
    for (const [k, v] of Object.entries(details)) {
        if (v === null || v === undefined || v === '') continue;
        let val;
        if (v instanceof Date) val = v.toISOString().slice(0, 10);
        else if (typeof v === 'object') continue; // nested objects / ids — too noisy for a one-liner
        else val = String(v);
        if (/^[a-f0-9]{24}$/i.test(val)) continue; // bare ids add noise
        parts.push(`${k}: ${val.length > 80 ? `${val.slice(0, 77)}…` : val}`);
        if (parts.length >= 4) break;
    }
    return parts.join(' · ');
}

async function restaurantActivity(restaurantId, limit = 20) {
    const rows = await AuditLog.find({ targetType: 'restaurant', targetId: restaurantId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({ path: 'actor', select: 'name email' })
        .lean();
    return rows.map((a) => ({
        _id: a._id,
        action: a.action,
        actorName: a.actor?.name || a.actorEmail || (a.actorRole === 'system' ? 'System' : ''),
        actorEmail: a.actor?.email || a.actorEmail || '',
        createdAt: a.createdAt,
        summary: summarizeAuditDetails(a.details),
    }));
}

const brief = (r) => ({
    _id: r._id,
    name: r.name,
    slug: r.slug,
    city: r.city || '',
    status: r.status,
    signupStatus: r.signupStatus || 'approved',
    createdAt: r.createdAt,
});

// GET /api/v1/superadmin/approvals/signups/:id
exports.getSignupApplication = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const r = await Restaurant.findById(id).select('+signupReviewNote').lean();
        if (!r || r.signupSource !== 'self') {
            return res.status(404).json({ success: false, message: 'Signup application not found' });
        }

        const email = (r.contactEmail || '').trim().toLowerCase();
        const [owner, requestedPlanDoc, noteAuthor] = await Promise.all([
            r.owner ? User.findById(r.owner).select('name email mobile createdAt lastLoginAt').lean() : null,
            r.requestedPlan?.plan ? SubscriptionPlan.findById(r.requestedPlan.plan).lean() : null,
            r.signupReviewNoteUpdatedBy ? User.findById(r.signupReviewNoteUpdatedBy).select('name email').lean() : null,
        ]);

        // ── Duplicate / risk checks ───────────────────────────────────
        const phones = [...new Set([normalizeMobile(r.contactPhone), normalizeMobile(owner?.mobile)].filter(Boolean))];
        const notSelf = { _id: { $ne: r._id } };
        const DUP_FIELDS = 'name slug city status signupStatus signupRejectedReason signupReviewedAt contactEmail contactPhone createdAt';

        const [emailDupes, phoneCandidates, nameCityDupes, leadCandidates] = await Promise.all([
            email
                ? Restaurant.find({ ...notSelf, contactEmail: exactCI(email) }).select(DUP_FIELDS).limit(DETAIL_LIST_CAP).lean()
                : [],
            phones.length
                ? Restaurant.find({ ...notSelf, $or: phones.map((p) => ({ contactPhone: phoneRegex(p) })) })
                    .select(DUP_FIELDS).limit(50).lean()
                : [],
            r.name && r.city
                ? Restaurant.find({ ...notSelf, name: exactCI(r.name), city: exactCI(r.city) })
                    .select(DUP_FIELDS).limit(DETAIL_LIST_CAP).lean()
                : [],
            (email || phones.length)
                ? Lead.find({
                    $or: [
                        ...(email ? [{ email: exactCI(email) }] : []),
                        ...phones.map((p) => ({ phone: phoneRegex(p) })),
                    ],
                }).select('name restaurantName status email phone createdAt').sort({ createdAt: -1 }).limit(50).lean()
                : [],
        ]);

        const phoneDupes = phoneCandidates
            .filter((d) => phones.includes(normalizeMobile(d.contactPhone)))
            .slice(0, DETAIL_LIST_CAP);
        const matchingLeads = leadCandidates
            .filter((l) => (email && (l.email || '').toLowerCase() === email) || phones.includes(normalizeMobile(l.phone)))
            .slice(0, DETAIL_LIST_CAP)
            .map((l) => ({ _id: l._id, name: l.name, restaurantName: l.restaurantName, status: l.status, createdAt: l.createdAt }));

        const rejectedById = new Map();
        for (const d of [...emailDupes, ...phoneDupes, ...nameCityDupes]) {
            if (d.signupStatus === 'rejected') rejectedById.set(String(d._id), d);
        }
        const previousRejections = [...rejectedById.values()].map((d) => ({
            _id: d._id,
            name: d.name,
            slug: d.slug,
            rejectedAt: d.signupReviewedAt || null,
            reason: d.signupRejectedReason || '',
        }));

        const activity = await restaurantActivity(r._id);
        const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
        const meta = r.signupMeta || {};

        return res.status(200).json({
            success: true,
            data: {
                application: {
                    _id: r._id,
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    address: r.address || {},
                    contactEmail: r.contactEmail || '',
                    contactPhone: r.contactPhone || '',
                    signupNote: r.signupNote || '',
                    signupStatus: r.signupStatus,
                    signupRejectedReason: r.signupRejectedReason || '',
                    signupReviewedAt: r.signupReviewedAt || null,
                    status: r.status,
                    createdAt: r.createdAt,
                    waitingSince: Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / DAY_MS)),
                    pageUrl: `${frontend}/${r.slug}`,
                },
                owner: owner ? {
                    _id: owner._id,
                    name: owner.name || meta.ownerName || '',
                    email: owner.email || '',
                    mobile: owner.mobile || '',
                    createdAt: owner.createdAt || null,
                    lastLoginAt: owner.lastLoginAt || null,
                } : (meta.ownerName ? { _id: null, name: meta.ownerName, email: r.contactEmail || '', mobile: r.contactPhone || '', createdAt: null, lastLoginAt: null } : null),
                requestedPlan: requestedPlanDoc
                    ? planPublicShape(requestedPlanDoc)
                    : (r.requestedPlan?.planName
                        ? { _id: r.requestedPlan.plan || null, name: r.requestedPlan.planName, slug: r.requestedPlan.planSlug || '', price: null, currency: 'INR', billingCycle: '', trialDays: 0, isActive: false, features: {}, limits: {} }
                        : null),
                subscriptionPlan: { planName: r.subscription?.planName || '', planSlug: r.subscription?.planSlug || '' },
                signupMeta: {
                    source: meta.source || '',
                    utmSource: meta.utmSource || '',
                    utmMedium: meta.utmMedium || '',
                    utmCampaign: meta.utmCampaign || '',
                    utmTerm: meta.utmTerm || '',
                    utmContent: meta.utmContent || '',
                    termsAcceptedAt: meta.termsAcceptedAt || null,
                    ip: meta.ip || '',
                },
                checks: {
                    duplicateEmail: emailDupes.map(brief),
                    duplicatePhone: phoneDupes.map(brief),
                    sameNameCity: nameCityDupes.map(brief),
                    previousRejections,
                    matchingLeads,
                },
                activity,
                reviewNote: {
                    text: r.signupReviewNote || '',
                    updatedAt: r.signupReviewNoteUpdatedAt || null,
                    updatedByName: noteAuthor?.name || noteAuthor?.email || '',
                },
            },
        });
    } catch (err) {
        logger.error('getSignupApplication error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load signup application' });
    }
};

// PATCH /api/v1/superadmin/approvals/signups/:id/note   { reviewNote }
// Internal note for other Super Admins — never shown to the tenant.
exports.updateSignupReviewNote = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const raw = req.body?.reviewNote;
        if (raw !== undefined && raw !== null && typeof raw !== 'string') {
            return res.status(400).json({ success: false, message: 'Review note must be text' });
        }
        const text = (raw || '').trim();
        if (text.length > 1000) {
            return res.status(400).json({ success: false, message: 'Review note cannot exceed 1000 characters' });
        }
        const r = await Restaurant.findById(id).select('name signupSource +signupReviewNote');
        if (!r || r.signupSource !== 'self') {
            return res.status(404).json({ success: false, message: 'Signup application not found' });
        }
        const before = r.signupReviewNote || '';
        const now = new Date();
        // updateOne — avoids re-validating unrelated legacy fields on save().
        await Restaurant.updateOne(
            { _id: r._id },
            { $set: { signupReviewNote: text, signupReviewNoteUpdatedAt: now, signupReviewNoteUpdatedBy: req.user._id } },
        );

        await recordAudit(req, {
            action: 'restaurant.signup_note',
            targetType: 'restaurant',
            targetId: r._id,
            targetName: r.name,
            details: { length: text.length, cleared: !text && !!before },
        });

        return res.status(200).json({
            success: true,
            data: { text, updatedAt: now, updatedByName: req.user.name || req.user.email || '' },
        });
    } catch (err) {
        logger.error('updateSignupReviewNote error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to save review note' });
    }
};

// GET /api/v1/superadmin/approvals/plan-changes/:requestId
exports.getPlanChangeDetail = async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!mongoose.isValidObjectId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const request = await PlanChangeRequest.findById(requestId).lean();
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });

        const restaurant = await Restaurant.findById(request.restaurant).lean();
        const sub = restaurant?.subscription || {};
        const currentPlanId = sub.plan || request.currentPlan || null;

        const [requestedPlanDoc, currentPlanDoc] = await Promise.all([
            SubscriptionPlan.findById(request.requestedPlan).lean(),
            currentPlanId ? SubscriptionPlan.findById(currentPlanId).lean() : null,
        ]);

        // ── Current plan = what the tenant is contracted on (snapshot) ──
        const currentPlan = currentPlanDoc || sub.planName ? {
            _id: currentPlanId,
            name: sub.planName || currentPlanDoc?.name || request.currentPlanName || '',
            price: typeof sub.price === 'number' ? sub.price : (currentPlanDoc?.price ?? null),
            catalogPrice: currentPlanDoc?.price ?? null,
            currency: currentPlanDoc?.currency || 'INR',
            billingCycle: currentPlanDoc?.billingCycle || 'monthly',
            features: Object.keys(sub.features || {}).length ? sub.features : toPlain(currentPlanDoc?.features),
            limits: Object.keys(sub.limits || {}).length ? sub.limits : toPlain(currentPlanDoc?.limits),
        } : null;
        const requestedPlan = requestedPlanDoc
            ? planPublicShape(requestedPlanDoc)
            : { _id: request.requestedPlan, name: request.requestedPlanName, price: request.requestedPlanPrice ?? null, currency: 'INR', billingCycle: '', trialDays: 0, isActive: false, features: {}, limits: {} };

        // ── Timing — mirrors approvePlanChangeRequest exactly ──────────
        // (it compares against the LIVE catalog price of the current plan).
        const currentCatalogPrice = currentPlanDoc?.price ?? 0;
        const requestedPrice = requestedPlanDoc?.price ?? request.requestedPlanPrice ?? 0;
        const isScheduledDowngrade = request.requestSource === 'tenant'
            && currentCatalogPrice > 0
            && requestedPrice < currentCatalogPrice;
        const direction = requestedPrice > currentCatalogPrice ? 'upgrade'
            : requestedPrice < currentCatalogPrice ? 'downgrade' : 'same';
        let timing;
        if (isScheduledDowngrade) {
            const effectiveAt = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
            timing = {
                mode: 'cycle_end',
                effectiveAt,
                explanation: effectiveAt
                    ? `Tenant-requested downgrade: the switch is scheduled for the end of the current billing cycle (${effectiveAt.toISOString().slice(0, 10)}). The Razorpay subscription is cancelled at cycle end — no refund, no proration.`
                    : 'Tenant-requested downgrade: the switch is scheduled for the end of the current billing cycle. No cycle end is on record, so it will take effect 30 days after approval.',
            };
        } else {
            const trialDays = requestedPlanDoc?.trialDays || 0;
            timing = {
                mode: 'immediate',
                effectiveAt: null,
                explanation: trialDays > 0
                    ? `The new plan applies immediately on approval and starts a ${trialDays}-day trial.`
                    : 'The new plan applies immediately on approval. The Razorpay subscription is not touched — your offline payment is the source of truth.',
            };
        }

        // ── Comparison ────────────────────────────────────────────────
        const curF = currentPlan?.features || {};
        const reqF = requestedPlan.features || {};
        const featureKeys = [...new Set([...Object.keys(curF), ...Object.keys(reqF)])].filter((k) => k !== '_id');
        const featuresAdded = [];
        const featuresRemoved = [];
        const featureChanges = [];
        const on = (v) => v === true || (typeof v === 'string' && v !== 'none' && v !== '');
        for (const k of featureKeys) {
            const a = curF[k];
            const b = reqF[k];
            if (typeof a === 'string' || typeof b === 'string') {
                if ((a || 'none') !== (b || 'none')) featureChanges.push({ key: k, from: a || 'none', to: b || 'none' });
                continue;
            }
            if (!on(a) && on(b)) featuresAdded.push(k);
            else if (on(a) && !on(b)) featuresRemoved.push(k);
        }
        const curL = currentPlan?.limits || {};
        const reqL = requestedPlan.limits || {};
        const limitChanges = APPROVAL_LIMIT_KEYS
            .filter((k) => curL[k] !== undefined || reqL[k] !== undefined)
            .map((k) => {
                const from = typeof curL[k] === 'number' ? curL[k] : null;
                const to = typeof reqL[k] === 'number' ? reqL[k] : null;
                let change = 'same';
                if (from !== to) change = (from ?? 0) < (to ?? 0) ? 'increase' : 'decrease';
                return { key: k, label: LIMIT_LABELS[k] || k, from, to, change };
            });

        // ── Usage (explicit tenant filters) ───────────────────────────
        let usage = { branches: 0, tables: 0, staff: 0, menuItems: 0 };
        if (restaurant) {
            const rid = restaurant._id;
            const [branches, tables, staff, menuItems] = await Promise.all([
                Branch.countDocuments({ restaurant: rid, isActive: true }),
                Table.countDocuments({ restaurant: rid, isDeleted: { $ne: true } }),
                User.countDocuments({ restaurant: rid, role: { $in: STAFF_ROLES }, status: 'active' }),
                MenuItem.countDocuments({ restaurant: rid }),
            ]);
            usage = { branches, tables, staff, menuItems };
        }
        const USAGE_LIMIT = { branches: 'maxBranches', tables: 'maxTables', staff: 'maxStaff', menuItems: 'maxMenuItems' };
        const limitViolations = [];
        for (const [usageKey, limitKey] of Object.entries(USAGE_LIMIT)) {
            const limit = reqL[limitKey];
            const used = usage[usageKey];
            // 0 / missing = not capped by the plan.
            if (typeof limit === 'number' && limit > 0 && used > limit) {
                const label = LIMIT_LABELS[limitKey];
                limitViolations.push({
                    key: limitKey, label, used, limit,
                    message: `${label}: ${used} in use, new plan allows ${limit}`,
                });
            }
        }

        const warnings = [];
        if (!restaurant) warnings.push('The tenant no longer exists.');
        if (!requestedPlanDoc || requestedPlanDoc.isActive === false) {
            warnings.push('The requested plan is no longer available — approval will fail. Reject this request and create a new one.');
        }

        const activity = restaurant ? await restaurantActivity(restaurant._id) : [];

        return res.status(200).json({
            success: true,
            data: {
                request: {
                    _id: request._id,
                    status: request.status,
                    createdAt: request.createdAt,
                    note: request.note || '',
                    requestSource: request.requestSource || 'operator',
                    requestedByEmail: request.requestedByEmail || '',
                    reviewedAt: request.reviewedAt || null,
                    reviewedByEmail: request.reviewedByEmail || '',
                    rejectedReason: request.rejectedReason || '',
                    direction,
                    timing,
                },
                restaurant: restaurant ? {
                    _id: restaurant._id,
                    name: restaurant.name,
                    slug: restaurant.slug,
                    status: restaurant.status,
                    contactEmail: restaurant.contactEmail || '',
                    contactPhone: restaurant.contactPhone || '',
                    subscriptionStatus: sub.status || '',
                    currentPeriodEnd: sub.currentPeriodEnd || null,
                } : null,
                currentPlan,
                requestedPlan,
                comparison: { featuresAdded, featuresRemoved, featureChanges, limitChanges },
                usage,
                limitViolations,
                warnings,
                activity,
            },
        });
    } catch (err) {
        logger.error('getPlanChangeDetail error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load plan change request' });
    }
};

// GET /api/v1/superadmin/approvals/payments/:id
exports.getPaymentApprovalDetail = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const r = await Restaurant.findById(id).lean();
        if (!r) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        const sub = r.subscription || {};

        const [planDoc, invoices, activity] = await Promise.all([
            sub.plan ? SubscriptionPlan.findById(sub.plan).select('name price currency billingCycle').lean() : null,
            SubscriptionInvoice.find({ restaurant: r._id })
                .sort({ createdAt: -1 })
                .limit(DETAIL_LIST_CAP)
                .select('invoiceNumber planName amount currency status paidAt createdAt')
                .lean(),
            restaurantActivity(r._id),
        ]);

        const catalogPrice = planDoc?.price ?? null;
        // Agreed (snapshot) price first; live catalog price as the legacy fallback.
        const amountDue = typeof sub.price === 'number' ? sub.price : (catalogPrice ?? 0);

        return res.status(200).json({
            success: true,
            data: {
                restaurant: {
                    _id: r._id,
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    contactEmail: r.contactEmail || '',
                    contactPhone: r.contactPhone || '',
                    status: r.status,
                    suspendedReason: r.suspendedReason || '',
                    paymentStatus: r.paymentStatus || 'na',
                    paymentNote: r.paymentNote || '',
                    paymentMethod: r.paymentMethod || '',
                    paymentConfirmedAt: r.paymentConfirmedAt || null,
                    subscriptionStatus: sub.status || '',
                    trialEndDate: sub.trialEndDate || null,
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                },
                plan: {
                    _id: sub.plan || null,
                    name: sub.planName || planDoc?.name || '',
                    price: catalogPrice,
                    agreedPrice: typeof sub.price === 'number' ? sub.price : null,
                    currency: planDoc?.currency || 'INR',
                    billingCycle: planDoc?.billingCycle || 'monthly',
                },
                amountDue,
                // Recent subscription invoices (Razorpay charges; amounts in paise).
                invoices: invoices.map((i) => ({
                    _id: i._id,
                    number: i.invoiceNumber,
                    planName: i.planName || '',
                    amount: i.amount,
                    currency: i.currency || 'INR',
                    status: i.status,
                    date: i.paidAt || i.createdAt,
                    method: 'razorpay',
                })),
                activity,
            },
        });
    } catch (err) {
        logger.error('getPaymentApprovalDetail error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load payment details' });
    }
};

// ═══════════════ MARKETING LEADS ════════════════════════════════════════
// Leads captured by the standalone marketing site (BestoDine-Marketing) via
// POST /api/v1/public/lead. They are GLOBAL / tenant-agnostic — a prospect
// has not picked a tenant yet — so these queries carry no tenant filter by
// design (see models/lead.js). The Super Admin reviews, contacts and finally
// converts a lead into a real Restaurant.

const LEAD_STATUSES = ['new', 'contacted', 'demoed', 'converted', 'lost'];

// GET /api/v1/superadmin/leads?status=&search=&page=&limit=
exports.listLeads = async (req, res) => {
    try {
        const { status, search } = req.query;
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const filter = {};
        if (status && LEAD_STATUSES.includes(status)) filter.status = status;
        if (search && search.trim()) {
            const esc = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(esc, 'i');
            filter.$or = [{ name: rx }, { restaurantName: rx }, { phone: rx }, { email: rx }];
        }

        const [leads, total, statusAgg] = await Promise.all([
            // AUDIT-EXEMPT: global pre-tenant lead — no restaurant scope by design.
            Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Lead.countDocuments(filter),
            Lead.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        ]);

        // Per-status counts for filter chips + the "new" nav badge.
        const counts = { all: 0, new: 0, contacted: 0, demoed: 0, converted: 0, lost: 0 };
        for (const row of statusAgg) {
            if (counts[row._id] !== undefined) counts[row._id] = row.n;
            counts.all += row.n;
        }

        return res.status(200).json({
            success: true,
            data: {
                leads,
                counts,
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
            },
        });
    } catch (err) {
        logger.error('listLeads error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load leads' });
    }
};

// GET /api/v1/superadmin/leads/:id
exports.getLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findById(id)
            .populate({ path: 'notes.createdBy', select: 'name email' })
            .populate({ path: 'convertedToRestaurant', select: 'name slug status' })
            .lean();
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
        return res.status(200).json({ success: true, data: lead });
    } catch (err) {
        logger.error('getLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load lead' });
    }
};

// PATCH /api/v1/superadmin/leads/:id   { status?, note?, convertedToRestaurant? }
// One endpoint handles status transitions, appending a note, and linking a
// converted restaurant. The frontend "Convert" button creates the Restaurant
// via the existing create flow, then PATCHes the lead with
// { status: 'converted', convertedToRestaurant: <newId> }.
exports.updateLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findById(id);
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        const { status, note, convertedToRestaurant } = req.body || {};
        const changed = {};

        if (status !== undefined) {
            if (!LEAD_STATUSES.includes(status)) {
                return res.status(400).json({ success: false, message: 'Invalid status' });
            }
            changed.status = { from: lead.status, to: status };
            lead.status = status;
            if (status === 'converted' && !lead.convertedAt) lead.convertedAt = new Date();
        }

        if (convertedToRestaurant !== undefined) {
            if (convertedToRestaurant && !mongoose.isValidObjectId(convertedToRestaurant)) {
                return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
            }
            lead.convertedToRestaurant = convertedToRestaurant || undefined;
            if (convertedToRestaurant && lead.status !== 'converted') {
                lead.status = 'converted';
                lead.convertedAt = new Date();
                changed.status = { from: changed.status?.from ?? lead.status, to: 'converted' };
            }
        }

        if (note !== undefined && String(note).trim()) {
            lead.notes.push({ text: String(note).trim().slice(0, 1000), createdBy: req.user._id });
            changed.noteAdded = true;
        }

        if (Object.keys(changed).length === 0) {
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        await lead.save();

        await recordAudit(req, {
            action: 'lead.update',
            targetType: '',
            targetId: lead._id,
            targetName: lead.restaurantName,
            details: changed,
        });

        return res.status(200).json({ success: true, data: lead });
    } catch (err) {
        logger.error('updateLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update lead' });
    }
};

// DELETE /api/v1/superadmin/leads/:id  — spam cleanup (full superadmins only)
exports.deleteLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findByIdAndDelete(id);
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        await recordAudit(req, {
            action: 'lead.delete',
            targetType: '',
            targetId: lead._id,
            targetName: lead.restaurantName,
            details: { phone: lead.phone, source: lead.source },
        });

        return res.status(200).json({ success: true, message: 'Lead deleted' });
    } catch (err) {
        logger.error('deleteLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete lead' });
    }
};

// ═══════════════ MARKETING SITE CONTENT ═════════════════════════════════
// Editable content for the standalone marketing site (BestoDine-Marketing).
// Platform-global singleton — NOT tenant scoped. Only text/link fields are
// editable here; marketing images stay as static assets in that project.

// GET /api/v1/superadmin/marketing
exports.getMarketingSettings = async (_req, res) => {
    try {
        // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
        const settings = await MarketingSetting.getSingleton();
        return res.status(200).json({ success: true, data: settings });
    } catch (err) {
        logger.error('getMarketingSettings error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load marketing settings' });
    }
};

// PUT /api/v1/superadmin/marketing
exports.updateMarketingSettings = async (req, res) => {
    try {
        // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
        const settings = await MarketingSetting.getSingleton();

        // Track field-level changes so the audit log records *what* the Super
        // Admin actually edited (old → new), not just the brand name.
        const changes = {};
        // Short values render inline in the audit diff; long ones (hero copy,
        // URLs) are truncated so the payload stays readable.
        const previewVal = (v) => {
            const s = String(v ?? '');
            return s.length > 120 ? s.slice(0, 117) + '…' : s;
        };
        const noteChange = (field, oldVal, newVal) => {
            if (String(oldVal ?? '') === String(newVal ?? '')) return;
            changes[field] = { from: previewVal(oldVal), to: previewVal(newVal) };
        };

        const STR_FIELDS = [
            'brandName', 'tagline', 'logoUrl', 'demoVideoUrl',
            'heroHeadline', 'heroSubtitle',
            'supportPhone', 'supportEmail', 'whatsappNumber', 'address',
        ];
        for (const f of STR_FIELDS) {
            if (req.body[f] !== undefined) {
                const next = String(req.body[f]).trim();
                noteChange(f, settings[f], next);
                settings[f] = next;
            }
        }

        if (req.body.social && typeof req.body.social === 'object') {
            settings.social = settings.social || {};
            for (const k of ['instagram', 'facebook', 'linkedin', 'youtube', 'twitter']) {
                if (req.body.social[k] !== undefined) {
                    const next = String(req.body.social[k]).trim();
                    noteChange(`social.${k}`, settings.social[k], next);
                    settings.social[k] = next;
                }
            }
        }

        // Platform screenshots — keep only rows with an image URL, cap at 8.
        if (Array.isArray(req.body.platformShots)) {
            const prevCount = Array.isArray(settings.platformShots) ? settings.platformShots.length : 0;
            settings.platformShots = req.body.platformShots
                .filter(s => s && typeof s === 'object' && String(s.url || '').trim())
                .slice(0, 8)
                .map(s => ({
                    url:   String(s.url   || '').trim().slice(0, 500),
                    title: String(s.title || '').trim().slice(0, 80),
                    desc:  String(s.desc  || '').trim().slice(0, 200),
                }));
            if (prevCount !== settings.platformShots.length) {
                changes.platformShots = { from: `${prevCount} screenshot(s)`, to: `${settings.platformShots.length} screenshot(s)` };
            }
        }

        settings.updatedBy = req.user._id;
        await settings.save();

        const changedFields = Object.keys(changes);
        await recordAudit(req, {
            action: 'marketing.update',
            targetType: 'platform',
            targetName: 'Marketing site content',
            details: {
                brandName: settings.brandName,
                changedFields,
                ...(changedFields.length ? { changes } : { note: 'Saved with no field changes' }),
            },
        });

        return res.status(200).json({ success: true, data: settings, message: 'Marketing content updated' });
    } catch (err) {
        logger.error('updateMarketingSettings error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update marketing settings' });
    }
};

// POST /api/v1/superadmin/marketing/logo  (multipart field: image)
// Uploads a logo image to Cloudinary and returns its URL. The client then
// saves it as logoUrl via the normal PUT /marketing — so the field accepts
// either a pasted URL or an uploaded file.
exports.uploadMarketingLogo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an image file' });
        }
        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/marketing',
            maxWidth:     600,
        });
        return res.status(200).json({ success: true, url: result.secure_url, message: 'Logo uploaded' });
    } catch (err) {
        logger.error('uploadMarketingLogo error: ' + err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to upload logo' });
    }
};

// POST /api/v1/superadmin/marketing/screenshot  (multipart field: image)
// Uploads a "platform screenshot" to Cloudinary and returns its URL. Same flow
// as the logo upload but kept wider (1280px) since these render large in the
// "A LOOK INSIDE THE PLATFORM" grid. The client saves the URL into one
// platformShots row, then persists via the normal PUT /marketing.
exports.uploadMarketingScreenshot = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an image file' });
        }
        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/marketing',
            maxWidth:     1280,
        });
        return res.status(200).json({ success: true, url: result.secure_url, message: 'Screenshot uploaded' });
    } catch (err) {
        logger.error('uploadMarketingScreenshot error: ' + err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to upload screenshot' });
    }
};

// ═══════════════ SUBSCRIPTION PAYMENTS ══════════════════════════════════
// Platform billing ledger (tenant → BestoDine). One row per successful
// Razorpay subscription charge, written by the razorpay webhook handler.
// Read-only, platform-wide (all tenants) — this is the Super Admin's
// "all subscription payments" view.
//
// GET /api/v1/superadmin/subscription-payments
//   ?status=all|paid|refunded|partially_refunded
//   ?search=<restaurant | invoice no | plan | razorpay id>
//   ?page=&limit=
exports.listSubscriptionPayments = async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        // Date-range filter (by charge date). Applies to BOTH the table and
        // the revenue summary so "total revenue" reflects the chosen period.
        const dateFilter = {};
        if (req.query.from) {
            const d = new Date(req.query.from);
            if (!isNaN(d.getTime())) dateFilter.$gte = d;
        }
        if (req.query.to) {
            const d = new Date(req.query.to);
            if (!isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); dateFilter.$lte = d; }
        }
        const hasDate = Object.keys(dateFilter).length > 0;

        const filter = {};
        if (hasDate) filter.createdAt = dateFilter;
        if (req.query.status && req.query.status !== 'all') {
            filter.status = req.query.status;
        }
        if (req.query.search && req.query.search.trim()) {
            const safe = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(safe, 'i');
            filter.$or = [
                { restaurantName: rx },
                { invoiceNumber: rx },
                { planName: rx },
                { razorpayPaymentId: rx },
                { razorpaySubscriptionId: rx },
            ];
        }

        // Summary respects the date range only (not status/search) so the
        // cards show the full paid/refunded breakdown for the period.
        const summaryMatch = hasDate ? { createdAt: dateFilter } : {};

        // AUDIT-EXEMPT: platform-wide billing ledger — SubscriptionInvoice is a
        // platform (tenant→BestoDine) record; the Super Admin sees all tenants.
        const [items, total, summaryAgg] = await Promise.all([
            SubscriptionInvoice.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            SubscriptionInvoice.countDocuments(filter),
            // Totals for the cards — scoped to the selected date range.
            SubscriptionInvoice.aggregate([
                { $match: summaryMatch },
                { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
            ]),
        ]);

        const summary = {
            totalCount: 0, paidCount: 0, refundedCount: 0,
            grossAmount: 0, refundedAmount: 0, currency: 'INR',
        };
        for (const g of summaryAgg) {
            summary.totalCount += g.count;
            if (g._id === 'paid') {
                summary.paidCount += g.count;
                summary.grossAmount += g.amount;
            } else if (g._id === 'partially_refunded') {
                summary.paidCount += g.count;
                summary.grossAmount += g.amount;
                summary.refundedCount += g.count;
            } else if (g._id === 'refunded') {
                summary.refundedCount += g.count;
                summary.refundedAmount += g.amount;
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                payments: items.map(i => ({
                    _id: i._id,
                    restaurant: i.restaurant,
                    restaurantName: i.restaurantName,
                    invoiceNumber: i.invoiceNumber,
                    planName: i.planName,
                    planSlug: i.planSlug,
                    amount: i.amount,
                    currency: i.currency,
                    status: i.status,
                    periodStart: i.periodStart,
                    periodEnd: i.periodEnd,
                    paidAt: i.paidAt,
                    createdAt: i.createdAt,
                    razorpayPaymentId: i.razorpayPaymentId,
                    razorpaySubscriptionId: i.razorpaySubscriptionId,
                })),
                summary,
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
            },
        });
    } catch (err) {
        logger.error('listSubscriptionPayments error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load subscription payments' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// Module management — push plan edits to tenants, paid add-ons
// ═══════════════════════════════════════════════════════════════════════

const { ADDON_CATALOG, TIERED_KEYS, isAddonActive } = require('../utils/featureAccess');

function planSnapshotParts(plan) {
    const snap = snapshotPlan(plan);
    return { features: snap.features, limits: snap.limits };
}

// Stable JSON for comparing snapshots regardless of key order.
function stableJson(obj) {
    if (!obj || typeof obj !== 'object') return JSON.stringify(obj ?? null);
    return JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {}));
}

// GET /api/v1/superadmin/plans/:id/tenant-impact
// How many restaurants are on this plan and how many of them still carry
// an older copy of its modules/limits (i.e. would change on a push).
exports.getPlanTenantImpact = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const { features, limits } = planSnapshotParts(plan);
        const wantF = stableJson(features);
        const wantL = stableJson(limits);
        const tenants = await Restaurant.find({ 'subscription.plan': plan._id })
            .select('name slug subscription.features subscription.limits')
            .lean();
        const outOfSync = tenants.filter(t =>
            stableJson(t.subscription?.features || {}) !== wantF
            || stableJson(t.subscription?.limits || {}) !== wantL);

        const [pendingUpgrades, scheduledDowngrades] = await Promise.all([
            Restaurant.countDocuments({ 'subscription.pendingUpgrade.plan': plan._id }),
            Restaurant.countDocuments({ 'subscription.scheduledDowngrade.plan': plan._id }),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                planId: plan._id,
                planName: plan.name,
                assignedCount: tenants.length,
                outOfSyncCount: outOfSync.length,
                outOfSync: outOfSync.slice(0, 50).map(t => ({ _id: t._id, name: t.name, slug: t.slug })),
                pendingUpgrades,
                scheduledDowngrades,
            },
        });
    } catch (err) {
        logger.error('getPlanTenantImpact error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load plan impact' });
    }
};

// POST /api/v1/superadmin/plans/:id/push   Body: { confirm: true }
//
// Copies the plan's CURRENT modules and limits onto every restaurant
// assigned to it (plus any pending upgrade / scheduled downgrade that
// targets it). Editing a plan never does this on its own — tenants keep
// the snapshot they signed up with until the Super Admin pushes.
//
// The agreed price is deliberately NOT touched (price protection), and
// per-tenant featureOverrides / add-ons keep winning over the plan.
exports.pushPlanToTenants = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        if (req.body?.confirm !== true) {
            return res.status(400).json({
                success: false,
                code: 'CONFIRM_REQUIRED',
                message: 'Send { "confirm": true } to push this plan to its restaurants.',
            });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const { features, limits } = planSnapshotParts(plan);

        const [live, pending, scheduled] = await Promise.all([
            Restaurant.updateMany(
                { 'subscription.plan': plan._id },
                { $set: {
                    'subscription.features': features,
                    'subscription.limits': limits,
                    'subscription.planName': plan.name,
                } },
            ),
            Restaurant.updateMany(
                { 'subscription.pendingUpgrade.plan': plan._id },
                { $set: {
                    'subscription.pendingUpgrade.features': features,
                    'subscription.pendingUpgrade.limits': limits,
                    'subscription.pendingUpgrade.planName': plan.name,
                } },
            ),
            Restaurant.updateMany(
                { 'subscription.scheduledDowngrade.plan': plan._id },
                { $set: {
                    'subscription.scheduledDowngrade.features': features,
                    'subscription.scheduledDowngrade.limits': limits,
                    'subscription.scheduledDowngrade.planName': plan.name,
                } },
            ),
        ]);

        const result = {
            matched: live.matchedCount,
            updated: live.modifiedCount,
            pendingUpgradesUpdated: pending.modifiedCount,
            scheduledDowngradesUpdated: scheduled.modifiedCount,
        };

        await recordAudit(req, {
            action: 'plan.push',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, ...result },
        });

        return res.status(200).json({ success: true, data: result });
    } catch (err) {
        logger.error('pushPlanToTenants error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to push plan to restaurants' });
    }
};

// GET /api/v1/superadmin/addon-catalog
exports.getAddonCatalog = (_req, res) => {
    const catalog = Object.entries(ADDON_CATALOG).map(([key, v]) => ({ key, ...v }));
    return res.status(200).json({ success: true, data: catalog });
};

// POST /api/v1/superadmin/restaurants/:id/addons
// Body: { key, price?, endDate?, note? }
exports.addRestaurantAddon = async (req, res) => {
    try {
        const { id } = req.params;
        const { key, note } = req.body || {};
        if (!SubscriptionPlan.FEATURE_KEYS.includes(key) || TIERED_KEYS.has(key)) {
            return res.status(400).json({ success: false, message: `"${key}" is not a module that can be sold as an add-on.` });
        }
        let price = req.body?.price;
        if (price === undefined || price === null || price === '') price = ADDON_CATALOG[key]?.monthlyPrice ?? 0;
        price = Number(price);
        if (!Number.isFinite(price) || price < 0) {
            return res.status(400).json({ success: false, message: 'Price must be a number of 0 or more.' });
        }
        let endDate = null;
        if (req.body?.endDate) {
            endDate = new Date(req.body.endDate);
            if (Number.isNaN(endDate.getTime()) || endDate <= new Date()) {
                return res.status(400).json({ success: false, message: 'End date must be a valid future date.' });
            }
        }

        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

        if ((restaurant.addons || []).some(a => a.key === key && isAddonActive(a))) {
            return res.status(409).json({ success: false, code: 'ADDON_EXISTS', message: 'This add-on is already active for the restaurant.' });
        }

        restaurant.addons.push({
            key,
            price,
            status: 'active',
            startDate: new Date(),
            endDate: endDate || undefined,
            note: typeof note === 'string' ? note.slice(0, 300) : '',
            addedBy: req.user?.email || '',
        });
        await restaurant.save();
        const added = restaurant.addons[restaurant.addons.length - 1];

        await recordAudit(req, {
            action: 'restaurant.addon.add',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { key, price, endDate },
        });

        return res.status(201).json({ success: true, data: { addon: added, addons: restaurant.addons } });
    } catch (err) {
        logger.error('addRestaurantAddon error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to add add-on' });
    }
};

// DELETE /api/v1/superadmin/restaurants/:id/addons/:addonId
// Cancels (not deletes) so the history stays for billing questions.
exports.cancelRestaurantAddon = async (req, res) => {
    try {
        const { id, addonId } = req.params;
        if (!mongoose.isValidObjectId(addonId)) {
            return res.status(400).json({ success: false, message: 'Invalid add-on id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        const addon = restaurant.addons.id(addonId);
        if (!addon) return res.status(404).json({ success: false, message: 'Add-on not found' });
        if (addon.status === 'cancelled') {
            return res.status(200).json({ success: true, data: { addon, addons: restaurant.addons } });
        }
        addon.status = 'cancelled';
        addon.cancelledAt = new Date();
        addon.cancelledBy = req.user?.email || '';
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.addon.cancel',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { key: addon.key, price: addon.price },
        });

        return res.status(200).json({ success: true, data: { addon, addons: restaurant.addons } });
    } catch (err) {
        logger.error('cancelRestaurantAddon error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel add-on' });
    }
};
