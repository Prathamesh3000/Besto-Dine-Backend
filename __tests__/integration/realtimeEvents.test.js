/**
 * 5.5 / 5.6 end-to-end realtime checks with real socket.io clients against
 * the real app (complements realtime.test.js, which covers order:new
 * tenant isolation, cross-tenant joins, scan-token guests and revoked
 * tokens):
 *
 *   - handshake: expired access token → AUTH_EXPIRED; a scan / kiosk
 *     token presented as the access token connects as an anonymous guest
 *   - status change / payment / counter-payment / refund events reach
 *     only the owning tenant + branch rooms and the owning customer —
 *     never another customer, another branch's pinned staff or tenant B
 *   - order:<id> room joins: owner / same scan session only
 *   - sweepers against real Mongo: emptyOrderSweeper cancels only the
 *     unpaid empty orders of the swept tenant, frees the table and kicks
 *     the table guest; staleOrderSweeper alerts only the owning admin
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { signTypedToken, TOKEN_TYPES } = require(path.join(BACKEND, 'middlewares/authMiddleware'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
const { runEmptyOrderSweep } = require(path.join(BACKEND, 'utils/emptyOrderSweeper'));
const { runStaleOrderScan } = require(path.join(BACKEND, 'utils/staleOrderSweeper'));

const ctx = useIntegrationApp();
let A;
let B;
let A2;            // second branch of tenant A
let chefA2;        // chef pinned to A2
let cust1;
let cust2;
const sockets = [];
let seq = 0;
const oid = (p) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

beforeAll(async () => {
    A = await seedTenant({ label: 'rte-a' });
    B = await seedTenant({ label: 'rte-b' });
    A2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    chefA2 = await createUser({
        name: 'chef a2', email: `chef.a2.${A.slug}@staff.test`, role: 'chef',
        restaurant: A.restaurant._id, branch: A2._id, permissions: defaultPermissionsForRole('chef'),
    });
    cust1 = await createCustomer('rte1');
    cust2 = await createCustomer('rte2');
});

afterAll(() => {
    for (const s of sockets) s.close();
});

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mentions = (events, orderId) => JSON.stringify(events).includes(orderId);

/** Connect the standard audience and return { name: events[] }. */
async function audience() {
    const who = {
        adminA: { token: A.users.admin.token },
        chefA: { token: A.users.chef.token },
        waiterA: { token: A.users.waiter.token },
        captainA: { token: A.users.captain.token },
        chefA2: { token: chefA2.token },
        adminB: { token: B.users.admin.token },
        chefB: { token: B.users.chef.token },
        cust1: { token: cust1.token },
        cust2: { token: cust2.token },
    };
    const out = {};
    for (const [k, auth] of Object.entries(who)) out[k] = recorder(await connect(auth));
    await sleep(100);
    return out;
}

async function customerOrder(t, user, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: oid('RTE'),
        type: 'takeaway',
        user: user ? user._id : null,
        customerName: user ? user.name : 'Guest',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1 }],
        total: 210,
        ...fields,
    });
    return doc.toObject();
}

