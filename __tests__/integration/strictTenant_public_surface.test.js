/**
 * STRICT multi-tenancy: the unauthenticated / guest surface.
 *
 *   publicRoute (+ landing, menu-bootstrap, branches), guest order tracking by
 *   id, QR scan, guest order creation that references another tenant's menu /
 *   table / coupon, publicApiRoute (API keys), NoSQL injection in every public
 *   query / param / body, deactivated tenants on the public QR path.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const ApiKey = require(path.join(BACKEND, 'models/apiKey'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const { generateApiKey } = require(path.join(BACKEND, 'utils/apiKeys'));

const ctx = useIntegrationApp();
let A;
let B;
let tableA;
let tableB;
let orderA;
let orderB;
let scanA; // scan token of A's table (guest session that placed orderA)
let scanB;

const V1 = '/api/v1';
const TOTAL = 250;
const get = (p) => ctx.api.raw.get(`${V1}${p}`);
const text = (res) => JSON.stringify(res.body || {});

async function placeGuestOrder(t, table) {
    const { scanToken } = await scanTable(ctx.api, table);
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, scanToken };
}

beforeAll(async () => {
    A = await seedTenant({ label: 'su-a' });
    B = await seedTenant({ label: 'su-b' });
    tableA = await createTable(A, { name: 'A-su' });
    tableB = await createTable(B, { name: 'B-su' });
    ({ order: orderA, scanToken: scanA } = await placeGuestOrder(A, tableA));
    ({ order: orderB, scanToken: scanB } = await placeGuestOrder(B, tableB));
    await settle();
});

// ───────────────────────── publicRoute content ─────────────────────────

describe('publicRoute: only public-safe, per-tenant data', () => {
    const FORBIDDEN = ['password', 'subscription', 'razorpay', 'contactEmail', 'owner', 'signup', 'legal', 'gstin', 'pan"', 'agent', 'keyVersion', 'qrToken', 'hash', 'secret', 'tokenVersion', 'paymentNote', 'suspendedReason', 'lastExportAt'];

    test('restaurant by slug: no secrets / billing / other tenant', async () => {
        const res = await get(`/public/restaurants/${A.slug}`);
        expect(res.status).toBe(200);
        const body = text(res).toLowerCase();
        for (const f of FORBIDDEN) expect(body).not.toContain(f.toLowerCase());
        expect(body).not.toContain(B.slug);
        expect(res.body.data.slug).toBe(A.slug);
    });

    test('restaurant list exposes only whitelisted keys per row', async () => {
        const res = await get('/public/restaurants');
        expect(res.status).toBe(200);
        const allowed = new Set(['_id', 'name', 'slug', 'city', 'phone', 'logo', 'features', 'operations']);
        for (const row of res.body.data) for (const k of Object.keys(row)) expect(allowed.has(k)).toBe(true);
        expect(text(res).toLowerCase()).not.toContain('contactemail');
    });

    test('directory mode (?q / ?limit) is capped and only { name, slug, city, logo }', async () => {
        const res = await get('/public/restaurants?limit=1000');
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeLessThanOrEqual(30);
        for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(['city', 'logo', 'name', 'slug']);
    });

    test('branches of A never include B branches and no internal fields', async () => {
        const res = await get(`/public/restaurants/${A.slug}/branches`);
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(String(B.branch._id));
        for (const b of res.body.data) {
            expect(b.restaurant).toBeUndefined();
            expect(b.createdBy).toBeUndefined();
            expect(b.email).toBeUndefined();
        }
    });

    test('landing of A: no B ids, no legal/tax ids, no plan data; ?branch of B (by slug) is not honoured', async () => {
        await Branch.updateOne({ _id: B.branch._id }, { $set: { slug: 'only-b' } });
        const res = await get(`/public/restaurants/${A.slug}/landing?branch=only-b`);
        expect(res.status).toBe(404);
        const ok = await get(`/public/restaurants/${A.slug}/landing`);
        expect(ok.status).toBe(200);
        const body = text(ok);
        expect(body).not.toContain(String(B.restaurant._id));
        expect(body).not.toContain(String(B.items.paneer._id));
        for (const f of ['gstin', 'fssai', 'password', 'razorpay', 'subscription"', 'contactEmail']) {
            expect(body.toLowerCase()).not.toContain(f.toLowerCase());
        }
    });

    test('landing never shows another tenant\'s dish even when the admin "chose" a foreign item id', async () => {
        await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'landingPage.featuredItems': [B.items.paneer._id] } });
        const res = await get(`/public/restaurants/${A.slug}/landing`);
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(String(B.items.paneer._id));
    });

    test('menu-bootstrap of A: only A items, foreign ?branch ignored, no secrets', async () => {
        const res = await get(`/public/menu-bootstrap?slug=${A.slug}&branch=${B.branch._id}`);
        expect(res.status).toBe(200);
        const body = text(res);
        expect(body).toContain(String(A.items.paneer._id));
        expect(body).not.toContain(String(B.items.paneer._id));
        expect(body).not.toContain(String(B.branch._id));
        expect(res.body.data.branch).toBeFalsy();
        for (const f of ['razorpay', 'printers', 'keyVersion', 'gstin', 'fssai', 'pan"', 'subscription"']) {
            expect(body.toLowerCase()).not.toContain(f.toLowerCase());
        }
    });

    test('menu-bootstrap: tenant selection is ONLY the slug param (headers / host / ids are ignored)', async () => {
        const res = await get(`/public/menu-bootstrap?slug=${A.slug}`)
            .set('X-Restaurant-Slug', B.slug).set('X-Restaurant-Id', String(B.restaurant._id));
        expect(res.status).toBe(200);
        expect(text(res)).toContain(String(A.items.paneer._id));
        expect(text(res)).not.toContain(String(B.items.paneer._id));
    });

    test('menu-bootstrap coupons / promotions carry only the tenant\'s own restaurant id', async () => {
        await Coupon.create({ restaurant: B.restaurant._id, code: 'BONLY10', title: 'B only', discountValue: 10, endDate: new Date(Date.now() + 864e5) });
        await Coupon.create({ restaurant: A.restaurant._id, code: 'AONLY10', title: 'A only', discountValue: 10, endDate: new Date(Date.now() + 864e5) });
        const res = await get(`/public/menu-bootstrap?slug=${A.slug}`);
        expect(res.status).toBe(200);
        const body = text(res);
        expect(body).toContain('AONLY10');
        expect(body).not.toContain('BONLY10');
        expect(body).not.toContain(String(B.restaurant._id));
    });

    test('Regression (fixed 2026-11): public coupon feed leaks internal redemption counters and the restaurant id to anonymous callers', async () => {
        // controllers/publicMenuBootstrapController.js:~218 (Coupon.find(...).lean() with no projection) and
        // promotionController.getActiveCoupons:131 return the WHOLE coupon doc to guests: usageCount,
        // usageLimit, targetUsers (customer ObjectIds), couponCategory, __v, restaurant. Marketing
        // internals (how many times a code was redeemed, which customers a code targets) are admin data.
        const res = await get(`/public/menu-bootstrap?slug=${A.slug}`);
        const coupon = (res.body.data.coupons || []).find((c) => c.code === 'AONLY10');
        expect(coupon).toBeDefined();
        expect(coupon.usageCount).toBeUndefined();
        expect(coupon.usageLimit).toBeUndefined();
        expect(coupon.targetUsers).toBeUndefined();
        expect(coupon.restaurant).toBeUndefined();
    });

    test('guest GET /settings (customer view) does not expose printer / agent / legal / payment-gateway config', async () => {
        const res = await ctx.api.guest(A).get('/settings');
        expect(res.status).toBe(200);
        const body = text(res).toLowerCase();
        for (const f of ['printers', 'keyversion', 'agentid', 'gstin', 'fssai', 'razorpay']) {
            expect(body).not.toContain(f);
        }
        expect(body).not.toContain(String(B.restaurant._id));
    });

    test('Regression (fixed 2026-11): guest GET /settings still returns admin-only sections (taxExport ledgers, notifications, landing featured ids)', async () => {
        // controllers/settingsController.js sanitizePublicSettings strips general.legal only. The
        // Tally ledger mapping (taxExport) and the staff notification switches (notifications) are
        // back-office configuration and are served to any anonymous caller holding the tenant slug.
        const res = await ctx.api.guest(A).get('/settings');
        expect(res.status).toBe(200);
        expect(res.body.taxExport).toBeUndefined();
        expect(res.body.notifications).toBeUndefined();
    });

    test('guest QR scan response: no other-tenant data, no billing, scan token bound to the right tenant', async () => {
        const { res } = await scanTable(ctx.api, tableA);
        expect(res.status).toBe(200);
        const body = text(res);
        expect(body).not.toContain(String(B.restaurant._id));
        expect(body.toLowerCase()).not.toContain('razorpay');
        expect(body).not.toContain('"password"');
        const jwt = require('jsonwebtoken');
        expect(jwt.decode(res.body.scanToken).restaurantId).toBe(String(A.restaurant._id));
    });

    test('Regression (fixed 2026-11): a stranger scanning the QR sticker receives the CURRENT diner\'s name and phone', async () => {
        // controllers/tableController.js:~597 `res.status(200).json(tableObj)` serialises the whole
        // table, including currentDiner {name, phone, user}. Anyone holding the (printed, static) QR
        // token — or a past customer who kept the URL — can read the seated guest's PII.
        const t = await createTable(A, { name: 'A-pii' });
        await Table.updateOne({ _id: t._id }, { $set: { currentDiner: { name: 'Secret Diner', phone: '9876543210', isRegistered: true, claimedAt: new Date() } } });
        const { res } = await scanTable(ctx.api, t);
        expect(res.status).toBe(200);
        const body = text(res);
        expect(body).not.toContain('9876543210');
        expect(body).not.toContain('Secret Diner');
    });

    test('scan of a B qr token with an A slug header resolves B (tenant is derived from the table) and is not A', async () => {
        const { res } = await scanTable(ctx.api, tableB, { 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(200);
        expect(res.body.restaurant.slug).toBe(B.slug);
    });

    test('exempt-prefix signup / lead / availability endpoints reveal no other tenant data', async () => {
        const r = await get(`/public/slug-availability?slug=${B.slug}`);
        expect(r.status).toBe(200);
        expect(text(r)).not.toContain(String(B.restaurant._id));
        expect(text(r).toLowerCase()).not.toContain('contactemail');
    });
});

// ───────────────────── deactivated tenants on public paths ─────────────────────

describe('suspended / cancelled / trial-expired tenant on the PUBLIC path', () => {
    let S;
    beforeAll(async () => { S = await seedTenant({ label: 'su-susp' }); });
    afterEach(async () => {
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'active', 'subscription.trialEndDate': null } });
    });

    test.each(['suspended', 'cancelled'])('%s: public profile, branches, landing, bootstrap, scan, tracking are all blocked', async (status) => {
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status } });
        const profile = await get(`/public/restaurants/${S.slug}`);
        expect(profile.status).toBe(404);
        const branches = await get(`/public/restaurants/${S.slug}/branches`);
        expect(branches.body.data).toEqual([]);
        const landing = await get(`/public/restaurants/${S.slug}/landing`);
        expect(landing.status).toBe(404);
        const boot = await get(`/public/menu-bootstrap?slug=${S.slug}`);
        expect(boot.status).toBe(404);
        const list = await get('/public/restaurants');
        expect(text(list)).not.toContain(S.slug);
        const dir = await get(`/public/restaurants?q=${S.slug}`);
        expect(text(dir)).not.toContain(S.slug);
        const scan = await scanTable(ctx.api, S.tables.main);
        expect(scan.res.status).toBe(403);
        expect(scan.res.body.scanToken).toBeUndefined();
        const menu = await ctx.api.guest(S).get('/menu');
        expect(menu.status).toBe(403);
    });

    test('a scan token issued BEFORE suspension cannot place an order afterwards', async () => {
        const before = await scanTable(ctx.api, S.tables.main);
        expect(before.res.status).toBe(200);
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'suspended' } });
        const res = await ctx.api.guest(S, before.scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(S.tables.main._id),
            items: [{ menuItem: String(S.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
        });
        expect(res.status).toBe(403);
        expect(await Order.countDocuments({ restaurant: S.restaurant._id })).toBe(0);
    });

    test('Regression (fixed 2026-11): a trial that ended unpaid (status still "trial", sweeper lag) stays open on the public menu / QR path', async () => {
        // tenantContext.ensureNotLocked treats it as locked (TRIAL_EXPIRED) for /menu etc., but
        // /public/* is a tenant-EXEMPT prefix and publicMenuBootstrapController / publicController /
        // publicLandingController / tableController.getTableByToken only test
        // status in ['active','trial'] / ['suspended','cancelled'] — never isTrialLocked().
        // Result: a locked tenant is invisible on /menu but its public menu, landing page and
        // QR scan (which hands out a scan token) keep working until the sweeper flips it.
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'trial', 'subscription.status': 'trial', 'subscription.trialEndDate': new Date(Date.now() - 3 * 864e5) } });
        const gated = await ctx.api.guest(S).get('/menu');
        expect(gated.status).toBe(403); // sanity: the tenant IS locked
        const boot = await get(`/public/menu-bootstrap?slug=${S.slug}`);
        expect(boot.status).not.toBe(200);
        const scan = await scanTable(ctx.api, S.tables.small);
        expect(scan.res.status).toBe(403);
    });
});

// ───────────────────────── guest order tracking ─────────────────────────

describe('guest order tracking / mutation by id', () => {
    const idOf = (o) => String(o._id);

    test('guest with NO credentials cannot read A\'s own order by _id or orderId', async () => {
        for (const id of [idOf(orderA), orderA.orderId]) {
            const res = await ctx.api.guest(A).get(`/orders/${id}/detail`);
            expect(res.status).toBe(404);
        }
    });

    test("A guest's own scan token opens only its own order", async () => {
        const res = await ctx.api.guest(A, scanA).get(`/orders/${idOf(orderA)}/detail`);
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(String(B.restaurant._id));
    });

    test("B's order id through A's slug (even with A's valid scan token) → 404", async () => {
        for (const id of [idOf(orderB), orderB.orderId]) {
            const res = await ctx.api.guest(A, scanA).get(`/orders/${id}/detail`);
            expect(res.status).toBe(404);
        }
    });

    test("B's scan token on A's slug cannot open B's order via A (tenant filter) and not A's order", async () => {
        const r1 = await ctx.api.guest(A, scanB).get(`/orders/${idOf(orderB)}/detail`);
        expect(r1.status).toBe(404);
        const r2 = await ctx.api.guest(A, scanB).get(`/orders/${idOf(orderA)}/detail`);
        expect(r2.status).toBe(404);
    });

    test("A's scan token on B's slug cannot open A's order", async () => {
        const res = await ctx.api.guest(B, scanA).get(`/orders/${idOf(orderA)}/detail`);
        expect(res.status).toBe(404);
    });

    test('NoSQL operator in the :id segment / query is not interpreted', async () => {
        for (const p of ['/orders/%7B%22$ne%22:null%7D/detail', '/orders/[$ne]=x/detail', '/orders/.*/detail', `/orders/${orderA.orderId}%00/detail`]) {
            const res = await ctx.api.guest(A, scanA).get(p);
            expect([400, 404]).toContain(res.status);
        }
        const q = await ctx.api.guest(A, scanA).get(`/orders/${idOf(orderA)}/detail?orderId[$ne]=1&restaurant[$ne]=1`);
        expect([200, 404]).toContain(q.status);
    });

    test('kiosk-track endpoint: no token / garbage token / operator token → 404, never an order', async () => {
        for (const h of [{}, { 'X-Kiosk-Token': 'x.y.z' }, { 'X-Kiosk-Token': '{"$ne":1}' }, { Authorization: 'Bearer ' + scanA }]) {
            let r = get(`/orders/track/${orderA.orderId}`).set('X-Restaurant-Slug', A.slug);
            for (const [k, v] of Object.entries(h)) r = r.set(k, v);
            const res = await r;
            expect(res.status).toBe(404);
        }
    });

    test('guest cancel / rate / pay / counter-payment on a B order via A (id guessing) → refused, B unchanged', async () => {
        const before = await Order.findById(orderB._id).lean();
        const g = (m, p) => ctx.api.guest(A, scanA)[m](p);
        const results = await Promise.all([
            g('patch', `/orders/${idOf(orderB)}/cancel`).send({}),
            g('patch', `/orders/${idOf(orderB)}/rating`).send({ rating: 1, feedback: 'x' }),
            g('patch', `/orders/${idOf(orderB)}/payment`).send({ paymentMethod: 'cash' }).set('Idempotency-Key', 'su-pay-1'),
            g('post', `/orders/${idOf(orderB)}/request-counter-payment`).send({}),
        ]);
        for (const r of results) expect(r.status).toBeGreaterThanOrEqual(400);
        const after = await Order.findById(orderB._id).lean();
        expect(after.status).toBe(before.status);
        expect(after.paymentStatus).toBe(before.paymentStatus);
        expect(after.rating || null).toEqual(before.rating || null);
    });

    test("guest on B's slug with B's scan token cannot cancel A's order", async () => {
        const before = await Order.findById(orderA._id).lean();
        const res = await ctx.api.guest(B, scanB).patch(`/orders/${idOf(orderA)}/cancel`).send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await Order.findById(orderA._id).lean()).status).toBe(before.status);
    });

    test("active-order-by-table with B's table id on A's slug returns nothing of B", async () => {
        const one = await ctx.api.guest(A, scanA).get(`/orders/active/table/${tableB._id}`);
        expect(one.status).toBe(200);
        expect(one.body.order).toBeNull();
        const many = await ctx.api.guest(A, scanA).get(`/orders/active-list/table/${tableB._id}`);
        expect(many.status).toBe(200);
        expect(many.body.orders).toEqual([]);
        expect(text(one) + text(many)).not.toContain(orderB.orderId);
    });

    test("active-order-by-table for a guest WITHOUT a scan session does not list the seated guest's order", async () => {
        const res = await ctx.api.guest(A).get(`/orders/active/table/${tableA._id}`);
        expect(res.status).toBe(200);
        expect(res.body.order).toBeNull();
    });

    test('customer token of A browsing B: /my-orders shows only B-scoped orders of that user', async () => {
        const cust = await createCustomer('su-cust');
        await setWallet(A, cust, { balance: 10 });
        const res = await ctx.api.as(cust, B).get('/orders/my-orders');
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(orderA.orderId);
    });
});

