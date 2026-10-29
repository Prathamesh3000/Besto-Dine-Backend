'use strict';
/**
 * Simple payroll runs: attendance + wallet payout only. NOT statutory payroll
 * (no PF / ESI / TDS / professional tax). See docs/payroll.md.
 *
 * ctx = { restaurantId, timezone, actorId, pinnedBranchId }
 */
const mongoose = require('mongoose');
const StaffPayProfile = require('../../models/staffPayProfile');
const PayrollRun = require('../../models/payrollRun');
const PayrollPayout = require('../../models/payrollPayout');
const Shift = require('../../models/shift');
const User = require('../../models/user');
const IncentiveEntry = require('../../models/incentiveEntry');
const TipSettlement = require('../../models/tipSettlement');
const StaffWallet = require('../../models/staffWallet');
const StaffWalletTransaction = require('../../models/staffWalletTransaction');
const { isValidYmd, businessDateOf, safeTz } = require('../../utils/businessDate');
const { attendanceForPeriod } = require('./attendanceSummary');
const {
    round2, validAmount, computeBaseAndOvertime, finishLine, computeTotals, periodDayCount, MAX_AMOUNT,
} = require('./payCalc');

const PAYABLE_ROLES = ['waiter', 'captain', 'chef', 'manager'];
const WALLET_ROLES = new Set(['waiter', 'captain']);   // same as staffWalletController
const MAX_PERIOD_DAYS = 31;
const PAY_TYPES = ['monthly', 'daily', 'hourly'];
const RATE_MAX = { monthly: MAX_AMOUNT, daily: 1000000, hourly: 100000 };

const httpErr = (status, message, code) => Object.assign(new Error(message), { status, code });
const isDup = (e) => e && (e.code === 11000 || /E11000/.test(e.message || ''));

// ---------------------------------------------------------------- profiles
async function listProfiles(ctx) {
    const staffQ = { restaurant: ctx.restaurantId, role: { $in: PAYABLE_ROLES }, status: 'active' };
    if (ctx.pinnedBranchId) staffQ.branch = ctx.pinnedBranchId;
    const [staff, profiles] = await Promise.all([
        User.find(staffQ).select('name role staffId branch').lean(),
        StaffPayProfile.find({ restaurant: ctx.restaurantId }).lean(),
    ]);
    const byStaff = new Map(profiles.map((p) => [String(p.staff), p]));
    return staff.map((u) => ({ staff: u, profile: byStaff.get(String(u._id)) || null }));
}

function parseProfileBody(body = {}) {
    if (!PAY_TYPES.includes(body.payType)) throw httpErr(400, 'payType must be monthly, daily or hourly.');
    const baseRate = Number(body.baseRate);
    if (!Number.isFinite(baseRate) || baseRate < 0 || baseRate > RATE_MAX[body.payType]) {
        throw httpErr(400, `baseRate must be between 0 and ${RATE_MAX[body.payType]} for ${body.payType} pay.`);
    }
    let overtimeRate = null;
    if (body.overtimeRate !== undefined && body.overtimeRate !== null && body.overtimeRate !== '') {
        overtimeRate = Number(body.overtimeRate);
        if (!Number.isFinite(overtimeRate) || overtimeRate < 0 || overtimeRate > 100000) throw httpErr(400, 'overtimeRate must be between 0 and 100000.');
    }
    const thr = body.overtimeThresholdHours === undefined ? 8 : Number(body.overtimeThresholdHours);
    if (!Number.isFinite(thr) || thr < 1 || thr > 24) throw httpErr(400, 'overtimeThresholdHours must be between 1 and 24.');
    const wd = body.workingDaysPerMonth === undefined ? 26 : Number(body.workingDaysPerMonth);
    if (!Number.isFinite(wd) || wd < 1 || wd > 31) throw httpErr(400, 'workingDaysPerMonth must be between 1 and 31.');
    return {
        payType: body.payType,
        baseRate: round2(baseRate),
        overtimeRate: overtimeRate === null ? null : round2(overtimeRate),
        overtimeThresholdHours: thr,
        workingDaysPerMonth: wd,
        active: body.active === undefined ? true : body.active === true,
    };
}

