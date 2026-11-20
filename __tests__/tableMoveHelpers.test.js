const {
    OPEN_STATUSES, movedFromOf, orderBlocker, summarizeOrders, isInMergeGroup, mergeMovedSessions,
} = require('../utils/tableMove');

describe('movedFromOf', () => {
    test('null for an order that never moved or has no history', () => {
        expect(movedFromOf(null)).toBeNull();
        expect(movedFromOf({})).toBeNull();
        expect(movedFromOf({ tableMoves: [] })).toBeNull();
    });
    test('the FROM side of the latest move', () => {
        const at1 = new Date('2026-01-01T10:00:00Z');
        const at2 = new Date('2026-01-01T11:00:00Z');
        const o = { tableMoves: [
            { fromTable: 'a', fromTableName: 'T1', at: at1 },
            { fromTable: 'b', fromTableName: 'T2', at: at2 },
        ] };
        expect(movedFromOf(o)).toEqual({ tableId: 'b', tableName: 'T2', at: at2 });
    });
    test('stringifies ObjectId-like ids and does not crash on junk', () => {
        const id = { toString: () => 'abc123' };
        expect(movedFromOf({ tableMoves: [{ fromTable: id, fromTableName: 'X', at: null }] }).tableId).toBe('abc123');
        expect(movedFromOf({ tableMoves: [null] })).toBeNull();
        expect(movedFromOf({ tableMoves: 'nope' })).toBeNull();
    });
});

describe('orderBlocker', () => {
    test('a plain open order is movable', () => {
        expect(orderBlocker({ status: 'new', paymentStatus: 'Pending', amountPaid: 0 })).toBeNull();
        expect(orderBlocker({ status: 'awaiting-payment', counterPaymentRequestedAt: new Date() })).toBeNull();
    });
    test('final bill', () => {
        expect(orderBlocker({ bill: { status: 'final' } })).toBe('BILL_FINAL');
        expect(orderBlocker({ bill: { status: 'draft' } })).toBeNull();
    });
    test.each([
        [{ paymentStatus: 'Paid' }],
        [{ paymentStatus: 'Partially Paid' }],
        [{ paymentStatus: 'Refunded' }],
        [{ amountPaid: 0.01 }],
    ])('payment attached %j', (o) => {
        expect(orderBlocker(o)).toBe('PAYMENT_ATTACHED');
    });
    test('final bill is reported before payment', () => {
        expect(orderBlocker({ bill: { status: 'final' }, paymentStatus: 'Paid' })).toBe('BILL_FINAL');
    });
});

describe('summarizeOrders', () => {
    test('sums quantities and totals to 2dp', () => {
        const s = summarizeOrders([
            { total: 10.1, items: [{ quantity: 2 }, { quantity: 1 }] },
            { total: 0.2, items: [{ quantity: 3 }] },
            { total: undefined, items: [] },
        ]);
        expect(s).toEqual({ orderCount: 3, itemCount: 6, total: 10.3 });
    });
    test('missing quantity counts as 1', () => {
        expect(summarizeOrders([{ total: 1, items: [{}] }]).itemCount).toBe(1);
    });
});

describe('isInMergeGroup', () => {
    test('merge state of the table itself', () => {
        expect(isInMergeGroup({ status: 'merged' })).toBe(true);
        expect(isInMergeGroup({ status: 'free', mergedWith: ['x'] })).toBe(true);
        expect(isInMergeGroup({ status: 'free', mergedWith: [] })).toBe(false);
        expect(isInMergeGroup({ status: 'free' })).toBe(false);
    });
    test('another table listing it counts', () => {
        expect(isInMergeGroup({ status: 'free' }, true)).toBe(true);
    });
});

describe('mergeMovedSessions', () => {
    test('adds new session entries, keeps the old ones, de-duplicates, caps the list', () => {
        const at = new Date();
        const out = mergeMovedSessions(
            [{ sessionId: 's1', fromTable: 'A', at: new Date(0) }],
            ['s1', 's2', '', null], 'B', at,
        );
        expect(out.filter((m) => m.sessionId === 's1')).toHaveLength(2); // different fromTable
        expect(out.find((m) => m.sessionId === 's2')).toMatchObject({ fromTable: 'B', at });
        expect(out.some((m) => !m.sessionId)).toBe(false);
        const many = mergeMovedSessions([], Array.from({ length: 500 }, (_, i) => `s${i}`), 'B', at);
        expect(many.length).toBeLessThanOrEqual(200);
    });
    test('same session + same fromTable is not duplicated', () => {
        const out = mergeMovedSessions([{ sessionId: 's1', fromTable: 'A', at: new Date(0) }], ['s1'], 'A', new Date());
        expect(out).toHaveLength(1);
    });
});

test('OPEN_STATUSES', () => {
    expect(OPEN_STATUSES).toEqual(['awaiting-payment', 'new', 'preparing', 'ready', 'served']);
});