// ───────────────────── guest order creation cross-references ─────────────────────

describe('guest order creation referencing another tenant', () => {
    const base = (t, table, extra = {}) => ({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL, ...extra,
    });

    test("B's menu item on A's own table → ITEM_NOT_FOUND, nothing created", async () => {
        const t = await createTable(A, { name: 'A-x1' });
        const { scanToken } = await scanTable(ctx.api, t);
        const before = await Order.countDocuments({});
        const res = await ctx.api.guest(A, scanToken).post('/orders').send(base(B, t));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ITEM_NOT_FOUND');
        expect(await Order.countDocuments({})).toBe(before);
    });

    test("B's table id with A's slug AND A's scan token → refused, no order on B's table", async () => {
        const before = await Order.countDocuments({ table: tableB._id });
        const res = await ctx.api.guest(A, scanA).post('/orders').send(base(A, tableB));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await Order.countDocuments({ table: tableB._id })).toBe(before);
    });

    test("B's table id with B's slug but A's scan token → refused", async () => {
        const before = await Order.countDocuments({ table: tableB._id });
        const res = await ctx.api.guest(B, scanA).post('/orders').send(base(B, tableB));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await Order.countDocuments({ table: tableB._id })).toBe(before);
    });

    test('dine-in with no scan token at all → refused (table id alone is not a credential)', async () => {
        const t = await createTable(A, { name: 'A-x2' });
        const res = await ctx.api.guest(A).post('/orders').send(base(A, t));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await Order.countDocuments({ table: t._id })).toBe(0);
    });

    test("a body-supplied restaurant / restaurantId / branch of B is ignored: the order lands in A (or fails)", async () => {
        const t = await createTable(A, { name: 'A-x3' });
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send(base(A, t, {
            restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), branch: String(B.branch._id), branchId: String(B.branch._id),
        }));
        expect(await Order.countDocuments({ restaurant: B.restaurant._id, table: t._id })).toBe(0);
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
            expect(String(saved.branch)).not.toBe(String(B.branch._id));
        }
    });

    test("takeaway at A with B's branchId is refused or re-homed to A, never booked against B's branch", async () => {
        const res = await ctx.api.guest(A).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', branchId: String(B.branch._id),
            items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
        });
        expect(await Order.countDocuments({ branch: B.branch._id, source: { $ne: 'qr' }, createdAt: { $gte: new Date(Date.now() - 60000) }, orderId: { $ne: orderB.orderId } })).toBe(0);
        if (res.status === 201) {
            const saved = await Order.findById(res.body.order._id).lean();
            expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        }
    });

    test("B's coupon code on A's order gives no discount and burns no B usage", async () => {
        const cust = await createCustomer('su-coupon');
        const bCoupon = await Coupon.create({ restaurant: B.restaurant._id, code: 'BSTEAL50', title: 'B 50', discountType: 'percentage', discountValue: 50, endDate: new Date(Date.now() + 864e5), usageLimit: 5 });
        const t = await createTable(A, { name: 'A-x4' });
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders').send(base(A, t, { couponCode: 'BSTEAL50', coupon: 'BSTEAL50' }));
        const used = await Coupon.findById(bCoupon._id).lean();
        expect(used.usageCount).toBe(0);
        if (res.status === 201) {
            expect(Number(res.body.order.discount || res.body.order.couponDiscount || 0)).toBe(0);
        }
    });

    test('guest order on A with an item id of B inside a NoSQL operator object is rejected', async () => {
        const t = await createTable(A, { name: 'A-x5' });
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(t._id),
            items: [{ menuItem: { $ne: null }, name: 'x', quantity: 1 }], total: TOTAL,
        });
        expect(res.status).toBe(400);
        const res2 = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: { $ne: null },
            items: [{ menuItem: String(A.items.paneer._id), name: 'x', quantity: 1 }], total: TOTAL,
        });
        expect(res2.status).toBeGreaterThanOrEqual(400);
    });

    test('idempotency key is per tenant: the same key on B cannot replay A\'s response', async () => {
        const tA = await createTable(A, { name: 'A-x6' });
        const tB = await createTable(B, { name: 'B-x6' });
        const sA = await scanTable(ctx.api, tA);
        const sB = await scanTable(ctx.api, tB);
        const key = `su-idem-${Date.now()}`;
        const r1 = await ctx.api.guest(A, sA.scanToken).post('/orders').set('Idempotency-Key', key).send(base(A, tA));
        const r2 = await ctx.api.guest(B, sB.scanToken).post('/orders').set('Idempotency-Key', key).send(base(B, tB));
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        expect(String(r2.body.order._id)).not.toBe(String(r1.body.order._id));
        expect(String(r2.body.order.restaurant || B.restaurant._id)).toBe(String(B.restaurant._id));
    });
});

