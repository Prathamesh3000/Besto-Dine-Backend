/**
 * Tenant self-service billing (Phase 5 step 4).
 *
 * Endpoints for an authenticated tenant admin to see their current
 * subscription and upgrade to a different plan on their own — without
 * a Super Admin touching the system. Mirrors the Super Admin
 * assignPlan flow but with a reduced attack surface:
 *
 *   - Auth: protect + role must be 'admin' (tenant owner). Captains
 *     and waiters can't change the plan even if they somehow land on
 *     this endpoint.
 *   - Tenant id comes from req.user.restaurant, NEVER req.params.
 *     A tenant admin can only touch their OWN tenant.
 *   - Trial days are not user-controllable. The tenant already had
 *     their initial trial during signup — self-service upgrades
 *     start billing immediately (or via the Razorpay authorization
 *     flow for paid plans).
 *   - Same-plan re-assignment is rejected (400) so a confused user
 *     can't accidentally cancel their active subscription by
 *     "upgrading" to the plan they're already on.
 *   - Price-0 "downgrade to free" is rejected from this endpoint —
 *     that's a cancellation flow, not an upgrade. Keeps scope tight.
 *
 * When the user completes the Razorpay authorization on the
 * short_url, the existing subscription.authenticated /
 * subscription.charged webhooks (Phase 2) will update the tenant
 * status automatically. No extra plumbing needed.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const User = require('../models/user');
const AuditLog = require('../models/auditLog');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const PlanChangeRequest = require('../models/planChangeRequest');
const logger = require('../utils/logger');
const { isAddonActive } = require('../utils/featureAccess');
const {
    isBillingConfigured,
    ensureRazorpayPlan,
    ensureRazorpayCustomer,
    createRazorpaySubscription,
    cancelRazorpaySubscription,
    fetchRazorpaySubscription,
    listSubscriptionInvoices,
    fetchRazorpayPayment,
} = require('../utils/razorpayBilling');
const { applyPaidPlanUpgrade, applyScheduledDowngrade } = require('../utils/planPaymentApply');
const { streamInvoicePdf } = require('../utils/invoicePdf');

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function buildPlanCard(plan) {
    if (!plan) return null;
    return {
        _id: plan._id,
        name: plan.name,
        slug: plan.slug,
        description: plan.description || '',
        price: plan.price,
        billingCycle: plan.billingCycle,
        features: plan.features || {},
        limits: plan.limits || {},
        sortOrder: plan.sortOrder || 0,
    };
}

/**
 * GET /api/v1/tenant/billing/current
 *
 * Snapshot of the tenant's current subscription. Returned fields
 * mirror what RestaurantDetail shows on the Super Admin side, minus
 * anything that belongs to the platform (audit log, system notes).
 */
exports.getCurrentSubscription = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }

        // Lazy-apply scheduled downgrades whose effective time has
        // passed. Belt-and-braces against the case where the
        // subscription.completed webhook never reached us (fallback
        // Orders path has no recurring sub at all, so no completion
        // event will ever fire). Loads the writable doc only when
        // there's actually work to do.
        const sched = await Restaurant.findById(req.restaurant._id)
            .select('subscription.scheduledDowngrade slug')
            .lean();
        if (sched?.subscription?.scheduledDowngrade?.effectiveAt
            && new Date(sched.subscription.scheduledDowngrade.effectiveAt) <= new Date()) {
            const writable = await Restaurant.findById(req.restaurant._id);
            const result = applyScheduledDowngrade(writable, { force: true });
            if (result.applied) {
                await writable.save();
                logger.info(`Lazy-applied scheduled downgrade for ${writable.slug} → ${writable.subscription.planName}`);
            }
        }

        const restaurant = await Restaurant.findById(req.restaurant._id).lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const sub = restaurant.subscription || {};
        const pending = sub.pendingUpgrade || null;
        const scheduled = sub.scheduledDowngrade?.planSlug ? sub.scheduledDowngrade : null;
        return res.status(200).json({
            success: true,
            data: {
                restaurant: {
                    _id: restaurant._id,
                    name: restaurant.name,
                    slug: restaurant.slug,
                    status: restaurant.status,
                },
                subscription: {
                    planName: sub.planName || '',
                    planSlug: sub.planSlug || '',
                    status: sub.status || '',
                    startDate: sub.startDate || null,
                    trialEndDate: sub.trialEndDate || null,
                    currentPeriodEnd: sub.currentPeriodEnd || null,
                    lastChargedAt: sub.lastChargedAt || null,
                    razorpayStatus: sub.razorpayStatus || '',
                    // Decision 5 (2026-10): when a halted subscription will
                    // be suspended if it is still unpaid (null = not scheduled).
                    scheduledSuspendAt: sub.scheduledSuspendAt || null,
                    razorpaySubscriptionId: sub.razorpaySubscriptionId || '',
                    shortUrl: sub.shortUrl || '',
                    features: sub.features || {},
                    limits: sub.limits || {},
                },
                // Paid add-ons in force (modules bought on top of the plan).
                addons: (restaurant.addons || [])
                    .filter(a => isAddonActive(a))
                    .map(a => ({
                        _id: a._id,
                        key: a.key,
                        price: a.price || 0,
                        startDate: a.startDate || null,
                        endDate: a.endDate || null,
                    })),
                // ADM-105 — surface pending upgrade so the UI can
                // render "Plan X (upgrading to Y — finish payment)".
                // Null when no upgrade is in flight.
                pendingUpgrade: pending && pending.planSlug
                    ? {
                        planName: pending.planName || '',
                        planSlug: pending.planSlug || '',
                        shortUrl: pending.shortUrl || '',
                        razorpaySubscriptionId: pending.razorpaySubscriptionId || '',
                        razorpayOrderId: pending.razorpayOrderId || '',
                        fallbackOrder: !!pending.fallbackOrder,
                        createdAt: pending.createdAt || null,
                    }
                    : null,
                // ADM-106 follow-up — surface any pending downgrade
                // request the tenant has filed so the page can show
                // its status (and lock further upgrade clicks). Only
                // one pending request per tenant is allowed at a time.
                downgradeRequest: await loadActiveDowngradeRequest(restaurant._id),
                // Approved + scheduled downgrade — applies at cycle
                // end. Tenant keeps current features until then.
                scheduledDowngrade: scheduled
                    ? {
                        planName: scheduled.planName || '',
                        planSlug: scheduled.planSlug || '',
                        fromPlanName: scheduled.fromPlanName || '',
                        effectiveAt: scheduled.effectiveAt || null,
                        scheduledAt: scheduled.scheduledAt || null,
                    }
                    : null,
            },
        });
    } catch (err) {
        logger.error('tenantBilling.getCurrentSubscription error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load subscription' });
    }
};

