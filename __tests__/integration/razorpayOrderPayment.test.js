/**
 * POST /api/v1/razorpay/create-order and /api/v1/razorpay/verify-payment
 * — controllers/razorpayController.js (createRazorpayOrder, verifyPayment).
 *
 * create-order opens a Razorpay checkout for a cafe order; verify-payment
 * turns the browser's checkout result into a Paid order. Together they are
 * the primary online-payment path (the webhook is the safety net, see
 * razorpayWebhook.test.js).
 *
 * Coverage:
 *   - create-order: notes stamped (tenant / payer / scan session), paise
 *     conversion, receipt length, razorpayOrderId stamping, amount rules,
 *     input validation, cross-tenant cafeOrderId, gateway failure
 *   - verify-payment: checkout HMAC, gateway fail-closed, payment/order
 *     binding (capture state, currency, purpose, tenant, payer, amount
 *     tolerance), single-use payment ids, replay + Idempotency-Key,
 *     wallet split, side effects (loyalty, tip, sibling rounds, table,
 *     notification), cross-tenant order lookup
 *   - mock gateway: never bypasses the signature in production or when off
 *
 * Tests whose name starts with "BUG:" pin behaviour the handlers get
 * wrong today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Table = require(path.join(BACKEND, 'models/table'));
const Tip = require(path.join(BACKEND, 'models/tip'));

const ctx = useIntegrationApp();
let A;
let B;

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const checkoutSig = (rzpOrderId, paymentId, secret = KEY_SECRET) =>
    crypto.createHmac('sha256', secret).update(`${rzpOrderId}|${paymentId}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'pay-a' });
    B = await seedTenant({ label: 'pay-b' });
    await Settings.updateOne(
        { restaurant: A.restaurant._id, branch: null },
        { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } },
    );
});

// ── Helpers ──────────────────────────────────────────────────────────

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `PAY-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        ...fields,
    });
    return doc.toObject();
}

/** Razorpay orders.create echo: returns what the real API would. */
function stubOrdersCreate() {
    rzp.instance.orders.create.mockImplementation(async (opts) => ({
        id: `order_${rid()}`,
        entity: 'order',
        amount: opts.amount,
        currency: opts.currency,
        receipt: opts.receipt,
        notes: opts.notes,
        status: 'created',
    }));
}

/**
 * Stub payments.fetch / orders.fetch for one checkout. Order notes default
 * to the server-stamped cafe-order notes for `order`.
 */
function stubGateway({ order, rzpOrderId, paymentId, amount, status = 'captured', currency = 'INR', notes }) {
    const n = notes !== undefined ? notes : {
        cafeOrderId: String(order._id),
        restaurantId: String(order.restaurant),
        purpose: 'cafe_order',
    };
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: rzpOrderId, status, amount, currency, notes: n,
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount, notes: n });
}

/** An order with a stamped checkout, plus the ids + signature the browser would hold. */
async function checkoutFor(t, fields = {}, { amount } = {}) {
    const rzpOrderId = `order_${rid()}`;
    const order = await makeOrder(t, { razorpayOrderId: rzpOrderId, ...fields });
    const paymentId = `pay_${rid()}`;
    const paise = amount !== undefined ? amount : Math.round(order.total * 100);
    return {
        order,
        rzpOrderId,
        paymentId,
        paise,
        body: {
            razorpay_order_id: rzpOrderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId),
            cafeOrderId: String(order._id),
        },
    };
}

const create = (client, body) => client.post('/razorpay/create-order').send(body);
const verify = (client, body, headers = {}) => {
    let r = client.post('/razorpay/verify-payment');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
};
const reload = (order) => Order.findById(order._id).lean();
const pointsRows = (order) => Transaction.find({ order: order._id, type: 'points_earned' }).lean();

// ── create-order ─────────────────────────────────────────────────────

