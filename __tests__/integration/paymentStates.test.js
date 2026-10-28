/**
 * Payment state block, table billing states and payment-gated release
 * (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 4, QR creation excluded).
 *
 *   order.payment { state none|pending|paid|failed, method, amount, reference,
 *                   cashReceived, changeDue, ... }
 *   table billingState (derived): billing_pending | payment_pending |
 *                   payment_failed | print_failed | null
 *   POST /tables/:id/free: force = admin/manager + reason (D1)
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const PrintJob = require(path.join(BACKEND, 'models/printJob'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Tip = require(path.join(BACKEND, 'models/tip'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;
let B;

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p, secret = KEY_SECRET) => crypto.createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'ps-a' });
    B = await seedTenant({ label: 'ps-b' });
});

const admin = () => ctx.api.as(A.users.admin, A);
const captain = () => ctx.api.as(A.users.captain, A);
const waiter = () => ctx.api.as(A.users.captain, A); // billing is captain-only (kept name)
const reload = (o) => Order.findById(o._id).lean();
const reloadTable = (t) => Table.findById(t._id).lean();

/** Occupied table + an unpaid served dine-in order on it. */
async function tableWithOrder(t = A, fields = {}) {
    const table = await createTable(t);
    const order = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `PS-${rid()}`,
        type: 'dine-in', table: table._id, status: 'served', total: 500,
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        ...fields,
    });
    await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied', activeOrder: order._id } });
    return { table, order: order.toObject() };
}

function stubOrdersCreate() {
    rzp.instance.orders.create.mockImplementation(async (opts) => ({
        id: `order_${rid()}`, entity: 'order', amount: opts.amount, currency: opts.currency,
        receipt: opts.receipt, notes: opts.notes, status: 'created',
    }));
}
function stubGateway({ order, rzpOrderId, paymentId, amount, status = 'captured' }) {
    const notes = { cafeOrderId: String(order._id), restaurantId: String(order.restaurant), purpose: 'cafe_order' };
    rzp.instance.payments.fetch.mockResolvedValue({ id: paymentId, entity: 'payment', order_id: rzpOrderId, status, amount, currency: 'INR', notes });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount, notes });
}
const create = (order, amount = order.total) =>
    ctx.api.as(A.users.captain, A).post('/razorpay/create-order').send({ amount, cafeOrderId: String(order._id) });
const verify = (body, headers = {}) => {
    let r = ctx.api.guest(A).post('/razorpay/verify-payment');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
};
const billingStateOfTable = async (table, client = captain()) => {
    const res = await client.get('/tables');
    expect(res.status).toBe(200);
    return res.body.tables.find((x) => String(x._id) === String(table._id)).billingState;
};

// ── Razorpay: create -> pending, verify -> paid / failed ──────────────

