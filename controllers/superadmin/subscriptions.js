// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const User = require('../../models/user');
const { recordAudit } = require('../../utils/audit');
const {
    isBillingConfigured,
    ensureRazorpayPlan,
    ensureRazorpayCustomer,
    createRazorpaySubscription,
    cancelRazorpaySubscription,
} = require('../../utils/razorpayBilling');
const logger = require('../../utils/logger');
const { snapshotPlan, buildRestaurantPayload } = require('./_shared');

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
