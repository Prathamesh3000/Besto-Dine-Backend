/**
 * utils/couponScope.js — ADM-064 coupon scope (all / food / beverages) and
 * the discount computation shared by checkout, order create and the staff
 * "apply coupon" flow.
 *
 * Coverage:
 *   - item classification by category kind (decision 6) with the prep
 *     station fallback, eligibility per scope, withCategoryKinds stamping
 *   - eligible subtotal: mixed carts, toppings, rounding, junk input
 *   - percentage (cap, no cap, > 100 %), flat (above / below eligible),
 *     unsupported discount types, unknown scope, return shape
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const { classifyItem, isEligible, eligibleSubtotal, computeCouponDiscount, withCategoryKinds } = require('../utils/couponScope');
const { inferPrepStation } = require('../utils/prepStationInfer');

const line = (price, quantity = 1, prepStation = 'kitchen', extra = {}) => ({ price, quantity, prepStation, ...extra });
const MIXED = [
    line(300, 2),            // food 600
    line(150, 1, 'bar'),     // beverage 150
    line(80.5, 2, 'counter') // counter 161 (classified as food today)
];

describe('classifyItem / isEligible', () => {
    test.each([
        ['bar', 'beverages'],
        ['BAR', 'beverages'],
        ['kitchen', 'food'],
        ['counter', 'food'],
        [undefined, 'food'],
        ['', 'food'],
    ])('prep station %p is classified as %s', (prepStation, cls) => {
        expect(classifyItem({ prepStation })).toBe(cls);
    });

    test('a missing item is classified as food', () => {
        expect(classifyItem(null)).toBe('food');
    });

    test.each([
        ['all', 'bar', true],
        [undefined, 'bar', true],
        ['food', 'kitchen', true],
        ['food', 'bar', false],
        ['beverages', 'bar', true],
        ['beverages', 'kitchen', false],
        ['drinks', 'bar', false],   // unknown scope matches nothing
    ])('scope %p with a %s item → eligible %p', (scope, prepStation, eligible) => {
        expect(isEligible({ prepStation }, scope)).toBe(eligible);
    });

    // Decision 6 (2026-10): the admin marks each menu category Food or
    // Drink (Category.kind) and that kind is snapshotted onto order lines as
    // categoryKind. Sealed drinks are routed to the 'counter' prep station
    // (utils/prepStationInfer: Coke, Pepsi, Sprite, Red Bull, water…), which
    // used to make a "beverages" coupon give nothing off a Coke.
    test('Regression (fixed 2026-10): decision 6 — a Coke in a Drink category counts as a beverage even when routed to the counter', () => {
        const station = inferPrepStation({ name: 'Coke 300ml' });
        expect(station).toBe('counter');
        const coke = { name: 'Coke 300ml', prepStation: station, categoryKind: 'beverages' };
        expect(classifyItem(coke)).toBe('beverages');
        expect(isEligible(coke, 'beverages')).toBe(true);
        expect(isEligible(coke, 'food')).toBe(false);
    });

    test.each([
        ['food', 'bar', 'food'],          // admin's category kind beats the bar station
        ['beverages', 'kitchen', 'beverages'],
        ['BEVERAGES', 'kitchen', 'beverages'],
        ['drinks', 'bar', 'beverages'],   // invalid kind → prep-station fallback
        ['', 'counter', 'food'],
        [undefined, 'bar', 'beverages'],  // old orders without the snapshot
    ])('categoryKind %p on a %s item → %s', (categoryKind, prepStation, cls) => {
        expect(classifyItem({ categoryKind, prepStation })).toBe(cls);
    });
});

describe('withCategoryKinds', () => {
    const menuById = new Map([
        ['m1', { _id: 'm1', category: { name: 'Cold Drinks', kind: 'beverages' } }],
        ['m2', { _id: 'm2', category: { name: 'Mains', kind: 'food' } }],
        ['m3', { _id: 'm3', category: 'cat-id-not-populated' }],
    ]);

    test('stamps the menu category kind onto each line without mutating it', () => {
        const items = [
            { menuItem: 'm1', price: 60, quantity: 2, prepStation: 'counter' },
            { menuItem: 'm2', price: 200, quantity: 1, prepStation: 'kitchen' },
        ];
        const out = withCategoryKinds(items, menuById);
        expect(out.map(i => i.categoryKind)).toEqual(['beverages', 'food']);
        expect(items[0].categoryKind).toBeUndefined();
        expect(eligibleSubtotal(out, 'beverages')).toBe(120);
        expect(eligibleSubtotal(out, 'food')).toBe(200);
    });

    test('unknown / unpopulated menu items get no kind (prep-station fallback)', () => {
        const out = withCategoryKinds([{ menuItem: 'm3', prepStation: 'bar' }, { menuItem: 'zz' }, { name: 'custom' }], menuById);
        expect(out.every(i => i.categoryKind === undefined)).toBe(true);
        expect(classifyItem(out[0])).toBe('beverages');
    });

    test('an existing snapshot is kept (re-labelling a category later does not shift old orders)', () => {
        expect(withCategoryKinds([{ menuItem: 'm1', categoryKind: 'food' }], menuById)[0].categoryKind).toBe('food');
    });

    test('accepts a populated menuItem and junk input', () => {
        expect(withCategoryKinds([{ menuItem: { _id: 'x', category: { kind: 'beverages' } } }], new Map())[0].categoryKind).toBe('beverages');
        expect(withCategoryKinds(null, menuById)).toEqual([]);
        expect(withCategoryKinds([{ menuItem: 'm1' }], null)[0].categoryKind).toBeUndefined();
    });
});

describe('eligibleSubtotal', () => {
    test.each([
        ['all', 911],
        ['food', 761],
        ['beverages', 150],
        ['drinks', 0],
    ])('scope %s on a mixed cart is ₹%d', (scope, expected) => {
        expect(eligibleSubtotal(MIXED, scope)).toBe(expected);
    });

    test('toppings are not part of the discountable amount', () => {
        expect(eligibleSubtotal([line(200, 2, 'kitchen', { selectedToppings: [{ price: 50 }] })], 'all')).toBe(400);
    });

    test('float drift is rounded to the paisa', () => {
        expect(eligibleSubtotal([line(0.1), line(0.2)], 'all')).toBe(0.3);
    });

    test('quantity 0 and junk prices contribute nothing', () => {
        expect(eligibleSubtotal([line(500, 0), line('abc', 3), line(100, 'x'), line(20, 2)], 'all')).toBe(40);
    });

    test.each([[[]], [null], [undefined], ['not-an-array']])('%p has no eligible subtotal', (items) => {
        expect(eligibleSubtotal(items, 'all')).toBe(0);
    });
});

describe('computeCouponDiscount', () => {
    const pct = (value, cap = 0, scope = 'all') => ({ discountType: 'percentage', discountValue: value, maxDiscountAmount: cap, scope });
    const flat = (value, scope = 'all') => ({ discountType: 'fixed_amount', discountValue: value, scope });

    test.each([
        ['10% of 911', pct(10), 91.1],
        ['12.5% of 911', pct(12.5), 113.88],   // 113.875 → paise
        ['33% of 911', pct(33), 300.63],
        ['33% capped at ₹250', pct(33, 250), 250],
        ['10% with a cap above it', pct(10, 500), 91.1],
        ['150% (capped at the eligible amount)', pct(150), 911],
        ['a ₹100 flat amount', flat(100), 100],
        ['a ₹5000 flat amount on ₹911', flat(5000), 911],
        ['a numeric-string flat amount', flat('75.5'), 75.5],
    ])('%s → ₹%d off', (_label, coupon, discount) => {
        expect(computeCouponDiscount(coupon, MIXED).discount).toBe(discount);
    });

    test('a scoped percentage applies only to eligible lines', () => {
        expect(computeCouponDiscount(pct(20, 0, 'beverages'), MIXED)).toEqual({ discount: 30, eligibleSubtotal: 150, scope: 'beverages' });
        expect(computeCouponDiscount(pct(20, 0, 'food'), MIXED)).toEqual({ discount: 152.2, eligibleSubtotal: 761, scope: 'food' });
    });

    test('a scoped flat coupon is capped at the eligible lines, not the whole cart', () => {
        expect(computeCouponDiscount(flat(400, 'beverages'), MIXED).discount).toBe(150);
    });

    test.each([
        ['bogo', { discountType: 'bogo', discountValue: 1 }],
        ['shipping_discount', { discountType: 'shipping_discount', discountValue: 40 }],
        ['an unknown type', { discountType: 'mystery', discountValue: 40 }],
    ])('%s gives no discount at this stage', (_label, coupon) => {
        expect(computeCouponDiscount(coupon, MIXED)).toEqual({ discount: 0, eligibleSubtotal: 911, scope: 'all' });
    });

    test('nothing eligible means no discount and an eligible subtotal of 0', () => {
        expect(computeCouponDiscount(pct(50, 0, 'beverages'), [line(500)])).toEqual({ discount: 0, eligibleSubtotal: 0, scope: 'beverages' });
    });

    // Contract: every caller (checkout, order create, staff apply, booking)
    // only calls this after finding a coupon, so a null coupon is a caller
    // bug and is allowed to throw.
    test('requires a coupon document', () => {
        expect(() => computeCouponDiscount(null, MIXED)).toThrow(TypeError);
    });

    test('a junk percentage value gives no discount', () => {
        expect(computeCouponDiscount(pct('ten'), MIXED).discount).toBe(0);
    });
});
