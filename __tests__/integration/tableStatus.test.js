/**
 * Table status timing (QA requirement, 2026-10):
 *
 *   "When someone sits at a table and scans the QR, its status must change
 *    from Free to Occupied instantly; after that table's bill is paid, its
 *    status must change from Occupied to Free instantly" — on the admin
 *    Tables screen, captain floor and waiter home.
 *
 * Rule implemented in utils/tableOccupancy.releaseTableIfSettled: a
 * dine-in table (the whole merge group) is Free as soon as no order on it
 * is unsettled (unsettled = not cancelled AND payment not Paid/Refunded).
 * Kitchen status does not matter — a paid order still being cooked stays
 * on the chef KDS. Each freed table is announced to the tenant's staff
 * with `table:updated` { tableId, status: 'free' }.
 *
 * Real app + in-memory Mongo + real socket.io clients (staff screens
 * refresh on `table:updated`).
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));

const ctx = useIntegrationApp();
let A;
let B;
const sockets = [];

beforeAll(async () => {
    A = await seedTenant({ label: 'tstat-a' });
    B = await seedTenant({ label: 'tstat-b' });
});
afterAll(() => {
    for (const s of sockets) s.close();
});

// ── helpers ──────────────────────────────────────────────────────────
const TOTAL = () => computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'dine-in' }).total;
const paneer = () => [{ menuItem: String(A.items.paneer._id), quantity: 1 }];

function connect(token) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, {
            auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}
/** Staff sockets of tenant A (admin, captain, waiter) + tenant B admin, recording table:updated. */
async function staffScreens() {
    const out = {};
    for (const [k, u] of Object.entries({
        adminA: A.users.admin, captainA: A.users.captain, waiterA: A.users.waiter, adminB: B.users.admin,
    })) {
        const events = [];
        // eslint-disable-next-line no-await-in-loop
        const s = await connect(u.token);
        s.on('table:updated', (p) => events.push(p));
        out[k] = events;
    }
    await settle(100);
    return out;
}
const waitForEvent = async (events, pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        // eslint-disable-next-line no-await-in-loop
        await settle(25);
    }
    throw new Error(`table:updated not received; got ${JSON.stringify(events)}`);
};
const freeEventFor = (tableId) => (p) => String(p.tableId) === String(tableId) && p.status === 'free';

const tableOf = (id) => Table.findById(id).lean();
const reload = (id) => Order.findById(id).lean();

async function guestOrder(table, scanToken) {
    const res = await ctx.api.guest(A, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id), items: paneer(), total: TOTAL(),
    });
    expect(res.status).toBe(201);
    return res.body.order;
}
async function customerOrder(cust, table, scanToken) {
    const res = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id), items: paneer(), total: TOTAL(),
    });
    expect(res.status).toBe(201);
    return res.body.order;
}
const staffCashSettle = (orderId) => ctx.api.as(A.users.admin).patch(`/orders/${orderId}/status`)
    .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: TOTAL() });
const walletPay = (cust, orderId) => ctx.api.as(cust, A).post('/wallet/pay').send({ orderId: String(orderId), amount: TOTAL() });

/** A customer seated at `table` with a wallet able to pay one order. */
async function walletCustomer(label, table) {
    const cust = await createCustomer(label);
    await setWallet(A, cust, { balance: 1000 });
    const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
    return { cust, scanToken };
}

// ── tests ────────────────────────────────────────────────────────────

describe('scan → Occupied instantly', () => {
    test('a QR scan flips a free table to occupied and tells only this tenant\'s staff screens', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const { res } = await scanTable(ctx.api, table);
        expect(res.status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('occupied');
        const occupied = (p) => String(p.tableId) === String(table._id) && p.status === 'occupied';
        await waitForEvent(screens.adminA, occupied);
        await waitForEvent(screens.captainA, occupied);
        await waitForEvent(screens.waiterA, occupied);
        await settle(100);
        expect(screens.adminB.some(occupied)).toBe(false);
    });
});