// ───────────────────────── public API (API keys) ─────────────────────────

describe('publicApiRoute: tenant API keys', () => {
    let keyA;
    let keyB;
    const pub = (p, key, h = {}) => {
        let r = ctx.api.raw.get(`/api/public/v1${p}`);
        if (key) r = r.set('Authorization', `Bearer ${key}`);
        for (const [k, v] of Object.entries(h)) r = r.set(k, v);
        return r;
    };

    async function mint(tenant, scopes = ['read:orders', 'read:menu', 'read:sales', 'read:inventory', 'read:bookings'], extra = {}) {
        const { key, prefix, hash } = generateApiKey();
        const doc = await ApiKey.create({ restaurant: tenant.restaurant._id, name: 'k', prefix, hash, scopes, ...extra });
        return { key, doc };
    }

    beforeAll(async () => {
        keyA = (await mint(A)).key;
        keyB = (await mint(B)).key;
    });

    test('A key lists only A orders; B order numbers are not reachable by id', async () => {
        const list = await pub('/orders', keyA);
        expect(list.status).toBe(200);
        expect(text(list)).toContain(orderA.orderId);
        expect(text(list)).not.toContain(orderB.orderId);
        const one = await pub(`/orders/${orderB.orderId}`, keyA);
        expect(one.status).toBe(404);
        const mine = await pub(`/orders/${orderA.orderId}`, keyA);
        expect(mine.status).toBe(200);
    });

    test('tenant selectors (headers / query / B branch id) cannot widen an API key', async () => {
        const res = await pub(`/orders?restaurant=${B.slug}&restaurantId=${B.restaurant._id}&branch_id=${B.branch._id}`, keyA, {
            'X-Restaurant-Slug': B.slug, 'X-Restaurant-Id': String(B.restaurant._id),
        });
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(orderB.orderId);
        expect(res.body.data).toEqual([]); // B's branch id filter on A's key matches nothing
        const menu = await pub('/menu', keyA, { 'X-Restaurant-Slug': B.slug });
        expect(text(menu)).not.toContain(String(B.items.paneer._id));
    });

    test('revoked, expired, scope-less and malformed keys are refused', async () => {
        const rev = await mint(A, ['read:orders'], { revokedAt: new Date() });
        const exp = await mint(A, ['read:orders'], { expiresAt: new Date(Date.now() - 1000) });
        const scoped = await mint(A, ['read:menu']);
        expect((await pub('/orders', rev.key)).status).toBe(401);
        expect((await pub('/orders', exp.key)).status).toBe(401);
        expect((await pub('/orders', scoped.key)).status).toBe(403);
        expect((await pub('/orders', 'bd_live_zzzz')).status).toBe(401);
        expect((await pub('/orders', null)).status).toBe(401);
    });

    test("key prefix of A with B's secret / swapped halves is refused", async () => {
        const [, , pa] = keyA.split('_');
        const [, , , sb] = keyB.split('_');
        const franken = `bd_live_${keyA.split('_')[2]}_${keyB.split('_')[3]}`;
        expect(pa).toBeTruthy();
        expect(sb).toBeTruthy();
        const res = await pub('/orders', franken);
        expect(res.status).toBe(401);
    });

    test('NoSQL operators in the key header / filters are not interpreted', async () => {
        for (const url of ['/orders?status[$ne]=x', '/orders?from[$gt]=1', '/orders?branch_id[$ne]=1', '/orders?payment_status[$regex]=.*', '/orders?page[$gt]=1']) {
            const res = await pub(url, keyA);
            expect([200, 400]).toContain(res.status);
            expect(text(res)).not.toContain(orderB.orderId);
        }
        const hdr = await pub('/orders', '{"$ne":null}');
        expect(hdr.status).toBe(401);
    });

    test('suspended tenant: its API key stops working immediately; the other tenant is unaffected', async () => {
        const X = await seedTenant({ label: 'su-apix' });
        const kx = (await mint(X)).key;
        expect((await pub('/menu', kx)).status).toBe(200);
        await Restaurant.updateOne({ _id: X.restaurant._id }, { $set: { status: 'suspended' } });
        const res = await pub('/menu', kx);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
        expect((await pub('/menu', keyA)).status).toBe(200);
    });

    test('responses carry no internal fields (hashes, guest tokens, other-tenant ids)', async () => {
        const res = await pub('/orders', keyA);
        const body = text(res).toLowerCase();
        for (const f of ['guestaccess', 'tokenhash', 'scansessionid', 'razorpay', 'password']) expect(body).not.toContain(f);
        expect(body).not.toContain(String(B.restaurant._id));
    });

    test('a key can neither write nor reach staff routes (/api/v1 is a different auth class)', async () => {
        const w = await ctx.api.raw.post('/api/public/v1/orders').set('Authorization', `Bearer ${keyA}`).send({});
        expect(w.status).toBe(405);
        const staff = await ctx.api.raw.get(`${V1}/orders/live`).set('Authorization', `Bearer ${keyA}`).set('X-Restaurant-Slug', A.slug);
        expect([400, 401, 403]).toContain(staff.status);
        const viaHeader = await ctx.api.raw.get(`${V1}/orders/live`).set('X-API-Key', keyA).set('X-Restaurant-Slug', A.slug);
        expect([400, 401, 403]).toContain(viaHeader.status);
    });
});

