/**
 * Promotions + coupons (checklist §7.1 / §7.2):
 *
 *   controllers/promotionController.js + routes/promotionRoute.js
 *     - coupon CRUD (admin only, couponPromotions gate, allowlisted body,
 *       code normalisation + per tenant/branch uniqueness, every
 *       validateCouponBody rule, branch ownership, list scoping)
 *     - POST /promotions/apply-coupon (every rule incl. time-of-day
 *       boundaries, usage / per-user limits, min order, branch scope,
 *       exact discount for %, capped %, flat, flat > bill, scoped items)
 *     - banners: create + public listing (active / in-date / own tenant
 *       / branch inheritance) and active-coupon listing
 *     - reports: /coupons/redemptions + /coupons/performance (exact
 *       counts / sums, date filters, tenant + branch scope)
 *   services/orderCreateService.js (coupon redemption lifecycle)
 *     - redemption written once per order, reports agree with orders,
 *       cancellation behaviour
 *
 * Already covered elsewhere (not repeated): last-use race / exhausted
 * coupon / per-user-at-create (orderCreateItems.test.js), staff
 * PATCH /orders/:id/coupon (orderPaymentService.test.js).
 * getCustomerCRM access control is covered in roleMatrix + tenantIsolationSweep.
 *
 * The server runs in-process; time-of-day + "today" logic uses the
 * process' local time zone. TZ is pinned to Asia/Kolkata (the product's
 * market) so results do not depend on the machine running the suite.
 *
 * Tests whose name starts with "BUG:" pin behaviour the code gets wrong
 * today; they are expected to fail until the source is fixed. Tests
 * marked "Regression (fixed 2026-10)" were BUG tests whose fix landed.
 */
process.env.TZ = 'Asia/Kolkata';