// Shared shape for surfacing the tenant's pending downgrade request
// — used by both getCurrentSubscription and the request endpoints
// below so the UI sees the same fields no matter which call returned
// the record.
function buildRequestPayload(request) {
    if (!request) return null;
    return {
        _id: request._id,
        status: request.status,
        currentPlanName: request.currentPlanName || '',
        requestedPlanName: request.requestedPlanName || '',
        requestedPlanPrice: request.requestedPlanPrice || 0,
        reason: request.note || '',
        rejectedReason: request.rejectedReason || '',
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt || null,
        reviewedByEmail: request.reviewedByEmail || '',
    };
}

async function loadActiveDowngradeRequest(restaurantId) {
    const doc = await PlanChangeRequest.findOne({
        restaurant: restaurantId,
        requestSource: 'tenant',
        status: 'pending',
    }).sort({ createdAt: -1 }).lean();
    return buildRequestPayload(doc);
}

/**
 * GET /api/v1/tenant/billing/plans
 *
 * Plans the tenant is allowed to upgrade to. Excludes the current
 * plan so the UI never shows a "select this" button next to the one
 * they're already on. Excludes archived plans. Returns sorted by
 * the plan's sortOrder (then by price).
 */
exports.getAvailablePlans = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const currentSlug = req.restaurant.subscription?.planSlug || '';
        // Private (bespoke) plans never appear in the tenant upgrade catalog.
        // `$ne: false` keeps legacy plans (no isPublic field) visible.
        const plans = await SubscriptionPlan.find({ isActive: true, isPublic: { $ne: false } })
            .sort({ sortOrder: 1, price: 1 })
            .lean();

        return res.status(200).json({
            success: true,
            data: {
                currentPlanSlug: currentSlug,
                plans: plans.map(buildPlanCard),
            },
        });
    } catch (err) {
        logger.error('tenantBilling.getAvailablePlans error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load plans' });
    }
};

/**
 * POST /api/v1/tenant/billing/upgrade
 * Body: { planId }
 *
 * Starts a plan upgrade for the caller's own tenant. Creates a
 * Razorpay subscription and returns the short_url the owner must
 * visit to authorize the recurring payment. Status updates arrive
 * later via the Phase 2 webhook handler — this endpoint only kicks
 * off the flow.
 */
