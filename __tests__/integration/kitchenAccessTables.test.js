/**
 * Kitchen display + order access + tables, through the real HTTP stack:
 *   - services/kitchenService.js   GET /orders/kitchen, /kitchen/completed,
 *                                  POST /orders/:id/reprint-kot
 *   - services/orderAccess.js      applySessionScope via the table bill
 *                                  list (orderAccessForCaller is unit-
 *                                  tested in __tests__/orderAccess.test.js)
 *   - controllers/tableController.js + utils/tableMerge.js +
 *     utils/tableOccupancy.js      scan, CRUD validation, claim, merge /
 *                                  unmerge, free, cross-branch staff.
 *
 * Seat reservation (tableSeats.test.js), table:unavailable pushes
 * (tableUnavailable.test.js) and the basic deleted-table rules
 * (orderFlow.test.js) are covered elsewhere and not repeated.
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { computeBill, toTaxConfig } = req_('utils/billing');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const Order = req_('models/order');
const Table = req_('models/table');
const Area = req_('models/area');
const Branch = req_('models/branch');
const MenuItem = req_('models/menuItem');
const Restaurant = req_('models/restaurant');
const Request = req_('models/request');

const ctx = useIntegrationApp();
let A;
let B;
let second;          // Second branch of A + pinned staff
let items;           // extra menu items: chicken (non-veg), water (counter)
let vegChef;

const bill = (subtotal, orderType = 'dine-in') =>
    computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType });

const rand = () => Math.random().toString(16).slice(2, 10);
const staff = (role, extra = {}) => createUser({
    name: `${role} ${rand()}`,
    email: `${role}.${rand()}@kitchen.test`,
    role,
    restaurant: A.restaurant._id,
    branch: A.branch._id,
    permissions: defaultPermissionsForRole(role),
    ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'kat' });
    B = await seedTenant({ label: 'katb' });
    const mk = (fields) => MenuItem.create({
        restaurant: A.restaurant._id, category: A.category._id, description: 'kitchen test', ...fields,
    });
    items = {
        chicken: await mk({ name: 'Chicken Tikka', basePrice: 300, vegType: 'non-veg', prepStation: 'kitchen' }),
        water: await mk({ name: 'Mineral Water', basePrice: 20, vegType: 'veg', prepStation: 'counter' }),
    };
    const branch = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    const area = await Area.create({ restaurant: A.restaurant._id, branch: branch._id, name: 'Second Hall' });
    second = {
        branch,
        area,
        chef: await staff('chef', { branch: branch._id }),
        captain: await staff('captain', { branch: branch._id }),
        waiter: await staff('waiter', { branch: branch._id }),
        admin: await staff('admin', { branch: branch._id, permissions: {} }),
    };
    vegChef = await staff('chef', { kitchenResponsibility: 'veg' });
});

/** Guest dine-in order; `lines` = [[menuItemDoc, qty], ...]. */
async function guestOrder({ table, scanToken, lines } = {}) {
    const tbl = table || await createTable(A, { capacity: 6 });
    let token = scanToken;
    if (!token) ({ scanToken: token } = await scanTable(ctx.api, tbl));
    const ls = lines || [[A.items.paneer, 1]];
    const subtotal = ls.reduce((s, [m, q]) => s + m.basePrice * q, 0);
    const res = await ctx.api.guest(A, token).post('/orders').send({
        type: 'dine-in',
        tableId: String(tbl._id),
        items: ls.map(([m, q]) => ({ menuItem: String(m._id), quantity: q })),
        total: bill(subtotal).total,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, table: tbl, scanToken: token };
}

const kitchenIds = async (user, query = '') => {
    const res = await ctx.api.as(user).get(`/orders/kitchen${query}`);
    expect(res.status).toBe(200);
    return res.body.orders.map((o) => o.id);
};
const reload = (id) => Order.findById(id).lean();
const reloadTable = (id) => Table.findById(id).select('+seats').lean();

// ─────────────────────────────────────────────────────────────────────
// 5.3 Kitchen display
// ─────────────────────────────────────────────────────────────────────
describe('KDS queues (GET /orders/kitchen)', () => {
    let mainOrder;
    let secondOrder;

    beforeAll(async () => {
        ({ order: mainOrder } = await guestOrder());
        const t2 = await createTable(A, { branch: second.branch._id, area: second.area._id });
        ({ order: secondOrder } = await guestOrder({ table: t2 }));
    });

    test('a branch-pinned chef sees only their branch; the tenant owner sees both; ?branch narrows the owner', async () => {
        const mainChef = await kitchenIds(A.users.chef);
        expect(mainChef).toContain(mainOrder.orderId);
        expect(mainChef).not.toContain(secondOrder.orderId);

        const secondChef = await kitchenIds(second.chef);
        expect(secondChef).toContain(secondOrder.orderId);
        expect(secondChef).not.toContain(mainOrder.orderId);

        const owner = await kitchenIds(A.users.admin);
        expect(owner).toEqual(expect.arrayContaining([mainOrder.orderId, secondOrder.orderId]));

        const narrowed = await kitchenIds(A.users.admin, `?branch=${second.branch._id}`);
        expect(narrowed).toContain(secondOrder.orderId);
        expect(narrowed).not.toContain(mainOrder.orderId);
    });

    test('a pinned chef cannot widen scope with ?branch=all or another branch id', async () => {
        const ids = await kitchenIds(second.chef, `?branch=${A.branch._id}`);
        expect(ids).not.toContain(mainOrder.orderId);
        const all = await kitchenIds(second.chef, '?branch=all');
        expect(all).not.toContain(mainOrder.orderId);
    });

    test('another tenant\'s chef never sees these orders', async () => {
        const ids = await kitchenIds(B.users.chef);
        expect(ids).not.toContain(mainOrder.orderId);
        expect(ids).not.toContain(secondOrder.orderId);
    });

    test.each([
        ['waiter', 403], ['captain', 403], ['chef', 200], ['admin', 200],
    ])('%s → %i (accessKitchen)', async (role, status) => {
        const res = await ctx.api.as(A.users[role]).get('/orders/kitchen');
        expect(res.status).toBe(status);
    });

    test('customers are refused', async () => {
        const cust = await createCustomer('kds');
        expect((await ctx.api.as(cust, A).get('/orders/kitchen')).status).toBe(403);
    });

    test('counter-only orders skip the KDS (saved as ready); mixed carts split and only the kitchen half shows', async () => {
        const { order: counterOnly } = await guestOrder({ lines: [[items.water, 2]] });
        expect((await reload(counterOnly._id)).status).toBe('ready');
        const { order: mixed, table } = await guestOrder({ lines: [[items.water, 1], [A.items.paneer, 1]] });

        const ids = await kitchenIds(A.users.chef);
        expect(ids).not.toContain(counterOnly.orderId);
        expect(ids).toContain(mixed.orderId);

        // The counter half of the mixed cart is its own ready doc on the same table.
        const onTable = await Order.find({ table: table._id }).lean();
        expect(onTable).toHaveLength(2);
        const counterDoc = onTable.find((o) => String(o._id) !== String(mixed._id));
        expect(counterDoc.status).toBe('ready');
        expect(ids).not.toContain(counterDoc.orderId);
        // Split docs still sum to the cart's bill, to the paisa.
        const sum = Math.round(onTable.reduce((s, o) => s + o.total, 0) * 100) / 100;
        expect(sum).toBe(bill(20 + 200).total);
    });

    test('a preparing card owned by chef X is hidden from chef Y but visible to the owner admin', async () => {
        const { order } = await guestOrder();
        const otherChef = await staff('chef');
        const start = await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        expect(start.status).toBe(200);
        expect(await kitchenIds(A.users.chef)).toContain(order.orderId);
        expect(await kitchenIds(otherChef)).not.toContain(order.orderId);
        expect(await kitchenIds(A.users.admin)).toContain(order.orderId);
    });

    test('a veg-responsibility chef does not see a non-veg-only order but does see a mixed one', async () => {
        const { order: nonVeg } = await guestOrder({ lines: [[items.chicken, 1]] });
        const { order: mixed } = await guestOrder({ lines: [[items.chicken, 1], [A.items.paneer, 1]] });
        const ids = await kitchenIds(vegChef);
        expect(ids).not.toContain(nonVeg.orderId);
        expect(ids).toContain(mixed.orderId);
        expect(await kitchenIds(A.users.chef)).toContain(nonVeg.orderId);
    });

    test('served / cancelled orders leave the board; completedToday matches /kitchen/completed', async () => {
        const { order } = await guestOrder();
        const { order: dropped } = await guestOrder();
        for (const s of ['preparing', 'ready', 'served']) {
            expect((await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: s })).status).toBe(200);
        }
        await ctx.api.as(A.users.admin).patch(`/orders/${dropped._id}/status`).send({ status: 'cancelled' });

        const kds = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        const ids = kds.body.orders.map((o) => o.id);
        expect(ids).not.toContain(order.orderId);
        expect(ids).not.toContain(dropped.orderId);

        const done = await ctx.api.as(A.users.chef).get('/orders/kitchen/completed');
        expect(done.status).toBe(200);
        expect(done.body.orders.map((o) => o.orderId || o.id)).toContain(order.orderId);
        expect(kds.body.completedToday).toBe(done.body.total);

        const limited = await ctx.api.as(A.users.chef).get('/orders/kitchen/completed?limit=0&days=999');
        expect(limited.status).toBe(200);
        expect(limited.body.orders.length).toBeLessThanOrEqual(50); // limit 0 → default 50
        const one = await ctx.api.as(A.users.chef).get('/orders/kitchen/completed?limit=1');
        expect(one.body.orders).toHaveLength(1);
        expect(one.body.total).toBe(done.body.total);
    });

    test('a served order from yesterday is not counted for today but is for days=2', async () => {
        const { order } = await guestOrder();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(12, 0, 0, 0);
        await Order.updateOne({ _id: order._id }, { $set: { status: 'served', servedAt: yesterday } });
        const today = await ctx.api.as(A.users.admin).get('/orders/kitchen/completed');
        expect(today.body.orders.map((o) => o.orderId || o.id)).not.toContain(order.orderId);
        const two = await ctx.api.as(A.users.admin).get('/orders/kitchen/completed?days=2&limit=200');
        expect(two.body.orders.map((o) => o.orderId || o.id)).toContain(order.orderId);
    });
});

