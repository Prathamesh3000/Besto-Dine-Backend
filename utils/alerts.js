/**
 * Platform-level alerting for Super Admin operators.
 *
 * Sends email notifications when a tenant hits a condition that needs
 * human attention — halted subscription, cancelled subscription, or a
 * tenant going silently dormant.
 *
 * Design notes:
 *
 *   1. **Idempotency via AuditLog.** We don't track "last alerted at"
 *      on the Restaurant because that'd need another schema field AND
 *      a migration. Instead we query the AuditLog for recent
 *      `tenant.alert.*` entries on the same target. Append-only,
 *      already audited, gives us the alert history for free.
 *
 *   2. **Recipient resolution.** `SUPERADMIN_ALERT_EMAILS` env var
 *      (comma-separated) takes priority. If unset, we fall back to
 *      every User with role === 'superadmin'. In dev with no email
 *      provider configured, utils/email.js logs to console — alerts
 *      are therefore safe to call even without SendGrid creds.
 *
 *   3. **Never throw from the notifier.** Alert failures must NEVER
 *      break the webhook handler or the scheduled job. Every public
 *      function wraps its body in try/catch and just logs on failure.
 *
 *   4. **Dormancy window.** An active-or-trial tenant with zero
 *      orders in the last DORMANCY_DAYS days is alerted ONCE per
 *      DORMANCY_COOLDOWN_DAYS so the operator doesn't get the same
 *      ping every day while they work the account.
 */

const mongoose = require('mongoose');
const logger = require('./logger');
const { sendEmail } = require('./email');
const Restaurant = require('../models/restaurant');
const User = require('../models/user');
const Order = require('../models/order');
const AuditLog = require('../models/auditLog');

const DORMANCY_DAYS = 7;
const DORMANCY_COOLDOWN_DAYS = 7;

// Alert types — one per action key written to the audit log. Keeping
// them as constants makes the idempotency queries self-documenting.
const ALERT = {
    HALTED:    'tenant.alert.halted',
    CANCELLED: 'tenant.alert.cancelled',
    DORMANT:   'tenant.alert.dormant',
};

/**
 * Resolve the list of email addresses to notify. Returns an array of
 * deduped lowercase strings. May return [] if no recipients are
 * configured — callers should handle that gracefully.
 */
async function resolveRecipients() {
    const envList = (process.env.SUPERADMIN_ALERT_EMAILS || '').trim();
    if (envList) {
        return [...new Set(
            envList.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        )];
    }
    // Fallback: every active Super Admin in the User collection.
    const admins = await User.find({ role: 'superadmin' }).select('email').lean();
    return [...new Set(admins.map(a => (a.email || '').toLowerCase()).filter(Boolean))];
}

/**
 * Has an alert of this type been written against this tenant within
 * the cooldown window? Returns true if we should SKIP sending.
 */
async function alertedRecently(action, tenantId, cooldownDays) {
    const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
    const existing = await AuditLog.findOne({
        action,
        targetId: tenantId,
        createdAt: { $gte: since },
    }).select('_id').lean();
    return Boolean(existing);
}

/**
 * Build the link to the tenant's detail page. Uses FRONTEND_URL from
 * env (same var the welcome email uses) so dev and prod link to the
 * right host. Falls back to a relative path if unset so the email
 * still makes sense when opened in-situ.
 */
function tenantLink(restaurantId) {
    const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    const path = `/superadmin/restaurants/${restaurantId}`;
    return base ? `${base}${path}` : path;
}

/**
 * Core send helper — resolves recipients, writes an audit record,
 * sends the mail. Returns `true` if sent, `false` if skipped
 * (idempotency, no recipients, send failure — all log the reason).
 */