describe('Razorpay payment states', () => {
    beforeEach(stubOrdersCreate);

    test('create-order -> pending (amount = payable, reference = razorpay order id); table stays occupied', async () => {
        const { table, order } = await tableWithOrder();
        const res = await create(order);
        expect(res.status).toBe(200);
        const db = await reload(order);
        expect(db.payment).toMatchObject({ state: 'pending', method: 'online', amount: 500, reference: res.body.razorpayOrder.id });
        expect(db.paymentStatus).toBe('Pending');
        expect((await reloadTable(table)).status).toBe('occupied');
        expect(await billingStateOfTable(table)).toBe('payment_pending');
    });

    test('verify ok -> paid, table freed, payment block recorded', async () => {
        const { table, order } = await tableWithOrder();
        const rzpOrderId = (await create(order)).body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId, paymentId, amount: 50000 });

        const res = await verify({ razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(order._id) });
        expect(res.status).toBe(200);
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Paid');
        expect(db.payment).toMatchObject({ state: 'paid', method: 'online', amount: 500, reference: paymentId });
        expect((await reloadTable(table)).status).toBe('free');
        expect(await billingStateOfTable(table)).toBeNull();
    });

    test('bad signature -> failed; order not paid; table stays occupied; billingState payment_failed', async () => {
        const { table, order } = await tableWithOrder();
        const rzpOrderId = (await create(order)).body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId, paymentId, amount: 50000 });

        const res = await verify({ razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId, 'wrong'), cafeOrderId: String(order._id) });
        expect(res.status).toBe(400);
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Pending');
        expect(db.payment).toMatchObject({ state: 'failed', failureReason: 'Invalid signature' });
        expect((await reloadTable(table)).status).toBe('occupied');
        expect(await billingStateOfTable(table)).toBe('payment_failed');
    });

    test('a forged signature naming an order with no matching pending checkout cannot fail it', async () => {
        const { order } = await tableWithOrder();
        const rzpOrderId = (await create(order)).body.razorpayOrder.id;
        const res = await verify({ razorpay_order_id: 'order_guess', razorpay_payment_id: 'pay_x', razorpay_signature: 'bad', cafeOrderId: String(order._id) });
        expect(res.status).toBe(400);
        expect((await reload(order)).payment).toMatchObject({ state: 'pending', reference: rzpOrderId });
    });

    test('amount mismatch (underpaid capture) -> failed, not paid, table occupied', async () => {
        const { table, order } = await tableWithOrder();
        const rzpOrderId = (await create(order)).body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId, paymentId, amount: 10000 }); // 100 of 500

        const res = await verify({ razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(order._id) });
        expect(res.status).toBeGreaterThanOrEqual(400);
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Pending');
        expect(db.payment.state).toBe('failed');
        expect((await reloadTable(table)).status).toBe('occupied');
    });

    test('a failed payment can be retried: new create-order -> pending again, then verify -> paid', async () => {
        const { order } = await tableWithOrder();
        const first = (await create(order)).body.razorpayOrder.id;
        await verify({ razorpay_order_id: first, razorpay_payment_id: 'pay_bad', razorpay_signature: 'nope', cafeOrderId: String(order._id) });
        expect((await reload(order)).payment.state).toBe('failed');
        const second = (await create(order)).body.razorpayOrder.id;
        expect((await reload(order)).payment).toMatchObject({ state: 'pending', reference: second });
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId: second, paymentId, amount: 50000 });
        const res = await verify({ razorpay_order_id: second, razorpay_payment_id: paymentId, razorpay_signature: sig(second, paymentId), cafeOrderId: String(order._id) });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment.state).toBe('paid');
    });

    test('duplicate verify (same payment id, and same Idempotency-Key) does not double-apply side effects', async () => {
        const { order } = await tableWithOrder(A, { tipAmount: 20, waiter: A.users.waiter._id });
        const rzpOrderId = (await create(order)).body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId, paymentId, amount: 50000 });
        const body = { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(order._id) };

        const key = `idem-${rid()}${rid()}`;
        const r1 = await verify(body, { 'Idempotency-Key': key });
        const afterFirst = await reload(order);
        const fetchCalls = rzp.instance.payments.fetch.mock.calls.length;
        const r2 = await verify(body, { 'Idempotency-Key': key });            // same key: replayed response
        const r3 = await verify(body);                                         // same payment id, no key
        expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
        expect(r2.body).toEqual(r1.body);
        expect(r3.body.paymentId).toBe(paymentId);

        const after = await reload(order);
        expect(after.paidAt).toEqual(afterFirst.paidAt);
        expect(after.payment).toEqual(afterFirst.payment);
        expect(after.amountPaid).toBe(500);
        expect(await Tip.countDocuments({ order: order._id })).toBe(1);
        expect(await PaymentClaim.countDocuments({ razorpayPaymentId: paymentId })).toBeLessThanOrEqual(1);
        // the replay never went back to the gateway
        expect(rzp.instance.payments.fetch.mock.calls.length).toBe(fetchCalls);
    });
});

// ── Cash settle ───────────────────────────────────────────────────────