describe('bill paid → Free instantly (kitchen status irrelevant)', () => {
    test('staff cash settle of an order still NEW frees the table at once; the order stays on the chef KDS', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table);
        const order = await guestOrder(table, scanToken);
        expect((await tableOf(table._id)).status).toBe('occupied');

        const res = await staffCashSettle(order._id);
        expect(res.status).toBe(200);

        const t = await tableOf(table._id);
        expect({ status: t.status, activeOrder: t.activeOrder }).toEqual({ status: 'free', activeOrder: null });
        await waitForEvent(screens.adminA, freeEventFor(table._id));
        await waitForEvent(screens.captainA, freeEventFor(table._id));
        await waitForEvent(screens.waiterA, freeEventFor(table._id));
        expect(screens.adminB.some(freeEventFor(table._id))).toBe(false);

        // Paid but not cooked yet: still 'new' and on the chef's board.
        const saved = await reload(order._id);
        expect({ status: saved.status, paymentStatus: saved.paymentStatus }).toEqual({ status: 'new', paymentStatus: 'Paid' });
        const kds = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(kds.status).toBe(200);
        expect(kds.body.orders.some((o) => o.id === order.orderId)).toBe(true);

        // Seats stay reserved while that paid order is still cooking …
        expect((await Table.findById(table._id).select('+seats').lean()).seats.length).toBeGreaterThan(0);
        // … and the chef can still finish it; once served the seats clear.
        for (const status of ['preparing', 'ready']) {
            // eslint-disable-next-line no-await-in-loop
            expect((await ctx.api.as(A.users.chef).patch(`/orders/${order._id}/status`).send({ status })).status).toBe(200);
        }
        expect((await ctx.api.as(A.users.waiter).patch(`/orders/${order._id}/pickup`)).status).toBe(200);
        const after = await Table.findById(table._id).select('+seats').lean();
        expect({ status: after.status, seats: after.seats }).toEqual({ status: 'free', seats: [] });
    });

    test('online payment (verify-payment) frees the table even though the food is not served', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table);
        const order = await guestOrder(table, scanToken);
        const rzpOrderId = `order_${crypto.randomBytes(5).toString('hex')}`;
        const paymentId = `pay_${crypto.randomBytes(5).toString('hex')}`;
        await Order.updateOne({ _id: order._id }, { $set: { razorpayOrderId: rzpOrderId } });
        const saved = await reload(order._id);
        const notes = {
            cafeOrderId: String(order._id),
            restaurantId: String(A.restaurant._id),
            purpose: 'cafe_order',
            ...(saved.scanSessionId ? { scanSessionId: String(saved.scanSessionId) } : {}),
        };
        const amount = Math.round(saved.total * 100);
        rzp.instance.payments.fetch.mockResolvedValue({
            id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount, currency: 'INR', notes,
        });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount, notes });
        const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${rzpOrderId}|${paymentId}`).digest('hex');

        const res = await ctx.api.guest(A, scanToken).post('/razorpay/verify-payment').send({
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature,
            cafeOrderId: String(order._id),
        });
        expect(res.status).toBe(200);
        expect((await reload(order._id)).paymentStatus).toBe('Paid');
        expect((await tableOf(table._id)).status).toBe('free');
        await waitForEvent(screens.adminA, freeEventFor(table._id));
    });

    test('wallet payment frees the table at once', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const { cust, scanToken } = await walletCustomer('tstat-wal', table);
        const order = await customerOrder(cust, table, scanToken);

        const res = await walletPay(cust, order._id);
        expect(res.status).toBe(200);
        expect(res.body.orderPaid).toBe(true);
        expect((await tableOf(table._id)).status).toBe('free');
        await waitForEvent(screens.waiterA, freeEventFor(table._id));
    });

    test('a partial wallet payment does not free the table', async () => {
        const table = await createTable(A, { capacity: 4 });
        const { cust, scanToken } = await walletCustomer('tstat-part', table);
        const order = await customerOrder(cust, table, scanToken);
        const res = await ctx.api.as(cust, A).post('/wallet/pay').send({ orderId: String(order._id), amount: 10 });
        expect(res.status).toBe(200);
        expect(res.body.orderPaid).toBe(false);
        expect((await tableOf(table._id)).status).toBe('occupied');
    });
});

describe('several parties / merged tables', () => {
    test('two parties: the first to pay leaves the table occupied (activeOrder repointed); the second payment frees it', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 6 });
        const guest = await scanTable(ctx.api, table);
        const guestOrd = await guestOrder(table, guest.scanToken);
        const { cust, scanToken } = await walletCustomer('tstat-two', table);
        const custOrd = await customerOrder(cust, table, scanToken);
        expect(String((await tableOf(table._id)).activeOrder)).toBe(String(custOrd._id));

        expect((await walletPay(cust, custOrd._id)).status).toBe(200);
        const mid = await tableOf(table._id);
        expect({ status: mid.status, activeOrder: String(mid.activeOrder) })
            .toEqual({ status: 'occupied', activeOrder: String(guestOrd._id) });
        await settle(150);
        expect(screens.adminA.some(freeEventFor(table._id))).toBe(false);

        expect((await staffCashSettle(guestOrd._id)).status).toBe(200);
        const end = await tableOf(table._id);
        expect({ status: end.status, activeOrder: end.activeOrder }).toEqual({ status: 'free', activeOrder: null });
        await waitForEvent(screens.adminA, freeEventFor(table._id));
    });

    test('a merged group frees together, and only once every order on the group is settled', async () => {
        const screens = await staffScreens();
        const t1 = await createTable(A, { capacity: 4 });
        const t2 = await createTable(A, { capacity: 4 });
        const merge = await ctx.api.as(A.users.admin).post('/tables/merge').send({ tableIds: [String(t1._id), String(t2._id)] });
        expect(merge.status).toBe(200);

        const { cust, scanToken } = await walletCustomer('tstat-merge', t1);
        const custOrd = await customerOrder(cust, t1, scanToken);
        // Scanning a sibling resolves to the group leader (the scan
        // response is the effective table) — orders go to the leader.
        const guest = await scanTable(ctx.api, t2);
        const guestOrd = await guestOrder({ _id: guest.res.body._id }, guest.scanToken);

        expect((await walletPay(cust, custOrd._id)).status).toBe(200);
        const [m1, m2] = await Promise.all([tableOf(t1._id), tableOf(t2._id)]);
        expect([m1.status, m2.status]).toEqual(['merged', 'merged']);

        expect((await staffCashSettle(guestOrd._id)).status).toBe(200);
        const [e1, e2] = await Promise.all([tableOf(t1._id), tableOf(t2._id)]);
        expect([e1.status, e2.status, e1.mergedWith, e2.mergedWith]).toEqual(['free', 'free', [], []]);
        await waitForEvent(screens.adminA, freeEventFor(t1._id));
        await waitForEvent(screens.adminA, freeEventFor(t2._id));
    });

    test('cancelling the last unpaid order frees the table (the other party already paid)', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 6 });
        const guest = await scanTable(ctx.api, table);
        const guestOrd = await guestOrder(table, guest.scanToken);
        const { cust, scanToken } = await walletCustomer('tstat-cancel', table);
        const custOrd = await customerOrder(cust, table, scanToken);
        expect((await walletPay(cust, custOrd._id)).status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('occupied');

        const res = await ctx.api.as(A.users.captain).patch(`/orders/${guestOrd._id}/status`).send({ status: 'cancelled' });
        expect(res.status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('free');
        await waitForEvent(screens.captainA, freeEventFor(table._id));
    });

    test('a takeaway payment never touches any table', async () => {
        const before = await Table.find({ restaurant: A.restaurant._id }).select('status').lean();
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', items: paneer(),
            total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway' }).total,
        });
        expect(res.status).toBe(201);
        expect((await ctx.api.as(A.users.admin).patch(`/orders/${res.body.order._id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash' })).status).toBe(200);
        const after = await Table.find({ restaurant: A.restaurant._id }).select('status').lean();
        expect(after.map((t) => [String(t._id), t.status])).toEqual(expect.arrayContaining(before.map((t) => [String(t._id), t.status])));
    });
});

