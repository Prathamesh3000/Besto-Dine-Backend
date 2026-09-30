const Restaurant = require('../models/restaurant');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const logger = require('./logger');

// Apply a pending plan upgrade onto the live subscription. Idempotent:
// no-op once pendingUpgrade has been cleared, so retried webhooks /
// duplicate verify calls don't double-apply.
function applyPendingUpgrade(restaurant) {
    const pending = restaurant.subscription?.pendingUpgrade;
    if (!pending || !pending.planSlug) return false;

    restaurant.subscription.plan      = pending.plan || restaurant.subscription.plan;
    restaurant.subscription.planName  = pending.planName || '';
    restaurant.subscription.planSlug  = pending.planSlug || '';
    if (typeof pending.price === 'number') restaurant.subscription.price = pending.price;
    restaurant.subscription.features  = pending.features || {};
    restaurant.subscription.limits    = pending.limits   || {};
    const oldSubId = restaurant.subscription?.razorpaySubscriptionId;
    if (pending.razorpaySubscriptionId && pending.razorpaySubscriptionId !== oldSubId) {
        restaurant.subscription.razorpaySubscriptionId = pending.razorpaySubscriptionId;
        if (oldSubId) {
            try {
                const razorpay = require('./razorpay');
                if (razorpay && razorpay.subscriptions) {
                    razorpay.subscriptions.cancel(oldSubId, { cancel_at_cycle_end: 0 })
                        .catch(err => logger.warn(`Failed to cancel old subscription ${oldSubId}: ${err.message}`));
                }
            } catch (err) {
                logger.warn(`Razorpay client error during sub cancel: ${err.message}`);
            }
        }
    }
    // CLEAR the authorization shortUrl now that payment confirmed — the
    // URL is stale, and leaving it set keeps the "Complete Payment"
    // button visible on the tenant's subscription page even though the
    // charge already landed (which made the page look broken).
    restaurant.subscription.shortUrl  = '';
    restaurant.subscription.status    = 'active';
    restaurant.subscription.startDate = new Date();
    restaurant.subscription.endDate   = null;
    restaurant.subscription.trialEndDate = null;
    if (restaurant.status === 'trial') restaurant.status = 'active';
    restaurant.subscription.pendingUpgrade = undefined;
    // If a scheduled downgrade was in flight, it's no longer relevant
    // — the tenant just upgraded to a different plan and paid for it.
    // Leaving the schedule in place would cause the next cycle-end to
    // silently downgrade them away from the plan they just paid for.
    restaurant.subscription.scheduledDowngrade = undefined;
    return true;
}

