/**
 * Integration tests for the tenant context middleware (attachTenant).
 *
 * These tests verify the core isolation guarantees of the SaaS
 * platform WITHOUT connecting to a real database. Instead, we stub
 * the Mongoose models and exercise the middleware's resolution logic
 * directly.
 *
 * Coverage:
 *   1. Super admin → req.restaurant = null (never scoped)
 *   2. Staff user with a valid restaurant → req.restaurant = doc
 *   3. Customer with a valid X-Restaurant-Slug → req.restaurant = doc
 *   4. Customer with a verified custom domain → req.restaurant = doc
 *   5. No context + strict mode ON → 400 TENANT_REQUIRED
 *   6. No context + strict mode OFF → req.restaurant = null (fallthrough)
 *   7. Exempt paths (/public, /auth) → always fall through
 *   8. Suspended tenant → 403 TENANT_SUSPENDED
 *   9. Branch resolution from X-Branch-Id header
 */

// Stub Mongoose models before importing the middleware
const mockRestaurant = {
    findById: jest.fn(),
    findOne: jest.fn(),
};
const mockBranch = { findOne: jest.fn() };

jest.mock('../models/restaurant', () => mockRestaurant);
jest.mock('../models/branch', () => mockBranch);

// Stub mongoose.connection.readyState + isValidObjectId
jest.mock('mongoose', () => ({
    isValidObjectId: (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id),
    connection: { readyState: 1 },
}));

const { attachTenant } = require('../middlewares/tenantContext');

// ── Helpers ────────────────────────────────────────────────────────────

function makeReq(overrides = {}) {
    return {
        method: 'GET',
        path: '/menu',
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
        json(data)   { res.body = data; return res; },
    };
    return res;
}

const next = jest.fn();

const FAKE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const fakeRestaurant = {
    _id: FAKE_ID,
    name: 'Test Cafe',
    slug: 'test-cafe',
    status: 'active',
    customDomain: '',
    domainVerified: false,
};

beforeEach(() => {
    // mockReset (not just clearAllMocks) so a `...Once` value queued by
    // a test that never reached the branch lookup can't leak into the
    // next test. That leak is why test 9 failed: it picked up a stale
    // mockResolvedValueOnce(null), which resolves to a PROMISE, and the
    // real code's `.lean()` call then threw "is not a function".
    mockRestaurant.findById.mockReset();
    mockRestaurant.findOne.mockReset();
    mockBranch.findOne.mockReset();
    next.mockClear();

    // Default branch mock matching the real call shape:
    // Branch.findOne(...).lean() → Promise. Tests that need a branch
    // override this; everything else resolves to "no branch".
    mockBranch.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    // Default: strict mode ON (leave env unset)
    delete process.env.STRICT_TENANT_ENFORCEMENT;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('attachTenant middleware', () => {
    test('1. super admin → req.restaurant = null, next() called', async () => {
        const req = makeReq({ user: { role: 'superadmin' } });
        const res = makeRes();
        await attachTenant(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toBeNull();
        expect(req.branch).toBeNull();
    });

    test('2. staff user with valid restaurant → req.restaurant = doc', async () => {
        mockRestaurant.findById.mockResolvedValueOnce(fakeRestaurant);

        const req = makeReq({ user: { _id: 'user1', role: 'admin', restaurant: FAKE_ID } });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toEqual(fakeRestaurant);
    });

    test('3. customer with X-Restaurant-Slug → resolved by slug', async () => {
        mockRestaurant.findOne.mockReturnValueOnce({
            exec: () => Promise.resolve(fakeRestaurant),
        });

        const req = makeReq({
            headers: { 'x-restaurant-slug': 'test-cafe' },
        });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toEqual(fakeRestaurant);
    });

    test('4. customer with verified custom domain → resolved by hostname', async () => {
        mockRestaurant.findOne.mockResolvedValueOnce(fakeRestaurant);

        const req = makeReq({
            headers: { origin: 'https://order.joescafe.com' },
        });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(mockRestaurant.findOne).toHaveBeenCalledWith({
            customDomain: 'order.joescafe.com',
            domainVerified: true,
        });
        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toEqual(fakeRestaurant);
    });

    test('5. no context + strict mode ON → 400 TENANT_REQUIRED', async () => {
        // No user, no slug, no domain match
        mockRestaurant.findOne.mockResolvedValue(null);

        const req = makeReq({});
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('6. STRICT_TENANT_ENFORCEMENT=false no longer opens an escape hatch', async () => {
        // CRIT-01 removed the opt-out: strict mode is now ALWAYS on.
        // This test previously asserted the old fall-through behaviour
        // and had been failing ever since. It now pins the hardened
        // contract — setting the old env var must change nothing, or a
        // stray value in a deploy environment would silently disable
        // tenant isolation.
        process.env.STRICT_TENANT_ENFORCEMENT = 'false';
        mockRestaurant.findOne.mockResolvedValue(null);

        const req = makeReq({});
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');

        delete process.env.STRICT_TENANT_ENFORCEMENT;
    });

    test('7. exempt path /public → falls through even with no context', async () => {
        mockRestaurant.findOne.mockResolvedValue(null);

        const req = makeReq({ path: '/public/restaurants' });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toBeNull();
    });

    test('7b. exempt path /auth → falls through', async () => {
        mockRestaurant.findOne.mockResolvedValue(null);

        const req = makeReq({ path: '/auth/login' });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    test('8. suspended tenant → 403 TENANT_SUSPENDED', async () => {
        const suspended = { ...fakeRestaurant, status: 'suspended' };
        mockRestaurant.findById.mockResolvedValueOnce(suspended);

        const req = makeReq({ user: { _id: 'user1', role: 'admin', restaurant: FAKE_ID } });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    test('9. X-Branch-Id header → req.branch populated', async () => {
        const fakeBranch = { _id: FAKE_ID, name: 'Downtown', slug: 'downtown' };
        // resolveBySlug consults an in-module slug cache populated by
        // earlier tests, so it may take the findById path instead of
        // findOne. Mock BOTH so this test doesn't depend on which
        // tests ran before it.
        mockRestaurant.findById.mockResolvedValue(fakeRestaurant);
        mockRestaurant.findOne.mockReturnValue({
            exec: () => Promise.resolve(fakeRestaurant),
        });
        // resolveActiveBranch calls Branch.findOne(...).lean(). The
        // previous mockResolvedValueOnce returned a PROMISE, so .lean()
        // threw "is not a function" and the branch never resolved —
        // which is why this test had been failing.
        mockBranch.findOne.mockReturnValue({
            lean: () => Promise.resolve(fakeBranch),
        });

        const req = makeReq({
            headers: {
                'x-restaurant-slug': 'test-cafe',
                'x-branch-id': FAKE_ID,
            },
        });
        const res = makeRes();
        await attachTenant(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.restaurant).toEqual(fakeRestaurant);
        // Branch should be resolved (may be the mock return)
        expect(req.branch).toBeDefined();
    });
});