// ── Handshake ──────────────────────────────────────────────────────────
describe('socket handshake', () => {
    test('expired access token → connect_error AUTH_EXPIRED', async () => {
        const expired = jwt.sign(
            { id: String(A.users.admin._id), role: 'admin', typ: 'user', tv: 0, exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET,
        );
        await expect(connect({ token: expired })).rejects.toThrow(/AUTH_EXPIRED/);
    });

    test.each([
        ['scan token', () => signTypedToken(TOKEN_TYPES.SCAN, { tableId: String(A.tables.main._id), restaurantId: String(A.restaurant._id), sessionId: 'x' }, { expiresIn: '1h' })],
        ['kiosk token', () => signTypedToken(TOKEN_TYPES.KIOSK, { kind: 'kiosk-track', orderId: 'X', restaurant: String(A.restaurant._id) }, { expiresIn: '1h' })],
        ['garbage', () => 'not-a-jwt'],
    ])('a %s presented as the access token connects with no staff identity', async (_l, mk) => {
        const s = await connect({ token: mk() });
        const ev = recorder(s);
        const order = await customerOrder(A, null);
        await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        await sleep(600);
        expect(mentions(ev, order.orderId)).toBe(false);
    });
});

// ── Order events ───────────────────────────────────────────────────────
describe('order events reach only the right tenant, branch and customer', () => {
    test('status change → branch staff + owning customer; not other branch / other customer / tenant B', async () => {
        const ev = await audience();
        const order = await customerOrder(A, cust1);
        const res = await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        expect(res.status).toBe(200);
        const isUpd = (e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId;
        await waitFor(ev.adminA, isUpd);
        await waitFor(ev.chefA, isUpd);
        await waitFor(ev.waiterA, isUpd);
        await waitFor(ev.cust1, isUpd);
        // customer bell toast for "Preparing"
        await waitFor(ev.cust1, (e) => e.event === 'notification:new' && /being prepared/.test(e.payload?.description || ''));

        const ready = await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'ready' });
        expect(ready.status).toBe(200);
        const isReady = (e) => e.event === 'order:ready' && e.payload?.orderId === order.orderId;
        await waitFor(ev.waiterA, isReady);
        await waitFor(ev.cust1, isReady);

        await sleep(500);
        for (const k of ['chefA2', 'adminB', 'chefB', 'cust2']) {
            expect({ k, leaked: mentions(ev[k], order.orderId) }).toEqual({ k, leaked: false });
        }
        // the updated payload carries no customer PII
        const p = ev.adminA.find(isUpd).payload;
        expect(Object.keys(p).sort()).toEqual(['orderId', 'paymentStatus', 'status']);
    });

    test('payment confirmation → admin + owning customer only', async () => {
        const ev = await audience();
        const order = await customerOrder(A, cust1, { status: 'served' });
        const res = await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 210 });
        expect(res.status).toBe(200);
        await waitFor(ev.adminA, (e) => e.event === 'notification:new' && (e.payload?.description || '').includes(order.orderId));
        await waitFor(ev.cust1, (e) => e.event === 'notification:new' && /Payment of ₹\d/.test(e.payload?.description || ''));
        await sleep(500);
        for (const k of ['chefA2', 'adminB', 'chefB', 'cust2']) {
            expect({ k, leaked: mentions(ev[k], order.orderId) }).toEqual({ k, leaked: false });
        }
        expect(ev.cust2.some((e) => /Payment of/.test(e.payload?.description || ''))).toBe(false);
    });

    test('counter-payment request → admin + captain of A; not other customer / tenant B', async () => {
        const ev = await audience();
        const table = await createTable(A);
        const order = await customerOrder(A, cust1, { type: 'dine-in', table: table._id, status: 'served' });
        const res = await ctx.api.as(cust1, A).post(`/orders/${order._id}/request-counter-payment`).send({});
        expect(res.status).toBe(200);
        const isCp = (e) => e.event === 'counter-payment:requested' && e.payload?.orderId === order.orderId;
        await waitFor(ev.adminA, isCp);
        await waitFor(ev.captainA, isCp);
        await sleep(500);
        for (const k of ['chefA2', 'adminB', 'chefB', 'cust2']) {
            expect({ k, leaked: mentions(ev[k], order.orderId) }).toEqual({ k, leaked: false });
        }
        expect(ev.chefA.some(isCp)).toBe(false);
    });

    test('a guest cannot request counter payment for another tenant\'s order by id', async () => {
        const order = await customerOrder(A, cust1, { status: 'served' });
        const res = await ctx.api.guest(B).post(`/orders/${order._id}/request-counter-payment`).send({});
        expect(res.status).toBe(404);
    });

    test('refund → admin + owning customer + order room; never the other customer or tenant B', async () => {
        const ev = await audience();
        const order = await customerOrder(A, cust1, {
            status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 210, paidAt: new Date(),
        });
        const res = await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(order._id), amount: 50, reason: 'cold' });
        expect(res.status).toBe(200);
        await waitFor(ev.adminA, (e) => e.event === 'notification:new' && /Refund Processed/.test(e.payload?.title || ''));
        await waitFor(ev.cust1, (e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId);
        await sleep(500);
        for (const k of ['chefA2', 'adminB', 'chefB', 'cust2']) {
            expect({ k, leaked: mentions(ev[k], order.orderId) }).toEqual({ k, leaked: false });
        }
    });
});

