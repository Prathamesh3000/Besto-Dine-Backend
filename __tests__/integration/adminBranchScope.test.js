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
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));

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

    test('an inactive branch is refused too', async () => {
        const dead = await Branch.create({ restaurant: A.restaurant._id, name: 'Closed', slug: 'closed', isActive: false });
        const res = await admin(A).get(`/areas?branch=${dead._id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
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