async function upsertProfile(ctx, staffId, body) {
    if (!mongoose.Types.ObjectId.isValid(staffId)) throw httpErr(400, 'Invalid staff id.');
    const fields = parseProfileBody(body);
    const q = { _id: staffId, restaurant: ctx.restaurantId, role: { $in: PAYABLE_ROLES } };
    if (ctx.pinnedBranchId) q.branch = ctx.pinnedBranchId;
    const user = await User.findOne(q).select('_id').lean();
    if (!user) throw httpErr(404, 'Staff member not found.');
    return StaffPayProfile.findOneAndUpdate(
        { restaurant: ctx.restaurantId, staff: staffId },
        { $set: { ...fields, updatedBy: ctx.actorId || null }, $setOnInsert: { restaurant: ctx.restaurantId, staff: staffId } },
        { new: true, upsert: true, runValidators: true },
    );
}

// ------------------------------------------------------------------- draft
function validatePeriod(from, to, tz) {
    if (!isValidYmd(from) || !isValidYmd(to)) throw httpErr(400, 'periodStart and periodEnd must be YYYY-MM-DD.');
    if (from > to) throw httpErr(400, 'periodStart must not be after periodEnd.');
    if (periodDayCount(from, to) > MAX_PERIOD_DAYS) throw httpErr(400, `A payroll period can be at most ${MAX_PERIOD_DAYS} days.`);
    if (to > businessDateOf(new Date(), tz)) throw httpErr(400, 'periodEnd cannot be in the future.');
}

async function lockedOverlaps(restaurantId, staffIds, from, to, excludeRunId) {
    const q = {
        restaurant: restaurantId, locked: true,
        'lines.staff': { $in: staffIds },
        periodStart: { $lte: to }, periodEnd: { $gte: from },
    };
    if (excludeRunId) q._id = { $ne: excludeRunId };
    return PayrollRun.find(q).select('periodStart periodEnd lines.staff').lean();
}

