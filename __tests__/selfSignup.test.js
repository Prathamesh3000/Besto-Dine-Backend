/**
 * Unit tests for hotel self-signup helpers:
 *   - utils/signupSlug  (slugify, issues, suggestions)
 *   - utils/passwordPolicy + the strong-password gate on
 *     POST /public/register-restaurant (runs before any DB access)
 *   - utils/mobile normalisation
 */
jest.mock('../utils/logger', () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const {
    slugify, slugFromName, slugIssue, suggestionCandidates, suggestSlugs,
} = require('../utils/signupSlug');
const { isStrongPassword, STRONG_PASSWORD_MESSAGE } = require('../utils/passwordPolicy');
const { normalizeMobile } = require('../utils/mobile');

describe('signupSlug', () => {
    test('slugify / slugFromName', () => {
        expect(slugify('  Hotel Tip-Top & Café!! ')).toBe('hotel-tip-top-caf');
        expect(slugFromName('The   Grand -- Palace')).toBe('the-grand-palace');
        expect(slugFromName('x'.repeat(80)).length).toBe(55);
    });

    test('slugIssue', () => {
        expect(slugIssue('hotel-tip-top')).toBeNull();
        expect(slugIssue('a')).toBe('too_short');
        expect(slugIssue('')).toBe('invalid');
        expect(slugIssue('bad--dash')).toBe('invalid');
        expect(slugIssue('x'.repeat(61))).toBe('invalid');
        expect(slugIssue('admin')).toBe('reserved');
        expect(slugIssue('request-demo')).toBe('reserved');
        expect(slugIssue('register-hotel')).toBe('reserved');
    });

    test('suggestionCandidates are valid, unique, not reserved and exclude the base', () => {
        const c = suggestionCandidates('spice-hub', { city: 'Pune' });
        expect(c[0]).toBe('spice-hub-pune');
        expect(c).not.toContain('spice-hub');
        expect(new Set(c).size).toBe(c.length);
        for (const s of c) expect(slugIssue(s)).toBeNull();
    });

    test('suggestSlugs skips taken candidates and returns at most 3', async () => {
        const taken = new Set(['spice-hub-restaurant', 'spice-hub-hotel']);
        const findTaken = jest.fn(async (slugs) => new Set(slugs.filter((s) => taken.has(s))));
        const out = await suggestSlugs('spice-hub', findTaken);
        expect(out).toHaveLength(3);
        expect(out).toEqual(['the-spice-hub', 'spice-hub-2', 'spice-hub-3']);
        expect(findTaken).toHaveBeenCalledTimes(1);
    });

    test('suggestSlugs falls back to random suffixes when everything is taken', async () => {
        const out = await suggestSlugs('login', async (slugs) => new Set(slugs.filter((s) => !/^login-[0-9a-f]{4}$/.test(s))));
        expect(out.length).toBeGreaterThan(0);
        for (const s of out) expect(s).toMatch(/^login-[0-9a-f]{4}$/);
    });

    test('suggestSlugs on an empty base returns []', async () => {
        expect(await suggestSlugs('', async () => new Set())).toEqual([]);
    });
});

describe('passwordPolicy', () => {
    test.each(['Sh#1a', 'Ab#1234', 'alllowercase#123', 'ALLUPPERCASE#123', 'NoDigits#Here!', 'NoSpecial12345A'])(
        '%s is rejected', (pw) => expect(isStrongPassword(pw)).toBe(false),
    );
    test('a "Good" password (8-11 chars, all character types) passes', () => {
        expect(isStrongPassword('Hotel@2026')).toBe(true);
        expect(isStrongPassword('Ab#12345')).toBe(true);
    });
    test('a "Strong" password (12+ chars, all character types) passes', () => {
        expect(isStrongPassword('Signup#Pass1234')).toBe(true);
    });
    test('non-strings are rejected', () => {
        expect(isStrongPassword(undefined)).toBe(false);
        expect(isStrongPassword({ $ne: 1 })).toBe(false);
    });
});

describe('normalizeMobile', () => {
    test.each([
        ['+91 98765-43210', '9876543210'],
        ['919876543210', '9876543210'],
        ['09876543210', '9876543210'],
        ['9876543210', '9876543210'],
    ])('%s → %s', (raw, out) => expect(normalizeMobile(raw)).toBe(out));
    test.each(['12345', '5876543210', '', null, {}])('%p is invalid', (raw) => expect(normalizeMobile(raw)).toBeNull());
});

describe('registerRestaurant — password + terms gates', () => {
    const { registerRestaurant } = require('../controllers/publicController');

    function mockRes() {
        const res = {};
        res.status = jest.fn(() => res);
        res.json = jest.fn(() => res);
        res.set = jest.fn(() => res);
        return res;
    }
    const base = {
        restaurantName: 'Spice Hub', ownerName: 'Owner', contactEmail: 'o@spice.test',
        contactPhone: '+91 98765 43210', city: 'Pune', acceptTerms: true,
    };

    test('weak password → 400 field password WEAK_PASSWORD', async () => {
        const res = mockRes();
        await registerRestaurant({ body: { ...base, password: 'weakpass1' }, headers: {} }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0]).toMatchObject({
            success: false, field: 'password', code: 'WEAK_PASSWORD', message: STRONG_PASSWORD_MESSAGE,
        });
    });

    test('missing acceptTerms → 400 TERMS_REQUIRED', async () => {
        const res = mockRes();
        await registerRestaurant({ body: { ...base, acceptTerms: false, password: 'Signup#Pass1234' }, headers: {} }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0]).toMatchObject({ field: 'acceptTerms', code: 'TERMS_REQUIRED' });
    });

    test('invalid mobile → 400 field contactPhone', async () => {
        const res = mockRes();
        await registerRestaurant({ body: { ...base, contactPhone: '12345', password: 'Signup#Pass1234' }, headers: {} }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0]).toMatchObject({ field: 'contactPhone' });
    });
});