exports.upgradePlan = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const { planId } = req.body || {};
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }

        // Reload the tenant fresh — req.restaurant is a snapshot from
        // the middleware, and we're about to mutate it.
        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(req.restaurant._id),
            SubscriptionPlan.findById(planId),
        ]);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // ── Reject nonsense transitions ─────────────────────────────
        const currentSlug = restaurant.subscription?.planSlug || '';
        if (plan.slug === currentSlug) {
            return res.status(400).json({
                success: false,
                code: 'SAME_PLAN',
                message: `You're already on the ${plan.name} plan.`,
            });
        }
        if (plan.price <= 0) {
            return res.status(400).json({
                success: false,
                code: 'DOWNGRADE_NOT_SUPPORTED',
                message: 'Self-service downgrade to a free plan is not supported. Contact support to cancel your subscription.',
            });
        }

        // Block paid-to-cheaper-paid downgrades too. Allowing them would
        // create a second Razorpay subscription alongside the still-active
        // higher-tier one — double-charging the tenant until somebody
        // notices. Cancelling the old subscription cleanly (with
        // proration / refunds) is a human-judgment problem; route the
        // user to support instead. ADM-106 follow-up.
        const currentPlanId = restaurant.subscription?.plan;
        if (currentPlanId) {
            const currentPlanDoc = await SubscriptionPlan.findById(currentPlanId).select('name price');
            // Judge against what the tenant actually pays (snapshot),
            // not the possibly-edited catalogue price.
            const snapPrice = restaurant.subscription?.price;
            const currentPrice = typeof snapPrice === 'number' ? snapPrice : (currentPlanDoc?.price ?? 0);
            if (currentPrice > 0 && plan.price < currentPrice) {
                return res.status(400).json({
                    success: false,
                    code: 'DOWNGRADE_NOT_SUPPORTED',
                    message: `Self-service downgrade from ${currentPlanDoc?.name || 'your current plan'} to ${plan.name} is not supported. Contact support to switch to a lower plan.`,
                });
            }
        }

        // ── State-collision guards ────────────────────────────────
        // Audit fix — block parallel state transitions so the tenant
        // can't accidentally rack up double-charges. The frontend
        // catches these codes and prompts the user to resolve the
        // existing flow first.

        // 1. Already have a pending upgrade in flight? Reject so we
        //    don't create a SECOND Razorpay subscription for the same
        //    tenant. They'll be billed by whichever they pay first.
        if (restaurant.subscription?.pendingUpgrade?.planSlug) {
            const pu = restaurant.subscription.pendingUpgrade;
            // An abandoned checkout (card declined, tab closed) leaves the
            // Razorpay subscription cancelled / expired while our stash
            // still says "pending", and the tenant was stuck behind this
            // 409 with no way out. Ask Razorpay first: a dead subscription
            // is cleared here and the new upgrade proceeds. A live one
            // (status created / authenticated / active) still blocks, and
            // the tenant can clear it with DELETE /upgrade/pending.
            let stale = false;
            if (pu.razorpaySubscriptionId && isBillingConfigured()) {
                try {
                    const live = await fetchRazorpaySubscription(pu.razorpaySubscriptionId);
                    stale = !!live && ['cancelled', 'expired', 'completed'].includes(live.status);
                } catch (probeErr) {
                    logger.warn(`tenantBilling.upgradePlan: pending subscription probe failed for ${pu.razorpaySubscriptionId}: ${probeErr.message}`);
                }
            }
            if (stale) {
                logger.info(`tenantBilling.upgradePlan[${restaurant.slug}]: clearing stale pending upgrade to ${pu.planSlug} (${pu.razorpaySubscriptionId})`);
                restaurant.subscription.pendingUpgrade = undefined;
                await restaurant.save();
            } else {
                return res.status(409).json({
                    success: false,
                    code: 'UPGRADE_ALREADY_PENDING',
                    message: `You already have a pending upgrade to ${pu.planName}. Complete or cancel that payment before starting a new one.`,
                    data: { pendingUpgrade: { planName: pu.planName, planSlug: pu.planSlug, shortUrl: pu.shortUrl || '' } },
                });
            }
        }

        // 2. Pending downgrade request awaiting Super Admin? Reject
        //    so the queue stays single-track.
        const pendingDowngradeReq = await PlanChangeRequest.findOne({
            restaurant: restaurant._id,
            requestSource: 'tenant',
            status: 'pending',
        }).lean();
        if (pendingDowngradeReq) {
            return res.status(409).json({
                success: false,
                code: 'DOWNGRADE_REQUEST_PENDING',
                message: `You have a pending downgrade request to ${pendingDowngradeReq.requestedPlanName}. Cancel it from the banner above before starting an upgrade.`,
            });
        }
        // 3. Scheduled downgrade in flight? Tell the user to cancel
        //    the schedule first — proceeding would leave both flows
        //    racing each other on cycle end. Different code than
        //    UPGRADE_ALREADY_PENDING so the frontend can show a
        //    distinct dialog ("you have a scheduled switch to X").
        if (restaurant.subscription?.scheduledDowngrade?.planSlug) {
            const sd = restaurant.subscription.scheduledDowngrade;
            return res.status(409).json({
                success: false,
                code: 'DOWNGRADE_SCHEDULED',
                message: `Your plan is scheduled to switch to ${sd.planName} on ${sd.effectiveAt ? new Date(sd.effectiveAt).toLocaleDateString('en-IN') : 'cycle end'}. Cancel that schedule before starting a new upgrade.`,
                data: { scheduledDowngrade: { planName: sd.planName, effectiveAt: sd.effectiveAt } },
            });
        }

        // ── Razorpay must be configured for paid plans ──────────────
        if (!isBillingConfigured()) {
            return res.status(503).json({
                success: false,
                code: 'BILLING_NOT_CONFIGURED',
                message: 'Online billing is temporarily unavailable. Contact support to upgrade your plan.',
            });
        }

        const previousPlanSlug = currentSlug || null;
        const previousSubId    = restaurant.subscription?.razorpaySubscriptionId || null;
        const previousCustomerId = restaurant.subscription?.razorpayCustomerId || '';

        // ── Razorpay flow — runs BEFORE we touch subscription state ─
        // ADM-105: previously we committed the new plan to
        // `restaurant.subscription` immediately ("optimistic apply")
        // and relied on a webhook to revert if the user never paid.
        // That webhook never fires for unauthenticated subscriptions,
        // so a tenant could click Upgrade, get plan features
        // instantly, and skip payment forever. Now we stash the plan
        // in `subscription.pendingUpgrade` and wait for the
        // subscription.charged / payment.captured webhook to move it
        // into the live fields.
        let billingResult = { configured: true, subscriptionCreated: false };
        let razorpaySubscriptionId = '';
        let razorpayOrderId = '';
        let shortUrl = '';
        let razorpayStatus = '';
        let fallbackOrderFlag = false;
        let customerId = previousCustomerId;
        try {
            try {
                await ensureRazorpayPlan(plan);
            } catch (planErr) {
                if (planErr?.statusCode !== 401) throw planErr;
                // 401 → Subscriptions not enabled; fall through to
                // createRazorpaySubscription which handles the fallback.
            }

            const owner = restaurant.owner ? await User.findById(restaurant.owner) : req.user;
            customerId = await ensureRazorpayCustomer(restaurant, owner);

            const sub = await createRazorpaySubscription({ plan, restaurant, customerId });

            if (sub.fallbackOrder) {
                // Fallback: Orders API used instead of Subscriptions.
                // Plan features stay in pendingUpgrade until the
                // payment.captured webhook applies them.
                razorpayOrderId = sub.orderId;
                razorpayStatus = 'pending_payment';
                fallbackOrderFlag = true;
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
                logger.info(`self-service upgrade: fallback order for ${restaurant.slug}: ${sub.orderId}`);
            } else {
                razorpaySubscriptionId = sub.id;
                shortUrl = sub.short_url || '';
                razorpayStatus = sub.status || 'created';
                billingResult = {
                    configured: true,
                    subscriptionCreated: true,
                    subscriptionId: sub.id,
                    shortUrl: sub.short_url,
                    status: sub.status,
                };
                logger.info(`self-service upgrade: sub created for ${restaurant.slug}: ${sub.id}`);
            }
        } catch (billingErr) {
            const errDescription =
                (billingErr?.error?.description)
                || (typeof billingErr?.error === 'string' ? billingErr.error : null)
                || billingErr?.message
                || 'Unknown billing error';
            const statusCode = billingErr?.statusCode || billingErr?.error?.code || null;
            logger.error(`self-service upgrade billing failed for ${restaurant.slug}: ${errDescription}`, { statusCode });
            return res.status(502).json({
                success: false,
                code: 'BILLING_SETUP_FAILED',
                message: 'We could not set up the payment with Razorpay. Your existing plan is unchanged. Please try again.',
                details: { error: errDescription, statusCode },
            });
        }

        // ── Stash the pending upgrade (NOT applied yet) ─────────────
        // Live features/limits/planName stay untouched. The webhook
        // will copy these fields into the live subscription once
        // Razorpay confirms payment. Until then the tenant sees their
        // existing plan + a "pending upgrade — finish payment" badge.
        restaurant.subscription = restaurant.subscription || {};
        // Persist the (possibly freshly created) Razorpay customer id so
        // the next upgrade reuses it instead of creating another customer.
        restaurant.subscription.razorpayCustomerId = customerId || previousCustomerId;
        restaurant.subscription.pendingUpgrade = {
            plan: plan._id,
            planName: plan.name,
            planSlug: plan.slug,
            price: typeof plan.price === 'number' ? plan.price : 0,
            features: plan.features?.toObject ? plan.features.toObject() : { ...(plan.features || {}) },
            limits:   plan.limits?.toObject   ? plan.limits.toObject()   : { ...(plan.limits   || {}) },
            razorpaySubscriptionId,
            razorpayOrderId,
            shortUrl,
            fallbackOrder: fallbackOrderFlag,
            previousPlanSlug: previousPlanSlug || '',
            previousSubscriptionId: previousSubId || '',
            createdAt: new Date(),
        };

        await restaurant.save();

        // ── Audit entry — actor is the tenant admin (not a super admin) ──
        try {
            await AuditLog.create({
                actor: req.user?._id || null,
                actorEmail: req.user?.email || '',
                actorRole: req.user?.role || 'admin',
                action: 'restaurant.self_upgrade',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: {
                    from: previousPlanSlug,
                    to: plan.slug,
                    billing: billingResult,
                },
                ip: req.ip || req.headers['x-forwarded-for'] || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (auditErr) {
            logger.warn(`self-service upgrade audit write failed: ${auditErr.message}`);
        }

        return res.status(200).json({
            success: true,
            data: {
                plan: buildPlanCard(plan),
                // Current subscription remains the one the tenant is on
                // RIGHT NOW. Pending upgrade is exposed separately so
                // the UI can show "Plan X (Plan Y pending payment)".
                subscription: {
                    planName: restaurant.subscription.planName || '',
                    planSlug: restaurant.subscription.planSlug || '',
                    razorpayStatus: restaurant.subscription.razorpayStatus || '',
                    status: restaurant.subscription.status || '',
                },
                pendingUpgrade: {
                    planName: plan.name,
                    planSlug: plan.slug,
                    razorpayStatus,
                    shortUrl,
                    subscriptionId: razorpaySubscriptionId,
                    orderId: razorpayOrderId,
                    fallbackOrder: fallbackOrderFlag,
                },
                billing: billingResult,
            },
        });
    } catch (err) {
        logger.error('tenantBilling.upgradePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to upgrade plan' });
    }
};

