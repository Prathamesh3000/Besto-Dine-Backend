/**
 * Operations profile, phase (d) — the remaining toggles
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §5.4). One server rule per toggle,
 * each with a regression test proving a tenant WITHOUT a profile behaves
 * exactly as before.
 *
 *   - orderFlow.staffOrder:false → waiter / captain create 403
 *     STAFF_ORDER_DISABLED; admin (POS) still allowed
 *   - chef module off, waiters on → the waiter serves a 'new' order
 *     straight from the pickup path, stock deducted
 *   - customerApp.appendToOrder:false → customer repeat 403 APPEND_DISABLED
 *   - tables.mergeTables:false → merge / unmerge 400 MERGE_DISABLED
 *   - orderFlow.customerSelfOrder:false → guest QR order 403
 *     SELF_ORDER_DISABLED; staff orders still work
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const { normaliseProfile, profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');

let D;   // default: no operations field at all

beforeAll(async () => {
    D = await seedTenant({ label: 'dflt' });
});

async function tenantWith(label, profile) {
    const t = await seedTenant({ label });
    await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { operations: normaliseProfile(profile) } });
    return t;
}

const dineInTotal = (t) => computeBill({ subtotal: 400, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;

const placeOrder = (client, t, table, extra = {}) => client.post('/orders').send({
    type: 'dine-in',
    tableId: String(table._id),
    items: [{ menuItem: String(t.items.paneer._id), quantity: 2 }],
    total: dineInTotal(t),
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
    ...extra,
});

async function guestAt(t) {
    const table = await createTable(t);
    const { scanToken } = await scanTable(ctx.api, table);
    return { table, guest: ctx.api.guest(t, scanToken) };
}

const reload = (id) => Order.findById(id).lean();

describe('orderFlow.staffOrder = false', () => {
    let S;
    beforeAll(async () => {
        S = await tenantWith('nostaff', { advanced: { 'orderFlow.staffOrder': false } });
    });

    test('waiter and captain cannot create orders → 403 STAFF_ORDER_DISABLED, nothing created', async () => {
        const before = await Order.countDocuments({ restaurant: S.restaurant._id });
        for (const role of ['waiter', 'captain']) {
            const table = await createTable(S);
            const res = await placeOrder(ctx.api.as(S.users[role], S), S, table);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('STAFF_ORDER_DISABLED');
        }
        expect(await Order.countDocuments({ restaurant: S.restaurant._id })).toBe(before);
    });

    test('admin (POS / counter) can still create orders', async () => {
        const table = await createTable(S);
        const res = await placeOrder(ctx.api.as(S.users.admin, S), S, table);
        expect(res.status).toBe(201);
    });

    test('regression: without a profile the waiter and captain still create orders', async () => {
        for (const role of ['waiter', 'captain']) {
            const table = await createTable(D);
            const res = await placeOrder(ctx.api.as(D.users[role], D), D, table);
            expect(res.status).toBe(201);
        }
    });
});

describe('kitchen screen off, waiters on: the waiter serves a new order', () => {
    let K;
    beforeAll(async () => {
        K = await tenantWith('nokds', {
            modules: { qrOrdering: true, waiter: true, captain: true, chef: false, customerPayment: true },
        });
    });

    test('order stays new, waiter pickup → served with stock deducted', async () => {
        const table = await createTable(K);
        const created = await placeOrder(ctx.api.as(K.users.admin, K), K, table);
        expect(created.status).toBe(201);
        const id = created.body.order._id;
        expect((await reload(id)).status).toBe('new');

        const res = await ctx.api.as(K.users.waiter, K).patch(`/orders/${id}/pickup`).send({});
        expect(res.status).toBe(200);
        const o = await reload(id);
        expect(o.status).toBe('served');
        expect(o.servedAt).toBeTruthy();
        expect(o.inventoryDeducted).toBe(true);
    });

    test('the general status endpoint still refuses new → served', async () => {
        const table = await createTable(K);
        const created = await placeOrder(ctx.api.as(K.users.admin, K), K, table);
        const res = await ctx.api.as(K.users.admin, K).patch(`/orders/${created.body.order._id}/status`).send({ status: 'served' });
        expect(res.status).toBe(409);
        expect((await reload(created.body.order._id)).status).toBe('new');
    });

    test('regression: without a profile a waiter cannot serve a new order', async () => {
        const table = await createTable(D);
        const created = await placeOrder(ctx.api.as(D.users.admin, D), D, table);
        const id = created.body.order._id;
        const res = await ctx.api.as(D.users.waiter, D).patch(`/orders/${id}/pickup`).send({});
        expect(res.status).toBe(400);
        const o = await reload(id);
        expect(o.status).toBe('new');
        expect(o.inventoryDeducted).not.toBe(true);
    });
});

describe('customerApp.appendToOrder = false', () => {
    test('customer repeat-all → 403 APPEND_DISABLED', async () => {
        const A = await tenantWith('noappend', { advanced: { 'customerApp.appendToOrder': false } });
        const { table, guest } = await guestAt(A);
        const created = await placeOrder(guest, A, table);
        expect(created.status).toBe(201);
        const res = await guest.post(`/orders/${created.body.order._id}/repeat-all`).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPEND_DISABLED');
    });

    test('regression: without a profile the customer can repeat', async () => {
        const { table, guest } = await guestAt(D);
        const created = await placeOrder(guest, D, table);
        expect(created.status).toBe(201);
        const res = await guest.post(`/orders/${created.body.order._id}/repeat-all`).send({});
        expect([200, 201]).toContain(res.status);
    });
});

describe('tables.mergeTables = false', () => {
    test('merge and unmerge → 400 MERGE_DISABLED', async () => {
        const M = await tenantWith('nomerge', { advanced: { 'tables.mergeTables': false } });
        const a = await createTable(M);
        const b = await createTable(M);
        const admin = ctx.api.as(M.users.admin, M);
        const merge = await admin.post('/tables/merge').send({ tableIds: [String(a._id), String(b._id)] });
        expect(merge.status).toBe(400);
        expect(merge.body.code).toBe('MERGE_DISABLED');
        const unmerge = await admin.post('/tables/unmerge').send({ tableId: String(a._id) });
        expect(unmerge.status).toBe(400);
        expect(unmerge.body.code).toBe('MERGE_DISABLED');
    });

    test('regression: without a profile tables merge and unmerge', async () => {
        const a = await createTable(D);
        const b = await createTable(D);
        const admin = ctx.api.as(D.users.admin, D);
        const merge = await admin.post('/tables/merge').send({ tableIds: [String(a._id), String(b._id)] });
        expect(merge.status).toBe(200);
        const unmerge = await admin.post('/tables/unmerge').send({ tableId: String(b._id) });
        expect(unmerge.status).toBe(200);
    });
});

describe('orderFlow.customerSelfOrder = false (QR menu only)', () => {
    let Q;
    beforeAll(async () => {
        Q = await tenantWith('noqr', {
            modules: { qrOrdering: false, waiter: true, captain: true, chef: true, customerPayment: true },
        });
    });

    test('guest dine-in QR order → 403 SELF_ORDER_DISABLED, nothing created', async () => {
        const { table, guest } = await guestAt(Q);
        const before = await Order.countDocuments({ restaurant: Q.restaurant._id });
        const res = await placeOrder(guest, Q, table);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SELF_ORDER_DISABLED');
        expect(await Order.countDocuments({ restaurant: Q.restaurant._id })).toBe(before);
    });

    test('staff orders still work', async () => {
        for (const role of ['admin', 'waiter']) {
            const table = await createTable(Q);
            const res = await placeOrder(ctx.api.as(Q.users[role], Q), Q, table);
            expect(res.status).toBe(201);
        }
    });

    test('regression: without a profile a guest can order from the QR', async () => {
        const { table, guest } = await guestAt(D);
        const res = await placeOrder(guest, D, table);
        expect(res.status).toBe(201);
    });
});

describe('pickup rule reads the profile, not the plan', () => {
    test('regression: no profile + plan without the kitchen screen → waiter still cannot serve a new order', async () => {
        const P = await seedTenant({ label: 'nokdsplan' });
        await Restaurant.updateOne({ _id: P.restaurant._id }, { $set: { 'subscription.features.kitchenDisplay': false } });
        const table = await createTable(P);
        const created = await placeOrder(ctx.api.as(P.users.admin, P), P, table);
        expect(created.status).toBe(201);
        const id = created.body.order._id;
        const res = await ctx.api.as(P.users.waiter, P).patch(`/orders/${id}/pickup`).send({});
        expect(res.status).toBe(400);
        expect((await reload(id)).status).toBe('new');
    });
});

describe('pay-first: paying one round does not settle the other rounds at the table', () => {
    test('held counter-cash round marked Paid → staff-entered unpaid round stays Pending', async () => {
        const F = await seedTenant({ label: 'pfsib' });
        await Restaurant.updateOne({ _id: F.restaurant._id }, { $set: { operations: profileFromPreset('cafeCounterPayFirst') } });
        const { table, guest } = await guestAt(F);
        const admin = ctx.api.as(F.users.admin, F);

        const staffRound = await placeOrder(admin, F, table);
        expect(staffRound.status).toBe(201);
        const held = await placeOrder(guest, F, table, { paymentIntent: 'counterCash' });
        expect(held.status).toBe(201);
        expect((await reload(held.body.order._id)).status).toBe('awaiting-payment');

        const pay = await admin.patch(`/orders/${held.body.order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        expect((await reload(held.body.order._id)).paymentStatus).toBe('Paid');
        const other = await reload(staffRound.body.order._id);
        expect(other.paymentStatus).toBe('Pending');
        expect(other.amountPaid || 0).toBe(0);
    });

    test('regression: without a profile paying one round still settles the table siblings', async () => {
        const table = await createTable(D);
        const admin = ctx.api.as(D.users.admin, D);
        const r1 = await placeOrder(admin, D, table);
        const r2 = await placeOrder(admin, D, table);
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        const pay = await admin.patch(`/orders/${r2.body.order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        expect((await reload(r1.body.order._id)).paymentStatus).toBe('Paid');
    });
});
