/**
 * 14-day free trial module (TRIAL_SIGNUP_AND_LEADS_PLAN.md §6 / §7):
 *   - instant start: self-signup logs the owner in at once (no approval wait)
 *   - abuse guard: Gmail dot/+tag email aliases and phone variants -> 409
 *   - read-only window (trialEnd .. trialEnd + 3d): GET passes, writes answer
 *     403 SUBSCRIPTION_READ_ONLY; billing / export (owner) and /auth stay open
 *   - locked (after lockAt): 403 SUBSCRIPTION_BLOCKED; owner keeps billing / export
 *   - trialExpirySweeper locks only after lockAt, idempotently and once
 *   - paying (applyPaidPlanUpgrade) lifts the lock with data intact
 *   - reminders t-3 / t-1 / t+0 / t+2: one claim per type, retried on failure
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
const { runTrialReminders } = require(path.join(BACKEND, 'utils/trialReminderJob'));
const { applyPaidPlanUpgrade } = require(path.join(BACKEND, 'utils/planPaymentApply'));
const { TRIAL_LOCK_REASON, TRIAL_DAYS, TRIAL_READONLY_GRACE_DAYS } = require(path.join(BACKEND, 'utils/trialLock'));

const ctx = useIntegrationApp();
const PASSWORD = 'Signup#Pass1234';
const STAFF_PASSWORD = 'Integration#Pass123';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const GRACE = TRIAL_READONLY_GRACE_DAYS * DAY;

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
const login = (user) => ctx.api.anon().post('/auth/login')
    .send({ email: user.email, password: STAFF_PASSWORD, loginType: 'staff' });

/** A seeded tenant turned into a trial ending `endsInMs` from `now`. */
async function trialTenant(label, endsInMs, { now = new Date(), sub = {} } = {}) {
    const t = await seedTenant({ label });
    await Restaurant.updateOne({ _id: t.restaurant._id }, {
        $set: {
            status: 'trial',
            'subscription.status': 'trial',
            'subscription.trialStartDate': new Date(now.getTime() - TRIAL_DAYS * DAY + endsInMs),
            'subscription.trialEndDate': new Date(now.getTime() + endsInMs),
            ...sub,
        },
    });
    return t;
}
// Reminder runs see every trial tenant in the shared DB: look at one only.
const mine = (list, t) => list.filter((x) => x.id === String(t.restaurant._id));
const reload = (t) => Restaurant.findById(t.restaurant._id).lean();
const reloadWithLead = (t) => Restaurant.findById(t.restaurant._id).select('+lead').lean();
const mailsTo = (to) => sendEmail.mock.calls.filter(([m]) => m.to === to).map(([m]) => m);