/**
 * GET /api/v1/tenant/billing/invoices
 *
 * Phase 5 step 5 — list of subscription charges for the caller's
 * tenant, sorted newest-first. Each row is populated by the
 * Razorpay webhook handler on `subscription.charged`. Empty list
 * is the expected state until the first charge lands.
 *
 * Pagination: capped at 50 rows per page so the response stays
 * small. The UI typically only needs the most recent 10-20.
 */
exports.listInvoices = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

        const filter = { restaurant: req.restaurant._id };
        const [items, total] = await Promise.all([
            SubscriptionInvoice.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            SubscriptionInvoice.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            data: items.map(i => ({
                _id: i._id,
                invoiceNumber: i.invoiceNumber,
                planName: i.planName,
                amount: i.amount,
                currency: i.currency,
                periodStart: i.periodStart,
                periodEnd: i.periodEnd,
                status: i.status,
                paidAt: i.paidAt,
                createdAt: i.createdAt,
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
        });
    } catch (err) {
        logger.error('tenantBilling.listInvoices error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list invoices' });
    }
};

/**
 * GET /api/v1/tenant/billing/invoices/:id/download
 *
 * Streams the PDF of a single invoice. The invoice id is validated
 * against the caller's tenant so there's no way to download
 * somebody else's invoice by guessing an id.
 */
exports.downloadInvoicePdf = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid invoice id' });
        }

        const invoice = await SubscriptionInvoice.findOne({
            _id: id,
            restaurant: req.restaurant._id,
        }).lean();

        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // Pull the tenant fresh so the bill-to block reflects current
        // name / email / city even if the tenant was renamed after
        // the charge. Historical accuracy of the amount is guaranteed
        // by the denormalised fields on the invoice itself (planName,
        // amount, period) which are snapshots at charge-time.
        const tenant = await Restaurant.findById(req.restaurant._id)
            .select('name contactEmail contactPhone city address legal')
            .lean();

        streamInvoicePdf(invoice, tenant, res);
    } catch (err) {
        logger.error('tenantBilling.downloadInvoicePdf error: ' + err.message);
        // If headers were already sent by streamInvoicePdf we can't
        // respond with JSON — just log and end.
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: 'Failed to generate invoice PDF' });
        }
    }
};

