/**
 * Token-number mode (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2) — a GUEST
 * who orders through the counter QR has no scan session, so the order is
 * issued a one-off guest access token (utils/guestAccess.js):
 *
 *   - POST /orders (guest, token mode, no table, no scan token) → 201 with
 *     `guestAccessToken` (+ `guestAccessExpiresAt`, 24 h); the order stores
 *     only the hash; a mixed cart's two docs share the token
 *   - GET /orders/:id/detail → 200 with the token (header or ?guestAccess=),
 *     404 without, 404 with another order's token, 404 once expired
 *   - GET /orders/track/:orderId → the same slim view with the token
 *   - PATCH /orders/:id/payment and POST /orders/:id/request-counter-payment
 *     accept the token like a scan session (401 without)
 *   - socket: `join { room:'order:<id>', guestAccess }` lets the guest hear
 *     order:updated; a plain join or a wrong token hears nothing
 *   - staff, logged-in customers and scan-session guests are untouched; a
 *     tenant WITH tables issues no token
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const { normaliseProfile } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { hashGuestAccessToken, GUEST_ACCESS_TTL_MS } = require(path.join(BACKEND, 'utils/guestAccess'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let T;      // token mode (tables.useTables:false), every module on
let W;      // profile WITH tables
let cust;
const sockets = [];

beforeAll(async () => {
    T = await seedTenant({ label: 'ga-tok' });
    await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { operations: normaliseProfile({ answers: { useTables: false } }) } });
    W = await seedTenant({ label: 'ga-tab' });
    await Restaurant.updateOne({ _id: W.restaurant._id }, { $set: { operations: normaliseProfile({ answers: { useTables: true } }) } });
    cust = await createCustomer('ga', { phone: '9444444444' });
});

afterAll(() => {
    for (const s of sockets) s.close();
});

const dineInTotal = (t, items) => computeBill({
    subtotal: items.reduce((s, i) => s + i.price * i.quantity, 0),
    taxConfig: toTaxConfig(t.settings.taxes),
    orderType: 'dine-in',
}).total;

/** A dine-in order WITHOUT a table (the counter-QR cart). */
function placeTokenOrder(client, t, { lines = [{ item: 'paneer', price: 200, quantity: 2 }], ...extra } = {}) {
    return client.post('/orders').send({
        type: 'dine-in',
        items: lines.map((l) => ({ menuItem: String(t.items[l.item]._id), quantity: l.quantity })),
        total: dineInTotal(t, lines),
        clientIdempotencyKey: `idem_${rid()}${rid()}`,
        ...extra,
    });
}

/** Guest client with the guest access header on top of the tenant slug. */
const guestWith = (t, token) => {
    const base = ctx.api.guest(t);
    const wrap = (method) => (p) => (token ? base[method](p).set('X-Guest-Access', token) : base[method](p));
    return { get: wrap('get'), post: wrap('post'), patch: wrap('patch') };
};

const expireAccess = (orderId) => Order.updateOne({ _id: orderId }, { $set: { 'guestAccess.expiresAt': new Date(Date.now() - 1000) } });

