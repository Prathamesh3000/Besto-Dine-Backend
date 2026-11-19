/**
 * STRICT payments campaign — LOYALTY POINTS + COUPONS / PROMOTIONS
 *   controllers/promotionController.js (apply-coupon, coupon CRUD),
 *   services/orderPricingService.js (resolveCartCoupon / resolvePointsRedemption),
 *   services/orderCreateService.js (atomic usage + redemption),
 *   services/orderPaymentService.js (points earn: staff mark-paid vs customer finalize),
 *   utils/couponScope.js.
 *
 * Money asserted to the paisa. "BUG:" tests pin real defects and are expected
 * to FAIL until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { computeBill, toTaxConfig } = req_('utils/billing');
const Order = req_('models/order');
const Coupon = req_('models/coupon');
const CouponRedemption = req_('models/couponRedemption');
const Wallet = req_('models/wallet');
const Transaction = req_('models/transaction');
const Settings = req_('models/settings');
const MenuItem = req_('models/menuItem');
const Category = req_('models/category');
const Branch = req_('models/branch');
const { invalidateCache } = req_('utils/settingsCache');

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(4).toString('hex');
const DAY = 86400000;
let C;      // main tenant (GST 5 %, SC 10 %, packaging 20)
let drink;  // bar item ₹100 on C
let kind;   // food / beverage category kinds

beforeAll(async () => {
    C = await seedTenant({ label: 'splc' });
    kind = await Category.create({ restaurant: C.restaurant._id, branch: null, name: `Drinks ${rid()}`, kind: 'beverages' });
    drink = await MenuItem.create({
        restaurant: C.restaurant._id, category: kind._id, name: 'Mojito', description: 'bar', basePrice: 100,
        prepStation: 'bar', vegType: 'veg',
    });
});

// 2 × Paneer (200) + Thali Full (225) = 625
const cart = (t) => [
    { menuItem: String(t.items.paneer._id), quantity: 2 },
    { menuItem: String(t.items.thali._id), quantity: 1, selectedSizes: [{ name: 'Full' }] },
];
const takeaway = (extra = {}) => ({ type: 'takeaway', pickupLocation: 'Counter', ...extra });
const billFor0 = (t, subtotal) => computeBill({ subtotal, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'takeaway' }).total;
// The server bill is authoritative for customers; the client total only needs to be >= server bill - 1.
const place = (cust, t, extra = {}) => ctx.api.as(cust, t).post('/orders').send(takeaway({ items: cart(t), total: billFor0(t, 625), ...extra }));
const billFor = (t, subtotal, couponDiscount = 0) => computeBill({ subtotal, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'takeaway', couponDiscount });
const r2 = (n) => Math.round(n * 100) / 100;

async function mkCoupon(t, fields = {}) {
    return Coupon.create({
        restaurant: t.restaurant._id,
        code: `SP${rid().toUpperCase()}`,
        title: 'strict coupon',
        discountType: 'percentage',
        discountValue: 10,
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
        ...fields,
    });
}
const apply = (cust, body, t = C, q = '') => ctx.api.as(cust, t).post(`/promotions/apply-coupon${q}`).send(body);
const walletOf = (t, u) => Wallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean();
async function setWalletSettings(t, patch) {
    const $set = {};
    for (const [k, v] of Object.entries(patch)) $set[`wallet.${k}`] = v;
    await Settings.updateOne({ restaurant: t.restaurant._id, branch: null }, { $set });
    invalidateCache();
}

// ═════════════════════════════════════════════════════════════════════════
describe('apply-coupon: code matching and status', () => {
    test.each([['lower', (c) => c.toLowerCase()], ['mixed', (c) => c[0] + c.slice(1).toLowerCase()], ['exact', (c) => c]])(
        'code is case-insensitive (%s)', async (_l, f) => {
            const cp = await mkCoupon(C);
            const cust = await createCustomer('ap-case');
            const res = await apply(cust, { code: f(cp.code), orderValue: 500 });
            expect(res.status).toBe(200);
            expect(res.body.discount).toBe(50);
            expect(res.body.coupon.code).toBe(cp.code);
        });

    test('Regression (fixed 2026-11): apply-coupon does not trim the code, while order create does — " CODE " is "invalid" at the cart but valid at checkout', async () => {
        // Expected: same normalisation on both paths (trim + upper-case) so a pasted code with a trailing space applies.
        // Actual: promotionController.applyCoupon uses code.toUpperCase() only → 404; resolveCartCoupon trims.
        const cp = await mkCoupon(C);
        const cust = await createCustomer('ap-trim');
        const res = await apply(cust, { code: `  ${cp.code}  `, orderValue: 500 });
        expect(res.status).toBe(200);
    });

    test('inactive → 404; unknown → 404; other tenant → 404', async () => {
        const cust = await createCustomer('ap-404');
        const off = await mkCoupon(C, { isActive: false });
        expect((await apply(cust, { code: off.code, orderValue: 500 })).status).toBe(404);
        expect((await apply(cust, { code: 'NOPE123', orderValue: 500 })).status).toBe(404);
        const other = await seedTenant({ label: 'splc-o' });
        const oc = await mkCoupon(other);
        expect((await apply(cust, { code: oc.code, orderValue: 500 })).status).toBe(404);
    });

    test('expired → 400; not started → 400; end boundary in the past by 1s → 400', async () => {
        const cust = await createCustomer('ap-exp');
        const expired = await mkCoupon(C, { startDate: new Date(Date.now() - 3 * DAY), endDate: new Date(Date.now() - 1000) });
        const future = await mkCoupon(C, { startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 2 * DAY) });
        for (const cp of [expired, future]) {
            const res = await apply(cust, { code: cp.code, orderValue: 500 });
            expect(res.status).toBe(400);
        }
    });

    test('time-of-day window outside now → 400 with the window in the message', async () => {
        const cust = await createCustomer('ap-time');
        const hh = new Date().getHours();
        const [s, e] = hh >= 12 ? ['01:00', '02:00'] : ['13:00', '14:00'];
        const cp = await mkCoupon(C, { startTime: s, endTime: e });
        const res = await apply(cust, { code: cp.code, orderValue: 500 });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain(s);
    });

    test('no code → 400; non-string code (object / number / array) → 400, never a 500', async () => {
        const cust = await createCustomer('ap-nocode');
        expect((await apply(cust, { orderValue: 500 })).status).toBe(400);
        for (const code of [{ $ne: null }, 12345, ['A']]) {
            const res = await apply(cust, { code, orderValue: 500 });
            expect(res.status).toBe(400);
        }
    });

    test.each([['zero', 0], ['negative', -10], ['abc', 'abc'], ['NaN string', 'NaN'], ['Infinity', 'Infinity'], ['object', { a: 1 }], ['missing', undefined]])(
        'orderValue %s → 400', async (_l, orderValue) => {
            const cp = await mkCoupon(C);
            const cust = await createCustomer('ap-ov');
            const body = { code: cp.code };
            if (orderValue !== undefined) body.orderValue = orderValue;
            expect((await apply(cust, body)).status).toBe(400);
        });

    test('a numeric string orderValue "500" behaves as the number 500 (numeric min-order comparison, not string)', async () => {
        const cp = await mkCoupon(C, { minOrderValue: 1000 });
        const cust = await createCustomer('ap-str');
        // "500" < 1000 numerically; as a string "500" > "1000" would wrongly pass.
        const res = await apply(cust, { code: cp.code, orderValue: '500' });
        expect(res.status).toBe(400);
        const ok = await apply(cust, { code: cp.code, orderValue: '1000' });
        expect(ok.status).toBe(200);
    });
});

describe('apply-coupon: discount math', () => {
    test.each([
        // [label, coupon fields, orderValue, expected discount]
        ['10% of 500', { discountValue: 10 }, 500, 50],
        ['33.33% of 100 (paise rounding)', { discountValue: 33.33 }, 100, 33.33],
        ['12.5% of 625', { discountValue: 12.5 }, 625, 78.13],
        ['100% = whole bill', { discountValue: 100 }, 250, 250],
        ['percentage capped by maxDiscountAmount', { discountValue: 50, maxDiscountAmount: 40 }, 500, 40],
        ['cap larger than the discount is ignored', { discountValue: 10, maxDiscountAmount: 400 }, 500, 50],
        ['fixed ₹75', { discountType: 'fixed_amount', discountValue: 75 }, 500, 75],
        ['fixed larger than the bill is clamped to the bill', { discountType: 'fixed_amount', discountValue: 5000 }, 300, 300],
        ['fixed equal to the bill', { discountType: 'fixed_amount', discountValue: 300 }, 300, 300],
        ['fixed ₹0.01', { discountType: 'fixed_amount', discountValue: 0.01 }, 1, 0.01],
    ])('%s', async (_l, fields, orderValue, expected) => {
        const cp = await mkCoupon(C, fields);
        const cust = await createCustomer('ap-math');
        const res = await apply(cust, { code: cp.code, orderValue });
        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(expected);
        expect(res.body.discount).toBeLessThanOrEqual(orderValue);
    });

    test('min order is inclusive at the boundary and refuses 1 paisa below', async () => {
        const cp = await mkCoupon(C, { minOrderValue: 500 });
        const cust = await createCustomer('ap-min');
        expect((await apply(cust, { code: cp.code, orderValue: 499.99 })).status).toBe(400);
        expect((await apply(cust, { code: cp.code, orderValue: 500 })).status).toBe(200);
    });

    test('apply is a read-only preview: usageCount and redemption rows never move', async () => {
        const cp = await mkCoupon(C, { usageLimit: 5 });
        const cust = await createCustomer('ap-ro');
        for (let i = 0; i < 3; i++) await apply(cust, { code: cp.code, orderValue: 500 });
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
        expect(await CouponRedemption.countDocuments({ coupon: cp._id })).toBe(0);
    });

    test('Regression (fixed 2026-11): a bogo / shipping_discount coupon is reported "applied successfully" with a ₹0 discount instead of being refused', async () => {
        // Expected: 400 (not applicable at cart) — the customer sees a success toast but is not discounted.
        // Actual: 200 {discount: 0}. computeCouponDiscount only prices percentage / fixed_amount (utils/couponScope.js:~108).
        const cust = await createCustomer('ap-bogo');
        for (const discountType of ['bogo', 'shipping_discount']) {
            const cp = await mkCoupon(C, { discountType, discountValue: 10 });
            const res = await apply(cust, { code: cp.code, orderValue: 500 });
            expect(res.status === 200 ? res.body.discount > 0 : res.status >= 400).toBe(true);
        }
    });

    test('scope=food needs items (COUPON_NEEDS_ITEMS) and only discounts the food slice', async () => {
        const cp = await mkCoupon(C, { scope: 'food', discountValue: 10 });
        const cust = await createCustomer('ap-food');
        const noItems = await apply(cust, { code: cp.code, orderValue: 500 });
        expect(noItems.status).toBe(400);
        expect(noItems.body.code).toBe('COUPON_NEEDS_ITEMS');
        const res = await apply(cust, {
            code: cp.code, orderValue: 400,
            items: [{ menuItem: String(C.items.paneer._id), price: 200, quantity: 1 }, { menuItem: String(drink._id), price: 200, quantity: 1, prepStation: 'bar' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.eligibleSubtotal).toBe(200);
        expect(res.body.discount).toBe(20);
    });

    test('scope=beverages with only food in the cart → 400 COUPON_SCOPE_NO_MATCH', async () => {
        const cp = await mkCoupon(C, { scope: 'beverages' });
        const cust = await createCustomer('ap-bev');
        const res = await apply(cust, { code: cp.code, orderValue: 200, items: [{ menuItem: String(C.items.paneer._id), price: 200, quantity: 1 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('COUPON_SCOPE_NO_MATCH');
    });

    test('a client-sent categoryKind cannot widen a food coupon onto a bar item that resolves to beverages', async () => {
        const cp = await mkCoupon(C, { scope: 'food', discountValue: 50 });
        const cust = await createCustomer('ap-kind');
        const res = await apply(cust, {
            code: cp.code, orderValue: 100,
            items: [{ menuItem: String(drink._id), price: 100, quantity: 1, categoryKind: 'food', prepStation: 'kitchen' }],
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('COUPON_SCOPE_NO_MATCH');
    });

    test('item with negative price / quantity cannot reduce the eligible slice into a negative or inflated discount', async () => {
        const cp = await mkCoupon(C, { scope: 'food', discountValue: 10 });
        const cust = await createCustomer('ap-neg');
        const res = await apply(cust, {
            code: cp.code, orderValue: 100,
            items: [{ price: 1000, quantity: 1 }, { price: 100, quantity: -9 }],
        });
        expect(res.status === 200 ? res.body.discount <= 100 && res.body.discount >= 0 : res.status >= 400).toBe(true);
    });
});

describe('apply-coupon: limits', () => {
    test('usageLimit reached → 400; one below → 200; 0 = unlimited', async () => {
        const cust = await createCustomer('ap-ul');
        const full = await mkCoupon(C, { usageLimit: 3, usageCount: 3 });
        const last = await mkCoupon(C, { usageLimit: 3, usageCount: 2 });
        const unl = await mkCoupon(C, { usageLimit: 0, usageCount: 9999 });
        expect((await apply(cust, { code: full.code, orderValue: 500 })).status).toBe(400);
        expect((await apply(cust, { code: last.code, orderValue: 500 })).status).toBe(200);
        expect((await apply(cust, { code: unl.code, orderValue: 500 })).status).toBe(200);
    });

    test('per-user limit counts only this user; another customer is unaffected; usagePerUser 0 = unlimited', async () => {
        const cp = await mkCoupon(C, { usagePerUser: 2 });
        const [u1, u2] = [await createCustomer('ap-pu1'), await createCustomer('ap-pu2')];
        for (let i = 0; i < 2; i++) {
            await CouponRedemption.create({ restaurant: C.restaurant._id, coupon: cp._id, couponCode: cp.code, couponTitle: 't', user: u1._id, orderValue: 100, discountAmount: 10, discountType: 'percentage', discountValue: 10 });
        }
        const blocked = await apply(u1, { code: cp.code, orderValue: 500 });
        expect(blocked.status).toBe(400);
        expect(blocked.body.message).toMatch(/2 times/);
        expect((await apply(u2, { code: cp.code, orderValue: 500 })).status).toBe(200);
        const unl = await mkCoupon(C, { usagePerUser: 0 });
        for (let i = 0; i < 3; i++) {
            await CouponRedemption.create({ restaurant: C.restaurant._id, coupon: unl._id, couponCode: unl.code, couponTitle: 't', user: u1._id, orderValue: 100, discountAmount: 10, discountType: 'percentage', discountValue: 10 });
        }
        expect((await apply(u1, { code: unl.code, orderValue: 500 })).status).toBe(200);
    });

    test('branch scope: a coupon pinned to branch 2 is hidden at branch 1 (?branch=) and valid at branch 2', async () => {
        const b2 = await Branch.create({ restaurant: C.restaurant._id, name: 'Second', slug: `s-${rid()}`, isActive: true });
        const cp = await mkCoupon(C, { branch: b2._id });
        const cust = await createCustomer('ap-branch');
        expect((await apply(cust, { code: cp.code, orderValue: 500 }, C, `?branch=${C.branch._id}`)).status).toBe(404);
        expect((await apply(cust, { code: cp.code, orderValue: 500 }, C, `?branch=${b2._id}`)).status).toBe(200);
    });

    test('same code at two branches resolves to the one of the requested branch', async () => {
        const b2 = await Branch.create({ restaurant: C.restaurant._id, name: 'Third', slug: `t-${rid()}`, isActive: true });
        const code = `DUAL${rid().toUpperCase()}`;
        await mkCoupon(C, { code, branch: C.branch._id, discountValue: 10 });
        await mkCoupon(C, { code, branch: b2._id, discountValue: 20 });
        const cust = await createCustomer('ap-dual');
        expect((await apply(cust, { code, orderValue: 100 }, C, `?branch=${C.branch._id}`)).body.discount).toBe(10);
        expect((await apply(cust, { code, orderValue: 100 }, C, `?branch=${b2._id}`)).body.discount).toBe(20);
    });

    test('anonymous guest (no login) → 401; staff roles cannot use customer apply?', async () => {
        const cp = await mkCoupon(C);
        const res = await ctx.api.guest(C).post('/promotions/apply-coupon').send({ code: cp.code, orderValue: 500 });
        expect(res.status).toBe(401);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('coupon at POST /orders: discount, caps, stacking', () => {
    test('percentage discount is exact and the order total matches computeBill with that coupon', async () => {
        const cp = await mkCoupon(C, { discountValue: 20 });
        const cust = await createCustomer('oc-pct');
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponDiscount).toBe(125);
        expect(saved.total).toBe(billFor(C, 625, 125).total);
    });

    test('maxDiscountAmount caps the order discount', async () => {
        const cp = await mkCoupon(C, { discountValue: 50, maxDiscountAmount: 100 });
        const cust = await createCustomer('oc-cap');
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).couponDiscount).toBe(100);
    });

    test('discount greater than the bill (fixed ₹5000 on ₹625): clamped to the subtotal, total never negative, GST not negative', async () => {
        const cp = await mkCoupon(C, { discountType: 'fixed_amount', discountValue: 5000 });
        const cust = await createCustomer('oc-big');
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponDiscount).toBe(625);
        expect(saved.total).toBeGreaterThanOrEqual(0);
        expect(saved.gst).toBeGreaterThanOrEqual(0);
        expect(saved.total).toBe(billFor(C, 625, 625).total);
    });

    test('100% coupon: discount equals the subtotal and a redemption row records exactly that', async () => {
        const cp = await mkCoupon(C, { discountValue: 100 });
        const cust = await createCustomer('oc-100');
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(201);
        const [row] = await CouponRedemption.find({ coupon: cp._id }).lean();
        expect(row.discountAmount).toBe(625);
        expect(row.orderValue).toBe(625);
    });

    test('client-sent couponDiscount is ignored (tamper): server amount wins', async () => {
        const cp = await mkCoupon(C, { discountValue: 10 });
        const cust = await createCustomer('oc-tamper');
        const res = await place(cust, C, { couponCode: cp.code, couponDiscount: 600 });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).couponDiscount).toBe(62.5);
    });

    test('code is matched case-insensitively and with surrounding spaces at create', async () => {
        const cp = await mkCoupon(C);
        const cust = await createCustomer('oc-case');
        const res = await place(cust, C, { couponCode: `  ${cp.code.toLowerCase()} ` });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).couponCode).toBe(cp.code);
    });

    test('stacking: two codes sent as an array are not both applied — no coupon discount, no usage', async () => {
        const [a, b] = [await mkCoupon(C), await mkCoupon(C)];
        const cust = await createCustomer('oc-stack');
        const res = await place(cust, C, { couponCode: [a.code, b.code] });
        expect([201, 400]).toContain(res.status);
        if (res.status === 201) expect((await Order.findById(res.body.order._id).lean()).couponDiscount).toBe(0);
        expect((await Coupon.findById(a._id).lean()).usageCount).toBe(0);
        expect((await Coupon.findById(b._id).lean()).usageCount).toBe(0);
    });

    test('stacking: comma-joined codes "A,B" is treated as one unknown code → 400, no order', async () => {
        const [a, b] = [await mkCoupon(C), await mkCoupon(C)];
        const cust = await createCustomer('oc-stack2');
        const res = await place(cust, C, { couponCode: `${a.code},${b.code}` });
        expect(res.status).toBe(400);
        expect(await Order.countDocuments({ user: cust._id })).toBe(0);
    });

    test('coupon + points stack: points are clamped to what is left after the coupon, bill never below zero', async () => {
        await setWalletSettings(C, { enableLoyalty: true, pointsToRupee: 1, maxRedeemPercent: 100 });
        const cp = await mkCoupon(C, { discountValue: 90 }); // 562.5 off a 625 subtotal
        const cust = await createCustomer('oc-stack3');
        await setWallet(C, cust, { loyaltyPoints: 10000 });
        const res = await place(cust, C, { couponCode: cp.code, pointsRedeemed: 10000 });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponDiscount).toBe(562.5);
        expect(saved.pointsRedeemed).toBe(62); // floor(625 − 562.5) at ₹1/point
        expect(saved.total).toBeGreaterThanOrEqual(0);
        expect((await walletOf(C, cust)).loyaltyPoints).toBe(10000 - 62);
        await setWalletSettings(C, { enableLoyalty: false, pointsToRupee: 0.1, maxRedeemPercent: 50 });
    });

    test('scope=beverages on a mixed cart discounts only the drink', async () => {
        const cp = await mkCoupon(C, { scope: 'beverages', discountValue: 50 });
        const cust = await createCustomer('oc-scope');
        const res = await ctx.api.as(cust, C).post('/orders').send(takeaway({
            items: [{ menuItem: String(C.items.paneer._id), quantity: 1 }, { menuItem: String(drink._id), quantity: 2 }],
            total: billFor0(C, 400), couponCode: cp.code,
        }));
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).couponDiscount).toBe(100);
    });

    test('minOrderValue is evaluated on the full subtotal (not the eligible slice)', async () => {
        const cp = await mkCoupon(C, { scope: 'beverages', discountValue: 10, minOrderValue: 300 });
        const cust = await createCustomer('oc-minfull');
        const res = await ctx.api.as(cust, C).post('/orders').send(takeaway({
            items: [{ menuItem: String(C.items.paneer._id), quantity: 1 }, { menuItem: String(drink._id), quantity: 1 }],
            total: billFor0(C, 300), couponCode: cp.code,
        }));
        // subtotal 300 meets the minimum; only the ₹100 drink is discounted.
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).couponDiscount).toBe(10);
    });

    test('Regression (fixed 2026-11): a coupon pinned to another branch is redeemable on a takeaway placed at this branch via body branchId (scope ignores the body branch)', async () => {
        // Expected: 400 COUPON_INVALID — the order is stamped at branch 1 (body branchId wins in resolvePlacement) but the coupon belongs to branch 2.
        // Actual: resolveCartCoupon is scoped by pricingBranchId = pinned || X-Branch-Id header only (services/orderCreateService.js:510-523),
        // so with no header the lookup is tenant-wide and the branch-restricted coupon applies.
        const b2 = await Branch.create({ restaurant: C.restaurant._id, name: 'Fourth', slug: `f-${rid()}`, isActive: true });
        const cp = await mkCoupon(C, { branch: b2._id });
        const cust = await createCustomer('oc-wrongbranch');
        const res = await place(cust, C, { couponCode: cp.code, branchId: String(C.branch._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('COUPON_INVALID');
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });

    test('bogo / shipping_discount coupons at create: no discount and NO usage consumed', async () => {
        const cust = await createCustomer('oc-bogo');
        const cp = await mkCoupon(C, { discountType: 'bogo' });
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponDiscount).toBe(0);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });
});

describe('coupon at POST /orders: concurrency and atomicity', () => {
    test('usageLimit 3 raced by 6 customers: exactly 3 orders, usageCount 3, 3 redemption rows, losers 409 and rolled back', async () => {
        const cp = await mkCoupon(C, { usageLimit: 3 });
        const custs = await Promise.all(Array.from({ length: 6 }, (_, i) => createCustomer(`oc-rc${i}`)));
        const results = await Promise.all(custs.map((u) => place(u, C, { couponCode: cp.code })));
        expect(results.filter((r) => r.status === 201)).toHaveLength(3);
        expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'COUPON_UNAVAILABLE')).toBe(true);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(3);
        expect(await CouponRedemption.countDocuments({ coupon: cp._id })).toBe(3);
        expect(await Order.countDocuments({ couponCode: cp.code })).toBe(3);
        expect(await Order.countDocuments({ user: { $in: custs.map((c) => c._id) } })).toBe(3);
    });

    test('same customer, usagePerUser 1, 4 concurrent orders: exactly one commits', async () => {
        const cp = await mkCoupon(C, { usagePerUser: 1 });
        const cust = await createCustomer('oc-pu-race');
        const results = await Promise.all([1, 2, 3, 4].map(() => place(cust, C, { couponCode: cp.code })));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(await CouponRedemption.countDocuments({ coupon: cp._id, user: cust._id })).toBe(1);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(1);
        expect(await Order.countDocuments({ user: cust._id })).toBe(1);
    });

    test('usagePerUser 2: third sequential order is refused; usageCount stays 2', async () => {
        const cp = await mkCoupon(C, { usagePerUser: 2 });
        const cust = await createCustomer('oc-pu2');
        expect((await place(cust, C, { couponCode: cp.code })).status).toBe(201);
        expect((await place(cust, C, { couponCode: cp.code })).status).toBe(201);
        const third = await place(cust, C, { couponCode: cp.code });
        expect(third.status).toBe(400);
        expect(third.body.code).toBe('COUPON_USER_LIMIT');
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(2);
    });

    test('a failed order (points conflict) rolls the coupon usage back too: usageCount equals committed orders', async () => {
        await setWalletSettings(C, { enableLoyalty: true, pointsToRupee: 0.1, maxRedeemPercent: 50 });
        const cp = await mkCoupon(C, { usagePerUser: 5, usageLimit: 100 });
        const cust = await createCustomer('oc-atomic');
        await setWallet(C, cust, { loyaltyPoints: 300 });
        const results = await Promise.all([1, 2].map(() => place(cust, C, { couponCode: cp.code, pointsRedeemed: 300 })));
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(1);
        expect(await CouponRedemption.countDocuments({ coupon: cp._id })).toBe(1);
        expect((await walletOf(C, cust)).loyaltyPoints).toBe(0);
        await setWalletSettings(C, { enableLoyalty: false });
    });

    test('expired-in-between: coupon deactivated before create → 400 and no usage', async () => {
        const cp = await mkCoupon(C);
        await Coupon.updateOne({ _id: cp._id }, { $set: { isActive: false } });
        const cust = await createCustomer('oc-deact');
        const res = await place(cust, C, { couponCode: cp.code });
        expect(res.status).toBe(400);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('coupon admin CRUD: validation and permissions', () => {
    const create = (body, user = C.users.admin) => ctx.api.as(user, C).post('/promotions/coupons').send({
        code: `NEW${rid().toUpperCase()}`, title: 'T', discountType: 'percentage', discountValue: 10,
        startDate: new Date().toISOString(), endDate: new Date(Date.now() + DAY).toISOString(), ...body,
    });

    test.each([
        ['discountValue 0', { discountValue: 0 }],
        ['discountValue negative', { discountValue: -5 }],
        ['discountValue "abc"', { discountValue: 'abc' }],
        ['percentage > 100', { discountValue: 100.01 }],
        ['maxDiscountAmount negative', { maxDiscountAmount: -1 }],
        ['usageLimit negative', { usageLimit: -1 }],
        ['usagePerUser negative', { usagePerUser: -1 }],
        ['minOrderValue negative', { minOrderValue: -1 }],
        ['endDate before startDate', { startDate: new Date(Date.now() + 2 * DAY).toISOString(), endDate: new Date(Date.now() + DAY).toISOString() }],
        ['endDate equal startDate', { startDate: '2030-01-01T00:00:00Z', endDate: '2030-01-01T00:00:00Z' }],
        ['bad discountType', { discountType: 'free_money' }],
        ['bad scope', { scope: 'everything' }],
        ['startTime after endTime', { startTime: '15:00', endTime: '12:00' }],
        ['title not text', { title: { a: 1 } }],
    ])('%s → 400', async (_l, body) => {
        const before = await Coupon.countDocuments({ restaurant: C.restaurant._id });
        const res = await create(body);
        expect(res.status).toBe(400);
        expect(await Coupon.countDocuments({ restaurant: C.restaurant._id })).toBe(before);
    });

    test('control: a percentage coupon with a tiny cap is accepted when minOrderValue is 0 (cap sanity only runs with a min order)', async () => {
        // Documents the validator gap: cap of ₹1 on a 50% coupon is accepted (only checked when minOrderValue > 0).
        // Expected: still accepted (cap is a legit business choice) → this test passes if accepted. Kept as a control.
        const res = await create({ discountValue: 50, maxDiscountAmount: 1, minOrderValue: 0 });
        expect(res.status).toBe(201);
    });

    test('numeric-string discountValue "10" is refused by the controller (typeof number) even though the route lets it through', async () => {
        const res = await create({ discountValue: '10' });
        expect(res.status).toBe(400);
    });

    test('create ignores usageCount from the body', async () => {
        const res = await create({ usageCount: 999 });
        expect(res.status).toBe(201);
        expect((await Coupon.findById(res.body.coupon._id).lean()).usageCount).toBe(0);
    });

    test('code with different case is a duplicate (409); same code in another tenant is fine', async () => {
        const code = `DUP${rid().toUpperCase()}`;
        expect((await create({ code })).status).toBe(201);
        expect((await create({ code: code.toLowerCase() })).status).toBe(409);
    });

    test('update cannot reset usageCount / change tenant; a bad merged value (discountValue 0) → 400', async () => {
        const cp = await mkCoupon(C, { usageCount: 4 });
        const up = await ctx.api.as(C.users.admin, C).put(`/promotions/coupons/${cp._id}`).send({ usageCount: 0, restaurant: String(C.branch._id), title: 'renamed' });
        expect(up.status).toBe(200);
        const saved = await Coupon.findById(cp._id).lean();
        expect(saved.usageCount).toBe(4);
        expect(String(saved.restaurant)).toBe(String(C.restaurant._id));
        const bad = await ctx.api.as(C.users.admin, C).put(`/promotions/coupons/${cp._id}`).send({ discountValue: 0 });
        expect(bad.status).toBe(400);
    });

    test('Regression (fixed 2026-11): lowering usageLimit below usageCount on update is accepted silently (coupon becomes unusable but reports odd state)', async () => {
        // Expected: 400 "usageLimit cannot be lower than the times already used". Actual: accepted.
        const cp = await mkCoupon(C, { usageCount: 5, usageLimit: 10 });
        const up = await ctx.api.as(C.users.admin, C).put(`/promotions/coupons/${cp._id}`).send({ usageLimit: 2 });
        expect(up.status).toBe(400);
    });

    test.each(['waiter', 'chef', 'captain'])('%s cannot create / update / delete coupons', async (role) => {
        const cp = await mkCoupon(C);
        const as = ctx.api.as(C.users[role], C);
        expect((await create({}, C.users[role])).status).toBe(403);
        expect((await as.put(`/promotions/coupons/${cp._id}`).send({ title: 'x' })).status).toBe(403);
        expect((await as.delete(`/promotions/coupons/${cp._id}`)).status).toBe(403);
        expect((await Coupon.findById(cp._id).lean()).title).toBe('strict coupon');
    });

    test('a customer cannot create or list admin coupons', async () => {
        const cust = await createCustomer('crud-cust');
        expect((await ctx.api.as(cust, C).post('/promotions/coupons').send({ code: 'X', title: 'x', discountValue: 5, endDate: new Date(Date.now() + DAY) })).status).toBe(403);
        expect((await ctx.api.as(cust, C).get('/promotions/coupons')).status).toBe(403);
    });

    test('public active-coupon list hides usage counters / targetUsers and expired / inactive coupons', async () => {
        const live = await mkCoupon(C, { usageCount: 7, usageLimit: 50 });
        const dead = await mkCoupon(C, { endDate: new Date(Date.now() - 1000), startDate: new Date(Date.now() - DAY) });
        const off = await mkCoupon(C, { isActive: false });
        const cust = await createCustomer('crud-list');
        const res = await ctx.api.as(cust, C).get('/promotions/coupons/active');
        expect(res.status).toBe(200);
        const codes = res.body.coupons.map((c) => c.code);
        expect(codes).toContain(live.code);
        expect(codes).not.toContain(dead.code);
        expect(codes).not.toContain(off.code);
        const row = res.body.coupons.find((c) => c.code === live.code);
        expect(row.usageCount).toBeUndefined();
        expect(row.usageLimit).toBeUndefined();
        expect(row.targetUsers).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('loyalty earn: staff mark-paid vs customer finalize (settings edge cases)', () => {
    async function paidOrder(t, cust, total, fields = {}) {
        return Order.create({
            restaurant: t.restaurant._id, branch: t.branch._id, orderId: `LY-${rid()}`, type: 'takeaway', user: cust._id,
            items: [{ menuItem: t.items.paneer._id, name: 'P', price: total, quantity: 1 }], total, status: 'new', paymentStatus: 'Pending', ...fields,
        });
    }
    const staffMarkPaid = (t, o) => ctx.api.as(t.users.admin).patch(`/orders/${o._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
    const finalize = (t, cust, o) => ctx.api.as(cust, t).patch(`/orders/${o._id}/payment`).set('Idempotency-Key', `k-${rid()}`).send({ paymentStatus: 'Paid' });
    const walletPaid = (t, cust, total) => paidOrder(t, cust, total, { paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: total, paidAt: new Date() });
    const pts = (t, cust) => walletOf(t, cust).then((w) => (w ? w.loyaltyPoints : 0));

    test.each([
        // [label, wallet settings, total, expected points]
        ['default rate 1/₹, floor of 512.4', { enableLoyalty: true }, 512.4, 512],
        ['rate 2 → floor(1024.8)', { enableLoyalty: true, pointsPerRupee: 2 }, 512.4, 1024],
        ['rate 0.5 → floor(256.2)', { enableLoyalty: true, pointsPerRupee: 0.5 }, 512.4, 256],
        ['total exactly at minBill earns', { enableLoyalty: true, minBillToEarn: 200 }, 200, 200],
        ['one paisa under minBill earns nothing', { enableLoyalty: true, minBillToEarn: 200 }, 199.99, 0],
        ['loyalty disabled earns nothing', { enableLoyalty: false }, 500, 0],
        ['pointsPerRupee 0 earns nothing', { enableLoyalty: true, pointsPerRupee: 0 }, 500, 0],
        ['minBillToEarn 0 earns on a ₹50 bill', { enableLoyalty: true, minBillToEarn: 0 }, 50, 50],
    ])('staff mark-paid: %s', async (_l, settings, total, expected) => {
        const t = await seedTenant({ label: 'splc-le' });
        await setWalletSettings(t, settings);
        const cust = await createCustomer('le-staff');
        const o = await paidOrder(t, cust, total);
        expect((await staffMarkPaid(t, o)).status).toBe(200);
        expect(await pts(t, cust)).toBe(expected);
    });

    test('Regression (fixed 2026-11): staff mark-paid writes a zero-point points_earned ledger row when nothing is earned (loyalty off / under minBill / rate 0)', async () => {
        // Expected: no points_earned row when earnedPoints is 0 (the customer-finalize and razorpay paths write none).
        // Actual: services/orderPaymentService.js:~66 saves the row unconditionally → amount 0 clutter in the customer's history.
        const t = await seedTenant({ label: 'splc-le0' });
        await setWalletSettings(t, { enableLoyalty: false });
        const cust = await createCustomer('le-zero');
        const o = await paidOrder(t, cust, 500);
        expect((await staffMarkPaid(t, o)).status).toBe(200);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(0);
    });

    test('staff mark-paid twice (re-patch) never double-awards', async () => {
        const t = await seedTenant({ label: 'splc-le2' });
        await setWalletSettings(t, { enableLoyalty: true });
        const cust = await createCustomer('le-twice');
        const o = await paidOrder(t, cust, 300);
        await staffMarkPaid(t, o);
        await staffMarkPaid(t, o);
        expect(await pts(t, cust)).toBe(300);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(1);
    });

    test('earn base is the paid total, not the pre-discount subtotal: coupon + points redeemed reduce the points earned', async () => {
        const t = await seedTenant({ label: 'splc-le3' });
        await setWalletSettings(t, { enableLoyalty: true, pointsToRupee: 0.1 });
        const cp = await mkCoupon(t, { discountValue: 10 });
        const cust = await createCustomer('le-base');
        await setWallet(t, cust, { loyaltyPoints: 200 });
        const res = await ctx.api.as(cust, t).post('/orders').send(takeaway({ items: cart(t), total: billFor0(t, 625), couponCode: cp.code, pointsRedeemed: 200 }));
        expect(res.status).toBe(201);
        const order = await Order.findById(res.body.order._id).lean();
        expect((await staffMarkPaid(t, order)).status).toBe(200);
        // 200 points left the wallet; earned points are floor(order.total)
        expect(await pts(t, cust)).toBe(Math.floor(order.total));
    });

    test('Regression (fixed 2026-11): customer finalize treats minBillToEarn 0 as 100 (falls back with ||), so a ₹50 wallet-paid bill earns nothing while staff mark-paid earns 50', async () => {
        // Expected: a stored 0 is honoured (resolveLoyaltySettings / numberOr) on both paths.
        // Actual: services/orderPaymentService.js:~500 `settings.wallet.minBillToEarn || 100`.
        const t = await seedTenant({ label: 'splc-le4' });
        await setWalletSettings(t, { enableLoyalty: true, minBillToEarn: 0 });
        const cust = await createCustomer('le-minbug');
        const o = await walletPaid(t, cust, 50);
        expect((await finalize(t, cust, o)).status).toBe(200);
        expect(await pts(t, cust)).toBe(50);
    });

    test('Regression (fixed 2026-11): customer finalize treats pointsPerRupee 0 as 1, so a tenant that turned earning off (rate 0) still awards points on wallet-paid orders', async () => {
        // Expected: 0 points (rate 0). Actual: services/orderPaymentService.js:~501 `pointsPerRupee || 1`.
        const t = await seedTenant({ label: 'splc-le5' });
        await setWalletSettings(t, { enableLoyalty: true, pointsPerRupee: 0, minBillToEarn: 0 });
        const cust = await createCustomer('le-ratebug');
        const o = await walletPaid(t, cust, 500);
        expect((await finalize(t, cust, o)).status).toBe(200);
        expect(await pts(t, cust)).toBe(0);
    });

    test('customer finalize at the default settings awards exactly floor(total) once', async () => {
        const t = await seedTenant({ label: 'splc-le6' });
        await setWalletSettings(t, { enableLoyalty: true });
        const cust = await createCustomer('le-fin');
        const o = await walletPaid(t, cust, 333.99);
        await finalize(t, cust, o);
        await finalize(t, cust, o);
        expect(await pts(t, cust)).toBe(333);
    });

    test('guest order (no user) earns nothing and does not create a wallet', async () => {
        const t = await seedTenant({ label: 'splc-le7' });
        await setWalletSettings(t, { enableLoyalty: true });
        const o = await Order.create({
            restaurant: t.restaurant._id, branch: t.branch._id, orderId: `LY-${rid()}`, type: 'takeaway',
            items: [{ menuItem: t.items.paneer._id, name: 'P', price: 300, quantity: 1 }], total: 300, status: 'new', paymentStatus: 'Pending',
        });
        await staffMarkPaid(t, o);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(0);
    });
});

describe('loyalty redeem at POST /orders: caps and math', () => {
    test('default 50% cap: 1000 points at ₹0.1 (₹100) on a ₹625 subtotal is allowed; value never exceeds 50% of the subtotal', async () => {
        const t = await seedTenant({ label: 'splc-lr1' });
        const cust = await createCustomer('lr-cap');
        await setWallet(t, cust, { loyaltyPoints: 100000 });
        const res = await place(cust, t, { pointsRedeemed: 100000 });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.pointsRedeemed).toBe(3125); // 312.5 rupees / 0.1
        expect(r2(saved.pointsRedeemed * 0.1)).toBeLessThanOrEqual(312.5);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(100000 - 3125);
    });

    test('maxRedeemPercent 0 → no points can be redeemed and none are debited', async () => {
        const t = await seedTenant({ label: 'splc-lr2' });
        await setWalletSettings(t, { maxRedeemPercent: 0 });
        const cust = await createCustomer('lr-zero');
        await setWallet(t, cust, { loyaltyPoints: 500 });
        const res = await place(cust, t, { pointsRedeemed: 500 });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).pointsRedeemed).toBe(0);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(500);
        expect(await Transaction.countDocuments({ user: cust._id, type: 'points_redeemed' })).toBe(0);
    });

    test('fractional request (10.7) is floored to whole points', async () => {
        const t = await seedTenant({ label: 'splc-lr3' });
        const cust = await createCustomer('lr-frac');
        await setWallet(t, cust, { loyaltyPoints: 100 });
        const res = await place(cust, t, { pointsRedeemed: 10.7 });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).pointsRedeemed).toBe(10);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(90);
    });

    test.each([['negative', -50], ['NaN string', 'NaN'], ['text', 'lots'], ['zero', 0], ['null', null]])(
        'pointsRedeemed %s redeems nothing and does not fail the order', async (_l, p) => {
            const t = await seedTenant({ label: 'splc-lr4' });
            const cust = await createCustomer('lr-neg');
            await setWallet(t, cust, { loyaltyPoints: 100 });
            const res = await place(cust, t, { pointsRedeemed: p });
            expect([201, 400]).toContain(res.status);
            expect((await walletOf(t, cust)).loyaltyPoints).toBe(100);
        });

    test('points redeemed twice across two orders: the second is clamped to the remaining balance, wallet never negative', async () => {
        const t = await seedTenant({ label: 'splc-lr5' });
        const cust = await createCustomer('lr-twice');
        await setWallet(t, cust, { loyaltyPoints: 300 });
        const r1 = await place(cust, t, { pointsRedeemed: 200 });
        const r2_ = await place(cust, t, { pointsRedeemed: 200 });
        expect(r1.status).toBe(201);
        expect(r2_.status).toBe(201);
        expect((await Order.findById(r1.body.order._id).lean()).pointsRedeemed).toBe(200);
        expect((await Order.findById(r2_.body.order._id).lean()).pointsRedeemed).toBe(100);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(0);
        const rows = await Transaction.find({ user: cust._id, type: 'points_redeemed' }).sort({ createdAt: 1 }).lean();
        expect(rows.map((r) => r.amount)).toEqual([-200, -100]);
        expect(rows.map((r) => r.balanceAfter)).toEqual([100, 0]);
    });

    test('a guest cannot redeem points (POINTS_REQUIRES_LOGIN) and a customer with no wallet redeems nothing', async () => {
        const t = await seedTenant({ label: 'splc-lr6' });
        const g = await ctx.api.guest(t).post('/orders').send(takeaway({ items: cart(t), total: billFor0(t, 625), pointsRedeemed: 50 }));
        expect(g.status).toBe(400);
        expect(g.body.code).toBe('POINTS_REQUIRES_LOGIN');
        const cust = await createCustomer('lr-nowallet');
        const res = await place(cust, t, { pointsRedeemed: 50 });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).pointsRedeemed).toBe(0);
    });

    test("points held at another tenant cannot be spent here", async () => {
        const t1 = await seedTenant({ label: 'splc-lr7a' });
        const t2 = await seedTenant({ label: 'splc-lr7b' });
        const cust = await createCustomer('lr-xt');
        await setWallet(t2, cust, { loyaltyPoints: 1000 });
        const res = await place(cust, t1, { pointsRedeemed: 500 });
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).pointsRedeemed).toBe(0);
        expect((await walletOf(t2, cust)).loyaltyPoints).toBe(1000);
    });

    test('Regression (fixed 2026-11): pointsToRupee = 0 lets the order debit the customer\'s points for a ₹0 discount', async () => {
        // Expected: with a zero rate nothing can be redeemed — no points debited (or 400).
        // Actual: authoritativePointsValue = 0 never exceeds the cap, so the requested points are still debited
        // (services/orderPricingService.js resolvePointsRedemption: the rate>0 guard only runs inside the cap branch).
        const t = await seedTenant({ label: 'splc-lr8' });
        await setWalletSettings(t, { pointsToRupee: 0 });
        const cust = await createCustomer('lr-rate0');
        await setWallet(t, cust, { loyaltyPoints: 500 });
        const res = await place(cust, t, { pointsRedeemed: 500 });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.pointsRedeemed === 0 || saved.total < billFor(t, 625).total).toBe(true);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(500);
    });

    test('BUG: cancelling an order does not give back the loyalty points it redeemed', async () => {
        // Expected: points (and ideally coupon usage) restored when the customer cancels before any work started.
        // Actual: no points_redeemed reversal anywhere in the cancel path (grep pointsRedeemed: only read-only uses).
        const t = await seedTenant({ label: 'splc-lr9' });
        const cust = await createCustomer('lr-cancel');
        await setWallet(t, cust, { loyaltyPoints: 400 });
        const res = await place(cust, t, { pointsRedeemed: 400 });
        expect(res.status).toBe(201);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(0);
        const cancel = await ctx.api.as(cust, t).patch(`/orders/${res.body.order._id}/cancel`).send({ reason: 'changed my mind' });
        expect(cancel.status).toBe(200);
        await settle(200);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(400);
    });

    test('ledger of redeem + earn is consistent: balanceBefore/After chain across two orders', async () => {
        const t = await seedTenant({ label: 'splc-lr10' });
        await setWalletSettings(t, { enableLoyalty: true });
        const cust = await createCustomer('lr-chain');
        await setWallet(t, cust, { loyaltyPoints: 100 });
        const res = await place(cust, t, { pointsRedeemed: 100 });
        const order = await Order.findById(res.body.order._id).lean();
        await ctx.api.as(t.users.admin).patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        const rows = await Transaction.find({ user: cust._id, type: { $in: ['points_redeemed', 'points_earned'] } }).sort({ createdAt: 1, _id: 1 }).lean();
        expect(rows.map((r) => r.type)).toEqual(['points_redeemed', 'points_earned']);
        expect(rows[0]).toMatchObject({ balanceBefore: 100, balanceAfter: 0, amount: -100 });
        expect(rows[1].balanceBefore).toBe(0);
        expect(rows[1].balanceAfter).toBe(rows[1].amount);
        expect((await walletOf(t, cust)).loyaltyPoints).toBe(rows[1].amount);
    });
});
