/**
 * Refund requests (ADM-049) — controllers/refundRequestController.js
 *
 *   POST /api/v1/refund-requests              customer creates a request
 *   GET  /api/v1/refund-requests/mine         customer lists own requests
 *   GET  /api/v1/refund-requests              admin lists (status/search/paging)
 *   POST /api/v1/refund-requests/:id/approve  admin approves → processOrderRefund
 *   POST /api/v1/refund-requests/:id/reject   admin rejects
 *
 * Coverage:
 *   - create: default full balance, partial amount, validation, paid-only,
 *     fully refunded, over-balance, owner / other customer / ownerless
 *     guest order, cross-tenant, staff refused, one pending per order
 *     (sequential + concurrent), re-request after rejection, paise amounts
 *   - list / mine: tenant + branch isolation, status filter, escaped
 *     search, paging bounds
 *   - approve: manual + wallet refunds, balance re-check, decided twice,
 *     cross-tenant / cross-branch, role + refund permission, gateway
 *     failure keeps the request pending, concurrent approvals
 *   - reject: note + notification, no money moved
 *   - cancel flow: a paid order cancelled by the customer queues one request
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
const Settings = require(path.join(BACKEND, 'models/settings'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const RefundRequest = require(path.join(BACKEND, 'models/refundRequest'));

const ctx = useIntegrationApp();
let A;      // refundMode 'original'
let W;      // refundMode 'wallet'
let B;

const rid = () => crypto.randomBytes(5).toString('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'rr-a' });
    W = await seedTenant({ label: 'rr-w' });
    B = await seedTenant({ label: 'rr-b' });
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'wallet.refundMode': 'original' } });
    await Settings.updateOne({ restaurant: W.restaurant._id, branch: null }, { $set: { 'wallet.refundMode': 'wallet' } });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Paid cash order by default (refunds as 'manual' — no gateway). */
