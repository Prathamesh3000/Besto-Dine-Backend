'use strict';
/**
 * Scheduled emailed reports.
 *
 * A periodic job (registered once in server.js through register()) looks at
 * every enabled ReportSchedule, works out the most recent COMPLETE period
 * that is due (yesterday / last week Mon-Sun / last calendar month, in the
 * tenant's timezone) and emails it as a CSV attachment through utils/email.
 *
 * Never double-sends: the job first CLAIMS the period with an atomic
 * conditional update (lastPeriodKey != key). Only the caller that wins the
 * claim sends; a second tick, a second app instance or a restart finds the
 * key already claimed and skips. If every recipient fails, the claim is
 * rolled back so the next tick retries; if some succeeded it is kept
 * (resending would duplicate mails) and lastError lists the failures.
 * When no mail transport is configured (dev) nothing leaves the building:
 * the period is kept as claimed and lastError says so.
 *
 * Export aid only, not a tax filing tool.
 */
const logger = require('../utils/logger');
const { safeTz, localParts, fmtYmd, addDays, dayStartUtc } = require('../utils/reportDates');
const { gstReportCsv, dailySalesCsv, DISCLAIMER } = require('../utils/gstReport');

const MAX_SCHEDULES_PER_TENANT = 10;
const MAX_RECIPIENTS = 5;
const TICK_MS = 15 * 60 * 1000;
const MAX_PER_TICK = 500;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

