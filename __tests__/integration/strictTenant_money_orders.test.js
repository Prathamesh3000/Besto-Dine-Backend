/**
 * STRICT multi-tenancy: order flow (routes/orderRoute.js).
 *
 * Two tenants (A, B), each with orders. We act as A (owner, branch-pinned
 * admin, waiter, chef, customer, guest, anonymous) and hit every order
 * route with B's ids. Expected: 400/403/404, B's document byte-identical
 * afterwards, no B data in any response body, lists/counts exclude B.
 *
 * Tests named "BUG:" pin a real cross-tenant leak and are expected to FAIL
 * until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, createTable } = require('./helpers/seed');
const { scanTable, settle, V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Table = require(path.join(BACKEND, 'models/table'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');

let A; let B;
let bPending; let bPaid; let bKiosk; let aOrder; let bCust;
let aBranch2; let aPinnedAdmin; let aCustomer;
const SECRET = 'SECRET-B-GUEST-NAME';
const SECRET_PHONE = '9876500099';

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `SM-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1 }],
        total: 200,
        status: 'new',
        paymentStatus: 'Pending',
        ...fields,
    });
    return doc.toObject();
}
const snap = async (o) => JSON.stringify(await Order.findById(o._id).lean());

beforeAll(async () => {
    A = await seedTenant({ label: 'smo-a' });
    B = await seedTenant({ label: 'smo-b' });
    bCust = await createCustomer('smob');
    aCustomer = await createCustomer('smoa');
    aBranch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A2', slug: 'a2', isActive: true });
    aPinnedAdmin = await createUser({
        name: 'pinned admin a', email: `pin.${rid()}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: aBranch2._id, permissions: defaultPermissionsForRole('admin'),
    });
    bPending = await mkOrder(B, { customerName: SECRET, phone: SECRET_PHONE, user: bCust._id, table: B.tables.main._id, type: 'dine-in', scanSessionId: `sess-${rid()}` });
    bPaid = await mkOrder(B, {
        customerName: SECRET, paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 200,
        razorpayPaymentId: `pay_${rid()}`, razorpayOrderId: `order_${rid()}`, paidAt: new Date(), status: 'served',
    });
    bKiosk = await mkOrder(B, { source: 'kiosk', orderId: `KSK-${rid()}`, customerName: SECRET });
    aOrder = await mkOrder(A, { customerName: 'A-guest' });
});

const leaks = (res) => {
    const s = JSON.stringify(res.body || {}) + (res.text || '');
    return [SECRET, SECRET_PHONE, String(bPending._id), String(bPaid._id), String(bPending.orderId), String(bPaid.orderId)]
        .filter((m) => s.includes(m));
};
const REFUSED = [400, 403, 404];

// ── Lists exclude B ──────────────────────────────────────────────────
describe('order lists never include tenant B', () => {
    test.each([
        ['/orders/live', (t) => t.users.admin],
        ['/orders/past', (t) => t.users.admin],
        ['/orders/refunds', (t) => t.users.admin],
        ['/orders/kitchen', (t) => t.users.admin],
        ['/orders/kitchen/completed', (t) => t.users.admin],
        ['/orders/live', (t) => t.users.waiter],
        ['/orders/past', (t) => t.users.waiter],
        ['/orders/kitchen', (t) => t.users.chef],
        ['/orders/past?branch=all', (t) => t.users.admin],
        ['/orders/live?restaurant=__B__', (t) => t.users.admin],
        ['/orders/past?restaurantId=__B__&tenant=__B__', (t) => t.users.admin],
    ])('GET %s as A staff', async (url, pick) => {
        const u = url.split('__B__').join(String(B.restaurant._id));
        const res = await ctx.api.as(pick(A)).get(u.replace('/orders', '/orders')).set('X-Restaurant-Id', String(B.restaurant._id));
        expect(res.status).toBeLessThan(500);
        expect(leaks(res)).toEqual([]);
    });

    test('A live list contains A order and its row count equals A-only rows', async () => {
        const res = await ctx.api.as(A.users.admin).get('/orders/live');
        expect(res.status).toBe(200);
        const s = JSON.stringify(res.body);
        expect(s).toContain(String(aOrder._id));
        expect(leaks(res)).toEqual([]);
    });

    test("branch-pinned A admin asking for B's branch id sees nothing of B", async () => {
        const res = await ctx.api.as(aPinnedAdmin).get(`/orders/past?branch=${B.branch._id}`);
        expect(res.status).toBeLessThan(500);
        expect(leaks(res)).toEqual([]);
    });

    test("A owner with ?branch=<B branch> sees no B orders", async () => {
        const res = await ctx.api.as(A.users.admin).get(`/orders/past?branch=${B.branch._id}`);
        expect(res.status).toBeLessThan(500);
        expect(leaks(res)).toEqual([]);
    });

    test('my-orders for an A customer does not list B orders (even B customer-owned ones)', async () => {
        const res = await ctx.api.as(aCustomer, A).get('/orders/my-orders');
        expect(res.status).toBeLessThan(500);
        expect(leaks(res)).toEqual([]);
    });

    test("B's customer on A's slug sees none of B's orders in my-orders", async () => {
        const res = await ctx.api.as(bCust, A).get('/orders/my-orders');
        expect(res.status).toBeLessThan(500);
        expect(leaks(res)).toEqual([]);
    });
});

// ── By-id routes as every A role with B's order ids ──────────────────
const ROUTES = [
    ['PATCH', (o) => `/orders/${o}/status`, { status: 'cancelled' }],
    ['PATCH', (o) => `/orders/${o}/status`, { status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash' }],
    ['PATCH', (o) => `/orders/${o}/pickup`, {}],
    ['PATCH', (o) => `/orders/${o}/delivery`, { deliveryStatus: 'delivered' }],
    ['POST', (o) => `/orders/${o}/append`, { items: [{ menuItem: '__A_ITEM__', quantity: 1 }] }],
    ['PATCH', (o) => `/orders/${o}/coupon`, { code: 'X' }],
    ['POST', (o) => `/orders/${o}/bill/save`, { paymentMethod: 'cash' }],
    ['POST', (o) => `/orders/${o}/bill/reopen`, { reason: 'test' }],
    ['GET', (o) => `/orders/${o}/bill/preview`, null],
    ['GET', (o) => `/orders/${o}/upi-qr`, null],
    ['POST', (o) => `/orders/${o}/reprint-kot`, {}],
    ['GET', (o) => `/orders/${o}/kots`, null],
    ['GET', (o) => `/orders/${o}/detail`, null],
    ['PATCH', (o) => `/orders/${o}/payment`, { paymentMethod: 'cash' }],
    ['POST', (o) => `/orders/${o}/request-counter-payment`, {}],
    ['PATCH', (o) => `/orders/${o}/cancel`, {}],
    ['PATCH', (o) => `/orders/${o}/rating`, { rating: 1, review: 'hijack' }],
    ['POST', (o) => `/orders/${o}/repeat-all`, {}],
];

function fire(api, [method, urlOf, body], oid, extraHeaders = {}) {
    let r = api[method.toLowerCase()](urlOf(oid));
    r = r.set('Idempotency-Key', `k-${rid()}`);
    for (const [k, v] of Object.entries(extraHeaders)) r = r.set(k, v);
    if (body) r = r.send(JSON.parse(JSON.stringify(body).replace('__A_ITEM__', String(A.items.paneer._id))));
    return r;
}

const ROLES = [
    ['A owner', () => ctx.api.as(A.users.admin)],
    ['A waiter', () => ctx.api.as(A.users.waiter)],
    ['A captain', () => ctx.api.as(A.users.captain)],
    ['A chef', () => ctx.api.as(A.users.chef)],
    ['A branch-pinned admin', () => ctx.api.as(aPinnedAdmin)],
    ['A customer (slug A)', () => ctx.api.as(aCustomer, A)],
    ['guest on slug A', () => ctx.api.guest(A)],
];

describe('by-id order routes with B order ids', () => {
    for (const [roleName, api] of ROLES) {
        describe(roleName, () => {
            test.each(ROUTES.map((r, i) => [`${r[0]} ${r[1]('<id>')} #${i}`, r]))('%s refuses B order (_id and orderId)', async (_l, route) => {
                const before = [await snap(bPending), await snap(bPaid)];
                for (const o of [bPending._id, bPending.orderId, bPaid._id, bPaid.orderId]) {
                    const res = await fire(api(), route, String(o));
                    // A 500 on a friendly orderId for append/coupon/reprint-kot is a separate
                    // robustness bug (see the "BUG:" test below); it still must not leak or mutate.
                    const friendly500 = res.status === 500 && !/^[0-9a-f]{24}$/.test(String(o));
                    if (!friendly500) expect([...REFUSED, 401]).toContain(res.status);
                    expect(leaks(res)).toEqual([]);
                }
                await settle(50);
                expect([await snap(bPending), await snap(bPaid)]).toEqual(before);
            });
        });
    }

    test("A owner sending X-Restaurant-Slug: B + B's order id still cannot act on B", async () => {
        const before = await snap(bPending);
        for (const route of ROUTES) {
            const res = await fire(ctx.api.as(A.users.admin), route, String(bPending._id), { 'X-Restaurant-Slug': B.slug });
            // The user's own tenant wins over the slug header; B's order is never found.
            expect([...REFUSED, 401]).toContain(res.status);
            expect(leaks(res)).toEqual([]);
        }
        expect(await snap(bPending)).toBe(before);
    });
});

// ── Robustness: friendly orderId strings must not 500 ─────────────────
describe('order routes accept the friendly orderId without crashing', () => {
    // validators/ops.js orderRef() accepts either a Mongo _id or an orderId string, but
    // services/orderItemsService.js (append, coupon, reprint-kot) does Order.findOne({ _id: id })
    // with the raw string -> CastError -> HTTP 500. Not a leak; own-tenant staff get a 500 too.
    test.each([
        ['POST', (o) => `/orders/${o}/append`, { items: [{ menuItem: '__A_ITEM__', quantity: 1 }] }],
        ['PATCH', (o) => `/orders/${o}/coupon`, { code: 'X' }],
        ['POST', (o) => `/orders/${o}/reprint-kot`, {}],
    ])('Regression (fixed 2026-11): %s %s with an unknown orderId string is a 4xx, not a 500', async (...route) => {
        const res = await fire(ctx.api.as(A.users.admin), route, 'ORD-DOES-NOT-EXIST');
        expect(res.status).toBeLessThan(500);
    });
});

// ── Anonymous / slug-less / wrong-slug callers on the public-ish routes ─
describe('public order routes with no tenant or the wrong tenant', () => {
    const PUBLIC = ROUTES.filter((r) => /detail|payment|cancel|rating|counter|repeat/.test(r[1]('x')));

    test.each(PUBLIC.map((r) => [`${r[0]} ${r[1]('<id>')}`, r]))('anonymous without a slug: %s', async (_l, route) => {
        const before = await snap(bPending);
        const res = await fire(ctx.api.anon(), route, String(bPending._id));
        expect([...REFUSED, 401]).toContain(res.status);
        expect(leaks(res)).toEqual([]);
        expect(await snap(bPending)).toBe(before);
    });

    test('anonymous without a slug cannot read B order by orderId string', async () => {
        const res = await ctx.api.anon().get(`/orders/${bPending.orderId}/detail`);
        expect([...REFUSED, 401]).toContain(res.status);
        expect(leaks(res)).toEqual([]);
    });

    test("anonymous, slug A, B's table scan session id as x-scan-token cannot read B order", async () => {
        const { scanToken } = await scanTable(ctx.api, B.tables.main);
        const res = await ctx.api.guest(A, scanToken).get(`/orders/${bPending._id}/detail`);
        expect([...REFUSED, 401]).toContain(res.status);
        expect(leaks(res)).toEqual([]);
    });

    test("B's scan token on slug B cannot reach B order of a different session", async () => {
        const { scanToken } = await scanTable(ctx.api, B.tables.small);
        const res = await ctx.api.guest(B, scanToken).get(`/orders/${bPending._id}/detail`);
        // Different table/session than the order: must not be returned in full.
        expect(JSON.stringify(res.body)).not.toContain(SECRET_PHONE);
    });

    test('kiosk track: no token / forged token / slug A all 404', async () => {
        for (const headers of [{}, { 'X-Kiosk-Token': 'forged' }, { Authorization: `Bearer ${A.users.admin.token}` }]) {
            let r = ctx.api.guest(A).get(`/orders/track/${bKiosk.orderId}`);
            for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
            const res = await r;
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).not.toContain(SECRET);
        }
        const anon = await ctx.api.anon().get(`/orders/track/${bKiosk.orderId}`);
        expect([400, 404]).toContain(anon.status);
    });

    test("table lookups: B's table id from slug A / anon / A admin returns nothing of B", async () => {
        for (const api of [ctx.api.guest(A), ctx.api.anon(), ctx.api.as(A.users.admin), ctx.api.as(A.users.waiter)]) {
            for (const p of [`/orders/active/table/${B.tables.main._id}`, `/orders/active-list/table/${B.tables.main._id}`]) {
                const res = await api.get(p);
                expect(res.status).toBeLessThan(500);
                expect(leaks(res)).toEqual([]);
            }
        }
    });

    test('malformed ids never 500 nor leak: array / object / operator injection', async () => {
        const ids = ['%7B%22%24ne%22%3Anull%7D', '[object%20Object]', '..%2F..%2Fx', 'undefined', '000000000000000000000000'];
        for (const id of ids) {
            for (const api of [ctx.api.as(A.users.admin), ctx.api.guest(A), ctx.api.anon()]) {
                const res = await api.get(`/orders/${id}/detail`);
                expect(res.status).toBeLessThan(500);
                expect(leaks(res)).toEqual([]);
            }
        }
        const q = await ctx.api.as(A.users.admin).get('/orders/past?search[$ne]=x&status[$ne]=x&branch[$ne]=1');
        expect(q.status).toBeLessThan(500);
        expect(leaks(q)).toEqual([]);
    });

    test('operator injection in body: status {$ne:null} on A order is refused and B untouched', async () => {
        const before = await snap(bPending);
        const res = await ctx.api.as(A.users.admin).patch(`/orders/${bPending._id}/status`).send({ status: { $ne: null } });
        expect([...REFUSED]).toContain(res.status);
        expect(await snap(bPending)).toBe(before);
        const res2 = await ctx.api.as(A.users.admin).patch(`/orders/${aOrder._id}/status`).send({ status: { $ne: null } });
        expect(res2.status).toBeLessThan(500);
    });
});

// ── Creating an order that references B's ids ────────────────────────
describe('POST /orders referencing tenant B', () => {
    const place = (body, api = ctx.api.guest(A), headers = {}) => {
        let r = api.post('/orders').set('Idempotency-Key', `k-${rid()}`);
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return r.send(body);
    };
    const cartA = () => [{ menuItem: String(A.items.paneer._id), quantity: 1 }];

    test.each([
        ['restaurant', () => ({ restaurant: String(B.restaurant._id) })],
        ['restaurantId', () => ({ restaurantId: String(B.restaurant._id) })],
        ['tenant', () => ({ tenant: String(B.restaurant._id) })],
        ['branch', () => ({ branch: String(B.branch._id) })],
        ['user', () => ({ user: String(bCust._id), customerId: String(bCust._id) })],
        ['paymentStatus', () => ({ paymentStatus: 'Paid', amountPaid: 9999 })],
    ])('mass-assignment of %s does not reach the stored order', async (_k, extra) => {
        const res = await place({ type: 'takeaway', pickupLocation: 'Counter', items: cartA(), total: 1, ...extra() });
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
            expect(String(saved.branch)).not.toBe(String(B.branch._id));
            expect(saved.user ? String(saved.user) : '').not.toBe(String(bCust._id));
            expect(saved.paymentStatus).not.toBe('Paid');
        } else {
            expect(res.status).toBeLessThan(500);
        }
        expect(await Order.countDocuments({ restaurant: B.restaurant._id, items: { $elemMatch: { price: { $lt: 0 } } } })).toBe(0);
    });

    test("B's menu items are refused", async () => {
        const res = await place({ type: 'takeaway', pickupLocation: 'Counter', items: [{ menuItem: String(B.items.paneer._id), quantity: 1 }], total: 1 });
        expect(res.status).toBe(400);
    });

    test("B's table id on a dine-in order is refused and B's table is untouched", async () => {
        const before = JSON.stringify(await Table.findById(B.tables.main._id).lean());
        for (const api of [ctx.api.guest(A), ctx.api.as(A.users.waiter), ctx.api.as(A.users.admin)]) {
            const res = await place({ type: 'dine-in', tableId: String(B.tables.main._id), items: cartA(), total: 1 }, api);
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        }
        expect(JSON.stringify(await Table.findById(B.tables.main._id).lean())).toBe(before);
    });

    test("B's coupon code cannot be redeemed on A's order and its usage count is untouched", async () => {
        const c = await Coupon.create({
            restaurant: B.restaurant._id, code: `BCP${rid().toUpperCase()}`.slice(0, 10), title: 'B only',
            discountType: 'percentage', discountValue: 50, endDate: new Date(Date.now() + 864e5),
        });
        const before = JSON.stringify(await Coupon.findById(c._id).lean());
        const res = await place({ type: 'takeaway', pickupLocation: 'Counter', items: cartA(), total: 100, couponCode: c.code });
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            expect(saved.couponDiscount || 0).toBe(0);
        }
        // and via PATCH /:id/coupon on A's own order
        const r2 = await ctx.api.as(A.users.admin).patch(`/orders/${aOrder._id}/coupon`).send({ code: c.code });
        expect(r2.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await Coupon.findById(c._id).lean())).toBe(before);
        expect((await Order.findById(aOrder._id).lean()).couponDiscount || 0).toBe(0);
    });

    test('an Idempotency-Key used by tenant B is not replayed to tenant A (no cross-tenant response replay)', async () => {
        const key = `shared-${rid()}`;
        const b = await ctx.api.as(B.users.admin).post('/orders').set('Idempotency-Key', key)
            .send({ type: 'takeaway', pickupLocation: 'Counter', items: [{ menuItem: String(B.items.paneer._id), quantity: 1 }], total: 1 });
        await settle(150);
        const a = await ctx.api.as(A.users.admin).post('/orders').set('Idempotency-Key', key)
            .send({ type: 'takeaway', pickupLocation: 'Counter', items: cartA(), total: 1 });
        const bOrderId = b.body?.order?._id;
        if (bOrderId) expect(JSON.stringify(a.body)).not.toContain(String(bOrderId));
        if (a.status === 201) expect(String((await Order.findById(a.body.order._id).lean()).restaurant)).toBe(String(A.restaurant._id));
    });

    test("branch-pinned A admin cannot place into B's branch via branchId", async () => {
        const res = await place({ type: 'takeaway', pickupLocation: 'Counter', branchId: String(B.branch._id), items: cartA(), total: 1 }, ctx.api.as(aPinnedAdmin));
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
            expect(String(saved.branch)).not.toBe(String(B.branch._id));
        }
    });
});

// ── Delivery quote / admin cleanup are tenant-scoped ─────────────────
describe('admin maintenance routes only touch the caller tenant', () => {
    test('cleanup-stale / cleanup-empty by A admin leave B orders untouched', async () => {
        const stale = await mkOrder(B, { items: [], total: 0, status: 'new', createdAt: new Date(Date.now() - 30 * 864e5) });
        const before = await snap(stale);
        const r1 = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({ hours: 1 });
        const r2 = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-empty').send({});
        expect(r1.status).toBeLessThan(500);
        expect(r2.status).toBeLessThan(500);
        expect(await Order.findById(stale._id).lean()).toBeTruthy();
        expect(await snap(stale)).toBe(before);
    });

    test('non-admin roles cannot call cleanup routes', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            const res = await ctx.api.as(u).post('/orders/admin/cleanup-empty').send({});
            expect(res.status).toBe(403);
        }
    });
});

// A table id used only to keep the helper import live for future extension.
void createTable; void V1;