describe('create: the guest counter order gets an access token', () => {
    test('201 carries guestAccessToken once; the order keeps only its hash + 24 h expiry', async () => {
        const before = Date.now();
        const res = await placeTokenOrder(ctx.api.guest(T), T);
        expect(res.status).toBe(201);
        expect(res.body.order.tokenNumber).toMatch(/^T-\d{3,}$/);
        const token = res.body.guestAccessToken;
        expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        const exp = new Date(res.body.guestAccessExpiresAt).getTime();
        expect(exp - before).toBeGreaterThan(GUEST_ACCESS_TTL_MS - 60_000);
        expect(exp - before).toBeLessThanOrEqual(GUEST_ACCESS_TTL_MS + 60_000);

        const stored = await Order.findById(res.body.order._id).lean();
        expect(stored.scanSessionId).toBeNull();
        expect(stored.guestAccess.tokenHash).toBe(hashGuestAccessToken(token));
        expect(new Date(stored.guestAccess.expiresAt).getTime()).toBe(exp);
        expect(JSON.stringify(stored)).not.toContain(token);           // raw token is never persisted
        // and never in the order payload of the response either
        expect(JSON.stringify(res.body.order)).not.toContain(token);
    });

    test('a mixed cart (kitchen + counter items) shares one token across both docs', async () => {
        const res = await placeTokenOrder(ctx.api.guest(T), T, {
            lines: [{ item: 'paneer', price: 200, quantity: 1 }, { item: 'naan', price: 40, quantity: 1 }],
        });
        // naan is a kitchen item in the seed → may or may not split; the
        // test only asserts that EVERY doc of the checkout shares the hash.
        expect(res.status).toBe(201);
        const token = res.body.guestAccessToken;
        expect(token).toBeTruthy();
        const docs = await Order.find({ $or: [{ _id: res.body.order._id }, { splitParent: res.body.order._id }] }).lean();
        expect(docs.length).toBeGreaterThanOrEqual(1);
        for (const d of docs) expect(d.guestAccess.tokenHash).toBe(hashGuestAccessToken(token));
    });

    test('no token for: a logged-in customer, staff, a guest WITH a scan session, or a tenant with tables', async () => {
        const own = await placeTokenOrder(ctx.api.as(cust, T), T);
        expect(own.status).toBe(201);
        expect(own.body.guestAccessToken).toBeUndefined();
        expect((await Order.findById(own.body.order._id).lean()).guestAccess?.tokenHash).toBeUndefined();

        const staff = await placeTokenOrder(ctx.api.as(T.users.admin, T), T);
        expect(staff.status).toBe(201);
        expect(staff.body.guestAccessToken).toBeUndefined();

        // an old table QR scan still lends its session → that is the proof, no token
        const table = await createTable(T);
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        const scanned = await placeTokenOrder(ctx.api.guest(T, scanToken), T);
        expect(scanned.status).toBe(201);
        expect(scanned.body.guestAccessToken).toBeUndefined();
        expect((await Order.findById(scanned.body.order._id).lean()).scanSessionId).toBe(sessionId);

        // tenant with tables: guest dine-in without a table is refused as before
        const refused = await placeTokenOrder(ctx.api.guest(W), W);
        expect(refused.status).toBe(400);
        expect(refused.body.guestAccessToken).toBeUndefined();
        const wTable = await createTable(W);
        const wScan = await scanTable(ctx.api, wTable);
        const tableOrder = await placeTokenOrder(ctx.api.guest(W, wScan.scanToken), W, { tableId: String(wTable._id) });
        expect(tableOrder.status).toBe(201);
        expect(tableOrder.body.guestAccessToken).toBeUndefined();
        expect((await Order.findById(tableOrder.body.order._id).lean()).guestAccess?.tokenHash).toBeUndefined();
    });
});

describe('GET /orders/:id/detail', () => {
    let order;
    let token;
    beforeAll(async () => {
        const res = await placeTokenOrder(ctx.api.guest(T), T);
        order = res.body.order;
        token = res.body.guestAccessToken;
    });

    test('200 with the token (header or query, by _id or orderId); the payload is the customer detail', async () => {
        const byHeader = await guestWith(T, token).get(`/orders/${order._id}/detail`);
        expect(byHeader.status).toBe(200);
        expect(byHeader.body.order).toMatchObject({ orderId: order.orderId, tokenNumber: order.tokenNumber, status: 'new' });
        const byQuery = await ctx.api.guest(T).get(`/orders/${order.orderId}/detail?guestAccess=${token}`);
        expect(byQuery.status).toBe(200);
        expect(byQuery.body.order.orderId).toBe(order.orderId);
        // the hash never travels back
        expect(JSON.stringify(byHeader.body)).not.toContain('tokenHash');
    });

    test('404 without a token, with a malformed one, with another order\'s token, and on another tenant', async () => {
        expect((await ctx.api.guest(T).get(`/orders/${order._id}/detail`)).status).toBe(404);
        expect((await guestWith(T, 'not-a-token').get(`/orders/${order._id}/detail`)).status).toBe(404);
        const other = await placeTokenOrder(ctx.api.guest(T), T);
        expect((await guestWith(T, other.body.guestAccessToken).get(`/orders/${order._id}/detail`)).status).toBe(404);
        expect((await guestWith(W, token).get(`/orders/${order._id}/detail`)).status).toBe(404);
    });

    test('expired → 404; staff still read it; a logged-in customer holding the token may too', async () => {
        const staff = await ctx.api.as(T.users.admin, T).get(`/orders/${order._id}/detail`);
        expect(staff.status).toBe(200);
        const custWithToken = await ctx.api.as(cust, T).get(`/orders/${order._id}/detail`).set('X-Guest-Access', token);
        expect(custWithToken.status).toBe(200);
        const custWithout = await ctx.api.as(cust, T).get(`/orders/${order._id}/detail`);
        expect(custWithout.status).toBe(404);

        const res = await placeTokenOrder(ctx.api.guest(T), T);
        await expireAccess(res.body.order._id);
        expect((await guestWith(T, res.body.guestAccessToken).get(`/orders/${res.body.order._id}/detail`)).status).toBe(404);
        expect((await ctx.api.as(T.users.admin, T).get(`/orders/${res.body.order._id}/detail`)).status).toBe(200);
    });
});

