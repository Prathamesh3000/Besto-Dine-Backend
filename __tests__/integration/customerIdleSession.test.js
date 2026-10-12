/**
 * QA N14 — customer inactivity timeout.
 *
 * Customer refresh sessions slide by CUSTOMER_IDLE_TIMEOUT_MINUTES
 * (default 60): a refresh within the window works and extends it; after
 * 60 minutes without use the refresh is refused with
 * SESSION_IDLE_TIMEOUT. On top of that a customer login ends a FIXED
 * 1 hour after sign-in, however active (SESSION_MAX_HOURS_CUSTOMER,
 * client decision 2026-10-07). Staff lifetimes are unchanged. Time
 * travel = rewriting the RefreshSession rows.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, DEFAULT_PASSWORD } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const RefreshSession = require(path.join(BACKEND, 'models/refreshSession'));

const ctx = useIntegrationApp();
let A;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

beforeAll(async () => {
    A = await seedTenant({ label: 'idle' });
});

async function login(user, loginType) {
    const res = await ctx.api.anon().post('/auth/login')
        .send({ email: user.email, password: DEFAULT_PASSWORD, loginType });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toEqual(expect.any(String));
    return res.body;
}

const refresh = (refreshToken, extra = {}) =>
    ctx.api.anon().post('/auth/refresh').send({ refreshToken, ...extra });

/** Pretend every live row of `userId` was issued `ms` ago. */
async function ageSessions(userId, ms) {
    const rows = await RefreshSession.find({ user: userId, revokedAt: null });
    for (const row of rows) {
        const back = (d) => new Date(new Date(d).getTime() - ms);
        await RefreshSession.updateOne({ _id: row._id }, {
            $set: {
                lastUsedAt: back(row.lastUsedAt || row.createdAt),
                createdAt: back(row.createdAt),
                expiresAt: back(row.expiresAt),
                ...(row.familyExpiresAt ? { familyExpiresAt: back(row.familyExpiresAt) } : {}),
            },
        });
    }
}

describe('customer refresh session — 60-minute inactivity timeout', () => {
    test('login issues a customer refresh session that expires 60 min out, capped 1 hour after sign-in', async () => {
        const cust = await createCustomer('idle-ttl');
        await login(cust, 'customer');
        const row = await RefreshSession.findOne({ user: cust._id, revokedAt: null }).lean();
        const ttl = new Date(row.expiresAt).getTime() - new Date(row.lastUsedAt).getTime();
        expect(ttl).toBeGreaterThan(59 * MIN);
        expect(ttl).toBeLessThanOrEqual(60 * MIN + 1000);
        const cap = new Date(row.familyExpiresAt).getTime() - new Date(row.createdAt).getTime();
        expect(cap).toBeGreaterThan(59 * MIN);
        expect(cap).toBeLessThanOrEqual(1 * HOUR + 1000);
    });

    test('the access token carries the session end (sexp) and never outlives it', async () => {
        const cust = await createCustomer('idle-sexp');
        const s0 = await login(cust, 'customer');
        const jwt = require('jsonwebtoken');
        const claims = jwt.decode(s0.token);
        const row = await RefreshSession.findOne({ user: cust._id, revokedAt: null }).lean();
        expect(claims.sexp).toBe(Math.floor(new Date(row.familyExpiresAt).getTime() / 1000));
        expect(claims.exp).toBeLessThanOrEqual(claims.sexp);
    });

    test('an active customer refreshes fine within the hour, and is signed out at the hour anyway', async () => {
        const cust = await createCustomer('idle-ok');
        const s0 = await login(cust, 'customer');

        await ageSessions(cust._id, 45 * MIN);
        const r1 = await refresh(s0.refreshToken);
        expect(r1.status).toBe(200);
        expect(r1.body.token).toEqual(expect.any(String));
        expect((await ctx.api.as(r1.body.token).get('/auth/me')).status).toBe(200);

        // Still active, but 65 min after sign-in: the fixed hour is up.
        await ageSessions(cust._id, 20 * MIN);
        const r2 = await refresh(r1.body.refreshToken, { idleMs: 1000 });
        expect(r2.status).toBe(401);
        expect(r2.body.code).toBe('SESSION_EXPIRED');
    });

    test('refresh after 60 min idle is refused — with the default 1-hour login that is the hour itself', async () => {
        const cust = await createCustomer('idle-expired');
        const s0 = await login(cust, 'customer');

        await ageSessions(cust._id, 61 * MIN);
        const r = await refresh(s0.refreshToken);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_EXPIRED');
        expect(r.body.message).toMatch(/sign in again/i);
    });

    test('with a longer login cap configured, 60 min idle is still SESSION_IDLE_TIMEOUT', async () => {
        process.env.SESSION_MAX_HOURS_CUSTOMER = '24';
        try {
            const cust = await createCustomer('idle-expired-24');
            const s0 = await login(cust, 'customer');
            await ageSessions(cust._id, 61 * MIN);
            const r = await refresh(s0.refreshToken);
            expect(r.status).toBe(401);
            expect(r.body.code).toBe('SESSION_IDLE_TIMEOUT');
        } finally {
            delete process.env.SESSION_MAX_HOURS_CUSTOMER;
        }
    });

    test('idle detected via lastUsedAt alone (legacy row with a long expiresAt)', async () => {
        const cust = await createCustomer('idle-legacy');
        const s0 = await login(cust, 'customer');
        // A row written before the change: 30-day expiresAt, last used 2h ago.
        await RefreshSession.updateMany({ user: cust._id, revokedAt: null }, {
            $set: {
                lastUsedAt: new Date(Date.now() - 2 * HOUR),
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() + 28 * 24 * HOUR),
            },
        });
        const r = await refresh(s0.refreshToken);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_IDLE_TIMEOUT');
        // The whole family is dead — replaying reads as expired, not theft.
        const again = await refresh(s0.refreshToken);
        expect(again.status).toBe(401);
        expect(again.body.code).not.toBe('REFRESH_REUSED');
    });

    test('client-reported idleMs ≥ 60 min ends the session (background polling is not "use")', async () => {
        const cust = await createCustomer('idle-client');
        const s0 = await login(cust, 'customer');
        const r = await refresh(s0.refreshToken, { idleMs: 61 * MIN });
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_IDLE_TIMEOUT');

        const cust2 = await createCustomer('idle-client-ok');
        const s1 = await login(cust2, 'customer');
        const ok = await refresh(s1.refreshToken, { idleMs: 5 * MIN });
        expect(ok.status).toBe(200);
    });

    test('the absolute cap ends even an active customer session', async () => {
        const cust = await createCustomer('idle-cap');
        const s0 = await login(cust, 'customer');
        // Recently used, but the session's end has passed.
        await RefreshSession.updateMany({ user: cust._id, revokedAt: null }, {
            $set: { familyExpiresAt: new Date(Date.now() - HOUR) },
        });
        const r = await refresh(s0.refreshToken);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_EXPIRED');
    });
});

describe('staff sessions are unaffected by the customer idle timeout', () => {
    test('staff refresh still works after 2h without use', async () => {
        const s0 = await login(A.users.admin, 'staff');
        const row = await RefreshSession.findOne({ user: A.users.admin._id, revokedAt: null })
            .sort({ createdAt: -1 }).lean();
        // Staff per-token window is still the long sliding one (7d by default).
        expect(new Date(row.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * HOUR);

        await ageSessions(A.users.admin._id, 2 * HOUR);
        const r = await refresh(s0.refreshToken, { idleMs: 3 * HOUR });
        expect(r.status).toBe(200);
        expect(r.body.token).toEqual(expect.any(String));
    });
});
