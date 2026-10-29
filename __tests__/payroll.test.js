/**
 * Simple payroll (attendance + wallet payout; not statutory payroll).
 * Pure calcs, attendance edge cases, unique-run index, finalize locks and
 * wallet payout idempotency (models mocked, no DB).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// Chainable query stub: every builder method returns the same thenable.
const mockQ = (val) => {
    const p = Promise.resolve(val);
    p.session = () => p; p.lean = () => p; p.select = () => p; p.sort = () => p; p.limit = () => p;
    return p;
};

const mockState = {
    run: null,           // the single PayrollRun doc the fakes serve
    wallets: new Map(),
    payouts: new Set(),
    txns: [],
    users: [],
    otherLocked: [],     // result of locked-overlap queries
    session: null,
};

jest.mock('../models/payrollRun', () => ({
    findOne: jest.fn(() => mockQ(mockState.run)),
    find: jest.fn(() => mockQ(mockState.otherLocked)),
    updateOne: jest.fn(async (q) => {
        if (mockState.run && mockState.run.status === q.status) {
            mockState.run.status = 'paid';
            mockState.run.payoutMethod = 'wallet';
            return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
    }),
    findOneAndUpdate: jest.fn(async (q, upd) => {
        if (mockState.run && mockState.run.status === q.status) {
            Object.assign(mockState.run, upd.$set);
            return mockState.run;
        }
        return null;
    }),
    create: jest.fn(),
}));
jest.mock('../models/payrollPayout', () => class {
    constructor(d) { Object.assign(this, d); }
    async save() {
        if (mockState.payouts.has(this.reference)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        mockState.payouts.add(this.reference);
    }
});
jest.mock('../models/staffWallet', () => {
    const C = class {
        constructor(d) { Object.assign(this, { status: 'active', _id: `w-${d.user}` }, d); }
        async save() { mockState.wallets.set(String(this.user), this); }
    };
    C.findOne = jest.fn((q) => mockQ(mockState.wallets.get(String(q.user)) || null));
    return C;
});
jest.mock('../models/staffWalletTransaction', () => class {
    constructor(d) { Object.assign(this, d); }
    async save() { mockState.txns.push(this); }
});
jest.mock('../models/user', () => ({ find: jest.fn(() => mockQ(mockState.users)), findOne: jest.fn() }));
jest.mock('../models/staffPayProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/shift', () => ({ find: jest.fn() }));
jest.mock('../models/incentiveEntry', () => ({ find: jest.fn() }));
jest.mock('../models/tipSettlement', () => ({ find: jest.fn() }));

const mongoose = require('mongoose');
const {
    round2, validAmount, computeBaseAndOvertime, finishLine, computeTotals,
} = require('../services/payroll/payCalc');
const { summarizeShifts } = require('../services/payroll/attendanceSummary');
const svc = require('../services/payroll/payrollService');

const oid = () => new mongoose.Types.ObjectId();
const IST = 'Asia/Kolkata';

describe('pay calculations', () => {
    const att = (o) => ({ daysPresent: 0, hours: 0, regularHours: 0, overtimeHours: 0, ...o });

    test('monthly: full attendance pays the full salary; prorated by attendance', () => {
        const p = { payType: 'monthly', baseRate: 26000, workingDaysPerMonth: 26 };
        const period = { from: '2026-10-01', to: '2026-10-31' };
        expect(computeBaseAndOvertime(p, att({ daysPresent: 26 }), period).basePay).toBe(26000);
        expect(computeBaseAndOvertime(p, att({ daysPresent: 30 }), period).basePay).toBe(26000);   // capped
        expect(computeBaseAndOvertime(p, att({ daysPresent: 13 }), period).basePay).toBe(13000);
    });

    test('monthly: a half-month period pays half of the month', () => {
        const p = { payType: 'monthly', baseRate: 30000, workingDaysPerMonth: 26 };
        const r = computeBaseAndOvertime(p, att({ daysPresent: 100 }), { from: '2026-09-01', to: '2026-09-15' });
        expect(r.basePay).toBe(15000);
    });

    test('daily: days present x rate; overtime only when an overtime rate is set', () => {
        const base = { payType: 'daily', baseRate: 700 };
        const a = att({ daysPresent: 20, overtimeHours: 5 });
        expect(computeBaseAndOvertime(base, a, {}).basePay).toBe(14000);
        expect(computeBaseAndOvertime(base, a, {}).overtimePay).toBe(0);
        expect(computeBaseAndOvertime({ ...base, overtimeRate: 120 }, a, {}).overtimePay).toBe(600);
    });

    test('hourly: regular hours x rate; overtime at overtimeRate, else at base rate', () => {
        const a = att({ regularHours: 100, overtimeHours: 10, hours: 110 });
        const base = { payType: 'hourly', baseRate: 80.5 };
        expect(computeBaseAndOvertime(base, a, {}).basePay).toBe(8050);
        expect(computeBaseAndOvertime(base, a, {}).overtimePay).toBe(805);
        expect(computeBaseAndOvertime({ ...base, overtimeRate: 120 }, a, {}).overtimePay).toBe(1200);
    });

    test('net = base + overtime + incentives - advances - deductions; negative net rejected', () => {
        const l = finishLine({ basePay: 1000, overtimePay: 100, incentives: 50.55, advances: 200, deductions: 0.1 });
        expect(l.grossPay).toBe(1150.55);
        expect(l.netPay).toBe(950.45);
        expect(() => finishLine({ basePay: 100, overtimePay: 0, incentives: 0, advances: 150, deductions: 0 })).toThrow(/exceed/);
    });

    test('totals and rounding use round2', () => {
        expect(round2(1.005 + 0.1)).toBe(1.11);
        const t = computeTotals([
            { basePay: 10.1, overtimePay: 0, incentives: 0, advances: 0, deductions: 0, netPay: 10.1 },
            { basePay: 20.2, overtimePay: 1, incentives: 2, advances: 3, deductions: 0, netPay: 20.2 },
        ]);
        expect(t).toMatchObject({ staffCount: 2, basePay: 30.3, netPay: 30.3 });
    });

    test('amount validation: non-negative, finite, sane maximum', () => {
        expect(validAmount('12.345')).toBe(12.35);
        expect(validAmount(undefined)).toBe(0);
        for (const bad of [-1, 'abc', Infinity, 1e9]) expect(() => validAmount(bad)).toThrow(/between 0 and/);
    });
});

describe('attendance summary', () => {
    const opts = { timezone: IST, from: '2026-10-01', to: '2026-10-31', overtimeThresholdHours: 8 };
    const sh = (status, inIso, outIso, totalHours = 0) => ({ status, clockIn: new Date(inIso), clockOut: outIso ? new Date(outIso) : null, totalHours });

    test('completed shifts: days, hours and per-day overtime', () => {
        const r = summarizeShifts([
            sh('completed', '2026-10-05T04:00:00Z', '2026-10-05T14:00:00Z'),   // 10h => 2 OT
            sh('completed', '2026-10-06T04:00:00Z', '2026-10-06T10:00:00Z'),   // 6h
        ], opts);
        expect(r).toMatchObject({ daysPresent: 2, hours: 16, overtimeHours: 2, regularHours: 14 });
    });

    test('two shifts on one business day count as one day and add up for overtime', () => {
        const r = summarizeShifts([
            sh('completed', '2026-10-05T03:00:00Z', '2026-10-05T08:00:00Z'),   // 5h
            sh('completed', '2026-10-05T10:00:00Z', '2026-10-05T14:00:00Z'),   // 4h
        ], opts);
        expect(r).toMatchObject({ daysPresent: 1, hours: 9, overtimeHours: 1 });
    });

    test('open (active) shift is not paid and raises a warning', () => {
        const r = summarizeShifts([sh('active', '2026-10-07T04:00:00Z', null)], opts);
        expect(r.daysPresent).toBe(0);
        expect(r.hours).toBe(0);
        expect(r.openShifts).toBe(1);
        expect(r.warnings.join(' ')).toMatch(/open shift/);
    });

    test('auto-closed (missed) shift counts at its capped hours and warns', () => {
        const r = summarizeShifts([sh('missed', '2026-10-07T04:00:00Z', '2026-10-07T20:00:00Z', 16)], opts);
        expect(r).toMatchObject({ daysPresent: 1, hours: 16, overtimeHours: 8, autoClosedShifts: 1 });
        expect(r.warnings.join(' ')).toMatch(/auto-closed/);
    });

    test('a shift crossing midnight belongs to the business day it started on (restaurant timezone)', () => {
        // 23:00 IST on 5 Oct (17:30Z) to 03:00 IST on 6 Oct.
        const r = summarizeShifts([sh('completed', '2026-10-05T17:30:00Z', '2026-10-05T21:30:00Z')], opts);
        expect(r.byDay).toEqual([{ day: '2026-10-05', hours: 4, overtime: 0 }]);
        // Same instant seen from UTC would be 5 Oct too, but 19:00Z->6 Oct IST proves tz use:
        const r2 = summarizeShifts([sh('completed', '2026-10-05T19:00:00Z', '2026-10-05T23:00:00Z')], opts);
        expect(r2.byDay[0].day).toBe('2026-10-06');
    });

    test('shifts outside the period are ignored; absurd hours clamp to 24', () => {
        const r = summarizeShifts([
            sh('completed', '2026-09-30T04:00:00Z', '2026-09-30T10:00:00Z'),
            sh('completed', '2026-10-02T00:00:00Z', '2026-10-09T00:00:00Z'),
        ], opts);
        expect(r.daysPresent).toBe(1);
        expect(r.hours).toBe(24);
    });
});

describe('PayrollRun unique index', () => {
    test('a staff + exact period can be in only one LOCKED run (partial unique index)', () => {
        const real = jest.requireActual('../models/payrollRun');
        const idx = real.schema.indexes().find(([, o]) => o.name === 'payroll_staff_period_once');
        expect(idx).toBeTruthy();
        expect(idx[0]).toEqual({ restaurant: 1, 'lines.staff': 1, periodStart: 1, periodEnd: 1 });
        expect(idx[1]).toMatchObject({ unique: true, partialFilterExpression: { locked: true } });
    });

    test('wallet payout idempotency index is unique per (run, staff)', () => {
        const real = jest.requireActual('../models/payrollPayout');
        const idx = real.schema.indexes().find(([k]) => k.run === 1 && k.staff === 1);
        expect(idx[1].unique).toBe(true);
    });
});

describe('finalize locks the run', () => {
    const PayrollRun = require('../models/payrollRun');
    const ctx = { restaurantId: oid(), actorId: oid(), pinnedBranchId: null, timezone: IST };
    const mkRun = (status) => ({
        _id: oid(), status, locked: status !== 'draft', periodStart: '2026-10-01', periodEnd: '2026-10-31', branch: null,
        lines: [{ staff: oid(), staffName: 'A', netPay: 100, basePay: 100, overtimePay: 0, incentives: 0, advances: 0, deductions: 0, incentiveEntryIds: [] }],
        save: jest.fn(),
    });
    beforeEach(() => { mockState.otherLocked = []; PayrollRun.findOneAndUpdate.mockClear(); });

    test('draft -> finalized, then a second finalize and any edit are refused with 409', async () => {
        mockState.run = mkRun('draft');
        const done = await svc.finalize(ctx, String(mockState.run._id));
        expect(done.status).toBe('finalized');
        expect(done.locked).toBe(true);
        await expect(svc.finalize(ctx, String(mockState.run._id))).rejects.toMatchObject({ status: 409, code: 'RUN_LOCKED' });
        await expect(svc.updateAdjustments(ctx, String(mockState.run._id), [{ staff: mockState.run.lines[0].staff, advances: 5 }]))
            .rejects.toMatchObject({ status: 409, code: 'RUN_LOCKED' });
        expect(mockState.run.save).not.toHaveBeenCalled();
    });

    test('overlapping locked run for the same staff blocks finalize', async () => {
        mockState.run = mkRun('draft');
        mockState.otherLocked = [{ _id: oid() }];
        await expect(svc.finalize(ctx, String(mockState.run._id))).rejects.toMatchObject({ status: 409, code: 'PERIOD_OVERLAP' });
        expect(PayrollRun.findOneAndUpdate).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ status: 'finalized' }) }), expect.anything());
    });

    test('unique-index violation at lock time surfaces as 409', async () => {
        mockState.run = mkRun('draft');
        PayrollRun.findOneAndUpdate.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
        await expect(svc.finalize(ctx, String(mockState.run._id))).rejects.toMatchObject({ status: 409, code: 'PERIOD_OVERLAP' });
    });

    test('draft adjustments recompute net and totals; over-deduction rejected', async () => {
        mockState.run = mkRun('draft');
        const staff = mockState.run.lines[0].staff;
        const run = await svc.updateAdjustments(ctx, String(mockState.run._id), [{ staff, advances: 30, deductions: 20 }]);
        expect(run.lines[0].netPay).toBe(50);
        expect(run.totals.netPay).toBe(50);
        await expect(svc.updateAdjustments(ctx, String(mockState.run._id), [{ staff, advances: 500 }])).rejects.toMatchObject({ status: 400 });
        await expect(svc.updateAdjustments(ctx, String(mockState.run._id), [{ staff, advances: -1 }])).rejects.toMatchObject({ status: 400 });
    });
});

describe('wallet payout is idempotent', () => {
    const ctx = { restaurantId: oid(), actorId: oid(), pinnedBranchId: null };
    let session;
    let waiter;
    let captain;

    beforeEach(() => {
        waiter = oid(); captain = oid();
        session = { startTransaction: jest.fn(), commitTransaction: jest.fn(async () => {}), abortTransaction: jest.fn(async () => {}), endSession: jest.fn() };
        jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
        mockState.wallets = new Map();
        mockState.payouts = new Set();
        mockState.txns = [];
        mockState.users = [{ _id: waiter, role: 'waiter' }, { _id: captain, role: 'captain' }];
        mockState.run = {
            _id: oid(), status: 'finalized', periodStart: '2026-10-01', periodEnd: '2026-10-31', branch: null,
            lines: [
                { staff: waiter, staffName: 'W', netPay: 1500.555 },
                { staff: captain, staffName: 'C', netPay: 2000 },
            ],
        };
        const PayrollRun = require('../models/payrollRun');
        PayrollRun.findOne.mockImplementation(() => mockQ(mockState.run));
    });
    afterEach(() => jest.restoreAllMocks());

    test('credits each line once in one transaction; a retry does not credit again', async () => {
        const id = String(mockState.run._id);
        const first = await svc.markPaid(ctx, id, { method: 'wallet' });
        expect(first.alreadyPaid).toBe(false);
        expect(first.credited).toBe(2);
        expect(session.commitTransaction).toHaveBeenCalledTimes(1);
        expect(mockState.wallets.get(String(waiter)).balance).toBe(1500.56);
        expect(mockState.wallets.get(String(captain)).balance).toBe(2000);
        expect(mockState.txns).toHaveLength(2);
        expect(mockState.payouts.size).toBe(2);

        const second = await svc.markPaid(ctx, id, { method: 'wallet' });
        expect(second.alreadyPaid).toBe(true);
        expect(mockState.wallets.get(String(waiter)).balance).toBe(1500.56);
        expect(mockState.txns).toHaveLength(2);
        expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    });

    test('a concurrent duplicate that slips past the status check loses on the unique payout row (409, aborted)', async () => {
        mockState.payouts.add(`${mockState.run._id}:${waiter}`);   // the other request already inserted it
        await expect(svc.markPaid(ctx, String(mockState.run._id), { method: 'wallet' }))
            .rejects.toMatchObject({ status: 409, code: 'ALREADY_PAID' });
        expect(session.abortTransaction).toHaveBeenCalled();
        expect(session.commitTransaction).not.toHaveBeenCalled();
    });

    test('draft run cannot be paid; non waiter/captain cannot be paid by wallet; frozen wallet aborts', async () => {
        mockState.run.status = 'draft';
        await expect(svc.markPaid(ctx, String(mockState.run._id), { method: 'wallet' })).rejects.toMatchObject({ status: 409, code: 'RUN_NOT_FINALIZED' });

        mockState.run.status = 'finalized';
        mockState.users = [{ _id: waiter, role: 'chef' }, { _id: captain, role: 'captain' }];
        await expect(svc.markPaid(ctx, String(mockState.run._id), { method: 'wallet' })).rejects.toMatchObject({ status: 400, code: 'WALLET_ROLE' });
        expect(mockState.wallets.size).toBe(0);

        mockState.users = [{ _id: waiter, role: 'waiter' }, { _id: captain, role: 'captain' }];
        const StaffWallet = require('../models/staffWallet');
        mockState.wallets.set(String(captain), new StaffWallet({ user: captain, balance: 0, lifetimeCredits: 0, status: 'frozen' }));
        await expect(svc.markPaid(ctx, String(mockState.run._id), { method: 'wallet' })).rejects.toMatchObject({ status: 409, code: 'WALLET_FROZEN' });
        expect(session.commitTransaction).not.toHaveBeenCalled();
    });

    test('cash / bank just records the payout, once', async () => {
        const id = String(mockState.run._id);
        const a = await svc.markPaid(ctx, id, { method: 'cash', reference: 'petty cash' });
        expect(a.run.status).toBe('paid');
        expect(a.alreadyPaid).toBe(false);
        expect(mockState.wallets.size).toBe(0);
        const b = await svc.markPaid(ctx, id, { method: 'cash' });
        expect(b.alreadyPaid).toBe(true);
        await expect(svc.markPaid(ctx, id, { method: 'bank' })).rejects.toMatchObject({ status: 409, code: 'ALREADY_PAID' });
        await expect(svc.markPaid(ctx, id, { method: 'cheque' })).rejects.toMatchObject({ status: 400 });
    });
});

describe('exports', () => {
    const run = {
        _id: 'r1', status: 'paid', periodStart: '2026-10-01', periodEnd: '2026-10-31', payoutMethod: 'cash', paidAt: null,
        totals: { basePay: 100, overtimePay: 0, incentives: 0, advances: 0, deductions: 0, netPay: 100 },
        lines: [{ staff: 's1', staffName: '=HYPERLINK("x")', role: 'waiter', payType: 'daily', baseRate: 100, daysPresent: 1, hours: 8, regularHours: 8, overtimeHours: 0, basePay: 100, overtimePay: 0, incentives: 0, tipsPaidOut: 5, advances: 0, deductions: 0, grossPay: 100, netPay: 100, adjustmentNote: '<b>hi</b>' }],
    };

    test('CSV neutralises formula injection and ends with a totals row', () => {
        const csv = svc.toCsv(run);
        expect(csv).toContain("'=HYPERLINK");
        expect(csv.trim().split('\r\n').pop()).toMatch(/^TOTAL/);
    });

    test('payslip HTML escapes user text; JSON has no statutory lines', () => {
        const html = svc.payslipHtml(run, 's1', 'Cafe <X>');
        expect(html).not.toContain('<b>hi</b>');
        expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
        expect(html).toContain('Cafe &lt;X&gt;');
        const j = svc.payslipJson(run, 's1');
        expect(j.netPay).toBe(100);
        expect(j.disclaimer).toMatch(/No statutory/);
        expect(() => svc.payslipJson(run, 'nope')).toThrow(/not in this run/);
    });
});

describe('profile validation', () => {
    test('rejects bad pay type, negative or absurd rates', () => {
        expect(() => svc.parseProfileBody({ payType: 'weekly', baseRate: 1 })).toThrow();
        expect(() => svc.parseProfileBody({ payType: 'daily', baseRate: -5 })).toThrow();
        expect(() => svc.parseProfileBody({ payType: 'hourly', baseRate: 1e6 })).toThrow();
        expect(svc.parseProfileBody({ payType: 'monthly', baseRate: 25000 })).toMatchObject({ overtimeRate: null, overtimeThresholdHours: 8, active: true });
    });
});
