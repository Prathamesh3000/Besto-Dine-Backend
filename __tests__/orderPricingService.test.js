/**
 * services/orderPricingService.js — authoritative money math for orders.
 *
 * Coverage:
 *   - toppings validation, canonical cart pricing (branch price, offer,
 *     sizes, toppings, quantity rules, paise rounding)
 *   - delivery fee (measured / fallback slab, disabled, min order)
 *   - coupon at order create (dates, min order, scope, %, cap, flat,
 *     branch pin, time-of-day window)
 *   - loyalty points redemption (balance clamp, conversion, caps)
 *   - wallet split balance check
 *   - client total sanity check and server tax breakdown per caller type
 *   - line-item enrichment, stock-shortage body, append pricing, bill
 *     recompute fallbacks
 *
 * Models, settings and the delivery quote are mocked; pricing helpers
 * (priceResolver, billing, couponScope, orderBillMath) run for real.
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */

// ── Mocks ────────────────────────────────────────────────────────────
jest.mock('../utils/idGenerator', () => ({ orderId: () => 'ORD-T', transactionId: () => 'TXN-T' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGetSettings = jest.fn();
jest.mock('../utils/settingsCache', () => ({ getSettings: (...a) => mockGetSettings(...a) }));

const mockWalletFindOne = jest.fn();
jest.mock('../models/wallet', () => ({ findOne: (...a) => mockWalletFindOne(...a) }));

const mockCouponFindOne = jest.fn();
jest.mock('../models/coupon', () => ({ findOne: (...a) => mockCouponFindOne(...a) }));

const mockQuoteDelivery = jest.fn();
jest.mock('../utils/deliveryDistance', () => ({ quoteDelivery: (...a) => mockQuoteDelivery(...a) }));

const pricing = require('../services/orderPricingService');
const { computeBill, toTaxConfig } = require('../utils/billing');

// ── Helpers ──────────────────────────────────────────────────────────
const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_BRANCH = 'cccccccccccccccccccccccc';
const USER = 'dddddddddddddddddddddddd';

const TAXES = {
    gst: { enabled: true, value: 5 },
    serviceCharge: { enabled: true, value: 10 },
    additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 20, enabled: true }],
};

const leanOf = (v) => ({ lean: () => Promise.resolve(v) });
const reqAs = (role, body = {}) => ({
    restaurant: { _id: TENANT },
    user: role ? { _id: USER, id: USER, role } : undefined,
    body,
});

async function expectHttpError(promiseOrFn, status, code) {
    let err;
    try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(status);
    if (code) expect(err.body.code).toBe(code);
    return err;
}

const menu = (fields = {}) => ({
    _id: 'm1', name: 'Paneer Tikka', basePrice: 200, finalPrice: 200, offerPercentage: 0,
    toppings: [{ name: 'Extra Cheese', price: 30 }, { name: 'Mint Dip', price: 15.5 }],
    sizes: [], vegType: 'veg', category: { name: 'Starters' }, prepStation: 'kitchen', prepTimeMinutes: 12,
    ...fields,
});
const byId = (...menus) => new Map(menus.map((m) => [String(m._id), m]));

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockResolvedValue({ taxes: TAXES });
});

// ── validateSelectedToppings ─────────────────────────────────────────
describe('validateSelectedToppings', () => {
    const m = menu();

    test('accepts toppings that match the menu, ignoring case, spaces and a 1-paise float drift', () => {
        expect(() => pricing.validateSelectedToppings([
            { menuItem: 'm1', selectedToppings: [{ name: '  extra CHEESE ', price: 30 }, { name: 'Mint Dip', price: 15.509 }] },
            { menuItem: 'm1' },
        ], byId(m))).not.toThrow();
    });

    test.each([
        ['an unknown topping', [{ name: 'Gold Leaf', price: 0 }], /Invalid topping/],
        ['a topping priced below the menu', [{ name: 'Extra Cheese', price: 0 }], /price mismatch/],
        ['a topping priced 2 paise off', [{ name: 'Mint Dip', price: 15.52 }], /price mismatch/],
        ['a nameless topping', [{ price: 30 }], /Invalid topping/],
    ])('rejects %s', (_label, selectedToppings, message) => {
        let err;
        try { pricing.validateSelectedToppings([{ menuItem: 'm1', selectedToppings }], byId(m)); } catch (e) { err = e; }
        expect(err.status).toBe(400);
        expect(err.body.message).toMatch(message);
    });

    test('rejects toppings on an item that is not on the menu', () => {
        let err;
        try { pricing.validateSelectedToppings([{ menuItem: 'ghost', selectedToppings: [{ name: 'x', price: 1 }] }], byId(m)); } catch (e) { err = e; }
        expect(err.status).toBe(400);
        expect(err.body.message).toMatch(/Unknown menu item/);
    });
});