// Another party seated after the first one settled (2026-10): A pays
// while its food is cooking (table → Free), B scans and sits (→ Occupied,
// seat, no order yet), then A's order is served. The served-after-paid
// release must NOT free the table or wipe B's seat.
describe('a newly seated party is never freed out from under', () => {
    const seatsOf = async (id) => (await Table.findById(id).select('+seats').lean()).seats || [];
    const cookAndServe = async (orderId) => {
        for (const status of ['preparing', 'ready']) {
            // eslint-disable-next-line no-await-in-loop
            expect((await ctx.api.as(A.users.chef).patch(`/orders/${orderId}/status`).send({ status })).status).toBe(200);
        }
        expect((await ctx.api.as(A.users.waiter).patch(`/orders/${orderId}/pickup`)).status).toBe(200);
    };

    test('A pays → free; B scans → occupied; A served → table stays occupied, B keeps the seat and can order', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const a = await scanTable(ctx.api, table);
        const orderA = await guestOrder(table, a.scanToken);
        expect((await staffCashSettle(orderA._id)).status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('free');

        const b = await scanTable(ctx.api, table);
        expect(b.res.status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('occupied');
        expect((await seatsOf(table._id)).some((st) => st.keys.includes(`s:${b.sessionId}`))).toBe(true);

        screens.adminA.length = 0;
        await cookAndServe(orderA._id);
        await settle(200);
        expect((await tableOf(table._id)).status).toBe('occupied');
        expect((await seatsOf(table._id)).some((st) => st.keys.includes(`s:${b.sessionId}`))).toBe(true);
        expect(screens.adminA.some(freeEventFor(table._id))).toBe(false);

        // B orders normally; the table is theirs and B is still seated.
        const orderB = await guestOrder(table, b.scanToken);
        const t = await tableOf(table._id);
        expect({ status: t.status, activeOrder: String(t.activeOrder) }).toEqual({ status: 'occupied', activeOrder: String(orderB._id) });
        expect((await seatsOf(table._id)).some((st) => st.keys.includes(`s:${b.sessionId}`))).toBe(true);

        // … and B paying frees it.
        expect((await staffCashSettle(orderB._id)).status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('free');
    });

    test('normal case: nobody else seated → A served after paying frees the table and clears the seats', async () => {
        const table = await createTable(A, { capacity: 4 });
        const a = await scanTable(ctx.api, table);
        const orderA = await guestOrder(table, a.scanToken);
        expect((await staffCashSettle(orderA._id)).status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('free');
        expect((await seatsOf(table._id)).length).toBe(1); // A's seat kept while cooking
        await cookAndServe(orderA._id);
        expect((await tableOf(table._id)).status).toBe('free');
        expect(await seatsOf(table._id)).toEqual([]);
    });

    test('a companion phone that scanned BEFORE the bill was paid does not hold the table', async () => {
        const screens = await staffScreens();
        const table = await createTable(A, { capacity: 4 });
        const a = await scanTable(ctx.api, table);
        const orderA = await guestOrder(table, a.scanToken);
        expect((await scanTable(ctx.api, table)).res.status).toBe(200); // companion, never orders
        await settle(20);
        expect((await staffCashSettle(orderA._id)).status).toBe(200);
        expect((await tableOf(table._id)).status).toBe('free');
        await waitForEvent(screens.adminA, freeEventFor(table._id));
    });

    test('staff "Free table" stays unconditional while a new party is seated', async () => {
        const table = await createTable(A, { capacity: 4 });
        const a = await scanTable(ctx.api, table);
        const orderA = await guestOrder(table, a.scanToken);
        expect((await staffCashSettle(orderA._id)).status).toBe(200);
        expect((await scanTable(ctx.api, table)).res.status).toBe(200); // B sits down
        expect((await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true })).status).toBe(200);
        const t = await Table.findById(table._id).select('+seats').lean();
        expect({ status: t.status, seats: t.seats }).toEqual({ status: 'free', seats: [] });
    });
});
