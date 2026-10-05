/**
 * Tenant / branch isolation helpers — gap coverage (checklist 3.1–3.3).
 *
 * Modules under test (no DB — Restaurant / Branch are replaced by a tiny
 * in-memory store that honours the real filter shapes, so a query that
 * forgets `restaurant: <tenant>` really does find the other tenant's row):
 *   - middlewares/tenantContext.js  (attachTenant, isStrictExempt,
 *                                    invalidateTenant / invalidateSlug)
 *   - utils/tenantScope.js          (tenantFilter, tenantId, branch filters)
 *   - utils/branchOwnership.js      (resolveOwnedBranch)
 *   - utils/mainBranch.js           (getMainBranchId, merged filters)
 *   - utils/createMainBranch.js     (createMainBranchFor)
 *   - utils/tenantAssertions.js     (installTenantAssertions)
 *   - utils/tenantScopePlugin.js    (gaps only: explicit other-tenant
 *                                    writes, $and / $or, $lookup, bulk ops)
 *
 * Coverage:
 *   1. Staff of tenant A sending tenant B's slug (header / query) stays in A
 *   2. X-Branch-Id of another tenant → 404; pinned staff sending another
 *      branch → 403; inactive / malformed / lookup-error branches
 *   3. Tenant status matrix (trial / active / past_due allowed;
 *      suspended / cancelled blocked) on staff, slug and custom-domain paths
 *   4. Exempt-path segment boundaries ('/publicXYZ' is NOT exempt)
 *   5. Slug validation, custom-domain precedence, fail-closed on DB errors
 *   6. Slug cache: TTL, invalidateTenant / invalidateSlug, cacheBus fan-out
 *   7. Branch filter helpers, resolveOwnedBranch, main-branch inheritance
 *   8. createMainBranchFor idempotency + field clamping
 *   9. installTenantAssertions (platform skips, idempotency, Mongoose 9 regression)
 *  10. tenantScopePlugin gaps
 */

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── In-memory model doubles ────────────────────────────────────────────

const mockRestaurants = [];
const mockBranches = [];

function mockMatches(doc, filter) {
    return Object.entries(filter || {}).every(([k, v]) => {
        if (v === undefined) return true;
        return String(doc[k]) === String(v);
    });
}

// Chainable query double: supports .sort().select().lean().exec() and await.
function mockQuery(compute) {
    const q = {
        _sort: null,
        sort(s) { q._sort = s; return q; },
        select() { return q; },
        lean() { return q; },
        exec() { return Promise.resolve().then(() => compute(q._sort)); },
        then(onOk, onErr) { return q.exec().then(onOk, onErr); },
    };
    return q;
}

function mockFirst(rows, filter, sort) {
    let hits = rows.filter((r) => mockMatches(r, filter));
    if (sort && sort.createdAt) {
        hits = hits.slice().sort((a, b) => (a.createdAt - b.createdAt) * sort.createdAt);
    }
    return hits[0] || null;
}

const mockRestaurant = {
    findById: jest.fn(),
    findOne: jest.fn(),
};
const mockBranch = {
    findOne: jest.fn(),
    exists: jest.fn(),
    create: jest.fn(),
};

jest.mock('../models/restaurant', () => mockRestaurant);
jest.mock('../models/branch', () => mockBranch);

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const cacheBus = require('../utils/cacheBus');
const requestContext = require('../utils/requestContext');
const plugin = require('../utils/tenantScopePlugin');
const {
    attachTenant,
    requireTenant,
    isStrictExempt,
    invalidateTenant,
    invalidateSlug,
    getTenantFallbackStats,
} = require('../middlewares/tenantContext');
const {
    tenantFilter,
    tenantId,
    strictBranchFilter,
    analyticsBranchFilter,
    pinnedBranchId,
    isBranchPinned,
} = require('../utils/tenantScope');
const { resolveOwnedBranch } = require('../utils/branchOwnership');
const {
    getMainBranchId,
    mergedBranchFilter,
    mergedCustomerBranchFilter,
    isSubBranchCaller,
} = require('../utils/mainBranch');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { installTenantAssertions } = require('../utils/tenantAssertions');

// ── Fixtures ───────────────────────────────────────────────────────────

const oid = () => new mongoose.Types.ObjectId();
const asOid = (s) => new mongoose.Types.ObjectId(String(s));

const A_ID = oid();
const B_ID = oid();
const A_MAIN = oid();
const A_SUB = oid();
const A_INACTIVE = oid();
const B_MAIN = oid();

const tenantA = () => ({ _id: A_ID, name: 'Tenant A', slug: 'tenant-a', status: 'active', customDomain: 'order.tenant-a.com', domainVerified: true });
const tenantB = () => ({ _id: B_ID, name: 'Tenant B', slug: 'tenant-b', status: 'active', customDomain: 'order.tenant-b.com', domainVerified: false });

function seedStore() {
    mockRestaurants.length = 0;
    mockRestaurants.push(tenantA(), tenantB());
    mockBranches.length = 0;
    mockBranches.push(
        { _id: A_MAIN, restaurant: A_ID, slug: 'main', isActive: true, createdAt: 3 },
        { _id: A_SUB, restaurant: A_ID, slug: 'pune', isActive: true, createdAt: 1 },
        { _id: A_INACTIVE, restaurant: A_ID, slug: 'closed', isActive: false, createdAt: 0 },
        { _id: B_MAIN, restaurant: B_ID, slug: 'main', isActive: true, createdAt: 2 },
    );
}

