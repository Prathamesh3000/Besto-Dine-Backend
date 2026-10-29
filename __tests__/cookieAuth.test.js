/**
 * 3A.4 — cookie web sessions, CSRF, socket cookie auth, CSP.
 * Real authController / authMiddleware / cookieAuth / csp; only persistence
 * (User / RefreshSession / Shift / Restaurant / loginAttempts) is mocked.
 */
const request = require('supertest');
const express = require('express');
const helmet = require('helmet');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockUsers = [];
const wrapUser = (u) => u && Object.assign(u, { comparePassword: async (p) => p === u._pw });
const chain = (val) => { const p = Promise.resolve(val); p.select = () => p; p.lean = () => p; return p; };
jest.mock('../models/user', () => ({
    findOne: (f) => chain(wrapUser(mockUsers.find((u) => (!f.role || u.role === f.role) && u.email === f.email) || null)),
    find: (f) => chain(mockUsers.filter((u) => u.email === f.email).map(wrapUser)),
    findById: (id) => chain(wrapUser(mockUsers.find((u) => String(u._id) === String(id)) || null)),
    updateOne: async () => ({ modifiedCount: 1 }),
}));
jest.mock('../models/restaurant', () => ({ findOne: () => chain(null), findById: () => chain({ status: 'active', name: 'R' }), find: () => chain([]) }));
const mockSessions = [];
const mockSessionOps = [];
jest.mock('../models/refreshSession', () => ({
    create: async (d) => { mockSessions.push({ ...d }); return d; },
    findOneAndUpdate: async (f, upd) => {
        const s = mockSessions.find((x) => x.tokenHash === f.tokenHash && !x.revokedAt);
        if (!s) return null;
        const before = { ...s };
        Object.assign(s, upd.$set);
        return before;
    },
    findOne: () => ({ lean: async () => null }),
    updateOne: async (f, upd) => {
        mockSessionOps.push({ f, upd });
        const s = mockSessions.find((x) => x.tokenHash === f.tokenHash && !x.revokedAt);
        if (s) Object.assign(s, upd.$set);
        return { modifiedCount: s ? 1 : 0 };
    },
    updateMany: async () => ({}),
}));
jest.mock('../models/shift', () => ({ findOne: () => chain(null), create: async () => ({}) }));
jest.mock('../models/otp', () => ({ OtpSendCounter: {} }));
jest.mock('../utils/loginAttempts', () => ({
    accountKey: () => 'k', isExempt: () => false, maskKey: (k) => k, maxFails: () => 10, lockMs: () => 900000,
    getLock: async () => ({ locked: false, fails: 0 }), recordFailure: async () => ({ fails: 1 }), clear: async () => {},
}));

process.env.JWT_SECRET = 'unit-jwt-secret-for-cookie-auth-0123456789';
const logger = require('../utils/logger');
const cookieAuth = require('../utils/cookieAuth');
const authController = require('../controllers/authController');
const authMw = require('../middlewares/authMiddleware');
const csp = require('../utils/csp');
const socketUtil = require('../utils/socket');

const HOUR = 3600 * 1000;
const SAVED = { ...process.env };

const mkRes = () => {
    const r = { code: 200, body: null, cookies: [], cleared: [] };
    r.status = (s) => { r.code = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = () => r;
    r.cookie = (name, value, opts) => { r.cookies.push({ name, value, opts }); return r; };
    r.clearCookie = (name, opts) => { r.cleared.push({ name, opts }); return r; };
    r.end = () => r;
    return r;
};
const mkReq = (body, headers = {}) => ({ body, headers, query: {}, ip: '1.1.1.1' });
const cookie = (res, name) => res.cookies.find((c) => c.name === name);
const cookieHeader = (res) => res.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');

function addUser(over = {}) {
    const u = {
        _id: String(mockUsers.length + 1).padStart(24, '0'), email: 'a@x.test', role: 'admin', status: 'active',
        tokenVersion: 0, _pw: 'pw', password: 'h', restaurant: 'R1', name: 'A', twoFactor: { enabled: false }, ...over,
    };
    mockUsers.push(u);
    return u;
}
const doLogin = async (headers = {}, userOver = {}) => {
    addUser(userOver);
    const res = mkRes();
    await authController.login(mkReq({ email: 'a@x.test', password: 'pw' }, headers), res);
    return res;
};

beforeEach(() => {
    mockUsers.length = 0; mockSessions.length = 0; mockSessionOps.length = 0;
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
    process.env.JWT_SECRET = 'unit-jwt-secret-for-cookie-auth-0123456789';
    delete process.env.USE_COOKIE_AUTH;
    logger.warn.mockClear();
});
afterAll(() => { for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]; Object.assign(process.env, SAVED); });

