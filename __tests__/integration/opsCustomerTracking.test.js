/**
 * Operations profile §12.3 — `orderFlow.customerTracking:false` enforced on
 * the server (OPERATIONS_CONTROL_PANEL_DESIGN.md).
 *
 * Tenant T has the chef module off (no kitchen screen → tracking off);
 * tenant D has no profile at all (today's behaviour). For T:
 *
 *   - customer / guest / kiosk reads (`/orders/:id/detail`, `/orders/my-orders`,
 *     `/orders/track/:id`, `/orders/active[-list]/table/:id`) show the
 *     collapsed status (`confirmed` / `completed` / `cancelled`), no kitchen
 *     fields and `trackingDisabled:true`; admin reads show the real status
 *   - preparing / ready reach the staff rooms but not the customer rooms
 *     (owner + `order:<id>`), and no "Being Prepared" / "Ready" customer row
 *     is written; served, cancelled and payment still reach the customer
 *   - the payment / release / pickup emits that bypass updateOrderStatus
 *     (customer wallet finalize, Razorpay verify, held-order release +
 *     auto-complete, waiter pickup) also collapse the status for the
 *     customer rooms and carry trackingDisabled:true; staff rooms unchanged
 *
 * For D everything is exactly as before (regression on the realtime and
 * query suites' expectations).
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { normaliseProfile, resolveOperations, profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { signTypedToken, TOKEN_TYPES } = require(path.join(BACKEND, 'middlewares/authMiddleware'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));

const ctx = useIntegrationApp();
let T;        // chef module off → customerTracking:false
let D;        // no profile → today's behaviour
let H;        // hotel pay-first preset: chef off (tracking off), held until paid, completes without a kitchen
let cust;
let seq = 0;
const oid = (p = 'CT') => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mentions = (events, orderId) => JSON.stringify(events).includes(orderId);
const sockets = [];

beforeAll(async () => {
    T = await seedTenant({ label: 'ct-off' });
    D = await seedTenant({ label: 'ct-dflt' });
    await Restaurant.updateOne({ _id: T.restaurant._id }, {
        $set: {
            operations: normaliseProfile({
                modules: { qrOrdering: true, waiter: true, captain: true, chef: false, customerPayment: true },
            }),
        },
    });
    H = await seedTenant({ label: 'ct-hotel' });
    await Restaurant.updateOne({ _id: H.restaurant._id }, { $set: { operations: profileFromPreset('hotelPayFirstSelfOrder') } });
    cust = await createCustomer('ct', { phone: '9333333333' });
});

afterAll(() => {
    for (const s of sockets) s.close();
});

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: oid(),
        type: 'takeaway',
        user: cust._id,
        customerName: cust.name,
        phone: '9333333333',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 2, prepStation: 'kitchen', prepTimeMinutes: 12 }],
        total: 420,
        ...fields,
    });
    return doc.toObject();
}

function connect(auth) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, {
            auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => reject(err));
    });
}
function recorder(socket) {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
}
const waitFor = (events, predicate, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
        const hit = events.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() - started > ms) return reject(new Error(`event not received in time; got ${JSON.stringify(events.map((e) => e.event))}`));
        return setTimeout(tick, 25);
    };
    tick();
});

/** admin + waiter + the customer (also joined to the order room). */
async function audience(t, order) {
    const admin = recorder(await connect({ token: t.users.admin.token }));
    const waiter = recorder(await connect({ token: t.users.waiter.token }));
    const custSocket = await connect({ token: cust.token });
    const customer = recorder(custSocket);
    custSocket.emit('join', `order:${order.orderId}`);
    await sleep(200);
    return { admin, waiter, customer };
}

const customerRows = (order) => Notification.find({ recipient: cust._id, 'meta.orderId': order.orderId }).lean();
const titles = async (order) => (await customerRows(order)).map((n) => n.title).sort();

describe('fixture', () => {
    test('T resolves to customerTracking:false, D to true', async () => {
        const t = await Restaurant.findById(T.restaurant._id).lean();
        expect(resolveOperations(t).orderFlow.customerTracking).toBe(false);
        const d = await Restaurant.findById(D.restaurant._id).lean();
        expect(resolveOperations(d).orderFlow.customerTracking).toBe(true);
    });
});

