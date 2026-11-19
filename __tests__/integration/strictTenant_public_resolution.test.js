/**
 * STRICT multi-tenancy: how the tenant of an unauthenticated / customer
 * request is RESOLVED, and whether any identifier an attacker controls
 * (slug header, ?restaurant=, Host / Origin / X-Forwarded-Host, restaurantId
 * in header / query / body, branch header, cached slug) can move them into a
 * tenant that is not theirs.
 *
 * Complements tenantContextHttp.test.js (does not repeat its cases).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { invalidateTenant } = require(path.join(BACKEND, 'middlewares/tenantContext'));

const ctx = useIntegrationApp();
let A;
let B;
let C; // vanity-domain tenant
let customer;

const V1 = '/api/v1';
const get = (p) => ctx.api.raw.get(`${V1}${p}`);
const post = (p) => ctx.api.raw.post(`${V1}${p}`);
const text = (res) => JSON.stringify(res.body || {});
const sees = (res, tenant) => text(res).includes(String(tenant.items.paneer._id));

beforeAll(async () => {
    A = await seedTenant({ label: 'pr-a' });
    B = await seedTenant({ label: 'pr-b' });
    C = await seedTenant({ label: 'pr-c' });
    await Restaurant.updateOne({ _id: C.restaurant._id }, {
        $set: { customDomain: 'order.cafe-c.example.test', domainVerified: true },
    });
    customer = await createCustomer('pr-cust');
});

describe('slug header / query resolution', () => {
    test('slug of A returns only A menu', async () => {
        const res = await get('/menu').set('X-Restaurant-Slug', A.slug);
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
    });

    test('duplicate X-Restaurant-Slug headers (A then B) never resolve to a mix', async () => {
        const res = await get('/menu').set('X-Restaurant-Slug', A.slug).set('X-Restaurant-Slug', B.slug);
        // Either rejected or a single tenant; never both tenants' items.
        expect(sees(res, A) && sees(res, B)).toBe(false);
        if (res.status === 200) expect(sees(res, A) !== sees(res, B)).toBe(true);
    });

    test('header wins over ?restaurant= (no merge of the two tenants)', async () => {
        const res = await get(`/menu?restaurant=${B.slug}`).set('X-Restaurant-Slug', A.slug);
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
    });

    test('legacy X-Restaurant header behaves like the slug header', async () => {
        const res = await get('/menu').set('X-Restaurant', A.slug);
        expect(res.status).toBe(200);
        expect(sees(res, B)).toBe(false);
    });

    test.each([
        ['upper-case', (s) => s.toUpperCase()],
        ['padded', (s) => `  ${s}  `],
    ])('%s slug is normalised to the SAME tenant, not another', async (_l, mut) => {
        const res = await get('/menu').set('X-Restaurant-Slug', mut(A.slug));
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
    });

    test.each([
        ['mongo operator object', '/menu?restaurant[$ne]=zzz'],
        ['mongo $regex object', '/menu?restaurant[$regex]=.*'],
        ['mongo $gt object', '/menu?restaurant[$gt]='],
        ['repeated param', () => `/menu?restaurant=${A.slug}&restaurant=${B.slug}`],
        ['regex metachars', '/menu?restaurant=.*'],
        ['path traversal', '/menu?restaurant=../b'],
        ['null byte', '/menu?restaurant=a%00'],
        ['over-long', `/menu?restaurant=${'a'.repeat(5000)}`],
    ])('NoSQL / garbage tenant selector (%s) → TENANT_REQUIRED, no data', async (_l, url) => {
        const res = await get(typeof url === 'function' ? url() : url);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
        expect(sees(res, A) || sees(res, B)).toBe(false);
    });

    test('slug HEADER cannot carry a JSON operator object (headers are strings)', async () => {
        const res = await get('/menu').set('X-Restaurant-Slug', '{"$ne":"x"}');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('unknown slug → TENANT_REQUIRED (indistinguishable from none), never a default tenant', async () => {
        const res = await get('/menu').set('X-Restaurant-Slug', 'no-such-tenant-xyz');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('a non-/public route with NO identifier never falls back to a default tenant', async () => {
        for (const p of ['/menu', '/categories', '/combos', '/promotions', '/settings', '/areas']) {
            const res = await get(p);
            expect([400, 401, 403]).toContain(res.status);
            expect(sees(res, A) || sees(res, B)).toBe(false);
        }
    });
});

describe('id-style identifiers are NOT tenant selectors', () => {
    test('X-Restaurant-Id / restaurantId header with B id and no slug → TENANT_REQUIRED', async () => {
        const res = await get('/menu')
            .set('X-Restaurant-Id', String(B.restaurant._id))
            .set('restaurantId', String(B.restaurant._id));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('with A slug + B id header/query, A data is served and B is not', async () => {
        const res = await get(`/menu?restaurantId=${B.restaurant._id}&tenant=${B.slug}&restaurant_id=${B.restaurant._id}`)
            .set('X-Restaurant-Slug', A.slug)
            .set('X-Restaurant-Id', String(B.restaurant._id))
            .set('X-Tenant-Id', String(B.restaurant._id));
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
    });

    test('staff of A cannot override tenant with query / header of B (several spellings)', async () => {
        const res = await get(`/menu?restaurant=${B.slug}&restaurantId=${B.restaurant._id}`)
            .set('Authorization', `Bearer ${A.users.admin.token}`)
            .set('X-Restaurant-Slug', B.slug)
            .set('X-Restaurant-Id', String(B.restaurant._id))
            .set('Host', 'order.cafe-c.example.test');
        expect(res.status).toBe(200);
        expect(sees(res, A)).toBe(true);
        expect(sees(res, B)).toBe(false);
        expect(sees(res, C)).toBe(false);
    });

    test("a body-supplied `restaurant` cannot plant a booking row in B (guest on A)", async () => {
        const Reservation = require(path.join(BACKEND, 'models/reservation'));
        const before = await Reservation.countDocuments({ restaurant: B.restaurant._id });
        await post('/reservations')
            .set('X-Restaurant-Slug', A.slug)
            .send({
                restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id),
                guestName: 'x', contactNo: '9000000001', date: new Date(Date.now() + 86400000), time: '20:00', guestCount: 2,
            });
        expect(await Reservation.countDocuments({ restaurant: B.restaurant._id })).toBe(before);
    });

    test("a body-supplied `restaurant` cannot re-home a staff-created area into B", async () => {
        const Area = require(path.join(BACKEND, 'models/area'));
        const res = await post('/areas')
            .set('Authorization', `Bearer ${A.users.admin.token}`)
            .send({ name: 'Smuggled', restaurant: String(B.restaurant._id), branch: String(B.branch._id) });
        const inB = await Area.findOne({ restaurant: B.restaurant._id, name: 'Smuggled' }).lean();
        expect(inB).toBeNull();
        if (res.status < 300) {
            const mine = await Area.findOne({ name: 'Smuggled' }).lean();
            expect(String(mine.restaurant)).toBe(String(A.restaurant._id));
            expect(String(mine.branch)).not.toBe(String(B.branch._id));
        }
    });
});

describe('Host / Origin / X-Forwarded-Host (custom-domain resolution)', () => {
    // NOTE: a browser Origin that is not in CORS allowedOrigins is refused by
    // the CORS layer (403) before tenant resolution, so a spoofed Origin can
    // never select a tenant; the Host header (set by the reverse proxy) can.
    test('verified vanity Host resolves to C only', async () => {
        const res = await get('/menu').set('Host', 'order.cafe-c.example.test');
        expect(res.status).toBe(200);
        expect(sees(res, C)).toBe(true);
        expect(sees(res, A) || sees(res, B)).toBe(false);
    });

    test('vanity Host with port and mixed case still resolves to C only', async () => {
        const res = await get('/menu').set('Host', 'Order.Cafe-C.Example.Test:8443');
        expect(res.status).toBe(200);
        expect(sees(res, C)).toBe(true);
        expect(sees(res, A) || sees(res, B)).toBe(false);
    });

    test('a spoofed non-allow-listed Origin of the vanity domain is refused by CORS (cannot select C)', async () => {
        const res = await get('/menu').set('Origin', 'https://order.cafe-c.example.test');
        expect(res.status).toBe(403);
        expect(sees(res, C)).toBe(false);
    });

    test.each([
        ['userinfo trick', 'order.cafe-c.example.test@evil.test'],
        ['suffix trick', 'order.cafe-c.example.test.evil.test'],
        ['prefix trick', 'evil-order.cafe-c.example.test'],
        ['sub-domain of vanity', 'x.order.cafe-c.example.test'],
        ['trailing dot', 'order.cafe-c.example.test.'],
    ])('lookalike Host (%s) does NOT resolve to C', async (_l, host) => {
        const res = await get('/menu').set('Host', host);
        expect(sees(res, C)).toBe(false);
    });

    test('X-Forwarded-Host with a vanity domain is NOT a tenant selector', async () => {
        const res = await get('/menu').set('X-Forwarded-Host', 'order.cafe-c.example.test');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('Forwarded / X-Original-Host / X-Host headers are ignored too', async () => {
        const res = await get('/menu')
            .set('Forwarded', 'host=order.cafe-c.example.test')
            .set('X-Original-Host', 'order.cafe-c.example.test')
            .set('X-Host', 'order.cafe-c.example.test');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    test('UNVERIFIED custom domain does not resolve', async () => {
        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { customDomain: 'unverified.b.example.test', domainVerified: false } });
        const res = await get('/menu').set('Host', 'unverified.b.example.test');
        expect(res.status).toBe(400);
        expect(sees(res, B)).toBe(false);
    });

    test('custom domain of a SUSPENDED tenant → 403 TENANT_SUSPENDED', async () => {
        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status: 'suspended' } });
        try {
            const res = await get('/menu').set('Host', 'order.cafe-c.example.test');
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('TENANT_SUSPENDED');
        } finally {
            await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status: 'active' } });
        }
    });

    test('vanity Host + A slug on a GUEST request: exactly one tenant, never a union', async () => {
        const res = await get('/menu')
            .set('Host', 'order.cafe-c.example.test')
            .set('X-Restaurant-Slug', A.slug);
        expect(res.status).toBe(200);
        expect(sees(res, A) && sees(res, C)).toBe(false);
    });

    test('customer token + vanity Host of C: customer never gets staff data', async () => {
        const res = await get('/orders/live')
            .set('Authorization', `Bearer ${customer.token}`)
            .set('Host', 'order.cafe-c.example.test');
        expect([401, 403]).toContain(res.status);
    });
});

describe('branch header / cache poisoning', () => {
    test.each([
        ['object id of B branch', () => String(B.branch._id)],
        ['mongo operator string', () => '{"$ne":null}'],
        ['regex', () => '.*'],
        ['short hex', () => 'abc'],
        ['array-ish', () => `${A.branch._id},${B.branch._id}`],
    ])('guest on A with X-Branch-Id %s is rejected, no data', async (_l, val) => {
        const res = await get('/menu').set('X-Restaurant-Slug', A.slug).set('X-Branch-Id', val());
        expect([400, 404]).toContain(res.status);
        expect(sees(res, B)).toBe(false);
    });

    test('X-Branch-Id verdict is not cached across tenants (B branch refused for A even after B itself used it)', async () => {
        const own = await get('/menu').set('X-Restaurant-Slug', B.slug).set('X-Branch-Id', String(B.branch._id));
        expect(own.status).toBe(200);
        const cross = await get('/menu').set('X-Restaurant-Slug', A.slug).set('X-Branch-Id', String(B.branch._id));
        expect(cross.status).toBe(404);
        const ownAgain = await get('/menu').set('X-Restaurant-Slug', B.slug).set('X-Branch-Id', String(B.branch._id));
        expect(ownAgain.status).toBe(200);
    });

    test('staff ?branch=<B branch id> is refused (verdict cache is keyed by tenant+branch)', async () => {
        // warm B's own verdict first
        const warm = await get(`/menu?branch=${B.branch._id}`).set('Authorization', `Bearer ${B.users.admin.token}`);
        expect(warm.status).toBe(200);
        const res = await get(`/orders/live?branch=${B.branch._id}`).set('Authorization', `Bearer ${A.users.admin.token}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('deactivated branch of A is invisible to A customers/waiters but never usable cross-tenant', async () => {
        const dead = await Branch.create({ restaurant: A.restaurant._id, name: 'Dead', slug: 'dead', isActive: false });
        const guest = await get('/menu').set('X-Restaurant-Slug', B.slug).set('X-Branch-Id', String(dead._id));
        expect(guest.status).toBe(404);
        const other = await get(`/orders/live?branch=${dead._id}`).set('Authorization', `Bearer ${B.users.admin.token}`);
        expect(other.status).toBe(404);
    });

    test('slug cache: suspending B after its slug was cached blocks the very next request', async () => {
        await get('/menu').set('X-Restaurant-Slug', B.slug); // warm
        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { status: 'suspended' } });
        try {
            const res = await get('/menu').set('X-Restaurant-Slug', B.slug);
            expect(res.status).toBe(403);
        } finally {
            await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { status: 'active' } });
            invalidateTenant(B.restaurant._id);
        }
    });

    test('Regression (fixed 2026-11): slug cache: a slug re-assigned to ANOTHER tenant keeps serving the OLD tenant for up to 30 s', async () => {
        const X = await seedTenant({ label: 'pr-x' });
        const Y = await seedTenant({ label: 'pr-y' });
        const oldSlug = X.slug;
        await get('/menu').set('X-Restaurant-Slug', oldSlug); // X's slug is cached -> X
        // X is renamed, Y takes the freed slug (direct DB writes, no explicit invalidation
        // call: the resolver must itself notice the cached tenant no longer owns the slug).
        await Restaurant.updateOne({ _id: X.restaurant._id }, { $set: { slug: `${oldSlug}-moved` } });
        await Restaurant.updateOne({ _id: Y.restaurant._id }, { $set: { slug: oldSlug } });
        const res = await get('/menu').set('X-Restaurant-Slug', oldSlug);
        // LEAK (latent, low): resolveBySlug (middlewares/tenantContext.js:363-375) trusts
        // the cached slug->id mapping and loads by id WITHOUT checking that the loaded
        // restaurant still owns that slug. If a slug is ever re-assigned (script / future
        // rename without invalidateSlug), guests of tenant Y land in tenant X for <=30 s.
        expect(sees(res, X)).toBe(false);
    });
});

describe('/auth and /public are exempt: no accidental tenant data', () => {
    test('exempt routes never populate a tenant (public restaurants list has no secrets)', async () => {
        const res = await get('/public/restaurants').set('X-Restaurant-Slug', A.slug);
        expect(res.status).toBe(200);
        const body = text(res);
        for (const secret of ['razorpay', 'subscriptionId', 'contactEmail', 'passwordHash', 'agentToken', 'apiKey', 'hash"']) {
            expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
        }
    });

    test("'/public/../menu' style traversal does not ride the exempt prefix", async () => {
        const res = await ctx.api.raw.get(`${V1}/public/../menu`);
        expect([400, 401, 403, 404]).toContain(res.status);
        expect(sees(res, A) || sees(res, B)).toBe(false);
    });

    test("'/PUBLIC' / '/public%2f..' variants are not treated as exempt for tenant data", async () => {
        for (const p of ['/PUBLIC/../menu', '/public%2f..%2fmenu', '/auth/../menu', '/superadmin/../menu', '/tables/scan/../../menu']) {
            const res = await ctx.api.raw.get(`${V1}${p}`);
            expect(sees(res, A) || sees(res, B)).toBe(false);
        }
    });
});
