'use strict';
/**
 * Pure pay calculations for simple payroll (attendance + wallet payout only;
 * no PF / ESI / TDS).
 *
 *   hourly : basePay = regularHours x baseRate;
 *            overtimePay = overtimeHours x (overtimeRate ?? baseRate)
 *   daily  : basePay = daysPresent x baseRate;
 *            overtimePay = overtimeHours x overtimeRate (0 when unset)
 *   monthly: periodFactor = periodDays / daysInMonth(periodStart)
 *            expectedDays = workingDaysPerMonth x periodFactor
 *            basePay = baseRate x periodFactor x min(1, daysPresent / expectedDays)
 *            overtimePay = overtimeHours x overtimeRate (0 when unset)
 *   net = base + overtime + incentives - advances - deductions (never < 0).
 */
const MAX_AMOUNT = 10000000;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function ymdToUtc(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function daysInMonthOf(ymd) {
    const [y, m] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function periodDayCount(from, to) {
    return Math.round((ymdToUtc(to) - ymdToUtc(from)) / 86400000) + 1;
}

/** Validate an admin-entered money amount: finite, >= 0, <= MAX. Returns number or throws a 400. */
function validAmount(v, label = 'Amount') {
    const n = Number(v === undefined || v === null || v === '' ? 0 : v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) {
        const e = new Error(`${label} must be a number between 0 and ${MAX_AMOUNT}.`);
        e.status = 400;
        throw e;
    }
    return round2(n);
}

function computeBaseAndOvertime(profile, att, period) {
    const baseRate = Number(profile.baseRate) || 0;
    const otRate = profile.overtimeRate === null || profile.overtimeRate === undefined ? null : Number(profile.overtimeRate);
    const otHours = att.overtimeHours || 0;
    let basePay = 0;
    let overtimePay = 0;
    if (profile.payType === 'hourly') {
        basePay = att.regularHours * baseRate;
        overtimePay = otHours * (otRate === null ? baseRate : otRate);
    } else if (profile.payType === 'daily') {
        basePay = att.daysPresent * baseRate;
        overtimePay = otRate === null ? 0 : otHours * otRate;
    } else {
        const days = periodDayCount(period.from, period.to);
        const factor = days / daysInMonthOf(period.from);
        const expected = Math.max(1, (profile.workingDaysPerMonth || 26) * factor);
        basePay = baseRate * factor * Math.min(1, att.daysPresent / expected);
        overtimePay = otRate === null ? 0 : otHours * otRate;
    }
    return { basePay: round2(basePay), overtimePay: round2(overtimePay) };
}

/** Recompute gross/net on a line from its components. Throws 400 if net would be negative. */
function finishLine(line) {
    const gross = round2(line.basePay + line.overtimePay + line.incentives);
    const net = round2(gross - line.advances - line.deductions);
    if (net < 0) {
        const e = new Error('Advances and deductions exceed the gross pay for this staff member.');
        e.status = 400;
        throw e;
    }
    return { ...line, grossPay: gross, netPay: net };
}

function computeTotals(lines) {
    const t = { staffCount: lines.length, basePay: 0, overtimePay: 0, incentives: 0, advances: 0, deductions: 0, netPay: 0 };
    for (const l of lines) {
        t.basePay += l.basePay; t.overtimePay += l.overtimePay; t.incentives += l.incentives;
        t.advances += l.advances; t.deductions += l.deductions; t.netPay += l.netPay;
    }
    for (const k of Object.keys(t)) if (k !== 'staffCount') t[k] = round2(t[k]);
    return t;
}

module.exports = { MAX_AMOUNT, round2, validAmount, computeBaseAndOvertime, finishLine, computeTotals, periodDayCount, daysInMonthOf };
