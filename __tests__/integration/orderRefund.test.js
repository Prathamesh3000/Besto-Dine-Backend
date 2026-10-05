/**
 * Order refunds — two implementations that must agree:
 *   - POST /api/v1/razorpay/refund → controllers/razorpayController.refundPayment
 *   - utils/orderRefund.processOrderRefund (used by the cancel flow)
 *
 * Coverage:
 *   - access: admin / manager (refund permission) only, every other role
 *     refused, cross-tenant order not found, input validation
 *   - limits: unpaid order, over-refund, cumulative partial refunds,
 *     paise-exact remainders (float drift)
 *   - channels: online → gateway refund in paise with the refund id kept,
 *     gateway failure leaves the order untouched; wallet-paid → wallet
 *     credit; refundMode 'wallet'; cash; mixed / counter / unset methods
 *   - loyalty clawback: proportional, already-spent points, points the
 *     order never earned
 *   - concurrency: simultaneous refunds cannot exceed the amount paid
 *   - side effects: refunds[] audit, ledger row, tip revoke, notifications
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
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
const Notification = require(path.join(BACKEND, 'models/notification'));
const Tip = require(path.join(BACKEND, 'models/tip'));
const { processOrderRefund } = require(path.join(BACKEND, 'utils/orderRefund'));

const ctx = useIntegrationApp();
let A;      // refundMode 'original' (default), loyalty 1 pt / ₹
let W;      // refundMode 'wallet'
let B;      // other tenant

const rid = () => crypto.randomBytes(5).toString('hex');
const SETTINGS_ORIGINAL = { wallet: { refundMode: 'original', pointsPerRupee: 1, enableLoyalty: true, minBillToEarn: 100 } };
const SETTINGS_WALLET = { wallet: { refundMode: 'wallet', pointsPerRupee: 1, enableLoyalty: true, minBillToEarn: 100 } };

beforeAll(async () => {
    A = await seedTenant({ label: 'rf-a' });
    W = await seedTenant({ label: 'rf-w' });
    B = await seedTenant({ label: 'rf-b' });
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, {
        $set: { 'wallet.refundMode': 'original', 'wallet.pointsPerRupee': 1, 'wallet.enableLoyalty': true, 'wallet.minBillToEarn': 100 },
    });
    await Settings.updateOne({ restaurant: W.restaurant._id, branch: null }, {
        $set: { 'wallet.refundMode': 'wallet', 'wallet.pointsPerRupee': 1, 'wallet.enableLoyalty': true, 'wallet.minBillToEarn': 100 },
    });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** A paid order. Defaults: ₹500 online with a Razorpay payment id. */