describe('flag OFF (default)', () => {
    test('login sets no cookies and returns tokens in the body', async () => {
        const res = await doLogin();
        expect(res.cookies).toHaveLength(0);
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.csrfToken).toBeUndefined();
    });
    test('cookies are never read', () => {
        expect(cookieAuth.readAccessToken({ headers: { cookie: 'bd_at_staff=abc' } })).toBeNull();
        expect(cookieAuth.readRefreshToken({ headers: { cookie: 'bd_rt_staff=abc' } })).toBeNull();
        expect(authMw.readBearerToken({ headers: { cookie: 'bd_at_staff=abc' } })).toBeNull();
    });
    test('csrfGuard is a no-op', () => {
        const next = jest.fn();
        cookieAuth.csrfGuard(() => true)({ method: 'POST', headers: { cookie: 'bd_at_staff=abc' }, path: '/orders' }, mkRes(), next);
        expect(next).toHaveBeenCalled();
    });
});

describe('flag ON: cookies issued', () => {
    beforeEach(() => { process.env.USE_COOKIE_AUTH = 'true'; });

    test('staff login sets httpOnly access + refresh cookies and a readable CSRF cookie with correct flags', async () => {
        const res = await doLogin();
        const at = cookie(res, 'bd_at_staff');
        const rt = cookie(res, 'bd_rt_staff');
        const cs = cookie(res, 'bd_csrf');
        expect(at.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: false });
        expect(rt.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' });
        expect(cs.opts).toMatchObject({ httpOnly: false, sameSite: 'lax', path: '/' });
        // Max-Age = the 12h absolute staff cap (not the 30m JWT, not the sliding window)
        for (const c of [at, rt, cs]) {
            expect(c.opts.maxAge).toBeLessThanOrEqual(12 * HOUR);
            expect(c.opts.maxAge).toBeGreaterThan(12 * HOUR - 10000);
        }
        expect(cookieAuth.isValidCsrfToken(cs.value)).toBe(true);
        expect(at.value).toBe(res.body.token);      // bearer clients still get the body token
        expect(rt.value).toBe(res.body.refreshToken);
    });

    test('Secure in production; SameSite=None forces Secure; Strict honoured; domain optional', async () => {
        process.env.NODE_ENV = 'production';
        let res = await doLogin();
        expect(cookie(res, 'bd_at_staff').opts.secure).toBe(true);
        process.env.NODE_ENV = 'test';
        process.env.COOKIE_SAMESITE = 'none';
        mockUsers.length = 0;
        res = await doLogin();
        expect(cookie(res, 'bd_at_staff').opts).toMatchObject({ sameSite: 'none', secure: true });
        process.env.COOKIE_SAMESITE = 'strict';
        process.env.COOKIE_DOMAIN = '.bestodine.test';
        mockUsers.length = 0;
        res = await doLogin();
        expect(cookie(res, 'bd_at_staff').opts).toMatchObject({ sameSite: 'strict', domain: '.bestodine.test' });
    });

    test('cookie name follows the role audience; customer cap is 1h, superadmin 8h', async () => {
        let res = await doLogin({}, { role: 'customer' });
        expect(cookie(res, 'bd_at_customer').opts.maxAge).toBeLessThanOrEqual(1 * HOUR);
        mockUsers.length = 0;
        res = await doLogin({}, { role: 'superadmin' });
        expect(cookie(res, 'bd_at_platform').opts.maxAge).toBeLessThanOrEqual(8 * HOUR);
        expect(cookie(res, 'bd_at_staff')).toBeUndefined();
    });

    test('web opt-in header: tokens stay out of the body; non-secret hints + csrfToken returned', async () => {
        const res = await doLogin({ 'x-auth-mode': 'cookie' });
        expect(res.body.token).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
        expect(res.body.cookieAuth).toBe(true);
        expect(res.body.csrfToken).toBe(cookie(res, 'bd_csrf').value);
        expect(res.body.accessExpiresAt).toBeGreaterThan(Date.now());
        expect(res.body.sessionExpiresAt).toBeGreaterThan(res.body.accessExpiresAt);
        expect(JSON.stringify(res.body)).not.toContain(cookie(res, 'bd_at_staff').value);
    });
});

