const Restaurant = require('../models/restaurant');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const logger = require('./logger');
const { skipScope } = require('./tenantScopePlugin');
const { describeRazorpayError } = require('./razorpayErrors');
const {
    normalizeCycle, addMonths, addCycle, priceWithGst, invoiceAmounts,
} = require('./billingCycles');

// Apply a pending plan upgrade onto the live subscription. Idempotent:
// no-op once pendingUpgrade has been cleared, so retried webhooks /
// duplicate verify calls don't double-apply.
function applyPendingUpgrade(restaurant) {
    return applyPendingUpgradeDetailed(restaurant).applied;
}

// Same as applyPendingUpgrade but also reports what it applied
// ({ applied, cycle, renewal }) so the caller can compute the paid term
// BEFORE the pending block is cleared.
function applyPendingUpgradeDetailed(restaurant) {
    const pending = restaurant.subscription?.pendingUpgrade;
    if (!pending || !pending.planSlug) return { applied: false, cycle: null, renewal: false };
    const cycle = normalizeCycle(pending.billingCycle);
    const renewal = pending.renewal === true;

    restaurant.subscription.plan      = pending.plan || restaurant.subscription.plan;
    restaurant.subscription.planName  = pending.planName || '';
    restaurant.subscription.planSlug  = pending.planSlug || '';
    if (typeof pending.price === 'number') restaurant.subscription.price = pending.price;
    restaurant.subscription.billingCycle = cycle;
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
    // One-time Order purchase (no new recurring subscription) that replaces a
    // live recurring one - e.g. monthly auto-renew -> a prepaid annual term
    // via Orders: cancel the old subscription, or it keeps billing monthly on
    // top of the term just paid for.
    if (!renewal && pending.fallbackOrder && !pending.razorpaySubscriptionId && oldSubId) {
        restaurant.subscription.razorpaySubscriptionId = '';
        try {
            const { cancelRazorpaySubscription } = require('./razorpayBilling');
            cancelRazorpaySubscription(oldSubId, false)
                .catch(err => logger.warn(`Failed to cancel old subscription ${oldSubId}`, describeRazorpayError(err)));
        } catch (err) {
            logger.warn('Razorpay client error during sub cancel', describeRazorpayError(err));
        }
    }
    // CLEAR the authorization shortUrl now that payment confirmed — the
    // URL is stale, and leaving it set keeps the "Complete Payment"
    // button visible on the tenant's subscription page even though the
    // charge already landed (which made the page look broken).
    restaurant.subscription.shortUrl  = '';
    restaurant.subscription.status    = 'active';
    // A same-plan renewal / cycle extension keeps the original start date
    // (the term is extended, not restarted).
    if (!renewal || !restaurant.subscription.startDate) restaurant.subscription.startDate = new Date();
    restaurant.subscription.endDate   = null;
    restaurant.subscription.trialEndDate = null;
    if (restaurant.status === 'trial') restaurant.status = 'active';
    restaurant.subscription.pendingUpgrade = undefined;
    // If a scheduled downgrade was in flight, it's no longer relevant
    // — the tenant just upgraded to a different plan and paid for it.
    // Leaving the schedule in place would cause the next cycle-end to
    // silently downgrade them away from the plan they just paid for.
    restaurant.subscription.scheduledDowngrade = undefined;
    return { applied: true, cycle, renewal };
}

// The paid term a payment buys: starts now, or at the END of the current term
// for a renewal / extension that is paid while time remains (the owner never
// loses days they already paid for). `cycle` sets the length (+1 / +12 / +24
// calendar months). Returns { periodStart, periodEnd }.
function paidTermFor(restaurant, { cycle, renewal = false, now = new Date() }) {
    const currentEnd = restaurant.subscription?.currentPeriodEnd
        ? new Date(restaurant.subscription.currentPeriodEnd) : null;
    const periodStart = renewal && currentEnd && currentEnd > now ? currentEnd : now;
    return { periodStart, periodEnd: addCycle(periodStart, cycle) };
}

// Local-calendar YYYYMMDD — same basis as the local-midnight
// `startOfDay` the per-day invoice counter uses. (`toISOString()` would
// give the UTC date, i.e. yesterday for any server east of UTC.)
function localYmd(d) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// +1 calendar month, clamped to the last day of the next month
// (31 Jan -> 28/29 Feb, not 3 Mar). Kept for older callers; the general
// version is billingCycles.addMonths.
function addOneMonth(from) {
    return addMonths(from, 1);
}