describe('Cash settle records cashReceived / changeDue', () => {
    const settle = (order, body, client = captain()) =>
        client.patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'Cash', ...body });

    test('amountPaid defaults cashReceived; change is cashReceived - payable', async () => {
        const { table, order } = await tableWithOrder();
        const res = await settle(order, { amountPaid: 600 });
        expect(res.status).toBe(200);
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Paid');
        expect(db.payment).toMatchObject({ state: 'paid', method: 'Cash', amount: 500, cashReceived: 600, changeDue: 100 });
        expect(db.payment.updatedBy.toString()).toBe(String(A.users.captain._id));
        expect((await reloadTable(table)).status).toBe('free');
    });

    test('explicit cashReceived wins over amountPaid', async () => {
        const { order } = await tableWithOrder();
        const res = await settle(order, { amountPaid: 500, cashReceived: 1000 });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 1000, changeDue: 500 });
    });

    test('cash below payable -> 400 CASH_SHORT, order and table untouched', async () => {
        const { table, order } = await tableWithOrder();
        const res = await settle(order, { amountPaid: 500, cashReceived: 300 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CASH_SHORT');
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Pending');
        expect(db.payment?.state || 'none').toBe('none');
        expect((await reloadTable(table)).status).toBe('occupied');
    });

    test('partial amountPaid is still refused as before (AMOUNT_TOO_LOW); exact cash gives changeDue 0', async () => {
        const { order } = await tableWithOrder();
        expect((await settle(order, { amountPaid: 100 })).body.code).toBe('AMOUNT_TOO_LOW');
        const ok = await settle(order, { amountPaid: 500 });
        expect(ok.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 500, changeDue: 0 });
    });

    test('a tip is not counted as change', async () => {
        const { order } = await tableWithOrder();
        expect((await settle(order, { amountPaid: 520, tipAmount: 20 })).status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 520, changeDue: 0 });
    });

    test('tip stored on the order and already in total is not subtracted twice from change', async () => {
        const { order } = await tableWithOrder(A, { total: 1050, tipAmount: 50 });
        const res = await settle(order, { amountPaid: 1100, cashReceived: 1100 });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 1100, changeDue: 50 });
    });

    test('tip supplied in the settle request itself (not yet in total) is deducted once', async () => {
        const { order } = await tableWithOrder();
        const res = await settle(order, { amountPaid: 500, cashReceived: 600, tipAmount: 50 });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 600, changeDue: 50 });
    });

    test('raising a stored tip in the request only deducts the increase', async () => {
        const { order } = await tableWithOrder(A, { total: 1050, tipAmount: 50 });
        const res = await settle(order, { amountPaid: 1050, cashReceived: 1200, tipAmount: 80 });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 1200, changeDue: 120 });
    });

    test('cash must cover the request-supplied tip too (CASH_SHORT), but a stored tip adds no extra requirement', async () => {
        const { order } = await tableWithOrder();
        const short = await settle(order, { amountPaid: 500, cashReceived: 520, tipAmount: 50 });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('CASH_SHORT');
        expect(short.body.amountDue).toBe(550);
        const { order: o2 } = await tableWithOrder(A, { total: 1050, tipAmount: 50 });
        expect((await settle(o2, { amountPaid: 1050, cashReceived: 1050 })).status).toBe(200);
        expect((await reload(o2)).payment).toMatchObject({ changeDue: 0 });
    });

    test('no tip: change and CASH_SHORT threshold unchanged', async () => {
        const { order } = await tableWithOrder();
        const short = await settle(order, { amountPaid: 500, cashReceived: 498 });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('CASH_SHORT');
        expect(short.body.amountDue).toBe(500);
        const ok = await settle(order, { amountPaid: 500, cashReceived: 560 });
        expect(ok.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ cashReceived: 560, changeDue: 60 });
    });

    test('non-cash manual settle records paid with no cash fields', async () => {
        const { order } = await tableWithOrder();
        const res = await captain().patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'UPI', amountPaid: 500 });
        expect(res.status).toBe(200);
        expect((await reload(order)).payment).toMatchObject({ state: 'paid', method: 'UPI', cashReceived: null, changeDue: null });
    });
});

// ── billingState ──────────────────────────────────────────────────────

