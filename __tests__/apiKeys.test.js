/**
 * Tenant API keys: hashing / constant-time compare (utils/apiKeys), and the
 * apiKeyAuth middleware: scope enforcement, revoked / expired, tenant
 * context, feature gate, suspended tenants. Models are spied, no database.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/rateLimitStore', () => ({ makeLimiter: () => (req, res, next) => next() }));

const crypto = require('crypto');
const ApiKey = require('../models/apiKey');
const Restaurant = require('../models/restaurant');
const { generateApiKey, parseApiKey, verifySecret, sha256Hex } = require('../utils/apiKeys');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');
const { getContext } = require('../utils/requestContext');

describe('utils/apiKeys', () => {
    test('format bd_live_<prefix>_<secret>; only the secret hash is derived', () => {
        const { key, prefix, hash } = generateApiKey();
        expect(key).toMatch(/^bd_live_[0-9a-f]{10}_[0-9a-f]{48}$/);
        const parsed = parseApiKey(key);
        expect(parsed.prefix).toBe(prefix);
        expect(hash).toBe(sha256Hex(parsed.secret));
        expect(hash).not.toContain(parsed.secret);
        expect(key).not.toContain(hash);
    });

    test('keys are unique', () => {
        const a = generateApiKey(); const b = generateApiKey();
        expect(a.key).not.toBe(b.key);
        expect(a.prefix).not.toBe(b.prefix);
    });

    test('verifySecret accepts the right secret, rejects wrong / malformed input', () => {
        const { key, hash } = generateApiKey();
        const { secret } = parseApiKey(key);
        expect(verifySecret(secret, hash)).toBe(true);
        expect(verifySecret(secret + '0', hash)).toBe(false);
        expect(verifySecret('', hash)).toBe(false);
        expect(verifySecret(secret, 'not-hex')).toBe(false);
        expect(verifySecret(secret, '')).toBe(false);
        expect(verifySecret(undefined, hash)).toBe(false);
    });

    test('verifySecret uses crypto.timingSafeEqual', () => {
        const spy = jest.spyOn(crypto, 'timingSafeEqual');
        const { key, hash } = generateApiKey();
        verifySecret(parseApiKey(key).secret, hash);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('parseApiKey rejects garbage', () => {
        expect(parseApiKey('bd_live_xyz')).toBeNull();
        expect(parseApiKey('sk_live_' + 'a'.repeat(10) + '_' + 'b'.repeat(48))).toBeNull();
        expect(parseApiKey(null)).toBeNull();
    });
});

describe('apiKeyAuth middleware', () => {
    const RID = '64b000000000000000000001';
    let issued; let keyDoc; let restaurant;

    const mkRes = () => {
        const res = { statusCode: 200, body: null };
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    };
    const mkReq = (key, extra = {}) => ({
        headers: key ? { authorization: `Bearer ${key}` } : {},
        method: 'GET', path: '/orders', baseUrl: '/api/public/v1', ...extra,
    });
    const run = async (scope, req) => {
        const res = mkRes();
        let nextCalled = false; let ctx = null;
        await apiKeyAuth(scope)(req, res, () => { nextCalled = true; ctx = getContext(); });
        return { res, nextCalled, ctx };
    };

    beforeEach(() => {
        issued = generateApiKey();
        keyDoc = {
            _id: 'k1', restaurant: RID, name: 'POS', prefix: issued.prefix, hash: issued.hash,
            scopes: ['read:orders'], revokedAt: null, expiresAt: null, lastUsedAt: null,
        };
        restaurant = { _id: RID, status: 'active', subscription: { features: { publicApi: true } } };
        jest.spyOn(ApiKey, 'findOne').mockImplementation((q) => ({
            select: () => ({ setOptions: () => Promise.resolve(q.prefix === keyDoc.prefix ? keyDoc : null) }),
        }));
        jest.spyOn(ApiKey, 'updateOne').mockReturnValue(Promise.resolve({}));
        jest.spyOn(Restaurant, 'findById').mockImplementation(() => Promise.resolve(restaurant));
    });
    afterEach(() => jest.restoreAllMocks());

    test('valid key + scope: passes and sets tenant + context; query-string keys are not accepted', async () => {
        const { nextCalled, ctx, res } = await run('read:orders', mkReq(issued.key));
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(ctx.tenantId)).toBe(RID);
        const q = await run('read:orders', { ...mkReq(null), query: { api_key: issued.key } });
        expect(q.res.statusCode).toBe(401);
        expect(q.res.body.code).toBe('API_KEY_REQUIRED');
    });

    test('X-API-Key header is accepted', async () => {
        const { nextCalled } = await run('read:orders', { ...mkReq(null), headers: { 'x-api-key': issued.key } });
        expect(nextCalled).toBe(true);
    });

    test('missing / malformed / unknown / wrong-secret keys -> 401', async () => {
        expect((await run('read:orders', mkReq(null))).res.body.code).toBe('API_KEY_REQUIRED');
        expect((await run('read:orders', mkReq('nope'))).res.body.code).toBe('API_KEY_INVALID');
        const other = generateApiKey();
        expect((await run('read:orders', mkReq(other.key))).res.statusCode).toBe(401);
        const wrong = `bd_live_${issued.prefix}_${'0'.repeat(48)}`;
        const r = await run('read:orders', mkReq(wrong));
        expect(r.res.statusCode).toBe(401);
        expect(r.nextCalled).toBe(false);
    });

    test('revoked key -> 401 API_KEY_REVOKED', async () => {
        keyDoc.revokedAt = new Date();
        const r = await run('read:orders', mkReq(issued.key));
        expect(r.res.statusCode).toBe(401);
        expect(r.res.body.code).toBe('API_KEY_REVOKED');
        expect(r.nextCalled).toBe(false);
    });

    test('expired key -> 401 API_KEY_EXPIRED; future expiry is fine', async () => {
        keyDoc.expiresAt = new Date(Date.now() - 1000);
        expect((await run('read:orders', mkReq(issued.key))).res.body.code).toBe('API_KEY_EXPIRED');
        keyDoc.expiresAt = new Date(Date.now() + 86400000);
        expect((await run('read:orders', mkReq(issued.key))).nextCalled).toBe(true);
    });

    test('scope enforcement: a key without the scope is refused with 403', async () => {
        const r = await run('read:sales', mkReq(issued.key));
        expect(r.res.statusCode).toBe(403);
        expect(r.res.body.code).toBe('INSUFFICIENT_SCOPE');
        expect(r.nextCalled).toBe(false);
    });

    test('suspended tenant -> 403; missing publicApi feature -> 403 FEATURE_LOCKED; override grants it', async () => {
        restaurant.status = 'suspended';
        expect((await run('read:orders', mkReq(issued.key))).res.body.code).toBe('TENANT_SUSPENDED');
        restaurant.status = 'active';
        restaurant.subscription.features.publicApi = false;
        const r = await run('read:orders', mkReq(issued.key));
        expect(r.res.statusCode).toBe(403);
        expect(r.res.body.code).toBe('FEATURE_LOCKED');
        restaurant.featureOverrides = { publicApi: true };
        expect((await run('read:orders', mkReq(issued.key))).nextCalled).toBe(true);
    });

    test('tenant comes from the key, never from request headers', async () => {
        const req = mkReq(issued.key, { headers: { authorization: `Bearer ${issued.key}`, 'x-restaurant-slug': 'other-tenant' } });
        const r = await run('read:orders', req);
        expect(String(r.ctx.tenantId)).toBe(RID);
        expect(String(req.restaurant._id)).toBe(RID);
    });

    test('lastUsedAt is stamped (tenant-scoped) and the hash never reaches req', async () => {
        const req = mkReq(issued.key);
        await run('read:orders', req);
        expect(ApiKey.updateOne).toHaveBeenCalledWith({ _id: 'k1', restaurant: RID }, expect.any(Object));
        expect(req.apiKey.hash).toBeUndefined();
    });
});

describe('ApiKey model', () => {
    test('hash is not selected by default; restaurant is required', () => {
        expect(ApiKey.schema.path('hash').options.select).toBe(false);
        expect(ApiKey.schema.path('restaurant').options.required).toBe(true);
        expect(ApiKey.SCOPES).toEqual(['read:orders', 'read:menu', 'read:sales', 'read:inventory', 'read:bookings']);
    });
});
