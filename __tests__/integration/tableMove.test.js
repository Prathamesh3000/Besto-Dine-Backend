/**
 * POST /tables/move — move a seated party (all its open orders) from one
 * table to a free one. See docs/MOVE_TABLE.md.
 *
 * Real app + in-memory replica set + real socket.io clients.
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
const Branch = req_('models/branch');
const Request = req_('models/request');
const Restaurant = req_('models/restaurant');
const TenantAudit = req_('models/tenantAudit');
const PrintJob = req_('models/printJob');
const { computeBill, toTaxConfig } = req_('utils/billing');
const { verifyTypedToken, TOKEN_TYPES } = req_('middlewares/authMiddleware');
const { normaliseProfile } = req_('utils/operationsProfile');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const { toPlainText } = req_('utils/receiptRenderer');

const ctx = useIntegrationApp();
const sockets = [];
afterAll(() => { for (const s of sockets) { try { s.close(); } catch { /* ignore */ } } });

let A;
let B;
const rid = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
    A = await seedTenant({ label: 'mv-a' });
    B = await seedTenant({ label: 'mv-b' });
    A.users.manager = await createUser({
        name: 'manager mv', email: `manager.${A.slug}@staff.test`, role: 'manager',
        restaurant: A.restaurant._id, branch: A.branch._id, permissions: defaultPermissionsForRole('manager'),
    });
});

// ── helpers ──────────────────────────────────────────────────────────
const line = (t, extra = {}) => ({
    menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1, prepStation: 'kitchen', ...extra,
});

async function makeOrder(t, table, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `MV-${rid()}`,
        type: 'dine-in',
        table: table._id,
        items: [line(t)],
        total: 210,
        status: 'new',
        ...fields,
    });
    return doc.toObject();
}

/** A fresh pair of tables: `from` occupied with `orders`, `to` free. */
async function seat(t, orderFields = [{}], tableFields = {}) {
    const from = await createTable(t, { name: `F-${rid()}` });
    const to = await createTable(t, { name: `T-${rid()}` });
    const orders = [];
    for (const f of orderFields) orders.push(await makeOrder(t, from, f));
    await Table.updateOne({ _id: from._id }, { $set: { status: 'occupied', activeOrder: orders[0]._id, ...tableFields } });
    return { from, to, orders };
}

const move = (user, body, t = A) => ctx.api.as(user, t).post('/tables/move').send(body);
const admin = () => A.users.admin;
const ids = (from, to, extra = {}) => ({ fromTableId: String(from._id), toTableId: String(to._id), ...extra });
const tableOf = (id) => Table.findById(id).select('+seats +movedSessions').lean();
const orderOf = (id) => Order.findById(id).lean();
const auditRows = (t = A) => TenantAudit.find({ restaurant: t.restaurant._id, action: 'table.move' }).lean();