async function createDraft(ctx, body = {}) {
    const tz = safeTz(ctx.timezone);
    const from = body.periodStart;
    const to = body.periodEnd;
    validatePeriod(from, to, tz);

    let branchId = ctx.pinnedBranchId || null;
    if (!branchId && body.branch) {
        if (!mongoose.Types.ObjectId.isValid(body.branch)) throw httpErr(400, 'Invalid branch id.');
        branchId = body.branch;
    }

    const profQ = { restaurant: ctx.restaurantId, active: true };
    if (Array.isArray(body.staffIds) && body.staffIds.length) {
        if (!body.staffIds.every((i) => mongoose.Types.ObjectId.isValid(i))) throw httpErr(400, 'Invalid staff id in staffIds.');
        profQ.staff = { $in: body.staffIds };
    }
    const profiles = await StaffPayProfile.find(profQ).lean();
    const userQ = { _id: { $in: profiles.map((p) => p.staff) }, restaurant: ctx.restaurantId, status: 'active' };
    if (branchId) userQ.branch = branchId;
    const users = await User.find(userQ).select('name role staffId branch').lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    let eligible = profiles.filter((p) => userById.has(String(p.staff)));

    // Staff already in a finalized/paid run for an overlapping period are skipped.
    const skipped = [];
    const overlaps = await lockedOverlaps(ctx.restaurantId, eligible.map((p) => p.staff), from, to);
    const blocked = new Set();
    for (const r of overlaps) for (const l of r.lines || []) blocked.add(String(l.staff));
    eligible = eligible.filter((p) => {
        if (blocked.has(String(p.staff))) {
            skipped.push({ staff: p.staff, name: userById.get(String(p.staff))?.name || '', reason: 'already in a finalized run for an overlapping period' });
            return false;
        }
        return true;
    });
    if (!eligible.length) throw httpErr(400, 'No eligible staff with an active pay profile for this period.');

    const staffIds = eligible.map((p) => p.staff);
    const thresholds = Object.fromEntries(eligible.map((p) => [String(p.staff), p.overtimeThresholdHours || 8]));
    const attendance = await attendanceForPeriod({
        Shift, restaurantId: ctx.restaurantId, staffIds, from, to, timezone: tz, thresholds,
    });

    // Incentives: confirmed entries in the period not already paid in a locked run.
    const used = new Set();
    const lockedRuns = await PayrollRun.find({ restaurant: ctx.restaurantId, locked: true, 'lines.staff': { $in: staffIds } })
        .select('lines.incentiveEntryIds').lean();
    for (const r of lockedRuns) for (const l of r.lines || []) for (const id of l.incentiveEntryIds || []) used.add(String(id));
    const entries = await IncentiveEntry.find({
        restaurant: ctx.restaurantId, staff: { $in: staffIds }, state: 'confirmed', day: { $gte: from, $lte: to },
    }).select('staff amount').lean();
    const incByStaff = new Map();
    for (const e of entries) {
        if (used.has(String(e._id))) continue;
        const k = String(e.staff);
        const cur = incByStaff.get(k) || { amount: 0, ids: [] };
        cur.amount += Number(e.amount) || 0; cur.ids.push(e._id);
        incByStaff.set(k, cur);
    }

    // Tips paid out (informational): settlements recorded in the period.
    const { startOfBusinessDate, addDays } = require('../../utils/businessDate');
    const settlements = await TipSettlement.find({
        restaurant: ctx.restaurantId, waiter: { $in: staffIds },
        createdAt: { $gte: startOfBusinessDate(from, tz), $lt: startOfBusinessDate(addDays(to, 1), tz) },
    }).select('waiter amount').lean();
    const tipsByStaff = new Map();
    for (const s of settlements) tipsByStaff.set(String(s.waiter), (tipsByStaff.get(String(s.waiter)) || 0) + (Number(s.amount) || 0));

    const lines = eligible.map((p) => {
        const k = String(p.staff);
        const u = userById.get(k);
        const att = attendance.get(k);
        const pay = computeBaseAndOvertime(p, att, { from, to });
        const inc = incByStaff.get(k) || { amount: 0, ids: [] };
        return finishLine({
            staff: p.staff, staffName: u.name || '', role: u.role || '',
            payType: p.payType, baseRate: p.baseRate, overtimeRate: p.overtimeRate ?? null,
            daysPresent: att.daysPresent, hours: att.hours, regularHours: att.regularHours, overtimeHours: att.overtimeHours,
            basePay: pay.basePay, overtimePay: pay.overtimePay,
            incentives: round2(inc.amount), incentiveEntryIds: inc.ids,
            tipsPaidOut: round2(tipsByStaff.get(k) || 0),
            advances: 0, deductions: 0, adjustmentNote: '',
            warnings: att.warnings,
        });
    });

    const run = await PayrollRun.create({
        restaurant: ctx.restaurantId, branch: branchId, periodStart: from, periodEnd: to, timezone: tz,
        status: 'draft', locked: false, lines, totals: computeTotals(lines), createdBy: ctx.actorId || null,
    });
    return { run, skipped };
}

// ------------------------------------------------------------- adjustments
async function updateAdjustments(ctx, runId, adjustments) {
    if (!mongoose.Types.ObjectId.isValid(runId)) throw httpErr(400, 'Invalid run id.');
    if (!Array.isArray(adjustments) || !adjustments.length) throw httpErr(400, 'adjustments must be a non-empty array.');
    const run = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId });
    if (!run) throw httpErr(404, 'Payroll run not found.');
    assertBranchAccess(ctx, run);
    if (run.status !== 'draft') throw httpErr(409, 'Only a draft run can be edited.', 'RUN_LOCKED');

    const patched = run.lines.map((l) => (l.toObject ? l.toObject() : { ...l }));
    for (const a of adjustments) {
        const line = patched.find((l) => String(l.staff) === String(a.staff));
        if (!line) throw httpErr(404, 'Staff member is not in this run.');
        if (a.advances !== undefined) line.advances = validAmount(a.advances, 'Advances');
        if (a.deductions !== undefined) line.deductions = validAmount(a.deductions, 'Deductions');
        if (a.adjustmentNote !== undefined) line.adjustmentNote = String(a.adjustmentNote || '').slice(0, 300);
    }
    const lines = patched.map((l) => finishLine(l));
    run.lines = lines;
    run.totals = computeTotals(lines);
    await run.save();
    return run;
}