/**
 * POST /api/v1/tenant/billing/upgrade/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *
 * ADM-106 — frontend-driven confirmation for self-service plan upgrades
 * that went through the Razorpay Orders API fallback. Previously the
 * Subscription page relied 100% on the payment.captured webhook to
 * apply the pending upgrade and create the SubscriptionInvoice, so any
 * environment where the webhook didn't land (local dev with no tunnel,
 * missing RAZORPAY_WEBHOOK_SECRET, blocked URL) left the tenant
 * charged but with no invoice and no upgraded plan.
 *
 * This endpoint mirrors the legacy /razorpay/verify-payment pattern:
 *   1. Verify the HMAC signature exactly the same way the SDK docs
 *      recommend (order_id|payment_id).
 *   2. Fetch the payment from Razorpay to read its `notes.restaurantId`
 *      authoritatively (don't trust the client to send a tenant id).
 *   3. Confirm the payment belongs to the caller's tenant.
 *   4. Apply the upgrade + create the invoice via the shared helper.
 *      Idempotent: the helper short-circuits if a SubscriptionInvoice
 *      already exists for this paymentId (whether the webhook beat us
 *      to it or this verify call was retried).
 */
exports.verifyUpgradePayment = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Payment details are required' });
        }

        if (!process.env.RAZORPAY_KEY_SECRET) {
            return res.status(503).json({
                success: false,
                code: 'BILLING_NOT_CONFIGURED',
                message: 'Online billing is temporarily unavailable.',
            });
        }

        // 1. Signature check — same algorithm as /razorpay/verify-payment.
        const expected = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');
        if (!safeEqual(expected, razorpay_signature)) {
            logger.warn(`tenantBilling.verifyUpgradePayment: signature mismatch for tenant ${req.restaurant.slug} (order ${razorpay_order_id})`);
            return res.status(400).json({
                success: false,
                code: 'SIGNATURE_INVALID',
                message: 'Payment verification failed — invalid signature.',
            });
        }

        // 2. Fetch the payment so we can read its notes server-side.
        const client = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        let payment;
        try {
            payment = await client.payments.fetch(razorpay_payment_id);
        } catch (fetchErr) {
            logger.error(`tenantBilling.verifyUpgradePayment: payments.fetch failed for ${razorpay_payment_id}: ${fetchErr.message}`);
            return res.status(502).json({
                success: false,
                code: 'RAZORPAY_FETCH_FAILED',
                message: 'Could not verify the payment with Razorpay. The webhook will still process it shortly.',
            });
        }

        if (!payment || payment.order_id !== razorpay_order_id) {
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_MISMATCH',
                message: 'Payment does not match the supplied order id.',
            });
        }

        // Only confirm captured payments. `authorized` (not yet captured)
        // means the customer's card was charged but Razorpay hasn't
        // released the funds — wait for the webhook in that case.
        if (payment.status !== 'captured') {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_NOT_CAPTURED',
                message: `Payment status is "${payment.status}". The invoice will appear once Razorpay captures the charge.`,
            });
        }

        // 3. Authoritative tenant check — the payment must carry the
        //    restaurantId we stamped at create-order time, AND it must
        //    match the caller's own tenant. Without this, a tenant could
        //    pay against another tenant's order id and have their own
        //    pendingUpgrade applied (cross-tenant invoice forgery).
        const notesRestaurantId = payment.notes?.restaurantId;
        if (!notesRestaurantId || String(notesRestaurantId) !== String(req.restaurant._id)) {
            logger.warn('tenantBilling.verifyUpgradePayment: tenant mismatch', {
                paymentId: payment.id,
                notesRestaurantId,
                callerTenant: String(req.restaurant._id),
            });
            return res.status(403).json({
                success: false,
                code: 'TENANT_MISMATCH',
                message: 'This payment does not belong to your account.',
            });
        }
        if (payment.notes?.type !== 'plan_payment') {
            return res.status(400).json({
                success: false,
                code: 'NOT_A_PLAN_PAYMENT',
                message: 'This payment is not a plan upgrade.',
            });
        }

        // 4. Apply the upgrade + create the invoice. Idempotent.
        const restaurant = await Restaurant.findById(req.restaurant._id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const result = await applyPaidPlanUpgrade({
            restaurant,
            payment,
            logTag: `tenantBilling.verifyUpgradePayment[${restaurant.slug}]`,
        });

        // Payment doesn't pay for the pending plan (wrong order / short
        // amount) — nothing applied, nothing invoiced.
        if (result.skipped) {
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_PLAN_MISMATCH',
                message: 'This payment does not cover the plan you are upgrading to. Please contact support.',
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                alreadyInvoiced: !!result.alreadyInvoiced,
                upgradeApplied: !!result.applied,
                invoiceNumber: result.invoiceNumber || null,
            },
        });
    } catch (err) {
        logger.error('tenantBilling.verifyUpgradePayment error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to verify payment' });
    }
};

/**
 * POST /api/v1/tenant/billing/sync
 *
 * Recovery path for when Razorpay's webhook can't reach the server
 * (local dev with no tunnel, webhook URL down, signature secret out of
 * sync). Pulls authoritative state straight from Razorpay's API:
 *
 *   1. Fetch the subscription (by the live id, or by the pendingUpgrade
 *      id if the upgrade hasn't been applied locally yet).
 *   2. List the Razorpay invoices on that subscription — each carries
 *      a `payment_id` once Razorpay captured the cycle's charge.
 *   3. For every captured payment we don't already have a
 *      SubscriptionInvoice for, fetch the payment entity and run it
 *      through `applyPaidPlanUpgrade` (same helper the webhook + the
 *      verify endpoint use — fully idempotent thanks to the unique
 *      index on razorpayPaymentId).
 *   4. Sync the denormalised status fields off the live subscription
 *      so the page reflects what Razorpay reports (currentPeriodEnd,
 *      razorpayStatus). When sub.status is 'active' we also clear the
 *      stale shortUrl so the misleading "Complete Payment" button
 *      stops showing.
 *
 * Returns the count of newly-created invoices so the UI can render an
 * accurate toast (vs. "synced — no changes").
 */
