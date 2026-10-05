/**
 * middlewares/authMiddleware — unit contract.
 *
 * Every request that carries a session goes through `protect` or the
 * globally mounted `optionalAuth`, and every role gate (adminOnly,
 * checkPermission, adminExclusive, superAdmin*) trusts what those two
 * put on `req.user`. The properties pinned here are the ones whose
 * failure is an authentication bypass, not a UX glitch:
 *
 *   - token-type confusion: a table-scan or kiosk token (same
 *     JWT_SECRET) must never be accepted as a user session, and a user
 *     session must never pass as a scan / kiosk token;
 *   - revocation: a tokenVersion bump kills every outstanding token;
 *   - forged tokens (wrong secret, alg=none) and expired tokens fail;
 *   - deleted / deactivated users are rejected;
 *   - cookies are only read when USE_COOKIE_AUTH is on, and the
 *     Authorization header wins over a cookie.
 *
 * User.findById is mocked; jsonwebtoken is real, so signatures,
 * expiry and algorithm handling are the genuine library behaviour.
 */

const jwt = require('jsonwebtoken');

jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockFindById = jest.fn();
jest.mock('../models/user', () => ({
    findById: (...args) => mockFindById(...args),
}));

const mockUpdateContext = jest.fn();
jest.mock('../utils/requestContext', () => ({
    updateContext: (...args) => mockUpdateContext(...args),
}));

const SECRET = 'unit-test-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const SAVED_ENV = { ...process.env };
process.env.JWT_SECRET = SECRET;

const logger = require('../utils/logger');
const auth = require('../middlewares/authMiddleware');

const USER_ID = '64b000000000000000000001';

/** A user document as `User.findById(...).select('-password')` resolves it. */
function makeUser(overrides = {}) {
    return {
        _id: USER_ID,
        role: 'admin',
        status: 'active',
        tokenVersion: 0,
        ...overrides,
    };
}

/** findById(id).select(...) resolves to `value` (or rejects with it). */
function dbReturns(value) {
    mockFindById.mockImplementation(() => ({ select: () => Promise.resolve(value) }));
}
function dbRejects(err) {
    mockFindById.mockImplementation(() => ({ select: () => Promise.reject(err) }));
}

function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    res.cookie = jest.fn(() => res);
    res.clearCookie = jest.fn(() => res);
    return res;
}

function reqWith({ bearer, cookie, authorization, user, path } = {}) {
    const headers = {};
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (authorization) headers.authorization = authorization;
    if (cookie) headers.cookie = cookie;
    const req = { headers };
    if (user) req.user = user;
    if (path) req.path = path;
    return req;
}

/** Run a (possibly async) middleware; returns { req, res, next }. */
async function run(mw, req) {
    const res = mockRes();
    const next = jest.fn();
    await mw(req, res, next);
    return { req, res, next };
}

const statusOf = (res) => res.status.mock.calls[0]?.[0];
const bodyOf = (res) => res.json.mock.calls[0]?.[0];

const userToken = (overrides = {}) => auth.signAccessToken(makeUser(overrides));

beforeEach(() => {
    mockFindById.mockReset();
    mockUpdateContext.mockReset();
    logger.error.mockClear();
    delete process.env.USE_COOKIE_AUTH;
    delete process.env.ACCESS_TOKEN_TTL;
    delete process.env.SUPERADMIN_ACCESS_TOKEN_TTL;
    process.env.JWT_SECRET = SECRET;
});

afterAll(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in SAVED_ENV)) delete process.env[k];
    }
    Object.assign(process.env, SAVED_ENV);
});

// ─── signAccessToken ──────────────────────────────────────────────────

