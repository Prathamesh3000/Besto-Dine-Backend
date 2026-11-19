/** BUG-27: a payroll run with no attendance / no net pay cannot be finalized or paid. */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const PayrollRun = require(path.join(BACKEND, 'models/payrollRun'));
const StaffPayProfile = require(path.join(BACKEND, 'models/staffPayProfile'));

const ctx = useIntegrationApp();
let A;
const admin = () => ctx.api.as(A.users.admin);
let seq = 0;
const period = () => { seq += 1; const d = String(seq).padStart(2, '0'); return { periodStart: `2026-02-${d}`, periodEnd: `2026-02-${d}` }; };

beforeAll(async () => { A = await seedTenant({ label: 'pre' }); });

const line = (staff, netPay, extra = {}) => ({
    staff: staff._id, staffName: staff.name, role: 'waiter', payType: 'daily', baseRate: 500,
    basePay: netPay, netPay, ...extra,
});
const mkRun = (lines) => PayrollRun.create({
    restaurant: A.restaurant._id, ...period(), status: 'draft', lines,
    totals: { staffCount: lines.length, netPay: lines.reduce((s, l) => s + l.netPay, 0) },
});

describe('payroll empty run (BUG-27)', () => {
    test('draft created for a period with no attendance: finalize -> 409 EMPTY_RUN, run stays draft', async () => {
        await StaffPayProfile.create({ restaurant: A.restaurant._id, staff: A.users.waiter._id, payType: 'daily', baseRate: 500, active: true });
        const c = await admin().post('/payroll/runs').send({ periodStart: '2020-01-01', periodEnd: '2020-01-02' });
        expect(c.status).toBeLessThan(300);
        const id = c.body.run._id;
        expect(c.body.run.totals.netPay).toBe(0);
        const fin = await admin().post(`/payroll/runs/${id}/finalize`).send({});
        expect(fin.status).toBe(409);
        expect(fin.body.code).toBe('EMPTY_RUN');
        expect(fin.body.message).toMatch(/No attendance in this period: nothing to pay/);
        expect((await PayrollRun.findById(id).lean()).status).toBe('draft');
    });

    test('a finalized zero-net run cannot be paid (wallet or cash)', async () => {
        const run = await mkRun([line(A.users.waiter, 0)]);
        await PayrollRun.updateOne({ _id: run._id }, { $set: { status: 'finalized', locked: true } });
        for (const method of ['wallet', 'cash']) {
            const r = await admin().post(`/payroll/runs/${run._id}/pay`).send({ method });
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('EMPTY_RUN');
        }
        expect((await PayrollRun.findById(run._id).lean()).status).toBe('finalized');
    });

    test('run with some zero-net lines but positive total finalizes and pays', async () => {
        const run = await mkRun([line(A.users.waiter, 500), line(A.users.chef, 0, { role: 'chef' })]);
        const fin = await admin().post(`/payroll/runs/${run._id}/finalize`).send({});
        expect(fin.status).toBe(200);
        expect(fin.body.run.status).toBe('finalized');
        const pay = await admin().post(`/payroll/runs/${run._id}/pay`).send({ method: 'cash' });
        expect(pay.status).toBe(200);
        expect((await PayrollRun.findById(run._id).lean()).status).toBe('paid');
    });
});
