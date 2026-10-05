/**
 * Follow-ups to the 2026-10 billing decisions, through the real HTTP stack:
 *
 *   Decision 6   category kind on real orders — a Coke in a 'beverages'
 *                category routed to the counter is a beverage for a
 *                scoped coupon at create (POST /orders), on staff apply
 *                (PATCH /orders/:id/coupon) and at the checkout preview
 *                (POST /promotions/apply-coupon); a 'food' coupon does
 *                not discount it. The kind is snapshotted on the line.
 *   Staff discount  POST /orders accepts `manualDiscount` from staff only
 *                (stamped at creation, ≤ total, rounded to paise).
 *   Split checkout  a mixed (kitchen + counter) takeaway cart is two
 *                linked docs (counter doc → splitParent); one online
 *                payment of the checkout (verify-payment / webhook /
 *                pay-first) settles both; a payment covering only the
 *                primary doc leaves the split doc unpaid.
 *
 * Money assertions are exact to the paisa.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const { V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Category = require(path.join(BACKEND, 'models/category'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));

const ctx = useIntegrationApp();
let A;
let cust;
let coke;      // ₹60, 'beverages' category, routed to the counter
let sandwich;  // ₹100, 'food' category, routed to the counter

const DAY = 24 * 60 * 60 * 1000;
const rid = () => crypto.randomBytes(5).toString('hex');
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const checkoutSig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');
const r2 = (n) => Math.round(n * 100) / 100;

beforeAll(async () => {
    A = await seedTenant({ label: 'fu' });
    cust = await createCustomer('fu-cust');
    const drinks = await Category.create({ restaurant: A.restaurant._id, name: `Drinks ${rid()}`, kind: 'beverages' });
    const snacks = await Category.create({ restaurant: A.restaurant._id, name: `Snacks ${rid()}`, kind: 'food' });
    coke = await MenuItem.create({
        restaurant: A.restaurant._id, category: drinks._id, name: 'Coke 300ml', description: 'sealed',
        basePrice: 60, prepStation: 'counter', vegType: 'veg',
    });
    sandwich = await MenuItem.create({
        restaurant: A.restaurant._id, category: snacks._id, name: 'Packed Sandwich', description: 'ready',
        basePrice: 100, prepStation: 'counter', vegType: 'veg',
    });
});

const takeawayBill = (subtotal, couponDiscount = 0) =>
    computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway', couponDiscount });

async function makeCoupon(fields = {}) {
    return (await Coupon.create({
        restaurant: A.restaurant._id,
        code: `FU${rid()}`.toUpperCase(),
        title: 'Coupon',
        discountType: 'percentage',
        discountValue: 10,
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
        ...fields,
    })).toObject();
}

const takeaway = (extra = {}) => ({
    type: 'takeaway',
    pickupLocation: 'Counter',
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
    ...extra,
});
const cokeLine = (quantity = 2) => ({ menuItem: String(coke._id), quantity });
const sandwichLine = (quantity = 1) => ({ menuItem: String(sandwich._id), quantity });
const paneerLine = (quantity = 1) => ({ menuItem: String(A.items.paneer._id), quantity });

// ── Decision 6 — category kind on real orders ────────────────────────

describe('Decision 6 — a counter-routed Coke in a beverages category is a beverage', () => {
    test('at create: a beverages coupon discounts it and the line snapshots categoryKind', async () => {
        const coupon = await makeCoupon({ scope: 'beverages' });
        // 2 × Coke (120) + 1 × Sandwich (100, food) → beverages slice 120 → 10 % = 12
        const expected = takeawayBill(220, 12);
        const res = await ctx.api.as(cust, A).post('/orders').send(takeaway({
            items: [cokeLine(2), sandwichLine(1)], couponCode: coupon.code, total: expected.total,
        }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.couponDiscount).toBe(12);
        expect(saved.total).toBe(expected.total);
        const kinds = Object.fromEntries(saved.items.map((i) => [i.name, [i.categoryKind, i.prepStation]]));
        expect(kinds).toEqual({ 'Coke 300ml': ['beverages', 'counter'], 'Packed Sandwich': ['food', 'counter'] });
    });

    test('at create: a food coupon does not discount the Coke', async () => {
        const coupon = await makeCoupon({ scope: 'food' });
        const onlyCoke = await ctx.api.as(cust, A).post('/orders').send(takeaway({
            items: [cokeLine(2)], couponCode: coupon.code, total: takeawayBill(120).total,
        }));
        expect(onlyCoke.status).toBe(400);
        expect(onlyCoke.body.code).toBe('COUPON_SCOPE_NO_MATCH');

        // Mixed: only the sandwich (100) is eligible → 10.
        const expected = takeawayBill(220, 10);
        const mixed = await ctx.api.as(cust, A).post('/orders').send(takeaway({
            items: [cokeLine(2), sandwichLine(1)], couponCode: coupon.code, total: expected.total,
        }));
        expect(mixed.status).toBe(201);
        expect((await Order.findById(mixed.body.order._id).lean()).couponDiscount).toBe(10);
    });

    test('staff apply on an existing order uses the categoryKind snapshot', async () => {
        const created = await ctx.api.as(cust, A).post('/orders').send(takeaway({
            items: [cokeLine(2), sandwichLine(1)], total: takeawayBill(220).total,
        }));
        expect(created.status).toBe(201);
        const id = created.body.order._id;

        const bev = await ctx.api.as(A.users.admin).patch(`/orders/${id}/coupon`)
            .send({ code: (await makeCoupon({ scope: 'beverages' })).code });
        expect(bev.status).toBe(200);
        expect(bev.body.discount).toBe(12);

        const food = await ctx.api.as(A.users.admin).patch(`/orders/${id}/coupon`)
            .send({ code: (await makeCoupon({ scope: 'food' })).code });
        expect(food.status).toBe(200);
        expect(food.body.discount).toBe(10);
        const saved = await Order.findById(id).lean();
        expect(saved.couponDiscount).toBe(10);
        expect(saved.total).toBe(takeawayBill(220, 10).total);
    });

    test('staff apply on a legacy order (no snapshot) resolves the menu category kind', async () => {
        const legacy = await Order.create({
            restaurant: A.restaurant._id, branch: A.branch._id, orderId: `LEG-${rid()}`, type: 'takeaway',
            items: [{ menuItem: String(coke._id), name: 'Coke 300ml', price: 60, quantity: 2, prepStation: 'counter' }],
            total: takeawayBill(120).total, gst: takeawayBill(120).gst,
        });
        const res = await ctx.api.as(A.users.admin).patch(`/orders/${legacy._id}/coupon`)
            .send({ code: (await makeCoupon({ scope: 'beverages' })).code });
        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(12);
    });

    test('checkout preview: the cart lines carry menuItem ids and the server resolves the kind', async () => {
        const preview = (scope) => makeCoupon({ scope }).then((c) => ctx.api.as(cust, A).post('/promotions/apply-coupon').send({
            code: c.code,
            orderValue: 220,
            // the cart sends prepStation 'counter' for both — only the category tells them apart
            items: [
                { menuItem: String(coke._id), prepStation: 'counter', price: 60, quantity: 2 },
                { menuItem: String(sandwich._id), prepStation: 'counter', price: 100, quantity: 1 },
            ],
        }));
        const bev = await preview('beverages');
        expect(bev.status).toBe(200);
        expect(bev.body).toMatchObject({ eligibleSubtotal: 120, discount: 12 });
        const food = await preview('food');
        expect(food.status).toBe(200);
        expect(food.body).toMatchObject({ eligibleSubtotal: 100, discount: 10 });
    });

    test('appended items snapshot the category kind too', async () => {
        const { createTable } = require('./helpers/seed');
        const table = await createTable(A);
        const created = await ctx.api.as(A.users.waiter).post('/orders').send({
            type: 'dine-in', tableId: String(table._id), items: [paneerLine(1)],
            total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'dine-in' }).total,
        });
        expect(created.status).toBe(201);
        const appended = await ctx.api.as(A.users.waiter).post(`/orders/${created.body.order._id}/append`)
            .set('Idempotency-Key', `app_${rid()}${rid()}`)
            .send({ items: [cokeLine(1)] });
        expect(appended.status).toBeLessThan(300);
        const docs = await Order.find({ table: table._id }).lean();
        const cokeRow = docs.flatMap((d) => d.items).find((i) => i.name === 'Coke 300ml');
        expect(cokeRow.categoryKind).toBe('beverages');
    });
});

// ── Staff manual discount at creation ────────────────────────────────

describe('POST /orders — manualDiscount (staff only)', () => {
    const body = (extra) => takeaway({ items: [paneerLine(2)], total: takeawayBill(400).total, ...extra });

    test('a staff caller stamps it at creation (rounded to paise); total is unchanged', async () => {
        const res = await ctx.api.as(A.users.admin).post('/orders').send(body({ manualDiscount: 50.456 }));
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.manualDiscount).toBe(50.46);
        expect(saved.total).toBe(takeawayBill(400).total);
    });

    test('a staff discount equal to the total is accepted; above it is refused', async () => {
        const total = takeawayBill(400).total;
        const equal = await ctx.api.as(A.users.admin).post('/orders').send(body({ manualDiscount: total }));
        expect(equal.status).toBe(201);

        const before = await Order.countDocuments({ restaurant: A.restaurant._id });
        const over = await ctx.api.as(A.users.admin).post('/orders').send(body({ manualDiscount: r2(total + 0.01) }));
        expect(over.status).toBe(400);
        expect(over.body.code).toBe('MANUAL_DISCOUNT_EXCEEDS_TOTAL');
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test.each([
        ['negative', -5],
        ['non-numeric', 'abc'],
    ])('a %s discount is refused', async (_l, value) => {
        const res = await ctx.api.as(A.users.admin).post('/orders').send(body({ manualDiscount: value }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_MANUAL_DISCOUNT');
    });

    test('a customer or guest cannot send one (403, nothing created); 0 is a harmless no-op', async () => {
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });
        const asCustomer = await ctx.api.as(cust, A).post('/orders').send(body({ manualDiscount: 100 }));
        expect(asCustomer.status).toBe(403);
        expect(asCustomer.body.code).toBe('MANUAL_DISCOUNT_STAFF_ONLY');
        const asGuest = await ctx.api.guest(A).post('/orders').send(body({ manualDiscount: 100 }));
        expect(asGuest.status).toBe(403);
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);

        const zero = await ctx.api.as(cust, A).post('/orders').send(body({ manualDiscount: 0 }));
        expect(zero.status).toBe(201);
        expect((await Order.findById(zero.body.order._id).lean()).manualDiscount).toBe(0);
    });

    test('staff Mark Paid then only owes total − manualDiscount', async () => {
        const res = await ctx.api.as(A.users.admin).post('/orders').send(body({ manualDiscount: 40 }));
        const due = r2(takeawayBill(400).total - 40);
        const paid = await ctx.api.as(A.users.admin).patch(`/orders/${res.body.order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: due });
        expect(paid.status).toBe(200);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved).toMatchObject({ paymentStatus: 'Paid', amountPaid: due, total: takeawayBill(400).total });
    });
});

// ── Mixed-cart split: one payment settles both docs ───────────────────

describe('mixed takeaway cart — online settlement covers the linked split doc', () => {
    // 1 × Paneer (200, kitchen) + 2 × Coke (120, counter)
    const fullBill = () => takeawayBill(320);
    const mixedBody = (extra = {}) => takeaway({ items: [paneerLine(1), cokeLine(2)], total: fullBill().total, paymentMethod: 'online', ...extra });

    async function placeMixed(client = ctx.api.as(cust, A), extra) {
        const res = await client.post('/orders').send(mixedBody(extra));
        expect(res.status).toBe(201);
        expect(res.body.isSplit).toBe(true);
        const main = await Order.findById(res.body.order._id).lean();
        const split = await Order.findById(res.body.splitOrder._id).lean();
        expect(String(split.splitParent)).toBe(String(main._id));
        expect(main.splitParent).toBeNull();
        expect(r2(main.total + split.total)).toBe(fullBill().total);
        return { main, split };
    }

    function stubGateway({ rzpOrderId, paymentId, paise, cafeOrderId = 'none' }) {
        const notes = { cafeOrderId, restaurantId: String(A.restaurant._id), purpose: 'cafe_order', userId: String(cust._id) };
        rzp.instance.payments.fetch.mockResolvedValue({
            id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: paise, currency: 'INR', notes,
        });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount: paise, notes });
    }

    const verify = (body) => ctx.api.as(cust, A).post('/razorpay/verify-payment').send(body);

    function deliverWebhook(entity) {
        const raw = JSON.stringify({ entity: 'event', event: 'payment.captured', id: `evt_${rid()}`, payload: { payment: { entity } } });
        return ctx.api.raw.post(`${V1}/razorpay/webhook`)
            .set('Content-Type', 'application/json')
            .set('X-Razorpay-Signature', crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
            .send(raw);
    }

    test('verify-payment of the whole checkout marks the split doc Paid too (amountPaid 0 on it)', async () => {
        const { main, split } = await placeMixed();
        const rzpOrderId = `order_${rid()}`;
        const paymentId = `pay_${rid()}`;
        await Order.updateOne({ _id: main._id }, { $set: { razorpayOrderId: rzpOrderId } });
        stubGateway({ rzpOrderId, paymentId, paise: Math.round(fullBill().total * 100), cafeOrderId: String(main._id) });

        const res = await verify({
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId), cafeOrderId: String(main._id),
        });
        expect(res.status).toBe(200);

        const paidMain = await Order.findById(main._id).lean();
        const paidSplit = await Order.findById(split._id).lean();
        expect(paidMain).toMatchObject({ paymentStatus: 'Paid', amountPaid: fullBill().total });
        expect(paidSplit).toMatchObject({ paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 0 });
        expect(paidSplit.paidAt).toBeTruthy();
    });

    test('pay-first checkout (razorpayPayment at create) then verify settles both docs', async () => {
        const rzpOrderId = `order_${rid()}`;
        const paymentId = `pay_${rid()}`;
        stubGateway({ rzpOrderId, paymentId, paise: Math.round(fullBill().total * 100) });
        const checkout = { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSig(rzpOrderId, paymentId) };
        const { main, split } = await placeMixed(ctx.api.as(cust, A), { razorpayPayment: checkout });

        const res = await verify({ ...checkout, cafeOrderId: main.orderId });
        expect(res.status).toBe(200);
        expect((await Order.findById(main._id).lean()).paymentStatus).toBe('Paid');
        expect(await Order.findById(split._id).lean()).toMatchObject({ paymentStatus: 'Paid', amountPaid: 0 });
    });

    test('the webhook safety net settles the split doc too', async () => {
        const { main, split } = await placeMixed();
        const rzpOrderId = `order_${rid()}`;
        await Order.updateOne({ _id: main._id }, { $set: { razorpayOrderId: rzpOrderId } });

        const res = await deliverWebhook({
            id: `pay_${rid()}`, entity: 'payment', amount: Math.round(fullBill().total * 100), currency: 'INR',
            status: 'captured', order_id: rzpOrderId,
            notes: { cafeOrderId: String(main._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' },
        });
        expect(res.status).toBe(200);
        expect(await Order.findById(main._id).lean()).toMatchObject({ paymentStatus: 'Paid', amountPaid: fullBill().total });
        expect(await Order.findById(split._id).lean()).toMatchObject({ paymentStatus: 'Paid', amountPaid: 0 });
    });

    test('a capture covering only the primary doc leaves the split doc unpaid', async () => {
        const { main, split } = await placeMixed();
        const rzpOrderId = `order_${rid()}`;
        await Order.updateOne({ _id: main._id }, { $set: { razorpayOrderId: rzpOrderId } });

        const res = await deliverWebhook({
            id: `pay_${rid()}`, entity: 'payment', amount: Math.round(main.total * 100), currency: 'INR',
            status: 'captured', order_id: rzpOrderId,
            notes: { cafeOrderId: String(main._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' },
        });
        expect(res.status).toBe(200);
        expect((await Order.findById(main._id).lean()).paymentStatus).toBe('Paid');
        expect((await Order.findById(split._id).lean()).paymentStatus).toBe('Pending');
    });

    test('a staff manual discount larger than the primary doc spills onto the split doc', async () => {
        const res = await ctx.api.as(A.users.admin).post('/orders').send(mixedBody({ paymentMethod: 'cash', manualDiscount: 0 }));
        expect(res.status).toBe(201);
        const mainTotal = (await Order.findById(res.body.order._id).lean()).total;
        const md = r2(mainTotal + 20);
        const res2 = await ctx.api.as(A.users.admin).post('/orders').send(mixedBody({ paymentMethod: 'cash', manualDiscount: md }));
        expect(res2.status).toBe(201);
        const main = await Order.findById(res2.body.order._id).lean();
        const split = await Order.findById(res2.body.splitOrder._id).lean();
        expect(main.manualDiscount).toBe(main.total);
        expect(split.manualDiscount).toBe(20);
    });
});
