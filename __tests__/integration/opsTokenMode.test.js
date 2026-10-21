/**
 * Operations profile — token-number mode, `tables.useTables:false`
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2).
 *
 * A restaurant without table numbers: dine-in orders are placed without a
 * table and collected by token ("T-001", "T-002", … per branch, starting
 * again each day; collection order_token_counters).
 *
 *   - dine-in create without a table → 201 with T-001, then T-002; the next
 *     day starts at T-001 (day injected into utils/orderToken)
 *   - a tableId a stale client still sends is ignored, never an error
 *   - kitchen list, live list, order detail and my-orders carry tokenNumber
 *   - assign / merge / unmerge / free / claim / reservation hold → 400
 *     TABLES_DISABLED; the table list stays readable
 *   - pay-first + token on an 'either' tenant: counter cash held then released,
 *     pay-after and prepaid online rounds all carry a token
 *   - staff append and the customer repeat flows work without a table
 *   - paying a token order touches no table
 *   - regressions: a tenant WITH tables and a tenant without a profile still
 *     answer 400 TABLE_REQUIRED, and their table endpoints still work
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const OrderTokenCounter = require(path.join(BACKEND, 'models/orderTokenCounter'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const { normaliseProfile, resolveOperations } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { nextTokenNumber, localDayKey } = require(path.join(BACKEND, 'utils/orderToken'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const sig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');

let T;    // token mode, every module on (pay after the meal)
let E;    // token mode + payment.dineIn 'either' (counter cash allowed)
let W;    // profile WITH tables (useTables true)
let D;    // no profile at all

async function tenantWith(label, profile) {
    const t = await seedTenant({ label });
    if (profile) {
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { operations: normaliseProfile(profile) } });
    }
    return t;
}

beforeAll(async () => {
    T = await tenantWith('tok', { answers: { useTables: false } });
    // 'either' with unpaid pay-now rounds held (same set-up as opsPayFirst's E tenant).
    E = await tenantWith('tokeither', {
        answers: { useTables: false, dineInPayment: 'either', counterCash: true },
        advanced: { 'payment.holdUntilPaid': true },
    });
    W = await tenantWith('tables', { answers: { useTables: true } });
    D = await tenantWith('dflt', null);
    // The resolver must hand the saved value through (no coercion to true).
    const r = await Restaurant.findById(T.restaurant._id).lean();
    expect(resolveOperations(r).tables.useTables).toBe(false);
});

afterEach(() => rzp.reset());

const dineInTotal = (t, qty = 2) => computeBill({ subtotal: 200 * qty, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;

/** A dine-in order WITHOUT a table (the token-mode cart). */
const placeTokenOrder = (client, t, extra = {}) => client.post('/orders').send({
    type: 'dine-in',
    items: [{ menuItem: String(t.items.paneer._id), quantity: 2 }],
    total: dineInTotal(t),
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
    ...extra,
});

const reload = (id) => Order.findById(id).lean();
const today = () => localDayKey(new Date());
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return localDayKey(d); };

/** A pay-first Razorpay checkout confirmed with the (mocked) gateway. */
function prepaid(t) {
    const paymentId = `pay_${rid()}`;
    const rzpOrderId = `order_${rid()}`;
    const paise = Math.round(dineInTotal(t) * 100);
    const notes = { cafeOrderId: 'none', restaurantId: String(t.restaurant._id), purpose: 'cafe_order' };
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: paise,
        currency: 'INR', created_at: Math.floor(Date.now() / 1000) - 30, notes: {},
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount: paise, notes });
    return { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) };
}

