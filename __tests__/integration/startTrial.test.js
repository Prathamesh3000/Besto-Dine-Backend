/**
 * POST /public/start-trial (TRIAL_SIGNUP_AND_LEADS_PLAN.md §4):
 *   - one short form, no plan / price / length from the client
 *   - server-chosen plan (TRIAL_PLAN_SLUG → trial-enabled public plan → 503)
 *   - trial length = plan.trial.durationDays when enabled, else 14
 *   - registrationSource 'self_service_trial', same response as register
 *   - dedupe: 409 EMAIL_IN_USE (gmail dot / +tag aliases) with the plan's
 *     message, 409 PHONE_IN_USE
 *   - approval mode still creates a pending signup (202)
 *   - own rate limiter: 429 after TRIAL_START_LIMIT_PER_HOUR successes
 *
 * This suite uses the REAL rate-limit store (memory, no REDIS_URL) instead
 * of the pass-through from helpers/mocks.js, so the limit must be high
 * enough for every successful signup made here before the limiter test.
 */
process.env.TRIAL_START_LIMIT_PER_HOUR = '8';

jest.mock('../../utils/rateLimitStore', () => jest.requireActual('../../utils/rateLimitStore'));
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const User = require(path.join(BACKEND, 'models/user'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));

const ctx = useIntegrationApp();
const DAY = 24 * 60 * 60 * 1000;
const MAX_PER_HOUR = Number(process.env.TRIAL_START_LIMIT_PER_HOUR);

const uniq = () => Math.random().toString(16).slice(2, 8);
let phoneSeq = 0;
const uniquePhone = () => `9${String(700000000 + (++phoneSeq) * 7919 + Math.floor(Math.random() * 1000)).padStart(9, '0')}`.slice(0, 10);
const trialBody = (extra = {}) => ({
    orgName: `Trial Cafe ${uniq()}`,
    adminName: 'Tara Owner',
    email: `owner.${uniq()}@hotels.test`,
    phone: uniquePhone(),
    adminPassword: 'trialpass123',
    ...extra,
});
const startTrial = (body) => ctx.api.anon().post('/public/start-trial').send(body);

beforeAll(async () => {
    const plans = {
        // Default trial plan (TRIAL_PLAN_SLUG unset → 'gold'); no trial flag
        // of its own → the 14-day constant applies.
        gold: await SubscriptionPlan.create({ name: 'Gold', slug: 'gold', price: 2999, tier: 20, sortOrder: 3 }),
        // Trial-enabled public plan with its own length.
        starter: await SubscriptionPlan.create({
            name: 'Starter', slug: 'starter', price: 999, tier: 10, sortOrder: 1,
            trial: { enabled: true, durationDays: 7 },
        }),
        free: await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0, tier: 0, sortOrder: 0 }),
    };
    expect(plans.gold.trialDays).toBe(0);
    expect(plans.starter.trialDays).toBe(7);
});

beforeEach(() => sendEmail.mockClear());

