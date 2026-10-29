// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const Restaurant = require('../../models/restaurant');
const Order = require('../../models/order');
const Branch = require('../../models/branch');
const PlanChangeRequest = require('../../models/planChangeRequest');
const AuditLog = require('../../models/auditLog');
const logger = require('../../utils/logger');
const { ADDON_MRR_EXPR } = require('./_shared');

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