// A fixed clock inside the 09:00-18:00 Asia/Kolkata send window (11:00 IST).
const SEND_HOUR = new Date('2026-11-17T05:30:00.000Z');

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
            signupStatus: 'approved', trialStarted: true, autoLogin: true, trialDays: TRIAL_DAYS, planName: 'Gold',
        });
        expect(res.body.data.trialEndDate).toBeTruthy();
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.tenant).toMatchObject({
            status: 'trial', trialState: 'active', readOnly: false, trialExpired: false, planSlug: 'gold',
        });
        expect(res.body.tenant.daysLeft).toBe(TRIAL_DAYS);
        expect(res.body.tenant.lockAt).toBeTruthy();

        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({ status: 'trial', signupStatus: 'approved', signupSource: 'self' });
        expect(r.subscription.planSlug).toBe('gold');
        expect(r.subscription.trialStartDate).toBeTruthy();

        // Token works immediately, and a normal login does too.
        const me = await ctx.api.as(res.body.token).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialState: 'active', trialExpired: false, subscriptionStatus: 'trial' });
        const owner = await ctx.api.anon().post('/auth/login')
            .send({ email: body.contactEmail, password: PASSWORD, loginType: 'staff' });
        expect(owner.status).toBe(200);

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
    test('locks only trials past lockAt (end + grace) that never paid, and is idempotent', async () => {
        const now = new Date();
        const pastLock = await trialTenant('exp', -(GRACE + HOUR), { now });
        const readOnly = await trialTenant('ro', -2 * DAY, { now });               // ended, inside the grace
        const justBeforeLock = await trialTenant('edge', -(GRACE - 60 * 1000), { now });
        const live = await trialTenant('live', 3 * DAY, { now });
        const paid = await trialTenant('paid', -(GRACE + DAY), { now, sub: { 'subscription.lastChargedAt': new Date(now.getTime() - DAY) } });
        const activeSub = await trialTenant('actsub', -(GRACE + DAY), { now, sub: { 'subscription.status': 'active' } });
        const plain = await seedTenant({ label: 'plain' }); // active, no trial

        const first = await runTrialExpirySweep({ now });
        expect(first.locked).toEqual([String(pastLock.restaurant._id)]);

        const r = await reload(pastLock);
        expect(r).toMatchObject({ status: 'suspended', suspendedReason: TRIAL_LOCK_REASON });
        expect(r.subscription.status).toBe('expired');
        expect(r.subscription.trialExpiredAt).toBeTruthy();
        for (const t of [readOnly, justBeforeLock, live, paid, activeSub]) expect((await reload(t)).status).toBe('trial');
        expect((await reload(plain)).status).toBe('active');

        const second = await runTrialExpirySweep({ now });
        expect(second.locked).toEqual([]);

        // Once the grace is over the read-only tenant is locked by the next sweep.
        const later = new Date(now.getTime() + GRACE);
        const third = await runTrialExpirySweep({ now: later });
        expect(third.locked).toEqual(expect.arrayContaining([String(readOnly.restaurant._id), String(justBeforeLock.restaurant._id)]));
        expect(third.locked).not.toContain(String(live.restaurant._id));
    });

    test('concurrent sweeps lock a tenant exactly once', async () => {
        const now = new Date();
        const t = await trialTenant('race', -(GRACE + DAY), { now });
        const [a, b] = await Promise.all([runTrialExpirySweep({ now }), runTrialExpirySweep({ now })]);
        const all = [...a.locked, ...b.locked].filter((id) => id === String(t.restaurant._id));
        expect(all).toHaveLength(1);
    });

    test('the sweeper sends no email of its own (the reminder job owns t+0 / t+2)', async () => {
        const now = new Date();
        const t = await trialTenant('quiet', -(GRACE + DAY), { now });
        await runTrialExpirySweep({ now });
        expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(0);
    });
});

describe('read-only window (trial ended, before lockAt)', () => {
    let t;
    beforeAll(async () => {
        t = await trialTenant('ro', -1 * DAY);
    });

    test('GET passes for the owner, staff and guests', async () => {
        const admin = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(admin.status).not.toBe(403);
        const waiter = await ctx.api.as(t.users.waiter).get('/orders/live');
        expect(waiter.status).not.toBe(403);
        const guest = await ctx.api.guest(t).get('/menu');
        expect(guest.status).toBe(200);
    });

    test('POST / PUT / PATCH / DELETE answer 403 SUBSCRIPTION_READ_ONLY with lockAt + trialEndDate', async () => {
        const r = await reload(t);
        const expectedLockAt = new Date(new Date(r.subscription.trialEndDate).getTime() + GRACE).toISOString();
        const calls = [
            ctx.api.as(t.users.admin).post('/staff').send({ name: 'New Waiter', email: `nw.${uniq()}@staff.test`, role: 'waiter' }),
            ctx.api.as(t.users.admin).put(`/menu/${t.restaurant._id}`).send({ name: 'x' }),
            ctx.api.as(t.users.admin).patch(`/staff/${t.users.waiter._id}/status`).send({ status: 'inactive' }),
            ctx.api.as(t.users.admin).delete(`/menu/${t.restaurant._id}`),
            ctx.api.as(t.users.waiter).post('/orders').send({ items: [] }),
            ctx.api.guest(t).post('/orders').send({ items: [] }),
        ];
        for (const res of await Promise.all(calls)) {
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ success: false, code: 'SUBSCRIPTION_READ_ONLY' });
            expect(res.body.lockAt).toBe(expectedLockAt);
            expect(res.body.trialEndDate).toBe(new Date(r.subscription.trialEndDate).toISOString());
        }
        // Staff creation really was refused.
        const list = await ctx.api.as(t.users.admin).get('/staff');
        expect(JSON.stringify(list.body)).not.toMatch(/New Waiter/);
    });

    test('every role may still log in; the auth payload flags readOnly', async () => {
        const waiter = await login(t.users.waiter);
        expect(waiter.status).toBe(200);
        expect(waiter.body.tenant).toMatchObject({ trialState: 'read_only', readOnly: true, trialExpired: false, daysLeft: 0 });
        const owner = await login(t.users.admin);
        expect(owner.status).toBe(200);
        expect(owner.body.tenant.readOnly).toBe(true);
        const me = await ctx.api.as(t.users.waiter).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialState: 'read_only', readOnly: true });
        expect(me.body.user.tenant.lockAt).toBeTruthy();
    });

    test('owner billing (GET + POST) and export stay open; /auth writes pass for staff; staff billing does not', async () => {
        expect((await ctx.api.as(t.users.admin).get('/tenant/billing/current')).status).toBe(200);
        const upgrade = await ctx.api.as(t.users.admin).post('/tenant/billing/upgrade').send({ planSlug: 'gold' });
        expect(upgrade.body.code).not.toBe('SUBSCRIPTION_READ_ONLY');
        expect((await ctx.api.as(t.users.admin).get('/tenant/export')).status).not.toBe(403);
        const logout = await ctx.api.as(t.users.waiter).post('/auth/logout').send({});
        expect(logout.body.code).not.toBe('SUBSCRIPTION_READ_ONLY');
        const staffBilling = await ctx.api.as(t.users.waiter).post('/tenant/billing/upgrade').send({ planSlug: 'gold' });
        expect(staffBilling.status).toBe(403);
        expect(staffBilling.body.code).toBe('SUBSCRIPTION_READ_ONLY');
    });
});

