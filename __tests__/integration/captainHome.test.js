/**
 * Captain home, team and handover (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 6, D7).
 *
 *   PUT  /tables/:id/assign          hardening, assignmentHistory, workload limit
 *   GET  /tables/:id/assignments     history (captain/admin/manager)
 *   GET  /captain/waiters            + workload { tables, limit }
 *   GET  /captain/floor-overview     + summary.openRequests / unassignedTables / myShift
 *   GET  /shifts/handover            summary; POST confirms (does not clock out)
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const Request = require(path.join(BACKEND, 'models/request'));
const Shift = require(path.join(BACKEND, 'models/shift'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { normaliseProfile, OperationsProfileError } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;        // default tenant: no limit configured
let L;        // tenant with tables.maxTablesPerWaiter = 2
let B;        // other tenant
let second;   // A's second branch + pinned captain

let seq = 0;
const oid = () => `CH-${Date.now()}-${++seq}`;

async function extraWaiter(T, label, fields = {}) {
    return createUser({
        name: `${label} ${T.slug}`, email: `${label}.${T.slug}@staff.test`, role: 'waiter',
        restaurant: T.restaurant._id, branch: T.branch._id, permissions: defaultPermissionsForRole('waiter'), ...fields,
    });
}

beforeAll(async () => {
    A = await seedTenant({ label: 'chm-a' });
    B = await seedTenant({ label: 'chm-b' });
    L = await seedTenant({ label: 'chm-l' });
    await Restaurant.updateOne({ _id: L.restaurant._id }, {
        $set: { operations: normaliseProfile({ advanced: { 'tables.maxTablesPerWaiter': 2 } }) },
    });
    const branch = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    const area = await Area.create({ restaurant: A.restaurant._id, branch: branch._id, name: 'Second Hall' });
    second = {
        branch, area,
        captain: await createUser({
            name: 'captain second', email: `cap.second.${A.slug}@staff.test`, role: 'captain',
            restaurant: A.restaurant._id, branch: branch._id, permissions: defaultPermissionsForRole('captain'),
        }),
    };
});

const cap = (T = A) => ctx.api.as(T.users.captain, T);
const admin = (T = A) => ctx.api.as(T.users.admin, T);
const assign = (client, table, body) => client.put(`/tables/${table._id}/assign`).send(body);
const history = async (table) => (await Table.findById(table._id).select('+assignmentHistory').lean()).assignmentHistory;

// ── Assignment hardening + history ────────────────────────────────────

describe('assign: hardening and history', () => {
    test('an inactive waiter is refused with 409 STAFF_INACTIVE and nothing changes', async () => {
        const gone = await extraWaiter(A, 'inactive', { status: 'inactive' });
        const table = await createTable(A);
        const res = await assign(cap(), table, { waiterId: String(gone._id) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('STAFF_INACTIVE');
        expect((await Table.findById(table._id).lean()).assignedWaiter ?? null).toBeNull();
        expect(await history(table)).toEqual([]);
    });

    test('a chef / other-tenant waiter stays 404 WAITER_NOT_FOUND', async () => {
        const table = await createTable(A);
        const chef = await assign(cap(), table, { waiterId: String(A.users.chef._id) });
        expect(chef.status).toBe(404);
        expect(chef.body.code).toBe('WAITER_NOT_FOUND');
        expect((await assign(cap(), table, { waiterId: String(B.users.waiter._id) })).status).toBe(404);
    });

    test('assign, reassign and clear are all recorded; no-op repeat is not', async () => {
        const w2 = await extraWaiter(A, 'w2');
        const table = await createTable(A);
        expect((await assign(cap(), table, { waiterId: String(A.users.waiter._id) })).status).toBe(200);
        expect((await assign(cap(), table, { waiterId: String(A.users.waiter._id) })).status).toBe(200);   // same waiter: no entry
        expect((await assign(admin(), table, { waiterId: String(w2._id) })).status).toBe(200);
        expect((await assign(cap(), table, { waiterId: null })).status).toBe(200);

        const h = await history(table);
        expect(h).toHaveLength(3);
        expect(h[0]).toMatchObject({ waiterName: A.users.waiter.name, assignedByName: A.users.captain.name, cleared: false, reason: '' });
        expect(String(h[1].waiter)).toBe(String(w2._id));
        expect(h[1].assignedByName).toBe(A.users.admin.name);
        expect(h[2]).toMatchObject({ waiter: null, cleared: true });
    });

    test('history is capped at the last 20 entries', async () => {
        const w2 = await extraWaiter(A, 'cap20');
        const table = await createTable(A);
        for (let i = 0; i < 23; i += 1) {
            const who = i % 2 ? A.users.waiter : w2;
            expect((await assign(cap(), table, { waiterId: String(who._id) })).status).toBe(200);
        }
        expect(await history(table)).toHaveLength(20);
    });

    test('GET /tables/:id/assignments returns newest first for captain, admin; waiter 403', async () => {
        const table = await createTable(A);
        await assign(cap(), table, { waiterId: String(A.users.waiter._id) });
        await assign(cap(), table, { waiterId: null });
        const res = await cap().get(`/tables/${table._id}/assignments`);
        expect(res.status).toBe(200);
        expect(res.body.table).toMatchObject({ name: table.name });
        expect(res.body.history).toHaveLength(2);
        expect(res.body.history[0].cleared).toBe(true);
        expect(res.body.history[1].waiterName).toBe(A.users.waiter.name);
        expect((await admin().get(`/tables/${table._id}/assignments`)).status).toBe(200);
        expect((await ctx.api.as(A.users.waiter, A).get(`/tables/${table._id}/assignments`)).status).toBe(403);
    });

    test('history endpoint is tenant- and branch-scoped', async () => {
        const table = await createTable(A);
        await assign(cap(), table, { waiterId: String(A.users.waiter._id) });
        expect((await admin(B).get(`/tables/${table._id}/assignments`)).status).toBe(404);
        const cross = await ctx.api.as(second.captain).get(`/tables/${table._id}/assignments`);
        expect(cross.status).toBe(403);
        expect(cross.body.code).toBe('BRANCH_MISMATCH');
    });

    test('history does not leak into the table listing', async () => {
        const table = await createTable(A);
        await assign(cap(), table, { waiterId: String(A.users.waiter._id) });
        const res = await cap().get('/tables');
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('assignmentHistory');
    });
});

// ── Workload limit (D7) ───────────────────────────────────────────────

describe('workload limit', () => {
    test('is off by default: a waiter can hold any number of tables; waiters list shows limit 0', async () => {
        const w = await extraWaiter(A, 'busy');
        for (let i = 0; i < 4; i += 1) {
            expect((await assign(cap(), await createTable(A), { waiterId: String(w._id) })).status).toBe(200);
        }
        const res = await cap().get('/captain/waiters');
        expect(res.status).toBe(200);
        const row = res.body.waiters.find((x) => String(x._id) === String(w._id));
        expect(row.workload).toEqual({ tables: 4, limit: 0 });
    });

    test('limit validation: 0 allowed, negative / fractional / string refused', () => {
        const ok = (v) => normaliseProfile({ advanced: { 'tables.maxTablesPerWaiter': v } });
        expect(ok(0).advanced['tables.maxTablesPerWaiter']).toBe(0);
        expect(ok(5).advanced['tables.maxTablesPerWaiter']).toBe(5);
        for (const bad of [-1, 2.5, '3', null, 1001]) expect(() => ok(bad)).toThrow(OperationsProfileError);
    });

    test('over the limit -> 409 WORKLOAD_LIMIT with current / limit; nothing changes', async () => {
        const w = await extraWaiter(L, 'ltd');
        for (let i = 0; i < 2; i += 1) expect((await assign(cap(L), await createTable(L), { waiterId: String(w._id) })).status).toBe(200);
        const third = await createTable(L);
        const res = await assign(cap(L), third, { waiterId: String(w._id) });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'WORKLOAD_LIMIT', current: 2, limit: 2 });
        expect((await Table.findById(third._id).lean()).assignedWaiter ?? null).toBeNull();
        expect(await history(third)).toEqual([]);

        const list = await cap(L).get('/captain/waiters');
        expect(list.body.waiters.find((x) => String(x._id) === String(w._id)).workload).toEqual({ tables: 2, limit: 2 });
    });

    test('override with a reason is allowed, recorded in history and logged; short reason is 400', async () => {
        const w = await extraWaiter(L, 'ovr');
        for (let i = 0; i < 2; i += 1) await assign(cap(L), await createTable(L), { waiterId: String(w._id) });
        const table = await createTable(L);

        const short = await assign(cap(L), table, { waiterId: String(w._id), overrideReason: 'x' });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('OVERRIDE_REASON_TOO_SHORT');

        const info = jest.spyOn(logger, 'info');
        const res = await assign(cap(L), table, { waiterId: String(w._id), overrideReason: '  VIP section rush  ' });
        expect(res.status).toBe(200);
        expect(info.mock.calls.some((c) => String(c[0]).includes('workload limit') && String(c[0]).includes('VIP section rush'))).toBe(true);
        info.mockRestore();
        const h = await history(table);
        expect(h).toHaveLength(1);
        expect(h[0].reason).toBe('VIP section rush');
    });

    test('within the limit an unneeded overrideReason is not recorded; clearing and re-assigning the same waiter are never blocked', async () => {
        const w = await extraWaiter(L, 'fine');
        const t1 = await createTable(L);
        const t2 = await createTable(L);
        expect((await assign(cap(L), t1, { waiterId: String(w._id), overrideReason: 'not needed' })).status).toBe(200);
        expect((await history(t1))[0].reason).toBe('');
        await assign(cap(L), t2, { waiterId: String(w._id) });
        // at the limit now: re-assigning an owned table is not "new load"
        expect((await assign(cap(L), t2, { waiterId: String(w._id) })).status).toBe(200);
        expect((await assign(cap(L), t2, { waiterId: null })).status).toBe(200);
    });
});

// ── Floor overview additions ──────────────────────────────────────────

describe('floor-overview summary', () => {
    test('openRequests, unassignedTables and myShift are present; existing fields kept', async () => {
        const T = await seedTenant({ label: 'chm-fo' });
        const t1 = await createTable(T);
        await createTable(T);
        await assign(cap(T), t1, { waiterId: String(T.users.waiter._id) });
        await Request.create({ restaurant: T.restaurant._id, branch: T.branch._id, table: t1._id, type: 'water', status: 'pending' });
        await Request.create({ restaurant: T.restaurant._id, branch: T.branch._id, table: t1._id, type: 'bill', status: 'accepted' });
        await Request.create({ restaurant: T.restaurant._id, branch: T.branch._id, table: t1._id, type: 'other', status: 'completed' });

        let res = await cap(T).get('/captain/floor-overview');
        expect(res.status).toBe(200);
        const total = res.body.summary.totalTables;
        expect(total).toBeGreaterThanOrEqual(3);
        expect(res.body.summary).toMatchObject({ openRequests: 2, myShift: { active: false, clockedInAt: null } });
        expect(res.body.summary.unassignedTables).toBe(total - 1);
        expect(res.body.summary).toEqual(expect.objectContaining({ occupied: expect.any(Number), delayedOrders: expect.any(Number) }));

        expect((await cap(T).post('/shifts/clock-in').send({})).status).toBe(201);
        res = await cap(T).get('/captain/floor-overview');
        expect(res.body.summary.myShift.active).toBe(true);
        expect(res.body.summary.myShift.clockedInAt).toBeTruthy();
    });
});

// ── Shift handover ────────────────────────────────────────────────────

describe('shift handover', () => {
    let H;
    let table;
    let unpaid;
    let cooking;

    beforeAll(async () => {
        H = await seedTenant({ label: 'chm-h' });
        expect((await cap(H).post('/shifts/clock-in').send({})).status).toBe(201);
        const mk = (fields) => Order.create({
            restaurant: H.restaurant._id, branch: H.branch._id, orderId: oid(), type: 'dine-in',
            items: [{ menuItem: H.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1 }], ...fields,
        });
        table = await createTable(H, { name: 'HT-1' });
        unpaid = await mk({ table: table._id, status: 'served', total: 500, amountPaid: 100 });
        const table2 = await createTable(H, { name: 'HT-2' });
        cooking = await mk({
            table: table2._id, status: 'preparing', total: 300,
            kots: [{ kotNo: 1, itemCount: 1 }, { kotNo: 2, itemCount: 1 }],
        });
        await Request.create({ restaurant: H.restaurant._id, branch: H.branch._id, table: table._id, type: 'waiter', status: 'pending' });
        // cash this captain settled during the shift (200 + 150), plus noise that must not count
        const paidBy = (by, method, amount) => mk({
            status: 'served', paymentStatus: 'Paid', total: amount, amountPaid: amount, paymentMethod: method,
            payment: { state: 'paid', method, amount, updatedBy: by, updatedAt: new Date() },
        });
        await paidBy(H.users.captain._id, 'Cash', 200);
        await paidBy(H.users.captain._id, 'cash', 150);
        await paidBy(H.users.captain._id, 'online', 999);
        await paidBy(H.users.admin._id, 'Cash', 777);
    });

    test('GET returns the full shape scoped to the open floor, with the documented cash rule', async () => {
        const res = await cap(H).get('/shifts/handover');
        expect(res.status).toBe(200);
        expect(res.body.shift).toMatchObject({ status: 'active' });
        expect(res.body.openTables).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'HT-1', orderId: unpaid.orderId, due: 400 }),
            expect.objectContaining({ name: 'HT-2', orderId: cooking.orderId, due: 300 }),
        ]));
        expect(res.body.unpaidBills).toEqual([
            expect.objectContaining({ orderId: unpaid.orderId, tableName: 'HT-1', due: 400, billStatus: 'none' }),
        ]);
        expect(res.body.activeKots.map((k) => [k.orderId, k.kotNo, k.status])).toEqual([
            [cooking.orderId, 1, 'preparing'], [cooking.orderId, 2, 'preparing'],
        ]);
        expect(res.body.activeKots[0]).toEqual(expect.objectContaining({ tableName: 'HT-2', ageMin: expect.any(Number) }));
        expect(res.body.openRequests).toEqual([expect.objectContaining({ tableName: 'HT-1', type: 'waiter', status: 'pending' })]);
        expect(res.body.cash).toEqual({ expected: 350 });
        expect(res.body.incentive).toBeNull();
        expect(res.body.warnings).toEqual(expect.arrayContaining(['1 unpaid bill', '2 active KOTs', '1 open request']));
    });

    test('a legacy order without kots[] counts as one KOT, round 1', async () => {
        const T = await seedTenant({ label: 'chm-leg' });
        const tbl = await createTable(T);
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: oid(), type: 'dine-in', table: tbl._id,
            status: 'new', total: 100, items: [{ menuItem: T.items.paneer._id, name: 'Paneer Tikka', price: 100, quantity: 1 }],
        });
        const res = await cap(T).get('/shifts/handover');
        expect(res.status).toBe(200);
        expect(res.body.shift).toBeNull();
        expect(res.body.activeKots).toHaveLength(1);
        expect(res.body.activeKots[0].kotNo).toBe(1);
        expect(res.body.cash).toEqual({ expected: 0 });
    });

    test('a branch-pinned captain only sees their own branch', async () => {
        const res = await ctx.api.as(second.captain).get('/shifts/handover');
        expect(res.status).toBe(200);
        expect(res.body.openTables).toEqual([]);
        expect(res.body.unpaidBills).toEqual([]);
        expect(res.body.activeKots).toEqual([]);
        expect(res.body.openRequests).toEqual([]);
        // and another tenant's captain never sees H's floor
        const other = await cap(B).get('/shifts/handover');
        expect(other.body.openTables).toEqual([]);
    });

    test('waiter and chef are 403 on both verbs', async () => {
        for (const who of [H.users.waiter, H.users.chef]) {
            expect((await ctx.api.as(who, H).get('/shifts/handover')).status).toBe(403);
            expect((await ctx.api.as(who, H).post('/shifts/handover').send({})).status).toBe(403);
        }
    });

    test('POST without an active shift is a clear 409 NO_ACTIVE_SHIFT', async () => {
        const res = await admin(H).post('/shifts/handover').send({ note: 'x' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NO_ACTIVE_SHIFT');
    });

    test('POST rejects a bad cashCounted', async () => {
        for (const bad of [-5, 'abc']) {
            const res = await cap(H).post('/shifts/handover').send({ cashCounted: bad });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_AMOUNT');
        }
    });

    test('POST stores the handover with variance and does NOT clock out; clock-out still works', async () => {
        const res = await cap(H).post('/shifts/handover').send({ note: 'Table 1 still eating', cashCounted: 340 });
        expect(res.status).toBe(200);
        expect(res.body.handover).toMatchObject({ note: 'Table 1 still eating', cashCounted: 340, cashExpected: 350, variance: -10 });
        expect(res.body.handover.openTables).toHaveLength(2);
        expect(res.body.handover.unpaidBills).toHaveLength(1);
        expect(res.body.handover.confirmedAt).toBeTruthy();

        const saved = await Shift.findOne({ staff: H.users.captain._id, restaurant: H.restaurant._id }).lean();
        expect(saved.status).toBe('active');
        expect(saved.handover).toMatchObject({ cashCounted: 340, cashExpected: 350, variance: -10 });

        const again = await cap(H).get('/shifts/handover');
        expect(again.body.shift.handover.note).toBe('Table 1 still eating');

        const out = await cap(H).post('/shifts/clock-out').send({ note: 'done' });
        expect(out.status).toBe(200);
        expect(out.body.shift.status).toBe('completed');
        expect(out.body.shift.handover.variance).toBe(-10);
    });

    test('cashCounted is optional (variance null)', async () => {
        const T = await seedTenant({ label: 'chm-nc' });
        await cap(T).post('/shifts/clock-in').send({});
        const res = await cap(T).post('/shifts/handover').send({ note: 'ok' });
        expect(res.status).toBe(200);
        expect(res.body.handover).toMatchObject({ cashCounted: null, variance: null, cashExpected: 0 });
    });
});