describe('KOT reprint (POST /orders/:id/reprint-kot)', () => {
    test('waiter reprints a live order; chef is refused; cancelled → 400 ORDER_TERMINAL; other tenant → 404', async () => {
        const { order } = await guestOrder();
        const ok = await ctx.api.as(A.users.waiter).post(`/orders/${order._id}/reprint-kot`).send({});
        expect(ok.status).toBe(200);
        expect(ok.body.order.orderId).toBe(order.orderId);

        expect((await ctx.api.as(A.users.chef).post(`/orders/${order._id}/reprint-kot`).send({})).status).toBe(403);
        expect((await ctx.api.as(B.users.admin).post(`/orders/${order._id}/reprint-kot`).send({})).status).toBe(404);

        await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`).send({ status: 'cancelled' });
        const dead = await ctx.api.as(A.users.admin).post(`/orders/${order._id}/reprint-kot`).send({});
        expect(dead.status).toBe(400);
        expect(dead.body.code).toBe('ORDER_TERMINAL');
    });

    test('a merged group prints every member\'s name on the KOT and on the KDS card', async () => {
        const t1 = await createTable(A, { name: 'KOT-7' });
        const t2 = await createTable(A, { name: 'KOT-10' });
        const merge = await ctx.api.as(A.users.admin).post('/tables/merge').send({ tableIds: [String(t1._id), String(t2._id)] });
        expect(merge.status).toBe(200);
        const scan = await scanTable(ctx.api, t2);
        expect(scan.res.status).toBe(200);
        const leaderId = jwt.decode(scan.scanToken).tableId;
        const leader = leaderId === String(t1._id) ? t1 : t2;
        const { order } = await guestOrder({ table: leader, scanToken: scan.scanToken });

        const kot = await ctx.api.as(A.users.admin).post(`/orders/${order._id}/reprint-kot`).send({});
        expect(kot.body.order.table).toBe('KOT-7, KOT-10'); // numeric-aware sort
        const card = (await ctx.api.as(A.users.chef).get('/orders/kitchen')).body.orders.find((o) => o.id === order.orderId);
        expect(card.tableId).toBe('KOT-7, KOT-10');
    });
});

describe('table bill list scoping (applySessionScope)', () => {
    test('guest sees only their scan session; customer only their own; staff see all; no token sees nothing', async () => {
        const table = await createTable(A, { capacity: 6 });
        const g1 = await guestOrder({ table });
        const g2 = await guestOrder({ table });
        const cust = await createCustomer('scope');
        const { scanToken: custScan } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const custRes = await ctx.api.customerAtTable(cust, A, custScan).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }], total: bill(200).total,
        });
        expect(custRes.status).toBe(201);

        const url = `/orders/active-list/table/${table._id}`;
        const ids = (res) => res.body.orders.map((o) => o.orderId).sort();

        expect(ids(await ctx.api.guest(A, g1.scanToken).get(url))).toEqual([g1.order.orderId]);
        expect(ids(await ctx.api.guest(A, g2.scanToken).get(url))).toEqual([g2.order.orderId]);
        expect(ids(await ctx.api.as(cust, A).get(url))).toEqual([custRes.body.order.orderId]);
        expect(ids(await ctx.api.guest(A).get(url))).toEqual([]);
        expect(ids(await ctx.api.guest(A, 'garbage').get(url))).toEqual([]);
        expect(ids(await ctx.api.as(A.users.waiter).get(url)))
            .toEqual([g1.order.orderId, g2.order.orderId, custRes.body.order.orderId].sort());
    });
});

// ─────────────────────────────────────────────────────────────────────
// 5.4 Tables
// ─────────────────────────────────────────────────────────────────────
describe('QR scan (GET /tables/scan/:qrToken)', () => {
    test('malformed token → 404; well-formed unknown token → 404 TABLE_UNAVAILABLE', async () => {
        const bad = await ctx.api.raw.get('/api/v1/tables/scan/tb-XYZ');
        expect(bad.status).toBe(404);
        const unknown = await ctx.api.raw.get('/api/v1/tables/scan/tb-000000000000');
        expect(unknown.status).toBe(404);
        expect(unknown.body.code).toBe('TABLE_UNAVAILABLE');
    });

    test.each([
        ['isActive=false', { isActive: false }],
        ['status=disabled', { status: 'disabled' }],
    ])('%s table → 403, no scan token, no seat', async (_l, patch) => {
        const table = await createTable(A);
        await Table.updateOne({ _id: table._id }, { $set: patch });
        const { res, scanToken } = await scanTable(ctx.api, table);
        expect(res.status).toBe(403);
        expect(scanToken).toBeUndefined();
        expect((await reloadTable(table._id)).seats).toEqual([]);
    });

    test('suspended tenant → 403 TENANT_SUSPENDED', async () => {
        const C = await seedTenant({ label: 'katsusp' });
        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status: 'suspended' } });
        const { res } = await scanTable(ctx.api, C.tables.main);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    test('scan establishes the OWNING tenant: B\'s sticker yields B\'s slug and a B-bound token', async () => {
        const { res, scanToken } = await scanTable(ctx.api, B.tables.main);
        expect(res.status).toBe(200);
        expect(res.body.restaurant.slug).toBe(B.slug);
        const decoded = jwt.decode(scanToken);
        expect(decoded.restaurantId).toBe(String(B.restaurant._id));
        expect(decoded.tableId).toBe(String(B.tables.main._id));
        expect(res.body.qrToken).toBeDefined();
    });

    test('free → occupied on scan; a reserved table keeps its status', async () => {
        const free = await createTable(A);
        expect((await scanTable(ctx.api, free)).res.status).toBe(200);
        expect((await reloadTable(free._id)).status).toBe('occupied');

        const reserved = await createTable(A);
        await Table.updateOne({ _id: reserved._id }, { $set: { status: 'reserved' } });
        expect((await scanTable(ctx.api, reserved)).res.status).toBe(200);
        expect((await reloadTable(reserved._id)).status).toBe('reserved');
    });

    test('re-scan after a paid + served order is flagged repeatScan', async () => {
        const { order, table } = await guestOrder();
        // Updated 2026-10: mark-paid no longer auto-serves a NEW order (it
        // must go through the kitchen), so the food is ready first.
        await Order.updateOne({ _id: order._id }, { $set: { status: 'ready' } });
        const pay = await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        expect((await reloadTable(table._id)).status).toBe('free');
        const again = await scanTable(ctx.api, table);
        expect(again.res.status).toBe(200);
        expect(again.res.body.repeatScan).toBe(true);
        expect(again.res.body.lastCompletedOrderId).toBe(order.orderId);
    });

    test('a fresh table scan carries no repeatScan flag', async () => {
        const table = await createTable(A);
        const { res } = await scanTable(ctx.api, table);
        expect(res.body.repeatScan).toBeUndefined();
    });
});

describe('table CRUD validation', () => {
    const create = (user, body) => ctx.api.as(user).post('/tables').send(body);

    test('admin creates a table with a scannable tb-<12 hex> token', async () => {
        const res = await create(A.users.admin, { name: '  CRUD-1  ', capacity: 4, area: String(A.area._id), branch: String(A.branch._id) });
        expect(res.status).toBe(201);
        const saved = await Table.findById(res.body.table._id).select('+qrToken').lean();
        expect(saved.name).toBe('CRUD-1');
        expect(saved.qrToken).toMatch(/^tb-[a-f0-9]{12}$/);
        expect(String(saved.branch)).toBe(String(A.branch._id));
        expect((await scanTable(ctx.api, { qrToken: saved.qrToken })).res.status).toBe(200);
    });

    test.each([
        ['capacity 0', { capacity: 0 }],
        ['capacity 1001', { capacity: 1001 }],
        ['capacity 1.5', { capacity: 1.5 }],
        ['capacity "abc"', { capacity: 'abc' }],
        ['blank name', { name: '   ' }],
        ['101-char name', { name: 'x'.repeat(101) }],
        ['missing area', { area: undefined }],
        ['bad area id', { area: 'nope' }],
    ])('%s → 400', async (_l, patch) => {
        const body = { name: `V-${rand()}`, capacity: 4, area: String(A.area._id), ...patch };
        const before = await Table.countDocuments({ restaurant: A.restaurant._id });
        const res = await create(A.users.admin, body);
        expect(res.status).toBe(400);
        expect(await Table.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('capacity bounds 1 and 1000 are accepted', async () => {
        for (const capacity of [1, 1000]) {
            const res = await create(A.users.admin, { name: `Cap-${capacity}-${rand()}`, capacity, area: String(A.area._id) });
            expect(res.status).toBe(201);
        }
    });

    test('duplicate name in the same area → 400; same name in another area is fine', async () => {
        const name = `Dup-${rand()}`;
        expect((await create(A.users.admin, { name, capacity: 2, area: String(A.area._id) })).status).toBe(201);
        const dup = await create(A.users.admin, { name, capacity: 2, area: String(A.area._id) });
        expect(dup.status).toBe(400);
        expect(dup.body.message).toMatch(/already exists/);
        const otherArea = await Area.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: `Patio ${rand()}` });
        expect((await create(A.users.admin, { name, capacity: 2, area: String(otherArea._id) })).status).toBe(201);
    });

    test('another tenant\'s branch id is rejected; captain/waiter cannot create', async () => {
        const res = await create(A.users.admin, { name: `X-${rand()}`, capacity: 2, area: String(A.area._id), branch: String(B.branch._id) });
        expect(res.status).toBe(400);
        for (const u of [A.users.captain, A.users.waiter, A.users.chef]) {
            expect((await create(u, { name: `X-${rand()}`, capacity: 2, area: String(A.area._id) })).status).toBe(403);
        }
    });

    test('a branch-pinned admin always creates at their own branch (body branch ignored)', async () => {
        const res = await create(second.admin, { name: `Pin-${rand()}`, capacity: 2, area: String(second.area._id), branch: String(A.branch._id) });
        expect(res.status).toBe(201);
        expect(String((await Table.findById(res.body.table._id).lean()).branch)).toBe(String(second.branch._id));
    });

    // Regression (fixed 2026-10): the duplicate check and the unique { name, area } index skip soft-deleted tables.
    test('a soft-deleted table\'s name can be reused in its area', async () => {
        const name = `Reuse-${rand()}`;
        const first = await create(A.users.admin, { name, capacity: 2, area: String(A.area._id) });
        expect(first.status).toBe(201);
        expect((await ctx.api.as(A.users.admin).delete(`/tables/${first.body.table._id}`)).status).toBe(200);
        const again = await create(A.users.admin, { name, capacity: 2, area: String(A.area._id) });
        expect(again.status).toBe(201);
    });

    describe('update (PUT /tables/:id)', () => {
        test.each([
            ['qrToken', { qrToken: 'tb-aaaaaaaaaaaa' }],
            ['activeOrder', { activeOrder: '64b000000000000000000000' }],
            ['capacity 0', { capacity: 0 }],
            ['status bogus', { status: 'bogus' }],
            ['isActive "yes"', { isActive: 'yes' }],
        ])('%s → 400', async (_l, body) => {
            const table = await createTable(A);
            const res = await ctx.api.as(A.users.admin).put(`/tables/${table._id}`).send(body);
            expect(res.status).toBe(400);
            const saved = await Table.findById(table._id).select('+qrToken').lean();
            expect(saved.qrToken).toBe(table.qrToken);
            expect(saved.capacity).toBe(table.capacity);
        });

        test('renaming onto an existing name in the same area → 400', async () => {
            const a = await createTable(A, { name: `Ren-a-${rand()}` });
            const b = await createTable(A, { name: `Ren-b-${rand()}` });
            const res = await ctx.api.as(A.users.admin).put(`/tables/${b._id}`).send({ name: a.name });
            expect(res.status).toBe(400);
            expect((await Table.findById(b._id).lean()).name).toBe(b.name);
        });

        test('a Second-branch captain cannot edit a Main-branch table (BRANCH_MISMATCH)', async () => {
            const table = await createTable(A);
            const res = await ctx.api.as(second.captain).put(`/tables/${table._id}`).send({ capacity: 9 });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('BRANCH_MISMATCH');
            expect((await Table.findById(table._id).lean()).capacity).toBe(4);
        });

        test('setting status free wipes the diner snapshot', async () => {
            const table = await createTable(A);
            await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied', currentDiner: { name: 'Asha', phone: '9000000000', isRegistered: false } } });
            const res = await ctx.api.as(A.users.captain).put(`/tables/${table._id}`).send({ status: 'free' });
            expect(res.status).toBe(200);
            const saved = await Table.findById(table._id).lean();
            expect(saved.status).toBe('free');
            expect(saved.currentDiner.name).toBe('');
            expect(saved.currentDiner.phone).toBe('');
        });
    });
});

describe('claim (POST /tables/:id/claim)', () => {
    test('customer claims the table they scanned; currentDiner is set', async () => {
        const table = await createTable(A);
        const cust = await createCustomer('claim');
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.customerAtTable(cust, A, scanToken).post(`/tables/${table._id}/claim`).send({});
        expect(res.status).toBe(200);
        const saved = await reloadTable(table._id);
        expect(String(saved.currentDiner.user)).toBe(String(cust._id));
        expect(saved.currentDiner.isRegistered).toBe(true);
        // Joined the existing seat — no second seat.
        expect(saved.seats).toHaveLength(1);
        // Idempotent.
        expect((await ctx.api.customerAtTable(cust, A, scanToken).post(`/tables/${table._id}/claim`).send({})).status).toBe(200);
        expect((await reloadTable(table._id)).seats).toHaveLength(1);
    });

    test('a second customer gets 409 TABLE_CLAIMED_BY_OTHER and the snapshot is kept', async () => {
        const table = await createTable(A);
        const c1 = await createCustomer('claim1');
        const c2 = await createCustomer('claim2');
        expect((await ctx.api.as(c1, A).post(`/tables/${table._id}/claim`).send({})).status).toBe(200);
        const res = await ctx.api.as(c2, A).post(`/tables/${table._id}/claim`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_CLAIMED_BY_OTHER');
        expect(String((await reloadTable(table._id)).currentDiner.user)).toBe(String(c1._id));
    });

    test.each(['admin', 'waiter', 'captain', 'chef'])('%s (staff) → 403', async (role) => {
        const table = await createTable(A);
        const res = await ctx.api.as(A.users[role]).post(`/tables/${table._id}/claim`).send({});
        expect(res.status).toBe(403);
        expect((await reloadTable(table._id)).currentDiner?.user ?? null).toBeNull();
    });

    test('deleted → 404, disabled → 409, other tenant → 404, bad id → 400, anonymous → 401', async () => {
        const cust = await createCustomer('claim-edge');
        const del = await createTable(A);
        await Table.updateOne({ _id: del._id }, { $set: { isDeleted: true, status: 'disabled' } });
        expect((await ctx.api.as(cust, A).post(`/tables/${del._id}/claim`).send({})).status).toBe(404);

        const dis = await createTable(A);
        await Table.updateOne({ _id: dis._id }, { $set: { status: 'disabled' } });
        const r = await ctx.api.as(cust, A).post(`/tables/${dis._id}/claim`).send({});
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('TABLE_DISABLED');

        expect((await ctx.api.as(cust, A).post(`/tables/${B.tables.main._id}/claim`).send({})).status).toBe(404);
        expect((await ctx.api.as(cust, A).post('/tables/not-an-id/claim').send({})).status).toBe(400);
        expect((await ctx.api.guest(A).post(`/tables/${dis._id}/claim`).send({})).status).toBe(401);
    });

    test('a customer cannot claim a seat at a full table', async () => {
        const table = await createTable(A, { capacity: 1 });
        expect((await scanTable(ctx.api, table)).res.status).toBe(200);
        const cust = await createCustomer('claim-full');
        const res = await ctx.api.as(cust, A).post(`/tables/${table._id}/claim`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_CAPACITY_REACHED');
        expect((await reloadTable(table._id)).currentDiner?.user ?? null).toBeNull();
    });
});

describe('merge / unmerge', () => {
    const merge = (user, ids) => ctx.api.as(user).post('/tables/merge').send({ tableIds: ids.map(String) });

    test('happy path: every member becomes merged and points at the others; unmerge frees all', async () => {
        const [t1, t2, t3] = [await createTable(A), await createTable(A), await createTable(A)];
        const res = await merge(A.users.waiter, [t1._id, t2._id, t3._id]);
        expect(res.status).toBe(200);
        for (const t of [t1, t2, t3]) {
            const saved = await reloadTable(t._id);
            expect(saved.status).toBe('merged');
            expect(saved.mergedWith.map(String).sort())
                .toEqual([t1, t2, t3].filter((x) => x !== t).map((x) => String(x._id)).sort());
        }
        const un = await ctx.api.as(A.users.captain).post('/tables/unmerge').send({ tableId: String(t2._id) });
        expect(un.status).toBe(200);
        for (const t of [t1, t2, t3]) {
            const saved = await reloadTable(t._id);
            expect(saved.status).toBe('free');
            expect(saved.mergedWith).toEqual([]);
        }
    });

    test.each([
        ['one table', async () => [await createTable(A)], 400],
        ['different areas', async () => {
            const other = await Area.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: `Roof ${rand()}` });
            return [await createTable(A), await createTable(A, { area: other._id })];
        }, 400],
        ['two occupied tables', async () => {
            const ts = [await createTable(A), await createTable(A)];
            await Table.updateMany({ _id: { $in: ts.map((t) => t._id) } }, { $set: { status: 'occupied' } });
            return ts;
        }, 400],
        ['a reserved table', async () => {
            const ts = [await createTable(A), await createTable(A)];
            await Table.updateOne({ _id: ts[0]._id }, { $set: { status: 'reserved' } });
            return ts;
        }, 400],
        ['an alert table', async () => {
            const ts = [await createTable(A), await createTable(A)];
            await Table.updateOne({ _id: ts[0]._id }, { $set: { status: 'alert' } });
            return ts;
        }, 400],
        ['an already merged table', async () => {
            const ts = [await createTable(A), await createTable(A)];
            await Table.updateOne({ _id: ts[0]._id }, { $set: { status: 'merged' } });
            return ts;
        }, 400],
        ['another tenant\'s table', async () => [await createTable(A), B.tables.small], 404],
    ])('refused: %s', async (_l, build, status) => {
        const ts = await build();
        const before = await Promise.all(ts.map((t) => Table.findById(t._id).lean()));
        const res = await merge(A.users.admin, ts.map((t) => t._id));
        expect(res.status).toBe(status);
        const after = await Promise.all(ts.map((t) => Table.findById(t._id).lean()));
        expect(after.map((t) => t.status)).toEqual(before.map((t) => t.status));
        expect(after.every((t) => !t.mergedWith?.length)).toBe(true);
    });

    test('one occupied + free tables may merge; a chef (no tables permission) may not', async () => {
        const ts = [await createTable(A), await createTable(A)];
        expect((await merge(A.users.chef, ts.map((t) => t._id))).status).toBe(403);
        await Table.updateOne({ _id: ts[0]._id }, { $set: { status: 'occupied' } });
        expect((await merge(A.users.admin, ts.map((t) => t._id))).status).toBe(200);
    });

    test('unmerge is refused while the group holds a live order; unmerge of a plain table → 400', async () => {
        const ts = [await createTable(A), await createTable(A)];
        expect((await merge(A.users.admin, ts.map((t) => t._id))).status).toBe(200);
        const scan = await scanTable(ctx.api, ts[1]);
        const leaderId = jwt.decode(scan.scanToken).tableId;
        const leader = ts.find((t) => String(t._id) === leaderId);
        const { order } = await guestOrder({ table: leader, scanToken: scan.scanToken });

        const un = await ctx.api.as(A.users.admin).post('/tables/unmerge').send({ tableId: String(ts[0]._id) });
        expect(un.status).toBe(400);
        expect((await reloadTable(ts[0]._id)).status).toBe('merged');

        // Paying the leader's (ready) order frees + unmerges the whole group.
        // Updated 2026-10: a NEW order is no longer auto-served on payment.
        await Order.updateOne({ _id: order._id }, { $set: { status: 'ready' } });
        const pay = await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        for (const t of ts) {
            const saved = await reloadTable(t._id);
            expect(saved.status).toBe('free');
            expect(saved.mergedWith).toEqual([]);
            expect(saved.activeOrder).toBeNull();
            expect(saved.seats).toEqual([]);
        }
        const plain = await ctx.api.as(A.users.admin).post('/tables/unmerge').send({ tableId: String(ts[0]._id) });
        expect(plain.status).toBe(400);
    });

    test('a merged member cannot be deleted', async () => {
        const ts = [await createTable(A), await createTable(A)];
        expect((await merge(A.users.admin, ts.map((t) => t._id))).status).toBe(200);
        const del = await ctx.api.as(A.users.admin).delete(`/tables/${ts[1]._id}`);
        expect(del.status).toBe(400);
        expect((await Table.findById(ts[1]._id).lean()).isDeleted).not.toBe(true);
    });
});

describe('free table (POST /tables/:id/free)', () => {
    test('an open bill needs force: 409 preview with the exact amount, then force writes it off', async () => {
        const first = await guestOrder({ lines: [[A.items.paneer, 1]] });
        const second_ = await guestOrder({ table: first.table, scanToken: first.scanToken, lines: [[A.items.paneer, 2]] });
        const expected = Math.round((bill(200).total + bill(400).total) * 100) / 100;
        expect(expected).toBe(730); // 250 + 480

        const preview = await ctx.api.as(A.users.captain).post(`/tables/${first.table._id}/free`).send({});
        expect(preview.status).toBe(409);
        expect(preview.body.code).toBe('ORDER_NOT_EMPTY');
        expect(preview.body.orderCount).toBe(2);
        expect(preview.body.totalAmount).toBe(expected);
        expect((await reload(first.order._id)).status).toBe('new');

        const forced = await ctx.api.as(A.users.admin).post(`/tables/${first.table._id}/free`).send({ force: true, reason: 'test reset' });
        expect(forced.status).toBe(200);
        expect(forced.body.closedOrderCount).toBe(2);
        for (const o of [first.order, second_.order]) {
            const saved = await reload(o._id);
            expect(saved.status).toBe('cancelled');
            expect(saved.cancelReason).toBe('walkout');
        }
        const t = await reloadTable(first.table._id);
        expect(t.status).toBe('free');
        expect(t.seats).toEqual([]);
    });

    test('a waiter cannot free a table; a table with nothing open frees without force', async () => {
        const table = await createTable(A);
        await scanTable(ctx.api, table);
        expect((await ctx.api.as(A.users.waiter).post(`/tables/${table._id}/free`).send({})).status).toBe(403);
        const res = await ctx.api.as(A.users.captain).post(`/tables/${table._id}/free`).send({});
        expect(res.status).toBe(200);
        expect(res.body.closedOrderCount).toBe(0);
        expect((await reloadTable(table._id)).status).toBe('free');
    });
});

describe('table listings', () => {
    test('GET /tables: staff only, deleted tables hidden, a pinned user sees only their branch, filters work', async () => {
        const del = await createTable(A, { name: `List-del-${rand()}` });
        await Table.updateOne({ _id: del._id }, { $set: { isDeleted: true, status: 'disabled' } });
        const secondTable = await createTable(A, { name: `List-2nd-${rand()}`, branch: second.branch._id, area: second.area._id });

        const cust = await createCustomer('list');
        expect((await ctx.api.as(cust, A).get('/tables')).status).toBe(403);

        const owner = await ctx.api.as(A.users.admin).get('/tables');
        expect(owner.status).toBe(200);
        const ownerIds = owner.body.tables.map((t) => String(t._id));
        expect(ownerIds).not.toContain(String(del._id));
        expect(ownerIds).toContain(String(secondTable._id));
        expect(owner.body.tables.every((t) => String(t.restaurant) === String(A.restaurant._id))).toBe(true);

        const pinned = await ctx.api.as(second.waiter).get('/tables');
        const pinnedIds = pinned.body.tables.map((t) => String(t._id));
        expect(pinnedIds).toContain(String(secondTable._id));
        expect(pinnedIds).not.toContain(String(A.tables.main._id));

        const byArea = await ctx.api.as(A.users.admin).get(`/tables?area=${second.area._id}`);
        expect(byArea.body.tables.map((t) => String(t._id))).toContain(String(secondTable._id));
        expect(byArea.body.tables.every((t) => String(t.area?._id || t.area) === String(second.area._id))).toBe(true);
        const narrowed = await ctx.api.as(A.users.admin).get(`/tables?branch=${second.branch._id}&status=free`);
        expect(narrowed.body.tables.length).toBeGreaterThan(0);
        expect(narrowed.body.tables.every((t) => t.status === 'free'
            && String(t.branch?._id || t.branch) === String(second.branch._id))).toBe(true);
    });

    test('GET /tables/bookable: customer view hides disabled / inactive-area tables and leaks no diner data', async () => {
        const cust = await createCustomer('bookable');
        const offArea = await Area.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: `Closed ${rand()}`, isActive: false });
        const hidden = await createTable(A, { area: offArea._id });
        const disabled = await createTable(A);
        await Table.updateOne({ _id: disabled._id }, { $set: { status: 'disabled' } });
        const busy = await createTable(A);
        await Table.updateOne({ _id: busy._id }, { $set: { status: 'occupied', currentDiner: { name: 'Secret Diner', phone: '9111111111' } } });

        const res = await ctx.api.as(cust, A).get('/tables/bookable');
        expect(res.status).toBe(200);
        const ids = res.body.tables.map((t) => String(t._id));
        expect(ids).not.toContain(String(hidden._id));
        expect(ids).not.toContain(String(disabled._id));
        const busyRow = res.body.tables.find((t) => String(t._id) === String(busy._id));
        expect(busyRow.isAvailable).toBe(false);
        expect(Object.keys(busyRow).sort()).toEqual(['_id', 'area', 'capacity', 'isAvailable', 'name']);
        expect(JSON.stringify(res.body)).not.toContain('Secret Diner');
        expect((await ctx.api.as(cust, A).get('/tables/bookable?area=nope')).status).toBe(400);
    });
});

describe('assign waiter (PUT /tables/:id/assign)', () => {
    test('captain assigns a same-branch waiter; open requests follow the table; clearing works', async () => {
        const table = await createTable(A);
        const reqDoc = await Request.create({ restaurant: A.restaurant._id, branch: A.branch._id, table: table._id, type: 'water' });
        const res = await ctx.api.as(A.users.captain).put(`/tables/${table._id}/assign`).send({ waiterId: String(A.users.waiter._id) });
        expect(res.status).toBe(200);
        expect(String((await Table.findById(table._id).lean()).assignedWaiter)).toBe(String(A.users.waiter._id));
        const handed = await Request.findById(reqDoc._id).lean();
        expect(handed.status).toBe('accepted');
        expect(String(handed.waiter)).toBe(String(A.users.waiter._id));

        const clear = await ctx.api.as(A.users.captain).put(`/tables/${table._id}/assign`).send({ waiterId: null });
        expect(clear.status).toBe(200);
        expect((await Table.findById(table._id).lean()).assignedWaiter).toBeNull();
    });

    test.each([
        ['a chef', async () => A.users.chef._id, 404],
        ['a customer', async () => (await createCustomer('assign'))._id, 404],
        ['another tenant\'s waiter', async () => B.users.waiter._id, 404],
        ['a Second-branch waiter', async () => second.waiter._id, 400],
    ])('refuses %s as the waiter', async (_l, who, status) => {
        const table = await createTable(A);
        const res = await ctx.api.as(A.users.admin).put(`/tables/${table._id}/assign`).send({ waiterId: String(await who()) });
        expect(res.status).toBe(status);
        expect((await Table.findById(table._id).lean()).assignedWaiter ?? null).toBeNull();
    });

    test('waiter cannot assign; Second-branch captain cannot touch a Main table', async () => {
        const table = await createTable(A);
        const body = { waiterId: String(A.users.waiter._id) };
        expect((await ctx.api.as(A.users.waiter).put(`/tables/${table._id}/assign`).send(body)).status).toBe(403);
        const cross = await ctx.api.as(second.captain).put(`/tables/${table._id}/assign`).send(body);
        expect(cross.status).toBe(403);
        expect(cross.body.code).toBe('BRANCH_MISMATCH');
    });
});

describe('QR token regeneration (POST /tables/:id/qr-token)', () => {
    test('the old sticker stops resolving and the new one scans; captain / other tenant refused', async () => {
        const table = await createTable(A);
        expect((await ctx.api.as(A.users.captain).post(`/tables/${table._id}/qr-token`).send({})).status).toBe(403);
        const res = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/qr-token`).send({});
        expect(res.status).toBe(200);
        const saved = await Table.findById(table._id).select('+qrToken').lean();
        expect(saved.qrToken).not.toBe(table.qrToken);
        expect(saved.qrToken).toMatch(/^tb-[a-f0-9]{12}$/);
        expect((await scanTable(ctx.api, table)).res.status).toBe(404);
        expect((await scanTable(ctx.api, { qrToken: saved.qrToken })).res.status).toBe(200);
        expect((await ctx.api.as(B.users.admin).post(`/tables/${table._id}/qr-token`).send({})).status).toBe(404);
    });
});

