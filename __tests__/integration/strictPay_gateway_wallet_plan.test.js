/**
 * STRICT payments campaign: gateway-funded wallet recharge, SaaS plan
 * payments (verify + webhook) and the pure paymentChecks rules.
 *
 *   controllers/razorpay/wallet.js, controllers/tenantBillingController.js
 *   (verifyUpgradePayment), utils/planPaymentApply.js, utils/paymentChecks.js
 *
 * Razorpay is mocked. "BUG:" tests pin real defects and are EXPECTED TO FAIL
 * until the source is fixed (expected vs actual in the comment above each).
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const { settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const Order = require(path.join(BACKEND, 'models/order'));
const { priceWithGst } = require(path.join(BACKEND, 'utils/billingCycles'));
const checks = require(path.join(BACKEND, 'utils/paymentChecks'));

const ctx = useIntegrationApp();
let A;
let B;

const rid = () => crypto.randomBytes(5).toString('hex');
const KEY = () => process.env.RAZORPAY_KEY_SECRET;
const sig = (o, p, secret = KEY()) => crypto.createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');
const whSign = (raw) => crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
    A = await seedTenant({ label: 'pgwp-a' });
    B = await seedTenant({ label: 'pgwp-b' });
});

// ═══ wallet recharge: create ═════════════════════════════════════════
describe('create-wallet-recharge', () => {
    beforeEach(() => {
        rzp.instance.orders.create.mockImplementation(async (o) => ({ id: `order_${rid()}`, amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes }));
    });
    const create = (api, body) => api.post('/razorpay/create-wallet-recharge').send(body);

    test('requires authentication', async () => {
        const res = await create(ctx.api.guest(A), { amount: 100 });
        expect([401, 403]).toContain(res.status);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test.each([
        ['string', '500'], ['null', null], ['object', { $gt: 0 }], ['array', [10]], ['zero', 0], ['negative', -1],
        ['0.5', 0.5], ['10,001', 10001], ['1e9', 1e9], ['missing', undefined],
    ])('amount %s is refused before the gateway', async (_l, amount) => {
        const cust = await createCustomer('pgwp-wc1');
        const res = await create(ctx.api.as(cust, A), { amount });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('₹1 and ₹10,000 are the accepted bounds; amount goes to the gateway in paise, INR only', async () => {
        const cust = await createCustomer('pgwp-wc2');
        const lo = await create(ctx.api.as(cust, A), { amount: 1 });
        const hi = await create(ctx.api.as(cust, A), { amount: 10000 });
        expect(lo.status).toBe(200); expect(hi.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0]).toMatchObject({ amount: 100, currency: 'INR' });
        expect(rzp.instance.orders.create.mock.calls[1][0].amount).toBe(1000000);
    });

    test('client cannot choose currency, purpose, user or tenant: notes are server-stamped', async () => {
        const cust = await createCustomer('pgwp-wc3');
        await create(ctx.api.as(cust, A), {
            amount: 100, currency: 'USD', purpose: 'cafe_order', userId: 'x', restaurantId: String(B.restaurant._id),
            notes: { purpose: 'cafe_order', userId: 'x', restaurantId: String(B.restaurant._id) },
        });
        const o = rzp.instance.orders.create.mock.calls[0][0];
        expect(o.currency).toBe('INR');
        expect(o.notes).toEqual({ purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id) });
        expect(o.receipt.length).toBeLessThanOrEqual(40);
    });

    test('gateway failure → generic 500 without gateway internals', async () => {
        rzp.instance.orders.create.mockRejectedValue(Object.assign(new Error('ECONNRESET internal-host:443'), { statusCode: 502, error: { description: 'key rzp_live_zzz bad' } }));
        const cust = await createCustomer('pgwp-wc4');
        const res = await create(ctx.api.as(cust, A), { amount: 100 });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/ECONNRESET|rzp_live|internal-host/);
    });

    test('creating a recharge order never touches the wallet balance', async () => {
        const cust = await createCustomer('pgwp-wc5');
        await create(ctx.api.as(cust, A), { amount: 500 });
        expect(await Wallet.countDocuments({ user: cust._id })).toBe(0);
    });
});

// ═══ wallet recharge: verify ═════════════════════════════════════════
describe('verify-wallet-recharge', () => {
    const verify = (api, body, key = `k-${rid()}`) => api.post('/razorpay/verify-wallet-recharge').set('Idempotency-Key', key).send(body);
    const bal = async (cust, t = A) => (await Wallet.findOne({ user: cust._id, restaurant: t.restaurant._id }).lean())?.balance || 0;

    function recharge(cust, { amount = 50000, t = A, status = 'captured', currency = 'INR', notes, orderNotes, payOrderId } = {}) {
        const rzpOrderId = `order_${rid()}`;
        const paymentId = `pay_${rid()}`;
        const n = notes || { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(t.restaurant._id) };
        rzp.instance.payments.fetch.mockResolvedValue({ id: paymentId, order_id: payOrderId || rzpOrderId, status, amount, currency, notes: n });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, notes: orderNotes || n });
        return { rzpOrderId, paymentId, body: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) } };
    }

    test('credits exactly what the gateway captured, ignoring a client-supplied amount; writes one transaction + claim', async () => {
        const cust = await createCustomer('pgwp-v1');
        const r = recharge(cust, { amount: 25050 });
        const res = await verify(ctx.api.as(cust, A), { ...r.body, amount: 9999 });
        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(250.5);
        expect(await bal(cust)).toBe(250.5);
        expect(await Transaction.countDocuments({ razorpayPaymentId: r.paymentId })).toBe(1);
        expect(await PaymentClaim.countDocuments({ paymentId: r.paymentId, purpose: 'wallet_recharge' })).toBe(1);
    });

    test.each([['razorpay_order_id'], ['razorpay_payment_id'], ['razorpay_signature']])('missing %s → 400, no credit', async (f) => {
        const cust = await createCustomer('pgwp-v2');
        const r = recharge(cust);
        const body = { ...r.body }; delete body[f];
        const res = await verify(ctx.api.as(cust, A), body);
        expect(res.status).toBe(400);
        expect(await bal(cust)).toBe(0);
    });

    test.each([
        ['tampered', (s) => s.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))],
        ['truncated', (s) => s.slice(0, 20)],
        ['upper-case', (s) => s.toUpperCase()],
        ['wrong secret', () => 'x'],
    ])('%s signature → 400, gateway never asked, no credit', async (l, f) => {
        const cust = await createCustomer('pgwp-v3');
        const r = recharge(cust);
        const bad = l === 'wrong secret' ? sig(r.rzpOrderId, r.paymentId, 'other-secret') : f(r.body.razorpay_signature);
        const res = await verify(ctx.api.as(cust, A), { ...r.body, razorpay_signature: bad });
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect(await bal(cust)).toBe(0);
    });

    test('requires login', async () => {
        const cust = await createCustomer('pgwp-v4');
        const r = recharge(cust);
        const res = await verify(ctx.api.guest(A), r.body);
        expect([401, 403]).toContain(res.status);
    });

    test('replay of the same payment (new idempotency key) is "alreadyCredited" and the balance does not move', async () => {
        const cust = await createCustomer('pgwp-v5');
        const r = recharge(cust, { amount: 10000 });
        await verify(ctx.api.as(cust, A), r.body);
        const again = await verify(ctx.api.as(cust, A), r.body);
        expect(again.status).toBe(200);
        expect(again.body.alreadyCredited).toBe(true);
        expect(await bal(cust)).toBe(100);
        expect(await Transaction.countDocuments({ razorpayPaymentId: r.paymentId })).toBe(1);
    });

    test('same idempotency key replays the cached answer without calling the gateway again', async () => {
        const cust = await createCustomer('pgwp-v6');
        const r = recharge(cust);
        const key = `k-${rid()}`;
        await verify(ctx.api.as(cust, A), r.body, key);
        await verify(ctx.api.as(cust, A), r.body, key);
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(1);
        expect(await bal(cust)).toBe(500);
    });

    test('6 parallel verifies of one payment credit once', async () => {
        const cust = await createCustomer('pgwp-v7');
        const r = recharge(cust, { amount: 30000 });
        const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => verify(ctx.api.as(cust, A), r.body)));
        expect(rs.every((x) => x.status === 200)).toBe(true);
        expect(await bal(cust)).toBe(300);
        expect(await Transaction.countDocuments({ razorpayPaymentId: r.paymentId })).toBe(1);
    });

    test('another user cannot claim the payer\'s recharge (403 RECHARGE_USER_MISMATCH), and the owner still can', async () => {
        const owner = await createCustomer('pgwp-v8a');
        const thief = await createCustomer('pgwp-v8b');
        const r = recharge(owner, { amount: 20000 });
        const res = await verify(ctx.api.as(thief, A), r.body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('RECHARGE_USER_MISMATCH');
        expect(await bal(thief)).toBe(0);
        expect((await verify(ctx.api.as(owner, A), r.body)).status).toBe(200);
        expect(await bal(owner)).toBe(200);
    });

    test('a cafe-order checkout cannot be redeemed as a wallet recharge (NOT_A_RECHARGE)', async () => {
        const cust = await createCustomer('pgwp-v9');
        const r = recharge(cust, { notes: { purpose: 'cafe_order', userId: String(cust._id), restaurantId: String(A.restaurant._id) } });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_A_RECHARGE');
        expect(await bal(cust)).toBe(0);
    });

    test('purpose is read from the SERVER-set order notes, not payment-level notes the browser can influence', async () => {
        const cust = await createCustomer('pgwp-v10');
        const r = recharge(cust, {
            notes: { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id) },
            orderNotes: { purpose: 'cafe_order', restaurantId: String(A.restaurant._id) },
        });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(await bal(cust)).toBe(0);
    });

    test('recharge stamped for tenant B cannot be credited on tenant A (403 TENANT_MISMATCH)', async () => {
        const cust = await createCustomer('pgwp-v11');
        const r = recharge(cust, { t: B });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(403);
        expect(await bal(cust, A)).toBe(0);
        expect(await bal(cust, B)).toBe(0);
    });

    test('wallet balances are per tenant: crediting A leaves B at zero', async () => {
        const cust = await createCustomer('pgwp-v12');
        const r = recharge(cust, { amount: 10000 });
        await verify(ctx.api.as(cust, A), r.body);
        expect(await bal(cust, A)).toBe(100);
        expect(await bal(cust, B)).toBe(0);
    });

    test('captured amount above the ₹10,000 recharge cap is refused (RECHARGE_AMOUNT_INVALID)', async () => {
        const cust = await createCustomer('pgwp-v13');
        const r = recharge(cust, { amount: 1000100 });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RECHARGE_AMOUNT_INVALID');
        expect(await bal(cust)).toBe(0);
    });

    test('currency mismatch (USD) is refused', async () => {
        const cust = await createCustomer('pgwp-v14');
        const r = recharge(cust, { currency: 'USD' });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_CURRENCY_MISMATCH');
        expect(await bal(cust)).toBe(0);
    });

    test.each([['created'], ['failed'], ['refunded']])('payment "%s" credits nothing', async (status) => {
        const cust = await createCustomer('pgwp-v15');
        const r = recharge(cust, { status });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(await bal(cust)).toBe(0);
    });

    // EXPECTED: wallet money is only credited for a CAPTURED payment (as verifyUpgradePayment
    // requires). ACTUAL: paymentChecks.SETTLED_PAYMENT_STATES includes 'authorized', so a mere
    // authorization credits spendable wallet balance; if it is never captured Razorpay voids it
    // and the customer keeps free wallet money.
    test('BUG: an authorized-only (uncaptured) payment must not credit the wallet', async () => {
        const cust = await createCustomer('pgwp-v16');
        const r = recharge(cust, { status: 'authorized' });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).not.toBe(200);
        expect(await bal(cust)).toBe(0);
    });

    test.each([[0], [null], ['x'], [-100]])('gateway amount %p credits nothing', async (amount) => {
        const cust = await createCustomer('pgwp-v17');
        const r = recharge(cust, { amount });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(await bal(cust)).toBe(0);
    });

    test('payment.order_id different from the named recharge order → refused', async () => {
        const cust = await createCustomer('pgwp-v18');
        const r = recharge(cust, { payOrderId: `order_${rid()}` });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(400);
        expect(await bal(cust)).toBe(0);
    });

    test('gateway timeout → 502, no credit, claim not leaked, retry then credits once', async () => {
        const cust = await createCustomer('pgwp-v19');
        const r = recharge(cust, { amount: 10000 });
        rzp.instance.payments.fetch.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        const first = await verify(ctx.api.as(cust, A), r.body);
        expect(first.status).toBe(502);
        expect(await bal(cust)).toBe(0);
        expect(await PaymentClaim.countDocuments({ paymentId: r.paymentId })).toBe(0);
        expect((await verify(ctx.api.as(cust, A), r.body)).status).toBe(200);
        expect(await bal(cust)).toBe(100);
    });

    test('a payment id already spent on a food order cannot also fund a wallet (409 PAYMENT_ALREADY_USED)', async () => {
        const cust = await createCustomer('pgwp-v20');
        const r = recharge(cust);
        await PaymentClaim.create({ paymentId: r.paymentId, purpose: 'order_payment', ref: String(oid()), restaurant: A.restaurant._id });
        const res = await verify(ctx.api.as(cust, A), r.body);
        expect(res.status).toBe(409);
        expect(await bal(cust)).toBe(0);
    });

    test('with RAZORPAY_KEY_SECRET unset the endpoint fails closed (5xx), no credit', async () => {
        const cust = await createCustomer('pgwp-v21');
        const r = recharge(cust);
        const saved = process.env.RAZORPAY_KEY_SECRET;
        delete process.env.RAZORPAY_KEY_SECRET;
        try {
            const res = await verify(ctx.api.as(cust, A), r.body);
            expect(res.status).toBeGreaterThanOrEqual(500);
        } finally { process.env.RAZORPAY_KEY_SECRET = saved; }
        expect(await bal(cust)).toBe(0);
    });

    // EXPECTED: a blank RAZORPAY_KEY_SECRET is a configuration error (503) — no signature can be
    // trusted. ACTUAL: wallet.js:~101 signs with crypto.createHmac('sha256','') so an HMAC made
    // with an empty key passes the signature gate (only the gateway fetch stands in the way).
    test('Regression (fixed 2026-11): blank RAZORPAY_KEY_SECRET must not accept a signature forged with an empty key (wallet)', async () => {
        const cust = await createCustomer('pgwp-v22');
        const r = recharge(cust, { amount: 10000 });
        const saved = process.env.RAZORPAY_KEY_SECRET;
        process.env.RAZORPAY_KEY_SECRET = '';
        try {
            const forged = crypto.createHmac('sha256', '').update(`${r.rzpOrderId}|${r.paymentId}`).digest('hex');
            const res = await verify(ctx.api.as(cust, A), { ...r.body, razorpay_signature: forged });
            expect(res.status).not.toBe(200);
        } finally { process.env.RAZORPAY_KEY_SECRET = saved; }
        expect(await bal(cust)).toBe(0);
    });

    test('a recharge payment cannot be redeemed as a food-order payment via the webhook', async () => {
        const cust = await createCustomer('pgwp-v23');
        const r = recharge(cust, { amount: 50000 });
        await verify(ctx.api.as(cust, A), r.body);
        const target = await Order.create({
            restaurant: A.restaurant._id, branch: A.branch._id, orderId: `PG-${rid()}`, type: 'takeaway',
            items: [{ menuItem: A.items.paneer._id, name: 'x', price: 500, quantity: 1 }], total: 500, razorpayOrderId: `order_${rid()}`,
        });
        const payload = { event: 'payment.captured', payload: { payment: { entity: {
            id: r.paymentId, amount: 50000, currency: 'INR', status: 'captured', order_id: target.razorpayOrderId,
            notes: { cafeOrderId: String(target._id), restaurantId: String(A.restaurant._id) },
        } } } };
        const raw = JSON.stringify(payload);
        await ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', whSign(raw)).send(raw);
        expect((await Order.findById(target._id).lean()).paymentStatus).not.toBe('Paid');
    });
});

// ═══ SaaS plan payments ══════════════════════════════════════════════
describe('plan payments: /tenant/billing/upgrade/verify and the plan_payment webhook', () => {
    const PRICE = 1999;
    const REQUIRED = priceWithGst(PRICE).totalPaise;

    async function planTenant({ pending = true, extra = {} } = {}) {
        const t = await seedTenant({ label: `pgwp-p${rid()}` });
        const rzpOrderId = `order_${rid()}`;
        const $set = {
            'subscription.price': PRICE, 'subscription.planName': 'Starter', 'subscription.planSlug': 'starter',
            ...extra,
        };
        if (pending) {
            $set['subscription.pendingUpgrade'] = {
                planName: 'Pro', planSlug: 'pro', price: PRICE, billingCycle: 'monthly', features: { reports: true },
                limits: {}, fallbackOrder: true, razorpayOrderId: rzpOrderId,
            };
        }
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set });
        return { t, rzpOrderId };
    }
    const planPayment = (t, rzpOrderId, o = {}) => ({
        id: o.id || `pay_${rid()}`, entity: 'payment', order_id: o.order_id || rzpOrderId, status: o.status || 'captured',
        amount: o.amount !== undefined ? o.amount : REQUIRED, currency: o.currency || 'INR', created_at: Math.floor(Date.now() / 1000),
        notes: o.notes || { type: 'plan_payment', restaurantId: String(t.restaurant._id) },
    });
    function verifyCall(t, p, { signature, orderId } = {}) {
        rzp.instance.payments.fetch.mockResolvedValue(p);
        const oidv = orderId || p.order_id;
        return ctx.api.as(t.users.admin).post('/tenant/billing/upgrade/verify').send({
            razorpay_order_id: oidv, razorpay_payment_id: p.id, razorpay_signature: signature || sig(oidv, p.id),
        });
    }
    function hook(p, signature) {
        const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: p } } });
        return ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json')
            .set('X-Razorpay-Signature', signature || whSign(raw)).send(raw);
    }
    const inv = (t) => SubscriptionInvoice.countDocuments({ restaurant: t.restaurant._id });
    const rest = (t) => Restaurant.findById(t.restaurant._id).lean();

    test('a correct capture applies the pending plan and writes one invoice with the GST split', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        const res = await verifyCall(t, p);
        expect(res.status).toBe(200);
        expect(res.body.data.upgradeApplied).toBe(true);
        const r = await rest(t);
        expect(r.subscription.planSlug).toBe('pro');
        expect(r.subscription.pendingUpgrade?.planSlug || '').toBe('');
        const invoice = await SubscriptionInvoice.findOne({ restaurant: t.restaurant._id }).lean();
        expect(invoice.razorpayPaymentId).toBe(p.id);
        expect(invoice.baseAmount + invoice.gstAmount).toBeCloseTo(invoice.amount, 2);
        expect(invoice.amount).toBe(REQUIRED); // stored in paise
    });

    test('verify twice → second says alreadyInvoiced, still exactly one invoice', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        await verifyCall(t, p);
        const again = await verifyCall(t, p);
        expect(again.status).toBe(200);
        expect(again.body.data.alreadyInvoiced).toBe(true);
        expect(await inv(t)).toBe(1);
    });

    test('verify then webhook redelivery (and the reverse) → one invoice, one application', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        await verifyCall(t, p);
        await hook(p); await hook(p);
        expect(await inv(t)).toBe(1);
        const { t: t2, rzpOrderId: o2 } = await planTenant();
        const p2 = planPayment(t2, o2);
        await hook(p2);
        const res = await verifyCall(t2, p2);
        expect(res.body.data.alreadyInvoiced).toBe(true);
        expect(await inv(t2)).toBe(1);
    });

    test('verify racing the webhook for the same payment → exactly one invoice', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        const rs = await Promise.all([verifyCall(t, p), hook(p), hook(p)]);
        expect(rs[0].status).toBe(200);
        await settle(100);
        expect(await inv(t)).toBe(1);
        expect((await rest(t)).subscription.planSlug).toBe('pro');
    });

    test('tampered / missing / wrong-secret signature → 400, nothing applied', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        for (const signature of ['f'.repeat(64), sig(rzpOrderId, p.id, 'nope'), sig(rzpOrderId, p.id).slice(0, 30)]) {
            const res = await verifyCall(t, p, { signature });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('SIGNATURE_INVALID');
        }
        const noSig = await ctx.api.as(t.users.admin).post('/tenant/billing/upgrade/verify').send({ razorpay_order_id: rzpOrderId, razorpay_payment_id: p.id });
        expect(noSig.status).toBe(400);
        expect(await inv(t)).toBe(0);
        expect((await rest(t)).subscription.planSlug).toBe('starter');
    });

    test('RAZORPAY_KEY_SECRET unset or blank → 503 BILLING_NOT_CONFIGURED', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        const saved = process.env.RAZORPAY_KEY_SECRET;
        try {
            for (const v of [undefined, '']) {
                if (v === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = v;
                const res = await ctx.api.as(t.users.admin).post('/tenant/billing/upgrade/verify').send({
                    razorpay_order_id: rzpOrderId, razorpay_payment_id: p.id, razorpay_signature: 'x',
                });
                expect(res.status).toBe(503);
            }
        } finally { process.env.RAZORPAY_KEY_SECRET = saved; }
    });

    test('only the tenant owner may verify (waiter / unauthenticated → 401/403)', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        const body = { razorpay_order_id: rzpOrderId, razorpay_payment_id: p.id, razorpay_signature: sig(rzpOrderId, p.id) };
        expect((await ctx.api.as(t.users.waiter).post('/tenant/billing/upgrade/verify').send(body)).status).toBe(403);
        const anon = (await ctx.api.anon().post('/tenant/billing/upgrade/verify').send(body)).status; expect(anon).toBeGreaterThanOrEqual(400); expect(anon).toBeLessThan(500);
    });

    test('authorized (uncaptured) payment → 409, nothing applied', async () => {
        const { t, rzpOrderId } = await planTenant();
        const res = await verifyCall(t, planPayment(t, rzpOrderId, { status: 'authorized' }));
        expect(res.status).toBe(409);
        expect(await inv(t)).toBe(0);
    });

    test('gateway fetch failure → 502, nothing applied; the retry then succeeds', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        rzp.instance.payments.fetch.mockRejectedValueOnce(new Error('timeout'));
        const bad = await ctx.api.as(t.users.admin).post('/tenant/billing/upgrade/verify').send({ razorpay_order_id: rzpOrderId, razorpay_payment_id: p.id, razorpay_signature: sig(rzpOrderId, p.id) });
        expect(bad.status).toBe(502);
        expect(await inv(t)).toBe(0);
        expect((await verifyCall(t, p)).status).toBe(200);
    });

    test('payment.order_id different from the signed order id → 400 PAYMENT_MISMATCH', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, `order_${rid()}`);
        const res = await verifyCall(t, p, { orderId: rzpOrderId });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_MISMATCH');
    });

    test('payment stamped for another tenant → 403 TENANT_MISMATCH; no notes → 403; wrong type → 400', async () => {
        const { t, rzpOrderId } = await planTenant();
        const other = await seedTenant({ label: `pgwp-o${rid()}` });
        expect((await verifyCall(t, planPayment(t, rzpOrderId, { notes: { type: 'plan_payment', restaurantId: String(other.restaurant._id) } }))).status).toBe(403);
        expect((await verifyCall(t, planPayment(t, rzpOrderId, { notes: {} }))).status).toBe(403);
        const wrong = await verifyCall(t, planPayment(t, rzpOrderId, { notes: { type: 'cafe_order', restaurantId: String(t.restaurant._id) } }));
        expect(wrong.status).toBe(400);
        expect(wrong.body.code).toBe('NOT_A_PLAN_PAYMENT');
        expect(await inv(t)).toBe(0);
    });

    test('a cheap capture (₹1) does not unlock the pending plan (PAYMENT_PLAN_MISMATCH); pending retained', async () => {
        const { t, rzpOrderId } = await planTenant();
        const res = await verifyCall(t, planPayment(t, rzpOrderId, { amount: 100 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_PLAN_MISMATCH');
        const r = await rest(t);
        expect(r.subscription.planSlug).toBe('starter');
        expect(r.subscription.pendingUpgrade.planSlug).toBe('pro');
        expect(await inv(t)).toBe(0);
    });

    test('price boundary: one paise short is refused, exact GST-inclusive total is accepted', async () => {
        const a = await planTenant(); const b = await planTenant();
        expect((await verifyCall(a.t, planPayment(a.t, a.rzpOrderId, { amount: REQUIRED - 1 }))).status).toBe(400);
        expect((await verifyCall(b.t, planPayment(b.t, b.rzpOrderId, { amount: REQUIRED }))).status).toBe(200);
    });

    test('a capture for an older / different rzp order than the pending upgrade is refused', async () => {
        const { t } = await planTenant();
        const res = await verifyCall(t, planPayment(t, `order_${rid()}`));
        expect(res.status).toBe(400);
        expect(await inv(t)).toBe(0);
    });

    // EXPECTED: a plan payment in a foreign currency is refused like cafe-order verify does
    // (PAYMENT_CURRENCY_MISMATCH). ACTUAL: applyPaidPlanUpgrade / verifyUpgradePayment never read
    // payment.currency — a USD capture of >= the INR paise figure applies the plan and writes an
    // invoice with currency 'USD'.
    test('Regression (fixed 2026-11): plan payment in a non-INR currency must not apply the upgrade', async () => {
        const { t, rzpOrderId } = await planTenant();
        const res = await verifyCall(t, planPayment(t, rzpOrderId, { currency: 'USD' }));
        expect(res.status).not.toBe(200);
        expect((await rest(t)).subscription.planSlug).toBe('starter');
    });

    // EXPECTED: a plan_payment capture with NO pending upgrade is only a renewal if it pays at
    // least the current plan price; a ₹1 payment must not extend the term or create an invoice.
    // ACTUAL: planPaymentApply.pendingPaymentMismatch returns '' when nothing is pending, so
    // applyPaidPlanUpgrade treats ANY amount as a full-term renewal: currentPeriodEnd is pushed out
    // a whole cycle and a paid invoice is minted for ₹1. Because payment-level notes (type /
    // restaurantId) are what the webhook and /upgrade/verify trust, a tenant who can put those
    // notes on any cheap checkout gets a month of service per rupee.
    test('Regression (fixed 2026-11): a ₹1 plan_payment with no pending upgrade must not extend the term or create an invoice (webhook)', async () => {
        const { t } = await planTenant({ pending: false });
        const before = (await rest(t)).subscription.currentPeriodEnd || null;
        await hook(planPayment(t, `order_${rid()}`, { amount: 100 }));
        await settle(100);
        const after = (await rest(t)).subscription.currentPeriodEnd || null;
        expect(await inv(t)).toBe(0);
        expect(after && (!before || new Date(after) > new Date(before))).toBeFalsy();
    });

    test('Regression (fixed 2026-11): a ₹1 plan_payment with no pending upgrade must not be accepted by /upgrade/verify', async () => {
        const { t } = await planTenant({ pending: false });
        const oid2 = `order_${rid()}`;
        const res = await verifyCall(t, planPayment(t, oid2, { amount: 100 }));
        expect(res.status).not.toBe(200);
        expect(await inv(t)).toBe(0);
    });

    test('webhook plan_payment: forged signature, missing / invalid / unknown restaurantId are all 200 no-ops', async () => {
        const { t, rzpOrderId } = await planTenant();
        const p = planPayment(t, rzpOrderId);
        expect((await hook(p, 'f'.repeat(64))).status).toBe(200);
        for (const rid2 of [undefined, 'nope', String(oid())]) {
            const q = planPayment(t, rzpOrderId, { notes: { type: 'plan_payment', ...(rid2 ? { restaurantId: rid2 } : {}) } });
            expect((await hook(q)).status).toBe(200);
        }
        expect(await inv(t)).toBe(0);
        expect((await rest(t)).subscription.planSlug).toBe('starter');
    });

    test('webhook plan_payment underpaid for the pending plan is skipped (pending kept, no invoice)', async () => {
        const { t, rzpOrderId } = await planTenant();
        await hook(planPayment(t, rzpOrderId, { amount: REQUIRED - 500 }));
        expect(await inv(t)).toBe(0);
        expect((await rest(t)).subscription.pendingUpgrade.planSlug).toBe('pro');
    });

    test('a plan payment for tenant B cannot apply B\'s pending upgrade through tenant A\'s verify', async () => {
        const a = await planTenant(); const b = await planTenant();
        const p = planPayment(b.t, b.rzpOrderId); // stamped for B
        const res = await verifyCall(a.t, p);
        expect(res.status).toBe(403);
        expect((await rest(b.t)).subscription.planSlug).toBe('starter');
        expect(await inv(a.t)).toBe(0);
    });

    test('a plan_payment webhook never settles a cafe order carrying the same ids', async () => {
        const { t, rzpOrderId } = await planTenant();
        const order = await Order.create({
            restaurant: t.restaurant._id, branch: t.branch._id, orderId: `PG-${rid()}`, type: 'takeaway',
            items: [{ menuItem: t.items.paneer._id, name: 'x', price: 500, quantity: 1 }], total: 500, razorpayOrderId: rzpOrderId,
        });
        await hook(planPayment(t, rzpOrderId));
        expect((await Order.findById(order._id).lean()).paymentStatus).not.toBe('Paid');
    });
});

// ═══ subscription.charged webhooks ═══════════════════════════════════
describe('subscription.charged webhook idempotency', () => {
    function charged(subId, payId, amount = 235882) {
        const raw = JSON.stringify({
            event: 'subscription.charged',
            payload: {
                subscription: { entity: { id: subId, status: 'active', current_start: 1767225600, current_end: 1769904000 } },
                payment: { entity: { id: payId, order_id: `order_${rid()}`, amount, currency: 'INR', status: 'captured' } },
            },
        });
        return ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', whSign(raw)).send(raw);
    }

    test('5 concurrent redeliveries of one charge write one invoice and keep the tenant active', async () => {
        const t = await seedTenant({ label: `pgwp-s${rid()}` });
        const subId = `sub_${rid()}`;
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.razorpaySubscriptionId': subId } });
        const payId = `pay_${rid()}`;
        const rs = await Promise.all([1, 2, 3, 4, 5].map(() => charged(subId, payId)));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        await settle(150);
        expect(await SubscriptionInvoice.countDocuments({ razorpayPaymentId: payId })).toBe(1);
        expect((await Restaurant.findById(t.restaurant._id).lean()).status).toBe('active');
    });

    test('a charge for an unknown subscription id is a 200 no-op', async () => {
        const res = await charged(`sub_${rid()}`, `pay_${rid()}`);
        expect(res.status).toBe(200);
    });
});

// ═══ pure paymentChecks rules ════════════════════════════════════════
describe('utils/paymentChecks (pure rules)', () => {
    test('paiseToRupees: exact, rounds fractional paise, garbage → 0', () => {
        expect(checks.paiseToRupees(50050)).toBe(500.5);
        expect(checks.paiseToRupees(1)).toBe(0.01);
        expect(checks.paiseToRupees('12345')).toBe(123.45);
        expect(checks.paiseToRupees(10.6)).toBe(0.11);
        for (const bad of [undefined, null, 'abc', NaN, Infinity, {}]) expect(checks.paiseToRupees(bad)).toBe(0);
    });

    test('isValidCheckoutSignature: valid / tampered / empty secret / missing parts', () => {
        const good = checks.expectedCheckoutSignature('o1', 'p1', 's3cret');
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: 'o1', razorpayPaymentId: 'p1', signature: good, secret: 's3cret' })).toBe(true);
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: 'o1', razorpayPaymentId: 'p1', signature: good, secret: 'other' })).toBe(false);
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: 'o1', razorpayPaymentId: 'p2', signature: good, secret: 's3cret' })).toBe(false);
        const forgedEmpty = checks.expectedCheckoutSignature('o1', 'p1', '');
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: 'o1', razorpayPaymentId: 'p1', signature: forgedEmpty, secret: '' })).toBe(false);
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: '', razorpayPaymentId: 'p1', signature: good, secret: 's3cret' })).toBe(false);
        expect(checks.isValidCheckoutSignature({ razorpayOrderId: 'o1', razorpayPaymentId: 'p1', signature: [good], secret: 's3cret' })).toBe(false);
    });

    test('orderAmountDue: full total, or total − prior partial; ignores a prior payment >= total', () => {
        expect(checks.orderAmountDue({ total: 500 })).toEqual({ total: 500, priorPaid: 0, due: 500 });
        expect(checks.orderAmountDue({ total: 500, amountPaid: 200 }).due).toBe(300);
        expect(checks.orderAmountDue({ total: 500, amountPaid: 500 }).due).toBe(500);
        expect(checks.orderAmountDue({ total: 500, amountPaid: 900 }).due).toBe(500);
        expect(checks.orderAmountDue({}).due).toBe(0);
    });

    test('checkCaptureCoversDue: ₹1 tolerance boundary and garbage amounts', () => {
        expect(checks.checkCaptureCoversDue({ order: { total: 500 }, amount: 499 }).ok).toBe(true);
        expect(checks.checkCaptureCoversDue({ order: { total: 500 }, amount: 498.99 }).ok).toBe(false);
        expect(checks.checkCaptureCoversDue({ order: { total: 500 }, amount: 'x' }).code).toBe('AMOUNT_INSUFFICIENT');
        expect(checks.checkCaptureCoversDue({ order: { total: 500 }, amount: -5 }).ok).toBe(false);
    });

    test('checkSettledPayment: missing payment, mismatching order, bad state, currency, amount', () => {
        const ok = { id: 'p', order_id: 'o', status: 'captured', amount: 100, currency: 'INR' };
        expect(checks.checkSettledPayment(ok, 'o').ok).toBe(true);
        expect(checks.checkSettledPayment(null, 'o').code).toBe('PAYMENT_NOT_FOUND');
        expect(checks.checkSettledPayment({ ...ok, id: undefined }, 'o').code).toBe('PAYMENT_NOT_FOUND');
        expect(checks.checkSettledPayment(ok, 'other').code).toBe('PAYMENT_ORDER_MISMATCH');
        expect(checks.checkSettledPayment({ ...ok, status: 'failed' }, 'o').code).toBe('PAYMENT_NOT_CAPTURED');
        expect(checks.checkSettledPayment({ ...ok, currency: 'EUR' }, 'o').code).toBe('PAYMENT_CURRENCY_MISMATCH');
        expect(checks.checkSettledPayment({ ...ok, amount: 0 }, 'o').code).toBe('PAYMENT_AMOUNT_INVALID');
    });

    test('checkWalletRechargePayment: user / tenant / purpose / cap rules', () => {
        const payment = { id: 'p', order_id: 'o', status: 'captured', amount: 50000, currency: 'INR' };
        const rzpOrder = { id: 'o', notes: { purpose: 'wallet_recharge', userId: 'u1', restaurantId: 't1' } };
        const base = { payment, rzpOrder, razorpayOrderId: 'o', userId: 'u1', tenant: 't1' };
        expect(checks.checkWalletRechargePayment(base).ok).toBe(true);
        expect(checks.checkWalletRechargePayment({ ...base, userId: 'u2' }).code).toBe('RECHARGE_USER_MISMATCH');
        expect(checks.checkWalletRechargePayment({ ...base, userId: undefined }).code).toBe('RECHARGE_USER_MISMATCH');
        expect(checks.checkWalletRechargePayment({ ...base, tenant: undefined }).code).toBe('TENANT_REQUIRED');
        expect(checks.checkWalletRechargePayment({ ...base, tenant: 't2' }).code).toBe('TENANT_MISMATCH');
        expect(checks.checkWalletRechargePayment({ ...base, rzpOrder: null }).code).toBe('RECHARGE_ORDER_INVALID');
        expect(checks.checkWalletRechargePayment({ ...base, rzpOrder: { id: 'zz', notes: rzpOrder.notes } }).code).toBe('RECHARGE_ORDER_INVALID');
        expect(checks.checkWalletRechargePayment({ ...base, payment: { ...payment, amount: 1000100 } }).code).toBe('RECHARGE_AMOUNT_INVALID');
    });

    test('checkOrphanRefundEligibility: age window, linked order, tenant, payer proof', () => {
        const now = Date.UTC(2026, 0, 1, 12);
        const payment = { id: 'p', created_at: Math.floor(now / 1000) - 60 };
        const rzpOrder = { notes: { restaurantId: 't1', cafeOrderId: 'none', userId: 'u1' } };
        const base = { payment, rzpOrder, tenant: 't1', caller: { userId: 'u1' }, nowMs: now };
        expect(checks.checkOrphanRefundEligibility(base).ok).toBe(true);
        expect(checks.checkOrphanRefundEligibility({ ...base, caller: {} }).code).toBe('PAYER_MISMATCH');
        expect(checks.checkOrphanRefundEligibility({ ...base, caller: {}, signatureValid: true }).ok).toBe(true);
        expect(checks.checkOrphanRefundEligibility({ ...base, tenant: 't2' }).code).toBe('TENANT_MISMATCH');
        expect(checks.checkOrphanRefundEligibility({ ...base, rzpOrder: { notes: { ...rzpOrder.notes, cafeOrderId: 'abc' } } }).code).toBe('PAYMENT_IN_USE');
        expect(checks.checkOrphanRefundEligibility({ ...base, rzpOrder: { notes: { ...rzpOrder.notes, purpose: 'wallet_recharge' } } }).code).toBe('PAYMENT_NOT_REFUNDABLE');
        expect(checks.checkOrphanRefundEligibility({ ...base, payment: { id: 'p', created_at: Math.floor(now / 1000) - 3 * 3600 } }).code).toBe('REFUND_WINDOW_EXPIRED');
        expect(checks.checkOrphanRefundEligibility({ ...base, payment: { id: 'p', created_at: Math.floor(now / 1000) + 3600 } }).code).toBe('REFUND_WINDOW_EXPIRED');
        expect(checks.checkOrphanRefundEligibility({ ...base, payment: { id: 'p' } }).code).toBe('PAYMENT_AGE_UNKNOWN');
    });

    test('resolveBookingPaymentOutcome: full, advance (50%), insufficient', () => {
        expect(checks.resolveBookingPaymentOutcome({ total: 1000, paidAmount: 1000 })).toMatchObject({ ok: true, status: 'Paid' });
        expect(checks.resolveBookingPaymentOutcome({ total: 1000, paidAmount: 500 })).toMatchObject({ ok: true, status: 'Partial' });
        expect(checks.resolveBookingPaymentOutcome({ total: 1000, paidAmount: 100 }).code).toBe('AMOUNT_INSUFFICIENT');
        expect(checks.resolveBookingPaymentOutcome({ total: 1000, paidAmount: 5000 }).advancePaid).toBe(1000);
    });

    test('orderCheckoutIds merges latest + history without duplicates', () => {
        expect(checks.orderCheckoutIds({ razorpayOrderId: 'a', razorpayOrderIds: ['b', 'a', 'c'] })).toEqual(['a', 'b', 'c']);
        expect(checks.orderCheckoutIds({})).toEqual([]);
    });
});
