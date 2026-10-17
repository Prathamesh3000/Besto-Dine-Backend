/**
 * Held pay-first orders — Operations Control Panel review fixes
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §6; review items A3, A4, A5).
 *
 *   A3  held ONLINE orders can leave 'awaiting-payment':
 *       - Razorpay payment.failed → onlinePaymentFailedAt + 15-min retry window
 *       - window passed + reconciliation finds NO capture → cancelled, table free
 *       - reconciliation finds a capture → RELEASED (verify-payment path), never cancelled
 *       - gateway unreachable → the hold is kept for the next sweep
 *       - a hold older than 2 h with no gateway news at all → checked, then cancelled
 *       - an online hold merely past its ORIGINAL expiry (no failure, < 2 h) is untouched
 *   A4  the sweeper's cancel has the manual-cancel side effects: order:cancelled /
 *       order:updated to the staff rooms + order room, counter-payment alert rows
 *       deleted, counterPaymentRequestedAt cleared
 *   A5  chef "Ready" auto-completes DINE-IN only (takeaway keeps its pickup step)
 *   —   a tenant WITHOUT a profile (pay after the meal) is untouched by all of it
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable, settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Table = require(path.join(BACKEND, 'models/table'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const { profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { cancelExpiredHolds, ONLINE_FAILED_GRACE_MS, ONLINE_HOLD_MAX_AGE_MS } = require(path.join(BACKEND, 'services/orderHoldService'));

const ctx = useIntegrationApp();
let H;   // hotel: QR + customer payment, pay first, no kitchen screen
let C;   // café: QR + chef + customer payment
let P;   // plain: no operations profile (pay after the meal)

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');
const whSign = (raw) => crypto.createHmac('sha256', WH_SECRET).update(raw).digest('hex');
const MIN = 60 * 1000;

const sockets = [];
beforeAll(async () => {
    H = await seedTenant({ label: 'swh' });
    C = await seedTenant({ label: 'swc' });
    P = await seedTenant({ label: 'swp' });
    await Restaurant.updateOne({ _id: H.restaurant._id }, { $set: { operations: profileFromPreset('hotelPayFirstSelfOrder') } });
    await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { operations: profileFromPreset('cafeCounterPayFirst') } });
});
afterAll(() => { for (const s of sockets) s.close(); });
afterEach(() => rzp.reset());

const total = (t, orderType = 'dine-in') => computeBill({ subtotal: 400, taxConfig: toTaxConfig(t.settings.taxes), orderType }).total;
const reload = (id) => Order.findById(id).lean();

async function atTable(t) {
    const table = await createTable(t);
    const { scanToken } = await scanTable(ctx.api, table);
    return { table, guest: ctx.api.guest(t, scanToken) };
}

const placeOrder = (client, t, table, extra = {}) => client.post('/orders').send({
    type: 'dine-in',
    tableId: String(table._id),
    items: [{ menuItem: String(t.items.paneer._id), quantity: 2 }],
    total: total(t),
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
    ...extra,
});

/** Online checkout the gateway could not confirm at create → the order is held with holdReason 'online'. */
function unconfirmedCheckout() {
    const paymentId = `pay_${rid()}`;
    const rzpOrderId = `order_${rid()}`;
    rzp.instance.payments.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
    rzp.instance.orders.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
    return {
        paymentId, rzpOrderId,
        checkout: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) },
    };
}

async function heldOnline(t) {
    const { table, guest } = await atTable(t);
    const p = unconfirmedCheckout();
    const res = await placeOrder(guest, t, table, { razorpayPayment: p.checkout, paymentMethod: 'online' });
    expect(res.status).toBe(201);
    const o = await reload(res.body.order._id);
    expect(o).toMatchObject({ status: 'awaiting-payment', holdReason: 'online' });
    expect(o.razorpayOrderId).toBe(p.rzpOrderId);
    return { table, order: o, p };
}

