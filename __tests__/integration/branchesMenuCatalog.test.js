/**
 * Branches + menu catalogue (checklist 10.4 / 10.8):
 *   - POST /branches          — validation, maxBranches, slug rules, Branch Admin
 *   - PUT/DELETE /branches    — Main protections, disable-check, reactivate
 *   - syncFromMain            — menu branchPrices (finalPrice), coupons
 *                               (usageCount reset), categories
 *   - PUT /menu/:id/branch-prices, POST /branches/:id/sync-menu
 *   - /menu, /categories, /combos, /areas — CRUD validation, allowlists,
 *     finalPrice recompute, inactivation, availability windows, scope
 *
 * Cross-tenant isolation is covered by tenantIsolationSweep*.test.js.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Category = require(path.join(BACKEND, 'models/category'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Combo = require(path.join(BACKEND, 'models/combo'));
const Area = require(path.join(BACKEND, 'models/area'));
const Order = require(path.join(BACKEND, 'models/order'));
const User = require(path.join(BACKEND, 'models/user'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let X; // a second tenant, only used as a source of foreign ids

const rid = () => new mongoose.Types.ObjectId().toString().slice(-6);
const owner = () => ctx.api.as(A.users.admin);
const setLimits = (t, limits) => Restaurant.updateOne({ _id: t.restaurant._id }, {
    $set: Object.fromEntries(Object.entries(limits).map(([k, v]) => [`subscription.limits.${k}`, v])),
});
/** Replace the 'FOREIGN' placeholder (test.each tables are built before beforeAll). */
const foreign = (body) => JSON.parse(JSON.stringify(body).replace(/"FOREIGN"/g, `"${X.branch._id}"`));
const newBranchBody = (extra = {}) => ({
    name: `Branch ${rid()}`, managerName: 'Branch Boss', managerEmail: `boss.${rid()}@branch.test`, ...extra,
});
/** A branch + a pinned Branch Admin, inserted directly. */
async function mkBranchWithAdmin(t, name = `B-${rid()}`) {
    const branch = await Branch.create({ restaurant: t.restaurant._id, name, slug: `b-${rid()}`, isActive: true });
    const admin = await createUser({
        name: `Sub ${name}`, email: `sub.${rid()}@staff.test`, role: 'admin', restaurant: t.restaurant._id,
        branch: branch._id, permissions: defaultPermissionsForRole('admin'),
    });
    return { branch, admin };
}
const mkOrder = (t, fields) => Order.create({
    restaurant: t.restaurant._id, orderId: `ORD-BMC-${rid()}${rid()}`, type: 'takeaway', total: 100,
    items: [{ name: 'X', price: 100, quantity: 1 }], ...fields,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'bmc' });
    X = await seedTenant({ label: 'bmc-x' });
    await setLimits(A, { maxBranches: 50, maxStaff: 500 });
});

