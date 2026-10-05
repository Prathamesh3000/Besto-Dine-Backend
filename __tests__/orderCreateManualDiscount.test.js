/**
 * services/orderCreateService — staff manual discount at creation
 * (resolveManualDiscount) and its allocation across a mixed-cart split
 * (buildOrderDocs), plus the split link. Pure phases; no database.
 * The HTTP path is covered by __tests__/integration/orderFollowups.test.js.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// uuid@13 is ESM-only (the unit run has no ESM transform).
jest.mock('../utils/idGenerator', () => ({
    orderId: () => 'ORD-T', takeawayOrderId: () => 'TK-T', kioskOrderId: () => 'KSK-T', transactionId: () => 'TXN-T',
}));

const { resolveManualDiscount, buildOrderDocs } = require('../services/orderCreateService');

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const reqAs = (user, body = {}) => ({ restaurant: { _id: TENANT }, user, body });
const admin = { _id: 'u1', role: 'admin' };
const waiterWith = (perm) => ({ _id: 'u2', role: 'waiter', permissions: { updateOrderStatus: perm } });

function thrown(fn) {
    try { fn(); } catch (e) { return e; }
    return null;
}

describe('resolveManualDiscount', () => {
    test.each([undefined, null, '', 0, '0'])('%p is a no-op for anyone (incl. guests)', (v) => {
        expect(resolveManualDiscount(reqAs(undefined, { manualDiscount: v }), 500)).toBe(0);
    });

    test('admin: rounded to paise', () => {
        expect(resolveManualDiscount(reqAs(admin, { manualDiscount: 12.345 }), 500)).toBe(12.35);
        expect(resolveManualDiscount(reqAs(admin, { manualDiscount: '40' }), 500)).toBe(40);
    });

    test('waiter needs the updateOrderStatus permission (same gate as PATCH /status)', () => {
        expect(resolveManualDiscount(reqAs(waiterWith(true), { manualDiscount: 10 }), 500)).toBe(10);
        expect(thrown(() => resolveManualDiscount(reqAs(waiterWith(false), { manualDiscount: 10 }), 500)))
            .toMatchObject({ status: 403, body: { code: 'MANUAL_DISCOUNT_STAFF_ONLY' } });
    });

    test.each([
        ['a customer', { _id: 'c', role: 'customer' }],
        ['a guest', undefined],
        ['a chef', { _id: 'k', role: 'chef', permissions: { updateOrderStatus: true } }],
    ])('%s is refused', (_l, user) => {
        expect(thrown(() => resolveManualDiscount(reqAs(user, { manualDiscount: 10 }), 500)))
            .toMatchObject({ status: 403, body: { code: 'MANUAL_DISCOUNT_STAFF_ONLY' } });
    });

    test.each([-1, 'abc', {}, Infinity])('invalid %p → 400', (v) => {
        expect(thrown(() => resolveManualDiscount(reqAs(admin, { manualDiscount: v }), 500)))
            .toMatchObject({ status: 400, body: { code: 'INVALID_MANUAL_DISCOUNT' } });
    });

    test('≤ total accepted, above total refused; without a total only shape + role are checked', () => {
        expect(resolveManualDiscount(reqAs(admin, { manualDiscount: 500 }), 500)).toBe(500);
        expect(thrown(() => resolveManualDiscount(reqAs(admin, { manualDiscount: 500.01 }), 500)))
            .toMatchObject({ status: 400, body: { code: 'MANUAL_DISCOUNT_EXCEEDS_TOTAL' } });
        expect(resolveManualDiscount(reqAs(admin, { manualDiscount: 9999 }))).toBe(9999);
    });
});

describe('buildOrderDocs — manual discount allocation', () => {
    const line = (prepStation, price) => ({ name: prepStation, price, quantity: 1, prepStation });
    const base = (items, total, md) => buildOrderDocs(reqAs(admin), {
        enrichedItems: items, authoritativeTotal: total, type: 'takeaway', orderId: 'TK-1',
        taxBreakdown: {}, authoritativeManualDiscount: md,
    });

    test('single doc: stamped on the primary doc', () => {
        const { primaryDocData, counterDocData } = base([line('kitchen', 200)], 230, 30);
        expect(counterDocData).toBeNull();
        expect(primaryDocData.manualDiscount).toBe(30);
        expect(primaryDocData.total).toBe(230);
    });

    test('mixed cart: the part above the primary doc total spills onto the counter doc', () => {
        // counter share 100 → primary 200
        const { primaryDocData, counterDocData } = base([line('kitchen', 180), line('counter', 100)], 300, 250);
        expect(primaryDocData.total).toBe(200);
        expect(counterDocData.total).toBe(100);
        expect(primaryDocData.manualDiscount).toBe(200);
        expect(counterDocData.manualDiscount).toBe(50);
    });

    test('no discount → field left at the schema default', () => {
        const { primaryDocData, counterDocData } = base([line('kitchen', 180), line('counter', 100)], 300, 0);
        expect(primaryDocData.manualDiscount).toBeUndefined();
        expect(counterDocData.manualDiscount).toBeUndefined();
    });
});
