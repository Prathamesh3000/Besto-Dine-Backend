/**
 * Stocktake (3B.6) + deduction-health endpoints. Controllers are called
 * directly with fake req/res over small in-memory models.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const R = 'rest1';
const mockState = { takes: [], inv: [], jobs: [], orders: [], seq: 0 };
const mockClone = (x) => JSON.parse(JSON.stringify(x));
const mockLeanQ = (v) => { const q = { sort: () => q, limit: () => q, select: () => q, lean: async () => mockClone(v) }; return q; };

jest.mock('../models/stocktake', () => {
    const lineMatch = (l, em) => String(l._id) === String(em._id) && (em.appliedAt !== null || !l.appliedAt);
    return {
        create: jest.fn(async (d) => {
            const doc = { _id: `64c0000000000000000000${String(++mockState.seq).padStart(2, '0')}`, ...d, lines: d.lines.map((l, i) => ({ _id: `64d00000000000000000${String(mockState.seq).padStart(2, '0')}${String(i).padStart(2, '0')}`, countedQty: null, variance: null, appliedAt: null, ...l })) };
            mockState.takes.push(doc);
            return mockClone(doc);
        }),
        find: jest.fn(() => mockLeanQ(mockState.takes)),
        findOne: jest.fn((f) => mockLeanQ(mockState.takes.find((t) => String(t._id) === String(f._id)) || null)),
        updateOne: jest.fn(async (f, u, opts) => {
            const t = mockState.takes.find((x) => String(x._id) === String(f._id) && (!f.status || x.status === f.status));
            if (!t) return { matchedCount: 0 };
            for (const [k, v] of Object.entries(u.$set)) {
                let m = k.match(/^lines\.\$\[(\w+)\]\.(\w+)$/);
                if (m) {
                    const flt = opts.arrayFilters.find((a) => Object.keys(a)[0].startsWith(`${m[1]}.`));
                    const line = t.lines.find((l) => String(l._id) === String(Object.values(flt)[0]));
                    line[m[2]] = v;
                    continue;
                }
                m = k.match(/^lines\.\$\.(\w+)$/);
                const line = t.lines.find((l) => String(l._id) === String(f['lines._id']));
                line[m[1]] = v;
            }
            return { matchedCount: 1 };
        }),
        findOneAndUpdate: jest.fn((f, u) => {
            const run = () => {
                const t = mockState.takes.find((x) => String(x._id) === String(f._id) && (!f.status || x.status === f.status));
                if (!t) return null;
                if (f.lines) {
                    const em = f.lines.$elemMatch;
                    const line = t.lines.find((l) => String(l._id) === String(em._id) && !l.appliedAt);
                    if (!line) return null;
                    for (const [k, v] of Object.entries(u.$set)) line[k.replace('lines.$.', '')] = v;
                    return t;
                }
                Object.assign(t, u.$set);
                return t;
            };
            const v = run();
            const p = Promise.resolve(v ? mockClone(v) : null);
            p.lean = async () => (v ? mockClone(v) : null);
            return p;
        }),
    };
});
jest.mock('../models/inventory', () => {
    const inv = {
        roundQty: (n) => Math.round(Number(n) * 1000) / 1000 + 0,
        find: jest.fn(() => mockLeanQ(mockState.inv)),
        findOne: jest.fn(async (f) => mockState.inv.find((i) => String(i._id) === String(f._id)) || null),
        findOneAndUpdate: jest.fn(async (f, u) => {
            const i = mockState.inv.find((x) => String(x._id) === String(f._id) && x.currentStock === f.currentStock);
            if (!i) return null;
            Object.assign(i, u.$set);
            i.adjustmentHistory = [...(i.adjustmentHistory || []), ...u.$push.adjustmentHistory.$each];
            return i;
        }),
    };
    return inv;
});
jest.mock('../models/inventoryDeductionJob', () => ({
    find: jest.fn(() => mockLeanQ(mockState.jobs)),
    aggregate: jest.fn(async () => [{ _id: 'failed', n: 1 }, { _id: 'pending', n: 2 }]),
    findOne: jest.fn((f) => mockLeanQ(mockState.jobs.find((j) => String(j._id) === String(f._id)) || null)),
    updateOne: jest.fn(async () => ({})),
}));
jest.mock('../models/order', () => ({
    find: jest.fn(() => mockLeanQ(mockState.orders)),
    countDocuments: jest.fn(async () => mockState.orders.length),
    findOne: jest.fn(async (f) => mockState.orders.find((o) => String(o._id) === String(f._id)) || null),
}));
const mockRecover = jest.fn();
const mockRetryJob = jest.fn();
jest.mock('../services/inventoryDeductionService', () => ({
    runDeductionWithRecovery: (...a) => mockRecover(...a),
    retryJob: (...a) => mockRetryJob(...a),
    hasDeductionRows: jest.fn(async () => false),
}));

const st = require('../controllers/stocktakeController');
const dh = require('../controllers/deductionHealthController');

const oid = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const mkRes = () => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
};
const mkReq = (extra = {}) => ({ restaurant: { _id: R }, user: { _id: 'u1', role: 'admin' }, params: {}, query: {}, body: {}, ...extra });
const call = async (fn, req) => { const res = mkRes(); await fn(req, res); return res; };

beforeEach(() => {
    jest.clearAllMocks();
    mockState.takes = []; mockState.jobs = []; mockState.orders = []; mockState.seq = 0;
    mockState.inv = [
        { _id: oid(1), name: 'Rice', itemId: 'INV-001', unit: 'kg', currentStock: 10, minStock: 2, maxStock: 0, restaurant: R },
        { _id: oid(2), name: 'Oil', itemId: 'INV-002', unit: 'L', currentStock: 5, minStock: 1, maxStock: 0, restaurant: R },
    ];
});

const newTake = async () => (await call(st.createStocktake, mkReq({ body: { name: 'Oct' } }))).body.stocktake;

describe('stocktake lifecycle', () => {
    test('create snapshots current quantities as expected', async () => {
        const res = await call(st.createStocktake, mkReq({ body: { name: 'Oct' } }));
        expect(res.statusCode).toBe(201);
        expect(res.body.stocktake.status).toBe('draft');
        expect(res.body.stocktake.lines.map((l) => [l.itemName, l.expectedQty])).toEqual([['Rice', 10], ['Oil', 5]]);
    });

    test('create with no items is a 400', async () => {
        mockState.inv = [];
        expect((await call(st.createStocktake, mkReq())).statusCode).toBe(400);
    });

    test('update counts computes variance and rejects bad numbers', async () => {
        const t = await newTake();
        const res = await call(st.updateCounts, mkReq({ params: { id: t._id }, body: { counts: [{ item: oid(1), countedQty: 8.5, note: 'spill' }] } }));
        expect(res.statusCode).toBe(200);
        expect(res.body.stocktake.lines[0]).toMatchObject({ countedQty: 8.5, variance: -1.5, note: 'spill' });
        const bad = await call(st.updateCounts, mkReq({ params: { id: t._id }, body: { counts: [{ item: oid(2), countedQty: -1 }] } }));
        expect(bad.statusCode).toBe(400);
    });

    test('submit needs a count; counts lock after submit', async () => {
        const t = await newTake();
        expect((await call(st.submitStocktake, mkReq({ params: { id: t._id } }))).statusCode).toBe(400);
        await call(st.updateCounts, mkReq({ params: { id: t._id }, body: { counts: [{ item: oid(1), countedQty: 9 }] } }));
        expect((await call(st.submitStocktake, mkReq({ params: { id: t._id } }))).body.stocktake.status).toBe('submitted');
        const again = await call(st.updateCounts, mkReq({ params: { id: t._id }, body: { counts: [{ item: oid(1), countedQty: 1 }] } }));
        expect(again.statusCode).toBe(409);
    });

    test('apply before submit is refused', async () => {
        const t = await newTake();
        expect((await call(st.applyStocktake, mkReq({ params: { id: t._id } }))).statusCode).toBe(409);
    });
});

describe('stocktake apply', () => {
    const submitted = async (counts) => {
        const t = await newTake();
        await call(st.updateCounts, mkReq({ params: { id: t._id }, body: { counts } }));
        await call(st.submitStocktake, mkReq({ params: { id: t._id } }));
        return t;
    };

    test('writes correction adjustments, skips uncounted/unchanged lines, marks applied', async () => {
        const t = await submitted([{ item: oid(1), countedQty: 8 }, { item: oid(2), countedQty: 5 }]);
        const res = await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        expect(res.body).toMatchObject({ success: true, applied: 1 });
        expect(res.body.stocktake.status).toBe('applied');
        const rice = mockState.inv[0];
        expect(rice.currentStock).toBe(8);
        expect(rice.adjustmentHistory).toHaveLength(1);
        expect(rice.adjustmentHistory[0]).toMatchObject({ type: 'correction', previousStock: 10, newStock: 8 });
        expect(mockState.inv[1].adjustmentHistory).toBeUndefined();
    });

    test('applies the variance relative to live stock (sales since the snapshot are kept)', async () => {
        const t = await submitted([{ item: oid(1), countedQty: 8 }]); // variance -2
        mockState.inv[0].currentStock = 7; // 3 kg sold since the snapshot
        await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        expect(mockState.inv[0].currentStock).toBe(5);
    });

    test('is idempotent: a second apply changes nothing', async () => {
        const t = await submitted([{ item: oid(1), countedQty: 8 }]);
        await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        const second = await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        expect(second.body).toMatchObject({ alreadyApplied: true, applied: 0 });
        expect(mockState.inv[0].currentStock).toBe(8);
        expect(mockState.inv[0].adjustmentHistory).toHaveLength(1);
    });

    test('two concurrent applies correct each line once', async () => {
        const t = await submitted([{ item: oid(1), countedQty: 8 }]);
        const [a, b] = await Promise.all([
            call(st.applyStocktake, mkReq({ params: { id: t._id } })),
            call(st.applyStocktake, mkReq({ params: { id: t._id } })),
        ]);
        expect(a.body.applied + b.body.applied).toBe(1);
        expect(mockState.inv[0].currentStock).toBe(8);
        expect(mockState.inv[0].adjustmentHistory).toHaveLength(1);
    });

    test('a failing line releases its claim, reports 207, and a retry finishes it', async () => {
        const t = await submitted([{ item: oid(1), countedQty: 8 }]);
        const gone = mockState.inv.shift(); // item deleted
        const res = await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        expect(res.statusCode).toBe(207);
        expect(res.body.failed[0].name).toBe('Rice');
        expect(res.body.stocktake.status).toBe('submitted');
        mockState.inv.unshift(gone);
        const retry = await call(st.applyStocktake, mkReq({ params: { id: t._id } }));
        expect(retry.body).toMatchObject({ success: true, applied: 1 });
        expect(retry.body.stocktake.status).toBe('applied');
        expect(gone.currentStock).toBe(8);
    });
});

describe('list / get', () => {
    test('list returns counts without lines; get returns lines; bad id is 400', async () => {
        const t = await newTake();
        const list = await call(st.listStocktakes, mkReq());
        expect(list.body.stocktakes[0]).toMatchObject({ lineCount: 2, countedCount: 0 });
        expect(list.body.stocktakes[0].lines).toBeUndefined();
        expect((await call(st.getStocktake, mkReq({ params: { id: t._id } }))).body.stocktake.lines).toHaveLength(2);
        expect((await call(st.getStocktake, mkReq({ params: { id: 'nope' } }))).statusCode).toBe(400);
        expect((await call(st.getStocktake, mkReq({ params: { id: oid(9) } }))).statusCode).toBe(404);
    });
});

describe('deduction-health', () => {
    test('report returns counts, jobs and orders without a marker', async () => {
        mockState.jobs = [{ _id: 'j1', order: oid(5), state: 'failed' }];
        mockState.orders = [{ _id: oid(5), orderId: 'A' }, { _id: oid(6), orderId: 'B' }];
        const res = await call(dh.getDeductionHealth, mkReq());
        expect(res.body.counts).toEqual({ failedJobs: 1, pendingJobs: 2, ordersWithoutMarker: 2 });
        expect(res.body.ordersWithoutMarker.map((o) => o.hasJob)).toEqual([true, false]);
    });

    test('retry requires jobId or orderId', async () => {
        expect((await call(dh.retryDeduction, mkReq())).statusCode).toBe(400);
    });

    test('retry by jobId forces the retry', async () => {
        mockState.jobs = [{ _id: oid(7), order: oid(5), state: 'pending', retryable: true, restaurant: R }];
        mockRetryJob.mockResolvedValue({ outcome: 'done' });
        const res = await call(dh.retryDeduction, mkReq({ body: { jobId: oid(7) } }));
        expect(res.body).toMatchObject({ success: true, outcome: 'done' });
        expect(mockRetryJob).toHaveBeenCalledWith(expect.objectContaining({ _id: oid(7) }), { force: true, userId: 'u1' });
    });

    test('a non-retryable job whose order is already marked is refused (would double-deduct)', async () => {
        mockState.jobs = [{ _id: oid(7), order: oid(5), state: 'failed', retryable: false, restaurant: R }];
        mockState.orders = [{ _id: oid(5), status: 'preparing', inventoryDeducted: true }];
        const res = await call(dh.retryDeduction, mkReq({ body: { jobId: oid(7) } }));
        expect(res.statusCode).toBe(409);
        expect(mockRetryJob).not.toHaveBeenCalled();
    });

    test('retry by orderId runs the recovering deduction; already-marked orders are a no-op', async () => {
        mockState.orders = [{ _id: oid(5), status: 'preparing', inventoryDeducted: false }, { _id: oid(6), status: 'served', inventoryDeducted: true }];
        mockRecover.mockResolvedValue({ deducted: [{}], errors: [] });
        expect((await call(dh.retryDeduction, mkReq({ body: { orderId: oid(5) } }))).body.outcome).toBe('done');
        expect(mockRecover).toHaveBeenCalledTimes(1);
        expect((await call(dh.retryDeduction, mkReq({ body: { orderId: oid(6) } }))).body.message).toBe('Already deducted');
        expect(mockRecover).toHaveBeenCalledTimes(1);
    });
});