describe('GET /orders/track/:orderId', () => {
    test('the slim tracking view with the token; 404 without / wrong / expired; kiosk tokens unchanged', async () => {
        const res = await placeTokenOrder(ctx.api.guest(T), T);
        const { order } = res.body;
        const token = res.body.guestAccessToken;
        const ok = await guestWith(T, token).get(`/orders/track/${order.orderId}`);
        expect(ok.status).toBe(200);
        expect(ok.body.order).toMatchObject({ orderId: order.orderId, status: 'new', paymentStatus: 'Pending', tokenNumber: order.tokenNumber, type: 'dine-in' });
        expect(ok.body.order).not.toHaveProperty('items');
        expect(ok.body.order).not.toHaveProperty('phone');
        expect((await ctx.api.guest(T).get(`/orders/track/${order.orderId}?guestAccess=${token}`)).status).toBe(200);

        expect((await ctx.api.guest(T).get(`/orders/track/${order.orderId}`)).status).toBe(404);
        const other = await placeTokenOrder(ctx.api.guest(T), T);
        expect((await guestWith(T, other.body.guestAccessToken).get(`/orders/track/${order.orderId}`)).status).toBe(404);
        // no tenant context at all: refused before the handler (TENANT_REQUIRED) — never 200
        const noTenant = await ctx.api.anon().get(`/orders/track/${order.orderId}`).set('X-Guest-Access', token);
        expect([400, 404]).toContain(noTenant.status);
        await expireAccess(order._id);
        expect((await guestWith(T, token).get(`/orders/track/${order.orderId}`)).status).toBe(404);
    });
});

describe('customer pay endpoints', () => {
    test('PATCH /orders/:id/payment and POST /orders/:id/request-counter-payment accept the token; 401 without', async () => {
        const res = await placeTokenOrder(ctx.api.guest(T), T);
        const { order } = res.body;
        const token = res.body.guestAccessToken;

        const noToken = await ctx.api.guest(T).patch(`/orders/${order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(noToken.status).toBe(401);
        expect(noToken.body.code).toBe('SCAN_TOKEN_REQUIRED');

        const other = await placeTokenOrder(ctx.api.guest(T), T);
        const wrong = await guestWith(T, other.body.guestAccessToken).patch(`/orders/${order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(wrong.status).toBe(401);
        expect(wrong.body.code).toBe('GUEST_ACCESS_INVALID');

        const intent = await guestWith(T, token).patch(`/orders/${order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(intent.status).toBe(200);

        const counter = await guestWith(T, token).post(`/orders/${order._id}/request-counter-payment`).send({});
        expect(counter.status).toBe(200);
        expect((await Order.findById(order._id).lean()).counterPaymentRequestedAt).toBeTruthy();
        expect((await ctx.api.guest(T).post(`/orders/${other.body.order._id}/request-counter-payment`).send({})).status).toBe(401);

        await expireAccess(order._id);
        const expired = await guestWith(T, token).patch(`/orders/${order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(expired.status).toBe(401);
        expect(expired.body.code).toBe('GUEST_ACCESS_EXPIRED');
    });
});

describe('socket order room', () => {
    function connect(auth = {}) {
        return new Promise((resolve, reject) => {
            const socket = connectClient(ctx.baseUrl, { auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
            sockets.push(socket);
            socket.on('connect', () => resolve(socket));
            socket.on('connect_error', reject);
        });
    }
    const recorder = (socket) => { const ev = []; socket.onAny((event, payload) => ev.push({ event, payload })); return ev; };
    const waitFor = (events, pred, ms = 3000) => new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const hit = events.find(pred);
            if (hit) return resolve(hit);
            if (Date.now() - started > ms) return reject(new Error(`event not received; got ${JSON.stringify(events.map((e) => e.event))}`));
            return setTimeout(tick, 25);
        };
        tick();
    });

    test('join { room, guestAccess } hears order:updated; a bare join, a wrong token or another order\'s room hears nothing', async () => {
        const res = await placeTokenOrder(ctx.api.guest(T), T);
        const { order } = res.body;
        const token = res.body.guestAccessToken;
        const other = await placeTokenOrder(ctx.api.guest(T), T);

        const withToken = recorder(await connect());
        sockets[sockets.length - 1].emit('join', { room: `order:${order.orderId}`, guestAccess: token });
        const bare = recorder(await connect());
        sockets[sockets.length - 1].emit('join', `order:${order.orderId}`);
        const wrong = recorder(await connect());
        sockets[sockets.length - 1].emit('join', { room: `order:${order.orderId}`, guestAccess: other.body.guestAccessToken });
        const elsewhere = recorder(await connect());
        sockets[sockets.length - 1].emit('join', { room: `order:${other.body.order.orderId}`, guestAccess: token });
        await sleep(300);

        const upd = await ctx.api.as(T.users.admin, T).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        expect(upd.status).toBe(200);
        const hit = await waitFor(withToken, (e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId);
        expect(hit.payload.status).toBe('preparing');
        await settle(400);
        for (const ev of [bare, wrong, elsewhere]) {
            expect(JSON.stringify(ev)).not.toContain(order.orderId);
        }
    });
});
