/**
 * Hotel self-signup + platform home public endpoints:
 *   - POST /public/register-restaurant  → pending tenant, emails, validation
 *   - staff login while pending / rejected (SIGNUP_PENDING / SIGNUP_REJECTED)
 *   - Super Admin approval → login works, tenant trial, landing reachable
 *   - GET /public/slug-availability
 *   - GET /public/plans
 *   - GET /public/restaurants?q=&limit=
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, DEFAULT_PASSWORD } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const User = require(path.join(BACKEND, 'models/user'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));

const ctx = useIntegrationApp();
const PASSWORD = 'Signup#Pass1234';
const FRONTEND = 'http://localhost:5173';

let superadmin;
let plans;
let active;       // seeded active tenant (directory)
let hiddenTenant; // active tenant with landingPage.enabled === false

const uniq = () => Math.random().toString(16).slice(2, 8);
const signupBody = (extra = {}) => ({
    restaurantName: `Spice Hub ${uniq()}`,
    ownerName: 'Asha Owner',
    contactEmail: `owner.${uniq()}@hotels.test`,
    contactPhone: '+91 98765 43210',
    city: 'Pune',
    password: PASSWORD,
    acceptTerms: true,
    ...extra,
});
const signup = (body) => ctx.api.anon().post('/public/register-restaurant').send(body);
const staffLogin = (email, password = PASSWORD) => ctx.api.anon().post('/auth/login')
    .send({ email, password, loginType: 'staff' });

beforeAll(async () => {
    process.env.SUPERADMIN_ALERT_EMAILS = 'ops1@platform.test, ops2@platform.test';
    plans = {
        free: await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0, sortOrder: 0 }),
        pro: await SubscriptionPlan.create({ name: 'Pro', slug: 'pro', price: 1999, sortOrder: 2, trialDays: 14, highlight: true, razorpayPlanId: 'plan_secret' }),
        basic: await SubscriptionPlan.create({ name: 'Basic', slug: 'basic', price: 999, sortOrder: 1 }),
        privateDeal: await SubscriptionPlan.create({ name: 'Private Deal', slug: 'private-deal', price: 500, isPublic: false }),
        retired: await SubscriptionPlan.create({ name: 'Retired', slug: 'retired', price: 10, isActive: false }),
    };
    superadmin = await createUser({
        name: 'Root', email: 'root@platform.test', role: 'superadmin', superadminLevel: 'full',
    });
    active = await seedTenant({ label: 'dir' });
    await Restaurant.updateOne({ _id: active.restaurant._id }, { $set: { name: 'Masala Junction', city: 'Nagpur', logo: 'https://cdn.test/logo.png' } });
    hiddenTenant = await seedTenant({ label: 'hid' });
    await Restaurant.updateOne({ _id: hiddenTenant.restaurant._id }, { $set: { name: 'Masala Hidden', city: 'Nagpur' } });
    await Settings.updateOne({ _id: hiddenTenant.settings._id }, { $set: { 'landingPage.enabled': false } });
});

afterAll(() => {
    delete process.env.SUPERADMIN_ALERT_EMAILS;
});

beforeEach(() => sendEmail.mockClear());

describe('POST /public/register-restaurant → approval → login', () => {
    test('full flow: pending, SIGNUP_PENDING login, approve, login + landing work', async () => {
        const body = signupBody({
            slug: `spice-hub-${uniq()}`,
            planId: String(plans.pro._id),
            source: 'home-hero',
            utm: { source: 'google', campaign: 'launch' },
        });
        const res = await signup(body);
        expect(res.status).toBe(202);
        const d = res.body.data;
        expect(d).toMatchObject({
            restaurant: { name: body.restaurantName, slug: body.slug },
            signupStatus: 'pending',
            pageUrl: `${FRONTEND}/${body.slug}`,
            requestedPlan: { name: 'Pro' },
        });
        expect(typeof d.message).toBe('string');
        expect(typeof res.body.message).toBe('string');

        const r = await Restaurant.findOne({ slug: body.slug }).lean();
        expect(r).toMatchObject({
            status: 'suspended', signupSource: 'self', signupStatus: 'pending',
            contactPhone: '9876543210', city: 'Pune',
        });
        expect(r.subscription.planSlug).toBe('free'); // billing not activated
        expect(String(r.requestedPlan.plan)).toBe(String(plans.pro._id));
        expect(r.signupMeta).toMatchObject({ ownerName: 'Asha Owner', source: 'home-hero', utmSource: 'google', utmCampaign: 'launch' });
        expect(r.signupMeta.termsAcceptedAt).toBeTruthy();

        // Owner "application received" + one alert per SUPERADMIN_ALERT_EMAILS entry.
        await settle(300);
        const tos = sendEmail.mock.calls.map(([m]) => m.to);
        expect(tos).toEqual(expect.arrayContaining([body.contactEmail, 'ops1@platform.test', 'ops2@platform.test']));
        const ownerMail = sendEmail.mock.calls.find(([m]) => m.to === body.contactEmail)[0];
        expect(ownerMail.subject).toMatch(/received/i);
        expect(ownerMail.text).toContain(`${FRONTEND}/${body.slug}`);
        expect(ownerMail.text).toMatch(/1 business day/);
        const alert = sendEmail.mock.calls.find(([m]) => m.to === 'ops1@platform.test')[0];
        expect(alert.text).toContain(`${FRONTEND}/superadmin/pending-approvals`);

        // Pending: login refused with a clear code; landing unavailable.
        const pending = await staffLogin(body.contactEmail);
        expect(pending.status).toBe(403);
        expect(pending.body.code).toBe('SIGNUP_PENDING');
        expect(pending.body.message).toMatch(/awaiting approval/);
        expect((await ctx.api.anon().get(`/public/restaurants/${body.slug}/landing`)).status).toBe(404);

        // Pending Approvals queue shows the display-ready item.
        const queue = await ctx.api.as(superadmin).get('/superadmin/pending-approvals');
        expect(queue.status).toBe(200);
        const item = queue.body.data.signups.find((s) => s.slug === body.slug);
        expect(item).toMatchObject({
            _id: String(r._id),
            name: body.restaurantName,
            slug: body.slug,
            city: 'Pune',
            contactPhone: '9876543210',
            contactEmail: body.contactEmail,
            ownerName: 'Asha Owner',
            requestedPlan: { _id: String(plans.pro._id), name: 'Pro' },
            signupMeta: { source: 'home-hero', utmSource: 'google', utmCampaign: 'launch', utmMedium: '' },
            subscription: { planName: 'Free' },
        });
        expect(item.createdAt).toBeTruthy();

        // Simulate a long review wait: the signup-date trial has expired.
        await Restaurant.updateOne({ _id: r._id }, {
            $set: { 'subscription.trialEndDate': new Date(Date.now() - 24 * 60 * 60 * 1000) },
        });

        // Approve.
        sendEmail.mockClear();
        const approve = await ctx.api.as(superadmin).post(`/superadmin/restaurants/${r._id}/approve-signup`).send({});
        expect(approve.status).toBe(200);
        const welcome = sendEmail.mock.calls.find(([m]) => m.to === body.contactEmail)?.[0];
        expect(welcome).toBeTruthy();
        expect(welcome.text).toContain(`${FRONTEND}/staff-login`);
        expect(welcome.text).toContain(`${FRONTEND}/${body.slug}`);
        // Full fresh trial (Free plan has no trialDays → 14-day default).
        expect(welcome.text).toContain('14-day free trial');

        const after = await Restaurant.findById(r._id).lean();
        expect(after.signupStatus).toBe('approved');
        expect(after.status).toBe('trial');
        expect(after.subscription.status).toBe('trial');
        const DAY = 24 * 60 * 60 * 1000;
        expect(Math.abs(new Date(after.subscription.trialStartDate) - Date.now())).toBeLessThan(60 * 1000);
        expect(Math.abs(new Date(after.subscription.trialEndDate) - (Date.now() + 14 * DAY))).toBeLessThan(60 * 1000);

        const ok = await staffLogin(body.contactEmail);
        expect(ok.status).toBe(200);
        expect(ok.body.success).toBe(true);

        const landing = await ctx.api.anon().get(`/public/restaurants/${body.slug}/landing`);
        expect(landing.status).toBe(200);
        expect(landing.body.data.restaurant.slug).toBe(body.slug);
    });

    test('rejected signup → 403 SIGNUP_REJECTED with the reason', async () => {
        const body = signupBody();
        const res = await signup(body);
        expect(res.status).toBe(202);
        const reject = await ctx.api.as(superadmin)
            .post(`/superadmin/restaurants/${res.body.data.restaurant._id}/reject-signup`)
            .send({ reason: 'Could not verify FSSAI licence' });
        expect(reject.status).toBe(200);

        await settle(200);
        const mail = sendEmail.mock.calls.find(([m]) => m.to === body.contactEmail && /Update on your/.test(m.subject))?.[0];
        expect(mail).toBeTruthy();
        expect(mail.text).toContain('Reason: Could not verify FSSAI licence');
        expect(mail.text).toMatch(/reply to this email/);

        const login = await staffLogin(body.contactEmail);
        expect(login.status).toBe(403);
        expect(login.body).toMatchObject({ code: 'SIGNUP_REJECTED', reason: 'Could not verify FSSAI licence' });
        expect(login.body.message).toContain('Could not verify FSSAI licence');
    });

    test('ordinary suspension of an approved tenant still answers TENANT_SUSPENDED', async () => {
        const t = await seedTenant({ label: 'sus' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { status: 'suspended' } });
        const login = await staffLogin(t.users.admin.email, DEFAULT_PASSWORD);
        expect(login.status).toBe(401);
        expect(login.body.code).toBe('TENANT_SUSPENDED');
    });

    test('weak password → 400 field password', async () => {
        const res = await signup(signupBody({ password: 'weakpass123' }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ field: 'password', code: 'WEAK_PASSWORD' });
        expect(res.body.message).toMatch(/8 characters/);
    });

    test('non-string password → 400 from route validation', async () => {
        const res = await signup(signupBody({ password: { $ne: null } }));
        expect(res.status).toBe(400);
    });

    test('acceptTerms missing → 400 TERMS_REQUIRED', async () => {
        const body = signupBody();
        delete body.acceptTerms;
        const res = await signup(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TERMS_REQUIRED');
        expect(await User.exists({ email: body.contactEmail })).toBeNull();
    });

    test('invalid mobile → 400 field contactPhone', async () => {
        const res = await signup(signupBody({ contactPhone: '12345' }));
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('contactPhone');
    });

    test('private / inactive / unknown planId → 400 INVALID_PLAN', async () => {
        for (const planId of [String(plans.privateDeal._id), String(plans.retired._id), 'nope']) {
            const res = await signup(signupBody({ planId }));
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_PLAN');
        }
    });

    test('duplicate email (any existing user) → 409 EMAIL_IN_USE', async () => {
        const body = signupBody();
        expect((await signup(body)).status).toBe(202);
        const dup = await signup(signupBody({ contactEmail: body.contactEmail.toUpperCase() }));
        expect(dup.status).toBe(409);
        expect(dup.body.code).toBe('EMAIL_IN_USE');
        expect(dup.body.message).toBe('An account with this email already exists. Log in or use another email.');

        const staff = await staffLogin('nobody@x.test'); // sanity: unrelated
        expect(staff.status).toBe(401);
        const existingStaff = await signup(signupBody({ contactEmail: active.users.waiter.email }));
        expect(existingStaff.status).toBe(409);
    });

    test('same restaurant name + city pending twice is allowed (slug differs)', async () => {
        const name = `Twin Dhaba ${uniq()}`;
        const a = await signup(signupBody({ restaurantName: name }));
        const b = await signup(signupBody({ restaurantName: name }));
        expect(a.status).toBe(202);
        expect(b.status).toBe(202);
        expect(a.body.data.restaurant.slug).not.toBe(b.body.data.restaurant.slug);
    });

    test('reserved and taken explicit slugs', async () => {
        const reserved = await signup(signupBody({ slug: 'request-demo' }));
        expect(reserved.status).toBe(400);
        expect(reserved.body.code).toBe('SLUG_RESERVED');
        const taken = await signup(signupBody({ slug: active.slug }));
        expect(taken.status).toBe(409);
        expect(taken.body.code).toBe('SLUG_TAKEN');
    });
});

describe('GET /public/slug-availability', () => {
    const check = (q) => ctx.api.anon().get(`/public/slug-availability${q}`);

    test('free slug is available (normalised)', async () => {
        const res = await check('?slug=  Brand New Place ');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ slug: 'brand-new-place', available: true, reason: null, suggestions: [] });
    });

    test('taken slug → reason taken + available suggestions', async () => {
        const res = await check(`?slug=${active.slug}`);
        expect(res.body.data).toMatchObject({ slug: active.slug, available: false, reason: 'taken' });
        const s = res.body.data.suggestions;
        expect(s.length).toBeGreaterThan(0);
        expect(s.length).toBeLessThanOrEqual(3);
        for (const x of s) expect(await Restaurant.exists({ slug: x })).toBeNull();
    });

    test('reserved / too_short / invalid', async () => {
        expect((await check('?slug=admin')).body.data).toMatchObject({ available: false, reason: 'reserved' });
        expect((await check('?slug=request-demo')).body.data.reason).toBe('reserved');
        expect((await check('?slug=a')).body.data).toMatchObject({ slug: 'a', available: false, reason: 'too_short' });
        expect((await check('?slug=%21%21%21')).body.data).toMatchObject({ slug: '', available: false, reason: 'invalid' });
    });

    test('name only → generated slug + availability', async () => {
        const res = await check('?name=Masala%20Junction%20Cafe');
        expect(res.body.data).toMatchObject({ slug: 'masala-junction-cafe', available: true, reason: null });
        const reserved = await check('?name=Admin');
        expect(reserved.body.data).toMatchObject({ slug: 'admin', available: false, reason: 'reserved' });
        expect(reserved.body.data.suggestions.length).toBeGreaterThan(0);
    });

    test('no slug and no name → 400', async () => {
        expect((await check('')).status).toBe(400);
    });
});

describe('GET /public/plans', () => {
    test('returns only public active plans sorted by sortOrder, public-safe fields', async () => {
        const res = await ctx.api.anon().get('/public/plans');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toMatch(/max-age=300/);
        expect(res.body.data.map((p) => p.name)).toEqual(['Free', 'Basic', 'Pro']);
        const pro = res.body.data[2];
        expect(pro).toMatchObject({ price: 1999, billingCycle: 'monthly', trialDays: 14, highlight: true });
        expect(pro.limits).toEqual({ branches: 1, tables: 10, staff: 5, menuItems: 50 });
        expect(typeof pro.features).toBe('object');
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('plan_secret');
        expect(text).not.toContain('razorpay');
        expect(text).not.toContain('auditRetentionDays');
        expect(text).not.toContain('apiRateLimit');
    });
});

describe('GET /public/restaurants', () => {
    test('?q= searches name/city, only active + landing-enabled, public fields only', async () => {
        // A pending signup matching the query must not show up.
        await signup(signupBody({ restaurantName: 'Masala Pending', city: 'Nagpur' }));
        const res = await ctx.api.anon().get('/public/restaurants?q=masala');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            { name: 'Masala Junction', slug: active.slug, city: 'Nagpur', logo: 'https://cdn.test/logo.png' },
        ]);
        const byCity = await ctx.api.anon().get('/public/restaurants?q=nagp');
        expect(byCity.body.data.map((r) => r.slug)).toEqual([active.slug]);
    });

    test('regex metacharacters are escaped and q is capped', async () => {
        const res = await ctx.api.anon().get(`/public/restaurants?q=${encodeURIComponent('.*')}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        const long = await ctx.api.anon().get(`/public/restaurants?q=${'a'.repeat(500)}`);
        expect(long.status).toBe(200);
    });

    test('limit defaults to 12 and is capped at 30', async () => {
        const res = await ctx.api.anon().get('/public/restaurants?limit=1');
        expect(res.body.data).toHaveLength(1);
        expect(Object.keys(res.body.data[0]).sort()).toEqual(['city', 'logo', 'name', 'slug']);
        const big = await ctx.api.anon().get('/public/restaurants?limit=500');
        expect(big.status).toBe(200);
        expect(big.body.data.length).toBeLessThanOrEqual(30);
    });

    test('no params → legacy shape unchanged (features, _id, phone)', async () => {
        const res = await ctx.api.anon().get('/public/restaurants');
        expect(res.status).toBe(200);
        const row = res.body.data.find((r) => r.slug === active.slug);
        expect(row).toMatchObject({ _id: String(active.restaurant._id), name: 'Masala Junction', phone: '' });
        expect(row.features).toBeTruthy();
        // Legacy list is not filtered by landing page and never includes pending tenants.
        expect(res.body.data.some((r) => r.slug === hiddenTenant.slug)).toBe(true);
        expect(res.body.data.some((r) => r.name === 'Masala Pending')).toBe(false);
    });
});