function validateRecipients(list) {
    if (!Array.isArray(list) || !list.length) return { error: 'Add at least one recipient email' };
    const clean = [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
    if (!clean.length) return { error: 'Add at least one recipient email' };
    if (clean.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} recipients` };
    const bad = clean.find((e) => e.length > 254 || !EMAIL_RE.test(e));
    if (bad) return { error: `Invalid email address: ${bad.slice(0, 60)}` };
    return { recipients: clean };
}

/**
 * The most recent complete period that is due at `now`.
 * @returns {{key:string, from:string, to:string}}
 */
function duePeriod({ frequency, hour = 8 }, now, tz) {
    const lp = localParts(now, tz);
    // Before the send hour, today's report is not due yet: behave as yesterday.
    const eff = lp.hour >= hour ? { y: lp.y, mo: lp.mo, d: lp.d } : addDays(lp, -1);
    if (frequency === 'weekly') {
        const dow = new Date(Date.UTC(eff.y, eff.mo - 1, eff.d)).getUTCDay(); // 0 Sun
        const monday = addDays(eff, -((dow + 6) % 7));
        const from = addDays(monday, -7);
        const to = addDays(monday, -1);
        return { key: fmtYmd(from), from: fmtYmd(from), to: fmtYmd(to) };
    }
    if (frequency === 'monthly') {
        const first = { y: eff.y, mo: eff.mo, d: 1 };
        const to = addDays(first, -1);
        const from = { y: to.y, mo: to.mo, d: 1 };
        return { key: fmtYmd(from).slice(0, 7), from: fmtYmd(from), to: fmtYmd(to) };
    }
    const day = addDays(eff, -1);
    return { key: fmtYmd(day), from: fmtYmd(day), to: fmtYmd(day) };
}

const TYPE_LABEL = { 'daily-sales': 'Sales summary', 'gst-summary': 'GST summary' };

async function buildAttachment(schedule, period, deps) {
    const tenant = await deps.loadTenantTaxContext(schedule.restaurant);
    const tz = safeTz(tenant.tz);
    const range = {
        from: period.from, to: period.to, tz,
        start: dayStartUtc(period.from, tz),
        end: dayStartUtc(addDays({ y: +period.to.slice(0, 4), mo: +period.to.slice(5, 7), d: +period.to.slice(8, 10) }, 1), tz),
    };
    const { report } = await deps.generateGstReport({ restaurantId: schedule.restaurant, branchClause: {}, range, tenant });
    const csv = schedule.type === 'gst-summary' ? gstReportCsv(report) : dailySalesCsv(report);
    const label = TYPE_LABEL[schedule.type] || 'Report';
    const name = `${schedule.type}-${period.from}${period.to !== period.from ? `_to_${period.to}` : ''}.csv`;
    const t = report.totals;
    const subject = `${tenant.taxpayer.name || 'BestoDine'} - ${label} ${period.from}${period.to !== period.from ? ` to ${period.to}` : ''}`;
    const html = `<p>${label} for <b>${period.from}${period.to !== period.from ? ` to ${period.to}` : ''}</b> is attached as a CSV.</p>`
        + `<p>Bills: ${t.invoiceCount} &middot; Taxable value: ${t.taxable.toFixed(2)} &middot; Tax: ${t.tax.toFixed(2)} &middot; Total: ${t.invoiceTotal.toFixed(2)}</p>`
        + `<p style="color:#666;font-size:12px">${DISCLAIMER}</p>`;
    const text = `${label} ${period.from} to ${period.to}. Bills: ${t.invoiceCount}, taxable ${t.taxable.toFixed(2)}, tax ${t.tax.toFixed(2)}, total ${t.invoiceTotal.toFixed(2)}.\n${DISCLAIMER}`;
    return { subject, html, text, attachments: [{ filename: name, content: Buffer.from(csv, 'utf8'), contentType: 'text/csv' }] };
}

/**
 * Process one schedule for `now`. Returns 'skipped' | 'sent' | 'failed' | 'lost-claim'.
 */
async function processSchedule(schedule, now, deps) {
    const tenant = await deps.loadTenantTaxContext(schedule.restaurant);
    const period = duePeriod(schedule, now, safeTz(tenant.tz));
    if (schedule.lastPeriodKey === period.key) return 'skipped';

    // Atomic claim: only one caller per period can flip lastPeriodKey.
    const claimed = await deps.ReportSchedule.findOneAndUpdate(
        { _id: schedule._id, restaurant: schedule.restaurant, enabled: true, lastPeriodKey: { $ne: period.key } },
        { $set: { lastPeriodKey: period.key, lastRunAt: now, lastError: '' } },
        { returnDocument: 'before' },
    );
    if (!claimed) return 'lost-claim';
    const previousKey = claimed.lastPeriodKey || '';

    try {
        const mail = await buildAttachment(schedule, period, deps);
        let delivered = 0;
        const failures = [];
        let devMode = false;
        for (const to of schedule.recipients || []) {
            const r = await deps.sendEmail({ to, ...mail });
            if (r?.sent) delivered += 1;
            else if (r?.dev) devMode = true;
            else failures.push(`${to}: ${String(r?.error || 'send failed').slice(0, 100)}`);
        }
        if (delivered === 0 && !devMode) {
            await deps.ReportSchedule.updateOne(
                { _id: schedule._id, restaurant: schedule.restaurant, lastPeriodKey: period.key },
                { $set: { lastPeriodKey: previousKey, lastError: (failures.join('; ') || 'No recipient received the email').slice(0, 480) } },
            );
            return 'failed';
        }
        const note = devMode && delivered === 0
            ? 'Email is not configured on this server; nothing was sent'
            : failures.join('; ').slice(0, 480);
        if (note) await deps.ReportSchedule.updateOne({ _id: schedule._id, restaurant: schedule.restaurant }, { $set: { lastError: note } });
        return 'sent';
    } catch (err) {
        logger.error('report schedule failed', { scheduleId: String(schedule._id), error: err.message });
        await deps.ReportSchedule.updateOne(
            { _id: schedule._id, restaurant: schedule.restaurant, lastPeriodKey: period.key },
            { $set: { lastPeriodKey: previousKey, lastError: String(err.message || err).slice(0, 480) } },
        ).catch(() => {});
        return 'failed';
    }
}

function defaultDeps() {
    return {
        ReportSchedule: require('../models/reportSchedule'),
        sendEmail: require('../utils/email').sendEmail,
        ...require('./gstReportService'),
    };
}

/** One job tick: process every enabled schedule once. */
async function runDueSchedules({ now = new Date(), deps = defaultDeps() } = {}) {
    // AUDIT-EXEMPT: platform job scans every tenant's schedules by design; each one is then processed with its own restaurant id
    const schedules = await deps.ReportSchedule.find({ enabled: true }).limit(MAX_PER_TICK).lean();
    const tally = { skipped: 0, sent: 0, failed: 0, 'lost-claim': 0 };
    for (const s of schedules) {
        try {
            tally[await processSchedule(s, now, deps)] += 1;
        } catch (err) {
            tally.failed += 1;
            logger.error('report schedule tick error', { scheduleId: String(s._id), error: err.message });
        }
    }
    return tally;
}

/** Register the recurring job (one line in server.js). */
function register() {
    require('../utils/scheduler').scheduleJob('report-schedules', TICK_MS, () => runDueSchedules(), { initialDelayMs: 2 * 60 * 1000 });
}

module.exports = {
    MAX_SCHEDULES_PER_TENANT, MAX_RECIPIENTS, validateRecipients, duePeriod, processSchedule, runDueSchedules, register,
};
