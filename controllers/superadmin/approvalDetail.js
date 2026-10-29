// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const User = require('../../models/user');
const MenuItem = require('../../models/menuItem');
const Table = require('../../models/table');
const Branch = require('../../models/branch');
const PlanChangeRequest = require('../../models/planChangeRequest');
const Lead = require('../../models/lead');
const AuditLog = require('../../models/auditLog');
const SubscriptionInvoice = require('../../models/subscriptionInvoice');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');
const { normalizeMobile } = require('../../utils/mobile');

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
