// Free-trial reminder emails (plan §7): one email (+ in-app notification +
// system note on the signup lead) per reminder TYPE, relative to
// subscription.trialEndDate:
//
//   t-3   3 days before the trial ends
//   t-1   1 day before (ends tomorrow)
//   t+0   trial ended; the account is read-only and locks on trialEndDate +
//         TRIAL_READONLY_GRACE_DAYS
//   t+2   last read-only day before the lock
//
// dueReminder(restaurant, now) is PURE: the single most recent applicable
// type not yet claimed in subscription.trialReminders[], or null. Tenants
// that have paid, are suspended for another reason, cancelled, locked, or
// have no owner email are never due; neither is anything outside the send
// window 09:00-18:00 in restaurant.timezone (the next hourly run catches it).
//
// Claim-then-send: each reminder is claimed with a conditional $push
// ({ type, queuedAt, sentAt: null }, only when no row of that type exists) so
// concurrent instances / restarts send it once. sendEmail never throws - on
// { sent: false } the claim is pulled back and a warning is logged so the next
// run retries. On success sentAt is set, an in-app Notification is created
// and a `kind: 'system'` note is appended to lead.notes without touching
// lead.stage / lastContactedAt.
//
// Env: TRIAL_REMINDERS_ENABLED (default true when NODE_ENV=production, else
// false; legacy TRIAL_REMINDERS_DISABLED=true always wins),
// TRIAL_REMINDERS_DRY_RUN=true (log who would be emailed; send and record
// nothing), TRIAL_REMINDER_INTERVAL_HOURS (default 1).

const Restaurant = require('../models/restaurant');
const Notification = require('../models/notification');
const logger = require('./logger');
const { sendEmail } = require('./email');
const { trialReminder } = require('./emailTemplates');
const { DAY_MS, TRIAL_READONLY_GRACE_DAYS, trialState, hasPaid } = require('./trialLock');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const SEND_WINDOW = { fromHour: 9, toHour: 18 }; // [09:00, 18:00) local time

// Ordered by trigger time (offset from trialEndDate, in days).
const REMINDER_TYPES = [
    { type: 't-3', offsetDays: -3 },
    { type: 't-1', offsetDays: -1 },
    { type: 't+0', offsetDays: 0 },
    { type: 't+2', offsetDays: TRIAL_READONLY_GRACE_DAYS - 1 },
];
const TYPES = REMINDER_TYPES.map((r) => r.type);

function upgradeUrl() {
    return `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')}/admin/subscription`;
}

/** Hour of day (0-23) at `now` in the IANA zone; falls back to Asia/Kolkata. */
function localHour(now, timezone) {
    const read = (tz) => Number(new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', hourCycle: 'h23', timeZone: tz,
    }).format(now));
    try {
        const h = read(timezone || DEFAULT_TIMEZONE);
        if (Number.isFinite(h)) return h;
    } catch (_) { /* unknown zone */ }
    return read(DEFAULT_TIMEZONE);
}

function inSendWindow(now, timezone) {
    const h = localHour(now, timezone);
    return h >= SEND_WINDOW.fromHour && h < SEND_WINDOW.toHour;
}

/** Trigger time of one reminder type for a trial ending at `trialEndDate`. */
function triggerAt(type, trialEndDate) {
    const def = REMINDER_TYPES.find((r) => r.type === type);
    return new Date(new Date(trialEndDate).getTime() + def.offsetDays * DAY_MS);
}

/**
 * Pure: which reminder is due for this tenant at `now`?
 * @returns {string|null} 't-3' | 't-1' | 't+0' | 't+2' | null
 */
function dueReminder(restaurant, now = new Date()) {
    if (!restaurant) return null;
    const sub = restaurant.subscription || {};
    if (!restaurant.contactEmail) return null;
    if (hasPaid(sub) || sub.status === 'cancelled') return null;
    const st = trialState(restaurant, now);
    if (st.state !== 'active' && st.state !== 'read_only') return null;
    if (!inSendWindow(now, restaurant.timezone)) return null;

    const end = new Date(sub.trialEndDate).getTime();
    const t = now.getTime();
    let latest = null;
    for (const r of REMINDER_TYPES) {
        if (end + r.offsetDays * DAY_MS <= t) latest = r.type;
    }
    if (!latest) return null;
    const claimed = (sub.trialReminders || []).some((row) => row && row.type === latest);
    return claimed ? null : latest;
}

