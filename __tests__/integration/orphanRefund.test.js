/**
 * POST /api/v1/razorpay/orphan-refund — controllers/razorpayController.
 * refundOrphanPayment + utils/paymentChecks.checkOrphanRefundEligibility.
 *
 * The "charged but the order could not be saved" self-refund. It is
 * reachable by guests, so the controls that matter are: the payment
 * belongs to this tenant, is a cafe-order checkout never bound to an
 * order, is recent, is provably the caller's, and is not referenced by
 * anything that already delivered value.
 *
 * Coverage:
 *   - input + gateway lookup failures
 *   - payer proof: logged-in user, guest scan session, checkout signature;
 *     refusals for strangers, other sessions, anonymous, forged/mismatched
 *     signatures
 *   - tenant, purpose, bound-to-order, age window (old / future / unknown)
 *   - payment state: refunded, fully refunded, failed, authorized
 *   - in-use guards: order, ledger row, advance booking, payment claim
 *   - refund issue (remaining paise, claim, admin alert), gateway failure
 *     releases the claim, verify-payment refuses a refund-claimed payment
 *
 * Proof tests use an already-refunded payment: once the caller is proven,
 * the handler answers 200 alreadyRefunded without touching the gateway,
 * so they exercise eligibility independently of the refund call.
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const AdvanceBooking = require(path.join(BACKEND, 'models/advanceBooking'));
const Notification = require(path.join(BACKEND, 'models/notification'));

const ctx = useIntegrationApp();
let A;
let B;

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const checkoutSig = (o, p, secret = KEY_SECRET) => crypto.createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'or-a' });
    B = await seedTenant({ label: 'or-b' });
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Stub the gateway for one orphan payment. Notes default to a deferred
 * cafe-order checkout for tenant A (what createRazorpayOrder stamps).
 */
function orphan({
    notes = {}, status = 'captured', amount = 50000, amountRefunded = 0,
    createdAt = nowSec() - 60, tenant = A,
} = {}) {
    const paymentId = `pay_${rid()}`;
    const rzpOrderId = `order_${rid()}`;
    const orderNotes = {
        cafeOrderId: 'none',
        restaurantId: String(tenant.restaurant._id),
        purpose: 'cafe_order',
        ...notes,
    };
    for (const k of Object.keys(orderNotes)) if (orderNotes[k] === undefined) delete orderNotes[k];
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: rzpOrderId, status, amount,
        amount_refunded: amountRefunded, currency: 'INR', created_at: createdAt, notes: {},
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount, notes: orderNotes });
    return { paymentId, rzpOrderId };
}

const post = (client, body) => client.post('/razorpay/orphan-refund').send(body);

function expectRefused(res, status, code) {
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
}

// ── Input ────────────────────────────────────────────────────────────