describe('POST /public/start-trial', () => {
    test('creates a 14-day trial on the server-chosen plan, no payment, logs the owner in', async () => {
        const body = trialBody({ source: 'pricing-cta', utm: { source: 'google', campaign: 'trial' } });
        const res = await startTrial(body);
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject({
            restaurant: { name: body.orgName },
            owner: { name: 'Tara Owner', email: body.email },
            signupStatus: 'approved',
            registrationSource: 'self_service_trial',
            subscriptionStatus: 'trial',
            trialStarted: true,
            autoLogin: true,
            trialDays: 14,
            planName: 'Gold',
            planSlug: 'gold',
            billingCycle: null,
            invoiceNumber: null,
            requestedPlan: null,
        });
        expect(res.body.data.restaurant.slug).toMatch(/^trial-cafe-[0-9a-f]+$/);
        expect(res.body.data.pageUrl).toBe(`http://localhost:5173/${res.body.data.restaurant.slug}`);
        // Same session body a login / register returns.
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.tenant).toMatchObject({ status: 'trial', trialExpired: false, planSlug: 'gold' });
        expect(res.body.tenant.daysLeft).toBe(14);

        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({
            status: 'trial',
            signupStatus: 'approved',
            signupSource: 'self',
            registrationSource: 'self_service_trial',
            contactEmail: body.email,
            contactPhone: body.phone,
            contactPhoneNormalized: body.phone,
        });
        expect(r.subscription).toMatchObject({ status: 'trial', planSlug: 'gold', planName: 'Gold' });
        expect(Math.abs(new Date(r.subscription.trialStartDate) - Date.now())).toBeLessThan(60 * 1000);
        expect(Math.abs(new Date(r.subscription.trialEndDate) - (Date.now() + 14 * DAY))).toBeLessThan(60 * 1000);
        expect(r.signupMeta).toMatchObject({ ownerName: 'Tara Owner', source: 'pricing-cta', utmSource: 'google', utmCampaign: 'trial' });

        const owner = await User.findById(r.owner).lean();
        expect(owner).toMatchObject({
            name: 'Tara Owner', email: body.email, mobile: body.phone, role: 'admin', isTenantOwner: true, status: 'active',
        });
        expect(owner.password).not.toBe(body.adminPassword);
        expect(await Branch.countDocuments({ restaurant: r._id })).toBe(1);

        const me = await ctx.api.as(res.body.token).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialExpired: false, subscriptionStatus: 'trial' });

        await settle();
        const welcome = sendEmail.mock.calls.find(([m]) => m.to === body.email);
        expect(welcome[0].subject).toMatch(/Welcome to BestoDine/);
        expect(welcome[0].text).toContain('14-day free trial');
    });

    test('register-form aliases are accepted and phone is optional', async () => {
        const res = await startTrial({
            restaurantName: `Alias Diner ${uniq()}`,
            ownerName: 'Ravi Alias',
            contactEmail: `alias.${uniq()}@hotels.test`,
            password: 'aliaspass123',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.trialStarted).toBe(true);
        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r.contactPhone).toBe('');
        expect(r.contactPhoneNormalized).toBeUndefined();
        expect(r.signupMeta.ownerName).toBe('Ravi Alias');
        const owner = await User.findById(r.owner).lean();
        expect(owner.name).toBe('Ravi Alias');
        expect(owner.mobile).toBe('');
    });

    test('TRIAL_PLAN_SLUG picks the plan; its trial.durationDays sets the length', async () => {
        process.env.TRIAL_PLAN_SLUG = 'starter';
        try {
            const res = await startTrial(trialBody());
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ planName: 'Starter', planSlug: 'starter', trialDays: 7 });
            const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
            expect(r.subscription.planSlug).toBe('starter');
            expect(Math.abs(new Date(r.subscription.trialEndDate) - (Date.now() + 7 * DAY))).toBeLessThan(60 * 1000);
            expect(res.body.tenant.daysLeft).toBe(7);
        } finally {
            delete process.env.TRIAL_PLAN_SLUG;
        }
    });

    test('duplicate email (incl. gmail dot / +tag aliases) → 409 EMAIL_IN_USE with the sign-in message', async () => {
        const local = `dup${uniq()}`;
        const first = await startTrial(trialBody({ email: `${local}@gmail.com` }));
        expect(first.status).toBe(201);
        const MESSAGE = 'This email already has an account. Please sign in.';
        for (const alias of [
            `${local}@gmail.com`,
            `${local.toUpperCase()}@Gmail.com`,
            `${local}+promo@gmail.com`,
            `${local.slice(0, 3)}.${local.slice(3)}@gmail.com`,
            `${local}@googlemail.com`,
        ]) {
            const dup = await startTrial(trialBody({ email: alias }));
            expect(dup.status).toBe(409);
            expect(dup.body).toMatchObject({ success: false, field: 'email', code: 'EMAIL_IN_USE', message: MESSAGE });
        }
        // An existing non-owner user with that email blocks it too.
        expect(await User.countDocuments({ email: `${local}@gmail.com` })).toBe(1);
    });

    test('phone already on a restaurant → 409 PHONE_IN_USE', async () => {
        const taken = await Restaurant.findOne({ contactPhoneNormalized: { $type: 'string' } }).lean();
        expect(taken).toBeTruthy();
        const dup = await startTrial(trialBody({ phone: `+91 ${taken.contactPhoneNormalized}` }));
        expect(dup.status).toBe(409);
        expect(dup.body).toMatchObject({ field: 'phone', code: 'PHONE_IN_USE' });
    });

    test('validation: name, your name, email, password ≥ 8 — nothing is created', async () => {
        const base = trialBody();
        const cases = [
            [{ ...base, orgName: '' }, 'orgName'],
            [{ ...base, adminName: '' }, 'adminName'],
            [{ ...base, email: 'not-an-email' }, 'email'],
            [{ ...base, phone: '12345' }, 'phone'],
            [{ ...base, adminPassword: 'short7!' }, 'adminPassword'],
        ];
        for (const [body, field] of cases) {
            const res = await startTrial(body);
            expect(res.status).toBe(400);
            expect(res.body.field).toBe(field);
        }
        const weak = await startTrial({ ...base, adminPassword: 'abc' });
        expect(weak.body.code).toBe('WEAK_PASSWORD');
        expect(await Restaurant.exists({ contactEmail: base.email })).toBeNull();
        // Non-string password is refused by the route rules.
        expect((await startTrial({ ...base, adminPassword: { $ne: null } })).status).toBe(400);
    });

    test('SELF_SIGNUP_REQUIRE_APPROVAL=true → pending signup (202), no session, gate kept', async () => {
        process.env.SELF_SIGNUP_REQUIRE_APPROVAL = 'true';
        try {
            const body = trialBody();
            const res = await startTrial(body);
            expect(res.status).toBe(202);
            expect(res.body.data).toMatchObject({ signupStatus: 'pending', registrationSource: 'self_service_trial' });
            expect(res.body.token).toBeUndefined();
            const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
            expect(r).toMatchObject({ status: 'suspended', signupStatus: 'pending', registrationSource: 'self_service_trial' });
            expect(r.subscription.status).toBe('trial');
            const login = await ctx.api.anon().post('/auth/login')
                .send({ email: body.email, password: body.adminPassword, loginType: 'staff' });
            expect(login.status).toBe(403);
            expect(login.body.code).toBe('SIGNUP_PENDING');
        } finally {
            delete process.env.SELF_SIGNUP_REQUIRE_APPROVAL;
        }
    });

    test('no trial plan at all → 503 TRIAL_UNAVAILABLE', async () => {
        await SubscriptionPlan.updateMany({ slug: { $in: ['gold', 'starter'] } }, { $set: { isActive: false } });
        try {
            const res = await startTrial(trialBody());
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({
                success: false, code: 'TRIAL_UNAVAILABLE', message: 'Free trials are temporarily unavailable',
            });
        } finally {
            await SubscriptionPlan.updateMany({ slug: { $in: ['gold', 'starter'] } }, { $set: { isActive: true } });
        }
    });

    test('with no gold plan the first trial-enabled public plan (by sortOrder) is used', async () => {
        await SubscriptionPlan.updateOne({ slug: 'gold' }, { $set: { isActive: false } });
        try {
            const res = await startTrial(trialBody());
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ planSlug: 'starter', trialDays: 7 });
        } finally {
            await SubscriptionPlan.updateOne({ slug: 'gold' }, { $set: { isActive: true } });
        }
    });

    test(`rate limit: 429 RATE_LIMITED after ${MAX_PER_HOUR} successful signups per IP (failures do not count)`, async () => {
        // Earlier tests in this file already used part of the budget; the
        // limiter must trip within MAX_PER_HOUR + 1 further attempts and
        // every attempt before it must have succeeded.
        const statuses = [];
        let limited = null;
        for (let i = 0; i <= MAX_PER_HOUR && !limited; i++) {
            const res = await startTrial(trialBody());
            statuses.push(res.status);
            if (res.status === 429) limited = res;
        }
        expect(limited).toBeTruthy();
        expect(statuses.slice(0, -1).every((s) => s === 201)).toBe(true);
        expect(limited.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
        expect(limited.body.message).toMatch(/trial signups/i);
        expect(limited.headers['ratelimit-limit']).toBe(String(MAX_PER_HOUR));
        // Register-restaurant has its own limiter — still open from this IP.
        const other = await ctx.api.anon().post('/public/register-restaurant').send({});
        expect(other.status).toBe(400);
    });
});
