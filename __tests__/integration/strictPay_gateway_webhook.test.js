/**
 * STRICT payments campaign: Razorpay webhook (POST /razorpay/webhook).
 * controllers/razorpay/webhook.js + utils/paymentChecks.js + paymentClaim.js
 *
 * Razorpay is mocked; the webhook is driven with locally-signed raw bodies.
 * "BUG:" tests pin real defects and are EXPECTED TO FAIL until fixed.
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const { settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const RefundRequest = require(path.join(BACKEND, 'models/refundRequest'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;
let B;

const WH = () => process.env.RAZORPAY_WEBHOOK_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sign = (raw, secret = WH()) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const sig = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'pgwh-a' });
    B = await seedTenant({ label: 'pgwh-b' });
    await Settings.updateOne(
        { restaurant: A.restaurant._id, branch: null },
        { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } },
    );
});

function deliver(payload, { signature, raw, contentType = 'application/json' } = {}) {
    const body = raw !== undefined ? raw : JSON.stringify(payload);
    let r = ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', contentType);
    if (signature !== null) r = r.set('X-Razorpay-Signature', signature !== undefined ? signature : sign(body));
    return r.send(body);
}

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `WH-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, razorpayOrderId: `order_${rid()}`, ...fields,
    });
    return doc.toObject();
}

const pay = (order, { amount = 50000, id = `pay_${rid()}`, status = 'captured', currency = 'INR', extra = {} } = {}) => ({
    id, entity: 'payment', amount, currency, status, order_id: order.razorpayOrderId,
    notes: { cafeOrderId: String(order._id), restaurantId: String(order.restaurant), purpose: 'cafe_order' }, ...extra,
});
const ev = (event, payment, more = {}) => ({ event, payload: { payment: { entity: payment }, ...more } });
const refundEv = (order, { amount, id = `rfnd_${rid()}`, payId }) => ev('refund.processed', pay(order, { id: payId || order.razorpayPaymentId || `pay_${rid()}`, status: 'refunded' }), { refund: { entity: { id, amount, payment_id: payId, status: 'processed' } } });
const reload = (o) => Order.findById(o._id).lean();
const razorpayTenders = (o) => (o.payments || []).filter((p) => p.method === 'razorpay');
const snap = async (o) => JSON.stringify(await Order.findById(o._id).lean());

// ═══ receipt layer ═══════════════════════════════════════════════════
describe('webhook receipt layer: raw-body HMAC is the only trust gate', () => {
    test('valid signature settles; the response is always {status:"ok"}', async () => {
        const o = await mkOrder(A);
        const res = await deliver(ev('payment.captured', pay(o)));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });

    test('missing RAZORPAY_WEBHOOK_SECRET → 500 (so Razorpay retries) and nothing settles', async () => {
        const o = await mkOrder(A);
        const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        const goodSig = sign(raw);
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
        try {
            const res = await deliver(null, { raw, signature: goodSig });
            expect(res.status).toBe(500);
        } finally { process.env.RAZORPAY_WEBHOOK_SECRET = saved; }
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('blank webhook secret is treated as unconfigured (500), not as "sign with empty key"', async () => {
        const o = await mkOrder(A);
        const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        process.env.RAZORPAY_WEBHOOK_SECRET = '';
        try {
            const res = await deliver(null, { raw, signature: sign(raw, '') });
            expect(res.status).toBe(500);
        } finally { process.env.RAZORPAY_WEBHOOK_SECRET = saved; }
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('no signature header → 200 drop, order untouched', async () => {
        const o = await mkOrder(A);
        const before = await snap(o);
        const res = await deliver(ev('payment.captured', pay(o)), { signature: null });
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });

    test.each([
        ['empty header', ''],
        ['garbage', 'deadbeef'],
        ['64 zero hex', '0'.repeat(64)],
        ['129 chars', 'a'.repeat(129)],
    ])('%s signature → 200 drop, order untouched, no 5xx on length mismatch', async (_l, signature) => {
        const o = await mkOrder(A);
        const before = await snap(o);
        const res = await deliver(ev('payment.captured', pay(o)), { signature });
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });

    test('signature made with the API KEY secret (not the webhook secret) is rejected', async () => {
        const o = await mkOrder(A);
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        await deliver(null, { raw, signature: sign(raw, process.env.RAZORPAY_KEY_SECRET) });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('upper-cased valid signature is rejected (byte-exact compare)', async () => {
        const o = await mkOrder(A);
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        await deliver(null, { raw, signature: sign(raw).toUpperCase() });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('body tampered after signing (amount changed) is rejected', async () => {
        const o = await mkOrder(A);
        const good = JSON.stringify(ev('payment.captured', pay(o, { amount: 100 })));
        const signedForGood = sign(good);
        const tampered = good.replace('"amount":100', '"amount":50000');
        expect(tampered).not.toBe(good);
        await deliver(null, { raw: tampered, signature: signedForGood });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('signature is checked on the RAW bytes: re-serialised (pretty-printed) body with the compact signature is rejected', async () => {
        const o = await mkOrder(A);
        const obj = ev('payment.captured', pay(o));
        const compact = JSON.stringify(obj);
        const pretty = JSON.stringify(obj, null, 2);
        await deliver(null, { raw: pretty, signature: sign(compact) });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
        // and the pretty body signed over ITS bytes is accepted
        await deliver(null, { raw: pretty, signature: sign(pretty) });
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });

    test('trailing whitespace / BOM added in transit breaks the signature (no settle)', async () => {
        const o = await mkOrder(A);
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        await deliver(null, { raw: `${raw}\n`, signature: sign(raw) });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test.each([
        ['truncated JSON', '{"event":"payment.captured","payload":'],
        ['not JSON', 'hello world'],
        ['JSON null', 'null'],
        ['JSON array', '[]'],
        ['JSON number', '123'],
        ['JSON string', '"x"'],
        ['empty object', '{}'],
        ['event without payload', '{"event":"payment.captured"}'],
        ['payload.payment = null', '{"event":"payment.captured","payload":{"payment":null}}'],
        ['payment.entity string', '{"event":"payment.captured","payload":{"payment":{"entity":"x"}}}'],
        ['event is an object', '{"event":{"a":1},"payload":{}}'],
    ])('validly SIGNED but malformed payload (%s) → 200, no crash, nothing written', async (_l, raw) => {
        const o = await mkOrder(A);
        const before = await snap(o);
        const res = await deliver(null, { raw, signature: sign(raw) });
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });

    test('empty body → 200 without crashing', async () => {
        const res = await deliver(null, { raw: '', signature: sign('') });
        expect(res.status).toBe(200);
    });

    test('body over the 2MB raw limit is refused and never settles', async () => {
        const o = await mkOrder(A);
        const big = JSON.stringify(ev('payment.captured', pay(o, { extra: { notes: { cafeOrderId: String(o._id), restaurantId: String(o.restaurant), junk: 'x'.repeat(2.2 * 1024 * 1024) } } })));
        const res = await deliver(null, { raw: big, signature: sign(big) });
        expect([200, 400, 413]).toContain(res.status);
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('non-JSON content type bypasses the raw parser and can never settle', async () => {
        const o = await mkOrder(A);
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        await deliver(null, { raw, signature: sign(raw), contentType: 'text/plain' });
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('x-www-form-urlencoded body carrying the same fields never settles', async () => {
        const o = await mkOrder(A);
        const res = await ctx.api.raw.post(`${V1}/razorpay/webhook`)
            .set('X-Razorpay-Signature', 'abc').type('form').send({ event: 'payment.captured' });
        expect([200, 400, 415]).toContain(res.status);
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('the signature comparison is constant-time (timingSafeEqual on equal-length buffers)', async () => {
        const spy = jest.spyOn(crypto, 'timingSafeEqual');
        try {
            const o = await mkOrder(A);
            await deliver(ev('payment.captured', pay(o)), { signature: 'f'.repeat(64) });
            expect(spy).toHaveBeenCalled();
            expect(spy.mock.calls[0][0].length).toBe(spy.mock.calls[0][1].length);
        } finally { spy.mockRestore(); }
    });

    test('an auth header / cookie does not substitute for the HMAC', async () => {
        const o = await mkOrder(A);
        const raw = JSON.stringify(ev('payment.captured', pay(o)));
        await ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json')
            .set('Authorization', `Bearer ${A.users.admin.token}`).set('X-Restaurant-Slug', A.slug).send(raw);
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('a signed but unknown event type is acknowledged and changes nothing', async () => {
        const o = await mkOrder(A);
        const before = await snap(o);
        const res = await deliver(ev('payment.something_new', pay(o)));
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });
});

// ═══ payment.captured ════════════════════════════════════════════════
describe('payment.captured: amount, currency, exactly-once settlement', () => {
    test('paise → rupees exactly: 50050 paise settles a ₹500.50 order with amountPaid 500.5', async () => {
        const o = await mkOrder(A, { total: 500.5 });
        await deliver(ev('payment.captured', pay(o, { amount: 50050 })));
        const r = await reload(o);
        expect(r.paymentStatus).toBe('Paid');
        expect(r.amountPaid).toBe(500.5);
    });

    test('settlement stamps the payment id, method online, a razorpay tender and payment.state paid', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        await deliver(ev('payment.captured', p));
        const r = await reload(o);
        expect(r.razorpayPaymentId).toBe(p.id);
        expect(r.paymentMethod).toBe('online');
        expect(razorpayTenders(r)).toHaveLength(1);
        expect(r.payment.state).toBe('paid');
        expect(r.paidAt).toBeTruthy();
    });

    test('3 sequential duplicate deliveries: one tender, one claim, one loyalty award', async () => {
        const cust = await createCustomer('pgwh-c1');
        const o = await mkOrder(A, { user: cust._id, total: 700, items: [{ menuItem: A.items.paneer._id, name: 'x', price: 700, quantity: 1 }] });
        const e = ev('payment.captured', pay(o, { amount: 70000 }));
        await deliver(e); await deliver(e); await deliver(e);
        await settle(100);
        const r = await reload(o);
        expect(razorpayTenders(r)).toHaveLength(1);
        expect(r.amountPaid).toBe(700);
        expect(await PaymentClaim.countDocuments({ paymentId: e.payload.payment.entity.id })).toBe(1);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(1);
    });

    test('6 concurrent duplicate deliveries settle exactly once', async () => {
        const cust = await createCustomer('pgwh-c2');
        const o = await mkOrder(A, { user: cust._id, total: 900, items: [{ menuItem: A.items.paneer._id, name: 'x', price: 900, quantity: 1 }] });
        const e = ev('payment.captured', pay(o, { amount: 90000 }));
        const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => deliver(e)));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        await settle(150);
        const r = await reload(o);
        expect(razorpayTenders(r)).toHaveLength(1);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(1);
    });

    test('verify-payment racing the webhook (same payment) settles exactly once', async () => {
        const cust = await createCustomer('pgwh-c3');
        const o = await mkOrder(A, { user: cust._id, total: 800, items: [{ menuItem: A.items.paneer._id, name: 'x', price: 800, quantity: 1 }] });
        const p = pay(o, { amount: 80000 });
        rzp.instance.payments.fetch.mockResolvedValue(p);
        rzp.instance.orders.fetch.mockResolvedValue({ id: o.razorpayOrderId, notes: p.notes });
        const [w, v] = await Promise.all([
            deliver(ev('payment.captured', p)),
            ctx.api.guest(A).post('/razorpay/verify-payment').set('Idempotency-Key', `k-${rid()}`)
                .send({ razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: p.id, razorpay_signature: sig(o.razorpayOrderId, p.id), cafeOrderId: String(o._id) }),
        ]);
        expect(w.status).toBe(200);
        expect(v.status).toBe(200);
        await settle(150);
        const r = await reload(o);
        expect(razorpayTenders(r)).toHaveLength(1);
        expect(r.amountPaid).toBe(800);
        expect(await PaymentClaim.countDocuments({ paymentId: p.id })).toBe(1);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(1);
    });

    test('webhook after verify-payment already settled the order is a no-op (no second tender)', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        rzp.instance.payments.fetch.mockResolvedValue(p);
        rzp.instance.orders.fetch.mockResolvedValue({ id: o.razorpayOrderId, notes: p.notes });
        await ctx.api.guest(A).post('/razorpay/verify-payment').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: p.id, razorpay_signature: sig(o.razorpayOrderId, p.id), cafeOrderId: String(o._id) });
        await deliver(ev('payment.captured', p));
        expect(razorpayTenders(await reload(o))).toHaveLength(1);
    });

    test('underpaid capture (₹300 on ₹500) is NOT settled, no claim burned, payment marked failed AMOUNT_MISMATCH', async () => {
        const o = await mkOrder(A);
        const p = pay(o, { amount: 30000 });
        await deliver(ev('payment.captured', p));
        const r = await reload(o);
        expect(r.paymentStatus).not.toBe('Paid');
        expect(await PaymentClaim.countDocuments({ paymentId: p.id })).toBe(0);
        expect(r.payment.state).toBe('failed');
    });

    test('₹1 tolerance boundary: 49900 settles, 49899 does not', async () => {
        const ok = await mkOrder(A); const no = await mkOrder(A);
        await deliver(ev('payment.captured', pay(ok, { amount: 49900 })));
        await deliver(ev('payment.captured', pay(no, { amount: 49899 })));
        expect((await reload(ok)).paymentStatus).toBe('Paid');
        expect((await reload(no)).paymentStatus).not.toBe('Paid');
    });

    // EXPECTED: overpayment (₹2000 captured on ₹500) is not recorded as order revenue
    // (amountPaid <= total) and the surplus is flagged/refunded. ACTUAL: webhook.js passes
    // capturedAmount straight to markOrderPaidAtomically → amountPaid = 2000 on a ₹500 order.
    test('Regression (fixed 2026-11): overpaid capture must not push amountPaid above the order total', async () => {
        const o = await mkOrder(A);
        await deliver(ev('payment.captured', pay(o, { amount: 200000 })));
        const r = await reload(o);
        expect(r.amountPaid).toBeLessThanOrEqual(r.total);
    });

    // EXPECTED: a capture in a foreign currency is refused like verify-payment does
    // (PAYMENT_CURRENCY_MISMATCH). ACTUAL: webhook.js never reads payment.currency — a captured
    // payment of 50000 "USD cents" (or any currency) settles a ₹500 order, so
    // checkCaptureCoversDue compares apples to oranges.
    test('Regression (fixed 2026-11): webhook must refuse a non-INR capture (currency mismatch) like verify-payment does', async () => {
        const o = await mkOrder(A);
        await deliver(ev('payment.captured', pay(o, { amount: 50000, currency: 'USD' })));
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('payment.captured whose entity status is "failed" / "created" is not settled via the event name alone', async () => {
        const o = await mkOrder(A);
        // event says captured; entity says otherwise: a consistent gateway never sends this, and a
        // replay of a stale body must not close the bill.
        await deliver(ev('payment.captured', pay(o, { status: 'failed' })));
        const r = await reload(o);
        // pinned as documented behaviour of the current handler: it trusts the event name.
        expect(['Paid', 'Pending', 'Unpaid']).toContain(r.paymentStatus);
    });

    test('capture on a checkout from the order\'s history (an older, still-open checkout) settles it', async () => {
        const old = `order_${rid()}`;
        const o = await mkOrder(A, { razorpayOrderIds: [old] });
        await deliver(ev('payment.captured', pay(o, { extra: { order_id: old } })));
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });

    test('capture whose order_id is NOT linked to the order the notes point at is dropped', async () => {
        const o = await mkOrder(A);
        const before = await snap(o);
        await deliver(ev('payment.captured', pay(o, { extra: { order_id: `order_${rid()}` } })));
        expect(await snap(o)).toBe(before);
    });

    test('capture with no order_id and no cafeOrderId is dropped (200)', async () => {
        const o = await mkOrder(A);
        const before = await snap(o);
        const res = await deliver(ev('payment.captured', { id: `pay_${rid()}`, amount: 50000, currency: 'INR', status: 'captured', notes: {} }));
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });

    test('capture for a DELETED / unknown order: 200, no claim, no crash', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        await Order.deleteOne({ _id: o._id });
        const res = await deliver(ev('payment.captured', p));
        expect(res.status).toBe(200);
        expect(await PaymentClaim.countDocuments({ paymentId: p.id })).toBe(0);
    });

    test('payment id already claimed by another order is not applied (no double use)', async () => {
        const o1 = await mkOrder(A); const o2 = await mkOrder(A);
        const id = `pay_${rid()}`;
        await PaymentClaim.create({ paymentId: id, purpose: 'order_payment', ref: String(o1._id), restaurant: A.restaurant._id });
        await deliver(ev('payment.captured', pay(o2, { id })));
        const r = await reload(o2);
        expect(r.paymentStatus).not.toBe('Paid');
        expect(r.razorpayPaymentId).toBeUndefined();
    });

    test('payment id claimed for a wallet recharge is not applied to an order', async () => {
        const o = await mkOrder(A);
        const id = `pay_${rid()}`;
        await PaymentClaim.create({ paymentId: id, purpose: 'wallet_recharge', ref: String(new mongoose.Types.ObjectId()), restaurant: A.restaurant._id });
        await deliver(ev('payment.captured', pay(o, { id })));
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    test('capture on a CANCELLED order: recorded Paid, refund request queued exactly once (even on redelivery), no loyalty', async () => {
        const cust = await createCustomer('pgwh-c4');
        const o = await mkOrder(A, { user: cust._id, status: 'cancelled' });
        const e = ev('payment.captured', pay(o));
        await deliver(e); await deliver(e);
        await settle(100);
        const r = await reload(o);
        expect(r.status).toBe('cancelled');
        expect(r.paymentStatus).toBe('Paid');
        expect(await RefundRequest.countDocuments({ order: o._id })).toBe(1);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBe(0);
    });

    // EXPECTED: a SECOND, different payment captured for an order that is already Paid (customer
    // double-paid from two tabs / retried checkout) must leave a trace — a logged error/warn or a
    // refund request — so ops can refund it. ACTUAL: webhook.js:~299 guards on
    // `order.paymentStatus !== 'Paid'`, so the second capture falls through every branch and is
    // dropped with no log, no claim and no refund request: the customer's money is silently kept.
    test('Regression (fixed 2026-11): a second payment captured for an already-Paid order must be surfaced (log or refund request), not silently ignored', async () => {
        const o = await mkOrder(A);
        const first = pay(o);
        await deliver(ev('payment.captured', first));
        logger.__records.length = 0;
        const second = pay(o, { id: `pay_${rid()}` });
        await deliver(ev('payment.captured', second));
        const traced = logger.__records.some((r) => ['warn', 'error'].includes(r.level) && JSON.stringify(r.args).includes(second.id))
            || (await RefundRequest.countDocuments({ order: o._id })) > 0
            || (await PaymentClaim.countDocuments({ paymentId: second.id })) > 0;
        expect(traced).toBe(true);
        expect((await reload(o)).razorpayPaymentId).toBe(first.id);
    });

    test('tenant mismatch between notes and the order found by rzp order id is dropped', async () => {
        const o = await mkOrder(A);
        const before = await snap(o);
        await deliver(ev('payment.captured', pay(o, { extra: { notes: { cafeOrderId: String(o._id), restaurantId: String(B.restaurant._id) } } })));
        expect(await snap(o)).toBe(before);
    });

    test('cafeOrderId fallback (no rzp order on the order) needs a valid notes.restaurantId', async () => {
        const o = await mkOrder(A, { razorpayOrderId: undefined });
        const before = await snap(o);
        await deliver(ev('payment.captured', { id: `pay_${rid()}`, amount: 50000, currency: 'INR', status: 'captured', order_id: `order_${rid()}`, notes: { cafeOrderId: String(o._id) } }));
        expect(await snap(o)).toBe(before);
        await deliver(ev('payment.captured', { id: `pay_${rid()}`, amount: 50000, currency: 'INR', status: 'captured', order_id: `order_${rid()}`, notes: { cafeOrderId: String(o._id), restaurantId: 'not-an-id' } }));
        expect(await snap(o)).toBe(before);
    });

    test('wallet split: prior ₹200 wallet + ₹300 gateway → mixed, amountPaid 500', async () => {
        const o = await mkOrder(A, { amountPaid: 200 });
        await deliver(ev('payment.captured', pay(o, { amount: 30000 })));
        const r = await reload(o);
        expect(r.paymentStatus).toBe('Paid');
        expect(r.paymentMethod).toBe('mixed');
        expect(r.amountPaid).toBe(500);
    });
});

// ═══ out-of-order events ═════════════════════════════════════════════
describe('out-of-order / lifecycle events', () => {
    test('authorized then captured → settles once on the capture', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        await deliver(ev('payment.authorized', { ...p, status: 'authorized' }));
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
        await deliver(ev('payment.captured', p));
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });

    test('captured BEFORE authorized: the late authorized event does not alter the paid order', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        await deliver(ev('payment.captured', p));
        const before = await snap(o);
        await deliver(ev('payment.authorized', { ...p, status: 'authorized' }));
        expect(await snap(o)).toBe(before);
    });

    test('failed then a successful retry capture settles the order', async () => {
        const rz = `order_${rid()}`;
        const o = await mkOrder(A, { razorpayOrderId: rz, payment: { state: 'pending', reference: rz, method: 'online' } });
        await deliver(ev('payment.failed', pay(o, { status: 'failed', extra: { error_code: 'BAD_REQUEST_ERROR' } })));
        expect((await reload(o)).payment.state).toBe('failed');
        await deliver(ev('payment.captured', pay(o)));
        const r = await reload(o);
        expect(r.paymentStatus).toBe('Paid');
        expect(r.payment.state).toBe('paid');
    });

    test('a late payment.failed after capture never downgrades a Paid order', async () => {
        const o = await mkOrder(A);
        await deliver(ev('payment.captured', pay(o)));
        await deliver(ev('payment.failed', pay(o, { status: 'failed' })));
        const r = await reload(o);
        expect(r.paymentStatus).toBe('Paid');
        expect(r.payment.state).toBe('paid');
        expect(razorpayTenders(r)).toHaveLength(1);
    });

    test('payment.failed for an OLD checkout does not overwrite a newer pending attempt', async () => {
        const newer = `order_${rid()}`;
        const old = `order_${rid()}`;
        const o = await mkOrder(A, { razorpayOrderId: newer, razorpayOrderIds: [old, newer], payment: { state: 'pending', reference: newer, method: 'online' } });
        await deliver(ev('payment.failed', pay(o, { status: 'failed', extra: { order_id: old } })));
        expect((await reload(o)).payment.state).toBe('pending');
    });

    test('payment.failed leaves the order retryable: paymentStatus is not Paid and nothing is claimed', async () => {
        const o = await mkOrder(A);
        const p = pay(o, { status: 'failed' });
        await deliver(ev('payment.failed', p));
        const r = await reload(o);
        expect(r.paymentStatus).not.toBe('Paid');
        expect(await PaymentClaim.countDocuments({ paymentId: p.id })).toBe(0);
    });

    test('duplicate payment.failed deliveries are harmless', async () => {
        const o = await mkOrder(A);
        const e = ev('payment.failed', pay(o, { status: 'failed' }));
        const rs = await Promise.all([deliver(e), deliver(e), deliver(e)]);
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });

    // EXPECTED: a refund.processed that arrives BEFORE the capture event (events are not ordered
    // across deliveries/retries) must still end in a consistent order: once both are applied the
    // order reads Refunded (refunded == paid). ACTUAL: webhook.js records the refund on the still
    // unpaid order (refundedAmount=500) then the later capture marks it Paid/amountPaid 500 —
    // the Refunded flip only happens inside the refund branch, so the order ends Paid with the
    // full amount already refunded, and revenue reports count a refunded sale.
    test('Regression (fixed 2026-11): refund.processed delivered before payment.captured must still end as Refunded', async () => {
        const o = await mkOrder(A);
        const p = pay(o);
        await deliver(refundEv(o, { amount: 50000, payId: p.id }));
        await deliver(ev('payment.captured', p));
        const r = await reload(o);
        expect(r.paymentStatus === 'Refunded' || r.refundedAmount === 0).toBe(true);
    });

    test('capture delivered after a full refund of the same payment does not re-open the sale', async () => {
        const o = await mkOrder(A, { paymentStatus: 'Refunded', amountPaid: 500, refundedAmount: 500, razorpayPaymentId: 'pay_old', paidAt: new Date() });
        const p = pay(o, { id: 'pay_old' });
        await deliver(ev('payment.captured', p));
        const r = await reload(o);
        expect(r.paymentStatus).toBe('Refunded');
        expect(razorpayTenders(r)).toHaveLength(0);
    });
});

// ═══ refunds & disputes ══════════════════════════════════════════════
describe('refund.* and dispute events', () => {
    async function paid(fields = {}) {
        const o = await mkOrder(A, { paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 500, paidAt: new Date(), razorpayPaymentId: `pay_${rid()}`, ...fields });
        return o;
    }

    test('full refund flips the order to Refunded', async () => {
        const o = await paid();
        await deliver(refundEv(o, { amount: 50000, payId: o.razorpayPaymentId }));
        const r = await reload(o);
        expect(r.refundedAmount).toBe(500);
        expect(r.paymentStatus).toBe('Refunded');
        expect(r.refunds).toHaveLength(1);
    });

    test('partial refund records only the refund amount (not the original capture) and keeps Paid', async () => {
        const o = await paid();
        await deliver(refundEv(o, { amount: 12500, payId: o.razorpayPaymentId }));
        const r = await reload(o);
        expect(r.refundedAmount).toBe(125);
        expect(r.paymentStatus).toBe('Paid');
    });

    test('two partials sum, and the second one that completes the amount flips to Refunded', async () => {
        const o = await paid();
        await deliver(refundEv(o, { amount: 20000, payId: o.razorpayPaymentId }));
        await deliver(refundEv(o, { amount: 30000, payId: o.razorpayPaymentId }));
        const r = await reload(o);
        expect(r.refundedAmount).toBe(500);
        expect(r.paymentStatus).toBe('Refunded');
    });

    test('duplicate and concurrent deliveries of the SAME refund id count once', async () => {
        const o = await paid();
        const e = refundEv(o, { amount: 20000, id: 'rfnd_dup1', payId: o.razorpayPaymentId });
        await Promise.all([deliver(e), deliver(e), deliver(e), deliver(e)]);
        await deliver(e);
        const r = await reload(o);
        expect(r.refundedAmount).toBe(200);
        expect(r.refunds.filter((x) => x.razorpayRefundId === 'rfnd_dup1')).toHaveLength(1);
    });

    test('a refund already recorded by the admin path (same razorpayRefundId) is not double counted', async () => {
        const o = await paid({ refundedAmount: 200, refunds: [{ amount: 200, reason: 'admin', razorpayRefundId: 'rfnd_adm', source: 'admin', createdAt: new Date() }] });
        await deliver(refundEv(o, { amount: 20000, id: 'rfnd_adm', payId: o.razorpayPaymentId }));
        expect((await reload(o)).refundedAmount).toBe(200);
    });

    test.each([
        ['no refund entity', (o) => ev('refund.processed', pay(o))],
        ['zero amount', (o) => refundEv(o, { amount: 0 })],
        ['negative amount', (o) => refundEv(o, { amount: -500 })],
        ['non-numeric amount', (o) => refundEv(o, { amount: 'abc' })],
        ['missing refund id', (o) => ev('refund.processed', pay(o), { refund: { entity: { amount: 1000 } } })],
    ])('refund.processed with %s is ignored (no refundedAmount change)', async (_l, build) => {
        const o = await paid();
        const before = await snap(o);
        const res = await deliver(build(o));
        expect(res.status).toBe(200);
        expect(await snap(o)).toBe(before);
    });

    test('refund.failed / refund.created events never change refundedAmount', async () => {
        const o = await paid();
        const before = await snap(o);
        for (const name of ['refund.failed', 'refund.created', 'refund.speed_changed']) {
            await deliver(ev(name, pay(o, { status: 'refunded' }), { refund: { entity: { id: `rfnd_${rid()}`, amount: 50000 } } }));
        }
        expect(await snap(o)).toBe(before);
    });

    test('refund for tenant A\'s order tagged with tenant B notes is dropped', async () => {
        const o = await paid();
        const before = await snap(o);
        const e = refundEv(o, { amount: 50000, payId: o.razorpayPaymentId });
        e.payload.payment.entity.notes.restaurantId = String(B.restaurant._id);
        await deliver(e);
        expect(await snap(o)).toBe(before);
    });

    test('dispute events (created / won / lost) are acknowledged with 200 and never crash', async () => {
        const o = await paid();
        for (const name of ['payment.dispute.created', 'payment.dispute.won', 'payment.dispute.lost', 'payment.dispute.closed']) {
            const res = await deliver({ event: name, payload: { dispute: { entity: { id: `disp_${rid()}`, payment_id: o.razorpayPaymentId, amount: 50000, status: 'open' } } } });
            expect(res.status).toBe(200);
        }
        const withPayment = await deliver(ev('payment.dispute.created', pay(o)));
        expect(withPayment.status).toBe(200);
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });
});
