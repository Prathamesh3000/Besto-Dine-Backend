/**
 * Session lifetime contract.
 *
 * The bug this pins: refresh tokens rotate, and every rotation wrote a
 * fresh `expiresAt = now + TTL`. On its own that is a sliding window
 * with no ceiling — any client that refreshes before the token lapses
 * stays signed in forever. The customer app polls notifications every
 * 15s and renews its access token roughly every 30 minutes, so a
 * browser tab left open overnight renewed itself indefinitely. A tester
 * who signed in one day was still signed in the next.
 *
 * `refreshAbsoluteMs` is the ceiling that actually ends a session. It
 * is set once when a login creates a token family and is carried
 * through rotations unchanged, so these numbers are a security control
 * rather than a tuning preference — hence tests.
 */

jest.mock('../utils/logger', () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const HOUR = 60 * 60 * 1000;

/**
 * Load the controller with `env` applied.
 *
 * NOTE: refreshAbsoluteMs reads process.env at CALL time, not at
 * require time, so the vars must stay set while the assertion runs.
 * afterEach restores them.
 */
const SAVED_ENV = { ...process.env };

function loadAuth(env = {}) {
    jest.resetModules();
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return require('../controllers/authController');
}

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in SAVED_ENV)) delete process.env[k];
    }
    Object.assign(process.env, SAVED_ENV);
});

const STAFF = ['admin', 'manager', 'waiter', 'chef', 'captain'];

describe('every role has a finite ceiling', () => {
    const auth = loadAuth();

    test.each([...STAFF, 'superadmin', 'customer'])('%s is bounded', (role) => {
        const ms = auth.refreshAbsoluteMs(role);
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
    });

    test('an unknown role still gets a ceiling, not Infinity', () => {
        // A role added later must not silently inherit an endless
        // session just because this function has no branch for it.
        const ms = auth.refreshAbsoluteMs('some-future-role');
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
    });
});

describe('ceilings are ordered by blast radius', () => {
    const auth = loadAuth();

    test('superadmin is the shortest — platform-wide access', () => {
        expect(auth.refreshAbsoluteMs('superadmin')).toBe(8 * HOUR);
        for (const role of STAFF) {
            expect(auth.refreshAbsoluteMs('superadmin'))
                .toBeLessThan(auth.refreshAbsoluteMs(role));
        }
    });

    test('staff sessions last about one shift', () => {
        for (const role of STAFF) {
            expect(auth.refreshAbsoluteMs(role)).toBe(12 * HOUR);
        }
    });

    test('a staff session cannot outlive a working day', () => {
        // The reported symptom was a staff login surviving overnight.
        for (const role of STAFF) {
            expect(auth.refreshAbsoluteMs(role)).toBeLessThanOrEqual(24 * HOUR);
        }
    });

    test('customers are signed out a fixed 1 hour after sign-in (client decision 2026-10-07)', () => {
        expect(auth.refreshAbsoluteMs('customer')).toBe(1 * HOUR);
        for (const role of STAFF) {
            expect(auth.refreshAbsoluteMs('customer')).toBeLessThan(auth.refreshAbsoluteMs(role));
        }
    });
});

