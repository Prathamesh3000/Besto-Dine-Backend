/**
 * Auth flows through the real HTTP stack (routes/authRoute.js →
 * controllers/authController.js + middlewares/authMiddleware.js).
 *
 * Complements securityRegressions.test.js (OTP attempt / send caps,
 * refresh rotation + reuse, password-change / logout-all revocation,
 * NoSQL login injection, mustChangePassword), customerIdleSession.test.js
 * (customer idle + absolute caps) and selfSignup.test.js (SIGNUP_PENDING /
 * SIGNUP_REJECTED / TENANT_SUSPENDED at login). Nothing here repeats them.
 *
 * Covered here: register, customer / staff / superadmin login and the
 * role-separation guards, multi-tenant staff email disambiguation,
 * response hygiene (no hashes / foreign tokens), mid-session tenant
 * lockout, OTP single-use / staff block / expiry, refresh edge cases and
 * token-type confusion, logout, forgot / reset password, change-password
 * validation, and Google Sign-In (utils/googleAuth mocked — no network).
 */
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, DEFAULT_PASSWORD } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const mockVerifyGoogle = jest.fn();
const mockGoogleConfigured = jest.fn(() => true);
jest.mock('../../utils/googleAuth', () => ({
    verifyGoogleIdToken: (...args) => mockVerifyGoogle(...args),
    isGoogleAuthConfigured: () => mockGoogleConfigured(),
}));

const BACKEND = path.join(__dirname, '..', '..');
const User = require(path.join(BACKEND, 'models/user'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const RefreshSession = require(path.join(BACKEND, 'models/refreshSession'));
const Otp = require(path.join(BACKEND, 'models/otp'));
const Shift = require(path.join(BACKEND, 'models/shift'));
const PasswordResetToken = require(path.join(BACKEND, 'models/passwordResetToken'));
const logger = require(path.join(BACKEND, 'utils/logger'));
const { signTypedToken } = require(path.join(BACKEND, 'middlewares/authMiddleware'));

const ctx = useIntegrationApp();
let A;
let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'autha' });
    B = await seedTenant({ label: 'authb' });
});

beforeEach(() => {
    mockVerifyGoogle.mockReset();
    mockGoogleConfigured.mockReset().mockReturnValue(true);
});

const rand = () => crypto.randomBytes(4).toString('hex');
let mobileSeq = 0;
/** A fresh valid Indian mobile per call (run-unique prefix). */
const freshMobile = () => {
    mobileSeq += 1;
    return `9${String(Date.now() % 1e5).padStart(5, '0')}${String(mobileSeq).padStart(4, '0')}`;
};

const post = (p, body, headers = {}) => {
    let r = ctx.api.anon().post(p);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
};
const login = (body, headers) => post('/auth/login', body, headers);

/** No bcrypt hash or password field anywhere in a response body. */
function expectNoSecrets(body) {
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/\$2[aby]\$\d{2}\$/);
    expect(s).not.toMatch(/"password"/);
    expect(s).not.toMatch(/"tokenVersion"/);
    expect(s).not.toMatch(/"googleId"/);
}

function lastLoggedOtp(mobile) {
    const hits = logger.__records
        .map((r) => String(r.args[0] || ''))
        .filter((m) => m.startsWith(`[DEV] OTP for ${mobile}:`));
    return hits.length ? hits[hits.length - 1].split(': ')[1] : null;
}

/** The raw reset token from the dev-mode email log line for `email`. */
function lastResetToken() {
    const hits = logger.__records
        .map((r) => String(r.args[0] || ''))
        .map((m) => m.match(/reset-password\?token=([0-9a-f]{64})/))
        .filter(Boolean);
    return hits.length ? hits[hits.length - 1][1] : null;
}

// ─── Register ─────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
    const valid = () => ({
        name: '  New Diner ',
        email: `New.${rand()}@Diners.Test`,
        password: 'Strong#Pass123',
        mobile: freshMobile(),
    });

    test('creates a customer, returns a working session and no secrets', async () => {
        const body = valid();
        const res = await post('/auth/register', body);
        expect(res.status).toBe(201);
        expect(res.body.role).toBe('customer');
        expect(res.body.name).toBe('New Diner');
        expect(res.body.email).toBe(body.email.toLowerCase());
        expect(res.body.token).toEqual(expect.any(String));
        expect(res.body.refreshToken).toEqual(expect.any(String));
        expectNoSecrets(res.body);

        const saved = await User.findOne({ email: body.email.toLowerCase() }).select('+password').lean();
        expect(saved.password).toMatch(/^\$2[aby]\$12\$/);
        expect(saved.password).not.toBe(body.password);
        expect((await ctx.api.as(res.body.token).get('/auth/me')).status).toBe(200);
    });

    test('role / restaurant / isTenantOwner in the body are ignored (no privilege escalation)', async () => {
        const body = {
            ...valid(), role: 'superadmin', superadminLevel: 'full',
            restaurant: String(A.restaurant._id), isTenantOwner: true, permissions: { editMenu: true },
        };
        const res = await post('/auth/register', body);
        expect(res.status).toBe(201);
        const saved = await User.findOne({ email: body.email.toLowerCase() }).lean();
        expect(saved.role).toBe('customer');
        expect(saved.superadminLevel || '').toBe('');
        expect(saved.restaurant || null).toBeNull();
        expect(saved.isTenantOwner).toBe(false);
        expect(saved.permissions || {}).toEqual({});
    });

    test('an existing email gets a generic answer (no account enumeration)', async () => {
        const cust = await createCustomer('dupe');
        const res = await post('/auth/register', { ...valid(), email: cust.email.toUpperCase() });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('REGISTER_FAILED');
        expect(res.body.message).not.toMatch(/already registered/i);
        expect(res.body.token).toBeUndefined();
    });

    test.each([
        ['weak password (no special char)', { password: 'Weakpass123' }, 'WEAK_PASSWORD'],
        ['short password', { password: 'Ab#1' }, undefined],
        ['bad mobile', { mobile: '12345' }, undefined],
        ['bad email', { email: 'not-an-email' }, undefined],
        ['blank name', { name: '   ' }, undefined],
        ['non-string allergy', { allergy: { $gt: '' } }, undefined],
    ])('%s → 400, no user created', async (_label, patch, code) => {
        const body = { ...valid(), ...patch };
        const before = await User.countDocuments();
        const res = await post('/auth/register', body);
        expect(res.status).toBe(400);
        if (code) expect(res.body.code).toBe(code);
        expect(await User.countDocuments()).toBe(before);
    });
});

