/**
 * POST /api/v1/razorpay/webhook — controllers/razorpayController.js
 * (handleWebhook, handlePlanPaymentCaptured, handleSubscriptionEvent).
 *
 * The webhook is the server-to-server safety net that settles orders when
 * the customer's browser never reached verify-payment, records gateway
 * refunds, and drives the SaaS subscription lifecycle. It is public and
 * unauthenticated, so the HMAC over the raw body is the whole trust gate.
 *
 * Coverage:
 *   - receipt layer: missing secret (500), missing / forged / truncated /
 *     wrong-secret signature, body tampered after signing, bad JSON,
 *     staff bearer token does not bypass the signature (all 200, no-op)
 *   - payment.captured: exact paise → rupee conversion, claim ledger,
 *     replay + concurrent duplicate delivery, payment id spent elsewhere,
 *     already-paid order, amount must cover what is due (same rule as
 *     verify-payment), wallet split, sibling dine-in rounds, tip, table
 *   - tenant isolation: notes.restaurantId vs order tenant, cafeOrderId
 *     fallback scoped by tenant, legacy untagged payments refused
 *   - payment.failed, refund.processed (full / partial / replay / admin
 *     refund already recorded / concurrent duplicate)
 *   - plan_payment capture and subscription.* events
 *
 * Tests whose name starts with "BUG:" pin behaviour the handler gets
 * wrong today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { V1, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const Table = require(path.join(BACKEND, 'models/table'));
const Tip = require(path.join(BACKEND, 'models/tip'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;
let B;

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'wh-a' });
    B = await seedTenant({ label: 'wh-b' });
    // Loyalty on for A so duplicate-award bugs are observable
    // (₹1 → 1 point, earn from ₹100).
    await Settings.updateOne(
        { restaurant: A.restaurant._id, branch: null },
        { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } },
    );
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Deliver a webhook. `signature: null` omits the header; a string is
 * sent as-is; default signs the exact bytes sent.
 */
function deliver(payload, { signature, raw, headers = {} } = {}) {
    const body = raw !== undefined ? raw : JSON.stringify(payload);
    let r = ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json');
    if (signature !== null) r = r.set('X-Razorpay-Signature', signature !== undefined ? signature : sign(body));
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
}

