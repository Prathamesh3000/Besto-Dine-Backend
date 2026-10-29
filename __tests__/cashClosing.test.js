/**
 * Daily cash closing (Plan 3B.5): variance maths, cash summary from loaded
 * sources, unique-closing / amend rules in the controller (models mocked).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { computeCash } = require('../utils/cashMath');

describe('computeCash', () => {
    test('expected = opening + cash sales - cash refunds - cash pay-outs; variance = counted - expected', () => {
        const r = computeCash({ openingCash: 1000, cashSales: 5000, cashRefunds: 200, cashPaidOuts: 800, countedCash: 4950 });
        expect(r.expectedCash).toBe(5000);
        expect(r.variance).toBe(-50);
    });
    test('no count yet -> variance null; floats stay at 2dp', () => {
        const r = computeCash({ openingCash: 0.1, cashSales: 0.2, countedCash: null });
        expect(r.expectedCash).toBe(0.3);
        expect(r.variance).toBeNull();
        expect(computeCash({ openingCash: 10, countedCash: 12.505 }).variance).toBeCloseTo(2.51, 2);
    });
});

describe('summarizeCash', () => {
    const { summarizeCash } = require('../services/ledgerSources');
    test('only cash tenders / cash refunds / cash pay-outs count', () => {
        const cashOrder = { _id: 'a', amountPaid: 100, paymentMethod: 'cash' };
        const upiOrder = { _id: 'b', amountPaid: 100, paymentMethod: 'UPI' };
        const out = summarizeCash({
            tenders: [
                { order: cashOrder, line: { method: 'cash', amount: 300 } },
                { order: upiOrder, line: { method: 'upi', amount: 999 } },
            ],
            refunds: [
                { order: cashOrder, refund: { amount: 40 } },
                { order: upiOrder, refund: { amount: 60 } },
            ],
            expenses: [{ method: 'cash', amount: 25 }, { method: 'upi', amount: 77 }],
            supplierPayments: [{ method: 'cash', amount: 10 }],
            poPayments: [{ payment: { mode: 'cash', amount: 5 } }, { payment: { mode: 'cheque', amount: 500 } }],
        });
        expect(out).toEqual({ cashSales: 300, cashRefunds: 40, cashPaidOuts: 40 });
    });
});

describe('cash closing controller', () => {
    let ctrl; let CashClosing;
    const res = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    const req = (over = {}) => ({
        restaurant: { _id: 'r1', timezone: 'Asia/Kolkata' }, user: { _id: 'u1', role: 'admin' }, query: {}, body: {}, params: {}, ...over,
    });
    // asyncHandler turns AppError into a JSON response; surface 4xx/5xx as a rejection for assertions.
    const call = async (fn, rq) => { const rs = res(); await fn(rq, rs, (e) => { throw e; }); if (rs.statusCode >= 400) throw Object.assign(new Error(rs.body.message), { status: rs.statusCode, code: rs.body.code }); return rs; };

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../models/cashClosing', () => ({
            findOne: jest.fn(), create: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(),
        }));
        jest.doMock('../services/ledgerSources', () => ({
            loadSources: jest.fn().mockResolvedValue({}),
            summarizeCash: jest.fn().mockReturnValue({ cashSales: 1000, cashRefunds: 100, cashPaidOuts: 200 }),
        }));
        CashClosing = require('../models/cashClosing');
        ctrl = require('../controllers/cashClosingController');
        const lean = (v) => ({ lean: () => Promise.resolve(v), sort: () => ({ lean: () => Promise.resolve(v) }) });
        CashClosing.findOne.mockImplementation(() => lean(null));
    });

    test('close creates a closed record with server-computed expected cash and variance', async () => {
        CashClosing.create.mockImplementation(async (d) => ({ ...d }));
        const rs = await call(ctrl.close, req({ body: { businessDate: '2026-10-01', openingCash: 500, countedCash: 1150 } }));
        expect(rs.statusCode).toBe(200);
        expect(rs.body.closing.expectedCash).toBe(1200);
        expect(rs.body.closing.variance).toBe(-50);
        expect(rs.body.closing.status).toBe('closed');
    });

    test('unique index violation on create -> 409', async () => {
        CashClosing.create.mockRejectedValue({ code: 11000 });
        await expect(call(ctrl.close, req({ body: { businessDate: '2026-10-01', countedCash: 10 } }))).rejects.toMatchObject({ status: 409 });
        await expect(call(ctrl.open, req({ body: { businessDate: '2026-10-01', openingCash: 10 } }))).rejects.toMatchObject({ status: 409 });
    });

    test('closing an already-closed day -> 409 ALREADY_CLOSED', async () => {
        CashClosing.findOne.mockImplementation(() => ({ lean: () => Promise.resolve({ _id: 'c1', status: 'closed' }) }));
        await expect(call(ctrl.close, req({ body: { businessDate: '2026-10-01', countedCash: 10 } }))).rejects.toMatchObject({ code: 'ALREADY_CLOSED' });
    });

    test('a lost race on the open->closed update -> 409', async () => {
        CashClosing.findOne.mockImplementation(() => ({ lean: () => Promise.resolve({ _id: 'c1', status: 'open', openingCash: 0 }) }));
        CashClosing.findOneAndUpdate.mockResolvedValue(null);
        await expect(call(ctrl.close, req({ body: { businessDate: '2026-10-01', countedCash: 10 } }))).rejects.toMatchObject({ status: 409 });
    });

    test('future dates and bad counts are rejected', async () => {
        await expect(call(ctrl.close, req({ body: { businessDate: '2999-01-01', countedCash: 1 } }))).rejects.toMatchObject({ code: 'FUTURE_DATE' });
        await expect(call(ctrl.close, req({ body: { countedCash: -5 } }))).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    });

    describe('amend', () => {
        const closedDoc = () => ({
            _id: 'c1', status: 'closed', openingCash: 500, cashSales: 1000, cashRefunds: 100, cashPaidOuts: 200,
            expectedCash: 1200, countedCash: 1150, variance: -50, notes: '',
        });

        test('closed day needs the admin role and a reason', async () => {
            CashClosing.findOne.mockResolvedValue(closedDoc());
            await expect(call(ctrl.amend, req({ user: { _id: 'm', role: 'manager' }, params: { id: 'c1' }, body: { countedCash: 1200, reason: 'x' } })))
                .rejects.toMatchObject({ code: 'ADMIN_ONLY' });
            await expect(call(ctrl.amend, req({ params: { id: 'c1' }, body: { countedCash: 1200 } })))
                .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
            expect(CashClosing.findOneAndUpdate).not.toHaveBeenCalled();
        });

        test('admin amend recomputes variance and records the edit with its reason', async () => {
            CashClosing.findOne.mockResolvedValue(closedDoc());
            CashClosing.findOneAndUpdate.mockResolvedValue({ ok: true });
            await call(ctrl.amend, req({ params: { id: 'c1' }, body: { countedCash: 1200, reason: 'Recounted drawer' } }));
            const [filter, update] = CashClosing.findOneAndUpdate.mock.calls[0];
            expect(filter.status).toBe('closed');
            expect(update.$set.variance).toBe(0);
            expect(update.$push.edits.reason).toBe('Recounted drawer');
            expect(update.$push.edits.before.variance).toBe(-50);
        });
    });
});