// Does this captured payment actually pay for the stashed pendingUpgrade?
// Returns '' when it does (or when there is nothing pending), otherwise a
// short reason. Money: payment.amount is PAISE, pending.price is RUPEES.
function pendingPaymentMismatch(pending, payment) {
    if (!pending || !pending.planSlug) return '';
    if (pending.razorpayOrderId && payment.order_id !== pending.razorpayOrderId) {
        return `order ${payment.order_id || '(none)'} is not the pending upgrade order ${pending.razorpayOrderId}`;
    }
    // pending.price is the BASE price (excl. GST) for the pending cycle; the
    // customer must have paid base + GST (utils/billingCycles.priceWithGst).
    const price = Number(pending.price);
    if (Number.isFinite(price) && price > 0) {
        const required = priceWithGst(price).totalPaise;
        if (!(Number(payment.amount) >= required)) {
            return `amount ${payment.amount || 0} paise is below the plan price incl. GST ${required} paise`;
        }
    }
    return '';
}

// Persist one SubscriptionInvoice for a captured plan payment, with the
// cycle and the GST split (base + GST = total paid, in paise). Used by the
// Orders-API path (applyPaidPlanUpgrade) AND the subscription.charged webhook
// so invoice numbering, dedupe and money fields cannot drift apart.
//
// Returns { invoiceNumber } or { deduped: true } when another path already
// materialised this razorpayPaymentId. Throws on any other failure.
async function createPaidInvoice({
    restaurant, payment, logTag = 'plan-payment', billingCycle, periodStart, periodEnd,
    razorpaySubscriptionId = '',
}) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const ymd = localYmd(startOfDay);
    const money = invoiceAmounts(payment.amount || 0, restaurant.subscription?.price);
    // Atomic-ish invoice numbering. countDocuments + 1 raced (two concurrent
    // webhooks the same day computed the same N), so we retry with the next
    // slot when Mongo rejects the insert on the composite
    // { restaurant, invoiceNumber } unique index. Bounded at 50 attempts.
    const todayBase = await SubscriptionInvoice.countDocuments({
        restaurant: restaurant._id,
        createdAt: { $gte: startOfDay },
    });
    let seq = todayBase + 1;
    let saved = null;
    let invoiceNumber = '';
    for (let attempt = 0; attempt < 50 && !saved; attempt++, seq++) {
        invoiceNumber = `INV-${ymd}-${String(seq).padStart(4, '0')}`;
        try {
            saved = await SubscriptionInvoice.create({
                restaurant: restaurant._id,
                restaurantName: restaurant.name,
                invoiceNumber,
                planName: restaurant.subscription?.planName || '',
                planSlug: restaurant.subscription?.planSlug || '',
                billingCycle: normalizeCycle(billingCycle),
                amount: money.amount,
                baseAmount: money.baseAmount,
                gstAmount: money.gstAmount,
                gstRate: money.gstRate,
                currency: payment.currency || 'INR',
                periodStart,
                periodEnd,
                razorpayPaymentId: payment.id,
                razorpaySubscriptionId,
                status: 'paid',
                paidAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date(),
            });
        } catch (insertErr) {
            if (insertErr?.code === 11000) {
                // Two duplicate-key flavours: invoiceNumber (concurrent invoice
                // in the same slot -> retry next slot) and razorpayPaymentId
                // (another path already materialised this payment -> deduped).
                const msg = insertErr.message || '';
                if (/invoiceNumber/.test(msg)) {
                    logger.info(`${logTag}: invoice number ${invoiceNumber} race-lost, retrying`);
                    continue;
                }
                logger.info(`${logTag}: SubscriptionInvoice already exists for payment ${payment.id} - race deduped`);
                return { deduped: true };
            }
            throw insertErr;
        }
    }
    if (!saved) {
        throw new Error(`Could not allocate a unique invoiceNumber after 50 attempts (tenant ${restaurant.slug})`);
    }
    logger.info(`${logTag}: SubscriptionInvoice ${invoiceNumber} created for ${restaurant.slug}`);
    return { invoiceNumber };
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
    // AUDIT-EXEMPT: razorpayPaymentId is platform-unique (unique index), so
    // idempotency must see an invoice under ANY tenant; the webhook caller has
    // no tenant context and the verify/sync callers have one. Existence only.
    const existing = await skipScope(SubscriptionInvoice.findOne({
        razorpayPaymentId: payment.id,
    }).select('_id').lean());
    if (existing) {
        logger.info(`${logTag}: payment ${payment.id} already invoiced — skipping`);
        return { applied: false, invoiceCreated: false, alreadyInvoiced: true };
    }

    // The payment must actually pay for the pending plan: right order
    // (fallback Orders path) and at least the plan price. Otherwise a
    // ₹1 capture, or an older cheaper plan order, would unlock whatever
    // plan is currently pending. Skip — nothing applied, nothing
    // invoiced — and leave it for manual reconciliation.
    //
    // With NO pending upgrade the payment can only be a plain renewal of
    // the current plan: it must be INR and pay the current plan's price
    // incl. GST, or a ₹1 plan_payment would extend the term + mint an invoice.
    const pendingUpgrade = restaurant.subscription?.pendingUpgrade;
    let mismatch = '';
    if (payment.currency && payment.currency !== 'INR') {
        mismatch = `unsupported currency ${payment.currency}`;
    } else if (pendingUpgrade && pendingUpgrade.planSlug) {
        mismatch = pendingPaymentMismatch(pendingUpgrade, payment);
    } else {
        const current = Number(restaurant.subscription?.price);
        if (!(Number.isFinite(current) && current > 0)) {
            mismatch = 'no pending upgrade and the current plan has no price to match';
        } else {
            const required = priceWithGst(current).totalPaise;
            if (!(Number(payment.amount) >= required)) {
                mismatch = `no pending upgrade and amount ${payment.amount || 0} paise is below the current plan price incl. GST ${required} paise`;
            }
        }
    }
    if (mismatch) {
        logger.error(`${logTag}: payment ${payment.id} NOT applied to pending upgrade for ${restaurant.slug}: ${mismatch}`);
        return { applied: false, invoiceCreated: false, alreadyInvoiced: false, skipped: true, reason: mismatch };
    }

    const detail = applyPendingUpgradeDetailed(restaurant);
    const applied = detail.applied;
    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayStatus = 'active';
    restaurant.subscription.lastChargedAt = new Date();

    // Orders-API one-shot: no real cycle date from Razorpay, so the paid term
    // is computed here: +1 / +12 / +24 calendar months for the cycle the
    // owner bought. A payment with no pending upgrade is a plain renewal of
    // the current plan, so it extends from the end of the current term.
    const cycle = detail.cycle || normalizeCycle(restaurant.subscription.billingCycle);
    const { periodStart, periodEnd } = paidTermFor(restaurant, {
        cycle,
        renewal: applied ? detail.renewal : true,
    });
    restaurant.subscription.currentPeriodEnd = periodEnd;
    restaurant.subscription.renewalReminderSentFor = [];
    // A paid renewal lifts the soft past_due state a lapsed term put the
    // tenant in (utils/renewalReminderJob). Suspensions are NOT lifted here.
    if (restaurant.subscription.status === 'past_due') restaurant.subscription.status = 'active';
    if (restaurant.status === 'past_due') restaurant.status = 'active';
    await restaurant.save();

    // The tenant just paid: drop the cached tenant (here and on every other
    // instance, same as the trial sweeper's post-lock hook) so the very next
    // request sees the active subscription instead of a cached trial lock.
    try {
        require('../middlewares/tenantContext').invalidateTenant(restaurant._id);
    } catch (err) {
        logger.warn(`${logTag}: tenant cache invalidation failed for ${restaurant.slug}: ${err.message}`);
    }

    if (applied) {
        logger.info(`${logTag}: applied pending upgrade for ${restaurant.slug} → ${restaurant.subscription.planName} (payment ${payment.id})`);
    }

    const created = await createPaidInvoice({
        restaurant, payment, logTag,
        billingCycle: cycle, periodStart, periodEnd,
        razorpaySubscriptionId: '',
    });
    if (created.deduped) return { applied, invoiceCreated: false, alreadyInvoiced: true };
    const invoiceCreated = true;
    const invoiceNumber = created.invoiceNumber;

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
    restaurant.subscription.billingCycle = normalizeCycle(sched.billingCycle);
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
    paidTermFor,
    createPaidInvoice,
    pendingPaymentMismatch,
    applyPendingUpgrade,
    applyPendingUpgradeDetailed,
    applyScheduledDowngrade,
    applyPaidPlanUpgrade,
};