// ── priceCartItems ───────────────────────────────────────────────────
describe('priceCartItems', () => {
    test('prices each line from the menu, ignoring the client price, and stamps it back', () => {
        const items = [{ menuItem: 'm1', price: 1, quantity: 2 }];

        const subtotal = pricing.priceCartItems(items, byId(menu()), null);

        expect(subtotal).toBe(400);
        expect(items[0]).toMatchObject({ price: 200, quantity: 2 });
    });

    test('uses the branch price override with its active offer', () => {
        const m = menu({ branchPrices: [{ branch: BRANCH, basePrice: 333, offerPercentage: 7 }] });
        const items = [{ menuItem: 'm1', quantity: 3 }];

        // 333 - 7% = 309.69 → × 3 = 929.07
        expect(pricing.priceCartItems(items, byId(m), BRANCH)).toBe(929.07);
    });

    test('a branch without an override pays the default price', () => {
        const m = menu({ branchPrices: [{ branch: BRANCH, basePrice: 333 }] });
        expect(pricing.priceCartItems([{ menuItem: 'm1', quantity: 1 }], byId(m), OTHER_BRANCH)).toBe(200);
    });

    test('a size uses its own price with the offer applied, rounded to the paisa', () => {
        const m = menu({ finalPrice: 135, basePrice: 150, offerPercentage: 10, sizes: [{ name: 'Half', price: 150 }, { name: 'Full', price: 249.99 }] });
        const items = [{ menuItem: 'm1', quantity: 1, selectedSizes: [{ name: 'full', price: 1 }] }];

        // 249.99 - 10% = 224.991 → 224.99
        expect(pricing.priceCartItems(items, byId(m), null)).toBe(224.99);
        expect(items[0].price).toBe(224.99);
    });

    test('toppings are charged at the menu price per unit', () => {
        const items = [{ menuItem: 'm1', quantity: 3, selectedToppings: [{ name: 'Extra Cheese', price: 0 }, { name: 'Mint Dip', price: 0 }] }];

        // (200 + 30 + 15.5) × 3 = 736.5
        expect(pricing.priceCartItems(items, byId(menu()), null)).toBe(736.5);
        expect(items[0].price).toBe(200); // per-unit menu price only; toppings stay in selectedToppings
    });

    test.each([
        [2.9, 2],
        [0, 1],
        [-4, 1],
        ['abc', 1],
        [999, 999],
    ])('quantity %p is charged as %i', (quantity, expected) => {
        const items = [{ menuItem: 'm1', quantity }];
        pricing.priceCartItems(items, byId(menu({ finalPrice: 1 })), null);
        expect(items[0].quantity).toBe(expected);
    });

    test('a quantity above 999 is refused', async () => {
        await expectHttpError(() => pricing.priceCartItems([{ menuItem: 'm1', quantity: 1000 }], byId(menu()), null), 400, 'QUANTITY_EXCEEDED');
    });

    test('an unknown item or size is refused', async () => {
        await expectHttpError(() => pricing.priceCartItems([{ menuItem: 'ghost' }], byId(menu()), null), 400, 'ITEM_NOT_FOUND');
        await expectHttpError(() => pricing.priceCartItems(
            [{ menuItem: 'm1', selectedSizes: [{ name: 'Jumbo' }] }], byId(menu({ sizes: [{ name: 'Half', price: 100 }] })), null,
        ), 400, 'INVALID_SIZE');
    });

    test('float drift across lines is rounded to the paisa', () => {
        const a = menu({ _id: 'a', finalPrice: 0.1 });
        const b = menu({ _id: 'b', finalPrice: 0.2 });
        expect(pricing.priceCartItems([{ menuItem: 'a' }, { menuItem: 'b' }], byId(a, b), null)).toBe(0.3);
    });
});

