/**
 * controllers/twoFactorController — challenge token, lockout, replay,
 * recovery single-use, enable/disable. Mongoose models are mocked with a
 * tiny in-memory User store; jsonwebtoken and utils/totp are real.
 */
const jwt = require('jsonwebtoken');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockUsers = new Map();
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const set = (o, p, v) => { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach((k) => { c[k] = c[k] || {}; c = c[k]; }); c[ks[ks.length - 1]] = v; };
const unset = (o, p) => { const ks = p.split('.'); let c = o; for (const k of ks.slice(0, -1)) { c = c && c[k]; if (!c) return; } delete c[ks[ks.length - 1]]; };
const matches = (u, f) => Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((alt) => matches(u, alt));
    const cur = k === '_id' ? u._id : get(u, k);
    if (v && typeof v === 'object' && '$lt' in v) return cur !== undefined && cur < v.$lt;
    if (v && typeof v === 'object' && '$exists' in v) return (cur !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$ne' in v) return cur !== v.$ne;
    if (Array.isArray(cur)) return cur.includes(v);
    return String(cur) === String(v);
});
const wrap = (u) => u && Object.assign(u, { comparePassword: async (p) => p === u._pw });
jest.mock('../models/user', () => ({
    findById: (id) => {
        const p = Promise.resolve(wrap(mockUsers.get(String(id)) || null));
        p.select = () => p;
        return p;
    },
    findOne: (f) => ({ select: async () => wrap([...mockUsers.values()].find((u) => matches(u, f)) || null) }),
    updateOne: async (f, upd) => {
        const u = [...mockUsers.values()].find((x) => matches(x, f));
        if (!u) return { modifiedCount: 0 };
        Object.entries(upd.$set || {}).forEach(([k, v]) => set(u, k, v));
        Object.keys(upd.$unset || {}).forEach((k) => unset(u, k));
        Object.entries(upd.$pull || {}).forEach(([k, v]) => set(u, k, get(u, k).filter((x) => x !== v)));
        return { modifiedCount: 1 };
    },
}));

const mockAttempts = new Map();
jest.mock('../utils/loginAttempts', () => ({
    getLock: async (k) => ({ locked: false, fails: mockAttempts.get(k) || 0 }),
    recordFailure: async (k) => { const n = (mockAttempts.get(k) || 0) + 1; mockAttempts.set(k, n); return { fails: n }; },
    clear: async (k) => { mockAttempts.delete(k); },
    lockMs: () => 15 * 60 * 1000,
}));

const mockComplete = jest.fn(async (req, res, user, extra) => res.status(200).json({ success: true, token: 'T', id: String(user._id), ...extra }));
const mockRevoke = jest.fn(async () => {});
jest.mock('../controllers/authController', () => ({
    completeLogin: (...a) => mockComplete(...a),
    revokeAllSessions: (...a) => mockRevoke(...a),
}));

const SECRET = 'unit-jwt-secret-for-2fa-controller-0123456789';
process.env.JWT_SECRET = SECRET;
const totp = require('../utils/totp');
const c = require('../controllers/twoFactorController');
const { verifyUserToken } = require('../middlewares/authMiddleware');