// ── HTTP reads ──────────────────────────────────────────────────────────
describe('GET /orders/:id/detail', () => {
    test('customer sees confirmed + trackingDisabled and no kitchen fields; admin sees the real status', async () => {
        const o = await mkOrder(T, { status: 'preparing', preparationStartedAt: new Date(), chef: T.users.chef._id });

        const c = await ctx.api.as(cust, T).get(`/orders/${o._id}/detail`);
        expect(c.status).toBe(200);
        expect(c.body.order.status).toBe('confirmed');
        expect(c.body.order.trackingDisabled).toBe(true);
        expect(c.body.order).not.toHaveProperty('preparationStartedAt');
        expect(c.body.order).not.toHaveProperty('preparationCompletedAt');
        expect(c.body.order).not.toHaveProperty('chef');
        expect(c.body.order.items[0]).not.toHaveProperty('prepStation');
        expect(c.body.order.items[0]).not.toHaveProperty('prepTimeMinutes');
        expect(c.body.order.items[0]).toMatchObject({ name: 'Paneer Tikka', price: 200, quantity: 2 });
        expect(c.body.order.total).toBe(420);

        const a = await ctx.api.as(T.users.admin).get(`/orders/${o._id}/detail`);
        expect(a.status).toBe(200);
        expect(a.body.order.status).toBe('preparing');
        expect(a.body.order).not.toHaveProperty('trackingDisabled');
        expect(a.body.order.items[0].prepStation).toBe('kitchen');
    });

    test.each([
        ['new', 'confirmed'],
        ['ready', 'confirmed'],
        ['served', 'completed'],
        ['cancelled', 'cancelled'],
        ['awaiting-payment', 'awaiting-payment'],
    ])('customer status %s → %s', async (status, shown) => {
        const o = await mkOrder(T, { status });
        const c = await ctx.api.as(cust, T).get(`/orders/${o._id}/detail`);
        expect(c.status).toBe(200);
        expect(c.body.order.status).toBe(shown);
        expect(c.body.order.trackingDisabled).toBe(true);
    });

    test('guest with the scan session also gets the collapsed view', async () => {
        const table = await createTable(T);
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        const o = await mkOrder(T, { type: 'dine-in', table: table._id, user: null, status: 'ready', scanSessionId: sessionId, preparationCompletedAt: new Date() });
        const g = await ctx.api.guest(T, scanToken).get(`/orders/${o.orderId}/detail`);
        expect(g.status).toBe(200);
        expect(g.body.order.status).toBe('confirmed');
        expect(g.body.order.trackingDisabled).toBe(true);
        expect(g.body.order).not.toHaveProperty('preparationCompletedAt');
    });

    test('regression: default tenant customer still sees the real status and kitchen fields', async () => {
        const o = await mkOrder(D, { status: 'preparing', preparationStartedAt: new Date() });
        const c = await ctx.api.as(cust, D).get(`/orders/${o._id}/detail`);
        expect(c.status).toBe(200);
        expect(c.body.order.status).toBe('preparing');
        expect(c.body.order).not.toHaveProperty('trackingDisabled');
        expect(c.body.order.items[0].prepStation).toBe('kitchen');
    });
});

describe('GET /orders/my-orders', () => {
    test('collapsed on T, untouched on D', async () => {
        const n = await mkOrder(T, { status: 'new' });
        const s = await mkOrder(T, { status: 'served' });
        const t = await ctx.api.as(cust, T).get('/orders/my-orders');
        expect(t.status).toBe(200);
        const byId = Object.fromEntries(t.body.orders.map((o) => [o.id, o]));
        expect(byId[n.orderId]).toMatchObject({ status: 'confirmed', trackingDisabled: true });
        expect(byId[s.orderId]).toMatchObject({ status: 'completed', trackingDisabled: true });
        for (const o of t.body.orders) expect(o.trackingDisabled).toBe(true);

        const dn = await mkOrder(D, { status: 'new' });
        const d = await ctx.api.as(cust, D).get('/orders/my-orders');
        expect(d.status).toBe(200);
        const row = d.body.orders.find((o) => o.id === dn.orderId);
        expect(row.status).toBe('new');
        expect(row).not.toHaveProperty('trackingDisabled');
    });
});

