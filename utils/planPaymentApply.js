const Restaurant = require('../models/restaurant');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const logger = require('./logger');
const { describeRazorpayError } = require('./razorpayErrors');

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
                // Immediate cancel (cancelAtCycleEnd=false) — the tenant
                // has just paid on the NEW subscription; leaving the old
                // one running would double-bill them. Lazy require keeps
                // the Razorpay SDK out of this module's load path.
                const { cancelRazorpaySubscription } = require('./razorpayBilling');
                cancelRazorpaySubscription(oldSubId, false)
                    .catch(err => logger.warn(`Failed to cancel old subscription ${oldSubId}`, describeRazorpayError(err)));
            } catch (err) {
                logger.warn('Razorpay client error during sub cancel', describeRazorpayError(err));
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

// Local-calendar YYYYMMDD — same basis as the local-midnight
// `startOfDay` the per-day invoice counter uses. (`toISOString()` would
// give the UTC date, i.e. yesterday for any server east of UTC.)
function localYmd(d) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// +1 calendar month, clamped to the last day of the next month
// (31 Jan → 28/29 Feb, not 3 Mar).
function addOneMonth(from) {
    const d = new Date(from);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
}

// Does this captured payment actually pay for the stashed pendingUpgrade?
// Returns '' when it does (or when there is nothing pending), otherwise a
// short reason. Money: payment.amount is PAISE, pending.price is RUPEES.
function pendingPaymentMismatch(pending, payment) {
    if (!pending || !pending.planSlug) return '';
    if (pending.razorpayOrderId && payment.order_id !== pending.razorpayOrderId) {
        return `order ${payment.order_id || '(none)'} is not the pending upgrade order ${pending.razorpayOrderId}`;
    }
    const price = Number(pending.price);
    if (Number.isFinite(price) && price > 0) {
        const required = Math.round(price * 100);
        if (!(Number(payment.amount) >= required)) {
            return `amount ${payment.amount || 0} paise is below the plan price ${required} paise`;
        }
    }
    return '';
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

    // The payment must actually pay for the pending plan: right order
    // (fallback Orders path) and at least the plan price. Otherwise a
    // ₹1 capture, or an older cheaper plan order, would unlock whatever
    // plan is currently pending. Skip — nothing applied, nothing
    // invoiced — and leave it for manual reconciliation.
    const mismatch = pendingPaymentMismatch(restaurant.subscription?.pendingUpgrade, payment);
    if (mismatch) {
        logger.error(`${logTag}: payment ${payment.id} NOT applied to pending upgrade for ${restaurant.slug}: ${mismatch}`);
        return { applied: false, invoiceCreated: false, alreadyInvoiced: false, skipped: true, reason: mismatch };
    }

    const applied = applyPendingUpgrade(restaurant);
    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayStatus = 'active';
    restaurant.subscription.lastChargedAt = new Date();

    // Orders-API one-shot: no real cycle date, assume +1 month so the
    // "next billing" badge in the UI has something to render.
    const oneMonthFromNow = addOneMonth(new Date());
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
        const ymd = localYmd(startOfDay);
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

    // Only lift a payment-related suspension (same rule as
    // superadminController.confirmPayment) — a tenant suspended for a
    // ToS / fraud reason must stay suspended.
    if (restaurant.status === 'suspended' && /payment/i.test(restaurant.suspendedReason || '')) {
        restaurant.status = 'active';
        restaurant.suspendedAt = undefined;
        restaurant.suspendedReason = '';
    }
    return { applied: true };
}

module.exports = {
    localYmd,
    addOneMonth,
    pendingPaymentMismatch,
    applyPendingUpgrade,
    applyScheduledDowngrade,
    applyPaidPlanUpgrade,
};