describe('input and lookup', () => {
    test.each([
        ['missing', {}],
        ['a number', { razorpay_payment_id: 12345 }],
        ['an object', { razorpay_payment_id: { $ne: null } }],
    ])('a payment id that is %s is refused', async (_label, body) => {
        const res = await post(ctx.api.guest(A), body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_ID_REQUIRED');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('a tenant is required', async () => {
        const res = await post(ctx.api.anon(), { razorpay_payment_id: `pay_${rid()}` });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('a payment the gateway cannot find answers 404', async () => {
        rzp.instance.payments.fetch.mockRejectedValue(new Error('BAD_REQUEST_ERROR: id does not exist'));
        const res = await post(ctx.api.guest(A), { razorpay_payment_id: `pay_${rid()}` });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
    });

    test('an empty gateway answer is treated as not found', async () => {
        rzp.instance.payments.fetch.mockResolvedValue({});
        const res = await post(ctx.api.guest(A), { razorpay_payment_id: `pay_${rid()}` });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
    });
});

// ── Payer proof ──────────────────────────────────────────────────────

describe('payer proof', () => {
    const refunded = { status: 'refunded', amountRefunded: 50000 };

    test('the logged-in customer who paid is accepted', async () => {
        const cust = await createCustomer('or-owner');
        const { paymentId } = orphan({ ...refunded, notes: { userId: String(cust._id), payerRole: 'customer' } });

        const res = await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, alreadyRefunded: true, refundedAmount: 500 });
    });

    test('a guest holding the scan session that paid is accepted', async () => {
        const { scanToken, sessionId } = await scanTable(ctx.api, await createTable(A));
        const { paymentId } = orphan({ ...refunded, notes: { scanSessionId: String(sessionId) } });

        const res = await post(ctx.api.guest(A, scanToken), { razorpay_payment_id: paymentId });

        expect(res.status).toBe(200);
        expect(res.body.alreadyRefunded).toBe(true);
    });

    test('a valid checkout signature alone is accepted', async () => {
        const { paymentId, rzpOrderId } = orphan(refunded);

        const res = await post(ctx.api.guest(A), {
            razorpay_payment_id: paymentId,
            razorpay_order_id: rzpOrderId,
            razorpay_signature: checkoutSig(rzpOrderId, paymentId),
        });

        expect(res.status).toBe(200);
        expect(res.body.alreadyRefunded).toBe(true);
    });

    test('another logged-in customer is refused', async () => {
        const owner = await createCustomer('or-o');
        const other = await createCustomer('or-x');
        const { paymentId } = orphan({ notes: { userId: String(owner._id), payerRole: 'customer' } });

        expectRefused(await post(ctx.api.as(other, A), { razorpay_payment_id: paymentId }), 403, 'PAYER_MISMATCH');
    });

    test('a guest holding a different scan session is refused', async () => {
        const mine = await scanTable(ctx.api, await createTable(A));
        const theirs = await scanTable(ctx.api, await createTable(A));
        const { paymentId } = orphan({ notes: { scanSessionId: String(mine.sessionId) } });

        expectRefused(await post(ctx.api.guest(A, theirs.scanToken), { razorpay_payment_id: paymentId }), 403, 'PAYER_MISMATCH');
    });

    test('an anonymous caller who only knows the payment id is refused', async () => {
        const cust = await createCustomer('or-anon');
        const { paymentId } = orphan({ notes: { userId: String(cust._id) } });

        expectRefused(await post(ctx.api.guest(A), { razorpay_payment_id: paymentId }), 403, 'PAYER_MISMATCH');
    });

    test.each([
        ['signed for a different Razorpay order', (p) => {
            const other = `order_${rid()}`;
            return { razorpay_order_id: other, razorpay_signature: checkoutSig(other, p.paymentId) };
        }],
        ['signed with the wrong secret', (p) => ({
            razorpay_order_id: p.rzpOrderId, razorpay_signature: checkoutSig(p.rzpOrderId, p.paymentId, 'wrong'),
        })],
        ['signed over swapped ids', (p) => ({
            razorpay_order_id: p.rzpOrderId, razorpay_signature: checkoutSig(p.paymentId, p.rzpOrderId),
        })],
    ])('a checkout signature %s is not proof', async (_label, makeProof) => {
        const p = orphan();
        const res = await post(ctx.api.guest(A), { razorpay_payment_id: p.paymentId, ...makeProof(p) });
        expectRefused(res, 403, 'PAYER_MISMATCH');
    });
});

// ── Tenant, purpose, binding, age ────────────────────────────────────

describe('eligibility', () => {
    test("a payment stamped for tenant A cannot be refunded through tenant B", async () => {
        const cust = await createCustomer('or-tenant');
        const { paymentId } = orphan({ notes: { userId: String(cust._id) } });

        expectRefused(await post(ctx.api.as(cust, B), { razorpay_payment_id: paymentId }), 403, 'TENANT_MISMATCH');
    });

    test('a payment without a tenant stamp is refused', async () => {
        const cust = await createCustomer('or-nostamp');
        const { paymentId } = orphan({ notes: { restaurantId: undefined, userId: String(cust._id) } });

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId }), 403, 'TENANT_MISMATCH');
    });

    test.each([
        ['purpose', 'wallet_recharge'],
        ['type', 'plan_payment'],
        ['purpose', 'advance-booking-remaining'],
    ])('a payment whose %s is %s is not auto-refundable', async (key, value) => {
        const cust = await createCustomer('or-purpose');
        const { paymentId } = orphan({ notes: { purpose: undefined, [key]: value, userId: String(cust._id) } });

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId }), 403, 'PAYMENT_NOT_REFUNDABLE');
    });

    test('a checkout opened for an existing order is not an orphan', async () => {
        const cust = await createCustomer('or-bound');
        const { paymentId } = orphan({ notes: { cafeOrderId: 'ORD-260101-ABC123', userId: String(cust._id) } });

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId }), 409, 'PAYMENT_IN_USE');
    });

    test.each([
        ['older than two hours', () => nowSec() - 2 * 3600 - 60, 403, 'REFUND_WINDOW_EXPIRED'],
        ['dated beyond the clock-skew allowance', () => nowSec() + 10 * 60, 403, 'REFUND_WINDOW_EXPIRED'],
        ['missing a creation time', () => null, 400, 'PAYMENT_AGE_UNKNOWN'],
    ])('a payment %s is refused', async (_label, createdAt, status, code) => {
        const cust = await createCustomer('or-age');
        const { paymentId } = orphan({ createdAt: createdAt(), notes: { userId: String(cust._id) } });

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId }), status, code);
    });

    test('a payment just inside the window is still eligible', async () => {
        const cust = await createCustomer('or-edge');
        const { paymentId } = orphan({
            status: 'refunded', amountRefunded: 50000, createdAt: nowSec() - 2 * 3600 + 60, notes: { userId: String(cust._id) },
        });

        const res = await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId });

        expect(res.status).toBe(200);
    });
});

