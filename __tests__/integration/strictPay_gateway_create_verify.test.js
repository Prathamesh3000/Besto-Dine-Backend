/**
 * STRICT payments campaign: Razorpay gateway, create-order + verify-payment.
 *
 *   POST /razorpay/create-order   (controllers/razorpay/orderPayment.js)
 *   POST /razorpay/verify-payment
 *   utils/paymentChecks.js, utils/paymentClaim.js
 *
 * Razorpay is fully mocked (helpers/razorpayMock.js); nothing leaves the
 * process. Tests named "BUG:" pin a real defect and are EXPECTED TO FAIL
 * until the source is fixed (expected vs actual in the comment above).
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const RefundRequest = require(path.join(BACKEND, 'models/refundRequest'));

const ctx = useIntegrationApp();
let A;
let B;

const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p, secret = process.env.RAZORPAY_KEY_SECRET) =>
    crypto.createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'pgcv-a' });
    B = await seedTenant({ label: 'pgcv-b' });
    await Settings.updateOne(
        { restaurant: A.restaurant._id, branch: null },
        { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } },
    );
});

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `PG-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, ...fields,
    });
    return doc.toObject();
}

function stubCreate() {
    rzp.instance.orders.create.mockImplementation(async (o) => ({
        id: `order_${rid()}`, entity: 'order', amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes,
    }));
}

function stubGateway({ order, rzpOrderId, paymentId, amount, status = 'captured', currency = 'INR', notes, orderIdOnPayment }) {
    const n = notes !== undefined ? notes : { cafeOrderId: String(order._id), restaurantId: String(order.restaurant), purpose: 'cafe_order' };
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: orderIdOnPayment || rzpOrderId, status, amount, currency, notes: n,
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount, notes: n });
}

async function checkout(t, fields = {}, { paise } = {}) {
    const rzpOrderId = `order_${rid()}`;
    const order = await mkOrder(t, { razorpayOrderId: rzpOrderId, ...fields });
    const paymentId = `pay_${rid()}`;
    return {
        order, rzpOrderId, paymentId, paise: paise !== undefined ? paise : Math.round(order.total * 100),
        body: {
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId,
            razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(order._id),
        },
    };
}

const reload = (o) => Order.findById(o._id).lean();
const verify = (api, body, key = `k-${rid()}`) => api.post('/razorpay/verify-payment').set('Idempotency-Key', key).send(body);
const create = (api, body) => api.post('/razorpay/create-order').send(body);
const guest = () => ctx.api.guest(A);

// ═══ create-order ════════════════════════════════════════════════════
describe('create-order: amount / currency are validated and server-fixed', () => {
    beforeEach(stubCreate);

    test.each([
        ['string "500"', '500'], ['null', null], ['boolean', true], ['array', [500]], ['object', { $gt: 0 }], ['missing', undefined],
        ['zero', 0], ['negative', -5], ['below 1 rupee', 0.99], ['above the cap', 10_000_001],
    ])('amount %s → 400 and the gateway is never called', async (_l, amount) => {
        const res = await create(guest(), { amount });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('boundaries ₹1 and ₹1,00,00,000 are accepted and converted to paise', async () => {
        const lo = await create(guest(), { amount: 1 });
        expect(lo.status).toBe(200);
        expect(lo.body.razorpayOrder.amount).toBe(100);
        const hi = await create(guest(), { amount: 10_000_000 });
        expect(hi.status).toBe(200);
        expect(hi.body.razorpayOrder.amount).toBe(1_000_000_000);
    });

    test('floating-point rupees round to exact paise (1.15 → 115, 0.29 → 29 via 1.29 → 129)', async () => {
        const a = await create(guest(), { amount: 1.15 });
        expect(rzp.instance.orders.create.mock.calls[0][0].amount).toBe(115);
        const b = await create(guest(), { amount: 1.29 });
        expect(rzp.instance.orders.create.mock.calls[1][0].amount).toBe(129);
        expect(a.status).toBe(200); expect(b.status).toBe(200);
    });

    test('client-supplied currency is ignored: the gateway order is always INR', async () => {
        const res = await create(guest(), { amount: 100, currency: 'USD' });
        expect(res.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0].currency).toBe('INR');
        expect(res.body.razorpayOrder.currency).toBe('INR');
    });

    test('client-supplied notes / purpose / restaurantId cannot override the server-stamped notes', async () => {
        const res = await create(guest(), {
            amount: 100, notes: { purpose: 'wallet_recharge', restaurantId: String(B.restaurant._id), userId: 'x' },
            purpose: 'plan_payment', restaurantId: String(B.restaurant._id),
        });
        expect(res.status).toBe(200);
        const n = rzp.instance.orders.create.mock.calls[0][0].notes;
        expect(n.purpose).toBe('cafe_order');
        expect(n.restaurantId).toBe(String(A.restaurant._id));
        expect(n.userId).toBeUndefined();
    });

    test('the receipt is clamped to Razorpay\'s 40-char limit', async () => {
        const res = await create(guest(), { amount: 100, receipt: 'r'.repeat(100) });
        expect(res.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0].receipt.length).toBeLessThanOrEqual(40);
    });

    test.each([
        ['object cafeOrderId (query operator)', { amount: 100, cafeOrderId: { $ne: null } }],
        ['array cafeOrderId', { amount: 100, cafeOrderId: ['a'] }],
        ['101-char cafeOrderId', { amount: 100, cafeOrderId: 'a'.repeat(101) }],
        ['object receipt', { amount: 100, receipt: { a: 1 } }],
        ['101-char receipt', { amount: 100, receipt: 'r'.repeat(101) }],
    ])('malformed %s → 400, no gateway call', async (_l, body) => {
        const res = await create(guest(), body);
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('logged-in payer is stamped from the token, never from the body', async () => {
        const cust = await createCustomer('pgcv-c1');
        const res = await create(ctx.api.as(cust, A), { amount: 100, userId: 'someone-else', payerRole: 'admin' });
        expect(res.status).toBe(200);
        const n = rzp.instance.orders.create.mock.calls[0][0].notes;
        expect(n.userId).toBe(String(cust._id));
        expect(n.payerRole).toBe('customer');
    });

    test('a request with no tenant context is refused before the gateway', async () => {
        const res = await create(ctx.api.anon(), { amount: 100 });
        expect([400, 403, 404]).toContain(res.status);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('opening a second checkout keeps BOTH rzp order ids in the order history', async () => {
        const o = await mkOrder(A);
        const r1 = await create(guest(), { amount: 500, cafeOrderId: String(o._id) });
        const r2 = await create(guest(), { amount: 500, cafeOrderId: String(o._id) });
        const after = await reload(o);
        expect(after.razorpayOrderId).toBe(r2.body.razorpayOrder.id);
        expect(after.razorpayOrderIds).toEqual(expect.arrayContaining([r1.body.razorpayOrder.id, r2.body.razorpayOrder.id]));
    });

    test('resolves the order by human orderId as well as _id', async () => {
        const o = await mkOrder(A);
        const res = await create(guest(), { amount: 500, cafeOrderId: o.orderId });
        expect(res.status).toBe(200);
        expect((await reload(o)).razorpayOrderId).toBe(res.body.razorpayOrder.id);
    });

    test('underpaying checkout (amount < due − ₹1) is refused with AMOUNT_MISMATCH and no gateway call', async () => {
        const o = await mkOrder(A);
        const res = await create(guest(), { amount: 498.99, cafeOrderId: String(o._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_MISMATCH');
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
        expect((await reload(o)).razorpayOrderId).toBeUndefined();
    });

    test('the ₹1 rounding tolerance boundary (499) is accepted', async () => {
        const o = await mkOrder(A);
        const res = await create(guest(), { amount: 499, cafeOrderId: String(o._id) });
        expect(res.status).toBe(200);
    });

    test('after a partial (wallet) payment the due is total − paid: 300 ok, 250 refused', async () => {
        const o = await mkOrder(A, { amountPaid: 200 });
        const bad = await create(guest(), { amount: 250, cafeOrderId: String(o._id) });
        expect(bad.status).toBe(400);
        const ok = await create(guest(), { amount: 300, cafeOrderId: String(o._id) });
        expect(ok.status).toBe(200);
    });

    // EXPECTED: the gateway order amount is what the SERVER computes for the order (₹500) — or an
    // amount above the due is refused. ACTUAL: orderPayment.js:~134 only enforces a FLOOR
    // (amount >= due-1); the client-chosen ₹5000 is sent to Razorpay as-is, so a customer can
    // open (and pay) a checkout for 10x the bill and verify-payment will then record that
    // overpayment as the order's amountPaid.
    test('Regression (fixed 2026-11): create-order for an existing order must not let the client choose an amount above the order due', async () => {
        const o = await mkOrder(A);
        const res = await create(guest(), { amount: 5000, cafeOrderId: String(o._id) });
        const sent = rzp.instance.orders.create.mock.calls[0]?.[0]?.amount;
        expect(sent === undefined || sent === 50000).toBe(true);
        expect(res.status === 400 || res.body.razorpayOrder.amount === 50000).toBe(true);
    });

    test.each([
        ['already Paid', { paymentStatus: 'Paid' }],
        ['Refunded', { paymentStatus: 'Refunded' }],
        ['cancelled', { status: 'cancelled' }],
    ])('an order that is %s cannot open a new checkout (409, no gateway call)', async (_l, f) => {
        const o = await mkOrder(A, f);
        const res = await create(guest(), { amount: 500, cafeOrderId: String(o._id) });
        expect(res.status).toBe(409);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('a non-existent / deleted order id → 404 and no gateway call', async () => {
        const res = await create(guest(), { amount: 500, cafeOrderId: String(new (require('mongoose').Types.ObjectId)()) });
        expect(res.status).toBe(404);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('gateway timeout → generic 500, no internal error text leaked, order not stamped', async () => {
        const o = await mkOrder(A);
        rzp.instance.orders.create.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT 10.1.2.3:443 secret_detail'), { code: 'ETIMEDOUT' }));
        const res = await create(guest(), { amount: 500, cafeOrderId: String(o._id) });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/ETIMEDOUT|secret_detail|10\.1\.2\.3/);
        const after = await reload(o);
        expect(after.razorpayOrderId).toBeUndefined();
    });

    test('gateway 4xx error object → 500 generic, body has no gateway description', async () => {
        rzp.instance.orders.create.mockRejectedValue({ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed key rzp_live_abc' } });
        const res = await create(guest(), { amount: 100 });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/rzp_live|Authentication/);
    });

    test('the response exposes only the public key id, never the key secret', async () => {
        const res = await create(guest(), { amount: 100 });
        expect(res.body.key).toBe(process.env.RAZORPAY_KEY_ID);
        expect(JSON.stringify(res.body)).not.toContain(process.env.RAZORPAY_KEY_SECRET);
        expect(JSON.stringify(res.body)).not.toContain(process.env.RAZORPAY_WEBHOOK_SECRET);
    });

    test('another tenant\'s order id cannot be opened from tenant A (404)', async () => {
        const bo = await mkOrder(B);
        const res = await create(guest(), { amount: 500, cafeOrderId: String(bo._id) });
        expect(res.status).toBe(404);
        expect((await reload(bo)).razorpayOrderId).toBeUndefined();
    });
});

// ═══ verify-payment: signature ═══════════════════════════════════════
describe('verify-payment: checkout signature', () => {
    test('valid signature + captured payment settles the order exactly once', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(200);
        const o = await reload(c.order);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.amountPaid).toBe(500);
        expect(o.razorpayPaymentId).toBe(c.paymentId);
        expect(o.payments.filter((p) => p.method === 'razorpay')).toHaveLength(1);
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(1);
    });

    test('a single flipped hex char in the signature is rejected; gateway never consulted; order stays unpaid', async () => {
        const c = await checkout(A);
        const bad = c.body.razorpay_signature.replace(/.$/, (ch) => (ch === '0' ? '1' : '0'));
        const res = await verify(guest(), { ...c.body, razorpay_signature: bad });
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
    });

    test.each([
        ['missing razorpay_order_id', 'razorpay_order_id'],
        ['missing razorpay_payment_id', 'razorpay_payment_id'],
        ['missing razorpay_signature', 'razorpay_signature'],
    ])('%s → 400', async (_l, field) => {
        const c = await checkout(A);
        const body = { ...c.body }; delete body[field];
        const res = await verify(guest(), body);
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('empty-string signature → 400', async () => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, razorpay_signature: '' });
        expect(res.status).toBe(400);
    });

    test('signature made with the wrong secret (and the webhook secret) is rejected', async () => {
        const c = await checkout(A);
        for (const secret of ['totally_wrong', process.env.RAZORPAY_WEBHOOK_SECRET]) {
            const res = await verify(guest(), { ...c.body, razorpay_signature: sig(c.rzpOrderId, c.paymentId, secret) });
            expect(res.status).toBe(400);
        }
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('signature over payment|order (ids swapped) is rejected', async () => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, razorpay_signature: sig(c.paymentId, c.rzpOrderId) });
        expect(res.status).toBe(400);
    });

    test('signature valid for another payment id cannot be re-used with a different payment id', async () => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, razorpay_payment_id: `pay_${rid()}` });
        expect(res.status).toBe(400);
    });

    test('upper-cased valid signature is rejected (byte-exact compare)', async () => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, razorpay_signature: c.body.razorpay_signature.toUpperCase() });
        expect(res.status).toBe(400);
    });

    test.each([
        ['truncated', (s) => s.slice(0, 10)],
        ['extended', (s) => `${s}00`],
        ['non-hex garbage of equal length', (s) => 'z'.repeat(s.length)],
        ['255 chars', () => 'a'.repeat(255)],
    ])('%s signature → clean 400, never a 5xx (length mismatch must not throw in timingSafeEqual)', async (_l, f) => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, razorpay_signature: f(c.body.razorpay_signature) });
        expect(res.status).toBe(400);
    });

    test.each([
        ['257 chars signature', { razorpay_signature: 'a'.repeat(257) }],
        ['array signature', { razorpay_signature: ['a'] }],
        ['object signature', { razorpay_signature: { $ne: 1 } }],
        ['numeric payment id', { razorpay_payment_id: 12345 }],
        ['object order id', { razorpay_order_id: { $gt: '' } }],
        ['object cafeOrderId', { cafeOrderId: { $ne: null } }],
    ])('malformed body (%s) → 400 and nothing is fetched', async (_l, patch) => {
        const c = await checkout(A);
        const res = await verify(guest(), { ...c.body, ...patch });
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('the comparison is constant-time: crypto.timingSafeEqual runs on equal-length buffers', async () => {
        const spy = jest.spyOn(crypto, 'timingSafeEqual');
        try {
            const c = await checkout(A);
            await verify(guest(), { ...c.body, razorpay_signature: 'f'.repeat(64) });
            expect(spy).toHaveBeenCalled();
            const [a, b] = spy.mock.calls[0];
            expect(a.length).toBe(b.length);
        } finally { spy.mockRestore(); }
    });

    test('a bad signature naming the pending checkout marks the payment failed but never Paid', async () => {
        const c = await checkout(A);
        await verify(guest(), { ...c.body, razorpay_signature: 'f'.repeat(64) });
        const o = await reload(c.order);
        expect(o.paymentStatus).not.toBe('Paid');
        expect(o.amountPaid || 0).toBe(0);
    });

    test('a forged call cannot flip another order to failed (bad signature + foreign rzp order id)', async () => {
        const victim = await checkout(A);
        const before = JSON.stringify(await reload(victim.order));
        await verify(guest(), {
            razorpay_order_id: `order_${rid()}`, razorpay_payment_id: `pay_${rid()}`,
            razorpay_signature: 'f'.repeat(64), cafeOrderId: String(victim.order._id),
        });
        expect(JSON.stringify(await reload(victim.order))).toBe(before);
    });

    test('with no cafeOrderId only the signature is checked (200) and nothing is written', async () => {
        const rzpOrderId = `order_${rid()}`; const paymentId = `pay_${rid()}`;
        const res = await verify(guest(), { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId) });
        expect(res.status).toBe(200);
        expect(await PaymentClaim.countDocuments({ paymentId })).toBe(0);
        const bad = await verify(guest(), { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: 'x'.repeat(64) });
        expect(bad.status).toBe(400);
    });

    test('_mock_ prefixed ids do NOT bypass the signature when mock mode is off', async () => {
        const c = await checkout(A, { razorpayOrderId: 'order_mock_abc123' });
        const res = await verify(guest(), {
            razorpay_order_id: 'order_mock_abc123', razorpay_payment_id: 'pay_mock_abc123',
            razorpay_signature: 'mock_signature_not_verified', cafeOrderId: String(c.order._id),
        });
        expect(res.status).toBe(400);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });
});

// ═══ verify-payment: env keys ════════════════════════════════════════
describe('verify-payment: missing / blank gateway secret', () => {
    const saved = process.env.RAZORPAY_KEY_SECRET;
    afterEach(() => { process.env.RAZORPAY_KEY_SECRET = saved; });

    test('with RAZORPAY_KEY_SECRET unset the endpoint fails closed (5xx) and the order stays unpaid', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        delete process.env.RAZORPAY_KEY_SECRET;
        const res = await verify(guest(), c.body);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    // EXPECTED: a blank RAZORPAY_KEY_SECRET is treated like a missing one (503, as
    // tenantBillingController.verifyUpgradePayment does) — nobody can mint a valid signature.
    // ACTUAL: orderPayment.js:~253 only checks nothing; crypto.createHmac('sha256','') happily
    // signs with an empty key, so a forged HMAC("") signature passes the signature gate (the
    // payment fetch is then the only remaining defence). paymentChecks.isValidCheckoutSignature
    // DOES guard `!secret`; verifyPayment / verifyWalletRecharge do not.
    test('Regression (fixed 2026-11): blank RAZORPAY_KEY_SECRET must not accept a signature forged with an empty key', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        process.env.RAZORPAY_KEY_SECRET = '';
        const forged = crypto.createHmac('sha256', '').update(`${c.rzpOrderId}|${c.paymentId}`).digest('hex');
        const res = await verify(guest(), { ...c.body, razorpay_signature: forged });
        expect(res.status).not.toBe(200);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });
});

// ═══ verify-payment: gateway truth ═══════════════════════════════════
describe('verify-payment: gateway-side facts are authoritative', () => {
    test('payments.fetch failing (timeout) → 502 GATEWAY_UNAVAILABLE, not paid, claim not leaked, retry succeeds', async () => {
        const c = await checkout(A);
        rzp.instance.payments.fetch.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        const r1 = await verify(guest(), c.body);
        expect(r1.status).toBe(502);
        expect(r1.body.code).toBe('GATEWAY_UNAVAILABLE');
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const r2 = await verify(guest(), c.body);
        expect(r2.status).toBe(200);
        expect((await reload(c.order)).paymentStatus).toBe('Paid');
    });

    test('orders.fetch failing → 502 and unpaid', async () => {
        const c = await checkout(A);
        rzp.instance.payments.fetch.mockResolvedValue({ id: c.paymentId, order_id: c.rzpOrderId, status: 'captured', amount: c.paise, currency: 'INR' });
        rzp.instance.orders.fetch.mockRejectedValue(new Error('socket hang up'));
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(502);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('a 502 response is not cached against the Idempotency-Key (retry with the same key re-runs)', async () => {
        const c = await checkout(A);
        const key = `k-${rid()}`;
        rzp.instance.payments.fetch.mockRejectedValueOnce(new Error('boom'));
        expect((await verify(guest(), c.body, key)).status).toBe(502);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const again = await verify(guest(), c.body, key);
        expect(again.status).toBe(200);
    });

    test('gateway returns no payment record → 404 PAYMENT_NOT_FOUND', async () => {
        const c = await checkout(A);
        rzp.instance.payments.fetch.mockResolvedValue(null);
        rzp.instance.orders.fetch.mockResolvedValue({ id: c.rzpOrderId });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
    });

    test.each([['created'], ['failed'], ['refunded']])('payment in "%s" state is not settled (PAYMENT_NOT_CAPTURED)', async (status) => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, status });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_NOT_CAPTURED');
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    // EXPECTED: an 'authorized' (not yet captured) payment does NOT mark the order Paid —
    // tenantBillingController.verifyUpgradePayment refuses it ("wait for the webhook"), and an
    // authorized-but-never-captured payment is auto-voided by Razorpay after ~5 days.
    // ACTUAL: paymentChecks.js:SETTLED_PAYMENT_STATES includes 'authorized', so verify-payment
    // (and the wallet credit) settle on an uncaptured authorization; if the account is not
    // auto-capture the venue serves the food and the money is later released back.
    test('BUG: an authorized-only (uncaptured) payment must not settle the order', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, status: 'authorized' });
        const res = await verify(guest(), c.body);
        expect(res.status).not.toBe(200);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('currency mismatch (USD) is refused even when the number matches', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, currency: 'USD' });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_CURRENCY_MISMATCH');
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test.each([[0], [-100], [undefined], [null], ['abc']])('gateway amount %p → refused (never settles for nothing)', async (amount) => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('underpaid capture (₹400 on a ₹500 order) → AMOUNT_INSUFFICIENT, unpaid, no claim burned', async () => {
        const c = await checkout(A, {}, { paise: 40000 });
        stubGateway({ order: c.order, ...c, amount: 40000 });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_INSUFFICIENT');
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('₹1 rounding tolerance boundary: 49900 paise accepted, 49899 refused', async () => {
        const ok = await checkout(A);
        stubGateway({ order: ok.order, ...ok, amount: 49900 });
        expect((await verify(guest(), ok.body)).status).toBe(200);
        const no = await checkout(A);
        stubGateway({ order: no.order, ...no, amount: 49899 });
        expect((await verify(guest(), no.body)).status).toBe(400);
    });

    // EXPECTED: an overpayment (₹1000 captured for a ₹500 order) is not silently recorded as the
    // order's revenue — amountPaid stays <= total (excess flagged / refunded). ACTUAL:
    // _shared.js:markOrderPaidAtomically sets amountPaid = capturedAmount (1000) while total
    // stays 500: the surplus is neither refunded nor tracked, and revenue reports over-count.
    test('Regression (fixed 2026-11): overpaid capture must not record amountPaid above the order total', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: 100000 });
        await verify(guest(), c.body);
        const o = await reload(c.order);
        expect(o.amountPaid).toBeLessThanOrEqual(o.total);
    });

    test('partial wallet payment + gateway for the rest → method "mixed", amountPaid = prior + captured', async () => {
        const c = await checkout(A, { amountPaid: 200 }, { paise: 30000 });
        stubGateway({ order: c.order, ...c, amount: 30000 });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(200);
        const o = await reload(c.order);
        expect(o.paymentStatus).toBe('Paid');
        expect(o.paymentMethod).toBe('mixed');
        expect(o.amountPaid).toBe(500);
        expect(o.walletAmountPaid).toBe(200);
    });

    test('gateway payment.order_id differs from the checkout named in the body → PAYMENT_ORDER_MISMATCH', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, orderIdOnPayment: `order_${rid()}` });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_ORDER_MISMATCH');
    });

    test('a validly signed checkout of ANOTHER order of the same tenant cannot settle this order', async () => {
        const mine = await checkout(A);
        const other = await checkout(A);
        stubGateway({ order: other.order, ...other, amount: other.paise });
        const res = await verify(guest(), { ...other.body, cafeOrderId: String(mine.order._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RAZORPAY_ORDER_MISMATCH');
        expect((await reload(mine.order)).paymentStatus).not.toBe('Paid');
    });

    test.each([['wallet_recharge'], ['plan_payment'], ['advance-booking-remaining']])('a "%s" payment cannot pay a food order', async (purpose) => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, notes: { purpose, restaurantId: String(A.restaurant._id) } });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_PURPOSE_MISMATCH');
    });

    test('payment notes stamped for tenant B cannot settle tenant A\'s order (403 TENANT_MISMATCH)', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise, notes: { cafeOrderId: String(c.order._id), restaurantId: String(B.restaurant._id) } });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(403);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('deferred order (no stamped checkout): notes.cafeOrderId pointing at a DIFFERENT order is refused', async () => {
        const rzpOrderId = `order_${rid()}`;
        const victim = await mkOrder(A);
        const target = await mkOrder(A);
        const paymentId = `pay_${rid()}`;
        stubGateway({ order: target, rzpOrderId, paymentId, amount: 50000, notes: { cafeOrderId: String(target._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' } });
        const res = await verify(guest(), {
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId,
            razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(victim._id),
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_ORDER_MISMATCH');
        expect((await reload(victim)).paymentStatus).not.toBe('Paid');
    });

    test('deferred order: payment with no restaurantId note is PAYMENT_UNBOUND', async () => {
        const rzpOrderId = `order_${rid()}`; const paymentId = `pay_${rid()}`;
        const o = await mkOrder(A);
        stubGateway({ order: o, rzpOrderId, paymentId, amount: 50000, notes: { cafeOrderId: String(o._id) } });
        const res = await verify(guest(), { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(o._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_UNBOUND');
    });

    test('deferred order: a customer payment stamped with another user is PAYER_MISMATCH', async () => {
        const cust = await createCustomer('pgcv-c2');
        const rzpOrderId = `order_${rid()}`; const paymentId = `pay_${rid()}`;
        const o = await mkOrder(A, { user: cust._id });
        stubGateway({ order: o, rzpOrderId, paymentId, amount: 50000, notes: { cafeOrderId: 'none', restaurantId: String(A.restaurant._id), userId: String(new (require('mongoose').Types.ObjectId)()), payerRole: 'customer' } });
        const res = await verify(guest(), { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(o._id) });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAYER_MISMATCH');
    });
});

// ═══ verify-payment: idempotency / reuse / order state ═══════════════
describe('verify-payment: idempotency, payment reuse, order state', () => {
    test('same Idempotency-Key replays the cached 200 — the gateway is consulted once', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const key = `k-${rid()}`;
        const r1 = await verify(guest(), c.body, key);
        const r2 = await verify(guest(), c.body, key);
        expect(r1.status).toBe(200); expect(r2.status).toBe(200);
        expect(r2.body).toEqual(r1.body);
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(1);
    });

    test('a fresh key for the same already-settled payment is still a clean 200 with no double side effects', async () => {
        const cust = await createCustomer('pgcv-c3');
        const c = await checkout(A, { user: cust._id, total: 600, items: [{ menuItem: A.items.paneer._id, name: 'x', price: 600, quantity: 1 }] }, { paise: 60000 });
        stubGateway({ order: c.order, ...c, amount: 60000 });
        expect((await verify(guest(), c.body)).status).toBe(200);
        expect((await verify(guest(), c.body)).status).toBe(200);
        expect((await verify(guest(), c.body)).status).toBe(200);
        await settle(100);
        const o = await reload(c.order);
        expect(o.payments.filter((p) => p.method === 'razorpay')).toHaveLength(1);
        expect(o.amountPaid).toBe(600);
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(1);
        expect(await Transaction.countDocuments({ order: c.order._id, type: 'points_earned' })).toBe(1);
    });

    test('a DIFFERENT payment id on an already-paid order → 409 ORDER_ALREADY_PAID, original payment id kept', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        await verify(guest(), c.body);
        const second = `pay_${rid()}`;
        stubGateway({ order: c.order, rzpOrderId: c.rzpOrderId, paymentId: second, amount: c.paise });
        const res = await verify(guest(), { ...c.body, razorpay_payment_id: second, razorpay_signature: sig(c.rzpOrderId, second) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_ALREADY_PAID');
        expect((await reload(c.order)).razorpayPaymentId).toBe(c.paymentId);
        expect(await PaymentClaim.countDocuments({ paymentId: second })).toBe(0);
    });

    test('payment id reuse across orders: the second order sharing the checkout id gets 409 PAYMENT_ALREADY_USED', async () => {
        const shared = `order_${rid()}`;
        const o1 = await mkOrder(A, { razorpayOrderId: shared });
        const o2 = await mkOrder(A, { razorpayOrderId: shared });
        const paymentId = `pay_${rid()}`;
        stubGateway({ order: o1, rzpOrderId: shared, paymentId, amount: 50000 });
        const mk = (o) => ({ razorpay_order_id: shared, razorpay_payment_id: paymentId, razorpay_signature: sig(shared, paymentId), cafeOrderId: String(o._id) });
        expect((await verify(guest(), mk(o1))).status).toBe(200);
        const res = await verify(guest(), mk(o2));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect((await reload(o2)).paymentStatus).not.toBe('Paid');
        expect((await reload(o1)).paymentStatus).toBe('Paid');
    });

    test('legacy guard: a payment id already stored on another order is PAYMENT_ALREADY_USED even with no claim row', async () => {
        const c = await checkout(A);
        await mkOrder(A, { razorpayPaymentId: c.paymentId, paymentStatus: 'Paid', amountPaid: 500 });
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
    });

    test('a payment id claimed for a WALLET recharge cannot settle an order', async () => {
        const c = await checkout(A);
        await PaymentClaim.create({ paymentId: c.paymentId, purpose: 'wallet_recharge', ref: String(new (require('mongoose').Types.ObjectId)()), restaurant: A.restaurant._id });
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(409);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('a non-existent / deleted order → 404, gateway not touched, no claim', async () => {
        const c = await checkout(A);
        await Order.deleteOne({ _id: c.order._id });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(404);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
    });

    test('capture for a CANCELLED order: 409 + refund request queued, order stays cancelled, no loyalty/tip', async () => {
        const cust = await createCustomer('pgcv-c4');
        const c = await checkout(A, { user: cust._id, status: 'cancelled', total: 500 });
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const res = await verify(guest(), c.body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_CANCELLED_REFUND_REQUESTED');
        const o = await reload(c.order);
        expect(o.status).toBe('cancelled');
        expect(await RefundRequest.countDocuments({ order: c.order._id })).toBe(1);
        expect(await Transaction.countDocuments({ order: c.order._id, type: 'points_earned' })).toBe(0);
    });

    test('verify on a cancelled order twice never queues two refund requests', async () => {
        const c = await checkout(A, { status: 'cancelled' });
        stubGateway({ order: c.order, ...c, amount: c.paise });
        await verify(guest(), c.body);
        await verify(guest(), c.body);
        expect(await RefundRequest.countDocuments({ order: c.order._id })).toBe(1);
    });

    test('tenant B cannot verify tenant A\'s order with a valid signature (404, untouched)', async () => {
        const c = await checkout(A);
        stubGateway({ order: c.order, ...c, amount: c.paise });
        const res = await verify(ctx.api.guest(B), c.body);
        expect(res.status).toBe(404);
        expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
    });

    test('5 parallel verifies of the same payment settle exactly once (one tender, one claim, one loyalty award)', async () => {
        const cust = await createCustomer('pgcv-c5');
        const c = await checkout(A, { user: cust._id, total: 800, items: [{ menuItem: A.items.paneer._id, name: 'x', price: 800, quantity: 1 }] }, { paise: 80000 });
        stubGateway({ order: c.order, ...c, amount: 80000 });
        const rs = await Promise.all([1, 2, 3, 4, 5].map(() => verify(guest(), c.body)));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        await settle(150);
        const o = await reload(c.order);
        expect(o.payments.filter((p) => p.method === 'razorpay')).toHaveLength(1);
        expect(o.amountPaid).toBe(800);
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(1);
        expect(await Transaction.countDocuments({ order: c.order._id, type: 'points_earned' })).toBe(1);
    });

    test('parallel verifies with DIFFERENT payment ids on one order: exactly one wins, the other gets 409 and is not claimed', async () => {
        const c = await checkout(A);
        const p2 = `pay_${rid()}`;
        rzp.instance.payments.fetch.mockImplementation(async (id) => ({
            id, order_id: c.rzpOrderId, status: 'captured', amount: 50000, currency: 'INR',
            notes: { cafeOrderId: String(c.order._id), restaurantId: String(A.restaurant._id) },
        }));
        rzp.instance.orders.fetch.mockResolvedValue({ id: c.rzpOrderId, notes: { cafeOrderId: String(c.order._id), restaurantId: String(A.restaurant._id) } });
        const rs = await Promise.all([
            verify(guest(), c.body),
            verify(guest(), { ...c.body, razorpay_payment_id: p2, razorpay_signature: sig(c.rzpOrderId, p2) }),
        ]);
        const codes = rs.map((r) => r.status).sort();
        expect(codes).toEqual([200, 409]);
        const o = await reload(c.order);
        expect(o.payments.filter((p) => p.method === 'razorpay')).toHaveLength(1);
        const winner = o.razorpayPaymentId;
        const loser = winner === c.paymentId ? p2 : c.paymentId;
        expect(await PaymentClaim.countDocuments({ paymentId: loser })).toBe(0);
    });

    test('verify-payment demands an Idempotency-Key only when IDEMPOTENCY_ENFORCE is on', async () => {
        const saved = process.env.IDEMPOTENCY_ENFORCE;
        try {
            process.env.IDEMPOTENCY_ENFORCE = 'true';
            const c = await checkout(A);
            stubGateway({ order: c.order, ...c, amount: c.paise });
            const res = await guest().post('/razorpay/verify-payment').send(c.body);
            expect(res.status).toBe(400);
            expect((await reload(c.order)).paymentStatus).not.toBe('Paid');
        } finally {
            if (saved === undefined) delete process.env.IDEMPOTENCY_ENFORCE; else process.env.IDEMPOTENCY_ENFORCE = saved;
        }
    });
});