function assertBranchAccess(ctx, run) {
    if (ctx.pinnedBranchId && String(run.branch || '') !== String(ctx.pinnedBranchId)) {
        throw httpErr(403, 'This payroll run is outside your branch.');
    }
}

// ---------------------------------------------------------------- finalize
async function finalize(ctx, runId) {
    if (!mongoose.Types.ObjectId.isValid(runId)) throw httpErr(400, 'Invalid run id.');
    const run = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId }).lean();
    if (!run) throw httpErr(404, 'Payroll run not found.');
    assertBranchAccess(ctx, run);
    if (run.status !== 'draft') throw httpErr(409, 'Only a draft run can be finalized.', 'RUN_LOCKED');
    if (!run.lines.length) throw httpErr(400, 'Cannot finalize an empty run.');

    const staffIds = run.lines.map((l) => l.staff);
    const clash = await lockedOverlaps(ctx.restaurantId, staffIds, run.periodStart, run.periodEnd, run._id);
    if (clash.length) throw httpErr(409, 'A staff member in this run is already in a finalized run for an overlapping period.', 'PERIOD_OVERLAP');
    const incIds = run.lines.flatMap((l) => l.incentiveEntryIds || []);
    if (incIds.length) {
        const reused = await PayrollRun.findOne({
            restaurant: ctx.restaurantId, locked: true, _id: { $ne: run._id }, 'lines.incentiveEntryIds': { $in: incIds },
        }).select('_id').lean();
        if (reused) throw httpErr(409, 'Some incentives in this run were already paid in another run. Recreate the draft.', 'INCENTIVE_REUSED');
    }

    try {
        const done = await PayrollRun.findOneAndUpdate(
            { _id: runId, restaurant: ctx.restaurantId, status: 'draft' },
            { $set: { status: 'finalized', locked: true, finalizedBy: ctx.actorId || null, finalizedAt: new Date() } },
            { new: true },
        );
        if (!done) throw httpErr(409, 'Only a draft run can be finalized.', 'RUN_LOCKED');
        return done;
    } catch (e) {
        if (isDup(e)) throw httpErr(409, 'A staff member in this run is already in a finalized run for this period.', 'PERIOD_OVERLAP');
        throw e;
    }
}

// ----------------------------------------------------------------- pay out
async function markPaid(ctx, runId, body = {}) {
    if (!mongoose.Types.ObjectId.isValid(runId)) throw httpErr(400, 'Invalid run id.');
    const method = body.method;
    if (!['wallet', 'cash', 'bank'].includes(method)) throw httpErr(400, "method must be 'wallet', 'cash' or 'bank'.");
    const reference = String(body.reference || '').trim().slice(0, 120);

    if (method === 'wallet') return payViaWallet(ctx, runId);

    const existing = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId }).lean();
    if (!existing) throw httpErr(404, 'Payroll run not found.');
    assertBranchAccess(ctx, existing);
    if (existing.status === 'paid') {
        if (existing.payoutMethod === method) return { run: existing, alreadyPaid: true };
        throw httpErr(409, `Run is already paid via ${existing.payoutMethod}.`, 'ALREADY_PAID');
    }
    if (existing.status !== 'finalized') throw httpErr(409, 'Only a finalized run can be marked paid.', 'RUN_NOT_FINALIZED');
    const run = await PayrollRun.findOneAndUpdate(
        { _id: runId, restaurant: ctx.restaurantId, status: 'finalized' },
        { $set: { status: 'paid', paidBy: ctx.actorId || null, paidAt: new Date(), payoutMethod: method, payoutReference: reference } },
        { new: true },
    );
    if (!run) throw httpErr(409, 'Run was already paid.', 'ALREADY_PAID');
    return { run, alreadyPaid: false };
}

/**
 * Wallet payout: every line is credited inside ONE mongo transaction, together
 * with a unique PayrollPayout row per (run, staff) and the run's move to
 * 'paid'. Any failure rolls everything back; a retry after commit finds the
 * run 'paid' and returns without crediting; a concurrent duplicate loses on
 * the unique payout index / the conditional status update.
 */