describe('locked tenant (after lockAt)', () => {
    let t;
    beforeAll(async () => {
        t = await trialTenant('lock', -(GRACE + DAY));
        await runTrialExpirySweep();
    });

    test('normal routes answer 403 SUBSCRIPTION_BLOCKED with lockAt + trialEndDate', async () => {
        const res = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ success: false, code: 'SUBSCRIPTION_BLOCKED' });
        expect(res.body.trialEndDate).toBeTruthy();
        expect(res.body.lockAt).toBeTruthy();
        expect(JSON.stringify(res.body)).not.toMatch(/TRIAL_EXPIRED/);
    });

    test('customer menu / staff apps are unavailable', async () => {
        const guest = await ctx.api.guest(t).get('/menu');
        expect(guest.status).toBe(403);
        expect(guest.body.code).toBe('SUBSCRIPTION_BLOCKED');
        const waiter = await ctx.api.as(t.users.waiter).get('/orders/live');
        expect(waiter.status).toBe(403);
        expect(waiter.body.code).toBe('SUBSCRIPTION_BLOCKED');
        const waiterBilling = await ctx.api.as(t.users.waiter).get('/tenant/billing/current');
        expect(waiterBilling.status).toBe(403);
        expect(waiterBilling.body.code).toBe('SUBSCRIPTION_BLOCKED');
    });

    test('staff login is refused with SUBSCRIPTION_BLOCKED; the owner can log in', async () => {
        const staff = await login(t.users.waiter);
        expect(staff.status).toBe(403);
        expect(staff.body.code).toBe('SUBSCRIPTION_BLOCKED');
        const owner = await login(t.users.admin);
        expect(owner.status).toBe(200);
        expect(owner.body.tenant).toMatchObject({
            trialState: 'locked', trialExpired: true, readOnly: false, subscriptionStatus: 'expired', daysLeft: 0,
        });
    });

    test('owner still reaches /auth/me, billing and export', async () => {
        const me = await ctx.api.as(t.users.admin).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ trialState: 'locked', trialExpired: true, daysLeft: 0 });
        expect(me.body.user.tenant.trialStartDate).toBeTruthy();
        expect(me.body.user.tenant.trialEndDate).toBeTruthy();

        const billing = await ctx.api.as(t.users.admin).get('/tenant/billing/current');
        expect(billing.status).toBe(200);
        const exp = await ctx.api.as(t.users.admin).get('/tenant/export');
        expect(exp.status).not.toBe(403);
    });

    test('paying restores full access (writable at once) with data intact', async () => {
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

        // The Gold snapshot above carries only { dineIn } so module gates may
        // still answer 403 of their own; only the trial codes must be gone.
        const TRIAL_CODES = ['SUBSCRIPTION_BLOCKED', 'SUBSCRIPTION_READ_ONLY', 'TRIAL_EXPIRED'];
        const res = await ctx.api.as(t.users.admin).get('/orders/live');
        expect(res.status).not.toBe(403);
        const waiter = await ctx.api.as(t.users.waiter).get('/orders/live');
        expect(TRIAL_CODES).not.toContain(waiter.body.code);
        expect((await login(t.users.waiter)).status).toBe(200);
        const me = await ctx.api.as(t.users.admin).get('/auth/me');
        expect(me.body.user.tenant).toMatchObject({ trialState: 'none', trialExpired: false, readOnly: false });
        // A real write goes through again (this one deactivates the waiter, so it runs last).
        const write = await ctx.api.as(t.users.admin).patch(`/staff/${t.users.waiter._id}/status`).send({ status: 'inactive' });
        expect(write.status).toBe(200);
    });
});