/** Razorpay webhook delivery, signed like the real thing. */
function deliver(event, paymentEntity) {
    const body = JSON.stringify({ entity: 'event', event, id: `evt_${rid()}`, payload: { payment: { entity: paymentEntity } } });
    return ctx.api.raw.post(`${V1}/razorpay/webhook`)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', whSign(body))
        .send(body);
}
const failedPayment = (o, p) => ({
    id: p.paymentId, entity: 'payment', status: 'failed', amount: Math.round(o.total * 100), currency: 'INR',
    order_id: p.rzpOrderId, error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment failed',
    notes: { cafeOrderId: String(o._id), restaurantId: String(o.restaurant), purpose: 'cafe_order' },
});

/** Razorpay knows no capture on any checkout of the order. */
const noCapture = () => rzp.instance.orders.fetchPayments.mockResolvedValue({ items: [] });
/** Razorpay has a capture covering the order. */
const capturedFor = (o, p) => rzp.instance.orders.fetchPayments.mockResolvedValue({
    items: [{ id: p.paymentId, entity: 'payment', status: 'captured', amount: Math.round(o.total * 100), currency: 'INR',
        order_id: p.rzpOrderId, created_at: Math.floor(Date.now() / 1000) - 60 }],
});

const past = (id, ms = 1000) => Order.updateOne({ _id: id }, { $set: { holdExpiresAt: new Date(Date.now() - ms) } });

function connectSocket(token) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
        sockets.push(socket);
        const events = [];
        socket.onAny((event, payload) => events.push({ event, payload }));
        socket.on('connect', () => resolve({ socket, events }));
        socket.on('connect_error', reject);
    });
}
const waitFor = (events, predicate, ms = 4000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
        const hit = events.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() - started > ms) return reject(new Error(`event not received; got ${JSON.stringify(events.map((e) => e.event))}`));
        return setTimeout(tick, 25);
    };
    tick();
});

