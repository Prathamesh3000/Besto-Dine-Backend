/**
 * utils/guestAccess — the one-off access token a token-mode guest counter
 * order gets instead of a scan session (design §12.2 follow-up).
 */
const {
    GUEST_ACCESS_TTL_MS, issueGuestAccess, hashGuestAccessToken, normaliseGuestAccessToken,
    guestAccessFromReq, guestAccessState, guestAccessMatches,
} = require('../utils/guestAccess');

const NOW = new Date('2026-10-19T10:00:00Z');

describe('issueGuestAccess', () => {
    test('random url-safe token, hash stored, 24 h expiry', () => {
        const a = issueGuestAccess(NOW);
        const b = issueGuestAccess(NOW);
        expect(a.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(a.token).not.toBe(b.token);
        expect(a.tokenHash).toBe(hashGuestAccessToken(a.token));
        expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(a.expiresAt.getTime() - NOW.getTime()).toBe(GUEST_ACCESS_TTL_MS);
        expect(GUEST_ACCESS_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
});

describe('guestAccessFromReq', () => {
    test('header first, then query; malformed values ignored', () => {
        const tok = issueGuestAccess().token;
        expect(guestAccessFromReq({ headers: { 'x-guest-access': tok }, query: {} })).toBe(tok);
        expect(guestAccessFromReq({ headers: {}, query: { guestAccess: tok } })).toBe(tok);
        expect(guestAccessFromReq({ headers: { 'x-guest-access': 'bad token!' }, query: { guestAccess: tok } })).toBe(tok);
        expect(guestAccessFromReq({ headers: {}, query: { guestAccess: ['a', 'b'] } })).toBeNull();
        expect(guestAccessFromReq({ headers: {}, query: { guestAccess: 'short' } })).toBeNull();
        expect(guestAccessFromReq({ headers: {}, query: { guestAccess: 'x'.repeat(129) } })).toBeNull();
        expect(guestAccessFromReq({})).toBeNull();
        expect(guestAccessFromReq(null)).toBeNull();
        expect(normaliseGuestAccessToken(undefined)).toBeNull();
    });
});

describe('guestAccessState / guestAccessMatches', () => {
    const issued = issueGuestAccess(NOW);
    const order = { guestAccess: { tokenHash: issued.tokenHash, expiresAt: issued.expiresAt } };

    test('own token, in time → ok', () => {
        expect(guestAccessState(order, issued.token, NOW)).toBe('ok');
        expect(guestAccessMatches(order, issued.token, new Date(NOW.getTime() + GUEST_ACCESS_TTL_MS - 1000))).toBe(true);
    });

    test('another order\'s token → mismatch; garbage → mismatch', () => {
        const other = issueGuestAccess(NOW);
        expect(guestAccessState(order, other.token, NOW)).toBe('mismatch');
        expect(guestAccessState(order, 'A'.repeat(32), NOW)).toBe('mismatch');
        expect(guestAccessMatches(order, other.token, NOW)).toBe(false);
    });

    test('expired → expired (at and after the deadline)', () => {
        expect(guestAccessState(order, issued.token, issued.expiresAt)).toBe('expired');
        expect(guestAccessState(order, issued.token, new Date(issued.expiresAt.getTime() + 1))).toBe('expired');
        expect(guestAccessMatches(order, issued.token, new Date(issued.expiresAt.getTime() + 1))).toBe(false);
        // a stored record without an expiry never matches
        expect(guestAccessState({ guestAccess: { tokenHash: issued.tokenHash } }, issued.token, NOW)).toBe('expired');
    });

    test('orders without guest access, or no token → none', () => {
        expect(guestAccessState({ scanSessionId: 's1' }, issued.token, NOW)).toBe('none');
        expect(guestAccessState({ guestAccess: {} }, issued.token, NOW)).toBe('none');
        expect(guestAccessState(order, null, NOW)).toBe('none');
        expect(guestAccessState(order, 'not valid', NOW)).toBe('none');
        expect(guestAccessState(null, issued.token, NOW)).toBe('none');
        expect(guestAccessMatches({ scanSessionId: 's1' }, issued.token, NOW)).toBe(false);
    });

    test('lean / string dates from Mongo are accepted', () => {
        const lean = { guestAccess: { tokenHash: issued.tokenHash, expiresAt: issued.expiresAt.toISOString() } };
        expect(guestAccessMatches(lean, issued.token, NOW)).toBe(true);
    });
});
