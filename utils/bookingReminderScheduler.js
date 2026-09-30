// Scheduled scan that reminds customers to settle their advance-booking
// balance before the event starts. Mirrors the dormancy-scan pattern in
// utils/alerts.js so operators get a consistent set of in-process timers.
//
// Behaviour: every BOOKING_REMINDER_SCAN_HOURS (default 6h), look for
// bookings where:
//   - status === 'Confirmed'  (admin already accepted — Pending bookings
//     aren't ready for a payment nudge yet)
//   - payment.status !== 'Paid'  (something is genuinely owed)
//   - bookingDate is between "now" and "now + REMINDER_WINDOW_HOURS"
//   - payment.balanceReminderSentAt has never been set
//
// Each match gets ONE persistent customer Notification + a one-shot
// socket emit, then balanceReminderSentAt is stamped so a re-scan at
// the next tick doesn't double-notify the same customer.
//
// Disable in multi-instance setups via BOOKING_REMINDER_DISABLED=true
// and trigger from an external cron instead.

const AdvanceBooking = require('../models/advanceBooking');
const logger = require('./logger');
const { notify } = require('../services/notificationService');

const INTERVAL_HOURS = Number(process.env.BOOKING_REMINDER_SCAN_HOURS) || 6;
const WINDOW_HOURS = Number(process.env.BOOKING_REMINDER_WINDOW_HOURS) || 24;
const DELAY_MS = 60 * 1000; // first run ~1 min after boot

let _timer = null;

const fmtBookingDate = (d) => {
    try {
        return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ''; }
};

// Run a single scan. Exported so an external cron / admin endpoint can
// trigger it on demand. Resolves with `{ scanned, sent }` for logs.
async function runBookingReminderScan() {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

    let scanned = 0;
    let sent = 0;

    try {
        const due = await AdvanceBooking.find({
            status: 'Confirmed',
            'payment.status': { $ne: 'Paid' },
            'payment.balanceReminderSentAt': { $in: [null, undefined] },
            bookingDate: { $gte: now, $lte: windowEnd },
        }).select('_id bookingId user restaurant branch bookingDate payment').lean();

        scanned = due.length;
        if (scanned === 0) return { scanned, sent };

        for (const b of due) {
            try {
                const total = b.payment?.totalAmount || 0;
                const paid = b.payment?.advancePaid || 0;
                const remaining = Math.max(total - paid, 0);
                if (remaining <= 0) {
                    // Nothing to nudge about — flag it so we skip cleanly next tick.
                    await AdvanceBooking.updateOne(
                        { _id: b._id },
                        { $set: { 'payment.balanceReminderSentAt': now } }
                    );
                    continue;
                }

                const dateStr = fmtBookingDate(b.bookingDate);
                const title = 'Balance Due Reminder';
                const description = `Your booking ${b.bookingId} is on ${dateStr}. ₹${remaining} balance is still pending — please pay before the event.`;

                // Persist atomic-style: only proceed if no concurrent
                // scan has already stamped the marker. updateOne with a
                // null-check filter prevents a duplicate notification
                // when two pods run the scan at once.
                const stamp = await AdvanceBooking.updateOne(
                    {
                        _id: b._id,
                        $or: [
                            { 'payment.balanceReminderSentAt': null },
                            { 'payment.balanceReminderSentAt': { $exists: false } },
                        ],
                    },
                    { $set: { 'payment.balanceReminderSentAt': now } }
                );
                if (stamp.modifiedCount !== 1) continue;

                if (b.user) {
                    // Runs outside any request context, so the tenant and
                    // branch are passed explicitly. notify() persists the
                    // customer row and emits notification:new to the
                    // customer's own room; it never throws.
                    await notify({
                        restaurant: b.restaurant,
                        branch: b.branch || null,
                        recipients: [b.user],
                        notification: {
                            title,
                            description,
                            category: 'Payment',
                            recipientRole: 'customer',
                            priority: 'high',
                            meta: {
                                bookingId: b.bookingId,
                                bookingDocId: b._id.toString(),
                                remainingAmount: remaining,
                            },
                        },
                        payload: { title, description },
                    });
                }
                sent += 1;
            } catch (perBookingErr) {
                logger.warn(`booking reminder skipped (${b.bookingId}): ${perBookingErr.message}`);
            }
        }

        if (sent > 0) logger.info(`booking-reminder scan: ${sent}/${scanned} reminders sent`);
        return { scanned, sent };
    } catch (err) {
        logger.error('booking-reminder scan error:', { error: err.message });
        return { scanned, sent };
    }
}

// Idempotent. Skips entirely when BOOKING_REMINDER_DISABLED=true.
function startScheduledBookingReminders() {
    if (_timer) return;

    if (process.env.BOOKING_REMINDER_DISABLED === 'true') {
        logger.info('booking reminders disabled via BOOKING_REMINDER_DISABLED');
        return;
    }

    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    // #35 — cluster-locked: runs on one instance per interval.
    _timer = require('./scheduler').scheduleJob('booking-reminders', intervalMs, runBookingReminderScan, { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled booking reminders every ${INTERVAL_HOURS}h (window=${WINDOW_HOURS}h, first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    runBookingReminderScan,
    startScheduledBookingReminders,
};
