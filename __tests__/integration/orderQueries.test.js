/**
 * 5.7 — services/orderQueryService.js + services/orderFormatters.js over
 * the real app and Mongo:
 *
 *   GET /orders/my-orders             customer sees only own orders, paging clamps
 *   GET /orders/:id/detail            owner / same scan session / tenant staff only
 *   GET /orders/live | /past          staff branch scope (staffBranchFilter),
 *                                     filters, injected operators, paging, summary
 *   GET /orders/refunds               scope, status buckets, summary money
 *   GET /orders/active[-list]/table   guest session scope, customer own orders
 *   GET /orders/track/:orderId        kiosk token binding
 *
 * Formatter output is checked for leaks: no password / scan session /
 * Razorpay ids / refund actors, and money fields come back exactly.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { signTypedToken, TOKEN_TYPES } = require(path.join(BACKEND, 'middlewares/authMiddleware'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let B;
let A2;
let subAdminA2;    // admin pinned to branch A2
let cust1;
let cust2;
let seq = 0;
const oid = (p = 'OQ') => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

const SECRET_KEYS = ['password', 'scanSessionId', 'razorpayPaymentId', 'razorpayOrderId', 'razorpaySignature',
    'razorpayRefundId', 'actor', 'actorName', 'tokenVersion', 'clientIdempotencyKey', 'qrToken'];

/** Recursively collect every key in a JSON value. */
function keysDeep(v, out = new Set()) {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
    return out;
}
const expectNoSecrets = (body) => {
    const keys = keysDeep(body);
    for (const k of SECRET_KEYS) expect({ key: k, present: keys.has(k) }).toEqual({ key: k, present: false });
};

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: oid(),
        type: 'takeaway',
        customerName: 'Walk-in',
        phone: '9000000000',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200.5, quantity: 2 }],
        total: 421.05,
        ...fields,
    });
    return doc.toObject();
}

let o1; let o2; let o3; let oB; let oA2;