describe('table billingState', () => {
    test('null -> billing_pending (bill saved) -> payment_pending -> payment_failed, and print_failed', async () => {
        const { table, order } = await tableWithOrder();
        expect(await billingStateOfTable(table)).toBeNull();

        const saved = await waiter().post(`/orders/${order._id}/bill/save`).send({});
        expect(saved.status).toBe(200);
        expect(await billingStateOfTable(table)).toBe('billing_pending');

        // a failed bill print takes over billing_pending
        const job = await PrintJob.create({
            restaurant: A.restaurant._id, branch: A.branch._id, order: order._id, orderId: order.orderId,
            kind: 'bill', station: 'counter', printer: { id: 'p1', name: 'Counter' }, document: {}, status: 'failed', error: 'offline',
        });
        expect(await billingStateOfTable(table)).toBe('print_failed');
        // ...until a later print succeeds (latest job decides)
        await PrintJob.create({
            restaurant: A.restaurant._id, branch: A.branch._id, order: order._id, orderId: order.orderId,
            kind: 'bill', station: 'counter', printer: { id: 'p1', name: 'Counter' }, document: {}, status: 'done',
            createdAt: new Date(Date.now() + 1000),
        });
        expect(await billingStateOfTable(table)).toBe('billing_pending');
        await PrintJob.deleteMany({ order: order._id });
        expect(job).toBeTruthy();

        await Order.updateOne({ _id: order._id }, { $set: { 'payment.state': 'failed' } });
        expect(await billingStateOfTable(table)).toBe('payment_failed');
        await Order.updateOne({ _id: order._id }, { $set: { 'payment.state': 'pending' } });
        expect(await billingStateOfTable(table)).toBe('payment_pending');
    });

    test('a pending payment older than 30 minutes stops masking the other chips (stored state unchanged)', async () => {
        const { table, order } = await tableWithOrder();
        await waiter().post(`/orders/${order._id}/bill/save`).send({});
        await Order.updateOne({ _id: order._id }, { $set: { 'payment.state': 'pending', 'payment.updatedAt': new Date() } });
        expect(await billingStateOfTable(table)).toBe('payment_pending');
        await Order.updateOne({ _id: order._id }, { $set: { 'payment.updatedAt': new Date(Date.now() - 31 * 60 * 1000) } });
        expect(await billingStateOfTable(table)).toBe('billing_pending');
        await PrintJob.create({
            restaurant: A.restaurant._id, branch: A.branch._id, order: order._id, orderId: order.orderId,
            kind: 'bill', station: 'counter', printer: { id: 'p1', name: 'Counter' }, document: {}, status: 'failed', error: 'offline',
        });
        expect(await billingStateOfTable(table)).toBe('print_failed');
        expect((await reload(order)).payment.state).toBe('pending');
    });

    test('a bill request from the customer (counterPaymentRequestedAt) counts as billing_pending', async () => {
        const { table } = await tableWithOrder(A, { counterPaymentRequestedAt: new Date() });
        expect(await billingStateOfTable(table)).toBe('billing_pending');
    });

    test('floor-overview rows and the active-order endpoints carry billingState + payment', async () => {
        const { table, order } = await tableWithOrder(A, { status: 'ready' });
        await waiter().post(`/orders/${order._id}/bill/save`).send({});
        const floor = await captain().get('/captain/floor-overview');
        expect(floor.status).toBe(200);
        const row = floor.body.tables.find((x) => String(x._id) === String(table._id));
        expect(row.billingState).toBe('billing_pending');

        const one = await captain().get(`/orders/active/table/${table._id}`);
        expect(one.body.billingState).toBe('billing_pending');
        expect(one.body.order.payment).toMatchObject({ state: 'none', amount: 0 });
        const list = await captain().get(`/orders/active-list/table/${table._id}`);
        expect(list.body.billingState).toBe('billing_pending');
        expect(list.body.orders[0].payment.state).toBe('none');
        const detail = await captain().get(`/orders/${order._id}/detail`);
        expect(detail.body.order.payment.state).toBe('none');
        const live = await captain().get('/orders/live');
        expect(live.body.orders.find((o) => o.id === order.orderId).payment.state).toBe('none');
    });
});

// ── Payment-gated release ─────────────────────────────────────────────

describe('a table frees only on full payment', () => {
    test('saved + finalised bill, printed bill and a pending/failed payment never free the table', async () => {
        const { table, order } = await tableWithOrder();
        expect((await waiter().post(`/orders/${order._id}/bill/save`).send({})).status).toBe(200);
        expect((await captain().post(`/orders/${order._id}/bill/save`).send({ final: true })).status).toBe(200);
        await PrintJob.create({
            restaurant: A.restaurant._id, branch: A.branch._id, order: order._id, orderId: order.orderId,
            kind: 'bill', station: 'counter', printer: { id: 'p1', name: 'Counter' }, document: {}, status: 'done',
        });
        stubOrdersCreate();
        expect((await create(order)).status).toBe(200);
        expect((await reloadTable(table)).status).toBe('occupied');
        await Order.updateOne({ _id: order._id }, { $set: { 'payment.state': 'failed' } });
        expect((await reloadTable(table)).status).toBe('occupied');
        const db = await reload(order);
        expect(db.paymentStatus).toBe('Pending');
        expect(String((await reloadTable(table)).activeOrder)).toBe(String(order._id));
    });
});

// ── POST /tables/:id/free (D1) ────────────────────────────────────────