async function paidOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `RF-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        paymentStatus: 'Paid',
        paymentMethod: 'online',
        amountPaid: 500,
        razorpayPaymentId: `pay_${rid()}`,
        paidAt: new Date(),
        ...fields,
    });
    return doc.toObject();
}

async function customerWith(t, { balance = 0, loyaltyPoints = 0 } = {}, label = 'rf') {
    const cust = await createCustomer(label);
    await Wallet.create({ user: cust._id, restaurant: t.restaurant._id, balance, loyaltyPoints });
    return cust;
}

/** Stub the SDK's refund method (payments.refund — the real SDK surface). */
function stubGatewayRefund(id = `rfnd_${rid()}`) {
    rzp.instance.payments.refund.mockImplementation(async (paymentId, params) => ({
        id, entity: 'refund', payment_id: paymentId, amount: params?.amount, status: 'processed',
    }));
    return id;
}

const refund = (t, body, user = t.users.admin) => ctx.api.as(user).post('/razorpay/refund').send(body);
const reload = (order) => Order.findById(order._id).lean();
const walletOf = (t, user) => Wallet.findOne({ user: user._id, restaurant: t.restaurant._id }).lean();
const refundRows = (order) => Transaction.find({ order: order._id, type: 'refund' }).lean();

// ── SDK contract ─────────────────────────────────────────────────────

describe('Razorpay SDK contract', () => {
    test('the installed SDK refunds through payments.refund and has no refunds.create', () => {
        const Actual = jest.requireActual('razorpay');
        const sdk = new Actual({ key_id: 'rzp_test_x', key_secret: 'y' });
        expect(typeof sdk.payments.refund).toBe('function');
        expect(sdk.refunds.create).toBeUndefined();
    });
});

// ── POST /razorpay/refund — access + validation ──────────────────────

describe('POST /razorpay/refund — access', () => {
    test.each([
        ['waiter', (t) => t.users.waiter, 403],
        ['chef', (t) => t.users.chef, 403],
        ['captain', (t) => t.users.captain, 403],
    ])('a %s cannot refund', async (_label, pick, status) => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount: 100 }, pick(A));

        expect(res.status).toBe(status);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    test('a customer cannot refund, not even their own order', async () => {
        const cust = await customerWith(A);
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });

        const res = await ctx.api.as(cust, A).post('/razorpay/refund').send({ orderId: String(order._id), amount: 100 });

        expect(res.status).toBe(403);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    test('a guest is refused with 401', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });
        const res = await ctx.api.guest(A).post('/razorpay/refund').send({ orderId: String(order._id), amount: 100 });
        expect(res.status).toBe(401);
    });

    test('a manager needs the refund permission', async () => {
        const without = await createUser({
            name: 'Mgr no-refund', email: `mgr.${rid()}@staff.test`, role: 'manager',
            restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: false },
        });
        const withPerm = await createUser({
            name: 'Mgr refund', email: `mgr.${rid()}@staff.test`, role: 'manager',
            restaurant: A.restaurant._id, branch: A.branch._id, permissions: { refund: true },
        });
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        const denied = await refund(A, { orderId: String(order._id), amount: 100 }, without);
        const allowed = await refund(A, { orderId: String(order._id), amount: 100 }, withPerm);

        expect(denied.status).toBe(403);
        expect(allowed.status).toBe(200);
        expect((await reload(order)).refundedAmount).toBe(100);
    });

    test("another tenant's order is not found and is left untouched", async () => {
        const foreign = await paidOrder(B, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        const byId = await refund(A, { orderId: String(foreign._id), amount: 100 });
        const byNumber = await refund(A, { orderId: foreign.orderId, amount: 100 });

        expect(byId.status).toBe(404);
        expect(byNumber.status).toBe(404);
        expect((await reload(foreign)).refundedAmount).toBe(0);
    });

    test.each([
        ['missing', undefined],
        ['zero', 0],
        ['negative', -50],
        ['a string', '100'],
        ['an object', { $gt: 0 }],
    ])('an amount that is %s is refused', async (_label, amount) => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount });

        expect(res.status).toBe(400);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    test('a missing order id is refused', async () => {
        const res = await refund(A, { amount: 100 });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Order ID is required/);
    });

    test('an order id sent as a query operator is refused', async () => {
        const res = await refund(A, { orderId: { $ne: null }, amount: 100 });
        expect(res.status).toBe(400);
    });
});

// ── POST /razorpay/refund — limits ───────────────────────────────────

describe('POST /razorpay/refund — limits', () => {
    test.each([
        ['pending', { paymentStatus: 'Pending', amountPaid: 0 }],
        ['partially paid', { paymentStatus: 'Partially Paid', amountPaid: 200 }],
        ['already fully refunded', { paymentStatus: 'Refunded', refundedAmount: 500 }],
    ])('an order that is %s cannot be refunded', async (_label, fields) => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined, ...fields });

        const res = await refund(A, { orderId: String(order._id), amount: 100 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Only paid orders/);
    });

    test('a refund above the amount paid is refused', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount: 500.01 });

        expect(res.status).toBe(400);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    test('partial refunds accumulate; the remainder cannot be exceeded; the last one flips to Refunded', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });

        expect((await refund(A, { orderId: String(order._id), amount: 200 })).status).toBe(200);
        let after = await reload(order);
        expect(after).toMatchObject({ refundedAmount: 200, paymentStatus: 'Paid' });

        const over = await refund(A, { orderId: String(order._id), amount: 300.01 });
        expect(over.status).toBe(400);

        const last = await refund(A, { orderId: String(order._id), amount: 300 });
        expect(last.status).toBe(200);
        expect(last.body.refundedAmount).toBe(500);
        after = await reload(order);
        expect(after).toMatchObject({ refundedAmount: 500, paymentStatus: 'Refunded' });
        expect(after.refunds.map((r) => r.amount)).toEqual([200, 300]);

        const again = await refund(A, { orderId: String(order._id), amount: 1 });
        expect(again.status).toBe(400);
    });

    // Regression (fixed 2026-10): maxRefundable is paise-rounded, so the exact ₹412.30 remainder is accepted.
    test('the exact remaining balance after a partial refund can be refunded', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined, total: 512.4, amountPaid: 512.4 });

        expect((await refund(A, { orderId: String(order._id), amount: 100.1 })).status).toBe(200);
        const res = await refund(A, { orderId: String(order._id), amount: 412.3 });

        expect(res.status).toBe(200);
        expect(await reload(order)).toMatchObject({ refundedAmount: 512.4, paymentStatus: 'Refunded' });
    });

    // Regression (fixed 2026-10): refundedAmount is paise-rounded, so 100.1 + 200.2 reaches 300.3 and flips to Refunded.
    test('two partial refunds that add up to the amount paid mark the order Refunded at exactly that amount', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined, total: 300.3, amountPaid: 300.3 });

        expect((await refund(A, { orderId: String(order._id), amount: 100.1 })).status).toBe(200);
        expect((await refund(A, { orderId: String(order._id), amount: 200.2 })).status).toBe(200);

        expect(await reload(order)).toMatchObject({ refundedAmount: 300.3, paymentStatus: 'Refunded' });
    });
});

// ── POST /razorpay/refund — channels ─────────────────────────────────

describe('POST /razorpay/refund — channels', () => {
    // Regression (fixed 2026-10): refundPayment uses razorpay.payments.refund (SDK 2.9.x has no refunds.create).
    test('an online refund goes to the gateway in paise and stores the refund id', async () => {
        const cust = await customerWith(A, { loyaltyPoints: 1000 });
        const order = await paidOrder(A, { user: cust._id, total: 512.4, amountPaid: 512.4 });
        const refundId = stubGatewayRefund();

        const res = await refund(A, { orderId: String(order._id), amount: 112.4, reason: 'cold food' });

        expect(res.status).toBe(200);
        expect(res.body.razorpayRefundId).toBe(refundId);
        expect(rzp.instance.payments.refund).toHaveBeenCalledWith(order.razorpayPaymentId, expect.objectContaining({ amount: 11240 }));
        const after = await reload(order);
        expect(after).toMatchObject({ refundedAmount: 112.4, paymentStatus: 'Paid' });
        expect(after.refunds[0]).toMatchObject({ amount: 112.4, reason: 'cold food', razorpayRefundId: refundId, source: 'admin' });
        expect((await walletOf(A, cust)).balance).toBe(0); // money goes back to the card, not the wallet
    });

    test('a gateway failure leaves the order, wallet and ledger untouched', async () => {
        const cust = await customerWith(A, { loyaltyPoints: 500 });
        const order = await paidOrder(A, { user: cust._id });
        rzp.instance.payments.refund.mockRejectedValue(new Error('BAD_REQUEST_ERROR'));

        const res = await refund(A, { orderId: String(order._id), amount: 100 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/payment gateway/);
        expect(await reload(order)).toMatchObject({ refundedAmount: 0, paymentStatus: 'Paid' });
        expect(await refundRows(order)).toHaveLength(0);
        expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
    });

    test('an online order without a stored payment id cannot be auto-refunded', async () => {
        const order = await paidOrder(A, { razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount: 100 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/no transaction ID/);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    // Regression (fixed 2026-10): the wallet branch matches paymentMethod case-insensitively (stored as lowercase wallet).
    test('a wallet-paid order is refunded to the wallet', async () => {
        const cust = await customerWith(A, { balance: 50 });
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount: 120.5 });

        expect(res.status).toBe(200);
        expect((await walletOf(A, cust)).balance).toBe(170.5);
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
    });

    test("in 'wallet' refund mode an online order is credited to the wallet without touching the gateway", async () => {
        const cust = await customerWith(W, { balance: 10 });
        const order = await paidOrder(W, { user: cust._id });

        const res = await refund(W, { orderId: String(order._id), amount: 250.25 });

        expect(res.status).toBe(200);
        expect(res.body.razorpayRefundId).toBeNull();
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
        expect((await walletOf(W, cust)).balance).toBe(260.25);
        const [row] = await refundRows(order);
        expect(row).toMatchObject({ amount: 250.25, balanceBefore: 10, balanceAfter: 260.25, paymentMethod: 'upi' });
    });

    test('a cash order is recorded for manual hand-back: no gateway, no wallet credit, one ledger row', async () => {
        const cust = await customerWith(A, { balance: 0 });
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });

        const res = await refund(A, { orderId: String(order._id), amount: 500 });

        expect(res.status).toBe(200);
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
        expect((await walletOf(A, cust)).balance).toBe(0);
        expect(await reload(order)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 500 });
        const [row] = await refundRows(order);
        expect(row).toMatchObject({ amount: 500, paymentMethod: 'cash' });
    });

    // Regression (fixed 2026-10): the refund ledger maps mixed/counter/unknown methods onto the Transaction enum.
    test.each([
        ['mixed', { paymentMethod: 'mixed', walletAmountPaid: 200 }],
        ['counter', { paymentMethod: 'counter' }],
        ['not selected', { paymentMethod: 'Not selected' }],
    ])('an order paid by "%s" can be refunded', async (_label, fields) => {
        const cust = await customerWith(A);
        const order = await paidOrder(A, { user: cust._id, razorpayPaymentId: undefined, ...fields });

        const res = await refund(A, { orderId: String(order._id), amount: 100 });

        expect(res.status).toBe(200);
        expect((await reload(order)).refundedAmount).toBe(100);
    });
});

// ── POST /razorpay/refund — loyalty, tips, notifications ─────────────

describe('POST /razorpay/refund — side effects', () => {
    test('claws back loyalty points in proportion to the refund (floored)', async () => {
        const cust = await customerWith(A, { loyaltyPoints: 600 });
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });

        expect((await refund(A, { orderId: String(order._id), amount: 149.99 })).status).toBe(200);

        expect((await walletOf(A, cust)).loyaltyPoints).toBe(451);
    });

    test('points the customer already spent are not driven negative', async () => {
        const cust = await customerWith(A, { loyaltyPoints: 30 });
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });

        expect((await refund(A, { orderId: String(order._id), amount: 500 })).status).toBe(200);

        expect((await walletOf(A, cust)).loyaltyPoints).toBe(30);
    });

    // Regression (fixed 2026-10): the clawback is a share of the points this order earned, never more.
    test('refunding an order that earned no points leaves the balance alone', async () => {
        const cust = await customerWith(A, { loyaltyPoints: 500 });
        const order = await paidOrder(A, {
            user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined, total: 80, amountPaid: 80,
        });

        expect((await refund(A, { orderId: String(order._id), amount: 80 })).status).toBe(200);

        expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
    });

    test('revokes a pending tip, keeps a settled one, and notifies admin and the customer', async () => {
        const cust = await customerWith(A);
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });
        const settledOrder = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: order._id, amount: 25 });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: settledOrder._id, amount: 25, status: 'settled' });

        expect((await refund(A, { orderId: String(order._id), amount: 100, reason: 'late' })).status).toBe(200);
        expect((await refund(A, { orderId: String(settledOrder._id), amount: 100 })).status).toBe(200);

        expect((await Tip.findOne({ order: order._id }).lean()).status).toBe('refunded');
        expect((await Tip.findOne({ order: settledOrder._id }).lean()).status).toBe('settled');

        await settle();
        const notes = await Notification.find({ 'meta.orderId': order.orderId, title: 'Refund Processed' }).lean();
        expect(notes.map((n) => n.recipientRole).sort()).toEqual(['admin', 'customer']);
        expect(String(notes.find((n) => n.recipientRole === 'customer').recipient)).toBe(String(cust._id));
        expect(notes.every((n) => n.meta.amount === 100)).toBe(true);
    });

    // Both requests pass the balance check on a stale read; the MongoDB
    // transaction write conflict is what stops the second one (it answers
    // 500 "Failed to process refund"). Pins that the money stays safe.
    test('two simultaneous refunds cannot return more than was paid', async () => {
        const cust = await customerWith(W, { balance: 0 });
        const order = await paidOrder(W, { user: cust._id });

        const results = await Promise.all([
            refund(W, { orderId: String(order._id), amount: 300 }),
            refund(W, { orderId: String(order._id), amount: 300 }),
        ]);

        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await walletOf(W, cust)).balance).toBe(300);
        expect((await reload(order)).refundedAmount).toBe(300);
    });
});

// ── utils/orderRefund.processOrderRefund ─────────────────────────────

describe('processOrderRefund', () => {
    const load = (order) => Order.findById(order._id);
    const run = async (order, opts) => processOrderRefund(await load(order), { settings: SETTINGS_ORIGINAL, tenantId: A.restaurant._id, ...opts });

    test.each([
        ['no order', null, {}, /Order not found/],
        ['zero amount', 'paid', { amount: 0 }, /positive number/],
        ['non-numeric amount', 'paid', { amount: 'lots' }, /positive number/],
        ['over-refund', 'paid', { amount: 500.01 }, /exceeds refundable balance/],
        ['unpaid order', 'pending', { amount: 10 }, /Only paid orders/],
    ])('refuses %s', async (_label, kind, opts, error) => {
        let doc = null;
        if (kind === 'paid') doc = await load(await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined }));
        if (kind === 'pending') doc = await load(await paidOrder(A, { paymentStatus: 'Pending', amountPaid: 0 }));

        const result = await processOrderRefund(doc, { settings: SETTINGS_ORIGINAL, ...opts });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(error);
    });

    test('accepts the exact float remainder thanks to its tolerance', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined, total: 512.4, amountPaid: 512.4 });

        expect((await run(order, { amount: 100.1 })).success).toBe(true);
        const result = await run(order, { amount: 412.3 });

        expect(result.success).toBe(true);
        expect((await reload(order)).paymentStatus).toBe('Refunded');
    });

    test('a cash refund is recorded as manual', async () => {
        const cust = await customerWith(A);
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'cash', razorpayPaymentId: undefined });

        const result = await run(order, { amount: 500, reason: 'cancelled' });

        expect(result).toMatchObject({ success: true, mode: 'manual', refundedAmount: 500, razorpayRefundId: null });
        expect((await reload(order)).paymentStatus).toBe('Refunded');
        expect(await refundRows(order)).toHaveLength(1);
    });

    test("'wallet' mode credits the wallet and records balances", async () => {
        const cust = await customerWith(W, { balance: 40 });
        const order = await paidOrder(W, { user: cust._id });

        const result = await processOrderRefund(await load(order), { amount: 99.5, settings: SETTINGS_WALLET, tenantId: W.restaurant._id });

        expect(result).toMatchObject({ success: true, mode: 'wallet' });
        expect((await walletOf(W, cust)).balance).toBe(139.5);
        const [row] = await refundRows(order);
        expect(row).toMatchObject({ balanceBefore: 40, balanceAfter: 139.5 });
    });

    // Regression (fixed 2026-10): processOrderRefund uses razorpay.payments.refund.
    test('an online refund goes to the gateway and returns the refund id', async () => {
        const order = await paidOrder(A);
        const refundId = stubGatewayRefund();

        const result = await run(order, { amount: 500, reason: 'cancelled' });

        expect(result).toMatchObject({ success: true, mode: 'original', razorpayRefundId: refundId });
        expect(rzp.instance.payments.refund).toHaveBeenCalledWith(order.razorpayPaymentId, expect.objectContaining({ amount: 50000 }));
    });

    test('a gateway failure is reported and nothing is written', async () => {
        const order = await paidOrder(A);
        rzp.instance.payments.refund.mockRejectedValue(new Error('down'));

        const result = await run(order, { amount: 100 });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/gateway/);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    test('an online order without a payment id is refused before any write', async () => {
        const order = await paidOrder(A, { razorpayPaymentId: undefined });

        const result = await run(order, { amount: 100 });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no Razorpay transaction id/);
        expect((await reload(order)).refundedAmount).toBe(0);
    });

    // Regression (fixed 2026-10): processOrderRefund matches wallet case-insensitively.
    test('a wallet-paid order is credited back to the wallet', async () => {
        const cust = await customerWith(A, { balance: 0 });
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'wallet', razorpayPaymentId: undefined });

        const result = await run(order, { amount: 200 });

        expect(result).toMatchObject({ success: true, mode: 'wallet' });
        expect((await walletOf(A, cust)).balance).toBe(200);
    });

    // Regression (fixed 2026-10): processOrderRefund maps mixed onto a valid ledger payment method.
    test('a mixed-payment order can be refunded', async () => {
        const cust = await customerWith(A);
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'mixed', walletAmountPaid: 200, razorpayPaymentId: undefined });

        const result = await run(order, { amount: 100 });

        expect(result.success).toBe(true);
    });

    test('revokes the pending tip', async () => {
        const order = await paidOrder(A, { paymentMethod: 'cash', razorpayPaymentId: undefined });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: order._id, amount: 15 });

        expect((await run(order, { amount: 50 })).success).toBe(true);

        expect((await Tip.findOne({ order: order._id }).lean()).status).toBe('refunded');
    });
});
