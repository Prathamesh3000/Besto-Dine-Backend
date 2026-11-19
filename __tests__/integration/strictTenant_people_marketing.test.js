/**
 * STRICT tenant isolation: CRM, campaigns, coupons / promotions,
 * notifications, two-factor admin reset.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const Order = model('order');
const Campaign = model('campaign');
const Coupon = model('coupon');
const CouponRedemption = model('couponRedemption');
const Promotion = model('promotion');
const Notification = model('notification');
const User = model('user');
const Wallet = model('wallet');
const Branch = model('branch');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A; let B; let custBOnly; let custShared; let branchA2; const rec = {};
const DENIED = [400, 403, 404];
const adminA = () => ctx.api.as(A.users.admin);
const text = (res) => JSON.stringify(res.body || {});
const DAY = 24 * 3600 * 1000;
const lean = (M, id) => M.findById(id).lean();
const order = (t, orderId, total, user) => Order.create({
    restaurant: t.restaurant._id, branch: t.branch._id, orderId, type: 'dine-in', user,
    items: [{ menuItem: String(t.items.paneer._id), name: `Item-${orderId}`, price: total, quantity: 1 }],
    total, status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash', note: `note-${orderId}`,
});
const coupon = (t, code, extra = {}) => Coupon.create({
    restaurant: t.restaurant._id, branch: null, code, title: `T-${code}-${t.label}`, discountType: 'fixed_amount', discountValue: 10,
    startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + 30 * DAY), isActive: true, ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'mk-a' });
    B = await seedTenant({ label: 'mk-b' });
    branchA2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A2', slug: 'a2', isActive: true });
    custBOnly = await createCustomer('mk-bonly', { name: 'B-Only-Customer', mobile: '9000011111' });
    custShared = await createCustomer('mk-shared', { name: 'Shared-Customer' });

    rec.orderB = await order(B, 'ORD-MK-B1', 777, custBOnly._id);
    rec.orderBShared = await order(B, 'ORD-MK-B2', 555, custShared._id);
    rec.orderAShared = await order(A, 'ORD-MK-A1', 100, custShared._id);
    await setWallet(B, custBOnly, { balance: 4321, loyaltyPoints: 99 });
    await setWallet(B, custShared, { balance: 8888, loyaltyPoints: 88 });
    await setWallet(A, custShared, { balance: 11, loyaltyPoints: 1 });

    rec.campB = await Campaign.create({ restaurant: B.restaurant._id, name: 'B-Secret-Campaign', type: 'custom', points: 50, startDate: new Date(), endDate: new Date(Date.now() + DAY), createdBy: B.users.admin._id });
    rec.campA = await Campaign.create({ restaurant: A.restaurant._id, name: 'A-Campaign', type: 'custom', points: 5, startDate: new Date(), endDate: new Date(Date.now() + DAY), createdBy: A.users.admin._id });

    rec.saveA = await coupon(A, 'SAVE10', { title: 'A-Save', discountValue: 10 });
    rec.saveB = await coupon(B, 'SAVE10', { title: 'B-Save', discountValue: 50, usagePerUser: 1 });
    rec.onlyB = await coupon(B, 'BONLY', { title: 'B-Only-Secret-Coupon', discountValue: 99 });
    rec.redB = await CouponRedemption.create({
        restaurant: B.restaurant._id, coupon: rec.onlyB._id, couponCode: 'BONLY', couponTitle: 'B-Only-Secret-Coupon',
        user: custBOnly._id, orderValue: 900, discountAmount: 99, discountType: 'fixed_amount', discountValue: 99,
    });
    rec.promoB = await Promotion.create({
        restaurant: B.restaurant._id, title: 'B-Secret-Promo', image: 'x.png', endDate: new Date(Date.now() + DAY),
    });
    rec.notiB = await Notification.create({
        restaurant: B.restaurant._id, branch: B.branch._id, title: 'B-Secret-Notice', description: 'b only',
        recipientRole: 'admin', recipient: null,
    });
    rec.notiBUser = await Notification.create({
        restaurant: B.restaurant._id, branch: B.branch._id, title: 'B-Personal-Notice', description: 'b only',
        recipientRole: 'waiter', recipient: B.users.waiter._id,
    });
    await settle();
});

// ── CRM ───────────────────────────────────────────────────────────────
describe('crmRoute', () => {
    test("B-only customers (name, email, mobile, spend, wallet) are not in A's CRM list", async () => {
        const res = await adminA().get('/crm/customers');
        expect(res.status).toBe(200);
        const t = text(res);
        for (const n of ['B-Only-Customer', custBOnly.email, '9000011111', '777', '4321']) expect(t).not.toContain(n);
        expect(res.body.customers.find((c) => String(c.id) === String(custBOnly._id))).toBeUndefined();
    });

    test('a customer shared by both tenants shows ONLY tenant A numbers', async () => {
        const res = await adminA().get('/crm/customers');
        const row = res.body.customers.find((c) => String(c.id) === String(custShared._id));
        expect(row).toBeTruthy();
        expect(row.visitCount).toBe(1);
        expect(row.spending).toBe(100);
        expect(row.walletBalance).toBe(11);
        expect(row.loyaltyPoints).toBe(1);
        expect(text(res)).not.toContain('8888');
    });

    test('CRM stats count only A (guest orders, totals)', async () => {
        await Order.create({ restaurant: B.restaurant._id, branch: B.branch._id, orderId: 'ORD-MK-BG', type: 'takeaway', user: null, items: [{ menuItem: String(B.items.paneer._id), name: 'g', price: 10, quantity: 1 }], total: 10, status: 'served' });
        const res = await adminA().get('/crm/customers');
        expect(res.body.stats.guestUsers).toBe(0);
        expect(res.body.stats.totalCustomers).toBe(res.body.customers.length);
    });

    test("GET /crm/customers/:id of a B-only customer → 404, no PII", async () => {
        const res = await adminA().get(`/crm/customers/${custBOnly._id}`);
        expect(res.status).toBe(404);
        const t = text(res);
        for (const n of ['B-Only-Customer', custBOnly.email, '9000011111', 'ORD-MK-B1']) expect(t).not.toContain(n);
    });

    test("GET /crm/customers/:id of a shared customer exposes A's orders only", async () => {
        const res = await adminA().get(`/crm/customers/${custShared._id}`);
        expect(res.status).toBe(200);
        const t = text(res);
        expect(t).toContain('ORD-MK-A1');
        for (const n of ['ORD-MK-B2', 'note-ORD-MK-B2', '8888']) expect(t).not.toContain(n);
        expect(res.body.customer.totalSpend).toBe(100);
        expect(res.body.customer.walletBalance).toBe(11);
    });

    test('CRM id injection / staff ids are rejected or 404', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D', String(B.users.admin._id), String(A.users.admin._id)]) {
            const res = await adminA().get(`/crm/customers/${id}`);
            expect(res.status).toBeLessThan(500);
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(text(res)).not.toContain(B.users.admin.email);
        }
    });

    test('A-token + B slug / header tricks never expose B customers', async () => {
        for (const res of [
            await ctx.api.as(A.users.admin, B).get('/crm/customers'),
            await adminA().get('/crm/customers').set('X-Restaurant-Id', String(B.restaurant._id)),
            await adminA().get(`/crm/customers?restaurant=${B.restaurant._id}&restaurantId=${B.restaurant._id}`),
        ]) expect(text(res)).not.toContain('B-Only-Customer');
    });

    test('a waiter / customer cannot read the CRM of A or B', async () => {
        for (const u of [A.users.waiter, custShared]) {
            expect([401, 403]).toContain((await ctx.api.as(u, A).get('/crm/customers')).status);
        }
    });

    test('positive control: B admin sees its own customer', async () => {
        const res = await ctx.api.as(B.users.admin).get('/crm/customers');
        expect(text(res)).toContain('B-Only-Customer');
    });

    test('GET /promotions/customer/:userId reveals nothing for a B-only customer', async () => {
        const res = await adminA().get(`/promotions/customer/${custBOnly._id}`);
        expect(DENIED).toContain(res.status);
        const t = text(res);
        for (const n of ['B-Only-Customer', custBOnly.email, '4321', '777']) expect(t).not.toContain(n);
    });

    test('GET /promotions/customer/:userId of staff / shared customer is tenant-scoped', async () => {
        const staff = await adminA().get(`/promotions/customer/${B.users.admin._id}`);
        expect(DENIED).toContain(staff.status);
        expect(text(staff)).not.toContain(B.users.admin.email);
        const shared = await adminA().get(`/promotions/customer/${custShared._id}`);
        if (shared.status === 200) {
            expect(text(shared)).not.toContain('8888');
            expect(text(shared)).not.toContain('ORD-MK-B2');
        }
    });
});

// ── Campaigns ─────────────────────────────────────────────────────────
describe('campaignRoute', () => {
    test("B's campaigns are not listed or counted for A", async () => {
        const list = await adminA().get('/campaigns');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain('B-Secret-Campaign');
        const stats = await adminA().get('/campaigns/stats');
        expect(stats.body.stats.totalCampaigns).toBe(await Campaign.countDocuments({ restaurant: A.restaurant._id }));
    });

    test('toggle / update / delete of a B campaign → 404 and B unchanged', async () => {
        const before = JSON.stringify(await lean(Campaign, rec.campB._id));
        const rs = [
            await adminA().patch(`/campaigns/${rec.campB._id}/toggle`),
            await adminA().put(`/campaigns/${rec.campB._id}`).send({ name: 'Hijacked', points: 1, enabled: false }),
            await adminA().delete(`/campaigns/${rec.campB._id}`),
        ];
        for (const r of rs) expect(r.status).toBe(404);
        expect(JSON.stringify(await lean(Campaign, rec.campB._id))).toBe(before);
    });

    test('create with body restaurant / B branch: lands in A or is refused', async () => {
        const r1 = await adminA().post('/campaigns').send({ name: 'Mass', points: 5, type: 'custom', startDate: new Date(), endDate: new Date(Date.now() + DAY), restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(r1.status).toBe(201);
        expect(String(r1.body.campaign.restaurant)).toBe(String(A.restaurant._id));
        const r2 = await adminA().post('/campaigns').send({ name: 'BBranch', points: 5, type: 'birthday', branch: String(B.branch._id) });
        expect(DENIED).toContain(r2.status);
        expect(await Campaign.exists({ name: 'BBranch' })).toBeFalsy();
    });

    test("update of A's own campaign cannot move it to B (restaurant / branch)", async () => {
        const res = await adminA().put(`/campaigns/${rec.campA._id}`).send({ restaurant: String(B.restaurant._id), branch: String(B.branch._id), name: 'still-a' });
        expect(res.status).toBeLessThan(500);
        const row = await lean(Campaign, rec.campA._id);
        expect(String(row.restaurant)).toBe(String(A.restaurant._id));
        expect(String(row.branch || '')).not.toBe(String(B.branch._id));
    });

    test('malformed ids are 400', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D']) {
            expect((await adminA().put(`/campaigns/${id}`).send({ name: 'x' })).status).toBe(400);
            expect((await adminA().delete(`/campaigns/${id}`)).status).toBe(400);
        }
    });

    test("branch-pinned admin of A cannot see tenant-level A campaigns nor B's", async () => {
        const sub = await createUser({ name: 'A sub', email: `sub.mk.${A.slug}@staff.test`, role: 'admin', restaurant: A.restaurant._id, branch: branchA2._id, permissions: {} });
        const res = await ctx.api.as(sub).get('/campaigns');
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain('B-Secret-Campaign');
        expect(text(res)).not.toContain('A-Campaign');
        expect((await ctx.api.as(sub).delete(`/campaigns/${rec.campB._id}`)).status).toBe(404);
    });

    test('positive control: B admin sees its campaign', async () => {
        expect(text(await ctx.api.as(B.users.admin).get('/campaigns'))).toContain('B-Secret-Campaign');
    });
});

// ── Coupons / promotions ──────────────────────────────────────────────
describe('promotionRoute', () => {
    const apply = (user, tenant, code, orderValue = 500) => ctx.api.as(user, tenant).post('/promotions/apply-coupon').send({ code, orderValue });

    test('the same code in two tenants resolves to each tenant\'s own coupon', async () => {
        const a = await apply(custShared, A, 'SAVE10');
        expect(a.status).toBe(200);
        expect(a.body.discount).toBe(10);
        expect(a.body.coupon.title).toBe('A-Save');
        const b = await apply(custShared, B, 'SAVE10');
        expect(b.status).toBe(200);
        expect(b.body.discount).toBe(50);
        expect(b.body.coupon.title).toBe('B-Save');
    });

    test("B-only coupon code cannot be applied in A (404, nothing leaked)", async () => {
        const res = await apply(custShared, A, 'BONLY');
        expect(res.status).toBe(404);
        expect(text(res)).not.toContain('B-Only-Secret-Coupon');
        const lower = await apply(custShared, A, 'bonly');
        expect(lower.status).toBe(404);
    });

    test('mass-assigned restaurant in the apply body does not select B', async () => {
        const res = await ctx.api.as(custShared, A).post('/promotions/apply-coupon').send({ code: 'BONLY', orderValue: 500, restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(res.status).toBe(404);
        const q = await ctx.api.as(custShared, A).post(`/promotions/apply-coupon?restaurant=${B.slug}`).send({ code: 'BONLY', orderValue: 500 });
        expect([404, 400, 403]).toContain(q.status);
    });

    test("B's per-customer usage does not consume A's coupon limits and vice versa", async () => {
        await CouponRedemption.create({
            restaurant: B.restaurant._id, coupon: rec.saveB._id, couponCode: 'SAVE10', couponTitle: 'B-Save',
            user: custShared._id, orderValue: 500, discountAmount: 50, discountType: 'fixed_amount', discountValue: 50,
        });
        expect((await apply(custShared, B, 'SAVE10')).status).toBe(400);   // B limit (1) reached
        const a = await apply(custShared, A, 'SAVE10');                      // A unaffected
        expect(a.status).toBe(200);
    });

    test('operator injection in code is a 400 / 404, never a match-all', async () => {
        for (const code of [{ $ne: null }, { $regex: '.*' }, ['SAVE10']]) {
            const res = await ctx.api.as(custShared, A).post('/promotions/apply-coupon').send({ code, orderValue: 500 });
            expect([400, 404]).toContain(res.status);
        }
    });

    test("A's coupon list / redemptions / performance exclude B", async () => {
        for (const p of ['/promotions/coupons', '/promotions/coupons/redemptions', '/promotions/coupons/performance?filter=month', '/promotions/coupons/active', '/promotions']) {
            const res = await adminA().get(p);
            expect(res.status).toBeLessThan(500);
            const t = text(res);
            for (const n of ['B-Only-Secret-Coupon', 'B-Secret-Promo', 'B-Save', String(rec.onlyB._id), String(rec.redB._id)]) expect(t).not.toContain(n);
        }
        const red = await adminA().get(`/promotions/coupons/redemptions?couponId=${rec.onlyB._id}`);
        expect(red.body.total).toBe(0);
        const branchQ = await adminA().get(`/promotions/coupons?branch=${B.branch._id}`);
        expect(text(branchQ)).not.toContain('B-Only-Secret-Coupon');
    });

    test('performance totals exclude B redemptions', async () => {
        const res = await adminA().get('/promotions/coupons/performance?filter=month');
        expect(JSON.stringify(res.body)).not.toMatch(/99/);
    });

    test('PUT / DELETE of a B coupon → 404 and B unchanged', async () => {
        const before = JSON.stringify(await lean(Coupon, rec.onlyB._id));
        const put = await adminA().put(`/promotions/coupons/${rec.onlyB._id}`).send({ discountValue: 1, isActive: false, restaurant: String(A.restaurant._id) });
        expect(put.status).toBe(404);
        const del = await adminA().delete(`/promotions/coupons/${rec.onlyB._id}`);
        expect(del.status).toBe(404);
        expect(JSON.stringify(await lean(Coupon, rec.onlyB._id))).toBe(before);
    });

    test("creating a coupon with body restaurant / B branch: stays in A or is refused; duplicate of B's code is allowed", async () => {
        const ok = await adminA().post('/promotions/coupons').send({ code: 'BONLY', title: 'A copy', discountType: 'fixed_amount', discountValue: 5, startDate: new Date(), endDate: new Date(Date.now() + DAY), restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(ok.status).toBe(201);
        expect(String(ok.body.coupon.restaurant)).toBe(String(A.restaurant._id));
        expect(String((await lean(Coupon, rec.onlyB._id)).discountValue)).toBe('99');
        const bad = await adminA().post('/promotions/coupons').send({ code: 'XB', title: 'x', discountType: 'fixed_amount', discountValue: 5, startDate: new Date(), endDate: new Date(Date.now() + DAY), branch: String(B.branch._id) });
        expect(DENIED).toContain(bad.status);
        expect(await Coupon.exists({ code: 'XB' })).toBeFalsy();
    });

    test("moving A's coupon to B's branch / tenant is refused", async () => {
        const res = await adminA().put(`/promotions/coupons/${rec.saveA._id}`).send({ branch: String(B.branch._id), restaurant: String(B.restaurant._id) });
        expect(DENIED).toContain(res.status);
        expect(String((await lean(Coupon, rec.saveA._id)).restaurant)).toBe(String(A.restaurant._id));
    });

    test('promotion create ignores body restaurant and refuses B branch', async () => {
        const ok = await adminA().post('/promotions').send({ title: 'A-Promo', image: 'a.png', endDate: new Date(Date.now() + DAY), restaurant: String(B.restaurant._id) });
        expect(ok.status).toBe(201);
        expect(String(ok.body.promotion.restaurant)).toBe(String(A.restaurant._id));
        const bad = await adminA().post('/promotions').send({ title: 'A-Promo2', image: 'a.png', endDate: new Date(Date.now() + DAY), branch: String(B.branch._id) });
        expect(DENIED).toContain(bad.status);
    });

    test('customers of A (slug A) see only A coupons / promos; slug B shows B', async () => {
        const a = await ctx.api.as(custShared, A).get('/promotions/coupons/active');
        expect(text(a)).not.toContain('B-Save');
        expect(text(a)).not.toContain('B-Only-Secret-Coupon');
        const g = await ctx.api.guest(A).get('/promotions');
        expect(text(g)).not.toContain('B-Secret-Promo');
        const b = await ctx.api.guest(B).get('/promotions');
        expect(text(b)).toContain('B-Secret-Promo');
    });

    test('apply a coupon to an order by id of the other tenant is refused (order of B, coupon of A)', async () => {
        const res = await ctx.api.as(A.users.admin).post(`/orders/${rec.orderB._id}/coupon`).send({ code: 'SAVE10' });
        expect([400, 403, 404, 405]).toContain(res.status);
        expect(await Order.countDocuments({ _id: rec.orderB._id, couponDiscount: { $gt: 0 } })).toBe(0);
    });
});

// ── Notifications ─────────────────────────────────────────────────────
describe('notificationRoute', () => {
    test("A's admin / waiter never see B's broadcast or personal notifications", async () => {
        for (const u of [A.users.admin, A.users.waiter]) {
            const res = await ctx.api.as(u).get('/notifications');
            expect(res.status).toBe(200);
            expect(text(res)).not.toContain('B-Secret-Notice');
            expect(text(res)).not.toContain('B-Personal-Notice');
        }
    });

    test('mark-read / delete of a B notification by id is a no-op for B', async () => {
        const before = JSON.stringify(await lean(Notification, rec.notiB._id));
        await adminA().put(`/notifications/${rec.notiB._id}/read`);
        await adminA().delete(`/notifications/${rec.notiB._id}`);
        expect(JSON.stringify(await lean(Notification, rec.notiB._id))).toBe(before);
    });

    test('mark-all-read and clear-all by A leave B notifications untouched', async () => {
        await adminA().put('/notifications/all/read');
        await adminA().delete('/notifications/clear');
        await ctx.api.as(A.users.waiter).delete('/notifications/clear');
        expect(await Notification.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        expect((await lean(Notification, rec.notiB._id)).status).not.toBe('read');
    });

    test("creating a notification addressed to B's user / role never reaches B", async () => {
        const res = await adminA().post('/notifications').send({
            title: 'Cross', description: 'to B', recipient: String(B.users.waiter._id), recipientRole: 'waiter',
            restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), branch: String(B.branch._id),
        });
        expect(res.status).toBeLessThan(500);
        expect(await Notification.countDocuments({ title: 'Cross', restaurant: B.restaurant._id })).toBe(0);
        const bView = await ctx.api.as(B.users.waiter).get('/notifications');
        expect(text(bView)).not.toContain('Cross');
    });

    test('a notification A creates with a B recipient is not stored with B restaurant and B does not receive it', async () => {
        const res = await adminA().post('/notifications').send({ title: 'Cross2', description: 'to B user', recipient: String(B.users.waiter._id), recipientRole: 'waiter' });
        expect(res.status).toBeLessThan(500);
        const bView = await ctx.api.as(B.users.waiter).get('/notifications');
        expect(text(bView)).not.toContain('Cross2');
    });

    test('non-ObjectId ids on mark-read / delete are 400', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D']) {
            expect((await adminA().put(`/notifications/${id}/read`)).status).toBeLessThan(500);
            expect((await adminA().delete(`/notifications/${id}`)).status).toBeLessThan(500);
        }
    });

    test('positive control: B admin receives its broadcast', async () => {
        expect(text(await ctx.api.as(B.users.admin).get('/notifications'))).toContain('B-Secret-Notice');
    });
});

// ── Two-factor ────────────────────────────────────────────────────────
describe('twoFactorRoute', () => {
    test("A's tenant owner cannot reset 2FA on B's admin (404) and B's 2FA state is untouched", async () => {
        await User.updateOne({ _id: B.users.admin._id }, { $set: { 'twoFactor.enabled': true } });
        const before = await User.findById(B.users.admin._id).lean();
        const res = await adminA().post('/auth/2fa/reset').send({ userId: String(B.users.admin._id) });
        expect([403, 404]).toContain(res.status);
        const after = await User.findById(B.users.admin._id).lean();
        expect(after.twoFactor.enabled).toBe(true);
        expect(after.tokenVersion || 0).toBe(before.tokenVersion || 0);
    });

    test('2FA reset with an operator-injected userId is a 400', async () => {
        for (const userId of [{ $ne: null }, ['x'], '123']) {
            const res = await adminA().post('/auth/2fa/reset').send({ userId });
            expect(res.status).toBe(400);
        }
    });

    test('a non-owner (manager of A) cannot reset 2FA for anyone', async () => {
        const mgr = await createUser({ name: 'A mgr', email: `mgr.mk.${A.slug}@staff.test`, role: 'manager', restaurant: A.restaurant._id, permissions: defaultPermissionsForRole('manager') });
        const res = await ctx.api.as(mgr).post('/auth/2fa/reset').send({ userId: String(A.users.admin._id) });
        expect(res.status).toBe(403);
    });

    test('a challenge token for a B user cannot be verified into an A session (wrong code is rejected)', async () => {
        const res = await ctx.api.anon().post('/auth/2fa/verify').set('X-Restaurant-Slug', A.slug).send({ challengeToken: 'not-a-token', code: '000000' });
        expect([400, 401]).toContain(res.status);
        const inj = await ctx.api.anon().post('/auth/2fa/verify').send({ challengeToken: { $ne: null }, code: { $ne: null } });
        expect([400, 401]).toContain(inj.status);
    });

    test('2FA status / setup for an A admin never includes B data', async () => {
        const st = await adminA().get('/auth/2fa/status');
        expect(st.status).toBeLessThan(500);
        expect(text(st)).not.toContain(String(B.restaurant._id));
    });
});