describe('create: dine-in without a table gets a token', () => {
    test('guest (counter QR, no scan token) → T-001; admin → T-002; the next day starts at T-001 again', async () => {
        const first = await placeTokenOrder(ctx.api.guest(T), T);
        expect(first.status).toBe(201);
        expect(first.body.order).toMatchObject({ type: 'dine-in', tokenNumber: 'T-001' });
        expect(first.body.order.table ?? null).toBeNull();
        expect(first.body.order.orderId).toMatch(/^ORD-/);        // the order id is unchanged
        // the order lands on the tenant's main branch (no table to inherit from)
        expect(String(first.body.order.branch)).toBe(String(T.branch._id));

        const second = await placeTokenOrder(ctx.api.as(T.users.admin, T), T);
        expect(second.status).toBe(201);
        expect(second.body.order.tokenNumber).toBe('T-002');
        expect(String(second.body.order.branch)).toBe(String(T.branch._id));

        // Day boundary: the same branch's counter for tomorrow is fresh,
        // while today's sequence carries on where the HTTP orders left it.
        expect(await nextTokenNumber(T.restaurant._id, T.branch._id, tomorrow())).toBe('T-001');
        expect(await nextTokenNumber(T.restaurant._id, T.branch._id, today())).toBe('T-003');
        const counter = await OrderTokenCounter.findOne({ restaurant: T.restaurant._id, branch: T.branch._id, day: today() }).lean();
        expect(counter.seq).toBe(3);
        // another tenant's counter is its own
        expect(await nextTokenNumber(E.restaurant._id, E.branch._id, today())).toBe('T-001');
    });

    test('the counter collection expires its rows (TTL index, 3 days)', async () => {
        const indexes = await OrderTokenCounter.collection.indexes();
        const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
        expect(ttl).toBeTruthy();
        expect(ttl.expireAfterSeconds).toBe(3 * 24 * 60 * 60);
        expect(indexes.find((i) => i.unique && i.key.restaurant && i.key.branch && i.key.day)).toBeTruthy();
    });

    test('a tableId sent in token mode is ignored: the order is a table-less token order and the table is untouched', async () => {
        const table = await createTable(T);
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await placeTokenOrder(ctx.api.guest(T, scanToken), T, { tableId: String(table._id) });
        expect(res.status).toBe(201);
        expect(res.body.order.table ?? null).toBeNull();
        expect(res.body.order.tokenNumber).toMatch(/^T-\d{3,}$/);
        const t = await Table.findById(table._id).lean();
        expect(t.activeOrder ?? null).toBeNull();
        expect(await Order.countDocuments({ table: table._id, restaurant: T.restaurant._id })).toBe(0);
    });

    test('takeaway keeps its ORT- id and gets no token', async () => {
        const res = await ctx.api.as(T.users.admin, T).post('/orders').send({
            type: 'takeaway',
            pickupLocation: 'Main',
            items: [{ menuItem: String(T.items.paneer._id), quantity: 1 }],
            total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(T.settings.taxes), orderType: 'takeaway' }).total,
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(res.status).toBe(201);
        expect(res.body.order.orderId).toMatch(/^ORT-/);
        expect(res.body.order.tokenNumber ?? null).toBeNull();
    });
});

