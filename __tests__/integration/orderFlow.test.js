/**
 * Dine-in order flow end to end, through the real HTTP stack:
 * QR scan → guest order (scan token) → server-side bill → kitchen →
 * waiter pickup → staff settlement → table freed. Plus idempotency,
 * append-items bill recompute, table capacity and deleted tables.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => {
    A = await seedTenant({ label: 'flow' });
});

// 2 × Paneer Tikka (200) + 1 × Veg Thali "Full" (250 − 10% = 225) = 625
function cart(t) {
    return [
        { menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 2, price: 1 },
        { menuItem: String(t.items.thali._id), name: 'Veg Thali', quantity: 1, price: 1, selectedSizes: [{ name: 'Full', price: 1 }] },
    ];
}
const expectedBill = (t, subtotal, orderType = 'dine-in') =>
    computeBill({ subtotal, taxConfig: toTaxConfig(t.settings.taxes), orderType });

async function guestOrder(t, table, { scanToken, body = {}, headers = {} } = {}) {
    let token = scanToken;
    if (!token) ({ scanToken: token } = await scanTable(ctx.api, table));
    let r = ctx.api.guest(t, token).post('/orders');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const bill = expectedBill(t, 625);
    const res = await r.send({ type: 'dine-in', tableId: String(table._id), items: cart(t), total: bill.total, ...body });
    return { res, scanToken: token };
}

describe('dine-in happy path', () => {
    let table;
    let scanToken;
    let order;

    beforeAll(async () => {
        table = await createTable(A, { name: 'Flow-1', capacity: 4 });
    });

    test('guest scan issues a scan token, occupies the table and names the tenant', async () => {
        const scan = await scanTable(ctx.api, table);
        expect(scan.res.status).toBe(200);
        expect(scan.scanToken).toEqual(expect.any(String));
        expect(scan.res.body.restaurant.slug).toBe(A.slug);
        scanToken = scan.scanToken;
        const t = await Table.findById(table._id).lean();
        expect(t.status).toBe('occupied');
    });

    test('guest places a dine-in order; server bill = utils/billing computeBill', async () => {
        const { res } = await guestOrder(A, table, { scanToken });
        expect(res.status).toBe(201);
        order = res.body.order;

        const bill = expectedBill(A, 625);
        expect(bill).toMatchObject({ subtotal: 625, gst: 31.25, serviceCharge: 62.5, additionalChargesTotal: 20, total: 738.75 });

        const saved = await Order.findById(order._id).lean();
        expect(saved.restaurant.toString()).toBe(A.restaurant._id.toString());
        expect(saved.branch.toString()).toBe(A.branch._id.toString());
        expect(saved.source).toBe('qr-scan');
        expect(saved.status).toBe('new');
        expect(saved.paymentStatus).toBe('Pending');
        // Client-sent prices (1) are ignored; canonical prices stamped.
        expect(saved.items.map((i) => i.price)).toEqual([200, 225]);
        expect(saved.gst).toBe(bill.gst);
        expect(saved.gstPercentage).toBe(5);
        expect(saved.serviceCharge).toBe(bill.serviceCharge);
        expect(saved.serviceChargePercentage).toBe(10);
        expect(saved.additionalChargesTotal).toBe(bill.additionalChargesTotal);
        expect(saved.total).toBe(bill.total);
        expect(saved.scanSessionId).toEqual(expect.any(String));

        const t = await Table.findById(table._id).lean();
        expect(t.status).toBe('occupied');
        expect(String(t.activeOrder)).toBe(String(order._id));
    });

    test('a waiter cannot move kitchen state (no updateOrderStatus permission)', async () => {
        const res = await ctx.api.as(A.users.waiter).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        expect(res.status).toBe(403);
    });

    test('chef moves the order new → preparing → ready and it shows on the KDS', async () => {
        const kds = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(kds.status).toBe(200);
        expect(JSON.stringify(kds.body)).toContain(order.orderId);

        const p = await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'preparing' });
        expect(p.status).toBe(200);
        expect(p.body.order.status).toBe('preparing');
        expect(p.body.order.chef).toBe(String(A.users.chef._id));
        expect(p.body.order.preparationStartedAt).toBeTruthy();

        // Skipping back is refused by the state machine.
        const back = await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'new' });
        expect(back.status).toBe(409);

        const r = await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'ready' });
        expect(r.status).toBe(200);
        expect(r.body.order.status).toBe('ready');
        expect(r.body.order.preparationCompletedAt).toBeTruthy();
    });

    test('waiter serves (pickup); the unpaid table stays occupied', async () => {
        const res = await ctx.api.as(A.users.waiter).patch(`/orders/${order._id}/pickup`).send({});
        expect(res.status).toBe(200);
        expect(res.body.order.status).toBe('served');
        const t = await Table.findById(table._id).lean();
        expect(t.status).toBe('occupied');
    });

    test('admin settles the bill → order Paid and table freed', async () => {
        const bill = expectedBill(A, 625);
        const res = await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: bill.total });
        expect(res.status).toBe(200);
        expect(res.body.order.paymentStatus).toBe('Paid');
        expect(res.body.order.status).toBe('served');
        expect(res.body.order.paidAt).toBeTruthy();

        const saved = await Order.findById(order._id).lean();
        expect(saved.amountPaid).toBe(bill.total);
        expect(saved.total).toBe(bill.total);
        const t = await Table.findById(table._id).lean();
        expect(t.status).toBe('free');
        expect(t.activeOrder).toBeNull();
        await settle();
    });
});

describe('server-side pricing guards', () => {
    test('takeaway: service charge never applies; inflated client total is clamped to the server bill', async () => {
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'takeaway',
            pickupLocation: 'Counter',
            items: cart(A),
            total: 900, // stale cart that still added service charge + more
        });
        expect(res.status).toBe(201);
        const bill = expectedBill(A, 625, 'takeaway');
        expect(bill.serviceCharge).toBe(0);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.serviceCharge).toBe(0);
        expect(saved.gst).toBe(bill.gst);
        expect(saved.total).toBe(bill.total); // 625 + 31.25 + 20 = 676.25
    });

    test('a client total below the item subtotal is rejected (TOTAL_TAMPERED)', async () => {
        const table = await createTable(A, { name: 'Tamper-1' });
        const { res } = await guestOrder(A, table, { body: { total: 100 } });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOTAL_TAMPERED');
    });

    // Regression: for dine-in the server used to stamp gst /
    // serviceCharge from computeBill but keep the CLIENT total as long
    // as it was >= subtotal - discounts, so a tampered client could drop
    // all tax and service charge from the amount due.
    test('dine-in: a client total that omits tax/service charge is rejected (TOTAL_MISMATCH)', async () => {
        const table = await createTable(A, { name: 'Tamper-2' });
        const { res } = await guestOrder(A, table, { body: { total: 625 } });
        const bill = expectedBill(A, 625);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOTAL_MISMATCH');
        expect(res.body.expectedTotal).toBe(bill.total);
    });

    test('dine-in: an inflated client total is stored as the server bill', async () => {
        const table = await createTable(A, { name: 'Tamper-3' });
        const { res } = await guestOrder(A, table, { body: { total: 900 } });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.total).toBe(expectedBill(A, 625).total);
    });

    test('kiosk (pays before the order exists): a total below the server bill is rejected', async () => {
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'takeaway', source: 'kiosk', pickupLocation: 'Kiosk - Takeaway Counter',
            items: cart(A), total: 625,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOTAL_MISMATCH');
    });

    test('kiosk: the exact server bill is accepted and stored', async () => {
        const bill = expectedBill(A, 625, 'takeaway');
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'takeaway', source: 'kiosk', pickupLocation: 'Kiosk - Takeaway Counter',
            items: cart(A), total: bill.total,
        });
        expect(res.status).toBe(201);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.source).toBe('kiosk');
        expect(saved.total).toBe(bill.total);
    });

    // Regression: createOrder priced each line from the menu item but
    // kept the CLIENT's `name` (enrichCartItems spread the cart item), so
    // the KOT / bill / invoice showed whatever the client typed.
    test('order line names come from the menu item, not the client', async () => {
        const table = await createTable(A, { name: 'Name-1' });
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in',
            tableId: String(table._id),
            items: [
                { menuItem: String(A.items.paneer._id), name: 'Lobster Thermidor', quantity: 1 },
                { menuItem: String(A.items.thali._id), name: 'Caviar', quantity: 1, selectedSizes: [{ name: 'full' }] },
            ],
            total: expectedBill(A, 425).total,
        });
        expect(res.status).toBe(201);
        expect(res.body.order.items.map((i) => i.name)).toEqual(['Paneer Tikka', 'Veg Thali']);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.items[1].selectedSizes.map((sz) => sz.name)).toEqual(['Full']);
    });

    // Regression: a cart line without `name` was a 500 ("Order
    // validation failed: items.0.name").
    test('a cart line without a client-sent name is accepted (name from the menu)', async () => {
        const table = await createTable(A, { name: 'Name-2' });
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in',
            tableId: String(table._id),
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }],
            total: expectedBill(A, 200).total,
        });
        expect(res.status).toBe(201);
        expect(res.body.order.items[0].name).toBe('Paneer Tikka');
    });

    test('an unknown size is rejected', async () => {
        const table = await createTable(A, { name: 'Size-1' });
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in',
            tableId: String(table._id),
            items: [{ menuItem: String(A.items.thali._id), name: 'Veg Thali', quantity: 1, selectedSizes: [{ name: 'Jumbo' }] }],
            total: 500,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_SIZE');
    });

    test('guest dine-in without a scan token is refused', async () => {
        const table = await createTable(A, { name: 'NoScan-1' });
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'dine-in', tableId: String(table._id), items: cart(A), total: 738.75,
        });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SCAN_TOKEN_REQUIRED');
    });

    test('a scan token for table X cannot order to table Y', async () => {
        const x = await createTable(A, { name: 'X-1' });
        const y = await createTable(A, { name: 'Y-1' });
        const { scanToken } = await scanTable(ctx.api, x);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(y._id), items: cart(A), total: 738.75,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCAN_TOKEN_MISMATCH');
    });
});

describe('idempotency', () => {
    test('same Idempotency-Key + clientIdempotencyKey sent twice creates ONE order', async () => {
        const table = await createTable(A, { name: 'Idem-1' });
        const { scanToken } = await scanTable(ctx.api, table);
        const key = `idem-seq-${Date.now()}-abcdef`;
        const opts = { scanToken, body: { clientIdempotencyKey: key }, headers: { 'Idempotency-Key': key } };

        const first = await guestOrder(A, table, opts);
        expect(first.res.status).toBe(201);
        await settle(100); // the Idempotency-Key record is written after the response
        const second = await guestOrder(A, table, opts);
        expect([200, 201]).toContain(second.res.status);
        expect(second.res.body.order._id).toBe(first.res.body.order._id);

        const count = await Order.countDocuments({ restaurant: A.restaurant._id, clientIdempotencyKey: key });
        expect(count).toBe(1);
    });

    test('clientIdempotencyKey alone (no header) replays the original order', async () => {
        const table = await createTable(A, { name: 'Idem-2' });
        const { scanToken } = await scanTable(ctx.api, table);
        const key = `idem-body-${Date.now()}-abcdef`;
        const first = await guestOrder(A, table, { scanToken, body: { clientIdempotencyKey: key } });
        const second = await guestOrder(A, table, { scanToken, body: { clientIdempotencyKey: key } });
        expect(first.res.status).toBe(201);
        expect(second.res.status).toBe(200);
        expect(second.res.body.idempotent).toBe(true);
        expect(second.res.body.order._id).toBe(first.res.body.order._id);
        expect(await Order.countDocuments({ clientIdempotencyKey: key })).toBe(1);
    });

    test('two CONCURRENT creates with the same clientIdempotencyKey still create one order', async () => {
        const table = await createTable(A, { name: 'Idem-3' });
        const { scanToken } = await scanTable(ctx.api, table);
        const key = `idem-race-${Date.now()}-abcdef`;
        const [a, b] = await Promise.all([
            guestOrder(A, table, { scanToken, body: { clientIdempotencyKey: key } }),
            guestOrder(A, table, { scanToken, body: { clientIdempotencyKey: key } }),
        ]);
        expect([a.res.status, b.res.status].sort()).toEqual([200, 201]);
        expect(a.res.body.order._id).toBe(b.res.body.order._id);
        expect(await Order.countDocuments({ clientIdempotencyKey: key })).toBe(1);
    });
});

describe('append items (second KOT round)', () => {
    test('waiter appends items; total is recomputed WITH tax and service charge', async () => {
        const table = await createTable(A, { name: 'Append-1' });
        const { res } = await guestOrder(A, table);
        expect(res.status).toBe(201);
        const before = expectedBill(A, 625);

        const append = await ctx.api.as(A.users.waiter).post(`/orders/${res.body.order._id}/append`)
            .send({ items: [{ menuItem: String(A.items.naan._id), name: 'Garlic Naan', quantity: 2, price: 1 }] });
        expect(append.status).toBe(200);

        const after = expectedBill(A, 625 + 80);
        const saved = await Order.findById(res.body.order._id).lean();
        expect(saved.items).toHaveLength(3);
        expect(saved.gst).toBe(after.gst);
        expect(saved.serviceCharge).toBe(after.serviceCharge);
        expect(saved.additionalChargesTotal).toBe(after.additionalChargesTotal); // flat charge not doubled
        expect(saved.total).toBe(after.total);
        expect(saved.total - before.total).toBeCloseTo(80 + 4 + 8, 2);
    });

    test('a chef cannot append (role gate)', async () => {
        const table = await createTable(A, { name: 'Append-2' });
        const { res } = await guestOrder(A, table);
        const append = await ctx.api.as(A.users.chef).post(`/orders/${res.body.order._id}/append`)
            .send({ items: [{ menuItem: String(A.items.naan._id), quantity: 1 }] });
        expect(append.status).toBe(403);
    });
});

describe('table capacity', () => {
    // QA #13 — the scan itself now reserves the seat. Previously the
    // early scanner held nothing until it ordered, so a second party
    // could also scan and whoever ordered first won; now the first
    // scan takes the only seat and every later party is refused at
    // scan time (before building a cart) and at order time.
    test('a second party cannot scan into or order at a full 1-seat table', async () => {
        const table = await createTable(A, { name: 'Cap-1', capacity: 1 });
        const p1 = await scanTable(ctx.api, table);
        expect(p1.res.status).toBe(200);

        const late = await scanTable(ctx.api, table);
        expect(late.res.status).toBe(409);
        expect(late.res.body.code).toBe('TABLE_CAPACITY_REACHED');

        const first = await guestOrder(A, table, { scanToken: p1.scanToken });
        expect(first.res.status).toBe(201);

        // A party holding a token from before the table filled up (its
        // seat released by a staff reset, say) is refused at order time.
        await Table.updateOne({ _id: table._id }, { $set: { seats: [] } });
        const intruder = await scanTable(ctx.api, table); // order-only party still counts → full
        expect(intruder.res.status).toBe(409);

        // The seated party can keep ordering.
        const p1again = await guestOrder(A, table, { scanToken: p1.scanToken });
        expect(p1again.res.status).toBe(201);
    });

    test('staff are never blocked by capacity', async () => {
        const table = await createTable(A, { name: 'Cap-2', capacity: 1 });
        expect((await guestOrder(A, table)).res.status).toBe(201);
        const res = await ctx.api.as(A.users.waiter).post('/orders').send({
            type: 'dine-in', tableId: String(table._id), items: cart(A), total: 738.75,
        });
        expect(res.status).toBe(201);
        expect(res.body.order.source).toBe('staff');
    });
});

describe('deleted tables', () => {
    test('a soft-deleted table rejects scans and orders (even with a pre-delete scan token)', async () => {
        const table = await createTable(A, { name: 'Del-1' });
        const { scanToken } = await scanTable(ctx.api, table);

        // The scan seats the guest; an occupied table must be freed first.
        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true });
        expect(free.status).toBe(200);

        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(200);
        const t = await Table.findById(table._id).lean();
        expect(t.isDeleted).toBe(true);

        const scan = await scanTable(ctx.api, table);
        expect(scan.res.status).toBe(404);

        const { res } = await guestOrder(A, table, { scanToken });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_UNAVAILABLE');
        expect(await Order.countDocuments({ table: table._id })).toBe(0);
    });

    test('a table with a live order cannot be deleted', async () => {
        const table = await createTable(A, { name: 'Del-2' });
        expect((await guestOrder(A, table)).res.status).toBe(201);
        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(400);
        expect(del.body.code).toBe('TABLE_HAS_ACTIVE_ORDER');
    });

    test('a table with a served but UNPAID order cannot be deleted', async () => {
        const table = await createTable(A, { name: 'Del-3' });
        const { res } = await guestOrder(A, table);
        expect(res.status).toBe(201);
        await Order.updateOne({ _id: res.body.order._id }, { $set: { status: 'served' } });

        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(400);
        expect(del.body.code).toBe('TABLE_HAS_ACTIVE_ORDER');
        expect((await Table.findById(table._id).lean()).isDeleted).not.toBe(true);
    });

    test('an occupied table (guest seated, no order yet) cannot be deleted', async () => {
        const table = await createTable(A, { name: 'Del-4' });
        expect((await scanTable(ctx.api, table)).res.status).toBe(200);
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');

        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(400);
        expect(del.body.code).toBe('TABLE_OCCUPIED');
        expect((await Table.findById(table._id).lean()).isDeleted).not.toBe(true);
    });

    test('items cannot be appended to an order whose table was deleted (nothing reaches the kitchen)', async () => {
        const table = await createTable(A, { name: 'Del-5' });
        const { res } = await guestOrder(A, table);
        expect(res.status).toBe(201);
        const orderId = res.body.order._id;
        // Data as left by the old delete rule: served-but-unpaid order on
        // a table that was soft-deleted anyway.
        await Order.updateOne({ _id: orderId }, { $set: { status: 'served' } });
        await Table.updateOne({ _id: table._id }, { $set: { isDeleted: true, deletedAt: new Date(), status: 'disabled' } });
        const before = await Order.findById(orderId).lean();

        for (const who of [A.users.waiter, A.users.admin]) {
            const append = await ctx.api.as(who).post(`/orders/${orderId}/append`)
                .send({ items: [{ menuItem: String(A.items.naan._id), quantity: 1 }] });
            expect(append.status).toBe(409);
            expect(append.body.code).toBe('TABLE_UNAVAILABLE');
        }
        const after = await Order.findById(orderId).lean();
        expect(after.status).toBe('served'); // not re-opened to the kitchen
        expect(after.items).toHaveLength(before.items.length);
        expect(after.total).toBe(before.total);
    });
});
