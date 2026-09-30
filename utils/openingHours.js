/**
 * openingHours — pure helpers for the public restaurant landing page.
 *
 *   computeOpenNow(operatingHours, timezone, now = new Date())
 *     → { isOpen: boolean, label: string }
 *
 * `operatingHours` is Settings.operatingHours: [{ day, start, end, isOpen }]
 * with `day` a weekday name ('Monday' / 'Mon' / 'monday' all work) and
 * start / end "HH:MM" 24-hour strings, evaluated in the tenant's IANA
 * timezone (invalid / missing → Asia/Kolkata).
 *
 * Rules:
 *   - end <= start  → overnight window (18:00–02:00 closes 02:00 next day);
 *                     start === end means open the full 24 hours
 *   - a day that is missing or isOpen:false is closed (a previous day's
 *     overnight window still spills into it)
 *
 * Labels: "Open now · closes 11:00 PM", "Open 24 hours",
 *         "Closed · opens 9:00 AM", "Closed · opens 9:00 AM tomorrow",
 *         "Closed · opens 9:00 AM Monday", "Closed".
 */

const DEFAULT_TZ = 'Asia/Kolkata';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MINUTES_PER_DAY = 24 * 60;

function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** { dayIndex (0=Sun), minutes (0..1439) } of `now` in `timezone`. */
function localDayAndMinutes(now, timezone) {
    const tz = isValidTimeZone(timezone) ? timezone : DEFAULT_TZ;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    const dayIndex = DAY_INDEX[get('weekday').slice(0, 3).toLowerCase()] ?? 0;
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute')) || 0;
    return { dayIndex, minutes: hour * 60 + minute };
}

/** "HH:MM" → minutes since midnight, or null when malformed. "24:00" → 1440. */
function parseTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
    return h * 60 + min;
}

/** minutes since midnight → "9:00 AM" / "11:30 PM" / "12:00 AM". */
function formatTime(minutes) {
    const total = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const h24 = Math.floor(total / 60);
    const mm = String(total % 60).padStart(2, '0');
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${mm} ${suffix}`;
}

/**
 * Normalise operatingHours into a 7-slot array indexed by day (0=Sun):
 * null (closed) or { start, end, overnight, allDay } in minutes.
 */
function buildWeek(operatingHours) {
    const week = new Array(7).fill(null);
    if (!Array.isArray(operatingHours)) return week;
    for (const entry of operatingHours) {
        if (!entry || entry.isOpen === false) continue;
        const idx = DAY_INDEX[String(entry.day || '').trim().slice(0, 3).toLowerCase()];
        if (idx === undefined) continue;
        const start = parseTime(entry.start);
        let end = parseTime(entry.end);
        if (start === null || end === null) continue;
        if (end === MINUTES_PER_DAY) end = 0;
        const allDay = start === end || (start === 0 && end === 0);
        week[idx] = { start, end, overnight: !allDay && end < start, allDay };
    }
    return week;
}

function computeOpenNow(operatingHours, timezone, now = new Date()) {
    const week = buildWeek(operatingHours);
    const { dayIndex, minutes } = localDayAndMinutes(now, timezone);

    const today = week[dayIndex];
    const yesterday = week[(dayIndex + 6) % 7];

    // 1. Still inside yesterday's overnight window?
    if (yesterday && yesterday.overnight && minutes < yesterday.end) {
        return { isOpen: true, label: `Open now · closes ${formatTime(yesterday.end)}` };
    }

    // 2. Inside today's window?
    if (today) {
        if (today.allDay) return { isOpen: true, label: 'Open 24 hours' };
        if (today.overnight && minutes >= today.start) {
            return { isOpen: true, label: `Open now · closes ${formatTime(today.end)}` };
        }
        if (!today.overnight && minutes >= today.start && minutes < today.end) {
            return { isOpen: true, label: `Open now · closes ${formatTime(today.end)}` };
        }
        // 3. Opens later today.
        if (minutes < today.start) {
            return { isOpen: false, label: `Closed · opens ${formatTime(today.start)}` };
        }
    }

    // 4. Next open day within the coming week.
    for (let offset = 1; offset <= 7; offset += 1) {
        const idx = (dayIndex + offset) % 7;
        const slot = week[idx];
        if (!slot) continue;
        const when = offset === 1 ? 'tomorrow' : DAY_NAMES[idx];
        return { isOpen: false, label: `Closed · opens ${formatTime(slot.start)} ${when}` };
    }

    return { isOpen: false, label: 'Closed' };
}

/** Default week used when a tenant never saved operating hours. */
function defaultOperatingHours() {
    return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        .map((day) => ({ day, start: '09:00', end: '23:00', isOpen: true }));
}

module.exports = {
    computeOpenNow,
    defaultOperatingHours,
    formatTime,
    parseTime,
    isValidTimeZone,
    localDayAndMinutes,
    DEFAULT_TZ,
};