// ── resolveDeliveryFee ───────────────────────────────────────────────
describe('resolveDeliveryFee', () => {
    const SLABS = [{ fromKm: 0, toKm: 3, charge: 30 }, { fromKm: 3, toKm: 6, charge: 49.995 }];
    const settings = (delivery) => ({ delivery: { enabled: true, slabs: SLABS, ...delivery } });
    const run = (opts) => pricing.resolveDeliveryFee(reqAs('customer'), {
        wantsDelivery: true, deliveryReq: {}, branchId: BRANCH, cleanDeliveryAddress: '12 MG Road',
        settings: settings(), authoritativeSubtotal: 500, ...opts,
    });

    test('no delivery means no fee', async () => {
        expect(await run({ wantsDelivery: false })).toMatchObject({ authoritativeDeliveryFee: 0, authoritativeDeliverySlab: null });
        expect(mockQuoteDelivery).not.toHaveBeenCalled();
    });

    test('uses the measured distance and snapshots the slab', async () => {
        mockQuoteDelivery.mockResolvedValue({ ok: true, slab: SLABS[1], distanceKm: 4.2, customer: { lat: 12.9, lng: 77.6 } });

        const r = await run();

        expect(r).toEqual({
            authoritativeDeliveryFee: 50,
            authoritativeDeliverySlab: { fromKm: 3, toKm: 6, charge: 50 },
            authoritativeDeliveryDistance: 4.2,
            authoritativeDeliveryCoords: { lat: 12.9, lng: 77.6 },
        });
    });

    test.each([
        ['an exact slab match', { slab: { fromKm: 0, toKm: 3 } }, 30],
        ['the slab index', { slabIndex: 1 }, 50],
    ])('falls back to %s when the distance cannot be measured', async (_label, deliveryReq, fee) => {
        mockQuoteDelivery.mockResolvedValue({ ok: false, fallback: true });
        expect((await run({ deliveryReq })).authoritativeDeliveryFee).toBe(fee);
    });

    test.each([
        ['delivery disabled', { settings: { delivery: { enabled: false } } }, 'DELIVERY_DISABLED'],
        ['no slabs configured', { settings: { delivery: { enabled: true, slabs: [] } } }, 'DELIVERY_NO_SLABS'],
        ['a slab that no longer exists', { deliveryReq: { slab: { fromKm: 9, toKm: 12 } } }, 'DELIVERY_SLAB_INVALID'],
        ['a cart below the delivery minimum', { settings: settings({ minOrderValue: 600 }), deliveryReq: { slabIndex: 0 } }, 'DELIVERY_MIN_ORDER'],
    ])('refuses %s', async (_label, opts, code) => {
        mockQuoteDelivery.mockResolvedValue({ ok: false, fallback: true });
        await expectHttpError(run(opts), 400, code);
    });

    test('a measuring error that is not a fallback is surfaced', async () => {
        mockQuoteDelivery.mockResolvedValue({ ok: false, fallback: false, code: 'DELIVERY_OUT_OF_RANGE', message: 'Too far' });
        await expectHttpError(run(), 400, 'DELIVERY_OUT_OF_RANGE');
    });

    test('a negative configured charge is clamped to zero', async () => {
        mockQuoteDelivery.mockResolvedValue({ ok: true, slab: { fromKm: 0, toKm: 1, charge: -10 }, distanceKm: 0.5 });
        expect((await run()).authoritativeDeliveryFee).toBe(0);
    });
});

