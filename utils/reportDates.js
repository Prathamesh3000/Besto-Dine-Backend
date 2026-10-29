'use strict';
/**
 * Timezone-aware day boundaries for tax / scheduled reports. Reports are
 * "from YYYY-MM-DD to YYYY-MM-DD inclusive" in the tenant's own timezone.
 * Pure (Intl only), unit-tested.
 */
const DEFAULT_TZ = 'Asia/Kolkata';
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 366;

function safeTz(tz) {
    const t = typeof tz === 'string' ? tz.trim() : '';
    if (!t) return DEFAULT_TZ;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: t });
        return t;
    } catch {
        return DEFAULT_TZ;
    }
}

function parseYmd(s) {
    const m = YMD_RE.exec(String(s || '').trim());
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y, mo, d };
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtYmd({ y, mo, d }) { return `${y}-${pad(mo)}-${pad(d)}`; }

/** Zone offset (ms, local - UTC) at the given instant. */
function tzOffsetMs(tz, date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 local on the given Y-M-D in tz. */
function dayStartUtc(ymd, tz) {
    const zone = safeTz(tz);
    const p = typeof ymd === 'string' ? parseYmd(ymd) : ymd;
    if (!p) return null;
    const naive = Date.UTC(p.y, p.mo - 1, p.d);
    let guess = naive - tzOffsetMs(zone, new Date(naive));
    guess = naive - tzOffsetMs(zone, new Date(guess));
    return new Date(guess);
}

/** Local calendar parts of an instant in tz. */
function localParts(date, tz) {
    const zone = safeTz(tz);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(date);
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return { y: g('year'), mo: g('month'), d: g('day'), hour: g('hour') };
}

function localYmd(date, tz) { return fmtYmd(localParts(date, tz)); }

function addDays(p, n) {
    const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Resolve ?from&to (inclusive local days) into a half-open UTC range.
 * Defaults: this month so far. Returns { error } on bad input.
 */
function resolveRange({ from, to }, tz, now = new Date()) {
    const zone = safeTz(tz);
    const today = localParts(now, zone);
    let f = from ? parseYmd(from) : { y: today.y, mo: today.mo, d: 1 };
    let t = to ? parseYmd(to) : { y: today.y, mo: today.mo, d: today.d };
    if (!f || !t) return { error: 'from and to must be YYYY-MM-DD' };
    const days = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(f.y, f.mo - 1, f.d)) / 86400000) + 1;
    if (days < 1) return { error: 'from must not be after to' };
    if (days > MAX_RANGE_DAYS) return { error: `Range cannot exceed ${MAX_RANGE_DAYS} days` };
    return {
        from: fmtYmd(f), to: fmtYmd(t), tz: zone, days,
        start: dayStartUtc(f, zone), end: dayStartUtc(addDays(t, 1), zone),
    };
}

module.exports = {
    DEFAULT_TZ, MAX_RANGE_DAYS, safeTz, parseYmd, fmtYmd, tzOffsetMs, dayStartUtc,
    localParts, localYmd, addDays, resolveRange,
};
