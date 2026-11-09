/**
 * 14-day free trial module:
 *   - instant start: self-signup logs the owner in at once (no approval wait)
 *   - abuse guard: Gmail dot/+tag email aliases and phone variants -> 409
 *   - trialExpirySweeper locks only expired unpaid trials, idempotently
 *   - locked tenant: TRIAL_EXPIRED on normal routes, owner keeps billing/me
 *   - paying (applyPaidPlanUpgrade) lifts the lock with data intact
 *   - reminders at 7 / 3 / 1 days and on expiry, each sent once
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));
const { runTrialExpirySweep } = require(path.join(BACKEND, 'utils/trialExpirySweeper'));
const { runTrialReminders, sendExpiryNotice } = require(path.join(BACKEND, 'utils/trialReminderJob'));
const { applyPaidPlanUpgrade } = require(path.join(BACKEND, 'utils/planPaymentApply'));
const { TRIAL_LOCK_REASON } = require(path.join(BACKEND, 'utils/trialLock'));

const ctx = useIntegrationApp();
const PASSWORD = 'Signup#Pass1234';
const DAY = 24 * 60 * 60 * 1000;

let gold;
const uniq = () => Math.random().toString(16).slice(2, 8);
let phoneSeq = 0;
const uniquePhone = () => `9${String(700000000 + (++phoneSeq) * 7919 + Math.floor(Math.random() * 1000)).padStart(9, '0')}`.slice(0, 10);
const signupBody = (extra = {}) => ({
    restaurantName: `Trial Hub ${uniq()}`,
    ownerName: 'Tara Owner',
    contactEmail: `owner.${uniq()}@hotels.test`,
    contactPhone: uniquePhone(),
    city: 'Pune',
    password: PASSWORD,
    acceptTerms: true,
    ...extra,
});
const signup = (body) => ctx.api.anon().post('/public/register-restaurant').send(body);

/** A seeded tenant turned into a trial ending `endsInMs` from `now`. */
async function trialTenant(label, endsInMs, { now = new Date(), sub = {} } = {}) {
    const t = await seedTenant({ label });
    await Restaurant.updateOne({ _id: t.restaurant._id }, {
        $set: {
            status: 'trial',
            'subscription.status': 'trial',
            'subscription.trialStartDate': new Date(now.getTime() - 14 * DAY + endsInMs),
            'subscription.trialEndDate': new Date(now.getTime() + endsInMs),
            ...sub,
        },
    });
    return t;
}
// Reminder runs see every trial tenant in the shared DB: look at one only.
const mine = (run, t) => run.sent.filter((x) => x.id === String(t.restaurant._id));
const reload = (t) => Restaurant.findById(t.restaurant._id).lean();

beforeAll(async () => {
    gold = await SubscriptionPlan.create({
        name: 'Gold', slug: 'gold', price: 2999, sortOrder: 2, features: { dineIn: true, dataExport: true },
    });
    // A plan literally named "free" must NOT be what trials get any more.
    await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0, sortOrder: 0 });
});

beforeEach(() => sendEmail.mockClear());

describe('instant start', () => {
    test('signup starts a 14-day Gold trial and logs the owner in at once', async () => {
        const body = signupBody();
        const res = await signup(body);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            signupStatus: 'approved', trialStarted: true, autoLogin: true, trialDays: 14, planName: 'Gold',
        });
        expect(res.body.data.trialEndDate).toBeTruthy();
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.tenant).toMatchObject({ status: 'trial', trialExpired: false, planSlug: 'gold' });
        expect(res.body.tenant.daysLeft).toBe(14);

        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({ status: 'trial', signupStatus: 'approved', signupSource: 'self' });
        expect(r.subscription.planSlug).toBe('gold');
        expect(r.subscription.trialStartDate).toBeTruthy();

        // Token works immediately, and a normal login does too.
        const me = await ctx.api.as(res.body.token).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialExpired: false, subscriptionStatus: 'trial' });
        const login = await ctx.api.anon().post('/auth/login')
            .send({ email: body.contactEmail, password: PASSWORD, loginType: 'staff' });
        expect(login.status).toBe(200);

        await settle();
        const welcome = sendEmail.mock.calls.find(([m]) => m.to === body.contactEmail);
        expect(welcome[0].subject).toMatch(/Welcome to BestoDine/);
    });

    test('SELF_SIGNUP_REQUIRE_APPROVAL=true restores the pending flow', async () => {
        process.env.SELF_SIGNUP_REQUIRE_APPROVAL = 'true';
        try {
            const res = await signup(signupBody());
            expect(res.status).toBe(202);
            expect(res.body.data.signupStatus).toBe('pending');
            expect(res.body.token).toBeUndefined();
        } finally {
            delete process.env.SELF_SIGNUP_REQUIRE_APPROVAL;
        }
    });
});

