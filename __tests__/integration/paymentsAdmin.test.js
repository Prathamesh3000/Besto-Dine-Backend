/**
 * Admin payments surface + payment-claim ledger:
 *   - GET /api/v1/payments/admin/all   → controllers/paymentController.getAllPayments
 *   - GET /api/v1/razorpay/reconcile   → razorpayController.reconcilePayments
 *   - razorpayController.runScheduledReconciliation (30-min background job)
 *   - utils/paymentClaim (claimPayment / releaseClaim / findClaim)
 *
 * Coverage:
 *   - payments list: role + viewPayments permission, tenant and branch
 *     isolation, status counts, today's revenue, method labels, bill
 *     breakdown residual, refundable balance and refund history
 *   - reconcile: recovery of a captured payment (paise, paidAt, claim,
 *     loyalty), still pending, gateway error per order, payment claimed
 *     elsewhere, freshness cutoff, minutes bounds, tenant isolation,
 *     amount must cover the order
 *   - scheduled reconcile: all active tenants, suspended tenants skipped,
 *     one tenant's failure does not stop the rest
 *   - claim ledger: first claim, same-purpose replay, conflict, release
 *     only the matching claim, concurrent claims
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const { claimPayment, releaseClaim, findClaim } = require(path.join(BACKEND, 'utils/paymentClaim'));
const { runScheduledReconciliation } = require(path.join(BACKEND, 'controllers/razorpayController'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const HOUR = 3600 * 1000;

async function makeOrder(t, fields = {}, { ageMs = 0 } = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `PA-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 2 }],
        total: 500,
        ...fields,
    });
    if (ageMs) {
        await Order.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - ageMs) } });
    }
    return doc.toObject();
}

const reload = (o) => Order.findById(o._id).lean();

// ── GET /payments/admin/all ──────────────────────────────────────────

describe('GET /payments/admin/all', () => {
    let P;
    let Q;
    let north;
    let rows;
    beforeAll(async () => {
        P = await seedTenant({ label: 'pa-list' });
        Q = await seedTenant({ label: 'pa-other' });
        north = await Branch.create({ restaurant: P.restaurant._id, name: 'North', slug: `north-${rid()}`, isActive: true });
        const cust = await createCustomer('pa-cust');

        rows = {
            paidToday: await makeOrder(P, {
                orderId: 'PA-PAID', user: cust._id, paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 512.4, total: 512.4,
                tipAmount: 20, couponDiscount: 50, pointsRedeemed: 10, refundedAmount: 100.1,
                razorpayPaymentId: 'pay_x', refunds: [{ amount: 100.1, reason: 'cold', source: 'admin', actorName: 'Owner' }],
            }),
            paidYesterday: await makeOrder(P, { orderId: 'PA-OLD', paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 300, total: 300 }, { ageMs: 30 * HOUR }),
            refunded: await makeOrder(P, { orderId: 'PA-REF', paymentStatus: 'Refunded', paymentMethod: 'wallet', amountPaid: 200, total: 200, refundedAmount: 200 }),
            partial: await makeOrder(P, { orderId: 'PA-PART', paymentStatus: 'Partially Paid', paymentMethod: 'mixed', amountPaid: 100 }),
            pending: await makeOrder(P, { orderId: 'PA-PEND', paymentMethod: 'Not selected' }),
            cancelledUnpaid: await makeOrder(P, { orderId: 'PA-CXL', status: 'cancelled' }),
            cancelledPaid: await makeOrder(P, { orderId: 'PA-CXLPAID', status: 'cancelled', paymentStatus: 'Paid', paymentMethod: 'UPI', amountPaid: 150, total: 150 }),
            northPaid: await makeOrder(P, { orderId: 'PA-NORTH', branch: north._id, paymentStatus: 'Paid', paymentMethod: 'razorpay', amountPaid: 80, total: 80 }),
            otherTenant: await makeOrder(Q, { orderId: 'PA-Q', paymentStatus: 'Paid', amountPaid: 999, total: 999 }),
        };
    });

    const list = (user) => ctx.api.as(user).get('/payments/admin/all');
    const byId = (res, id) => res.body.payments.find((p) => p.id === id);

    test("the owner sees every payment of the tenant and none of another tenant's", async () => {
        const res = await list(P.users.admin);

        expect(res.status).toBe(200);
        const ids = res.body.payments.map((p) => p.id).sort();
        expect(ids).toEqual(['PA-CXLPAID', 'PA-NORTH', 'PA-OLD', 'PA-PAID', 'PA-PART', 'PA-PEND', 'PA-REF']);
    });

    test('status counts and filters match the rows', async () => {
        const res = await list(P.users.admin);
        const counts = Object.fromEntries(res.body.filters.map((f) => [f.name, f.count]));

        expect(counts).toEqual({ All: '07', Successful: '04', Pending: '02', Failed: '00', Refunded: '01' });
        expect(res.body.stats).toMatchObject({ successful: 4, pending: 2, failed: 1 });
    });

    test("today's revenue sums the totals of orders paid and created today", async () => {
        const res = await list(P.users.admin);
        // PA-PAID 512.4 + PA-CXLPAID 150 + PA-NORTH 80 (PA-OLD is from yesterday)
        expect(res.body.stats.todayRevenue).toBeCloseTo(742.4, 10);
    });

    test.each([
        ['PA-PAID', 'Online', 'successful'],
        ['PA-OLD', 'Cash', 'successful'],
        ['PA-REF', 'Wallet', 'refunded'],
        ['PA-PART', 'Mixed', 'pending'],
        ['PA-PEND', '-', 'pending'],
        ['PA-CXLPAID', 'UPI', 'successful'],
        ['PA-NORTH', 'Online', 'successful'],
    ])('%s is shown as method %s, status %s', async (id, method, status) => {
        const row = byId(await list(P.users.admin), id);
        expect(row).toMatchObject({ method, status });
    });

    test('the bill breakdown reconciles to the total and exposes the refundable balance', async () => {
        const row = byId(await list(P.users.admin), 'PA-PAID');

        expect(row).toMatchObject({
            subtotal: 400, tipAmount: 20, couponDiscount: 50, pointsRedeemed: 10, total: 512.4,
            amountPaid: 512.4, refundedAmount: 100.1, refundableBalance: 412.29999999999995,
            razorpayPaymentId: 'pay_x', customer: 'Customer pa-cust',
        });
        // 512.4 - 400 - 20 + 50 + 10 = 152.4
        expect(row.taxesAndCharges).toBe(152.4);
        expect(row.items).toEqual([{ name: 'Paneer Tikka x2', variant: '', price: 400, unitPrice: 200 }]);
        expect(row.refunds).toEqual([expect.objectContaining({ amount: 100.1, reason: 'cold', actorName: 'Owner', source: 'admin' })]);
    });

    test('a branch admin only sees their branch', async () => {
        const northAdmin = await createUser({
            name: 'North admin', email: `na.${rid()}@staff.test`, role: 'admin',
            restaurant: P.restaurant._id, branch: north._id, permissions: {},
        });

        const res = await list(northAdmin);

        expect(res.status).toBe(200);
        expect(res.body.payments.map((p) => p.id)).toEqual(['PA-NORTH']);
        expect(res.body.stats.todayRevenue).toBe(80);
    });

    test.each([
        ['waiter', (t) => t.users.waiter],
        ['chef', (t) => t.users.chef],
        ['captain', (t) => t.users.captain],
    ])('a %s cannot see payments', async (_label, pick) => {
        expect((await list(pick(P))).status).toBe(403);
    });

    test('a customer cannot see payments', async () => {
        const cust = await createCustomer('pa-nope');
        expect((await ctx.api.as(cust, P).get('/payments/admin/all')).status).toBe(403);
    });

    test('labels card, net banking and unknown methods, and names the kiosk and table', async () => {
        const L = await seedTenant({ label: 'pa-labels' });
        const paid = { paymentStatus: 'Paid', amountPaid: 100, total: 100 };
        await makeOrder(L, { ...paid, orderId: 'PA-CARD', paymentMethod: 'Debit Card', source: 'kiosk' });
        await makeOrder(L, { ...paid, orderId: 'PA-NB', paymentMethod: 'netbanking', type: 'dine-in', table: L.tables.main._id });
        await makeOrder(L, { ...paid, orderId: 'PA-PAYTM', paymentMethod: 'paytm' });
        await makeOrder(L, { ...paid, orderId: 'PA-BLANK', paymentMethod: '' });

        const res = await list(L.users.admin);

        expect(byId(res, 'PA-CARD')).toMatchObject({ method: 'Card', table: 'Kiosk' });
        expect(byId(res, 'PA-NB')).toMatchObject({ method: 'Net Banking', table: L.tables.main.name });
        expect(byId(res, 'PA-PAYTM')).toMatchObject({ method: 'Paytm', table: 'Takeaway' });
        expect(byId(res, 'PA-BLANK').method).toBe('-');
    });

    test('a manager needs the viewPayments permission', async () => {
        const mk = (viewPayments) => createUser({
            name: `Mgr ${viewPayments}`, email: `mgr.${rid()}@staff.test`, role: 'manager',
            restaurant: P.restaurant._id, branch: null, permissions: { viewPayments },
        });

        expect((await list(await mk(false))).status).toBe(403);
        expect((await list(await mk(true))).status).toBe(200);
    });
});

// ── GET /razorpay/reconcile ──────────────────────────────────────────

describe('GET /razorpay/reconcile', () => {
    let R;
    let S;
    beforeAll(async () => {
        R = await seedTenant({ label: 'pa-rec' });
        S = await seedTenant({ label: 'pa-rec-s' });
        await Settings.updateOne({ restaurant: R.restaurant._id, branch: null }, {
            $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 },
        });
    });

    /** Stub fetchPayments per Razorpay order id. */
    function gateway(map) {
        rzp.instance.orders.fetchPayments.mockImplementation(async (rzpOrderId) => {
            const v = map[rzpOrderId];
            if (v instanceof Error) throw v;
            return { entity: 'collection', items: v || [] };
        });
    }

    const reconcile = (user, query = '') => ctx.api.as(user).get(`/razorpay/reconcile${query}`);
    const resultFor = (res, order) => res.body.results.find((r) => r.orderId === order.orderId);

    test('recovers a stale order whose payment was captured', async () => {
        const cust = await createCustomer('rec-ok');
        const order = await makeOrder(R, { user: cust._id, razorpayOrderId: `order_${rid()}`, total: 512.4 }, { ageMs: HOUR });
        const paymentId = `pay_${rid()}`;
        gateway({ [order.razorpayOrderId]: [
            { id: `pay_${rid()}`, status: 'failed', amount: 51240 },
            { id: paymentId, status: 'captured', amount: 51240, created_at: 1767225600 },
        ] });

        const res = await reconcile(R.users.admin);

        expect(res.status).toBe(200);
        expect(resultFor(res, order)).toEqual({ orderId: order.orderId, status: 'recovered', amount: 512.4 });
        const after = await reload(order);
        expect(after).toMatchObject({ paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 512.4, razorpayPaymentId: paymentId });
        expect(new Date(after.paidAt).toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(await findClaim(paymentId)).toMatchObject({ purpose: 'order_payment', ref: String(order._id) });
        expect((await Wallet.findOne({ user: cust._id, restaurant: R.restaurant._id }).lean()).loyaltyPoints).toBe(512);
    });

    test('an order with no captured payment stays pending', async () => {
        const order = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        gateway({ [order.razorpayOrderId]: [{ id: `pay_${rid()}`, status: 'failed', amount: 50000 }] });

        const res = await reconcile(R.users.admin);

        expect(resultFor(res, order)).toEqual({ orderId: order.orderId, status: 'still_pending' });
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a gateway error is reported for that order without stopping the others', async () => {
        const broken = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const fine = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        gateway({
            [broken.razorpayOrderId]: new Error('gateway timeout'),
            [fine.razorpayOrderId]: [{ id: `pay_${rid()}`, status: 'captured', amount: 50000 }],
        });

        const res = await reconcile(R.users.admin);

        expect(resultFor(res, broken)).toMatchObject({ status: 'error', error: 'gateway timeout' });
        expect(resultFor(res, fine).status).toBe('recovered');
    });

    test('a payment already claimed for something else is not applied', async () => {
        const order = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const paymentId = `pay_${rid()}`;
        await PaymentClaim.create({ paymentId, purpose: 'wallet_recharge', ref: 'someone' });
        gateway({ [order.razorpayOrderId]: [{ id: paymentId, status: 'captured', amount: 50000 }] });

        const res = await reconcile(R.users.admin);

        expect(resultFor(res, order).status).toBe('payment_used_elsewhere');
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('orders younger than the cutoff, without a checkout, or already paid are not touched', async () => {
        const fresh = await makeOrder(R, { razorpayOrderId: `order_${rid()}` });
        const noCheckout = await makeOrder(R, {}, { ageMs: HOUR });
        const paid = await makeOrder(R, { razorpayOrderId: `order_${rid()}`, paymentStatus: 'Paid', amountPaid: 500 }, { ageMs: HOUR });
        gateway({});

        const res = await reconcile(R.users.admin, '?minutes=30');

        for (const o of [fresh, noCheckout, paid]) expect(resultFor(res, o)).toBeUndefined();
        expect(rzp.instance.orders.fetchPayments).not.toHaveBeenCalledWith(fresh.razorpayOrderId);
    });

    test.each([
        ['0', 30],
        ['-5', 1],
        ['99999', 1440],
        ['abc', 30],
    ])('minutes=%s is treated as %i', async (minutes, effective) => {
        const justInside = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: (effective + 1) * 60 * 1000 });
        const justOutside = await makeOrder(R, { razorpayOrderId: `order_${rid()}` }, { ageMs: (effective - 1) * 60 * 1000 + 1000 });
        gateway({});

        const res = await reconcile(R.users.admin, `?minutes=${minutes}`);

        expect(res.status).toBe(200);
        expect(resultFor(res, justInside)).toBeDefined();
        expect(resultFor(res, justOutside)).toBeUndefined();
    });

    test("another tenant's stale orders are never checked or changed", async () => {
        const foreign = await makeOrder(S, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        gateway({ [foreign.razorpayOrderId]: [{ id: `pay_${rid()}`, status: 'captured', amount: 50000 }] });

        const res = await reconcile(R.users.admin);

        expect(resultFor(res, foreign)).toBeUndefined();
        expect((await reload(foreign)).paymentStatus).toBe('Pending');
    });

    test.each([
        ['waiter', (t) => t.users.waiter],
        ['captain', (t) => t.users.captain],
    ])('a %s cannot run reconciliation', async (_label, pick) => {
        expect((await reconcile(pick(R))).status).toBe(403);
    });

    // Regression (fixed 2026-10): reconciliation applies the verify-payment coverage rule.
    test('an underpaid capture does not settle the order', async () => {
        const order = await makeOrder(R, { razorpayOrderId: `order_${rid()}`, total: 500 }, { ageMs: HOUR });
        gateway({ [order.razorpayOrderId]: [{ id: `pay_${rid()}`, status: 'captured', amount: 10000 }] });

        await reconcile(R.users.admin);

        expect((await reload(order)).paymentStatus).not.toBe('Paid');
    });
});