/** Human copy per type. `daysLeft` is whole days to trialEndDate. */
function describe(type, { daysLeft, lockAt, timezone }) {
    const lockDate = formatDate(lockAt, timezone);
    switch (type) {
        case 't-3':
            return {
                note: `Auto email: trial ends in ${daysLeft} days`,
                title: `Your free trial ends in ${daysLeft} days`,
                body: 'Upgrade now to keep your restaurant running without interruption.',
            };
        case 't-1':
            return {
                note: 'Auto email: trial ends tomorrow',
                title: 'Your free trial ends tomorrow',
                body: 'Upgrade now to keep your restaurant running without interruption.',
            };
        case 't+0':
            return {
                note: `Auto email: trial ended, locks on ${lockDate}`,
                title: 'Your free trial has ended - account is read-only',
                body: `You can view everything but not make changes. Your account locks on ${lockDate}. Upgrade to continue.`,
            };
        case 't+2':
        default:
            return {
                note: 'Auto email: last day before lock',
                title: 'Last day before your account locks',
                body: `Your account locks on ${lockDate}. Upgrade now to keep your data and your staff working.`,
            };
    }
}

function formatDate(d, timezone) {
    if (!d) return '';
    try {
        return new Intl.DateTimeFormat('en-IN', {
            day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone || DEFAULT_TIMEZONE,
        }).format(new Date(d));
    } catch (_) {
        return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: DEFAULT_TIMEZONE })
            .format(new Date(d));
    }
}

// Still a live, unpaid trial: the claim and the sentAt update both re-check
// this so a tenant that pays mid-run never gets the mail.
function unpaidTrialFilter() {
    return {
        status: 'trial',
        'subscription.status': { $nin: ['active', 'cancelled', 'expired'] },
        'subscription.lastChargedAt': null,
    };
}

async function claim(model, tenantId, type, now) {
    const res = await model.updateOne(
        { _id: tenantId, ...unpaidTrialFilter(), 'subscription.trialReminders.type': { $ne: type } },
        { $push: { 'subscription.trialReminders': { type, queuedAt: now, sentAt: null } } },
    );
    return (res.modifiedCount ?? res.nModified) === 1;
}

async function release(model, tenantId, type) {
    await model.updateOne({ _id: tenantId }, { $pull: { 'subscription.trialReminders': { type } } })
        .catch((err) => logger.warn(`trial reminder: could not release claim ${type} for ${tenantId}: ${err.message}`));
}

async function markSent(model, tenantId, type, now) {
    await model.updateOne(
        { _id: tenantId, 'subscription.trialReminders.type': type },
        { $set: { 'subscription.trialReminders.$.sentAt': now } },
    );
}

