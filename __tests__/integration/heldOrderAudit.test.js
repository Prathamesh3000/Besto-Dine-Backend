/**
 * Held pay-first orders ('awaiting-payment', services/orderHoldService.js)
 * across the read-side / settlement sites that enumerate order statuses:
 *
 *   - not a sale: /telemetry/stats "today" count, /telemetry/reports
 *     order totals / items / earnings, /promotions/coupons/performance
 *     order denominator, /staff/:id/performance "handled", CRM spend
 *   - still open: a held order blocks disabling / deleting its branch
 *   - razorpayController.settleSplitSiblings: a held split doc that it
 *     marks Paid is released via releaseHeldOrder (never left held+Paid)
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { _settleSplitSiblings } = require(path.join(BACKEND, 'controllers/razorpayController'));

const ctx = useIntegrationApp();
const rand = (n = 4) => crypto.randomBytes(n).toString('hex');

const IST_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayIst = () => IST_KEY.format(new Date());

function mkOrder(t, fields = {}) {
    return Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `HA-${rand(6)}`,
        type: 'takeaway',
        customerName: 'Walk-in',
        items: [{ name: 'Paneer Tikka', price: 200, quantity: 1 }],
        total: 200,
        status: 'served',
        paymentStatus: 'Paid',
        paymentMethod: 'cash',
        ...fields,
    });
}

/** A pay-first order still held from the kitchen until paid. */
const mkHeld = (t, fields = {}) => mkOrder(t, {
    status: 'awaiting-payment',
    paymentStatus: 'Pending',
    holdReason: 'counterCash',
    holdReleaseStatus: 'new',
    holdExpiresAt: new Date(Date.now() + 30 * 60000),
    items: [{ name: 'Paneer Tikka', price: 200, quantity: 5 }],
    total: 1000,
    ...fields,
});

describe('held orders are not sales (telemetry)', () => {
    let T;
    beforeAll(async () => {
        T = await seedTenant({ label: 'hat' });
        await mkOrder(T);                                         // 1 real sale: 200
        await mkHeld(T);                                          // unpaid hold
        await mkHeld(T, { paymentStatus: 'Paid', amountPaid: 1000 }); // paid, mid-release
    });

    test('/telemetry/stats: held orders are not "today" orders or earnings', async () => {
        const res = await ctx.api.as(T.users.admin).get('/telemetry/stats?earningsPeriod=daily');
        expect(res.status).toBe(200);
        expect(res.body.stats.todayOrders).toBe(1);
        expect(res.body.stats.pendingOrders).toBe(0);
    });

    test('/telemetry/reports: held orders excluded from order totals, items and earnings', async () => {
        const d = todayIst();
        const res = await ctx.api.as(T.users.admin).get(`/telemetry/reports?from=${d}&to=${d}`);
        expect(res.status).toBe(200);
        expect(res.body.totals.orders).toBe(1);
        expect(res.body.totals.paidOrders).toBe(1);
        expect(res.body.totals.earnings).toBe(200);
        expect(res.body.totals.itemsSold).toBe(1);
        const sum = res.body.earnings.data.reduce((s, r) => s + (r.value || 0), 0);
        expect(sum).toBe(200);
    });
});

describe('held orders are not placed / handled / spent orders', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'hab' }); });

    test('/promotions/coupons/performance: held order not in the order denominator', async () => {
        await mkOrder(T);
        await mkHeld(T);
        const res = await ctx.api.as(T.users.admin).get('/promotions/coupons/performance?filter=week');
        expect(res.status).toBe(200);
        expect(res.body.summary.totalOrders).toBe(1);
    });

    test('/staff/:id/performance: held order not counted as handled', async () => {
        const waiter = T.users.waiter;
        await mkOrder(T, { waiter: waiter._id });
        await mkHeld(T, { waiter: waiter._id });
        const res = await ctx.api.as(T.users.admin).get(`/staff/${waiter._id}/performance`);
        expect(res.status).toBe(200);
        expect(res.body.performance.ordersHandled).toBe(1);
        expect(res.body.performance.todayHandled).toBe(1);
    });

    test('CRM: held order not in customer spend (list + detail)', async () => {
        const cust = await createCustomer('hacrm');
        await mkOrder(T, { user: cust._id, total: 300 });
        await mkHeld(T, { user: cust._id, total: 1000 });
        const list = await ctx.api.as(T.users.admin).get('/crm/customers');
        expect(list.status).toBe(200);
        const row = list.body.customers.find((c) => String(c.id) === String(cust._id));
        expect(row.spending).toBe(300);
        const one = await ctx.api.as(T.users.admin).get(`/crm/customers/${cust._id}`);
        expect(one.status).toBe(200);
        expect(one.body.customer.totalSpend).toBe(300);
    });
});