describe('POST /razorpay/create-order', () => {
    beforeEach(stubOrdersCreate);

    test('opens a checkout in paise, stamps tenant + payer notes and links it to the order', async () => {
        const cust = await createCustomer('c-create');
        const order = await makeOrder(A, { user: cust._id, total: 512.4 });

        const res = await create(ctx.api.as(cust, A), { amount: 512.4, cafeOrderId: String(order._id) });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.key).toBe(process.env.RAZORPAY_KEY_ID);
        expect(res.body.razorpayOrder).toMatchObject({ amount: 51240, currency: 'INR' });
        expect(res.body.mock).toBeUndefined();

        const opts = rzp.instance.orders.create.mock.calls[0][0];
        expect(opts.amount).toBe(51240);
        expect(opts.currency).toBe('INR');
        expect(opts.receipt.length).toBeLessThanOrEqual(40);
        expect(opts.notes).toEqual({
            cafeOrderId: String(order._id),
            restaurantId: String(A.restaurant._id),
            purpose: 'cafe_order',
            userId: String(cust._id),
            payerRole: 'customer',
        });

        expect((await reload(order)).razorpayOrderId).toBe(res.body.razorpayOrder.id);
    });

    test.each([
        [512.4, 51240],
        [19.99, 1999],
        [1.15, 115],
        [4.35, 435],
        [0.1 + 0.2 + 99.7, 10000],
    ])('converts ₹%d to exactly %i paise', async (amount, paise) => {
        const res = await create(ctx.api.guest(A), { amount });
        expect(res.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0].amount).toBe(paise);
    });

    test('a guest checkout carries the verified scan session and no user id', async () => {
        const table = await createTable(A);
        const { scanToken, sessionId } = await scanTable(ctx.api, table);
        expect(scanToken).toBeTruthy();

        const res = await create(ctx.api.guest(A, scanToken), { amount: 250 });

        expect(res.status).toBe(200);
        const { notes } = rzp.instance.orders.create.mock.calls[0][0];
        expect(notes.scanSessionId).toBe(String(sessionId));
        expect(notes.userId).toBeUndefined();
        expect(notes.cafeOrderId).toBe('none');
    });

    test('a caller-supplied receipt is clamped to Razorpay’s 40-character limit', async () => {
        const res = await create(ctx.api.guest(A), { amount: 100, receipt: 'r'.repeat(100) });
        expect(res.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0].receipt).toBe('r'.repeat(40));
    });

    test('an invalid scan token is never stamped as the payer session', async () => {
        const res = await create(ctx.api.guest(A, 'not-a-real-scan-token'), { amount: 100 });
        expect(res.status).toBe(200);
        expect(rzp.instance.orders.create.mock.calls[0][0].notes.scanSessionId).toBeUndefined();
    });

    test('a deferred checkout (no cafeOrderId) links nothing', async () => {
        const res = await create(ctx.api.guest(A), { amount: 300 });

        expect(res.status).toBe(200);
        expect(await Order.countDocuments({ razorpayOrderId: res.body.razorpayOrder.id })).toBe(0);
    });

    test("staff can open a checkout for a customer's order and are stamped as the payer", async () => {
        const cust = await createCustomer('c-staff');
        const order = await makeOrder(A, { user: cust._id });

        const res = await create(ctx.api.as(A.users.waiter), { amount: 500, cafeOrderId: order.orderId });

        expect(res.status).toBe(200);
        const { notes } = rzp.instance.orders.create.mock.calls[0][0];
        expect(notes.payerRole).toBe('waiter');
        expect(notes.userId).toBe(String(A.users.waiter._id));
    });

    test.each([
        ['zero', 0],
        ['negative', -100],
        ['a numeric string', '500'],
        ['null', null],
        ['above ₹1 crore', 10_000_001],
        ['an object', { $gt: 0 }],
    ])('rejects an amount that is %s without calling the gateway', async (_label, amount) => {
        const res = await create(ctx.api.guest(A), { amount });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    // Regression (fixed 2026-10): create-order enforces the ₹1 floor before the gateway.
    test('rejects an amount below ₹1 with 400 before calling the gateway', async () => {
        const res = await create(ctx.api.guest(A), { amount: 0.5 });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test.each([
        ['an operator object', { $ne: null }],
        ['an array', ['x']],
        ['an over-long string', 'x'.repeat(101)],
    ])('rejects a cafeOrderId that is %s', async (_label, cafeOrderId) => {
        const res = await create(ctx.api.guest(A), { amount: 500, cafeOrderId });
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test("cannot open a checkout against another tenant's order", async () => {
        const foreign = await makeOrder(B);

        const byId = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(foreign._id) });
        const byNumber = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: foreign.orderId });

        expect(byId.status).toBe(404);
        expect(byId.body.code).toBe('ORDER_NOT_FOUND');
        expect(byNumber.status).toBe(404);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
        expect((await reload(foreign)).razorpayOrderId).toBeUndefined();
    });

    test('requires a tenant', async () => {
        const res = await create(ctx.api.anon(), { amount: 500 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test.each([
        [499, 200],
        [498.99, 400],
        [100, 400],
    ])('for a ₹500 order, a checkout of ₹%d answers %i', async (amount, status) => {
        const order = await makeOrder(A);
        const res = await create(ctx.api.guest(A), { amount, cafeOrderId: String(order._id) });
        expect(res.status).toBe(status);
        if (status === 400) {
            expect(res.body.code).toBe('AMOUNT_MISMATCH');
            expect(rzp.instance.orders.create).not.toHaveBeenCalled();
        }
    });

    // Regression (fixed 2026-10): create-order compares against total − amountPaid.
    test('a partly wallet-paid order can open a checkout for the remaining due', async () => {
        const order = await makeOrder(A, { total: 500, amountPaid: 200, paymentStatus: 'Partially Paid' });

        const res = await create(ctx.api.guest(A), { amount: 300, cafeOrderId: String(order._id) });

        expect(res.status).toBe(200);
    });

    // Regression (fixed 2026-10): decision 4b — no checkout is opened for an
    // order that can no longer take the money (paid / refunded / cancelled);
    // refused with a 409 code before the gateway is called.
    test.each([
        ['already paid', { paymentStatus: 'Paid', amountPaid: 500, paymentMethod: 'cash' }, 'ORDER_ALREADY_PAID'],
        ['refunded', { paymentStatus: 'Refunded', amountPaid: 500, refundedAmount: 500, paymentMethod: 'online' }, 'ORDER_ALREADY_PAID'],
        ['cancelled', { status: 'cancelled' }, 'ORDER_CANCELLED'],
    ])('refuses a checkout for an order that is %s', async (_label, fields, code) => {
        const order = await makeOrder(A, fields);

        const res = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe(code);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
        expect((await reload(order)).razorpayOrderId).toBeUndefined();
    });

    test('a gateway failure answers 500 and links nothing', async () => {
        rzp.instance.orders.create.mockRejectedValue(Object.assign(new Error('auth failed'), { statusCode: 401 }));
        const order = await makeOrder(A);

        const res = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect((await reload(order)).razorpayOrderId).toBeUndefined();
    });
});

// ── verify-payment: request + signature ──────────────────────────────

describe('POST /razorpay/verify-payment — request and signature', () => {
    test.each(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])(
        'rejects a request missing %s', async (field) => {
            const { body, order } = await checkoutFor(A);
            delete body[field];

            const res = await verify(ctx.api.guest(A), body);

            expect(res.status).toBe(400);
            expect((await reload(order)).paymentStatus).toBe('Pending');
        },
    );

    test.each([
        ['an object signature', { razorpay_signature: { $ne: '' } }],
        ['an object cafeOrderId', { cafeOrderId: { $ne: null } }],
        ['a numeric payment id', { razorpay_payment_id: 12345 }],
    ])('rejects %s', async (_label, patch) => {
        const { body } = await checkoutFor(A);
        const res = await verify(ctx.api.guest(A), { ...body, ...patch });
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test.each([
        ['signed with the webhook secret', (o, p) => checkoutSig(o, p, process.env.RAZORPAY_WEBHOOK_SECRET)],
        ['ids swapped in the HMAC', (o, p) => checkoutSig(p, o)],
        ['signature of a different payment', (o) => checkoutSig(o, `pay_${rid()}`)],
        ['truncated', (o, p) => checkoutSig(o, p).slice(0, 40)],
    ])('a forged checkout signature (%s) is refused before the gateway is consulted', async (_label, makeSig) => {
        const { body, order, rzpOrderId, paymentId } = await checkoutFor(A);

        const res = await verify(ctx.api.guest(A), { ...body, razorpay_signature: makeSig(rzpOrderId, paymentId) });

        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a valid signature without a cafeOrderId only acknowledges — nothing is settled', async () => {
        const { body, order, paymentId } = await checkoutFor(A);
        delete body.cafeOrderId;

        const res = await verify(ctx.api.guest(A), body);

        expect(res.status).toBe(200);
        expect(res.body.paymentId).toBe(paymentId);
        expect((await reload(order)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ paymentId })).toBe(0);
    });
});

// ── verify-payment: settlement ───────────────────────────────────────

describe('POST /razorpay/verify-payment — settlement', () => {
    test('settles the order with the captured rupees, claims the payment and awards points once', async () => {
        const cust = await createCustomer('v-ok');
        const c = await checkoutFor(A, { user: cust._id, total: 512.4 });
        stubGateway({ ...c, amount: 51240 });

        const res = await verify(ctx.api.as(cust, A), c.body);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, paymentId: c.paymentId });
        const after = await reload(c.order);
        expect(after).toMatchObject({
            paymentStatus: 'Paid',
            paymentMethod: 'online',
            amountPaid: 512.4,
            total: 512.4,
            razorpayOrderId: c.rzpOrderId,
            razorpayPaymentId: c.paymentId,
        });
        expect(after.paidAt).toBeTruthy();

        const claim = await PaymentClaim.findOne({ paymentId: c.paymentId }).lean();
        expect(claim).toMatchObject({ purpose: 'order_payment', ref: String(c.order._id), amount: 512.4 });

        const rows = await pointsRows(c.order);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(512);

        await settle();
        const note = await Notification.findOne({ restaurant: A.restaurant._id, 'meta.orderId': c.order.orderId }).lean();
        expect(note).toMatchObject({ title: 'Payment Confirmed', recipientRole: 'admin' });
    });

    test('a repeated verify of the same payment is idempotent', async () => {
        const cust = await createCustomer('v-replay');
        const c = await checkoutFor(A, { user: cust._id });
        stubGateway({ ...c, amount: 50000 });

        const first = await verify(ctx.api.as(cust, A), c.body);
        const second = await verify(ctx.api.as(cust, A), c.body);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.paymentId).toBe(c.paymentId);
        expect(await pointsRows(c.order)).toHaveLength(1);
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(1);
    });

    test('a different payment on an already-paid order is refused with ORDER_ALREADY_PAID', async () => {
        const c = await checkoutFor(A, {
            paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 500, razorpayPaymentId: `pay_${rid()}`,
        });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_ALREADY_PAID');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('a gateway outage fails closed with 502 and leaves no claim', async () => {
        const c = await checkoutFor(A);
        rzp.instance.payments.fetch.mockRejectedValue(new Error('ETIMEDOUT'));

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(502);
        expect(res.body.code).toBe('GATEWAY_UNAVAILABLE');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
    });

    test.each([
        ['not yet captured', { status: 'created' }, 400, 'PAYMENT_NOT_CAPTURED'],
        ['in a foreign currency', { currency: 'USD' }, 400, 'PAYMENT_CURRENCY_MISMATCH'],
        ['for a wallet recharge', { notes: { purpose: 'wallet_recharge' } }, 400, 'PAYMENT_PURPOSE_MISMATCH'],
        ['for a plan payment', { notes: { type: 'plan_payment' } }, 400, 'PAYMENT_PURPOSE_MISMATCH'],
    ])('a payment %s is refused', async (_label, patch, status, code) => {
        const c = await checkoutFor(A);
        stubGateway({ ...c, amount: 50000, ...patch });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ paymentId: c.paymentId })).toBe(0);
    });

    test('a payment the gateway cannot find is refused with PAYMENT_NOT_FOUND', async () => {
        const c = await checkoutFor(A);
        rzp.instance.payments.fetch.mockResolvedValue({});
        rzp.instance.orders.fetch.mockResolvedValue({ id: c.rzpOrderId, notes: {} });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('a payment tagged for tenant B cannot settle a tenant A order', async () => {
        const c = await checkoutFor(A);
        stubGateway({ ...c, amount: 50000, notes: { cafeOrderId: String(c.order._id), restaurantId: String(B.restaurant._id) } });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_MISMATCH');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('a checkout for a different Razorpay order than the one linked is refused', async () => {
        const c = await checkoutFor(A);
        const otherRzp = `order_${rid()}`;
        const body = { ...c.body, razorpay_order_id: otherRzp, razorpay_signature: checkoutSig(otherRzp, c.paymentId) };
        stubGateway({ ...c, rzpOrderId: otherRzp, amount: 50000 });

        const res = await verify(ctx.api.guest(A), body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RAZORPAY_ORDER_MISMATCH');
    });

    test.each([
        [49901, 200],
        [49900, 200],
        [49899, 400],
        [100, 400],
    ])('for a ₹500 order, a capture of %i paise answers %i', async (paise, status) => {
        const c = await checkoutFor(A);
        stubGateway({ ...c, amount: paise });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(status);
        const after = await reload(c.order);
        if (status === 200) {
            expect(after.paymentStatus).toBe('Paid');
            expect(after.amountPaid).toBe(paise / 100);
            expect(after.total).toBe(500);
        } else {
            expect(res.body.code).toBe('AMOUNT_INSUFFICIENT');
            expect(after.paymentStatus).toBe('Pending');
        }
    });

    test('an online top-up after a partial wallet payment records a mixed payment', async () => {
        const c = await checkoutFor(A, { total: 500, amountPaid: 200, paymentStatus: 'Partially Paid', paymentMethod: 'wallet' });
        stubGateway({ ...c, amount: 30000 });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(200);
        const after = await reload(c.order);
        expect(after).toMatchObject({
            paymentStatus: 'Paid', paymentMethod: 'mixed', amountPaid: 500, walletAmountPaid: 200, total: 500,
        });
    });

    test('a payment id already recorded on another order is refused', async () => {
        const c = await checkoutFor(A);
        await makeOrder(A, { paymentStatus: 'Paid', amountPaid: 500, razorpayPaymentId: c.paymentId });
        stubGateway({ ...c, amount: 50000 });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('a payment id claimed for another purpose is refused', async () => {
        const c = await checkoutFor(A);
        await PaymentClaim.create({ paymentId: c.paymentId, purpose: 'wallet_recharge', ref: String(A.users.admin._id) });
        stubGateway({ ...c, amount: 50000 });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test("tenant A's order cannot be verified through tenant B", async () => {
        const c = await checkoutFor(A);
        stubGateway({ ...c, amount: 50000 });

        const res = await verify(ctx.api.guest(B), c.body);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ORDER_NOT_FOUND');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('an Idempotency-Key replay returns the cached answer without re-checking the gateway', async () => {
        const c = await checkoutFor(A);
        stubGateway({ ...c, amount: 50000 });
        const headers = { 'Idempotency-Key': `verify_${rid()}` };

        const first = await verify(ctx.api.guest(A), c.body, headers);
        await settle();
        const second = await verify(ctx.api.guest(A), c.body, headers);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(second.body).toEqual(first.body);
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(1);
    });

    // Regression (fixed 2026-10): verify-payment flips to Paid atomically; losers skip side effects.
    test('concurrent verifies of one payment award loyalty points once', async () => {
        const cust = await createCustomer('v-race');
        const c = await checkoutFor(A, { user: cust._id });
        stubGateway({ ...c, amount: 50000 });

        const results = await Promise.all([
            verify(ctx.api.as(cust, A), c.body),
            verify(ctx.api.as(cust, A), c.body),
            verify(ctx.api.as(cust, A), c.body),
        ]);

        results.forEach((r) => expect(r.status).toBe(200));
        expect(await pointsRows(c.order)).toHaveLength(1);
    });
});

// ── verify-payment: deferred checkouts (no razorpayOrderId linked) ───

describe('POST /razorpay/verify-payment — deferred checkout binding', () => {
    async function deferred(fields = {}) {
        const c = await checkoutFor(A, { razorpayOrderId: undefined, ...fields });
        return c;
    }

    test("a customer cannot settle another customer's order with their own deferred checkout", async () => {
        const owner = await createCustomer('d-owner');
        const payer = await createCustomer('d-payer');
        const c = await deferred({ user: owner._id });
        stubGateway({
            ...c, amount: 50000,
            notes: { cafeOrderId: 'none', restaurantId: String(A.restaurant._id), purpose: 'cafe_order', userId: String(payer._id), payerRole: 'customer' },
        });

        const res = await verify(ctx.api.as(payer, A), c.body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAYER_MISMATCH');
    });

    test("staff may settle a customer's order with a deferred checkout they took", async () => {
        const owner = await createCustomer('d-staff');
        const c = await deferred({ user: owner._id });
        stubGateway({
            ...c, amount: 50000,
            notes: { cafeOrderId: 'none', restaurantId: String(A.restaurant._id), purpose: 'cafe_order', userId: String(A.users.waiter._id), payerRole: 'waiter' },
        });

        const res = await verify(ctx.api.as(A.users.waiter), c.body);

        expect(res.status).toBe(200);
        expect((await reload(c.order)).paymentStatus).toBe('Paid');
    });

    test('a deferred checkout whose Razorpay order cannot be confirmed is refused', async () => {
        const c = await deferred();
        stubGateway({ ...c, amount: 50000 });
        rzp.instance.orders.fetch.mockResolvedValue({ id: `order_${rid()}`, notes: {} });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RAZORPAY_ORDER_MISMATCH');
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('a deferred checkout naming the order by its order number settles it', async () => {
        const c = await deferred();
        stubGateway({ ...c, amount: 50000, notes: { cafeOrderId: c.order.orderId, restaurantId: String(A.restaurant._id) } });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(200);
        const after = await reload(c.order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.razorpayOrderId).toBe(c.rzpOrderId);
    });

    test.each([
        ['made for a different order', (c) => ({ cafeOrderId: String(c.order._id).replace(/.$/, (d) => (d === '0' ? '1' : '0')), restaurantId: String(A.restaurant._id) }), 'PAYMENT_ORDER_MISMATCH'],
        ['not linked to any restaurant', () => ({ cafeOrderId: 'none' }), 'PAYMENT_UNBOUND'],
    ])('a deferred checkout %s is refused', async (_label, makeNotes, code) => {
        const c = await deferred();
        stubGateway({ ...c, amount: 50000, notes: makeNotes(c) });

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });
});

// ── verify-payment: dine-in side effects ─────────────────────────────

describe('POST /razorpay/verify-payment — dine-in side effects', () => {
    test('settles sibling rounds at zero, records the tip and releases a served table', async () => {
        const table = await createTable(A);
        await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });
        const c = await checkoutFor(A, {
            type: 'dine-in', table: table._id, status: 'served', total: 530, tipAmount: 30, waiter: A.users.waiter._id,
        });
        const sibling = await makeOrder(A, { type: 'dine-in', table: table._id, status: 'served', total: 200 });
        stubGateway({ ...c, amount: 73000 }); // aggregated table bill

        const res = await verify(ctx.api.guest(A), c.body);

        expect(res.status).toBe(200);
        expect((await reload(c.order)).amountPaid).toBe(730);
        const sib = await reload(sibling);
        expect(sib).toMatchObject({ paymentStatus: 'Paid', amountPaid: 0, paymentMethod: 'online' });
        const tip = await Tip.findOne({ order: c.order._id }).lean();
        expect(tip).toMatchObject({ amount: 30, status: 'pending' });
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });
});

// ── Two checkouts on one order ───────────────────────────────────────

describe('create-order → verify-payment', () => {
    beforeEach(stubOrdersCreate);

    // Regression (fixed 2026-10): decision 4a — create-order used to
    // overwrite order.razorpayOrderId, so paying the FIRST of two checkouts
    // was refused (RAZORPAY_ORDER_MISMATCH) and the customer was charged
    // for an unpaid order. Every checkout is now kept in razorpayOrderIds.
    test('paying the first of two checkouts still settles the order', async () => {
        const order = await makeOrder(A);
        const first = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        const second = await create(ctx.api.as(A.users.waiter), { amount: 500, cafeOrderId: String(order._id) });
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const rzpOrderId = first.body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId, paymentId, amount: 50000 });

        const res = await verify(ctx.api.guest(A), {
            razorpay_order_id: rzpOrderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId),
            cafeOrderId: String(order._id),
        });

        expect(res.status).toBe(200);
        expect((await reload(order)).paymentStatus).toBe('Paid');
    });

    test('both checkouts stay linked and a second capture on the paid order is refused (single-use)', async () => {
        const order = await makeOrder(A);
        const first = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        const second = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        const [r1, r2] = [first.body.razorpayOrder.id, second.body.razorpayOrder.id];
        const linked = await reload(order);
        expect(linked.razorpayOrderId).toBe(r2);
        expect(linked.razorpayOrderIds).toEqual([r1, r2]);

        const p1 = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId: r1, paymentId: p1, amount: 50000 });
        const paid = await verify(ctx.api.guest(A), {
            razorpay_order_id: r1, razorpay_payment_id: p1, razorpay_signature: checkoutSig(r1, p1), cafeOrderId: String(order._id),
        });
        expect(paid.status).toBe(200);
        const after = await reload(order);
        expect(after).toMatchObject({ paymentStatus: 'Paid', razorpayOrderId: r1, razorpayPaymentId: p1 });

        const p2 = `pay_${rid()}`;
        stubGateway({ order, rzpOrderId: r2, paymentId: p2, amount: 50000 });
        const again = await verify(ctx.api.guest(A), {
            razorpay_order_id: r2, razorpay_payment_id: p2, razorpay_signature: checkoutSig(r2, p2), cafeOrderId: String(order._id),
        });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('ORDER_ALREADY_PAID');
        expect(await PaymentClaim.countDocuments({ ref: String(order._id) })).toBe(1);
    });

    test('a legacy order whose single razorpayOrderId predates the history keeps it as payable', async () => {
        const legacy = `order_${rid()}`;
        const order = await makeOrder(A, { razorpayOrderId: legacy });
        const res = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        expect(res.status).toBe(200);
        expect((await reload(order)).razorpayOrderIds).toEqual([legacy, res.body.razorpayOrder.id]);
    });

    test('a payment from a checkout of ANOTHER order is still refused', async () => {
        const mine = await makeOrder(A);
        const other = await makeOrder(A);
        await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(mine._id) });
        const otherCheckout = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(other._id) });
        const rzpOrderId = otherCheckout.body.razorpayOrder.id;
        const paymentId = `pay_${rid()}`;
        stubGateway({ order: other, rzpOrderId, paymentId, amount: 50000 });

        const res = await verify(ctx.api.guest(A), {
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId), cafeOrderId: String(mine._id),
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RAZORPAY_ORDER_MISMATCH');
        expect((await reload(mine)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ paymentId })).toBe(0);
    });
});