async function paidOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `RR-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        paymentStatus: 'Paid',
        paymentMethod: 'cash',
        amountPaid: 500,
        paidAt: new Date(),
        customerName: 'Asha Rao',
        phone: '9876543210',
        ...fields,
    });
    return doc.toObject();
}

async function pendingRequest(t, order, fields = {}) {
    return (await RefundRequest.create({
        restaurant: t.restaurant._id,
        branch: order.branch || null,
        order: order._id,
        orderIdRef: order.orderId,
        user: order.user || null,
        customerName: order.customerName || '',
        customerPhone: order.phone || '',
        amount: order.amountPaid - (order.refundedAmount || 0),
        reason: 'cold food',
        source: 'customer-request',
        status: 'pending',
        ...fields,
    })).toObject();
}

const create = (user, t, body) => ctx.api.as(user, t).post('/refund-requests').send(body);
const approve = (user, rr, body = {}) => ctx.api.as(user).post(`/refund-requests/${rr._id}/approve`).send(body);
const reject = (user, rr, body = {}) => ctx.api.as(user).post(`/refund-requests/${rr._id}/reject`).send(body);
const reloadOrder = (o) => Order.findById(o._id).lean();
const reloadRR = (rr) => RefundRequest.findById(rr._id).lean();

async function staff(t, role, fields = {}) {
    return createUser({
        name: `${role} ${rid()}`, email: `${role}.${rid()}@staff.test`, role,
        restaurant: t.restaurant._id, branch: t.branch._id, permissions: {}, ...fields,
    });
}

// ── Create ───────────────────────────────────────────────────────────

describe('POST /refund-requests', () => {
    test('the owner can request the full refundable balance by default; admins are alerted', async () => {
        const cust = await createCustomer('rr-owner');
        const order = await paidOrder(A, { user: cust._id, refundedAmount: 120.5 });

        const res = await create(cust, A, { orderId: String(order._id), reason: '  cold food  ' });

        expect(res.status).toBe(201);
        expect(res.body.refundRequest).toMatchObject({
            amount: 379.5, status: 'pending', source: 'customer-request', reason: 'cold food',
            orderIdRef: order.orderId, customerName: 'Asha Rao', customerPhone: '9876543210',
        });
        expect(String(res.body.refundRequest.user)).toBe(String(cust._id));

        await settle();
        const alert = await Notification.findOne({ 'meta.orderId': order.orderId, title: 'Refund Request — Action Needed' }).lean();
        expect(alert).toMatchObject({ recipientRole: 'admin', priority: 'high', title: 'Refund Request — Action Needed' });
        expect(alert.meta.amount).toBe(379.5);
    });

    test('a partial amount can be requested by order number', async () => {
        const cust = await createCustomer('rr-partial');
        const order = await paidOrder(A, { user: cust._id });

        const res = await create(cust, A, { orderId: order.orderId, amount: 149.99 });

        expect(res.status).toBe(201);
        expect(res.body.refundRequest.amount).toBe(149.99);
    });

    test.each([
        ['zero', 0],
        ['negative', -10],
        ['an empty string', ''],
        ['a word', 'lots'],
        ['above the balance', 500.01],
    ])('an amount that is %s is refused', async (_label, amount) => {
        const cust = await createCustomer('rr-amt');
        const order = await paidOrder(A, { user: cust._id });

        const res = await create(cust, A, { orderId: String(order._id), amount });

        expect(res.status).toBe(400);
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(0);
    });

    test.each([
        ['missing', undefined, 400],
        ['an operator object', { $ne: null }, 400],
        ['unknown', `RR-${'0'.repeat(10)}`, 404],
    ])('an order id that is %s is refused', async (_label, orderId, status) => {
        const cust = await createCustomer('rr-oid');
        const res = await create(cust, A, { orderId });
        expect(res.status).toBe(status);
    });

    test.each([
        ['unpaid', { paymentStatus: 'Pending', amountPaid: 0 }, /Only paid orders/],
        ['fully refunded but still marked Paid', { refundedAmount: 500 }, /already fully refunded/],
    ])('an order that is %s cannot be requested', async (_label, fields, message) => {
        const cust = await createCustomer('rr-state');
        const order = await paidOrder(A, { user: cust._id, ...fields });

        const res = await create(cust, A, { orderId: String(order._id) });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
    });

    test("a customer cannot request a refund on another customer's order", async () => {
        const owner = await createCustomer('rr-o');
        const other = await createCustomer('rr-x');
        const order = await paidOrder(A, { user: owner._id });

        const res = await create(other, A, { orderId: String(order._id) });

        expect(res.status).toBe(403);
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(0);
    });

    // Regression (fixed 2026-10): createRefundRequest refuses a customer on an ownerless (guest) order.
    test("a customer cannot request a refund on a guest's order they did not place", async () => {
        const stranger = await createCustomer('rr-guest');
        const order = await paidOrder(A, { scanSessionId: `sess-${rid()}` });

        const res = await create(stranger, A, { orderId: String(order._id) });

        expect(res.status).toBe(403);
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(0);
    });

    test("another tenant's order is not found", async () => {
        const cust = await createCustomer('rr-cross');
        const foreign = await paidOrder(B, { user: cust._id });

        const res = await create(cust, A, { orderId: String(foreign._id) });

        expect(res.status).toBe(404);
        expect(await RefundRequest.countDocuments({ order: foreign._id })).toBe(0);
    });

    test.each(['admin', 'waiter'])('a %s cannot use the customer endpoint', async (role) => {
        const order = await paidOrder(A);
        const res = await ctx.api.as(A.users[role]).post('/refund-requests').send({ orderId: String(order._id) });
        expect(res.status).toBe(403);
    });

    test('only one pending request per order; a new one is allowed after a rejection', async () => {
        const cust = await createCustomer('rr-dup');
        const order = await paidOrder(A, { user: cust._id });

        const first = await create(cust, A, { orderId: String(order._id) });
        const second = await create(cust, A, { orderId: String(order._id), amount: 10 });
        expect(first.status).toBe(201);
        expect(second.status).toBe(409);
        expect(second.body.refundRequest.id).toBe(first.body.refundRequest._id);

        expect((await reject(A.users.admin, first.body.refundRequest)).status).toBe(200);
        const third = await create(cust, A, { orderId: String(order._id), amount: 10 });
        expect(third.status).toBe(201);
    });

    test('concurrent requests for one order create exactly one', async () => {
        const cust = await createCustomer('rr-race');
        const order = await paidOrder(A, { user: cust._id });

        const results = await Promise.all([1, 2, 3].map(() => create(cust, A, { orderId: String(order._id) })));

        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        results.filter((r) => r.status !== 201).forEach((r) => expect(r.status).toBe(409));
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(1);
    });

    // Regression (fixed 2026-10): the default amount is paise-rounded (300.3 - 100.1 = 200.2).
    test('the default full-balance amount is stored to the paisa', async () => {
        const cust = await createCustomer('rr-float');
        const order = await paidOrder(A, { user: cust._id, total: 300.3, amountPaid: 300.3, refundedAmount: 100.1 });

        const res = await create(cust, A, { orderId: String(order._id) });

        expect(res.status).toBe(201);
        expect(res.body.refundRequest.amount).toBe(200.2);
    });
});

// ── Lists ────────────────────────────────────────────────────────────

describe('listing refund requests', () => {
    let L;
    let mine;
    let theirs;
    let north;
    let branchAdmin;
    beforeAll(async () => {
        L = await seedTenant({ label: 'rr-list' });
        mine = await createCustomer('rr-mine');
        theirs = await createCustomer('rr-theirs');
        north = await Branch.create({ restaurant: L.restaurant._id, name: 'North', slug: `north-${rid()}`, isActive: true });
        branchAdmin = await staff(L, 'admin', { branch: north._id });

        const o1 = await paidOrder(L, { user: mine._id, orderId: 'RR-LIST-ALPHA', customerName: 'Meera (VIP)' });
        const o2 = await paidOrder(L, { user: theirs._id, orderId: 'RR-LIST-BETA' });
        const o3 = await paidOrder(L, { user: mine._id, orderId: 'RR-LIST-NORTH', branch: north._id });
        await pendingRequest(L, o1, { customerName: 'Meera (VIP)' });
        await pendingRequest(L, o2, { status: 'rejected' });
        await pendingRequest(L, o3);
        await pendingRequest(B, await paidOrder(B, { user: mine._id, orderId: 'RR-LIST-OTHER-TENANT' }));
    });

    const list = (user, query = '') => ctx.api.as(user).get(`/refund-requests${query}`);

    test('a customer sees only their own requests in this tenant', async () => {
        const res = await ctx.api.as(mine, L).get('/refund-requests/mine');

        expect(res.status).toBe(200);
        expect(res.body.data.map((r) => r.orderIdRef).sort()).toEqual(['RR-LIST-ALPHA', 'RR-LIST-NORTH']);
    });

    test('the tenant owner sees every request of the tenant and none of another tenant', async () => {
        const res = await list(L.users.admin, '?status=all');

        expect(res.status).toBe(200);
        const refs = res.body.data.map((r) => r.orderIdRef);
        expect(refs.sort()).toEqual(['RR-LIST-ALPHA', 'RR-LIST-BETA', 'RR-LIST-NORTH']);
        expect(res.body.totalItems).toBe(3);
    });

    test('a branch admin sees only their branch', async () => {
        const res = await list(branchAdmin, '?status=all');

        expect(res.status).toBe(200);
        expect(res.body.data.map((r) => r.orderIdRef)).toEqual(['RR-LIST-NORTH']);
    });

    test('filters by status', async () => {
        const res = await list(L.users.admin, '?status=rejected');
        expect(res.body.data.map((r) => r.orderIdRef)).toEqual(['RR-LIST-BETA']);
    });

    test('search treats regex characters literally', async () => {
        const literal = await list(L.users.admin, `?status=all&search=${encodeURIComponent('(VIP)')}`);
        const wildcard = await list(L.users.admin, `?status=all&search=${encodeURIComponent('.*')}`);

        expect(literal.body.data.map((r) => r.orderIdRef)).toEqual(['RR-LIST-ALPHA']);
        expect(wildcard.body.data).toEqual([]);
    });

    test('a non-string status cannot inject a query operator', async () => {
        const res = await list(L.users.admin, '?status[$ne]=pending');

        expect(res.status).toBe(200);
        expect(res.body.totalItems).toBe(3);
    });

    test('paging is bounded', async () => {
        const res = await list(L.users.admin, '?status=all&limit=1000&page=-5');

        expect(res.status).toBe(200);
        expect(res.body.currentPage).toBe(1);
        expect(res.body.data.length).toBeLessThanOrEqual(50);
    });

    test.each([
        ['a waiter', (t) => t.users.waiter, 403],
        ['a customer', () => null, 403],
    ])('%s cannot list all requests', async (_label, pick, status) => {
        const user = pick(L) || mine;
        const res = await ctx.api.as(user, L).get('/refund-requests');
        expect(res.status).toBe(status);
    });
});

// ── Approve ──────────────────────────────────────────────────────────

describe('POST /refund-requests/:id/approve', () => {
    test('approving a cash order records a manual refund and tells the customer', async () => {
        const cust = await createCustomer('ap-cash');
        const order = await paidOrder(A, { user: cust._id });
        const rr = await pendingRequest(A, order, { amount: 200 });

        const res = await approve(A.users.admin, rr, { note: '  goodwill ' });

        expect(res.status).toBe(200);
        expect(res.body.refund).toMatchObject({ success: true, mode: 'manual', refundedAmount: 200 });
        expect(await reloadRR(rr)).toMatchObject({ status: 'approved', refundMode: 'manual', decisionNote: 'goodwill' });
        expect(String((await reloadRR(rr)).decidedBy)).toBe(String(A.users.admin._id));
        expect(await reloadOrder(order)).toMatchObject({ refundedAmount: 200, paymentStatus: 'Paid' });

        await settle();
        const note = await Notification.findOne({ recipient: cust._id, title: 'Refund Approved' }).lean();
        expect(note.description).toContain('₹200 will be refunded at the counter');
    });

    test("in 'wallet' refund mode the approval credits the customer's wallet", async () => {
        const cust = await createCustomer('ap-wallet');
        await Wallet.create({ user: cust._id, restaurant: W.restaurant._id, balance: 25 });
        const order = await paidOrder(W, { user: cust._id, paymentMethod: 'online', razorpayPaymentId: `pay_${rid()}` });
        const rr = await pendingRequest(W, order);

        const res = await approve(W.users.admin, rr);

        expect(res.status).toBe(200);
        expect((await Wallet.findOne({ user: cust._id, restaurant: W.restaurant._id }).lean()).balance).toBe(525);
        expect(await reloadOrder(order)).toMatchObject({ refundedAmount: 500, paymentStatus: 'Refunded' });
        expect((await reloadRR(rr)).refundMode).toBe('wallet');
    });

    test('an order partly refunded since the request is refunded only what is left', async () => {
        const order = await paidOrder(A, { refundedAmount: 450 });
        const rr = await pendingRequest(A, order, { amount: 500 });

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(200);
        expect(res.body.refund.refundedAmount).toBe(500);
        expect(await reloadOrder(order)).toMatchObject({ refundedAmount: 500, paymentStatus: 'Refunded' });
    });

    test('an order with nothing left to refund cannot be approved; the request stays pending', async () => {
        const order = await paidOrder(A, { refundedAmount: 500 });
        const rr = await pendingRequest(A, order, { amount: 100 });

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/no refundable balance/);
        expect((await reloadRR(rr)).status).toBe('pending');
    });

    test.each(['approved', 'rejected'])('an %s request cannot be approved again', async (status) => {
        const order = await paidOrder(A);
        const rr = await pendingRequest(A, order, { status });

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(400);
        expect((await reloadOrder(order)).refundedAmount).toBe(0);
    });

    test("another tenant's request is not found", async () => {
        const order = await paidOrder(B);
        const rr = await pendingRequest(B, order);

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(404);
        expect((await reloadRR(rr)).status).toBe('pending');
        expect((await reloadOrder(order)).refundedAmount).toBe(0);
    });

    test("a branch admin cannot approve another branch's request", async () => {
        const north = await Branch.create({ restaurant: A.restaurant._id, name: 'North', slug: `north-${rid()}`, isActive: true });
        const northAdmin = await staff(A, 'admin', { branch: north._id });
        const order = await paidOrder(A); // main branch
        const rr = await pendingRequest(A, order);

        const res = await approve(northAdmin, rr);

        expect(res.status).toBe(404);
        expect((await reloadRR(rr)).status).toBe('pending');
    });

    test.each([
        ['waiter', (t) => t.users.waiter],
        ['captain', (t) => t.users.captain],
        ['chef', (t) => t.users.chef],
    ])('a %s cannot approve', async (_label, pick) => {
        const order = await paidOrder(A);
        const rr = await pendingRequest(A, order);

        const res = await approve(pick(A), rr);

        expect(res.status).toBe(403);
        expect((await reloadRR(rr)).status).toBe('pending');
    });

    test('a customer cannot approve their own request', async () => {
        const cust = await createCustomer('ap-self');
        const order = await paidOrder(A, { user: cust._id });
        const rr = await pendingRequest(A, order);

        const res = await ctx.api.as(cust, A).post(`/refund-requests/${rr._id}/approve`).send({});

        expect(res.status).toBe(403);
        expect((await reloadOrder(order)).refundedAmount).toBe(0);
    });

    // Regression (fixed 2026-10): approve/reject require checkPermission("refund") like POST /razorpay/refund.
    test('a manager without the refund permission cannot approve', async () => {
        const manager = await staff(A, 'manager', { permissions: { refund: false } });
        const order = await paidOrder(A);
        const rr = await pendingRequest(A, order);

        const res = await approve(manager, rr);

        expect(res.status).toBe(403);
        expect((await reloadOrder(order)).refundedAmount).toBe(0);
    });

    test('a request whose order no longer exists cannot be approved', async () => {
        const order = await paidOrder(A);
        const rr = await pendingRequest(A, order);
        await Order.deleteOne({ _id: order._id });

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Order not found/);
        expect((await reloadRR(rr)).status).toBe('pending');
    });

    test('a malformed request id is refused', async () => {
        const res = await ctx.api.as(A.users.admin).post('/refund-requests/not-an-id/approve').send({});
        expect(res.status).toBe(400);
    });

    // Regression (fixed 2026-10): processOrderRefund uses razorpay.payments.refund.
    test('approving an online-paid request refunds it through the gateway', async () => {
        const cust = await createCustomer('ap-online');
        const order = await paidOrder(A, { user: cust._id, paymentMethod: 'online', razorpayPaymentId: `pay_${rid()}` });
        const rr = await pendingRequest(A, order);
        rzp.instance.payments.refund.mockResolvedValue({ id: 'rfnd_rr1', entity: 'refund' });

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(200);
        expect(await reloadRR(rr)).toMatchObject({ status: 'approved', refundMode: 'original', razorpayRefundId: 'rfnd_rr1' });
    });

    test('a gateway failure leaves the request pending for a retry', async () => {
        const order = await paidOrder(A, { paymentMethod: 'online', razorpayPaymentId: `pay_${rid()}` });
        const rr = await pendingRequest(A, order);
        rzp.instance.payments.refund.mockRejectedValue(new Error('gateway down'));

        const res = await approve(A.users.admin, rr);

        expect(res.status).toBe(400);
        expect((await reloadRR(rr)).status).toBe('pending');
        expect((await reloadOrder(order)).refundedAmount).toBe(0);
    });

    // Regression (fixed 2026-10): approve atomically claims the request (pending → approved) before refunding.
    test('two admins approving at the same time refund the order once', async () => {
        const cust = await createCustomer('ap-race');
        await Wallet.create({ user: cust._id, restaurant: W.restaurant._id, balance: 0 });
        const order = await paidOrder(W, { user: cust._id });
        const rr = await pendingRequest(W, order);
        const second = await staff(W, 'admin', { branch: null });

        const results = await Promise.all([approve(W.users.admin, rr), approve(second, rr)]);

        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await Wallet.findOne({ user: cust._id, restaurant: W.restaurant._id }).lean()).balance).toBe(500);
        expect((await reloadOrder(order)).refundedAmount).toBe(500);
        expect((await reloadRR(rr)).status).toBe('approved');
    });
});

// ── Reject ───────────────────────────────────────────────────────────

describe('POST /refund-requests/:id/reject', () => {
    test('records the decision and note, notifies the customer and moves no money', async () => {
        const cust = await createCustomer('rj-ok');
        const order = await paidOrder(A, { user: cust._id });
        const rr = await pendingRequest(A, order);

        const res = await reject(A.users.admin, rr, { note: 'Food was eaten' });

        expect(res.status).toBe(200);
        expect(await reloadRR(rr)).toMatchObject({ status: 'rejected', decisionNote: 'Food was eaten' });
        expect(await reloadOrder(order)).toMatchObject({ refundedAmount: 0, paymentStatus: 'Paid' });

        await settle();
        const note = await Notification.findOne({ recipient: cust._id, title: 'Refund Request Declined' }).lean();
        expect(note.description).toContain('Note: Food was eaten');
    });

    test('a decided request cannot be rejected', async () => {
        const order = await paidOrder(A);
        const rr = await pendingRequest(A, order, { status: 'approved' });

        expect((await reject(A.users.admin, rr)).status).toBe(400);
        expect((await reloadRR(rr)).status).toBe('approved');
    });

    test("another tenant's request cannot be rejected", async () => {
        const rr = await pendingRequest(B, await paidOrder(B));

        expect((await reject(A.users.admin, rr)).status).toBe(404);
        expect((await reloadRR(rr)).status).toBe('pending');
    });

    test('a note longer than 1000 characters is refused', async () => {
        const rr = await pendingRequest(A, await paidOrder(A));

        expect((await reject(A.users.admin, rr, { note: 'x'.repeat(1001) })).status).toBe(400);
        expect((await reloadRR(rr)).status).toBe('pending');
    });
});

// ── Cancel flow ──────────────────────────────────────────────────────

describe('cancelling a paid order', () => {
    test('queues exactly one pending refund request for the paid balance', async () => {
        const cust = await createCustomer('cx-paid');
        const order = await paidOrder(A, { user: cust._id, status: 'new', refundedAmount: 100 });

        const first = await ctx.api.as(cust, A).patch(`/orders/${order._id}/cancel`).send({ reason: 'changed my mind' });
        const second = await ctx.api.as(cust, A).patch(`/orders/${order._id}/cancel`).send({ reason: 'again' });

        expect(first.status).toBe(200);
        expect(second.status).toBeLessThan(500);
        const rows = await RefundRequest.find({ order: order._id }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'pending', source: 'customer-cancel', amount: 400 });
        expect((await reloadOrder(order)).refundedAmount).toBe(100); // no money moved yet
    });
});