// ── resolveCartCoupon ────────────────────────────────────────────────
describe('resolveCartCoupon', () => {
    const DAY = 86400000;
    const coupon = (fields = {}) => ({
        code: 'SAVE10', isActive: true, discountType: 'percentage', discountValue: 10, maxDiscountAmount: 0,
        minOrderValue: 0, scope: 'all', startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY), ...fields,
    });
    const items = [{ menuItem: 'm1', price: 300, quantity: 1 }, { menuItem: 'd1', price: 100, quantity: 2 }];
    const menus = byId(menu({ _id: 'm1' }), menu({ _id: 'd1', prepStation: 'bar' }));
    const run = (c, { role = 'customer', code = ' save10 ', subtotal = 500, req } = {}) => {
        mockCouponFindOne.mockReturnValue(leanOf(c));
        return pricing.resolveCartCoupon(req || reqAs(role, { couponCode: code }), { items, menuById: menus, authoritativeSubtotal: subtotal });
    };

    test('applies a percentage coupon looked up by normalised code within the tenant', async () => {
        const r = await run(coupon());

        expect(r).toEqual({ authoritativeCouponCode: 'SAVE10', authoritativeCouponDiscount: 50 });
        expect(mockCouponFindOne).toHaveBeenCalledWith({ code: 'SAVE10', isActive: true, restaurant: TENANT });
    });

    test.each([
        ['a capped percentage', { discountValue: 50, maxDiscountAmount: 120 }, 120],
        ['a flat amount', { discountType: 'fixed_amount', discountValue: 75 }, 75],
        ['a flat amount larger than the bill', { discountType: 'fixed_amount', discountValue: 900 }, 500],
        ['a beverages-only percentage', { scope: 'beverages', discountValue: 25 }, 50],
    ])('computes %s exactly', async (_label, fields, discount) => {
        expect((await run(coupon(fields))).authoritativeCouponDiscount).toBe(discount);
    });

    test('a guest cannot use a coupon — the code is silently dropped', async () => {
        const r = await run(coupon(), { role: null });
        expect(r).toEqual({ authoritativeCouponCode: '', authoritativeCouponDiscount: 0 });
        expect(mockCouponFindOne).not.toHaveBeenCalled();
    });

    test('a non-string code is ignored', async () => {
        const r = await pricing.resolveCartCoupon(reqAs('customer', { couponCode: { $ne: null } }), { items, menuById: menus, authoritativeSubtotal: 500 });
        expect(r.authoritativeCouponDiscount).toBe(0);
        expect(mockCouponFindOne).not.toHaveBeenCalled();
    });

    test.each([
        ['unknown', null, 'COUPON_INVALID'],
        ['not yet active', coupon({ startDate: new Date(Date.now() + DAY) }), 'COUPON_NOT_STARTED'],
        ['expired', coupon({ endDate: new Date(Date.now() - 1000) }), 'COUPON_EXPIRED'],
        ['below its minimum order', coupon({ minOrderValue: 500.01 }), 'COUPON_MIN_ORDER'],
        ['food-only on a drinks-only cart', coupon({ scope: 'food' }), 'COUPON_SCOPE_NO_MATCH'],
    ])('refuses a coupon that is %s', async (label, c, code) => {
        if (label.startsWith('food-only')) {
            mockCouponFindOne.mockReturnValue(leanOf(c));
            const drinks = [{ menuItem: 'd1', price: 100, quantity: 2 }];
            await expectHttpError(pricing.resolveCartCoupon(reqAs('customer', { couponCode: 'SAVE10' }), { items: drinks, menuById: menus, authoritativeSubtotal: 200 }), 400, code);
            return;
        }
        await expectHttpError(run(c), 400, code);
    });

    // Regression (fixed 2026-10): order create now looks coupons up within the
    // order's branch scope (tenant-level / this branch / main), like applyCoupon.
    test('a coupon pinned to another branch is refused at order create', async () => {
        const req = { ...reqAs('customer', { couponCode: 'SAVE10' }), branch: { _id: BRANCH } };
        mockCouponFindOne.mockImplementation((filter) => leanOf(filter.branch === undefined || String(filter.branch) === OTHER_BRANCH ? coupon({ branch: OTHER_BRANCH }) : null));

        await expectHttpError(pricing.resolveCartCoupon(req, { items, menuById: menus, authoritativeSubtotal: 500 }), 400, 'COUPON_INVALID');
    });

    // Regression (fixed 2026-10): order create enforces the coupon's
    // startTime/endTime window (400 COUPON_TIME_WINDOW), like applyCoupon.
    test('a coupon outside its time-of-day window is refused at order create', async () => {
        const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const later = new Date(Date.now() + 2 * 3600 * 1000);
        const evenLater = new Date(Date.now() + 3 * 3600 * 1000);
        // Skip the edge case where the window would wrap past midnight.
        if (hhmm(evenLater) < hhmm(later)) return;

        let err;
        try { await run(coupon({ startTime: hhmm(later), endTime: hhmm(evenLater) })); } catch (e) { err = e; }

        expect(err?.status).toBe(400);
    });
});