describe('flag ON: protect / precedence', () => {
    beforeEach(() => { process.env.USE_COOKIE_AUTH = 'true'; });

    test('cookie authenticates when there is no Authorization header', async () => {
        const res = await doLogin();
        const req = { headers: { cookie: cookieHeader(res), 'x-auth-audience': 'staff' } };
        expect(authMw.readBearerToken(req)).toBe(cookie(res, 'bd_at_staff').value);
        const out = mkRes(); const next = jest.fn();
        await authMw.protect(req, out, next);
        expect(next).toHaveBeenCalled();
        expect(req.user.email).toBe('a@x.test');
    });

    test('Authorization header wins over the cookie', async () => {
        const res = await doLogin();
        const req = { headers: { authorization: 'Bearer HEADERTOKEN', cookie: cookieHeader(res) } };
        expect(authMw.readBearerToken(req)).toBe('HEADERTOKEN');
    });

    test('audience hint selects the right cookie; ambiguity without a hint yields nothing', () => {
        const h = 'bd_at_staff=S; bd_at_customer=C';
        expect(cookieAuth.readAccessToken({ headers: { cookie: h, 'x-auth-audience': 'customer' } })).toBe('C');
        expect(cookieAuth.readAccessToken({ headers: { cookie: h, 'x-auth-audience': 'staff' } })).toBe('S');
        expect(cookieAuth.readAccessToken({ headers: { cookie: h } })).toBeNull();
        expect(cookieAuth.readAccessToken({ headers: { cookie: 'bd_at_customer=C' } })).toBe('C');
    });
});

describe('flag ON: refresh + logout', () => {
    beforeEach(() => { process.env.USE_COOKIE_AUTH = 'true'; });

    test('refresh works from the cookie alone, rotates it and reissues cookies', async () => {
        const login = await doLogin();
        const oldRt = cookie(login, 'bd_rt_staff').value;
        const res = mkRes();
        await authController.refresh(mkReq({}, { cookie: cookieHeader(login), 'x-auth-audience': 'staff', 'x-auth-mode': 'cookie' }), res);
        expect(res.code).toBe(200);
        expect(res.body.cookieAuth).toBe(true);
        expect(res.body.refreshToken).toBeUndefined();
        const newRt = cookie(res, 'bd_rt_staff').value;
        expect(newRt).not.toBe(oldRt);
        expect(cookie(res, 'bd_at_staff')).toBeTruthy();
        expect(mockSessions.filter((s) => !s.revokedAt)).toHaveLength(1);   // old one revoked, new live
    });

    test('refresh with a body token (mobile / old web) still works', async () => {
        const login = await doLogin();
        const res = mkRes();
        await authController.refresh(mkReq({ refreshToken: login.body.refreshToken }), res);
        expect(res.code).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
    });

    test('refresh with no token and no cookie is a 401', async () => {
        const res = mkRes();
        await authController.refresh(mkReq({}), res);
        expect(res.code).toBe(401);
    });

    test('logout revokes the cookie session server-side and clears only that audience', async () => {
        const login = await doLogin();
        const res = mkRes();
        await authController.logout(mkReq({}, { cookie: cookieHeader(login), 'x-auth-audience': 'staff' }), res);
        expect(res.code).toBe(200);
        expect(mockSessionOps).toHaveLength(1);
        expect(mockSessions[0].revokedAt).toBeInstanceOf(Date);
        const names = res.cleared.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(['bd_at_staff', 'bd_rt_staff']));
        expect(names).not.toContain('bd_at_customer');
        const rtClear = res.cleared.find((c) => c.name === 'bd_rt_staff');
        expect(rtClear.opts.path).toBe('/api/v1/auth');
        expect(rtClear.opts.maxAge).toBeUndefined();
    });

    test('logout with a body refresh token (bearer client) still revokes it', async () => {
        const login = await doLogin();
        const res = mkRes();
        await authController.logout(mkReq({ refreshToken: login.body.refreshToken }), res);
        expect(mockSessions[0].revokedAt).toBeInstanceOf(Date);
    });

    test('2FA completeLogin issues the same cookies', async () => {
        const u = addUser();
        const res = mkRes();
        await authController.completeLogin(mkReq({}, { 'x-auth-mode': 'cookie' }), res, u);
        expect(res.code).toBe(200);
        expect(cookie(res, 'bd_rt_staff')).toBeTruthy();
        expect(res.body.cookieAuth).toBe(true);
    });
});

