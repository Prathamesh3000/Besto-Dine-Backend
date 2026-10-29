'use strict';
/**
 * Attendance summary for payroll, from Shift records.
 *
 * How a shift counts:
 *  - It belongs to the business date (restaurant timezone) of its clockIn, so a
 *    shift crossing midnight is credited wholly to the day it started.
 *  - Only CLOSED shifts count: status 'completed', or 'missed' (auto-closed by
 *    utils/shiftAutoCloser, hours capped at the sweep threshold; flagged as a
 *    warning so the admin can verify).
 *  - A still 'active' (open) shift is NOT paid; it is reported as a warning so
 *    the admin can force-clock-out it and re-create the draft.
 *  - Hours per shift = clockOut - clockIn when both exist, else totalHours;
 *    clamped to [0, 24].
 *  - A day is "present" when its closed shifts total > 0 hours.
 *  - Overtime is per business day: hours above `overtimeThresholdHours`.
 */
const { businessDateOf, startOfBusinessDate, addDays, DEFAULT_TZ } = require('../../utils/businessDate');
const { round2 } = require('./payCalc');

const MAX_SHIFT_HOURS = 24;

function shiftHours(s) {
    let h;
    if (s.clockIn && s.clockOut) h = (new Date(s.clockOut) - new Date(s.clockIn)) / 3600000;
    else h = Number(s.totalHours) || 0;
    if (!Number.isFinite(h) || h < 0) return 0;
    return Math.min(h, MAX_SHIFT_HOURS);
}

/** Pure. `shifts` for ONE staff member; returns the summary. */
function summarizeShifts(shifts, { timezone = DEFAULT_TZ, from, to, overtimeThresholdHours = 8 } = {}) {
    const perDay = new Map();
    const warnings = [];
    let open = 0;
    let autoClosed = 0;
    for (const s of shifts || []) {
        if (!s.clockIn) continue;
        const day = businessDateOf(s.clockIn, timezone);
        if ((from && day < from) || (to && day > to)) continue;
        if (s.status === 'active') { open += 1; continue; }
        if (s.status === 'missed') autoClosed += 1;
        perDay.set(day, (perDay.get(day) || 0) + shiftHours(s));
    }
    let hours = 0; let overtime = 0; let days = 0;
    const byDay = [];
    for (const [day, h] of [...perDay.entries()].sort()) {
        if (h <= 0) continue;
        days += 1;
        const ot = Math.max(0, h - overtimeThresholdHours);
        hours += h; overtime += ot;
        byDay.push({ day, hours: round2(h), overtime: round2(ot) });
    }
    if (open) warnings.push(`${open} open shift(s) not counted - clock the staff member out and recompute`);
    if (autoClosed) warnings.push(`${autoClosed} auto-closed shift(s) counted at the auto-close cap - verify`);
    const totalHours = round2(hours);
    const overtimeHours = round2(overtime);
    return {
        daysPresent: days,
        hours: totalHours,
        overtimeHours,
        regularHours: round2(totalHours - overtimeHours),
        openShifts: open,
        autoClosedShifts: autoClosed,
        byDay,
        warnings,
    };
}

/**
 * Fetch shifts for the period and summarize per staff.
 * @returns Map<staffIdString, summary>
 */
async function attendanceForPeriod({ Shift, restaurantId, staffIds, from, to, timezone, thresholds = {} }) {
    const start = startOfBusinessDate(from, timezone);
    const end = startOfBusinessDate(addDays(to, 1), timezone);
    const shifts = await Shift.find({
        restaurant: restaurantId,
        staff: { $in: staffIds },
        clockIn: { $gte: start, $lt: end },
    }).select('staff status clockIn clockOut totalHours').lean();
    const grouped = new Map(staffIds.map((id) => [String(id), []]));
    for (const s of shifts) {
        const k = String(s.staff);
        if (grouped.has(k)) grouped.get(k).push(s);
    }
    const out = new Map();
    for (const [k, list] of grouped) {
        out.set(k, summarizeShifts(list, { timezone, from, to, overtimeThresholdHours: thresholds[k] || 8 }));
    }
    return out;
}

module.exports = { summarizeShifts, attendanceForPeriod, shiftHours, MAX_SHIFT_HOURS };
