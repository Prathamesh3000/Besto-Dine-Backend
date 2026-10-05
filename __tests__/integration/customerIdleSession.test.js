/**
 * QA N14 — customer inactivity timeout.
 *
 * Customer refresh sessions slide by CUSTOMER_IDLE_TIMEOUT_MINUTES
 * (default 60): a refresh within the window works and extends it; after
 * 60 minutes without use the refresh is refused with
 * SESSION_IDLE_TIMEOUT. An absolute cap (REFRESH_TTL_HOURS_CUSTOMER,
 * default 24h) ends even an active session. Staff lifetimes are
 * unchanged. Time travel = rewriting the RefreshSession rows.
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
            },
        });
    }
}

describe('customer refresh session — 60-minute inactivity timeout', () => {
    test('login issues a customer refresh session that expires 60 min out (≤ 24h cap)', async () => {
        const cust = await createCustomer('idle-ttl');
        await login(cust, 'customer');
        const row = await RefreshSession.findOne({ user: cust._id, revokedAt: null }).lean();
        const ttl = new Date(row.expiresAt).getTime() - new Date(row.lastUsedAt).getTime();
        expect(ttl).toBeGreaterThan(59 * MIN);
        expect(ttl).toBeLessThanOrEqual(60 * MIN + 1000);
        const cap = new Date(row.familyExpiresAt).getTime() - new Date(row.createdAt).getTime();
        expect(cap).toBeGreaterThan(23.9 * HOUR);
        expect(cap).toBeLessThanOrEqual(24 * HOUR + 1000);
    });

    test('refresh within 60 min works and extends the window', async () => {
        const cust = await createCustomer('idle-ok');
        const s0 = await login(cust, 'customer');

        await ageSessions(cust._id, 45 * MIN);
        const r1 = await refresh(s0.refreshToken);
        expect(r1.status).toBe(200);
        expect(r1.body.token).toEqual(expect.any(String));

        // The new token restarts the 60-minute window: another 45 min
        // later (90 min after login) it still works.
        await ageSessions(cust._id, 45 * MIN);
        const r2 = await refresh(r1.body.refreshToken);
        expect(r2.status).toBe(200);
        expect((await ctx.api.as(r2.body.token).get('/auth/me')).status).toBe(200);
    });

    test('refresh after 60 min idle is refused with SESSION_IDLE_TIMEOUT', async () => {
        const cust = await createCustomer('idle-expired');
        const s0 = await login(cust, 'customer');

        await ageSessions(cust._id, 61 * MIN);
        const r = await refresh(s0.refreshToken);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_IDLE_TIMEOUT');
        expect(r.body.message).toMatch(/sign in again/i);
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

    test('absolute 24h cap ends even an active customer session', async () => {
        const cust = await createCustomer('idle-cap');
        const s0 = await login(cust, 'customer');
        // Recently used, but the login itself is 25h old.
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