const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const { V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const CouponRedemption = require(path.join(BACKEND, 'models/couponRedemption'));
const Promotion = require(path.join(BACKEND, 'models/promotion'));
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Category = require(path.join(BACKEND, 'models/category'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;          // main tenant; branches: main, fc (FC Road), kt (Kothrud)
let B;          // second tenant
let C;          // tenant whose plan lacks couponPromotions
let fc;
let kt;
let fcAdmin;    // admin pinned to FC Road
let cust;       // customer of A

const DAY = 86400000;
const rid = () => crypto.randomBytes(4).toString('hex').toUpperCase();

beforeAll(async () => {
    A = await seedTenant({ label: 'pc-a' });
    B = await seedTenant({ label: 'pc-b' });
    C = await seedTenant({ label: 'pc-c' });
    await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { 'subscription.features.couponPromotions': false } });
    fc = await Branch.create({ restaurant: A.restaurant._id, name: 'FC Road', slug: 'fc-road', isActive: true });
    kt = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
    fcAdmin = await createUser({
        name: 'FC admin', email: `fcadmin.${rid()}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: fc._id, permissions: defaultPermissionsForRole('admin'),
    });
    cust = await createCustomer('pc-cust');
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Request with arbitrary headers (X-Branch-Id etc.). */
function call(method, url, { user, tenant, branch } = {}) {
    let r = ctx.api.raw[method](`${V1}${url}`);
    if (user) r = r.set('Authorization', `Bearer ${user.token}`);
    if (tenant) r = r.set('X-Restaurant-Slug', tenant.slug);
    if (branch) r = r.set('X-Branch-Id', String(branch._id || branch));
    return r;
}

async function makeCoupon(t, fields = {}) {
    return (await Coupon.create({
        restaurant: t.restaurant._id,
        code: `PC${rid()}`,
        title: 'Coupon',
        discountType: 'percentage',
        discountValue: 10,
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
        ...fields,
    })).toObject();
}

async function makePromo(t, fields = {}) {
    return (await Promotion.create({
        restaurant: t.restaurant._id,
        title: `Banner ${rid()}`,
        image: 'https://img.test/b.png',
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 10 * DAY),
        ...fields,
    })).toObject();
}

const validCouponBody = (extra = {}) => ({
    code: `new${rid()}`,
    title: 'Ten off',
    discountType: 'percentage',
    discountValue: 10,
    startDate: new Date(Date.now() - DAY).toISOString(),
    endDate: new Date(Date.now() + 7 * DAY).toISOString(),
    ...extra,
});

const apply = (body, opts = {}) => call('post', '/promotions/apply-coupon', { user: cust, tenant: A, ...opts }).send(body);

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
/** Minute-of-day now, after making sure we're not about to roll over. */
async function stableMinute() {
    const s = new Date().getSeconds();
    if (s >= 55) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

// ── Coupon CRUD ──────────────────────────────────────────────────────

describe('coupon create', () => {
    test('admin creates: code trimmed + upper-cased, branch defaults to Main, counters / targetUsers / restaurant from body ignored', async () => {
        const code = `  lunch${rid().toLowerCase()} `;
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({
            code,
            maxDiscountAmount: 75,
            usageCount: 999,
            targetUsers: [String(cust._id)],
            restaurant: String(B.restaurant._id),
        }));

        expect(res.status).toBe(201);
        const saved = await Coupon.findById(res.body.coupon._id).lean();
        expect(saved.code).toBe(code.trim().toUpperCase());
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        expect(String(saved.branch)).toBe(String(A.branch._id));
        expect(saved.usageCount).toBe(0);
        expect(saved.targetUsers).toEqual([]);
        expect(saved).toMatchObject({ discountType: 'percentage', discountValue: 10, maxDiscountAmount: 75, usageLimit: 1000, usagePerUser: 1, isActive: true });
    });

    test('a percentage of exactly 100 is accepted', async () => {
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ discountValue: 100 }));
        expect(res.status).toBe(201);
        expect(res.body.coupon.discountValue).toBe(100);
    });

    test.each([
        ['endDate before startDate', { startDate: '2026-12-10', endDate: '2026-12-01' }, 'Start date must be before end date'],
        ['endDate equal to startDate', { startDate: '2026-12-10T10:00:00Z', endDate: '2026-12-10T10:00:00Z' }, 'Start date must be before end date'],
        ['startTime after endTime', { startTime: '18:00', endTime: '12:00' }, 'Start time must be before end time'],
        ['startTime equal to endTime', { startTime: '12:00', endTime: '12:00' }, 'Start time must be before end time'],
        ['unknown discountType', { discountType: 'flat' }, 'Discount type must be "percentage" or "fixed_amount"'],
        ['discountValue 0', { discountValue: 0 }, 'Discount value must be greater than 0'],
        ['negative discountValue', { discountValue: -5 }, 'Discount value must be greater than 0'],
        ['numeric-string discountValue', { discountValue: '10' }, 'Discount value must be greater than 0'],
        ['percentage above 100', { discountValue: 100.01 }, 'Percentage discount cannot exceed 100'],
        ['negative usageLimit', { usageLimit: -1 }, 'Usage limit cannot be negative'],
        ['negative usagePerUser', { usagePerUser: -1 }, 'Usage per user cannot be negative'],
        ['negative minOrderValue', { minOrderValue: -1 }, 'Minimum order value cannot be negative'],
        ['negative maxDiscountAmount', { maxDiscountAmount: -1 }, 'Max discount cap cannot be negative'],
        ['cap below 1/10 of the min-order discount', { discountValue: 20, minOrderValue: 1000, maxDiscountAmount: 19.99 }, 'Max discount cap looks too low for this discount %. Check the values.'],
        ['non-string code', { code: 12345 }, 'Coupon code must be text'],
        ['malformed branch id', { branch: 'not-an-id' }, 'Invalid branch'],
        ['invalid date', { endDate: 'tomorrow-ish' }, 'endDate must be a valid date'],
    ])('%s → 400 "%s", nothing stored', async (_label, extra, message) => {
        const body = validCouponBody(extra);
        const before = await Coupon.countDocuments({ restaurant: A.restaurant._id });
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect(await Coupon.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('flat ₹ discount above 100 is fine (the 100 cap is for percentages only)', async () => {
        const res = await call('post', '/promotions/coupons', { user: A.users.admin })
            .send(validCouponBody({ discountType: 'fixed_amount', discountValue: 250 }));
        expect(res.status).toBe(201);
    });

    test.each([
        ['title', { title: undefined }],
        ['endDate', { endDate: undefined }],
        ['code', { code: undefined }],
    ])('missing %s → 400 from the model, nothing stored', async (_f, extra) => {
        const before = await Coupon.countDocuments({ restaurant: A.restaurant._id });
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody(extra));
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(await Coupon.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('duplicate code in the same tenant + branch (different case) → 409', async () => {
        const first = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code: 'DUPCODE1' }));
        expect(first.status).toBe(201);
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code: 'dupcode1' }));
        expect(res.status).toBe(409);
        expect(res.body.message).toBe('A coupon with this code already exists');
        expect(await Coupon.countDocuments({ restaurant: A.restaurant._id, code: 'DUPCODE1' })).toBe(1);
    });

    test('duplicate code with surrounding spaces is still caught → 409', async () => {
        await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code: 'DUPCODE2' }));
        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code: ' dupcode2 ' }));
        expect(res.status).toBe(409);
        expect(await Coupon.countDocuments({ restaurant: A.restaurant._id, code: 'DUPCODE2' })).toBe(1);
    });

    test('the same code may exist in another tenant and in another branch of the same tenant', async () => {
        const code = `SHARE${rid()}`;
        expect((await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code }))).status).toBe(201);
        expect((await call('post', '/promotions/coupons', { user: B.users.admin }).send(validCouponBody({ code }))).status).toBe(201);
        expect((await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ code, branch: String(kt._id) }))).status).toBe(201);
        expect(await Coupon.countDocuments({ code })).toBe(3);
    });

    test("owner may pin a coupon to one of the tenant's branches but not to another tenant's branch", async () => {
        const ok = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ branch: String(fc._id) }));
        expect(ok.status).toBe(201);
        expect(String(ok.body.coupon.branch)).toBe(String(fc._id));

        const res = await call('post', '/promotions/coupons', { user: A.users.admin }).send(validCouponBody({ branch: String(B.branch._id) }));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Branch not found or not part of your restaurant');
    });

    test('a branch admin always owns the coupon at their branch; naming another branch → 403 BRANCH_MISMATCH', async () => {
        const ok = await call('post', '/promotions/coupons', { user: fcAdmin }).send(validCouponBody());
        expect(ok.status).toBe(201);
        expect(String((await Coupon.findById(ok.body.coupon._id).lean()).branch)).toBe(String(fc._id));

        const res = await call('post', '/promotions/coupons', { user: fcAdmin }).send(validCouponBody({ branch: String(kt._id) }));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });

    test.each(['waiter', 'chef', 'captain'])('%s → 403', async (role) => {
        const res = await call('post', '/promotions/coupons', { user: A.users[role] }).send(validCouponBody());
        expect(res.status).toBe(403);
    });

    test('customer → 403; anonymous on a tenant → 401; anonymous with no tenant → 400 TENANT_REQUIRED', async () => {
        expect((await call('post', '/promotions/coupons', { user: cust, tenant: A }).send(validCouponBody())).status).toBe(403);
        expect((await call('post', '/promotions/coupons', { tenant: A }).send(validCouponBody())).status).toBe(401);
        const bare = await call('post', '/promotions/coupons').send(validCouponBody());
        expect(bare.status).toBe(400);
        expect(bare.body.code).toBe('TENANT_REQUIRED');
    });

    test('plan without couponPromotions → 403 FEATURE_LOCKED with the admin wording', async () => {
        const res = await call('post', '/promotions/coupons', { user: C.users.admin }).send(validCouponBody());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FEATURE_LOCKED');
        expect(res.body.message).toMatch(/Upgrade your subscription/);
        expect(await Coupon.countDocuments({ restaurant: C.restaurant._id })).toBe(0);
    });
});

describe('coupon list / update / delete', () => {
    let mainC;
    let fcC;
    let ktC;
    let nullC;
    let foreign;
    beforeAll(async () => {
        mainC = await makeCoupon(A, { branch: A.branch._id });
        fcC = await makeCoupon(A, { branch: fc._id });
        ktC = await makeCoupon(A, { branch: kt._id });
        nullC = await makeCoupon(A, { branch: null });
        foreign = await makeCoupon(B);
    });
    const ids = (res) => res.body.coupons.map((c) => String(c._id));

    test('owner lists every coupon of the tenant and nothing from other tenants', async () => {
        const res = await call('get', '/promotions/coupons', { user: A.users.admin });
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual(expect.arrayContaining([mainC, fcC, ktC, nullC].map((c) => String(c._id))));
        expect(ids(res)).not.toContain(String(foreign._id));
        expect(res.body.coupons.every((c) => String(c.restaurant) === String(A.restaurant._id))).toBe(true);
    });

    test.each([
        ['?branch=<fc>', () => `?branch=${fc._id}`, () => [fcC]],
        ['?branch=tenant-only', () => '?branch=tenant-only', () => [nullC]],
    ])('owner with %s sees only that slice', async (_l, q, expected) => {
        const res = await call('get', `/promotions/coupons${q()}`, { user: A.users.admin });
        const got = ids(res);
        for (const c of expected()) expect(got).toContain(String(c._id));
        for (const c of [mainC, fcC, ktC, nullC].filter((x) => !expected().includes(x))) expect(got).not.toContain(String(c._id));
    });

    test('branch admin lists only their branch (no Main, no tenant-level, ?branch=all ignored)', async () => {
        const res = await call('get', '/promotions/coupons?branch=all', { user: fcAdmin });
        expect(res.status).toBe(200);
        expect(res.body.coupons.length).toBeGreaterThan(0);
        expect(res.body.coupons.every((c) => String(c.branch) === String(fc._id))).toBe(true);
    });

    test('update changes allowed fields only; usageCount / targetUsers / restaurant in body ignored', async () => {
        const c = await makeCoupon(A, { usageCount: 4 });
        const res = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin }).send({
            title: 'Renamed', discountValue: 15, discountType: 'percentage', isActive: false,
            usageCount: 0, targetUsers: [String(cust._id)], restaurant: String(B.restaurant._id),
        });
        expect(res.status).toBe(200);
        const saved = await Coupon.findById(c._id).lean();
        expect(saved).toMatchObject({ title: 'Renamed', discountValue: 15, isActive: false, usageCount: 4 });
        expect(saved.targetUsers).toEqual([]);
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
    });

    test('update runs the same body rules as create', async () => {
        const c = await makeCoupon(A);
        const res = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin })
            .send({ discountType: 'percentage', discountValue: 150 });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Percentage discount cannot exceed 100');
        expect((await Coupon.findById(c._id).lean()).discountValue).toBe(10);
    });

    // Regression (fixed 2026-10): updateCoupon re-runs validateCouponBody on the merged (stored + incoming) coupon.
    test('update with only discountValue 150 on a percentage coupon is accepted (no discountType in body)', async () => {
        const c = await makeCoupon(A, { discountType: 'percentage', discountValue: 10 });
        const res = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin }).send({ discountValue: 150 });
        expect(res.status).toBe(400);
        expect((await Coupon.findById(c._id).lean()).discountValue).toBe(10);
    });

    test('update with only an endDate earlier than the stored startDate is accepted', async () => {
        const c = await makeCoupon(A, { startDate: new Date(Date.now() + 5 * DAY), endDate: new Date(Date.now() + 10 * DAY) });
        const res = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin })
            .send({ endDate: new Date(Date.now() + 2 * DAY).toISOString() });
        expect(res.status).toBe(400);
    });

    test("owner can move a coupon to a tenant branch, not to another tenant's branch", async () => {
        const c = await makeCoupon(A);
        const ok = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin }).send({ branch: String(kt._id) });
        expect(ok.status).toBe(200);
        expect(String((await Coupon.findById(c._id).lean()).branch)).toBe(String(kt._id));
        const bad = await call('put', `/promotions/coupons/${c._id}`, { user: A.users.admin }).send({ branch: String(B.branch._id) });
        expect(bad.status).toBe(400);
        expect(String((await Coupon.findById(c._id).lean()).branch)).toBe(String(kt._id));
    });

    test.each([
        ['another tenant', () => B.users.admin, () => ktC],
        ['a branch admin on another branch', () => fcAdmin, () => ktC],
        ['a branch admin on a tenant-level coupon', () => fcAdmin, () => nullC],
    ])('update / delete by %s → 404 and the coupon is untouched', async (_l, user, coupon) => {
        const c = coupon();
        const up = await call('put', `/promotions/coupons/${c._id}`, { user: user() }).send({ title: 'Hijacked' });
        expect(up.status).toBe(404);
        const del = await call('delete', `/promotions/coupons/${c._id}`, { user: user() });
        expect(del.status).toBe(404);
        const saved = await Coupon.findById(c._id).lean();
        expect(saved.title).toBe('Coupon');
    });

    test('branch admin edits own-branch coupon; re-pointing it at another branch → 403', async () => {
        const c = await makeCoupon(A, { branch: fc._id });
        expect((await call('put', `/promotions/coupons/${c._id}`, { user: fcAdmin }).send({ title: 'FC deal' })).status).toBe(200);
        const res = await call('put', `/promotions/coupons/${c._id}`, { user: fcAdmin }).send({ branch: String(kt._id) });
        expect(res.status).toBe(403);
        const saved = await Coupon.findById(c._id).lean();
        expect(saved.title).toBe('FC deal');
        expect(String(saved.branch)).toBe(String(fc._id));
    });

    test('delete removes the coupon; a second delete → 404; malformed id → 400', async () => {
        const c = await makeCoupon(A);
        const res = await call('delete', `/promotions/coupons/${c._id}`, { user: A.users.admin });
        expect(res.status).toBe(200);
        expect(await Coupon.findById(c._id)).toBeNull();
        expect((await call('delete', `/promotions/coupons/${c._id}`, { user: A.users.admin })).status).toBe(404);
        expect((await call('delete', '/promotions/coupons/nope', { user: A.users.admin })).status).toBe(400);
        expect((await call('put', '/promotions/coupons/nope', { user: A.users.admin }).send({ title: 'x' })).status).toBe(400);
    });
});

// ── apply-coupon ─────────────────────────────────────────────────────

describe('POST /promotions/apply-coupon', () => {
    test('guest (tenant slug, no login) → 401; no tenant at all → 400 TENANT_REQUIRED', async () => {
        const c = await makeCoupon(A);
        expect((await call('post', '/promotions/apply-coupon', { tenant: A }).send({ code: c.code, orderValue: 500 })).status).toBe(401);
        const bare = await call('post', '/promotions/apply-coupon').send({ code: c.code, orderValue: 500 });
        expect(bare.status).toBe(400);
        expect(bare.body.code).toBe('TENANT_REQUIRED');
    });

    test('customer of a tenant without couponPromotions → 403 with customer wording', async () => {
        const c = await makeCoupon(C);
        const res = await call('post', '/promotions/apply-coupon', { user: cust, tenant: C }).send({ code: c.code, orderValue: 500 });
        expect(res.status).toBe(403);
        expect(res.body.message).toBe("This restaurant doesn't offer coupons and promotions.");
    });

    test.each([
        // [label, coupon fields, orderValue, expected discount]
        ['10 % of 625', { discountValue: 10 }, 625, 62.5],
        ['12.5 % of 99.99 (rounded to the paisa)', { discountValue: 12.5 }, 99.99, 12.5],
        ['15 % of 333.33', { discountValue: 15 }, 333.33, 50],
        ['7 % of 1234.56', { discountValue: 7 }, 1234.56, 86.42],
        ['20 % capped at 75', { discountValue: 20, maxDiscountAmount: 75 }, 1000, 75],
        ['20 % under the 300 cap', { discountValue: 20, maxDiscountAmount: 300 }, 1000, 200],
        ['cap 0 = uncapped', { discountValue: 50, maxDiscountAmount: 0 }, 1000, 500],
        ['100 %', { discountValue: 100 }, 432.1, 432.1],
        ['flat 100', { discountType: 'fixed_amount', discountValue: 100 }, 625, 100],
        ['flat 150 on a 99.5 order → whole order', { discountType: 'fixed_amount', discountValue: 150 }, 99.5, 99.5],
        ['numeric-string order value "625"', { discountValue: 10 }, '625', 62.5],
    ])('%s → discount %p', async (_l, fields, orderValue, expected) => {
        const c = await makeCoupon(A, fields);
        const res = await apply({ code: c.code.toLowerCase(), orderValue });
        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(expected);
        expect(res.body.coupon).toMatchObject({ code: c.code, discountType: c.discountType, discountValue: c.discountValue, scope: 'all' });
    });

    test('apply is read-only: no usageCount increment, no redemption row', async () => {
        const c = await makeCoupon(A, { usagePerUser: 1 });
        for (let i = 0; i < 3; i += 1) expect((await apply({ code: c.code, orderValue: 500 })).status).toBe(200);
        expect((await Coupon.findById(c._id).lean()).usageCount).toBe(0);
        expect(await CouponRedemption.countDocuments({ coupon: c._id })).toBe(0);
    });

    test.each([
        ['missing code', () => ({ orderValue: 500 }), 400, 'Please provide a coupon code'],
        ['missing orderValue', (c) => ({ code: c.code }), 400, 'Invalid order value'],
        ['orderValue 0', (c) => ({ code: c.code, orderValue: 0 }), 400, 'Invalid order value'],
        ['negative orderValue', (c) => ({ code: c.code, orderValue: -10 }), 400, 'Invalid order value'],
        ['non-numeric orderValue', (c) => ({ code: c.code, orderValue: 'abc' }), 400, 'Invalid order value'],
        ['object orderValue', (c) => ({ code: c.code, orderValue: { $gt: 0 } }), 400, 'Invalid order value'],
        ['non-string code', () => ({ code: 123, orderValue: 500 }), 400, 'Please provide a coupon code'],
        ['unknown code', () => ({ code: 'NOPE-NOPE', orderValue: 500 }), 404, 'Invalid or inactive coupon code'],
    ])('%s → %i', async (_l, body, status, message) => {
        const c = await makeCoupon(A);
        const res = await apply(body(c));
        expect(res.status).toBe(status);
        expect(res.body.message).toBe(message);
    });

    test.each([
        ['inactive', { isActive: false }, 404, 'Invalid or inactive coupon code'],
        ['expired yesterday', { startDate: new Date(Date.now() - 5 * DAY), endDate: new Date(Date.now() - DAY) }, 400, 'Coupon code has expired'],
        ['expired one second ago', { startDate: new Date(Date.now() - 5 * DAY), endDate: new Date(Date.now() - 1000) }, 400, 'Coupon code has expired'],
        ['not started yet', { startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 5 * DAY) }, 400, 'Coupon code has expired'],
        ['usage limit reached', { usageLimit: 5, usageCount: 5 }, 400, 'Coupon usage limit has been reached'],
        ['below min order', { minOrderValue: 500.01 }, 400, 'Minimum order value of ₹500.01 required for this coupon'],
    ])('%s → %i "%s"', async (_l, fields, status, message) => {
        const c = await makeCoupon(A, fields);
        const res = await apply({ code: c.code, orderValue: 500 });
        expect(res.status).toBe(status);
        expect(res.body.message).toBe(message);
    });

    test('min order is inclusive: orderValue exactly minOrderValue is accepted', async () => {
        const c = await makeCoupon(A, { minOrderValue: 500 });
        const res = await apply({ code: c.code, orderValue: 500 });
        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(50);
    });

    test("another tenant's code → 404", async () => {
        const c = await makeCoupon(B);
        expect((await apply({ code: c.code, orderValue: 500 })).status).toBe(404);
    });

    test('usageLimit 0 = unlimited; one use below the limit still applies', async () => {
        const unl = await makeCoupon(A, { usageLimit: 0, usageCount: 9999 });
        expect((await apply({ code: unl.code, orderValue: 500 })).status).toBe(200);
        const almost = await makeCoupon(A, { usageLimit: 5, usageCount: 4 });
        expect((await apply({ code: almost.code, orderValue: 500 })).status).toBe(200);
    });

    describe('per-user limit (counts CouponRedemption rows of this user)', () => {
        const redeem = (c, user) => CouponRedemption.create({
            restaurant: A.restaurant._id, coupon: c._id, couponCode: c.code, couponTitle: c.title,
            user: user ? user._id : null, orderValue: 500, discountAmount: 50, discountType: 'percentage', discountValue: 10,
        });

        test('1 per user: refused after one redemption, another customer still OK', async () => {
            const c = await makeCoupon(A, { usagePerUser: 1 });
            await redeem(c, cust);
            const res = await apply({ code: c.code, orderValue: 500 });
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('You can only use this coupon 1 time');
            const other = await createCustomer('pc-other');
            expect((await apply({ code: c.code, orderValue: 500 }, { user: other })).status).toBe(200);
        });

        test('3 per user: 2 used → OK, 3 used → refused (plural message)', async () => {
            const c = await makeCoupon(A, { usagePerUser: 3 });
            await redeem(c, cust);
            await redeem(c, cust);
            expect((await apply({ code: c.code, orderValue: 500 })).status).toBe(200);
            await redeem(c, cust);
            const res = await apply({ code: c.code, orderValue: 500 });
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('You can only use this coupon 3 times');
        });

        test('usagePerUser 0 = no per-user limit; guest redemptions (user null) do not count', async () => {
            const c = await makeCoupon(A, { usagePerUser: 0 });
            for (let i = 0; i < 4; i += 1) await redeem(c, cust);
            expect((await apply({ code: c.code, orderValue: 500 })).status).toBe(200);
            const c2 = await makeCoupon(A, { usagePerUser: 1 });
            await redeem(c2, null);
            expect((await apply({ code: c2.code, orderValue: 500 })).status).toBe(200);
        });
    });

    describe('time-of-day window (server local time, minute resolution, inclusive)', () => {
        test.each([
            ['now inside [now-60, now+60]', (m) => [m - 60, m + 60], 200],
            ['window starting exactly now', (m) => [m, m + 30], 200],
            ['window ending exactly now (whole end minute counts)', (m) => [m - 30, m], 200],
            ['window ended one minute ago', (m) => [m - 30, m - 1], 400],
            ['window starts in one minute', (m) => [m + 1, m + 30], 400],
        ])('%s → %i', async (_l, win, status) => {
            const m = await stableMinute();
            const [s, e] = win(m);
            if (s < 0 || e > 1439) return; // too close to midnight to express this window
            const c = await makeCoupon(A, { startTime: hhmm(s), endTime: hhmm(e) });
            const res = await apply({ code: c.code, orderValue: 500 });
            expect(res.status).toBe(status);
            if (status === 400) {
                expect(res.body.message).toBe(`This coupon is valid only between ${hhmm(s)} and ${hhmm(e)}`);
            } else {
                expect(res.body.discount).toBe(50);
            }
        });

        test('only one bound set → the window is ignored', async () => {
            const m = await stableMinute();
            if (m > 1437) return;
            const c = await makeCoupon(A, { startTime: hhmm(m + 2) });
            expect((await apply({ code: c.code, orderValue: 500 })).status).toBe(200);
        });
    });

    describe('branch scope (X-Branch-Id)', () => {
        test.each([
            ['own branch', () => fc, 200],
            ['Main branch (inherited)', () => A.branch, 200],
            ['tenant-level (branch null)', () => null, 200],
            ['a sibling branch', () => kt, 404],
        ])('customer at FC Road applying a %s coupon → %i', async (_l, owner, status) => {
            const o = owner();
            const c = await makeCoupon(A, { branch: o ? o._id : null });
            const res = await apply({ code: c.code, orderValue: 500 }, { branch: fc });
            expect(res.status).toBe(status);
        });

        test.each([
            ['Main', () => A.branch, 200],
            ['tenant-level', () => null, 200],
            ['FC Road', () => fc, 404],
        ])('customer at the Main branch applying a %s coupon → %i', async (_l, owner, status) => {
            const o = owner();
            const c = await makeCoupon(A, { branch: o ? o._id : null });
            const res = await apply({ code: c.code, orderValue: 500 }, { branch: A.branch });
            expect(res.status).toBe(status);
        });

        test('malformed X-Branch-Id → 400 BRANCH_ID_INVALID', async () => {
            const c = await makeCoupon(A);
            const res = await apply({ code: c.code, orderValue: 500 }, { branch: 'bad' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('BRANCH_ID_INVALID');
        });
    });

    describe('item scope', () => {
        const items = [
            { prepStation: 'kitchen', price: 200, quantity: 2 },
            { prepStation: 'bar', price: 120.5, quantity: 3 },
        ];
        test('scoped coupon without items → 400 COUPON_NEEDS_ITEMS', async () => {
            const c = await makeCoupon(A, { scope: 'food' });
            const res = await apply({ code: c.code, orderValue: 761.5 });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('COUPON_NEEDS_ITEMS');
        });
        test.each([
            ['food 10 %', { scope: 'food' }, 400, 40],
            ['beverages 10 %', { scope: 'beverages' }, 361.5, 36.15],
            ['beverages flat 500 → capped at the beverage slice', { scope: 'beverages', discountType: 'fixed_amount', discountValue: 500 }, 361.5, 361.5],
            ['all 10 % with items', { scope: 'all' }, 761.5, 76.15],
        ])('%s → eligible %p, discount %p', async (_l, fields, eligible, discount) => {
            const c = await makeCoupon(A, fields);
            const res = await apply({ code: c.code, orderValue: 761.5, items });
            expect(res.status).toBe(200);
            expect(res.body.eligibleSubtotal).toBe(eligible);
            expect(res.body.discount).toBe(discount);
        });
        test('beverage coupon on a food-only cart → 400 COUPON_SCOPE_NO_MATCH', async () => {
            const c = await makeCoupon(A, { scope: 'beverages' });
            const res = await apply({ code: c.code, orderValue: 400, items: [items[0]] });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('COUPON_SCOPE_NO_MATCH');
        });
        // Decision 6 — classification follows the admin's category kind.
        test('a Coke in a Drink category counts as a beverage even when routed to the counter', async () => {
            const drinks = await Category.create({ restaurant: A.restaurant._id, name: `Drinks ${rid()}`, kind: 'beverages' });
            const coke = await MenuItem.create({
                restaurant: A.restaurant._id, category: drinks._id, name: 'Coke 300ml', description: 'd',
                basePrice: 60, prepStation: 'counter',
            });
            const cart = [
                // client claims 'food' — the server resolves the menu item's category instead
                { menuItem: String(coke._id), prepStation: 'counter', categoryKind: 'food', price: 60, quantity: 2 },
                { menuItem: String(A.items.paneer._id), prepStation: 'kitchen', price: 200, quantity: 1 },
            ];
            const bev = await apply({ code: (await makeCoupon(A, { scope: 'beverages' })).code, orderValue: 320, items: cart });
            expect(bev.status).toBe(200);
            expect(bev.body.eligibleSubtotal).toBe(120);
            const food = await apply({ code: (await makeCoupon(A, { scope: 'food' })).code, orderValue: 320, items: cart });
            expect(food.status).toBe(200);
            expect(food.body.eligibleSubtotal).toBe(200);
        });
        test('a client-sent categoryKind is used for lines without a menu item id', async () => {
            const c = await makeCoupon(A, { scope: 'beverages' });
            const res = await apply({ code: c.code, orderValue: 100, items: [{ prepStation: 'counter', categoryKind: 'beverages', price: 50, quantity: 2 }] });
            expect(res.status).toBe(200);
            expect(res.body.eligibleSubtotal).toBe(100);
        });
        test('the discount never exceeds the orderValue sent, even if items sum higher', async () => {
            const c = await makeCoupon(A, { discountType: 'fixed_amount', discountValue: 300 });
            const res = await apply({ code: c.code, orderValue: 100, items });
            expect(res.status).toBe(200);
            expect(res.body.discount).toBe(100);
        });
    });
});

// ── Public listings ──────────────────────────────────────────────────

describe('active coupons / promotions listings', () => {
    test('GET /coupons/active: only active + in-date coupons of this tenant', async () => {
        const live = await makeCoupon(A);
        const off = await makeCoupon(A, { isActive: false });
        const old = await makeCoupon(A, { startDate: new Date(Date.now() - 9 * DAY), endDate: new Date(Date.now() - DAY) });
        const future = await makeCoupon(A, { startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 9 * DAY) });
        const foreign = await makeCoupon(B);
        const res = await call('get', '/promotions/coupons/active', { tenant: A });
        expect(res.status).toBe(200);
        const got = res.body.coupons.map((c) => String(c._id));
        expect(got).toContain(String(live._id));
        for (const c of [off, old, future, foreign]) expect(got).not.toContain(String(c._id));
        expect(res.body.count).toBe(got.length);
    });

    test('customer at FC Road sees FC + Main + tenant-level coupons, not Kothrud', async () => {
        const fcC = await makeCoupon(A, { branch: fc._id });
        const mainC = await makeCoupon(A, { branch: A.branch._id });
        const nullC = await makeCoupon(A, { branch: null });
        const ktC = await makeCoupon(A, { branch: kt._id });
        const res = await call('get', '/promotions/coupons/active', { tenant: A, branch: fc });
        const got = res.body.coupons.map((c) => String(c._id));
        for (const c of [fcC, mainC, nullC]) expect(got).toContain(String(c._id));
        expect(got).not.toContain(String(ktC._id));
    });

    test('GET /promotions: active, in-date, own tenant only, ordered by displayOrder', async () => {
        const second = await makePromo(A, { displayOrder: 2 });
        const first = await makePromo(A, { displayOrder: 1 });
        const off = await makePromo(A, { isActive: false });
        const expired = await makePromo(A, { startDate: new Date(Date.now() - 9 * DAY), endDate: new Date(Date.now() - 1000) });
        const future = await makePromo(A, { startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 9 * DAY) });
        const foreign = await makePromo(B);
        const res = await call('get', '/promotions', { tenant: A });
        expect(res.status).toBe(200);
        const got = res.body.promotions.map((p) => String(p._id));
        expect(got.indexOf(String(first._id))).toBeGreaterThan(-1);
        expect(got.indexOf(String(first._id))).toBeLessThan(got.indexOf(String(second._id)));
        for (const p of [off, expired, future, foreign]) expect(got).not.toContain(String(p._id));
        expect(res.body.promotions.every((p) => String(p.restaurant) === String(A.restaurant._id))).toBe(true);
    });

    test('anonymous request with no tenant slug is refused (400 TENANT_REQUIRED), never an all-tenant list', async () => {
        await makePromo(A);
        await makePromo(B);
        for (const url of ['/promotions', '/promotions/coupons/active']) {
            const res = await call('get', url);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('TENANT_REQUIRED');
            expect(res.body.promotions || res.body.coupons).toBeUndefined();
        }
    });

    test('public listings are 403 for a tenant without couponPromotions', async () => {
        expect((await call('get', '/promotions', { tenant: C })).status).toBe(403);
        expect((await call('get', '/promotions/coupons/active', { tenant: C })).status).toBe(403);
    });
});

describe('POST /promotions (banner create)', () => {
    const body = (extra = {}) => ({
        title: 'Diwali', image: 'https://img.test/d.png', type: 'banner',
        endDate: new Date(Date.now() + 5 * DAY).toISOString(), ...extra,
    });

    test('admin creates: tenant from token, branch defaults to Main, restaurant in body ignored; it appears in the public list', async () => {
        const res = await call('post', '/promotions', { user: A.users.admin }).send(body({ restaurant: String(B.restaurant._id), displayOrder: -5 }));
        expect(res.status).toBe(201);
        const saved = await Promotion.findById(res.body.promotion._id).lean();
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        expect(String(saved.branch)).toBe(String(A.branch._id));
        const list = await call('get', '/promotions', { tenant: A });
        expect(list.body.promotions.map((p) => String(p._id))).toContain(String(saved._id));
    });

    test('branch admin banner is owned by their branch and hidden from a sibling branch', async () => {
        const res = await call('post', '/promotions', { user: fcAdmin }).send(body());
        expect(res.status).toBe(201);
        expect(String(res.body.promotion.branch)).toBe(String(fc._id));
        const atKt = await call('get', '/promotions', { tenant: A, branch: kt });
        expect(atKt.body.promotions.map((p) => String(p._id))).not.toContain(String(res.body.promotion._id));
        const atFc = await call('get', '/promotions', { tenant: A, branch: fc });
        expect(atFc.body.promotions.map((p) => String(p._id))).toContain(String(res.body.promotion._id));
    });

    test.each([
        ['missing title', { title: undefined }, 'Title is required'],
        ['blank title', { title: '   ' }, 'Title is required'],
        ['end before start', { startDate: '2026-12-10', endDate: '2026-12-01' }, 'Start date must be before end date'],
        ['bad type', { type: 'sticker' }, 'Invalid type'],
        ['non-numeric displayOrder', { displayOrder: 'top' }, 'displayOrder must be a number'],
        ["another tenant's branch", { branch: 'B' }, 'Branch not found or not part of your restaurant'],
    ])('%s → 400 "%s"', async (_l, extra, message) => {
        const e = { ...extra };
        if (e.branch === 'B') e.branch = String(B.branch._id);
        const before = await Promotion.countDocuments({ restaurant: A.restaurant._id });
        const res = await call('post', '/promotions', { user: A.users.admin }).send(body(e));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect(await Promotion.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('missing image → 400 (model), customer → 403, waiter → 403', async () => {
        expect((await call('post', '/promotions', { user: A.users.admin }).send(body({ image: undefined }))).status).toBe(400);
        expect((await call('post', '/promotions', { user: cust, tenant: A }).send(body())).status).toBe(403);
        expect((await call('post', '/promotions', { user: A.users.waiter }).send(body())).status).toBe(403);
    });
});

// ── Reports ──────────────────────────────────────────────────────────

describe('redemption + performance reports', () => {
    let R;
    let R2;
    let rFc;
    let c1;
    let c2;
    let cFc;
    let rFcAdmin;

    // Raw insert so createdAt can be placed exactly (bypasses timestamps).
    async function rawRedemption(t, coupon, { at, discountAmount, orderValue = 500, branch = coupon.branch || null, user = null }) {
        await CouponRedemption.collection.insertOne({
            restaurant: t.restaurant._id, branch, coupon: coupon._id, order: null,
            couponCode: coupon.code, couponTitle: coupon.title, user,
            orderValue, discountAmount, discountType: coupon.discountType, discountValue: coupon.discountValue,
            createdAt: at, updatedAt: at,
        });
    }
    // Noon (local) N days ago — far from any midnight edge.
    const noonDaysAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

    beforeAll(async () => {
        R = await seedTenant({ label: 'pc-r' });
        R2 = await seedTenant({ label: 'pc-r2' });
        rFc = await Branch.create({ restaurant: R.restaurant._id, name: 'FC', slug: 'fc', isActive: true });
        rFcAdmin = await createUser({
            name: 'R fc admin', email: `rfc.${rid()}@staff.test`, role: 'admin',
            restaurant: R.restaurant._id, branch: rFc._id, permissions: defaultPermissionsForRole('admin'),
        });
        c1 = await makeCoupon(R, { code: 'RPTONE', title: 'Report one', branch: R.branch._id });
        c2 = await makeCoupon(R, { code: 'RPTTWO', title: 'Report two', discountType: 'fixed_amount', discountValue: 40, branch: R.branch._id });
        cFc = await makeCoupon(R, { code: 'RPTFC', title: 'FC only', branch: rFc._id });
        const other = await makeCoupon(R2, { code: 'RPTONE' });

        // Two days ago (inside week + month): c1 × 2, c2 × 1, cFc × 1
        await rawRedemption(R, c1, { at: noonDaysAgo(2), discountAmount: 50.25 });
        await rawRedemption(R, c1, { at: noonDaysAgo(2), discountAmount: 12.5 });
        await rawRedemption(R, c2, { at: noonDaysAgo(2), discountAmount: 40 });
        await rawRedemption(R, cFc, { at: noonDaysAgo(2), discountAmount: 7.05 });
        // 20 days ago (month only): c2 × 1
        await rawRedemption(R, c2, { at: noonDaysAgo(20), discountAmount: 40 });
        // 60 days ago (no filter only)
        await rawRedemption(R, c1, { at: noonDaysAgo(60), discountAmount: 99 });
        // Noise in another tenant
        await rawRedemption(R2, other, { at: noonDaysAgo(2), discountAmount: 1000 });
    });

    const red = (q = '', user = R.users.admin) => call('get', `/promotions/coupons/redemptions${q}`, { user });
    const perf = (q = '', user = R.users.admin) => call('get', `/promotions/coupons/performance${q}`, { user });

    test.each([
        ['no filter', '', 6],
        ['week', '?filter=week', 4],
        ['month', '?filter=month', 5],
        ['today', '?filter=today', 0],
    ])('redemptions %s → total %i, tenant-scoped', async (_l, q, total) => {
        const res = await red(q);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(total);
        expect(res.body.redemptions.every((r) => String(r.restaurant) === String(R.restaurant._id))).toBe(true);
    });

    test('couponId filter + pagination', async () => {
        const res = await red(`?couponId=${c1._id}&limit=2&page=1`);
        expect(res.body).toMatchObject({ total: 3, page: 1, totalPages: 2 });
        expect(res.body.redemptions).toHaveLength(2);
        const p2 = await red(`?couponId=${c1._id}&limit=2&page=2`);
        expect(p2.body.redemptions).toHaveLength(1);
        // newest first
        expect(p2.body.redemptions[0].discountAmount).toBe(99);
    });

    test('branch admin sees only redemptions of their branch coupons', async () => {
        const res = await red('', rFcAdmin);
        expect(res.body.total).toBe(1);
        expect(res.body.redemptions[0].couponCode).toBe('RPTFC');
    });

    test('another tenant admin cannot read R redemptions, even with R couponId', async () => {
        const res = await red(`?couponId=${c1._id}`, R2.users.admin);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
    });

    test.each([
        ['page=0', '?page=0'],
        ['malformed couponId', '?couponId=xyz'],
    ])('redemptions with %s → a 4xx / sane default, not 500', async (_l, q) => {
        // Regression (fixed 2026-10): getRedemptions clamps page/limit (limit ≤ 100) and 400s a malformed couponId.
        const res = await red(q);
        expect(res.status).toBeLessThan(500);
    });

    test('performance (week): exact counts, savings and top coupons; month adds the older row', async () => {
        const res = await perf('?filter=week');
        expect(res.status).toBe(200);
        expect(res.body.summary).toMatchObject({ totalRedemptions: 4, totalSavings: 109.8, activeCoupons: 3 });
        expect(res.body.daily).toHaveLength(7);
        const top = Object.fromEntries(res.body.topCoupons.map((t) => [t.code, t]));
        expect(top.RPTONE).toMatchObject({ count: 2, savings: 62.75 });
        expect(top.RPTTWO).toMatchObject({ count: 1, savings: 40 });
        expect(top.RPTFC).toMatchObject({ count: 1, savings: 7.05 });

        const month = await perf('?filter=month');
        expect(month.body.summary).toMatchObject({ totalRedemptions: 5, totalSavings: 149.8 });
        expect(month.body.daily).toHaveLength(30);
    });

    test('performance for a branch admin counts only their branch', async () => {
        const res = await perf('?filter=week', rFcAdmin);
        expect(res.body.summary).toMatchObject({ totalRedemptions: 1, totalSavings: 7.05, activeCoupons: 1 });
    });

    test('performance with ?branch=<Main> narrows the aggregate (ObjectId cast)', async () => {
        const res = await perf(`?filter=week&branch=${R.branch._id}`);
        expect(res.body.summary).toMatchObject({ totalRedemptions: 3, totalSavings: 102.75, activeCoupons: 2 });
    });

    // Regression (fixed 2026-10): getPerformanceStats builds day boundaries, bucket keys and $dateToString grouping all in APP_TIMEZONE (IST).
    test('performance "today" counts a redemption made at 06:00 local time today (IST server)', async () => {
        const T = await seedTenant({ label: 'pc-tz' });
        const c = await makeCoupon(T, { branch: T.branch._id });
        const six = new Date(); six.setHours(6, 0, 0, 0);       // 00:30 UTC today
        await rawRedemption(T, c, { at: six, discountAmount: 25 });
        const res = await perf('?filter=today', T.users.admin);
        expect(res.status).toBe(200);
        expect(res.body.summary).toMatchObject({ totalRedemptions: 1, totalSavings: 25 });
    });

    test('reports are admin-only and feature-gated', async () => {
        expect((await red('', R.users.waiter)).status).toBe(403);
        expect((await call('get', '/promotions/coupons/redemptions', { user: cust, tenant: R })).status).toBe(403);
        expect((await call('get', '/promotions/coupons/performance', { user: C.users.admin })).status).toBe(403);
    });
});

// ── Redemption lifecycle through real orders (§7.2) ─────────────────

describe('coupon redemption lifecycle via POST /orders', () => {
    let L;
    beforeAll(async () => { L = await seedTenant({ label: 'pc-life' }); });

    // 2 × Paneer (200) + Thali Full (225) = 625 subtotal
    const cart = (t) => [
        { menuItem: String(t.items.paneer._id), quantity: 2 },
        { menuItem: String(t.items.thali._id), quantity: 1, selectedSizes: [{ name: 'Full' }] },
    ];
    const order = (t, user, code, total) => call('post', '/orders', { user, tenant: t })
        .send({ type: 'takeaway', pickupLocation: 'Counter', items: cart(t), couponCode: code, total });

    test('one order = one usage + one redemption whose numbers match the order; reports agree with the orders', async () => {
        const c = await makeCoupon(L, { code: 'LIFE10', discountValue: 10, usagePerUser: 0, branch: L.branch._id });
        const flat = await makeCoupon(L, { code: 'LIFEFLAT', discountType: 'fixed_amount', discountValue: 99.99, usagePerUser: 0, branch: L.branch._id });
        const u1 = await createCustomer('life1');
        const u2 = await createCustomer('life2');
        // 625 + 31.25 GST + 20 packaging = 676.25
        const r1 = await order(L, u1, 'life10', 613.75);
        const r2 = await order(L, u2, 'LIFE10', 613.75);
        const r3 = await order(L, u1, 'lifeflat', 576.26);
        for (const r of [r1, r2, r3]) expect(r.status).toBe(201);

        expect((await Coupon.findById(c._id).lean()).usageCount).toBe(2);
        expect((await Coupon.findById(flat._id).lean()).usageCount).toBe(1);

        const orders = await Order.find({ restaurant: L.restaurant._id, couponCode: { $ne: '' } }).lean();
        const rows = await CouponRedemption.find({ restaurant: L.restaurant._id }).lean();
        expect(rows).toHaveLength(3);
        for (const o of orders) {
            const row = rows.find((r) => String(r.order) === String(o._id));
            expect(row).toBeDefined();
            expect(row.discountAmount).toBe(o.couponDiscount);
            expect(row.couponCode).toBe(o.couponCode);
            expect(row.orderValue).toBe(625);
            expect(String(row.user)).toBe(String(o.user));
            expect(String(row.branch)).toBe(String(L.branch._id));
        }
        const sumDiscount = Math.round(orders.reduce((s, o) => s + o.couponDiscount, 0) * 100) / 100;
        expect(sumDiscount).toBe(224.99);   // 62.50 + 62.50 + 99.99

        const list = await call('get', '/promotions/coupons/redemptions', { user: L.users.admin });
        expect(list.body.total).toBe(3);
        expect(list.body.redemptions.map((r) => r.user && r.user.email).filter(Boolean).sort())
            .toEqual([u1.email, u1.email, u2.email].sort());

        const p = await call('get', '/promotions/coupons/performance?filter=month', { user: L.users.admin });
        expect(p.body.summary.totalOrders).toBe(3);
        expect(p.body.summary).toMatchObject({ totalRedemptions: 3, totalSavings: 224.99 });
        const top = Object.fromEntries(p.body.topCoupons.map((t) => [t.code, t]));
        expect(top.LIFE10).toMatchObject({ count: 2, savings: 125 });
        expect(top.LIFEFLAT).toMatchObject({ count: 1, savings: 99.99 });
    });

    test('apply-coupon after a real order enforces the per-user limit for that customer', async () => {
        const c = await makeCoupon(L, { code: 'LIFEONCE', usagePerUser: 1 });
        const u = await createCustomer('life-once');
        expect((await call('post', '/promotions/apply-coupon', { user: u, tenant: L }).send({ code: c.code, orderValue: 625 })).status).toBe(200);
        expect((await order(L, u, c.code, 613.75)).status).toBe(201);
        const again = await call('post', '/promotions/apply-coupon', { user: u, tenant: L }).send({ code: c.code, orderValue: 625 });
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('You can only use this coupon 1 time');
    });

    // Not marked BUG: no spec / comment says a cancelled order should give
    // the use back, and getPerformanceStats (promotionController.js:639-640)
    // explicitly anticipates "a redeemed order that was later cancelled".
    // Pinned so a change is noticed — see risks in the QA report.
    test('cancelling a coupon order keeps the usage and the redemption (no release path)', async () => {
        const c = await makeCoupon(L, { code: 'LIFECXL', usageLimit: 1, usagePerUser: 1 });
        const u = await createCustomer('life-cxl');
        const placed = await order(L, u, c.code, 613.75);
        expect(placed.status).toBe(201);
        const res = await call('patch', `/orders/${placed.body.order._id}/status`, { user: L.users.admin })
            .send({ status: 'cancelled', cancellationReason: 'Kitchen closed early' });
        expect(res.status).toBe(200);
        expect((await Order.findById(placed.body.order._id).lean()).status).toBe('cancelled');

        expect((await Coupon.findById(c._id).lean()).usageCount).toBe(1);
        expect(await CouponRedemption.countDocuments({ coupon: c._id })).toBe(1);
        // …so the customer can't re-apply it and nobody else can either.
        const again = await call('post', '/promotions/apply-coupon', { user: u, tenant: L }).send({ code: c.code, orderValue: 625 });
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('Coupon usage limit has been reached');
    });
});