// ───────────────────────── NoSQL injection in public inputs ─────────────────────────

describe('NoSQL / regex injection in public inputs', () => {
    test.each([
        '/public/restaurants?q[$ne]=zz',
        '/public/restaurants?q[$regex]=.*&limit=5',
        '/public/restaurants?limit[$gt]=0',
        '/public/restaurants/%7B%22$ne%22:null%7D',
        '/public/restaurants/[$ne]=x/branches',
        '/public/restaurants/.*/landing',
        '/public/restaurants/a%00b/landing',
        '/public/menu-bootstrap?slug[$ne]=x',
        '/public/menu-bootstrap?slug=%7B%22$ne%22:1%7D',
        '/public/slug-availability?slug[$ne]=x&name[$gt]=&city[$regex]=.',
        '/public/blog/%7B%22$ne%22:null%7D',
        '/tables/scan/%7B%22$ne%22:null%7D',
        '/tables/scan/tb-.*',
    ])('GET %s never returns tenant data or a 5xx', async (p) => {
        const res = await get(p);
        expect(res.status).toBeLessThan(500);
        // The plain /public/restaurants list is public by design (BranchSelection); every other
        // endpoint must not echo a tenant when handed an operator / garbage selector.
        if (p.startsWith('/public/restaurants?')) {
            for (const row of res.body.data || []) expect(Object.keys(row).every((k) => ['_id', 'name', 'slug', 'city', 'phone', 'logo', 'features', 'operations'].includes(k))).toBe(true);
            return;
        }
        const body = text(res);
        expect(body).not.toContain(String(A.restaurant._id));
        expect(body).not.toContain(String(B.restaurant._id));
    });

    test('directory search treats q as a literal (a regex that would match every tenant matches none)', async () => {
        const res = await get('/public/restaurants?q=.*');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });

    test('menu-bootstrap ?branch / ?kiosk / ?limit operators are inert', async () => {
        const res = await get(`/public/menu-bootstrap?slug=${A.slug}&branch[$ne]=x&kiosk[$ne]=1&limit[$gt]=0`);
        expect(res.status).toBe(200);
        expect(text(res)).not.toContain(String(B.items.paneer._id));
    });

    test('login with operator objects as email/password does not authenticate anyone', async () => {
        for (const body of [
            { email: { $ne: null }, password: { $ne: null } },
            { email: { $regex: '.*' }, password: 'Integration#Pass123' },
            { email: A.users.admin.email, password: { $ne: '' } },
            { identifier: { $gt: '' }, password: { $gt: '' } },
        ]) {
            const res = await ctx.api.anon().post('/auth/login').send(body);
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.body.token).toBeUndefined();
            expect(res.body.accessToken).toBeUndefined();
        }
    });

    test('forgot-password / reset / verify-otp / refresh with operator objects do not act on any user', async () => {
        const f = await ctx.api.anon().post('/auth/forgot-password').send({ email: { $ne: null } });
        expect(f.status).toBeGreaterThanOrEqual(200);
        expect(f.status).toBeLessThan(500);
        const r = await ctx.api.anon().post('/auth/reset-password').send({ token: { $ne: null }, password: 'Neu#Passw0rd1', email: { $ne: null } });
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        const v = await ctx.api.anon().post('/auth/verify-otp').send({ phone: { $ne: null }, email: { $ne: null }, otp: { $ne: null } });
        expect(v.status).toBeGreaterThanOrEqual(400);
        expect(v.status).toBeLessThan(500);
        const rf = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: { $ne: null } });
        expect(rf.status).toBeGreaterThanOrEqual(400);
        expect(rf.status).toBeLessThan(500);
    });

    test('self-signup with operator objects / foreign slug reservations cannot overwrite an existing tenant', async () => {
        const before = await Restaurant.findById(A.restaurant._id).lean();
        const res = await ctx.api.anon().post('/public/register-restaurant').send({
            restaurantName: 'Evil', ownerName: 'E', contactEmail: { $ne: null }, contactPhone: '9000000000', city: 'X',
            password: 'Str0ng#Passw0rd', acceptTerms: true, slug: A.slug,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        const after = await Restaurant.findById(A.restaurant._id).lean();
        expect(after.name).toBe(before.name);
        expect(String(after._id)).toBe(String(before._id));
        expect(await Restaurant.countDocuments({ slug: A.slug })).toBe(1);
    });

    test('lead submission cannot inject operators and creates no tenant data', async () => {
        const before = await Restaurant.countDocuments({});
        const res = await ctx.api.anon().post('/public/lead').send({ name: { $ne: 1 }, email: { $ne: 1 }, phone: { $ne: 1 }, message: { $ne: 1 } });
        expect(res.status).toBeLessThan(500);
        expect(await Restaurant.countDocuments({})).toBe(before);
    });
});

// ───────────────────────── query/body override on guest writes ─────────────────────────

describe('guest write endpoints ignore tenant overrides in query / body', () => {
    test('POST /requests (call waiter) with a B table id and restaurant override creates nothing in B', async () => {
        const Request = require(path.join(BACKEND, 'models/request'));
        const before = await Request.countDocuments({ restaurant: B.restaurant._id });
        await ctx.api.guest(A, scanA).post(`/requests?restaurant=${B.slug}`).send({
            table: String(tableB._id), tableId: String(tableB._id), restaurant: String(B.restaurant._id), type: 'waiter',
        });
        expect(await Request.countDocuments({ restaurant: B.restaurant._id })).toBe(before);
    });

    test('guest menu item read by B id through A → 404 / absent', async () => {
        const res = await ctx.api.guest(A).get(`/menu/${B.items.paneer._id}`);
        expect([403, 404]).toContain(res.status);
        expect(text(res)).not.toContain('Paneer Tikka'.concat(String(B.restaurant._id)));
        const doc = await MenuItem.findById(B.items.paneer._id).lean();
        expect(doc).not.toBeNull();
    });
});