// ═════════════════════════════════════════════════════════════════════
describe('POST /branches', () => {
    test.each([
        ['missing name', { name: '' }, /Branch name is required/],
        ['name > 80 chars', { name: 'x'.repeat(81) }, /cannot exceed 80/],
        ['missing Branch Admin name', { managerName: '' }, /Branch Admin name is required/],
        ['missing Branch Admin email', { managerEmail: '' }, /Branch Admin email is required/],
        ['bad Branch Admin email', { managerEmail: 'not-an-email' }, /Invalid email format/],
        ['bad Branch Admin phone', { managerPhone: '12345' }, /10-digit Indian mobile/],
        ['latitude out of range', { latitude: 91 }, /latitude must be between/],
    ])('400 on %s', async (_l, override, msg) => {
        const res = await owner().post('/branches').send(newBranchBody(override));
        expect(res.status).toBe(400);
        expect(res.body.message || JSON.stringify(res.body)).toMatch(msg);
    });

    test('creates the branch + a pinned Branch Admin with a temp password; slug from name', async () => {
        const res = await owner().post('/branches').send(newBranchBody({ name: '  Koregaon Park!! ', managerPhone: '9876543210' }));
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ name: 'Koregaon Park!!', slug: 'koregaon-park' });
        expect(res.body.manager.tempPassword).toEqual(expect.any(String));
        expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
        const sub = await User.findById(res.body.manager.user._id).lean();
        expect(sub).toMatchObject({ role: 'admin', mustChangePassword: true, isTenantOwner: false });
        expect(String(sub.branch)).toBe(String(res.body.data._id));
        expect(res.body.sync).toMatchObject({ menu: null, coupons: null });
    });

    test('slug rules: "main" reserved, duplicate gets a suffix, symbols-only name falls back', async () => {
        expect((await owner().post('/branches').send(newBranchBody({ slug: 'Main' }))).body.code).toBe('SLUG_RESERVED');

        const first = await owner().post('/branches').send(newBranchBody({ name: 'Viman Nagar' }));
        const second = await owner().post('/branches').send(newBranchBody({ name: 'Viman Nagar' }));
        expect(first.body.data.slug).toBe('viman-nagar');
        expect(second.body.data.slug).toMatch(/^viman-nagar-[a-z0-9]{1,4}$/);

        const sym = await owner().post('/branches').send(newBranchBody({ name: '!!! ???' }));
        expect(sym.status).toBe(201);
        expect(sym.body.data.slug).toMatch(/^branch-[a-z0-9]+$/);
    });

    test('maxBranches is enforced (unset limit → 1) and nothing is created', async () => {
        const T = await seedTenant({ label: 'bmc-lim' });
        const before = await Branch.countDocuments({ restaurant: T.restaurant._id });
        const res = await ctx.api.as(T.users.admin).post('/branches').send(newBranchBody());
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'BRANCH_LIMIT_REACHED', current: 1, limit: 1 });
        expect(await Branch.countDocuments({ restaurant: T.restaurant._id })).toBe(before);
    });

    test('Branch Admin email already used → 400/409 and the branch is not left behind', async () => {
        const name = `Dup ${rid()}`;
        const res = await owner().post('/branches').send(newBranchBody({ name, managerEmail: A.users.waiter.email }));
        expect([400, 409]).toContain(res.status);
        expect(await Branch.exists({ restaurant: A.restaurant._id, name })).toBeNull();
    });

    test.each([
        ['Branch Admin (pinned)', async () => (await mkBranchWithAdmin(A)).admin, 403],
        ['waiter', async () => A.users.waiter, 403],
    ])('%s cannot create branches → %i', async (_l, who, code) => {
        const u = await who();
        expect((await ctx.api.as(u).post('/branches').send(newBranchBody())).status).toBe(code);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('Main branch protections + update', () => {
    test.each([
        ['rename', { name: 'Something Else' }, 'MAIN_NAME_LOCKED'],
        ['change slug', { slug: 'downtown' }, 'SLUG_LOCKED'],
    ])('Main: cannot %s', async (_l, body, code) => {
        const res = await owner().put(`/branches/${A.branch._id}`).send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
    });

    test('Main: same name is stripped and the rest of the update applies', async () => {
        const res = await owner().put(`/branches/${A.branch._id}`).send({ name: 'Main', city: 'Pune', contactEmail: ' HI@Main.Test ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ name: 'Main', city: 'Pune', contactEmail: 'hi@main.test' });
    });

    test.each([
        ['soft disable', (id) => owner().delete(`/branches/${id}`)],
        ['hard delete', (id) => owner().delete(`/branches/${id}/permanent`)],
    ])('Main: cannot %s', async (_l, call) => {
        const res = await call(A.branch._id);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MAIN_BRANCH_PROTECTED');
        expect((await Branch.findById(A.branch._id).lean()).isActive).toBe(true);
    });

    test('sub-branch: cannot take slug "main", cannot flip isActive via PUT, duplicate slug → 409', async () => {
        const { branch } = await mkBranchWithAdmin(A);
        const other = await Branch.create({ restaurant: A.restaurant._id, name: 'Other', slug: `taken-${rid()}` });
        expect((await owner().put(`/branches/${branch._id}`).send({ slug: 'main' })).body.code).toBe('SLUG_RESERVED');
        expect((await owner().put(`/branches/${branch._id}`).send({ isActive: false })).status).toBe(400);
        const dup = await owner().put(`/branches/${branch._id}`).send({ slug: other.slug });
        expect(dup.status).toBe(409);
        expect(dup.body.code).toBe('SLUG_TAKEN');
        // Allowlist: restaurant / createdBy are ignored.
        const r = await owner().put(`/branches/${branch._id}`).send({ restaurant: String(X.restaurant._id), city: 'Nashik' });
        expect(r.status).toBe(200);
        expect(String((await Branch.findById(branch._id).lean()).restaurant)).toBe(String(A.restaurant._id));
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('disable / reactivate', () => {
    test('disable-check counts active orders (blocker), staff + tables (warnings)', async () => {
        const { branch } = await mkBranchWithAdmin(A);
        const area = await Area.create({ restaurant: A.restaurant._id, branch: branch._id, name: `Z-${rid()}` });
        const { createTable } = require('./helpers/seed');
        await createTable(A, { branch: branch._id, area: area._id });
        for (const status of ['new', 'preparing', 'ready', 'served', 'cancelled']) {
            await mkOrder(A, { branch: branch._id, status });
        }
        const res = await owner().get(`/branches/${branch._id}/disable-check`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true, canDisable: false,
            blockers: { activeOrders: 3 },
            warnings: { assignedStaff: 1, assignedTables: 1 },
        });
        // Hard delete is blocked by the same active orders.
        const hard = await owner().delete(`/branches/${branch._id}/permanent`);
        expect(hard.status).toBe(400);
        expect(hard.body).toMatchObject({ code: 'ACTIVE_ORDERS', activeOrders: 3 });
    });

    // Regression (fixed 2026-10): deleteBranch refuses (400 ACTIVE_ORDERS) while the branch has new/preparing/ready orders.
    test('soft disable is refused while the branch has active orders', async () => {
        const { branch } = await mkBranchWithAdmin(A);
        await mkOrder(A, { branch: branch._id, status: 'preparing' });
        const res = await owner().delete(`/branches/${branch._id}`);
        expect(res.status).toBe(400);
        expect((await Branch.findById(branch._id).lean()).isActive).toBe(true);
    });

    // Regression (fixed 2026-10): deleteBranch keeps the Branch Admin pinned, deactivates it and bumps tokenVersion instead of nulling its branch.
    test('disabling a branch does not turn its Branch Admin into a tenant-wide admin', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        const before = await ctx.api.as(admin).get('/branches');
        expect(before.status).toBe(200);
        expect(before.body.data.map((b) => String(b._id))).toEqual([String(branch._id)]);

        const res = await owner().delete(`/branches/${branch._id}`);
        expect(res.status).toBe(200);
        expect(res.body.staffUnassigned).toBe(1);

        const after = await ctx.api.as(admin).get('/branches');
        // Expected: locked out (401/403) or still scoped to nothing.
        const visible = after.status === 200 ? after.body.data.map((b) => String(b._id)) : [];
        expect(visible).not.toContain(String(A.branch._id));
    });

    test('reactivate enforces maxBranches', async () => {
        const T = await seedTenant({ label: 'bmc-re' });
        const off = await Branch.create({ restaurant: T.restaurant._id, name: 'Off', slug: 'off', isActive: false });
        const r1 = await ctx.api.as(T.users.admin).patch(`/branches/${off._id}/reactivate`);
        expect(r1.status).toBe(403);
        expect(r1.body.code).toBe('BRANCH_LIMIT_REACHED');
        await setLimits(T, { maxBranches: 2 });
        const r2 = await ctx.api.as(T.users.admin).patch(`/branches/${off._id}/reactivate`);
        expect(r2.status).toBe(200);
        expect(r2.body.data.isActive).toBe(true);
    });

    test('hard delete cascades branch-scoped config and strips branchPrices', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        await Area.create({ restaurant: A.restaurant._id, branch: branch._id, name: `HD-${rid()}` });
        await MenuItem.updateOne({ _id: A.items.naan._id }, { $push: { branchPrices: { branch: branch._id, basePrice: 45 } } });
        const res = await owner().delete(`/branches/${branch._id}/permanent`);
        expect(res.status).toBe(200);
        expect(res.body.cleanup).toMatchObject({ branchAdminDeleted: 1, areas: 1, menuPriceEntries: 1 });
        expect(await Branch.exists({ _id: branch._id })).toBeNull();
        expect(await User.exists({ _id: admin._id })).toBeNull();
        const naan = await MenuItem.findById(A.items.naan._id).lean();
        expect(naan.branchPrices.some((bp) => String(bp.branch) === String(branch._id))).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('Copy from Main (syncFromMain)', () => {
    let T;
    beforeAll(async () => {
        T = await seedTenant({ label: 'bmc-copy' });
        await setLimits(T, { maxBranches: 20, maxStaff: 200 });
        await Coupon.create({
            restaurant: T.restaurant._id, branch: T.branch._id, code: 'MAIN10', title: 'Main 10',
            discountValue: 10, endDate: new Date(Date.now() + 7 * 86400000), usageCount: 42, usageLimit: 100,
        });
    });

    test('menu: every active Main/shared item gets a branchPrices entry with the right finalPrice; coupons copied with usageCount 0', async () => {
        await MenuItem.create({
            restaurant: T.restaurant._id, category: T.category._id, name: 'Draft Dish', description: 'd',
            basePrice: 99, status: 'draft',
        });
        const res = await ctx.api.as(T.users.admin).post('/branches').send(newBranchBody({
            syncFromMain: { menu: true, coupons: true },
        }));
        expect(res.status).toBe(201);
        expect(res.body.sync).toMatchObject({ menu: 3, coupons: 1 });
        const bid = res.body.data._id;

        const items = await MenuItem.find({ restaurant: T.restaurant._id, 'branchPrices.branch': bid }).lean();
        const prices = Object.fromEntries(items.map((i) => {
            const bp = i.branchPrices.find((p) => String(p.branch) === bid);
            return [i.name, [bp.basePrice, bp.offerPercentage, bp.finalPrice]];
        }));
        expect(prices).toEqual({
            'Paneer Tikka': [200, 0, 200],
            'Veg Thali': [150, 10, 135],
            'Garlic Naan': [40, 0, 40],
        });

        const copy = await Coupon.findOne({ restaurant: T.restaurant._id, branch: bid }).lean();
        expect(copy).toMatchObject({ code: 'MAIN10', usageCount: 0, usageLimit: 100, discountValue: 10 });

        // Re-running the sync is idempotent.
        const again = await ctx.api.as(T.users.admin).post(`/branches/${bid}/sync-menu`).send({});
        expect(again.body).toMatchObject({ newlySynced: 0, pricesReset: 0 });
    });

    test('sync-menu resetPrices re-applies the current default price (finalPrice recomputed)', async () => {
        const res = await ctx.api.as(T.users.admin).post('/branches').send(newBranchBody({ syncFromMain: { menu: true } }));
        const bid = res.body.data._id;
        await MenuItem.updateOne(
            { _id: T.items.paneer._id, 'branchPrices.branch': bid },
            { $set: { 'branchPrices.$.basePrice': 999, 'branchPrices.$.finalPrice': 999 } },
        );
        await MenuItem.updateOne({ _id: T.items.paneer._id }, { $set: { offerPercentage: 25 } });
        const r = await ctx.api.as(T.users.admin).post(`/branches/${bid}/sync-menu`).send({ resetPrices: true });
        expect(r.status).toBe(200);
        expect(r.body.pricesReset).toBeGreaterThanOrEqual(1);
        const p = (await MenuItem.findById(T.items.paneer._id).lean()).branchPrices.find((x) => String(x.branch) === bid);
        expect([p.basePrice, p.offerPercentage, p.finalPrice]).toEqual([200, 25, 150]);
        await MenuItem.updateOne({ _id: T.items.paneer._id }, { $set: { offerPercentage: 0 } });
    });

    test('sync-menu: bad resetPrices type → 400; inactive branch → 404', async () => {
        const off = await Branch.create({ restaurant: T.restaurant._id, name: 'Off', slug: `off-${rid()}`, isActive: false });
        expect((await ctx.api.as(T.users.admin).post(`/branches/${off._id}/sync-menu`).send({ resetPrices: 'yes' })).status).toBe(400);
        expect((await ctx.api.as(T.users.admin).post(`/branches/${off._id}/sync-menu`).send({})).status).toBe(404);
    });

    // Regression (fixed 2026-10): getAllMenuItems maps a pinned viewer's shared items onto the branch's same-named copied categories (and aliases ?category=).
    test('after Copy-from-Main (categories + menu) the branch\'s categories contain its items', async () => {
        const res = await ctx.api.as(T.users.admin).post('/branches').send(newBranchBody({
            syncFromMain: { categories: true, menu: true },
        }));
        expect(res.status).toBe(201);
        expect(res.body.sync.categories).toBe(1);
        const bid = res.body.data._id;
        const sub = await User.findById(res.body.manager.user._id);
        sub.token = require(path.join(BACKEND, 'middlewares/authMiddleware')).signAccessToken(sub);
        await User.updateOne({ _id: sub._id }, { $set: { mustChangePassword: false } });

        const cats = (await ctx.api.as(sub).get('/categories')).body.data;
        expect(cats.map((c) => c.name)).toEqual([T.category.name]);
        const items = (await ctx.api.as(sub).get('/menu?status=All Status&limit=50')).body;
        const list = items.data || items.menuItems || items.items || [];
        expect(list.length).toBeGreaterThanOrEqual(3);
        const catIds = new Set(cats.map((c) => String(c._id)));
        const orphaned = list.filter((i) => !catIds.has(String(i.category?._id || i.category)));
        expect(orphaned.map((i) => i.name)).toEqual([]);
        expect(String(bid)).toBeTruthy();
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('PUT /menu/:id/branch-prices', () => {
    test('owner sets overrides; finalPrice computed; foreign / inactive / malformed entries skipped', async () => {
        const { branch } = await mkBranchWithAdmin(A);
        const off = await Branch.create({ restaurant: A.restaurant._id, name: 'Off', slug: `off-${rid()}`, isActive: false });
        const res = await owner().put(`/menu/${A.items.paneer._id}/branch-prices`).send({
            branchPrices: [
                { branch: String(branch._id), basePrice: 240, offerPercentage: 12.5 },
                { branch: String(X.branch._id), basePrice: 1 },        // other tenant
                { branch: String(off._id), basePrice: 1 },             // inactive
                { branch: String(branch._id), basePrice: '300' },      // not a number
                { branch: 'nope', basePrice: 1 },
                { branch: String(A.branch._id), basePrice: 180, offerPercentage: 150 }, // clamped to 100
            ],
        });
        expect(res.status).toBe(200);
        const byBranch = Object.fromEntries(res.body.data.branchPrices.map((bp) => [String(bp.branch._id || bp.branch), bp]));
        expect(Object.keys(byBranch).sort()).toEqual([String(A.branch._id), String(branch._id)].sort());
        expect(byBranch[String(branch._id)]).toMatchObject({ basePrice: 240, offerPercentage: 12.5, finalPrice: 210 });
        expect(byBranch[String(A.branch._id)]).toMatchObject({ basePrice: 180, offerPercentage: 100, finalPrice: 0 });
        await owner().put(`/menu/${A.items.paneer._id}/branch-prices`).send({ branchPrices: [] });
    });

    test('Branch Admin cannot set branch prices (owner only); non-array → 400', async () => {
        const { admin } = await mkBranchWithAdmin(A);
        expect((await ctx.api.as(admin).put(`/menu/${A.items.paneer._id}/branch-prices`).send({ branchPrices: [] })).status).toBe(403);
        expect((await owner().put(`/menu/${A.items.paneer._id}/branch-prices`).send({ branchPrices: 'x' })).status).toBe(400);
    });

    // Regression (fixed 2026-10): the menuItem pre-save hook recomputes a ₹0
    // branch override to finalPrice 0 instead of skipping it.
    test('a ₹0 branch override stores finalPrice 0', async () => {
        const res = await owner().put(`/menu/${A.items.naan._id}/branch-prices`).send({
            branchPrices: [{ branch: String(A.branch._id), basePrice: 0 }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.branchPrices[0].finalPrice).toBe(0);
        await owner().put(`/menu/${A.items.naan._id}/branch-prices`).send({ branchPrices: [] });
    });

    // Regression (fixed 2026-10): setBranchPrices rejects two valid overrides for the same branch (400 DUPLICATE_BRANCH_PRICE).
    test('two overrides for the same branch are rejected or collapsed to one', async () => {
        const res = await owner().put(`/menu/${A.items.naan._id}/branch-prices`).send({
            branchPrices: [
                { branch: String(A.branch._id), basePrice: 50 },
                { branch: String(A.branch._id), basePrice: 60 },
            ],
        });
        const stored = (await MenuItem.findById(A.items.naan._id).lean()).branchPrices
            .filter((bp) => String(bp.branch) === String(A.branch._id));
        await owner().put(`/menu/${A.items.naan._id}/branch-prices`).send({ branchPrices: [] });
        expect(res.status === 400 || stored.length === 1).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('menu item CRUD', () => {
    const create = (body) => owner().post('/menu').send({
        name: `Dish ${rid()}`, description: 'tasty', category: String(A.category._id), basePrice: 100, ...body,
    });

    test('allowlist: finalPrice / orderCount / restaurant / branchPrices from the body are ignored', async () => {
        const res = await create({
            basePrice: 300, offerPercentage: 20, finalPrice: 1, orderCount: 9999,
            restaurant: String(X.restaurant._id), branchPrices: [{ branch: String(A.branch._id), basePrice: 1 }],
        });
        expect(res.status).toBe(201);
        const got = await MenuItem.findById(res.body.data._id).lean();
        expect(got).toMatchObject({ basePrice: 300, offerPercentage: 20, finalPrice: 240, orderCount: 0 });
        expect(String(got.restaurant)).toBe(String(A.restaurant._id));
        expect(got.branchPrices).toEqual([]);
    });

    test.each([
        ['negative price', { basePrice: -1 }],
        ['offer > 100', { offerPercentage: 101 }],
        ['bad day', { availableDays: ['Funday'] }],
        ['bad vegType', { vegType: 'vegan-ish' }],
        ['bad prepStation', { prepStation: 'oven' }],
        ['bad status', { status: 'deleted' }],
        ['bad branch id', { branch: 'xyz' }],
        ['foreign branch', { branch: 'FOREIGN' }],
        ['negative size price', { sizes: [{ name: 'L', price: -5 }] }],
    ])('400 on %s', async (_l, body) => {
        expect((await create(foreign(body))).status).toBe(400);
    });

    test('edit recomputes finalPrice from stored + new values (pre-save bypass handled)', async () => {
        const id = (await create({ basePrice: 200, offerPercentage: 0 })).body.data._id;
        let r = await owner().put(`/menu/${id}`).send({ offerPercentage: 15 });
        expect(r.body.data.finalPrice).toBe(170);
        r = await owner().put(`/menu/${id}`).send({ basePrice: 400 });
        expect(r.body.data.finalPrice).toBe(340);
        r = await owner().put(`/menu/${id}`).send({ basePrice: 0 });
        expect(r.body.data.finalPrice).toBe(0);
        r = await owner().put(`/menu/${id}`).send({ finalPrice: 1, orderCount: 5 });
        expect(r.body.data).toMatchObject({ finalPrice: 0, orderCount: 0 });
    });

    test('inactivation: 24h / 1w / custom set inactivationUntil; permanent → null; reactivation clears', async () => {
        const id = (await create({})).body.data._id;
        const archive = (extra) => owner().put(`/menu/${id}`).send({ status: 'archived', inactivationReason: 'Out of paneer', ...extra });

        let t0 = Date.now();
        let r = await archive({ inactivationDuration: '24h' });
        let until = new Date(r.body.data.inactivationUntil).getTime();
        expect(Math.abs(until - (t0 + 86400000))).toBeLessThan(10000);
        expect(r.body.data.inactivationReason).toBe('Out of paneer');

        t0 = Date.now();
        r = await archive({ inactivationDuration: '1w' });
        until = new Date(r.body.data.inactivationUntil).getTime();
        expect(Math.abs(until - (t0 + 7 * 86400000))).toBeLessThan(10000);

        r = await archive({ inactivationDuration: 'custom', inactivationDateRange: { start: '2030-01-01', end: '2030-01-05' } });
        const u = new Date(r.body.data.inactivationUntil);
        expect([u.getFullYear(), u.getMonth(), u.getDate(), u.getHours(), u.getMinutes()]).toEqual([2030, 0, 5, 23, 59]);

        r = await archive({ inactivationDuration: 'permanent' });
        expect(r.body.data.inactivationUntil).toBeNull();

        r = await owner().put(`/menu/${id}`).send({ status: 'active' });
        expect(r.body.data).toMatchObject({ inactivationUntil: null, inactivationReason: '' });

        expect((await archive({ inactivationDuration: 'forever' })).status).toBe(400);
    });

    test('archiving an item archives combos that bundle it; deleting does too', async () => {
        const id = (await create({})).body.data._id;
        const combo = await Combo.create({
            restaurant: A.restaurant._id, name: `Combo ${rid()}`, description: 'c', price: 150,
            categories: [{ name: 'Main', items: [{ menuItemId: id, name: 'Dish', price: 100 }] }],
        });
        const r = await owner().put(`/menu/${id}`).send({ status: 'archived', inactivationDuration: 'permanent' });
        expect(r.body.disabledCombos.map((c) => c.name)).toEqual([combo.name]);
        expect((await Combo.findById(combo._id).lean()).status).toBe('archived');
    });

    test('availability window: customers do not see out-of-window items, staff do', async () => {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const notToday = days.filter((d) => d !== days[new Date().getDay()]);
        const hidden = (await create({ name: `Hidden ${rid()}`, availableDays: notToday })).body.data;
        const shown = (await create({ name: `Shown ${rid()}`, availableDays: [days[new Date().getDay()]] })).body.data;

        const pick = (body) => (body.data || []).map((i) => i.name);
        const customer = pick((await ctx.api.guest(A).get('/menu?limit=100')).body);
        expect(customer).toContain(shown.name);
        expect(customer).not.toContain(hidden.name);
        const staff = pick((await owner().get('/menu?limit=100')).body);
        expect(staff).toEqual(expect.arrayContaining([shown.name, hidden.name]));
        const search = (await ctx.api.guest(A).get(`/menu/search?q=${encodeURIComponent(hidden.name)}`)).body.results || [];
        expect(search.map((i) => i.name)).not.toContain(hidden.name);
    });

    test('Branch Admin cannot edit or delete a shared (tenant-level) item', async () => {
        const { admin } = await mkBranchWithAdmin(A);
        expect((await ctx.api.as(admin).put(`/menu/${A.items.paneer._id}`).send({ basePrice: 1 })).status).toBe(404);
        expect((await ctx.api.as(admin).delete(`/menu/${A.items.paneer._id}`)).status).toBe(404);
        expect((await MenuItem.findById(A.items.paneer._id).lean()).basePrice).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('categories', () => {
    test('delete with items → 409 with count; ?force=true deletes the items too', async () => {
        const cat = await Category.create({ restaurant: A.restaurant._id, name: `Del ${rid()}` });
        await MenuItem.create([1, 2].map((n) => ({
            restaurant: A.restaurant._id, category: cat._id, name: `C${n} ${rid()}`, description: 'd', basePrice: 10,
        })));
        const r1 = await owner().delete(`/categories/${cat._id}`);
        expect(r1.status).toBe(409);
        expect(r1.body.itemCount).toBe(2);
        const r2 = await owner().delete(`/categories/${cat._id}?force=true`);
        expect(r2.status).toBe(200);
        expect(r2.body.message).toBe('Category and 2 items deleted');
        expect(await MenuItem.countDocuments({ category: cat._id })).toBe(0);
    });

    test.each([
        ['bad status', { name: 'Ok', status: 'gone' }],
        ['negative displayOrder', { name: 'Ok', displayOrder: -1 }],
        ['foreign branch', { name: 'Ok', branch: 'FOREIGN' }],
        ['unknown kind', { name: 'Ok', kind: 'snacks' }],
    ])('create: 400 on %s', async (_l, body) => {
        expect((await owner().post('/categories').send(foreign(body))).status).toBe(400);
    });

    // Decision 6 — admin picks Food / Drink per category (Category.kind).
    test('kind: defaults to food, accepts beverages on create, can be changed on update', async () => {
        const food = await owner().post('/categories').send({ name: `Kind F ${rid()}` });
        expect(food.status).toBe(201);
        expect(food.body.data.kind).toBe('food');
        const drink = await owner().post('/categories').send({ name: `Kind D ${rid()}`, kind: 'beverages' });
        expect(drink.status).toBe(201);
        expect(drink.body.data.kind).toBe('beverages');
        const upd = await owner().put(`/categories/${food.body.data._id}`).send({ kind: 'beverages' });
        expect(upd.status).toBe(200);
        expect((await Category.findById(food.body.data._id).lean()).kind).toBe('beverages');
        expect((await owner().put(`/categories/${food.body.data._id}`).send({ kind: 'drinks' })).status).toBe(400);
        expect((await Category.findById(food.body.data._id).lean()).kind).toBe('beverages');
    });

    test('create: duplicate name in the same scope → 400; restaurant in body ignored', async () => {
        const name = `Dupe ${rid()}`;
        const r = await owner().post('/categories').send({ name, restaurant: String(X.restaurant._id) });
        expect(r.status).toBe(201);
        expect(String(r.body.data.restaurant)).toBe(String(A.restaurant._id));
        expect((await owner().post('/categories').send({ name })).status).toBe(400);
    });

    test('reorder validates entries', async () => {
        expect((await owner().put('/categories/reorder').send({ categories: [] })).status).toBe(400);
        expect((await owner().put('/categories/reorder').send({ categories: [{ id: 'x', displayOrder: 1 }] })).status).toBe(400);
        expect((await owner().put('/categories/reorder').send({ categories: [{ id: String(A.category._id), displayOrder: -1 }] })).status).toBe(400);
    });

    // Regression (fixed 2026-10): reorderCategories applies strictBranchFilter for branch-pinned callers.
    test('a Branch Admin cannot reorder categories outside their branch', async () => {
        const { admin } = await mkBranchWithAdmin(A);
        const before = (await Category.findById(A.category._id).lean()).displayOrder;
        await ctx.api.as(admin).put('/categories/reorder').send({ categories: [{ id: String(A.category._id), displayOrder: 777 }] });
        expect((await Category.findById(A.category._id).lean()).displayOrder).toBe(before);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('combos', () => {
    const create = (body, who = A.users.admin) => ctx.api.as(who).post('/combos').send({
        name: `Combo ${rid()}`, description: 'c', price: 199, ...body,
    });

    test.each([
        ['missing name', { name: ' ' }, /name is required/],
        ['negative price', { price: -1 }, /non-negative/],
        ['missing price', { price: null }, /non-negative/],
        ['negative discount', { discount: -5 }, /cannot be negative/],
        ['percentage > 100', { discount: 150, discountType: 'Percentage' }, /cannot exceed 100/],
    ])('400 on %s', async (_l, body, msg) => {
        const r = await create(body);
        expect(r.status).toBe(400);
        expect(r.body.message).toMatch(msg);
    });

    test('savings computed from originalPrice − price on create and on edit', async () => {
        const r = await create({ price: 300, originalPrice: 400 });
        expect(r.status).toBe(201);
        expect(r.body.data.savings).toBe(100);
        const u = await owner().put(`/combos/${r.body.data._id}`).send({ price: 350 });
        expect(u.body.data.savings).toBe(50);
        const u2 = await owner().put(`/combos/${r.body.data._id}`).send({ originalPrice: 100 });
        expect(u2.body.data.savings).toBe(0);
    });

    test('pinned Branch Admin: combo is stamped with their branch, body.branch ignored', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        const r = await create({ branch: String(A.branch._id) }, admin);
        expect(r.status).toBe(201);
        expect(String(r.body.data.branch)).toBe(String(branch._id));
        const u = await ctx.api.as(admin).put(`/combos/${r.body.data._id}`).send({ branch: String(A.branch._id) });
        expect(String(u.body.data.branch)).toBe(String(branch._id));
    });

    // Regression (fixed 2026-10): createCombo/updateCombo allowlist fields and require component menuItemIds to be own-tenant items (400 otherwise).
    test('combo components must be own-tenant menu items and counters are not client-writable', async () => {
        const r = await create({
            orderCount: 5000,
            categories: [{ name: 'Mains', items: [{ menuItemId: String(X.items.paneer._id), name: 'Paneer Tikka', price: 1 }] }],
        });
        const saved = r.status === 201 ? await Combo.findById(r.body.data._id).lean() : null;
        expect(r.status === 400 || (saved.orderCount === 0 && !String(JSON.stringify(saved)).includes(String(X.items.paneer._id)))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('areas', () => {
    test('create / duplicate / update / delete', async () => {
        const name = `Rooftop ${rid()}`;
        const r = await owner().post('/areas').send({ name: `  ${name} `, description: 'open air' });
        expect(r.status).toBe(201);
        expect(r.body.area).toMatchObject({ name, description: 'open air', branch: null });
        expect((await owner().post('/areas').send({ name })).status).toBe(400);
        expect((await owner().post('/areas').send({ name: 'Long', description: 'x'.repeat(301) })).status).toBe(400);
        const u = await owner().put(`/areas/${r.body.area._id}`).send({ isActive: false, note: ' n ' });
        expect(u.body.area).toMatchObject({ isActive: false, note: 'n' });
        const d = await owner().delete(`/areas/${r.body.area._id}`);
        expect(d.body).toMatchObject({ success: true, deletedTables: 0 });
    });

    test('delete is blocked while a table in the area has an active order', async () => {
        const area = await Area.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: `Busy ${rid()}` });
        const { createTable } = require('./helpers/seed');
        const table = await createTable(A, { area: area._id, name: `BT-${rid()}` });
        await mkOrder(A, { branch: A.branch._id, table: table._id, type: 'dine-in', status: 'preparing' });
        const d = await owner().delete(`/areas/${area._id}`);
        expect(d.status).toBe(400);
        expect(d.body.code).toBe('AREA_HAS_ACTIVE_TABLES');
        expect(d.body.blockedTables).toEqual([table.name]);
    });

    test('Branch Admin creates areas at their own branch and cannot edit Main\'s', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        const r = await ctx.api.as(admin).post('/areas').send({ name: 'Patio', branch: String(A.branch._id) });
        expect(String(r.body.area.branch)).toBe(String(branch._id));
        expect((await ctx.api.as(admin).put(`/areas/${A.area._id}`).send({ name: 'Hijacked' })).status).toBe(404);
    });

    // Regression (fixed 2026-10): createArea validates the owner's body.branch against the tenant's active branches.
    test('area branch id must be an active branch of this tenant', async () => {
        const r = await owner().post('/areas').send({ name: `Ghost ${rid()}`, branch: String(X.branch._id) });
        expect(r.status).toBe(400);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('branch reads, Branch Admin management, area sync', () => {
    test('list / get: a Branch Admin sees only their own branch', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        const list = await ctx.api.as(admin).get('/branches');
        expect(list.body.data.map((b) => String(b._id))).toEqual([String(branch._id)]);
        expect((await ctx.api.as(admin).get(`/branches/${A.branch._id}`)).status).toBe(403);
        const own = await ctx.api.as(admin).get(`/branches/${branch._id}`);
        expect(own.status).toBe(200);
        expect(JSON.stringify(own.body)).not.toMatch(/\$2[aby]\$|"password"/);
        expect((await ctx.api.as(A.users.waiter).get('/branches')).status).toBe(403);
        expect((await owner().get(`/branches/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });

    test('owner list hides disabled branches unless includeInactive=true', async () => {
        const off = await Branch.create({ restaurant: A.restaurant._id, name: 'Hidden', slug: `hid-${rid()}`, isActive: false });
        const ids = async (q) => (await owner().get(`/branches${q}`)).body.data.map((b) => String(b._id));
        expect(await ids('')).not.toContain(String(off._id));
        expect(await ids('?includeInactive=true')).toContain(String(off._id));
    });

    test('POST /:id/subadmin: 409 when one exists; creates one for an admin-less branch (no hash in body)', async () => {
        const { branch } = await mkBranchWithAdmin(A);
        const dup = await owner().post(`/branches/${branch._id}/subadmin`).send({ name: 'N', email: `n.${rid()}@x.test` });
        expect(dup.status).toBe(409);

        const bare = await Branch.create({ restaurant: A.restaurant._id, name: 'Bare', slug: `bare-${rid()}` });
        expect((await owner().post(`/branches/${bare._id}/subadmin`).send({ email: `n.${rid()}@x.test` })).status).toBe(400);
        expect((await owner().post(`/branches/${bare._id}/subadmin`).send({ name: 'N', email: 'bad' })).status).toBe(400);
        const ok = await owner().post(`/branches/${bare._id}/subadmin`).send({ name: 'New Boss', email: `nb.${rid()}@x.test` });
        expect(ok.status).toBe(201);
        expect(ok.body.subAdmin).toMatchObject({ name: 'New Boss', mustChangePassword: true });
        expect(ok.body.tempPassword).toEqual(expect.any(String));
        expect(JSON.stringify(ok.body)).not.toMatch(/\$2[aby]\$/);
    });

    test('PATCH /:id/subadmin validates the name; reset-password rotates the hash', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        expect((await owner().patch(`/branches/${branch._id}/subadmin`).send({ name: '   ' })).status).toBe(400);
        const u = await owner().patch(`/branches/${branch._id}/subadmin`).send({ name: 'Renamed Boss' });
        expect(u.status).toBe(200);
        expect((await User.findById(admin._id).lean()).name).toBe('Renamed Boss');

        const before = (await User.findById(admin._id).select('+password').lean()).password;
        const r = await owner().post(`/branches/${branch._id}/subadmin/reset-password`);
        expect(r.status).toBe(200);
        const after = await User.findById(admin._id).select('+password');
        expect(after.password).not.toBe(before);
        expect(after.mustChangePassword).toBe(true);
        expect(await after.comparePassword(r.body.tempPassword)).toBe(true);

        const bare = await Branch.create({ restaurant: A.restaurant._id, name: 'NoAdmin', slug: `na-${rid()}` });
        expect((await owner().post(`/branches/${bare._id}/subadmin/reset-password`)).body.code).toBe('NO_SUBADMIN');
    });

    test('sync-areas copies Main areas once (idempotent) and refuses Main as a target', async () => {
        const T = await seedTenant({ label: 'bmc-area' });
        const b = await Branch.create({ restaurant: T.restaurant._id, name: 'Two', slug: 'two' });
        const first = await ctx.api.as(T.users.admin).post(`/branches/${b._id}/sync-areas`);
        expect(first.body.newlySynced).toBe(1);
        const again = await ctx.api.as(T.users.admin).post(`/branches/${b._id}/sync-areas`);
        expect(again.body.newlySynced).toBe(0);
        expect(await Area.countDocuments({ restaurant: T.restaurant._id, branch: b._id })).toBe(1);
        const main = await ctx.api.as(T.users.admin).post(`/branches/${T.branch._id}/sync-areas`);
        expect(main.body.code).toBe('MAIN_IS_SOURCE');
        const all = await ctx.api.as(T.users.admin).post('/branches/sync-menu-all');
        expect(all.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('menu CSV import + reads', () => {
    const HEAD = 'name,description,category,basePrice,vegType,prepStation,offerPercentage,availableDays,sizes';
    const upload = (csv) => owner().post('/menu/import').attach('file', Buffer.from(csv, 'utf8'), 'menu.csv');

    test('valid rows land with finalPrice; bad rows are reported per row', async () => {
        const cat = `CSV Cat ${rid()}`;
        const name = `CSV Dosa ${rid()}`;
        const csv = [
            HEAD,
            `${name},Crispy,${cat},120,veg,kitchen,25,Mon|tue|Xyz,Regular:120|Large:-1|Bad`,
            `NoDesc,,${cat},50,veg,kitchen,0,,`,
            `NegPrice,d,${cat},-5,veg,kitchen,0,,`,
            `BadVeg,d,${cat},5,vegan,kitchen,0,,`,
            `BadOffer,d,${cat},5,veg,kitchen,101,,`,
            `BadStation,d,${cat},5,veg,oven,0,,`,
        ].join('\n');
        const res = await upload(csv);
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(1);
        expect(res.body.errors.map((e) => e.message)).toEqual([
            'description is required',
            'basePrice must be a non-negative number',
            'vegType must be "veg" or "non-veg" (got "vegan")',
            'offerPercentage must be between 0 and 100',
            'prepStation must be kitchen|bar|counter (got "oven")',
        ]);
        const item = await MenuItem.findOne({ restaurant: A.restaurant._id, name }).populate('category').lean();
        expect(item).toMatchObject({ basePrice: 120, offerPercentage: 25, finalPrice: 90, availableDays: ['Mon', 'Tue'] });
        expect(item.sizes.map((s) => [s.name, s.price])).toEqual([['Regular', 120]]);
        expect(item.category.name).toBe(cat);
    });

    test.each([
        ['no file', null, 400],
        ['header only', 'name,description,category,basePrice', 400],
        ['missing required column', 'name,description\nA,B', 400],
    ])('%s → %i', async (_l, csv, code) => {
        const res = csv === null ? await owner().post('/menu/import') : await upload(csv);
        expect(res.status).toBe(code);
    });

    test('branch-prices read is admin-only and reports the default price', async () => {
        expect((await ctx.api.guest(A).get(`/menu/${A.items.paneer._id}/branch-prices`)).status).toBe(401);
        const bp = await owner().get(`/menu/${A.items.thali._id}/branch-prices`);
        expect(bp.body.data.defaultPrice).toEqual({ basePrice: 150, finalPrice: 135, offerPercentage: 10 });
    });

    // Regression (fixed 2026-10): menuRoute validates startTime/endTime as 00:00–23:59 and pads "H:MM" to "HH:MM".
    test.each(['9:00', '9am', '25:99'])('startTime %p is rejected or normalised to HH:MM', async (startTime) => {
        const res = await owner().post('/menu').send({
            name: `Time ${rid()}`, description: 'd', category: String(A.category._id), basePrice: 10, startTime, endTime: '17:00',
        });
        const stored = res.status === 201 ? res.body.data.startTime : null;
        expect(res.status === 400 || /^([01]\d|2[0-3]):[0-5]\d$/.test(stored)).toBe(true);
    });
});

describe('combo reads', () => {
    const mk = (fields) => Combo.create({ restaurant: A.restaurant._id, name: `RC ${rid()}`, description: 'd', price: 99, ...fields });
    const names = (body) => (body.data || []).map((c) => c.name);

    test('Branch Admin sees only their own branch combos; single read works for customers', async () => {
        const { branch, admin } = await mkBranchWithAdmin(A);
        const shared = await mk({});
        const mine = await mk({ branch: branch._id });
        expect(names((await ctx.api.as(admin).get('/combos?limit=100')).body)).toEqual([mine.name]);
        expect(names((await ctx.api.guest(A).get('/combos?limit=100&status=active')).body)).toContain(shared.name);
        expect((await ctx.api.guest(A).get(`/combos/${shared._id}`)).status).toBe(200);
    });

    // Regression (fixed 2026-10): getCombos forces status 'active' for non-staff callers.
    test('anonymous GET /combos hides archived and draft combos by default', async () => {
        const archived = await mk({ status: 'archived' });
        const draft = await mk({ status: 'draft' });
        const cust = names((await ctx.api.guest(A).get('/combos?limit=100')).body);
        expect(cust).not.toContain(archived.name);
        expect(cust).not.toContain(draft.name);
    });
});
