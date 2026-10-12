/**
 * Operations profile, phase (c) — the first real client end-to-end
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §0.2, §5, §6).
 *
 * Hotel = modules 1 + 5 (QR ordering + customer payment): no waiter,
 * captain or kitchen screen; customers pay first; cash at the counter
 * allowed; no live tracking; the order is complete once paid.
 *
 * Café = modules 1 + 3 + 5: same, but the kitchen screen is on, so a
 * released order goes to the KDS and Ready completes it.
 *
 *   - no payment → 402 PAYMENT_REQUIRED_FIRST (staff orders unaffected)
 *   - online confirmed → created, auto-completed (hotel) / on the KDS (café)
 *   - online unconfirmed → held; invisible to the KDS; verify releases it once
 *   - cash at the counter → held + admin alert; "Mark paid" releases it once
 *   - a held order can't be pushed to the kitchen by a status change
 *   - unpaid holds expire → cancelled, table freed
 *   - waiter / captain / chef off → apps 403, no new accounts, no call-waiter,
 *     no tips, no customer repeat
 *   - café: chef Ready completes the order; round 2 doesn't orphan round 1
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Table = require(path.join(BACKEND, 'models/table'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const { profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { cancelExpiredHolds } = require(path.join(BACKEND, 'services/orderHoldService'));

const ctx = useIntegrationApp();
let H;   // hotel: modules 1 + 5
let C;   // café: modules 1 + 3 + 5

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    H = await seedTenant({ label: 'hotel' });
    C = await seedTenant({ label: 'cafe' });
    await Restaurant.updateOne({ _id: H.restaurant._id }, { $set: { operations: profileFromPreset('hotelPayFirstSelfOrder') } });
    await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { operations: profileFromPreset('cafeCounterPayFirst') } });
});

const dineInTotal = (t) => computeBill({ subtotal: 400, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;

/** A fresh table + a guest client holding its scan token. */
async function atTable(t) {
    const table = await createTable(t);
    const { scanToken } = await scanTable(ctx.api, table);
    return { table, guest: ctx.api.guest(t, scanToken) };
}

const placeOrder = (client, t, table, extra = {}) => client.post('/orders').send({
    type: 'dine-in',
    tableId: String(table._id),
    items: [{ menuItem: String(t.items.paneer._id), quantity: 2 }],
    total: dineInTotal(t),
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
    ...extra,
});

/** A pay-first Razorpay checkout; `confirmed: false` = gateway unreachable at create. */
function prepaid(t, { confirmed = true } = {}) {
    const paymentId = `pay_${rid()}`;
    const rzpOrderId = `order_${rid()}`;
    const paise = Math.round(dineInTotal(t) * 100);
    const notes = { cafeOrderId: 'none', restaurantId: String(t.restaurant._id), purpose: 'cafe_order' };
    const stub = () => {
        rzp.instance.payments.fetch.mockResolvedValue({
            id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: paise,
            currency: 'INR', created_at: Math.floor(Date.now() / 1000) - 30, notes: {},
        });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount: paise, notes });
    };
    if (confirmed) stub();
    else {
        rzp.instance.payments.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
        rzp.instance.orders.fetch.mockRejectedValue(Object.assign(new Error('gateway down'), { statusCode: 503 }));
    }
    return {
        paymentId, rzpOrderId, stub,
        checkout: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) },
    };
}

const kitchenIds = async (t) => {
    const res = await ctx.api.as(t.users.admin, t).get('/orders/kitchen');
    expect(res.status).toBe(200);
    const list = res.body.orders || res.body.data || [];
    return list.map(o => String(o._id));
};
const reload = (id) => Order.findById(id).lean();

afterEach(() => rzp.reset());