describe('request-time backstop (no sweeper)', () => {
    test('a trial inside the grace is read-only, one past lockAt is blocked, before any sweep', async () => {
        const ro = await trialTenant('back-ro', -1 * HOUR);
        expect((await ctx.api.as(ro.users.admin).get('/orders/live')).status).not.toBe(403);
        const w = await ctx.api.as(ro.users.admin).post('/staff').send({ name: 'x', email: `x.${uniq()}@staff.test`, role: 'waiter' });
        expect(w.body.code).toBe('SUBSCRIPTION_READ_ONLY');

        const locked = await trialTenant('back-lock', -(GRACE + HOUR));
        const res = await ctx.api.as(locked.users.admin).get('/orders/live');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SUBSCRIPTION_BLOCKED');
        expect((await ctx.api.as(locked.users.admin).get('/tenant/billing/current')).status).toBe(200);
        expect((await reload(locked)).status).toBe('trial'); // the sweeper has not run
    });
});

describe('reminders', () => {
    test('t-3 / t-1 / t+0 / t+2 each go out once; a second run sends nothing', async () => {
        const now = SEND_HOUR;
        // Ends 2 days + 1 hour from now (13:00 IST), so every run below at 11:00 IST sits inside one window.
        const t = await trialTenant('rem', 2 * DAY + HOUR, { now });
        const to = t.restaurant.contactEmail;
        const at = (ms) => new Date(now.getTime() + ms);

        let run = await runTrialReminders({ now, dryRun: false });
        expect(mine(run.sent, t)).toEqual([{ id: String(t.restaurant._id), type: 't-3' }]);
        expect(mailsTo(to)).toHaveLength(1);
        expect(mailsTo(to)[0].subject).toMatch(/ends in 3 days/);
        expect(mailsTo(to)[0].html).toMatch(/Upgrade now/);
        expect(mailsTo(to)[0].text).toMatch(/This is an account notice for your BestoDine trial/);

        run = await runTrialReminders({ now, dryRun: false });
        expect(mine(run.sent, t)).toEqual([]);
        expect(mailsTo(to)).toHaveLength(1);

        run = await runTrialReminders({ now: at(2 * DAY), dryRun: false }); // 1h before the end
        expect(mine(run.sent, t).map((s) => s.type)).toEqual(['t-1']);
        expect(mailsTo(to)[1].subject).toMatch(/ends tomorrow/);

        run = await runTrialReminders({ now: at(3 * DAY), dryRun: false }); // ended, read-only
        expect(mine(run.sent, t).map((s) => s.type)).toEqual(['t+0']);
        expect(mailsTo(to)[2].subject).toMatch(/has ended/);
        expect(mailsTo(to)[2].text).toMatch(/locks completely on/);

        run = await runTrialReminders({ now: at(5 * DAY), dryRun: false }); // last read-only day (lockAt is 1h later)
        expect(mine(run.sent, t).map((s) => s.type)).toEqual(['t+2']);
        expect(mailsTo(to)[3].subject).toMatch(/Last day/);
        expect(mine((await runTrialReminders({ now: at(5 * DAY), dryRun: false })).sent, t)).toEqual([]);

        const r = await reloadWithLead(t);
        expect(r.subscription.trialReminders.map((x) => x.type).sort()).toEqual(['t+0', 't+2', 't-1', 't-3'].sort());
        for (const row of r.subscription.trialReminders) expect(row.sentAt).toBeTruthy();
        expect(r.subscription.trialRemindersSent || []).toEqual([]);  // legacy field untouched
        expect(await Notification.countDocuments({ restaurant: t.restaurant._id, category: 'System', recipientRole: 'admin' })).toBe(4);
        // System notes on the lead, without touching stage / lastContactedAt.
        const notes = r.lead.notes.filter((n) => n.kind === 'system').map((n) => n.text);
        expect(notes).toEqual([
            'Auto email: trial ends in 3 days',
            'Auto email: trial ends tomorrow',
            expect.stringMatching(/^Auto email: trial ended, locks on /),
            'Auto email: last day before lock',
        ]);
        expect(r.lead.stage).toBe('new');
        expect(r.lead.lastContactedAt).toBeNull();
    });

    test('only the latest missed type is sent', async () => {
        const now = SEND_HOUR;
        const t = await trialTenant('rem2', 12 * HOUR, { now }); // t-3 and t-1 both already triggered
        const run = await runTrialReminders({ now, dryRun: false });
        expect(mine(run.sent, t)).toEqual([{ id: String(t.restaurant._id), type: 't-1' }]);
        expect(mine((await runTrialReminders({ now, dryRun: false })).sent, t)).toEqual([]);
    });

    test('a converted (paid) tenant and a locked tenant get nothing', async () => {
        const now = SEND_HOUR;
        const paid = await trialTenant('rem4', 2 * DAY, { now, sub: { 'subscription.lastChargedAt': now } });
        const active = await trialTenant('rem5', 2 * DAY, { now, sub: { 'subscription.status': 'active' } });
        const locked = await trialTenant('rem6', -(GRACE + HOUR), { now });
        const run = await runTrialReminders({ now, dryRun: false });
        for (const t of [paid, active, locked]) {
            expect(mine(run.sent, t)).toEqual([]);
            expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(0);
        }
    });

    test('a failed send releases the claim and is retried on the next run', async () => {
        const now = SEND_HOUR;
        const t = await trialTenant('rem7', 2 * DAY, { now });
        const to = t.restaurant.contactEmail;
        sendEmail.mockImplementationOnce(async () => ({ sent: false, provider: 'smtp', dev: false, error: 'boom' }));

        let run = await runTrialReminders({ now, dryRun: false });
        expect(mine(run.sent, t)).toEqual([]);
        expect(mine(run.failed, t)).toEqual([{ id: String(t.restaurant._id), type: 't-3', error: 'boom' }]);
        expect((await reload(t)).subscription.trialReminders).toEqual([]);
        expect(await Notification.countDocuments({ restaurant: t.restaurant._id, category: 'System' })).toBe(0);

        run = await runTrialReminders({ now: new Date(now.getTime() + HOUR), dryRun: false });
        expect(mine(run.sent, t)).toEqual([{ id: String(t.restaurant._id), type: 't-3' }]);
        expect(mailsTo(to)).toHaveLength(2); // the failed attempt + the retry
        const r = await reload(t);
        expect(r.subscription.trialReminders).toHaveLength(1);
        expect(r.subscription.trialReminders[0]).toMatchObject({ type: 't-3' });
        expect(r.subscription.trialReminders[0].sentAt).toBeTruthy();
    });

    test('concurrent runs claim each reminder once', async () => {
        const now = SEND_HOUR;
        const t = await trialTenant('rem8', 2 * DAY, { now });
        const [a, b] = await Promise.all([runTrialReminders({ now, dryRun: false }), runTrialReminders({ now, dryRun: false })]);
        expect([...mine(a.sent, t), ...mine(b.sent, t)]).toHaveLength(1);
        expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(1);
    });

    test('outside the 09:00-18:00 send window nothing is sent', async () => {
        const now = new Date('2026-11-17T15:30:00.000Z'); // 21:00 IST
        const t = await trialTenant('rem9', 2 * DAY, { now });
        const run = await runTrialReminders({ now, dryRun: false });
        expect(mine(run.sent, t)).toEqual([]);
        expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(0);
        // Same tenant, next morning: due.
        const morning = new Date('2026-11-18T04:30:00.000Z'); // 10:00 IST
        expect(mine((await runTrialReminders({ now: morning, dryRun: false })).sent, t).map((s) => s.type)).toEqual(['t-3']);
    });

    test('dry run reports who would be emailed and records nothing', async () => {
        const now = SEND_HOUR;
        const t = await trialTenant('rem10', 2 * DAY, { now });
        const run = await runTrialReminders({ now, dryRun: true });
        expect(mine(run.dryRun, t)).toEqual([{ id: String(t.restaurant._id), type: 't-3' }]);
        expect(mine(run.sent, t)).toEqual([]);
        expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(0);
        expect((await reload(t)).subscription.trialReminders).toEqual([]);
    });

    test('a tenant that pays after a reminder gets no further reminder', async () => {
        const now = SEND_HOUR;
        const t = await trialTenant('rem11', 2 * DAY + HOUR, { now });
        expect(mine((await runTrialReminders({ now, dryRun: false })).sent, t).map((s) => s.type)).toEqual(['t-3']);
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.lastChargedAt': now } });
        const later = await runTrialReminders({ now: new Date(now.getTime() + 2 * DAY), dryRun: false });
        expect(mine(later.sent, t)).toEqual([]);
        expect(mailsTo(t.restaurant.contactEmail)).toHaveLength(1);
    });
});