const mkRes = () => {
    const r = { code: 200, body: null, headers: {} };
    r.status = (s) => { r.code = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    return r;
};
const hex = (n) => String(n).padStart(24, '0');

function addUser(over = {}) {
    const id = over._id || hex(mockUsers.size + 1);
    const secret = totp.generateSecret();
    const recovery = totp.generateRecoveryCodes();
    const u = {
        _id: id, role: 'admin', status: 'active', tokenVersion: 0, email: 'a@x.test', _pw: 'pw', password: 'hashed', isTenantOwner: false,
        twoFactor: { enabled: true, secretEnc: totp.encryptSecret(secret), recoveryHashes: recovery.map(totp.hashRecoveryCode), lastUsedStep: 0 },
        ...over,
    };
    mockUsers.set(id, u);
    return { u, secret, recovery };
}
const nowCode = (secret, d = 0) => totp.codeForStep(secret, totp.stepFor() + d);

beforeEach(() => { mockUsers.clear(); mockAttempts.clear(); mockComplete.mockClear(); mockRevoke.mockClear(); });

describe('challenge token', () => {
    test('is a typed 5-minute JWT that protect()/verifyUserToken refuses', () => {
        const { u } = addUser();
        const t = c.signChallenge(u);
        const d = jwt.decode(t);
        expect(d.typ).toBe('2fa-challenge');
        expect(d.exp - d.iat).toBe(300);
        expect(() => verifyUserToken(t)).toThrow();
    });
    test('a normal session token is not accepted as a challenge', async () => {
        const { u, secret } = addUser();
        const session = jwt.sign({ id: u._id, role: 'admin', typ: 'user', tv: 0 }, SECRET, { expiresIn: '5m' });
        const res = mkRes();
        await c.verify({ body: { challengeToken: session, code: nowCode(secret) } }, res);
        expect(res.code).toBe(401);
        expect(mockComplete).not.toHaveBeenCalled();
    });
    test('expired / wrong-secret / stale tokenVersion are refused', async () => {
        const { u, secret } = addUser();
        const expired = jwt.sign({ id: u._id, typ: '2fa-challenge', tv: 0 }, SECRET, { expiresIn: -10 });
        const forged = jwt.sign({ id: u._id, typ: '2fa-challenge', tv: 0 }, 'other-secret');
        for (const t of [expired, forged]) {
            const res = mkRes();
            await c.verify({ body: { challengeToken: t, code: nowCode(secret) } }, res);
            expect(res.code).toBe(401);
        }
        const t = c.signChallenge(u);
        u.tokenVersion = 1;
        const res = mkRes();
        await c.verify({ body: { challengeToken: t, code: nowCode(secret) } }, res);
        expect(res.code).toBe(401);
        expect(mockComplete).not.toHaveBeenCalled();
    });
});

describe('verify step', () => {
    test('valid code completes login; the same code cannot be replayed', async () => {
        const { u, secret } = addUser();
        const ch = c.signChallenge(u);
        const code = nowCode(secret);
        const r1 = mkRes();
        await c.verify({ body: { challengeToken: ch, code } }, r1);
        expect(r1.code).toBe(200);
        expect(mockComplete).toHaveBeenCalledTimes(1);
        const r2 = mkRes();
        await c.verify({ body: { challengeToken: ch, code } }, r2);
        expect(r2.code).toBe(401);
        expect(r2.body.code).toBe('INVALID_CODE');
        expect(mockComplete).toHaveBeenCalledTimes(1);
    });
    test('recovery code works once and is consumed', async () => {
        const { u, recovery } = addUser();
        const ch = c.signChallenge(u);
        const r1 = mkRes();
        await c.verify({ body: { challengeToken: ch, recoveryCode: recovery[0].toLowerCase() } }, r1);
        expect(r1.code).toBe(200);
        expect(r1.body.recoveryCodesRemaining).toBe(7);
        const r2 = mkRes();
        await c.verify({ body: { challengeToken: ch, recoveryCode: recovery[0] } }, r2);
        expect(r2.code).toBe(401);
        const r3 = mkRes();
        await c.verify({ body: { challengeToken: ch, recoveryCode: recovery[1] } }, r3);
        expect(r3.code).toBe(200);
    });
    test('locks after 5 wrong codes, even for the right code afterwards', async () => {
        const { u, secret } = addUser();
        const ch = c.signChallenge(u);
        const codes = [];
        for (let i = 0; i < 5; i++) {
            const r = mkRes();
            await c.verify({ body: { challengeToken: ch, code: '000000' } }, r);
            codes.push(r.code);
        }
        expect(codes).toEqual([401, 401, 401, 401, 429]);
        const r = mkRes();
        await c.verify({ body: { challengeToken: ch, code: nowCode(secret) } }, r);
        expect(r.code).toBe(429);
        expect(r.headers['Retry-After']).toBe('900');
        expect(mockComplete).not.toHaveBeenCalled();
    });
    test('a successful verify resets the failure counter', async () => {
        const { u, secret } = addUser();
        const ch = c.signChallenge(u);
        for (let i = 0; i < 3; i++) await c.verify({ body: { challengeToken: ch, code: '000000' } }, mkRes());
        await c.verify({ body: { challengeToken: ch, code: nowCode(secret) } }, mkRes());
        expect(mockAttempts.size).toBe(0);
    });
    test('user without 2FA enabled cannot use verify', async () => {
        const { u, secret } = addUser({ twoFactor: { enabled: false } });
        const res = mkRes();
        await c.verify({ body: { challengeToken: c.signChallenge(u), code: nowCode(secret) } }, res);
        expect(res.code).toBe(401);
    });
});

describe('enrolment', () => {
    test('setup -> enable returns 8 recovery codes once, stores only hashes', async () => {
        const { u } = addUser({ twoFactor: { enabled: false }, role: 'admin' });
        const rs = mkRes();
        await c.setup({ user: u }, rs);
        expect(rs.body.secret).toBeTruthy();
        expect(rs.body.qrDataUrl).toMatch(/^data:image\/png/);
        expect(rs.body.otpauthUri).toContain('otpauth://totp/');
        expect(u.twoFactor.enabled).toBe(false);
        expect(JSON.stringify(u.twoFactor)).not.toContain(rs.body.secret);

        const bad = mkRes();
        await c.enable({ user: u, body: { code: '123456' } }, bad);
        expect(bad.code).toBe(400);
        expect(u.twoFactor.enabled).toBe(false);

        const ok = mkRes();
        await c.enable({ user: u, body: { code: nowCode(rs.body.secret) } }, ok);
        expect(ok.body.recoveryCodes).toHaveLength(8);
        expect(u.twoFactor.enabled).toBe(true);
        expect(u.twoFactor.recoveryHashes).toHaveLength(8);
        expect(u.twoFactor.recoveryHashes.join()).not.toContain(ok.body.recoveryCodes[0]);
    });
    test('waiter / chef / captain / manager cannot enrol', async () => {
        for (const role of ['waiter', 'chef', 'captain', 'manager']) {
            const { u } = addUser({ role, twoFactor: { enabled: false } });
            const res = mkRes();
            await c.setup({ user: u }, res);
            expect(res.code).toBe(403);
        }
    });
    test('disable needs password AND a code', async () => {
        const { u, secret } = addUser();
        const r1 = mkRes();
        await c.disable({ user: u, body: { password: 'wrong', code: nowCode(secret) } }, r1);
        expect(r1.code).toBe(400);
        expect(u.twoFactor.enabled).toBe(true);
        const r2 = mkRes();
        await c.disable({ user: u, body: { password: 'pw', code: nowCode(secret) } }, r2);
        expect(r2.body.success).toBe(true);
        expect(u.twoFactor.enabled).toBe(false);
        expect(u.twoFactor.secretEnc).toBeUndefined();
    });
    test('regenerate replaces the recovery set (needs a TOTP code)', async () => {
        const { u, secret, recovery } = addUser();
        const bad = mkRes();
        await c.regenerateRecovery({ user: u, body: { code: '000000' } }, bad);
        expect(bad.code).toBe(400);
        const ok = mkRes();
        await c.regenerateRecovery({ user: u, body: { code: nowCode(secret) } }, ok);
        expect(ok.body.recoveryCodes).toHaveLength(8);
        expect(totp.findRecoveryIndex(u.twoFactor.recoveryHashes, recovery[0])).toBe(-1);
    });
});

describe('admin reset', () => {
    test('owner can reset another admin of the same restaurant and sessions are revoked', async () => {
        const owner = addUser({ restaurant: 'R1', isTenantOwner: true, twoFactor: { enabled: false } }).u;
        const other = addUser({ restaurant: 'R1' }).u;
        const res = mkRes();
        await c.adminReset({ user: owner, body: { userId: other._id } }, res);
        expect(res.body.success).toBe(true);
        expect(other.twoFactor.enabled).toBe(false);
        expect(mockRevoke).toHaveBeenCalledWith(other._id);
    });
    test('owner cannot reset another tenant or themself; a non-owner admin cannot reset', async () => {
        const owner = addUser({ restaurant: 'R1', isTenantOwner: true }).u;
        const foreign = addUser({ restaurant: 'R2' }).u;
        const plain = addUser({ restaurant: 'R1', isTenantOwner: false }).u;
        const target = addUser({ restaurant: 'R1' }).u;
        let r = mkRes(); await c.adminReset({ user: owner, body: { userId: foreign._id } }, r); expect(r.code).toBe(404);
        r = mkRes(); await c.adminReset({ user: owner, body: { userId: owner._id } }, r); expect(r.code).toBe(400);
        r = mkRes(); await c.adminReset({ user: plain, body: { userId: target._id } }, r); expect(r.code).toBe(403);
        expect(foreign.twoFactor.enabled).toBe(true);
        expect(mockRevoke).not.toHaveBeenCalled();
    });
    test('superadmin can reset anyone', async () => {
        const sa = addUser({ role: 'superadmin', twoFactor: { enabled: false } }).u;
        const target = addUser({ restaurant: 'R9' }).u;
        const r = mkRes();
        await c.adminReset({ user: sa, body: { userId: target._id } }, r);
        expect(r.body.success).toBe(true);
        expect(mockRevoke).toHaveBeenCalled();
    });
});
