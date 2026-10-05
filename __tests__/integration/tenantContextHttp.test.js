/**
 * attachTenant over real HTTP + a real database (checklist 3.1 / 3.2).
 *
 * The unit suites stub Restaurant / Branch; this file proves the same
 * guarantees through the real app wiring (optionalAuth → attachTenant →
 * route), with real Branch documents and the real slug cache:
 *
 *   - X-Branch-Id of another tenant → 404, never a cross-tenant branch
 *   - branch-pinned staff cannot pivot to another branch via the header
 *   - '/publicXYZ' is not treated as the exempt '/public' prefix
 *   - suspended / cancelled tenants are blocked on staff and guest paths,
 *     trial / past_due are not
 *   - a renamed slug stops resolving once invalidateTenant() runs
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { invalidateTenant } = require(path.join(BACKEND, 'middlewares/tenantContext'));

const ctx = useIntegrationApp();
let A;
let B;
let branchA2;

beforeAll(async () => {
    A = await seedTenant({ label: 'a' });
    B = await seedTenant({ label: 'b' });
    branchA2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
});

async function setStatus(tenant, status) {
    await Restaurant.updateOne({ _id: tenant.restaurant._id }, { $set: { status } });
}

// ── Branch header ──────────────────────────────────────────────────────

describe('X-Branch-Id across tenants', () => {
    test("A's tenant owner sending B's branch id → 404 BRANCH_NOT_FOUND", async () => {
        const res = await ctx.api.as(A.users.admin).get('/menu').set('X-Branch-Id', String(B.branch._id));

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test("a guest on A's slug sending B's branch id → 404 BRANCH_NOT_FOUND", async () => {
        const res = await ctx.api.guest(A).get('/menu').set('X-Branch-Id', String(B.branch._id));

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test("A's waiter pinned to Main sending A's second branch id → 403 BRANCH_MISMATCH", async () => {
        const res = await ctx.api.as(A.users.waiter).get('/menu').set('X-Branch-Id', String(branchA2._id));

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });

    test("A's waiter sending its own branch id is served", async () => {
        const res = await ctx.api.as(A.users.waiter).get('/menu').set('X-Branch-Id', String(A.branch._id));

        expect(res.status).toBe(200);
    });

    test("A's owner with B's slug header still gets A's menu, never B's", async () => {
        const res = await ctx.api.as(A.users.admin).get('/menu').set('X-Restaurant-Slug', B.slug);

        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).toContain(String(A.items.paneer._id));
        expect(body).not.toContain(String(B.items.paneer._id));
    });
});

// ── Exempt prefix boundary ─────────────────────────────────────────────

describe('exempt path boundary', () => {
    test("'/publicXYZ' without a tenant → 400 TENANT_REQUIRED (not exempt)", async () => {
        const res = await ctx.api.anon().get('/publicXYZ');

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test("'/public/plans' without a tenant is not rejected by attachTenant", async () => {
        const res = await ctx.api.anon().get('/public/plans');

        expect(res.body.code).not.toBe('TENANT_REQUIRED');
    });
});

// ── Tenant status ──────────────────────────────────────────────────────

describe('tenant status gate', () => {
    afterEach(async () => {
        await setStatus(B, 'active');
    });

    test.each(['suspended', 'cancelled'])('%s tenant → 403 TENANT_SUSPENDED for staff and guests', async (status) => {
        await ctx.api.guest(B).get('/menu'); // warm the slug cache first
        await setStatus(B, status);

        const staff = await ctx.api.as(B.users.admin).get('/menu');
        const guest = await ctx.api.guest(B).get('/menu');

        expect(staff.status).toBe(403);
        expect(staff.body.code).toBe('TENANT_SUSPENDED');
        expect(guest.status).toBe(403);
        expect(guest.body.code).toBe('TENANT_SUSPENDED');
    });

    test.each(['trial', 'past_due'])('%s tenant is still served', async (status) => {
        await setStatus(B, status);

        const staff = await ctx.api.as(B.users.admin).get('/menu');
        const guest = await ctx.api.guest(B).get('/menu');

        expect(staff.status).toBe(200);
        expect(guest.status).toBe(200);
    });

    test('suspending B does not affect tenant A', async () => {
        await setStatus(B, 'suspended');

        const res = await ctx.api.guest(A).get('/menu');

        expect(res.status).toBe(200);
    });
});

// ── Slug cache ─────────────────────────────────────────────────────────

describe('slug rename + invalidation', () => {
    test('old slug stops resolving after invalidateTenant; new slug resolves', async () => {
        const oldSlug = B.slug;
        const newSlug = `${oldSlug}-renamed`;
        expect((await ctx.api.guest(B).get('/menu')).status).toBe(200); // cached

        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { slug: newSlug } });
        invalidateTenant(B.restaurant._id);

        const oldRes = await ctx.api.guest({ slug: oldSlug }).get('/menu');
        const newRes = await ctx.api.guest({ slug: newSlug }).get('/menu');

        expect(oldRes.status).toBe(400);
        expect(oldRes.body.code).toBe('TENANT_REQUIRED');
        expect(newRes.status).toBe(200);

        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { slug: oldSlug } });
        invalidateTenant(B.restaurant._id);
    });
});