describe('signAccessToken', () => {
    test('carries id, role, typ=user and the tokenVersion', () => {
        const t = auth.signAccessToken(makeUser({ role: 'waiter', tokenVersion: 7 }));
        const p = jwt.verify(t, SECRET);
        expect(p).toMatchObject({ id: USER_ID, role: 'waiter', typ: 'user', tv: 7 });
    });

    test('a missing / garbage tokenVersion is signed as 0', () => {
        expect(jwt.decode(auth.signAccessToken(makeUser({ tokenVersion: undefined }))).tv).toBe(0);
        expect(jwt.decode(auth.signAccessToken(makeUser({ tokenVersion: 'x' }))).tv).toBe(0);
    });

    test('never embeds the password or any other user field', () => {
        const t = auth.signAccessToken(makeUser({ password: '$2a$12$hash', email: 'a@b.c' }));
        expect(Object.keys(jwt.decode(t)).sort()).toEqual(['exp', 'iat', 'id', 'role', 'tv', 'typ']);
    });

    test.each([
        ['admin', 30 * 60],
        ['customer', 30 * 60],
        ['superadmin', 15 * 60],
    ])('default lifetime for %s is %i s', (role, seconds) => {
        const p = jwt.decode(auth.signAccessToken(makeUser({ role })));
        expect(p.exp - p.iat).toBe(seconds);
    });

    test('ACCESS_TOKEN_TTL / SUPERADMIN_ACCESS_TOKEN_TTL override the defaults', () => {
        process.env.ACCESS_TOKEN_TTL = '5m';
        process.env.SUPERADMIN_ACCESS_TOKEN_TTL = '2m';
        const a = jwt.decode(auth.signAccessToken(makeUser({ role: 'chef' })));
        const s = jwt.decode(auth.signAccessToken(makeUser({ role: 'superadmin' })));
        expect(a.exp - a.iat).toBe(300);
        expect(s.exp - s.iat).toBe(120);
    });
});

// ─── verifyUserToken / verifyTypedToken: token-type confusion ─────────