// ── resolvePointsRedemption ──────────────────────────────────────────
describe('resolvePointsRedemption', () => {
    const settings = (wallet = {}) => ({ wallet: { pointsToRupee: 0.5, ...wallet } });
    const run = ({ points, available, subtotal = 500, coupon = 0, role = 'customer', userId = USER, s = settings() }) => {
        mockWalletFindOne.mockReturnValue(leanOf(available === undefined ? null : { loyaltyPoints: available }));
        return pricing.resolvePointsRedemption(reqAs(role, { pointsRedeemed: points }), {
            validUserId: userId, settings: s, authoritativeSubtotal: subtotal, authoritativeCouponDiscount: coupon,
        });
    };

    test('no points requested redeems nothing and reads no wallet', async () => {
        expect(await run({ points: 0 })).toEqual({ authoritativePointsRedeemed: 0, authoritativePointsValue: 0 });
        expect(mockWalletFindOne).not.toHaveBeenCalled();
    });

    test('a guest cannot redeem points', async () => {
        await expectHttpError(run({ points: 10, role: null, userId: null }), 400, 'POINTS_REQUIRES_LOGIN');
    });

    test('redeems the requested points at the tenant rate, from the tenant-scoped wallet', async () => {
        expect(await run({ points: 101, available: 500 })).toEqual({ authoritativePointsRedeemed: 101, authoritativePointsValue: 50.5 });
        expect(mockWalletFindOne).toHaveBeenCalledWith({ user: USER, restaurant: TENANT });
    });

    test('is clamped to the points the customer actually has', async () => {
        expect(await run({ points: 1000, available: 40 })).toEqual({ authoritativePointsRedeemed: 40, authoritativePointsValue: 20 });
    });

    test('no wallet means nothing to redeem', async () => {
        expect(await run({ points: 100 })).toEqual({ authoritativePointsRedeemed: 0, authoritativePointsValue: 0 });
    });

    // Updated 2026-10: the default 50 % maxRedeemPercent cap now applies,
    // so this pins the post-coupon floor with the cap lifted to 100 %.
    test('cannot push the post-coupon subtotal below zero; points used are recomputed', async () => {
        // subtotal 120 - coupon 20 = 100 max → 200 points at ₹0.5
        expect(await run({ points: 5000, available: 5000, subtotal: 120, coupon: 20, s: settings({ maxRedeemPercent: 100 }) }))
            .toEqual({ authoritativePointsRedeemed: 200, authoritativePointsValue: 100 });
    });

    // Regression (fixed 2026-10): Settings.wallet.maxRedeemPercent (default
    // 50 %) of the subtotal caps what points can pay.
    test('redemption is capped at the tenant maxRedeemPercent of the subtotal', async () => {
        const r = await run({ points: 5000, available: 5000, subtotal: 500, s: settings({ maxRedeemPercent: 50 }) });
        expect(r.authoritativePointsValue).toBe(250);
        expect(r.authoritativePointsRedeemed).toBe(500);
    });

    // Regression (fixed 2026-10): requested points are floored to whole points.
    test('only whole points can be redeemed', async () => {
        const r = await run({ points: 10.7, available: 100 });
        expect(Number.isInteger(r.authoritativePointsRedeemed)).toBe(true);
    });
});

// ── resolveWalletPayment ─────────────────────────────────────────────
describe('resolveWalletPayment', () => {
    const run = (amount, { balance, role = 'customer', userId = USER } = {}) => {
        mockWalletFindOne.mockReturnValue(leanOf(balance === undefined ? null : { balance }));
        return pricing.resolveWalletPayment(reqAs(role, { walletAmountPaid: amount }), { validUserId: userId });
    };

    test.each([[0], [-50], ['abc'], [undefined]])('a wallet amount of %p is treated as none', async (amount) => {
        expect(await run(amount, { balance: 100 })).toBe(0);
    });

    test('a guest cannot pay from a wallet', async () => {
        await expectHttpError(run(100, { role: null, userId: null }), 400, 'WALLET_REQUIRES_LOGIN');
    });

    test('a balance below the requested amount is refused', async () => {
        const err = await expectHttpError(run(100.01, { balance: 100 }), 400, 'WALLET_INSUFFICIENT');
        expect(err.body.message).toMatch(/₹100\.00 is less than the requested ₹100\.01/);
    });

    test('a covered amount is recorded to the paisa from the tenant-scoped wallet', async () => {
        expect(await run(99.999, { balance: 200 })).toBe(100);
        expect(mockWalletFindOne).toHaveBeenCalledWith({ user: USER, restaurant: TENANT });
    });
});

// ── checkClientTotal ─────────────────────────────────────────────────
describe('checkClientTotal', () => {
    const base = { authoritativeSubtotal: 500, authoritativeCouponDiscount: 50, authoritativePointsValue: 10, authoritativeTip: 20, authoritativeDeliveryFee: 30 };
    // server minimum = 500 - 50 - 10 + 20 + 30 = 490

    test.each([
        [488.99, 'refused'],
        [489, 'accepted'],
        [490, 'accepted'],
        [NaN, 'refused'],
        ['abc', 'refused'],
    ])('a client total of %p is %s', async (total, outcome) => {
        if (outcome === 'refused') {
            await expectHttpError(() => pricing.checkClientTotal({ ...base, total }), 400, 'TOTAL_TAMPERED');
        } else {
            expect(pricing.checkClientTotal({ ...base, total }).serverMinTotal).toBe(490);
        }
    });

    test('rounds a legitimate total to the paisa', () => {
        expect(pricing.checkClientTotal({ ...base, total: 551.255 }).authoritativeTotal).toBe(551.26);
    });

    test('an absurdly large total falls back to the server minimum', () => {
        const r = pricing.checkClientTotal({ ...base, total: 990.01 });
        expect(r.authoritativeTotal).toBe(490);
        expect(r.clientTotal).toBe(990.01);
    });
});