exports.syncFromRazorpay = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        if (!isBillingConfigured()) {
            return res.status(503).json({
                success: false,
                code: 'BILLING_NOT_CONFIGURED',
                message: 'Online billing is not configured.',
            });
        }

        const restaurant = await Restaurant.findById(req.restaurant._id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        // Sync EVERY subscription id we know about for this tenant —
        // the live one AND any pending upgrade's sub. The pending one
        // matters because the user clicks "Upgrade to X", pays on
        // Razorpay's hosted page, then comes back here expecting the
        // new plan + invoice. Without iterating both, the sync only
        // checks the OLD live sub (which never fires another charge)
        // and the pending upgrade silently stays unapplied. Order:
        // pending FIRST so its invoice materialises before we touch
        // status fields that would otherwise wipe pendingUpgrade.
        const liveSubId    = restaurant.subscription?.razorpaySubscriptionId || '';
        const pendingSubId = restaurant.subscription?.pendingUpgrade?.razorpaySubscriptionId || '';
        const subIds = [...new Set([pendingSubId, liveSubId].filter(Boolean))];
        if (subIds.length === 0) {
            return res.status(400).json({
                success: false,
                code: 'NO_RAZORPAY_SUBSCRIPTION',
                message: 'No Razorpay subscription is linked to this tenant. Nothing to sync.',
            });
        }

        let created = 0;
        let upgradeApplied = false;
        const subStates = [];   // collected for the final status sync below

        for (const subId of subIds) {
            // ── 1. Fetch authoritative subscription state ──────────────
            let sub;
            try {
                sub = await fetchRazorpaySubscription(subId);
            } catch (fetchErr) {
                logger.error(`tenantBilling.syncFromRazorpay: subscriptions.fetch failed for ${subId}: ${fetchErr.message}`);
                // Keep going — one bad sub shouldn't block the other.
                continue;
            }
            if (!sub) continue;
            subStates.push({ id: subId, sub });

            // ── 2. List cycle-invoices so we can find captured payments ─
            let rzpInvoices = [];
            try {
                rzpInvoices = await listSubscriptionInvoices(subId);
            } catch (listErr) {
                logger.warn(`tenantBilling.syncFromRazorpay: invoices.all failed for ${subId}: ${listErr.message}`);
                // Non-fatal — caller can retry sync after Razorpay recovers.
            }

            // ── 3. Materialise missing SubscriptionInvoice rows ────────
            for (const rzpInv of rzpInvoices) {
                const paymentId = rzpInv?.payment_id;
                if (!paymentId) continue;                  // unpaid cycle
                if (rzpInv.status !== 'paid') continue;    // not yet captured

                const existing = await SubscriptionInvoice.findOne({ razorpayPaymentId: paymentId }, null, { skipTenantScope: true }).lean(); // global idempotency on platform-unique payment id
                if (existing) continue;

                let payment;
                try {
                    payment = await fetchRazorpayPayment(paymentId);
                } catch (pmtErr) {
                    logger.warn(`syncFromRazorpay: payments.fetch failed for ${paymentId}: ${pmtErr.message}`);
                    continue;
                }
                if (!payment || payment.status !== 'captured') continue;

                try {
                    const result = await applyPaidPlanUpgrade({
                        restaurant,
                        payment,
                        logTag: `tenantBilling.syncFromRazorpay[${restaurant.slug}]`,
                    });
                    if (result.invoiceCreated) created += 1;
                    if (result.applied) upgradeApplied = true;
                } catch (applyErr) {
                    logger.error(`syncFromRazorpay: applyPaidPlanUpgrade failed for ${paymentId}: ${applyErr.message}`);
                }
            }
        }

        // ── 4. Sync the denormalised subscription fields ───────────────
        // Reload after applyPaidPlanUpgrade saved earlier so we don't
        // overwrite anything the helper wrote (most notably the
        // freshly-applied planName / pendingUpgrade cleared / shortUrl
        // cleared).
        const fresh = await Restaurant.findById(restaurant._id);
        fresh.subscription = fresh.subscription || {};
        // Prefer the LIVE sub's status if we have one — that's the
        // canonical billing pipeline. Pending sub status is metadata
        // until applyPaidPlanUpgrade promotes it.
        const liveState    = subStates.find(s => s.id === fresh.subscription.razorpaySubscriptionId);
        const preferredSub = liveState?.sub || subStates[0]?.sub;
        if (preferredSub?.status) fresh.subscription.razorpayStatus = preferredSub.status;
        if (preferredSub?.current_end) {
            fresh.subscription.currentPeriodEnd = new Date(preferredSub.current_end * 1000);
        }
        if (preferredSub?.status === 'active') {
            // First charge cleared — the authorization URL is dead.
            // Clear it so the "Complete Payment" CTA stops showing.
            fresh.subscription.shortUrl = '';
        }
        // Refresh lastChargedAt from the most recent charge_at on the
        // preferred sub. Razorpay exposes this as a unix-seconds field
        // when the sub has billed at least once. Keeping our denormalised
        // copy in sync prevents the "Last charge: never" UI when the
        // webhook missed but a sync caught up.
        if (preferredSub?.charge_at) {
            fresh.subscription.lastChargedAt = new Date(preferredSub.charge_at * 1000);
        } else if (subStates.some(s => s.sub?.paid_count > 0)) {
            // No charge_at returned but Razorpay says paid_count > 0 —
            // fall back to now (best effort, beats leaving it stale).
            fresh.subscription.lastChargedAt = new Date();
        }
        // Backfill customerId if it ever drifted (e.g. customer was
        // recreated after a partial failure).
        if (preferredSub?.customer_id && !fresh.subscription.razorpayCustomerId) {
            fresh.subscription.razorpayCustomerId = preferredSub.customer_id;
        }
        await fresh.save();

        // Carry the first sub state for the response payload.
        const sub = preferredSub || subStates[0]?.sub || {};

        return res.status(200).json({
            success: true,
            data: {
                razorpayStatus: sub.status || '',
                paidCount: sub.paid_count || 0,
                currentEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
                invoicesCreated: created,
                upgradeApplied,
            },
        });
    } catch (err) {
        logger.error('tenantBilling.syncFromRazorpay error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to sync from Razorpay' });
    }
};