function installStoreMocks() {
    mockRestaurant.findById.mockImplementation(async (id) =>
        mockRestaurants.find((r) => String(r._id) === String(id)) || null);
    mockRestaurant.findOne.mockImplementation((filter) =>
        mockQuery(() => mockFirst(mockRestaurants, filter)));
    mockBranch.findOne.mockImplementation((filter) =>
        mockQuery((sort) => mockFirst(mockBranches, filter, sort)));
    mockBranch.exists.mockImplementation(async (filter) => {
        const hit = mockFirst(mockBranches, filter);
        return hit ? { _id: hit._id } : null;
    });
    mockBranch.create.mockImplementation(async (doc) => ({ _id: oid(), ...doc }));
}

function makeReq(overrides = {}) {
    return {
        method: 'GET',
        path: '/orders',
        baseUrl: '/api/v1',
        headers: {},
        query: {},
        user: null,
        ...overrides,
    };
}

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}

async function run(req) {
    const res = makeRes();
    const next = jest.fn();
    await attachTenant(req, res, next);
    return { req, res, next };
}

const ownerA = (extra = {}) => ({ _id: oid(), role: 'admin', restaurant: A_ID, branch: null, ...extra });
const pinnedA = (branch = A_SUB, extra = {}) => ({ _id: oid(), role: 'waiter', restaurant: A_ID, branch, ...extra });

beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    seedStore();
    installStoreMocks();
    // Module-level slug cache survives between tests — clear both tenants.
    invalidateTenant(A_ID);
    invalidateTenant(B_ID);
    cacheBus.setTransport(null);
    delete process.env.TENANT_SCOPE_PLUGIN;
});

// ── 1. Cross-tenant slug conflicts ─────────────────────────────────────

