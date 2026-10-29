/**
 * Inter-branch stock transfer + weighted-average costing + valuation report.
 * Services/controllers run over small in-memory models (no database).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn();
jest.mock('../services/tenantAuditService', () => ({ recordTenantAudit: (...a) => mockAudit(...a) }));

const R = '64a000000000000000000001';
const R2 = '64a000000000000000000002';
const B1 = '64b000000000000000000001'; // main
const B2 = '64b000000000000000000002';
const BX = '64b0000000000000000000ff'; // other restaurant's branch
const mockSt = { inv: [], branches: [], transfers: [], seq: 0 };
const mockClone = (x) => JSON.parse(JSON.stringify(x));
const mockSameId = (a, b) => String(a) === String(b);

// Minimal Mongo-style matcher for the operators the code under test uses.
function mockMatches(doc, filter) {
    return Object.entries(filter).every(([k, v]) => {
        if (k === 'lines') {
            const em = v.$elemMatch;
            return (doc.lines || []).some((l) => mockLineMatches(l, em));
        }
        const val = doc[k];
        if (v && typeof v === 'object' && !(v instanceof Date) && !(v._bsontype) && v.constructor === Object) {
            if ('$in' in v) return v.$in.some((x) => (x === null ? val == null : mockSameId(x, val)));
            if ('$gte' in v) return val >= v.$gte;
            if ('$regex' in v) return new RegExp(v.$regex, v.$options).test(val);
            return false;
        }
        if (v === null) return val == null;
        return mockSameId(v, val);
    });
}
function mockLineMatches(l, em) {
    return Object.entries(em).every(([k, v]) => {
        if (v && typeof v === 'object' && '$ne' in v) return (l[k] ?? null) !== v.$ne;
        if (v === null) return (l[k] ?? null) === null;
        return mockSameId(l[k], v);
    });
}
const mockChain = (get) => { const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => get(true), then: (a, b) => Promise.resolve(get(false)).then(a, b) }; return q; };

jest.mock('../models/inventory', () => {
    const roundQty = (n) => Math.round(Number(n) * 1000) / 1000 + 0;
    return {
        roundQty,
        find: jest.fn((f) => mockChain((lean) => mockClone(mockSt.inv.filter((d) => mockMatches(d, f))))),
        findOne: jest.fn((f) => mockChain((lean) => { const d = mockSt.inv.find((x) => mockMatches(x, f)); return d ? (lean ? mockClone(d) : d) : null; })),
        create: jest.fn(async (d) => { if (mockSt.inv.some((x) => x.restaurant === d.restaurant && x.itemId === d.itemId)) { const e = new Error('dup'); e.code = 11000; throw e; } const doc = { _id: `64c0000000000000000001${String(++mockSt.seq).padStart(2, '0')}`, avgCost: null, adjustmentHistory: [], ...d, restaurant: String(d.restaurant), branch: String(d.branch) }; mockSt.inv.push(doc); return doc; }),
        incStock: jest.fn(async (f, delta) => {
            const d = mockSt.inv.find((x) => mockMatches(x, f));
            if (!d) return null;
            const previousStock = d.currentStock;
            d.currentStock = Math.round((d.currentStock + delta) * 1000) / 1000;
            return { doc: d, previousStock, newStock: d.currentStock };
        }),
        updateOne: jest.fn(async (f, u) => {
            const d = mockSt.inv.find((x) => mockMatches(x, f));
            if (!d) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(d, u.$set || {});
            if (u.$push) d.adjustmentHistory.push(...u.$push.adjustmentHistory.$each);
            return { matchedCount: 1, modifiedCount: 1 };
        }),
    };
});
jest.mock('../models/branch', () => ({
    findOne: jest.fn((f) => mockChain(() => mockSt.branches.find((b) => mockMatches(b, f)) || null)),
    find: jest.fn((f) => mockChain(() => mockClone(mockSt.branches.filter((b) => mockMatches(b, f))))),
}));
jest.mock('../models/stockTransfer', () => {
    const find1 = (f) => mockSt.transfers.find((t) => mockMatches(t, f));
    return {
        create: jest.fn(async (d) => {
            const doc = { _id: `64d0000000000000000000${String(++mockSt.seq).padStart(2, '0')}`, ...d, restaurant: String(d.restaurant), fromBranch: String(d.fromBranch), toBranch: String(d.toBranch),
                lines: d.lines.map((l, i) => ({ _id: `64e0000000000000000000${mockSt.seq}${i}`.slice(0, 24), outAppliedAt: null, inAppliedAt: null, returnedAt: null, receivedQty: null, shortfallQty: 0, destItem: null, error: '', ...l, item: String(l.item) })) };
            mockSt.transfers.push(doc);
            return mockClone(doc);
        }),
        find: jest.fn((f) => mockChain(() => mockClone(mockSt.transfers.filter((t) => mockMatches(t, f))))),
        findOne: jest.fn((f) => mockChain(() => { const t = find1(f); return t ? mockClone(t) : null; })),
        findOneAndUpdate: jest.fn(async (f, u) => {
            const t = find1(f);
            if (!t) return null;
            const hit = f.lines ? t.lines.find((l) => mockLineMatches(l, f.lines.$elemMatch)) : null;
            for (const [k, v] of Object.entries(u.$set)) {
                if (k.startsWith('lines.$.')) {
                    hit[k.slice(8)] = v;
                } else t[k] = v;
            }
            return mockClone(t);
        }),
        updateOne: jest.fn(async (f, u) => {
            const t = mockSt.transfers.find((x) => mockSameId(x._id, f._id));
            if (!t) return { matchedCount: 0 };
            for (const [k, v] of Object.entries(u.$set)) {
                if (k.startsWith('lines.$.')) t.lines.find((l) => mockSameId(l._id, f['lines._id']))[k.slice(8)] = v;
            }
            return { matchedCount: 1 };
        }),
    };
});

const cost = require('../services/inventoryCostService');
const svc = require('../services/stockTransferService');
const ctl = require('../controllers/stockTransferController');

const mkReq = (extra = {}) => ({ restaurant: { _id: R }, mainBranchId: B1, user: { _id: 'u1', role: 'admin' }, params: {}, query: {}, body: {}, ...extra });
const mkRes = () => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };
const rejects = async (p) => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

beforeEach(() => {
    jest.clearAllMocks();
    mockSt.seq = 0; mockSt.transfers = [];
    mockSt.branches = [{ _id: B1, restaurant: R, name: 'Main' }, { _id: B2, restaurant: R, name: 'Annex' }, { _id: BX, restaurant: R2, name: 'Foreign' }];
    mockSt.inv = [
        { _id: '64f000000000000000000001', restaurant: R, branch: B1, itemId: 'INV-001', name: 'Rice', unit: 'kg', category: 'Raw Ingredients', currentStock: 10, minStock: 2, costPerUnit: 50, avgCost: 60, adjustmentHistory: [] },
        { _id: '64f000000000000000000002', restaurant: R, branch: null, itemId: 'INV-002', name: 'Oil', unit: 'L', category: 'Oils & Sauces', currentStock: 5, minStock: 1, costPerUnit: 100, avgCost: null, adjustmentHistory: [] },
        { _id: '64f000000000000000000003', restaurant: R, branch: B2, itemId: 'INV-003', name: 'rice', unit: 'kg', category: 'Raw Ingredients', currentStock: 4, minStock: 1, costPerUnit: 55, avgCost: 40, adjustmentHistory: [] },
    ];
});

const RICE = '64f000000000000000000001';
const OIL = '64f000000000000000000002';
const draft = async (lines, req = mkReq()) => (await svc.createDraft(req, { fromBranch: B1, toBranch: B2, lines })).transfer;

describe('weighted average cost (pure)', () => {
    const w = cost.weightedAverageCost;
    test('blends old and new with 4-decimal rounding', () => {
        expect(w({ oldQty: 10, oldCost: 60, inQty: 5, inCost: 90 })).toBe(70);
        expect(w({ oldQty: 3, oldCost: 10, inQty: 4, inCost: 11 })).toBe(10.5714);
    });
    test('zero / negative old qty takes the incoming cost', () => {
        expect(w({ oldQty: 0, oldCost: null, inQty: 5, inCost: 12.34567 })).toBe(12.3457);
        expect(w({ oldQty: -3, oldCost: 99, inQty: 2, inCost: 8 })).toBe(8);
    });
    test('zero qty or missing cost leaves the average unchanged; unknown stays unknown', () => {
        expect(w({ oldQty: 5, oldCost: 20, inQty: 0, inCost: 30 })).toBe(20);
        expect(w({ oldQty: 5, oldCost: 20, inQty: 5, inCost: undefined })).toBe(20);
        expect(w({ oldQty: 5, oldCost: 20, inQty: 5, inCost: 0 })).toBe(20);
        expect(w({ oldQty: 5, oldCost: null, inQty: 5, inCost: 30 })).toBeNull();
        expect(w({ oldQty: 5, oldCost: null, inQty: 5, inCost: undefined })).toBeNull();
    });
    test('recordReceiptCost updates once and ignores missing cost', async () => {
        const doc = mockSt.inv[0];
        const Inv = require('../models/inventory');
        expect(await cost.recordReceiptCost({ Inventory: Inv, filter: { _id: RICE }, doc, previousStock: 10, inQty: 10, unitCost: undefined })).toBeNull();
        expect(mockSt.inv[0].avgCost).toBe(60);
        expect(await cost.recordReceiptCost({ Inventory: Inv, filter: { _id: RICE }, doc: { ...doc }, previousStock: 10, inQty: 10, unitCost: 80 })).toBe(70);
        expect(mockSt.inv[0].avgCost).toBe(70);
    });
});

describe('transfer create', () => {
    test('creates a draft with a TRF number and snapshots lines', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        expect(t.status).toBe('draft');
        expect(t.number).toBe('TRF-0001');
        expect(t.lines[0]).toMatchObject({ itemName: 'Rice', qty: 3, unit: 'kg' });
    });
    test('refuses a branch of another restaurant, same branch, empty or foreign items', async () => {
        expect((await rejects(svc.createDraft(mkReq(), { fromBranch: B1, toBranch: BX, lines: [{ item: RICE, qty: 1 }] }))).status).toBe(400);
        expect((await rejects(svc.createDraft(mkReq(), { fromBranch: B1, toBranch: B1, lines: [{ item: RICE, qty: 1 }] }))).code).toBe('SAME_BRANCH');
        expect((await rejects(svc.createDraft(mkReq(), { fromBranch: B1, toBranch: B2, lines: [] }))).code).toBe('NO_LINES');
        // item 3 lives in B2, not in the source branch
        expect((await rejects(svc.createDraft(mkReq(), { fromBranch: B1, toBranch: B2, lines: [{ item: '64f000000000000000000003', qty: 1 }] }))).code).toBe('ITEM_NOT_IN_BRANCH');
        expect((await rejects(svc.createDraft(mkReq(), { fromBranch: B1, toBranch: B2, lines: [{ item: RICE, qty: 0 }] }))).code).toBe('INVALID_QTY');
    });
    test('a branch-pinned user cannot create from another branch', async () => {
        const e = await rejects(svc.createDraft(mkReq({ user: { _id: 'u2', role: 'admin', branch: B2 } }), { fromBranch: B1, toBranch: B2, lines: [{ item: RICE, qty: 1 }] }));
        expect(e.status).toBe(403);
    });
});

describe('send', () => {
    test('deducts source with a transfer_out row, snapshots avgCost, is idempotent', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        const r1 = await svc.send(mkReq(), t._id);
        expect(r1.transfer.status).toBe('in_transit');
        expect(r1.transfer.lines[0].unitCost).toBe(60);
        expect(mockSt.inv[0].currentStock).toBe(7);
        expect(mockSt.inv[0].adjustmentHistory.map((h) => h.type)).toEqual(['transfer_out']);
        const r2 = await svc.send(mkReq(), t._id);
        expect(r2.already).toBe(true);
        expect(mockSt.inv[0].currentStock).toBe(7);
        expect(mockSt.inv[0].adjustmentHistory).toHaveLength(1);
    });
    test('parallel sends deduct once', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await Promise.allSettled([svc.send(mkReq(), t._id), svc.send(mkReq(), t._id)]);
        expect(mockSt.inv[0].currentStock).toBe(7);
        expect(mockSt.inv[0].adjustmentHistory.filter((h) => h.type === 'transfer_out')).toHaveLength(1);
    });
    test('insufficient stock refuses everything, nothing moves, stays draft', async () => {
        const t = await draft([{ item: RICE, qty: 3 }, { item: OIL, qty: 6 }]);
        const e = await rejects(svc.send(mkReq(), t._id));
        expect(e.code).toBe('INSUFFICIENT_STOCK');
        expect(e.details.shortages[0]).toMatchObject({ name: 'Oil', available: 5, requested: 6 });
        expect(mockSt.inv[0].currentStock).toBe(10);
        expect(mockSt.inv[1].currentStock).toBe(5);
        expect(mockSt.transfers[0].status).toBe('draft');
    });
    test('legacy item (branch null) belongs to the main branch; unknown cost is carried as null', async () => {
        const t = await draft([{ item: OIL, qty: 2 }]);
        const r = await svc.send(mkReq(), t._id);
        expect(r.transfer.lines[0].unitCost).toBeNull();
        expect(mockSt.inv[1].currentStock).toBe(3);
    });
});

describe('receive', () => {
    test('full receive adds to the matching destination item, weighted avg from source cost, once', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await svc.send(mkReq(), t._id);
        const r = await svc.receive(mkReq(), t._id, {});
        expect(r.transfer.status).toBe('received');
        const dest = mockSt.inv[2]; // "rice" matched case-insensitively
        expect(dest.currentStock).toBe(7);
        expect(dest.adjustmentHistory.map((h) => h.type)).toEqual(['transfer_in']);
        expect(dest.avgCost).toBe(48.5714); // (4*40 + 3*60) / 7
        const again = await svc.receive(mkReq(), t._id, {});
        expect(again.already).toBe(true);
        expect(dest.currentStock).toBe(7);
    });
    test('parallel receives add once', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await svc.send(mkReq(), t._id);
        await Promise.allSettled([svc.receive(mkReq(), t._id, {}), svc.receive(mkReq(), t._id, {})]);
        expect(mockSt.inv[2].currentStock).toBe(7);
    });
    test('partial receive records the shortfall and adds only what arrived', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await svc.send(mkReq(), t._id);
        const lineId = mockSt.transfers[0].lines[0]._id;
        const r = await svc.receive(mkReq(), t._id, { lines: [{ lineId, receivedQty: 2.5 }] });
        expect(r.transfer.lines[0]).toMatchObject({ receivedQty: 2.5, shortfallQty: 0.5 });
        expect(mockSt.inv[2].currentStock).toBe(6.5);
        expect(r.transfer.status).toBe('received');
    });
    test('receiving more than sent is refused; receiving a draft is refused', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        expect((await rejects(svc.receive(mkReq(), t._id, {}))).code).toBe('INVALID_STATE');
        await svc.send(mkReq(), t._id);
        const lineId = mockSt.transfers[0].lines[0]._id;
        expect((await rejects(svc.receive(mkReq(), t._id, { lines: [{ lineId, receivedQty: 4 }] }))).code).toBe('RECEIVED_EXCEEDS_SENT');
        expect(mockSt.inv[2].currentStock).toBe(4);
    });
    test('creates the destination item when none matches (stock, avgCost, branch)', async () => {
        const t = await draft([{ item: OIL, qty: 2 }]);
        await svc.send(mkReq(), t._id);
        await svc.receive(mkReq(), t._id, {});
        const created = mockSt.inv.find((i) => i.name === 'Oil' && i.branch === B2);
        expect(created).toMatchObject({ currentStock: 2, unit: 'L', category: 'Oils & Sauces', avgCost: null });
        expect(created.itemId).toBe('INV-004');
    });
    test('new destination item with a known source cost takes that cost', async () => {
        mockSt.inv[2].name = 'Basmati';
        const t = await draft([{ item: RICE, qty: 2 }]);
        await svc.send(mkReq(), t._id);
        await svc.receive(mkReq(), t._id, {});
        const created = mockSt.inv.find((i) => i.name === 'Rice' && i.branch === B2);
        expect(created).toMatchObject({ currentStock: 2, avgCost: 60 });
    });
});

describe('cancel', () => {
    test('draft cancels without touching stock', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        const r = await svc.cancel(mkReq(), t._id);
        expect(r.transfer.status).toBe('cancelled');
        expect(mockSt.inv[0].currentStock).toBe(10);
    });
    test('in-transit cancel returns stock exactly once; receive afterwards is refused', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await svc.send(mkReq(), t._id);
        expect(mockSt.inv[0].currentStock).toBe(7);
        await svc.cancel(mkReq(), t._id);
        expect(mockSt.inv[0].currentStock).toBe(10);
        const again = await svc.cancel(mkReq(), t._id);
        expect(again.already).toBe(true);
        expect(mockSt.inv[0].currentStock).toBe(10);
        expect((await rejects(svc.receive(mkReq(), t._id, {}))).code).toBe('INVALID_STATE');
    });
    test('a received transfer cannot be cancelled', async () => {
        const t = await draft([{ item: RICE, qty: 3 }]);
        await svc.send(mkReq(), t._id);
        await svc.receive(mkReq(), t._id, {});
        expect((await rejects(svc.cancel(mkReq(), t._id))).code).toBe('INVALID_STATE');
    });
});

describe('controller + valuation report', () => {
    const run = async (fn, req) => { const res = mkRes(); await fn(req, res, (e) => { throw e; }); return res; };
    test('send writes one audit record and list resolves branch names', async () => {
        const create = await run(ctl.createTransfer, mkReq({ body: { fromBranch: B1, toBranch: B2, lines: [{ item: RICE, qty: 1 }] } }));
        expect(create.statusCode).toBe(201);
        const id = create.body.transfer._id;
        await run(ctl.sendTransfer, mkReq({ params: { id } }));
        await run(ctl.sendTransfer, mkReq({ params: { id } })); // idempotent: no second audit
        expect(mockAudit.mock.calls.filter((c) => /sent/.test(c[1].summary))).toHaveLength(1);
        const list = await run(ctl.listTransfers, mkReq());
        expect(list.body.transfers[0]).toMatchObject({ fromName: 'Main', toName: 'Annex', status: 'in_transit' });
    });
    test('valuation values known cost at avgCost, flags unknown, groups by category and branch', async () => {
        const res = await run(ctl.getValuation, mkReq());
        const b = res.body;
        // Rice 10*60 + rice(B2) 4*40 = 760; Oil unknown (5*100 list value reported separately)
        expect(b.totals).toMatchObject({ value: 760, unknownCostItems: 1, unknownCostListValue: 500, items: 3 });
        expect(b.byItem.find((r) => r.name === 'Oil')).toMatchObject({ unknownCost: true, value: 0, listValue: 500, avgCost: null });
        expect(b.byCategory.find((c) => c.key === 'Raw Ingredients').value).toBe(760);
        expect(b.byBranch.map((x) => x.label).sort()).toEqual(['Annex', 'Main', 'Main / unassigned']);
    });
});