describe('hotel (QR + customer payment only): pay first', () => {
    test('no payment → 402 PAYMENT_REQUIRED_FIRST; nothing is created', async () => {
        const { table, guest } = await atTable(H);
        const before = await Order.countDocuments({ restaurant: H.restaurant._id });
        const res = await placeOrder(guest, H, table);
        expect(res.status).toBe(402);
        expect(res.body.code).toBe('PAYMENT_REQUIRED_FIRST');
        expect(res.body.methods).toMatchObject({ online: true, counterCash: true });
        expect(await Order.countDocuments({ restaurant: H.restaurant._id })).toBe(before);
    });

    test('staff orders are not forced to pay first', async () => {
        const table = await createTable(H);
        const res = await placeOrder(ctx.api.as(H.users.admin, H), H, table);
        expect(res.status).toBe(201);
    });

    test('online payment confirmed → order created and completed at once (no kitchen screen, nobody serves)', async () => {
        const { table, guest } = await atTable(H);
        const p = prepaid(H);
        const res = await placeOrder(guest, H, table, { razorpayPayment: p.checkout, paymentMethod: 'online' });
        expect(res.status).toBe(201);
        expect(res.body.order.status).toBe('served');
        await settle();
        const o = await reload(res.body.order._id);
        expect(o.status).toBe('served');
        expect(o.servedAt).toBeTruthy();
        expect(o.inventoryDeducted).toBe(true);
        expect(o.waiter).toBeFalsy();
    });

    test('online payment not confirmed at create → held, invisible to the kitchen, released once by verify', async () => {
        const { table, guest } = await atTable(H);
        const p = prepaid(H, { confirmed: false });
        const res = await placeOrder(guest, H, table, { razorpayPayment: p.checkout, paymentMethod: 'online' });
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        let o = await reload(id);
        expect(o).toMatchObject({ status: 'awaiting-payment', holdReason: 'online', holdReleaseStatus: 'new' });
        expect(o.holdExpiresAt).toBeTruthy();
        expect(await kitchenIds(H)).not.toContain(String(id));

        p.stub();
        const body = { ...p.checkout, cafeOrderId: o.orderId };
        const first = await guest.post('/razorpay/verify-payment').send(body);
        const second = await guest.post('/razorpay/verify-payment').send(body);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        o = await reload(id);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.status).toBe('served');            // hotel: complete once released
        expect(o.releasedAt).toBeTruthy();
        expect(o.inventoryDeducted).toBe(true);
    });

    test('cash at the counter → held + admin alert; "Mark paid" releases it exactly once', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        expect(res.status).toBe(201);
        const id = res.body.order._id;
        let o = await reload(id);
        expect(o).toMatchObject({ status: 'awaiting-payment', holdReason: 'counterCash', paymentMethod: 'cash' });
        expect(o.counterPaymentRequestedAt).toBeTruthy();
        expect(o.inventoryDeducted).not.toBe(true);
        await settle();
        expect(await Notification.countDocuments({
            restaurant: H.restaurant._id, recipientRole: 'admin', 'meta.orderId': o.orderId,
        })).toBeGreaterThanOrEqual(1);

        // The table is occupied while the order waits for payment.
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');

        const admin = ctx.api.as(H.users.admin, H);
        const pay = await admin.patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(pay.status).toBe(200);
        o = await reload(id);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.status).toBe('served');
        const releasedAt = o.releasedAt;
        expect(releasedAt).toBeTruthy();

        const again = await admin.patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect([200, 400, 409]).toContain(again.status);
        expect((await reload(id)).releasedAt.getTime()).toBe(releasedAt.getTime());
    });

    test('a held order cannot be pushed to the kitchen by a status change', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        const id = res.body.order._id;
        const admin = ctx.api.as(H.users.admin, H);
        for (const status of ['new', 'preparing', 'ready', 'served']) {
            const r = await admin.patch(`/orders/${id}/status`).send({ status });
            expect(r.status).toBeGreaterThanOrEqual(400);
        }
        expect((await reload(id)).status).toBe('awaiting-payment');
        // …but it can be cancelled
        const cancel = await admin.patch(`/orders/${id}/status`).send({ status: 'cancelled', cancelReason: 'admin-void' });
        expect(cancel.status).toBe(200);
    });

    test('an unpaid hold expires → cancelled (payment-timeout), table freed', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        const id = res.body.order._id;
        await Order.updateOne({ _id: id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
        const r = await cancelExpiredHolds();
        expect(r.cancelled).toBeGreaterThanOrEqual(1);
        const o = await reload(id);
        expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'payment-timeout' });
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });

    test('wallet intent is held until the wallet pays', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'wallet' });
        expect(res.status).toBe(201);
        expect((await reload(res.body.order._id)).status).toBe('awaiting-payment');
    });
});

