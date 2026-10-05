/**
 * Wallet recharge via Razorpay — controllers/razorpayController.js
 * (createWalletRechargeOrder, verifyWalletRecharge) +
 * utils/paymentChecks.checkWalletRechargePayment.
 *
 * Gap suite. securityRegressions.test.js (#3) already pins: forged HMAC,
 * gateway outage, uncaptured payment, another user's payment, crediting
 * the gateway amount (not the body) and sequential replay. This file adds:
 *
 *   - create: notes binding (tenant + user), paise, receipt length,
 *     amount bounds, auth, gateway failure
 *   - verify: cross-tenant recharge, non-recharge payments presented as a
 *     recharge, over-limit / foreign currency, payment already spent on an
 *     order, exact paise credit, balance drift, ledger row, per-tenant
 *     wallets, concurrent verifies, Idempotency-Key replay
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));

const ctx = useIntegrationApp();
let A;
let B;

const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'wr-a' });
    B = await seedTenant({ label: 'wr-b' });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Stub one recharge checkout at the gateway; notes default to a valid recharge for `cust` in `t`. */
function recharge(cust, t, { amount = 50000, notes, currency = 'INR', status = 'captured' } = {}) {
    const paymentId = `pay_${rid()}`;
    const orderId = `order_${rid()}`;
    const n = notes !== undefined ? notes : {
        purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(t.restaurant._id),
    };
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: orderId, amount, currency, status, notes: {},
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: orderId, entity: 'order', amount, notes: n });
    return {
        paymentId,
        orderId,
        body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig(orderId, paymentId) },
    };
}

const create = (client, body) => client.post('/razorpay/create-wallet-recharge').send(body);
const verify = (cust, t, body, headers = {}) => {
    let r = ctx.api.as(cust, t).post('/razorpay/verify-wallet-recharge');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
};
const balanceOf = async (t, cust) => (await Wallet.findOne({ user: cust._id, restaurant: t.restaurant._id }).lean())?.balance;

// ── create-wallet-recharge ───────────────────────────────────────────

