// Scheduled sweeper — closes "abandoned" waiter shifts.
//
// Why this exists:
//   A waiter who forgets to clock out leaves their Shift in status='active'
//   forever. The frontend's running-hours stat keeps adding seconds on top
//   of an already-finished workday, and the next clock-in is blocked by
//   the "you already have an active shift" guard. Both bugs corrupt the
//   shift dashboard and need a self-heal.
//
// What it does:
//   Marks any active shift older than SHIFT_AUTOCLOSE_HOURS (default 16h)
//   as 'missed', caps clockOut at the threshold, computes totalHours, and
//   appends an audit note. Unlike the stale order sweeper this one
//   modifies the row — there's no human review needed because by the time
//   a shift is 16h old, the staff member is definitively gone.
//
// Disabled via SHIFT_AUTOCLOSE_DISABLED=true on multi-instance setups
// that want to run the check from external cron via
// POST /api/v1/shifts/admin/run-autoclose instead.

const Shift = require('../models/shift');
const logger = require('./logger');
const { runWithoutContext } = require('./requestContext');

// Default: 16 hours. Long enough to cover a double-shift, short enough
// to catch the typical "forgot to clock out before going home" case the
// next morning.
const AUTOCLOSE_HOURS_DEFAULT = 16;
// How often the check runs. Cheap query (indexed filter on status +
// clockIn) so hourly is fine.
const SWEEP_INTERVAL_HOURS_DEFAULT = 1;

/**
 * @param {object} [opts]
 * @param {object|string} [opts.restaurant] limit to one tenant (Restaurant
 *   doc or id) — tenant-admin "run now". Omitted = every tenant (scheduled).
 */
async function runShiftAutoClose({ restaurant } = {}) {
    const restaurantId = restaurant ? (restaurant._id || restaurant) : null;
    const thresholdHours = Number(process.env.SHIFT_AUTOCLOSE_HOURS) || AUTOCLOSE_HOURS_DEFAULT;
    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);

    try {
        const abandoned = await Shift.find({
            ...(restaurantId ? { restaurant: restaurantId } : {}),
            status: 'active',
            clockIn: { $lt: cutoff },
        });

        if (abandoned.length === 0) return { count: 0 };

        const auditNote = `[Auto-closed after ${thresholdHours}h — shift not manually clocked out]`;

        const updates = abandoned.map(s => {
            const cappedClockOut = new Date(new Date(s.clockIn).getTime() + thresholdHours * 60 * 60 * 1000);
            return Shift.updateOne(
                { _id: s._id },
                {
                    $set: {
                        status: 'missed',
                        clockOut: cappedClockOut,
                        totalHours: thresholdHours,
                        note: s.note ? `${s.note}\n${auditNote}` : auditNote,
                    },
                }
            );
        });

        await Promise.all(updates);

        logger.warn('Shift auto-closer marked abandoned shifts as missed', {
            count: abandoned.length,
            thresholdHours,
            restaurant: restaurantId ? String(restaurantId) : 'all',
        });

        return { count: abandoned.length, thresholdHours };
    } catch (err) {
        logger.error('Shift auto-closer error', { error: err.message });
        return { count: 0, error: err.message };
    }
}

function startScheduledShiftAutoClose() {
    if (String(process.env.SHIFT_AUTOCLOSE_DISABLED).toLowerCase() === 'true') {
        logger.info('Shift auto-closer disabled via SHIFT_AUTOCLOSE_DISABLED');
        return;
    }
    const hours = Number(process.env.SHIFT_AUTOCLOSE_SWEEP_HOURS) || SWEEP_INTERVAL_HOURS_DEFAULT;
    const intervalMs = hours * 60 * 60 * 1000;
    // #35 — cluster-locked: runs on one instance per interval.
    require('./scheduler').scheduleJob('shift-auto-close', intervalMs, () => runWithoutContext(() => runShiftAutoClose()), { initialDelayMs: 3 * 60 * 1000 });
    logger.debug(`Shift auto-closer scheduled every ${hours}h (threshold ${process.env.SHIFT_AUTOCLOSE_HOURS || AUTOCLOSE_HOURS_DEFAULT}h)`);
}

module.exports = {
    runShiftAutoClose,
    startScheduledShiftAutoClose,
};