describe('hotel: roles and buttons that are switched off', () => {
    test('waiter, captain and chef apps → 403 ROLE_NOT_IN_USE; admin unaffected', async () => {
        for (const role of ['waiter', 'captain', 'chef']) {
            const res = await ctx.api.as(H.users[role], H).get('/orders/live');
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ROLE_NOT_IN_USE');
            expect((await ctx.api.as(H.users[role], H).get('/auth/me')).status).toBe(200);
        }
        expect((await ctx.api.as(H.users.admin, H).get('/orders/live')).status).toBe(200);
    });

    test('admin cannot hire a waiter, captain or chef', async () => {
        for (const role of ['waiter', 'captain', 'chef']) {
            const res = await ctx.api.as(H.users.admin, H).post('/staff').send({
                name: `New ${role}`, email: `new.${role}.${rid()}@hotel.test`, password: 'Passw0rd!x', role, mobile: '9876543210',
            });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('ROLE_NOT_IN_USE');
        }
    });

    test('"call waiter", "water" and "bill" requests are refused', async () => {
        const table = await createTable(H);
        const { scanToken } = await scanTable(ctx.api, table);
        for (const type of ['waiter', 'water', 'bill']) {
            const res = await ctx.api.guest(H, scanToken).post('/requests').send({ tableId: String(table._id), type });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('REQUEST_TYPE_DISABLED');
        }
    });

    test('tips are refused', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash', tipAmount: 20, total: dineInTotal(H) + 20 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TIPS_DISABLED');
    });

    test('a customer "repeat" (an order with no payment step) is refused', async () => {
        const { table, guest } = await atTable(H);
        const created = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        const res = await guest.post(`/orders/${created.body.order._id}/repeat-all`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('REPEAT_REQUIRES_PAYMENT');
    });

    test('assigning a waiter to a table is refused', async () => {
        const table = await createTable(H);
        const res = await ctx.api.as(H.users.admin, H).put(`/tables/${table._id}/assign`).send({ waiterId: String(H.users.waiter._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('WAITERS_NOT_IN_USE');
        // clearing an old assignment still works
        const clear = await ctx.api.as(H.users.admin, H).put(`/tables/${table._id}/assign`).send({ waiterId: null });
        expect(clear.status).toBe(200);
    });
});

describe('café (kitchen screen on): released orders go to the KDS; Ready completes them', () => {
    test('cash at the counter: held off the KDS, appears after Mark paid, chef Ready → served', async () => {
        const { table, guest } = await atTable(C);
        const res = await placeOrder(guest, C, table, { paymentIntent: 'counterCash' });
        const id = res.body.order._id;
        expect(await kitchenIds(C)).not.toContain(String(id));

        await ctx.api.as(C.users.admin, C).patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect((await reload(id)).status).toBe('new');
        expect(await kitchenIds(C)).toContain(String(id));

        const chef = ctx.api.as(C.users.chef, C);
        expect((await chef.patch(`/orders/${id}/status`).send({ status: 'preparing' })).status).toBe(200);
        expect((await reload(id)).inventoryDeducted).toBe(true);
        const ready = await chef.patch(`/orders/${id}/status`).send({ status: 'ready' });
        expect(ready.status).toBe(200);
        const o = await reload(id);
        expect(o.status).toBe('served');
        expect(o.preparationCompletedAt).toBeTruthy();
    });

    test('online confirmed → straight to the KDS as a normal new order', async () => {
        const { table, guest } = await atTable(C);
        const p = prepaid(C);
        const res = await placeOrder(guest, C, table, { razorpayPayment: p.checkout, paymentMethod: 'online' });
        expect(res.status).toBe(201);
        expect(res.body.order.status).toBe('new');
        expect(await kitchenIds(C)).toContain(String(res.body.order._id));
    });

    test('a second paid round at the same table does not orphan the first one still cooking', async () => {
        const { table, guest } = await atTable(C);
        const admin = ctx.api.as(C.users.admin, C);
        const r1 = await placeOrder(guest, C, table, { paymentIntent: 'counterCash' });
        await admin.patch(`/orders/${r1.body.order._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect((await reload(r1.body.order._id)).status).toBe('new');

        const r2 = await placeOrder(guest, C, table, { paymentIntent: 'counterCash' });
        expect(r2.status).toBe(201);
        expect(String((await reload(r1.body.order._id)).table)).toBe(String(table._id));
    });

    test('the table stays occupied while a paid round is cooking and frees when the kitchen finishes', async () => {
        const { table, guest } = await atTable(C);
        const admin = ctx.api.as(C.users.admin, C);
        const r = await placeOrder(guest, C, table, { paymentIntent: 'counterCash' });
        const id = r.body.order._id;
        await admin.patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');
        const chef = ctx.api.as(C.users.chef, C);
        await chef.patch(`/orders/${id}/status`).send({ status: 'preparing' });
        await chef.patch(`/orders/${id}/status`).send({ status: 'ready' });
        expect((await reload(id)).status).toBe('served');
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });
});

describe('tenants without a profile are unchanged', () => {
    test('guest dine-in without payment is still accepted (pay after the meal)', async () => {
        const T = await seedTenant({ label: 'plain' });
        const table = await createTable(T);
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await placeOrder(ctx.api.guest(T, scanToken), T, table);
        expect(res.status).toBe(201);
        expect(res.body.order.status).toBe('new');
    });
});

describe('code-review fixes', () => {
    const { releaseHeldOrder } = require(path.join(BACKEND, 'services/orderHoldService'));

    test('an unconfirmed ONLINE hold is never expired by the sweep (money may already be taken)', async () => {
        const { table, guest } = await atTable(H);
        const p = prepaid(H, { confirmed: false });
        const res = await placeOrder(guest, H, table, { razorpayPayment: p.checkout, paymentMethod: 'online' });
        const id = res.body.order._id;
        await Order.updateOne({ _id: id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
        await cancelExpiredHolds();
        expect((await reload(id)).status).toBe('awaiting-payment');
    });

    test('a guest cannot dodge pay-first with a takeaway or a spoofed kiosk order', async () => {
        const take = await ctx.api.guest(H).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', customerName: 'G', phone: '9876543210',
            items: [{ menuItem: String(H.items.paneer._id), quantity: 2 }],
            total: computeBill({ subtotal: 400, taxConfig: toTaxConfig(H.settings.taxes), orderType: 'takeaway' }).total,
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(take.status).toBe(402);
        const kiosk = await ctx.api.guest(H).post('/orders').send({
            type: 'dine-in', source: 'kiosk',
            items: [{ menuItem: String(H.items.paneer._id), quantity: 2 }],
            total: dineInTotal(H),
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect([402, 401, 403]).toContain(kiosk.status);
    });

    test('a held counter-side split order is released only once it is paid itself', async () => {
        const base = {
            restaurant: H.restaurant._id, branch: H.branch._id, type: 'dine-in',
            items: [{ menuItem: H.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1 }],
            total: 200, status: 'awaiting-payment', holdReason: 'wallet', holdReleaseStatus: 'new',
        };
        const parent = await Order.create({ ...base, orderId: `HP-${rid()}`, paymentStatus: 'Paid' });
        const child = await Order.create({ ...base, orderId: `HC-${rid()}`, holdReleaseStatus: 'ready', splitParent: parent._id, paymentStatus: 'Pending' });
        await releaseHeldOrder(parent._id);
        expect((await reload(parent._id)).status).not.toBe('awaiting-payment');
        expect((await reload(child._id)).status).toBe('awaiting-payment');
    });

    test('staff takeaway orders in the hotel are not auto-completed (pickup keeps its ready step)', async () => {
        const res = await ctx.api.as(H.users.admin, H).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', customerName: 'Walk-in', phone: '9876543210',
            items: [{ menuItem: String(H.items.paneer._id), quantity: 2 }],
            total: computeBill({ subtotal: 400, taxConfig: toTaxConfig(H.settings.taxes), orderType: 'takeaway' }).total,
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(res.status).toBe(201);
        expect(res.body.order.status).not.toBe('served');
    });

    test('tenant without a profile still accepts tips (even if its plan lacks tip management)', async () => {
        const T = await seedTenant({ label: 'tips' });
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { 'subscription.features.tipManagement': false } });
        const table = await createTable(T);
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await placeOrder(ctx.api.guest(T, scanToken), T, table, { tipAmount: 20, total: dineInTotal(T) + 20 });
        expect(res.status).toBe(201);
    });
});

describe('admin sees held orders', () => {
    test('/orders/live includes awaiting-payment orders for the admin (cashier view)', async () => {
        const { table, guest } = await atTable(H);
        const res = await placeOrder(guest, H, table, { paymentIntent: 'counterCash' });
        const live = await ctx.api.as(H.users.admin, H).get('/orders/live');
        expect(live.status).toBe(200);
        const list = live.body.orders || live.body.data || [];
        expect(list.map(o => String(o._id))).toContain(String(res.body.order._id));
    });
});