describe('POST /razorpay/create-wallet-recharge', () => {
    beforeEach(() => {
        rzp.instance.orders.create.mockImplementation(async (o) => ({
            id: `order_${rid()}`, entity: 'order', amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes,
        }));
    });

    test('binds the checkout to the customer and tenant, in paise, with a short receipt', async () => {
        const cust = await createCustomer('wr-create');

        const res = await create(ctx.api.as(cust, A), { amount: 512.4 });

        expect(res.status).toBe(200);
        expect(res.body.razorpayOrder).toMatchObject({ amount: 51240, currency: 'INR' });
        expect(res.body.key).toBe(process.env.RAZORPAY_KEY_ID);
        const opts = rzp.instance.orders.create.mock.calls[0][0];
        expect(opts.notes).toEqual({
            purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id),
        });
        expect(opts.receipt.length).toBeLessThanOrEqual(40);
        expect(opts.receipt.startsWith(`wrc_${String(cust._id).slice(-6)}_`)).toBe(true);
    });

    test.each([
        [10000, 200],
        [10000.01, 400],
        [0, 400],
        [-1, 400],
        ['500', 400],
        [null, 400],
    ])('an amount of %p answers %i', async (amount, status) => {
        const cust = await createCustomer('wr-bounds');
        const res = await create(ctx.api.as(cust, A), { amount });
        expect(res.status).toBe(status);
        if (status === 400) expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    // Regression (fixed 2026-10): create-wallet-recharge enforces the ₹1 floor.
    test('an amount below ₹1 is refused before the gateway', async () => {
        const cust = await createCustomer('wr-min');
        const res = await create(ctx.api.as(cust, A), { amount: 0.5 });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('a guest cannot open a recharge', async () => {
        const res = await create(ctx.api.guest(A), { amount: 100 });
        expect(res.status).toBe(401);
    });

    test('a gateway failure answers 500', async () => {
        rzp.instance.orders.create.mockRejectedValue(Object.assign(new Error('auth'), { statusCode: 401 }));
        const cust = await createCustomer('wr-down');
        const res = await create(ctx.api.as(cust, A), { amount: 100 });
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
    });
});

// ── verify-wallet-recharge ───────────────────────────────────────────

describe('POST /razorpay/verify-wallet-recharge', () => {
    test('credits exactly the captured paise and writes one ledger row', async () => {
        const cust = await createCustomer('wr-ok');
        const r = recharge(cust, A, { amount: 51240 });

        const res = await verify(cust, A, r.body);

        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(512.4);
        const wallet = await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean();
        expect(wallet.balance).toBe(512.4);
        const rows = await Transaction.find({ razorpayPaymentId: r.paymentId }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            type: 'wallet_recharge', amount: 512.4, balanceBefore: 0, balanceAfter: 512.4, razorpayOrderId: r.orderId,
        });
        expect(String(rows[0].restaurant)).toBe(String(A.restaurant._id));
        expect(await PaymentClaim.findOne({ paymentId: r.paymentId }).lean()).toMatchObject({ purpose: 'wallet_recharge', amount: 512.4 });
    });

    test("a recharge in tenant A does not touch the same customer's tenant B wallet", async () => {
        const cust = await createCustomer('wr-split');
        await setWallet(B, cust, { balance: 70 });
        const r = recharge(cust, A, { amount: 10000 });

        expect((await verify(cust, A, r.body)).status).toBe(200);

        expect(await balanceOf(A, cust)).toBe(100);
        expect(await balanceOf(B, cust)).toBe(70);
    });

    test('a recharge started in tenant A cannot be credited through tenant B', async () => {
        const cust = await createCustomer('wr-cross');
        const r = recharge(cust, A);

        const res = await verify(cust, B, r.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_MISMATCH');
        expect(await balanceOf(B, cust)).toBeUndefined();
        expect(await PaymentClaim.countDocuments({ paymentId: r.paymentId })).toBe(0);
    });

    test.each([
        ['a food-order checkout', (c, t) => ({ cafeOrderId: 'none', purpose: 'cafe_order', restaurantId: String(t.restaurant._id), userId: String(c._id) })],
        ['a checkout with no purpose', (c, t) => ({ userId: String(c._id), restaurantId: String(t.restaurant._id) })],
        ['a plan payment', (c, t) => ({ type: 'plan_payment', restaurantId: String(t.restaurant._id) })],
    ])('%s cannot be turned into wallet money', async (_label, makeNotes) => {
        const cust = await createCustomer('wr-purpose');
        const r = recharge(cust, A, { notes: makeNotes(cust, A) });

        const res = await verify(cust, A, r.body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_A_RECHARGE');
        expect(await balanceOf(A, cust)).toBeUndefined();
    });

    test.each([
        ['above the ₹10,000 limit', { amount: 1000001 }, 'RECHARGE_AMOUNT_INVALID'],
        ['in a foreign currency', { currency: 'USD' }, 'PAYMENT_CURRENCY_MISMATCH'],
        ['only authorised-then-failed', { status: 'failed' }, 'PAYMENT_NOT_CAPTURED'],
    ])('a payment %s is refused', async (_label, opts, code) => {
        const cust = await createCustomer('wr-limit');
        const r = recharge(cust, A, opts);

        const res = await verify(cust, A, r.body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect(await balanceOf(A, cust)).toBeUndefined();
    });

    test('exactly ₹10,000 is credited', async () => {
        const cust = await createCustomer('wr-max');
        const r = recharge(cust, A, { amount: 1000000 });

        expect((await verify(cust, A, r.body)).status).toBe(200);
        expect(await balanceOf(A, cust)).toBe(10000);
    });

    test('a payment already spent on an order cannot also be credited', async () => {
        const cust = await createCustomer('wr-spent');
        const r = recharge(cust, A);
        await PaymentClaim.create({ paymentId: r.paymentId, purpose: 'order_payment', ref: 'some-order' });

        const res = await verify(cust, A, r.body);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect(await balanceOf(A, cust)).toBeUndefined();
    });

    test('recharging an existing balance keeps it to the paisa (post-update rounding hook)', async () => {
        const cust = await createCustomer('wr-drift');
        await setWallet(A, cust, { balance: 100.1 });
        const r = recharge(cust, A, { amount: 20020 });

        const res = await verify(cust, A, r.body);

        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(300.3);
        expect(await balanceOf(A, cust)).toBe(300.3);
    });

    // Regression (fixed 2026-10): models/wallet.js rounds atomically in the DB instead of saving a stale absolute balance.
    test('simultaneous recharges with paise amounts are all credited', async () => {
        const notesFor = (cust) => ({ purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id) });
        const payments = new Map();
        rzp.instance.payments.fetch.mockImplementation(async (id) => ({
            id, entity: 'payment', order_id: payments.get(id).orderId, amount: 20, currency: 'INR', status: 'captured', notes: {},
        }));
        rzp.instance.orders.fetch.mockImplementation(async (id) => {
            const p = [...payments.values()].find((v) => v.orderId === id);
            return { id, entity: 'order', amount: 20, notes: p.notes };
        });

        const finals = [];
        for (let round = 0; round < 5; round++) {
            const cust = await createCustomer(`wr-lost-${round}`);
            await setWallet(A, cust, { balance: 0.1 });
            const bodies = Array.from({ length: 10 }, () => {
                const paymentId = `pay_${rid()}`;
                const orderId = `order_${rid()}`;
                payments.set(paymentId, { orderId, notes: notesFor(cust) });
                return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig(orderId, paymentId) };
            });
            const results = await Promise.all(bodies.map((body) => verify(cust, A, body)));
            results.forEach((res) => expect(res.status).toBe(200));
            await settle();
            finals.push(await balanceOf(A, cust));
        }

        expect(finals).toEqual([2.1, 2.1, 2.1, 2.1, 2.1]);
    });

    test('three simultaneous verifies of one payment credit it once', async () => {
        const cust = await createCustomer('wr-race');
        const r = recharge(cust, A, { amount: 25000 });

        const results = await Promise.all([1, 2, 3].map(() => verify(cust, A, r.body)));

        results.forEach((res) => expect(res.status).toBe(200));
        expect(results.filter((res) => !res.body.alreadyCredited)).toHaveLength(1);
        await settle();
        expect(await balanceOf(A, cust)).toBe(250);
        expect(await Transaction.countDocuments({ razorpayPaymentId: r.paymentId })).toBe(1);
    });

    test('an Idempotency-Key replay returns the cached answer without asking the gateway again', async () => {
        const cust = await createCustomer('wr-idem');
        const r = recharge(cust, A, { amount: 30000 });
        const headers = { 'Idempotency-Key': `wr_${rid()}` };

        const first = await verify(cust, A, r.body, headers);
        await settle();
        const second = await verify(cust, A, r.body, headers);

        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(second.body).toEqual(first.body);
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(1);
        expect(await balanceOf(A, cust)).toBe(300);
    });

    test('a guest cannot verify a recharge', async () => {
        const cust = await createCustomer('wr-guest');
        const r = recharge(cust, A);
        const res = await ctx.api.guest(A).post('/razorpay/verify-wallet-recharge').send(r.body);
        expect(res.status).toBe(401);
    });
});
