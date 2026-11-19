// Free-trial expiry sweeper (plan §6).
//
// Locks every tenant whose trial ended unpaid AND whose read-only grace
// window is over: status 'trial' with subscription.trialEndDate +
// TRIAL_READONLY_GRACE_DAYS in the past becomes status 'suspended' +
// subscription.status 'expired' + trialExpiredAt (data is kept; see
// utils/trialLock for what the owner can still reach). Between trialEndDate
// and lockAt the tenant is read-only - that is enforced per request from the
// dates (trialLock.trialState), so this job only has to flip the final lock.
// Includes trials a Super Admin created. Tenants that paid (subscription
// active / charged) are skipped.
//
// Safe on several instances and safe to re-run: each tenant is flipped with
// a conditional update that re-checks the due conditions, so only one
// instance wins and a second run finds nothing. Paying clears trialEndDate
// and activates the subscription (utils/planPaymentApply), which also
// removes the tenant from the due set.
//
// No email is sent here: the "trial ended" (t+0) and "last day before lock"
// (t+2) notices belong to utils/trialReminderJob, so the lock never produces
// a second mail.
//
// Disable with TRIAL_SWEEP_DISABLED=true. Interval: TRIAL_SWEEP_INTERVAL_MINUTES
// (default 60).

const Restaurant = require('../models/restaurant');
const logger = require('./logger');
const { TRIAL_LOCK_REASON, TRIAL_READONLY_GRACE_DAYS, DAY_MS } = require('./trialLock');

const SWEEP_INTERVAL_MINUTES_DEFAULT = 60;

/** Trials whose lockAt (= trialEndDate + grace) is strictly before `now`. */
function lockDueBefore(now) {
    return new Date(now.getTime() - TRIAL_READONLY_GRACE_DAYS * DAY_MS);
}

function dueFilter(now) {
    return {
        status: 'trial',
        'subscription.trialEndDate': { $lt: lockDueBefore(now) },
        'subscription.status': { $nin: ['active', 'cancelled', 'expired'] },
        'subscription.lastChargedAt': null, // missing or null = never charged
    };
}

/**
 * @param {object} [opts]
 * @param {Date}   [opts.now]      injectable clock (tests)
 * @param {function} [opts.onLocked] called with each locked tenant (tenant
 *   cache invalidation) - failures are logged, never thrown.
 * @returns {Promise<{ checked: number, locked: string[] }>}
 */
async function runTrialExpirySweep({ now = new Date(), model = Restaurant, onLocked } = {}) {
    const due = dueFilter(now);
    const candidates = await model.find(due).select('_id slug').lean();
    const locked = [];
    for (const c of candidates) {
        const updated = await model.findOneAndUpdate(
            { _id: c._id, ...due },
            {
                $set: {
                    status: 'suspended',
                    suspendedAt: now,
                    suspendedReason: TRIAL_LOCK_REASON,
                    'subscription.status': 'expired',
                    'subscription.trialExpiredAt': now,
                },
            },
            { returnDocument: 'after' },
        );
        if (!updated) continue;
        locked.push(String(updated._id));
        logger.info(`Free trial ended for ${updated.slug} - tenant locked`);
        if (onLocked) {
            try {
                await onLocked(updated);
            } catch (err) {
                logger.warn(`Post-lock hook failed for ${updated.slug}: ${err.message}`);
            }
        }
    }
    return { checked: candidates.length, locked };
}

/** Start the interval job (cluster-locked through utils/scheduler). */
function startTrialExpirySweeper() {
    if (process.env.TRIAL_SWEEP_DISABLED === 'true') {
        logger.info('Trial expiry sweeper disabled (TRIAL_SWEEP_DISABLED=true)');
        return null;
    }
    const minutes = Number(process.env.TRIAL_SWEEP_INTERVAL_MINUTES) || SWEEP_INTERVAL_MINUTES_DEFAULT;
    const scheduler = require('./scheduler');
    return scheduler.scheduleJob('trial-expiry-sweeper', minutes * 60 * 1000, () =>
        runTrialExpirySweep({
            onLocked: async (tenant) => {
                // Drop the cached tenant so the next request sees the lock.
                const { invalidateTenant } = require('../middlewares/tenantContext');
                invalidateTenant(tenant._id);
            },
        }));
}

module.exports = { lockDueBefore, dueFilter, runTrialExpirySweep, startTrialExpirySweeper };