describe('held orders keep a branch open', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'hbr' }); });

    test('disable-check and DELETE /branches/:id are blocked by a held order', async () => {
        const B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'Second', slug: `second-${rand(2)}`, isActive: true });
        const held = await mkHeld(T, { branch: B2._id });

        const check = await ctx.api.as(T.users.admin).get(`/branches/${B2._id}/disable-check`);
        expect(check.status).toBe(200);
        expect(check.body.canDisable).toBe(false);
        expect(check.body.blockers.activeOrders).toBe(1);

        const del = await ctx.api.as(T.users.admin).delete(`/branches/${B2._id}`);
        expect(del.status).toBe(400);
        expect((await Branch.findById(B2._id)).isActive).toBe(true);

        // Once the hold is gone the branch can be disabled.
        await Order.updateOne({ _id: held._id }, { $set: { status: 'cancelled', cancelReason: 'payment-timeout' } });
        const after = await ctx.api.as(T.users.admin).get(`/branches/${B2._id}/disable-check`);
        expect(after.body.canDisable).toBe(true);
    });
});

describe('razorpay settleSplitSiblings releases a held split doc', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'hsp' }); });

    test('held split doc covered by the capture → Paid AND released (not left held)', async () => {
        const primary = await mkOrder(T, {
            status: 'new', total: 200, amountPaid: 300, paymentMethod: 'online', paidAt: new Date(),
        });
        const split = await mkHeld(T, {
            splitParent: primary._id,
            holdReleaseStatus: 'ready',
            items: [{ name: 'Water', price: 100, quantity: 1 }],
            total: 100,
        });

        await _settleSplitSiblings(primary, 'online');

        const after = await Order.findById(split._id).lean();
        expect(after.paymentStatus).toBe('Paid');
        expect(after.status).not.toBe('awaiting-payment');
        expect(['ready', 'served']).toContain(after.status);
        expect(after.releasedAt).toBeTruthy();
    });

    test('held split doc NOT covered by the capture stays held and unpaid', async () => {
        const primary = await mkOrder(T, {
            status: 'new', total: 200, amountPaid: 200, paymentMethod: 'online', paidAt: new Date(),
        });
        const split = await mkHeld(T, { splitParent: primary._id, holdReleaseStatus: 'ready', total: 100 });

        await _settleSplitSiblings(primary, 'online');

        const after = await Order.findById(split._id).lean();
        expect(after.paymentStatus).toBe('Pending');
        expect(after.status).toBe('awaiting-payment');
    });
});

// ── razorpayController review follow-ups ────────────────────────────────
const { V1 } = require('./helpers/http');
const { createTable } = require('./helpers/seed');
const RefundRequest = require(path.join(BACKEND, 'models/refundRequest'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Tip = require(path.join(BACKEND, 'models/tip'));
const { profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));
const { _settleSiblingDineInRounds } = require(path.join(BACKEND, 'controllers/razorpayController'));

const whSign = (raw) => crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
function deliverCapture(order, amountPaise) {
    const body = JSON.stringify({
        entity: 'event', event: 'payment.captured', id: `evt_${rand(5)}`,
        payload: { payment: { entity: {
            id: `pay_${rand(5)}`, entity: 'payment', amount: amountPaise, currency: 'INR', status: 'captured',
            order_id: order.razorpayOrderId,
            notes: { cafeOrderId: String(order._id), restaurantId: String(order.restaurant), purpose: 'cafe_order' },
        } } },
    });
    return ctx.api.raw.post(`${V1}/razorpay/webhook`)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', whSign(body))
        .send(body);
}
const rzpOrder = (t, fields = {}) => mkOrder(t, {
    status: 'new', paymentStatus: 'Pending', paymentMethod: undefined,
    total: 500, items: [{ name: 'Paneer Tikka', price: 500, quantity: 1 }],
    razorpayOrderId: `order_${rand(5)}`, ...fields,
});

describe('capture on an already-cancelled order (markOrderPaidAtomically)', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'hcx' }); });

    test('held online order cancelled before the capture → Paid recorded + refund request queued, no tip', async () => {
        const order = await rzpOrder(T, {
            status: 'cancelled', cancelReason: 'payment-timeout', holdReason: 'online',
            waiter: T.users.waiter._id, tipAmount: 20, total: 500,
        });
        const res = await deliverCapture(order, 50000);
        expect(res.status).toBe(200);

        const after = await Order.findById(order._id).lean();
        expect(after.status).toBe('cancelled');          // never resurrected
        expect(after.paymentStatus).toBe('Paid');        // the money is recorded
        expect(after.amountPaid).toBe(500);
        const reqs = await RefundRequest.find({ order: order._id }).lean();
        expect(reqs).toHaveLength(1);
        expect(reqs[0]).toMatchObject({ amount: 500, status: 'pending' });
        expect(await Tip.countDocuments({ order: order._id })).toBe(0);

        // A duplicate delivery doesn't queue a second request.
        await deliverCapture(order, 50000);
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(1);
    });

    test('a live order captured normally queues no refund request', async () => {
        const order = await rzpOrder(T);
        expect((await deliverCapture(order, 50000)).status).toBe(200);
        expect((await Order.findById(order._id).lean()).paymentStatus).toBe('Paid');
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(0);
    });
});

