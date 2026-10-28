/**
 * Freeing a table signs the diners seated there out.
 *
 *   - Guests: the scan token (X-Scan-Token) is revoked by Table.sessionEpoch
 *     -> 401 TABLE_SESSION_ENDED on their next request; a fresh re-scan works.
 *   - Logged-in customers (seated or owning an open order): tokenVersion is
 *     bumped -> access token 401 SESSION_REVOKED, refresh token refused.
 *     Staff are never touched.
 *   - `session:ended` is pushed to the table room and the customer's room.
 *   - POST /tables/free-all frees every table in the caller's scope.
 *
 * Real app + in-memory Mongo + real socket.io clients.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const {
    seedTenant, createTable, createCustomer, createUser, DEFAULT_PASSWORD,
} = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const User = require(path.join(BACKEND, 'models/user'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { normaliseProfile } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const sockets = [];
afterAll(() => { for (const s of sockets) s.close(); });

// ── helpers ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Scan-token iat is whole seconds: wait into the next second so a later reset is strictly newer. */
const crossSecond = () => sleep(1050 - (Date.now() % 1000));

const cart = (t) => [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }];
const cartTotal = (t) => computeBill({ subtotal: 200, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;
const body = (t, table) => ({ type: 'dine-in', tableId: String(table._id), items: cart(t), total: cartTotal(t) });

const guestOrder = (t, table, scanToken) => ctx.api.guest(t, scanToken).post('/orders').send(body(t, table));
const customerOrder = (t, user, table, scanToken) => ctx.api.customerAtTable(user, t, scanToken).post('/orders').send(body(t, table));
const claim = (t, user, table, scanToken) => ctx.api.customerAtTable(user, t, scanToken).post(`/tables/${table._id}/claim`).send({});
const probe = (t, table, scanToken) => ctx.api.guest(t, scanToken).get(`/requests/active/table/${table._id}`);

const seatsOf = async (id) => (await Table.findById(id).select('+seats').lean()).seats || [];

async function customerLogin(user) {
    const res = await ctx.api.anon().post('/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
    expect(res.status).toBe(200);
    return { token: res.body.token, refreshToken: res.body.refreshToken };
}
const refresh = (refreshToken) => ctx.api.anon().post('/auth/refresh').send({ refreshToken });

function connect(auth) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, {
            auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}
function recorder(socket) {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
}
const waitFor = async (events, pred, ms = 3000) => {
    const started = Date.now();
    for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - started > ms) throw new Error(`event not received; got ${JSON.stringify(events.map((e) => e.event))}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
    }
};

/** A branch-pinned sub-admin (role admin, not the tenant owner). */
const subAdmin = (t, branchId, tag) => createUser({
    name: `sub ${tag}`, email: `sub.${tag}.${t.slug}@staff.test`, role: 'admin',
    restaurant: t.restaurant._id, branch: branchId, isTenantOwner: false, permissions: {},
});
const manager = (t) => createUser({
    name: 'mgr', email: `mgr.${t.slug}@staff.test`, role: 'manager',
    restaurant: t.restaurant._id, branch: t.branch._id, permissions: defaultPermissionsForRole('manager'),
});

// ── (a) guest + socket ───────────────────────────────────────────────
describe('freeing one table signs out guests and pushes session:ended', () => {
    let A;
    beforeAll(async () => { A = await seedTenant({ label: 'tfs-a' }); });

    test('stale scan token -> 401 TABLE_SESSION_ENDED; a fresh re-scan works; sockets are told', async () => {
        const table = await createTable(A, { name: 'FS-Guest', capacity: 4 });
        const guest = await scanTable(ctx.api, table);
        expect(guest.res.status).toBe(200);
        expect((await probe(A, table, guest.scanToken)).status).toBe(200);

        const cust = await createCustomer('tfs-sock');
        const tableSock = await connect({ scanToken: guest.scanToken });
        const tableEvents = recorder(tableSock);
        const custSock = await connect({ token: cust.token });
        const custEvents = recorder(custSock);
        // Make the customer a seated diner so their room is addressed.
        expect((await claim(A, cust, table, guest.scanToken)).status).toBe(200);
        await sleep(200);

        await crossSecond();
        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({});
        expect(free.status).toBe(200);
        expect(free.body.customersSignedOut).toBe(1);

        const stale = await probe(A, table, guest.scanToken);
        expect(stale.status).toBe(401);
        expect(stale.body.code).toBe('TABLE_SESSION_ENDED');
        const staleOrder = await guestOrder(A, table, guest.scanToken);
        expect(staleOrder.status).toBe(401);
        expect(staleOrder.body.code).toBe('TABLE_SESSION_ENDED');

        // Fresh scan (also WITH the old token header: scan is exempt) works.
        const again = await scanTable(ctx.api, table, { 'X-Scan-Token': guest.scanToken });
        expect(again.res.status).toBe(200);
        expect((await probe(A, table, again.scanToken)).status).toBe(200);

        const te = await waitFor(tableEvents, (e) => e.event === 'session:ended');
        expect(te.payload).toMatchObject({ reason: 'table-freed', tableId: String(table._id) });
        const ce = await waitFor(custEvents, (e) => e.event === 'session:ended');
        expect(ce.payload.reason).toBe('table-freed');
        await settle();
    });

    test('a token from another, untouched table keeps working', async () => {
        const t1 = await createTable(A, { name: 'FS-Keep1' });
        const t2 = await createTable(A, { name: 'FS-Keep2' });
        const g1 = await scanTable(ctx.api, t1);
        const g2 = await scanTable(ctx.api, t2);
        await crossSecond();
        expect((await ctx.api.as(A.users.admin).post(`/tables/${t1._id}/free`).send({})).status).toBe(200);
        expect((await probe(A, t1, g1.scanToken)).status).toBe(401);
        expect((await probe(A, t2, g2.scanToken)).status).toBe(200);
    });
});

// ── (b) logged-in customers ──────────────────────────────────────────
describe('freeing a table revokes seated customers\' logins (not staff)', () => {
    let A;
    beforeAll(async () => { A = await seedTenant({ label: 'tfs-b' }); });

    test('seated customer: access token -> 401 SESSION_REVOKED, refresh refused, tokenVersion bumped', async () => {
        const table = await createTable(A, { name: 'FS-Cust' });
        const cust = await createCustomer('tfs-b1');
        const { token, refreshToken } = await customerLogin(cust);
        const guest = await scanTable(ctx.api, table);
        expect((await claim(A, token, table, guest.scanToken)).status).toBe(200);
        expect((await ctx.api.as(token).get('/auth/me')).status).toBe(200);

        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({});
        expect(free.status).toBe(200);
        expect(free.body.customersSignedOut).toBe(1);

        const me = await ctx.api.as(token).get('/auth/me');
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('SESSION_REVOKED');
        expect((await refresh(refreshToken)).status).toBe(401);
        expect((await User.findById(cust._id).lean()).tokenVersion).toBe(1);

        // Logging in again works (new tokenVersion).
        const again = await customerLogin(cust);
        expect((await ctx.api.as(again.token).get('/auth/me')).status).toBe(200);
    });

    test('a customer who owns an open order is signed out even though no seat key names them', async () => {
        const table = await createTable(A, { name: 'FS-Owner' });
        const cust = await createCustomer('tfs-b2');
        const guest = await scanTable(ctx.api, table);
        expect((await customerOrder(A, cust, table, guest.scanToken)).status).toBe(201);
        await Table.updateOne({ _id: table._id }, { $set: { seats: [] } });

        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true, reason: 'owner test' });
        expect(free.status).toBe(200);
        expect(free.body.customersSignedOut).toBe(1);
        expect((await ctx.api.as(cust, A).get('/auth/me')).status).toBe(401);
    });

    test('staff tokens are unaffected, even the waiter who placed the order', async () => {
        const table = await createTable(A, { name: 'FS-Staff' });
        expect((await ctx.api.as(A.users.waiter).post('/orders').send(body(A, table))).status).toBe(201);
        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true, reason: 'staff test' });
        expect(free.status).toBe(200);
        expect(free.body.customersSignedOut).toBe(0);
        for (const u of [A.users.admin, A.users.waiter, A.users.captain]) {
            expect((await ctx.api.as(u).get('/auth/me')).status).toBe(200);
            expect((await User.findById(u._id).lean()).tokenVersion || 0).toBe(0);
        }
    });
});

// ── (c) free-all ─────────────────────────────────────────────────────
describe('POST /tables/free-all', () => {
    test('real open bills: 409 preview, then force+reason frees all, cancels orders, revokes every session', async () => {
        const F = await seedTenant({ label: 'tfs-fa' });
        const t1 = await createTable(F, { name: 'FA-1' });
        const t2 = await createTable(F, { name: 'FA-2' });
        const t3 = await createTable(F, { name: 'FA-3' });
        const g1 = await scanTable(ctx.api, t1);
        const g2 = await scanTable(ctx.api, t2);
        await scanTable(ctx.api, t3);
        const c1 = await createCustomer('fa1');
        const c2 = await createCustomer('fa2');
        const l1 = await customerLogin(c1);
        const l2 = await customerLogin(c2);
        // t1: seated customer with a real bill; t2: seated customer, no bill; t3: guest seated.
        expect((await customerOrder(F, l1.token, t1, g1.scanToken)).status).toBe(201);
        expect((await claim(F, l2.token, t2, g2.scanToken)).status).toBe(200);
        const adminApi = ctx.api.as(F.users.admin);

        const preview = await adminApi.post('/tables/free-all').send({});
        expect(preview.status).toBe(409);
        expect(preview.body).toMatchObject({ code: 'ORDER_NOT_EMPTY', tableCount: 1, orderCount: 1, totalAmount: cartTotal(F) });
        // Nothing changed.
        expect((await Table.findById(t1._id).lean()).status).not.toBe('free');
        expect(await seatsOf(t3._id)).toHaveLength(1);
        expect((await ctx.api.as(l1.token).get('/auth/me')).status).toBe(200);

        // force without a reason is refused and also changes nothing.
        for (const reason of [undefined, '', '  ', 'ab']) {
            const r = await adminApi.post('/tables/free-all').send({ force: true, reason });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('REASON_REQUIRED');
        }
        expect(await seatsOf(t3._id)).toHaveLength(1);

        const customerSock = recorder(await connect({ token: l2.token }));
        const guestSock = recorder(await connect({ scanToken: g1.scanToken }));
        await sleep(200);
        await crossSecond();

        const res = await adminApi.post('/tables/free-all').send({ force: true, reason: 'closing the floor' });
        expect(res.status).toBe(200);
        // 3 new tables + the 2 seeded ones.
        expect(res.body).toMatchObject({ success: true, freedTableCount: 5, closedOrderCount: 1, customersSignedOut: 2 });

        const tables = await Table.find({ restaurant: F.restaurant._id }).select('+seats').lean();
        expect(tables).toHaveLength(5);
        tables.forEach((t) => { expect(t.status).toBe('free'); expect(t.seats || []).toHaveLength(0); expect(t.sessionEpoch).toBeTruthy(); });
        const orders = await Order.find({ restaurant: F.restaurant._id }).lean();
        expect(orders).toHaveLength(1);
        expect(orders[0].status).toBe('cancelled');
        expect(orders[0].cancellationReason).toBe('closing the floor');

        for (const l of [l1, l2]) {
            expect((await ctx.api.as(l.token).get('/auth/me')).status).toBe(401);
            expect((await refresh(l.refreshToken)).status).toBe(401);
        }
        expect((await probe(F, t1, g1.scanToken)).body.code).toBe('TABLE_SESSION_ENDED');
        expect((await probe(F, t2, g2.scanToken)).body.code).toBe('TABLE_SESSION_ENDED');

        const ce = await waitFor(customerSock, (e) => e.event === 'session:ended');
        expect(ce.payload.reason).toBe('all-tables-freed');
        const ge = await waitFor(guestSock, (e) => e.event === 'session:ended');
        expect(ge.payload).toMatchObject({ reason: 'all-tables-freed', tableId: String(t1._id) });
        await settle();
    });

    test('no real bills (empty orders only): 200 without force, and empty orders are cancelled', async () => {
        const G = await seedTenant({ label: 'tfs-nb' });
        const t1 = await createTable(G, { name: 'NB-1' });
        const g = await scanTable(ctx.api, t1);
        const cust = await createCustomer('nb');
        expect((await claim(G, cust, t1, g.scanToken)).status).toBe(200);
        await Order.create({
            restaurant: G.restaurant._id, branch: G.branch._id, orderId: `NB-${Date.now()}`, type: 'dine-in',
            table: t1._id, status: 'new', paymentStatus: 'Pending', items: [], total: 0,
        });
        await crossSecond();

        const res = await ctx.api.as(G.users.admin).post('/tables/free-all').send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ freedTableCount: 3, closedOrderCount: 1, customersSignedOut: 1 });
        expect((await probe(G, t1, g.scanToken)).status).toBe(401);
        expect((await ctx.api.as(cust, G).get('/auth/me')).status).toBe(401);

        // Nothing left: still 200 and idempotent.
        const again = await ctx.api.as(G.users.admin).post('/tables/free-all').send({});
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ freedTableCount: 3, closedOrderCount: 0, customersSignedOut: 0 });
    });

    test('manager allowed; waiter and captain 403 and nothing is freed', async () => {
        const R = await seedTenant({ label: 'tfs-role' });
        const t1 = await createTable(R, { name: 'RL-1' });
        const g = await scanTable(ctx.api, t1);
        await crossSecond();
        for (const u of [R.users.waiter, R.users.captain]) {
            const r = await ctx.api.as(u).post('/tables/free-all').send({});
            expect(r.status).toBe(403);
        }
        expect((await probe(R, t1, g.scanToken)).status).toBe(200);
        expect(await seatsOf(t1._id)).toHaveLength(1);

        const mgr = await manager(R);
        const r = await ctx.api.as(mgr).post('/tables/free-all').send({});
        expect(r.status).toBe(200);
        expect((await probe(R, t1, g.scanToken)).status).toBe(401);
    });

    test('branch-pinned admin only affects tables of their own branch', async () => {
        const H = await seedTenant({ label: 'tfs-br' });
        const b2 = await Branch.create({ restaurant: H.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        const tMain = await createTable(H, { name: 'BR-main' });
        const tB2 = await createTable(H, { name: 'BR-b2', branch: b2._id });
        const gMain = await scanTable(ctx.api, tMain);
        const gB2 = await scanTable(ctx.api, tB2);
        await crossSecond();

        const pinned = await subAdmin(H, b2._id, 'b2');
        const res = await ctx.api.as(pinned).post('/tables/free-all').send({});
        expect(res.status).toBe(200);
        expect(res.body.freedTableCount).toBe(1);
        expect((await probe(H, tB2, gB2.scanToken)).status).toBe(401);
        expect((await probe(H, tMain, gMain.scanToken)).status).toBe(200);
        expect(await seatsOf(tMain._id)).toHaveLength(1);
        expect((await Table.findById(tMain._id).lean()).sessionEpoch).toBeFalsy();

        // And the other way round: the main-branch admin leaves branch 2 alone.
        const g2 = await scanTable(ctx.api, tB2);
        await crossSecond();
        const mainPinned = await subAdmin(H, H.branch._id, 'main');
        const res2 = await ctx.api.as(mainPinned).post('/tables/free-all').send({});
        expect(res2.status).toBe(200);
        expect((await probe(H, tMain, gMain.scanToken)).status).toBe(401);
        expect((await probe(H, tB2, g2.scanToken)).status).toBe(200);
    });

    test('tenant isolation: another restaurant\'s tables, seats, customers are untouched', async () => {
        const X = await seedTenant({ label: 'tfs-x' });
        const Y = await seedTenant({ label: 'tfs-y' });
        const tx = await createTable(X, { name: 'ISO-x' });
        const gx = await scanTable(ctx.api, tx);
        const cx = await createCustomer('iso-x');
        const lx = await customerLogin(cx);
        expect((await claim(X, lx.token, tx, gx.scanToken)).status).toBe(200);
        await crossSecond();

        const res = await ctx.api.as(Y.users.admin).post('/tables/free-all').send({ force: true, reason: 'tenant Y close' });
        expect(res.status).toBe(200);
        expect(res.body.freedTableCount).toBe(2); // Y's own seeded tables only
        expect(await seatsOf(tx._id)).toHaveLength(1);
        expect((await Table.findById(tx._id).lean()).sessionEpoch).toBeFalsy();
        expect((await probe(X, tx, gx.scanToken)).status).toBe(200);
        expect((await ctx.api.as(lx.token).get('/auth/me')).status).toBe(200);
    });

    test('a merged group is freed once and every member\'s sessions end', async () => {
        const M = await seedTenant({ label: 'tfs-mg' });
        const m1 = await createTable(M, { name: 'MG-1', capacity: 2 });
        const m2 = await createTable(M, { name: 'MG-2', capacity: 2 });
        expect((await ctx.api.as(M.users.admin).post('/tables/merge').send({ tableIds: [String(m1._id), String(m2._id)] })).status).toBe(200);
        const ga = await scanTable(ctx.api, m1);
        const gb = await scanTable(ctx.api, m2);
        const cust = await createCustomer('mg');
        const lc = await customerLogin(cust);
        expect((await claim(M, lc.token, m1, ga.scanToken)).status).toBe(200);
        await crossSecond();

        const res = await ctx.api.as(M.users.admin).post('/tables/free-all').send({});
        expect(res.status).toBe(200);
        // merged pair (2, each counted once) + the 2 seeded tables
        expect(res.body).toMatchObject({ freedTableCount: 4, customersSignedOut: 1 });
        const group = await Table.find({ _id: { $in: [m1._id, m2._id] } }).select('+seats').lean();
        group.forEach((t) => {
            expect(t.status).toBe('free');
            expect(t.mergedWith || []).toHaveLength(0);
            expect(t.seats || []).toHaveLength(0);
            expect(t.sessionEpoch).toBeTruthy();
        });
        expect((await probe(M, m1, ga.scanToken)).body.code).toBe('TABLE_SESSION_ENDED');
        expect((await probe(M, m2, gb.scanToken)).body.code).toBe('TABLE_SESSION_ENDED');
        expect((await ctx.api.as(lc.token).get('/auth/me')).status).toBe(401);
    });

    test('token-number tenant (tables off) -> 400 TABLES_DISABLED', async () => {
        const K = await seedTenant({ label: 'tfs-tok' });
        await Restaurant.updateOne({ _id: K.restaurant._id }, { $set: { operations: normaliseProfile({ answers: { useTables: false } }) } });
        const res = await ctx.api.as(K.users.admin).post('/tables/free-all').send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TABLES_DISABLED');
    });

    test('disabled tables are skipped', async () => {
        const D = await seedTenant({ label: 'tfs-dis' });
        const t = await createTable(D, { name: 'DIS-1' });
        await Table.updateOne({ _id: t._id }, { $set: { status: 'disabled' } });
        const res = await ctx.api.as(D.users.admin).post('/tables/free-all').send({});
        expect(res.status).toBe(200);
        expect(res.body.freedTableCount).toBe(2);
        expect((await Table.findById(t._id).lean()).status).toBe('disabled');
    });
});

// ── (d) single table: shape + preview unchanged ──────────────────────
describe('POST /tables/:id/free keeps its contract', () => {
    let A;
    beforeAll(async () => { A = await seedTenant({ label: 'tfs-d' }); });

    test('response shape (plus customersSignedOut) and the 409 preview for a real bill', async () => {
        const table = await createTable(A, { name: 'D-1' });
        const g = await scanTable(ctx.api, table);
        const placed = await guestOrder(A, table, g.scanToken);
        expect(placed.status).toBe(201);

        const admin = ctx.api.as(A.users.admin);
        const preview = await admin.post(`/tables/${table._id}/free`).send({});
        expect(preview.status).toBe(409);
        expect(preview.body).toMatchObject({ success: false, code: 'ORDER_NOT_EMPTY', orderCount: 1, totalAmount: cartTotal(A) });
        // The preview must not end anyone's session.
        expect((await probe(A, table, g.scanToken)).status).toBe(200);
        expect((await Table.findById(table._id).lean()).sessionEpoch).toBeFalsy();

        expect((await admin.post(`/tables/${table._id}/free`).send({ force: true })).body.code).toBe('REASON_REQUIRED');
        expect((await ctx.api.as(A.users.captain).post(`/tables/${table._id}/free`).send({ force: true, reason: 'nope nope' })).status).toBe(403);

        await crossSecond();
        const done = await admin.post(`/tables/${table._id}/free`).send({ force: true, reason: 'guest left' });
        expect(done.status).toBe(200);
        expect(done.body).toEqual({
            success: true,
            message: 'Table freed — 1 open order(s) closed',
            freedTableIds: [String(table._id)],
            closedOrderCount: 1,
            customersSignedOut: 0,
        });
        expect((await probe(A, table, g.scanToken)).body.code).toBe('TABLE_SESSION_ENDED');
    });

    test('an empty table frees with the plain shape', async () => {
        const table = await createTable(A, { name: 'D-2' });
        const res = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Table freed', closedOrderCount: 0, customersSignedOut: 0 });
        expect(res.body.freedTableIds).toEqual([String(table._id)]);
    });
});
