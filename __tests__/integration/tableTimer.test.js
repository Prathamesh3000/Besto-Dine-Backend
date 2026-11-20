/**
 * Table timer: starts at the FIRST CONFIRMED order of a table session, is
 * stored as a server timestamp (Table.sessionStartedAt + a TableSession row),
 * is only visible to admin / manager / captain, and stops when the table is
 * released. See docs/TABLE_TIMER.md.
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createUser, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Order = req_('models/order');
const Table = req_('models/table');
const TableSession = req_('models/tableSession');
const { computeBill, toTaxConfig } = req_('utils/billing');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const { startTableTimer } = req_('utils/tableTimer');
const { releaseHeldOrder } = req_('services/orderHoldService');
const { backfillTableTimers } = req_('migrations/backfillTableTimers');

const ctx = useIntegrationApp();
const sockets = [];
afterAll(() => { for (const s of sockets) { try { s.close(); } catch { /* ignore */ } } });

let A;
const rid = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
    A = await seedTenant({ label: 'tt-a' });
    A.users.manager = await createUser({
        name: 'manager tt', email: `manager.${A.slug}@staff.test`, role: 'manager',
        restaurant: A.restaurant._id, branch: A.branch._id, permissions: defaultPermissionsForRole('manager'),
    });
});

const line = (t) => ({ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1, prepStation: 'kitchen' });
async function makeOrder(table, fields = {}) {
    const doc = await Order.create({
        restaurant: A.restaurant._id, branch: A.branch._id, orderId: `TT-${rid()}`,
        type: 'dine-in', table: table._id, items: [line(A)], total: 210, status: 'new', ...fields,
    });
    return doc.toObject();
}
const occupy = (table, order) => Table.updateOne({ _id: table._id }, { $set: { status: 'occupied', activeOrder: order._id } });
const tableOf = (id) => Table.findById(id).select('+sessionStartedAt +tableSession +seats').lean();
const sessionsOf = (table) => TableSession.find({ table: table._id }).sort({ createdAt: 1 }).lean();
const freshTable = () => createTable(A, { name: `TT-${rid()}` });
const admin = () => ctx.api.as(A.users.admin);

const cartTotal = () => computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'dine-in' }).total;
const staffOrder = (user, table) => ctx.api.as(user).post('/orders').send({
    type: 'dine-in', tableId: String(table._id),
    items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: cartTotal(),
});

function connect(auth) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, { auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}
const recorder = (socket) => { const events = []; socket.onAny((event, payload) => events.push({ event, payload })); return events; };
const waitFor = async (events, pred, ms = 3000) => {
    const started = Date.now();
    for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - started > ms) throw new Error(`event not received; got ${JSON.stringify(events.map((e) => e.event))}`);
        await sleep(25);
    }
};