describe('settleSiblingDineInRounds is skipped for pay-first', () => {
    test('pay-first tenant: a dine-in capture leaves the other rounds on the table unpaid', async () => {
        const P = await seedTenant({ label: 'hpf' });
        await Restaurant.updateOne({ _id: P.restaurant._id }, { $set: { operations: profileFromPreset('cafeCounterPayFirst') } });
        const table = await createTable(P);
        const paid = await rzpOrder(P, { type: 'dine-in', table: table._id });
        const sibling = await mkOrder(P, { type: 'dine-in', table: table._id, status: 'new', paymentStatus: 'Pending', total: 200 });

        expect((await deliverCapture(paid, 50000)).status).toBe(200);

        expect((await Order.findById(paid._id).lean()).paymentStatus).toBe('Paid');
        expect((await Order.findById(sibling._id).lean()).paymentStatus).toBe('Pending');
    });

    test('paid order carrying a holdReason never settles its siblings (pay-later tenant)', async () => {
        const T = await seedTenant({ label: 'hhr' });
        const table = await createTable(T);
        const paid = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', holdReason: 'online', amountPaid: 200 });
        const sibling = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', paymentStatus: 'Pending', total: 200 });

        await _settleSiblingDineInRounds(paid, 'online');
        expect((await Order.findById(sibling._id).lean()).paymentStatus).toBe('Pending');

        // Control: same table, no holdReason → the aggregated-bill sibling settle still runs.
        const plain = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', amountPaid: 400 });
        await _settleSiblingDineInRounds(plain, 'online');
        const sib = await Order.findById(sibling._id).lean();
        expect(sib.paymentStatus).toBe('Paid');
        expect(sib.amountPaid).toBe(0);
    });
});

// ── A7: a failed operations-profile lookup must not skip sibling settlement ──
describe('settleSiblingDineInRounds — profile lookup error falls back to today\'s behaviour (A7)', () => {
    const holdService = require(path.join(BACKEND, 'services/orderHoldService'));

    test('loadOps throws → pay-after tenant still settles the other unpaid rounds on the table', async () => {
        const T = await seedTenant({ label: 'ha7' });
        const table = await createTable(T);
        const paid = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', amountPaid: 400, paymentMethod: 'online' });
        const sibling = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', paymentStatus: 'Pending', total: 200 });

        const spy = jest.spyOn(holdService, 'loadOps').mockRejectedValue(new Error('restaurant lookup failed'));
        try {
            await _settleSiblingDineInRounds(paid, 'online');
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
        const sib = await Order.findById(sibling._id).lean();
        expect(sib.paymentStatus).toBe('Paid');
        expect(sib.amountPaid).toBe(0);
        expect(sib.paymentMethod).toBe('online');
    });

    test('a held (pay-first) order still never settles siblings, lookup error or not', async () => {
        const T = await seedTenant({ label: 'ha7b' });
        const table = await createTable(T);
        const held = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', holdReason: 'online', amountPaid: 200 });
        const sibling = await mkOrder(T, { type: 'dine-in', table: table._id, status: 'new', paymentStatus: 'Pending', total: 200 });
        const spy = jest.spyOn(holdService, 'loadOps').mockRejectedValue(new Error('boom'));
        try { await _settleSiblingDineInRounds(held, 'online'); } finally { spy.mockRestore(); }
        expect((await Order.findById(sibling._id).lean()).paymentStatus).toBe('Pending');
    });
});