describe('attachTenant — staff JWT for tenant A with tenant B slug', () => {
    test.each([
        ['X-Restaurant-Slug header', { headers: { 'x-restaurant-slug': 'tenant-b' } }],
        ['legacy X-Restaurant header', { headers: { 'x-restaurant': 'tenant-b' } }],
        ['?restaurant= query param', { query: { restaurant: 'tenant-b' } }],
        ['tenant B verified custom domain origin', { headers: { origin: 'https://order.tenant-b.com' } }],
    ])('stays scoped to tenant A when B is named via %s', async (_label, overrides) => {
        const { req, res, next } = await run(makeReq({ user: ownerA(), ...overrides }));

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
        expect(String(req.restaurant._id)).toBe(String(A_ID));
        expect(mockRestaurant.findOne).not.toHaveBeenCalled();
    });

    test('tenant-A request context carries tenant A even when B slug is sent', async () => {
        const req = makeReq({ user: ownerA(), headers: { 'x-restaurant-slug': 'tenant-b' } });
        let seen;
        await attachTenant(req, makeRes(), () => { seen = requestContext.getContext(); });

        expect(String(seen.tenantId)).toBe(String(A_ID));
    });

    test('staff whose restaurant no longer exists → 403 TENANT_MISSING (no slug fallback)', async () => {
        const user = ownerA({ restaurant: oid() });
        const { res, next } = await run(makeReq({ user, headers: { 'x-restaurant-slug': 'tenant-b' } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('TENANT_MISSING');
    });

    test('superadmin on a tenant route ignores the slug header (never scoped)', async () => {
        const { req, next } = await run(makeReq({ user: { _id: oid(), role: 'superadmin' }, headers: { 'x-restaurant-slug': 'tenant-a' } }));

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toBeNull();
        expect(req.branch).toBeNull();
        expect(mockRestaurant.findOne).not.toHaveBeenCalled();
    });

    test('requireTenant is the same strict middleware', () => {
        expect(requireTenant).toBe(attachTenant);
    });
});

// ── 2. Branch resolution ───────────────────────────────────────────────

describe('attachTenant — X-Branch-Id resolution', () => {
    test('tenant owner of A sending a branch id of tenant B → 404 BRANCH_NOT_FOUND', async () => {
        const { req, res, next } = await run(makeReq({ user: ownerA(), headers: { 'x-branch-id': String(B_MAIN) } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
        expect(req.branch).toBeUndefined();
        expect(mockBranch.findOne).toHaveBeenCalledWith({ _id: String(B_MAIN), restaurant: A_ID, isActive: true });
    });

    test('guest on tenant A slug sending a branch id of tenant B → 404 BRANCH_NOT_FOUND', async () => {
        const { res, next } = await run(makeReq({ headers: { 'x-restaurant-slug': 'tenant-a', 'x-branch-id': String(B_MAIN) } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('guest on tenant A slug with an own active branch → req.branch populated', async () => {
        const { req, next } = await run(makeReq({ headers: { 'x-restaurant-slug': 'tenant-a', 'x-branch-id': String(A_SUB) } }));

        expect(next).toHaveBeenCalled();
        expect(String(req.branch._id)).toBe(String(A_SUB));
    });

    test('own branch that is inactive → 404 BRANCH_NOT_FOUND', async () => {
        const { res } = await run(makeReq({ user: ownerA(), headers: { 'x-branch-id': String(A_INACTIVE) } }));

        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test.each([
        ['not hex', 'not-an-object-id'],
        ['operator payload', '{"$ne":null}'],
        ['two ids joined by a proxy', `${A_SUB}, ${A_MAIN}`],
    ])('malformed X-Branch-Id (%s) → 400 BRANCH_ID_INVALID without a DB lookup', async (_label, header) => {
        const { res, next } = await run(makeReq({ user: ownerA(), headers: { 'x-branch-id': header } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('BRANCH_ID_INVALID');
        expect(mockBranch.findOne).not.toHaveBeenCalled();
    });

    test('header branch lookup error → 503 BRANCH_LOOKUP_FAILED (fail closed)', async () => {
        mockBranch.findOne.mockImplementationOnce(() => { throw new Error('mongo down'); });

        const { res, next } = await run(makeReq({ user: ownerA(), headers: { 'x-branch-id': String(A_SUB) } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('BRANCH_LOOKUP_FAILED');
    });

    test('owner without a header stays tenant-level (req.branch = null)', async () => {
        const { req, next } = await run(makeReq({ user: ownerA() }));

        expect(next).toHaveBeenCalled();
        expect(req.branch).toBeNull();
        expect(mockBranch.findOne).not.toHaveBeenCalled();
    });
});

describe('attachTenant — branch-pinned staff', () => {
    test('sending another branch id of the same tenant → 403 BRANCH_MISMATCH, no lookup', async () => {
        const { res, next } = await run(makeReq({ user: pinnedA(A_SUB), headers: { 'x-branch-id': String(A_MAIN) } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
        expect(mockBranch.findOne).not.toHaveBeenCalled();
    });

    test("sending tenant B's branch id → 403 BRANCH_MISMATCH", async () => {
        const { res } = await run(makeReq({ user: pinnedA(A_SUB), headers: { 'x-branch-id': String(B_MAIN) } }));

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });

    test('sending its own branch id (or none) → pinned branch resolved', async () => {
        const withHeader = await run(makeReq({ user: pinnedA(A_SUB), headers: { 'x-branch-id': String(A_SUB) } }));
        const without = await run(makeReq({ user: pinnedA(A_SUB) }));

        expect(String(withHeader.req.branch._id)).toBe(String(A_SUB));
        expect(String(without.req.branch._id)).toBe(String(A_SUB));
    });

    test('pin pointing at a branch of tenant B → 403 BRANCH_INACTIVE (lookup is tenant-scoped)', async () => {
        const { res, next } = await run(makeReq({ user: pinnedA(B_MAIN) }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('BRANCH_INACTIVE');
        expect(mockBranch.findOne).toHaveBeenCalledWith({ _id: B_MAIN, restaurant: A_ID, isActive: true });
    });

    test('pin pointing at a deactivated branch → 403 BRANCH_INACTIVE', async () => {
        const { res } = await run(makeReq({ user: pinnedA(A_INACTIVE) }));

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('BRANCH_INACTIVE');
    });

    test('pin lookup error → 503 BRANCH_LOOKUP_FAILED', async () => {
        mockBranch.findOne.mockImplementationOnce(() => { throw new Error('mongo down'); });

        const { res } = await run(makeReq({ user: pinnedA(A_SUB) }));

        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('BRANCH_LOOKUP_FAILED');
    });
});

// ── 3. Tenant status matrix ────────────────────────────────────────────

describe('attachTenant — tenant status', () => {
    const paths = {
        staff: () => makeReq({ user: ownerA() }),
        slug: () => makeReq({ headers: { 'x-restaurant-slug': 'tenant-a' } }),
        'custom domain': () => makeReq({ headers: { origin: 'https://order.tenant-a.com' } }),
    };
    const cases = [];
    for (const via of Object.keys(paths)) {
        for (const status of ['trial', 'active', 'past_due']) cases.push([status, via, true]);
        for (const status of ['suspended', 'cancelled']) cases.push([status, via, false]);
    }

    test.each(cases)('status %s via %s → allowed=%s', async (status, via, allowed) => {
        mockRestaurants[0].status = status;

        const { req, res, next } = await run(paths[via]());

        if (allowed) {
            expect(next).toHaveBeenCalled();
            expect(String(req.restaurant._id)).toBe(String(A_ID));
        } else {
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
            expect(res.body.code).toBe('TENANT_SUSPENDED');
            expect(req.restaurant).toBeUndefined();
        }
    });

    test('stale staff JWT of a suspended tenant can still reach /auth (exempt, no lookup)', async () => {
        mockRestaurants[0].status = 'suspended';

        const { req, next } = await run(makeReq({ path: '/auth/login', user: ownerA() }));

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toBeNull();
        expect(mockRestaurant.findById).not.toHaveBeenCalled();
    });
});

// ── 4. Exempt paths ────────────────────────────────────────────────────

describe('isStrictExempt — segment boundaries', () => {
    test.each([
        ['/public', true],
        ['/public/restaurants/tenant-a', true],
        ['/publicXYZ', false],
        ['/public-orders', false],
        ['/auth', true],
        ['/auth/login', true],
        ['/authorize', false],
        ['/superadmin/tenants', true],
        ['/superadmins', false],
        ['/razorpay/webhook', true],
        ['/razorpay/webhooks', false],
        ['/razorpay/order', false],
        ['/tables/scan/tb-abc', true],
        ['/tables/scanner', false],
        ['/tables', false],
        ['/orders/public', false],
        ['', false],
    ])('%s → exempt=%s', (path, exempt) => {
        expect(isStrictExempt({ path })).toBe(exempt);
    });

    test('missing req.path is treated as non-exempt', () => {
        expect(isStrictExempt({})).toBe(false);
    });

    test("'/publicXYZ' without a tenant is rejected 400 TENANT_REQUIRED", async () => {
        const { res, next } = await run(makeReq({ path: '/publicXYZ' }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('exempt path ignores a slug header and opens a tenant-less context', async () => {
        const req = makeReq({ path: '/public/restaurants', headers: { 'x-restaurant-slug': 'tenant-a' } });
        let seen;
        await attachTenant(req, makeRes(), () => { seen = requestContext.getContext(); });

        expect(req.restaurant).toBeNull();
        expect(seen.tenantId).toBeNull();
        expect(mockRestaurant.findOne).not.toHaveBeenCalled();
    });
});

// ── 5. Slug / domain resolution ────────────────────────────────────────

describe('attachTenant — slug and custom-domain resolution', () => {
    test.each([
        ['single character', 'a'],
        ['path traversal', '../tenant-a'],
        ['operator injection', '{"$ne":null}'],
        ['leading hyphen', '-tenant-a'],
        ['too long', 'a'.repeat(61)],
        ['regex wildcard', 'tenant.*'],
    ])('invalid slug (%s) → 400 TENANT_REQUIRED without a slug query', async (_label, slug) => {
        const { res, next } = await run(makeReq({ headers: { 'x-restaurant-slug': slug } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(mockRestaurant.findOne).not.toHaveBeenCalledWith(expect.objectContaining({ slug: expect.anything() }));
    });

    test('object-shaped ?restaurant[$ne]= query is stringified and rejected', async () => {
        const { res } = await run(makeReq({ query: { restaurant: { $ne: null } } }));

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('slug header is trimmed and lower-cased before lookup', async () => {
        const { req } = await run(makeReq({ headers: { 'x-restaurant-slug': '  Tenant-A ' } }));

        expect(String(req.restaurant._id)).toBe(String(A_ID));
        expect(mockRestaurant.findOne).toHaveBeenCalledWith({ slug: 'tenant-a' });
    });

    test('unknown slug → 400 TENANT_REQUIRED', async () => {
        const { res } = await run(makeReq({ headers: { 'x-restaurant-slug': 'no-such-tenant' } }));

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('verified custom domain wins over a slug header of another tenant', async () => {
        const { req } = await run(makeReq({ headers: { origin: 'https://order.tenant-a.com:443', 'x-restaurant-slug': 'tenant-b' } }));

        expect(String(req.restaurant._id)).toBe(String(A_ID));
    });

    test("custom-domain tenant A with tenant B's X-Branch-Id → 404 BRANCH_NOT_FOUND", async () => {
        const { res, next } = await run(makeReq({ headers: { origin: 'https://order.tenant-a.com', 'x-branch-id': String(B_MAIN) } }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('unverified custom domain is ignored (falls through to slug)', async () => {
        const { req } = await run(makeReq({ headers: { host: 'order.tenant-b.com', 'x-restaurant-slug': 'tenant-a' } }));

        expect(String(req.restaurant._id)).toBe(String(A_ID));
        expect(mockRestaurant.findOne).toHaveBeenCalledWith({ customDomain: 'order.tenant-b.com', domainVerified: true });
    });

    test.each(['localhost:5000', 'app.localhost', 'http://localhost:3000'])(
        'local host %s skips the custom-domain lookup', async (host) => {
            await run(makeReq({ headers: { host, 'x-restaurant-slug': 'tenant-a' } }));

            expect(mockRestaurant.findOne).not.toHaveBeenCalledWith(expect.objectContaining({ customDomain: expect.anything() }));
        });

    test('Mongo error during resolution → 400 TENANT_REQUIRED (fail closed), logged', async () => {
        mockRestaurant.findById.mockRejectedValueOnce(new Error('ECONNRESET'));

        const { res, next } = await run(makeReq({ user: ownerA() }));

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
        expect(logger.warn).toHaveBeenCalledWith('tenant.resolve.strict-reject', expect.objectContaining({ reason: 'resolve-error' }));
    });

    test('fallback stats stay at zero (escape hatch removed)', () => {
        expect(getTenantFallbackStats()).toEqual({ nullRestaurantHits: 0, byRoute: {} });
    });
});

// ── 6. Slug cache + invalidation ───────────────────────────────────────

describe('slug cache invalidation', () => {
    const guestReq = (slug = 'tenant-a') => makeReq({ headers: { 'x-restaurant-slug': slug } });
    const slugLookups = () => mockRestaurant.findOne.mock.calls.filter(([f]) => f && f.slug).length;

    test('second request within the TTL is served from cache (findById, no slug query)', async () => {
        await run(guestReq());
        await run(guestReq());

        expect(slugLookups()).toBe(1);
        expect(mockRestaurant.findById).toHaveBeenCalledWith(A_ID);
    });

    test('entry expires after 30 s', async () => {
        const t0 = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(t0);
        await run(guestReq());

        Date.now.mockReturnValue(t0 + 31_000);
        await run(guestReq());

        expect(slugLookups()).toBe(2);
    });

    test('invalidateTenant drops every slug of that tenant only', async () => {
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        invalidateTenant(A_ID);
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        const slugs = mockRestaurant.findOne.mock.calls.map(([f]) => f.slug).filter(Boolean);
        expect(slugs).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);
    });

    test('after a slug rename + invalidateTenant the old slug stops resolving', async () => {
        await run(guestReq('tenant-a'));
        mockRestaurants[0].slug = 'tenant-a-renamed';

        invalidateTenant(A_ID);
        const { res } = await run(guestReq('tenant-a'));

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('suspension takes effect on a cached slug (status is read fresh)', async () => {
        await run(guestReq());
        mockRestaurants[0].status = 'suspended';

        const { res } = await run(guestReq());

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    test('cached id of a deleted tenant falls back to a fresh slug lookup', async () => {
        await run(guestReq());
        mockRestaurants.splice(0, 1);

        const { res } = await run(guestReq());

        expect(res.statusCode).toBe(400);
        expect(slugLookups()).toBe(2);
    });

    test('invalidateSlug normalises case/whitespace and only drops that slug', async () => {
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        invalidateSlug('  TENANT-A ');
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        expect(slugLookups()).toBe(3);
    });

    test('remote cacheBus messages clear the local cache (slug and restaurantId)', async () => {
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        cacheBus.deliver('tenantSlug', { slug: 'tenant-a' });
        cacheBus.deliver('tenantSlug', { restaurantId: String(B_ID) });
        cacheBus.deliver('tenantSlug', null); // ignored, must not throw
        await run(guestReq('tenant-a'));
        await run(guestReq('tenant-b'));

        expect(slugLookups()).toBe(4);
    });

    test('cache is bounded to 200 slugs — the oldest entry is evicted first', async () => {
        for (let i = 0; i < 201; i++) {
            mockRestaurants.push({ _id: oid(), name: `T${i}`, slug: `bulk-tenant-${i}`, status: 'active' });
        }
        await run(guestReq('bulk-tenant-0'));
        for (let i = 1; i <= 200; i++) await run(guestReq(`bulk-tenant-${i}`));
        mockRestaurant.findOne.mockClear();

        await run(guestReq('bulk-tenant-0'));   // evicted → fresh lookup
        await run(guestReq('bulk-tenant-200')); // newest → still cached

        const slugs = mockRestaurant.findOne.mock.calls.map(([f]) => f.slug).filter(Boolean);
        expect(slugs).toEqual(['bulk-tenant-0']);
    });

    test('invalidations are published to other instances; empty ids are ignored', () => {
        const transport = { publish: jest.fn() };
        cacheBus.setTransport(transport);

        invalidateTenant(A_ID);
        invalidateSlug(' Tenant-A ');
        invalidateTenant(null);
        invalidateSlug('');

        expect(transport.publish.mock.calls).toEqual([
            ['tenantSlug', { restaurantId: String(A_ID) }],
            ['tenantSlug', { slug: 'tenant-a' }],
        ]);
    });
});

// ── 7a. tenantScope helpers ────────────────────────────────────────────

describe('tenantScope helpers — gaps', () => {
    test('tenantId returns the resolved tenant id or null', () => {
        expect(tenantId({ restaurant: { _id: A_ID } })).toBe(A_ID);
        expect(tenantId({ restaurant: null })).toBeNull();
        expect(tenantId({})).toBeNull();
    });

    test('tenantFilter tolerates an undefined req and warns', () => {
        expect(tenantFilter(undefined)).toEqual({});
        expect(logger.warn).toHaveBeenCalledWith('tenantScope.tenantFilter.no-tenant', expect.objectContaining({ role: 'anonymous' }));
    });

    test('tenantFilter warning is deduped to the 1st, 10th and 100th hit per route', () => {
        const req = { method: 'GET', path: '/dedupe-probe', user: { role: 'admin' } };
        for (let i = 0; i < 100; i++) tenantFilter(req);

        const hits = logger.warn.mock.calls
            .filter(([msg, meta]) => msg === 'tenantScope.tenantFilter.no-tenant' && meta.route.includes('/dedupe-probe'))
            .map(([, meta]) => meta.occurrences);
        expect(hits).toEqual([1, 10, 100]);
    });

    test("tenant A filter + owner's ?branch=<tenant B branch> stays inside tenant A", () => {
        const req = { restaurant: { _id: A_ID }, user: { role: 'admin', branch: null }, query: { branch: String(B_MAIN) } };

        const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };

        expect(filter).toEqual({ restaurant: A_ID, branch: B_MAIN });
    });

    test.each([
        ['strictBranchFilter', strictBranchFilter, 'shared', { branch: null }],
        ['strictBranchFilter', strictBranchFilter, 'none', { branch: null }],
        ['strictBranchFilter', strictBranchFilter, 'garbage', {}],
        ['analyticsBranchFilter', analyticsBranchFilter, 'none', { branch: null }],
        ['analyticsBranchFilter', analyticsBranchFilter, 'shared', {}],
        ['analyticsBranchFilter', analyticsBranchFilter, 'all', {}],
        ['analyticsBranchFilter', analyticsBranchFilter, 'garbage', {}],
    ])('%s(?branch=%s) for an unpinned owner → %j', (_name, fn, raw, expected) => {
        expect(fn({ user: { role: 'admin' }, query: { branch: raw } })).toEqual(expected);
    });

    test.each([
        ['strictBranchFilter', strictBranchFilter],
        ['analyticsBranchFilter', analyticsBranchFilter],
    ])('%s falls back to req.branch (string or ObjectId) and casts to ObjectId', (_name, fn) => {
        const fromString = fn({ user: null, query: {}, branch: { _id: String(A_SUB) } });
        const fromOid = fn({ user: null, query: {}, branch: { _id: A_SUB } });

        expect(fromString.branch).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(String(fromString.branch)).toBe(String(A_SUB));
        expect(fromOid.branch).toBe(A_SUB);
    });

    test.each([
        ['strictBranchFilter', strictBranchFilter],
        ['analyticsBranchFilter', analyticsBranchFilter],
    ])('%s keeps an ObjectId pin as-is and ignores req.branch from a header', (_name, fn) => {
        const req = { user: { branch: A_SUB }, query: { branch: 'all' }, branch: { _id: A_MAIN } };

        expect(fn(req)).toEqual({ branch: A_SUB });
    });

    test('both filters return {} for a request without query or user', () => {
        expect(strictBranchFilter(undefined)).toEqual({});
        expect(analyticsBranchFilter({})).toEqual({});
        expect(pinnedBranchId(undefined)).toBeNull();
        expect(isBranchPinned({ user: { branch: { _id: A_SUB } } })).toBe(true);
    });
});

// ── 7b. resolveOwnedBranch ─────────────────────────────────────────────

describe('resolveOwnedBranch', () => {
    const owner = (extra = {}) => ({ restaurant: { _id: A_ID }, user: { role: 'admin', branch: null }, ...extra });
    const pinned = (branch = A_SUB) => ({ restaurant: { _id: A_ID }, user: { role: 'admin', branch } });

    test.each([
        ['another branch of the same tenant', String(A_MAIN)],
        ["tenant B's branch", String(B_MAIN)],
    ])('pinned caller naming %s → 403 BRANCH_MISMATCH', async (_label, raw) => {
        await expect(resolveOwnedBranch(pinned(), raw)).resolves.toEqual(
            expect.objectContaining({ ok: false, status: 403, code: 'BRANCH_MISMATCH' }));
        expect(mockBranch.exists).not.toHaveBeenCalled();
    });

    test.each([[undefined], [null], [''], [String(A_SUB)]])('pinned caller with %p → own pin', async (raw) => {
        await expect(resolveOwnedBranch(pinned(), raw)).resolves.toEqual({ ok: true, branchId: A_SUB });
    });

    test('populated pin ({_id}) is compared by id', async () => {
        const res = await resolveOwnedBranch(pinned({ _id: A_SUB }), String(A_SUB));

        expect(res.ok).toBe(true);
    });

    test.each([[undefined], [null], ['']])('owner with blank %p → branchId null', async (raw) => {
        await expect(resolveOwnedBranch(owner(), raw)).resolves.toEqual({ ok: true, branchId: null });
    });

    test('owner with a malformed id → 400', async () => {
        await expect(resolveOwnedBranch(owner(), 'nope')).resolves.toEqual({ ok: false, status: 400, message: 'Invalid branch id' });
    });

    test("owner of A naming tenant B's branch → 400, lookup scoped to A", async () => {
        const res = await resolveOwnedBranch(owner(), String(B_MAIN));

        expect(res).toEqual(expect.objectContaining({ ok: false, status: 400 }));
        expect(mockBranch.exists).toHaveBeenCalledWith({ _id: String(B_MAIN), restaurant: A_ID });
    });

    test('owner naming an own branch → ok with that id', async () => {
        await expect(resolveOwnedBranch(owner(), String(A_SUB))).resolves.toEqual({ ok: true, branchId: String(A_SUB) });
    });
});

// ── 7c. Main-branch inheritance ────────────────────────────────────────

describe('mainBranch helpers', () => {
    const reqFor = (tenant, user = null, extra = {}) => ({ restaurant: tenant ? { _id: tenant } : null, user, query: {}, ...extra });

    test("getMainBranchId prefers slug 'main' within the caller's tenant", async () => {
        await expect(getMainBranchId(reqFor(A_ID))).resolves.toBe(A_MAIN);
        await expect(getMainBranchId(reqFor(B_ID))).resolves.toBe(B_MAIN);
        expect(mockBranch.findOne).toHaveBeenCalledWith({ restaurant: A_ID, isActive: true, slug: 'main' });
    });

    test('getMainBranchId falls back to the oldest active branch of the same tenant', async () => {
        mockBranches.splice(0, 1); // drop A's 'main'

        await expect(getMainBranchId(reqFor(A_ID))).resolves.toBe(A_SUB);
    });

    test('getMainBranchId returns null for a tenant without active branches', async () => {
        const req = reqFor(oid());

        await expect(getMainBranchId(req)).resolves.toBeNull();
        expect(req._mainBranchIdCached).toBeNull();
    });

    test('getMainBranchId is cached per request and null without a tenant', async () => {
        const req = reqFor(A_ID);
        await getMainBranchId(req);
        await getMainBranchId(req);
        await expect(getMainBranchId(reqFor(null))).resolves.toBeNull();

        expect(mockBranch.findOne).toHaveBeenCalledTimes(1);
    });

    test('mergedBranchFilter: owner {} / sub-branch $in [own, main] / main-pinned own only', async () => {
        await expect(mergedBranchFilter(reqFor(A_ID, { role: 'admin', branch: null }))).resolves.toEqual({});
        await expect(mergedBranchFilter(reqFor(A_ID, { role: 'admin', branch: A_SUB }))).resolves.toEqual({ branch: { $in: [A_SUB, A_MAIN] } });
        await expect(mergedBranchFilter(reqFor(A_ID, { role: 'admin', branch: A_MAIN }))).resolves.toEqual({ branch: A_MAIN });
    });

    test("mergedBranchFilter never merges in another tenant's main branch", async () => {
        const filter = await mergedBranchFilter(reqFor(A_ID, { role: 'admin', branch: A_SUB }));

        expect(filter.branch.$in.map(String)).not.toContain(String(B_MAIN));
    });

    test.each([
        ['guest', null],
        ['customer', { role: 'customer' }],
    ])('mergedCustomerBranchFilter for a %s on a sub-branch → $in [selected, main]', async (_label, user) => {
        const req = reqFor(A_ID, user, { branch: { _id: A_SUB } });

        await expect(mergedCustomerBranchFilter(req)).resolves.toEqual({ branch: { $in: [A_SUB, A_MAIN] } });
    });

    test('mergedCustomerBranchFilter: guest on main → main only; pinned staff → own+main; unpinned staff → {}', async () => {
        await expect(mergedCustomerBranchFilter(reqFor(A_ID, null, { branch: { _id: A_MAIN } }))).resolves.toEqual({ branch: A_MAIN });
        await expect(mergedCustomerBranchFilter(reqFor(A_ID, { role: 'waiter', branch: A_SUB }))).resolves.toEqual({ branch: { $in: [A_SUB, A_MAIN] } });
        await expect(mergedCustomerBranchFilter(reqFor(A_ID, { role: 'waiter', branch: A_MAIN }))).resolves.toEqual({ branch: A_MAIN });
        await expect(mergedCustomerBranchFilter(reqFor(A_ID, { role: 'admin', branch: null }, { branch: { _id: A_SUB } }))).resolves.toEqual({});
        await expect(mergedCustomerBranchFilter(reqFor(A_ID, null))).resolves.toEqual({});
    });

    test('mergedCustomerBranchFilter for a guest of a tenant with no main → selected branch only', async () => {
        const T = oid();
        const sel = oid();

        await expect(mergedCustomerBranchFilter(reqFor(T, null, { branch: { _id: sel } }))).resolves.toEqual({ branch: sel });
    });

    test('isSubBranchCaller is true only for a pin that is not the main branch', async () => {
        await expect(isSubBranchCaller(reqFor(A_ID, { branch: A_SUB }))).resolves.toBe(true);
        await expect(isSubBranchCaller(reqFor(A_ID, { branch: A_MAIN }))).resolves.toBe(false);
        await expect(isSubBranchCaller(reqFor(A_ID, { branch: null }))).resolves.toBe(false);
        await expect(isSubBranchCaller(reqFor(oid(), { branch: A_SUB }))).resolves.toBe(false);
    });
});

// ── 8. createMainBranchFor ─────────────────────────────────────────────

describe('createMainBranchFor', () => {
    test("returns the tenant's existing main branch without creating another", async () => {
        const branch = await createMainBranchFor({ _id: A_ID, name: 'Tenant A' });

        expect(branch._id).toBe(A_MAIN);
        expect(mockBranch.create).not.toHaveBeenCalled();
        expect(mockBranch.findOne).toHaveBeenCalledWith({ restaurant: A_ID, slug: 'main' });
    });

    test("another tenant's 'main' branch does not count — a new one is created", async () => {
        const T = oid();

        const branch = await createMainBranchFor({ _id: T, name: 'Tenant C' });

        expect(mockBranch.create).toHaveBeenCalledTimes(1);
        expect(branch.restaurant).toBe(T);
        expect(branch.slug).toBe('main');
    });

    test('copies and clamps tenant fields to Branch limits', async () => {
        const T = oid();
        const by = oid();

        await createMainBranchFor({
            _id: T,
            name: 'N'.repeat(100),
            city: 'C'.repeat(100),
            contactPhone: ' 9'.repeat(20),
            contactEmail: '  Owner@Tenant.COM ',
            address: { line1: 'L'.repeat(250), line2: null, state: 'MH', pincode: '4110011234567890123456' },
        }, by);

        const doc = mockBranch.create.mock.calls[0][0];
        expect(doc).toEqual(expect.objectContaining({
            restaurant: T, slug: 'main', sortOrder: -1, isActive: true, createdBy: by,
            state: 'MH', addressLine2: '', country: 'India', contactEmail: 'owner@tenant.com',
        }));
        expect(doc.name).toHaveLength(80);
        expect(doc.city).toHaveLength(80);
        expect(doc.addressLine1).toHaveLength(200);
        expect(doc.postalCode).toHaveLength(20);
        expect(doc.contactPhone.length).toBeLessThanOrEqual(30);
    });

    test('missing optional fields become empty strings and createdBy is omitted', async () => {
        await createMainBranchFor({ _id: oid(), name: 'Bare' });

        const doc = mockBranch.create.mock.calls[0][0];
        expect(doc).toEqual(expect.objectContaining({
            name: 'Bare', addressLine1: '', city: '', postalCode: '', contactEmail: '', country: 'India',
        }));
        expect(doc.createdBy).toBeUndefined();
    });
});

// ── 9. installTenantAssertions ─────────────────────────────────────────

describe('installTenantAssertions', () => {
    // bufferCommands:false → a save that gets past the pre-save hooks fails
    // fast with a "before initial connection" MongooseError instead of
    // hanging; a hook rejection surfaces as its own error first.
    const opts = { bufferCommands: false };
    const scopedSchema = new mongoose.Schema({ restaurant: mongoose.Schema.Types.ObjectId, name: String }, opts);
    const ScopedBefore = mongoose.model('TenantAssertTestScoped', scopedSchema);
    const platformSchema = new mongoose.Schema({ restaurant: mongoose.Schema.Types.ObjectId }, opts);
    mongoose.model('AuditLog', platformSchema);
    const plainSchema = new mongoose.Schema({ name: String }, opts);
    mongoose.model('TenantAssertTestPlain', plainSchema);

    const MARKER = '__tenantAssertionInstalled__';
    let first;
    let second;
    beforeAll(() => {
        first = installTenantAssertions();
        second = installTenantAssertions();
    });

    test('hooks tenant-scoped schemas only; platform and field-less models are skipped', () => {
        expect(scopedSchema[MARKER]).toBe(true);
        expect(platformSchema[MARKER]).toBeUndefined();
        expect(plainSchema[MARKER]).toBeUndefined();
        expect(first.installed).toBeGreaterThanOrEqual(1);
        expect(first.skipped).toBeGreaterThanOrEqual(2);
    });

    test('is idempotent — a second call installs nothing', () => {
        expect(second.installed).toBe(0);
        expect(scopedSchema.s.hooks._pres.get('save').filter((h) => h.fn.name === 'rejectIfMissingTenant')).toHaveLength(1);
    });

    // Regression (fixed 2026-10): installTenantAssertions also hooks already-compiled models (prototype.$__middleware / _middleware).
    test('saving a tenant-scoped doc without restaurant is rejected with TENANT_FIELD_MISSING', async () => {
        const doc = new ScopedBefore({ name: 'orphan' });

        await expect(doc.save()).rejects.toMatchObject({ code: 'TENANT_FIELD_MISSING' });
    });

    // Regression (fixed 2026-10): the hook no longer takes next(); it throws to reject and returns to accept (Mongoose 9 / kareem 3).
    test('a valid document of a model compiled after install is not broken by the hook', async () => {
        const ScopedAfter = mongoose.model('TenantAssertTestScopedAfter', scopedSchema);
        const doc = new ScopedAfter({ name: 'ok', restaurant: A_ID });

        await expect(doc.save()).rejects.toThrow(/before initial connection/);
    });
});

// ── 10. tenantScopePlugin — gaps ───────────────────────────────────────

describe('tenantScopePlugin — gaps', () => {
    const schema = new mongoose.Schema({ restaurant: mongoose.Schema.Types.ObjectId, branch: mongoose.Schema.Types.ObjectId, status: String });
    schema.plugin(plugin);
    const Scoped = mongoose.model('TenantIsolationHelpersScoped', schema);

    async function runQueryPre(query) {
        await query._queryMiddleware.execPre(query.op, query, []);
        return [query]; // wrapped: a returned Query is thenable and would execute
    }
    async function runAggregatePre(agg) {
        await Scoped.hooks.execPre('aggregate', agg, []);
        return [agg];
    }
    let seq = 0;
    const inTenant = (tid, fn) => requestContext.runWithContext(
        { tenantId: tid, method: 'POST', path: `/api/v1/gap-${++seq}`, role: 'admin' }, fn);

    test.each([
        ['updateMany', () => Scoped.updateMany({ restaurant: B_ID }, { $set: { status: 'x' } })],
        ['deleteMany', () => Scoped.deleteMany({ restaurant: B_ID })],
        ['findOneAndUpdate', () => Scoped.findOneAndUpdate({ restaurant: B_ID }, { $set: { status: 'x' } })],
    ])('%s with an explicit tenant-B filter inside tenant A is kept (by design) and logged as a mismatch', async (_op, build) => {
        await inTenant(A_ID, async () => {
            const [q] = await runQueryPre(build());
            expect(q.getFilter()).toEqual({ restaurant: B_ID });
        });

        expect(logger.warn).toHaveBeenCalledWith('tenantScope.explicit-mismatch', expect.any(Object));
    });

    test('tenant B condition hidden in $and is kept but NOT logged as a mismatch', async () => {
        await inTenant(A_ID, async () => {
            const [q] = await runQueryPre(Scoped.updateMany({ $and: [{ restaurant: B_ID }] }, { $set: { status: 'x' } }));
            expect(q.getFilter()).toEqual({ $and: [{ restaurant: B_ID }] });
        });

        expect(logger.warn).not.toHaveBeenCalledWith('tenantScope.explicit-mismatch', expect.anything());
    });

    test('$or where only some branches name a tenant gets tenant A injected at top level', async () => {
        await inTenant(A_ID, async () => {
            const [q] = await runQueryPre(Scoped.find({ $or: [{ restaurant: B_ID }, { status: 'open' }] }));
            expect(String(q.getFilter().restaurant)).toBe(String(A_ID));
            expect(q.getFilter().$or).toHaveLength(2);
        });
    });

    test('aggregate with $lookup: outer pipeline is scoped, the sub-pipeline is left alone (documented limit)', async () => {
        const lookup = { $lookup: { from: 'orders', pipeline: [{ $match: { status: 'paid' } }], as: 'o' } };

        await inTenant(A_ID, async () => {
            const [agg] = await runAggregatePre(Scoped.aggregate([lookup]));
            expect(agg.pipeline()[0]).toEqual({ $match: { restaurant: A_ID } });
            expect(agg.pipeline()[1]).toBe(lookup);
            expect(agg.pipeline()[1].$lookup.pipeline).toEqual([{ $match: { status: 'paid' } }]);
        });
    });

    test('aggregate with an explicit tenant-B $match inside tenant A is not rewritten', async () => {
        await inTenant(A_ID, async () => {
            const [agg] = await runAggregatePre(Scoped.aggregate([{ $match: { restaurant: B_ID } }]));
            expect(agg.pipeline()).toEqual([{ $match: { restaurant: B_ID } }]);
        });
    });

    test('aggregate starting with an unscopable stage is left alone and logged', async () => {
        await inTenant(A_ID, async () => {
            const [agg] = await runAggregatePre(Scoped.aggregate([{ $collStats: { count: {} } }]));
            expect(agg.pipeline()).toEqual([{ $collStats: { count: {} } }]);
        });

        expect(logger.warn).toHaveBeenCalledWith('tenantScope.unscopable', expect.any(Object));
    });

    test('insertMany / bulkWrite are not hooked by the plugin (documented limit)', () => {
        const hookNames = (op) => (Scoped.schema.s.hooks._pres.get(op) || []).map((h) => h.fn.name);

        expect(hookNames('insertMany')).not.toContain('queryHook');
        expect(hookNames('bulkWrite')).not.toContain('queryHook');
        expect(hookNames('updateMany')).toContain('queryHook');
    });

    test('a tenant id that is not a valid ObjectId leaves the query untouched', async () => {
        await inTenant('not-an-id', async () => {
            const [q] = await runQueryPre(Scoped.find({ status: 'x' }));
            expect(q.getFilter()).toEqual({ status: 'x' });
        });
    });

    test('getTenantScopeStats reports injected / mismatch / unscopable counters', () => {
        const stats = plugin.getTenantScopeStats();

        expect(stats).toEqual(expect.objectContaining({
            injected: expect.any(Number), mismatches: expect.any(Number), unscopable: expect.any(Number),
        }));
        expect(stats.mismatches).toBeGreaterThan(0);
    });
});