function expectOk(res) {
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
}

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `WH-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        razorpayOrderId: `order_${rid()}`,
        ...fields,
    });
    return doc.toObject();
}

function paymentEntity({ order, amount, paymentId = `pay_${rid()}`, notes, rzpOrderId, createdAt }) {
    return {
        id: paymentId,
        entity: 'payment',
        amount,
        currency: 'INR',
        status: 'captured',
        order_id: rzpOrderId !== undefined ? rzpOrderId : order?.razorpayOrderId,
        notes: notes !== undefined ? notes : {
            cafeOrderId: order ? String(order._id) : 'none',
            restaurantId: order ? String(order.restaurant) : undefined,
            purpose: 'cafe_order',
        },
        created_at: createdAt,
    };
}

function capturedEvent(opts) {
    return {
        entity: 'event',
        event: 'payment.captured',
        id: `evt_${rid()}`,
        payload: { payment: { entity: paymentEntity(opts) } },
    };
}

function refundEvent({ order, refundId = `rfnd_${rid()}`, refundAmount, paymentAmount, reason = 'damaged item' }) {
    return {
        entity: 'event',
        event: 'refund.processed',
        id: `evt_${rid()}`,
        payload: {
            refund: {
                entity: {
                    id: refundId,
                    entity: 'refund',
                    amount: refundAmount,
                    payment_id: order.razorpayPaymentId,
                    notes: { reason },
                },
            },
            // Razorpay sends the ORIGINAL payment alongside the refund;
            // its amount is the full captured amount, not the refund.
            payment: {
                entity: paymentEntity({ order, amount: paymentAmount, paymentId: order.razorpayPaymentId }),
            },
        },
    };
}

function subscriptionEvent(event, sub, payment) {
    const payload = { subscription: { entity: { entity: 'subscription', ...sub } } };
    if (payment) payload.payment = { entity: payment };
    return { entity: 'event', event, id: `evt_${rid()}`, payload };
}

/** A paid online order, as left behind by a successful capture. */
async function paidOrder(t, fields = {}) {
    return makeOrder(t, {
        paymentStatus: 'Paid',
        paymentMethod: 'online',
        amountPaid: 500,
        razorpayPaymentId: `pay_${rid()}`,
        paidAt: new Date(),
        ...fields,
    });
}

const reload = (order) => Order.findById(order._id).lean();
const pointsRows = (order) => Transaction.find({ order: order._id, type: 'points_earned' }).lean();

// ── Receipt layer ────────────────────────────────────────────────────

describe('receipt layer — signature and body', () => {
    test('a missing webhook secret answers 500 so Razorpay retries, and changes nothing', async () => {
        const order = await makeOrder(A);
        const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
        try {
            const res = await deliver(capturedEvent({ order, amount: 50000 }), { signature: 'anything' });
            expect(res.status).toBe(500);
        } finally {
            process.env.RAZORPAY_WEBHOOK_SECRET = saved;
        }
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a delivery without the signature header is dropped with 200', async () => {
        const order = await makeOrder(A);
        const res = await deliver(capturedEvent({ order, amount: 50000 }), { signature: null });
        expectOk(res);
        expect((await reload(order)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ ref: String(order._id) })).toBe(0);
    });

    test.each([
        ['signed with a different secret', (raw) => sign(raw, 'not-the-webhook-secret')],
        ['signed with the API key secret instead of the webhook secret', (raw) => sign(raw, process.env.RAZORPAY_KEY_SECRET)],
        ['truncated signature', (raw) => sign(raw).slice(0, 32)],
        ['upper-cased hex signature', (raw) => sign(raw).toUpperCase()],
        ['empty signature', () => ''],
        ['random 64-char hex', () => crypto.randomBytes(32).toString('hex')],
    ])('a forged capture (%s) is dropped with 200 and the order stays unpaid', async (_label, makeSig) => {
        const order = await makeOrder(A);
        const raw = JSON.stringify(capturedEvent({ order, amount: 50000 }));
        const res = await deliver(null, { raw, signature: makeSig(raw) });
        expectOk(res);
        const after = await reload(order);
        expect(after.paymentStatus).toBe('Pending');
        expect(after.razorpayPaymentId).toBeUndefined();
    });

    test('a body altered after signing (amount bumped) fails the HMAC and is dropped', async () => {
        const order = await makeOrder(A);
        const signedRaw = JSON.stringify(capturedEvent({ order, amount: 100 }));
        const tampered = signedRaw.replace('"amount":100', '"amount":50000');
        expect(tampered).not.toBe(signedRaw);
        const res = await deliver(null, { raw: tampered, signature: sign(signedRaw) });
        expectOk(res);
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a correctly signed but malformed JSON body is dropped with 200', async () => {
        const raw = '{"event":"payment.captured",';
        const res = await deliver(null, { raw, signature: sign(raw) });
        expectOk(res);
    });

    test('an admin bearer token does not bypass the signature check', async () => {
        const order = await makeOrder(A);
        const res = await deliver(capturedEvent({ order, amount: 50000 }), {
            signature: 'forged',
            headers: { Authorization: `Bearer ${A.users.admin.token}`, 'X-Restaurant-Slug': A.slug },
        });
        expectOk(res);
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a capture sent with a non-JSON content type is never applied', async () => {
        const order = await makeOrder(A);
        const raw = JSON.stringify(capturedEvent({ order, amount: 50000 }));
        const res = await ctx.api.raw.post(`${V1}/razorpay/webhook`)
            .set('Content-Type', 'text/plain')
            .set('X-Razorpay-Signature', sign(raw))
            .send(raw);
        expectOk(res);
        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('a signed event with no payment entity is acknowledged and ignored', async () => {
        const res = await deliver({ event: 'payment.captured', payload: {} });
        expectOk(res);
    });
});

// ── payment.captured ─────────────────────────────────────────────────

describe('payment.captured', () => {
    test('settles the order found by razorpayOrderId with the exact captured rupees', async () => {
        const order = await makeOrder(A, { total: 512.4 });
        const createdAt = 1767225600; // 2026-01-01T00:00:00Z
        const evt = capturedEvent({ order, amount: 51240, createdAt });
        const paymentId = evt.payload.payment.entity.id;

        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.paymentMethod).toBe('online');
        expect(after.amountPaid).toBe(512.4);
        expect(after.total).toBe(512.4);
        expect(after.razorpayPaymentId).toBe(paymentId);
        expect(new Date(after.paidAt).toISOString()).toBe('2026-01-01T00:00:00.000Z');

        const claim = await PaymentClaim.findOne({ paymentId }).lean();
        expect(claim).toMatchObject({ purpose: 'order_payment', ref: String(order._id), amount: 512.4 });
        expect(String(claim.restaurant)).toBe(String(A.restaurant._id));
    });

    test.each([
        [33333, 333.33],
        [100, 1],
        [99999, 999.99],
        [70001, 700.01],
    ])('converts %i paise to exactly ₹%d', async (paise, rupees) => {
        const order = await makeOrder(A, { total: rupees });
        expectOk(await deliver(capturedEvent({ order, amount: paise })));
        const after = await reload(order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.amountPaid).toBe(rupees);
    });

    test('falls back to notes.cafeOrderId (order number) when the tenant tag matches', async () => {
        const order = await makeOrder(A, { razorpayOrderId: undefined });
        const evt = capturedEvent({
            order,
            amount: 50000,
            rzpOrderId: `order_${rid()}`,
            notes: { cafeOrderId: order.orderId, restaurantId: String(A.restaurant._id), purpose: 'cafe_order' },
        });
        expectOk(await deliver(evt));
        const after = await reload(order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.amountPaid).toBe(500);
    });

    test('a redelivered capture is a no-op: one claim, one loyalty award', async () => {
        const order = await makeOrder(A, { user: A.users.waiter._id }); // any user id earns points
        const evt = capturedEvent({ order, amount: 50000 });

        expectOk(await deliver(evt));
        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.amountPaid).toBe(500);
        expect(await PaymentClaim.countDocuments({ paymentId: evt.payload.payment.entity.id })).toBe(1);
        const rows = await pointsRows(order);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(500);
    });

    // Regression (fixed 2026-10): the Paid transition is an atomic findOneAndUpdate, so only one delivery runs side effects.
    test('concurrent duplicate deliveries award loyalty points only once', async () => {
        const order = await makeOrder(A, { user: A.users.captain._id });
        const evt = capturedEvent({ order, amount: 50000 });

        const results = await Promise.all([deliver(evt), deliver(evt), deliver(evt)]);
        results.forEach(expectOk);
        await settle();

        expect((await reload(order)).paymentStatus).toBe('Paid');
        expect(await pointsRows(order)).toHaveLength(1);
    });

    test('a payment id already spent on another purpose is not applied to the order', async () => {
        const order = await makeOrder(A);
        const paymentId = `pay_${rid()}`;
        await PaymentClaim.create({ paymentId, purpose: 'wallet_recharge', ref: String(A.users.waiter._id) });

        expectOk(await deliver(capturedEvent({ order, amount: 50000, paymentId })));

        const after = await reload(order);
        expect(after.paymentStatus).toBe('Pending');
        expect(after.razorpayPaymentId).toBeUndefined();
    });

    test('a second capture on an already-paid order does not overwrite the first payment', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', amountPaid: 500 });
        const evt = capturedEvent({ order, amount: 50000 });

        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.paymentMethod).toBe('cash');
        expect(after.razorpayPaymentId).toBe(order.razorpayPaymentId);
        expect(await PaymentClaim.countDocuments({ paymentId: evt.payload.payment.entity.id })).toBe(0);
    });

    // Regression (fixed 2026-10): the webhook applies the verify-payment coverage rule and never rewrites order.total.
    test('an underpaid capture does not settle the order or lower its total', async () => {
        const order = await makeOrder(A, { total: 500 });

        expectOk(await deliver(capturedEvent({ order, amount: 10000 })));

        const after = await reload(order);
        expect(after.total).toBe(500);
        expect(after.paymentStatus).not.toBe('Paid');
    });

    // Regression (fixed 2026-10): the webhook records prior + captured, walletAmountPaid and method mixed like verify-payment.
    test('an online top-up after a partial wallet payment keeps the wallet share', async () => {
        const order = await makeOrder(A, {
            total: 500,
            amountPaid: 200,
            paymentStatus: 'Partially Paid',
            paymentMethod: 'wallet',
        });

        expectOk(await deliver(capturedEvent({ order, amount: 30000 })));

        const after = await reload(order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.total).toBe(500);
        expect(after.amountPaid).toBe(500);
        expect(after.walletAmountPaid).toBe(200);
        expect(after.paymentMethod).toBe('mixed');
    });

    // Regression (fixed 2026-10): the webhook calls settleSiblingDineInRounds like verify-payment.
    test('a dine-in capture also settles the other unpaid rounds on the table', async () => {
        const table = await createTable(A);
        const first = await makeOrder(A, { type: 'dine-in', table: table._id, total: 300 });
        const sibling = await makeOrder(A, { type: 'dine-in', table: table._id, total: 200, razorpayOrderId: undefined });

        expectOk(await deliver(capturedEvent({ order: first, amount: 50000 })));

        expect((await reload(first)).paymentStatus).toBe('Paid');
        const sib = await reload(sibling);
        expect(sib.paymentStatus).toBe('Paid');
        expect(sib.amountPaid).toBe(0);
    });

    test('records the waiter tip carried on the order', async () => {
        const order = await makeOrder(A, { waiter: A.users.waiter._id, tipAmount: 30, total: 530 });

        expectOk(await deliver(capturedEvent({ order, amount: 53000 })));

        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0]).toMatchObject({ amount: 30, status: 'pending' });
        expect(String(tips[0].waiter)).toBe(String(A.users.waiter._id));
    });

    test('releases the table of a served dine-in order', async () => {
        const table = await createTable(A);
        await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });
        const order = await makeOrder(A, { type: 'dine-in', table: table._id, status: 'served' });

        expectOk(await deliver(capturedEvent({ order, amount: 50000 })));

        expect((await reload(order)).paymentStatus).toBe('Paid');
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });
});

// ── Tenant isolation ─────────────────────────────────────────────────

describe('tenant isolation', () => {
    test("a payment tagged for tenant B cannot settle tenant A's order found by razorpayOrderId", async () => {
        const order = await makeOrder(A);
        const evt = capturedEvent({
            order,
            amount: 50000,
            notes: { cafeOrderId: String(order._id), restaurantId: String(B.restaurant._id) },
        });

        expectOk(await deliver(evt));

        expect((await reload(order)).paymentStatus).toBe('Pending');
        expect(await PaymentClaim.countDocuments({ ref: String(order._id) })).toBe(0);
    });

    test("notes.cafeOrderId pointing at tenant A's order is not resolved under tenant B's tag", async () => {
        const order = await makeOrder(A, { razorpayOrderId: undefined });
        const evt = capturedEvent({
            order,
            amount: 100,
            rzpOrderId: `order_${rid()}`,
            notes: { cafeOrderId: String(order._id), restaurantId: String(B.restaurant._id) },
        });

        expectOk(await deliver(evt));

        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test.each([
        ['missing', undefined],
        ['not an ObjectId', 'tenant-a'],
    ])('a cafeOrderId lookup with the tenant tag %s is refused', async (_label, restaurantId) => {
        const order = await makeOrder(A, { razorpayOrderId: undefined });
        const notes = { cafeOrderId: String(order._id) };
        if (restaurantId !== undefined) notes.restaurantId = restaurantId;

        expectOk(await deliver(capturedEvent({ order, amount: 50000, rzpOrderId: `order_${rid()}`, notes })));

        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('an order already bound to a different Razorpay checkout is not settled via cafeOrderId', async () => {
        const order = await makeOrder(A); // has its own razorpayOrderId
        const evt = capturedEvent({
            order,
            amount: 50000,
            rzpOrderId: `order_${rid()}`,
            notes: { cafeOrderId: String(order._id), restaurantId: String(A.restaurant._id) },
        });

        expectOk(await deliver(evt));

        expect((await reload(order)).paymentStatus).toBe('Pending');
    });

    test('an unknown Razorpay order is acknowledged without touching any order', async () => {
        const order = await makeOrder(B);
        const evt = capturedEvent({ amount: 50000, rzpOrderId: `order_${rid()}`, notes: { cafeOrderId: 'none' } });

        expectOk(await deliver(evt));

        expect((await reload(order)).paymentStatus).toBe('Pending');
    });
});

// ── payment.failed ───────────────────────────────────────────────────

describe('payment.failed', () => {
    const failedEvent = (order) => ({
        event: 'payment.failed',
        payload: { payment: { entity: { ...paymentEntity({ order, amount: 50000 }), status: 'failed' } } },
    });

    test('a failed retry never downgrades an order that is already paid', async () => {
        const order = await paidOrder(A);

        expectOk(await deliver(failedEvent(order)));

        expect((await reload(order)).paymentStatus).toBe('Paid');
    });

    // Regression (fixed 2026-10): payment.failed no longer writes the invalid Failed status; it only logs.
    test('a failed payment on a pending order is handled without hitting the error path', async () => {
        const order = await makeOrder(A);
        const before = logger.__records.length;

        expectOk(await deliver(failedEvent(order)));

        const errors = logger.__records.slice(before)
            .filter((r) => r.level === 'error' && String(r.args[0]).includes('Webhook handler error'));
        expect(errors).toEqual([]);
        expect((await reload(order)).paymentStatus).not.toBe('Paid');
    });

    test('a late failure for an older checkout does not overwrite a newer pending state', async () => {
        const newer = `order_new_${rid()}`;
        const order = await makeOrder(A, {
            razorpayOrderId: newer,
            payment: { state: 'pending', method: 'online', amount: 500, reference: newer, updatedAt: new Date() },
        });
        const stale = { ...order, razorpayOrderId: `order_old_${rid()}` };
        expectOk(await deliver(failedEvent(stale)));
        expect((await reload(order)).payment.state).toBe('pending');

        expectOk(await deliver(failedEvent(order)));
        expect((await reload(order)).payment.state).toBe('failed');
    });
});

// ── refund.processed ─────────────────────────────────────────────────

describe('refund.processed', () => {
    test('a full refund marks the order Refunded, records the refund and revokes the pending tip', async () => {
        const order = await paidOrder(A, { amountPaid: 512.4, total: 512.4, waiter: A.users.waiter._id, tipAmount: 20 });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: order._id, amount: 20 });
        const evt = refundEvent({ order, refundAmount: 51240, paymentAmount: 51240 });

        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.paymentStatus).toBe('Refunded');
        expect(after.refundedAmount).toBe(512.4);
        expect(after.refunds).toHaveLength(1);
        expect(after.refunds[0]).toMatchObject({
            amount: 512.4,
            reason: 'damaged item',
            razorpayRefundId: evt.payload.refund.entity.id,
            source: 'webhook',
        });
        expect((await Tip.findOne({ order: order._id }).lean()).status).toBe('refunded');
    });

    // Regression (fixed 2026-10): refund.processed reads payload.refund.entity.amount.
    test('a partial refund records only the refunded amount and keeps the order Paid', async () => {
        const order = await paidOrder(A);

        expectOk(await deliver(refundEvent({ order, refundAmount: 10000, paymentAmount: 50000 })));

        const after = await reload(order);
        expect(after.refundedAmount).toBe(100);
        expect(after.refunds[0].amount).toBe(100);
        expect(after.paymentStatus).toBe('Paid');
    });

    test('a redelivered refund is counted once', async () => {
        const order = await paidOrder(A);
        const evt = refundEvent({ order, refundAmount: 50000, paymentAmount: 50000 });

        expectOk(await deliver(evt));
        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.refundedAmount).toBe(500);
        expect(after.refunds).toHaveLength(1);
    });

    test('a refund already recorded by the admin refund path is not counted again', async () => {
        const refundId = `rfnd_${rid()}`;
        const order = await paidOrder(A, {
            refundedAmount: 500,
            paymentStatus: 'Refunded',
            refunds: [{ amount: 500, reason: 'admin', razorpayRefundId: refundId, source: 'admin' }],
        });

        expectOk(await deliver(refundEvent({ order, refundId, refundAmount: 50000, paymentAmount: 50000 })));

        const after = await reload(order);
        expect(after.refundedAmount).toBe(500);
        expect(after.refunds).toHaveLength(1);
    });

    // Regression (fixed 2026-10): refund.processed dedupes atomically (filter on refunds.razorpayRefundId).
    test('concurrent duplicate refund deliveries are counted once', async () => {
        const order = await paidOrder(A, { amountPaid: 1000, total: 1000 });
        const evt = refundEvent({ order, refundAmount: 20000, paymentAmount: 20000 });

        const results = await Promise.all([deliver(evt), deliver(evt)]);
        results.forEach(expectOk);

        const after = await reload(order);
        expect(after.refunds).toHaveLength(1);
        expect(after.refundedAmount).toBe(200);
    });

    test("a refund tagged for tenant B does not touch tenant A's order", async () => {
        const order = await paidOrder(A);
        const evt = refundEvent({ order, refundAmount: 50000, paymentAmount: 50000 });
        evt.payload.payment.entity.notes.restaurantId = String(B.restaurant._id);

        expectOk(await deliver(evt));

        const after = await reload(order);
        expect(after.paymentStatus).toBe('Paid');
        expect(after.refundedAmount).toBe(0);
    });
});

// ── plan_payment (fallback Orders API subscription) ──────────────────

describe('payment.captured for a plan payment', () => {
    let P;
    let Q;
    beforeAll(async () => {
        P = await seedTenant({ label: 'wh-plan' });
        Q = await seedTenant({ label: 'wh-plan-q' });
        const pending = {
            planName: 'Pro', planSlug: 'pro', price: 1999,
            features: { reports: true }, limits: { branches: 3 }, fallbackOrder: true,
        };
        await Restaurant.updateOne({ _id: P.restaurant._id }, { $set: { 'subscription.pendingUpgrade': pending } });
        await Restaurant.updateOne({ _id: Q.restaurant._id }, { $set: { 'subscription.pendingUpgrade': { ...pending, planSlug: 'pro-q' } } });
    });

    const planCapture = (restaurantId, paymentId = `pay_${rid()}`) => ({
        event: 'payment.captured',
        payload: {
            payment: {
                entity: {
                    id: paymentId, entity: 'payment', amount: 199900, currency: 'INR', status: 'captured',
                    order_id: `order_${rid()}`, notes: { type: 'plan_payment', restaurantId }, created_at: 1767225600,
                },
            },
        },
    });

    test('applies the pending upgrade and writes exactly one invoice, even on redelivery', async () => {
        const evt = planCapture(String(P.restaurant._id));
        const paymentId = evt.payload.payment.entity.id;

        expectOk(await deliver(evt));
        expectOk(await deliver(evt));

        const r = await Restaurant.findById(P.restaurant._id).lean();
        expect(r.subscription.planSlug).toBe('pro');
        expect(r.subscription.price).toBe(1999);
        expect(r.subscription.status).toBe('active');
        expect(r.subscription.pendingUpgrade?.planSlug || '').toBe('');

        const invoices = await SubscriptionInvoice.find({ razorpayPaymentId: paymentId }, null, { skipTenantScope: true }).lean();
        expect(invoices).toHaveLength(1);
        expect(invoices[0]).toMatchObject({ amount: 199900, currency: 'INR', status: 'paid', planSlug: 'pro' });
        expect(String(invoices[0].restaurant)).toBe(String(P.restaurant._id));

        // The other tenant's pending upgrade is untouched.
        const q = await Restaurant.findById(Q.restaurant._id).lean();
        expect(q.subscription.pendingUpgrade.planSlug).toBe('pro-q');
    });

    test.each([
        ['missing', undefined],
        ['not an ObjectId', 'nope'],
        ['an unknown tenant', '0123456789abcdef01234567'],
    ])('a plan payment whose tenant tag is %s changes nothing', async (_label, restaurantId) => {
        const evt = planCapture(restaurantId);

        expectOk(await deliver(evt));

        const n = await SubscriptionInvoice.countDocuments(
            { razorpayPaymentId: evt.payload.payment.entity.id }, { skipTenantScope: true });
        expect(n).toBe(0);
        const q = await Restaurant.findById(Q.restaurant._id).lean();
        expect(q.subscription.pendingUpgrade.planSlug).toBe('pro-q');
    });
});

// ── subscription.* lifecycle ─────────────────────────────────────────

describe('subscription events', () => {
    let S;
    let T;
    beforeAll(async () => {
        S = await seedTenant({ label: 'wh-sub' });
        T = await seedTenant({ label: 'wh-sub-t' });
    });

    async function withSubscription(tenant, fields = {}) {
        const subId = `sub_${rid()}`;
        await Restaurant.updateOne(
            { _id: tenant.restaurant._id },
            {
                $set: { status: 'active', suspendedReason: '', 'subscription.razorpaySubscriptionId': subId, 'subscription.haltedCount': 0, ...fields },
                $unset: { 'subscription.firstHaltedAt': '', 'subscription.scheduledSuspendAt': '' },
            },
        );
        return subId;
    }

    // Updated 2026-10 (product decision 5, CRIT-18): a halt no longer locks
    // the tenant out instantly — it becomes past_due with a 24h grace period
    // and utils/haltedSubscriptionSuspender suspends it if nothing is paid.
    test('halted puts only the owning tenant in a 24h grace period and writes a system audit row', async () => {
        const subId = await withSubscription(S);
        await withSubscription(T);
        const before = Date.now();

        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('past_due');
        expect(s.subscription.razorpayStatus).toBe('halted');
        expect(s.subscription.haltedCount).toBe(1);
        const graceMs = new Date(s.subscription.scheduledSuspendAt).getTime() - new Date(s.subscription.firstHaltedAt).getTime();
        expect(graceMs).toBe(24 * 60 * 60 * 1000);
        expect(new Date(s.subscription.firstHaltedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(s.suspendedReason || '').toBe('');
        expect((await Restaurant.findById(T.restaurant._id).lean()).status).toBe('active');

        const audit = await AuditLog.findOne({ targetId: S.restaurant._id, action: 'subscription.halted' }).sort({ createdAt: -1 }).lean();
        expect(audit).toMatchObject({ actor: null, actorRole: 'system', actorEmail: 'razorpay-webhook' });
        expect(audit.details).toMatchObject({ previousStatus: 'active', newStatus: 'past_due' });
    });

    test('a repeated halt never extends the grace deadline', async () => {
        const subId = await withSubscription(S);
        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));
        const first = (await Restaurant.findById(S.restaurant._id).lean()).subscription.scheduledSuspendAt;

        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(new Date(s.subscription.scheduledSuspendAt).toISOString()).toBe(new Date(first).toISOString());
        expect(s.subscription.haltedCount).toBe(2);
    });

    test('a tenant already suspended for another reason stays suspended on a halt', async () => {
        const subId = await withSubscription(S, { status: 'suspended', suspendedReason: 'Terms violation' });

        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('suspended');
        expect(s.suspendedReason).toBe('Terms violation');
    });

    test('a charge inside the grace period restores the tenant and cancels the lockout', async () => {
        const subId = await withSubscription(S, { 'subscription.trialEndDate': null });
        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));

        expectOk(await deliver(subscriptionEvent('subscription.charged', { id: subId, status: 'active' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('active');
        expect(s.subscription.haltedCount).toBe(0);
        expect(s.subscription.scheduledSuspendAt).toBeUndefined();
        expect(s.subscription.firstHaltedAt).toBeUndefined();
    });

    test('once the grace period ends without payment the suspender locks the tenant out', async () => {
        const { runHaltedSuspension, SUSPEND_REASON } = require(path.join(BACKEND, 'utils/haltedSubscriptionSuspender'));
        const subId = await withSubscription(S);
        await withSubscription(T);
        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: subId, status: 'halted' })));

        const early = await runHaltedSuspension({ now: new Date(Date.now() + 23 * 60 * 60 * 1000) });
        expect(early.suspended).not.toContain(String(S.restaurant._id));
        expect((await Restaurant.findById(S.restaurant._id).lean()).status).toBe('past_due');

        const late = await runHaltedSuspension({ now: new Date(Date.now() + 25 * 60 * 60 * 1000) });
        expect(late.suspended).toContain(String(S.restaurant._id));
        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s).toMatchObject({ status: 'suspended', suspendedReason: SUSPEND_REASON });
        expect((await Restaurant.findById(T.restaurant._id).lean()).status).toBe('active');
    });

    test('charged after a halt reactivates the tenant, sets the period end and invoices once', async () => {
        const subId = await withSubscription(S, {
            status: 'suspended',
            'subscription.razorpayStatus': 'halted',
            'subscription.trialEndDate': null,
        });
        const currentEnd = 1798761600; // 2027-01-01T00:00:00Z
        const startAt = 1767225600;    // 2026-01-01T00:00:00Z
        const pmt = { id: `pay_${rid()}`, amount: 99900, currency: 'INR', created_at: 1767225600 };
        const evt = subscriptionEvent('subscription.charged',
            { id: subId, status: 'active', current_end: currentEnd, start_at: startAt }, pmt);

        expectOk(await deliver(evt));
        expectOk(await deliver(evt));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('active');
        expect(s.suspendedReason).toBe('');
        expect(s.subscription.razorpayStatus).toBe('active');
        expect(new Date(s.subscription.currentPeriodEnd).toISOString()).toBe('2027-01-01T00:00:00.000Z');

        const invoices = await SubscriptionInvoice.find({ razorpayPaymentId: pmt.id }, null, { skipTenantScope: true }).lean();
        expect(invoices).toHaveLength(1);
        expect(invoices[0]).toMatchObject({ amount: 99900, currency: 'INR', razorpaySubscriptionId: subId });
        expect(invoices[0].invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);
        expect(new Date(invoices[0].periodStart).toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(new Date(invoices[0].periodEnd).toISOString()).toBe('2027-01-01T00:00:00.000Z');
        expect(new Date(invoices[0].paidAt).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    test('charged after a halt returns a tenant still inside its trial to trial, not active', async () => {
        const subId = await withSubscription(S, {
            status: 'suspended',
            'subscription.razorpayStatus': 'halted',
            'subscription.trialEndDate': new Date(Date.now() + 7 * 86400000),
        });

        expectOk(await deliver(subscriptionEvent('subscription.charged', { id: subId, status: 'active' })));

        expect((await Restaurant.findById(S.restaurant._id).lean()).status).toBe('trial');
    });

    test('charged does not reactivate a tenant suspended for a reason other than a halt', async () => {
        const subId = await withSubscription(S, {
            status: 'suspended',
            suspendedReason: 'Terms violation',
            'subscription.razorpayStatus': 'active',
        });

        expectOk(await deliver(subscriptionEvent('subscription.charged', { id: subId, status: 'active' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('suspended');
        expect(s.suspendedReason).toBe('Terms violation');
    });

    test.each([
        'subscription.pending',
        'subscription.authenticated',
        'subscription.activated',
        'subscription.paused',
    ])('%s only syncs razorpayStatus and leaves tenant access alone', async (event) => {
        const subId = await withSubscription(S);
        const status = event.replace('subscription.', '');

        expectOk(await deliver(subscriptionEvent(event, { id: subId, status })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('active');
        expect(s.subscription.razorpayStatus).toBe(status);
    });

    test('charged on a fresh upgrade is matched by the pending subscription id and applies the plan', async () => {
        await withSubscription(S);
        const newSub = `sub_${rid()}`;
        await Restaurant.updateOne({ _id: S.restaurant._id }, {
            $set: { 'subscription.pendingUpgrade': { planName: 'Growth', planSlug: 'growth', price: 2999, razorpaySubscriptionId: newSub } },
        });

        expectOk(await deliver(subscriptionEvent('subscription.charged', { id: newSub, status: 'active' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.subscription.planSlug).toBe('growth');
        expect(s.subscription.price).toBe(2999);
        expect(s.subscription.razorpaySubscriptionId).toBe(newSub);
    });

    test('cancelled keeps the tenant active until the period ends', async () => {
        const subId = await withSubscription(S);

        expectOk(await deliver(subscriptionEvent('subscription.cancelled', { id: subId, status: 'cancelled' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.status).toBe('active');
        expect(s.subscription.razorpayStatus).toBe('cancelled');
    });

    test('completed applies a scheduled downgrade', async () => {
        const subId = await withSubscription(S, {
            'subscription.planSlug': 'growth',
            'subscription.scheduledDowngrade': {
                planName: 'Basic', planSlug: 'basic', price: 499,
                effectiveAt: new Date(Date.now() + 86400000),
            },
        });

        expectOk(await deliver(subscriptionEvent('subscription.completed', { id: subId, status: 'completed' })));

        const s = await Restaurant.findById(S.restaurant._id).lean();
        expect(s.subscription.planSlug).toBe('basic');
        expect(s.subscription.price).toBe(499);
        expect(s.subscription.scheduledDowngrade?.planSlug || '').toBe('');
    });

    test('an event for an unknown subscription changes no tenant', async () => {
        await withSubscription(T);

        expectOk(await deliver(subscriptionEvent('subscription.halted', { id: `sub_${rid()}`, status: 'halted' })));

        expect((await Restaurant.findById(T.restaurant._id).lean()).status).toBe('active');
    });

    test('an event without a subscription entity is acknowledged', async () => {
        expectOk(await deliver({ event: 'subscription.halted', payload: {} }));
    });
});
