// Free-trial reminders: email (+ in-app notification) to the owner 7, 3 and
// 1 days before trialEndDate and once when the trial ends (sent by the
// sweeper via sendExpiryNotice).
//
// Dedupe: subscription.trialRemindersSent holds the thresholds already sent
// (0 = expiry notice). A threshold is CLAIMED with a conditional $addToSet
// before sending, so concurrent instances / re-runs send it once; a failed
// send releases the claim so the next run retries. If a tenant is already
// past several thresholds (downtime, short trial) only the nearest one is
// sent and the earlier ones are marked as sent.
//
// Disable with TRIAL_REMINDERS_DISABLED=true. Interval:
// TRIAL_REMINDER_INTERVAL_HOURS (default 24).

const Restaurant = require('../models/restaurant');
const Notification = require('../models/notification');
const logger = require('./logger');
const { sendEmail } = require('./email');
const { trialEndingSoon, trialEnded } = require('./emailTemplates');
const { DAY_MS } = require('./trialLock');

const THRESHOLDS = [7, 3, 1];

function upgradeUrl() {
    return `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')}/admin/subscription`;
}

async function notifyInApp(tenant, title, description) {
    try {
        await Notification.create({
            restaurant: tenant._id,
            recipientRole: 'admin',
            title,
            description,
            category: 'System',
            priority: 'high',
        });
    } catch (err) {
        logger.warn(`trial in-app notification failed for ${tenant.slug}: ${err.message}`);
    }
}

async function claim(model, tenant, threshold, alsoMark = []) {
    const won = await model.findOneAndUpdate(
        { _id: tenant._id, 'subscription.trialRemindersSent': { $ne: threshold } },
        { $addToSet: { 'subscription.trialRemindersSent': { $each: [threshold, ...alsoMark] } } },
        { returnDocument: 'after' },
    );
    return !!won;
}

async function release(model, tenant, threshold) {
    await model.updateOne({ _id: tenant._id }, { $pull: { 'subscription.trialRemindersSent': threshold } })
        .catch(() => {});
}

/** "Your trial has ended" - email + in-app, once. Never throws. */
async function sendExpiryNotice(tenant, { model = Restaurant } = {}) {
    try {
        if (!(await claim(model, tenant, 0))) return false;
        try {
            await sendEmail({
                to: tenant.contactEmail,
                ...trialEnded({
                    restaurantName: tenant.name,
                    ownerName: tenant.signupMeta?.ownerName || '',
                    upgradeUrl: upgradeUrl(),
                }),
            });
        } catch (err) {
            await release(model, tenant, 0);
            throw err;
        }
        await notifyInApp(tenant, 'Your free trial has ended',
            'Upgrade your plan to restore access. All your data is safe.');
        return true;
    } catch (err) {
        logger.warn(`trial expiry notice failed for ${tenant.slug}: ${err.message}`);
        return false;
    }
}

/**
 * Send the 7/3/1-day reminders that are due.
 * @returns {Promise<{ checked: number, sent: Array<{ id: string, days: number }> }>}
 */
async function runTrialReminders({ now = new Date(), model = Restaurant } = {}) {
    const horizon = new Date(now.getTime() + THRESHOLDS[0] * DAY_MS);
    const candidates = await model.find({
        status: 'trial',
        'subscription.trialEndDate': { $gt: now, $lte: horizon },
        'subscription.status': { $nin: ['active', 'cancelled', 'expired'] },
        'subscription.lastChargedAt': null,
    }).select('_id slug name contactEmail signupMeta subscription.trialEndDate subscription.trialRemindersSent').lean();

    const sent = [];
    for (const t of candidates) {
        const daysLeft = Math.ceil((new Date(t.subscription.trialEndDate).getTime() - now.getTime()) / DAY_MS);
        const threshold = [...THRESHOLDS].reverse().find((d) => daysLeft <= d);
        if (!threshold) continue;
        if ((t.subscription.trialRemindersSent || []).includes(threshold)) continue;
        const earlier = THRESHOLDS.filter((d) => d > threshold);
        if (!(await claim(model, t, threshold, earlier))) continue;
        try {
            await sendEmail({
                to: t.contactEmail,
                ...trialEndingSoon({
                    restaurantName: t.name,
                    ownerName: t.signupMeta?.ownerName || '',
                    daysLeft: threshold,
                    trialEndDate: t.subscription.trialEndDate,
                    upgradeUrl: upgradeUrl(),
                }),
            });
        } catch (err) {
            await release(model, t, threshold);
            logger.warn(`trial reminder email failed for ${t.slug}: ${err.message}`);
            continue;
        }
        await notifyInApp(t, `Your free trial ends in ${threshold} day${threshold === 1 ? '' : 's'}`,
            'Upgrade now to keep your restaurant running without interruption.');
        sent.push({ id: String(t._id), days: threshold });
    }
    return { checked: candidates.length, sent };
}

function startTrialReminderJob() {
    if (process.env.TRIAL_REMINDERS_DISABLED === 'true') {
        logger.info('Trial reminders disabled (TRIAL_REMINDERS_DISABLED=true)');
        return null;
    }
    const hours = Number(process.env.TRIAL_REMINDER_INTERVAL_HOURS) || 24;
    return require('./scheduler').scheduleJob('trial-reminders', hours * 60 * 60 * 1000, () => runTrialReminders());
}

module.exports = { THRESHOLDS, runTrialReminders, sendExpiryNotice, startTrialReminderJob };