async function appendLeadNote(model, tenantId, text, now) {
    // $push only: lead is select:false and stage / lastContactedAt stay as they are.
    try {
        await model.updateOne({ _id: tenantId }, {
            $push: { 'lead.notes': { text, by: null, byName: 'System', at: now, kind: 'system' } },
        });
    } catch (err) {
        logger.warn(`trial reminder: lead note failed for ${tenantId}: ${err.message}`);
    }
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

/** Cheap "what you have set up" counts for the email; never throws. */
async function setupCounts(tenantId) {
    try {
        const MenuItem = require('../models/menuItem');
        const User = require('../models/user');
        const [menuItemCount, staffCount, admin] = await Promise.all([
            MenuItem.countDocuments({ restaurant: tenantId }),
            User.countDocuments({ restaurant: tenantId, role: { $ne: 'customer' } }),
            User.findOne({ restaurant: tenantId, role: 'admin' }).sort({ createdAt: 1 }).select('name').lean(),
        ]);
        return { menuItemCount, staffCount, adminName: admin?.name || '' };
    } catch (err) {
        logger.warn(`trial reminder: counts failed for ${tenantId}: ${err.message}`);
        return { menuItemCount: null, staffCount: null, adminName: '' };
    }
}

function supportEmail() {
    return process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || '';
}

/** Tenants that could be due anything right now (dueReminder decides). */
function candidateFilter(now) {
    const earliest = Math.min(...REMINDER_TYPES.map((r) => r.offsetDays));
    return {
        ...unpaidTrialFilter(),
        'subscription.trialEndDate': {
            // not yet locked ... first reminder already triggered
            $gt: new Date(now.getTime() - TRIAL_READONLY_GRACE_DAYS * DAY_MS),
            $lte: new Date(now.getTime() - earliest * DAY_MS),
        },
    };
}

/**
 * One run: claim + send every due reminder.
 * @returns {Promise<{ checked: number, sent: Array<{ id: string, type: string }>,
 *   failed: Array<{ id: string, type: string, error: string }>, dryRun: Array<{ id: string, type: string }> }>}
 */
async function runTrialReminders({ now = new Date(), model = Restaurant, dryRun = isDryRun() } = {}) {
    const candidates = await model.find(candidateFilter(now))
        .select('_id slug name contactEmail timezone status signupMeta subscription.trialEndDate subscription.trialReminders subscription.status subscription.lastChargedAt')
        .lean();

    const out = { checked: candidates.length, sent: [], failed: [], dryRun: [] };
    for (const t of candidates) {
        const type = dueReminder(t, now);
        if (!type) continue;
        if (dryRun) {
            logger.info(`[trial reminders dry-run] would send ${type} to ${t.contactEmail} (${t.slug})`);
            out.dryRun.push({ id: String(t._id), type });
            continue;
        }
        if (!(await claim(model, t._id, type, now))) continue;

        const st = trialState(t, now);
        const counts = await setupCounts(t._id);
        const copy = describe(type, { daysLeft: st.daysLeft, lockAt: st.lockAt, timezone: t.timezone });
        const mail = trialReminder({
            type,
            ownerName: t.signupMeta?.ownerName || counts.adminName || '',
            restaurantName: t.name,
            daysLeft: st.daysLeft,
            trialEndDate: st.trialEndDate,
            lockAt: st.lockAt,
            upgradeUrl: upgradeUrl(),
            menuItemCount: counts.menuItemCount,
            staffCount: counts.staffCount,
            supportEmail: supportEmail(),
            timezone: t.timezone,
        });

        let result;
        try {
            result = await sendEmail({ to: t.contactEmail, ...mail });
        } catch (err) {
            result = { sent: false, error: err.message };
        }
        if (!result || !result.sent) {
            await release(model, t._id, type);
            const why = result?.error || (result?.dev ? 'no email transport configured' : 'unknown');
            logger.warn(`trial reminder ${type} NOT sent to ${t.contactEmail} (${t.slug}); will retry next run: ${why}`);
            out.failed.push({ id: String(t._id), type, error: why });
            continue;
        }

        await markSent(model, t._id, type, now);
        await notifyInApp(t, copy.title, copy.body);
        await appendLeadNote(model, t._id, copy.note, now);
        out.sent.push({ id: String(t._id), type });
    }
    return out;
}

function isDryRun() {
    return /^(1|true|yes|on)$/i.test(String(process.env.TRIAL_REMINDERS_DRY_RUN || '').trim());
}

function remindersEnabled() {
    if (process.env.TRIAL_REMINDERS_DISABLED === 'true') return false;
    const v = String(process.env.TRIAL_REMINDERS_ENABLED ?? '').trim();
    if (!v) return process.env.NODE_ENV === 'production';
    return /^(1|true|yes|on)$/i.test(v);
}

function startTrialReminderJob() {
    if (!remindersEnabled()) {
        logger.info('Trial reminders disabled (TRIAL_REMINDERS_ENABLED is false, or TRIAL_REMINDERS_DISABLED=true)');
        return null;
    }
    const hours = Number(process.env.TRIAL_REMINDER_INTERVAL_HOURS) || 1;
    if (isDryRun()) logger.info('Trial reminders running in DRY RUN mode (TRIAL_REMINDERS_DRY_RUN=true): nothing is sent or recorded');
    return require('./scheduler').scheduleJob('trial-reminders', hours * 60 * 60 * 1000, () => runTrialReminders());
}

module.exports = {
    TYPES,
    REMINDER_TYPES,
    SEND_WINDOW,
    dueReminder,
    triggerAt,
    inSendWindow,
    localHour,
    candidateFilter,
    runTrialReminders,
    remindersEnabled,
    isDryRun,
    startTrialReminderJob,
};
