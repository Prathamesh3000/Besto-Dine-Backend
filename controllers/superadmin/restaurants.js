// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const User = require('../../models/user');
const Order = require('../../models/order');
const MenuItem = require('../../models/menuItem');
const Table = require('../../models/table');
const Branch = require('../../models/branch');
const PlanChangeRequest = require('../../models/planChangeRequest');
const SubscriptionInvoice = require('../../models/subscriptionInvoice');
const { recordAudit } = require('../../utils/audit');
const { sendEmail } = require('../../utils/email');
const {
    restaurantWelcome,
    restaurantSuspended,
    restaurantReactivated,
} = require('../../utils/emailTemplates');
const logger = require('../../utils/logger');
const { invalidateTenant } = require('../../middlewares/tenantContext');
const {
    PINCODE_REGEX,
    FSSAI_REGEX,
    GSTIN_REGEX,
    PAN_REGEX,
    generateTempPassword,
    ADDON_MRR_EXPR,
    buildRestaurantPayload,
} = require('./_shared');

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
