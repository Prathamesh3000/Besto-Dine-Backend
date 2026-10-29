/**
 * Login flow with / without 2FA, end to end through the REAL
 * authController.login + twoFactorController.verify. Only persistence is
 * mocked (User / RefreshSession / Shift / Restaurant / loginAttempts).
 */
const jwt = require('jsonwebtoken');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockUsers = [];
const wrapUser = (u) => u && Object.assign(u, { comparePassword: async (p) => p === u._pw });
const chain = (val) => { const p = Promise.resolve(val); p.select = () => p; p.lean = () => p; return p; };
jest.mock('../models/user', () => ({
    findOne: (f) => chain(wrapUser(mockUsers.find((u) => (!f.role || u.role === f.role) && u.email === f.email) || null)),
    find: (f) => chain(mockUsers.filter((u) => u.email === f.email && (!f.role || !f.role.$in || f.role.$in.includes(u.role))).map(wrapUser)),
    findById: (id) => chain(wrapUser(mockUsers.find((u) => String(u._id) === String(id)) || null)),
    updateOne: async (f, upd) => {
        const u = mockUsers.find((x) => String(x._id) === String(f._id));
        if (!u) return { modifiedCount: 0 };
        if (upd.$set && 'twoFactor.lastUsedStep' in upd.$set) {
            const cur = u.twoFactor.lastUsedStep;
            if (!(cur < upd.$set['twoFactor.lastUsedStep'])) return { modifiedCount: 0 };
            u.twoFactor.lastUsedStep = upd.$set['twoFactor.lastUsedStep'];
        }
        return { modifiedCount: 1 };
    },
}));
jest.mock('../models/restaurant', () => ({ findOne: () => chain(null), findById: () => chain({ status: 'active', name: 'R' }), find: () => chain([]) }));
const mockSessions = [];
jest.mock('../models/refreshSession', () => ({ create: async (d) => { mockSessions.push(d); return d; }, updateMany: async () => ({}) }));
jest.mock('../models/shift', () => ({ findOne: () => chain(null), create: async () => ({}) }));
jest.mock('../models/otp', () => ({ OtpSendCounter: {} }));
jest.mock('../utils/loginAttempts', () => ({
    accountKey: () => 'k', isExempt: () => false, maskKey: (k) => k, maxFails: () => 10, lockMs: () => 900000,
    getLock: async () => ({ locked: false, fails: 0 }), recordFailure: async () => ({ fails: 1 }), clear: async () => {},
}));

process.env.JWT_SECRET = 'unit-jwt-secret-for-2fa-login-0123456789';
const totp = require('../utils/totp');
const auth = require('../controllers/authController');
const tf = require('../controllers/twoFactorController');
const { verifyUserToken } = require('../middlewares/authMiddleware');

const mkRes = () => {
    const r = { code: 200, body: null };
    r.status = (s) => { r.code = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = () => r;
    r.cookie = () => r;
    r.clearCookie = () => r;
    return r;
};
const req = (body) => ({ body, headers: {}, query: {}, ip: '1.1.1.1' });

function addUser(over = {}) {
    const secret = totp.generateSecret();
    const u = {
        _id: String(mockUsers.length + 1).padStart(24, '0'), email: 'boss@x.test', role: 'admin', status: 'active', tokenVersion: 0,
        _pw: 'secret-pw', password: 'h', restaurant: 'R1', name: 'Boss',
        twoFactor: { enabled: true, secretEnc: totp.encryptSecret(secret), recoveryHashes: [], lastUsedStep: 0 }, ...over,
    };
    mockUsers.push(u);
    return { u, secret };
}

beforeEach(() => { mockUsers.length = 0; mockSessions.length = 0; delete process.env.TWO_FA_REQUIRED_ROLES; });

test('admin without 2FA logs in normally (no flags)', async () => {
    addUser({ twoFactor: { enabled: false } });
    const res = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'secret-pw' }), res);
    expect(res.code).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
    expect(res.body.twoFactorSetupRequired).toBeUndefined();
});

test('TWO_FA_REQUIRED_ROLES nudges an unenrolled admin but still logs in', async () => {
    process.env.TWO_FA_REQUIRED_ROLES = 'admin';
    addUser({ twoFactor: { enabled: false } });
    const res = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'secret-pw' }), res);
    expect(res.code).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorSetupRequired).toBe(true);
});

test('waiter is never challenged even with 2FA data present', async () => {
    addUser({ role: 'waiter' });
    const res = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'secret-pw' }), res);
    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
});

test('wrong password never reveals the 2FA step', async () => {
    addUser();
    const res = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'nope' }), res);
    expect(res.code).toBe(401);
    expect(res.body.twoFactorRequired).toBeUndefined();
});

test('admin with 2FA: login returns a challenge and NO tokens; verify issues the session', async () => {
    const { u, secret } = addUser();
    const r1 = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'secret-pw' }), r1);
    expect(r1.code).toBe(200);
    expect(r1.body.twoFactorRequired).toBe(true);
    expect(r1.body.token).toBeUndefined();
    expect(r1.body.refreshToken).toBeUndefined();
    expect(mockSessions).toHaveLength(0);
    // challenge cannot act as a session token
    expect(() => verifyUserToken(r1.body.challengeToken)).toThrow();

    const r2 = mkRes();
    await tf.verify(req({ challengeToken: r1.body.challengeToken, code: totp.codeForStep(secret, totp.stepFor()) }), r2);
    expect(r2.code).toBe(200);
    expect(r2.body.token).toBeTruthy();
    expect(r2.body.refreshToken).toBeTruthy();
    expect(mockSessions).toHaveLength(1);
    expect(mockSessions[0].tv).toBe(0);
    const d = jwt.verify(r2.body.token, process.env.JWT_SECRET);
    expect(d.typ).toBe('user');
    expect(d.id).toBe(u._id);
    expect(d.sexp).toBeGreaterThan(Date.now() / 1000);
});

test('superadmin with 2FA is challenged too', async () => {
    addUser({ role: 'superadmin', restaurant: undefined });
    const res = mkRes();
    await auth.login(req({ email: 'boss@x.test', password: 'secret-pw' }), res);
    expect(res.body.twoFactorRequired).toBe(true);
});