// ── Payment state ────────────────────────────────────────────────────

describe('payment state', () => {
    let cust;
    beforeAll(async () => { cust = await createCustomer('or-state'); });
    const mine = () => ({ userId: String(cust._id) });

    test('a captured payment already fully refunded at the gateway answers alreadyRefunded', async () => {
        const { paymentId } = orphan({ amount: 51240, amountRefunded: 51240, notes: mine() });

        const res = await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ alreadyRefunded: true, refundedAmount: 512.4 });
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
    });

    test.each(['failed', 'authorized', 'created'])('a payment in %s state is not refundable', async (status) => {
        const { paymentId } = orphan({ status, notes: mine() });

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: paymentId }), 400, 'PAYMENT_NOT_REFUNDABLE');
    });
});

// ── In-use guards ────────────────────────────────────────────────────

describe('payments already referenced are never self-refunded', () => {
    let cust;
    beforeAll(async () => { cust = await createCustomer('or-inuse'); });

    const baseOrder = () => ({
        restaurant: A.restaurant._id, branch: A.branch._id, orderId: `OR-${rid()}`, type: 'takeaway',
        items: [{ name: 'Paneer Tikka', price: 500, quantity: 1 }], total: 500,
    });

    test.each([
        ['an order carrying the payment id', (p) => Order.create({ ...baseOrder(), razorpayPaymentId: p.paymentId })],
        ['an order carrying the Razorpay order id', (p) => Order.create({ ...baseOrder(), razorpayOrderId: p.rzpOrderId })],
        ['a ledger row carrying the payment id', (p) => Transaction.collection.insertOne({
            transactionId: `TXN-OR-${rid()}`, user: cust._id, restaurant: A.restaurant._id, type: 'recharge', amount: 500, razorpayPaymentId: p.paymentId,
        })],
        ['a ledger row carrying the Razorpay order id', (p) => Transaction.collection.insertOne({
            transactionId: `TXN-OR-${rid()}`, user: cust._id, restaurant: A.restaurant._id, type: 'recharge', amount: 500, razorpayOrderId: p.rzpOrderId,
        })],
        ['an advance booking paid with it', (p) => AdvanceBooking.collection.insertOne({
            bookingId: `BKT-OR-${rid()}`, restaurant: A.restaurant._id, payment: { razorpayPaymentId: p.paymentId },
        })],
        ["an advance booking's remaining-balance checkout", (p) => AdvanceBooking.collection.insertOne({
            bookingId: `BKT-OR-${rid()}`, restaurant: A.restaurant._id, payment: { remainingRazorpayOrderId: p.rzpOrderId },
        })],
        ['a claim for an order payment', (p) => PaymentClaim.create({
            paymentId: p.paymentId, purpose: 'order_payment', ref: 'some-order',
        })],
    ])('refuses when the payment is referenced by %s', async (_label, link) => {
        const p = orphan({ notes: { userId: String(cust._id) } });
        await link(p);

        expectRefused(await post(ctx.api.as(cust, A), { razorpay_payment_id: p.paymentId }), 409, 'PAYMENT_IN_USE');
    });
});