describe('CSRF guard', () => {
    const allowed = (o) => o === 'https://app.test';
    const guard = () => cookieAuth.csrfGuard(allowed);
    const csrf = cookieAuth.newCsrfToken();
    const run = (req) => { const res = mkRes(); const next = jest.fn(); guard()({ body: {}, ...req }, res, next); return { res, next }; };
    beforeEach(() => { process.env.USE_COOKIE_AUTH = 'true'; });

    const base = { method: 'POST', path: '/orders', headers: { cookie: `bd_at_staff=jwt; bd_csrf=${csrf}`, origin: 'https://app.test' } };
    const withHeaders = (h) => ({ ...base, headers: { ...base.headers, ...h } });

    test('safe methods pass', () => {
        expect(run({ ...base, method: 'GET', headers: { cookie: 'bd_at_staff=jwt' } }).next).toHaveBeenCalled();
    });
    test('Authorization header requests are exempt (bearer clients unchanged)', () => {
        expect(run({ method: 'POST', path: '/orders', headers: { authorization: 'Bearer x', cookie: 'bd_at_staff=jwt' } }).next).toHaveBeenCalled();
    });
    test('no ambient cookie: nothing to protect', () => {
        expect(run({ method: 'POST', path: '/orders', headers: {} }).next).toHaveBeenCalled();
    });
    test('cookie-authenticated POST without the header is rejected', () => {
        const { res, next } = run(base);
        expect(next).not.toHaveBeenCalled();
        expect(res.code).toBe(403);
        expect(res.body.code).toBe('CSRF_INVALID');
    });
    test('header that does not match the cookie is rejected', () => {
        expect(run(withHeaders({ 'x-csrf-token': cookieAuth.newCsrfToken() })).res.code).toBe(403);
    });
    test('matching but forged (bad HMAC) token is rejected', () => {
        const forged = 'abc.def';
        expect(run(withHeaders({ cookie: `bd_at_staff=jwt; bd_csrf=${forged}`, 'x-csrf-token': forged })).res.code).toBe(403);
    });
    test('valid double-submit passes', () => {
        expect(run(withHeaders({ 'x-csrf-token': csrf })).next).toHaveBeenCalled();
    });
    test('foreign Origin is rejected even with a valid token', () => {
        const { res } = run(withHeaders({ 'x-csrf-token': csrf, origin: 'https://evil.test' }));
        expect(res.code).toBe(403);
        expect(res.body.code).toBe('CSRF_ORIGIN');
    });
    test('Referer is used when Origin is absent', () => {
        const h = { 'x-csrf-token': csrf, origin: undefined, referer: 'https://evil.test/page' };
        expect(run(withHeaders(h)).res.code).toBe(403);
        expect(run(withHeaders({ ...h, referer: 'https://app.test/page' })).next).toHaveBeenCalled();
    });
    test('login/2FA entry points skip double-submit but still check Origin', () => {
        expect(run({ ...base, path: '/auth/login' }).next).toHaveBeenCalled();
        expect(run({ ...base, path: '/auth/2fa/verify' }).next).toHaveBeenCalled();
        expect(run({ ...base, path: '/auth/login', headers: { ...base.headers, origin: 'https://evil.test' } }).res.code).toBe(403);
    });
    test('refresh from cookie needs the token; refresh with a body token does not', () => {
        expect(run({ ...base, path: '/auth/refresh' }).res.code).toBe(403);
        expect(run({ ...base, path: '/auth/refresh', body: { refreshToken: 'rt' } }).next).toHaveBeenCalled();
    });
    test('logout is exempt from double-submit (must work when the CSRF cookie is lost)', () => {
        expect(run({ ...base, path: '/auth/logout' }).next).toHaveBeenCalled();
    });
});

