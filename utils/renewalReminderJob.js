// Renewal reminders + lapse rule for paid terms that do NOT auto-renew.
//
// Who is covered:
//   - annual / biennial tenants (prepaid terms; a Razorpay yearly plan may
//     auto-renew, but a one-time-Order purchase never does), and
//   - any tenant paying by one-time Razorpay Orders (monthly included),
// i.e. every tenant with a paid `subscription.currentPeriodEnd` and no LIVE
// recurring Razorpay subscription. Tenants on a live auto-renewing
// subscription are never emailed and never lapsed by this job (Razorpay's
// own charge / halted events drive them).
//
// 1. Reminders: an email 7 and 1 days before currentPeriodEnd. Dedupe in
//    subscription.renewalReminderSentFor as `<ISO period end>:<days>` markers;
//    a marker is CLAIMED with a conditional $addToSet before sending (so
//    concurrent instances send once) and released if the send fails. If a
//    tenant is already within 1 day only that reminder is sent (the 7-day
//    marker is recorded as sent too). Paying a renewal resets the list
//    (utils/planPaymentApply / webhook), and a new period end makes new markers.
//
// 2. Lapse rule: once currentPeriodEnd + LAPSE_GRACE_DAYS (3) has passed and
//    there is still no live recurring subscription, an `active` tenant is
//    flipped to `past_due` (tenant status AND subscription.status). This reuses
//    the existing halted / past_due state: `past_due` is a SOFT state (the
//    owner keeps working and sees the pay-now banner); this job invents no new
//    lock. HOW IT COMBINES WITH THE TRIAL LOCK: the TRIAL_EXPIRED lock
//    (utils/trialLock, owned by the trial module) applies only to free trials
//    (subscription.status 'trial' -> 'expired', tenant `suspended`); this job
//    ignores trials entirely, and the trial sweeper ignores tenants that have
//    ever paid. A tenant is therefore in exactly one of: trial -> expired
//    (hard lock) or paid -> past_due (soft). A payment of either kind returns
//    the tenant to `active` (applyPaidPlanUpgrade / webhook subscription.charged
//    / the Restaurant pre-save hook for the trial lock). If product later wants
//    a hard lock for lapsed paid terms, extend haltedSubscriptionSuspender with
//    this state rather than adding a second mechanism.
//
// 3. Scheduled downgrades whose effectiveAt (the paid term end) has passed are
//    applied here too, so prepaid terms never depend on Razorpay's `completed`
//    event timing (applyScheduledDowngrade, same helper the page-load check uses).
//
// Disable with RENEWAL_REMINDERS_DISABLED=true. Interval:
// RENEWAL_REMINDER_INTERVAL_HOURS (default 24).

const Restaurant = require('../models/restaurant');
const logger = require('./logger');
const { sendEmail } = require('./email');
const { renewalReminder } = require('./emailTemplates');
const { normalizeCycle } = require('./billingCycles');
const { applyScheduledDowngrade } = require('./planPaymentApply');

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLDS = [7, 1];
const LAPSE_GRACE_DAYS = 3;

// A live recurring subscription (Razorpay charges the owner by itself).
const LIVE_RZP_STATUSES = ['created', 'authenticated', 'active', 'pending'];

function hasLiveRecurringSub(sub) {
    return !!sub?.razorpaySubscriptionId && LIVE_RZP_STATUSES.includes(sub?.razorpayStatus || '');
}

function renewUrl() {
    return `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')}/admin/subscription`;
}

const marker = (end, days) => `${new Date(end).toISOString()}:${days}`;

async function claim(model, tenant, markers) {
    const won = await model.findOneAndUpdate(
        { _id: tenant._id, 'subscription.renewalReminderSentFor': { $ne: markers[0] } },
        { $addToSet: { 'subscription.renewalReminderSentFor': { $each: markers } } },
        { returnDocument: 'after' },
    );
    return !!won;
}

async function release(model, tenant, markers) {
    await model.updateOne({ _id: tenant._id }, { $pull: { 'subscription.renewalReminderSentFor': { $in: markers } } })
        .catch(() => {});
}

/**
 * Email the reminders that are due.
 * @returns {Promise<{ checked: number, sent: Array<{ id: string, days: number }> }>}
 */