async function payViaWallet(ctx, runId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const run = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId }).session(session);
        if (!run) throw httpErr(404, 'Payroll run not found.');
        assertBranchAccess(ctx, run);
        if (run.status === 'paid') {
            await session.abortTransaction();
            session.endSession();
            if (run.payoutMethod === 'wallet') return { run, alreadyPaid: true };
            throw httpErr(409, `Run is already paid via ${run.payoutMethod}.`, 'ALREADY_PAID');
        }
        if (run.status !== 'finalized') throw httpErr(409, 'Only a finalized run can be marked paid.', 'RUN_NOT_FINALIZED');

        const payLines = run.lines.filter((l) => l.netPay > 0);
        const users = await User.find({ _id: { $in: payLines.map((l) => l.staff) }, restaurant: ctx.restaurantId })
            .select('role name').session(session).lean();
        const roleById = new Map(users.map((u) => [String(u._id), u.role]));
        const bad = payLines.filter((l) => !WALLET_ROLES.has(roleById.get(String(l.staff))));
        if (bad.length) {
            throw httpErr(400, `Wallet payout is only available for waiter/captain. Use cash or bank for: ${bad.map((l) => l.staffName || l.staff).join(', ')}.`, 'WALLET_ROLE');
        }

        for (const l of payLines) {
            const amount = round2(l.netPay);
            const reference = `${run._id}:${l.staff}`;
            let wallet = await StaffWallet.findOne({ user: l.staff, restaurant: ctx.restaurantId }).session(session);
            if (!wallet) {
                wallet = new StaffWallet({ user: l.staff, restaurant: ctx.restaurantId, balance: 0, lifetimeCredits: 0, lifetimeDebits: 0 });
            }
            if (wallet.status === 'frozen') throw httpErr(409, `Wallet is frozen for ${l.staffName || l.staff}.`, 'WALLET_FROZEN');
            wallet.balance = round2(wallet.balance + amount);
            wallet.lifetimeCredits = round2(wallet.lifetimeCredits + amount);
            await wallet.save({ session });

            await new PayrollPayout({
                restaurant: ctx.restaurantId, run: run._id, staff: l.staff, amount, method: 'wallet', reference,
            }).save({ session });

            await new StaffWalletTransaction({
                restaurant: ctx.restaurantId, wallet: wallet._id, user: l.staff,
                type: 'adjustment', direction: 'credit', amount, balanceAfter: wallet.balance,
                referenceKind: 'AdminAdjustment', referenceId: run._id,
                note: `Payroll ${run.periodStart} to ${run.periodEnd}`,
            }).save({ session });
        }

        const upd = await PayrollRun.updateOne(
            { _id: run._id, restaurant: ctx.restaurantId, status: 'finalized' },
            { $set: { status: 'paid', paidBy: ctx.actorId || null, paidAt: new Date(), payoutMethod: 'wallet', payoutReference: 'wallet' } },
            { session },
        );
        if (!upd || (upd.modifiedCount ?? upd.nModified) !== 1) throw httpErr(409, 'Run was already paid.', 'ALREADY_PAID');

        await session.commitTransaction();
        session.endSession();
        const fresh = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId }).lean();
        return { run: fresh, alreadyPaid: false, credited: payLines.length };
    } catch (e) {
        try { await session.abortTransaction(); } catch { /* already aborted */ }
        session.endSession();
        if (isDup(e)) throw httpErr(409, 'This run is already being paid or was paid.', 'ALREADY_PAID');
        throw e;
    }
}

// ------------------------------------------------------------------- reads
async function listRuns(ctx) {
    const q = { restaurant: ctx.restaurantId };
    if (ctx.pinnedBranchId) q.branch = ctx.pinnedBranchId;
    return PayrollRun.find(q).select('-lines').sort({ periodStart: -1, createdAt: -1 }).limit(100).lean();
}

async function getRun(ctx, runId) {
    if (!mongoose.Types.ObjectId.isValid(runId)) throw httpErr(400, 'Invalid run id.');
    const run = await PayrollRun.findOne({ _id: runId, restaurant: ctx.restaurantId }).lean();
    if (!run) throw httpErr(404, 'Payroll run not found.');
    assertBranchAccess(ctx, run);
    return run;
}