describe('abuse guard', () => {
    test('Gmail dot / +tag aliases of a used email are refused (EMAIL_IN_USE)', async () => {
        const local = `abuse${uniq()}`;
        const first = await signup(signupBody({ contactEmail: `${local}@gmail.com` }));
        expect(first.status).toBe(201);
        for (const alias of [`${local}+promo@gmail.com`, `${local.slice(0, 5)}.${local.slice(5)}@GMAIL.com`, `${local}@googlemail.com`]) {
            const dup = await signup(signupBody({ contactEmail: alias }));
            expect(dup.status).toBe(409);
            expect(dup.body.code).toBe('EMAIL_IN_USE');
        }
    });

    test('same phone in any format is refused (PHONE_IN_USE)', async () => {
        const phone = uniquePhone();
        expect((await signup(signupBody({ contactPhone: phone }))).status).toBe(201);
        for (const variant of [`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, `+91-${phone}`, `0${phone}`]) {
            const dup = await signup(signupBody({ contactPhone: variant }));
            expect(dup.status).toBe(409);
            expect(dup.body.code).toBe('PHONE_IN_USE');
        }
    });
});

describe('trialExpirySweeper', () => {
    test('locks only expired unpaid trials, and is idempotent', async () => {
        const now = new Date();
        const expired = await trialTenant('exp', -2 * DAY, { now });
        const live = await trialTenant('live', 3 * DAY, { now });
        const paid = await trialTenant('paid', -2 * DAY, { now, sub: { 'subscription.lastChargedAt': new Date(now.getTime() - DAY) } });
        const activeSub = await trialTenant('actsub', -2 * DAY, { now, sub: { 'subscription.status': 'active' } });
        const plain = await seedTenant({ label: 'plain' }); // active, no trial

        const first = await runTrialExpirySweep({ now });
        expect(first.locked).toEqual([String(expired.restaurant._id)]);

        const r = await reload(expired);
        expect(r).toMatchObject({ status: 'suspended', suspendedReason: TRIAL_LOCK_REASON });
        expect(r.subscription.status).toBe('expired');
        expect(r.subscription.trialExpiredAt).toBeTruthy();
        for (const t of [live, paid, activeSub]) expect((await reload(t)).status).toBe('trial');
        expect((await reload(plain)).status).toBe('active');

        const second = await runTrialExpirySweep({ now });
        expect(second.locked).toEqual([]);
    });

    test('concurrent sweeps lock a tenant exactly once', async () => {
        const now = new Date();
        const t = await trialTenant('race', -1 * DAY, { now });
        const [a, b] = await Promise.all([runTrialExpirySweep({ now }), runTrialExpirySweep({ now })]);
        const all = [...a.locked, ...b.locked].filter((id) => id === String(t.restaurant._id));
        expect(all).toHaveLength(1);
    });
});

describe('locked tenant', () => {
    let t;
    beforeAll(async () => {
        t = await trialTenant('lock', -1 * DAY);
        await runTrialExpirySweep();
    });

    test('normal routes answer 403 TRIAL_EXPIRED with trialEndDate', async () => {
        const res = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ success: false, code: 'TRIAL_EXPIRED' });
        expect(res.body.trialEndDate).toBeTruthy();
    });

    test('customer menu / staff apps are unavailable', async () => {
        const guest = await ctx.api.guest(t).get('/menu');
        expect(guest.status).toBe(403);
        expect(guest.body.code).toBe('TRIAL_EXPIRED');
        const waiter = await ctx.api.as(t.users.waiter).get('/orders/live');
        expect(waiter.status).toBe(403);
        expect(waiter.body.code).toBe('TRIAL_EXPIRED');
    });

    test('staff login is refused with TRIAL_EXPIRED; the owner can log in', async () => {
        const staff = await ctx.api.anon().post('/auth/login')
            .send({ email: t.users.waiter.email, password: 'Integration#Pass123', loginType: 'staff' });
        expect(staff.status).toBe(403);
        expect(staff.body.code).toBe('TRIAL_EXPIRED');
        const owner = await ctx.api.anon().post('/auth/login')
            .send({ email: t.users.admin.email, password: 'Integration#Pass123', loginType: 'staff' });
        expect(owner.status).toBe(200);
        expect(owner.body.tenant).toMatchObject({ trialExpired: true, subscriptionStatus: 'expired', daysLeft: 0 });
    });

    test('owner still reaches /auth/me, billing and export', async () => {
        const me = await ctx.api.as(t.users.admin).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialExpired: true, daysLeft: 0 });
        expect(me.body.user.tenant.trialStartDate).toBeTruthy();
        expect(me.body.user.tenant.trialEndDate).toBeTruthy();

        const billing = await ctx.api.as(t.users.admin).get('/tenant/billing/current');
        expect(billing.status).toBe(200);
        const exp = await ctx.api.as(t.users.admin).get('/tenant/export');
        expect(exp.status).not.toBe(403);
    });

    test('paying restores full access with data intact', async () => {
        await Restaurant.updateOne({ _id: t.restaurant._id }, {
            $set: {
                'subscription.pendingUpgrade': {
                    plan: gold._id, planName: 'Gold', planSlug: 'gold', price: null,
                    features: { dineIn: true }, limits: {}, razorpayOrderId: '',
                },
            },
        });
        const doc = await Restaurant.findById(t.restaurant._id);
        const out = await applyPaidPlanUpgrade({ restaurant: doc, payment: { id: `pay_${uniq()}`, amount: 100000 } });
        expect(out.applied).toBe(true);

        const r = await reload(t);
        expect(r.status).toBe('active');
        expect(r.subscription.status).toBe('active');
        expect(r.suspendedReason).toBe('');
        expect(r.subscription.trialExpiredAt).toBeFalsy();

        const res = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(res.status).not.toBe(403);
        const waiter = await ctx.api.as(t.users.waiter).get('/orders/live');
        expect(waiter.body.code).not.toBe('TRIAL_EXPIRED');
    });
});

describe('request-time backstop', () => {
    test('a trial past its end date is locked even before the sweeper runs', async () => {
        const t = await trialTenant('back', -1 * DAY);
        const res = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TRIAL_EXPIRED');
        expect((await ctx.api.as(t.users.admin).get('/tenant/billing/current')).status).toBe(200);
    });
});

describe('reminders', () => {
    test('7 / 3 / 1 day reminders each go out once', async () => {
        const now = new Date();
        const t = await trialTenant('rem', 6.5 * DAY, { now });
        const to = t.restaurant.contactEmail;
        const sentTo = () => sendEmail.mock.calls.filter(([m]) => m.to === to).map(([m]) => m.subject);

        let run = await runTrialReminders({ now });
        expect(mine(run, t)).toEqual([{ id: String(t.restaurant._id), days: 7 }]);
        expect(sentTo()).toHaveLength(1);
        expect(sentTo()[0]).toMatch(/ends in 7 days/);

        run = await runTrialReminders({ now });
        expect(mine(run, t)).toEqual([]);
        expect(sentTo()).toHaveLength(1);

        run = await runTrialReminders({ now: new Date(now.getTime() + 4 * DAY) }); // 2.5 days left
        expect(mine(run, t).map((s) => s.days)).toEqual([3]);
        run = await runTrialReminders({ now: new Date(now.getTime() + 6 * DAY) }); // 0.5 days left
        expect(mine(run, t).map((s) => s.days)).toEqual([1]);
        expect(mine(await runTrialReminders({ now: new Date(now.getTime() + 6 * DAY) }), t)).toEqual([]);

        expect((await reload(t)).subscription.trialRemindersSent.sort()).toEqual([1, 3, 7]);
        expect(await Notification.countDocuments({ restaurant: t.restaurant._id, title: /free trial ends/ }, { skipTenantScope: true })).toBe(3);
    });

    test('only the nearest threshold is sent when several were missed', async () => {
        const now = new Date();
        const t = await trialTenant('rem2', 0.5 * DAY, { now });
        const run = await runTrialReminders({ now });
        expect(mine(run, t)).toEqual([{ id: String(t.restaurant._id), days: 1 }]);
        expect(mine(await runTrialReminders({ now }), t)).toEqual([]);
    });

    test('the expiry notice is sent once, by the sweeper hook', async () => {
        const t = await trialTenant('rem3', -1 * DAY);
        const doc = await reload(t);
        expect(await sendExpiryNotice(doc)).toBe(true);
        expect(await sendExpiryNotice(doc)).toBe(false);
        const mails = sendEmail.mock.calls.filter(([m]) => m.to === t.restaurant.contactEmail);
        expect(mails).toHaveLength(1);
        expect(mails[0][0].subject).toMatch(/has ended/);
    });

    test('paid or already-locked tenants get no countdown reminders', async () => {
        const now = new Date();
        const t = await trialTenant('rem4', 2 * DAY, { now, sub: { 'subscription.lastChargedAt': now } });
        expect(mine(await runTrialReminders({ now }), t)).toEqual([]);
    });
});