describe('socket.io cookie auth', () => {
    const hs = (headers, auth = {}) => ({ handshake: { headers, auth } });
    const allowed = (o) => o === 'https://app.test';
    beforeEach(() => { process.env.USE_COOKIE_AUTH = 'true'; });

    test('cookie token accepted from an allowed Origin, audience from auth.audience', () => {
        const s = hs({ origin: 'https://app.test', cookie: 'bd_at_staff=S; bd_at_customer=C' }, { audience: 'customer' });
        expect(socketUtil.cookieTokenForSocket(s, allowed)).toBe('C');
    });
    test('rejected from a foreign or missing Origin (cross-site WebSocket hijacking)', () => {
        expect(socketUtil.cookieTokenForSocket(hs({ origin: 'https://evil.test', cookie: 'bd_at_staff=S' }), allowed)).toBeNull();
        expect(socketUtil.cookieTokenForSocket(hs({ cookie: 'bd_at_staff=S' }), allowed)).toBeNull();
    });
    test("auth.audience 'none' (client chose guest) never falls back to the cookie", () => {
        const s = hs({ origin: 'https://app.test', cookie: 'bd_at_staff=S' }, { audience: 'none' });
        expect(socketUtil.cookieTokenForSocket(s, allowed)).toBeNull();
    });
    test('off when the flag is off', () => {
        delete process.env.USE_COOKIE_AUTH;
        expect(socketUtil.cookieTokenForSocket(hs({ origin: 'https://app.test', cookie: 'bd_at_staff=S' }), allowed)).toBeNull();
    });
});

describe('CSP', () => {
    const appWith = (env) => {
        const app = express();
        app.use(helmet({ contentSecurityPolicy: csp.helmetCspOption(env) }));
        app.use('/csp-report', require('../middlewares/cspReport').createCspReportRouter());
        app.get('/x', (req, res) => res.json({}));
        return app;
    };

    test('default mode is report-only: Report-Only header present, enforcing header absent', async () => {
        const res = await request(appWith({ NODE_ENV: 'test' })).get('/x');
        expect(res.headers['content-security-policy-report-only']).toContain("default-src 'self'");
        expect(res.headers['content-security-policy']).toBeUndefined();
    });
    test('policy covers the third parties the app uses', async () => {
        const h = (await request(appWith({ NODE_ENV: 'test' })).get('/x')).headers['content-security-policy-report-only'];
        for (const s of ['https://checkout.razorpay.com', 'https://api.razorpay.com', 'https://accounts.google.com/gsi/client',
            'https://res.cloudinary.com', 'https://images.unsplash.com', 'https://*.ingest.sentry.io',
            'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'data:', 'blob:', "object-src 'none'", "frame-ancestors 'self'", 'report-uri /csp-report']) {
            expect(h).toContain(s);
        }
        expect(h).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    });
    test('enforce mode uses the enforcing header; off sends none', async () => {
        const enf = await request(appWith({ NODE_ENV: 'test', CSP_MODE: 'enforce' })).get('/x');
        expect(enf.headers['content-security-policy']).toBeDefined();
        expect(enf.headers['content-security-policy-report-only']).toBeUndefined();
        const off = await request(appWith({ NODE_ENV: 'test', CSP_MODE: 'off' })).get('/x');
        expect(off.headers['content-security-policy']).toBeUndefined();
        expect(off.headers['content-security-policy-report-only']).toBeUndefined();
    });
    test('unknown CSP_MODE falls back to report-only; API origins add ws twins', () => {
        expect(csp.cspMode({ CSP_MODE: 'bogus' })).toBe('report-only');
        const d = csp.buildDirectives({ NODE_ENV: 'production', CSP_API_ORIGINS: 'https://api.bestodine.test' });
        expect(d['connect-src']).toEqual(expect.arrayContaining(['https://api.bestodine.test', 'wss://api.bestodine.test']));
    });
    test('/csp-report: 204, logs a summary, tiny cap, rate limited', async () => {
        const app = appWith({ NODE_ENV: 'test' });
        const body = { 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'https://x.test/a.png', 'document-uri': 'https://app.test/' } };
        const r = await request(app).post('/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(body));
        expect(r.status).toBe(204);
        expect(logger.warn).toHaveBeenCalledWith('csp.violation', expect.objectContaining({ directive: 'img-src', blocked: 'https://x.test/a.png' }));
        logger.warn.mockClear();
        const big = await request(app).post('/csp-report').set('Content-Type', 'application/csp-report').send('{"a":"' + 'x'.repeat(9000) + '"}');
        expect(big.status).toBe(204);
        expect(logger.warn).not.toHaveBeenCalled();
        for (let i = 0; i < 40; i++) await request(app).post('/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(body));
        expect(logger.warn.mock.calls.length).toBeLessThanOrEqual(30);
    });
});
