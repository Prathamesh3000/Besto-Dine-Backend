/**
 * STRICT multi-tenancy: payment flow
 *   razorpayRoute (webhook, verify-payment, create-order, refund, orphan-refund,
 *   wallet recharge, reconcile), paymentRoute, refundRequestRoute, walletRoute.
 *
 * "BUG:" tests pin real cross-tenant leaks and are expected to FAIL until fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');
const { settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const RefundRequest = require(path.join(BACKEND, 'models/refundRequest'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const hmac = (s, k) => crypto.createHmac('sha256', k).update(s).digest('hex');
const checkoutSig = (o, p) => hmac(`${o}|${p}`, KEY_SECRET);

let A; let B; let bCust; let aCust; let aPinned;
const SECRET = 'SECRET-B-PAYER';

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `PM-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, status: 'new', paymentStatus: 'Pending', razorpayOrderId: `order_${rid()}`, ...fields,
    });
    return doc.toObject();
}
const snap = async (o) => JSON.stringify(await Order.findById(o._id).lean());
const paidFields = () => ({
    paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 500, paidAt: new Date(),
    razorpayPaymentId: `pay_${rid()}`, customerName: SECRET,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'smp-a' });
    B = await seedTenant({ label: 'smp-b' });
    bCust = await createCustomer('smpb');
    aCust = await createCustomer('smpa');
    const br2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A2', slug: 'a2', isActive: true });
    aPinned = await createUser({
        name: 'pinned a', email: `pin.${rid()}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: br2._id, permissions: defaultPermissionsForRole('admin'),
    });
});

function webhook(payload, { signature, headers = {} } = {}) {
    const raw = JSON.stringify(payload);
    let r = ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature || hmac(raw, WH_SECRET));
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(raw);
}
const capture = (payment, event = 'payment.captured') => ({ event, payload: { payment: { entity: { entity: 'payment', status: 'captured', currency: 'INR', ...payment } } } });

// ── Webhook ──────────────────────────────────────────────────────────
describe('webhook: a payment tagged for tenant A can never settle / mutate tenant B', () => {
    test.each([
        ['B order _id in notes.cafeOrderId + notes.restaurantId=A', (o) => ({ order_id: `order_${rid()}`, notes: { cafeOrderId: String(o._id), restaurantId: String(A.restaurant._id) } })],
        ['B orderId string in notes + restaurantId=A', (o) => ({ order_id: `order_${rid()}`, notes: { cafeOrderId: o.orderId, restaurantId: String(A.restaurant._id) } })],
        ["B's razorpay order_id + notes.restaurantId=A", (o) => ({ order_id: o.razorpayOrderId, notes: { restaurantId: String(A.restaurant._id) } })],
        ["B's razorpay order_id + notes cafeOrderId=A order", (o) => ({ order_id: o.razorpayOrderId, notes: { cafeOrderId: 'none', restaurantId: String(A.restaurant._id) } })],
        ['B order _id with NO restaurantId tag', (o) => ({ order_id: `order_${rid()}`, notes: { cafeOrderId: String(o._id) } })],
        ['B order _id with injected restaurantId object', (o) => ({ order_id: `order_${rid()}`, notes: { cafeOrderId: String(o._id), restaurantId: { $ne: null } } })],
    ])('payment.captured: %s', async (_l, build) => {
        const bOrder = await mkOrder(B);
        const before = await snap(bOrder);
        const claimsBefore = await PaymentClaim.countDocuments({});
        const pay = { id: `pay_${rid()}`, amount: 50000, ...build(bOrder) };
        const res = await webhook(capture(pay));
        expect(res.status).toBe(200);
        await settle(100);
        expect(await snap(bOrder)).toBe(before);
        expect(await PaymentClaim.countDocuments({ razorpayPaymentId: pay.id })).toBe(0);
        expect(await PaymentClaim.countDocuments({})).toBe(claimsBefore);
    });

    test('payment.failed tagged A cannot flip B order payment state', async () => {
        const bOrder = await mkOrder(B);
        const before = await snap(bOrder);
        const res = await webhook(capture({ id: `pay_${rid()}`, amount: 50000, status: 'failed', order_id: bOrder.razorpayOrderId, notes: { restaurantId: String(A.restaurant._id) } }, 'payment.failed'));
        expect(res.status).toBe(200);
        await settle(100);
        expect(await snap(bOrder)).toBe(before);
    });

    test("refund.processed for B's paid order, tagged A, records no refund on B", async () => {
        const bOrder = await mkOrder(B, paidFields());
        const before = await snap(bOrder);
        const txBefore = await Transaction.countDocuments({ order: bOrder._id });
        const ev = capture({ id: bOrder.razorpayPaymentId, amount: 50000, order_id: bOrder.razorpayOrderId, status: 'refunded', amount_refunded: 50000, notes: { restaurantId: String(A.restaurant._id) } }, 'refund.processed');
        ev.payload.refund = { entity: { id: `rfnd_${rid()}`, payment_id: bOrder.razorpayPaymentId, amount: 50000, status: 'processed' } };
        const res = await webhook(ev);
        expect(res.status).toBe(200);
        await settle(100);
        expect(await snap(bOrder)).toBe(before);
        expect(await Transaction.countDocuments({ order: bOrder._id })).toBe(txBefore);
    });

    test("refund.processed with A's payment id referencing B payment id does not refund B", async () => {
        const bOrder = await mkOrder(B, paidFields());
        const before = await snap(bOrder);
        const ev = capture({ id: bOrder.razorpayPaymentId, amount: 50000, status: 'refunded', amount_refunded: 50000, notes: { restaurantId: String(A.restaurant._id), cafeOrderId: String(bOrder._id) } }, 'refund.processed');
        ev.payload.refund = { entity: { id: `rfnd_${rid()}`, payment_id: bOrder.razorpayPaymentId, amount: 50000, status: 'processed' } };
        await webhook(ev);
        await settle(100);
        expect(await snap(bOrder)).toBe(before);
    });

    test('forged signature / staff bearer token never reaches the order lookup', async () => {
        const bOrder = await mkOrder(B);
        const before = await snap(bOrder);
        const pay = { id: `pay_${rid()}`, amount: 50000, order_id: bOrder.razorpayOrderId, notes: { restaurantId: String(B.restaurant._id), cafeOrderId: String(bOrder._id) } };
        const res = await webhook(capture(pay), { signature: 'deadbeef', headers: { Authorization: `Bearer ${B.users.admin.token}`, 'X-Restaurant-Slug': B.slug } });
        expect(res.status).toBe(200);
        await settle(50);
        expect(await snap(bOrder)).toBe(before);
    });

    test('control: a correctly tagged, signed webhook DOES settle tenant B (the harness works)', async () => {
        const bOrder = await mkOrder(B);
        const pay = { id: `pay_${rid()}`, amount: 50000, order_id: bOrder.razorpayOrderId, notes: { restaurantId: String(B.restaurant._id), cafeOrderId: String(bOrder._id), purpose: 'cafe_order' } };
        await webhook(capture(pay));
        await settle(200);
        const after = await Order.findById(bOrder._id).lean();
        expect(after.paymentStatus).toBe('Paid');
        expect(String(after.restaurant)).toBe(String(B.restaurant._id));
    });

    test("one payment id claimed by tenant B's order cannot be re-applied to tenant A's order", async () => {
        const bOrder = await mkOrder(B);
        const aOrder = await mkOrder(A);
        const payId = `pay_${rid()}`;
        await webhook(capture({ id: payId, amount: 50000, order_id: bOrder.razorpayOrderId, notes: { restaurantId: String(B.restaurant._id), cafeOrderId: String(bOrder._id), purpose: 'cafe_order' } }));
        await settle(200);
        await webhook(capture({ id: payId, amount: 50000, order_id: aOrder.razorpayOrderId, notes: { restaurantId: String(A.restaurant._id), cafeOrderId: String(aOrder._id), purpose: 'cafe_order' } }));
        await settle(200);
        expect((await Order.findById(aOrder._id).lean()).paymentStatus).not.toBe('Paid');
    });
});

// ── verify-payment / create-order ────────────────────────────────────
describe('razorpay verify-payment / create-order with B order ids', () => {
    test.each([
        ['guest on slug A', () => ctx.api.guest(A)],
        ['A customer', () => ctx.api.as(aCust, A)],
        ['A owner', () => ctx.api.as(A.users.admin)],
    ])('verify-payment (valid signature) for B order via %s → 404, B untouched', async (_l, api) => {
        const bOrder = await mkOrder(B);
        const before = await snap(bOrder);
        const payId = `pay_${rid()}`;
        for (const ref of [String(bOrder._id), bOrder.orderId]) {
            const res = await api().post('/razorpay/verify-payment').set('Idempotency-Key', `k-${rid()}`)
                .send({ razorpay_order_id: bOrder.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: checkoutSig(bOrder.razorpayOrderId, payId), cafeOrderId: ref });
            expect([400, 403, 404]).toContain(res.status);
            expect(JSON.stringify(res.body)).not.toContain(SECRET);
        }
        expect(await snap(bOrder)).toBe(before);
    });

    test("anonymous (no slug): attacker's own tenant-A payment replayed onto B's unlinked order is refused", async () => {
        const bOrder = await mkOrder(B, { razorpayOrderId: undefined });
        const before = await snap(bOrder);
        const rzpA = `order_${rid()}`; const payId = `pay_${rid()}`;
        const notes = { restaurantId: String(A.restaurant._id), cafeOrderId: 'none', purpose: 'cafe_order' };
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpA, status: 'captured', amount: 50000, currency: 'INR', notes });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpA, entity: 'order', amount: 50000, notes });
        const res = await ctx.api.anon().post('/razorpay/verify-payment').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: rzpA, razorpay_payment_id: payId, razorpay_signature: checkoutSig(rzpA, payId), cafeOrderId: String(bOrder._id) });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await snap(bOrder)).toBe(before);
    });

    test('create-order with a B cafeOrderId from slug A / A staff is refused and B order untouched', async () => {
        const bOrder = await mkOrder(B);
        const before = await snap(bOrder);
        rzp.instance.orders.create.mockImplementation(async (o) => ({ id: `order_${rid()}`, ...o }));
        for (const api of [ctx.api.guest(A), ctx.api.as(A.users.admin), ctx.api.as(aCust, A)]) {
            for (const ref of [String(bOrder._id), bOrder.orderId]) {
                const res = await api.post('/razorpay/create-order').send({ amount: 500, cafeOrderId: ref });
                expect([400, 403, 404]).toContain(res.status);
            }
        }
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
        expect(await snap(bOrder)).toBe(before);
    });

    test("create-order on slug A stamps notes.restaurantId = A even when body names B", async () => {
        rzp.instance.orders.create.mockImplementation(async (o) => ({ id: `order_${rid()}`, ...o }));
        const res = await ctx.api.guest(A).post('/razorpay/create-order').send({ amount: 100, restaurantId: String(B.restaurant._id), restaurant: String(B.restaurant._id), notes: { restaurantId: String(B.restaurant._id) } });
        if (rzp.instance.orders.create.mock.calls.length) {
            expect(String(rzp.instance.orders.create.mock.calls[0][0].notes.restaurantId)).toBe(String(A.restaurant._id));
        } else {
            expect(res.status).toBeGreaterThanOrEqual(400);
        }
    });
});

// ── razorpay admin refund ────────────────────────────────────────────
describe('POST /razorpay/refund with B orders', () => {
    test.each([
        ['A owner', () => A.users.admin],
        ['A branch-pinned admin', () => aPinned],
    ])('%s cannot refund B order (_id / orderId) — no gateway call, B untouched', async (_l, pick) => {
        const bOrder = await mkOrder(B, paidFields());
        const before = await snap(bOrder);
        rzp.instance.payments.refund.mockResolvedValue({ id: 'rfnd_x', status: 'processed' });
        for (const ref of [String(bOrder._id), bOrder.orderId]) {
            const res = await ctx.api.as(pick()).post('/razorpay/refund').set('Idempotency-Key', `k-${rid()}`).send({ orderId: ref, amount: 100, reason: 'x' });
            expect([400, 403, 404]).toContain(res.status);
            expect(JSON.stringify(res.body)).not.toContain(SECRET);
        }
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
        expect(await snap(bOrder)).toBe(before);
    });

    test('operator injection in orderId is refused', async () => {
        const res = await ctx.api.as(A.users.admin).post('/razorpay/refund').set('Idempotency-Key', `k-${rid()}`).send({ orderId: { $ne: null }, amount: 100 });
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('orphan-refund: payment whose notes belong to tenant B is refused from slug A', async () => {
        const payId = `pay_${rid()}`; const rzpO = `order_${rid()}`;
        const notes = { restaurantId: String(B.restaurant._id), cafeOrderId: 'none', purpose: 'cafe_order', userId: String(bCust._id) };
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpO, status: 'captured', amount: 50000, amount_refunded: 0, currency: 'INR', notes, created_at: Math.floor(Date.now() / 1000) });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpO, entity: 'order', amount: 50000, notes });
        rzp.instance.payments.refund.mockResolvedValue({ id: 'rfnd_x', status: 'processed' });
        for (const api of [ctx.api.guest(A), ctx.api.as(bCust, A), ctx.api.as(aCust, A)]) {
            const res = await api.post('/razorpay/orphan-refund').set('Idempotency-Key', `k-${rid()}`)
                .send({ razorpay_payment_id: payId, razorpay_order_id: rzpO, razorpay_signature: checkoutSig(rzpO, payId) });
            expect(res.status).toBeGreaterThanOrEqual(400);
        }
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
    });

    test('reconcile by A admin does not touch B pending orders', async () => {
        const bOrder = await mkOrder(B, { createdAt: new Date(Date.now() - 3 * 3600e3) });
        const before = await snap(bOrder);
        rzp.instance.orders.fetchPayments.mockResolvedValue({ items: [{ id: `pay_${rid()}`, status: 'captured', amount: 50000, order_id: bOrder.razorpayOrderId, notes: { restaurantId: String(B.restaurant._id), cafeOrderId: String(bOrder._id) } }] });
        const res = await ctx.api.as(A.users.admin).get('/razorpay/reconcile');
        expect(res.status).toBeLessThan(500);
        expect(rzp.instance.orders.fetchPayments).not.toHaveBeenCalledWith(bOrder.razorpayOrderId);
        expect(await snap(bOrder)).toBe(before);
    });
});

// ── wallet recharge ──────────────────────────────────────────────────
describe('wallet recharge across tenants', () => {
    test("a recharge paid for tenant B cannot be verified (and credited) on tenant A's slug", async () => {
        const cust = await createCustomer('rech');
        await setWallet(A, cust, { balance: 10 });
        await setWallet(B, cust, { balance: 20 });
        const payId = `pay_${rid()}`; const rzpO = `order_${rid()}`;
        const notes = { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(B.restaurant._id) };
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpO, status: 'captured', amount: 10000, currency: 'INR', notes });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpO, entity: 'order', amount: 10000, notes });
        const res = await ctx.api.as(cust, A).post('/razorpay/verify-wallet-recharge').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: rzpO, razorpay_payment_id: payId, razorpay_signature: checkoutSig(rzpO, payId) });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).balance).toBe(10);
        expect((await Wallet.findOne({ user: cust._id, restaurant: B.restaurant._id }).lean()).balance).toBe(20);
    });

    test("a recharge paid for tenant B verified with NO tenant context must not credit another tenant's wallet", async () => {
        // checkWalletRechargePayment skips the tenant check when the request has no tenant
        // (utils/paymentChecks.js:110); this pins that the request is nevertheless refused / not
        // credited to tenant A's wallet.
        const cust = await createCustomer('rech2');
        await setWallet(A, cust, { balance: 10 });
        await setWallet(B, cust, { balance: 20 });
        const payId = `pay_${rid()}`; const rzpO = `order_${rid()}`;
        const notes = { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(B.restaurant._id) };
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpO, status: 'captured', amount: 10000, currency: 'INR', notes });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpO, entity: 'order', amount: 10000, notes });
        await ctx.api.as(cust).post('/razorpay/verify-wallet-recharge').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: rzpO, razorpay_payment_id: payId, razorpay_signature: checkoutSig(rzpO, payId) });
        await settle(100);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).balance).toBe(10);
        expect(await Wallet.countDocuments({ user: cust._id, restaurant: null })).toBe(0);
    });
});

// ── GET /payments/admin/all ──────────────────────────────────────────
describe('GET /payments/admin/all', () => {
    test('A admin sees only A payments; stats exclude B; branch / tenant params do not widen', async () => {
        const bOrder = await mkOrder(B, paidFields());
        const aOrder = await mkOrder(A, { ...paidFields(), customerName: 'A-PAYER' });
        const baseline = await ctx.api.as(A.users.admin).get('/payments/admin/all');
        expect(baseline.status).toBe(200);
        const s = JSON.stringify(baseline.body);
        expect(s).toContain(String(aOrder._id));
        expect(s).not.toContain(String(bOrder._id));
        expect(s).not.toContain(SECRET);
        for (const q of [`?branch=all`, `?branch=${B.branch._id}`, `?restaurant=${B.restaurant._id}`, `?restaurantId=${B.restaurant._id}`, '?branch[$ne]=x']) {
            const res = await ctx.api.as(A.users.admin).get(`/payments/admin/all${q}`).set('X-Restaurant-Slug', B.slug);
            expect(res.status).toBeLessThan(500);
            expect(JSON.stringify(res.body)).not.toContain(String(bOrder._id));
            expect(JSON.stringify(res.body)).not.toContain(SECRET);
        }
        const pinned = await ctx.api.as(aPinned).get(`/payments/admin/all?branch=${B.branch._id}`);
        expect(JSON.stringify(pinned.body)).not.toContain(String(bOrder._id));
    });
});

// ── refund requests ──────────────────────────────────────────────────
describe('refund requests', () => {
    async function bRequest() {
        const order = await mkOrder(B, { ...paidFields(), user: bCust._id });
        const rr = await RefundRequest.create({
            restaurant: B.restaurant._id, branch: B.branch._id, order: order._id, orderIdRef: order.orderId,
            user: bCust._id, customerName: SECRET, customerPhone: '9000000000', amount: 100, reason: 'B reason', source: 'customer-request', status: 'pending',
        });
        return { order, rr };
    }

    test('A customer cannot create a request for a B order (by _id or orderId)', async () => {
        const { order } = await bRequest();
        const before = await RefundRequest.countDocuments({ order: order._id });
        for (const api of [ctx.api.as(aCust, A), ctx.api.as(bCust, A)]) {
            for (const ref of [String(order._id), order.orderId]) {
                const res = await api.post('/refund-requests').send({ orderId: ref, reason: 'steal', amount: 100 });
                expect([403, 404]).toContain(res.status);
            }
        }
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(before);
    });

    test('A admin list excludes B rows, filters/search cannot reach B', async () => {
        const { rr } = await bRequest();
        for (const q of ['', '?status=all', `?search=${SECRET}`, `?search=${rr.orderIdRef}`, `?branch=${B.branch._id}`, `?restaurant=${B.restaurant._id}`, '?status[$ne]=x']) {
            const res = await ctx.api.as(A.users.admin).get(`/refund-requests${q}`);
            expect(res.status).toBeLessThan(500);
            const s = JSON.stringify(res.body);
            expect(s).not.toContain(String(rr._id));
            expect(s).not.toContain(SECRET);
        }
        const pinned = await ctx.api.as(aPinned).get('/refund-requests?status=all');
        expect(JSON.stringify(pinned.body)).not.toContain(String(rr._id));
    });

    test('approve / reject B request as A admin → 404, no refund, request untouched', async () => {
        const { order, rr } = await bRequest();
        const before = JSON.stringify(await RefundRequest.findById(rr._id).lean());
        const orderBefore = await snap(order);
        rzp.instance.payments.refund.mockResolvedValue({ id: 'rfnd_x', status: 'processed' });
        for (const user of [A.users.admin, aPinned]) {
            for (const action of ['approve', 'reject']) {
                const res = await ctx.api.as(user).post(`/refund-requests/${rr._id}/${action}`).send({ note: 'x' });
                expect(res.status).toBe(404);
            }
        }
        for (const bad of ['not-an-id', '%7B%22%24ne%22%3Anull%7D']) {
            const res = await ctx.api.as(A.users.admin).post(`/refund-requests/${bad}/approve`).send({});
            expect(res.status).toBeLessThan(500);
        }
        expect(rzp.instance.payments.refund).not.toHaveBeenCalled();
        expect(JSON.stringify(await RefundRequest.findById(rr._id).lean())).toBe(before);
        expect(await snap(order)).toBe(orderBefore);
    });

    test("B's customer on slug A sees none of B's requests in /mine", async () => {
        const { rr } = await bRequest();
        const res = await ctx.api.as(bCust, A).get('/refund-requests/mine');
        expect(JSON.stringify(res.body)).not.toContain(String(rr._id));
        const mine = await ctx.api.as(bCust).get('/refund-requests/mine');
        expect(mine.status).toBeLessThan(500);
    });
});

// ── customer wallet ──────────────────────────────────────────────────
describe('wallet routes', () => {
    test("admin routes never see B's customers' balances / history / stats", async () => {
        const c = await createCustomer('wb', { name: SECRET });
        await setWallet(B, c, { balance: 777, loyaltyPoints: 888 });
        await Transaction.create({ user: c._id, restaurant: B.restaurant._id, type: 'wallet_recharge', amount: 777, paymentMethod: 'wallet', description: SECRET, transactionId: `T-${rid()}`, balanceBefore: 0, balanceAfter: 777, status: 'completed' });
        for (const p of ['/wallet/admin/stats', `/wallet/admin/customers?q=${encodeURIComponent('Customer wb')}`, '/wallet/admin/customers?q=' + SECRET, '/wallet/admin/manual-history', '/wallet/admin/reports', '/wallet/admin/reports?branch=all', `/wallet/admin/stats?branch=${B.branch._id}`]) {
            for (const user of [A.users.admin, aPinned]) {
                const res = await ctx.api.as(user).get(p);
                expect(res.status).toBeLessThan(500);
                const s = JSON.stringify(res.body);
                expect(s).not.toContain(SECRET);
                expect(s).not.toContain(String(c._id));
            }
        }
    });

    test("A admin adjust / add-points / set-status on B's wallet never mutates B's wallet", async () => {
        const c = await createCustomer('wb2');
        await setWallet(B, c, { balance: 100, loyaltyPoints: 100 });
        const before = JSON.stringify(await Wallet.findOne({ user: c._id, restaurant: B.restaurant._id }).lean());
        const txBefore = await Transaction.countDocuments({ restaurant: B.restaurant._id, user: c._id });
        const calls = [
            ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 50, type: 'balance', action: 'deduct' }),
            ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 50, type: 'points', action: 'deduct' }),
            ctx.api.as(A.users.admin).post('/wallet/admin/set-status').send({ targetUserId: String(c._id), status: 'blocked' }),
            ctx.api.as(A.users.admin).post('/wallet/points/add').send({ targetUserId: String(c._id), points: 10 }),
            ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 5, type: 'balance', action: 'add', restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) }).set('X-Restaurant-Slug', B.slug),
        ];
        for (const r of calls) expect((await r).status).toBeLessThan(500);
        expect(JSON.stringify(await Wallet.findOne({ user: c._id, restaurant: B.restaurant._id }).lean())).toBe(before);
        expect(await Transaction.countDocuments({ restaurant: B.restaurant._id, user: c._id })).toBe(txBefore);
    });

    test('adjust / set-status with injected targetUserId never 2xx', async () => {
        for (const target of [{ $ne: null }, ['a', 'b'], 'nope', '']) {
            for (const [url, body] of [
                ['/wallet/admin/adjust', { amount: 1, type: 'balance', action: 'add' }],
                ['/wallet/admin/set-status', { status: 'blocked' }],
                ['/wallet/points/add', { points: 1 }],
            ]) {
                const res = await ctx.api.as(A.users.admin).post(url).send({ ...body, targetUserId: target });
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        }
    });

    test('wallet pay on a B order from A customer / A slug is refused; both wallets untouched', async () => {
        const bOrder = await mkOrder(B, { user: bCust._id });
        const before = await snap(bOrder);
        await setWallet(A, aCust, { balance: 1000 });
        for (const ref of [String(bOrder._id), bOrder.orderId]) {
            const res = await ctx.api.as(aCust, A).post('/wallet/pay').set('Idempotency-Key', `k-${rid()}`).send({ orderId: ref, amount: 500 });
            expect([400, 403, 404]).toContain(res.status);
        }
        expect((await Wallet.findOne({ user: aCust._id, restaurant: A.restaurant._id }).lean()).balance).toBe(1000);
        expect(await snap(bOrder)).toBe(before);
    });

    test("GET /wallet on A slug never returns B's balance for the same customer", async () => {
        const c = await createCustomer('wb3');
        await setWallet(A, c, { balance: 11, loyaltyPoints: 1 });
        await setWallet(B, c, { balance: 99999, loyaltyPoints: 99999 });
        const res = await ctx.api.as(c, A).get('/wallet');
        expect(res.status).toBe(200);
        const s = JSON.stringify(res.body);
        expect(s).not.toContain('99999');
    });

    test('redeem points on slug A only moves the A wallet', async () => {
        const c = await createCustomer('wb4');
        await setWallet(A, c, { balance: 0, loyaltyPoints: 0 });
        await setWallet(B, c, { balance: 0, loyaltyPoints: 500 });
        await ctx.api.as(c, A).post('/wallet/points/redeem').send({ points: 100 });
        expect((await Wallet.findOne({ user: c._id, restaurant: B.restaurant._id }).lean()).loyaltyPoints).toBe(500);
    });

    test('non-admin roles cannot call admin wallet routes', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            const res = await ctx.api.as(u).post('/wallet/admin/adjust').send({ targetUserId: String(aCust._id), amount: 1, type: 'balance', action: 'add' });
            expect(res.status).toBe(403);
        }
        const r = await ctx.api.as(aCust, A).post('/wallet/admin/adjust').send({ targetUserId: String(aCust._id), amount: 1000, type: 'balance', action: 'add' });
        expect(r.status).toBe(403);
    });
});