// --------------------------------------------------------------- exports
const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;   // spreadsheet formula guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(run) {
    const head = ['Staff', 'Role', 'Pay type', 'Rate', 'Days present', 'Hours', 'Overtime hours', 'Base pay', 'Overtime pay',
        'Incentives', 'Tips paid out (info)', 'Advances', 'Deductions', 'Net pay', 'Note'];
    const rows = run.lines.map((l) => [l.staffName, l.role, l.payType, l.baseRate, l.daysPresent, l.hours, l.overtimeHours,
        l.basePay, l.overtimePay, l.incentives, l.tipsPaidOut, l.advances, l.deductions, l.netPay, l.adjustmentNote]);
    const t = run.totals || {};
    rows.push(['TOTAL', '', '', '', '', '', '', t.basePay, t.overtimePay, t.incentives, '', t.advances, t.deductions, t.netPay, '']);
    return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function findLine(run, staffId) {
    const line = run.lines.find((l) => String(l.staff) === String(staffId));
    if (!line) throw httpErr(404, 'Staff member is not in this run.');
    return line;
}

function payslipJson(run, staffId, restaurantName = '') {
    const l = findLine(run, staffId);
    return {
        restaurantName,
        runId: run._id, status: run.status, periodStart: run.periodStart, periodEnd: run.periodEnd,
        paidAt: run.paidAt || null, payoutMethod: run.payoutMethod || null,
        staff: { _id: l.staff, name: l.staffName, role: l.role },
        payType: l.payType, rate: l.baseRate,
        attendance: { daysPresent: l.daysPresent, hours: l.hours, regularHours: l.regularHours, overtimeHours: l.overtimeHours },
        earnings: { basePay: l.basePay, overtimePay: l.overtimePay, incentives: l.incentives, grossPay: l.grossPay },
        deductions: { advances: l.advances, deductions: l.deductions },
        tipsPaidOutInfo: l.tipsPaidOut,
        netPay: l.netPay, note: l.adjustmentNote || '',
        disclaimer: 'Attendance-based payout. No statutory deductions (PF/ESI/TDS) are included.',
    };
}

const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (n) => (Number(n) || 0).toFixed(2);

function payslipHtml(run, staffId, restaurantName = '') {
    const p = payslipJson(run, staffId, restaurantName);
    const row = (k, v) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(p.staff.name)} ${esc(p.periodStart)}</title>
<style>body{font-family:Arial,sans-serif;max-width:640px;margin:24px auto;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}
td{padding:6px 8px;border-bottom:1px solid #ddd}td.r{text-align:right}h1{font-size:20px}h2{font-size:15px;margin:16px 0 0}.net td{font-weight:bold;border-top:2px solid #111}
.note{font-size:12px;color:#555}</style></head><body>
<h1>${esc(p.restaurantName || 'Payslip')}</h1>
<p>Payslip for <b>${esc(p.staff.name)}</b> (${esc(p.staff.role)})<br>Period: ${esc(p.periodStart)} to ${esc(p.periodEnd)} &middot; Status: ${esc(p.status)}</p>
<h2>Attendance</h2><table>${row('Days present', p.attendance.daysPresent)}${row('Hours worked', p.attendance.hours)}${row('Overtime hours', p.attendance.overtimeHours)}</table>
<h2>Earnings</h2><table>${row('Base pay', money(p.earnings.basePay))}${row('Overtime pay', money(p.earnings.overtimePay))}${row('Incentives', money(p.earnings.incentives))}${row('Gross', money(p.earnings.grossPay))}</table>
<h2>Deductions</h2><table>${row('Advances', money(p.deductions.advances))}${row('Other deductions', money(p.deductions.deductions))}</table>
<table><tr class="net"><td>Net pay</td><td class="r">${money(p.netPay)}</td></tr></table>
<p class="note">Tips already paid out in this period (information only, not part of net pay): ${money(p.tipsPaidOutInfo)}</p>
${p.note ? `<p class="note">Note: ${esc(p.note)}</p>` : ''}
<p class="note">${esc(p.disclaimer)}</p></body></html>`;
}

module.exports = {
    PAYABLE_ROLES, listProfiles, upsertProfile, parseProfileBody, createDraft, updateAdjustments, finalize, markPaid,
    listRuns, getRun, toCsv, payslipJson, payslipHtml, csvCell,
};