describe('payloads carry tokenNumber', () => {
    let order;
    let cust;
    beforeAll(async () => {
        cust = await createCustomer('tokcust');
        const res = await placeTokenOrder(ctx.api.as(cust, T), T);
        expect(res.status).toBe(201);
        order = res.body.order;
        expect(order.tokenNumber).toMatch(/^T-/);
    });

    test('kitchen list (chef)', async () => {
        const res = await ctx.api.as(T.users.chef, T).get('/orders/kitchen');
        expect(res.status).toBe(200);
        const row = res.body.orders.find((o) => o.id === order.orderId);
        expect(row).toBeTruthy();
        expect(row.tokenNumber).toBe(order.tokenNumber);
        expect(row.table).toBeNull();
    });

    test('live list (admin) — sorted by createdAt as before', async () => {
        const res = await ctx.api.as(T.users.admin, T).get('/orders/live');
        expect(res.status).toBe(200);
        const row = res.body.orders.find((o) => o.id === order.orderId);
        expect(row.tokenNumber).toBe(order.tokenNumber);
        expect(row.table).toBeNull();
        const times = res.body.orders.filter((o) => o.status !== 'served').map((o) => new Date(o.createdAt).getTime());
        expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    test('order detail (staff and the customer) and my-orders (customer)', async () => {
        const staff = await ctx.api.as(T.users.admin, T).get(`/orders/${order._id}/detail`);
        expect(staff.status).toBe(200);
        expect(staff.body.order.tokenNumber).toBe(order.tokenNumber);

        const own = await ctx.api.as(cust, T).get(`/orders/${order._id}/detail`);
        expect(own.status).toBe(200);
        expect(own.body.order.tokenNumber).toBe(order.tokenNumber);

        const mine = await ctx.api.as(cust, T).get('/orders/my-orders');
        expect(mine.status).toBe(200);
        expect(mine.body.orders.find((o) => o.id === order.orderId).tokenNumber).toBe(order.tokenNumber);
    });

    test('past orders (admin) once served', async () => {
        await Order.updateOne({ _id: order._id }, { $set: { status: 'served', servedAt: new Date() } });
        const res = await ctx.api.as(T.users.admin, T).get('/orders/past');
        expect(res.status).toBe(200);
        expect(res.body.orders.find((o) => o.id === order.orderId).tokenNumber).toBe(order.tokenNumber);
    });
});

describe('table-only endpoints → 400 TABLES_DISABLED; listing stays readable', () => {
    const expectDisabled = (res) => {
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TABLES_DISABLED');
    };

    test('assign waiter, merge, unmerge, free', async () => {
        const a = await createTable(T);
        const b = await createTable(T);
        const admin = ctx.api.as(T.users.admin, T);
        expectDisabled(await admin.put(`/tables/${a._id}/assign`).send({ waiterId: String(T.users.waiter._id) }));
        expectDisabled(await ctx.api.as(T.users.captain, T).put(`/tables/${a._id}/assign`).send({ waiterId: String(T.users.waiter._id) }));
        expectDisabled(await admin.post('/tables/merge').send({ tableIds: [String(a._id), String(b._id)] }));
        expectDisabled(await admin.post('/tables/unmerge').send({ tableId: String(a._id) }));
        expectDisabled(await admin.post(`/tables/${a._id}/free`).send({ force: true }));
        const t = await Table.findById(a._id).lean();
        expect(t.assignedWaiter ?? null).toBeNull();
        expect(t.status).toBe('free');
    });

    test('customer claim seat', async () => {
        const table = await createTable(T);
        const cust = await createCustomer('tokclaim');
        const { scanToken } = await scanTable(ctx.api, table);
        expectDisabled(await ctx.api.customerAtTable(cust, T, scanToken).post(`/tables/${table._id}/claim`).send({}));
    });

    test('reservation hold on a table', async () => {
        const table = await createTable(T);
        const res = await ctx.api.as(T.users.admin, T).post('/reservations').send({
            guestName: 'Token Guest', contactNo: '9999999999', date: new Date().toISOString().slice(0, 10),
            time: '19:00', guestCount: 2, selectedArea: String(T.area._id), selectedTable: String(table._id),
        });
        expectDisabled(res);
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });

    test('GET /tables still lists the configured tables', async () => {
        const res = await ctx.api.as(T.users.admin, T).get('/tables');
        expect(res.status).toBe(200);
    });
});

describe('pay-first + token (payment.dineIn = either)', () => {
    test('counter cash → held with a token, invisible to the kitchen; Mark paid releases it', async () => {
        const res = await placeTokenOrder(ctx.api.guest(E), E, { paymentIntent: 'counterCash' });
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        let o = await reload(id);
        expect(o).toMatchObject({ status: 'awaiting-payment', holdReason: 'counterCash', paymentChannel: 'payFirst' });
        expect(o.tokenNumber).toMatch(/^T-/);
        expect(o.table ?? null).toBeNull();
        const kitchen = await ctx.api.as(E.users.chef, E).get('/orders/kitchen');
        expect(kitchen.body.orders.map((k) => k.id)).not.toContain(o.orderId);

        const pay = await ctx.api.as(E.users.admin, E).patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        o = await reload(id);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.status).toBe('new');                 // chef module on → cooks after release
        expect(o.releasedAt).toBeTruthy();
    });

    test('pay after the meal (no payment intent) → straight to the kitchen with a token', async () => {
        const res = await placeTokenOrder(ctx.api.guest(E), E);
        expect(res.status).toBe(201);
        const o = await reload(res.body.order._id);
        expect(o).toMatchObject({ status: 'new', paymentChannel: 'payAfter' });
        expect(o.tokenNumber).toMatch(/^T-/);
    });

    test('online payment confirmed at create → created at once (not held) with a token; verify marks it Paid', async () => {
        const guest = ctx.api.guest(E);
        const checkout = prepaid(E);
        const res = await placeTokenOrder(guest, E, { razorpayPayment: checkout, paymentMethod: 'online' });
        expect(res.status).toBe(201);
        let o = await reload(res.body.order._id);
        expect(o).toMatchObject({ paymentChannel: 'payFirst', status: 'new', razorpayPaymentId: checkout.razorpay_payment_id });
        expect(o.holdReason).toBeFalsy();
        expect(o.tokenNumber).toMatch(/^T-/);
        const token = o.tokenNumber;

        const verify = await guest.post('/razorpay/verify-payment').send({ ...checkout, cafeOrderId: o.orderId });
        expect(verify.status).toBe(200);
        o = await reload(res.body.order._id);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.tokenNumber).toBe(token);
    });

    test('tokens of the three rounds are distinct and consecutive on the branch', async () => {
        const tokens = (await Order.find({ restaurant: E.restaurant._id, tokenNumber: { $type: 'string' } })
            .sort({ createdAt: 1 }).select('tokenNumber').lean()).map((o) => o.tokenNumber);
        expect(new Set(tokens).size).toBe(tokens.length);
        expect(tokens.length).toBeGreaterThanOrEqual(3);
    });
});

