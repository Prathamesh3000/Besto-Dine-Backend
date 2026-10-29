/**
 * Scheduled reports + GST/Tally endpoints. Models are mocked (no DB).
 */
jest.mock('../models/reportSchedule', () => ({
    find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
    countDocuments: jest.fn(), create: jest.fn(), deleteOne: jest.fn(),
}));
jest.mock('../models/settings', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../services/gstReportService', () => ({
    loadTenantTaxContext: jest.fn(),
    generateGstReport: jest.fn(),
}));

const ReportSchedule = require('../models/reportSchedule');
const Settings = require('../models/settings');
const gstSvc = require('../services/gstReportService');
const svc = require('../services/reportScheduleService');
const scheduleCtl = require('../controllers/reportScheduleController');
const gstCtl = require('../controllers/gstReportController');
const { buildGstReport } = require('../utils/gstReport');

const TENANT = { _id: 'rest1', timezone: 'Asia/Kolkata' };
const D = (s) => new Date(s);

function res() {
    const r = { headers: {}, statusCode: 200 };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.sent = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
}
const call = async (fn, req) => { const r = res(); await fn({ restaurant: TENANT, user: { _id: 'u1' }, query: {}, body: {}, params: {}, ...req }, r, (e) => { r.err = e; }); return r; };

describe('duePeriod', () => {
    const tz = 'Asia/Kolkata';
    test('daily: yesterday once the hour has passed, day before otherwise', () => {
        // 2026-10-29 09:00 IST
        expect(svc.duePeriod({ frequency: 'daily', hour: 8 }, D('2026-10-29T03:30:00Z'), tz).key).toBe('2026-10-28');
        // 07:00 IST: today's is not due yet
        expect(svc.duePeriod({ frequency: 'daily', hour: 8 }, D('2026-10-29T01:30:00Z'), tz).key).toBe('2026-10-27');
    });
    test('weekly: last Monday to Sunday', () => {
        const p = svc.duePeriod({ frequency: 'weekly', hour: 8 }, D('2026-10-29T03:30:00Z'), tz); // Thursday
        expect(p).toEqual({ key: '2026-10-19', from: '2026-10-19', to: '2026-10-25' });
    });
    test('monthly: previous calendar month, across a year boundary', () => {
        expect(svc.duePeriod({ frequency: 'monthly', hour: 8 }, D('2026-10-29T03:30:00Z'), tz)).toEqual({ key: '2026-09', from: '2026-09-01', to: '2026-09-30' });
        expect(svc.duePeriod({ frequency: 'monthly', hour: 8 }, D('2027-01-05T10:00:00Z'), tz)).toEqual({ key: '2026-12', from: '2026-12-01', to: '2026-12-31' });
    });
});

describe('validateRecipients', () => {
    test('accepts, lowercases and de-duplicates', () => {
        expect(svc.validateRecipients(['A@x.com', 'a@x.com', ' b@y.in '])).toEqual({ recipients: ['a@x.com', 'b@y.in'] });
    });
    test('rejects empty, bad and too many', () => {
        expect(svc.validateRecipients([]).error).toBeTruthy();
        expect(svc.validateRecipients(['nope']).error).toMatch(/Invalid/);
        expect(svc.validateRecipients(['a@b.co, c@d.co']).error).toMatch(/Invalid/);
        expect(svc.validateRecipients(Array.from({ length: 6 }, (_, i) => `u${i}@x.com`)).error).toMatch(/At most/);
        expect(svc.validateRecipients('a@b.co').error).toBeTruthy();
    });
});

