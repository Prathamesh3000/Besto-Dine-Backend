'use strict';
/**
 * Business-date helpers (ledger + cash closing, Plan 3B.3 / 3B.5).
 *
 * A "business date" is the calendar day ('YYYY-MM-DD') in the restaurant's
 * IANA time zone (Restaurant.timezone, default Asia/Kolkata - the same
 * fallback utils/billWorkspace.js uses for the financial year).
 */
const DEFAULT_TZ = 'Asia/Kolkata';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeTz(timeZone) {
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || DEFAULT_TZ });
        return timeZone || DEFAULT_TZ;
    } catch (_) {
        return DEFAULT_TZ;
    }
}

function isValidYmd(s) {
    if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 'YYYY-MM-DD' of `date` in `timeZone`. */
function businessDateOf(date, timeZone) {
    const d = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: safeTz(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

// Offset (ms) of `timeZone` from UTC at instant `ms` (positive = ahead of UTC).
function tzOffsetMs(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant at which `ymd` starts (00:00) in `timeZone`. */
function startOfBusinessDate(ymd, timeZone) {
    const tz = safeTz(timeZone);
    const [y, m, d] = ymd.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - tzOffsetMs(guess, tz);
    t = guess - tzOffsetMs(t, tz); // re-evaluate near a DST edge
    return new Date(t);
}

function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
}

/** { start, end } (end exclusive) UTC instants covering business date `ymd`. */
function dayBounds(ymd, timeZone) {
    return { start: startOfBusinessDate(ymd, timeZone), end: startOfBusinessDate(addDays(ymd, 1), timeZone) };
}

/** Inclusive list of business dates from..to (caps at maxDays, default 62). */
function eachDate(from, to, maxDays = 62) {
    const out = [];
    for (let d = from; d <= to && out.length < maxDays; d = addDays(d, 1)) out.push(d);
    return out;
}

module.exports = { DEFAULT_TZ, safeTz, isValidYmd, businessDateOf, startOfBusinessDate, dayBounds, addDays, eachDate };