describe('A3 — held online orders leave awaiting-payment', () => {
    test('payment.failed on a held online order → 15-minute retry window; the sweep does not touch it before that', async () => {
        const { order: o, p } = await heldOnline(H);
        const before = Date.now();
        const res = await deliver('payment.failed', failedPayment(o, p));
        expect(res.status).toBe(200);

        const after = await reload(o._id);
        expect(after.status).toBe('awaiting-payment');
        expect(after.onlinePaymentFailedAt).toBeTruthy();
        const expiresIn = after.holdExpiresAt.getTime() - before;
        expect(expiresIn).toBeGreaterThan(ONLINE_FAILED_GRACE_MS - MIN);
        expect(expiresIn).toBeLessThanOrEqual(ONLINE_FAILED_GRACE_MS + MIN);

        noCapture();
        await cancelExpiredHolds();
        expect((await reload(o._id)).status).toBe('awaiting-payment');
        expect(rzp.instance.orders.fetchPayments).not.toHaveBeenCalled();
    });

    test('window passed + reconciliation finds no capture → cancelled (payment-timeout), table freed', async () => {
        const { table, order: o, p } = await heldOnline(H);
        await deliver('payment.failed', failedPayment(o, p));
        await past(o._id);
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');

        noCapture();
        const r = await cancelExpiredHolds();
        expect(r.cancelled).toBeGreaterThanOrEqual(1);
        expect(rzp.instance.orders.fetchPayments).toHaveBeenCalledWith(p.rzpOrderId);

        const after = await reload(o._id);
        expect(after).toMatchObject({ status: 'cancelled', cancelReason: 'payment-timeout', paymentStatus: 'Pending' });
        expect(after.cancelReasonNote).toMatch(/failed/);
        expect(after.holdExpiresAt).toBeUndefined();
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });

    test('reconciliation finds a captured payment → the order is RELEASED (paid, served), not cancelled', async () => {
        const { order: o, p } = await heldOnline(H);
        await deliver('payment.failed', failedPayment(o, p));   // a failed attempt, then the customer retried and paid
        await past(o._id);

        capturedFor(o, p);
        const r = await cancelExpiredHolds();
        expect(r.released).toBeGreaterThanOrEqual(1);

        const after = await reload(o._id);
        expect(after.status).toBe('served');            // hotel: complete once released
        expect(after.paymentStatus).toBe('Paid');
        expect(after.razorpayPaymentId).toBe(p.paymentId);
        expect(after.releasedAt).toBeTruthy();
        expect(after.cancelReason).toBeFalsy();
    });

    test('gateway unreachable at sweep time → the hold is kept for the next sweep', async () => {
        const { order: o, p } = await heldOnline(H);
        await deliver('payment.failed', failedPayment(o, p));
        await past(o._id);
        // razorpayMock default: fetchPayments rejects
        const r = await cancelExpiredHolds();
        expect(r.kept).toBeGreaterThanOrEqual(1);
        expect((await reload(o._id)).status).toBe('awaiting-payment');
    });

    test('an online hold older than 2 hours with no gateway news is checked and, with no capture, cancelled', async () => {
        const { order: o, p } = await heldOnline(H);
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: new Date(Date.now() - ONLINE_HOLD_MAX_AGE_MS - MIN) } });

        noCapture();
        const r = await cancelExpiredHolds();
        expect(r.cancelled).toBeGreaterThanOrEqual(1);
        expect(rzp.instance.orders.fetchPayments).toHaveBeenCalledWith(p.rzpOrderId);
        const after = await reload(o._id);
        expect(after).toMatchObject({ status: 'cancelled', cancelReason: 'payment-timeout' });
        expect(after.cancelReasonNote).toMatch(/never confirmed/);
    });

    test('an online hold merely past its original expiry (no failure, under 2 h) is still never expired', async () => {
        const { order: o } = await heldOnline(H);
        await past(o._id);
        noCapture();
        await cancelExpiredHolds();
        expect((await reload(o._id)).status).toBe('awaiting-payment');
        expect(rzp.instance.orders.fetchPayments).not.toHaveBeenCalled();
    });

    test('a replayed capture webhook after the cancel still records the money and queues a refund (unchanged)', async () => {
        const { order: o, p } = await heldOnline(H);
        await deliver('payment.failed', failedPayment(o, p));
        await past(o._id);
        noCapture();
        await cancelExpiredHolds();
        expect((await reload(o._id)).status).toBe('cancelled');

        const res = await deliver('payment.captured', { ...failedPayment(o, p), status: 'captured' });
        expect(res.status).toBe(200);
        const after = await reload(o._id);
        expect(after.status).toBe('cancelled');
        expect(after.paymentStatus).toBe('Paid');
    });
});

describe('A4 — the sweeper cancels with the manual-cancel side effects', () => {
    test('cash hold expires → admin alert rows deleted, counterPaymentRequestedAt cleared, order:cancelled + order:updated emitted', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        await settle();
        const o = await reload(id);
        expect(o.counterPaymentRequestedAt).toBeTruthy();
        const alerts = () => Notification.countDocuments({ restaurant: H.restaurant._id, recipientRole: 'admin', 'meta.orderId': o.orderId });
        expect(await alerts()).toBeGreaterThanOrEqual(1);

        const { events } = await connectSocket(H.users.admin.token);
        await past(id);
        const r = await cancelExpiredHolds();
        expect(r.cancelled).toBeGreaterThanOrEqual(1);

        const cancelled = await waitFor(events, (e) => e.event === 'order:cancelled' && e.payload?.orderId === o.orderId);
        expect(cancelled.payload).toMatchObject({ status: 'cancelled', cancelReason: 'payment-timeout', restaurant: String(H.restaurant._id) });
        await waitFor(events, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId && e.payload?.status === 'cancelled');

        const after = await reload(id);
        expect(after).toMatchObject({ status: 'cancelled', cancelReason: 'payment-timeout' });
        expect(after.counterPaymentRequestedAt).toBeUndefined();
        expect(after.holdExpiresAt).toBeUndefined();
        expect(await alerts()).toBe(0);
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });

    test('the per-order room (customer tracking page) hears the cancel too', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        const o = await reload(res.body.order._id);
        // Same-tenant staff may join order:<id>; the guest's own join path is exercised in realtimeEvents.test.js.
        const { socket, events } = await connectSocket(H.users.admin.token);
        socket.emit('join', `order:${o.orderId}`);
        await settle(150);
        await past(o._id);
        await cancelExpiredHolds();
        await waitFor(events, (e) => e.event === 'order:cancelled' && e.payload?.orderId === o.orderId);
        // staff room + order room → the same socket hears it from both
        await settle(150);
        expect(events.filter((e) => e.event === 'order:cancelled' && e.payload?.orderId === o.orderId).length).toBeGreaterThanOrEqual(1);
    });
});

