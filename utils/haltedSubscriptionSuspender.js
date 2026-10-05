// Grace-period suspension for halted subscriptions (product decision 5,
// 2026-10 — CRIT-18).
//
// Why this exists:
//   When Razorpay gives up retrying a subscription charge it sends
//   `subscription.halted`. Suspending the tenant on that single event
//   locked restaurants out mid-service over a temporary card problem.
//   The webhook now marks the tenant `past_due`, records the halt
//   (subscription.haltedCount / firstHaltedAt) and schedules the lockout
//   for 24 hours later in subscription.scheduledSuspendAt. A successful
//   `subscription.charged` in between clears the schedule.
//
// What it does:
//   Suspends every tenant that is still `past_due`, whose Razorpay status
//   is still `halted`, and whose scheduledSuspendAt has passed. Each
//   tenant is flipped with a conditional update, so a charge that lands
//   at the same moment (which clears the schedule) always wins.
//
// Disable with HALTED_SUSPEND_DISABLED=true (e.g. to run it from an
// external cron instead).

const Restaurant = require('../models/restaurant');
const logger = require('./logger');

const GRACE_HOURS = 24;
const SWEEP_INTERVAL_MINUTES_DEFAULT = 15;
const SUSPEND_REASON = 'Payment failed — subscription halted by Razorpay';

/** When a tenant halted at `at` gets locked out. */
function scheduledSuspendAtFor(at = new Date()) {
    return new Date(at.getTime() + GRACE_HOURS * 60 * 60 * 1000);
}

/**
 * Suspend every tenant whose grace period has ended.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now]       injectable clock (tests)
 * @param {object} [opts.model]     injectable Restaurant model (tests)
 * @param {function} [opts.onSuspended] called with each suspended tenant
 *   (cache invalidation / alerts) — failures are logged, never thrown.
 * @returns {Promise<{ checked: number, suspended: string[] }>}
 */
async function runHaltedSuspension({ now = new Date(), model = Restaurant, onSuspended } = {}) {
    const due = {
        status: 'past_due',
        'subscription.razorpayStatus': 'halted',
        'subscription.scheduledSuspendAt': { $lte: now },
    };
    const candidates = await model.find(due).select('_id slug').lean();
    const suspended = [];

    for (const c of candidates) {
        // Re-check the same conditions atomically: a subscription.charged
        // that cleared the schedule in the meantime must not be overridden.
        const updated = await model.findOneAndUpdate(
            { _id: c._id, ...due },
            {
                $set: { status: 'suspended', suspendedAt: now, suspendedReason: SUSPEND_REASON },
                $unset: { 'subscription.scheduledSuspendAt': '' },
            },
            { returnDocument: 'after' },
        );
        if (!updated) continue;
        suspended.push(String(updated._id));
        logger.warn(`Halted subscription grace period ended for ${updated.slug} — tenant suspended`);
        if (onSuspended) {
            try {
                await onSuspended(updated);
            } catch (err) {
                logger.warn(`Post-suspend hook failed for ${updated.slug}: ${err.message}`);
            }
        }
    }

    return { checked: candidates.length, suspended };
}

/** Start the interval job (cluster-locked through utils/scheduler). */
function startHaltedSubscriptionSuspender() {
    if (process.env.HALTED_SUSPEND_DISABLED === 'true') {
        logger.info('Halted-subscription suspender disabled (HALTED_SUSPEND_DISABLED=true)');
        return null;
    }
    const minutes = Number(process.env.HALTED_SUSPEND_INTERVAL_MINUTES) || SWEEP_INTERVAL_MINUTES_DEFAULT;
    const scheduler = require('./scheduler');
    return scheduler.scheduleJob('halted-subscription-suspender', minutes * 60 * 1000, () =>
        runHaltedSuspension({
            onSuspended: (tenant) => {
                const { invalidateTenant } = require('../middlewares/tenantContext');
                invalidateTenant(tenant._id);
            },
        }));
}

module.exports = {
    GRACE_HOURS,
    SUSPEND_REASON,
    scheduledSuspendAtFor,
    runHaltedSuspension,
    startHaltedSubscriptionSuspender,
};