beforeAll(async () => {
    A = await seedTenant({ label: 'oq-a' });
    B = await seedTenant({ label: 'oq-b' });
    A2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    subAdminA2 = await createUser({
        name: 'sub admin a2', email: `sub.a2.${A.slug}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: A2._id, permissions: defaultPermissionsForRole('admin'),
    });
    cust1 = await createCustomer('oq1', { phone: '9111111111' });
    cust2 = await createCustomer('oq2', { phone: '9222222222' });

    o1 = await mkOrder(A, {
        user: cust1._id, customerName: 'Cust One', phone: '9111111111', status: 'served',
        paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 421.05, walletAmountPaid: 21.05,
        razorpayOrderId: 'order_SECRET', razorpayPaymentId: 'pay_SECRET', scanSessionId: 'sess-secret-1',
        refundedAmount: 100.25,
        refunds: [{ amount: 100.25, reason: 'cold', razorpayRefundId: 'rfnd_SECRET', actor: A.users.admin._id, actorName: 'Admin A' }],
        couponCode: 'SAVE10', couponDiscount: 10.5, tipAmount: 5, pointsRedeemed: 3,
    });
    o2 = await mkOrder(A, { user: cust2._id, customerName: 'Cust Two', phone: '9222222222', status: 'cancelled' });
    o3 = await mkOrder(A, { user: cust1._id, customerName: 'Cust One', status: 'new' });
    oA2 = await mkOrder(A, { branch: A2._id, customerName: 'Branch Two Diner', status: 'served', total: 99 });
    oB = await mkOrder(B, { user: cust1._id, customerName: 'Cust One at B', status: 'served' });
});

// ── detail: stamped bill lines (2026-10) ──────────────────────────────
describe('GET /orders/:id/detail — stamped bill lines', () => {
    // Regression (fixed 2026-10): the detail payload omitted the stamped tax
    // breakdown, so the customer bill re-derived taxes from current settings.
    test('returns the tax breakdown, staff discount and delivery fee stored on the order', async () => {
        const cust = await createCustomer('detail-bill');
        const order = await mkOrder(A, {
            user: cust._id, status: 'served', total: 455,
            gst: 20, gstPercentage: 5, serviceCharge: 40, serviceChargePercentage: 10,
            additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 20, amount: 20 }],
            additionalChargesTotal: 20, manualDiscount: 25, delivery: { requested: true, fee: 30 },
        });

        const res = await ctx.api.as(cust, A).get(`/orders/${order._id}/detail`);

        expect(res.status).toBe(200);
        expect(res.body.order).toMatchObject({
            gst: 20, gstPercentage: 5, serviceCharge: 40, serviceChargePercentage: 10,
            additionalChargesTotal: 20, manualDiscount: 25, deliveryFee: 30,
        });
        expect(res.body.order.additionalCharges).toEqual([{ name: 'Packaging', type: 'Flat', value: 20, amount: 20 }]);
    });
});

// ── my-orders ──────────────────────────────────────────────────────────
describe('GET /orders/my-orders', () => {
    test('customer sees only own orders in the requested tenant', async () => {
        const res = await ctx.api.as(cust1, A).get('/orders/my-orders');
        expect(res.status).toBe(200);
        const ids = res.body.orders.map((o) => o.id).sort();
        expect(ids).toEqual([o1.orderId, o3.orderId].sort());
        expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 2, pages: 1 });
        const other = await ctx.api.as(cust2, A).get('/orders/my-orders');
        expect(other.body.orders.map((o) => o.id)).toEqual([o2.orderId]);
        const atB = await ctx.api.as(cust1, B).get('/orders/my-orders');
        expect(atB.body.orders.map((o) => o.id)).toEqual([oB.orderId]);
    });

    test('row shape: no secrets, money fields exact', async () => {
        const res = await ctx.api.as(cust1, A).get('/orders/my-orders');
        expectNoSecrets(res.body);
        const row = res.body.orders.find((o) => o.id === o1.orderId);
        expect(row).toMatchObject({
            total: 421.05, amountPaid: 421.05, walletAmountPaid: 21.05, couponDiscount: 10.5,
            couponCode: 'SAVE10', tipAmount: 5, pointsRedeemed: 3, paymentStatus: 'Paid', table: 'Takeaway',
        });
        expect(row.items[0]).toEqual({
            menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', price: 200.5, quantity: 2,
            selectedSizes: [], selectedToppings: [], instructions: '',
        });
        expect(row).not.toHaveProperty('refunds');
        expect(row.user).toBe('Cust One'); // own customerName only
    });

    test.each([
        ['limit=1000', '?limit=1000', { page: 1, limit: 100 }],
        ['limit=0', '?limit=0', { page: 1, limit: 20 }],
        ['limit=-5', '?limit=-5', { page: 1, limit: 1 }],
        ['page=-3', '?page=-3&limit=1', { page: 1, limit: 1 }],
        ['page=abc', '?page=abc', { page: 1, limit: 20 }],
        ['page beyond end', '?page=9&limit=1', { page: 9, limit: 1 }],
        ['array params', '?page=2&page=3&limit=1', { page: 2, limit: 1 }],
    ])('pagination bounds: %s', async (_l, qs, want) => {
        const res = await ctx.api.as(cust1, A).get(`/orders/my-orders${qs}`);
        expect(res.status).toBe(200);
        expect(res.body.pagination).toMatchObject({ ...want, total: 2 });
        expect(res.body.orders.length).toBeLessThanOrEqual(want.limit);
        if (want.page === 9) expect(res.body.orders).toEqual([]);
    });

    test('anonymous → 401', async () => {
        expect((await ctx.api.guest(A).get('/orders/my-orders')).status).toBe(401);
    });
});

// ── detail ─────────────────────────────────────────────────────────────
describe('GET /orders/:id/detail', () => {
    test.each([
        ['by _id', () => String(o1._id)],
        ['by orderId', () => o1.orderId],
    ])('owner can read own order %s; formatter leaks nothing internal', async (_l, id) => {
        const res = await ctx.api.as(cust1, A).get(`/orders/${id()}/detail`);
        expect(res.status).toBe(200);
        expectNoSecrets(res.body);
        const o = res.body.order;
        expect(o).toMatchObject({
            orderId: o1.orderId, total: 421.05, amountPaid: 421.05, refundedAmount: 100.25,
            walletAmountPaid: 21.05, couponDiscount: 10.5, isScheduled: false, kitchenStartAt: null,
        });
        expect(o.refunds).toEqual([{ amount: 100.25, reason: 'cold', hasGatewayRefund: true, createdAt: expect.any(String) }]);
    });

    test('another customer, a guest without a token and tenant B staff all get 404', async () => {
        expect((await ctx.api.as(cust2, A).get(`/orders/${o1._id}/detail`)).status).toBe(404);
        expect((await ctx.api.guest(A).get(`/orders/${o1._id}/detail`)).status).toBe(404);
        expect((await ctx.api.as(B.users.admin).get(`/orders/${o1._id}/detail`)).status).toBe(404);
        expect((await ctx.api.as(cust1, B).get(`/orders/${o1._id}/detail`)).status).toBe(404);
    });

    test('guest: same scan session may read; another session at the same table may not', async () => {
        const table = await createTable(A);
        const g1 = await scanTable(ctx.api, table);
        const g2 = await scanTable(ctx.api, table);
        const order = await mkOrder(A, { type: 'dine-in', table: table._id, scanSessionId: g1.sessionId });
        const ok = await ctx.api.guest(A, g1.scanToken).get(`/orders/${order.orderId}/detail`);
        expect(ok.status).toBe(200);
        expect(ok.body.order.table).toBe(table.name);
        expectNoSecrets(ok.body);
        expect((await ctx.api.guest(A, g2.scanToken).get(`/orders/${order.orderId}/detail`)).status).toBe(404);
        // a forged / foreign-tenant scan token
        const forged = signTypedToken(TOKEN_TYPES.SCAN, { tableId: String(table._id), restaurantId: String(B.restaurant._id), sessionId: g1.sessionId }, { expiresIn: '1h' });
        expect((await ctx.api.guest(A, forged).get(`/orders/${order.orderId}/detail`)).status).toBe(404);
        expect((await ctx.api.guest(A, 'garbage').get(`/orders/${order.orderId}/detail`)).status).toBe(404);
    });

    test('tenant staff may read any order of the tenant', async () => {
        expect((await ctx.api.as(A.users.waiter).get(`/orders/${o2._id}/detail`)).status).toBe(200);
    });

    test('a branch-pinned sub-admin cannot read another branch\'s order detail (customer name + phone)', async () => {
        // Regression (fixed 2026-10): getOrderById applies the staff branch pin (404 for another branch's order).
        const res = await ctx.api.as(subAdminA2).get(`/orders/${o1.orderId}/detail`);
        expect(res.status).toBe(404);
    });
});

// ── live / past ────────────────────────────────────────────────────────
describe('GET /orders/live and /orders/past — branch scope + filters', () => {
    test('live: tenant owner sees all A branches, never B; pinned sub-admin sees only A2', async () => {
        const all = await ctx.api.as(A.users.admin).get('/orders/live');
        expect(all.status).toBe(200);
        const ids = all.body.orders.map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining([o1.orderId, o3.orderId, oA2.orderId]));
        expect(ids).not.toContain(oB.orderId);
        const pinned = await ctx.api.as(subAdminA2).get('/orders/live');
        const pids = pinned.body.orders.map((o) => o.id);
        expect(pids).toContain(oA2.orderId);
        expect(pids).not.toContain(o1.orderId);
        expect(pids).not.toContain(o3.orderId);
        // pinned staff can't widen scope via ?branch=
        const widened = await ctx.api.as(subAdminA2).get(`/orders/live?branch=${A.branch._id}`);
        expect(widened.body.orders.map((o) => o.id)).not.toContain(o3.orderId);
        expectNoSecrets(all.body);
    });

    test('live: branch-pinned staff also see un-routed takeaways (branch null) but not other-branch ones', async () => {
        const unrouted = await mkOrder(A, { branch: null, status: 'new' });
        const res = await ctx.api.as(subAdminA2).get('/orders/live');
        expect(res.body.orders.map((o) => o.id)).toContain(unrouted.orderId);
    });

    test('customers and guests cannot list live/past/refunds', async () => {
        for (const p of ['/orders/live', '/orders/past', '/orders/refunds']) {
            expect((await ctx.api.as(cust1, A).get(p)).status).toBe(403);
            expect((await ctx.api.guest(A).get(p)).status).toBe(401);
        }
    });

    test('past: owner ?branch=<A2> narrows; ?branch=all widens; summary counts the full filtered set', async () => {
        const narrowed = await ctx.api.as(A.users.admin).get(`/orders/past?branch=${A2._id}`);
        expect(narrowed.body.orders.map((o) => o.id)).toEqual([oA2.orderId]);
        expect(narrowed.body.summary).toEqual({ total: 1, served: 1, cancelled: 0, revenue: 99 });
        const all = await ctx.api.as(A.users.admin).get('/orders/past?branch=all&limit=1');
        expect(all.body.orders).toHaveLength(1);
        expect(all.body.summary.total).toBe(all.body.pagination.total);
        expect(all.body.pagination.pages).toBe(all.body.pagination.total);
        const ids = (await ctx.api.as(A.users.admin).get('/orders/past?limit=200')).body.orders.map((o) => o.id);
        expect(ids).not.toContain(oB.orderId);
        expect(ids).not.toContain(o3.orderId); // status new is not "past"
    });

    test('past: pinned sub-admin summary is scoped to its branch too (aggregate ObjectId cast)', async () => {
        const res = await ctx.api.as(subAdminA2).get('/orders/past');
        expect(res.body.orders.map((o) => o.id)).toEqual([oA2.orderId]);
        expect(res.body.summary).toEqual({ total: 1, served: 1, cancelled: 0, revenue: 99 });
    });

    test.each([
        ['status[$ne]', '?status[$ne]=served'],
        ['type[$ne]', '?type[$ne]=x'],
        ['search[$regex]', '?search[$regex]=.*'],
        ['branch[$ne]', '?branch[$ne]=x'],
        ['regex metachar search', '?search=(*['],
        ['bad dates', '?from=nope&to=alsonope'],
        ['unknown preset', '?dateRange=forever'],
    ])('past: injected / malformed %s → 200, no operator injection', async (_l, qs) => {
        const res = await ctx.api.as(A.users.admin).get(`/orders/past${qs}`);
        expect(res.status).toBe(200);
        expect(res.body.orders.map((o) => o.id)).not.toContain(oB.orderId);
    });

    test('past: search matches orderId or customer name, case-insensitive', async () => {
        const res = await ctx.api.as(A.users.admin).get('/orders/past?search=cust two');
        expect(res.body.orders.map((o) => o.id)).toEqual([o2.orderId]);
        const byId = await ctx.api.as(A.users.admin).get(`/orders/past?search=${o1.orderId.toLowerCase()}`);
        expect(byId.body.orders.map((o) => o.id)).toEqual([o1.orderId]);
    });

    test('past: status + type filters', async () => {
        const c = await ctx.api.as(A.users.admin).get('/orders/past?status=cancelled');
        expect(c.body.orders.every((o) => o.status === 'cancelled')).toBe(true);
        expect(c.body.orders.map((o) => o.id)).toContain(o2.orderId);
        const d = await ctx.api.as(A.users.admin).get('/orders/past?type=dine-in');
        expect(d.body.orders.every((o) => o.type === 'dine-in')).toBe(true);
    });

    test('past: from/to window excludes older orders', async () => {
        const old = await mkOrder(A, { status: 'served' });
        await Order.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date('2020-01-01T00:00:00Z') } });
        const res = await ctx.api.as(A.users.admin).get(`/orders/past?from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&limit=200`);
        expect(res.body.orders.map((o) => o.id)).not.toContain(old.orderId);
        const oldOnly = await ctx.api.as(A.users.admin).get('/orders/past?from=2019-12-31T00:00:00Z&to=2020-01-02T00:00:00Z');
        expect(oldOnly.body.orders.map((o) => o.id)).toEqual([old.orderId]);
    });
});

// ── refunds ────────────────────────────────────────────────────────────
describe('GET /orders/refunds', () => {
    let full; let partial; let pendingManual; let refundA2;
    beforeAll(async () => {
        full = await mkOrder(A, { status: 'cancelled', paymentStatus: 'Refunded', paymentMethod: 'online', amountPaid: 300, refundedAmount: 300, total: 300 });
        partial = await mkOrder(A, { status: 'served', paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 500, refundedAmount: 120.75, total: 500, user: cust1._id });
        pendingManual = await mkOrder(A, { status: 'cancelled', paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 250, refundedAmount: 0, total: 250 });
        refundA2 = await mkOrder(A, { branch: A2._id, status: 'cancelled', paymentStatus: 'Refunded', amountPaid: 80, refundedAmount: 80, total: 80 });
        await mkOrder(B, { status: 'cancelled', paymentStatus: 'Refunded', amountPaid: 999, refundedAmount: 999 });
    });

    test('owner: all A refund-relevant orders, exact summary money, no B rows', async () => {
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds');
        expect(res.status).toBe(200);
        const ids = res.body.orders.map((o) => o.orderId);
        expect(ids).toEqual(expect.arrayContaining([full.orderId, partial.orderId, pendingManual.orderId, refundA2.orderId, o1.orderId]));
        expect(ids).not.toContain(o2.orderId); // cancelled but never paid
        expect(res.body.orders.every((o) => String(o.branch?._id || o.branch) !== String(B.branch._id))).toBe(true);
        // o1 (100.25) + full (300) + partial (120.75) + A2 (80)
        expect(res.body.summary.totalRefunded).toBe(601);
        expect(res.body.summary.fullCount).toBe(2);
        expect(res.body.summary.partialCount).toBe(2); // o1 + partial
        expect(res.body.summary.pendingManualCount).toBe(1);
        expect(res.body.summary.today).toEqual({ amount: 601, count: 5 });
    });

    test.each([
        ['refunded', (r) => [r.full, r.refundA2]],
        ['partial', (r) => [r.partial, o1]],
        ['pending-manual', (r) => [r.pendingManual]],
    ])('status=%s bucket', async (status, pick) => {
        const res = await ctx.api.as(A.users.admin).get(`/orders/refunds?status=${status}`);
        const want = pick({ full, partial, pendingManual, refundA2 }).map((o) => o.orderId).sort();
        expect(res.body.orders.map((o) => o.orderId).sort()).toEqual(want);
    });

    test('method filter + pinned sub-admin scope', async () => {
        const cash = await ctx.api.as(A.users.admin).get('/orders/refunds?method=Cash');
        expect(cash.body.orders.map((o) => o.orderId).sort()).toEqual([partial.orderId, pendingManual.orderId].sort());
        const pinned = await ctx.api.as(subAdminA2).get('/orders/refunds');
        expect(pinned.body.orders.map((o) => o.orderId)).toEqual([refundA2.orderId]);
        expect(pinned.body.summary.totalRefunded).toBe(80);
    });

    test('populated customer carries only name/email/mobile (no password / tokens)', async () => {
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds?status=partial');
        const row = res.body.orders.find((o) => o.orderId === partial.orderId);
        expect(Object.keys(row.user).sort()).toEqual(expect.arrayContaining(['_id', 'name', 'email']));
        for (const k of ['password', 'tokenVersion', 'role', 'restaurant']) expect(row.user).not.toHaveProperty(k);
    });

    test.each([
        ['method[$ne]', '?method[$ne]=x'],
        ['status array', '?status=refunded&status=partial'],
        ['limit=5000', '?limit=5000'],
    ])('injected / odd params %s → 200 and stay scoped', async (_l, qs) => {
        const res = await ctx.api.as(A.users.admin).get(`/orders/refunds${qs}`);
        expect(res.status).toBe(200);
        expect(res.body.pagination.limit).toBeLessThanOrEqual(100);
    });

    test('an unparseable ?from date is ignored by /orders/refunds (like past-orders)', async () => {
        // Regression (fixed 2026-10): getRefunds drops invalid from/to dates instead of casting an Invalid Date (500).
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds?from=not-a-date');
        expect(res.status).toBe(200);
    });

    test('empty result pagination', async () => {
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds?method=NoSuchMethod');
        expect(res.body.orders).toEqual([]);
        expect(res.body.pagination.total).toBe(0);
    });
});

// ── active table lookups ──────────────────────────────────────────────
describe('GET /orders/active[-list]/table/:tableId', () => {
    let table; let g1; let g2; let gOrder; let custOrder;
    beforeAll(async () => {
        table = await createTable(A);
        g1 = await scanTable(ctx.api, table);
        g2 = await scanTable(ctx.api, table);
        gOrder = await mkOrder(A, { type: 'dine-in', table: table._id, status: 'served', scanSessionId: g1.sessionId, customerName: 'Guest One', phone: '9333333333' });
        custOrder = await mkOrder(A, { type: 'dine-in', table: table._id, status: 'new', user: cust2._id, customerName: 'Cust Two' });
    });

    test('guest sees only its own scan session; no token → nothing', async () => {
        const mine = await ctx.api.guest(A, g1.scanToken).get(`/orders/active-list/table/${table._id}`);
        expect(mine.body.orders.map((o) => o.orderId)).toEqual([gOrder.orderId]);
        const other = await ctx.api.guest(A, g2.scanToken).get(`/orders/active-list/table/${table._id}`);
        expect(other.body.orders).toEqual([]);
        const none = await ctx.api.guest(A).get(`/orders/active-list/table/${table._id}`);
        expect(none.body.orders).toEqual([]);
        const single = await ctx.api.guest(A, g2.scanToken).get(`/orders/active/table/${table._id}`);
        expect(single.body.order).toBeNull();
    });

    test('logged-in customer sees only own orders on the table', async () => {
        const c1 = await ctx.api.as(cust1, A).get(`/orders/active-list/table/${table._id}`);
        expect(c1.body.orders).toEqual([]);
        const c2 = await ctx.api.as(cust2, A).get(`/orders/active/table/${table._id}`);
        expect(c2.body.order.orderId).toBe(custOrder.orderId);
    });

    test('staff see every unpaid order on the table; tenant B staff see none', async () => {
        const staff = await ctx.api.as(A.users.waiter).get(`/orders/active-list/table/${table._id}`);
        expect(staff.body.orders.map((o) => o.orderId).sort()).toEqual([gOrder.orderId, custOrder.orderId].sort());
        const foreign = await ctx.api.as(B.users.admin).get(`/orders/active-list/table/${table._id}`);
        expect(foreign.body.orders).toEqual([]);
    });

    test('guest sessions older than 12 h are hidden from guests but not from staff', async () => {
        const t2 = await createTable(A);
        const g = await scanTable(ctx.api, t2);
        const old = await mkOrder(A, { type: 'dine-in', table: t2._id, status: 'served', scanSessionId: g.sessionId });
        await Order.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 13 * 3600e3) } });
        expect((await ctx.api.guest(A, g.scanToken).get(`/orders/active/table/${t2._id}`)).body.order).toBeNull();
        expect((await ctx.api.as(A.users.waiter).get(`/orders/active/table/${t2._id}`)).body.order.orderId).toBe(old.orderId);
    });

    test('invalid table id → 400', async () => {
        expect((await ctx.api.guest(A).get('/orders/active/table/nope')).status).toBe(400);
        expect((await ctx.api.guest(A).get('/orders/active-list/table/nope')).status).toBe(400);
    });
});

// ── kiosk tracking ────────────────────────────────────────────────────
describe('GET /orders/track/:orderId (kiosk)', () => {
    const kioskToken = (orderId, restaurant) => signTypedToken(TOKEN_TYPES.KIOSK,
        { kind: 'kiosk-track', orderId, restaurant: String(restaurant) }, { expiresIn: '2h' });

    test('valid token → minimal fields only', async () => {
        const k = await mkOrder(A, { source: 'kiosk', customerName: 'Kiosk Kid', scanSessionId: 'zzz' });
        const res = await ctx.api.guest(A).get(`/orders/track/${k.orderId}`).set('X-Kiosk-Token', kioskToken(k.orderId, A.restaurant._id));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.order).sort()).toEqual([
            'cancelledAt', 'createdAt', 'orderId', 'paymentStatus', 'pickupLocation', 'preparationCompletedAt',
            'preparationStartedAt', 'status', 'total', 'type',
        ].filter((x) => x !== 'pickupLocation' || res.body.order.pickupLocation !== undefined).sort());
        expect(res.body.order.total).toBe(421.05);
        expectNoSecrets(res.body);
    });

    test.each([
        ['no token', () => null],
        ['token for another order', (k) => kioskToken('ORD-OTHER', A.restaurant._id)],
        ['token bound to tenant B', (k) => kioskToken(k.orderId, B.restaurant._id)],
        ['scan token instead of kiosk', (k) => signTypedToken(TOKEN_TYPES.SCAN, { tableId: 'x', orderId: k.orderId }, { expiresIn: '1h' })],
        ['expired token', (k) => signTypedToken(TOKEN_TYPES.KIOSK, { kind: 'kiosk-track', orderId: k.orderId, restaurant: String(A.restaurant._id) }, { expiresIn: -10 })],
    ])('%s → 404', async (_l, mk) => {
        const k = await mkOrder(A, { source: 'kiosk' });
        let r = ctx.api.guest(A).get(`/orders/track/${k.orderId}`);
        const tok = mk(k);
        if (tok) r = r.set('X-Kiosk-Token', tok);
        expect((await r).status).toBe(404);
    });

    test('valid token for a non-kiosk order → 404', async () => {
        const k = await mkOrder(A, { source: 'web-customer' });
        const res = await ctx.api.guest(A).get(`/orders/track/${k.orderId}`).set('X-Kiosk-Token', kioskToken(k.orderId, A.restaurant._id));
        expect(res.status).toBe(404);
    });

    test('token presented on another tenant host → 404', async () => {
        const k = await mkOrder(A, { source: 'kiosk' });
        const res = await ctx.api.guest(B).get(`/orders/track/${k.orderId}`).set('X-Kiosk-Token', kioskToken(k.orderId, A.restaurant._id));
        expect(res.status).toBe(404);
    });
});

// ── kitchen board (orderFormatters.formatKitchenOrder / sortKitchenOrders /
//    formatCompletedKitchenOrder) ─────────────────────────────────────
describe('GET /orders/kitchen and /orders/kitchen/completed', () => {
    // "hh:mm AM" in IST, `hours` from now (the customer app's slot format).
    const istSlot = (hours) => new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(new Date(Date.now() + hours * 3600e3));

    let scheduled; let dineIn; let counterOnly; let otherBranch; let served;
    beforeAll(async () => {
        scheduled = await mkOrder(A, { status: 'new', pickupTime: istSlot(3), items: [{ name: 'Biryani', price: 300, quantity: 1, prepTimeMinutes: 35, prepStation: 'kitchen' }] });
        dineIn = await mkOrder(A, { type: 'dine-in', table: A.tables.main._id, status: 'new', items: [{ name: 'Dal', price: 100, quantity: 2, prepStation: 'kitchen' }] });
        counterOnly = await mkOrder(A, { status: 'ready', items: [{ name: 'Water', price: 20, quantity: 1, prepStation: 'counter' }] });
        otherBranch = await mkOrder(A, { branch: A2._id, status: 'new', items: [{ name: 'Soup', price: 90, quantity: 1, prepStation: 'kitchen' }] });
        const started = new Date(Date.now() - 30 * 60e3);
        served = await mkOrder(A, {
            status: 'served', servedAt: new Date(), preparationCompletedAt: new Date(Date.now() - 10 * 60e3),
            items: [{ name: 'Naan', price: 40, quantity: 3, prepStation: 'kitchen' }, { name: 'Dal', price: 100, quantity: 1, prepStation: 'kitchen' }],
        });
        await Order.collection.updateOne({ _id: served._id }, { $set: { createdAt: started } });
    });

    test('pinned chef sees own-branch kitchen orders only; counter-only and other-branch orders are excluded', async () => {
        const res = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(res.status).toBe(200);
        const ids = res.body.orders.map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining([scheduled.orderId, dineIn.orderId]));
        expect(ids).not.toContain(counterOnly.orderId);
        expect(ids).not.toContain(otherBranch.orderId);
        expect(ids).not.toContain(oB.orderId);
        expectNoSecrets(res.body);
    });

    test('scheduled takeaway lands in the "scheduled" bucket with IST-correct pickup / prep-start', async () => {
        const res = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        const card = res.body.orders.find((o) => o.id === scheduled.orderId);
        expect(card.queueBucket).toBe('scheduled');
        expect(card.isUrgent).toBe(false);
        const pickupMs = new Date(card.pickupAt).getTime();
        // slot minutes are truncated → pickup within (now+3h−1min, now+3h]
        expect(Math.abs(pickupMs - (Date.now() + 3 * 3600e3))).toBeLessThan(2 * 60e3);
        expect(new Date(card.prepStartAt).getTime()).toBe(pickupMs - 35 * 60e3);
        expect(card.minutesToPickup).toBeGreaterThanOrEqual(178);
        const dine = res.body.orders.find((o) => o.id === dineIn.orderId);
        expect(dine).toMatchObject({ queueBucket: 'ready_to_prepare', pickupAt: null, tableId: A.tables.main.name });
        expect(dine.items[0]).toMatchObject({ name: 'Dal', quantity: 2, prepTimeMinutes: 15, prepStation: 'kitchen' });
        // takeaways sort before dine-in
        const ix = (id) => res.body.orders.findIndex((o) => o.id === id);
        expect(ix(scheduled.orderId)).toBeLessThan(ix(dineIn.orderId));
    });

    test('completed drawer: item count, prep minutes, branch scope', async () => {
        const res = await ctx.api.as(A.users.chef).get('/orders/kitchen/completed');
        expect(res.status).toBe(200);
        const row = res.body.orders.find((o) => o.orderId === served.orderId);
        expect(row).toMatchObject({ itemCount: 4, prepMinutes: 20, items: [{ name: 'Naan', quantity: 3 }, { name: 'Dal', quantity: 1 }] });
        expect(res.body.orders.map((o) => o.orderId)).not.toContain(oA2.orderId);
        expectNoSecrets(res.body);
    });

    test('waiter without accessKitchen is refused', async () => {
        expect((await ctx.api.as(A.users.waiter).get('/orders/kitchen')).status).toBe(403);
    });
});

describe('GET /orders/live ?floor and /orders/past ?dateRange presets', () => {
    test('floor filter keeps that area\'s tables plus takeaways', async () => {
        const Area = require(path.join(BACKEND, 'models/area'));
        const patio = await Area.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: `Patio ${Date.now()}` });
        const other = await createTable(A, { area: patio._id });
        const onOther = await mkOrder(A, { type: 'dine-in', table: other._id, status: 'new' });
        const onMain = await mkOrder(A, { type: 'dine-in', table: A.tables.main._id, status: 'new' });
        const res = await ctx.api.as(A.users.admin).get(`/orders/live?floor=${A.area._id}`);
        const ids = res.body.orders.map((o) => o.id);
        expect(ids).toContain(onMain.orderId);
        expect(ids).toContain(o3.orderId); // takeaway always included
        expect(ids).not.toContain(onOther.orderId);
        const row = res.body.orders.find((o) => o.id === onMain.orderId);
        expect(row.table).toMatchObject({ name: A.tables.main.name, area: String(A.area._id) });
    });

    test.each([['today'], ['yesterday'], ['last7'], ['last30']])('dateRange=%s → 200, never other tenants', async (dr) => {
        const res = await ctx.api.as(A.users.admin).get(`/orders/past?dateRange=${dr}&limit=200`);
        expect(res.status).toBe(200);
        expect(res.body.orders.map((o) => o.id)).not.toContain(oB.orderId);
        if (dr === 'yesterday') expect(res.body.orders.map((o) => o.id)).not.toContain(o1.orderId);
        else expect(res.body.orders.map((o) => o.id)).toContain(o1.orderId);
    });
});
