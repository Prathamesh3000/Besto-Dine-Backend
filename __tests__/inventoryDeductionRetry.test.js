/**
 * Inventory deduction reliability (plan 2.4): durable job, backoff, retry,
 * no double deduction, cap + alert.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockEmit = jest.fn();
jest.mock('../utils/socket', () => ({ getIO: () => ({}), emitToAdmin: (...a) => mockEmit(...a) }));

const mockDeduct = jest.fn();
const mockRestore = jest.fn(async () => ({ errors: [], restored: [] }));
jest.mock('../controllers/inventoryController', () => ({
    deductInventoryForOrder: (...a) => mockDeduct(...a),
    restoreInventoryForOrder: (...a) => mockRestore(...a),
}));

// ── in-memory models ────────────────────────────────────────────────
const R = 'rest1';
let mockOrders; let mockJobs; let mockInv;

const mockLean = (v) => ({ lean: async () => v, sort() { return this; }, limit() { return this; }, select() { return this; } });

jest.mock('../models/order', () => ({
    findOne: jest.fn((f) => {
        const v = mockOrders.find((o) => String(o._id) === String(f._id)) || null;
        const q = { select: () => q, lean: async () => v, then: (res, rej) => Promise.resolve(v).then(res, rej) };
        return q;
    }),
    findOneAndUpdate: jest.fn(async (f, u) => {
        const o = mockOrders.find((x) => String(x._id) === String(f._id));
        if (!o || (f.inventoryDeducted !== undefined && o.inventoryDeducted !== f.inventoryDeducted)) return null;
        if (u.$set) Object.assign(o, u.$set);
        if (u.$unset) for (const k of Object.keys(u.$unset)) delete o[k];
        return o;
    }),
}));
jest.mock('../models/inventory', () => ({
    exists: jest.fn(async () => (mockInv.partial ? { _id: 'x' } : null)),
}));
jest.mock('../models/inventoryDeductionJob', () => {
    const match = (j, f) => Object.entries(f).every(([k, v]) => {
        if (k === 'nextAttemptAt' && v && v.$lte) return j.nextAttemptAt && j.nextAttemptAt <= v.$lte;
        if (v && v.$in) return v.$in.includes(j[k]);
        return String(j[k]) === String(v);
    });
    return {
        findOneAndUpdate: jest.fn(async (f, u, opts) => {
            let j = mockJobs.find((x) => match(x, f));
            if (!j) {
                if (!opts?.upsert) return null;
                j = { _id: `job${mockJobs.length + 1}`, restaurant: f.restaurant, order: f.order, state: 'pending', retryable: true, attempts: 0, ...(u.$setOnInsert || {}) };
                mockJobs.push(j);
            }
            if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) j[k] = (j[k] || 0) + v;
            if (u.$set) Object.assign(j, u.$set);
            return { ...j };
        }),
        updateOne: jest.fn(async (f, u) => {
            const j = mockJobs.find((x) => match(x, f));
            if (j && u.$set) Object.assign(j, u.$set);
            return { matchedCount: j ? 1 : 0 };
        }),
        findOne: jest.fn((f) => { const j = mockJobs.find((x) => match(x, f)); return mockLean(j ? { ...j } : null); }),
        find: jest.fn((f) => mockLean(mockJobs.filter((x) => match(x, f)).map((j) => ({ ...j })))),
    };
});

const svc = require('../services/inventoryDeductionService');

const order = (extra = {}) => ({ _id: 'o1', orderId: 'ORD-1', restaurant: R, status: 'preparing', inventoryDeducted: false, items: [], ...extra });
const ok = { deducted: [{}], errors: [], skipped: [] };
const systemic = { deducted: [], errors: [{ reason: 'connection reset' }], skipped: [] };

beforeEach(() => {
    jest.clearAllMocks();
    mockJobs = []; mockInv = { partial: false };
    mockOrders = [order()];
    delete process.env.INVENTORY_DEDUCTION_MAX_ATTEMPTS;
    delete process.env.INVENTORY_DEDUCTION_BACKOFF_BASE_MS;
});

describe('backoffMs', () => {
    test('doubles per attempt from 30s and caps at 1h', () => {
        expect(svc.backoffMs(1)).toBe(30000);
        expect(svc.backoffMs(2)).toBe(60000);
        expect(svc.backoffMs(3)).toBe(120000);
        expect(svc.backoffMs(20)).toBe(3600000);
    });
    test('base is configurable', () => {
        process.env.INVENTORY_DEDUCTION_BACKOFF_BASE_MS = '1000';
        expect(svc.backoffMs(3)).toBe(4000);
    });
});

describe('runDeductionWithRecovery', () => {
    test('clean deduction creates no job', async () => {
        mockDeduct.mockResolvedValue(ok);
        await svc.runDeductionWithRecovery(mockOrders[0], R, 'u1');
        expect(mockJobs).toHaveLength(0);
    });

    test('systemic failure with nothing taken: claim released, retryable pending job with backoff', async () => {
        mockOrders[0].inventoryDeducted = true; // the claim deduct made before failing
        mockDeduct.mockResolvedValue(systemic);
        await svc.runDeductionWithRecovery(mockOrders[0], R, 'u1');
        expect(mockOrders[0].inventoryDeducted).toBe(false);
        expect(mockJobs).toHaveLength(1);
        expect(mockJobs[0]).toMatchObject({ state: 'pending', retryable: true, attempts: 1 });
        expect(mockJobs[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect(mockJobs[0].lastError).toMatch(/connection reset/);
    });

    test('a thrown error is treated like a systemic failure', async () => {
        mockDeduct.mockRejectedValue(new Error('boom'));
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockJobs[0]).toMatchObject({ state: 'pending', retryable: true });
    });

    test('partial deduction is NOT retried (would double-deduct): failed, claim kept, admin alerted', async () => {
        mockOrders[0].inventoryDeducted = true;
        mockInv.partial = true;
        mockDeduct.mockResolvedValue(systemic);
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockOrders[0].inventoryDeducted).toBe(true);
        expect(mockJobs[0]).toMatchObject({ state: 'failed', retryable: false });
        expect(mockJobs[0].lastError).toMatch(/Partial deduction/);
        expect(mockEmit).toHaveBeenCalledWith(expect.anything(), null, 'inventory:alert', expect.objectContaining({ severity: 'deduction-failed' }));
    });

    test('item-level errors (unit mismatch) are recorded as failed, not retryable', async () => {
        mockDeduct.mockResolvedValue({ deducted: [], skipped: [], errors: [{ inventoryItem: 'i1', reason: 'Unit mismatch' }] });
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockJobs[0]).toMatchObject({ state: 'failed', retryable: false });
    });

    test('a later clean result marks an open job done', async () => {
        mockDeduct.mockResolvedValueOnce(systemic).mockResolvedValueOnce(ok);
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockJobs[0].state).toBe('done');
    });

    test('attempt cap: job fails and alerts instead of retrying forever', async () => {
        process.env.INVENTORY_DEDUCTION_MAX_ATTEMPTS = '2';
        mockDeduct.mockResolvedValue(systemic);
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockJobs[0].state).toBe('pending');
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        expect(mockJobs[0]).toMatchObject({ state: 'failed', retryable: false, attempts: 2 });
        expect(mockEmit).toHaveBeenCalledTimes(1);
    });
});

describe('retry worker', () => {
    const makeDue = async () => {
        mockDeduct.mockResolvedValueOnce(systemic);
        await svc.runDeductionWithRecovery(mockOrders[0], R);
        mockJobs[0].nextAttemptAt = new Date(Date.now() - 1000);
    };

    test('retries a due job until it succeeds, deducting exactly once', async () => {
        await makeDue();
        mockDeduct.mockResolvedValueOnce(systemic).mockResolvedValueOnce(ok);
        let r = await svc.runDueRetries();
        expect(r).toMatchObject({ scanned: 1, retried: 1 });
        expect(mockJobs[0]).toMatchObject({ state: 'pending', attempts: 2 });
        mockJobs[0].nextAttemptAt = new Date(Date.now() - 1000);
        r = await svc.runDueRetries();
        expect(r.done).toBe(1);
        expect(mockJobs[0].state).toBe('done');
        expect(mockDeduct).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    test('does not touch jobs that are not due yet', async () => {
        await makeDue();
        mockJobs[0].nextAttemptAt = new Date(Date.now() + 60000);
        const r = await svc.runDueRetries();
        expect(r.scanned).toBe(0);
        expect(mockDeduct).toHaveBeenCalledTimes(1);
    });

    test('never re-deducts an order that already carries the marker', async () => {
        await makeDue();
        mockOrders[0].inventoryDeducted = true; // someone else deducted meanwhile
        const r = await svc.runDueRetries();
        expect(r.done).toBe(1);
        expect(mockDeduct).toHaveBeenCalledTimes(1);
        expect(mockJobs[0].state).toBe('done');
    });

    test('a cancelled order is closed out without deducting', async () => {
        await makeDue();
        mockOrders[0].status = 'cancelled';
        await svc.runDueRetries();
        expect(mockDeduct).toHaveBeenCalledTimes(1);
        expect(mockJobs[0].state).toBe('done');
    });

    test('a lease stops a concurrent second retry of the same job', async () => {
        await makeDue();
        const snapshot = { ...mockJobs[0] };
        mockDeduct.mockResolvedValue(ok);
        const [a, b] = await Promise.all([svc.retryJob(snapshot), svc.retryJob(snapshot)]);
        expect([a.outcome, b.outcome].sort()).toEqual(['done', 'skipped']);
    });

    test('cancel racing a successful retry restores the stock it just took', async () => {
        await makeDue();
        mockDeduct.mockImplementationOnce(async (o) => { o.inventoryDeducted = true; o.status = 'cancelled'; return ok; });
        // order is 'preparing' when the retry starts, 'cancelled' by the time it finishes
        await svc.runDueRetries();
        expect(mockRestore).toHaveBeenCalledTimes(1);
    });
});
