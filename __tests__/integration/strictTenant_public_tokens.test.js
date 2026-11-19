/**
 * STRICT multi-tenancy: token and role confusion. A JWT of tenant A (any
 * role) combined with tenant B's identifiers must never yield B access;
 * forged / expired / none-alg / tampered / wrong-type tokens must never
 * authenticate; customer, staff, owner and platform tokens must stay on
 * their own route classes.
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const User = require(path.join(BACKEND, 'models/user'));
const { signTypedToken, TOKEN_TYPES } = require(path.join(BACKEND, 'middlewares/authMiddleware'));

const ctx = useIntegrationApp();
let A;
let B;
let superUser;
let customer;
let managerA;

const V1 = '/api/v1';
const bearer = (t) => `Bearer ${t}`;
const call = (method, p, token, extra = {}) => {
    let r = ctx.api.raw[method](`${V1}${p}`);
    if (token) r = r.set('Authorization', bearer(token));
    for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
    return r;
};
const text = (res) => JSON.stringify(res.body || {});
const sees = (res, t) => text(res).includes(String(t.items.paneer._id));
const sign = (payload, opts = {}) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '10m', ...opts });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

beforeAll(async () => {
    A = await seedTenant({ label: 'tk-a' });
    B = await seedTenant({ label: 'tk-b' });
    superUser = await createUser({ name: 'Root', email: `root.${Date.now()}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
    customer = await createCustomer('tk-cust');
    managerA = await createUser({
        name: 'Mgr A', email: `mgr.${A.slug}@staff.test`, role: 'manager',
        restaurant: A.restaurant._id, branch: null, isTenantOwner: false,
    });
});

describe('forged / malformed tokens never authenticate', () => {
    const adminId = () => String(A.users.admin._id);

    test('alg:none token for the A owner → not authenticated', async () => {
        const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: adminId(), role: 'admin', typ: 'user', tv: 0 })}.`;
        const res = await call('get', '/orders/live', t);
        expect([400, 401]).toContain(res.status);
    });

    test.each(['None', 'NONE', 'nOnE'])('alg:%s variant is rejected', async (alg) => {
        const t = `${b64({ alg, typ: 'JWT' })}.${b64({ id: adminId(), typ: 'user', tv: 0 })}.`;
        const res = await call('get', '/staff', t);
        expect([400, 401]).toContain(res.status);
    });

    test('token signed with a different secret is rejected', async () => {
        const t = jwt.sign({ id: adminId(), role: 'admin', typ: 'user', tv: 0 }, 'not-the-secret', { expiresIn: '10m' });
        const res = await call('get', '/staff', t);
        expect([400, 401]).toContain(res.status);
    });

    test('tampered payload (id swapped to B owner, original signature kept) is rejected', async () => {
        const good = A.users.admin.token.split('.');
        const forged = [good[0], b64({ id: String(B.users.admin._id), role: 'admin', typ: 'user', tv: 0, exp: 4102444800 }), good[2]].join('.');
        const res = await call('get', '/staff', forged);
        expect([400, 401]).toContain(res.status);
    });

    test('truncated / extra-segment / empty-signature tokens are rejected', async () => {
        const t = A.users.admin.token;
        for (const bad of [t.slice(0, -5), `${t}.extra`, `${t.split('.').slice(0, 2).join('.')}.`, 'a.b.c', '..']) {
            const res = await call('get', '/staff', bad);
            expect([400, 401]).toContain(res.status);
        }
    });

    test('expired token for the A owner is rejected on a protected route (TOKEN_EXPIRED / 401)', async () => {
        const t = sign({ id: adminId(), role: 'admin', typ: 'user', tv: 0 }, { expiresIn: -60 });
        const res = await call('get', '/staff', t);
        expect([400, 401]).toContain(res.status);
    });

    test('expired token + valid slug is only ever a GUEST, never staff', async () => {
        const t = sign({ id: adminId(), typ: 'user', tv: 0 }, { expiresIn: -60 });
        const res = await call('get', '/orders/live', t, { 'X-Restaurant-Slug': A.slug });
        expect([401, 403]).toContain(res.status);
    });

    test('not-yet-valid (nbf in the future) token is rejected', async () => {
        const t = sign({ id: adminId(), typ: 'user', tv: 0 }, { notBefore: 3600 });
        const res = await call('get', '/staff', t);
        expect([400, 401]).toContain(res.status);
    });

    test('token whose tokenVersion no longer matches (logout-all / password change) is revoked', async () => {
        const u = await createUser({ name: 'TV', email: `tv.${Date.now()}@s.test`, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id });
        const old = u.token;
        expect((await call('get', '/orders/live', old)).status).toBe(200);
        await User.updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
        const res = await call('get', '/orders/live', old);
        expect(res.status).toBe(401);
    });

    test('a DEACTIVATED user token is refused, even with a valid tenant slug', async () => {
        const u = await createUser({ name: 'Off', email: `off.${Date.now()}@s.test`, role: 'waiter', restaurant: A.restaurant._id, branch: A.branch._id });
        await User.updateOne({ _id: u._id }, { $set: { status: 'inactive' } });
        const res = await call('get', '/orders/live', u.token, { 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(401);
    });

    test('a token for a user that no longer exists is refused', async () => {
        const ghost = sign({ id: '64b7f0f0f0f0f0f0f0f0f0f0', typ: 'user', tv: 0 });
        const res = await call('get', '/orders/live', ghost, { 'X-Restaurant-Slug': A.slug });
        expect([401, 403]).toContain(res.status);
    });

    test('session cookie is ignored while cookie auth is off (no ambient credential)', async () => {
        const res = await ctx.api.raw.get(`${V1}/orders/live`)
            .set('Cookie', `bestodine_token=${A.users.admin.token}`)
            .set('X-Restaurant-Slug', A.slug);
        expect([401, 403]).toContain(res.status);
    });

    test('lower-case "bearer" / token in query string is not accepted', async () => {
        const r1 = await ctx.api.raw.get(`${V1}/orders/live`).set('Authorization', `bearer ${A.users.admin.token}`).set('X-Restaurant-Slug', A.slug);
        expect([401, 403]).toContain(r1.status);
        const r2 = await ctx.api.raw.get(`${V1}/orders/live?token=${A.users.admin.token}&access_token=${A.users.admin.token}`).set('X-Restaurant-Slug', A.slug);
        expect([401, 403]).toContain(r2.status);
    });
});

describe('claim tampering with a VALID signature (we hold the secret) cannot escalate', () => {
    test('role claim "superadmin" on a waiter token is ignored (role comes from the database)', async () => {
        const t = sign({ id: String(A.users.waiter._id), role: 'superadmin', superadminLevel: 'full', typ: 'user', tv: 0 });
        const res = await call('get', '/superadmin/restaurants', t);
        expect(res.status).toBe(403);
    });

    test('role claim "admin" on a waiter token does not open admin routes', async () => {
        const t = sign({ id: String(A.users.waiter._id), role: 'admin', isTenantOwner: true, typ: 'user', tv: 0 });
        const res = await call('get', '/tenant/export', t);
        expect(res.status).toBe(403);
        const res2 = await call('post', '/print/agent-key', t);
        expect(res2.status).toBe(403);
    });

    test('`restaurant` claim of B on an A owner token is ignored: A data, never B', async () => {
        const t = sign({ id: String(A.users.admin._id), role: 'admin', typ: 'user', tv: 0, restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), tenant: String(B.restaurant._id) });
        const res = await call('get', '/menu', t);
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
    });

    test('`branch` claim of B on an A waiter token is ignored', async () => {
        const t = sign({ id: String(A.users.waiter._id), typ: 'user', tv: 0, branch: String(B.branch._id) });
        const res = await call('get', '/orders/live', t);
        expect(res.status).toBe(200);
    });

    test('B owner token with A slug / branch headers still resolves to B only', async () => {
        const res = await call('get', '/menu', B.users.admin.token, { 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(200);
        expect(sees(res, B)).toBe(true);
        expect(sees(res, A)).toBe(false);
        const res2 = await call('get', '/menu', B.users.admin.token, { 'X-Branch-Id': String(A.branch._id) });
        expect(res2.status).toBe(404);
    });

    test('a customer whose profile is bound to tenant A cannot be redirected to B with a B slug', async () => {
        const bound = await createCustomer('tk-bound', { restaurant: A.restaurant._id });
        const res = await call('get', '/menu', bound.token, { 'X-Restaurant-Slug': B.slug });
        expect(res.status).toBe(200);
        expect(sees(res, B)).toBe(false);
    });

    test('Regression (fixed 2026-11): user-token `id` typed as {$ne:null} authenticates as an ARBITRARY user (hardening gap)', async () => {
        // middlewares/authMiddleware.js:95 loadUserForToken does User.findById(decoded.id) with the
        // raw claim; Mongoose passes an operator object through, so {"id":{"$ne":null}} resolves to
        // the first user in the collection (any tenant). Needs a validly SIGNED token, so it is not
        // remotely exploitable without the JWT secret, but it is the only thing between a leaked /
        // mis-issued claim and cross-tenant takeover. Fix: require typeof decoded.id === 'string'
        // and a 24-hex ObjectId in verifyUserToken.
        for (const id of [{ $ne: null }, { $gt: '' }]) {
            const res = await call('get', '/staff', sign({ id, typ: 'user', tv: 0 }));
            expect(res.status).not.toBe(200);
        }
    });
});

describe('wrong token TYPE presented as a session token', () => {
    const adminClaims = () => ({ id: String(A.users.admin._id), tv: 0 });

    test.each([
        ['scan', TOKEN_TYPES.SCAN],
        ['kiosk', TOKEN_TYPES.KIOSK],
        ['agent', TOKEN_TYPES.AGENT],
        ['2fa challenge', '2fa-challenge'],
        ['refresh', 'refresh'],
    ])('a %s-typed token carrying the owner id is not a session', async (_l, typ) => {
        const t = signTypedToken(typ, adminClaims(), { expiresIn: '10m' });
        const res = await call('get', '/staff', t);
        expect([400, 401]).toContain(res.status);
    });

    test('legacy typ-less token that carries scan/kiosk markers is not a user session', async () => {
        for (const extra of [{ tableId: String(A.tables.main._id) }, { kind: 'kiosk-track' }, { orderId: 'x' }]) {
            const t = sign({ ...adminClaims(), ...extra });
            const res = await call('get', '/staff', t);
            expect([400, 401]).toContain(res.status);
        }
    });

    test('a scan token of tenant B is not accepted as authentication on tenant A', async () => {
        const scan = signTypedToken(TOKEN_TYPES.SCAN, { tableId: String(B.tables.main._id), restaurantId: String(B.restaurant._id), sessionId: 'x' }, { expiresIn: '1h' });
        const res = await call('get', '/orders/live', scan, { 'X-Restaurant-Slug': A.slug });
        expect([401, 403]).toContain(res.status);
    });

    test('a scan token cannot be replayed as the kiosk tracking token', async () => {
        const scan = signTypedToken(TOKEN_TYPES.SCAN, { tableId: String(A.tables.main._id), restaurantId: String(A.restaurant._id), sessionId: 's' }, { expiresIn: '1h' });
        const res = await call('get', '/orders/track/ORD-0001', null, { 'X-Kiosk-Token': scan, 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(404);
    });

    test("a kiosk token bound to tenant B does not open a tracking page on A's host", async () => {
        const kiosk = signTypedToken(TOKEN_TYPES.KIOSK, { kind: 'kiosk-track', orderId: 'ORD-9', restaurant: String(B.restaurant._id) }, { expiresIn: '1h' });
        const res = await call('get', '/orders/track/ORD-9', null, { 'X-Kiosk-Token': kiosk, 'X-Restaurant-Slug': A.slug });
        expect(res.status).toBe(404);
    });
});

describe('role classes stay separated', () => {
    const STAFF_ROUTES = [
        ['get', '/orders/live'], ['get', '/orders/past'], ['get', '/staff'], ['get', '/audit'],
        ['get', '/tables'], ['get', '/inventory'], ['get', '/telemetry/stats'],
    ];

    test.each(STAFF_ROUTES)('customer token on %s %s → 401/403, no data', async (m, p) => {
        const res = await call(m, p, customer.token, { 'X-Restaurant-Slug': A.slug });
        expect([401, 403]).toContain(res.status);
        expect(text(res)).not.toContain(A.users.waiter.email);
    });

    test.each([
        ['get', '/staff'], ['get', '/telemetry/stats'], ['post', '/print/agent-key'],
        ['get', '/tenant/export'], ['get', '/developer/api-keys'], ['get', '/branches'],
    ])('waiter token on admin/owner route %s %s → 403', async (m, p) => {
        const res = await call(m, p, A.users.waiter.token);
        expect(res.status).toBe(403);
    });

    test.each([
        ['get', '/tenant/export'], ['get', '/developer/api-keys'], ['post', '/branches'], ['post', '/print/agent-key'],
    ])('non-owner MANAGER of A on owner-only route %s %s', async (m, p) => {
        const res = await call(m, p, managerA.token);
        // /print/agent-key is adminOnly (manager allowed by design); the others are owner-only.
        if (p === '/print/agent-key') expect([200, 400]).toContain(res.status);
        else expect(res.status).toBe(403);
    });

    test('BUG-probe: a branch-pinned sub-admin (role admin, isTenantOwner=false) cannot export or read developer keys', async () => {
        const sub = await createUser({
            name: 'Sub', email: `sub.${Date.now()}@s.test`, role: 'admin',
            restaurant: A.restaurant._id, branch: A.branch._id, isTenantOwner: false,
        });
        for (const p of ['/tenant/export', '/developer/api-keys', '/tenant/billing/current']) {
            const res = await call('get', p, sub.token);
            expect(res.status).toBe(403);
        }
    });

    test.each([
        ['get', '/superadmin/restaurants'], ['get', '/superadmin/plans'], ['get', '/superadmin/audit-logs'],
        ['get', '/superadmin/analytics'], ['get', '/superadmin/pending-approvals'], ['get', '/superadmin/subscription-payments'],
        ['get', '/superadmin/leads'],
    ])('tenant OWNER token on platform route %s %s → 403 (never data)', async (m, p) => {
        const res = await call(m, p, A.users.admin.token);
        expect([403, 404]).toContain(res.status);
        expect(text(res)).not.toContain(String(B.restaurant._id));
    });

    test('tenant owner cannot reach superadmin routes by faking the superadmin header / slug', async () => {
        const res = await call('get', '/superadmin/restaurants', A.users.admin.token, {
            'X-Restaurant-Slug': B.slug, 'X-Superadmin': 'true', 'X-Impersonate': String(B.users.admin._id),
        });
        expect(res.status).toBe(403);
    });

    test('tenant owner cannot mutate platform state: create restaurant / plan / suspend B', async () => {
        const before = await Restaurant.findById(B.restaurant._id).lean();
        const r1 = await call('post', '/superadmin/restaurants', A.users.admin.token).send({ name: 'Evil', slug: 'evil-x' });
        const r2 = await call('post', '/superadmin/plans', A.users.admin.token).send({ name: 'X', price: 1 });
        const r3 = await call('put', `/superadmin/restaurants/${B.restaurant._id}/suspend`, A.users.admin.token).send({ reason: 'x' });
        const r4 = await call('delete', `/superadmin/restaurants/${B.restaurant._id}`, A.users.admin.token);
        for (const r of [r1, r2, r3, r4]) expect([403, 404]).toContain(r.status);
        const after = await Restaurant.findById(B.restaurant._id).lean();
        expect(after.status).toBe(before.status);
        expect(await Restaurant.countDocuments({ slug: 'evil-x' })).toBe(0);
    });

    test('platform (superadmin) token on tenant-scoped routes is NOT silently a member of tenant A', async () => {
        const res = await call('get', '/menu', superUser.token, { 'X-Restaurant-Slug': A.slug });
        // superadmin is never scoped: if it answers it must not be a write-capable staff identity of A
        const w = await call('post', '/areas', superUser.token, { 'X-Restaurant-Slug': A.slug }).send({ name: 'sa-area' });
        const Area = require(path.join(BACKEND, 'models/area'));
        expect(await Area.countDocuments({ name: 'sa-area', restaurant: null })).toBe(0);
        expect([200, 400, 401, 403]).toContain(res.status);
        expect([200, 201, 400, 401, 403]).toContain(w.status);
    });
});

describe('suspended tenant with a still-valid token', () => {
    let S;
    beforeAll(async () => { S = await seedTenant({ label: 'tk-susp' }); });
    afterEach(async () => { await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'active' } }); });

    test.each(['suspended', 'cancelled'])('%s: every staff role is blocked on tenant routes', async (status) => {
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status } });
        for (const role of ['admin', 'waiter', 'chef', 'captain']) {
            const res = await call('get', '/orders/live', S.users[role].token);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('TENANT_SUSPENDED');
        }
        const exp = await call('get', '/tenant/export', S.users.admin.token);
        expect(exp.status).toBe(403);
        const dev = await call('get', '/developer/api-keys', S.users.admin.token);
        expect(dev.status).toBe(403);
    });

    test('Regression (fixed 2026-11): a suspended tenant staff token can still call /auth/* write endpoints that touch the account', async () => {
        // /auth is a tenant-EXEMPT prefix (tenantContext.js STRICT_EXEMPT_PREFIXES), so
        // ensureNotLocked is skipped. By design login/me must keep working, but a
        // suspended tenant's staff can still mint new access tokens via /auth/refresh
        // and rewrite their profile. A suspended tenant should not be able to refresh a
        // working session. Probe /auth/2fa/reset (owner resetting other admins).
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'suspended' } });
        const other = await createUser({ name: 'Adm2', email: `adm2.${Date.now()}@s.test`, role: 'admin', restaurant: S.restaurant._id, branch: null });
        const res = await call('post', '/auth/2fa/reset', S.users.admin.token).send({ userId: String(other._id) });
        // Blocked (403 TENANT_SUSPENDED) is the strict expectation.
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    test('a tenant whose Restaurant doc was deleted → TENANT_MISSING for its (stale) staff tokens', async () => {
        const Z = await seedTenant({ label: 'tk-gone' });
        await Restaurant.deleteOne({ _id: Z.restaurant._id });
        const res = await call('get', '/orders/live', Z.users.admin.token);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_MISSING');
    });
});