describe('customer inactivity timeout (QA N14)', () => {
    const MIN = 60 * 1000;

    test('the customer per-token window is the 60-minute idle timeout', () => {
        const auth = loadAuth();
        expect(auth.customerIdleMs()).toBe(60 * MIN);
        expect(auth.refreshTtlMs('customer')).toBe(60 * MIN);
    });

    test('CUSTOMER_IDLE_TIMEOUT_MINUTES is honoured', () => {
        const auth = loadAuth({ CUSTOMER_IDLE_TIMEOUT_MINUTES: '15' });
        expect(auth.refreshTtlMs('customer')).toBe(15 * MIN);
    });

    test('a bad CUSTOMER_IDLE_TIMEOUT_MINUTES falls back to 60', () => {
        const auth = loadAuth({ CUSTOMER_IDLE_TIMEOUT_MINUTES: 'never' });
        expect(auth.refreshTtlMs('customer')).toBe(60 * MIN);
    });

    test('the legacy REFRESH_TTL_HOURS_CUSTOMER no longer stretches the 1-hour cap', () => {
        const auth = loadAuth({ REFRESH_TTL_HOURS_CUSTOMER: '24' });
        expect(auth.refreshAbsoluteMs('customer')).toBe(1 * HOUR);
    });

    test('SESSION_MAX_HOURS_CUSTOMER overrides the cap (fractions allowed)', () => {
        expect(loadAuth({ SESSION_MAX_HOURS_CUSTOMER: '3' }).refreshAbsoluteMs('customer')).toBe(3 * HOUR);
        expect(loadAuth({ SESSION_MAX_HOURS_CUSTOMER: '0.5' }).refreshAbsoluteMs('customer')).toBe(0.5 * HOUR);
    });

    test('the access token never outlives the session and carries its end (sexp)', () => {
        const jwt = require('jsonwebtoken');
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-session-lifetime';
        const { signAccessToken } = jest.requireActual('../middlewares/authMiddleware');
        const user = { _id: 'u1', role: 'customer', tokenVersion: 0 };
        const end = new Date(Date.now() + 10 * MIN);          // session ends in 10 min, access TTL is 30 min
        const d = jwt.decode(signAccessToken(user, { sessionExpiresAt: end }));
        expect(d.sexp).toBe(Math.floor(end.getTime() / 1000));
        expect(d.exp).toBe(Math.floor(end.getTime() / 1000));
        const far = new Date(Date.now() + 5 * HOUR);           // session longer than the TTL → normal TTL
        const d2 = jwt.decode(signAccessToken(user, { sessionExpiresAt: far }));
        expect(d2.exp).toBeLessThan(Math.floor(far.getTime() / 1000));
        expect(jwt.decode(signAccessToken(user)).sexp).toBeUndefined();
    });

    test('staff and superadmin windows are unchanged', () => {
        const auth = loadAuth();
        for (const role of STAFF) expect(auth.refreshTtlMs(role)).toBe(7 * 24 * HOUR);
        expect(auth.refreshTtlMs('superadmin')).toBe(12 * HOUR);
    });
});

describe('the ceiling actually binds', () => {
    const auth = loadAuth();

    test('staff ceiling is SHORTER than the per-token TTL', () => {
        // This is the whole point. The per-token TTL is 7 days; without
        // a shorter ceiling the session would renew for a week at a
        // time, forever. If someone later raises the ceiling above the
        // TTL, the ceiling stops binding and this test fails.
        for (const role of STAFF) {
            expect(auth.refreshAbsoluteMs(role)).toBeLessThan(auth.refreshTtlMs(role));
        }
    });

    test('superadmin ceiling is shorter than its per-token TTL', () => {
        expect(auth.refreshAbsoluteMs('superadmin'))
            .toBeLessThan(auth.refreshTtlMs('superadmin'));
    });
});

describe('env overrides', () => {
    test('SESSION_MAX_HOURS_STAFF is honoured', () => {
        const auth = loadAuth({ SESSION_MAX_HOURS_STAFF: '4' });
        expect(auth.refreshAbsoluteMs('waiter')).toBe(4 * HOUR);
    });

    test('SESSION_MAX_HOURS_SUPERADMIN is honoured', () => {
        const auth = loadAuth({ SESSION_MAX_HOURS_SUPERADMIN: '2' });
        expect(auth.refreshAbsoluteMs('superadmin')).toBe(2 * HOUR);
    });

    test.each([
        ['zero', '0'],
        ['negative', '-5'],
        ['non-numeric', 'forever'],
        ['empty', ''],
    ])('a %s override falls back to the default rather than disabling the ceiling', (_label, value) => {
        // A typo in the environment must never be the thing that grants
        // unlimited sessions.
        const auth = loadAuth({ SESSION_MAX_HOURS_STAFF: value });
        expect(auth.refreshAbsoluteMs('waiter')).toBe(12 * HOUR);
    });
});