// ── order:<id> room joins ─────────────────────────────────────────────
describe('order room joins', () => {
    test('owner may join, another customer may not; only the owner gets per-order events', async () => {
        const order = await customerOrder(A, cust1);
        const s1 = await connect({ token: cust1.token });
        const s2 = await connect({ token: cust2.token });
        const e1 = recorder(s1);
        const e2 = recorder(s2);
        s1.emit('join', `order:${order.orderId}`);
        s2.emit('join', `order:${order.orderId}`);
        await sleep(300);
        await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        await waitFor(e1, (e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId);
        await sleep(500);
        expect(mentions(e2, order.orderId)).toBe(false);
    });

    test('guest: same scan session joins its order room; another party at the same table does not', async () => {
        const table = await createTable(A);
        const g1 = await scanTable(ctx.api, table);
        const order = await customerOrder(A, null, { type: 'dine-in', table: table._id, scanSessionId: g1.sessionId });
        const g2 = await scanTable(ctx.api, table);
        expect(g2.sessionId).toBeTruthy();
        expect(g2.sessionId).not.toBe(g1.sessionId);
        const s1 = await connect({ scanToken: g1.scanToken });
        const s2 = await connect({ scanToken: g2.scanToken });
        const e1 = recorder(s1);
        const e2 = recorder(s2);
        s1.emit('join', `order:${order.orderId}`);
        s2.emit('join', `order:${order.orderId}`);
        await sleep(300);
        await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        await waitFor(e1, (e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId);
        await sleep(500);
        expect(e2.some((e) => e.event === 'order:updated' && e.payload?.orderId === order.orderId)).toBe(false);
    });

    test('a tenant B staff socket cannot join a tenant A order room', async () => {
        const order = await customerOrder(A, cust1);
        const s = await connect({ token: B.users.admin.token });
        const ev = recorder(s);
        s.emit('join', `order:${order.orderId}`);
        await sleep(300);
        await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        await sleep(700);
        expect(mentions(ev, order.orderId)).toBe(false);
    });
});

// ── Sweepers against real Mongo ───────────────────────────────────────
describe('sweepers (real Mongo)', () => {
    const age = (Model, id, minutes) => Model.collection.updateOne(
        { _id: id }, { $set: { updatedAt: new Date(Date.now() - minutes * 60 * 1000) } },
    );

    test('emptyOrderSweeper: cancels only unpaid empty orders of the swept tenant, frees the table, kicks only that table guest', async () => {
        const tA = await createTable(A);
        const tB = await createTable(B);
        const gA = await scanTable(ctx.api, tA);
        const gB = await scanTable(ctx.api, tB);
        const sA = await connect({ scanToken: gA.scanToken });
        const sB = await connect({ scanToken: gB.scanToken });
        const adminA = await connect({ token: A.users.admin.token });
        const evA = recorder(sA);
        const evB = recorder(sB);
        const evAdmin = recorder(adminA);

        const mk = (t, fields) => Order.create({
            restaurant: t.restaurant._id, branch: t.branch._id, orderId: oid('SW'), type: 'dine-in', items: [], total: 0, ...fields,
        });
        const orphanA = await mk(A, { table: tA._id });
        const paidEmptyA = await mk(A, { paymentStatus: 'Paid', amountPaid: 100 });
        const partialEmptyA = await mk(A, { paymentStatus: 'Partially Paid', amountPaid: 10 });
        const withItemsA = await mk(A, { items: [{ name: 'X', price: 10, quantity: 1 }], total: 10 });
        const freshA = await mk(A, {});
        const orphanB = await mk(B, { table: tB._id });
        await Table.updateOne({ _id: tA._id }, { $set: { status: 'occupied', activeOrder: orphanA._id } });
        await Table.updateOne({ _id: tB._id }, { $set: { status: 'occupied', activeOrder: orphanB._id } });
        for (const o of [orphanA, paidEmptyA, partialEmptyA, withItemsA, orphanB]) await age(Order, o._id, 45);
        await age(Order, freshA._id, 10);

        const r = await runEmptyOrderSweep({ restaurant: A.restaurant });
        expect(r.cancelled).toBe(1);
        expect(r.freedTables).toBeGreaterThanOrEqual(1);

        const st = async (o) => (await Order.findById(o._id).lean()).status;
        expect(await st(orphanA)).toBe('cancelled');
        const cancelled = await Order.findById(orphanA._id).lean();
        expect(cancelled.cancelReason).toBe('auto-sweeper');
        for (const o of [paidEmptyA, partialEmptyA, withItemsA, freshA, orphanB]) expect(await st(o)).toBe('new');
        expect((await Table.findById(tA._id).lean()).status).toBe('free');
        expect((await Table.findById(tB._id).lean()).status).toBe('occupied');

        await waitFor(evA, (e) => e.event === 'session:ended' && e.payload?.tableId === String(tA._id));
        await waitFor(evAdmin, (e) => e.event === 'table:updated' && String(e.payload?.tableId) === String(tA._id));
        await sleep(300);
        expect(evB.some((e) => e.event === 'session:ended')).toBe(false);

        // idempotent re-run
        const again = await runEmptyOrderSweep({ restaurant: A.restaurant });
        expect(again.cancelled).toBe(0);
    });

    test('staleOrderSweeper: alerts only the owning tenant admin with its own order ids', async () => {
        const adminA = recorder(await connect({ token: A.users.admin.token }));
        const adminB = recorder(await connect({ token: B.users.admin.token }));
        const stale = await customerOrder(A, null, { status: 'ready' });
        await age(Order, stale._id, 7 * 60);
        const r = await runStaleOrderScan();
        expect(r.count).toBeGreaterThanOrEqual(1);
        const hit = await waitFor(adminA, (e) => e.event === 'stale-orders:detected' && (e.payload?.orderIds || []).includes(stale.orderId));
        expect(hit.payload.restaurant).toBe(String(A.restaurant._id));
        expect((await Order.findById(stale._id).lean()).status).toBe('ready'); // observe-only
        await sleep(300);
        expect(mentions(adminB, stale.orderId)).toBe(false);
    });
});