// Shared apply-paid-plan logic used by BOTH the Razorpay webhook
// (handlePlanPaymentCaptured) and the frontend-initiated verify call
// (tenantBillingController.verifyUpgradePayment). Either path may
// arrive first; the unique index on SubscriptionInvoice.razorpayPaymentId
// makes the second a no-op.
//
// Returns { applied, invoiceCreated, invoiceNumber, alreadyInvoiced }.
async function applyPaidPlanUpgrade({ restaurant, payment, logTag = 'plan-payment' }) {
    if (!restaurant || !payment?.id) {
        throw new Error('applyPaidPlanUpgrade requires restaurant + payment.id');
    }

    // Idempotency: if this payment was already invoiced, the upgrade
    // was already applied on the first run — bail.
    // Global idempotency on a platform-unique payment id — opt out of
    // the #30 tenant-scope plugin so a tenant-context caller still sees it.
    const existing = await SubscriptionInvoice.findOne({
        razorpayPaymentId: payment.id,
    }, null, { skipTenantScope: true }).lean();
    if (existing) {
        logger.info(`${logTag}: payment ${payment.id} already invoiced — skipping`);
        return { applied: false, invoiceCreated: false, alreadyInvoiced: true };
    }

    const applied = applyPendingUpgrade(restaurant);
    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayStatus = 'active';
    restaurant.subscription.lastChargedAt = new Date();

    // Orders-API one-shot: no real cycle date, assume +1 month so the
    // "next billing" badge in the UI has something to render.
    const oneMonthFromNow = new Date();
    oneMonthFromNow.setMonth(oneMonthFromNow.getMonth() + 1);
    restaurant.subscription.currentPeriodEnd = oneMonthFromNow;
    await restaurant.save();

    if (applied) {
        logger.info(`${logTag}: applied pending upgrade for ${restaurant.slug} → ${restaurant.subscription.planName} (payment ${payment.id})`);
    }

    let invoiceCreated = false;
    let invoiceNumber = '';
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const ymd = startOfDay.toISOString().slice(0, 10).replace(/-/g, '');
        // Atomic-ish invoice numbering. The old `countDocuments + 1`
        // approach raced — two concurrent webhooks on the same day for
        // the same tenant both computed the same N and produced
        // duplicate invoice numbers (the razorpayPaymentId unique
        // index doesn't catch this when the payments differ). We now
        // retry with the next slot if Mongo rejects the insert on the
        // composite { restaurant, invoiceNumber } index (added as a
        // belt-and-braces unique). Bounded retry — give up after 50
        // attempts to avoid an infinite loop on a real bug.
        const todayBase = await SubscriptionInvoice.countDocuments({
            restaurant: restaurant._id,
            createdAt: { $gte: startOfDay },
        });
        let seq = todayBase + 1;
        let saved = null;
        for (let attempt = 0; attempt < 50 && !saved; attempt++, seq++) {
            invoiceNumber = `INV-${ymd}-${String(seq).padStart(4, '0')}`;
            try {
                saved = await SubscriptionInvoice.create({
                    restaurant: restaurant._id,
                    restaurantName: restaurant.name,
                    invoiceNumber,
                    planName: restaurant.subscription?.planName || '',
                    planSlug: restaurant.subscription?.planSlug || '',
                    amount: payment.amount || 0,
                    currency: payment.currency || 'INR',
                    periodStart: new Date(),
                    periodEnd: oneMonthFromNow,
                    razorpayPaymentId: payment.id,
                    razorpaySubscriptionId: '',
                    status: 'paid',
                    paidAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date(),
                });
            } catch (insertErr) {
                if (insertErr?.code === 11000) {
                    // Two duplicate-key flavours we expect:
                    //   - razorpayPaymentId unique: another path already
                    //     materialised this payment → treat as deduped.
                    //   - invoiceNumber unique: another concurrent invoice
                    //     in the same per-day counter slot → retry with
                    //     the next slot. Detect by message; fall back to
                    //     "treat as paymentId race" when the message is
                    //     opaque (some mongo versions / drivers strip it).
                    const msg = insertErr.message || '';
                    if (/invoiceNumber/.test(msg)) {
                        logger.info(`${logTag}: invoice number ${invoiceNumber} race-lost, retrying`);
                        continue;
                    }
                    // razorpayPaymentId race (default for any other E11000)
                    logger.info(`${logTag}: SubscriptionInvoice already exists for payment ${payment.id} — race deduped`);
                    return { applied, invoiceCreated: false, alreadyInvoiced: true };
                }
                throw insertErr;
            }
        }
        if (!saved) {
            throw new Error(`Could not allocate a unique invoiceNumber after 50 attempts (tenant ${restaurant.slug})`);
        }
        invoiceCreated = true;
        logger.info(`${logTag}: SubscriptionInvoice ${invoiceNumber} created for ${restaurant.slug}`);
    } catch (invoiceErr) {
        logger.error(`${logTag}: SubscriptionInvoice create failed for ${restaurant.slug}: ${invoiceErr.message}`);
        throw invoiceErr;
    }

    return { applied, invoiceCreated, invoiceNumber, alreadyInvoiced: false };
}

/**
 * Apply a scheduled downgrade onto the live subscription. Called
 * from the subscription.completed webhook (Razorpay subs path) and
 * from a lazy-check on the tenant's subscription-page load (fallback
 * Orders path, or as a safety net if the webhook missed).
 *
 * Idempotent — bails if scheduledDowngrade is empty or if the
 * effectiveAt is still in the future. Returns `{ applied }`.
 */
function applyScheduledDowngrade(restaurant, { force = false } = {}) {
    const sched = restaurant.subscription?.scheduledDowngrade;
    if (!sched || !sched.planSlug) return { applied: false };
    // Only apply if the cycle end has passed (or caller forces it,
    // e.g. operator-driven early apply). Otherwise the tenant should
    // keep their current features until the date they paid through.
    if (!force && sched.effectiveAt && new Date(sched.effectiveAt) > new Date()) {
        return { applied: false, pending: true };
    }

    restaurant.subscription.plan      = sched.plan || restaurant.subscription.plan;
    restaurant.subscription.planName  = sched.planName || '';
    restaurant.subscription.planSlug  = sched.planSlug || '';
    if (typeof sched.price === 'number') restaurant.subscription.price = sched.price;
    restaurant.subscription.features  = sched.features || {};
    restaurant.subscription.limits    = sched.limits   || {};
    restaurant.subscription.startDate = new Date();
    restaurant.subscription.status    = 'active';
    // The OLD Razorpay subscription has finished its cycle. Clear the
    // reference; a NEW Razorpay subscription will be set up if/when
    // the tenant pays their first invoice on the new (cheaper) plan.
    restaurant.subscription.razorpaySubscriptionId = '';
    restaurant.subscription.shortUrl = '';
    restaurant.subscription.razorpayStatus = '';
    restaurant.subscription.scheduledDowngrade = undefined;

    if (restaurant.status === 'suspended') restaurant.status = 'active';
    return { applied: true };
}

module.exports = {
    applyPendingUpgrade,
    applyScheduledDowngrade,
    applyPaidPlanUpgrade,
};