/**
 * POST /api/v1/tenant/billing/downgrade-request
 * Body: { planId, reason }
 *
 * Tenant-initiated downgrade request. Self-service upgrades go
 * through Razorpay directly; downgrades to a cheaper plan (free or
 * paid) need Super Admin review because they have side effects the
 * tenant can't handle alone — cancelling the old Razorpay
 * subscription, refunds / proration, dropping features the tenant
 * may still depend on.
 *
 * Validation:
 *   - Reason is required (min 10 chars) so the reviewer has context.
 *   - planId must exist, be active and public.
 *   - Cannot request the same plan they're on.
 *   - Plan must be cheaper than the price the tenant currently pays.
 *   - At most ONE pending request per tenant (no stacking).
 *
 * On approval, the existing approvePlanChangeRequest superadmin
 * flow swaps the plan snapshot — no further work needed here.
 */
exports.requestDowngrade = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const { planId, reason } = req.body || {};
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'A valid plan id is required' });
        }
        const trimmedReason = (reason || '').toString().trim();
        if (trimmedReason.length < 10) {
            return res.status(400).json({
                success: false,
                code: 'REASON_REQUIRED',
                message: 'Please tell us why you want to downgrade (at least 10 characters). This helps our team review your request faster.',
            });
        }
        if (trimmedReason.length > 1000) {
            return res.status(400).json({ success: false, message: 'Reason must be 1000 characters or less.' });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(req.restaurant._id),
            SubscriptionPlan.findById(planId),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // No-op guard — can't request a downgrade to the plan you're
        // already on.
        if (plan.slug === restaurant.subscription?.planSlug) {
            return res.status(400).json({
                success: false,
                code: 'SAME_PLAN',
                message: `You're already on the ${plan.name} plan.`,
            });
        }

        // Downgrade means a cheaper plan from the public catalogue. A
        // pricier (or private/bespoke) plan through this queue would be
        // a free upgrade once approved — upgrades go through payment.
        if (plan.isPublic === false) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }
        // Snapshot price (what the tenant pays); catalogue only as a
        // fallback for legacy tenants without one.
        let currentPrice = restaurant.subscription?.price;
        if (typeof currentPrice !== 'number') {
            const currentPlanDoc = restaurant.subscription?.plan
                ? await SubscriptionPlan.findById(restaurant.subscription.plan).select('price')
                : null;
            currentPrice = currentPlanDoc?.price ?? 0;
        }
        if (!(Number(plan.price) < currentPrice)) {
            return res.status(400).json({
                success: false,
                code: 'NOT_A_DOWNGRADE',
                message: `${plan.name} is not cheaper than your current plan. Use Upgrade to move to a higher plan.`,
            });
        }

        // Stack guard — one pending request at a time so the reviewer
        // queue stays clean and the tenant can't fire-and-forget
        // dozens of requests.
        const existing = await PlanChangeRequest.findOne({
            restaurant: restaurant._id,
            status: 'pending',
        }).lean();
        if (existing) {
            return res.status(409).json({
                success: false,
                code: 'REQUEST_ALREADY_PENDING',
                message: 'You already have a pending plan change request. Cancel it first if you want to request a different plan.',
                data: { existingRequest: buildRequestPayload(existing) },
            });
        }

        const request = await PlanChangeRequest.create({
            restaurant: restaurant._id,
            requestedPlan: plan._id,
            requestedPlanName: plan.name,
            requestedPlanPrice: plan.price,
            currentPlan: restaurant.subscription?.plan || null,
            currentPlanName: restaurant.subscription?.planName || '',
            note: trimmedReason,
            requestSource: 'tenant',
            requestedBy: req.user._id,
            requestedByEmail: req.user.email,
        });

        try {
            await AuditLog.create({
                actor: req.user._id,
                actorEmail: req.user.email,
                actorRole: req.user.role || 'admin',
                action: 'plan_change.tenant_request',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: {
                    from: request.currentPlanName,
                    to: request.requestedPlanName,
                    requestId: request._id,
                    reason: trimmedReason.slice(0, 200),
                },
                ip: req.ip || req.headers['x-forwarded-for'] || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (auditErr) {
            logger.warn(`tenantBilling.requestDowngrade audit write failed: ${auditErr.message}`);
        }

        return res.status(201).json({
            success: true,
            data: buildRequestPayload(request),
        });
    } catch (err) {
        logger.error('tenantBilling.requestDowngrade error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to submit downgrade request' });
    }
};

/**
 * GET /api/v1/tenant/billing/downgrade-request
 *
 * Returns the tenant's most-recent pending downgrade request, or
 * null. Used by the Subscription page on mount to render the
 * "request pending" banner without an extra round trip after submit.
 */
exports.getDowngradeRequest = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const payload = await loadActiveDowngradeRequest(req.restaurant._id);
        return res.status(200).json({ success: true, data: payload });
    } catch (err) {
        logger.error('tenantBilling.getDowngradeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load downgrade request' });
    }
};

/**
 * DELETE /api/v1/tenant/billing/downgrade-request/:id
 *
 * Lets the tenant withdraw their own pending request — they changed
 * their mind, picked a different plan, etc. Tenant-scoped so they
 * can never cancel another tenant's request even if they guess the
 * id. Already-reviewed (approved / rejected) requests are immutable.
 */