describe('starting', () => {
    test('a staff order with items starts the timer once; the second order does not reset it', async () => {
        const table = await freshTable();
        const before = Date.now();
        const r1 = await staffOrder(A.users.waiter, table);
        expect(r1.status).toBe(201);
        const t1 = await tableOf(table._id);
        expect(t1.sessionStartedAt).toBeInstanceOf(Date);
        expect(t1.sessionStartedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(t1.sessionStartedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        await sleep(40);
        const r2 = await staffOrder(A.users.waiter, table);
        expect(r2.status).toBe(201);
        const t2 = await tableOf(table._id);
        expect(t2.sessionStartedAt.getTime()).toBe(t1.sessionStartedAt.getTime());
        const rows = await sessionsOf(table);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ endedAt: null });
        expect(String(rows[0]._id)).toBe(String(t2.tableSession));
        expect(rows[0].startedAt.getTime()).toBe(t1.sessionStartedAt.getTime());
    });

    test('a bare QR scan (occupied, no order) does not start it', async () => {
        const table = await freshTable();
        const { res } = await scanTable(ctx.api, table, { 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(200);
        const t = await tableOf(table._id);
        expect(t.status).toBe('occupied');
        expect(t.sessionStartedAt || null).toBeNull();
        expect(await sessionsOf(table)).toHaveLength(0);
    });

    test('an order with no items does not start it', async () => {
        const table = await freshTable();
        const o = await makeOrder(table, { items: [], total: 0 });
        await occupy(table, o);
        await startTableTimer(o);
        expect((await tableOf(table._id)).sessionStartedAt || null).toBeNull();
        expect(await sessionsOf(table)).toHaveLength(0);
    });

    test('awaiting-payment does not start it; releaseHeldOrder does, with the release time', async () => {
        const table = await freshTable();
        const o = await makeOrder(table, { status: 'awaiting-payment', holdReleaseStatus: 'new', holdReason: 'online' });
        await occupy(table, o);
        await startTableTimer(o);
        expect((await tableOf(table._id)).sessionStartedAt || null).toBeNull();
        await sleep(60);
        const before = Date.now();
        await releaseHeldOrder(o._id);
        const t = await tableOf(table._id);
        expect(t.sessionStartedAt).toBeInstanceOf(Date);
        expect(t.sessionStartedAt.getTime()).toBeGreaterThanOrEqual(before - 5);
        const released = await Order.findById(o._id).lean();
        expect(Math.abs(t.sessionStartedAt.getTime() - new Date(released.releasedAt).getTime())).toBeLessThan(2000);
    });

    test('concurrent first orders start exactly one session', async () => {
        const table = await freshTable();
        const orders = [];
        for (let i = 0; i < 5; i++) orders.push(await makeOrder(table));
        await occupy(table, orders[0]);
        await Promise.all(orders.map((o) => startTableTimer(o)));
        const rows = await sessionsOf(table);
        expect(rows).toHaveLength(1);
        const t = await tableOf(table._id);
        expect(String(t.tableSession)).toBe(String(rows[0]._id));
    });

    test('a wrong client clock changes nothing; the list returns serverTime', async () => {
        const table = await freshTable();
        const before = Date.now();
        const res = await ctx.api.as(A.users.waiter).post('/orders')
            .set('Date', 'Sat, 01 Jan 2000 00:00:00 GMT').set('X-Client-Time', '2000-01-01T00:00:00Z')
            .send({ type: 'dine-in', tableId: String(table._id), items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: cartTotal(), startedAt: '2000-01-01T00:00:00Z', sessionStartedAt: '2000-01-01T00:00:00Z' });
        expect(res.status).toBe(201);
        const t = await tableOf(table._id);
        expect(t.sessionStartedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
        const list = await admin().get('/tables').set('X-Client-Time', '2000-01-01T00:00:00Z');
        expect(Math.abs(new Date(list.body.serverTime).getTime() - Date.now())).toBeLessThan(5000);
    });
});

describe('cancel', () => {
    test('cancelling the only order clears the timer and marks the session cleared', async () => {
        const table = await freshTable();
        const r = await staffOrder(A.users.waiter, table);
        const orderId = r.body.order._id;
        const res = await admin().patch(`/orders/${orderId}/status`).send({ status: 'cancelled', cancellationReason: 'guest left' });
        expect(res.status).toBe(200);
        await settle();
        const t = await tableOf(table._id);
        expect(t.sessionStartedAt || null).toBeNull();
        expect(t.tableSession || null).toBeNull();
        const [row] = await sessionsOf(table);
        expect(row).toMatchObject({ endReason: 'cleared', durationMinutes: 0 });
        expect(row.endedAt).toBeInstanceOf(Date);
    });

    test('cancelling the first of two keeps the timer; cancelling the last clears it', async () => {
        const table = await freshTable();
        const r1 = await staffOrder(A.users.waiter, table);
        const r2 = await staffOrder(A.users.waiter, table);
        const started = (await tableOf(table._id)).sessionStartedAt;
        await admin().patch(`/orders/${r1.body.order._id}/status`).send({ status: 'cancelled', cancellationReason: 'x1' });
        await settle();
        const mid = await tableOf(table._id);
        expect(mid.sessionStartedAt.getTime()).toBe(started.getTime());
        expect((await sessionsOf(table))[0].endedAt).toBeNull();
        await admin().patch(`/orders/${r2.body.order._id}/status`).send({ status: 'cancelled', cancellationReason: 'x2' });
        await settle();
        expect((await tableOf(table._id)).sessionStartedAt || null).toBeNull();
        expect((await sessionsOf(table))[0].endReason).toBe('cleared');
    });
});

describe('stopping', () => {
    test('payment frees the table and closes the session with endedAt and durationMinutes', async () => {
        const table = await freshTable();
        const r = await staffOrder(A.users.waiter, table);
        const orderId = r.body.order._id;
        const startedAt = new Date(Date.now() - 37 * 60000);
        await TableSession.updateOne({ table: table._id }, { $set: { startedAt } });
        await Table.updateOne({ _id: table._id }, { $set: { sessionStartedAt: startedAt } });
        const res = await admin().patch(`/orders/${orderId}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.status).toBe(200);
        await settle();
        const t = await tableOf(table._id);
        expect(t.status).toBe('free');
        expect(t.sessionStartedAt || null).toBeNull();
        expect(t.tableSession || null).toBeNull();
        const [row] = await sessionsOf(table);
        expect(row.endReason).toBe('paid');
        expect(row.durationMinutes).toBe(37);
        expect(row.endedAt.getTime() - row.startedAt.getTime()).toBeGreaterThanOrEqual(37 * 60000);
        expect(row.orderCount).toBeGreaterThanOrEqual(1);
        expect(String(row.firstOrder)).toBe(String(orderId));
    });

    test('manual free records endReason freed', async () => {
        const table = await freshTable();
        const o = await makeOrder(table, { paymentStatus: 'Paid' });
        await occupy(table, o);
        await startTableTimer(o);
        const res = await ctx.api.as(A.users.captain).post(`/tables/${table._id}/free`).send({});
        expect(res.status).toBe(200);
        const [row] = await sessionsOf(table);
        expect(row.endReason).toBe('freed');
        expect(row.endedAt).toBeInstanceOf(Date);
        expect((await tableOf(table._id)).sessionStartedAt || null).toBeNull();
    });

    test('force-free of an unpaid bill records endReason forced', async () => {
        const table = await freshTable();
        const o = await makeOrder(table);
        await occupy(table, o);
        await startTableTimer(o);
        const res = await admin().post(`/tables/${table._id}/free`).send({ force: true, reason: 'walked out' });
        expect(res.status).toBe(200);
        expect((await sessionsOf(table))[0].endReason).toBe('forced');
    });

    test('a new session after the table is freed gets a new row', async () => {
        const table = await freshTable();
        const o = await makeOrder(table);
        await occupy(table, o);
        await startTableTimer(o);
        await admin().post(`/tables/${table._id}/free`).send({ force: true, reason: 'reset' });
        const o2 = await makeOrder(table);
        await occupy(table, o2);
        await startTableTimer(o2);
        const rows = await sessionsOf(table);
        expect(rows).toHaveLength(2);
        expect(rows[1].endedAt).toBeNull();
    });
});

describe('merge groups', () => {
    test('each member reports the earliest start; paying the group closes ONE session', async () => {
        const a = await freshTable();
        const b = await freshTable();
        const o = await makeOrder(a);
        await Table.updateOne({ _id: a._id }, { $set: { status: 'merged', mergedWith: [b._id], activeOrder: o._id } });
        await Table.updateOne({ _id: b._id }, { $set: { status: 'merged', mergedWith: [a._id] } });
        await startTableTimer(o);
        const early = new Date(Date.now() - 50 * 60000);
        await Table.updateOne({ _id: b._id }, { $set: { sessionStartedAt: early } });
        const list = await admin().get('/tables');
        const byId = new Map(list.body.tables.map((t) => [String(t._id), t]));
        expect(new Date(byId.get(String(a._id)).sessionStartedAt).getTime()).toBe(early.getTime());
        expect(new Date(byId.get(String(b._id)).sessionStartedAt).getTime()).toBe(early.getTime());

        const res = await admin().patch(`/orders/${o._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.status).toBe(200);
        await settle();
        expect(await TableSession.countDocuments({ table: { $in: [a._id, b._id] }, endedAt: { $ne: null } })).toBe(1);
        expect((await tableOf(a._id)).sessionStartedAt || null).toBeNull();
        expect((await tableOf(b._id)).sessionStartedAt || null).toBeNull();
    });
});

describe('visibility', () => {
    const FIELDS = ['sessionStartedAt', 'tableTimer', 'serverTime', 'tableSession'];
    let table;
    beforeAll(async () => {
        table = await freshTable();
        const o = await makeOrder(table);
        await occupy(table, o);
        await startTableTimer(o);
    });
    const find = (body) => body.tables.find((t) => String(t._id) === String(table._id));

    test.each(['admin', 'manager', 'captain'])('%s sees sessionStartedAt, serverTime and tableTimer', async (role) => {
        const res = await ctx.api.as(A.users[role]).get('/tables');
        expect(res.status).toBe(200);
        expect(typeof find(res.body).sessionStartedAt).toBe('string');
        expect(new Date(find(res.body).sessionStartedAt).toISOString()).toBe(find(res.body).sessionStartedAt);
        expect(typeof res.body.serverTime).toBe('string');
        expect(res.body.tableTimer).toEqual({ amberMinutes: 60, redMinutes: 90 });
        expect(find(res.body).tableSession).toBeUndefined();
    });

    test.each(['waiter', 'chef'])('%s sees none of it', async (role) => {
        const res = await ctx.api.as(A.users[role]).get('/tables');
        if (res.status !== 200) return expect([401, 403]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toMatch(/sessionStartedAt|tableTimer|serverTime|tableSession/);
    });

    test('a free table has sessionStartedAt null for privileged roles', async () => {
        const free = await freshTable();
        const res = await admin().get('/tables');
        expect(res.body.tables.find((t) => String(t._id) === String(free._id)).sessionStartedAt).toBeNull();
    });

    test('captain floor-overview and admin bootstrap carry the fields for privileged roles only', async () => {
        const cap = await ctx.api.as(A.users.captain).get('/captain/floor-overview');
        expect(cap.status).toBe(200);
        expect(typeof cap.body.tables.find((t) => String(t._id) === String(table._id)).sessionStartedAt).toBe('string');
        expect(typeof cap.body.serverTime).toBe('string');
        expect(cap.body.tableTimer).toEqual({ amberMinutes: 60, redMinutes: 90 });

        const bs = await admin().get('/admin/bootstrap?sections=tables');
        expect(bs.status).toBe(200);
        expect(typeof bs.body.data.tables.find((t) => String(t._id) === String(table._id)).sessionStartedAt).toBe('string');
        expect(typeof bs.body.serverTime).toBe('string');
        expect(bs.body.tableTimer).toEqual({ amberMinutes: 60, redMinutes: 90 });

        const mgr = await ctx.api.as(A.users.manager).get('/admin/bootstrap?sections=tables,settings');
        expect(mgr.status).toBe(200);
        expect(typeof mgr.body.serverTime).toBe('string');
        expect(mgr.body.data.settings.tableTimer).toEqual({ amberMinutes: 60, redMinutes: 90 });
        expect(typeof mgr.body.data.tables.find((t) => String(t._id) === String(table._id)).sessionStartedAt).toBe('string');
        const mcap = await ctx.api.as(A.users.manager).get('/captain/floor-overview');
        if (mcap.status === 200) expect(typeof mcap.body.serverTime).toBe('string');
        const wb = await ctx.api.as(A.users.waiter).get('/admin/bootstrap?sections=tables');
        if (wb.status === 200) expect(JSON.stringify(wb.body)).not.toMatch(/sessionStartedAt|tableTimer|serverTime|tableSession/);
    });

    test.each(['waiter', 'chef'])('%s gets no tableTimer thresholds from /settings or /admin/bootstrap', async (role) => {
        const st = await ctx.api.as(A.users[role]).get('/settings');
        expect(st.status).toBe(200);
        expect(st.body).not.toHaveProperty('tableTimer');
        const bs = await ctx.api.as(A.users[role]).get('/admin/bootstrap?sections=settings');
        if (bs.status === 200) expect(JSON.stringify(bs.body)).not.toMatch(/tableTimer/);
    });

    test('customers, guests and anonymous callers never get timer fields', async () => {
        const cust = await createCustomer('tt-c');
        const bodies = [];
        const { res: scan, scanToken } = await scanTable(ctx.api, table, { 'X-Restaurant-Slug': A.slug });
        bodies.push(scan.body);
        const avail = await ctx.api.guest(A).get(`/tables/${table._id}/availability`);
        bodies.push(avail.body);
        const claim = await ctx.api.customerAtTable(cust, A, scanToken).post(`/tables/${table._id}/claim`).send({});
        bodies.push(claim.body);
        bodies.push((await ctx.api.as(cust, A).get('/tables/bookable')).body);
        for (const r of [await ctx.api.as(cust, A).get('/tables'), await ctx.api.guest(A).get('/tables'), await ctx.api.anon().get('/tables')]) {
            expect([400, 401, 403]).toContain(r.status);
            bodies.push(r.body);
        }
        for (const b of bodies) for (const f of FIELDS) expect(JSON.stringify(b)).not.toContain(f);
        // and a staff-less token scan on the occupied table
        const again = await scanTable(ctx.api, table, { 'X-Restaurant-Slug': A.slug });
        for (const f of FIELDS) expect(JSON.stringify(again.res.body)).not.toContain(f);
    });
});

describe('realtime', () => {
    test('started and stopped reach admin, manager and captain only, with exact payloads', async () => {
        const rec = {};
        for (const r of ['admin', 'manager', 'captain', 'waiter', 'chef']) rec[r] = recorder(await connect({ token: A.users[r].token }));
        await sleep(150);
        const table = await freshTable();
        const r1 = await staffOrder(A.users.waiter, table);
        const t = await tableOf(table._id);
        for (const r of ['admin', 'manager', 'captain']) {
            const hit = await waitFor(rec[r], (e) => e.event === 'table:timer-started' && e.payload.tableId === String(table._id));
            expect(Object.keys(hit.payload).sort()).toEqual(["at", "restaurant", "startedAt", "tableId"]);
            expect(hit.payload.startedAt).toBe(t.sessionStartedAt.toISOString());
            expect(typeof hit.payload.at).toBe('string');
        }
        await admin().patch(`/orders/${r1.body.order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        for (const r of ['admin', 'manager', 'captain']) {
            const hit = await waitFor(rec[r], (e) => e.event === 'table:timer-stopped' && e.payload.tableId === String(table._id));
            expect(hit.payload).toMatchObject({ tableId: String(table._id), endReason: 'paid' });
            expect(typeof hit.payload.endedAt).toBe('string');
            expect(typeof hit.payload.durationMinutes).toBe('number');
            expect(hit.payload.cleared).toBeUndefined();
        }
        await sleep(200);
        for (const r of ['waiter', 'chef']) {
            expect(rec[r].filter((e) => /^table:timer-/.test(e.event))).toHaveLength(0);
        }
    });

    test('clearing sends stopped with cleared:true', async () => {
        const rec = recorder(await connect({ token: A.users.captain.token }));
        await sleep(150);
        const table = await freshTable();
        const r1 = await staffOrder(A.users.waiter, table);
        await admin().patch(`/orders/${r1.body.order._id}/status`).send({ status: 'cancelled', cancellationReason: 'oops' });
        const hit = await waitFor(rec, (e) => e.event === 'table:timer-stopped' && e.payload.tableId === String(table._id));
        expect(hit.payload).toMatchObject({ cleared: true, endReason: 'cleared', durationMinutes: 0 });
    });
});

describe('settings', () => {
    test('defaults 60/90 are returned by GET /settings', async () => {
        const res = await admin().get('/settings');
        expect(res.status).toBe(200);
        expect(res.body.tableTimer).toEqual({ amberMinutes: 60, redMinutes: 90 });
    });

    test('PATCH /settings/tableTimer saves, the table list returns the tenant thresholds, validation rejects bad input', async () => {
        const ok = await admin().patch('/settings/tableTimer').send({ amberMinutes: 30, redMinutes: 45 });
        expect(ok.status).toBe(200);
        expect(ok.body.tableTimer).toEqual({ amberMinutes: 30, redMinutes: 45 });
        const list = await ctx.api.as(A.users.captain).get('/tables');
        expect(list.body.tableTimer).toEqual({ amberMinutes: 30, redMinutes: 45 });
        expect((await admin().get('/settings')).body.tableTimer).toEqual({ amberMinutes: 30, redMinutes: 45 });

        for (const bad of [{ amberMinutes: 60, redMinutes: 60 }, { amberMinutes: 90, redMinutes: 30 }, { amberMinutes: 0, redMinutes: 10 },
            { amberMinutes: 10, redMinutes: 1441 }, { amberMinutes: 'a', redMinutes: 10 }, { amberMinutes: 5.5, redMinutes: 10 }]) {
            const res = await admin().patch('/settings/tableTimer').send(bad);
            expect(res.status).toBe(400);
            expect(typeof res.body.message).toBe('string');
        }
        const red = await admin().patch('/settings/tableTimer').send({ amberMinutes: 60, redMinutes: 60 });
        expect(red.body.message).toMatch(/greater than/i);
        // unchanged after the rejects
        expect((await admin().get('/settings')).body.tableTimer).toEqual({ amberMinutes: 30, redMinutes: 45 });
    });

    test('PUT /settings accepts tableTimer, rejects red <= amber, and a partial put keeps the other half', async () => {
        const put = await admin().put('/settings').send({ tableTimer: { amberMinutes: 20, redMinutes: 40 } });
        expect(put.status).toBe(200);
        expect(put.body.tableTimer).toEqual({ amberMinutes: 20, redMinutes: 40 });
        const bad = await admin().put('/settings').send({ tableTimer: { amberMinutes: 50, redMinutes: 50 } });
        expect(bad.status).toBe(400);
        const half = await admin().put('/settings').send({ tableTimer: { amberMinutes: 25 } });
        expect(half.status).toBe(200);
        expect(half.body.tableTimer).toEqual({ amberMinutes: 25, redMinutes: 40 });
        const clash = await admin().put('/settings').send({ tableTimer: { amberMinutes: 45 } });
        expect(clash.status).toBe(400);
        await admin().patch('/settings/tableTimer').send({ amberMinutes: 60, redMinutes: 90 });
    });

    test('captains cannot edit the thresholds', async () => {
        const res = await ctx.api.as(A.users.captain).patch('/settings/tableTimer').send({ amberMinutes: 10, redMinutes: 20 });
        expect([401, 403]).toContain(res.status);
    });

    test('customers do not see tableTimer in public settings', async () => {
        const res = await ctx.api.guest(A).get('/settings');
        expect(JSON.stringify(res.body)).not.toContain('tableTimer');
    });
});

describe('backfill', () => {
    test('dry run reports, apply writes the earliest confirmed open order and a session', async () => {
        const table = await freshTable();
        const early = new Date(Date.now() - 80 * 60000);
        const o1 = await makeOrder(table, { createdAt: early });
        await makeOrder(table, { createdAt: new Date(Date.now() - 20 * 60000) });
        await makeOrder(table, { status: 'awaiting-payment', createdAt: new Date(Date.now() - 100 * 60000) });
        await occupy(table, o1);

        const dry = await backfillTableTimers({ apply: false, restaurantId: A.restaurant._id });
        expect(dry.apply).toBe(false);
        expect(dry.planned).toBeGreaterThanOrEqual(1);
        expect((await tableOf(table._id)).sessionStartedAt || null).toBeNull();
        expect(await sessionsOf(table)).toHaveLength(0);

        const done = await backfillTableTimers({ apply: true, restaurantId: A.restaurant._id });
        expect(done.written).toBeGreaterThanOrEqual(1);
        const t = await tableOf(table._id);
        expect(t.sessionStartedAt.getTime()).toBe(early.getTime());
        const rows = await sessionsOf(table);
        expect(rows).toHaveLength(1);
        expect(String(rows[0]._id)).toBe(String(t.tableSession));
        expect(rows[0].orderCount).toBe(2);

        const again = await backfillTableTimers({ apply: true, restaurantId: A.restaurant._id });
        expect(again.written).toBe(0);
        expect(await sessionsOf(table)).toHaveLength(1);
    });
});