describe('GET /orders/track/:orderId (kiosk)', () => {
    const kioskToken = (orderId, restaurant) => signTypedToken(TOKEN_TYPES.KIOSK,
        { kind: 'kiosk-track', orderId, restaurant: String(restaurant) }, { expiresIn: '2h' });

    test('T: collapsed status, no prep timestamps; D: real status with timestamps', async () => {
        const k = await mkOrder(T, { source: 'kiosk', user: null, customerName: 'Kiosk', status: 'preparing', preparationStartedAt: new Date() });
        const r = await ctx.api.guest(T).get(`/orders/track/${k.orderId}`).set('X-Kiosk-Token', kioskToken(k.orderId, T.restaurant._id));
        expect(r.status).toBe(200);
        expect(r.body.order).toMatchObject({ orderId: k.orderId, status: 'confirmed', trackingDisabled: true, paymentStatus: k.paymentStatus });
        expect(r.body.order).not.toHaveProperty('preparationStartedAt');
        expect(r.body.order).toHaveProperty('cancelledAt');

        const kd = await mkOrder(D, { source: 'kiosk', user: null, customerName: 'Kiosk', status: 'preparing', preparationStartedAt: new Date() });
        const rd = await ctx.api.guest(D).get(`/orders/track/${kd.orderId}`).set('X-Kiosk-Token', kioskToken(kd.orderId, D.restaurant._id));
        expect(rd.status).toBe(200);
        expect(rd.body.order.status).toBe('preparing');
        expect(rd.body.order.preparationStartedAt).toBeTruthy();
        expect(rd.body.order).not.toHaveProperty('trackingDisabled');
    });
});

describe('GET /orders/active/table/:id and /active-list/table/:id', () => {
    test('guest gets the collapsed rows, admin the raw documents', async () => {
        const table = await createTable(T);
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        const o = await mkOrder(T, { type: 'dine-in', table: table._id, user: null, status: 'preparing', scanSessionId: sessionId, preparationStartedAt: new Date() });

        const one = await ctx.api.guest(T, scanToken).get(`/orders/active/table/${table._id}`);
        expect(one.status).toBe(200);
        expect(one.body.order.orderId).toBe(o.orderId);
        expect(one.body.order.status).toBe('confirmed');
        expect(one.body.order.trackingDisabled).toBe(true);
        expect(one.body.order).not.toHaveProperty('preparationStartedAt');
        expect(one.body.order.items[0]).not.toHaveProperty('prepStation');

        const list = await ctx.api.guest(T, scanToken).get(`/orders/active-list/table/${table._id}`);
        expect(list.status).toBe(200);
        expect(list.body.orders).toHaveLength(1);
        expect(list.body.orders[0]).toMatchObject({ orderId: o.orderId, status: 'confirmed', trackingDisabled: true });

        const admin = await ctx.api.as(T.users.admin).get(`/orders/active/table/${table._id}`);
        expect(admin.status).toBe(200);
        expect(admin.body.order.status).toBe('preparing');
        expect(admin.body.order.preparationStartedAt).toBeTruthy();
        expect(admin.body.order).not.toHaveProperty('trackingDisabled');
    });
});