describe('CSV bulk import (POST /tables/import)', () => {
    const upload = (user, csv, name = 'tables.csv') => ctx.api.as(user).post('/tables/import')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: name, contentType: 'text/csv' });

    test('template downloads as CSV (admin only)', async () => {
        const res = await ctx.api.as(A.users.admin).get('/tables/template').buffer(true).parse((r, cb) => {
            let data = '';
            r.on('data', (c) => { data += c; });
            r.on('end', () => cb(null, data));
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.body).toMatch(/^area,name,capacity/);
        expect((await ctx.api.as(A.users.waiter).get('/tables/template')).status).toBe(403);
    });

    test('imports valid rows, creates missing areas, skips duplicates and reports bad rows', async () => {
        const area = `Garden ${rand()}`;
        const csv = [
            'Area,Name,Capacity',
            `${area},G1,4`,
            `${area},G2,2`,
            `${area.toUpperCase()},g1,4`,
            `${area},G3,0`,
            `${area},G4,51`,
            `${area},,2`,
            ',G5,2',
            `${A.area.name},${A.tables.main.name},4`,
        ].join('\n');
        // Import into Main (areas are matched per branch).
        const res = await ctx.api.as(A.users.admin).post(`/tables/import?branch=${A.branch._id}`)
            .attach('file', Buffer.from(csv, 'utf8'), { filename: 'tables.csv', contentType: 'text/csv' });
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(2);
        expect(res.body.areasCreated).toBe(1);
        expect(res.body.errorCount).toBe(4);
        expect(res.body.skippedCount).toBe(2);
        const made = await Table.find({ restaurant: A.restaurant._id, name: { $in: ['G1', 'G2'] } }).select('+qrToken').lean();
        expect(made).toHaveLength(2);
        expect(made.every((t) => /^tb-[a-f0-9]{12}$/.test(t.qrToken))).toBe(true);
        expect((await scanTable(ctx.api, { qrToken: made[0].qrToken })).res.status).toBe(200);
    });

    test('missing columns / header only / no file → 400; non-csv refused; captain refused', async () => {
        expect((await upload(A.users.admin, 'area,name\nX,Y')).status).toBe(400);
        expect((await upload(A.users.admin, 'area,name,capacity')).status).toBe(400);
        expect((await ctx.api.as(A.users.admin).post('/tables/import').send({})).status).toBe(400);
        const bin = await ctx.api.as(A.users.admin).post('/tables/import')
            .attach('file', Buffer.from('x'), { filename: 'evil.exe', contentType: 'application/octet-stream' });
        expect(bin.status).not.toBe(200);
        expect((await upload(A.users.captain, 'area,name,capacity\nX,Y,2')).status).toBe(403);
    });

    test('a branch-pinned admin imports into their own branch', async () => {
        const res = await upload(second.admin, `area,name,capacity\nSecond Imported ${rand()},S-IMP-1,2`);
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(1);
        const t = await Table.findOne({ restaurant: A.restaurant._id, name: 'S-IMP-1' }).lean();
        expect(String(t.branch)).toBe(String(second.branch._id));
    });
});

// Regression (fixed 2026-10): freeTable, mergeTables, unmergeTables and deleteTable enforce the branch pin (BRANCH_MISMATCH).
describe('cross-branch staff on table write endpoints', () => {
    test('a Second-branch admin cannot force-free a Main-branch table and write off its bill', async () => {
        const { order, table } = await guestOrder();
        const res = await ctx.api.as(second.admin).post(`/tables/${table._id}/free`).send({ force: true, reason: 'test reset' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
        expect((await reload(order._id)).status).toBe('new');
    });

    test('a Second-branch waiter cannot merge Main-branch tables', async () => {
        const ts = [await createTable(A), await createTable(A)];
        const res = await ctx.api.as(second.waiter).post('/tables/merge').send({ tableIds: ts.map((t) => String(t._id)) });
        expect(res.status).toBe(403);
        expect((await reloadTable(ts[0]._id)).status).toBe('free');
    });

    test('a Second-branch admin cannot delete a Main-branch table', async () => {
        const table = await createTable(A);
        const res = await ctx.api.as(second.admin).delete(`/tables/${table._id}`);
        expect(res.status).toBe(403);
        expect((await Table.findById(table._id).lean()).isDeleted).not.toBe(true);
        await settle();
    });
});