describe('runDueSchedules idempotency', () => {
    // Minimal in-memory ReportSchedule honouring the conditional claim.
    function fakeModel(docs) {
        return {
            find: () => ({ limit: () => ({ lean: async () => docs.filter((d) => d.enabled).map((d) => ({ ...d })) }) }),
            findOneAndUpdate: async (filter, update) => {
                const d = docs.find((x) => x._id === filter._id && x.enabled === filter.enabled);
                if (!d || d.lastPeriodKey === filter.lastPeriodKey.$ne) return null;
                const before = { ...d };
                Object.assign(d, update.$set);
                return before;
            },
            updateOne: async (filter, update) => {
                const d = docs.find((x) => x._id === filter._id);
                if (d && (filter.lastPeriodKey === undefined || d.lastPeriodKey === filter.lastPeriodKey)) Object.assign(d, update.$set);
            },
        };
    }
    function mkDeps(docs, sendEmail) {
        const report = buildGstReport({ orders: [], tz: 'Asia/Kolkata', range: { from: '2026-10-28', to: '2026-10-28' } });
        return {
            ReportSchedule: fakeModel(docs),
            sendEmail,
            loadTenantTaxContext: async () => ({ tz: 'Asia/Kolkata', taxpayer: { name: 'Demo Cafe', gstin: '' } }),
            generateGstReport: async () => ({ report }),
        };
    }
    const base = () => ({ _id: 's1', restaurant: 'rest1', type: 'daily-sales', frequency: 'daily', hour: 8, recipients: ['a@x.com', 'b@x.com'], enabled: true, lastPeriodKey: '2026-10-27', lastError: '' });
    const now = D('2026-10-29T03:30:00Z');

    test('sends once per period, never twice', async () => {
        const docs = [base()];
        const sendEmail = jest.fn(async () => ({ sent: true }));
        const deps = mkDeps(docs, sendEmail);
        expect(await svc.runDueSchedules({ now, deps })).toMatchObject({ sent: 1 });
        expect(sendEmail).toHaveBeenCalledTimes(2); // two recipients
        expect(sendEmail.mock.calls[0][0].attachments[0].filename).toBe('daily-sales-2026-10-28.csv');
        expect(docs[0].lastPeriodKey).toBe('2026-10-28');
        // second tick, same period
        expect(await svc.runDueSchedules({ now: D('2026-10-29T04:00:00Z'), deps })).toMatchObject({ sent: 0, skipped: 1 });
        expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    test('two racing instances: only the claim winner sends', async () => {
        const docs = [base()];
        const sendEmail = jest.fn(async () => ({ sent: true }));
        const deps = mkDeps(docs, sendEmail);
        const stale = { ...docs[0] }; // both instances read the same stale doc
        const out = await Promise.all([svc.processSchedule(stale, now, deps), svc.processSchedule(stale, now, deps)]);
        expect(out.sort()).toEqual(['lost-claim', 'sent']);
        expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    test('total failure rolls the claim back so the next tick retries', async () => {
        const docs = [base()];
        const sendEmail = jest.fn(async () => ({ sent: false, error: 'smtp down' }));
        const deps = mkDeps(docs, sendEmail);
        expect(await svc.runDueSchedules({ now, deps })).toMatchObject({ failed: 1 });
        expect(docs[0].lastPeriodKey).toBe('2026-10-27');
        expect(docs[0].lastError).toMatch(/smtp down/);
        sendEmail.mockImplementation(async () => ({ sent: true }));
        expect(await svc.runDueSchedules({ now, deps })).toMatchObject({ sent: 1 });
    });

    test('partial failure keeps the claim (no duplicate mails) and records the error', async () => {
        const docs = [base()];
        const sendEmail = jest.fn(async ({ to }) => (to === 'a@x.com' ? { sent: true } : { sent: false, error: 'bounced' }));
        const deps = mkDeps(docs, sendEmail);
        expect(await svc.runDueSchedules({ now, deps })).toMatchObject({ sent: 1 });
        expect(docs[0].lastPeriodKey).toBe('2026-10-28');
        expect(docs[0].lastError).toMatch(/b@x.com/);
    });

    test('dev mode (no mail transport): nothing sent, period kept, clear note', async () => {
        const docs = [base()];
        const deps = mkDeps(docs, jest.fn(async () => ({ sent: false, dev: true })));
        await svc.runDueSchedules({ now, deps });
        expect(docs[0].lastPeriodKey).toBe('2026-10-28');
        expect(docs[0].lastError).toMatch(/not configured/);
    });

    test('disabled schedules are ignored', async () => {
        const docs = [{ ...base(), enabled: false }];
        const sendEmail = jest.fn();
        expect(await svc.runDueSchedules({ now, deps: mkDeps(docs, sendEmail) })).toMatchObject({ sent: 0 });
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('schedule endpoints', () => {
    beforeEach(() => jest.clearAllMocks());

    test('create: validates, caps per tenant, starts from the next boundary', async () => {
        ReportSchedule.countDocuments.mockResolvedValue(0);
        ReportSchedule.create.mockImplementation(async (d) => ({ _id: 'n1', ...d }));
        const ok = await call(scheduleCtl.create, { body: { type: 'gst-summary', frequency: 'monthly', hour: 9, recipients: ['CA@firm.com'] } });
        expect(ok.statusCode).toBe(201);
        const arg = ReportSchedule.create.mock.calls[0][0];
        expect(arg.restaurant).toBe('rest1');
        expect(arg.recipients).toEqual(['ca@firm.com']);
        expect(arg.lastPeriodKey).toMatch(/^\d{4}-\d{2}$/);

        const bad = await call(scheduleCtl.create, { body: { type: 'gst-summary', frequency: 'monthly', recipients: ['nope'] } });
        expect(bad.statusCode).toBe(400);
        expect(bad.body.code).toBe('BAD_RECIPIENTS');
        expect((await call(scheduleCtl.create, { body: { type: 'x', frequency: 'daily', recipients: ['a@b.co'] } })).body.code).toBe('BAD_TYPE');
        expect((await call(scheduleCtl.create, { body: { type: 'daily-sales', frequency: 'daily', hour: 30, recipients: ['a@b.co'] } })).body.code).toBe('BAD_HOUR');

        ReportSchedule.countDocuments.mockResolvedValue(svc.MAX_SCHEDULES_PER_TENANT);
        const cap = await call(scheduleCtl.create, { body: { type: 'daily-sales', frequency: 'daily', recipients: ['a@b.co'] } });
        expect(cap.body.code).toBe('SCHEDULE_LIMIT');
    });

    test('disable / delete are tenant-scoped', async () => {
        ReportSchedule.findOneAndUpdate.mockResolvedValue({ _id: 's1', enabled: false });
        const r = await call(scheduleCtl.update, { params: { id: 's1' }, body: { enabled: false } });
        expect(r.body.success).toBe(true);
        expect(ReportSchedule.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 's1', restaurant: 'rest1' });
        ReportSchedule.deleteOne.mockResolvedValue({ deletedCount: 0 });
        expect((await call(scheduleCtl.remove, { params: { id: 'zz' } })).statusCode).toBe(404);
        expect(ReportSchedule.deleteOne.mock.calls[0][0]).toEqual({ _id: 'zz', restaurant: 'rest1' });
    });

    test('re-enabling resets the period so skipped periods are not replayed', async () => {
        ReportSchedule.findOne.mockReturnValue({ lean: async () => ({ _id: 's1', frequency: 'daily', hour: 8, enabled: false }) });
        ReportSchedule.findOneAndUpdate.mockResolvedValue({ _id: 's1', enabled: true });
        await call(scheduleCtl.update, { params: { id: 's1' }, body: { enabled: true } });
        expect(ReportSchedule.findOneAndUpdate.mock.calls[0][1].$set.lastPeriodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('no tenant is a 400', async () => {
        const r = await call(scheduleCtl.list, { restaurant: null });
        expect(r.statusCode).toBe(400);
    });
});

describe('GST / Tally endpoints', () => {
    beforeEach(() => jest.clearAllMocks());
    const tenantCtx = { tz: 'Asia/Kolkata', taxpayer: { name: 'Demo', gstin: '' }, defaultHsn: '996331', ledgers: {}, partyMode: 'cash', company: 'Demo' };
    const order = { orderId: 'O1', status: 'served', paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 105, items: [{ menuItem: 'a', name: 'Tea', price: 100, quantity: 1 }], total: 105, gst: 5, gstPercentage: 5, paidAt: D('2026-10-10T08:00:00Z'), bill: { billNo: 1, financialYear: '2026-27' } };

    beforeEach(() => {
        gstSvc.loadTenantTaxContext.mockResolvedValue(tenantCtx);
        gstSvc.generateGstReport.mockImplementation(async ({ range }) => ({
            report: buildGstReport({ orders: [order], tz: range.tz, range: { from: range.from, to: range.to } }),
            orders: [order], hsnCtx: {}, tenant: tenantCtx,
        }));
    });

    test('summary json, csv and xlsx', async () => {
        const q = { from: '2026-10-01', to: '2026-10-31' };
        const j = await call(gstCtl.gstSummary, { query: q });
        expect(j.body.report.totals.invoiceCount).toBe(1);
        expect(j.body.report.selfCheck.ok).toBe(true);
        expect(gstSvc.generateGstReport.mock.calls[0][0].restaurantId).toBe('rest1');
        const c = await call(gstCtl.gstSummary, { query: { ...q, format: 'csv' } });
        expect(c.headers['Content-Type']).toMatch(/text\/csv/);
        expect(c.headers['Content-Disposition']).toContain('gst-summary-2026-10-01_to_2026-10-31.csv');
        expect(c.sent).toContain('Invoice register');
        const x = await call(gstCtl.gstSummary, { query: { ...q, format: 'xlsx' } });
        expect(x.headers['Content-Type']).toMatch(/spreadsheetml/);
        expect(Buffer.isBuffer(x.sent)).toBe(true);
        expect(x.sent.slice(0, 2).toString()).toBe('PK');
    });

    test('bad range is a 400', async () => {
        const r = await call(gstCtl.gstSummary, { query: { from: 'x', to: 'y' } });
        expect(r.statusCode).toBe(400);
        expect(r.body.code).toBe('BAD_RANGE');
    });

    test('tally export returns XML with voucher count', async () => {
        const r = await call(gstCtl.tallyExport, { query: { from: '2026-10-01', to: '2026-10-31' } });
        expect(r.headers['Content-Type']).toMatch(/application\/xml/);
        expect(r.headers['X-Voucher-Count']).toBe('1');
        expect(r.sent).toContain('<VOUCHER VCHTYPE="Sales"');
    });

    test('config update validates and is tenant-scoped', async () => {
        Settings.findOneAndUpdate.mockResolvedValue({ taxExport: { defaultHsn: '996331', ledgers: {}, partyMode: 'debtors' } });
        const ok = await call(gstCtl.updateConfig, { body: { defaultHsn: '996331', partyMode: 'debtors', ledgers: { sales: 'My Sales' } } });
        expect(ok.body.success).toBe(true);
        const [filter, upd] = Settings.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ restaurant: 'rest1', branch: null });
        expect(upd.$set['taxExport.ledgers.sales']).toBe('My Sales');
        expect((await call(gstCtl.updateConfig, { body: { defaultHsn: 'abc' } })).body.code).toBe('BAD_HSN');
        expect((await call(gstCtl.updateConfig, { body: { partyMode: 'x' } })).body.code).toBe('BAD_PARTY_MODE');
        expect((await call(gstCtl.updateConfig, { body: { ledgers: { sales: 'x'.repeat(81) } } })).body.code).toBe('BAD_LEDGER');
        Settings.findOneAndUpdate.mockResolvedValue(null);
        expect((await call(gstCtl.updateConfig, { body: { defaultHsn: '9963' } })).body.code).toBe('NO_SETTINGS');
    });
});