describe('POST /tables/:id/free', () => {
    test('without force and an unpaid bill -> 409 preview for captain and admin', async () => {
        const { table } = await tableWithOrder();
        for (const client of [captain(), admin()]) {
            const res = await client.post(`/tables/${table._id}/free`).send({});
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'ORDER_NOT_EMPTY', orderCount: 1, totalAmount: 500 });
        }
        expect((await reloadTable(table)).status).toBe('occupied');
    });

    test('force by a captain -> 403 FORCE_REQUIRES_PRIVILEGE, nothing changes', async () => {
        const { table, order } = await tableWithOrder();
        const res = await captain().post(`/tables/${table._id}/free`).send({ force: true, reason: 'guest left' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORCE_REQUIRES_PRIVILEGE');
        expect((await reload(order)).status).toBe('served');
        expect((await reloadTable(table)).status).toBe('occupied');
        // a captain's forced call is refused even with nothing unpaid
        const empty = await createTable(A);
        expect((await captain().post(`/tables/${empty._id}/free?force=true`).send({})).status).toBe(403);
    });

    test('force by admin without / with a short reason -> 400 REASON_REQUIRED', async () => {
        const { table, order } = await tableWithOrder();
        for (const body of [{ force: true }, { force: true, reason: '  ' }, { force: true, reason: 'ab' }]) {
            const res = await admin().post(`/tables/${table._id}/free`).send(body);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('REASON_REQUIRED');
        }
        expect((await reload(order)).status).toBe('served');
    });

    test('force by admin and by manager with a reason -> frees, cancels, stores reason, writes an audit line', async () => {
        const { createUser } = require('./helpers/seed');
        const manager = await createUser({
            name: 'mgr', email: `mgr.${rid()}@staff.test`, role: 'manager',
            restaurant: A.restaurant._id, branch: null,
        });
        for (const [actor, label] of [[admin(), 'admin'], [ctx.api.as(manager, A), 'manager']]) {
            const { table, order } = await tableWithOrder();
            const before = logger.__records.length;
            const res = await actor.post(`/tables/${table._id}/free`).send({ force: true, reason: `guest walked out (${label})` });
            expect(res.status).toBe(200);
            expect(res.body.closedOrderCount).toBe(1);
            const db = await reload(order);
            expect(db.status).toBe('cancelled');
            expect(db.cancellationReason).toBe(`guest walked out (${label})`);
            expect(db.cancelledBy).toBeTruthy();
            const t = await reloadTable(table);
            expect(t.status).toBe('free');
            const audit = logger.__records.slice(before).find((r) => r.level === 'info' && String(r.args[0]).includes('AUDIT table force-free'));
            expect(audit).toBeTruthy();
            expect(audit.args[1]).toMatchObject({ role: label, table: String(table._id), orders: [order.orderId] });
            expect(audit.args[1].reason).toContain('guest walked out');
        }
    });

    test('force-free reverses a confirmed incentive entry of the cancelled order', async () => {
        const mongoose = require('mongoose');
        const IncentiveEntry = require(path.join(BACKEND, 'models/incentiveEntry'));
        const incentives = require(path.join(BACKEND, 'services/incentiveService'));
        const { table, order } = await tableWithOrder();
        const entry = await IncentiveEntry.create({
            restaurant: A.restaurant._id, branch: A.branch._id, campaign: new mongoose.Types.ObjectId(),
            order: order._id, orderId: order.orderId, itemKey: String(order.items[0]._id),
            menuItem: A.items.paneer._id, itemName: 'Paneer Tikka', quantity: 1, rate: 20, amount: 20,
            staff: A.users.waiter._id, staffRole: 'waiter', state: 'confirmed', day: '2026-10-22',
        });
        const res = await admin().post(`/tables/${table._id}/free`).send({ force: true, reason: 'guest walked out' });
        expect(res.status).toBe(200);
        await incentives.idle();
        const after = await IncentiveEntry.findById(entry._id).lean();
        expect(after.state).toBe('reversed');
    });

    test('captain frees a table with nothing unpaid (no force) as before', async () => {
        const table = await createTable(A);
        await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });
        const res = await captain().post(`/tables/${table._id}/free`).send({});
        expect(res.status).toBe(200);
        expect((await reloadTable(table)).status).toBe('free');
    });
});

// ── Isolation ─────────────────────────────────────────────────────────

describe('tenant / branch isolation', () => {
    test("another tenant's admin cannot force-free, pay or see this tenant's billing state", async () => {
        const { table, order } = await tableWithOrder();
        const bAdmin = ctx.api.as(B.users.admin, B);
        const free = await bAdmin.post(`/tables/${table._id}/free`).send({ force: true, reason: 'not mine' });
        expect(free.status).toBe(404);
        const cash = await bAdmin.patch(`/orders/${order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 500 });
        expect(cash.status).toBe(404);
        const list = await bAdmin.get('/tables');
        expect(list.body.tables.find((t) => String(t._id) === String(table._id))).toBeUndefined();
        expect((await reload(order)).paymentStatus).toBe('Pending');
        expect((await reloadTable(table)).status).toBe('occupied');
    });

    test('create-order for another tenant order is refused and leaves payment untouched', async () => {
        stubOrdersCreate();
        const { order } = await tableWithOrder();
        const res = await ctx.api.as(B.users.captain, B).post('/razorpay/create-order').send({ amount: 500, cafeOrderId: String(order._id) });
        expect(res.status).toBe(404);
        expect((await reload(order)).payment).toBeUndefined();
    });
});