describe('verifyUserToken — only user session tokens pass', () => {
    test('a freshly signed access token verifies', () => {
        expect(auth.verifyUserToken(userToken()).id).toBe(USER_ID);
    });

    test('a legacy (pre-typ) token with only an id is still accepted', () => {
        const legacy = jwt.sign({ id: USER_ID, role: 'admin' }, SECRET, { expiresIn: '5m' });
        expect(auth.verifyUserToken(legacy).id).toBe(USER_ID);
    });

    test.each([
        ['typed scan token', { typ: 'scan', tableId: 't1', sessionId: 's1' }],
        ['typed kiosk token', { typ: 'kiosk', kind: 'kiosk-track', orderId: 'o1' }],
        ['typed scan token that also carries an id', { typ: 'scan', id: USER_ID, tableId: 't1' }],
        ['legacy scan token shape', { tableId: 't1', id: USER_ID }],
        ['legacy kiosk token shape', { kind: 'kiosk-track', id: USER_ID }],
        ['legacy order token shape', { orderId: 'o1', id: USER_ID }],
        ['typ=user without an id', { typ: 'user', role: 'admin' }],
        ['unknown typ', { typ: 'refresh', id: USER_ID }],
        ['no id at all', { role: 'admin' }],
    ])('rejects a %s', (_label, payload) => {
        const t = jwt.sign(payload, SECRET, { expiresIn: '5m' });
        expect(() => auth.verifyUserToken(t)).toThrow(expect.objectContaining({ name: 'JsonWebTokenError' }));
    });

    test('rejects a token signed with another secret', () => {
        const t = jwt.sign({ id: USER_ID, typ: 'user', tv: 0 }, 'some-other-secret');
        expect(() => auth.verifyUserToken(t)).toThrow(expect.objectContaining({ name: 'JsonWebTokenError' }));
    });

    test('rejects an unsigned alg=none token', () => {
        const t = jwt.sign({ id: USER_ID, typ: 'user', tv: 0 }, null, { algorithm: 'none' });
        expect(() => auth.verifyUserToken(t)).toThrow(expect.objectContaining({ name: 'JsonWebTokenError' }));
    });

    test('rejects a token whose payload was tampered with (role escalation)', () => {
        const [h, , s] = userToken({ role: 'waiter' }).split('.');
        const forged = Buffer.from(JSON.stringify({ id: USER_ID, role: 'superadmin', typ: 'user', tv: 0 })).toString('base64url');
        expect(() => auth.verifyUserToken(`${h}.${forged}.${s}`)).toThrow();
    });

    test('an opaque refresh token is not an access token', () => {
        const refresh = require('crypto').randomBytes(32).toString('base64url');
        expect(() => auth.verifyUserToken(refresh)).toThrow(expect.objectContaining({ name: 'JsonWebTokenError' }));
    });

    test('an expired token throws TokenExpiredError', () => {
        jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
        try {
            const t = userToken();
            jest.setSystemTime(new Date('2026-01-01T00:31:00Z'));
            expect(() => auth.verifyUserToken(t)).toThrow(expect.objectContaining({ name: 'TokenExpiredError' }));
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('verifyTypedToken — scan / kiosk tokens', () => {
    const { SCAN, KIOSK, USER } = auth.TOKEN_TYPES;

    test('TOKEN_TYPES is frozen', () => {
        expect(Object.isFrozen(auth.TOKEN_TYPES)).toBe(true);
        expect(auth.TOKEN_TYPES).toEqual({ USER: 'user', SCAN: 'scan', KIOSK: 'kiosk' });
    });

    test('signTypedToken stamps typ and round-trips through verifyTypedToken', () => {
        const t = auth.signTypedToken(SCAN, { tableId: 't1', sessionId: 's1' }, { expiresIn: '5m' });
        expect(auth.verifyTypedToken(t, SCAN)).toMatchObject({ typ: 'scan', tableId: 't1' });
    });

    test('signTypedToken cannot be talked into a different typ by the payload', () => {
        const t = auth.signTypedToken(SCAN, { tableId: 't1', typ: USER, id: USER_ID }, { expiresIn: '5m' });
        expect(jwt.decode(t).typ).toBe(SCAN);
        expect(() => auth.verifyUserToken(t)).toThrow();
    });

    test.each([
        ['user access token as scan', () => userToken(), SCAN],
        ['user access token as kiosk', () => userToken(), KIOSK],
        ['scan token as kiosk', () => auth.signTypedToken(SCAN, { tableId: 't1' }), KIOSK],
        ['kiosk token as scan', () => auth.signTypedToken(KIOSK, { kind: 'kiosk-track', orderId: 'o' }), SCAN],
        ['legacy scan shape that also carries a user id', () => jwt.sign({ tableId: 't1', id: USER_ID }, SECRET), SCAN],
        ['legacy kiosk shape that also carries a user id', () => jwt.sign({ kind: 'kiosk-track', id: USER_ID }, SECRET), KIOSK],
        ['legacy user token as scan', () => jwt.sign({ id: USER_ID }, SECRET), SCAN],
    ])('rejects %s', (_label, mint, typ) => {
        expect(() => auth.verifyTypedToken(mint(), typ)).toThrow(expect.objectContaining({ name: 'JsonWebTokenError' }));
    });

    test.each([
        ['legacy scan', { tableId: 't1', sessionId: 's' }, SCAN],
        ['legacy kiosk', { kind: 'kiosk-track', orderId: 'o' }, KIOSK],
    ])('accepts a %s token shape without typ', (_label, payload, typ) => {
        expect(auth.verifyTypedToken(jwt.sign(payload, SECRET), typ)).toMatchObject(payload);
    });

    test('a scan token signed with another secret is rejected', () => {
        const t = jwt.sign({ typ: SCAN, tableId: 't1' }, 'wrong-secret');
        expect(() => auth.verifyTypedToken(t, SCAN)).toThrow();
    });
});

// ─── loadUserForToken: revocation ────────────────────────────────────

describe('loadUserForToken', () => {
    test('loads the user without the password field', async () => {
        const select = jest.fn().mockResolvedValue(makeUser());
        mockFindById.mockReturnValue({ select });
        await auth.loadUserForToken({ id: USER_ID, tv: 0 });
        expect(mockFindById).toHaveBeenCalledWith(USER_ID);
        expect(select).toHaveBeenCalledWith('-password');
    });

    test.each([
        ['token tv behind the user', { tv: 1 }, { tokenVersion: 2 }, false],
        ['token tv ahead of the user', { tv: 3 }, { tokenVersion: 2 }, false],
        ['matching tv', { tv: 2 }, { tokenVersion: 2 }, true],
        ['legacy token (no tv) vs never-bumped user', {}, { tokenVersion: undefined }, true],
        ['legacy token (no tv) after a bump', {}, { tokenVersion: 1 }, false],
    ])('%s', async (_label, claims, userFields, ok) => {
        dbReturns(makeUser(userFields));
        const user = await auth.loadUserForToken({ id: USER_ID, ...claims });
        expect(!!user).toBe(ok);
    });

    test('a deleted user resolves to null', async () => {
        dbReturns(null);
        expect(await auth.loadUserForToken({ id: USER_ID, tv: 0 })).toBeNull();
    });
});

// ─── protect ──────────────────────────────────────────────────────────

describe('protect', () => {
    test('no token → 401 and no DB lookup', async () => {
        const { res, next } = await run(auth.protect, reqWith());
        expect(statusOf(res)).toBe(401);
        expect(bodyOf(res).message).toMatch(/no token/);
        expect(next).not.toHaveBeenCalled();
        expect(mockFindById).not.toHaveBeenCalled();
    });

    test.each([
        ['Basic scheme', 'Basic dXNlcjpwYXNz'],
        ['lowercase bearer', 'bearer abc'],
        ['raw token without scheme', 'eyJhbGciOi'],
    ])('a non-Bearer Authorization header (%s) is treated as no token', async (_l, header) => {
        const { res, next } = await run(auth.protect, reqWith({ authorization: header }));
        expect(statusOf(res)).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('a valid token loads the user, records the request context and calls next', async () => {
        const user = makeUser({ role: 'manager' });
        dbReturns(user);
        const { req, res, next } = await run(auth.protect, reqWith({ bearer: userToken() }));
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(req.user).toBe(user);
        expect(mockUpdateContext).toHaveBeenCalledWith({ userId: USER_ID, role: 'manager', isSuperadmin: false });
    });

    test('a superadmin is flagged on the request context', async () => {
        dbReturns(makeUser({ role: 'superadmin' }));
        await run(auth.protect, reqWith({ bearer: userToken({ role: 'superadmin' }) }));
        expect(mockUpdateContext).toHaveBeenCalledWith(expect.objectContaining({ isSuperadmin: true }));
    });

    test('a revoked token (tokenVersion bumped) → 401 SESSION_REVOKED', async () => {
        dbReturns(makeUser({ tokenVersion: 1 }));
        const { res, next } = await run(auth.protect, reqWith({ bearer: userToken({ tokenVersion: 0 }) }));
        expect(statusOf(res)).toBe(401);
        expect(bodyOf(res).code).toBe('SESSION_REVOKED');
        expect(next).not.toHaveBeenCalled();
    });

    test('a deleted user → 401 SESSION_REVOKED', async () => {
        dbReturns(null);
        const { res, next } = await run(auth.protect, reqWith({ bearer: userToken() }));
        expect(statusOf(res)).toBe(401);
        expect(bodyOf(res).code).toBe('SESSION_REVOKED');
        expect(next).not.toHaveBeenCalled();
    });

    test('a deactivated user → 401 and no context update', async () => {
        dbReturns(makeUser({ status: 'inactive' }));
        const { res, next } = await run(auth.protect, reqWith({ bearer: userToken() }));
        expect(statusOf(res)).toBe(401);
        expect(bodyOf(res).message).toMatch(/deactivated/);
        expect(next).not.toHaveBeenCalled();
        expect(mockUpdateContext).not.toHaveBeenCalled();
    });

    test('an expired token → 401 TOKEN_EXPIRED, not logged as an error', async () => {
        jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
        try {
            const t = userToken();
            jest.setSystemTime(new Date('2026-01-01T01:00:00Z'));
            const { res, next } = await run(auth.protect, reqWith({ bearer: t }));
            expect(statusOf(res)).toBe(401);
            expect(bodyOf(res).code).toBe('TOKEN_EXPIRED');
            expect(next).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    test.each([
        ['scan token', () => auth.signTypedToken('scan', { tableId: 't1', sessionId: 's' }, { expiresIn: '5m' })],
        ['kiosk token', () => auth.signTypedToken('kiosk', { kind: 'kiosk-track', orderId: 'o' }, { expiresIn: '5m' })],
        ['token signed with another secret', () => jwt.sign({ id: USER_ID, typ: 'user', tv: 0 }, 'nope')],
        ['alg=none token', () => jwt.sign({ id: USER_ID, typ: 'user', tv: 0 }, null, { algorithm: 'none' })],
        ['opaque refresh token', () => require('crypto').randomBytes(32).toString('base64url')],
        ['garbage', () => 'not.a.jwt'],
    ])('%s → 401 token failed, user never loaded', async (_label, mint) => {
        const { res, next } = await run(auth.protect, reqWith({ bearer: mint() }));
        expect(statusOf(res)).toBe(401);
        expect(bodyOf(res).message).toBe('Not authorized, token failed');
        expect(next).not.toHaveBeenCalled();
        expect(mockFindById).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    test.each(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError'])(
        'a DB outage (%s) is a 503, not a logout',
        async (name) => {
            const err = new Error('db down');
            err.name = name;
            dbRejects(err);
            const { res, next } = await run(auth.protect, reqWith({ bearer: userToken() }));
            expect(statusOf(res)).toBe(503);
            expect(next).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalled();
        },
    );

    test('an unexpected error is logged and answered 401 (fail closed)', async () => {
        dbRejects(new TypeError('boom'));
        const { res, next } = await run(auth.protect, reqWith({ bearer: userToken() }));
        expect(statusOf(res)).toBe(401);
        expect(next).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    describe('fast path (optionalAuth already populated req.user)', () => {
        test('active user → next without re-verifying', async () => {
            const { next } = await run(auth.protect, reqWith({ user: makeUser(), bearer: 'ignored' }));
            expect(next).toHaveBeenCalledTimes(1);
            expect(mockFindById).not.toHaveBeenCalled();
        });

        test('inactive user → 401', async () => {
            const { res, next } = await run(auth.protect, reqWith({ user: makeUser({ status: 'inactive' }) }));
            expect(statusOf(res)).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });
    });
});

// ─── Cookie vs bearer (CRIT-08) ───────────────────────────────────────

describe('cookie auth', () => {
    const cookieFor = (t) => `theme=dark; ${auth.AUTH_COOKIE_NAME}=${encodeURIComponent(t)}; other=1`;

    test.each([[undefined, false], ['', false], ['false', false], ['true', true], ['1', true], [' YES ', true]])(
        'USE_COOKIE_AUTH=%p → enabled %p',
        (value, enabled) => {
            if (value === undefined) delete process.env.USE_COOKIE_AUTH;
            else process.env.USE_COOKIE_AUTH = value;
            expect(auth.isCookieAuthEnabled()).toBe(enabled);
        },
    );

    test('flag off: a session cookie alone does not authenticate', async () => {
        const { res, next } = await run(auth.protect, reqWith({ cookie: cookieFor(userToken()) }));
        expect(statusOf(res)).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('flag on: the cookie authenticates', async () => {
        process.env.USE_COOKIE_AUTH = 'true';
        dbReturns(makeUser());
        const { next } = await run(auth.protect, reqWith({ cookie: cookieFor(userToken()) }));
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('flag on: the Authorization header wins over the cookie', async () => {
        process.env.USE_COOKIE_AUTH = 'true';
        const headerTok = 'header-token';
        const req = reqWith({ bearer: headerTok, cookie: cookieFor('cookie-token') });
        expect(auth.readBearerToken(req)).toBe(headerTok);
    });

    test('flag on: malformed / missing cookies yield no token', () => {
        process.env.USE_COOKIE_AUTH = 'true';
        expect(auth.readBearerToken(reqWith({ cookie: `${auth.AUTH_COOKIE_NAME}=%E0%A4%A` }))).toBeNull();
        expect(auth.readBearerToken(reqWith({ cookie: 'novalue; x=1' }))).toBeNull();
        expect(auth.readBearerToken(reqWith({}))).toBeNull();
        // Name must match exactly, not as a prefix/suffix.
        expect(auth.readBearerToken(reqWith({ cookie: `x${auth.AUTH_COOKIE_NAME}=abc` }))).toBeNull();
    });

    test('setAuthCookie is a no-op while the flag is off', () => {
        const res = mockRes();
        auth.setAuthCookie(res, userToken());
        expect(res.cookie).not.toHaveBeenCalled();
    });

    test('setAuthCookie: httpOnly, SameSite=Strict, /api, never outlives the JWT', () => {
        process.env.USE_COOKIE_AUTH = 'true';
        const res = mockRes();
        const t = userToken();
        auth.setAuthCookie(res, t);
        const [name, value, opts] = res.cookie.mock.calls[0];
        expect(name).toBe(auth.AUTH_COOKIE_NAME);
        expect(value).toBe(t);
        expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api' });
        expect(opts.maxAge).toBeGreaterThan(29 * 60 * 1000);
        expect(opts.maxAge).toBeLessThanOrEqual(30 * 60 * 1000);
    });

    test('setAuthCookie falls back to 30 min for an undecodable token', () => {
        process.env.USE_COOKIE_AUTH = 'true';
        const res = mockRes();
        auth.setAuthCookie(res, 'garbage');
        expect(res.cookie.mock.calls[0][2].maxAge).toBe(30 * 60 * 1000);
    });

    test('Secure is set in production', () => {
        process.env.USE_COOKIE_AUTH = 'true';
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const res = mockRes();
            auth.setAuthCookie(res, userToken());
            expect(res.cookie.mock.calls[0][2].secure).toBe(true);
        } finally {
            process.env.NODE_ENV = saved;
        }
    });

    test('clearAuthCookie always clears both paths, even with the flag off', () => {
        const res = mockRes();
        auth.clearAuthCookie(res);
        expect(res.clearCookie).toHaveBeenCalledWith(auth.AUTH_COOKIE_NAME, { path: '/api' });
        expect(res.clearCookie).toHaveBeenCalledWith(auth.AUTH_COOKIE_NAME, { path: '/' });
    });
});

// ─── optionalAuth ─────────────────────────────────────────────────────

describe('optionalAuth', () => {
    test('no token → guest, next()', async () => {
        const { req, next } = await run(auth.optionalAuth, reqWith());
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('valid token → req.user set', async () => {
        const user = makeUser();
        dbReturns(user);
        const { req, next } = await run(auth.optionalAuth, reqWith({ bearer: userToken() }));
        expect(req.user).toBe(user);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['inactive user', () => dbReturns(makeUser({ status: 'inactive' })), () => userToken()],
        ['user with an unknown status', () => dbReturns(makeUser({ status: undefined })), () => userToken()],
        ['revoked token', () => dbReturns(makeUser({ tokenVersion: 5 })), () => userToken()],
        ['deleted user', () => dbReturns(null), () => userToken()],
        ['scan token', () => dbReturns(makeUser()), () => auth.signTypedToken('scan', { tableId: 't' })],
        ['forged token', () => dbReturns(makeUser()), () => jwt.sign({ id: USER_ID, typ: 'user' }, 'x')],
        ['DB outage', () => dbRejects(Object.assign(new Error('x'), { name: 'MongoNetworkError' })), () => userToken()],
    ])('%s → continue as guest (never 401)', async (_label, arrange, mint) => {
        arrange();
        const { req, res, next } = await run(auth.optionalAuth, reqWith({ bearer: mint() }));
        expect(req.user).toBeUndefined();
        expect(res.status).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });
});

// ─── Role gates ───────────────────────────────────────────────────────

const ALL_ROLES = ['customer', 'waiter', 'chef', 'captain', 'manager', 'admin', 'superadmin'];

describe.each([
    ['adminOnly', () => auth.adminOnly, ['admin', 'manager']],
    ['captainOrAdmin', () => auth.captainOrAdmin, ['captain', 'admin', 'manager']],
    ['staffOnly', () => auth.staffOnly, ['waiter', 'captain', 'chef', 'manager', 'admin']],
    ['superAdminOnly', () => auth.superAdminOnly, ['superadmin']],
    ['restrictTo(waiter, admin)', () => auth.restrictTo('waiter', 'admin'), ['waiter', 'admin']],
])('%s', (_name, getMw, allowed) => {
    test.each(ALL_ROLES)('role %s', async (role) => {
        const { res, next } = await run(getMw(), reqWith({ user: makeUser({ role }) }));
        if (allowed.includes(role)) {
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.status).not.toHaveBeenCalled();
        } else {
            expect(statusOf(res)).toBe(403);
            expect(next).not.toHaveBeenCalled();
        }
    });
});

describe.each([
    ['adminOnly', () => auth.adminOnly],
    ['captainOrAdmin', () => auth.captainOrAdmin],
    ['staffOnly', () => auth.staffOnly],
    ['superAdminOnly', () => auth.superAdminOnly],
    ['superAdminFull', () => auth.superAdminFull],
    ['adminExclusive', () => auth.adminExclusive],
    ['checkPermission', () => auth.checkPermission('editMenu')],
])('%s without req.user', (_name, getMw) => {
    test('→ 403, never next()', async () => {
        const { res, next } = await run(getMw(), reqWith());
        expect(statusOf(res)).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('restrictTo', () => {
    test('a role name is matched exactly (no substring / case games)', async () => {
        const mw = auth.restrictTo('admin');
        for (const role of ['Admin', 'ADMIN', 'superadmin', 'admin ', '']) {
            // eslint-disable-next-line no-await-in-loop
            const { next } = await run(mw, reqWith({ user: makeUser({ role }) }));
            expect(next).not.toHaveBeenCalled();
        }
    });
});

describe('superAdminFull', () => {
    test.each([
        ['superadmin', 'full', true],
        ['superadmin', 'support', false],
        ['superadmin', undefined, false],
        ['admin', 'full', false],
    ])('role=%s level=%s → allowed %p', async (role, superadminLevel, ok) => {
        const { res, next } = await run(auth.superAdminFull, reqWith({ user: makeUser({ role, superadminLevel }) }));
        expect(next).toHaveBeenCalledTimes(ok ? 1 : 0);
        if (!ok) expect(statusOf(res)).toBe(403);
    });
});

describe('adminExclusive (owner only)', () => {
    test.each([
        ['admin', true, true],
        ['admin', false, false],
        ['admin', 'true', false],   // must be the boolean, not a truthy string
        ['admin', undefined, false],
        ['manager', true, false],
        ['superadmin', true, false],
    ])('role=%s isTenantOwner=%p → allowed %p', async (role, isTenantOwner, ok) => {
        const { res, next } = await run(auth.adminExclusive, reqWith({ user: makeUser({ role, isTenantOwner }) }));
        expect(next).toHaveBeenCalledTimes(ok ? 1 : 0);
        if (!ok) {
            expect(statusOf(res)).toBe(403);
            expect(bodyOf(res).code).toBe('OWNER_ONLY');
        }
    });
});

describe('checkPermission', () => {
    const mw = auth.checkPermission('editMenu');

    test('admin bypasses even with an empty / missing permissions map', async () => {
        for (const permissions of [undefined, {}, { editMenu: false }]) {
            // eslint-disable-next-line no-await-in-loop
            const { next } = await run(mw, reqWith({ user: makeUser({ role: 'admin', permissions }) }));
            expect(next).toHaveBeenCalledTimes(1);
        }
    });

    test.each([
        ['manager', { editMenu: true }, true],
        ['manager', { editMenu: false }, false],
        ['manager', {}, false],
        ['manager', undefined, false],
        ['waiter', { editMenu: true }, true],
        ['chef', { accessKitchen: true }, false],
        ['waiter', { editMenu: 'true' }, false],  // strict === true
        ['waiter', { editMenu: 1 }, false],
        ['customer', { editMenu: true }, true],    // the gate checks the flag only; route pairs it with a role gate
        ['superadmin', {}, false],                // no superadmin bypass
    ])('%s with %p → allowed %p', async (role, permissions, ok) => {
        const { res, next } = await run(mw, reqWith({ user: makeUser({ role, permissions }) }));
        expect(next).toHaveBeenCalledTimes(ok ? 1 : 0);
        if (!ok) {
            expect(statusOf(res)).toBe(403);
            expect(bodyOf(res).message).toContain('editMenu');
        }
    });

    test('a flag inherited through the prototype chain is honoured (pinned behaviour)', async () => {
        // perms[key] reads through the prototype chain — pinned so a
        // future change to hasOwnProperty is a conscious decision.
        const permissions = Object.create({ editMenu: true });
        const { next } = await run(mw, reqWith({ user: makeUser({ role: 'waiter', permissions }) }));
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('requirePasswordCurrent', () => {
    test('no user / flag off → next', async () => {
        expect((await run(auth.requirePasswordCurrent, reqWith({ path: '/orders' }))).next).toHaveBeenCalled();
        expect((await run(auth.requirePasswordCurrent, reqWith({ path: '/orders', user: makeUser() }))).next).toHaveBeenCalled();
    });

    test.each(['/auth/me', '/auth/change-password', '/auth/refresh', '/auth/logout', '/auth/logout-all'])(
        'flag on: %s is allowed',
        async (path) => {
            const { next } = await run(auth.requirePasswordCurrent, reqWith({ path, user: makeUser({ mustChangePassword: true }) }));
            expect(next).toHaveBeenCalledTimes(1);
        },
    );

    test.each(['/orders', '/auth/profile', '/auth/me/', '/auth/change-password-x', '/AUTH/ME'])(
        'flag on: %s → 403 PASSWORD_CHANGE_REQUIRED',
        async (path) => {
            const { res, next } = await run(auth.requirePasswordCurrent, reqWith({ path, user: makeUser({ mustChangePassword: true }) }));
            expect(next).not.toHaveBeenCalled();
            expect(statusOf(res)).toBe(403);
            expect(bodyOf(res).code).toBe('PASSWORD_CHANGE_REQUIRED');
        },
    );
});