// ─── Customer login & role separation ─────────────────────────────────

describe('POST /auth/login — customer', () => {
    test('success: session + profile, never the hash; tokens are per-login', async () => {
        const cust = await createCustomer('login');
        const r1 = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        const r2 = await login({ email: cust.email.toUpperCase(), password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expectNoSecrets(r1.body);
        expect(r1.body._id).toBe(String(cust._id));
        expect(r1.body.refreshToken).not.toBe(r2.body.refreshToken);
        const decoded = jwt.decode(r1.body.token);
        expect(decoded).toMatchObject({ id: String(cust._id), typ: 'user', role: 'customer', tv: 0 });
        expect(decoded.exp - decoded.iat).toBe(30 * 60);
        // Only a hash of the refresh token is stored.
        const rows = await RefreshSession.find({ user: cust._id }).lean();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.tokenHash).not.toBe(r1.body.refreshToken);
            expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    test('wrong password and unknown email are indistinguishable', async () => {
        const cust = await createCustomer('wrongpw');
        const wrong = await login({ email: cust.email, password: 'Nope#12345', loginType: 'customer' });
        const unknown = await login({ email: `ghost.${rand()}@x.test`, password: 'Nope#12345', loginType: 'customer' });
        expect(wrong.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(wrong.body).toEqual(unknown.body);
    });

    test('a deactivated account is refused after the password check (no session)', async () => {
        const cust = await createCustomer('inactive', { status: 'inactive' });
        const ok = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect(ok.status).toBe(401);
        expect(ok.body.message).toMatch(/deactivated/);
        expect(ok.body.token).toBeUndefined();
        // Wrong password does not reveal the account state.
        const bad = await login({ email: cust.email, password: 'Nope#12345', loginType: 'customer' });
        expect(bad.status).toBe(401);
        expect(bad.body.message).toBe('Invalid email or password');
        expect(await RefreshSession.countDocuments({ user: cust._id })).toBe(0);
    });

    test('a Google-only account is steered to Google instead of a 500', async () => {
        const email = `g.${rand()}@gmail.test`;
        await User.collection.insertOne({
            name: 'G Only', email, role: 'customer', status: 'active',
            googleId: `sub-${rand()}`, authProviders: ['google'], tokenVersion: 0, createdAt: new Date(),
        });
        const res = await login({ email, password: 'Whatever#123', loginType: 'customer' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('USE_GOOGLE_SIGNIN');
    });

    test.each([
        ['staff creds on the customer form', () => A.users.waiter, { loginType: 'customer' }],
        ['customer creds on the staff form', async () => createCustomer('onstaff'), { loginType: 'staff' }],
        ['waiter picking the admin tile', () => A.users.waiter, { loginType: 'staff', expectedRole: 'admin' }],
        ['customer with expectedRole=admin', async () => createCustomer('exp'), { expectedRole: 'admin' }],
    ])('%s → generic 401, no session', async (_label, getUser, extra) => {
        const user = await getUser();
        const headers = user.restaurant ? { 'X-Restaurant-Slug': A.slug } : {};
        const before = await RefreshSession.countDocuments({ user: user._id });
        const res = await login({ email: user.email, password: DEFAULT_PASSWORD, ...extra }, headers);
        expect(res.status).toBe(401);
        expect(res.body.message).toBe('Invalid email or password');
        expect(res.body.token).toBeUndefined();
        expect(await RefreshSession.countDocuments({ user: user._id })).toBe(before);
    });
});

// ─── Staff login & multi-tenancy ──────────────────────────────────────

describe('POST /auth/login — staff', () => {
    test('staff login opens an auto shift; logout with the access token closes it', async () => {
        const chef = await createUser({
            name: 'Shift Chef', email: `chef.${rand()}@staff.test`, role: 'chef',
            restaurant: A.restaurant._id, branch: A.branch._id,
        });
        const res = await login({ email: chef.email, password: DEFAULT_PASSWORD, loginType: 'staff', expectedRole: 'chef' },
            { 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(200);
        expect(res.body.tenant).toMatchObject({ slug: A.slug });
        expectNoSecrets(res.body);
        const open = await Shift.findOne({ staff: chef._id, status: 'active' }).lean();
        expect(open).toBeTruthy();

        // A second login does not open a second shift (idempotent).
        await login({ email: chef.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': A.slug });
        expect(await Shift.countDocuments({ staff: chef._id, status: 'active' })).toBe(1);

        const out = await ctx.api.as(res.body.token).post('/auth/logout').send({ refreshToken: res.body.refreshToken });
        expect(out.status).toBe(200);
        expect(await Shift.countDocuments({ staff: chef._id, status: 'active' })).toBe(0);
        const closed = await Shift.findOne({ staff: chef._id, status: 'completed' }).lean();
        expect(closed.note).toMatch(/Auto-closed on logout/);
        const row = await RefreshSession.findOne({ user: chef._id, revokedAt: { $ne: null } }).lean();
        expect(row).toBeTruthy();
    });

    describe('same email at two tenants', () => {
        let email;
        let inA;
        let inB;
        beforeAll(async () => {
            email = `shared.${rand()}@staff.test`;
            inA = await createUser({ name: 'Shared A', email, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id });
            inB = await createUser({ name: 'Shared B', email, role: 'waiter', restaurant: B.restaurant._id, branch: B.branch._id });
        });

        test('without a tenant slug → 409 TENANT_DISAMBIGUATION_REQUIRED', async () => {
            const res = await login({ email, password: DEFAULT_PASSWORD, loginType: 'staff' });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('TENANT_DISAMBIGUATION_REQUIRED');
            expect(res.body.token).toBeUndefined();
        });

        test.each([
            ['X-Restaurant-Slug', (t) => ({ 'X-Restaurant-Slug': t.slug })],
            ['X-Restaurant', (t) => ({ 'X-Restaurant': t.slug.toUpperCase() })],
        ])('the %s header picks the right account', async (_h, headersFor) => {
            const ra = await login({ email, password: DEFAULT_PASSWORD, loginType: 'staff' }, headersFor(A));
            const rb = await login({ email, password: DEFAULT_PASSWORD, loginType: 'staff' }, headersFor(B));
            expect(ra.status).toBe(200);
            expect(rb.status).toBe(200);
            expect(ra.body._id).toBe(String(inA._id));
            expect(rb.body._id).toBe(String(inB._id));
            expect(String(ra.body.restaurant)).toBe(String(A.restaurant._id));
            expect(String(rb.body.restaurant)).toBe(String(B.restaurant._id));
        });

        test('?restaurant= query also disambiguates', async () => {
            const res = await ctx.api.raw.post(`/api/v1/auth/login?restaurant=${B.slug}`)
                .send({ email, password: DEFAULT_PASSWORD, loginType: 'staff' });
            expect(res.status).toBe(200);
            expect(res.body._id).toBe(String(inB._id));
        });

        test('a malformed slug is ignored (no lookup), falling back to the 409', async () => {
            const res = await login({ email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': '$ne' });
            expect(res.status).toBe(409);
        });
    });

    test("tenant-A staff naming tenant B's slug never gets a tenant-B session", async () => {
        // The per-tenant lookup misses, then the global single-match
        // fallback authenticates the user into THEIR OWN tenant. The
        // security property: the session is scoped to A, never B.
        const res = await login({ email: A.users.captain.email, password: DEFAULT_PASSWORD, loginType: 'staff' },
            { 'X-Restaurant-Slug': B.slug });
        expect(res.status).toBe(200);
        expect(String(res.body.restaurant)).toBe(String(A.restaurant._id));
        expect(res.body.tenant.slug).toBe(A.slug);
        const me = await ctx.api.as(res.body.token).get('/auth/me').set('X-Restaurant-Slug', B.slug);
        expect(me.status).toBe(200);
        expect(me.body.user.tenant.slug).toBe(A.slug);
    });

    test('a wrong staff password with the right slug → 401', async () => {
        const res = await login({ email: B.users.waiter.email, password: 'Integration#Pass124', loginType: 'staff' },
            { 'X-Restaurant-Slug': B.slug });
        expect(res.status).toBe(401);
    });
});

// ─── Superadmin ───────────────────────────────────────────────────────

describe('superadmin login', () => {
    let sa;
    beforeAll(async () => {
        sa = await createUser({ name: 'Platform', email: `sa.${rand()}@bestodine.test`, role: 'superadmin', superadminLevel: 'full' });
    });

    test('logs in from the staff form, any tenant slug, 15-minute access token', async () => {
        for (const headers of [{}, { 'X-Restaurant-Slug': A.slug }]) {
            // eslint-disable-next-line no-await-in-loop
            const res = await login({ email: sa.email, password: DEFAULT_PASSWORD, loginType: 'staff', expectedRole: 'admin' }, headers);
            expect(res.status).toBe(200);
            expect(res.body.role).toBe('superadmin');
            expect(res.body.superadminLevel).toBe('full');
            expect(res.body.tenant).toBeUndefined();
            expectNoSecrets(res.body);
            const d = jwt.decode(res.body.token);
            expect(d.exp - d.iat).toBe(15 * 60);
        }
        expect(await Shift.countDocuments({ staff: sa._id })).toBe(0);
    });

    test('is refused on the customer form', async () => {
        const res = await login({ email: sa.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect(res.status).toBe(401);
    });

    test('superadmin refresh session ceiling is 8h', async () => {
        const res = await login({ email: sa.email, password: DEFAULT_PASSWORD, loginType: 'staff' });
        const row = await RefreshSession.findOne({ user: sa._id }).sort({ createdAt: -1 }).lean();
        const hours = (new Date(row.familyExpiresAt) - new Date(row.createdAt)) / 3600000;
        expect(hours).toBeGreaterThan(7.99);
        expect(hours).toBeLessThanOrEqual(8.01);
        expect(res.status).toBe(200);
    });
});

// ─── Mid-session tenant lockout ───────────────────────────────────────

describe('tenant lockout after login', () => {
    async function tenantWithAdmin(fields = {}) {
        const slug = `lk-${rand()}`;
        const r = await Restaurant.create({
            name: `Lock ${slug}`, slug, contactEmail: `${slug}@t.test`, status: 'active',
            subscription: { planName: 'x', planSlug: 'x', status: 'active', features: {}, limits: {} },
            ...fields,
        });
        const admin = await createUser({
            name: 'Lock Admin', email: `admin.${slug}@staff.test`, role: 'admin',
            restaurant: r._id, isTenantOwner: true,
        });
        return { r, admin, slug };
    }

    test('suspension mid-session: /auth/me and /auth/refresh stop working', async () => {
        const { r, admin, slug } = await tenantWithAdmin();
        const s = await login({ email: admin.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': slug });
        expect(s.status).toBe(200);

        await Restaurant.updateOne({ _id: r._id }, { $set: { status: 'suspended' } });
        const me = await ctx.api.as(s.body.token).get('/auth/me');
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('TENANT_SUSPENDED');
        const ref = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(ref.status).toBe(401);
        expect(ref.body.code).toBe('TENANT_SUSPENDED');
        expect(ref.body.token).toBeUndefined();
    });

    test('cancelled tenant → staff login refused', async () => {
        const { admin, slug } = await tenantWithAdmin({ status: 'cancelled' });
        const res = await login({ email: admin.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': slug });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
        expect(res.body.token).toBeUndefined();
    });

    test('deleted tenant → TENANT_MISSING at login', async () => {
        const { r, admin } = await tenantWithAdmin();
        await Restaurant.deleteOne({ _id: r._id });
        const res = await login({ email: admin.email, password: DEFAULT_PASSWORD, loginType: 'staff' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TENANT_MISSING');
    });

    test('past_due / trial tenants still log in', async () => {
        for (const status of ['past_due', 'trial']) {
            // eslint-disable-next-line no-await-in-loop
            const { admin, slug } = await tenantWithAdmin({ status });
            // eslint-disable-next-line no-await-in-loop
            const res = await login({ email: admin.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': slug });
            expect(res.status).toBe(200);
        }
    });

    test('a deactivated staff member loses /auth/me and refresh mid-session', async () => {
        const w = await createUser({ name: 'Soon gone', email: `w.${rand()}@staff.test`, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id });
        const s = await login({ email: w.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': A.slug });
        expect(s.status).toBe(200);
        await User.updateOne({ _id: w._id }, { $set: { status: 'inactive' } });
        expect((await ctx.api.as(s.body.token).get('/auth/me')).status).toBe(401);
        const ref = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(ref.status).toBe(401);
    });

    test('a deleted user’s still-valid access token is refused', async () => {
        const cust = await createCustomer('deleted');
        expect((await ctx.api.as(cust).get('/auth/me')).status).toBe(200);
        await User.deleteOne({ _id: cust._id });
        const res = await ctx.api.as(cust).get('/auth/me');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_REVOKED');
    });
});

// ─── Token-type confusion over HTTP ───────────────────────────────────

describe('token types are not interchangeable', () => {
    test('a refresh token is not a Bearer access token', async () => {
        const cust = await createCustomer('confuse1');
        const s = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        const res = await ctx.api.as(s.body.refreshToken).get('/auth/me');
        expect(res.status).toBe(401);
    });

    test('an access token is not a refresh token', async () => {
        const cust = await createCustomer('confuse2');
        const s = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        const res = await post('/auth/refresh', { refreshToken: s.body.token });
        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
    });

    test('a kiosk token signed with the app secret is not a session', async () => {
        const kiosk = signTypedToken('kiosk', { kind: 'kiosk-track', orderId: 'x' }, { expiresIn: '5m' });
        expect((await ctx.api.as(kiosk).get('/auth/me')).status).toBe(401);
    });

    test('an expired access token → 401 TOKEN_EXPIRED', async () => {
        const cust = await createCustomer('expired');
        const t = jwt.sign({ id: String(cust._id), role: 'customer', typ: 'user', tv: 0, iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET);
        const res = await ctx.api.as(t).get('/auth/me');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    test('a forged role claim (wrong secret) cannot reach staff endpoints', async () => {
        const forged = jwt.sign({ id: String(A.users.admin._id), role: 'admin', typ: 'user', tv: 0 }, 'attacker-secret');
        expect((await ctx.api.as(forged).get('/auth/me')).status).toBe(401);
    });
});

// ─── Refresh edge cases ───────────────────────────────────────────────

describe('POST /auth/refresh — edge cases', () => {
    test.each([
        ['missing', {}],
        ['non-string', { refreshToken: { $ne: null } }],
        ['too long', { refreshToken: 'x'.repeat(201) }],
        ['unknown', { refreshToken: crypto.randomBytes(32).toString('base64url') }],
    ])('%s token → 401 REFRESH_INVALID', async (_label, body) => {
        const res = await post('/auth/refresh', body);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('REFRESH_INVALID');
    });

    test('two tabs racing with the same token inside the grace window both succeed, family kept', async () => {
        const cust = await createCustomer('race');
        const s = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        const first = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        const second = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // Both new tokens still work — no theft response inside the window.
        expect((await post('/auth/refresh', { refreshToken: first.body.refreshToken })).status).toBe(200);
        expect((await post('/auth/refresh', { refreshToken: second.body.refreshToken })).status).toBe(200);
    });

    test('rotation inherits the family ceiling (no sliding forever)', async () => {
        const w = A.users.waiter;
        const s = await login({ email: w.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': A.slug });
        const r1 = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(r1.status).toBe(200);
        const rows = await RefreshSession.find({ user: w._id }).sort({ createdAt: -1 }).limit(2).lean();
        expect(rows[0].family).toBe(rows[1].family);
        expect(new Date(rows[0].familyExpiresAt).getTime()).toBe(new Date(rows[1].familyExpiresAt).getTime());
    });

    test('an expired staff token → REFRESH_INVALID (not the customer idle code)', async () => {
        const w = A.users.chef;
        const s = await login({ email: w.email, password: DEFAULT_PASSWORD, loginType: 'staff' }, { 'X-Restaurant-Slug': A.slug });
        await RefreshSession.updateOne({ user: w._id, revokedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const res = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('REFRESH_INVALID');
    });

    test('tokenVersion bumped out-of-band (admin reset) → SESSION_REVOKED', async () => {
        const cust = await createCustomer('tvbump');
        const s = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        await User.updateOne({ _id: cust._id }, { $inc: { tokenVersion: 1 } });
        const res = await post('/auth/refresh', { refreshToken: s.body.refreshToken });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_REVOKED');
        expect((await ctx.api.as(s.body.token).get('/auth/me')).body.code).toBe('SESSION_REVOKED');
    });
});

// ─── Logout ───────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
    test('revokes only the presented refresh token', async () => {
        const cust = await createCustomer('logout');
        const s1 = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        const s2 = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect((await post('/auth/logout', { refreshToken: s1.body.refreshToken })).status).toBe(200);
        expect((await post('/auth/refresh', { refreshToken: s1.body.refreshToken })).status).toBe(401);
        expect((await post('/auth/refresh', { refreshToken: s2.body.refreshToken })).status).toBe(200);
    });

    test.each([
        ['no body', undefined],
        ['garbage token', { refreshToken: 'nope' }],
        ['object token', { refreshToken: { $ne: null } }],
    ])('is idempotent and always 200 (%s) and clears the cookie', async (_l, body) => {
        const res = await post('/auth/logout', body);
        expect(res.status).toBe(200);
        expect(String(res.headers['set-cookie'] || '')).toMatch(/bestodine_token=;/);
    });

    test('logout-all requires a session', async () => {
        expect((await post('/auth/logout-all', {})).status).toBe(401);
    });
});

// ─── OTP (not covered by securityRegressions) ─────────────────────────

describe('OTP login — single use, staff block, expiry, input checks', () => {
    test('a correct code works exactly once', async () => {
        const mobile = freshMobile();
        expect((await post('/auth/send-otp', { mobile })).status).toBe(200);
        const code = lastLoggedOtp(mobile);
        const first = await post('/auth/verify-otp', { mobile: `+91 ${mobile}`, code });
        expect(first.status).toBe(200);
        expectNoSecrets(first.body);
        const replay = await post('/auth/verify-otp', { mobile, code });
        expect(replay.status).toBe(400);
        expect(replay.body.token).toBeUndefined();
    });

    test('the code is stored hashed, never in the response', async () => {
        const mobile = freshMobile();
        const res = await post('/auth/send-otp', { mobile });
        const code = lastLoggedOtp(mobile);
        expect(JSON.stringify(res.body)).not.toContain(code);
        const rec = await Otp.findOne({ mobile }).sort({ createdAt: -1 }).lean();
        expect(rec.code).toMatch(/^[0-9a-f]{64}$/);
        expect(rec.code).not.toBe(code);
    });

    test('a new send supersedes the previous code', async () => {
        const mobile = freshMobile();
        await post('/auth/send-otp', { mobile });
        const oldCode = lastLoggedOtp(mobile);
        await post('/auth/send-otp', { mobile });
        const newCode = lastLoggedOtp(mobile);
        if (oldCode !== newCode) {
            expect((await post('/auth/verify-otp', { mobile, code: oldCode })).status).not.toBe(200);
        }
        expect((await post('/auth/verify-otp', { mobile, code: newCode })).status).toBe(200);
    });

    test('an expired code is refused', async () => {
        const mobile = freshMobile();
        await post('/auth/send-otp', { mobile });
        const code = lastLoggedOtp(mobile);
        await Otp.updateMany({ mobile }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const res = await post('/auth/verify-otp', { mobile, code });
        expect(res.status).toBe(400);
        expect(res.body.token).toBeUndefined();
    });

    test("a staff member's mobile never gets a session via OTP", async () => {
        const mobile = freshMobile();
        const w = await createUser({ name: 'OTP waiter', email: `otpw.${rand()}@staff.test`, role: 'waiter', mobile, restaurant: A.restaurant._id, branch: A.branch._id });
        await post('/auth/send-otp', { mobile });
        const res = await post('/auth/verify-otp', { mobile, code: lastLoggedOtp(mobile) });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('STAFF_OTP_BLOCKED');
        expect(res.body.token).toBeUndefined();
        expect(await User.countDocuments({ mobile, role: 'customer' })).toBe(0);
        expect(await RefreshSession.countDocuments({ user: w._id })).toBe(0);
    });

    test('a deactivated customer cannot sign in by OTP', async () => {
        const mobile = freshMobile();
        await createCustomer('otpoff', { mobile, status: 'inactive' });
        await post('/auth/send-otp', { mobile });
        const res = await post('/auth/verify-otp', { mobile, code: lastLoggedOtp(mobile) });
        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
    });

    test.each([
        ['send: invalid mobile', '/auth/send-otp', { mobile: '12345' }],
        ['send: object mobile', '/auth/send-otp', { mobile: { $gt: '' } }],
        ['verify: missing code', '/auth/verify-otp', { mobile: '9876543210' }],
        ['verify: non-numeric code', '/auth/verify-otp', { mobile: '9876543210', code: 'abcdef' }],
        ['verify: object code', '/auth/verify-otp', { mobile: '9876543210', code: { $ne: null } }],
    ])('%s → 400', async (_l, p, body) => {
        const res = await post(p, body);
        expect(res.status).toBe(400);
    });

    test('verify with no outstanding code → 400', async () => {
        const res = await post('/auth/verify-otp', { mobile: freshMobile(), code: '123456' });
        expect(res.status).toBe(400);
    });
});

// ─── Forgot / reset password ──────────────────────────────────────────

describe('forgot / reset password', () => {
    const GENERIC = 'If an account exists for that email, a reset link is on its way.';

    test('unknown, staff and customer addresses get the identical answer', async () => {
        const cust = await createCustomer('forgot');
        const unknown = await post('/auth/forgot-password', { email: `ghost.${rand()}@x.test` });
        const staff = await post('/auth/forgot-password', { email: A.users.admin.email });
        const real = await post('/auth/forgot-password', { email: cust.email });
        for (const r of [unknown, staff, real]) {
            expect(r.status).toBe(200);
            expect(r.body).toEqual({ success: true, message: GENERIC });
        }
        // Staff never get a self-service reset token.
        expect(await PasswordResetToken.countDocuments({ user: A.users.admin._id })).toBe(0);
        const tok = await PasswordResetToken.findOne({ user: cust._id }).lean();
        expect(tok.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(tok.tokenHash).not.toBe(lastResetToken());
    });

    test('full reset: new password works, old fails, old sessions die, token is single-use', async () => {
        const cust = await createCustomer('reset');
        const s = await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        await post('/auth/forgot-password', { email: cust.email });
        const token = lastResetToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);

        const res = await post('/auth/reset-password', { token, newPassword: 'Reset#Pass9876' });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeUndefined();

        expect((await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' })).status).toBe(401);
        expect((await login({ email: cust.email, password: 'Reset#Pass9876', loginType: 'customer' })).status).toBe(200);
        expect((await ctx.api.as(s.body.token).get('/auth/me')).status).toBe(401);
        expect((await post('/auth/refresh', { refreshToken: s.body.refreshToken })).status).toBe(401);

        const again = await post('/auth/reset-password', { token, newPassword: 'Another#Pass111' });
        expect(again.status).toBe(400);
        expect(again.body.code).toBe('TOKEN_INVALID');
    });

    test('an expired token is refused', async () => {
        const cust = await createCustomer('resetexp');
        await post('/auth/forgot-password', { email: cust.email });
        const token = lastResetToken();
        await PasswordResetToken.updateMany({ user: cust._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const res = await post('/auth/reset-password', { token, newPassword: 'Reset#Pass9876' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOKEN_INVALID');
        expect((await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' })).status).toBe(200);
    });

    test('requesting a new link retires the old one; links expire in 30 min', async () => {
        const cust = await createCustomer('reset2');
        await post('/auth/forgot-password', { email: cust.email });
        const first = lastResetToken();
        await post('/auth/forgot-password', { email: cust.email });
        const second = lastResetToken();
        expect(second).not.toBe(first);
        expect((await post('/auth/reset-password', { token: first, newPassword: 'Reset#Pass9876' })).body.code).toBe('TOKEN_INVALID');
        const live = await PasswordResetToken.findOne({ user: cust._id, usedAt: null }).lean();
        const minutes = (new Date(live.expiresAt) - new Date(live.createdAt)) / 60000;
        expect(minutes).toBeGreaterThan(29.9);
        expect(minutes).toBeLessThanOrEqual(30.1);
        expect((await post('/auth/reset-password', { token: second, newPassword: 'Reset#Pass9876' })).status).toBe(200);
    });

    test('per-account throttle: at most 3 links per 15 minutes', async () => {
        const cust = await createCustomer('reset3');
        for (let i = 0; i < 5; i++) {
            // eslint-disable-next-line no-await-in-loop
            expect((await post('/auth/forgot-password', { email: cust.email })).status).toBe(200);
        }
        expect(await PasswordResetToken.countDocuments({ user: cust._id })).toBe(3);
    });

    test('a weak new password is refused WITHOUT burning the token', async () => {
        const cust = await createCustomer('reset4');
        await post('/auth/forgot-password', { email: cust.email });
        const token = lastResetToken();
        const weak = await post('/auth/reset-password', { token, newPassword: 'weakweakweak' });
        expect(weak.status).toBe(400);
        expect(weak.body.code).toBe('WEAK_PASSWORD');
        expect((await post('/auth/reset-password', { token, newPassword: 'Strong#Pass321' })).status).toBe(200);
    });

    test.each([
        ['unknown token', { token: 'f'.repeat(64), newPassword: 'Strong#Pass321' }, 400],
        ['object token', { token: { $ne: null }, newPassword: 'Strong#Pass321' }, 400],
        ['missing password', { token: 'f'.repeat(64) }, 400],
    ])('%s → %i', async (_l, body, status) => {
        expect((await post('/auth/reset-password', body)).status).toBe(status);
    });

    test('a Google-only customer who resets gains the password provider', async () => {
        const email = `greset.${rand()}@gmail.test`;
        const { insertedId } = await User.collection.insertOne({
            name: 'G Reset', email, role: 'customer', status: 'active',
            googleId: `sub-${rand()}`, authProviders: ['google'], tokenVersion: 0, createdAt: new Date(),
        });
        await post('/auth/forgot-password', { email });
        const res = await post('/auth/reset-password', { token: lastResetToken(), newPassword: 'Strong#Pass321' });
        expect(res.status).toBe(200);
        const u = await User.findById(insertedId).lean();
        expect(u.authProviders.sort()).toEqual(['google', 'password']);
        expect((await login({ email, password: 'Strong#Pass321', loginType: 'customer' })).status).toBe(200);
    });
});

// ─── Change password validation ───────────────────────────────────────

describe('PUT /auth/change-password', () => {
    test('wrong current password → 401, password unchanged, sessions intact', async () => {
        const cust = await createCustomer('cpw');
        const res = await ctx.api.as(cust).put('/auth/change-password')
            .send({ currentPassword: 'Wrong#Pass123', newPassword: 'Changed#Pass4567' });
        expect(res.status).toBe(401);
        expect((await ctx.api.as(cust).get('/auth/me')).status).toBe(200);
        expect((await login({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' })).status).toBe(200);
    });

    test.each([
        ['no special char', 'Changed4567xx'],
        ['no uppercase', 'changed#4567'],
        ['short', 'Ab#1'],
    ])('weak new password (%s) → 400', async (_l, newPassword) => {
        const cust = await createCustomer('cpw2');
        const res = await ctx.api.as(cust).put('/auth/change-password').send({ currentPassword: DEFAULT_PASSWORD, newPassword });
        expect(res.status).toBe(400);
    });

    test('requires a session', async () => {
        const res = await ctx.api.anon().put('/auth/change-password').send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'Changed#Pass4567' });
        expect(res.status).toBe(401);
    });

    test('clears mustChangePassword so the staff member is unblocked', async () => {
        const w = await createUser({ name: 'Temp pw', email: `tmp.${rand()}@staff.test`, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id, mustChangePassword: true });
        const res = await ctx.api.as(w).put('/auth/change-password').send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'Changed#Pass4567' });
        expect(res.status).toBe(200);
        expect((await User.findById(w._id).lean()).mustChangePassword).toBe(false);
        expect((await ctx.api.as(res.body.token).get('/orders/live')).body.code).not.toBe('PASSWORD_CHANGE_REQUIRED');
    });
});

// ─── Google Sign-In (verifier mocked) ─────────────────────────────────

describe('POST /auth/google', () => {
    const profile = (over = {}) => ({
        googleId: `g-${rand()}`, email: `gg.${rand()}@gmail.test`, emailVerified: true,
        name: 'Gee User', picture: 'https://lh3.googleusercontent.test/a.png', ...over,
    });
    const google = (body = { credential: 'tok' }) => post('/auth/google', body);

    test('not configured → 503', async () => {
        mockGoogleConfigured.mockReturnValue(false);
        const res = await google();
        expect(res.status).toBe(503);
        expect(mockVerifyGoogle).not.toHaveBeenCalled();
    });

    test('verifier rejects the token → generic 401', async () => {
        mockVerifyGoogle.mockRejectedValue(new Error('bad aud'));
        const res = await google();
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('GOOGLE_AUTH_FAILED');
        expect(JSON.stringify(res.body)).not.toContain('bad aud');
    });

    test('a profile without a subject is rejected (never matches password-only users)', async () => {
        mockVerifyGoogle.mockResolvedValue(profile({ googleId: undefined }));
        expect((await google()).status).toBe(401);
    });

    test('new verified email → customer created with no password, needsMobile', async () => {
        const p = profile();
        mockVerifyGoogle.mockResolvedValue(p);
        const res = await google({ idToken: 'tok' });
        expect(res.status).toBe(200);
        expect(res.body.role).toBe('customer');
        expect(res.body.needsMobile).toBe(true);
        expectNoSecrets(res.body);
        const u = await User.findOne({ googleId: p.googleId }).select('+password').lean();
        expect(u.password).toBeUndefined();
        expect(u.authProviders).toEqual(['google']);
        // Second sign-in matches on googleId even if the email changed.
        mockVerifyGoogle.mockResolvedValue({ ...p, email: `changed.${rand()}@gmail.test` });
        const again = await google();
        expect(again.status).toBe(200);
        expect(again.body._id).toBe(String(u._id));
    });

    test('new UNverified email → refused, nothing created', async () => {
        const p = profile({ emailVerified: false });
        mockVerifyGoogle.mockResolvedValue(p);
        expect((await google()).status).toBe(401);
        expect(await User.countDocuments({ email: p.email })).toBe(0);
    });

    test('existing password customer + verified email → linked, avatar not overwritten when set', async () => {
        const cust = await createCustomer('glink', { avatar: 'https://cdn.test/mine.png' });
        const p = profile({ email: cust.email });
        mockVerifyGoogle.mockResolvedValue(p);
        const res = await google();
        expect(res.status).toBe(200);
        expect(res.body._id).toBe(String(cust._id));
        const u = await User.findById(cust._id).lean();
        expect(u.googleId).toBe(p.googleId);
        expect(u.authProviders.sort()).toEqual(['google', 'password']);
        expect(u.avatar).toBe('https://cdn.test/mine.png');
    });

    test('existing customer + UNverified Google email → no link (account takeover gate)', async () => {
        const cust = await createCustomer('gnolink');
        mockVerifyGoogle.mockResolvedValue(profile({ email: cust.email, emailVerified: false }));
        const res = await google();
        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
        expect((await User.findById(cust._id).lean()).googleId).toBeUndefined();
    });

    test('staff email → same generic refusal, staff account untouched', async () => {
        mockVerifyGoogle.mockResolvedValue(profile({ email: A.users.admin.email }));
        const res = await google();
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('GOOGLE_AUTH_FAILED');
        expect((await User.findById(A.users.admin._id).lean()).googleId).toBeUndefined();
    });

    test('a staff account that carries a googleId still cannot use Google', async () => {
        const gid = `g-staff-${rand()}`;
        await User.updateOne({ _id: A.users.chef._id }, { $set: { googleId: gid } });
        try {
            mockVerifyGoogle.mockResolvedValue(profile({ googleId: gid, email: A.users.chef.email }));
            const res = await google();
            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
        } finally {
            await User.updateOne({ _id: A.users.chef._id }, { $unset: { googleId: 1 } });
        }
    });

    test('a deactivated Google customer is refused', async () => {
        const p = profile();
        await User.collection.insertOne({
            name: 'G off', email: p.email, role: 'customer', status: 'inactive',
            googleId: p.googleId, authProviders: ['google'], tokenVersion: 0, createdAt: new Date(),
        });
        mockVerifyGoogle.mockResolvedValue(p);
        const res = await google();
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/deactivated/);
    });
});

// ─── OTP daily cap ────────────────────────────────────────────────────

describe('send-otp daily cap', () => {
    test('the per-mobile daily counter refuses sends past OTP_DAILY_SEND_CAP (default 10)', async () => {
        const { OtpSendCounter } = require(path.join(BACKEND, 'models/otp'));
        const mobile = freshMobile();
        const day = new Date().toISOString().slice(0, 10);
        await OtpSendCounter.create({ mobile, day, count: 10, expiresAt: new Date(Date.now() + 2 * 86400000) });
        const res = await post('/auth/send-otp', { mobile });
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('OTP_DAILY_LIMIT');
        expect(await Otp.countDocuments({ mobile })).toBe(0);
    });
});

// ─── Profile update (self-service fields only) ────────────────────────

describe('PUT /auth/profile', () => {
    test('identity / privilege fields in the body are ignored', async () => {
        const cust = await createCustomer('prof');
        const res = await ctx.api.as(cust).put('/auth/profile').send({
            name: '  Renamed  ', email: 'hijack@x.test', role: 'admin', restaurant: String(A.restaurant._id),
            isTenantOwner: true, tokenVersion: 99, permissions: { editMenu: true }, status: 'active',
            password: 'Hijack#Pass123', superadminLevel: 'full',
        });
        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe('Renamed');
        expectNoSecrets(res.body);
        const u = await User.findById(cust._id).select('+password').lean();
        expect(u.email).toBe(cust.email);
        expect(u.role).toBe('customer');
        expect(u.restaurant || null).toBeNull();
        expect(u.isTenantOwner).toBe(false);
        expect(u.tokenVersion).toBe(0);
        expect(u.permissions || {}).toEqual({});
        expect(u.password).toBe(cust.password);
        // Old token still valid (tokenVersion untouched), old password still works.
        expect((await ctx.api.as(cust).get('/auth/me')).status).toBe(200);
    });

    test.each([
        ['javascript: avatar', { avatar: 'javascript:alert(1)' }],
        ['data: avatar', { avatar: 'data:text/html,<script>alert(1)</script>' }],
        ['empty name', { name: '   ' }],
        ['101-char name', { name: 'x'.repeat(101) }],
        ['bad mobile', { mobile: '12345' }],
        ['future dob', { dob: new Date(Date.now() + 86400000).toISOString() }],
        ['bad gender', { gender: 'robot' }],
        ['bad diet', { dietaryPreference: 'carnivore' }],
        ['bad language', { preferredLanguage: 'xx' }],
        ['bad pincode', { address: { pincode: '012345' } }],
    ])('%s → 400', async (_l, body) => {
        const cust = await createCustomer('prof400');
        const res = await ctx.api.as(cust).put('/auth/profile').send(body);
        expect(res.status).toBe(400);
    });

    test('allowed avatar forms are accepted', async () => {
        const cust = await createCustomer('profav');
        for (const avatar of ['https://cdn.test/a.png', '/uploads/a.png', '']) {
            // eslint-disable-next-line no-await-in-loop
            expect((await ctx.api.as(cust).put('/auth/profile').send({ avatar })).status).toBe(200);
        }
    });

    // Regression (fixed 2026-10): updateProfile rejects non-string name / mobile / allergy / avatar with 400.
    test.each([
        ['numeric name', { name: 12345 }],
        ['object mobile', { mobile: { $gt: '' } }],
        ['array allergy', { allergy: ['nuts'] }],
    ])('%s should be a 400, not a 500', async (_l, body) => {
        const cust = await createCustomer('profbug');
        const res = await ctx.api.as(cust).put('/auth/profile').send(body);
        expect(res.status).toBe(400);
    });
});

afterAll(async () => {
    await settle(100);
});