// ── Issuing the refund ───────────────────────────────────────────────

describe('issuing the refund', () => {
    // Regression (fixed 2026-10): refundOrphanPayment uses razorpay.payments.refund (SDK 2.9.x has no refunds.create).
    test('refunds the remaining paise, claims the payment and alerts the admin', async () => {
        const cust = await createCustomer('or-ok');
        const p = orphan({ amount: 51240, amountRefunded: 1240, notes: { userId: String(cust._id) } });
        rzp.instance.payments.refund.mockImplementation(async (paymentId, params) => ({
            id: 'rfnd_orphan1', entity: 'refund', payment_id: paymentId, amount: params?.amount,
        }));

        const res = await post(ctx.api.as(cust, A), { razorpay_payment_id: p.paymentId, reason: 'Out of stock' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, refundedAmount: 500, refundId: 'rfnd_orphan1' });
        expect(rzp.instance.payments.refund).toHaveBeenCalledWith(p.paymentId, expect.objectContaining({ amount: 50000 }));
        expect(await PaymentClaim.findOne({ paymentId: p.paymentId }).lean()).toMatchObject({ purpose: 'orphan_refund', amount: 500 });

        await settle();
        const alert = await Notification.findOne({ restaurant: A.restaurant._id, 'meta.orderId': 'rfnd_orphan1' }).lean();
        expect(alert).toMatchObject({ priority: 'high', recipientRole: 'admin' });
        expect(alert.description).toContain('₹500.00');
        expect(alert.description).toContain('Out of stock');
    });

    test('a gateway failure answers 502 and releases the claim for a retry', async () => {
        const cust = await createCustomer('or-fail');
        const p = orphan({ notes: { userId: String(cust._id) } });
        rzp.instance.payments.refund.mockRejectedValue(new Error('gateway down'));

        const res = await post(ctx.api.as(cust, A), { razorpay_payment_id: p.paymentId });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe('GATEWAY_REFUND_FAILED');
        expect(await PaymentClaim.countDocuments({ paymentId: p.paymentId })).toBe(0);
    });

    test('a payment claimed for an orphan refund cannot then settle an order through verify-payment', async () => {
        const cust = await createCustomer('or-cross');
        const p = orphan({ notes: { userId: String(cust._id) } });
        await PaymentClaim.create({ paymentId: p.paymentId, purpose: 'orphan_refund', ref: p.paymentId });
        const order = await Order.create({
            restaurant: A.restaurant._id, branch: A.branch._id, orderId: `OR-${rid()}`, type: 'takeaway', user: cust._id,
            items: [{ name: 'Paneer Tikka', price: 500, quantity: 1 }], total: 500,
        });

        const res = await ctx.api.as(cust, A).post('/razorpay/verify-payment').send({
            razorpay_order_id: p.rzpOrderId,
            razorpay_payment_id: p.paymentId,
            razorpay_signature: checkoutSig(p.rzpOrderId, p.paymentId),
            cafeOrderId: String(order._id),
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect((await Order.findById(order._id).lean()).paymentStatus).toBe('Pending');
    });
});