async function sendAlert({ action, restaurant, subject, body, detailsExtra = {} }) {
    try {
        // 1. Idempotency
        if (await alertedRecently(action, restaurant._id, DORMANCY_COOLDOWN_DAYS)) {
            logger.info(`alert skipped (recent) ${action} ${restaurant.slug}`);
            return false;
        }

        // 2. Recipients
        const recipients = await resolveRecipients();
        if (recipients.length === 0) {
            logger.warn(`alert skipped (no recipients configured) ${action} ${restaurant.slug}`);
            return false;
        }

        // 3. Audit first so we retain the record even if email fails.
        //    targetId is indexed so the idempotency query above is O(log N).
        await AuditLog.create({
            actor: null,
            actorEmail: 'system-alerts',
            actorRole: 'system',
            action,
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { recipients, ...detailsExtra },
        });

        // 4. Email — fire and forget, but log failures with stack.
        //    utils/email.js already handles provider selection (sendgrid
        //    / resend / mailgun / dev-console fallback).
        for (const to of recipients) {
            try {
                await sendEmail({ to, subject, html: body, text: body.replace(/<[^>]+>/g, '') });
            } catch (err) {
                logger.error(`alert email failed for ${to}: ${err.message}`);
            }
        }
        logger.info(`alert sent ${action} ${restaurant.slug} → ${recipients.length} recipient(s)`);
        return true;
    } catch (err) {
        // Absolutely never throw out of this module.
        logger.error(`alert error ${action}: ${err.message}`);
        return false;
    }
}

// ─── Public notifiers ─────────────────────────────────────────────────

/**
 * A tenant's Razorpay subscription has halted (payment failures
 * exhausted retries). The webhook handler has already auto-suspended
 * the tenant; this adds an out-of-band email ping.
 */
async function notifyTenantHalted(restaurant) {
    return sendAlert({
        action: ALERT.HALTED,
        restaurant,
        subject: `[BestoDine] Subscription halted — ${restaurant.name}`,
        body: `
<p><strong>${restaurant.name}</strong> has had its Razorpay subscription halted.</p>
<p>The tenant has been auto-suspended and staff are now locked out until
the payment is recovered. You may want to contact the owner to recover
the subscription or authorize a new payment method.</p>
<ul>
  <li>Tenant: ${restaurant.name} (${restaurant.slug})</li>
  <li>Owner email: ${restaurant.contactEmail || '—'}</li>
  <li>Plan: ${restaurant.subscription?.planName || '—'}</li>
  <li>Suspended at: ${new Date().toISOString()}</li>
</ul>
<p><a href="${tenantLink(restaurant._id)}">Open tenant in Super Admin →</a></p>
        `.trim(),
        detailsExtra: {
            reason: 'subscription.halted',
            plan: restaurant.subscription?.planName || '',
        },
    });
}

/**
 * Subscription was cancelled (either by the customer through Razorpay
 * or by the Super Admin explicitly). Tenant keeps access until the
 * period end, but we want to know so we can follow up.
 */
async function notifyTenantCancelled(restaurant) {
    const periodEnd = restaurant.subscription?.currentPeriodEnd;
    return sendAlert({
        action: ALERT.CANCELLED,
        restaurant,
        subject: `[BestoDine] Subscription cancelled — ${restaurant.name}`,
        body: `
<p><strong>${restaurant.name}</strong>'s subscription has been cancelled.</p>
<p>Access will continue until the current billing period ends.</p>
<ul>
  <li>Tenant: ${restaurant.name} (${restaurant.slug})</li>
  <li>Owner email: ${restaurant.contactEmail || '—'}</li>
  <li>Plan: ${restaurant.subscription?.planName || '—'}</li>
  <li>Access until: ${periodEnd ? new Date(periodEnd).toISOString() : '—'}</li>
</ul>
<p><a href="${tenantLink(restaurant._id)}">Open tenant in Super Admin →</a></p>
        `.trim(),
        detailsExtra: {
            reason: 'subscription.cancelled',
            plan: restaurant.subscription?.planName || '',
            currentPeriodEnd: periodEnd || null,
        },
    });
}

/**
 * A live tenant (status: active or trial) has zero orders in the
 * last DORMANCY_DAYS days. Sent once per cooldown window per tenant.
 */
async function notifyTenantDormant(restaurant) {
    return sendAlert({
        action: ALERT.DORMANT,
        restaurant,
        subject: `[BestoDine] Dormant tenant — ${restaurant.name}`,
        body: `
<p><strong>${restaurant.name}</strong> has not processed any orders in
the last ${DORMANCY_DAYS} days. Worth a check-in before silent churn.</p>
<ul>
  <li>Tenant: ${restaurant.name} (${restaurant.slug})</li>
  <li>Owner email: ${restaurant.contactEmail || '—'}</li>
  <li>Status: ${restaurant.status}</li>
  <li>Plan: ${restaurant.subscription?.planName || '—'}</li>
</ul>
<p><a href="${tenantLink(restaurant._id)}">Open tenant in Super Admin →</a></p>
        `.trim(),
        detailsExtra: {
            reason: 'dormant',
            days: DORMANCY_DAYS,
            status: restaurant.status,
        },
    });
}