// ── Webhook with several checkouts on one order (decision 4a) ────────

describe('webhook — several checkouts on one order', () => {
    beforeEach(stubOrdersCreate);

    const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
    function deliverCaptured(payment) {
        const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payment } } });
        const sig = crypto.createHmac('sha256', WH_SECRET).update(body).digest('hex');
        return ctx.api.raw.post(`${V1}/razorpay/webhook`)
            .set('Content-Type', 'application/json')
            .set('X-Razorpay-Signature', sig)
            .send(body);
    }
    const captured = (rzpOrderId, notes, amount = 50000) => ({
        id: `pay_${rid()}`, entity: 'payment', order_id: rzpOrderId, status: 'captured',
        amount, currency: 'INR', created_at: Math.floor(Date.now() / 1000), notes,
    });

    test('a payment from an older checkout of the same order settles it', async () => {
        const order = await makeOrder(A);
        const first = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        await create(ctx.api.as(A.users.waiter), { amount: 500, cafeOrderId: String(order._id) });
        const r1 = first.body.razorpayOrder.id;
        const payment = captured(r1, { cafeOrderId: String(order._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' });

        const res = await deliverCaptured(payment);

        expect(res.status).toBe(200);
        const after = await reload(order);
        expect(after).toMatchObject({ paymentStatus: 'Paid', razorpayOrderId: r1, razorpayPaymentId: payment.id, amountPaid: 500 });
        expect(await PaymentClaim.findOne({ paymentId: payment.id }).lean())
            .toMatchObject({ purpose: 'order_payment', ref: String(order._id) });
    });

    test("a payment from another order's checkout never settles this order", async () => {
        const mine = await makeOrder(A);
        await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(mine._id) });
        // A checkout no order of ours knows, whose notes point at `mine`.
        const payment = captured(`order_${rid()}`, { cafeOrderId: String(mine._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' });

        const res = await deliverCaptured(payment);

        expect(res.status).toBe(200);
        expect((await reload(mine)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ paymentId: payment.id })).toBe(0);
    });
});

// ── Pay first, then order (decision 4c) ──────────────────────────────

describe('POST /orders with a pay-first checkout (deferred takeaway / kiosk)', () => {
    // 2 × Paneer Tikka (₹200) as a takeaway.
    const takeawayTotal = () => computeBill({ subtotal: 400, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway' }).total;

    function prepaid({ notes, amount, paymentId = `pay_${rid()}`, rzpOrderId = `order_${rid()}` } = {}) {
        const paise = amount !== undefined ? amount : Math.round(takeawayTotal() * 100);
        const n = notes || { cafeOrderId: 'none', restaurantId: String(A.restaurant._id), purpose: 'cafe_order' };
        rzp.instance.payments.fetch.mockResolvedValue({
            id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: paise,
            currency: 'INR', created_at: Math.floor(Date.now() / 1000) - 30, notes: {},
        });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount: paise, notes: n });
        return {
            paymentId,
            rzpOrderId,
            checkout: {
                razorpay_order_id: rzpOrderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: checkoutSig(rzpOrderId, paymentId),
            },
        };
    }
    const placeOrder = (client, checkout, extra = {}) => client.post('/orders').send({
        type: 'takeaway',
        pickupLocation: 'Counter',
        items: [{ menuItem: String(A.items.paneer._id), quantity: 2 }],
        total: takeawayTotal(),
        paymentMethod: 'online',
        clientIdempotencyKey: `idem_${rid()}${rid()}`,
        ...(checkout ? { razorpayPayment: checkout } : {}),
        ...extra,
    });
    const ordersFor = (paymentId) => Order.countDocuments({ razorpayPaymentId: paymentId });

    test('links the payment at creation; orphan-refund is then refused and verify-payment is an idempotent replay', async () => {
        const p = prepaid();

        const created = await placeOrder(ctx.api.guest(A), p.checkout);

        expect(created.status).toBe(201);
        const order = await Order.findById(created.body.order._id).lean();
        expect(order).toMatchObject({
            paymentStatus: 'Pending', razorpayOrderId: p.rzpOrderId, razorpayOrderIds: [p.rzpOrderId], razorpayPaymentId: p.paymentId,
        });
        expect(await PaymentClaim.findOne({ paymentId: p.paymentId }).lean())
            .toMatchObject({ purpose: 'order_payment', ref: String(order._id), razorpayOrderId: p.rzpOrderId });

        // The food is ordered — the browser can no longer refund itself.
        const refund = await ctx.api.guest(A).post('/razorpay/orphan-refund').send({ razorpay_payment_id: p.paymentId, ...p.checkout });
        expect(refund.status).toBe(409);
        expect(refund.body.code).toBe('PAYMENT_IN_USE');
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();

        const body = { ...p.checkout, cafeOrderId: order.orderId };
        const first = await verify(ctx.api.guest(A), body);
        const second = await verify(ctx.api.guest(A), body);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const paid = await reload(order);
        expect(paid).toMatchObject({ paymentStatus: 'Paid', razorpayPaymentId: p.paymentId, amountPaid: takeawayTotal() });
        expect(await PaymentClaim.countDocuments({ paymentId: p.paymentId })).toBe(1);
    });

    test('a request without checkout ids creates the order unlinked (pay-at-counter / legacy clients)', async () => {
        const res = await placeOrder(ctx.api.guest(A), null, { paymentMethod: 'cash' });
        expect(res.status).toBe(201);
        const order = await Order.findById(res.body.order._id).lean();
        expect(order.razorpayOrderId).toBeUndefined();
        expect(order.razorpayPaymentId).toBeUndefined();
    });

    test.each([
        ['a forged signature', (p) => ({ ...p.checkout, razorpay_signature: checkoutSig(p.rzpOrderId, p.paymentId, 'wrong-secret') }), 400, 'PAYMENT_SIGNATURE_INVALID'],
        ['a payment id swapped after signing', (p) => ({ ...p.checkout, razorpay_payment_id: `pay_${rid()}` }), 400, 'PAYMENT_SIGNATURE_INVALID'],
        ['a missing signature', (p) => ({ razorpay_order_id: p.rzpOrderId, razorpay_payment_id: p.paymentId }), 400, 'PAYMENT_DETAILS_INVALID'],
        ['operator-object ids', (p) => ({ ...p.checkout, razorpay_payment_id: { $ne: null } }), 400, 'PAYMENT_DETAILS_INVALID'],
        ['a non-object payload', () => 'order_x|pay_y', 400, 'PAYMENT_DETAILS_INVALID'],
    ])('%s refuses the order — nothing is created or claimed', async (_label, tamper, status, code) => {
        const p = prepaid();
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });

        const res = await placeOrder(ctx.api.guest(A), tamper(p));

        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
        expect(await PaymentClaim.countDocuments({ paymentId: p.paymentId })).toBe(0);
    });

    test.each([
        ["another tenant's checkout", () => ({ notes: { cafeOrderId: 'none', restaurantId: String(B.restaurant._id), purpose: 'cafe_order' } }), 403, 'TENANT_MISMATCH'],
        ['a wallet-recharge payment', () => ({ notes: { purpose: 'wallet_recharge', restaurantId: String(A.restaurant._id) } }), 400, 'PAYMENT_PURPOSE_MISMATCH'],
        ['a checkout opened for an existing order', () => ({ notes: { cafeOrderId: '64b000000000000000000001', restaurantId: String(A.restaurant._id), purpose: 'cafe_order' } }), 400, 'PAYMENT_ORDER_MISMATCH'],
        ['an underpaid capture', () => ({ amount: 100 }), 400, 'AMOUNT_INSUFFICIENT'],
    ])('%s refuses the order', async (_label, opts, status, code) => {
        const p = prepaid(opts());
        const res = await placeOrder(ctx.api.guest(A), p.checkout);
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(await ordersFor(p.paymentId)).toBe(0);
        expect(await PaymentClaim.countDocuments({ paymentId: p.paymentId })).toBe(0);
    });

    test('one payment can never create (or pay for) two orders', async () => {
        const p = prepaid();
        const first = await placeOrder(ctx.api.guest(A), p.checkout);
        expect(first.status).toBe(201);

        const second = await placeOrder(ctx.api.guest(A), p.checkout); // new idempotency key
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('PAYMENT_ALREADY_USED');
        expect(await ordersFor(p.paymentId)).toBe(1);
    });

    test('a payment already claimed for something else refuses the order', async () => {
        const p = prepaid();
        await PaymentClaim.create({ paymentId: p.paymentId, purpose: 'wallet_recharge', ref: String(A.users.admin._id) });
        const res = await placeOrder(ctx.api.guest(A), p.checkout);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect(await ordersFor(p.paymentId)).toBe(0);
    });

    test('an idempotent retry of the same create returns the same linked order', async () => {
        const p = prepaid();
        const key = `idem_${rid()}${rid()}`;
        const first = await placeOrder(ctx.api.guest(A), p.checkout, { clientIdempotencyKey: key });
        const retry = await placeOrder(ctx.api.guest(A), p.checkout, { clientIdempotencyKey: key });
        expect(first.status).toBe(201);
        expect(retry.status).toBe(200);
        expect(retry.body.order._id).toBe(first.body.order._id);
        expect(await ordersFor(p.paymentId)).toBe(1);
    });

    test('gateway unreachable at create: the signed checkout is still linked (not claimed) so it cannot be orphan-refunded', async () => {
        const rzpOrderId = `order_${rid()}`;
        const paymentId = `pay_${rid()}`;
        rzp.instance.payments.fetch.mockRejectedValue(new Error('gateway timeout'));
        rzp.instance.orders.fetch.mockRejectedValue(new Error('gateway timeout'));

        const res = await placeOrder(ctx.api.guest(A), {
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSig(rzpOrderId, paymentId),
        });

        expect(res.status).toBe(201);
        const order = await Order.findById(res.body.order._id).lean();
        expect(order).toMatchObject({ paymentStatus: 'Pending', razorpayOrderId: rzpOrderId, razorpayPaymentId: paymentId });
        expect(await PaymentClaim.countDocuments({ paymentId })).toBe(0);

        // Gateway back: verify does the full check and settles it.
        prepaid({ paymentId, rzpOrderId });
        const v = await verify(ctx.api.guest(A), {
            razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId), cafeOrderId: order.orderId,
        });
        expect(v.status).toBe(200);
        expect((await reload(order)).paymentStatus).toBe('Paid');
    });
});