async function runRenewalReminders({ now = new Date(), model = Restaurant } = {}) {
    const horizon = new Date(now.getTime() + THRESHOLDS[0] * DAY_MS);
    const candidates = await model.find({
        status: { $in: ['active', 'past_due'] },
        'subscription.status': { $in: ['active', 'past_due'] },
        'subscription.currentPeriodEnd': { $gt: now, $lte: horizon },
    }).select('_id slug name contactEmail signupMeta subscription').lean();

    const sent = [];
    let checked = 0;
    for (const t of candidates) {
        if (hasLiveRecurringSub(t.subscription)) continue;
        checked += 1;
        const end = new Date(t.subscription.currentPeriodEnd);
        const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
        const threshold = [...THRESHOLDS].reverse().find((d) => daysLeft <= d);
        if (!threshold) continue;
        const already = t.subscription.renewalReminderSentFor || [];
        if (already.includes(marker(end, threshold))) continue;
        const markers = [threshold, ...THRESHOLDS.filter((d) => d > threshold)].map((d) => marker(end, d));
        if (!(await claim(model, t, markers))) continue;
        try {
            await sendEmail({
                to: t.contactEmail,
                ...renewalReminder({
                    restaurantName: t.name,
                    ownerName: t.signupMeta?.ownerName || '',
                    planName: t.subscription.planName || '',
                    billingCycle: normalizeCycle(t.subscription.billingCycle),
                    daysLeft: threshold,
                    periodEnd: end,
                    renewUrl: renewUrl(),
                }),
            });
        } catch (err) {
            await release(model, t, markers);
            logger.warn(`renewal reminder email failed for ${t.slug}: ${err.message}`);
            continue;
        }
        sent.push({ id: String(t._id), days: threshold });
    }
    return { checked, sent };
}

/**
 * Flip lapsed paid terms to past_due (soft, see header).
 * @returns {Promise<{ checked: number, lapsed: string[] }>}
 */
async function runLapseCheck({ now = new Date(), model = Restaurant, onLapsed } = {}) {
    const cutoff = new Date(now.getTime() - LAPSE_GRACE_DAYS * DAY_MS);
    const due = {
        status: 'active',
        'subscription.status': 'active',
        'subscription.currentPeriodEnd': { $lte: cutoff },
    };
    const candidates = await model.find(due).select('_id slug subscription.razorpaySubscriptionId subscription.razorpayStatus').lean();
    const lapsed = [];
    for (const c of candidates) {
        if (hasLiveRecurringSub(c.subscription)) continue;
        // Conditional: a payment that landed in the meantime moved the period end.
        const updated = await model.findOneAndUpdate(
            { _id: c._id, ...due },
            { $set: { status: 'past_due', 'subscription.status': 'past_due' } },
            { returnDocument: 'after' },
        );
        if (!updated) continue;
        lapsed.push(String(updated._id));
        logger.warn(`Paid term lapsed for ${updated.slug} (period end + ${LAPSE_GRACE_DAYS}d passed, no live subscription) - past_due`);
        if (onLapsed) {
            try { await onLapsed(updated); } catch (err) { logger.warn(`Post-lapse hook failed for ${updated.slug}: ${err.message}`); }
        }
    }
    return { checked: candidates.length, lapsed };
}

/** Apply scheduled downgrades whose paid term has ended. */
async function runDueDowngrades({ now = new Date(), model = Restaurant, onApplied } = {}) {
    const candidates = await model.find({ 'subscription.scheduledDowngrade.effectiveAt': { $lte: now } }).select('_id');
    const applied = [];
    for (const c of candidates) {
        const doc = await model.findById(c._id);
        if (!doc) continue;
        const r = applyScheduledDowngrade(doc);
        if (!r.applied) continue;
        await doc.save();
        applied.push(String(doc._id));
        logger.info(`Scheduled downgrade applied for ${doc.slug} -> ${doc.subscription.planName}`);
        if (onApplied) {
            try { await onApplied(doc); } catch (err) { logger.warn(`Post-downgrade hook failed for ${doc.slug}: ${err.message}`); }
        }
    }
    return { applied };
}

async function runRenewalJob(opts = {}) {
    const invalidate = (tenant) => {
        try { require('../middlewares/tenantContext').invalidateTenant(tenant._id); } catch (_) { /* cache only */ }
    };
    const reminders = await runRenewalReminders(opts);
    const lapse = await runLapseCheck({ ...opts, onLapsed: invalidate });
    const downgrades = await runDueDowngrades({ ...opts, onApplied: invalidate });
    return { reminders, lapse, downgrades };
}

function startRenewalReminderJob() {
    if (process.env.RENEWAL_REMINDERS_DISABLED === 'true') {
        logger.info('Renewal reminders disabled (RENEWAL_REMINDERS_DISABLED=true)');
        return null;
    }
    const hours = Number(process.env.RENEWAL_REMINDER_INTERVAL_HOURS) || 24;
    return require('./scheduler').scheduleJob('renewal-reminders', hours * 60 * 60 * 1000, () => runRenewalJob());
}

module.exports = {
    THRESHOLDS,
    LAPSE_GRACE_DAYS,
    hasLiveRecurringSub,
    runRenewalReminders,
    runLapseCheck,
    runDueDowngrades,
    runRenewalJob,
    startRenewalReminderJob,
};