// ── computeTaxBreakdown ──────────────────────────────────────────────
describe('computeTaxBreakdown', () => {
    const exact = (subtotal, type, extra = 0) => computeBill({ subtotal, taxConfig: toTaxConfig(TAXES), orderType: type }).total + extra;
    const run = ({ role = 'customer', type = 'dine-in', source = 'qr-scan', clientTotal, delivery = false, discounts = {}, subtotal = 400 }) => {
        const d = { authoritativeCouponDiscount: 0, authoritativePointsValue: 0, authoritativeTip: 0, authoritativeDeliveryFee: 0, ...discounts };
        const serverMinTotal = subtotal - d.authoritativeCouponDiscount - d.authoritativePointsValue + d.authoritativeTip + d.authoritativeDeliveryFee;
        return pricing.computeTaxBreakdown(reqAs(role), {
            type, deliveryReq: { requested: delivery }, resolvedSource: source, authoritativeSubtotal: subtotal,
            authoritativeTotal: Math.round(clientTotal * 100) / 100, serverMinTotal, clientTotal, ...d,
        });
    };

    test('a customer dine-in order stores the exact server bill with its breakdown', async () => {
        // 400 + 20 GST + 40 service + 20 packaging = 480
        const r = await run({ clientTotal: 485 });

        expect(r.authoritativeTotal).toBe(480);
        expect(r.taxBreakdown).toMatchObject({
            gst: 20, gstPercentage: 5, serviceCharge: 40, serviceChargePercentage: 10, additionalChargesTotal: 20,
        });
        expect(exact(400, 'dine-in')).toBe(480);
    });

    test('GST is levied on the post-coupon value; points, tip and delivery do not move it', async () => {
        // takeaway: GST 5% of (400 − 30 coupon) = 18.50 (points are a payment
        // method, not a discount); flat packaging 20 on the gross bill.
        // 400 + 18.50 + 20 − 30 coupon − 10 points + 25 tip + 40 delivery = 463.50
        const r = await run({ type: 'takeaway', clientTotal: 463.5, discounts: {
            authoritativeCouponDiscount: 30, authoritativePointsValue: 10, authoritativeTip: 25, authoritativeDeliveryFee: 40,
        } });
        expect(r.authoritativeTotal).toBe(463.5);
        expect(r.taxBreakdown.gst).toBe(18.5);
        expect(r.taxBreakdown.serviceCharge).toBe(0);
    });

    test('the stamped GST and total follow the coupon (₹1000 food, 5% GST, ₹100 coupon → GST ₹45)', async () => {
        // No other charges apply in this fixture except the flat ₹20
        // packaging, so: 1000 + 45 + 20 − 100 = 965.
        const r = await run({ type: 'takeaway', clientTotal: 965, subtotal: 1000, discounts: {
            authoritativeCouponDiscount: 100,
        } });
        expect(r.taxBreakdown.gst).toBe(45);
        expect(r.authoritativeTotal).toBe(965);
    });

    test('a client that taxed the gross subtotal (stale rule) overpays but is not rejected', async () => {
        // Old rule would have sent 400 + 20 + 20 − 30 = 410; the new bill is 408.50.
        const r = await run({ type: 'takeaway', clientTotal: 410, discounts: { authoritativeCouponDiscount: 30 } });
        expect(r.authoritativeTotal).toBe(408.5);
    });

    test('a delivery order carries no service charge', async () => {
        const r = await run({ type: 'takeaway', delivery: true, clientTotal: 440 });
        expect(r.taxBreakdown.serviceCharge).toBe(0);
        expect(r.authoritativeTotal).toBe(440);
    });

    test('a customer total more than ₹1 below the server bill is refused with the expected total', async () => {
        const err = await expectHttpError(run({ clientTotal: 478.99 }), 400, 'TOTAL_MISMATCH');
        expect(err.body.expectedTotal).toBe(480);
    });

    test('a customer total within ₹1 below is accepted but the server bill is stored', async () => {
        expect((await run({ clientTotal: 479.01 })).authoritativeTotal).toBe(480);
    });

    test.each([
        [480.5, 480.5],
        [479.5, 479.5],
    ])('a kiosk order keeps the ₹%d it already charged', async (charged, stored) => {
        expect((await run({ source: 'kiosk', type: 'takeaway', clientTotal: charged + 0 })).authoritativeTotal)
            .toBe(charged >= 439 ? stored : 440);
    });

    test('a staff takeaway order above the bill is clamped down to it', async () => {
        expect((await run({ role: 'waiter', type: 'takeaway', clientTotal: 470 })).authoritativeTotal).toBe(440);
    });

    test('staff may record an ad-hoc discount down to the pre-tax minimum', async () => {
        expect((await run({ role: 'admin', type: 'dine-in', clientTotal: 400 })).authoritativeTotal).toBe(400);
    });

    test('if tax settings cannot be read the breakdown is zero and the client total is kept', async () => {
        mockGetSettings.mockRejectedValue(new Error('db down'));
        const r = await run({ clientTotal: 400 });
        expect(r.authoritativeTotal).toBe(400);
        expect(r.taxBreakdown).toMatchObject({ gst: 0, serviceCharge: 0, additionalChargesTotal: 0 });
    });
});

