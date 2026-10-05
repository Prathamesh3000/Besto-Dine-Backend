// ADM-043 — availability schedule filter for menu items / combos.
//
// Items can carry an availability window: `availableDays` (subset of
// Mon..Sun) and an `startTime`/`endTime` ("HH:MM" 24-hour strings).
// The admin sets these to express e.g. "breakfast menu, Mon–Fri 7–11".
// Before this filter existed the fields were stored but never enforced,
// so a lunch-only item kept showing up on the customer menu after hours
// and on weekends.
//
// Public API:
//   - currentDayShort() / currentTimeHHMM()    — read "now" (server clock)
//   - buildAvailabilityFilter()                — Mongo filter to AND into list queries
//   - isStaffCaller(req)                       — admins skip the filter so they
//                                                can still see/edit out-of-window items
//
// Wrap-around (overnight) windows are supported: startTime > endTime
// means "open from startTime through midnight to endTime the next day"
// (e.g. 22:00–02:00).

const STAFF_ROLES = new Set(['admin', 'manager', 'captain', 'waiter', 'chef', 'superadmin']);
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function currentDayShort(now = new Date()) {
    return SHORT_DAYS[now.getDay()];
}

function currentTimeHHMM(now = new Date()) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function isStaffCaller(req) {
    return Boolean(req?.user?.role && STAFF_ROLES.has(req.user.role));
}

/**
 * Returns a Mongo filter fragment that matches items currently available.
 * Designed to be spread into an existing query object via Object.assign /
 * `{ ...filter, ...availabilityFilter() }`.
 *
 * Treats blank/missing values as "no restriction":
 *   - availableDays empty/missing → available every day
 *   - startTime or endTime blank   → no time window
 */
// Zero-pad a legacy "H:MM" bound to "HH:MM" inside the aggregation
// expression so string comparison matches clock order ("9:00" would
// otherwise sort after "17:00"). The routes normalise new writes; this
// keeps rows stored before that validation correct.
function paddedTime(field) {
    return {
        $cond: [
            { $eq: [{ $strLenCP: { $ifNull: [field, ''] } }, 4] },
            { $concat: ['0', field] },
            field,
        ],
    };
}

function buildAvailabilityFilter(now = new Date()) {
    const today = currentDayShort(now);
    const hhmm = currentTimeHHMM(now);
    const start = paddedTime('$startTime');
    const end = paddedTime('$endTime');
    return {
        $and: [
            // ── Day-of-week gate ────────────────────────────────────────
            // Either the field is missing/empty (no restriction) or
            // today is one of the listed days.
            {
                $or: [
                    { availableDays: { $exists: false } },
                    { availableDays: { $size: 0 } },
                    { availableDays: today },
                ],
            },
            // ── Time-of-day gate ────────────────────────────────────────
            // Implemented with $expr so the wrap-around case
            // (overnight windows like 22:00–02:00) stays a single
            // round-trip. Blank strings on either bound short-circuit
            // to "no restriction".
            {
                $expr: {
                    $or: [
                        { $in: [{ $ifNull: ['$startTime', ''] }, ['', null]] },
                        { $in: [{ $ifNull: ['$endTime', ''] }, ['', null]] },
                        // Non-wrap: startTime <= endTime AND now in [start, end]
                        {
                            $and: [
                                { $lte: [start, end] },
                                { $lte: [start, hhmm] },
                                { $gte: [end, hhmm] },
                            ],
                        },
                        // Wrap (overnight): startTime > endTime AND
                        // (now >= start OR now <= end)
                        {
                            $and: [
                                { $gt: [start, end] },
                                {
                                    $or: [
                                        { $gte: [hhmm, start] },
                                        { $lte: [hhmm, end] },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            },
        ],
    };
}

module.exports = {
    currentDayShort,
    currentTimeHHMM,
    isStaffCaller,
    buildAvailabilityFilter,
};