// ─── Dormancy scanner ────────────────────────────────────────────────

/**
 * Scan every live tenant, find the dormant ones, and notify. Intended
 * to run on a schedule (setInterval in server.js by default; external
 * cron can hit POST /superadmin/internal/run-dormancy-check for
 * multi-instance production setups).
 *
 * Returns { scanned, dormant, alerted } so the caller / manual
 * endpoint can show a useful summary.
 */
async function checkDormantTenants() {
    const summary = { scanned: 0, dormant: 0, alerted: 0, skipped: false };

    // Guard: skip the run entirely if the Mongoose connection isn't
    // ready. The Order.aggregate() inside this function would
    // otherwise sit in Mongoose's command buffer and time out after
    // 10s — that's harmless but it spams the logs and serves no
    // purpose. The next scheduled run (DORMANCY_SCAN_HOURS later)
    // will retry once the connection is back.
    //
    // readyState values:
    //   0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    if (mongoose.connection.readyState !== 1) {
        logger.warn(
            `checkDormantTenants skipped — Mongo not connected (readyState=${mongoose.connection.readyState})`
        );
        summary.skipped = true;
        return summary;
    }

    try {
        const weekAgo = new Date(Date.now() - DORMANCY_DAYS * 24 * 60 * 60 * 1000);

        // Match all orders created in the window, group by restaurant,
        // count. Same trick as the analytics endpoint — one indexed
        // match + group.
        const activeRows = await Order.aggregate([
            { $match: { createdAt: { $gte: weekAgo } } },
            { $group: { _id: '$restaurant', count: { $sum: 1 } } },
        ]);
        const activeIds = new Set(activeRows.map(r => r._id?.toString?.()).filter(Boolean));

        const liveTenants = await Restaurant.find({
            status: { $in: ['active', 'trial'] },
        }).lean();
        summary.scanned = liveTenants.length;

        for (const t of liveTenants) {
            if (activeIds.has(t._id.toString())) continue;
            summary.dormant++;
            const sent = await notifyTenantDormant(t);
            if (sent) summary.alerted++;
        }
        if (summary.dormant > 0 || summary.alerted > 0) {
            logger.info(
                `checkDormantTenants scanned=${summary.scanned} dormant=${summary.dormant} alerted=${summary.alerted}`
            );
        } else {
            logger.debug(
                `checkDormantTenants scanned=${summary.scanned} dormant=0 alerted=0`
            );
        }
    } catch (err) {
        logger.error(`checkDormantTenants error: ${err.message}`);
    }
    return summary;
}

// ─── Scheduled runner ────────────────────────────────────────────────

/**
 * Start a simple in-process interval that scans for dormant tenants
 * every N hours. Safe to call at server boot — the first run is
 * delayed by DELAY_MS so we don't block startup.
 *
 * #35 — the tick is cluster-locked (utils/scheduler + utils/jobLock),
 * so on multi-instance setups only one pod scans per interval. The
 * DORMANCY_SCAN_DISABLED + external-cron route (routes/superadminRoute.js)
 * remains available.
 */
const INTERVAL_HOURS = Number(process.env.DORMANCY_SCAN_HOURS) || 6;
const DELAY_MS = 60 * 1000;  // 1 minute after boot
let _scanTimer = null;

function startScheduledDormancyScan() {
    if (_scanTimer) return; // idempotent

    // Skip entirely if explicitly disabled (useful for external-cron setups).
    if (process.env.DORMANCY_SCAN_DISABLED === 'true') {
        logger.info('dormancy scan disabled via DORMANCY_SCAN_DISABLED');
        return;
    }

    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    // #35 — cluster-locked: runs on one instance per interval.
    _scanTimer = require('./scheduler').scheduleJob('dormancy-scan', intervalMs, checkDormantTenants, { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled dormancy scan every ${INTERVAL_HOURS}h (first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    notifyTenantHalted,
    resolveRecipients,
    notifyTenantCancelled,
    notifyTenantDormant,
    checkDormantTenants,
    startScheduledDormancyScan,
    // Exported for test visibility
    ALERT,
    DORMANCY_DAYS,
};
