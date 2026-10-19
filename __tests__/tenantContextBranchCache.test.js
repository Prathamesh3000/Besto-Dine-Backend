/**
 * middlewares/tenantContext — Main-branch and branch-state micro-caches
 * (2026-10-09 review items, fixed 2026-10-16).
 *
 *   1. mainBranchCache never caches a null result: a tenant whose Main
 *      branch does not exist yet (fresh signup) is re-resolved on the next
 *      request instead of hiding branch:null records for 60 s.
 *   2. Positive Main entries live 60 s, expire, and are dropped by
 *      invalidateBranchCache() (locally and via the cacheBus channel).
 *   3. `?branch=<id>` verdicts ({exists, isActive}) are cached per
 *      (tenant, branch) for 60 s with the same TTL / invalidation.
 *   4. A DEACTIVATED branch of the caller's own tenant: admin / manager
 *      GET → pass, admin / manager write → 409 BRANCH_INACTIVE, other
 *      roles → 404; unknown / foreign branch → 404 for everyone.
 *   5. Same matrix for the X-Branch-Id header path.
 */

const mockRestaurant = { findById: jest.fn(), findOne: jest.fn() };
const mockBranch = { findOne: jest.fn() };

jest.mock('../models/restaurant', () => mockRestaurant);
jest.mock('../models/branch', () => mockBranch);
jest.mock('mongoose', () => ({
    isValidObjectId: (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id),
    connection: { readyState: 1 },
}));

const cacheBus = require('../utils/cacheBus');
const { attachTenant, invalidateBranchCache, _branchCaches } = require('../middlewares/tenantContext');
const { mainBranchCache, branchStateCache, MAIN_BRANCH_TTL_MS, BRANCH_STATE_TTL_MS } = _branchCaches;

const RID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MAIN_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DEAD_ID = 'cccccccccccccccccccccccc';
const LIVE_ID = 'dddddddddddddddddddddddd';
const GHOST_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

const restaurant = { _id: RID, name: 'Cafe', slug: 'cafe', status: 'active' };

// In-memory "collection" the Branch.findOne mock answers from. The real
// code chains .select()/.sort()/.lean(); mimic a Mongoose query builder.
let branches = [];
function chain(result) {
    const c = { select: () => c, sort: () => c, lean: () => Promise.resolve(result) };
    return c;
}
function lookup(filter) {
    const inTenant = branches.filter((b) => String(b.restaurant) === String(filter.restaurant));
    if (filter._id) {
        const b = inTenant.find((x) => String(x._id) === String(filter._id));
        if (!b) return null;
        if (filter.isActive === true && b.isActive === false) return null;
        return b;
    }
    const active = inTenant.filter((b) => b.isActive !== false);
    if (filter.slug) return active.find((b) => b.slug === filter.slug) || null;
    return active[0] || null;
}
const idLookups = () => mockBranch.findOne.mock.calls.filter(([f]) => f && f._id).length;
const mainLookups = () => mockBranch.findOne.mock.calls.filter(([f]) => f && !f._id).length;

