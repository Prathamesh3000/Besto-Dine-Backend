/**
 * createOrder (services/orderCreateService.js + the pricing phases in
 * services/orderPricingService.js) through the real HTTP stack — the
 * parts orderFlow.test.js does not already cover:
 *
 *   coupons      usageCount + CouponRedemption written atomically with
 *                the order, the last use raced by two customers, an
 *                exhausted coupon, per-user limit, guest coupon drop
 *   points       wallet debit + ledger row exactly once, clamping,
 *                concurrent double-spend
 *   stacking     coupon + points + tip + delivery fee, exact to the paisa
 *   wallet split walletAmountPaid recorded / validated
 *   delivery     fee from Settings slabs, no service charge, refusals
 *   channels     kiosk "Eat Here", kiosk claims, staff POS takeaway,
 *                dine-in role gate for customers / chefs
 *   menu         out of stock, unknown, archived, outside availability
 *                window, quantity bounds, request-shape validation
 *   branch       table branch wins, takeaway branchId validated, pinned
 *                staff, branch-specific prices
 *   split        mixed kitchen + counter cart → two docs summing to the bill
 *   ids          order number uniqueness, idempotency key per tenant
 *
 * Every money assertion is exact to the paisa (toBe, never toBeCloseTo).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle, V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const CouponRedemption = require(path.join(BACKEND, 'models/couponRedemption'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const { invalidateCache } = require(path.join(BACKEND, 'utils/settingsCache'));
const { currentDayShort } = require(path.join(BACKEND, 'utils/menuAvailability'));

const ctx = useIntegrationApp();
let A; // GST 5 %, service charge 10 %, flat ₹20 packaging (helpers/seed DEFAULT_TAXES)
let B; // second tenant (idempotency / foreign ids)
let D; // tenant with home delivery enabled
let water; // counter item on A (₹30)

beforeAll(async () => {
    A = await seedTenant({ label: 'oci' });
    B = await seedTenant({ label: 'ocib' });
    D = await seedTenant({ label: 'ocid' });
    await Settings.updateOne({ restaurant: D.restaurant._id, branch: null }, {
        $set: {
            delivery: { enabled: true, minOrderValue: 300, slabs: [{ fromKm: 0, toKm: 5, charge: 40 }, { fromKm: 5, toKm: 10, charge: 75 }] },
        },
    });
    invalidateCache();
    water = await MenuItem.create({
        restaurant: A.restaurant._id, category: A.category._id, name: 'Mineral Water',
        description: 'bottled', basePrice: 30, prepStation: 'counter', vegType: 'veg',
    });
});

// 2 × Paneer Tikka (200) + 1 × Veg Thali "Full" (250 − 10 % = 225) = 625
const cart = (t) => [
    { menuItem: String(t.items.paneer._id), quantity: 2 },
    { menuItem: String(t.items.thali._id), quantity: 1, selectedSizes: [{ name: 'Full' }] },
];
const bill = (t, subtotal, orderType = 'dine-in') =>
    computeBill({ subtotal, taxConfig: toTaxConfig(t.settings.taxes), orderType });
const r2 = (n) => Math.round(n * 100) / 100;

const takeaway = (extra = {}) => ({ type: 'takeaway', pickupLocation: 'Counter', ...extra });

async function makeCoupon(t, fields = {}) {
    return Coupon.create({
        restaurant: t.restaurant._id,
        code: `CP${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        title: 'Integration coupon',
        discountType: 'percentage',
        discountValue: 10,
        endDate: new Date(Date.now() + 86400000),
        ...fields,
    });
}

describe('coupons at create', () => {
    // 625 takeaway, 10 % off 625 = 62.50. GST is on the post-coupon value:
    // 5 % of (625 − 62.50) = 28.125 → 28.13; 625 + 28.13 + 20 packaging − 62.50 = 610.63
    test('logged-in customer: discount stamped, usageCount +1 and one CouponRedemption row', async () => {
        const coupon = await makeCoupon(A);
        const cust = await createCustomer('oc-cp1');
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code.toLowerCase(), couponDiscount: 600, total: 610.63 }));
        expect(res.status).toBe(201);

        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponCode).toBe(coupon.code);
        expect(saved.couponDiscount).toBe(62.5);          // client's 600 ignored
        expect(saved.gst).toBe(28.13);                    // 5 % of 562.50
        expect(saved.total).toBe(610.63);                 // 625 + 28.13 + 20 − 62.50
        expect(saved.total).toBe(computeBill({
            subtotal: 625, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway', couponDiscount: 62.5,
        }).total);
        expect(String(saved.user)).toBe(String(cust._id));

        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(1);
        const rows = await CouponRedemption.find({ coupon: coupon._id }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ orderValue: 625, discountAmount: 62.5, discountType: 'percentage', discountValue: 10 });
        expect(String(rows[0].user)).toBe(String(cust._id));
        expect(String(rows[0].order)).toBe(String(saved._id));
        expect(String(rows[0].restaurant)).toBe(String(A.restaurant._id));
    });

    test('a guest cannot redeem a coupon: code silently dropped, full bill charged, usage untouched', async () => {
        const coupon = await makeCoupon(A);
        const res = await ctx.api.guest(A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 676.25 }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponCode).toBe('');
        expect(saved.couponDiscount).toBe(0);
        expect(saved.total).toBe(676.25);
        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(0);
        expect(await CouponRedemption.countDocuments({ coupon: coupon._id })).toBe(0);
    });

    test('two customers racing for the LAST use: exactly one order commits, the other is 409 and rolled back', async () => {
        const coupon = await makeCoupon(A, { usageLimit: 1 });
        const [c1, c2] = [await createCustomer('oc-race1'), await createCustomer('oc-race2')];
        const send = (c) => ctx.api.as(c, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 613.75 }));
        const results = await Promise.all([send(c1), send(c2)]);

        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const loser = results.find((r) => r.status === 409);
        expect(loser.body.code).toBe('COUPON_UNAVAILABLE');

        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(1);
        expect(await CouponRedemption.countDocuments({ coupon: coupon._id })).toBe(1);
        // The loser's order (and nothing else) was rolled back.
        expect(await Order.countDocuments({ couponCode: coupon.code })).toBe(1);
        expect(await Order.countDocuments({ user: { $in: [c1._id, c2._id] } })).toBe(1);
    });

    test('a coupon already at its usage limit → 409 COUPON_UNAVAILABLE, no order', async () => {
        const coupon = await makeCoupon(A, { usageLimit: 3, usageCount: 3 });
        const cust = await createCustomer('oc-limit');
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 613.75 }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('COUPON_UNAVAILABLE');
        expect(await Order.countDocuments({ user: cust._id })).toBe(0);
        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(3);
    });

    test('usageLimit 0 means unlimited', async () => {
        const coupon = await makeCoupon(A, { usageLimit: 0, usageCount: 50 });
        const cust = await createCustomer('oc-unl');
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 613.75 }));
        expect(res.status).toBe(201);
        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(51);
    });

    test.each([
        ['unknown code', () => ({ code: 'NOSUCHCODE' }), 'COUPON_INVALID'],
        ['inactive coupon', async () => makeCoupon(A, { isActive: false }), 'COUPON_INVALID'],
        ['expired coupon', async () => makeCoupon(A, { startDate: new Date(Date.now() - 3 * 86400000), endDate: new Date(Date.now() - 86400000) }), 'COUPON_EXPIRED'],
        ['not yet started', async () => makeCoupon(A, { startDate: new Date(Date.now() + 86400000), endDate: new Date(Date.now() + 2 * 86400000) }), 'COUPON_NOT_STARTED'],
        ['below minOrderValue', async () => makeCoupon(A, { minOrderValue: 1000 }), 'COUPON_MIN_ORDER'],
        ['beverage-only coupon on a food cart', async () => makeCoupon(A, { scope: 'beverages' }), 'COUPON_SCOPE_NO_MATCH'],
        ["another tenant's coupon code", async () => makeCoupon(B), 'COUPON_INVALID'],
    ])('%s → 400 %s, no order and no usage', async (_label, mk, code) => {
        const coupon = await mk();
        const cust = await createCustomer('oc-bad');
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 676.25 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect(await Order.countDocuments({ user: cust._id })).toBe(0);
        if (coupon._id) expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(0);
    });

    // Regression (fixed 2026-10): resolveCartCoupon counts CouponRedemption rows
    // (usagePerUser) and persistOrderDocs re-checks it in the transaction.
    test('usagePerUser is not enforced at create — the same customer redeems a 1-per-user coupon twice', async () => {
        const coupon = await makeCoupon(A, { usagePerUser: 1 });
        const cust = await createCustomer('oc-peruser');
        const send = () => ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), couponCode: coupon.code, total: 613.75 }));
        expect((await send()).status).toBe(201);
        const second = await send();
        // Expected: the second redemption is refused (400/409).
        expect(second.status).toBeGreaterThanOrEqual(400);
        expect(await CouponRedemption.countDocuments({ coupon: coupon._id, user: cust._id })).toBe(1);
    });
});

describe('loyalty points at create', () => {
    // Default pointsToRupee = 0.1 (10 points = ₹1).
    test('points are debited from the wallet exactly once with one ledger row; bill reduced by their value', async () => {
        const cust = await createCustomer('oc-pts');
        await setWallet(A, cust, { loyaltyPoints: 500 });
        // 676.25 − 200 pts × 0.1 = 656.25
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), pointsRedeemed: 200, total: 656.25 }));
        expect(res.status).toBe(201);

        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.pointsRedeemed).toBe(200);
        expect(saved.total).toBe(656.25);

        const wallet = await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean();
        expect(wallet.loyaltyPoints).toBe(300);
        const ledger = await Transaction.find({ user: cust._id, type: 'points_redeemed' }).lean();
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ amount: -200, balanceBefore: 500, balanceAfter: 300, paymentMethod: 'points' });
        expect(String(ledger[0].order)).toBe(String(saved._id));
        expect(String(ledger[0].restaurant)).toBe(String(A.restaurant._id));
    });

    test('requesting more points than held is clamped to the balance', async () => {
        const cust = await createCustomer('oc-ptsclamp');
        await setWallet(A, cust, { loyaltyPoints: 50 });
        // 50 pts = ₹5 → 671.25
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), pointsRedeemed: 100000, total: 671.25 }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.pointsRedeemed).toBe(50);
        expect(saved.total).toBe(671.25);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).loyaltyPoints).toBe(0);
    });

    test('a guest asking to redeem points → 400 POINTS_REQUIRES_LOGIN', async () => {
        const res = await ctx.api.guest(A).post('/orders')
            .send(takeaway({ items: cart(A), pointsRedeemed: 10, total: 676.25 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('POINTS_REQUIRES_LOGIN');
    });

    test('two concurrent orders spending the same points: one commits, the other 409 POINTS_UNAVAILABLE; wallet never negative', async () => {
        const cust = await createCustomer('oc-ptsrace');
        await setWallet(A, cust, { loyaltyPoints: 300 });
        // 300 pts = ₹30 → 646.25
        const send = () => ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), pointsRedeemed: 300, total: 646.25 }));
        const results = await Promise.all([send(), send()]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409).body.code).toBe('POINTS_UNAVAILABLE');
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).loyaltyPoints).toBe(0);
        expect(await Transaction.countDocuments({ user: cust._id, type: 'points_redeemed' })).toBe(1);
        expect(await Order.countDocuments({ user: cust._id })).toBe(1);
    });
});

describe('stacked discounts + delivery (tenant D, delivery enabled)', () => {
    // Delivery bill on 625, coupon 10 % (62.50). GST is on the post-coupon
    // value (points are a payment method and do not reduce it):
    //   5 % of (625 − 62.50) = 28.13; 625 + 28.13 + 0 service + 20 packaging = 673.13
    //   − coupon 62.50 − 150 pts (₹15) + tip 25 + delivery slab 5–10 km (75)
    //   = 695.63
    test('coupon + points + tip + delivery fee: total, breakdown, wallet and coupon all exact', async () => {
        const coupon = await makeCoupon(D);
        const cust = await createCustomer('oc-stack');
        await setWallet(D, cust, { loyaltyPoints: 150 });
        const res = await ctx.api.as(cust, D).post('/orders').send({
            type: 'takeaway',
            items: cart(D),
            couponCode: coupon.code,
            pointsRedeemed: 150,
            tipAmount: 25,
            delivery: { requested: true, address: '12 MG Road, Pune', slab: { fromKm: 5, toKm: 10, charge: 0 } },
            total: 695.63,
        });
        expect(res.status).toBe(201);

        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved).toMatchObject({
            gst: 28.13, serviceCharge: 0, serviceChargePercentage: 0, additionalChargesTotal: 20,
            couponDiscount: 62.5, pointsRedeemed: 150, tipAmount: 25, total: 695.63,
        });
        expect(saved.delivery).toMatchObject({ requested: true, fee: 75, status: 'pending', address: '12 MG Road, Pune' });
        expect(saved.delivery.slab).toMatchObject({ fromKm: 5, toKm: 10, charge: 75 });
        const expected = computeBill({
            subtotal: 625, taxConfig: toTaxConfig(D.settings.taxes), orderType: 'delivery',
            couponDiscount: 62.5, pointsRedeemed: 15, tipAmount: 25, deliveryFee: 75,
        });
        expect(saved.total).toBe(expected.total);

        expect((await Wallet.findOne({ user: cust._id, restaurant: D.restaurant._id }).lean()).loyaltyPoints).toBe(0);
        expect((await Coupon.findById(coupon._id).lean()).usageCount).toBe(1);
    });

    test('a client total that leaves out the delivery fee is rejected (TOTAL_MISMATCH)', async () => {
        const res = await ctx.api.guest(D).post('/orders').send({
            type: 'takeaway', items: cart(D),
            delivery: { requested: true, address: '1 Lane', slab: { fromKm: 0, toKm: 5 } },
            total: 676.25,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOTAL_MISMATCH');
        expect(res.body.expectedTotal).toBe(716.25);
    });

    test.each([
        ['dine-in delivery', 'D', { type: 'dine-in', delivery: { requested: true, address: 'x' } }, 'DELIVERY_TAKEAWAY_ONLY'],
        ['no address', 'D', { type: 'takeaway', delivery: { requested: true, address: '  ' } }, 'DELIVERY_ADDRESS_REQUIRED'],
        ['tenant without delivery', 'A', { type: 'takeaway', delivery: { requested: true, address: '1 Lane', slab: { fromKm: 0, toKm: 5 } } }, 'DELIVERY_DISABLED'],
        ['unknown slab', 'D', { type: 'takeaway', delivery: { requested: true, address: '1 Lane', slab: { fromKm: 0, toKm: 50 } } }, 'DELIVERY_SLAB_INVALID'],
    ])('%s → 400 %s', async (_l, tenant, body, code) => {
        const t = tenant === 'D' ? D : A;
        const res = await ctx.api.guest(t).post('/orders').send({ items: cart(t), total: 900, ...body });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
    });

    test('below the delivery minimum order (₹300) → 400 DELIVERY_MIN_ORDER', async () => {
        const res = await ctx.api.guest(D).post('/orders').send({
            type: 'takeaway',
            items: [{ menuItem: String(D.items.paneer._id), quantity: 1 }],
            delivery: { requested: true, address: '1 Lane', slab: { fromKm: 0, toKm: 5 } },
            total: 500,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DELIVERY_MIN_ORDER');
    });
});

describe('wallet split (walletAmountPaid)', () => {
    test('the wallet portion is recorded on the order; the balance is only checked, not debited, at create', async () => {
        const cust = await createCustomer('oc-wal');
        await setWallet(A, cust, { balance: 500 });
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), walletAmountPaid: 300.555, total: 676.25 }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.walletAmountPaid).toBe(300.56);
        expect(saved.total).toBe(676.25);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).balance).toBe(500);
    });

    test.each([
        ['guest', null, 'WALLET_REQUIRES_LOGIN'],
        ['balance too low', 100, 'WALLET_INSUFFICIENT'],
    ])('%s → 400 %s', async (_l, balance, code) => {
        let api = ctx.api.guest(A);
        if (balance !== null) {
            const cust = await createCustomer('oc-wal-low');
            await setWallet(A, cust, { balance });
            api = ctx.api.as(cust, A);
        }
        const res = await api.post('/orders').send(takeaway({ items: cart(A), walletAmountPaid: 200, total: 676.25 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
    });

    // Regression (fixed 2026-10): createOrder refuses walletAmountPaid above the
    // order total (400 WALLET_EXCEEDS_TOTAL; clamped within the ₹1 window).
    test('walletAmountPaid larger than the order total is accepted and stored', async () => {
        const cust = await createCustomer('oc-wal-over');
        await setWallet(A, cust, { balance: 5000 });
        const res = await ctx.api.as(cust, A).post('/orders')
            .send(takeaway({ items: cart(A), walletAmountPaid: 5000, total: 676.25 }));
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            // Expected: wallet part never exceeds the bill.
            expect(saved.walletAmountPaid).toBeLessThanOrEqual(saved.total);
        } else {
            expect(res.status).toBe(400);
        }
    });
});

describe('order channels', () => {
    test('kiosk "Eat Here" (dine-in, no table): KSK id, main-branch fallback, tracking token, dine-in service charge', async () => {
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'dine-in', source: 'kiosk', items: cart(A), total: 738.75,
        });
        expect(res.status).toBe(201);
        expect(res.body.trackingToken).toEqual(expect.any(String));
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.orderId).toMatch(/^KSK-/);
        expect(saved.source).toBe('kiosk');
        expect(saved.table).toBeFalsy();
        expect(String(saved.branch)).toBe(String(A.branch._id));
        expect(saved.serviceCharge).toBe(62.5);
        expect(saved.total).toBe(738.75);
    });

    test('a kiosk order naming a table is refused (KIOSK_NO_TABLE)', async () => {
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'dine-in', source: 'kiosk', tableId: String(A.tables.main._id), items: cart(A), total: 738.75,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('KIOSK_NO_TABLE');
    });

    test.each([
        ['customer claims kiosk', 'kiosk', 'web-customer'],
        ['customer claims pos', 'pos', 'web-customer'],
        ['customer claims an unknown channel', 'hacker', 'web-customer'],
    ])('%s → source falls back to %s', async (_l, source, expected) => {
        const cust = await createCustomer('oc-src');
        const res = await ctx.api.as(cust, A).post('/orders').send(takeaway({ source, items: cart(A), total: 676.25 }));
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).source).toBe(expected);
    });

    test('staff POS takeaway: source pos, waiter of record, body userId ignored, staff discount below the bill kept', async () => {
        const cust = await createCustomer('oc-pos');
        // serverMinTotal = 625 (subtotal); exact bill 676.25. Staff tools
        // apply ad-hoc discounts client-side, so 650 is kept as sent.
        const res = await ctx.api.as(A.users.waiter).post('/orders').send(takeaway({
            source: 'pos', items: cart(A), total: 650, userId: String(cust._id), waiterId: String(A.users.captain._id),
            customerName: 'Walk In', phone: '+91 98765-43210',
        }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.source).toBe('pos');
        expect(saved.user).toBeNull();
        expect(String(saved.waiter)).toBe(String(A.users.waiter._id));
        expect(saved.total).toBe(650);
        expect(saved.gst).toBe(31.25);
        expect(saved.serviceCharge).toBe(0);
        expect(saved.phone).toBe('+919876543210');
        expect(saved.customerName).toBe('Walk In');
        expect(String(saved.branch)).toBe(String(A.branch._id));
    });

    test('staff POS: a stale total above the takeaway bill is clamped down to the bill', async () => {
        const res = await ctx.api.as(A.users.waiter).post('/orders').send(takeaway({ items: cart(A), total: 738.75 }));
        expect(res.status).toBe(201);
        expect((await Order.findById(res.body.order._id).lean()).total).toBe(676.25);
    });

    test('staff POS: a total below the item subtotal is still TOTAL_TAMPERED', async () => {
        const res = await ctx.api.as(A.users.waiter).post('/orders').send(takeaway({ items: cart(A), total: 600 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOTAL_TAMPERED');
    });

    test.each([
        ['logged-in customer without a scan token', (t) => ctx.api.as(t.cust, A), 401, 'SCAN_TOKEN_REQUIRED'],
        ['chef', () => ctx.api.as(A.users.chef), 403, 'ROLE_NOT_ALLOWED'],
    ])('dine-in by %s is refused (%i %s)', async (_l, mk, status, code) => {
        const table = await createTable(A, { name: `Gate-${code}` });
        const cust = await createCustomer('oc-gate');
        const res = await mk({ cust }).post('/orders').send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: 738.75 });
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(await Order.countDocuments({ table: table._id })).toBe(0);
    });

    test('logged-in customer with a scan token: order linked to the account and the scan session', async () => {
        const table = await createTable(A, { name: 'Cust-DI' });
        const cust = await createCustomer('oc-di');
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        const res = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: 738.75 });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(String(saved.user)).toBe(String(cust._id));
        expect(saved.scanSessionId).toBe(sessionId);
        expect(saved.source).toBe('web-customer');
        expect(saved.customerName).toBe(cust.name);
        expect(saved.total).toBe(738.75);
    });
});

describe('menu item validity', () => {
    const order = (items, total) => ctx.api.guest(A).post('/orders').send(takeaway({ items, total }));

    test('an out-of-stock item refuses the whole order and names the item', async () => {
        const item = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Sold Out Biryani',
            description: 'x', basePrice: 300, inStock: false,
        });
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });
        const res = await order([...cart(A), { menuItem: String(item._id), quantity: 1 }], 1000);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('Sold Out Biryani');
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test.each([
        ['a random ObjectId', () => '64b000000000000000000001'],
        ['a non-ObjectId string', () => 'paneer-tikka'],
        ['a missing menuItem', () => undefined],
        ["tenant B's menu item", () => String(B.items.paneer._id)],
    ])('%s → 400 ITEM_NOT_FOUND', async (_l, id) => {
        const res = await order([{ menuItem: id(), name: 'Ghost', price: 1, quantity: 1 }], 100);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ITEM_NOT_FOUND');
    });

    // Regression (fixed 2026-10): loadCartMenu refuses non-active (archived /
    // draft) menu items (400 ITEM_UNAVAILABLE); append does the same.
    test('an archived menu item is accepted at create', async () => {
        const item = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Retired Kebab',
            description: 'x', basePrice: 100, status: 'archived',
        });
        const res = await order([{ menuItem: String(item._id), quantity: 1 }], 135);
        // Expected: refused like an unknown / out-of-stock item.
        expect(res.status).toBe(400);
    });

    // Regression (fixed 2026-10): loadCartMenu refuses items outside their
    // availableDays / startTime–endTime schedule (400 ITEM_UNAVAILABLE).
    test('an item outside its availability window (not available today) is accepted at create', async () => {
        const allDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const today = currentDayShort(new Date());
        const item = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Weekend Brunch',
            description: 'x', basePrice: 100, availableDays: allDays.filter((d) => d !== today),
        });
        // Sanity: the public menu hides it right now.
        const menu = await ctx.api.guest(A).get('/menu?limit=200');
        expect(JSON.stringify(menu.body)).not.toContain('Weekend Brunch');

        const res = await order([{ menuItem: String(item._id), quantity: 1 }], 135);
        // Expected: refused (item not available now).
        expect(res.status).toBe(400);
    });

    test.each([
        // [sent quantity, stored quantity]
        [0, 1],
        [-3, 1],
        [2.7, 2],
        ['3', 3],
        [999, 999],
    ])('quantity %p is normalised to %p and billed on that', async (sent, stored) => {
        const sub = 40 * stored; // Garlic Naan ₹40
        const total = bill(A, sub, 'takeaway').total;
        const res = await order([{ menuItem: String(A.items.naan._id), quantity: sent }], total);
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.items[0].quantity).toBe(stored);
        expect(saved.total).toBe(total);
    });

    test('quantity above 999 → 400 QUANTITY_EXCEEDED', async () => {
        const res = await order([{ menuItem: String(A.items.naan._id), quantity: 1000 }], 50000);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('QUANTITY_EXCEEDED');
    });

    test.each([
        ['empty cart', { items: [] }],
        ['items not an array', { items: { 0: 'x' } }],
        ['missing total', { total: undefined }],
        ['zero total', { total: 0 }],
        ['string total', { total: '676.25' }],
        ['bad order type', { type: 'delivery' }],
        ['takeaway without pickup location', { pickupLocation: undefined }],
        ['takeaway with a table', { tableId: '64b000000000000000000002' }],
    ])('%s → 400', async (_l, patch) => {
        const body = { ...takeaway({ items: cart(A), total: 676.25 }), ...patch };
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });
        const res = await ctx.api.guest(A).post('/orders').send(body);
        expect(res.status).toBe(400);
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('dine-in without a table → 400 TABLE_REQUIRED (staff caller)', async () => {
        const res = await ctx.api.as(A.users.waiter).post('/orders').send({ type: 'dine-in', items: cart(A), total: 738.75 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TABLE_REQUIRED');
    });
});

describe('branch resolution', () => {
    let second; let inactive; let secondTable; let pinnedSecondWaiter;

    beforeAll(async () => {
        second = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        inactive = await Branch.create({ restaurant: A.restaurant._id, name: 'Closed', slug: 'closed', isActive: false });
        const area = await Area.create({ restaurant: A.restaurant._id, branch: second._id, name: 'Second Hall' });
        secondTable = await createTable(A, { name: 'Second-1', branch: second._id, area: area._id });
        pinnedSecondWaiter = A.users.waiter; // pinned to main
    });

    test("dine-in: the table's branch wins over the guest's X-Branch-Id header", async () => {
        const table = await createTable(A, { name: 'BrMain-1' }); // main branch
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.raw.post(`${V1}/orders`)
            .set('X-Restaurant-Slug', A.slug).set('X-Scan-Token', scanToken).set('X-Branch-Id', String(second._id))
            .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: 738.75 });
        expect(res.status).toBe(201);
        expect(String((await Order.findById(res.body.order._id).lean()).branch)).toBe(String(A.branch._id));
    });

    test.each([
        ['an active branch of the tenant', () => second._id, () => String(second._id)],
        ['an inactive branch', () => inactive._id, () => null],
        ["another tenant's branch", () => B.branch._id, () => null],
        ['a malformed id', () => 'not-an-id', () => null],
    ])('takeaway branchId = %s', async (_l, id, expected) => {
        const res = await ctx.api.as(A.users.admin).post('/orders')
            .send(takeaway({ branchId: String(id()), items: cart(A), total: 676.25 }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.branch ? String(saved.branch) : null).toBe(expected());
    });

    test('a branch-pinned waiter cannot route a takeaway to another branch (403 BRANCH_SCOPE_VIOLATION)', async () => {
        const res = await ctx.api.as(pinnedSecondWaiter).post('/orders')
            .send(takeaway({ branchId: String(second._id), items: cart(A), total: 676.25 }));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_SCOPE_VIOLATION');
    });

    test('a branch-pinned waiter cannot place a dine-in order on another branch\'s table', async () => {
        const res = await ctx.api.as(A.users.waiter).post('/orders')
            .send({ type: 'dine-in', tableId: String(secondTable._id), items: cart(A), total: 738.75 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_SCOPE_VIOLATION');
        expect(await Order.countDocuments({ table: secondTable._id })).toBe(0);
    });

    // Regression (fixed 2026-10): dine-in carts are priced at the table's branch
    // (resolvePricingBranch), not the client's X-Branch-Id header.
    test("dine-in at a branch with branch-specific prices is billed at the default price when X-Branch-Id is omitted", async () => {
        const item = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Premium Curry',
            description: 'x', basePrice: 200, branchPrices: [{ branch: second._id, basePrice: 300 }],
        });
        const { scanToken } = await scanTable(ctx.api, secondTable);
        const premiumBill = bill(A, 300); // 300 + 15 + 30 + 20 = 365
        const res = await ctx.api.guest(A, scanToken).post('/orders')
            .send({ type: 'dine-in', tableId: String(secondTable._id), items: [{ menuItem: String(item._id), quantity: 1 }], total: premiumBill.total });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(String(saved.branch)).toBe(String(second._id));
        // Expected: the branch's ₹300 price.
        expect(saved.items[0].price).toBe(300);
        expect(saved.total).toBe(365);
    });
});

describe('mixed kitchen + counter cart', () => {
    test('dine-in mixed cart splits into a ready counter doc and a kitchen doc; together they equal the bill', async () => {
        const table = await createTable(A, { name: 'Split-1' });
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        // 2 × Paneer 200 (kitchen) + 3 × Water 30 (counter) = 490
        const full = bill(A, 490); // 490 + 24.5 + 49 + 20 = 583.5
        const key = `split-${Date.now()}-abcdefgh`;
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id), clientIdempotencyKey: key, total: full.total,
            items: [{ menuItem: String(A.items.paneer._id), quantity: 2 }, { menuItem: String(water._id), quantity: 3 }],
        });
        expect(res.status).toBe(201);
        expect(res.body.isSplit).toBe(true);

        const kitchen = await Order.findById(res.body.order._id).lean();
        const counter = await Order.findById(res.body.splitOrder._id).lean();
        expect(kitchen.items.map((i) => i.name)).toEqual(['Paneer Tikka']);
        expect(counter.items.map((i) => i.name)).toEqual(['Mineral Water']);
        expect(kitchen.status).toBe('new');
        expect(counter.status).toBe('ready');
        expect(counter.preparationCompletedAt).toBeTruthy();

        expect(full.total).toBe(583.5);
        expect(counter.total).toBe(90);                 // bare items, no tax
        expect(counter.gst).toBe(0);
        expect(kitchen.total).toBe(493.5);              // 583.5 − 90
        expect(kitchen.gst).toBe(24.5);                 // tax lines on the whole cart
        expect(kitchen.serviceCharge).toBe(49);
        expect(r2(kitchen.total + counter.total)).toBe(full.total);

        expect(kitchen.clientIdempotencyKey).toBe(key);
        expect(counter.clientIdempotencyKey == null).toBe(true);
        expect(kitchen.scanSessionId).toBe(sessionId);
        expect(counter.scanSessionId).toBe(sessionId);
        expect(String(counter.table)).toBe(String(table._id));
        expect(counter.orderId).not.toBe(kitchen.orderId);
    });

    test('a counter-only cart is one doc that skips the kitchen (status ready)', async () => {
        const res = await ctx.api.guest(A).post('/orders').send(takeaway({
            items: [{ menuItem: String(water._id), quantity: 2 }], total: bill(A, 60, 'takeaway').total,
        }));
        expect(res.status).toBe(201);
        expect(res.body.isSplit).toBe(false);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.status).toBe('ready');
        expect(saved.preparationCompletedAt).toBeTruthy();
        expect(saved.total).toBe(83); // 60 + 3 + 20
    });

    // Regression (fixed 2026-10): buildOrderDocs lets the counter doc absorb a
    // discount larger than the kitchen share — both docs ≥ 0, summing to the bill.
    test('mixed cart with a discount larger than the kitchen share fails to create (500)', async () => {
        const coupon = await makeCoupon(A, { discountType: 'fixed_amount', discountValue: 300 });
        const cust = await createCustomer('oc-split-cp');
        // 1 × Paneer 200 + 5 × Water 30 = 350 takeaway, ₹300 coupon. GST is on
        // the post-coupon value: 5 % of (350 − 300) = 2.50 → 350 + 2.5 + 20 − 300 = 72.5
        // counter doc = 150 (bare) → kitchen doc = 72.5 − 150 = −77.5
        const total = computeBill({
            subtotal: 350, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway', couponDiscount: 300,
        }).total;
        expect(total).toBe(72.5);
        const res = await ctx.api.as(cust, A).post('/orders').send(takeaway({
            couponCode: coupon.code, total,
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }, { menuItem: String(water._id), quantity: 5 }],
        }));
        // Expected: 201 with two non-negative docs summing to ₹72.50.
        expect(res.status).toBe(201);
        const docs = await Order.find({ user: cust._id }).lean();
        expect(docs.every((d) => d.total >= 0)).toBe(true);
        expect(r2(docs.reduce((s, d) => s + d.total, 0))).toBe(72.5);
    });
});

describe('order numbers and idempotency keys', () => {
    test('15 concurrent takeaway orders get 15 distinct, well-formed order numbers', async () => {
        const results = await Promise.all(Array.from({ length: 15 }, () =>
            ctx.api.guest(A).post('/orders').send(takeaway({ items: cart(A), total: 676.25 }))));
        expect(results.every((r) => r.status === 201)).toBe(true);
        const ids = results.map((r) => r.body.order.orderId);
        expect(new Set(ids).size).toBe(15);
        ids.forEach((id) => expect(id).toMatch(/^ORT-\d{6}-[A-Z0-9]{6}$/));
    });

    test('the same clientIdempotencyKey in another tenant is independent', async () => {
        const key = `cross-tenant-${Date.now()}-abc`;
        const a1 = await ctx.api.guest(A).post('/orders').send(takeaway({ items: cart(A), total: 676.25, clientIdempotencyKey: key }));
        const b1 = await ctx.api.guest(B).post('/orders').send(takeaway({ items: cart(B), total: 676.25, clientIdempotencyKey: key }));
        expect(a1.status).toBe(201);
        expect(b1.status).toBe(201);
        expect(b1.body.order._id).not.toBe(a1.body.order._id);
        expect(String((await Order.findById(b1.body.order._id).lean()).restaurant)).toBe(String(B.restaurant._id));

        // Each tenant replays its own order.
        const a2 = await ctx.api.guest(A).post('/orders').send(takeaway({ items: cart(A), total: 676.25, clientIdempotencyKey: key }));
        expect(a2.status).toBe(200);
        expect(a2.body.order._id).toBe(a1.body.order._id);
        expect(await Order.countDocuments({ clientIdempotencyKey: key })).toBe(2);
    });

    test.each([
        ['too short', 'short-key'],
        ['illegal characters', 'abc def/ghi$jkl%mno'],
        ['too long', 'k'.repeat(81)],
    ])('a malformed clientIdempotencyKey (%s) → 400 IDEMPOTENCY_KEY_INVALID', async (_l, key) => {
        const res = await ctx.api.guest(A).post('/orders').send(takeaway({ items: cart(A), total: 676.25, clientIdempotencyKey: key }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    });
});

afterAll(async () => {
    await settle();
});