// ── enrichCartItems + insufficientStockBody ──────────────────────────
describe('enrichCartItems', () => {
    test('replaces client display fields with canonical menu data', () => {
        const m = menu({ sizes: [{ name: 'Full', price: 250 }], prepTimeMinutes: 500 });
        const [line] = pricing.enrichCartItems([{
            menuItem: 'm1', name: 'Lobster Thermidor', category: 'Fake', vegType: 'non-veg', price: 200, quantity: 1,
            selectedSizes: [{ id: 's1', name: 'full', priceDetails: 'x' }],
            selectedToppings: [{ id: 't1', name: 'extra cheese', price: 0 }, { name: 'Gold Leaf', price: 0 }],
        }], byId(m));

        expect(line).toMatchObject({
            name: 'Paneer Tikka', category: 'Starters', vegType: 'veg', prepTimeMinutes: 240,
            selectedSizes: [{ id: 's1', name: 'Full', priceDetails: 'x' }],
            selectedToppings: [{ id: 't1', name: 'Extra Cheese', price: 30 }],
        });
    });

    // Decision 6 — the line snapshots the menu category's Food / Drink kind.
    test('snapshots categoryKind from the populated category (none when the category has no kind)', () => {
        const coke = menu({ _id: 'm2', name: 'Coke', prepStation: 'counter', category: { name: 'Drinks', kind: 'beverages' } });
        const lines = pricing.enrichCartItems([{ menuItem: 'm2', quantity: 1 }, { menuItem: 'm1', quantity: 1 }], byId(coke, menu()));
        expect(lines[0]).toMatchObject({ categoryKind: 'beverages', prepStation: 'counter' });
        expect(lines[1].categoryKind).toBeUndefined();
    });

    test('an unknown size is dropped and a missing prep time defaults to 15 minutes', () => {
        const [line] = pricing.enrichCartItems([{ menuItem: 'm1', selectedSizes: [{ name: 'Jumbo' }] }], byId(menu({ prepTimeMinutes: undefined })));
        expect(line.selectedSizes).toEqual([]);
        expect(line.prepTimeMinutes).toBe(15);
    });
});

describe('insufficientStockBody', () => {
    test('names the first three shortages and counts the rest', () => {
        const shortages = ['Paneer', 'Cream', 'Butter', 'Naan', 'Rice'].map((name) => ({ name, needed: 2, available: 1, unit: 'kg' }));
        const body = pricing.insufficientStockBody({ shortages });
        expect(body).toMatchObject({ success: false, code: 'INSUFFICIENT_STOCK', shortages });
        expect(body.message).toBe('Out of stock: Paneer (need 2 kg, have 1 kg); Cream (need 2 kg, have 1 kg); Butter (need 2 kg, have 1 kg) and 2 more.');
    });
});

