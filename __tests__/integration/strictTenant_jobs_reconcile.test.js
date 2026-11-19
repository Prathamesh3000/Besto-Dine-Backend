/**
 * STRICT tenant campaign / jobs: payment reconciliation
 * (controllers/razorpay/reconcile.runScheduledReconciliation, scheduled as
 * 'payment-reconciliation').
 *
 * Two tenants with stale Pending online orders; the (mocked) gateway reports
 * captures. Each recovery must land only on its own tenant's order, claim,
 * wallet and loyalty (per-tenant settings); suspended/cancelled tenants are
 * skipped, past_due (soft state) is not; a failure in one order or one tenant
 * never stops the next; a second run changes nothing; the JobLock lets one of
 * two "instances" run the tick.
 *
 * Credentials: reconciliation uses ONE platform Razorpay client (no per-tenant
 * keys exist), so there is no per-tenant credential to leak.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const JobLock = require(path.join(BACKEND, 'models/jobLock'));
const { runScheduledReconciliation } = require(path.join(BACKEND, 'controllers/razorpayController'));
const { runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { createScheduler } = require(path.join(BACKEND, 'utils/scheduler'));
const { createJobLock } = require(path.join(BACKEND, 'utils/jobLock'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const HOUR = 3600 * 1000;
const job = () => runAsSystem('job:payment-reconciliation', () => runScheduledReconciliation());
const reload = (o) => runAsSystem('read', () => Order.findById(o._id).lean());
const setStatus = (t, status) => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { status } });

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `RJ-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 2 }],
        total: 500, razorpayOrderId: `order_${rid()}`, ...fields,
    });
    await Order.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - HOUR) } });
    return doc.toObject();
}
const cap = (amount, id = `pay_${rid()}`) => [{ id, status: 'captured', amount }];
function gateway(map) {
    rzp.instance.orders.fetchPayments.mockImplementation(async (id) => {
        const v = map[id];
        if (v instanceof Error) throw v;
        return { items: v || [] };
    });
}

let A; let B; let custA; let custB;
beforeAll(async () => {
    A = await seedTenant({ label: 'rja' });
    B = await seedTenant({ label: 'rjb' });
    custA = await createCustomer('rja-c');
    custB = await createCustomer('rjb-c');
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } });
    await Settings.updateOne({ restaurant: B.restaurant._id, branch: null }, { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 3, 'wallet.minBillToEarn': 100 } });
});

describe('payment reconciliation across two tenants', () => {
    let oa; let ob; let payA; let payB; let r1Calls;
    test('each tenant capture settles only its own order, claim and loyalty (per-tenant rules)', async () => {
        oa = await makeOrder(A, { user: custA._id });
        ob = await makeOrder(B, { user: custB._id });
        const stillA = await makeOrder(A, { user: custA._id }); // nothing captured
        payA = `pay_${rid()}`; payB = `pay_${rid()}`;
        gateway({ [oa.razorpayOrderId]: cap(50000, payA), [ob.razorpayOrderId]: cap(50000, payB) });

        await expect(job()).resolves.toBeUndefined();

        const a = await reload(oa); const b = await reload(ob);
        expect(a.paymentStatus).toBe('Paid'); expect(b.paymentStatus).toBe('Paid');
        expect(String(a.restaurant)).toBe(String(A.restaurant._id));
        expect(String(b.restaurant)).toBe(String(B.restaurant._id));
        expect(a.razorpayPaymentId).toBe(payA); expect(b.razorpayPaymentId).toBe(payB);
        expect((await reload(stillA)).paymentStatus).not.toBe('Paid');

        const claims = await PaymentClaim.find({ paymentId: { $in: [payA, payB] } }).lean();
        const byId = Object.fromEntries(claims.map((c) => [c.paymentId, c]));
        expect(String(byId[payA].restaurant)).toBe(String(A.restaurant._id));
        expect(String(byId[payB].restaurant)).toBe(String(B.restaurant._id));
        expect(String(byId[payA].ref)).toBe(String(oa._id));

        // Loyalty uses each tenant's OWN pointsPerRupee (1 vs 3), into its own wallet.
        const wa = await runAsSystem('r', () => Wallet.find({ user: custA._id }).lean());
        const wb = await runAsSystem('r', () => Wallet.find({ user: custB._id }).lean());
        expect(wa).toHaveLength(1); expect(wb).toHaveLength(1);
        expect(String(wa[0].restaurant)).toBe(String(A.restaurant._id));
        expect(wa[0].loyaltyPoints).toBe(500);
        expect(String(wb[0].restaurant)).toBe(String(B.restaurant._id));
        expect(wb[0].loyaltyPoints).toBe(1500);
        r1Calls = rzp.instance.orders.fetchPayments.mock.calls.length;
    });

    test('idempotent: a second run fetches nothing new and pays/awards nothing twice', async () => {
        gateway({ [oa.razorpayOrderId]: cap(50000, payA), [ob.razorpayOrderId]: cap(50000, payB) });
        await job();
        const asked = rzp.instance.orders.fetchPayments.mock.calls.map((c) => c[0]);
        expect(asked).not.toContain(oa.razorpayOrderId);
        expect(asked).not.toContain(ob.razorpayOrderId);
        expect(r1Calls).toBeGreaterThan(0);
        expect(await PaymentClaim.countDocuments({ paymentId: { $in: [payA, payB] } })).toBe(2);
        expect((await runAsSystem('r', () => Wallet.findOne({ user: custA._id }).lean())).loyaltyPoints).toBe(500);
        expect((await runAsSystem('r', () => Wallet.findOne({ user: custB._id }).lean())).loyaltyPoints).toBe(1500);
    });
});

describe('cross-tenant payment id reuse', () => {
    test('a payment id is single-use across tenants: only one of two orders can be settled by it', async () => {
        const oa = await makeOrder(A, {});
        const ob = await makeOrder(B, {});
        const shared = `pay_${rid()}`;
        gateway({ [oa.razorpayOrderId]: cap(50000, shared), [ob.razorpayOrderId]: cap(50000, shared) });
        await job();
        const paid = [(await reload(oa)).paymentStatus, (await reload(ob)).paymentStatus].filter((s) => s === 'Paid');
        expect(paid).toHaveLength(1);
        expect(await PaymentClaim.countDocuments({ paymentId: shared })).toBe(1);
    });

    test('a capture that does not cover the order total leaves it unpaid', async () => {
        const o = await makeOrder(A, {});
        gateway({ [o.razorpayOrderId]: cap(10000) });
        await job();
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });
});

describe('tenant status gating', () => {
    test('suspended and cancelled tenants are skipped (gateway never asked); past_due is still reconciled', async () => {
        const S = await seedTenant({ label: 'rjs' });
        const C = await seedTenant({ label: 'rjc' });
        const P = await seedTenant({ label: 'rjp' });
        await setStatus(S, 'suspended'); await setStatus(C, 'cancelled'); await setStatus(P, 'past_due');
        const os = await makeOrder(S, {}); const oc = await makeOrder(C, {}); const op = await makeOrder(P, {});
        gateway({ [os.razorpayOrderId]: cap(50000), [oc.razorpayOrderId]: cap(50000), [op.razorpayOrderId]: cap(50000) });
        await job();
        const asked = rzp.instance.orders.fetchPayments.mock.calls.map((c) => c[0]);
        expect(asked).not.toContain(os.razorpayOrderId);
        expect(asked).not.toContain(oc.razorpayOrderId);
        expect((await reload(os)).paymentStatus).not.toBe('Paid');
        expect((await reload(oc)).paymentStatus).not.toBe('Paid');
        expect((await reload(op)).paymentStatus).toBe('Paid');
    });
});

describe('failure isolation', () => {
    test('a gateway error on one order does not stop the rest of the same tenant or other tenants', async () => {
        const bad = await makeOrder(A, {}); const goodA = await makeOrder(A, {}); const goodB = await makeOrder(B, {});
        gateway({ [bad.razorpayOrderId]: new Error('boom'), [goodA.razorpayOrderId]: cap(50000), [goodB.razorpayOrderId]: cap(50000) });
        await job();
        expect((await reload(bad)).paymentStatus).not.toBe('Paid');
        expect((await reload(goodA)).paymentStatus).toBe('Paid');
        expect((await reload(goodB)).paymentStatus).toBe('Paid');
    });

    test('a whole-tenant failure (its order query throws) does not stop the other tenants', async () => {
        const oa = await makeOrder(A, {}); const ob = await makeOrder(B, {});
        gateway({ [oa.razorpayOrderId]: cap(50000), [ob.razorpayOrderId]: cap(50000) });
        const realFind = Order.find;
        const spy = jest.spyOn(Order, 'find').mockImplementation(function (filter, ...rest) {
            if (filter && String(filter.restaurant) === String(A.restaurant._id)) throw new Error('tenant A db failure');
            return realFind.call(this, filter, ...rest);
        });
        try { await expect(job()).resolves.toBeUndefined(); } finally { spy.mockRestore(); }
        expect((await reload(oa)).paymentStatus).not.toBe('Paid');
        expect((await reload(ob)).paymentStatus).toBe('Paid');
    });

    test('a total failure (tenant list throws) is swallowed, nothing is mutated', async () => {
        const o = await makeOrder(A, {});
        gateway({ [o.razorpayOrderId]: cap(50000) });
        const spy = jest.spyOn(Restaurant, 'find').mockImplementation(() => { throw new Error('db down'); });
        try { await expect(job()).resolves.toBeUndefined(); } finally { spy.mockRestore(); }
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });
});

describe('JobLock around the scheduled job', () => {
    test('of two instances racing for the tick only one runs the job; the lease persists in joblocks', async () => {
        const o = await makeOrder(A, {});
        gateway({ [o.razorpayOrderId]: cap(50000) });
        const fn = jest.fn(() => runScheduledReconciliation());
        const s1 = createScheduler({ lock: createJobLock({ owner: 'inst-1' }) });
        const s2 = createScheduler({ lock: createJobLock({ owner: 'inst-2' }) });
        for (const s of [s1, s2]) s.scheduleJob('payment-reconciliation', 30 * 60 * 1000, fn, { initialDelayMs: 3600 * 1000 });
        await Promise.all([s1._runTick('payment-reconciliation'), s2._runTick('payment-reconciliation')]);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(s1.getJobs()[0].runs + s2.getJobs()[0].runs).toBe(1);
        const lock = await JobLock.findOne({ name: 'payment-reconciliation' }).lean();
        expect(lock.lockedUntil.getTime()).toBeGreaterThan(Date.now());
        expect(['inst-1', 'inst-2']).toContain(lock.owner);
        // within the same interval a later tick is skipped cluster-wide
        await s1._runTick('payment-reconciliation'); await s2._runTick('payment-reconciliation');
        expect(fn).toHaveBeenCalledTimes(1);
        await Promise.all([s1.stopAll(), s2.stopAll()]);
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });
});