exports.cancelDowngradeRequest = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const request = await PlanChangeRequest.findOne({
            _id: id,
            restaurant: req.restaurant._id,
            requestSource: 'tenant',
        });
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }
        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                code: 'REQUEST_LOCKED',
                message: `This request is already ${request.status} and can't be cancelled.`,
            });
        }

        request.status = 'cancelled';
        request.reviewedAt = new Date();
        request.reviewedBy = req.user._id;
        request.reviewedByEmail = req.user.email;
        await request.save();

        try {
            await AuditLog.create({
                actor: req.user._id,
                actorEmail: req.user.email,
                actorRole: req.user.role || 'admin',
                action: 'plan_change.tenant_cancel',
                targetType: 'restaurant',
                targetId: req.restaurant._id,
                targetName: req.restaurant.name,
                details: {
                    requestId: request._id,
                    from: request.currentPlanName,
                    to: request.requestedPlanName,
                },
                ip: req.ip || req.headers['x-forwarded-for'] || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (_) { /* audit failures must not block UX */ }

        return res.status(200).json({ success: true, data: buildRequestPayload(request) });
    } catch (err) {
        logger.error('tenantBilling.cancelDowngradeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel request' });
    }
};

/**
 * POST /api/v1/tenant/billing/scheduled-downgrade/cancel
 *
 * Tenant changes their mind AFTER Super Admin approved the downgrade
 * but BEFORE the cycle-end switch lands.
 *
 * Important caveat: Razorpay's cancel_at_cycle_end can NOT be undone
 * once set. So the old subscription will still stop at cycle end —
 * the tenant just won't be auto-downgraded to the cheaper plan when
 * it does. They'll need to start a fresh upgrade flow for whatever
 * plan they want to keep going forward.
 *
 * We clear the local scheduledDowngrade snapshot + audit it. The UI
 * makes the caveat explicit before submit so the user isn't
 * surprised.
 */
exports.cancelScheduledDowngrade = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const restaurant = await Restaurant.findById(req.restaurant._id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        const sched = restaurant.subscription?.scheduledDowngrade;
        if (!sched?.planSlug) {
            return res.status(404).json({
                success: false,
                code: 'NO_SCHEDULED_DOWNGRADE',
                message: 'There is no scheduled downgrade to cancel.',
            });
        }

        const snapshot = {
            planName: sched.planName,
            planSlug: sched.planSlug,
            effectiveAt: sched.effectiveAt,
            requestId: sched.requestId,
        };
        restaurant.subscription.scheduledDowngrade = undefined;
        await restaurant.save();

        try {
            await AuditLog.create({
                actor: req.user._id,
                actorEmail: req.user.email,
                actorRole: req.user.role || 'admin',
                action: 'plan_change.tenant_cancel_schedule',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: { ...snapshot },
                ip: req.ip || req.headers['x-forwarded-for'] || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (_) { /* audit failure must not break UX */ }

        return res.status(200).json({
            success: true,
            data: {
                cancelled: snapshot,
                note: 'Your Razorpay subscription will still close at the original cycle end (it cannot be un-cancelled). Start a fresh upgrade if you want to keep paying for this or another plan after that date.',
            },
        });
    } catch (err) {
        logger.error('tenantBilling.cancelScheduledDowngrade error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel scheduled downgrade' });
    }
};

/**
 * DELETE /api/v1/tenant/billing/upgrade/pending
 *
 * Abandon an upgrade that never got paid. The "Complete or cancel that
 * payment" 409 promised a cancel path that did not exist: a tenant whose
 * card was declined kept their old plan AND could not start the upgrade
 * again. This clears the stash (the live plan is untouched — it was never
 * applied) and cancels the Razorpay subscription so the tenant can't be
 * charged later for a plan they gave up on. A fallback Orders-API upgrade
 * has nothing to cancel at Razorpay: an unpaid order simply expires.
 *
 * Razorpay cancel failures are tolerated (logged, razorpayCancelled false):
 * the subscription may already be cancelled / expired on their side, and
 * leaving the tenant stuck is the worse outcome.
 */
exports.cancelPendingUpgrade = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const restaurant = await Restaurant.findById(req.restaurant._id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        const pu = restaurant.subscription?.pendingUpgrade;
        if (!pu?.planSlug) {
            return res.status(404).json({
                success: false,
                code: 'NO_PENDING_UPGRADE',
                message: 'There is no pending upgrade to cancel.',
            });
        }

        let razorpayCancelled = false;
        if (pu.razorpaySubscriptionId && isBillingConfigured()) {
            try {
                await cancelRazorpaySubscription(pu.razorpaySubscriptionId, false);
                razorpayCancelled = true;
            } catch (cancelErr) {
                logger.warn(`tenantBilling.cancelPendingUpgrade[${restaurant.slug}]: Razorpay cancel failed for ${pu.razorpaySubscriptionId}: ${cancelErr.message}`);
            }
        }

        const cancelled = {
            planName: pu.planName,
            planSlug: pu.planSlug,
            razorpaySubscriptionId: pu.razorpaySubscriptionId || '',
        };
        restaurant.subscription.pendingUpgrade = undefined;
        await restaurant.save();

        try {
            await AuditLog.create({
                actor: req.user?._id || null,
                actorEmail: req.user?.email || '',
                actorRole: req.user?.role || 'admin',
                action: 'restaurant.self_upgrade_cancelled',
                targetType: 'restaurant',
                targetId: restaurant._id,
                details: { to: cancelled.planSlug, razorpaySubscriptionId: cancelled.razorpaySubscriptionId, razorpayCancelled },
            });
        } catch (auditErr) {
            logger.warn('tenantBilling.cancelPendingUpgrade: audit write failed: ' + auditErr.message);
        }

        return res.status(200).json({
            success: true,
            message: `Pending upgrade to ${cancelled.planName} cancelled. Your current plan is unchanged.`,
            data: { cancelledPlanSlug: cancelled.planSlug, razorpayCancelled },
        });
    } catch (err) {
        logger.error('tenantBilling.cancelPendingUpgrade error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel the pending upgrade' });
    }
};