// ── buildAppendItems ─────────────────────────────────────────────────
describe('buildAppendItems', () => {
    test('prices appended lines from the menu with toppings', () => {
        const { enrichedItems, deltaTotal } = pricing.buildAppendItems([
            { menuItem: 'm1', name: 'Wrong', price: 1, quantity: 2.7, selectedToppings: [{ name: 'Mint Dip', price: 15.5 }] },
            { menuItem: 'm1', quantity: 1 },
        ], byId(menu()), null);

        // (200 + 15.5) × 2 + 200 = 631
        expect(deltaTotal).toBe(631);
        expect(enrichedItems[0]).toMatchObject({ name: 'Paneer Tikka', price: 200, quantity: 2, category: 'Starters', prepTimeMinutes: 12 });
    });

    // Regression (fixed 2026-10): buildAppendItems stamps one shared `now`
    // on every line of a batch. The clock stub ticks 1 ms per call so a
    // per-line new Date() would be caught deterministically.
    test('every line of one append batch shares the same addedAt', () => {
        const RealDate = Date;
        let tick = 0;
        global.Date = class extends RealDate {
            constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + (tick++)); }
            static now() { return RealDate.now(); }
        };
        try {
            const { enrichedItems } = pricing.buildAppendItems(
                [{ menuItem: 'm1', quantity: 1 }, { menuItem: 'm1', quantity: 1 }], byId(menu()), null,
            );
            expect(enrichedItems[0].addedAt.getTime()).toBe(enrichedItems[1].addedAt.getTime());
        } finally {
            global.Date = RealDate;
        }
    });

    test('appended lines snapshot the category kind (Decision 6)', () => {
        const coke = menu({ _id: 'm2', name: 'Coke', category: { name: 'Drinks', kind: 'beverages' } });
        const { enrichedItems } = pricing.buildAppendItems([{ menuItem: 'm2', quantity: 1 }, { menuItem: 'm1', quantity: 1 }], byId(coke, menu()), null);
        expect(enrichedItems[0].categoryKind).toBe('beverages');
        expect(enrichedItems[1].categoryKind).toBeUndefined();
    });

    test('toppings on an appended item that is not on the menu are refused', () => {
        let err;
        try { pricing.buildAppendItems([{ menuItem: 'ghost', selectedToppings: [{ name: 'x', price: 1 }] }], byId(menu()), null); } catch (e) { err = e; }
        expect(err.status).toBe(400);
        expect(err.body.message).toMatch(/Unknown menu item/);
    });

    test('a branch price override applies to appended items', () => {
        const m = menu({ branchPrices: [{ branch: BRANCH, basePrice: 180 }] });
        expect(pricing.buildAppendItems([{ menuItem: 'm1', quantity: 1 }], byId(m), BRANCH).deltaTotal).toBe(180);
    });

    test.each([
        ['an unknown topping', [{ name: 'Gold Leaf', price: 0 }], /Invalid topping/],
        ['an under-priced topping', [{ name: 'Extra Cheese', price: 1 }], /price mismatch/],
    ])('rejects %s', (_label, selectedToppings, message) => {
        let err;
        try { pricing.buildAppendItems([{ menuItem: 'm1', selectedToppings }], byId(menu()), null); } catch (e) { err = e; }
        expect(err.status).toBe(400);
        expect(err.body.message).toMatch(message);
    });

    // Regression (fixed 2026-10): appended sized items are priced like
    // priceCartItems — size price + item offer, rounded (₹250 − 10 % = ₹225).
    test('an appended item with a size is charged that size\'s price', () => {
        const m = menu({ basePrice: 150, finalPrice: 135, offerPercentage: 10, sizes: [{ name: 'Half', price: 150 }, { name: 'Full', price: 250 }] });

        const { deltaTotal, enrichedItems } = pricing.buildAppendItems(
            [{ menuItem: 'm1', quantity: 1, selectedSizes: [{ name: 'Full' }] }], byId(m), null,
        );

        expect(deltaTotal).toBe(225);
        expect(enrichedItems[0].price).toBe(225);
    });
});

// ── bill recompute fallbacks ─────────────────────────────────────────
describe('bill recompute when settings cannot be read', () => {
    test('append falls back to adding the bare item delta', async () => {
        mockGetSettings.mockRejectedValue(new Error('down'));
        const order = { type: 'dine-in', total: 480.1, items: [{ price: 200, quantity: 3 }] };

        await pricing.applyAppendToBill(reqAs('waiter'), order, 400, 200.2);

        expect(order.total).toBe(680.3);
    });

    test('a new repeat order falls back to the bare subtotal', async () => {
        mockGetSettings.mockRejectedValue(new Error('down'));
        const order = { type: 'takeaway', items: [{ price: 100.1, quantity: 3 }] };

        await pricing.applyNewOrderBill(reqAs('customer'), order);

        expect(order.total).toBe(300.3);
    });
});
