/**
 * Admin branch switcher scoping (`?branch=<id>` on staff GETs).
 *
 * Regression (fixed 2026-10): a stale `adminActiveBranch` in the browser
 * (another restaurant's branch id, or a deleted branch) was injected into
 * every admin GET and used as a strict list filter, so Areas / Tables /
 * everything came back empty with a 200. Now it is refused with
 * 404 BRANCH_NOT_FOUND — the same code a bad X-Branch-Id gets — so the
 * client drops it. Also pins that an owner-created area carrying the
 * viewed branch shows up in that branch's strict view.
 *
 * 2026-10-16 (review item): a DEACTIVATED branch of the caller's own
 * tenant is no longer a 404 for the tenant owner / manager — its
 * historical orders and reports must stay reachable from the switcher.
 * Reads pass, writes get 409 BRANCH_INACTIVE, other roles and other
 * tenants' branches keep the 404. The verdict is cached for 60 s and
 * dropped by invalidateBranchCache() (called from branchController).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { invalidateBranchCache } = require(path.join(BACKEND, 'middlewares/tenantContext'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'abs-a' });
    B = await seedTenant({ label: 'abs-b' });
});

const admin = (t) => ctx.api.as(t.users.admin, t);

describe('staff ?branch=<id> must belong to the caller\'s tenant', () => {
    test.each([
        ['another tenant\'s branch', () => String(B.branch._id)],
        ['a branch that does not exist', () => '69f8300f24be77f6adbd9c75'],
    ])('%s → 404 BRANCH_NOT_FOUND on every admin list', async (_l, id) => {
        for (const route of ['/areas', '/tables', '/menu', '/orders/live', '/admin/bootstrap']) {
            const res = await admin(A).get(`${route}?branch=${id()}&branchScope=auto`);
            expect({ route, status: res.status, code: res.body.code }).toEqual({ route, status: 404, code: 'BRANCH_NOT_FOUND' });
        }
    });

    test('own branch, "all", "tenant-only" and no param all pass', async () => {
        for (const q of [`?branch=${A.branch._id}&branchScope=auto`, '?branch=all', '?branch=tenant-only', '']) {
            const res = await admin(A).get(`/areas${q}`);
            expect({ q, status: res.status }).toEqual({ q, status: 200 });
        }
    });

    test('waiters (pinned staff) with a foreign ?branch are refused as well; customers are unaffected', async () => {
        const res = await ctx.api.as(A.users.waiter, A).get(`/areas?branch=${B.branch._id}`);
        expect(res.status).toBe(404);
        // Customer flow never sends ?branch; a guest list still works.
        const guest = await ctx.api.guest(A).get('/areas');
        expect(guest.status).toBe(200);
    });
});

describe('a DEACTIVATED branch of the caller\'s own tenant', () => {
    let dead;       // A's closed branch
    let deadB;      // B's closed branch
    let manager;    // A's tenant-level manager (unpinned)

    beforeAll(async () => {
        dead = await Branch.create({ restaurant: A.restaurant._id, name: 'Closed', slug: 'closed', isActive: false });
        deadB = await Branch.create({ restaurant: B.restaurant._id, name: 'Closed B', slug: 'closed-b', isActive: false });
        manager = await createUser({
            name: 'Manager abs-a', email: `manager.${A.slug}@staff.test`, role: 'manager',
            restaurant: A.restaurant._id, branch: null, permissions: defaultPermissionsForRole('manager'),
        });
    });

    test('admin GET orders / reports / lists with ?branch=<inactive own branch> → 200', async () => {
        for (const route of ['/orders/past', '/orders/live', '/areas', '/tables']) {
            const res = await admin(A).get(`${route}?branch=${dead._id}`);
            expect({ route, status: res.status, code: res.body.code }).toEqual({ route, status: 200, code: undefined });
        }
    });

    test('manager GET with ?branch=<inactive own branch> → 200', async () => {
        const res = await ctx.api.as(manager, A).get(`/orders/past?branch=${dead._id}`);
        expect(res.status).toBe(200);
    });

    test('admin POST with that branch → 409 BRANCH_INACTIVE and nothing is written', async () => {
        const order = await admin(A).post(`/orders?branch=${dead._id}`).send({ items: [] });
        expect(order.status).toBe(409);
        expect(order.body).toMatchObject({ success: false, code: 'BRANCH_INACTIVE' });
        expect(order.body.message).toMatch(/deactivated/i);

        const area = await admin(A).post(`/areas?branch=${dead._id}`).send({ name: 'Ghost Floor', note: '', description: '', branch: String(dead._id) });
        expect(area.status).toBe(409);
        expect(area.body.code).toBe('BRANCH_INACTIVE');
        expect(await Area.countDocuments({ restaurant: A.restaurant._id, name: 'Ghost Floor' })).toBe(0);

        const put = await admin(A).put(`/areas/${A.area._id}?branch=${dead._id}`).send({ name: 'Renamed' });
        expect(put.status).toBe(409);
        expect(put.body.code).toBe('BRANCH_INACTIVE');
    });

    test('the same rule applies to the X-Branch-Id header', async () => {
        const get = await admin(A).get('/orders/past').set('X-Branch-Id', String(dead._id));
        expect(get.status).toBe(200);
        const post = await admin(A).post('/orders').set('X-Branch-Id', String(dead._id)).send({ items: [] });
        expect(post.status).toBe(409);
        expect(post.body.code).toBe('BRANCH_INACTIVE');
    });

    test('waiter GET with ?branch=<inactive own branch> → 404 BRANCH_NOT_FOUND', async () => {
        const res = await ctx.api.as(A.users.waiter, A).get(`/orders/past?branch=${dead._id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('another tenant\'s inactive branch → 404 for admin reads AND writes (never 409: no existence leak)', async () => {
        const get = await admin(A).get(`/orders/past?branch=${deadB._id}`);
        expect(get.status).toBe(404);
        expect(get.body.code).toBe('BRANCH_NOT_FOUND');
        const post = await admin(A).post(`/orders?branch=${deadB._id}`).send({ items: [] });
        expect(post.status).toBe(404);
        expect(post.body.code).toBe('BRANCH_NOT_FOUND');
        const hdr = await admin(A).get('/orders/past').set('X-Branch-Id', String(deadB._id));
        expect(hdr.status).toBe(404);
    });

    test('deactivating through DELETE /branches/:id takes effect on the next request (cache invalidated)', async () => {
        await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { 'subscription.limits.maxBranches': 50 } });
        const sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Baner', slug: 'baner', isActive: true });

        // Warm the verdict cache with "active".
        const warm = await admin(A).post(`/areas?branch=${sub._id}`).send({ name: 'Baner Hall', note: '', description: '', branch: String(sub._id) });
        expect(warm.status).toBe(201);

        const off = await admin(A).delete(`/branches/${sub._id}`);
        expect(off.status).toBe(200);
        expect(off.body.data.isActive).toBe(false);

        // No 60 s window of stale "active": writes are refused immediately,
        // reads still work for the owner.
        const write = await admin(A).post(`/areas?branch=${sub._id}`).send({ name: 'Too Late', note: '', description: '', branch: String(sub._id) });
        expect(write.status).toBe(409);
        expect(write.body.code).toBe('BRANCH_INACTIVE');
        const read = await admin(A).get(`/areas?branch=${sub._id}`);
        expect(read.status).toBe(200);
        expect(read.body.areas.map((a) => a.name)).toContain('Baner Hall');

        // Reactivate through the API: the 409 verdict is dropped as well.
        const on = await admin(A).patch(`/branches/${sub._id}/reactivate`);
        expect(on.status).toBe(200);
        const again = await admin(A).post(`/areas?branch=${sub._id}`).send({ name: 'Back Again', note: '', description: '', branch: String(sub._id) });
        expect(again.status).toBe(201);

        // A direct DB write (migration / script) bypasses the controller
        // hook: the middleware keeps its cached "active" verdict (the
        // request reaches areaController, which refuses the inactive body
        // branch itself with 400 — not the middleware's 409) until the
        // exported invalidateBranchCache() runs.
        await Branch.updateOne({ _id: sub._id }, { $set: { isActive: false } });
        const stale = await admin(A).post(`/areas?branch=${sub._id}`).send({ name: 'Stale', note: '', description: '', branch: String(sub._id) });
        expect(stale.status).not.toBe(409);
        invalidateBranchCache(A.restaurant._id);
        const fresh = await admin(A).post(`/areas?branch=${sub._id}`).send({ name: 'Fresh', note: '', description: '', branch: String(sub._id) });
        expect(fresh.status).toBe(409);
        expect(fresh.body.code).toBe('BRANCH_INACTIVE');
    });
});

describe('owner creates an area while viewing a branch', () => {
    test('the area carries that branch and appears in the strict branch view', async () => {
        const create = await admin(A).post('/areas').send({ name: 'First Floor', note: '', description: '', branch: String(A.branch._id) });
        expect(create.status).toBe(201);
        expect(String(create.body.area.branch)).toBe(String(A.branch._id));

        const list = await admin(A).get(`/areas?branch=${A.branch._id}&branchScope=auto`);
        expect(list.status).toBe(200);
        expect(list.body.areas.map((a) => a.name)).toContain('First Floor');

        // Without a branch the area is stored tenant-level (branch:null). Such
        // records belong to the Main branch (utils/tenantScope.branchScopeClause):
        // they show in Main's view (A.branch is Main) and stay out of every other
        // branch's view.
        const shared = await admin(A).post('/areas').send({ name: 'Shared Terrace', note: '', description: '' });
        expect(shared.status).toBe(201);
        expect(shared.body.area.branch).toBeNull();
        const strict = await admin(A).get(`/areas?branch=${A.branch._id}`);
        expect(strict.body.areas.map((a) => a.name)).toContain('Shared Terrace');
        const sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
        const subView = await admin(A).get(`/areas?branch=${sub._id}`);
        expect(subView.status).toBe(200);
        expect(subView.body.areas.map((a) => a.name)).not.toContain('Shared Terrace');
        const all = await admin(A).get('/areas?branch=all');
        expect(all.body.areas.map((a) => a.name)).toEqual(expect.arrayContaining(['First Floor', 'Shared Terrace']));
    });

    test('a foreign branch in the body is refused', async () => {
        const res = await admin(A).post('/areas').send({ name: 'Nope', branch: String(B.branch._id) });
        expect(res.status).toBe(400);
        expect(await Area.countDocuments({ restaurant: A.restaurant._id, name: 'Nope' })).toBe(0);
    });
});