// ── Mock gateway ─────────────────────────────────────────────────────

describe('mock gateway (RAZORPAY_MOCK)', () => {
    const saved = {};
    beforeEach(() => {
        saved.mock = process.env.RAZORPAY_MOCK;
        saved.env = process.env.NODE_ENV;
    });
    afterEach(() => {
        if (saved.mock === undefined) delete process.env.RAZORPAY_MOCK; else process.env.RAZORPAY_MOCK = saved.mock;
        process.env.NODE_ENV = saved.env;
    });

    const mockBody = (order) => ({
        razorpay_order_id: `order_mock_${rid()}`,
        razorpay_payment_id: `pay_mock_${rid()}`,
        razorpay_signature: 'mock_signature_not_verified',
        cafeOrderId: String(order._id),
    });

    test.each([
        ['mock mode is off', undefined, 'test'],
        ['NODE_ENV is production', 'true', 'production'],
    ])('mock ids never bypass the signature when %s', async (_label, flag, nodeEnv) => {
        if (flag === undefined) delete process.env.RAZORPAY_MOCK; else process.env.RAZORPAY_MOCK = flag;
        const order = await makeOrder(A);
        const body = mockBody(order);
        process.env.NODE_ENV = nodeEnv;

        const res = await verify(ctx.api.guest(A), body);

        process.env.NODE_ENV = saved.env;
        expect(res.status).toBe(400);
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    // Regression (fixed 2026-10): mock payments carry the amount of the mock checkout (dev only).
    test('in mock mode a mock checkout settles the order end to end', async () => {
        process.env.RAZORPAY_MOCK = 'true';
        const order = await makeOrder(A);

        const created = await create(ctx.api.guest(A), { amount: 500, cafeOrderId: String(order._id) });
        expect(created.status).toBe(200);
        expect(created.body.mock).toBe(true);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();

        const rzpOrderId = created.body.razorpayOrder.id;
        const res = await verify(ctx.api.guest(A), {
            razorpay_order_id: rzpOrderId,
            razorpay_payment_id: `pay_mock_${rid()}`,
            razorpay_signature: 'mock_signature_not_verified',
            cafeOrderId: String(order._id),
        });

        expect(res.status).toBe(200);
        expect((await reload(order)).paymentStatus).toBe('Paid');
    });
});