// ── Sockets + customer rows ─────────────────────────────────────────────
describe('status transitions on T (tracking off)', () => {
    test('preparing / ready reach staff, never the customer; served reaches the customer as completed', async () => {
        const o = await mkOrder(T, { status: 'new' });
        const ev = await audience(T, o);
        const isUpd = (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId;

        // new → preparing (admin, since the chef role is off on T)
        let res = await ctx.api.as(T.users.admin).patch(`/orders/${o._id}/status`).send({ status: 'preparing' });
        expect(res.status).toBe(200);
        await waitFor(ev.admin, isUpd);
        await waitFor(ev.waiter, isUpd);
        expect(ev.admin.find(isUpd).payload.status).toBe('preparing');   // staff get the real status
        await sleep(600);
        expect(mentions(ev.customer, o.orderId)).toBe(false);
        expect(await titles(o)).toEqual([]);                              // no "Order Being Prepared" row

        // preparing → ready
        ev.admin.length = 0; ev.waiter.length = 0;
        res = await ctx.api.as(T.users.admin).patch(`/orders/${o._id}/status`).send({ status: 'ready' });
        expect(res.status).toBe(200);
        await waitFor(ev.waiter, (e) => e.event === 'order:ready' && e.payload?.orderId === o.orderId);
        await waitFor(ev.admin, isUpd);
        await sleep(600);
        expect(mentions(ev.customer, o.orderId)).toBe(false);
        expect(await titles(o)).toEqual([]);                              // no "Your Order is Ready!" row

        // ready → served: completion reaches the customer, collapsed
        res = await ctx.api.as(T.users.admin).patch(`/orders/${o._id}/status`).send({ status: 'served' });
        expect(res.status).toBe(200);
        const done = await waitFor(ev.customer, isUpd);
        expect(done.payload).toEqual({ orderId: o.orderId, status: 'completed', paymentStatus: 'Pending', trackingDisabled: true });
        await waitFor(ev.customer, (e) => e.event === 'notification:new' && /picked up/.test(e.payload?.description || ''));
        expect(await titles(o)).toEqual(['Order Delivered']);
        // the customer never saw a kitchen status
        expect(ev.customer.some((e) => ['preparing', 'ready'].includes(e.payload?.status))).toBe(false);
        expect(ev.customer.some((e) => e.event === 'order:ready')).toBe(false);
    });

    test('cancellation still reaches the customer', async () => {
        const o = await mkOrder(T, { status: 'preparing' });
        const ev = await audience(T, o);
        const res = await ctx.api.as(T.users.admin).patch(`/orders/${o._id}/status`).send({ status: 'cancelled' });
        expect(res.status).toBe(200);
        const upd = await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(upd.payload).toMatchObject({ status: 'cancelled', trackingDisabled: true });
        await waitFor(ev.customer, (e) => e.event === 'notification:new' && /cancelled/i.test(e.payload?.title || ''));
        expect(await titles(o)).toEqual(['Order Cancelled']);
    });

    test('payment confirmation reaches the customer with the kitchen status hidden', async () => {
        const o = await mkOrder(T, { status: 'preparing' });
        const ev = await audience(T, o);
        const res = await ctx.api.as(T.users.admin).patch(`/orders/${o._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 420 });
        expect(res.status).toBe(200);
        await waitFor(ev.customer, (e) => e.event === 'notification:new' && /Payment of ₹\d/.test(e.payload?.description || ''));
        const upd = await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(upd.payload).toEqual({ orderId: o.orderId, status: 'confirmed', paymentStatus: 'Paid', trackingDisabled: true });
        // staff still see the real status on the same event
        const staff = await waitFor(ev.admin, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(staff.payload.status).toBe('preparing');
        expect((await titles(o))).toContain('Payment Successful');
    });
});

// ── Emits that bypass updateOrderStatus ─────────────────────────────────
describe('payment / release / pickup emits on tenants with tracking off', () => {
    const rid = () => crypto.randomBytes(5).toString('hex');
    const sig = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
    const dineInTotal = (t) => computeBill({ subtotal: 400, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;
    const custUpdates = (ev, orderId) => ev.customer.filter((e) => e.event === 'order:updated' && e.payload?.orderId === orderId).map((e) => e.payload);
    const staffStatuses = (ev, orderId) => ev.admin.filter((e) => e.event === 'order:updated' && e.payload?.orderId === orderId).map((e) => e.payload.status);

    /** The logged-in customer at a fresh table of `t`, holding its scan token. */
    async function custAtTable(t) {
        const table = await createTable(t);
        const { scanToken } = await scanTable(ctx.api, table);
        return { table, client: ctx.api.customerAtTable(cust, t, scanToken) };
    }
    const placeOrder = (client, t, table, extra = {}) => client.post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), quantity: 2 }],
        total: dineInTotal(t), clientIdempotencyKey: `idem_${rid()}${rid()}`, ...extra,
    });
    /** A Razorpay checkout the (mocked) gateway cannot confirm yet; `stub()` makes it captured. */
    function checkout(t) {
        const paymentId = `pay_${rid()}`;
        const rzpOrderId = `order_${rid()}`;
        const paise = Math.round(dineInTotal(t) * 100);
        rzp.instance.payments.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
        rzp.instance.orders.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
        const stub = () => {
            rzp.instance.payments.fetch.mockResolvedValue({
                id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: paise,
                currency: 'INR', created_at: Math.floor(Date.now() / 1000) - 30, notes: {},
            });
            rzp.instance.orders.fetch.mockResolvedValue({
                id: rzpOrderId, entity: 'order', amount: paise,
                notes: { cafeOrderId: 'none', restaurantId: String(t.restaurant._id), purpose: 'cafe_order' },
            });
        };
        return { stub, body: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) } };
    }

    test('fixture: H resolves to tracking off, held until paid, no kitchen / served step', async () => {
        const r = resolveOperations(await Restaurant.findById(H.restaurant._id).lean());
        expect(r.orderFlow).toMatchObject({ customerTracking: false, kitchenDisplay: false, servedStep: false });
        expect(r.payment).toMatchObject({ dineIn: 'payFirst', holdUntilPaid: true, methods: { counterCash: true, online: true } });
    });

    test('customer wallet payment finalize (PATCH /orders/:id/payment) → collapsed status to the customer, real status to staff', async () => {
        const o = await mkOrder(T, { status: 'preparing' });
        await setWallet(T, cust, { balance: 2000 });
        const paid = await ctx.api.as(cust, T).post('/wallet/pay').send({ orderId: String(o._id), amount: 420 });
        expect(paid.status).toBe(200);
        const ev = await audience(T, o);
        const fin = await ctx.api.as(cust, T).patch(`/orders/${o._id}/payment`).send({ paymentStatus: 'Paid' });
        expect(fin.status).toBe(200);
        const upd = await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(upd.payload).toEqual({ orderId: o.orderId, status: 'confirmed', paymentStatus: 'Paid', trackingDisabled: true });
        const staff = await waitFor(ev.admin, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(staff.payload).toEqual({ orderId: o.orderId, status: 'preparing', paymentStatus: 'Paid' });
    });

    test('regression D: the wallet finalize emit is unchanged (real status, no flag)', async () => {
        const o = await mkOrder(D, { status: 'preparing' });
        await setWallet(D, cust, { balance: 2000 });
        expect((await ctx.api.as(cust, D).post('/wallet/pay').send({ orderId: String(o._id), amount: 420 })).status).toBe(200);
        const ev = await audience(D, o);
        expect((await ctx.api.as(cust, D).patch(`/orders/${o._id}/payment`).send({ paymentStatus: 'Paid' })).status).toBe(200);
        const upd = await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(upd.payload).toEqual({ orderId: o.orderId, status: 'preparing', paymentStatus: 'Paid' });
    });

    test('Razorpay verify of a held order (H) → payment, release and completion reach the customer collapsed; staff see new / served', async () => {
        const { table, client } = await custAtTable(H);
        const c = checkout(H);
        const res = await placeOrder(client, H, table, { razorpayPayment: c.body, paymentMethod: 'online' });
        expect(res.status).toBe(201);
        const o = res.body.order;
        expect((await Order.findById(o._id).lean()).status).toBe('awaiting-payment');
        const ev = await audience(H, o);

        c.stub();
        const verify = await client.post('/razorpay/verify-payment').send({ ...c.body, cafeOrderId: o.orderId });
        expect(verify.status).toBe(200);
        await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId && e.payload.status === 'completed');
        await settle(500);
        const mine = custUpdates(ev, o.orderId);
        expect(mine.length).toBeGreaterThanOrEqual(2);                       // payment + completion at least
        for (const p of mine) {
            expect(p.trackingDisabled).toBe(true);
            expect(['awaiting-payment', 'confirmed', 'completed']).toContain(p.status);
        }
        expect(mine.some((p) => p.paymentStatus === 'Paid')).toBe(true);
        expect(mine[mine.length - 1].status).toBe('completed');
        const staff = staffStatuses(ev, o.orderId);
        expect(staff).toContain('new');                                       // release, real status
        expect(staff).not.toContain('confirmed');
        expect(ev.admin.some((e) => e.payload?.trackingDisabled)).toBe(false);
        expect((await Order.findById(o._id).lean())).toMatchObject({ paymentStatus: 'Paid', status: 'served' });
    });

    test('counter cash held (H) → admin "Mark paid" releases + completes: the customer hears confirmed / completed, never new / served', async () => {
        const { table, client } = await custAtTable(H);
        const res = await placeOrder(client, H, table, { paymentIntent: 'counterCash' });
        expect(res.status).toBe(201);
        const o = res.body.order;
        const ev = await audience(H, o);
        const pay = await ctx.api.as(H.users.admin, H).patch(`/orders/${o._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId && e.payload.status === 'completed');
        await settle(500);
        const mine = custUpdates(ev, o.orderId);
        expect(mine.length).toBeGreaterThanOrEqual(2);
        for (const p of mine) {
            expect(p.trackingDisabled).toBe(true);
            expect(['confirmed', 'completed']).toContain(p.status);
        }
        expect(mine.some((p) => p.status === 'confirmed')).toBe(true);        // the release ('new'), collapsed
        expect(staffStatuses(ev, o.orderId)).toContain('new');
        expect((await Order.findById(o._id).lean())).toMatchObject({ paymentStatus: 'Paid', status: 'served' });
    });

    test('waiter pickup (PATCH /orders/:id/pickup) → completed + trackingDisabled to the customer on T; served on D', async () => {
        const o = await mkOrder(T, { status: 'ready', preparationCompletedAt: new Date() });
        const ev = await audience(T, o);
        const res = await ctx.api.as(T.users.waiter, T).patch(`/orders/${o._id}/pickup`).send({});
        expect(res.status).toBe(200);
        const upd = await waitFor(ev.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(upd.payload).toMatchObject({ orderId: o.orderId, status: 'completed', paymentStatus: 'Pending', trackingDisabled: true });
        expect(upd.payload.servedAt).toBeTruthy();
        const staff = await waitFor(ev.waiter, (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId);
        expect(staff.payload.status).toBe('served');
        expect(staff.payload).not.toHaveProperty('trackingDisabled');

        const d = await mkOrder(D, { status: 'ready', preparationCompletedAt: new Date() });
        const evD = await audience(D, d);
        expect((await ctx.api.as(D.users.waiter, D).patch(`/orders/${d._id}/pickup`).send({})).status).toBe(200);
        const updD = await waitFor(evD.customer, (e) => e.event === 'order:updated' && e.payload?.orderId === d.orderId);
        expect(updD.payload.status).toBe('served');
        expect(updD.payload).not.toHaveProperty('trackingDisabled');
    });
});

describe('regression: status transitions on D (tracking on) are unchanged', () => {
    test('customer gets order:updated with the real status, the "being prepared" row and order:ready', async () => {
        const o = await mkOrder(D, { status: 'new' });
        const ev = await audience(D, o);
        const isUpd = (e) => e.event === 'order:updated' && e.payload?.orderId === o.orderId;

        let res = await ctx.api.as(D.users.admin).patch(`/orders/${o._id}/status`).send({ status: 'preparing' });
        expect(res.status).toBe(200);
        const upd = await waitFor(ev.customer, isUpd);
        expect(upd.payload).toEqual({ orderId: o.orderId, status: 'preparing', paymentStatus: 'Pending' });
        await waitFor(ev.customer, (e) => e.event === 'notification:new' && /being prepared/.test(e.payload?.description || ''));

        res = await ctx.api.as(D.users.chef).patch(`/orders/${o._id}/status`).send({ status: 'ready' });
        expect(res.status).toBe(200);
        await waitFor(ev.customer, (e) => e.event === 'order:ready' && e.payload?.orderId === o.orderId);
        await waitFor(ev.waiter, (e) => e.event === 'order:ready' && e.payload?.orderId === o.orderId);
        expect(await titles(o)).toEqual(['Order Being Prepared', 'Your Order is Ready!']);
    });
});