function makeReq(overrides = {}) {
    return {
        method: 'GET', path: '/orders/past', baseUrl: '/api/v1', headers: {}, query: {},
        user: { _id: 'u1', role: 'admin', restaurant: RID, branch: null },
        ...overrides,
    };
}
function makeRes() {
    const res = {
        statusCode: null, body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}
async function run(reqOverrides) {
    const req = makeReq(reqOverrides);
    const res = makeRes();
    const next = jest.fn();
    await attachTenant(req, res, next);
    return { req, res, next };
}

let now;
beforeEach(() => {
    mockRestaurant.findById.mockReset();
    mockRestaurant.findOne.mockReset();
    mockBranch.findOne.mockReset();
    mockRestaurant.findById.mockResolvedValue(restaurant);
    mockBranch.findOne.mockImplementation((filter) => chain(lookup(filter)));
    mainBranchCache.clear();
    branchStateCache.clear();
    branches = [
        { _id: MAIN_ID, restaurant: RID, slug: 'main', isActive: true },
        { _id: DEAD_ID, restaurant: RID, slug: 'closed', isActive: false },
        { _id: LIVE_ID, restaurant: RID, slug: 'live', isActive: true },
    ];
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

// ── Main branch cache ──────────────────────────────────────────────────

describe('mainBranchCache', () => {
    test('a tenant without a Main branch is NOT cached as "no Main"; the next request re-resolves', async () => {
        branches = [];                                   // fresh signup: createMainBranchFor not done yet
        const first = await run();
        expect(first.next).toHaveBeenCalled();
        expect(first.req.mainBranchId).toBeNull();
        expect(mainBranchCache.has(RID)).toBe(false);

        branches = [{ _id: MAIN_ID, restaurant: RID, slug: 'main', isActive: true }];
        const second = await run();
        expect(String(second.req.mainBranchId)).toBe(MAIN_ID);
        expect(mainBranchCache.get(RID)).toMatchObject({ id: MAIN_ID });
    });

    test('a resolved Main id is served from the cache until the 60 s TTL expires', async () => {
        await run();
        expect(mainLookups()).toBe(1);
        await run();
        await run();
        expect(mainLookups()).toBe(1);                   // cache hit, no Mongo
        now += MAIN_BRANCH_TTL_MS - 1;
        await run();
        expect(mainLookups()).toBe(1);
        now += 2;                                        // past expiry
        const { req } = await run();
        expect(mainLookups()).toBe(2);
        expect(String(req.mainBranchId)).toBe(MAIN_ID);
    });

    test('invalidateBranchCache(rid) drops the Main entry so a renamed Main is re-resolved at once', async () => {
        await run();
        expect(mainLookups()).toBe(1);
        branches[0].slug = 'headquarters';                // Main renamed: fallback is now oldest active
        branches.push({ _id: 'ffffffffffffffffffffffff', restaurant: RID, slug: 'main', isActive: true });
        await run();
        expect(mainLookups()).toBe(1);                   // still the stale cache without invalidation
        invalidateBranchCache(RID);
        const { req } = await run();
        expect(mainLookups()).toBe(2);
        expect(String(req.mainBranchId)).toBe('ffffffffffffffffffffffff');
    });

    test('invalidation only touches the given tenant', async () => {
        mainBranchCache.set('other', { id: 'x', expires: now + 1000 });
        branchStateCache.set('other:y', { exists: true, isActive: true, expires: now + 1000 });
        await run({ query: { branch: LIVE_ID } });
        expect(mainBranchCache.has(RID)).toBe(true);
        expect(branchStateCache.has(`${RID}:${LIVE_ID}`)).toBe(true);
        invalidateBranchCache(RID);
        expect(mainBranchCache.has(RID)).toBe(false);
        expect(branchStateCache.has(`${RID}:${LIVE_ID}`)).toBe(false);
        expect(mainBranchCache.has('other')).toBe(true);
        expect(branchStateCache.has('other:y')).toBe(true);
    });

    test('a cacheBus message from another instance clears both caches locally', async () => {
        await run({ query: { branch: LIVE_ID } });
        expect(mainBranchCache.has(RID)).toBe(true);
        cacheBus.deliver('tenantBranch', { restaurantId: RID });
        expect(mainBranchCache.has(RID)).toBe(false);
        expect(branchStateCache.size).toBe(0);
    });

    test('invalidateBranchCache publishes the tenant id on the tenantBranch channel', () => {
        const published = [];
        cacheBus.setTransport({ publish: (ch, msg) => published.push([ch, msg]) });
        try {
            invalidateBranchCache(RID);
            expect(published).toEqual([['tenantBranch', { restaurantId: RID }]]);
        } finally {
            cacheBus.setTransport(null);
        }
    });
});

// ── ?branch=<id> verdict cache ─────────────────────────────────────────

describe('branchStateCache for ?branch=<id>', () => {
    test('the existence check hits Mongo once per (tenant, branch) per minute', async () => {
        await run({ query: { branch: LIVE_ID } });
        await run({ query: { branch: LIVE_ID } });
        await run({ query: { branch: LIVE_ID } });
        expect(idLookups()).toBe(1);
        expect(branchStateCache.get(`${RID}:${LIVE_ID}`)).toMatchObject({ exists: true, isActive: true });

        now += BRANCH_STATE_TTL_MS + 1;
        await run({ query: { branch: LIVE_ID } });
        expect(idLookups()).toBe(2);
    });

    test('"not found" is cached too, and invalidation makes a newly created branch visible immediately', async () => {
        const miss = await run({ query: { branch: GHOST_ID } });
        expect(miss.res.statusCode).toBe(404);
        expect(branchStateCache.get(`${RID}:${GHOST_ID}`)).toMatchObject({ exists: false });

        branches.push({ _id: GHOST_ID, restaurant: RID, slug: 'new', isActive: true });
        expect((await run({ query: { branch: GHOST_ID } })).res.statusCode).toBe(404);   // stale verdict
        expect(idLookups()).toBe(1);

        invalidateBranchCache(RID);
        const hit = await run({ query: { branch: GHOST_ID } });
        expect(hit.next).toHaveBeenCalled();
        expect(idLookups()).toBe(2);
    });

    test('a branch deactivated then invalidated is refused for writes on the very next request', async () => {
        expect((await run({ method: 'POST', query: { branch: LIVE_ID } })).next).toHaveBeenCalled();
        branches.find((b) => b._id === LIVE_ID).isActive = false;
        invalidateBranchCache(RID);
        const { res, next } = await run({ method: 'POST', query: { branch: LIVE_ID } });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('BRANCH_INACTIVE');
    });
});

// ── Deactivated branch: role × method matrix ───────────────────────────

describe('?branch=<deactivated own branch>', () => {
    test.each([
        ['admin', 'GET'], ['admin', 'HEAD'], ['manager', 'GET'], ['manager', 'HEAD'],
    ])('%s %s → passes (history stays readable)', async (role, method) => {
        const { res, next } = await run({ method, user: { _id: 'u', role, restaurant: RID, branch: null }, query: { branch: DEAD_ID } });
        expect(res.statusCode).toBeNull();
        expect(next).toHaveBeenCalled();
    });

    test.each([
        ['admin', 'POST'], ['admin', 'PUT'], ['admin', 'PATCH'], ['admin', 'DELETE'],
        ['manager', 'POST'], ['manager', 'DELETE'],
    ])('%s %s → 409 BRANCH_INACTIVE', async (role, method) => {
        const { res, next } = await run({ method, user: { _id: 'u', role, restaurant: RID, branch: null }, query: { branch: DEAD_ID } });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({ success: false, code: 'BRANCH_INACTIVE' });
        expect(res.body.message).toMatch(/deactivated/i);
    });

    test.each(['waiter', 'captain', 'chef'])('%s GET → 404 BRANCH_NOT_FOUND (unchanged)', async (role) => {
        const { res, next } = await run({ user: { _id: 'u', role, restaurant: RID, branch: MAIN_ID }, query: { branch: DEAD_ID } });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('admin GET with an unknown / foreign branch id → still 404', async () => {
        const { res } = await run({ query: { branch: GHOST_ID } });
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('admin POST with an ACTIVE branch → passes', async () => {
        const { next } = await run({ method: 'POST', query: { branch: LIVE_ID } });
        expect(next).toHaveBeenCalled();
    });

    test('keywords all / tenant-only / none are left alone', async () => {
        for (const q of ['all', 'tenant-only', 'none']) {
            const { next } = await run({ query: { branch: q } });
            expect(next).toHaveBeenCalled();
        }
        expect(idLookups()).toBe(0);
    });
});

describe('X-Branch-Id naming a deactivated own branch', () => {
    test('admin GET → req.branch is the inactive branch', async () => {
        const { req, next } = await run({ headers: { 'x-branch-id': DEAD_ID } });
        expect(next).toHaveBeenCalled();
        expect(String(req.branch._id)).toBe(DEAD_ID);
    });

    test('admin POST → 409 BRANCH_INACTIVE', async () => {
        const { res, next } = await run({ method: 'POST', headers: { 'x-branch-id': DEAD_ID } });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('BRANCH_INACTIVE');
    });

    test('customer on the slug path → 404 BRANCH_NOT_FOUND (unchanged)', async () => {
        mockRestaurant.findOne.mockReturnValue({ exec: () => Promise.resolve(restaurant) });
        const { res, next } = await run({ user: null, headers: { 'x-restaurant-slug': 'cafe', 'x-branch-id': DEAD_ID } });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('admin GET with an active branch → req.branch set (unchanged)', async () => {
        const { req, next } = await run({ headers: { 'x-branch-id': LIVE_ID } });
        expect(next).toHaveBeenCalled();
        expect(String(req.branch._id)).toBe(LIVE_ID);
    });
});