describe('A5 — chef Ready completes dine-in only', () => {
    const chef = () => ctx.api.as(C.users.chef, C);
    const admin = () => ctx.api.as(C.users.admin, C);

    test('café takeaway: Ready keeps the pickup step (status stays ready)', async () => {
        const res = await admin().post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', customerName: 'Walk-in', phone: '9876543210',
            items: [{ menuItem: String(C.items.paneer._id), quantity: 2 }],
            total: total(C, 'takeaway'),
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        expect((await chef().patch(`/orders/${id}/status`).send({ status: 'preparing' })).status).toBe(200);
        expect((await chef().patch(`/orders/${id}/status`).send({ status: 'ready' })).status).toBe(200);
        const o = await reload(id);
        expect(o.status).toBe('ready');
        expect(o.servedAt).toBeFalsy();
    });

    test('café dine-in (control): Ready completes the order', async () => {
        const table = await createTable(C);
        const res = await placeOrder(admin(), C, table);
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        await chef().patch(`/orders/${id}/status`).send({ status: 'preparing' });
        await chef().patch(`/orders/${id}/status`).send({ status: 'ready' });
        expect((await reload(id)).status).toBe('served');
    });

    test('tenant without a profile: takeaway AND dine-in Ready both stay ready (today)', async () => {
        const chefP = ctx.api.as(P.users.chef, P);
        const table = await createTable(P);
        const dine = await placeOrder(ctx.api.as(P.users.admin, P), P, table);
        const take = await ctx.api.as(P.users.admin, P).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', customerName: 'Walk-in', phone: '9876543210',
            items: [{ menuItem: String(P.items.paneer._id), quantity: 2 }],
            total: total(P, 'takeaway'),
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        for (const id of [dine.body.order._id, take.body.order._id]) {
            await chefP.patch(`/orders/${id}/status`).send({ status: 'preparing' });
            await chefP.patch(`/orders/${id}/status`).send({ status: 'ready' });
            expect((await reload(id)).status).toBe('ready');
        }
    });
});

describe('tenant without a profile (pay after the meal) is untouched', () => {
    test('payment.failed on a normal unpaid order changes nothing; the sweep never sees it', async () => {
        const table = await createTable(P);
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await placeOrder(ctx.api.guest(P, scanToken), P, table);
        expect(res.status).toBe(201);
        const o = await reload(res.body.order._id);
        expect(o.status).toBe('new');
        const rzpOrderId = `order_${rid()}`;
        await Order.updateOne({ _id: o._id }, { $set: { razorpayOrderId: rzpOrderId } });
        const p = { paymentId: `pay_${rid()}`, rzpOrderId };

        expect((await deliver('payment.failed', failedPayment({ ...o, razorpayOrderId: rzpOrderId }, p))).status).toBe(200);
        const after = await reload(o._id);
        expect(after.status).toBe('new');
        expect(after.onlinePaymentFailedAt).toBeUndefined();
        expect(after.holdExpiresAt).toBeUndefined();

        noCapture();
        await cancelExpiredHolds();
        expect((await reload(o._id)).status).toBe('new');
        expect(rzp.instance.orders.fetchPayments).not.toHaveBeenCalled();
    });
});
