/** utils/totp — TOTP window/replay, encryption round trip, recovery codes, policy. */
const { authenticator } = require('otplib');

const SAVED = { ...process.env };
beforeEach(() => { process.env.JWT_SECRET = 'unit-jwt-secret-for-totp-tests-0123456789'; delete process.env.TWO_FA_ENC_KEY; delete process.env.TWO_FA_REQUIRED_ROLES; });
afterAll(() => { process.env = SAVED; });

const totp = require('../utils/totp');

describe('TOTP verify', () => {
    const secret = totp.generateSecret();
    const now = 1_700_000_000_000;
    const step = totp.stepFor(now);

    test('matches otplib output (interop)', () => {
        const real = Date.now();
        expect(totp.codeForStep(secret, totp.stepFor(real))).toBe(authenticator.generate(secret));
    });
    test('accepts current and +-1 step, rejects +-2', () => {
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step), { nowMs: now })).toBe(step);
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step - 1), { nowMs: now })).toBe(step - 1);
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step + 1), { nowMs: now })).toBe(step + 1);
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step - 2), { nowMs: now })).toBeNull();
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step + 2), { nowMs: now })).toBeNull();
    });
    test('replay: a step <= lastUsedStep never matches', () => {
        const code = totp.codeForStep(secret, step);
        expect(totp.verifyCode(secret, code, { nowMs: now, lastUsedStep: step })).toBeNull();
        expect(totp.verifyCode(secret, code, { nowMs: now, lastUsedStep: step - 1 })).toBe(step);
        // an older in-window code is also dead once a newer step was used
        expect(totp.verifyCode(secret, totp.codeForStep(secret, step - 1), { nowMs: now, lastUsedStep: step })).toBeNull();
    });
    test('rejects malformed input', () => {
        for (const bad of [undefined, null, '', '12345', '1234567', 'abcdef', {}]) {
            expect(totp.verifyCode(secret, bad, { nowMs: now })).toBeNull();
        }
        // whitespace tolerated
        const c = totp.codeForStep(secret, step);
        expect(totp.verifyCode(secret, `${c.slice(0, 3)} ${c.slice(3)}`, { nowMs: now })).toBe(step);
    });
});

describe('secret encryption', () => {
    test('round trip, random IV, tamper detection', () => {
        const s = totp.generateSecret();
        const a = totp.encryptSecret(s);
        const b = totp.encryptSecret(s);
        expect(a).not.toBe(b);
        expect(a).not.toContain(s);
        expect(totp.decryptSecret(a)).toBe(s);
        const parts = a.split('.');
        parts[3] = Buffer.from('tampered-bytes!').toString('base64url');
        expect(() => totp.decryptSecret(parts.join('.'))).toThrow();
        expect(() => totp.decryptSecret('garbage')).toThrow();
    });
    test('explicit key vs derived key are different', () => {
        const s = totp.generateSecret();
        const viaJwt = totp.encryptSecret(s);
        process.env.TWO_FA_ENC_KEY = 'a-dedicated-key';
        expect(() => totp.decryptSecret(viaJwt)).toThrow();
        const viaKey = totp.encryptSecret(s);
        expect(totp.decryptSecret(viaKey)).toBe(s);
        delete process.env.TWO_FA_ENC_KEY;
        expect(() => totp.decryptSecret(viaKey)).toThrow();
    });
});

describe('recovery codes', () => {
    test('8 unique, hashed, case/dash insensitive', () => {
        const codes = totp.generateRecoveryCodes();
        expect(codes).toHaveLength(8);
        expect(new Set(codes).size).toBe(8);
        expect(codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
        const hashes = codes.map(totp.hashRecoveryCode);
        expect(hashes[0]).not.toContain(codes[0]);
        expect(totp.findRecoveryIndex(hashes, codes[3].toLowerCase().replace('-', ' '))).toBe(3);
        expect(totp.findRecoveryIndex(hashes, 'AAAAA-AAAAA')).toBe(-1);
    });
});

describe('policy', () => {
    test('only admin/superadmin are eligible; enabled => required', () => {
        expect(totp.loginPolicy({ role: 'waiter', twoFactor: { enabled: true } })).toEqual({ required: false, setupRequired: false });
        expect(totp.loginPolicy({ role: 'admin', twoFactor: { enabled: true } }).required).toBe(true);
        expect(totp.loginPolicy({ role: 'superadmin', twoFactor: { enabled: true } }).required).toBe(true);
        expect(totp.loginPolicy({ role: 'admin' })).toEqual({ required: false, setupRequired: false });
    });
    test('TWO_FA_REQUIRED_ROLES flags unenrolled eligible roles only', () => {
        process.env.TWO_FA_REQUIRED_ROLES = 'admin, waiter';
        expect(totp.loginPolicy({ role: 'admin' }).setupRequired).toBe(true);
        expect(totp.loginPolicy({ role: 'waiter' }).setupRequired).toBe(false);
        expect(totp.loginPolicy({ role: 'superadmin' }).setupRequired).toBe(false);
        expect(totp.loginPolicy({ role: 'admin', twoFactor: { enabled: true } }).setupRequired).toBe(false);
    });
});
