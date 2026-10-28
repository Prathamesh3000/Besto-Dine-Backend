/**
 * Billing / payment is captain-only (admin/manager too). A WAITER only takes
 * orders: every bill/payment route answers 403 BILLING_CAPTAIN_ONLY for a
 * staff waiter, whatever permissions were granted, and is unchanged for
 * captain/admin/manager, customers and guests.
 */
const crypto = require('crypto');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(6).toString('hex');
let A;

beforeAll(async () => { A = await seedTenant({ label: 'bco-a' }); });

const as = (role) => ctx.api.as(A.users[role], A);
const newOrder = async (client = as('admin')) => {
    const res = await client.post('/orders').send({
        type: 'takeaway', pickupLocation: 'Counter',
        items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }],
        total: 5000, clientIdempotencyKey: `idem_${rid()}${rid()}`,
    });
    expect(res.status).toBe(201);
    return res.body.order;
};
const isBlocked = (res) => {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
        success: false, code: 'BILLING_CAPTAIN_ONLY', message: 'Billing and payment are handled by the captain',
    });
};

describe('waiter is refused on every billing route', () => {
    let order;
    beforeAll(async () => { order = await newOrder(); });

    const routes = [
        ['POST bill/save', (c) => c.post(`/orders/${order._id}/bill/save`).send({})],
        ['GET bill/preview', (c) => c.get(`/orders/${order._id}/bill/preview`)],
        ['POST print bill', (c) => c.post(`/print/orders/${order._id}/bill`).send({})],
        ['GET print/status', (c) => c.get('/print/status')],
        ['GET print/jobs/:id', (c) => c.get(`/print/jobs/${new (require('mongoose').Types.ObjectId)()}`)],
        ['PATCH coupon', (c) => c.patch(`/orders/${order._id}/coupon`).send({ code: '' })],
        ['razorpay create-order', (c) => c.post('/razorpay/create-order').send({ amount: 100, cafeOrderId: String(order._id) })],
        ['razorpay verify-payment', (c) => c.post('/razorpay/verify-payment').send({ razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' })],
    ];
    test.each(routes)('%s', async (_n, call) => { isBlocked(await call(as('waiter'))); });

    test.each([
        ['paymentStatus', { paymentStatus: 'Paid' }],
        ['paymentMethod', { paymentMethod: 'cash' }],
        ['amountPaid', { amountPaid: 50 }],
        ['cashReceived', { cashReceived: 100 }],
        ['manualDiscount', { manualDiscount: 5 }],
        ['tipAmount', { tipAmount: 5 }],
    ])('PATCH status carrying %s', async (_k, body) => {
        isBlocked(await as('waiter').patch(`/orders/${order._id}/status`).send({ status: 'completed', ...body }));
    });

    test('a granted updateOrderStatus permission cannot let a waiter settle', async () => {
        const User = require('../../models/user');
        const id = A.users.waiter._id;
        const before = await User.findById(id).lean();
        await User.updateOne({ _id: id }, { $set: { 'permissions.updateOrderStatus': true } });
        try {
            isBlocked(await as('waiter').patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' }));
        } finally {
            await User.updateOne({ _id: id }, { $set: { permissions: before.permissions } });
        }
    });
});

describe('captain / admin / manager keep billing access', () => {
    test.each(['captain', 'admin', 'manager'])('%s: save, preview, coupon clear, print status', async (role) => {
        if (!A.users[role]) return;
        const order = await newOrder();
        expect((await as(role).post(`/orders/${order._id}/bill/save`).send({})).status).toBe(200);
        expect((await as(role).get(`/orders/${order._id}/bill/preview`)).status).toBe(200);
        expect((await as(role).get('/print/status')).status).toBe(200);
        const c = await as(role).patch(`/orders/${order._id}/coupon`).send({ code: '' });
        expect(c.body?.code).not.toBe('BILLING_CAPTAIN_ONLY');
    });

    test('captain can settle through PATCH status with payment fields', async () => {
        const order = await newOrder();
        const res = await as('captain').patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.body?.code).not.toBe('BILLING_CAPTAIN_ONLY');
    });
});

describe('waiter still does the floor work', () => {
    test('creates, appends and reprints a KOT; reads own orders', async () => {
        const order = await newOrder(as('waiter'));
        const ap = await as('waiter').post(`/orders/${order._id}/append`)
            .send({ items: [{ menuItem: String(A.items.naan._id), quantity: 1 }] });
        expect(ap.status).toBe(200);
        const kot = await as('waiter').post(`/orders/${order._id}/reprint-kot`).send({});
        expect(kot.status).toBe(200);
        expect((await as('waiter').get('/orders/live')).status).toBe(200);
    });
});

describe('customers and guests are unaffected on razorpay routes', () => {
    test('customer / guest reach validation, not the billing guard', async () => {
        const order = await newOrder();
        const clients = [ctx.api.guest(A)];
        if (A.users.customer) clients.push(ctx.api.as(A.users.customer, A));
        for (const c of clients) {
            const r1 = await c.post('/razorpay/create-order').send({ amount: 100, cafeOrderId: String(order._id) });
            expect(r1.body?.code).not.toBe('BILLING_CAPTAIN_ONLY');
            const r2 = await c.post('/razorpay/verify-payment').send({});
            expect(r2.status).toBe(400);
            expect(r2.body?.code).not.toBe('BILLING_CAPTAIN_ONLY');
        }
    });
});