// ── Scheduled reconciliation ─────────────────────────────────────────

describe('runScheduledReconciliation', () => {
    test('recovers stale orders across active tenants and skips suspended ones', async () => {
        const T1 = await seedTenant({ label: 'pa-job-1' });
        const T2 = await seedTenant({ label: 'pa-job-2' });
        const Sus = await seedTenant({ label: 'pa-job-sus' });
        await Restaurant.updateOne({ _id: Sus.restaurant._id }, { $set: { status: 'suspended' } });

        const o1 = await makeOrder(T1, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const o2 = await makeOrder(T2, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const oBroken = await makeOrder(T2, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const oSus = await makeOrder(Sus, { razorpayOrderId: `order_${rid()}` }, { ageMs: HOUR });
        const captured = (amount) => [{ id: `pay_${rid()}`, status: 'captured', amount }];
        const map = {
            [o1.razorpayOrderId]: captured(50000),
            [o2.razorpayOrderId]: captured(50000),
            [oBroken.razorpayOrderId]: new Error('boom'),
            [oSus.razorpayOrderId]: captured(50000),
        };
        rzp.instance.orders.fetchPayments.mockImplementation(async (id) => {
            const v = map[id];
            if (v instanceof Error) throw v;
            return { items: v || [] };
        });

        await expect(runScheduledReconciliation()).resolves.toBeUndefined();

        expect((await reload(o1)).paymentStatus).toBe('Paid');
        expect((await reload(o2)).paymentStatus).toBe('Paid');
        expect((await reload(oBroken)).paymentStatus).toBe('Pending');
        expect((await reload(oSus)).paymentStatus).toBe('Pending');
    });
});

// ── utils/paymentClaim ───────────────────────────────────────────────

describe('payment claim ledger', () => {
    const opts = (fields = {}) => ({ purpose: 'order_payment', ref: 'order-1', amount: 500, ...fields });

    test('the first claim wins and is recorded', async () => {
        const id = `pay_${rid()}`;
        const result = await claimPayment(id, opts({ razorpayOrderId: 'order_x' }));

        expect(result.claimed).toBe(true);
        expect(result.replay).toBeUndefined();
        expect(await findClaim(id)).toMatchObject({ paymentId: id, purpose: 'order_payment', ref: 'order-1', amount: 500, razorpayOrderId: 'order_x' });
    });

    test('the same purpose and ref claiming again is an idempotent replay', async () => {
        const id = `pay_${rid()}`;
        await claimPayment(id, opts());

        const again = await claimPayment(id, opts());

        expect(again).toMatchObject({ claimed: true, replay: true });
    });

    test.each([
        ['a different ref', { ref: 'order-2' }],
        ['a different purpose', { purpose: 'wallet_recharge' }],
    ])('%s cannot claim a spent payment', async (_label, other) => {
        const id = `pay_${rid()}`;
        await claimPayment(id, opts());

        const result = await claimPayment(id, opts(other));

        expect(result.claimed).toBe(false);
        expect(result.claim).toMatchObject({ purpose: 'order_payment', ref: 'order-1' });
    });

    test('ten concurrent claims for different orders: exactly one wins', async () => {
        const id = `pay_${rid()}`;

        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimPayment(id, opts({ ref: `order-${i}` }))));

        expect(results.filter((r) => r.claimed)).toHaveLength(1);
        expect(await PaymentClaim.countDocuments({ paymentId: id })).toBe(1);
    });

    test('release only removes the matching claim', async () => {
        const id = `pay_${rid()}`;
        await claimPayment(id, opts());

        await releaseClaim(id, { purpose: 'order_payment', ref: 'order-2' });
        expect(await findClaim(id)).not.toBeNull();

        await releaseClaim(id, { purpose: 'order_payment', ref: 'order-1' });
        expect(await findClaim(id)).toBeNull();
        expect((await claimPayment(id, opts({ ref: 'order-3' }))).claimed).toBe(true);
    });

    test('ids are compared as strings', async () => {
        const id = `pay_${rid()}`;
        await claimPayment(id, opts({ ref: 42 }));
        expect((await claimPayment(id, opts({ ref: '42' }))).replay).toBe(true);
    });
});