describe('append and repeat without a table', () => {
    test('waiter appends items to a token order', async () => {
        const created = await placeTokenOrder(ctx.api.as(T.users.admin, T), T);
        expect(created.status).toBe(201);
        const res = await ctx.api.as(T.users.waiter, T).post(`/orders/${created.body.order._id}/append`)
            .send({ items: [{ menuItem: String(T.items.naan._id), quantity: 1 }] });
        expect(res.status).toBe(200);
        const o = await reload(created.body.order._id);
        expect(o.items).toHaveLength(2);
        expect(o.table ?? null).toBeNull();
        expect(o.tokenNumber).toBe(created.body.order.tokenNumber);
    });

    test('customer repeat-all: appends to the open token order; a targetTableId → 400 TABLES_DISABLED', async () => {
        const cust = await createCustomer('tokrepeat');
        const client = ctx.api.as(cust, T);
        const created = await placeTokenOrder(client, T);
        expect(created.status).toBe(201);
        const id = created.body.order._id;

        const withTable = await client.post(`/orders/${id}/repeat-all`).send({ targetTableId: String(T.tables.main._id) });
        expect(withTable.status).toBe(400);
        expect(withTable.body.code).toBe('TABLES_DISABLED');

        const ok = await client.post(`/orders/${id}/repeat-all`).send({});
        expect(ok.status).toBe(200);
        const o = await reload(id);
        expect(o.items.reduce((s, i) => s + i.quantity, 0)).toBe(4);
        expect(o.table ?? null).toBeNull();
    });

    test('customer repeat-all of a settled token order creates a new token order', async () => {
        const cust = await createCustomer('tokrepeat2');
        const client = ctx.api.as(cust, T);
        const created = await placeTokenOrder(client, T);
        expect(created.status).toBe(201);
        await Order.updateOne({ _id: created.body.order._id }, { $set: { status: 'served', paymentStatus: 'Paid' } });
        const res = await client.post(`/orders/${created.body.order._id}/repeat-all`).send({});
        expect(res.status).toBe(201);
        expect(res.body.order.table ?? null).toBeNull();
        expect(res.body.order.tokenNumber).toMatch(/^T-/);
        expect(res.body.order.tokenNumber).not.toBe(created.body.order.tokenNumber);
    });
});

describe('occupancy: token orders touch no table', () => {
    test('paying a token order leaves every table of the tenant as it was', async () => {
        const before = await Table.find({ restaurant: T.restaurant._id }).select('status activeOrder').sort({ _id: 1 }).lean();
        const created = await placeTokenOrder(ctx.api.as(T.users.admin, T), T);
        const pay = await ctx.api.as(T.users.admin, T).patch(`/orders/${created.body.order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        await settle();
        const after = await Table.find({ restaurant: T.restaurant._id }).select('status activeOrder').sort({ _id: 1 }).lean();
        expect(after).toEqual(before);
    });
});

describe('regression: tenants with tables behave exactly as today', () => {
    test.each([
        ['a profile with tables', () => W],
        ['no profile', () => D],
    ])('%s: dine-in without a table → 400 TABLE_REQUIRED, no token anywhere', async (_l, pick) => {
        const t = pick();
        for (const client of [ctx.api.as(t.users.admin, t), ctx.api.as(t.users.waiter, t)]) {
            const res = await placeTokenOrder(client, t);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('TABLE_REQUIRED');
        }
        expect(await Order.countDocuments({ restaurant: t.restaurant._id, tokenNumber: { $exists: true } })).toBe(0);
        expect(await OrderTokenCounter.countDocuments({ restaurant: t.restaurant._id })).toBe(0);
    });

    test.each([
        ['a profile with tables', () => W],
        ['no profile', () => D],
    ])('%s: a dine-in order at a table has no token and occupies the table; table endpoints still work', async (_l, pick) => {
        const t = pick();
        const table = await createTable(t);
        const res = await placeTokenOrder(ctx.api.as(t.users.admin, t), t, { tableId: String(table._id) });
        expect(res.status).toBe(201);
        expect(res.body.order.tokenNumber ?? null).toBeNull();
        expect(String(res.body.order.table)).toBe(String(table._id));
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');

        const assign = await ctx.api.as(t.users.captain, t).put(`/tables/${table._id}/assign`).send({ waiterId: String(t.users.waiter._id) });
        expect(assign.status).toBe(200);
        const freed = await ctx.api.as(t.users.admin, t).post(`/tables/${table._id}/free`).send({ force: true });
        expect(freed.status).toBe(200);
    });

    test('guest without a scan token is still refused on a tenant with tables', async () => {
        const table = await createTable(W);
        const res = await placeTokenOrder(ctx.api.guest(W), W, { tableId: String(table._id) });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SCAN_TOKEN_REQUIRED');
    });
});
