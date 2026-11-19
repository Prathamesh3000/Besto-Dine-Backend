/**
 * STRICT payments campaign — REFUNDS, part 1: POST /razorpay/refund
 * (controllers/razorpay/refunds.js refundPayment) and the shared
 * utils/orderRefund helpers.
 *
 * Angles: input validation, paise rounding, full vs partial, over-refund,
 * refund twice / idempotency key, unpaid / cancelled / already refunded,
 * channel (gateway / wallet / cash / mixed), wallet credited exactly once,
 * loyalty clawback, concurrency, gateway-vs-DB failure consistency, role
 * permissions, audit trail.
 *
 * Tests named "BUG:" pin behaviour that is wrong today and are expected to
 * FAIL until the source is fixed (expected vs actual in the comment above).
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const TenantAudit = require(path.join(BACKEND, 'models/tenantAudit'));
const { roundPaise, ledgerPaymentMethod, isWalletPaid, loyaltyPointsToClawBack } = require(path.join(BACKEND, 'utils/orderRefund'));

const ctx = useIntegrationApp();
let A; let W; let B;
const rid = () => crypto.randomBytes(5).toString('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'sp-a' });
    W = await seedTenant({ label: 'sp-w' });
    B = await seedTenant({ label: 'sp-b' });
    const w = { 'wallet.pointsPerRupee': 1, 'wallet.enableLoyalty': true, 'wallet.minBillToEarn': 100 };
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { ...w, 'wallet.refundMode': 'original' } });
    await Settings.updateOne({ restaurant: W.restaurant._id, branch: null }, { $set: { ...w, 'wallet.refundMode': 'wallet' } });
});

async function paidOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `SP-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 500,
        razorpayPaymentId: `pay_${rid()}`, paidAt: new Date(), ...fields,
    });
    return doc.toObject();
}
const cashOrder = (t, f = {}) => paidOrder(t, { paymentMethod: 'cash', razorpayPaymentId: undefined, ...f });
async function customerWith(t, { balance = 0, loyaltyPoints = 0 } = {}) {
    const c = await createCustomer('sp');
    await Wallet.create({ user: c._id, restaurant: t.restaurant._id, balance, loyaltyPoints });
    return c;
}
let rfCount = 0;
function stubGateway({ delay = 0, fail = false } = {}) {
    rzp.instance.payments.refund.mockImplementation(async (paymentId, params) => {
        if (delay) await settle(delay);
        if (fail) throw Object.assign(new Error('gateway down'), { statusCode: 502 });
        rfCount += 1;
        return { id: `rfnd_${rfCount}_${rid()}`, entity: 'refund', payment_id: paymentId, amount: params.amount, status: 'processed' };
    });
}
const gwCalls = () => rzp.instance.payments.refund.mock.calls;
const gwPaise = () => gwCalls().reduce((s, c) => s + c[1].amount, 0);
const refund = (t, body, user = t.users.admin, key) => {
    let r = ctx.api.as(user).post('/razorpay/refund');
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
};
const reload = (o) => Order.findById(o._id).lean();
const walletOf = (t, u) => Wallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean();
const untouched = async (o) => {
    const after = await reload(o);
    expect(after.refundedAmount).toBe(0);
    expect(after.paymentStatus).toBe('Paid');
    expect(after.refunds || []).toHaveLength(0);
    expect(gwCalls()).toHaveLength(0);
};

// ═══ validation ══════════════════════════════════════════════════════
describe('input validation: nothing moves on a bad request', () => {
    test.each([
        ['amount missing', {}],
        ['amount null', { amount: null }],
        ['amount as string', { amount: '100' }],
        ['amount zero', { amount: 0 }],
        ['amount negative', { amount: -50 }],
        ['amount below one paisa', { amount: 0.004 }],
        ['amount an array', { amount: [100] }],
        ['amount an object', { amount: { $gt: 0 } }],
        ['amount boolean', { amount: true }],
    ])('%s -> 400, order untouched, gateway not called', async (_n, extra) => {
        stubGateway();
        const o = await paidOrder(A);
        const res = await refund(A, { orderId: String(o._id), ...extra });
        expect(res.status).toBe(400);
        await untouched(o);
    });

    test('amount 1e999 (parses to Infinity) is refused', async () => {
        stubGateway();
        const o = await paidOrder(A);
        const res = await ctx.api.as(A.users.admin).post('/razorpay/refund')
            .set('Content-Type', 'application/json').send(`{"orderId":"${o._id}","amount":1e999}`);
        expect(res.status).toBe(400);
        await untouched(o);
    });

    test('a reason longer than 1000 chars is refused', async () => {
        stubGateway();
        const o = await paidOrder(A);
        const res = await refund(A, { orderId: String(o._id), amount: 10, reason: 'x'.repeat(1001) });
        expect(res.status).toBe(400);
        await untouched(o);
    });

    // Expected: a refund must carry a reason (attribution / fraud review) -> 400.
    // Actual: `reason || ''` - the refund goes through with an empty reason
    // (refunds.js:104 / :125); the audit row and ledger say "No reason".
    test('Regression (fixed 2026-11): a refund without a reason is rejected', async () => {
        stubGateway();
        const o = await cashOrder(A);
        const res = await refund(A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(400);
        expect((await reload(o)).refundedAmount).toBe(0);
    });

    test('Regression (fixed 2026-11): a whitespace-only reason is rejected', async () => {
        const o = await cashOrder(A);
        const res = await refund(A, { orderId: String(o._id), amount: 100, reason: '    ' });
        expect(res.status).toBe(400);
    });

    test('the human order number (orderId) works as a reference as well as the _id', async () => {
        const o = await cashOrder(A);
        const res = await refund(A, { orderId: o.orderId, amount: 100, reason: 'by number' });
        expect(res.status).toBe(200);
        expect((await reload(o)).refundedAmount).toBe(100);
    });

    test('an unknown order is a 404 and an unknown ObjectId too', async () => {
        const r1 = await refund(A, { orderId: 'NOPE-1', amount: 10, reason: 'x' });
        const r2 = await refund(A, { orderId: '64b64b64b64b64b64b64b64b', amount: 10, reason: 'x' });
        expect([r1.status, r2.status]).toEqual([404, 404]);
    });
});

// ═══ order state ═════════════════════════════════════════════════════
describe('which orders can be refunded', () => {
    test.each(['Pending', 'Partially Paid', 'Refunded'])('a %s order is refused with 400 and untouched', async (ps) => {
        stubGateway();
        const o = await paidOrder(A, { paymentStatus: ps, amountPaid: ps === 'Pending' ? 0 : 500, refundedAmount: ps === 'Refunded' ? 500 : 0 });
        const res = await refund(A, { orderId: String(o._id), amount: 100, reason: 'r' });
        expect(res.status).toBe(400);
        expect(gwCalls()).toHaveLength(0);
        const after = await reload(o);
        expect(after.refundedAmount).toBe(o.refundedAmount || 0);
    });

    test('a cancelled-but-paid order can be refunded (this is the cancel->refund path)', async () => {
        const o = await cashOrder(A, { status: 'cancelled' });
        const res = await refund(A, { orderId: String(o._id), amount: 500, reason: 'cancelled' });
        expect(res.status).toBe(200);
        expect((await reload(o))).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 500, status: 'cancelled' });
    });

    test('a Paid order with amountPaid 0 (free / data glitch) refuses any refund', async () => {
        const o = await cashOrder(A, { amountPaid: 0 });
        const res = await refund(A, { orderId: String(o._id), amount: 10, reason: 'r' });
        expect(res.status).toBe(400);
        expect((await reload(o)).refundedAmount).toBe(0);
    });

    test("another tenant's order is 404 and untouched; no gateway call", async () => {
        stubGateway();
        const o = await paidOrder(B);
        const res = await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' });
        expect(res.status).toBe(404);
        await untouched(o);
    });
});

// ═══ limits, full vs partial, rounding ═══════════════════════════════
describe('amount limits and paise rounding', () => {
    test('a refund above the amount paid is refused and names the ceiling', async () => {
        stubGateway();
        const o = await paidOrder(A);
        const res = await refund(A, { orderId: String(o._id), amount: 500.01, reason: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('500');
        await untouched(o);
    });

    test('a full online refund sends exactly amountPaid in paise and flips to Refunded', async () => {
        stubGateway();
        const o = await paidOrder(A, { amountPaid: 512.4, total: 512.4 });
        const res = await refund(A, { orderId: String(o._id), amount: 512.4, reason: 'full' });
        expect(res.status).toBe(200);
        expect(gwCalls()).toHaveLength(1);
        expect(gwCalls()[0][0]).toBe(o.razorpayPaymentId);
        expect(gwCalls()[0][1].amount).toBe(51240);
        expect(await reload(o)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 512.4 });
    });

    test('a partial refund keeps the order Paid and records exactly one refunds[] row', async () => {
        stubGateway();
        const o = await paidOrder(A);
        expect((await refund(A, { orderId: String(o._id), amount: 120.5, reason: 'dish cold' })).status).toBe(200);
        const after = await reload(o);
        expect(after).toMatchObject({ paymentStatus: 'Paid', refundedAmount: 120.5 });
        expect(after.refunds).toHaveLength(1);
        expect(after.refunds[0]).toMatchObject({ amount: 120.5, reason: 'dish cold', source: 'admin' });
        expect(after.refunds[0].razorpayRefundId).toMatch(/^rfnd_/);
    });

    test.each([
        [19.99, 1999], [0.01, 1], [100.126, 10013], [33.333, 3333], [1234.56, 123456], [0.29, 29], [4.35, 435],
    ])('rupee %s goes to the gateway as %s paise (no float drift)', async (rupees, paise) => {
        stubGateway();
        const o = await paidOrder(A, { amountPaid: 2000, total: 2000 });
        const res = await refund(A, { orderId: String(o._id), amount: rupees, reason: 'r' });
        expect(res.status).toBe(200);
        expect(gwCalls()[0][1].amount).toBe(paise);
        expect(Number.isInteger(gwCalls()[0][1].amount)).toBe(true);
        expect((await reload(o)).refundedAmount).toBe(roundPaise(rupees));
    });

    test('512.40 paid: 100.10 then 412.30 lands on exactly Refunded (no 412.29999 remainder)', async () => {
        stubGateway();
        const o = await paidOrder(A, { amountPaid: 512.4, total: 512.4 });
        expect((await refund(A, { orderId: String(o._id), amount: 100.1, reason: 'a' })).status).toBe(200);
        expect((await refund(A, { orderId: String(o._id), amount: 412.3, reason: 'b' })).status).toBe(200);
        expect(await reload(o)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 512.4 });
        expect(gwPaise()).toBe(51240);
    });

    test('33.33 + 33.33 + 33.34 on a 100 order ends Refunded at exactly 100', async () => {
        stubGateway();
        const o = await paidOrder(A, { amountPaid: 100, total: 100 });
        for (const a of [33.33, 33.33, 33.34]) expect((await refund(A, { orderId: String(o._id), amount: a, reason: 'r' })).status).toBe(200);
        expect(await reload(o)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 100 });
    });

    test('0.1 + 0.2 style float input (0.30000000000000004) on a 0.30 order is accepted as 0.30', async () => {
        const o = await cashOrder(A, { amountPaid: 0.3, total: 0.3 });
        const res = await refund(A, { orderId: String(o._id), amount: 0.1 + 0.2, reason: 'r' });
        expect(res.status).toBe(200);
        expect(await reload(o)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 0.3 });
    });

    test('after a partial refund the ceiling shrinks: asking for 1 paisa more than the rest is refused', async () => {
        stubGateway();
        const o = await paidOrder(A);
        expect((await refund(A, { orderId: String(o._id), amount: 200, reason: 'a' })).status).toBe(200);
        const res = await refund(A, { orderId: String(o._id), amount: 300.01, reason: 'b' });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('300');
        expect((await reload(o)).refundedAmount).toBe(200);
        expect(gwCalls()).toHaveLength(1);
    });

    test('refunding the full amount twice: the second is refused and the gateway is called once', async () => {
        stubGateway();
        const o = await paidOrder(A);
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' })).status).toBe(200);
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' })).status).toBe(400);
        expect(gwCalls()).toHaveLength(1);
        expect((await reload(o)).refunds).toHaveLength(1);
    });

    test('the response reports the running refundedAmount and gateway id', async () => {
        stubGateway();
        const o = await paidOrder(A);
        const r1 = await refund(A, { orderId: String(o._id), amount: 100, reason: 'a' });
        const r2 = await refund(A, { orderId: String(o._id), amount: 50.5, reason: 'b' });
        expect(r1.body.refundedAmount).toBe(100);
        expect(r2.body.refundedAmount).toBe(150.5);
        expect(r1.body.razorpayRefundId).not.toBe(r2.body.razorpayRefundId);
    });

    test('roundPaise helper: float drift and junk inputs', () => {
        expect(roundPaise(512.4 - 100.1)).toBe(412.3);
        expect(roundPaise(undefined)).toBe(0);
        expect(roundPaise('abc')).toBe(0);
        expect(roundPaise(null)).toBe(0);
        expect(roundPaise(0.1 + 0.2)).toBe(0.3);
    });
});

// ═══ idempotency key ═════════════════════════════════════════════════
describe('Idempotency-Key replay', () => {
    test('the same key twice replays the first answer: one gateway call, one refunds[] row', async () => {
        stubGateway();
        const o = await paidOrder(A);
        const key = `key-${rid()}`;
        const r1 = await refund(A, { orderId: String(o._id), amount: 100, reason: 'a' }, A.users.admin, key);
        const r2 = await refund(A, { orderId: String(o._id), amount: 100, reason: 'a' }, A.users.admin, key);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r2.body.razorpayRefundId).toBe(r1.body.razorpayRefundId);
        expect(gwCalls()).toHaveLength(1);
        const after = await reload(o);
        expect(after.refundedAmount).toBe(100);
        expect(after.refunds).toHaveLength(1);
    });

    test('a wallet refund replayed with the same key credits the wallet once', async () => {
        const c = await customerWith(W, { balance: 10 });
        const o = await paidOrder(W, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        const key = `key-${rid()}`;
        for (let i = 0; i < 3; i += 1) {
            expect((await refund(W, { orderId: String(o._id), amount: 200, reason: 'a' }, W.users.admin, key)).status).toBe(200);
        }
        expect((await walletOf(W, c)).balance).toBe(210);
        expect(await Transaction.countDocuments({ order: o._id, type: 'refund' })).toBe(1);
    });

    test('a different key on the same amount is a NEW refund (and is bounded by the balance)', async () => {
        stubGateway();
        const o = await paidOrder(A);
        expect((await refund(A, { orderId: String(o._id), amount: 300, reason: 'a' }, A.users.admin, `key-${rid()}`)).status).toBe(200);
        expect((await refund(A, { orderId: String(o._id), amount: 300, reason: 'a' }, A.users.admin, `key-${rid()}`)).status).toBe(400);
        expect((await reload(o)).refundedAmount).toBe(300);
    });

    test("another admin cannot replay someone else's key to read their cached refund (scoped by caller)", async () => {
        stubGateway();
        const o1 = await paidOrder(A);
        const o2 = await paidOrder(A);
        const mgr = await createUser({ name: 'mgr', email: `mgr.${rid()}@staff.test`, role: 'manager', restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: true } });
        const key = `key-${rid()}`;
        const r1 = await refund(A, { orderId: String(o1._id), amount: 100, reason: 'a' }, A.users.admin, key);
        const r2 = await refund(A, { orderId: String(o2._id), amount: 100, reason: 'a' }, mgr, key);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r2.body.razorpayRefundId).not.toBe(r1.body.razorpayRefundId);
        expect((await reload(o2)).refundedAmount).toBe(100);
    });
});

// ═══ channels ════════════════════════════════════════════════════════
describe('refund channel: gateway / wallet / cash', () => {
    test('cash order: recorded for manual hand-back, no gateway, no wallet credit, ledger row for a registered user', async () => {
        stubGateway();
        const c = await customerWith(A, { balance: 5 });
        const o = await cashOrder(A, { user: c._id });
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'cash back' })).status).toBe(200);
        expect(gwCalls()).toHaveLength(0);
        expect((await walletOf(A, c)).balance).toBe(5);
        const rows = await Transaction.find({ order: o._id, type: 'refund' }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: 500, paymentMethod: 'cash', status: 'completed' });
    });

    test('guest cash order: refunded without a user ledger row and without error', async () => {
        const o = await cashOrder(A);
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'r' })).status).toBe(200);
        expect(await Transaction.countDocuments({ order: o._id })).toBe(0);
    });

    test("wallet-paid order: refund goes back to the wallet (not the gateway) exactly once with correct balances", async () => {
        const c = await customerWith(A, { balance: 40 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        stubGateway();
        expect((await refund(A, { orderId: String(o._id), amount: 150, reason: 'r' })).status).toBe(200);
        expect(gwCalls()).toHaveLength(0);
        expect((await walletOf(A, c)).balance).toBe(190);
        const rows = await Transaction.find({ order: o._id, type: 'refund' }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: 150, paymentMethod: 'wallet', balanceBefore: 40, balanceAfter: 190 });
    });

    test('legacy "Wallet" capitalised method is also treated as wallet-paid', async () => {
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'Wallet', razorpayPaymentId: undefined });
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'r' })).status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(500);
        expect(isWalletPaid({ paymentMethod: 'Wallet' })).toBe(true);
    });

    test('wallet partials add up: 150 + 350 credits 500 in total, ledger rows chain balanceBefore/After', async () => {
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        await refund(A, { orderId: String(o._id), amount: 150, reason: 'a' });
        await refund(A, { orderId: String(o._id), amount: 350, reason: 'b' });
        expect((await walletOf(A, c)).balance).toBe(500);
        const rows = (await Transaction.find({ order: o._id, type: 'refund' }).sort({ createdAt: 1 }).lean());
        expect(rows.map((r) => [r.balanceBefore, r.balanceAfter])).toEqual([[0, 150], [150, 500]]);
    });

    test("a wallet refund for a customer with no wallet doc creates one (upsert) at exactly the refund amount", async () => {
        const c = await createCustomer('nowallet');
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        expect((await refund(A, { orderId: String(o._id), amount: 77.77, reason: 'r' })).status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(77.77);
        expect(await Wallet.countDocuments({ user: c._id, restaurant: A.restaurant._id })).toBe(1);
    });

    test("in 'wallet' refund mode an online order is credited to the wallet, gateway untouched", async () => {
        stubGateway();
        const c = await customerWith(W, { balance: 0 });
        const o = await paidOrder(W, { user: c._id });
        expect((await refund(W, { orderId: String(o._id), amount: 500, reason: 'r' })).status).toBe(200);
        expect(gwCalls()).toHaveLength(0);
        expect((await walletOf(W, c)).balance).toBe(500);
    });

    // Expected: a guest (no wallet) online payment in wallet-refund mode either
    // refunds through the gateway or is refused - never silently "Refunded" with
    // nobody paid. Actual: refunds.js:111-122 skips the gateway (mode != original)
    // and walletRefund is false (no user), so the order flips to Refunded and
    // NO money moves anywhere. Real money lost for the customer.
    test('Regression (fixed 2026-11): guest online payment in wallet mode is not marked Refunded with no money moved', async () => {
        stubGateway();
        const o = await paidOrder(W); // guest, online, rzp id
        const res = await refund(W, { orderId: String(o._id), amount: 500, reason: 'guest refund' });
        const after = await reload(o);
        const moneyMoved = gwCalls().length > 0;
        expect(res.status >= 400 || moneyMoved).toBe(true);
        if (res.status >= 400) expect(after.paymentStatus).toBe('Paid');
    });

    test("online order without a stored payment id: 400, nothing recorded", async () => {
        stubGateway();
        const o = await paidOrder(A, { razorpayPaymentId: undefined });
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'r' })).status).toBe(400);
        await untouched(o);
    });

    // Expected: mixed order (₹100 wallet + ₹400 online) refunds the online leg
    // (40000 paise) through the gateway. Actual: paymentMethod 'mixed' matches
    // neither the 'online' branch nor wallet-paid (refunds.js:96,112), so no
    // gateway call happens, yet the order is marked Refunded: the customer's
    // card/UPI money is never returned.
    test('Regression (fixed 2026-11): a mixed (wallet + online) order refunds the online leg through the gateway', async () => {
        stubGateway();
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'mixed', walletAmountPaid: 100, amountPaid: 500 });
        const res = await refund(A, { orderId: String(o._id), amount: 500, reason: 'mixed' });
        expect(res.status).toBe(200);
        expect(gwPaise()).toBe(40000);
    });

    // Expected: the wallet leg (₹100) is credited back to the wallet.
    // Actual: no wallet credit for 'mixed' in original mode (isWalletPaid is false).
    test('Regression (fixed 2026-11): a mixed order credits its wallet leg back to the wallet', async () => {
        stubGateway();
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'mixed', walletAmountPaid: 100, amountPaid: 500 });
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'mixed' });
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test.each([
        ['online', 'upi'], ['upi', 'upi'], ['card', 'card'], ['wallet', 'wallet'], ['cash', 'cash'],
        ['points', 'points'], ['mixed', 'upi'], ['counter', 'cash'], ['Not selected', 'cash'], [undefined, 'cash'], ['CASH', 'cash'],
    ])('ledger payment method mapping %s -> %s', (m, expected) => {
        expect(ledgerPaymentMethod(m)).toBe(expected);
    });
});

// ═══ gateway failures / consistency ══════════════════════════════════
describe('gateway failure leaves a consistent state', () => {
    test('gateway down: 400, order/wallet/ledger untouched; a retry once it is up refunds exactly once', async () => {
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id });
        stubGateway({ fail: true });
        const bad = await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' });
        expect(bad.status).toBe(400);
        expect((await reload(o)).refundedAmount).toBe(0);
        expect(await Transaction.countDocuments({ order: o._id, type: 'refund' })).toBe(0);
        rzp.reset(); stubGateway();
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' })).status).toBe(200);
        expect(gwCalls()).toHaveLength(1);
        expect(await Transaction.countDocuments({ order: o._id, type: 'refund' })).toBe(1);
    });

    test('a gateway failure is not cached by the idempotency key: the retry with the SAME key goes through', async () => {
        const o = await paidOrder(A);
        const key = `key-${rid()}`;
        stubGateway({ fail: true });
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' }, A.users.admin, key)).status).toBe(400);
        rzp.reset(); stubGateway();
        expect((await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' }, A.users.admin, key)).status).toBe(200);
        expect((await reload(o)).paymentStatus).toBe('Refunded');
    });

    // Expected: if the gateway already returned the money and the bookkeeping
    // transaction then fails, the order must still show what was refunded (or the
    // refund must be reversible) - otherwise a retry refunds the customer twice.
    // Actual: refunds.js:131-199 runs the DB writes after the irreversible
    // gateway call; when the transaction aborts the order shows refundedAmount 0
    // and no razorpayRefundId, so the money is gone with no trace and a retry
    // refunds AGAIN.
    test('Regression (fixed 2026-11): gateway refund succeeded but ledger write failed -> order still records the refund', async () => {
        stubGateway();
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id });
        const spy = jest.spyOn(Transaction, 'create').mockRejectedValueOnce(new Error('ledger down'));
        let res;
        try { res = await refund(A, { orderId: String(o._id), amount: 500, reason: 'a' }); } finally { spy.mockRestore(); }
        expect(gwPaise()).toBe(50000);                    // the customer WAS paid back at the gateway
        const after = await reload(o);
        expect(after.refundedAmount).toBe(500);           // ... so the books must say so
        expect(res.status).toBeLessThan(500);
    });

    test('a failed bookkeeping transaction rolls the wallet credit back together with the order write', async () => {
        const c = await customerWith(A, { balance: 25 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        const spy = jest.spyOn(Transaction, 'create').mockRejectedValueOnce(new Error('ledger down'));
        try { await refund(A, { orderId: String(o._id), amount: 100, reason: 'a' }); } finally { spy.mockRestore(); }
        expect((await walletOf(A, c)).balance).toBe(25);
        expect((await reload(o)).refundedAmount).toBe(0);
    });
});

// ═══ concurrency ═════════════════════════════════════════════════════
describe('concurrent refunds', () => {
    // Expected: two simultaneous 300 refunds on a 500 online payment hit the gateway
    // for at most 500 in total. Actual: both pass the balance check on a stale read
    // and BOTH call payments.refund (refunds.js:96-110) before the DB transaction
    // lets only one win; the loser answers 500 but the gateway already refunded
    // 600 on a 500 payment.
    test('Regression (fixed 2026-11): two concurrent 300 refunds on a 500 online payment never refund more than 500 at the gateway', async () => {
        stubGateway({ delay: 80 });
        const o = await paidOrder(A);
        const rs = await Promise.all([
            refund(A, { orderId: String(o._id), amount: 300, reason: 'a' }),
            refund(A, { orderId: String(o._id), amount: 300, reason: 'b' }),
        ]);
        expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
        expect(gwPaise()).toBeLessThanOrEqual(50000);
    });

    test('five concurrent 100 cash refunds: books stay self-consistent (refundedAmount = sum(refunds[]) = 100 x successes <= paid)', async () => {
        const c = await customerWith(A, { balance: 0 });
        const o = await cashOrder(A, { user: c._id });
        const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => refund(A, { orderId: String(o._id), amount: 100, reason: `r${i}` })));
        const ok = rs.filter((r) => r.status === 200).length;
        const after = await reload(o);
        expect(ok).toBeGreaterThanOrEqual(1);
        expect(after.refundedAmount).toBeLessThanOrEqual(500);
        expect(after.refundedAmount).toBe(100 * ok);
        expect(after.refunds.reduce((s, r) => s + r.amount, 0)).toBe(after.refundedAmount);
        expect(await Transaction.countDocuments({ order: o._id, type: 'refund' })).toBe(ok);
    });

    test('five concurrent 100 wallet refunds credit the wallet exactly 100 x successes', async () => {
        const c = await customerWith(A, { balance: 0 });
        const o = await paidOrder(A, { user: c._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });
        const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => refund(A, { orderId: String(o._id), amount: 100, reason: `r${i}` })));
        const ok = rs.filter((r) => r.status === 200).length;
        expect(ok).toBeGreaterThanOrEqual(1);
        expect((await walletOf(A, c)).balance).toBe(100 * ok);
        expect((await reload(o)).refundedAmount).toBe(100 * ok);
    });

    test('concurrent refunds for the full amount with the SAME idempotency key give one refund', async () => {
        stubGateway({ delay: 60 });
        const o = await paidOrder(A);
        const key = `key-${rid()}`;
        const rs = await Promise.all([1, 2, 3].map(() => refund(A, { orderId: String(o._id), amount: 500, reason: 'a' }, A.users.admin, key)));
        expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
        expect(gwCalls()).toHaveLength(1);
        expect((await reload(o)).refundedAmount).toBe(500);
    });
});

// ═══ loyalty / tips ══════════════════════════════════════════════════
describe('loyalty points clawback', () => {
    const earnedRow = (t, o, user, amount) => Transaction.create({
        user: user._id, restaurant: t.restaurant._id, order: o._id, type: 'points_earned', amount,
        paymentMethod: 'points', status: 'completed', description: 'earned', transactionId: `T-${rid()}`,
    });

    test('claws back from the points_earned ledger row (not the earn rule), proportionally', async () => {
        const c = await customerWith(A, { loyaltyPoints: 100 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 40);
        await refund(A, { orderId: String(o._id), amount: 250, reason: 'half' });
        expect((await walletOf(A, c)).loyaltyPoints).toBe(80);
    });

    test('a full refund claws back exactly what the order earned, not a point more', async () => {
        const c = await customerWith(A, { loyaltyPoints: 100 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 40);
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'full' });
        expect((await walletOf(A, c)).loyaltyPoints).toBe(60);
    });

    // Expected: after two halves summing to the full refund, all 7 earned points
    // are gone. Actual: floor(7*0.5)=3 twice -> 6 clawed; 1 point stays forever on
    // a fully refunded order (orderRefund.js loyaltyPointsToClawBack floors each
    // refund independently with no running total).
    test('Regression (fixed 2026-11): two partial refunds that fully refund an order claw back ALL earned points', async () => {
        const c = await customerWith(A, { loyaltyPoints: 7 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 7);
        await refund(A, { orderId: String(o._id), amount: 250, reason: 'a' });
        await refund(A, { orderId: String(o._id), amount: 250, reason: 'b' });
        expect((await reload(o)).paymentStatus).toBe('Refunded');
        expect((await walletOf(A, c)).loyaltyPoints).toBe(0);
    });

    test('points already spent are not driven negative', async () => {
        const c = await customerWith(A, { loyaltyPoints: 5 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 40);
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'full' });
        expect((await walletOf(A, c)).loyaltyPoints).toBe(5);
    });

    test('a guest order refund touches no wallet', async () => {
        const before = await Wallet.countDocuments({ restaurant: A.restaurant._id });
        const o = await cashOrder(A);
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'full' });
        expect(await Wallet.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('loyaltyPointsToClawBack: refund bigger than base cannot claw back more than earned', async () => {
        const c = await customerWith(A, { loyaltyPoints: 100 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 10);
        const n = await loyaltyPointsToClawBack(await Order.findById(o._id), 99999, { enableLoyalty: true, minBillToEarn: 0, pointsPerRupee: 1 });
        expect(n).toBe(10);
    });

    test('loyaltyPointsToClawBack: legacy order with no ledger row and loyalty disabled claws back nothing', async () => {
        const c = await customerWith(A, { loyaltyPoints: 100 });
        const o = await cashOrder(A, { user: c._id });
        const n = await loyaltyPointsToClawBack(await Order.findById(o._id), 500, { enableLoyalty: false, minBillToEarn: 0, pointsPerRupee: 1 });
        expect(n).toBe(0);
    });

    // Expected: the loyalty ledger (Transaction rows) shows the points reversal, so
    // wallet history reconciles. Actual: the wallet's loyaltyPoints is decremented
    // silently; no points_* Transaction row is written (refunds.js:157-166).
    test('Regression (fixed 2026-11): a loyalty clawback leaves a ledger row so points history reconciles', async () => {
        const c = await customerWith(A, { loyaltyPoints: 40 });
        const o = await cashOrder(A, { user: c._id });
        await earnedRow(A, o, c, 40);
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'full' });
        const rows = await Transaction.find({ order: o._id, type: { $in: ['points_redeemed', 'points_reversed'] } }).lean();
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });
});

// ═══ roles / permissions ═════════════════════════════════════════════
describe('who may refund', () => {
    test.each(['waiter', 'captain', 'chef'])('a %s is refused (403) and nothing moves', async (role) => {
        stubGateway();
        const o = await cashOrder(A);
        const res = await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, A.users[role]);
        expect(res.status).toBe(403);
        await untouched(o);
    });

    test('a waiter explicitly granted the refund permission is still refused (admin/manager only)', async () => {
        const o = await cashOrder(A);
        const w = await createUser({ name: 'w+', email: `w.${rid()}@staff.test`, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: true } });
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, w)).status).toBe(403);
        expect((await reload(o)).refundedAmount).toBe(0);
    });

    test('a captain granted the refund permission is still refused', async () => {
        const o = await cashOrder(A);
        const cap = await createUser({ name: 'c+', email: `c.${rid()}@staff.test`, role: 'captain', restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: true } });
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, cap)).status).toBe(403);
    });

    test('a manager WITH the refund permission may; WITHOUT it may not', async () => {
        const o = await cashOrder(A);
        const yes = await createUser({ name: 'm1', email: `m1.${rid()}@staff.test`, role: 'manager', restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: true } });
        const no = await createUser({ name: 'm2', email: `m2.${rid()}@staff.test`, role: 'manager', restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: false } });
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, no)).status).toBe(403);
        expect((await reload(o)).refundedAmount).toBe(0);
        expect((await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, yes)).status).toBe(200);
    });

    test('an anonymous caller gets 401 and a customer 403', async () => {
        const o = await cashOrder(A);
        const c = await createCustomer('rf');
        expect((await ctx.api.guest(A).post('/razorpay/refund').send({ orderId: String(o._id), amount: 10 })).status).toBe(401);
        expect((await ctx.api.as(c, A).post('/razorpay/refund').send({ orderId: String(o._id), amount: 10 })).status).toBe(403);
        expect((await reload(o)).refundedAmount).toBe(0);
    });

    // Expected: a branch-pinned admin (Branch 2) cannot refund an order of Branch 1
    // (the refund-request approve route enforces this with strictBranchFilter).
    // Actual: refundPayment only applies tenantFilter, so any branch admin can
    // refund any branch's order directly.
    test("Regression (fixed 2026-11): a branch-pinned admin cannot refund another branch's order", async () => {
        stubGateway();
        const b2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: `s-${rid()}`, isActive: true });
        const pinned = await createUser({ name: 'pinned', email: `pin.${rid()}@staff.test`, role: 'admin', restaurant: A.restaurant._id, branch: b2._id, permissions: {} });
        const o = await cashOrder(A); // branch 1
        const res = await refund(A, { orderId: String(o._id), amount: 100, reason: 'x' }, pinned);
        expect([403, 404]).toContain(res.status);
        expect((await reload(o)).refundedAmount).toBe(0);
    });
});

// ═══ audit trail ═════════════════════════════════════════════════════
describe('audit trail', () => {
    const auditFor = async (o) => {
        for (let i = 0; i < 20; i += 1) {
            const rows = await TenantAudit.find({ restaurant: o.restaurant, action: 'order.refund', entityId: o.orderId }).lean();
            if (rows.length) return rows;
            await settle(60);
        }
        return [];
    };

    test('refunds[] carries actor id, actor name, reason, source and timestamp', async () => {
        const o = await cashOrder(A);
        await refund(A, { orderId: String(o._id), amount: 100, reason: 'spilled' });
        const r = (await reload(o)).refunds[0];
        expect(String(r.actor)).toBe(String(A.users.admin._id));
        expect(r.actorName).toBe(A.users.admin.name);
        expect(r.reason).toBe('spilled');
        expect(r.source).toBe('admin');
        expect(r.createdAt).toBeInstanceOf(Date);
    });

    test('a tenant audit row order.refund is written with actor, amount, mode and reason', async () => {
        const o = await cashOrder(A);
        await refund(A, { orderId: String(o._id), amount: 120, reason: 'stale' });
        const rows = await auditFor(o);
        expect(rows).toHaveLength(1);
        expect(String(rows[0].actor.id)).toBe(String(A.users.admin._id));
        expect(rows[0].after).toMatchObject({ amount: 120, reason: 'stale' });
        expect(rows[0].summary).toContain(o.orderId);
    });

    // Expected: the audit "before" state records the pre-refund payment status
    // ('Paid') so the change is reconstructable. Actual: the controller never
    // passes beforeStatus (refunds.js auditRefund call) so before.paymentStatus is null.
    test('Regression (fixed 2026-11): the refund audit row records the status BEFORE the refund', async () => {
        const o = await cashOrder(A);
        await refund(A, { orderId: String(o._id), amount: 500, reason: 'full' });
        const rows = await auditFor(o);
        expect(rows[0].before.paymentStatus).toBe('Paid');
    });

    test('a refused refund (over limit) writes no audit row and no refunds[] entry', async () => {
        const o = await cashOrder(A);
        await refund(A, { orderId: String(o._id), amount: 9999, reason: 'x' });
        await settle(200);
        expect(await TenantAudit.countDocuments({ action: 'order.refund', entityId: o.orderId })).toBe(0);
    });
});