const cart = (t) => [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }];
const cartTotal = (t) => computeBill({ subtotal: 200, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;
const guestOrder = (t, table, scanToken) => ctx.api.guest(t, scanToken).post('/orders').send({
    type: 'dine-in', tableId: String(table._id), items: cart(t), total: cartTotal(t),
});

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
const recorder = (socket) => {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
};
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

// ── roles ────────────────────────────────────────────────────────────
describe('roles', () => {
    test.each(['admin', 'captain', 'manager'])('%s can move a table', async (role) => {
        const { from, to } = await seat(A);
        const res = await move(A.users[role], ids(from, to));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test.each(['waiter', 'chef'])('%s is refused and nothing changes', async (role) => {
        const { from, to, orders } = await seat(A);
        const res = await move(A.users[role], ids(from, to));
        expect([401, 403]).toContain(res.status);
        expect(String((await orderOf(orders[0]._id)).table)).toBe(String(from._id));
        expect((await tableOf(to._id)).status).toBe('free');
    });

    test('customer and anonymous callers are refused', async () => {
        const { from, to } = await seat(A);
        const cust = await createCustomer('mv-c');
        const asCustomer = await ctx.api.as(cust, A).post('/tables/move').send(ids(from, to));
        expect([401, 403]).toContain(asCustomer.status);
        const guest = await ctx.api.guest(A).post('/tables/move').send(ids(from, to));
        expect([401, 403]).toContain(guest.status);
        const anon = await ctx.api.anon().post('/tables/move').send(ids(from, to));
        expect([400, 401, 403]).toContain(anon.status);
    });
});

// ── happy path ───────────────────────────────────────────────────────
describe('moving a party', () => {
    test('orders keep status, items, kotNo and timestamps; only the table changes', async () => {
        const { from, to, orders } = await seat(A, [
            { status: 'preparing', total: 210 },
            { status: 'ready', total: 105, items: [line(A, { quantity: 2 })] },
            { status: 'served', total: 50, paymentStatus: 'Pending' },
        ]);
        const before = await Promise.all(orders.map((o) => orderOf(o._id)));

        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(200);
        expect(res.body.moved).toMatchObject({
            fromTableId: String(from._id), toTableId: String(to._id),
            fromName: from.name, toName: to.name, orderCount: 3, itemCount: 4, total: 365,
        });
        expect(res.body.moved.orderIds.sort()).toEqual(before.map((o) => o.orderId).sort());

        for (const b of before) {
            const a = await orderOf(b._id);
            expect(String(a.table)).toBe(String(to._id));
            expect(a.status).toBe(b.status);
            expect(a.paymentStatus).toBe(b.paymentStatus);
            expect(a.total).toBe(b.total);
            expect(JSON.stringify(a.items)).toBe(JSON.stringify(b.items));
            expect(a.createdAt).toEqual(b.createdAt);
            expect(a.kotNo).toEqual(b.kotNo);
            expect(a.tableMoves).toHaveLength(1);
            expect(a.tableMoves[0]).toMatchObject({
                fromTableName: from.name, toTableName: to.name, byName: A.users.admin.name,
            });
            expect(String(a.tableMoves[0].fromTable)).toBe(String(from._id));
            expect(String(a.tableMoves[0].toTable)).toBe(String(to._id));
            expect(String(a.tableMoves[0].by)).toBe(String(A.users.admin._id));
            expect(a.tableMoves[0].at).toBeInstanceOf(Date);
        }
        const src = await tableOf(from._id);
        const dst = await tableOf(to._id);
        expect(src.status).toBe('free');
        expect(src.activeOrder == null).toBe(true);
        expect(dst.status).toBe('occupied');
        expect(String(dst.activeOrder)).toBe(String(orders[0]._id));
    });

    test('seats, diner, assigned waiter and alerts travel; the source is cleared', async () => {
        const reqDoc = await Request.create({
            restaurant: A.restaurant._id, branch: A.branch._id, table: (await createTable(A))._id, type: 'waiter',
        });
        const { from, to } = await seat(A, [{}], {
            seats: [{ keys: ['s:sess-1', 'u:abc'], joinedAt: new Date(), lastSeenAt: new Date() }],
            currentDiner: { name: 'Ravi', phone: '99999', isRegistered: false },
            assignedWaiter: A.users.waiter._id,
            alerts: [{ reason: 'Call waiter', type: 'waiter', requestId: reqDoc._id }],
        });
        expect((await move(admin(), ids(from, to))).status).toBe(200);
        const src = await tableOf(from._id);
        const dst = await tableOf(to._id);
        expect(dst.seats).toHaveLength(1);
        expect(dst.seats[0].keys).toEqual(['s:sess-1', 'u:abc']);
        expect(dst.currentDiner.name).toBe('Ravi');
        expect(String(dst.assignedWaiter)).toBe(String(A.users.waiter._id));
        expect(dst.alerts).toHaveLength(1);
        expect(dst.movedSessions.map((m) => m.sessionId)).toContain('sess-1');
        expect(src.seats).toHaveLength(0);
        expect(src.currentDiner.name || '').toBe('');
        expect(src.assignedWaiter == null).toBe(true);
        expect(src.alerts).toHaveLength(0);
        // No session epoch stamped: diners are not signed out.
        expect(src.sessionEpoch == null).toBe(true);
    });

    test('a move can be repeated (A -> B -> C) and history accumulates', async () => {
        const { from, to, orders } = await seat(A);
        const c = await createTable(A, { name: `C-${rid()}` });
        expect((await move(admin(), ids(from, to))).status).toBe(200);
        expect((await move(admin(), ids(to, c))).status).toBe(200);
        const o = await orderOf(orders[0]._id);
        expect(o.tableMoves).toHaveLength(2);
        expect(String(o.table)).toBe(String(c._id));
    });

    test('preview returns the totals and writes nothing', async () => {
        const { from, to, orders } = await seat(A, [{ total: 210 }, { total: 90.5, items: [line(A, { quantity: 3 })] }]);
        const res = await move(admin(), ids(from, to, { preview: true }));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            preview: {
                from: { id: String(from._id), name: from.name },
                to: { id: String(to._id), name: to.name },
                orderCount: 2, itemCount: 4, total: 300.5,
            },
        });
        expect(String((await orderOf(orders[0]._id)).table)).toBe(String(from._id));
        expect((await orderOf(orders[0]._id)).tableMoves).toBeUndefined();
        expect((await tableOf(from._id)).status).toBe('occupied');
        expect((await tableOf(to._id)).status).toBe('free');
        expect(await auditRows().then((r) => r.filter((x) => x.entityId === String(from._id)))).toHaveLength(0);
    });

    test('preview still validates', async () => {
        const { from, to } = await seat(A, [{ bill: { status: 'final' } }]);
        const res = await move(admin(), ids(from, to, { preview: true }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('BILL_FINAL');
    });

    test('closed orders on the source are not moved', async () => {
        const { from, to, orders } = await seat(A, [{ status: 'new' }]);
        const done = await makeOrder(A, from, { status: 'cancelled' });
        expect((await move(admin(), ids(from, to))).status).toBe(200);
        expect(String((await orderOf(done._id)).table)).toBe(String(from._id));
        expect(String((await orderOf(orders[0]._id)).table)).toBe(String(to._id));
    });
});

// ── validation ───────────────────────────────────────────────────────
describe('validation', () => {
    test('bad ids -> 400 VALIDATION', async () => {
        const res = await move(admin(), { fromTableId: 'nope', toTableId: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION');
        const missing = await move(admin(), {});
        expect(missing.status).toBe(400);
    });

    test('unknown table -> 404 TABLE_NOT_FOUND', async () => {
        const { from } = await seat(A);
        const res = await move(admin(), { fromTableId: String(from._id), toTableId: String(new (require('mongoose').Types.ObjectId)()) });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TABLE_NOT_FOUND');
    });

    test('same table -> MOVE_SAME_TABLE', async () => {
        const { from } = await seat(A);
        const res = await move(admin(), ids(from, from));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MOVE_SAME_TABLE');
    });

    test('source not occupied -> 409 SOURCE_NOT_OCCUPIED', async () => {
        const a = await createTable(A);
        const b = await createTable(A);
        const res = await move(admin(), ids(a, b));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_OCCUPIED');
    });

    test('occupied source without any open order -> SOURCE_NOT_OCCUPIED', async () => {
        const { from, to } = await seat(A, [{ status: 'cancelled' }]);
        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_OCCUPIED');
    });

    test.each(['occupied', 'alert'])('destination %s -> DEST_NOT_FREE with its status', async (status) => {
        const { from, to, orders } = await seat(A);
        await Table.updateOne({ _id: to._id }, { $set: { status } });
        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('DEST_NOT_FREE');
        expect(res.body.destinationStatus).toBe(status);
        expect(String((await orderOf(orders[0]._id)).table)).toBe(String(from._id));
    });

    test('destination free but holding an open order -> DEST_NOT_FREE', async () => {
        const { from, to } = await seat(A);
        await makeOrder(A, to, { status: 'new' });
        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('DEST_NOT_FREE');
    });

    test('destination reserved -> DEST_RESERVED', async () => {
        const { from, to } = await seat(A);
        await Table.updateOne({ _id: to._id }, { $set: { status: 'reserved' } });
        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('DEST_RESERVED');
    });

    test('destination disabled / inactive -> DEST_DISABLED', async () => {
        const one = await seat(A);
        await Table.updateOne({ _id: one.to._id }, { $set: { status: 'disabled' } });
        const r1 = await move(admin(), ids(one.from, one.to));
        expect(r1.status).toBe(409);
        expect(r1.body.code).toBe('DEST_DISABLED');
        const two = await seat(A);
        await Table.updateOne({ _id: two.to._id }, { $set: { isActive: false } });
        const r2 = await move(admin(), ids(two.from, two.to));
        expect(r2.status).toBe(409);
        expect(r2.body.code).toBe('DEST_DISABLED');
    });

    test('deleted destination -> TABLE_NOT_FOUND', async () => {
        const { from, to } = await seat(A);
        await Table.updateOne({ _id: to._id }, { $set: { isDeleted: true } });
        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TABLE_NOT_FOUND');
    });

    test('merged source or destination -> TABLE_MERGED "Unmerge tables first"', async () => {
        const m1 = await seat(A);
        const sibling = await createTable(A);
        await Table.updateOne({ _id: m1.from._id }, { $set: { mergedWith: [sibling._id] } });
        const r1 = await move(admin(), ids(m1.from, m1.to));
        expect(r1.status).toBe(409);
        expect(r1.body).toMatchObject({ success: false, code: 'TABLE_MERGED', message: 'Unmerge tables first' });

        const m2 = await seat(A);
        const sib2 = await createTable(A);
        await Table.updateOne({ _id: m2.to._id }, { $set: { status: 'merged', mergedWith: [sib2._id] } });
        await Table.updateOne({ _id: sib2._id }, { $set: { status: 'merged', mergedWith: [m2.to._id] } });
        const r2 = await move(admin(), ids(m2.from, m2.to));
        expect(r2.status).toBe(409);
        expect(r2.body.code).toBe('TABLE_MERGED');

        // a destination that is only listed by ANOTHER table's mergedWith
        const m3 = await seat(A);
        const lister = await createTable(A);
        await Table.updateOne({ _id: lister._id }, { $set: { mergedWith: [m3.to._id] } });
        const r3 = await move(admin(), ids(m3.from, m3.to));
        expect(r3.status).toBe(409);
        expect(r3.body.code).toBe('TABLE_MERGED');
    });

    test('another tenant: cannot move its tables nor onto its tables', async () => {
        const mine = await seat(A);
        const theirs = await seat(B);
        const r1 = await move(admin(), ids(theirs.from, theirs.to));
        expect(r1.status).toBe(404);
        const r2 = await move(admin(), ids(mine.from, theirs.to));
        expect(r2.status).toBe(404);
        expect(r2.body.code).toBe('TABLE_NOT_FOUND');
        expect(String((await orderOf(theirs.orders[0]._id)).table)).toBe(String(theirs.from._id));
        expect(String((await orderOf(mine.orders[0]._id)).table)).toBe(String(mine.from._id));
    });

    test('token-number tenant (tables off) -> 400 TABLES_DISABLED', async () => {
        const K = await seedTenant({ label: 'mv-tok' });
        const { from, to } = await seat(K);
        await Restaurant.updateOne({ _id: K.restaurant._id }, { $set: { operations: normaliseProfile({ answers: { useTables: false } }) } });
        const res = await ctx.api.as(K.users.admin, K).post('/tables/move').send(ids(from, to));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TABLES_DISABLED');
    });
});

// ── branches ─────────────────────────────────────────────────────────
describe('branches', () => {
    let branch2;
    beforeAll(async () => {
        branch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: `second-${rid()}`, isActive: true });
    });

    test('branch-pinned captain cannot move across branches', async () => {
        const { from, to, orders } = await seat(A);
        const other = await createTable(A, { name: `B2-${rid()}`, branch: branch2._id });
        const res = await move(A.users.captain, ids(from, other));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
        // ... nor take a party from another branch
        const foreign = await createTable(A, { name: `B2s-${rid()}`, branch: branch2._id });
        await Table.updateOne({ _id: foreign._id }, { $set: { status: 'occupied' } });
        await makeOrder(A, foreign, { branch: branch2._id });
        const res2 = await move(A.users.captain, ids(foreign, to));
        expect(res2.status).toBe(403);
        expect(res2.body.code).toBe('BRANCH_MISMATCH');
        expect(String((await orderOf(orders[0]._id)).table)).toBe(String(from._id));
    });

    test('an unpinned admin cannot move between branches either', async () => {
        const { from } = await seat(A);
        const other = await createTable(A, { name: `B2u-${rid()}`, branch: branch2._id });
        const res = await move(admin(), ids(from, other));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });
});

// ── billed / paid ────────────────────────────────────────────────────
describe('billed or paid parties are refused and nothing changes', () => {
    async function expectUntouched({ from, to, orders }) {
        for (const o of orders) {
            const a = await orderOf(o._id);
            expect(String(a.table)).toBe(String(from._id));
            expect(a.tableMoves).toBeUndefined();
        }
        expect((await tableOf(from._id)).status).toBe('occupied');
        expect((await tableOf(to._id)).status).toBe('free');
        const rows = (await auditRows()).filter((r) => r.entityId === String(from._id));
        expect(rows).toHaveLength(0);
    }

    test('a final bill on any open order -> BILL_FINAL', async () => {
        const s = await seat(A, [{}, { bill: { status: 'final', billNo: 7 } }]);
        const res = await move(admin(), ids(s.from, s.to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('BILL_FINAL');
        await expectUntouched(s);
    });

    test.each([
        ['Paid', { paymentStatus: 'Paid', amountPaid: 210 }],
        ['Partially Paid', { paymentStatus: 'Partially Paid', amountPaid: 50 }],
        ['Refunded', { paymentStatus: 'Refunded' }],
        ['amountPaid > 0', { amountPaid: 10 }],
    ])('%s -> PAYMENT_ATTACHED', async (_label, fields) => {
        const s = await seat(A, [{}, fields]);
        const res = await move(admin(), ids(s.from, s.to));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ATTACHED');
        await expectUntouched(s);
    });

    test('a counter-payment request does NOT block; it carries over with its alert and Request', async () => {
        const s = await seat(A, [{ counterPaymentRequestedAt: new Date(Date.now() - 60000) }]);
        const reqDoc = await Request.create({
            restaurant: A.restaurant._id, branch: A.branch._id, table: s.from._id, type: 'bill', status: 'pending',
        });
        await Table.updateOne({ _id: s.from._id }, {
            $set: { status: 'alert', alerts: [{ reason: 'Counter payment requested', type: 'bill', requestId: reqDoc._id }] },
        });
        const before = await orderOf(s.orders[0]._id);
        const res = await move(admin(), ids(s.from, s.to));
        expect(res.status).toBe(200);
        const after = await orderOf(s.orders[0]._id);
        expect(after.counterPaymentRequestedAt).toEqual(before.counterPaymentRequestedAt);
        const dst = await tableOf(s.to._id);
        expect(dst.status).toBe('alert');
        expect(dst.alerts).toHaveLength(1);
        expect(String(dst.alerts[0].requestId)).toBe(String(reqDoc._id));
        expect(String((await Request.findById(reqDoc._id).lean()).table)).toBe(String(s.to._id));
        expect((await tableOf(s.from._id)).alerts).toHaveLength(0);
    });
});

// ── held pay-first orders ────────────────────────────────────────────
describe('held (awaiting-payment) orders', () => {
    test('move and stay awaiting-payment', async () => {
        const s = await seat(A, [{ status: 'awaiting-payment', holdReason: 'counterCash', paymentChannel: 'payFirst' }, { status: 'new' }]);
        const res = await move(admin(), ids(s.from, s.to));
        expect(res.status).toBe(200);
        const held = await orderOf(s.orders[0]._id);
        expect(held.status).toBe('awaiting-payment');
        expect(held.holdReason).toBe('counterCash');
        expect(String(held.table)).toBe(String(s.to._id));
        // the single source of truth for a held order's table is order.table:
        // the cashier lookup by table finds it on the new table only
        const onNew = await Order.find({ table: s.to._id, status: 'awaiting-payment' }).lean();
        const onOld = await Order.find({ table: s.from._id, status: 'awaiting-payment' }).lean();
        expect(onNew).toHaveLength(1);
        expect(onOld).toHaveLength(0);
    });
});

// ── concurrency ──────────────────────────────────────────────────────
describe('concurrent moves: exactly one wins', () => {
    const outcome = (results) => {
        const ok = results.filter((r) => r.status === 200);
        const lost = results.filter((r) => r.status !== 200);
        expect(ok).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0].status).toBe(409);
        expect(lost[0].body.code).toBe('MOVE_CONFLICT');
    };

    test('same source, same destination', async () => {
        const { from, to, orders } = await seat(A);
        const results = await Promise.all([move(admin(), ids(from, to)), move(A.users.captain, ids(from, to))]);
        outcome(results);
        const o = await orderOf(orders[0]._id);
        expect(String(o.table)).toBe(String(to._id));
        expect(o.tableMoves).toHaveLength(1);
        expect((await tableOf(from._id)).status).toBe('free');
        expect((await tableOf(to._id)).status).toBe('occupied');
        expect((await auditRows()).filter((r) => r.entityId === String(from._id))).toHaveLength(1);
    });

    test('same source, different destinations', async () => {
        const { from, to, orders } = await seat(A);
        const other = await createTable(A, { name: `O-${rid()}` });
        const results = await Promise.all([move(admin(), ids(from, to)), move(A.users.captain, ids(from, other))]);
        outcome(results);
        const o = await orderOf(orders[0]._id);
        const winnerTo = results[0].status === 200 ? to : other;
        const loserTo = results[0].status === 200 ? other : to;
        expect(String(o.table)).toBe(String(winnerTo._id));
        expect(o.tableMoves).toHaveLength(1);
        expect((await tableOf(winnerTo._id)).status).toBe('occupied');
        expect((await tableOf(loserTo._id)).status).toBe('free');
        expect((await tableOf(from._id)).status).toBe('free');
    });

    test('different sources, same destination', async () => {
        const one = await seat(A);
        const two = await seat(A);
        const results = await Promise.all([move(admin(), ids(one.from, one.to)), move(A.users.captain, ids(two.from, one.to))]);
        outcome(results);
        const winnerOne = results[0].status === 200;
        const winner = winnerOne ? one : two;
        const loser = winnerOne ? two : one;
        expect(String((await orderOf(winner.orders[0]._id)).table)).toBe(String(one.to._id));
        expect(String((await orderOf(loser.orders[0]._id)).table)).toBe(String(loser.from._id));
        expect((await tableOf(loser.from._id)).status).toBe('occupied');
        expect((await tableOf(winner.from._id)).status).toBe('free');
    });
});

// ── audit ────────────────────────────────────────────────────────────
describe('audit', () => {
    test('a table.move row records who, from, to, when and what moved', async () => {
        const { from, to, orders } = await seat(A, [{ total: 210 }, { total: 90, items: [line(A, { quantity: 2 })] }]);
        const startedAt = Date.now();
        expect((await move(A.users.captain, ids(from, to))).status).toBe(200);
        const rows = (await auditRows()).filter((r) => r.entityId === String(from._id));
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.actor).toMatchObject({ name: A.users.captain.name, role: 'captain' });
        expect(String(row.actor.id)).toBe(String(A.users.captain._id));
        expect(row.entityType).toBe('table');
        expect(row.summary).toContain(from.name);
        expect(row.summary).toContain(to.name);
        expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(startedAt - 2000);
        expect(row.before).toMatchObject({ tableId: String(from._id), tableName: from.name });
        expect(row.after).toMatchObject({
            tableId: String(to._id), tableName: to.name, itemCount: 3, total: 300,
        });
        expect(row.after.orderIds.sort()).toEqual(orders.map((o) => o.orderId).sort());
    });

    test('if the audit write fails the whole move rolls back', async () => {
        const { from, to, orders } = await seat(A, [{}, {}], {
            seats: [{ keys: ['s:rb'], joinedAt: new Date(), lastSeenAt: new Date() }],
        });
        const spy = jest.spyOn(TenantAudit, 'create').mockRejectedValue(new Error('audit down'));
        let res;
        try {
            res = await move(admin(), ids(from, to));
        } finally {
            spy.mockRestore();
        }
        expect(res.status).toBeGreaterThanOrEqual(500);
        for (const o of orders) {
            const a = await orderOf(o._id);
            expect(String(a.table)).toBe(String(from._id));
            expect(a.tableMoves).toBeUndefined();
        }
        const src = await tableOf(from._id);
        const dst = await tableOf(to._id);
        expect(src.status).toBe('occupied');
        expect(String(src.activeOrder)).toBe(String(orders[0]._id));
        expect(src.seats).toHaveLength(1);
        expect(dst.status).toBe('free');
        expect(dst.activeOrder == null).toBe(true);
        expect(dst.movedSessions || []).toHaveLength(0);
    });
});

// ── guest phones ─────────────────────────────────────────────────────
describe('guest phone sessions', () => {
    test('a phone that missed the push places its NEXT order and it lands on the new table', async () => {
        const oldT = await createTable(A, { name: `G-${rid()}` });
        const newT = await createTable(A, { name: `GN-${rid()}` });
        const { scanToken, sessionId } = await scanTable(ctx.api, oldT);
        const first = await guestOrder(A, oldT, scanToken);
        expect(first.status).toBe(201);
        await settle(200);

        const res = await move(admin(), ids(oldT, newT));
        expect(res.status).toBe(200);

        // the phone still holds the OLD token and still talks about the OLD table
        const next = await guestOrder(A, oldT, scanToken);
        expect(next.status).toBe(201);
        const placed = await orderOf(next.body.order._id);
        expect(String(placed.table)).toBe(String(newT._id));
        expect(placed.scanSessionId).toBe(sessionId);
        expect(String((await orderOf(first.body.order._id)).table)).toBe(String(newT._id));

        // ... and when it already talks about the NEW table with the old token
        const third = await guestOrder(A, newT, scanToken);
        expect(third.status).toBe(201);
        expect(String((await orderOf(third.body.order._id)).table)).toBe(String(newT._id));
    });

    test('an unrelated token for the old table is not honoured for the new one', async () => {
        const oldT = await createTable(A, { name: `GU-${rid()}` });
        const newT = await createTable(A, { name: `GUN-${rid()}` });
        const { scanToken } = await scanTable(ctx.api, oldT);
        expect((await guestOrder(A, oldT, scanToken)).status).toBe(201);
        await settle(200);
        expect((await move(admin(), ids(oldT, newT))).status).toBe(200);

        // brand-new party scans the (now free) old table: normal new session
        const fresh = await scanTable(ctx.api, oldT);
        expect(fresh.res.status).toBe(200);
        expect(fresh.sessionId).toBeTruthy();
        const freshOrder = await guestOrder(A, oldT, fresh.scanToken);
        expect(freshOrder.status).toBe(201);
        expect(String((await orderOf(freshOrder.body.order._id)).table)).toBe(String(oldT._id));
        // ... and that new party cannot use its old-table token to order on the moved party's table
        const hijack = await guestOrder(A, newT, fresh.scanToken);
        expect(hijack.status).toBe(403);
        expect(hijack.body.code).toBe('SCAN_TOKEN_MISMATCH');
    });

    test('the moved party stays signed in when the old table is later freed (guard + socket)', async () => {
        const oldT = await createTable(A, { name: `GF-${rid()}` });
        const newT = await createTable(A, { name: `GFN-${rid()}` });
        const { scanToken } = await scanTable(ctx.api, oldT);
        expect((await guestOrder(A, oldT, scanToken)).status).toBe(201);
        await settle(200);
        expect((await move(admin(), ids(oldT, newT))).status).toBe(200);
        await sleep(1100);
        const free = await ctx.api.as(admin()).post(`/tables/${oldT._id}/free`).send({});
        expect(free.status).toBe(200);
        // old table's epoch is now newer than the phone's token, but the party moved
        const again = await guestOrder(A, oldT, scanToken);
        expect(again.status).toBe(201);
        expect(String((await orderOf(again.body.order._id)).table)).toBe(String(newT._id));
    });

    test('pushed token path: table:moved carries a fresh token for the new table and the socket changes rooms', async () => {
        const oldT = await createTable(A, { name: `GP-${rid()}` });
        const newT = await createTable(A, { name: `GPN-${rid()}` });
        const { scanToken, sessionId } = await scanTable(ctx.api, oldT);
        const phone = await connect({ scanToken });
        const phoneEvents = recorder(phone);
        // a party at ANOTHER table is not touched
        const elsewhere = await createTable(A, { name: `GE-${rid()}` });
        const strangerScan = await scanTable(ctx.api, elsewhere);
        const otherEvents = recorder(await connect({ scanToken: strangerScan.scanToken }));
        expect((await guestOrder(A, oldT, scanToken)).status).toBe(201);
        await settle(200);

        expect((await move(admin(), ids(oldT, newT))).status).toBe(200);
        const hit = await waitFor(phoneEvents, (e) => e.event === 'table:moved');
        expect(hit.payload).toMatchObject({ toTableId: String(newT._id), toTableName: newT.name, sessionId });
        const decoded = verifyTypedToken(hit.payload.scanToken, TOKEN_TYPES.SCAN);
        expect(decoded.tableId).toBe(String(newT._id));
        expect(decoded.sessionId).toBe(sessionId);
        expect(String(decoded.restaurantId)).toBe(String(A.restaurant._id));
        await sleep(150);
        // a party that was not moved gets no push
        expect(otherEvents.find((e) => e.event === 'table:moved')).toBeUndefined();

        // the pushed token works straight away on the new table
        const placed = await guestOrder(A, newT, hit.payload.scanToken);
        expect(placed.status).toBe(201);
        expect(String((await orderOf(placed.body.order._id)).table)).toBe(String(newT._id));

        // freeing the old table later does not sign the moved phone out
        await sleep(1100);
        const before = phoneEvents.length;
        expect((await ctx.api.as(admin()).post(`/tables/${oldT._id}/free`).send({})).status).toBe(200);
        await sleep(300);
        expect(phoneEvents.slice(before).find((e) => e.event === 'session:ended')).toBeUndefined();
        // ... while a brand-new party that sat down at the freed old table is told
        const newcomer = await scanTable(ctx.api, oldT);
        const newcomerEvents = recorder(await connect({ scanToken: newcomer.scanToken }));
        await sleep(1100);
        expect((await ctx.api.as(admin()).post(`/tables/${oldT._id}/free`).send({})).status).toBe(200);
        await waitFor(newcomerEvents, (e) => e.event === 'session:ended');
        expect(otherEvents.find((e) => e.event === 'session:ended')).toBeUndefined();
    });

    test('freeing the destination wipes movedSessions', async () => {
        const oldT = await createTable(A, { name: `GW-${rid()}` });
        const newT = await createTable(A, { name: `GWN-${rid()}` });
        const { scanToken } = await scanTable(ctx.api, oldT);
        expect((await guestOrder(A, oldT, scanToken)).status).toBe(201);
        await settle(200);
        expect((await move(admin(), ids(oldT, newT))).status).toBe(200);
        expect((await tableOf(newT._id)).movedSessions.length).toBeGreaterThan(0);
        expect((await ctx.api.as(admin()).post(`/tables/${newT._id}/free`).send({ force: true, reason: 'test cleanup' })).status).toBe(200);
        expect((await tableOf(newT._id)).movedSessions || []).toHaveLength(0);
        // the old-table token is a plain token for the (free) old table again: it no longer reaches the destination
        const stale = await guestOrder(A, oldT, scanToken);
        expect(stale.status).toBe(201);
        expect(String((await orderOf(stale.body.order._id)).table)).toBe(String(oldT._id));
    });
});

// ── realtime ─────────────────────────────────────────────────────────
describe('staff realtime', () => {
    test('table:moved reaches admin, captain, waiter and kitchen; table:updated and order:updated follow', async () => {
        const { from, to, orders } = await seat(A, [{ total: 210 }, { total: 90, items: [line(A, { quantity: 2 })] }]);
        const roles = ['admin', 'captain', 'waiter', 'chef'];
        const recs = {};
        for (const r of roles) {
            // eslint-disable-next-line no-await-in-loop
            const s = await connect({ token: A.users[r].token });
            recs[r] = recorder(s);
        }
        await sleep(200);
        const startedAt = Date.now();
        expect((await move(A.users.captain, ids(from, to))).status).toBe(200);

        for (const r of roles) {
            // eslint-disable-next-line no-await-in-loop
            const hit = await waitFor(recs[r], (e) => e.event === 'table:moved');
            expect(hit.payload).toMatchObject({
                fromTableId: String(from._id), toTableId: String(to._id),
                fromTableName: from.name, toTableName: to.name,
                itemCount: 3, total: 300,
                movedBy: { id: String(A.users.captain._id), name: A.users.captain.name },
            });
            expect(hit.payload.orderIds.sort()).toEqual(orders.map((o) => o.orderId).sort());
            expect(new Date(hit.payload.at).getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
        }
        await waitFor(recs.admin, (e) => e.event === 'table:updated' && String(e.payload.tableId) === String(from._id));
        await waitFor(recs.admin, (e) => e.event === 'table:updated' && String(e.payload.tableId) === String(to._id));
        const upd = recs.admin.filter((e) => e.event === 'order:updated');
        expect(upd.map((e) => e.payload.orderId).sort()).toEqual(expect.arrayContaining(orders.map((o) => o.orderId)));
    });
});

// ── serialisation / printing ─────────────────────────────────────────
describe('movedFrom everywhere the table is shown', () => {
    test('live list, order detail, table order list, kitchen list and KOT reprint payload', async () => {
        const { from, to, orders } = await seat(A, [{ status: 'preparing' }]);
        const never = await seat(A, [{ status: 'preparing' }]);
        expect((await move(admin(), ids(from, to))).status).toBe(200);
        const o = orders[0];

        const live = await ctx.api.as(admin()).get('/orders/live');
        expect(live.status).toBe(200);
        const liveRow = live.body.orders.find((x) => x.id === o.orderId);
        expect(liveRow.movedFrom).toMatchObject({ tableId: String(from._id), tableName: from.name });
        expect(liveRow.movedFrom.at).toBeTruthy();
        expect(live.body.orders.find((x) => x.id === never.orders[0].orderId).movedFrom).toBeNull();

        const detail = await ctx.api.as(admin()).get(`/orders/${o._id}/detail`);
        expect(detail.status).toBe(200);
        expect(detail.body.order.movedFrom).toMatchObject({ tableId: String(from._id), tableName: from.name });

        const list = await ctx.api.as(admin()).get(`/orders/active-list/table/${to._id}`);
        expect(list.status).toBe(200);
        expect(list.body.orders[0].movedFrom).toMatchObject({ tableName: from.name });

        const kitchen = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(kitchen.status).toBe(200);
        const kRow = kitchen.body.orders.find((x) => x.id === o.orderId);
        expect(kRow).toBeTruthy();
        expect(kRow.movedFrom).toMatchObject({ tableId: String(from._id), tableName: from.name });
        expect(kRow.tableId).toBe(to.name);
        expect(kitchen.body.orders.find((x) => x.id === never.orders[0].orderId).movedFrom).toBeNull();

        const chef = await connect({ token: A.users.chef.token });
        const chefEvents = recorder(chef);
        await sleep(150);
        const reprint = await ctx.api.as(admin()).post(`/orders/${o._id}/reprint-kot`).send({});
        expect(reprint.status).toBe(200);
        const hit = await waitFor(chefEvents, (e) => e.event === 'order:kot-reprint');
        expect(hit.payload.movedFrom).toMatchObject({ tableName: from.name });
        expect(reprint.body.order.movedFrom).toMatchObject({ tableName: from.name });
    });

    test('printed KOT carries "Moved from <name>" for moved orders and not for others', async () => {
        const T = await seedTenant({ label: 'mv-print' });
        const patched = await ctx.api.as(T.users.admin, T).patch('/settings/printers').send({
            enabled: true,
            autoPrint: { kotOnCreate: true, kotOnAppend: true, billOnPaid: false },
            list: [{ name: 'Kitchen', station: 'kitchen', interface: 'lan', host: '127.0.0.1', port: 9100, paperWidth: '80' }],
        });
        expect(patched.status).toBe(200);

        const s = await seat(T, [{ status: 'preparing' }]);
        const other = await seat(T, [{ status: 'preparing' }]);
        expect((await ctx.api.as(T.users.admin, T).post('/tables/move').send(ids(s.from, s.to))).status).toBe(200);

        const kot = async (order) => {
            const r = await ctx.api.as(T.users.admin, T).post(`/orders/${order._id}/reprint-kot`).send({});
            expect(r.status).toBe(200);
            await settle(300);
            const job = await PrintJob.findOne({ order: order._id, kind: 'kot' }).sort({ createdAt: -1 }).lean();
            expect(job).toBeTruthy();
            return toPlainText(job.document);
        };
        const moved = await kot(s.orders[0]);
        expect(moved).toContain(`Moved from ${s.from.name}`);
        expect(moved).toContain(`Table ${s.to.name}`);
        const plain = await kot(other.orders[0]);
        expect(plain).not.toContain('Moved from');
    });
});

// ── table timer travels with the party (docs/TABLE_TIMER.md) ─────────────
describe('table timer', () => {
    const TableSession = req_('models/tableSession');
    const { startTableTimer } = req_('utils/tableTimer');
    const timerOf = (id) => Table.findById(id).select('+sessionStartedAt +tableSession').lean();

    test('startedAt is unchanged after a move; source cleared; session row re-pointed; stopped event not sent', async () => {
        const { from, to, orders } = await seat(A);
        await startTableTimer(orders[0]);
        const startedAt = new Date(Date.now() - 25 * 60000);
        await TableSession.updateOne({ table: from._id }, { $set: { startedAt } });
        await Table.updateOne({ _id: from._id }, { $set: { sessionStartedAt: startedAt } });
        const before = await timerOf(from._id);
        const cap = recorder(await connect({ token: A.users.captain.token }));
        await sleep(150);

        const res = await move(admin(), ids(from, to));
        expect(res.status).toBe(200);

        const dst = await timerOf(to._id);
        const src = await timerOf(from._id);
        expect(dst.sessionStartedAt.getTime()).toBe(startedAt.getTime());
        expect(String(dst.tableSession)).toBe(String(before.tableSession));
        expect(src.sessionStartedAt || null).toBeNull();
        expect(src.tableSession || null).toBeNull();
        const rows = await TableSession.find({ firstOrder: orders[0]._id }).lean();
        expect(rows).toHaveLength(1);
        expect(String(rows[0].table)).toBe(String(to._id));
        expect(rows[0].endedAt).toBeNull();
        expect(rows[0].startedAt.getTime()).toBe(startedAt.getTime());
        await sleep(300);
        expect(cap.filter((e) => e.event === 'table:timer-stopped')).toHaveLength(0);
    });

    test('a move without a timer leaves both tables without one', async () => {
        const { from, to } = await seat(A);
        expect((await move(admin(), ids(from, to))).status).toBe(200);
        expect((await timerOf(to._id)).sessionStartedAt || null).toBeNull();
    });
});
