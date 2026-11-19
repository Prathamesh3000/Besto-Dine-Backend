/**
 * STRICT tenant campaign / jobs: subscription renewal reminders, lapse rule
 * and due downgrades (utils/renewalReminderJob, 'renewal-reminders').
 *
 * Several tenants with different paid terms. Each email must go to ITS OWN
 * contactEmail with its own name / plan / period; locked tenants (trial,
 * suspended, cancelled) and live auto-renewing subscriptions are never
 * emailed or lapsed; one tenant failing (email throws, DB throws) never stops
 * the others, across all three phases; a second run does not re-send,
 * re-lapse or re-apply; the JobLock admits one instance per interval.
 */
const crypto = require('crypto');
const path = require('path');

const mockSent = [];
let mockFailFor = null;
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async (msg) => {
        if (mockFailFor && msg.to === mockFailFor) throw new Error('smtp down');
        mockSent.push(msg);
        return { ok: true };
    }),
}));

const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const JobLock = require(path.join(BACKEND, 'models/jobLock'));
const job = require(path.join(BACKEND, 'utils/renewalReminderJob'));
const { runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { createScheduler } = require(path.join(BACKEND, 'utils/scheduler'));
const { createJobLock } = require(path.join(BACKEND, 'utils/jobLock'));

useIntegrationApp();
const DAY = 24 * 3600 * 1000;
const run = (fn) => runAsSystem('job:renewal-reminders', fn);
const get = (t) => runAsSystem('r', () => Restaurant.findById(t.restaurant._id).lean());
const setR = (t, $set) => Restaurant.collection.updateOne({ _id: t.restaurant._id }, { $set });
const mailTo = (t) => mockSent.filter((m) => m.to === t.restaurant.contactEmail);

// A seeded tenant on a paid term ending in `days` days (fractions allowed).
async function paidTenant(label, days, extra = {}) {
    const t = await seedTenant({ label });
    await setR(t, {
        'subscription.currentPeriodEnd': new Date(Date.now() + days * DAY),
        'subscription.billingCycle': 'annual',
        'subscription.planName': `Plan-${label}`,
        'signupMeta.ownerName': `Owner ${label}`,
        ...extra,
    });
    return t;
}

beforeEach(() => { mockSent.length = 0; mockFailFor = null; });

describe('reminder emails', () => {
    let A; let B; let C;
    beforeAll(async () => {
        A = await paidTenant('rna', 6);       // inside 7-day window
        B = await paidTenant('rnb', 0.5);     // inside 1-day window
        C = await paidTenant('rnc', 20);      // too far out
    });

    test('each tenant owner gets exactly their own reminder, with their own plan and threshold', async () => {
        const r = await run(() => job.runRenewalReminders());
        const a = mailTo(A); const b = mailTo(B);
        expect(a).toHaveLength(1); expect(b).toHaveLength(1);
        expect(mailTo(C)).toHaveLength(0);
        expect(a[0].subject).toContain('Plan-rna'); expect(a[0].subject).toContain('7 days'); expect(a[0].subject).toContain(A.restaurant.name);
        expect(b[0].subject).toContain('Plan-rnb'); expect(b[0].subject).toContain('1 day'); expect(b[0].subject).toContain(B.restaurant.name);
        expect(a[0].html).toContain('Owner rna'); expect(a[0].html).not.toContain('Owner rnb');
        expect(b[0].html).not.toContain(A.restaurant.name);
        // a single recipient per message, never a list spanning tenants
        for (const m of mockSent) expect(String(m.to)).not.toMatch(/[,;]/);
        expect(r.sent.map((s) => s.id)).toEqual(expect.arrayContaining([String(A.restaurant._id), String(B.restaurant._id)]));
        // dedupe markers are written on the owning tenant only
        expect((await get(A)).subscription.renewalReminderSentFor.length).toBeGreaterThan(0);
        expect((await get(B)).subscription.renewalReminderSentFor.length).toBeGreaterThan(0);
        expect((await get(C)).subscription.renewalReminderSentFor || []).toHaveLength(0);
    });

    test('idempotent: running again sends nothing', async () => {
        const r = await run(() => job.runRenewalReminders());
        expect(r.sent).toHaveLength(0);
        expect(mockSent).toHaveLength(0);
    });

    test('concurrent runs (two instances) send each reminder once', async () => {
        const D = await paidTenant('rnd', 5);
        await Promise.all([run(() => job.runRenewalReminders()), run(() => job.runRenewalReminders())]);
        expect(mailTo(D)).toHaveLength(1);
    });
});

describe('who is never emailed', () => {
    test('trial, suspended, cancelled and live auto-renewing tenants are skipped', async () => {
        const trial = await paidTenant('rnt', 3, { status: 'trial', 'subscription.status': 'trial' });
        const susp = await paidTenant('rns', 3, { status: 'suspended' });
        const canc = await paidTenant('rnx', 3, { status: 'cancelled', 'subscription.status': 'cancelled' });
        const live = await paidTenant('rnl', 3, { 'subscription.razorpaySubscriptionId': 'sub_live', 'subscription.razorpayStatus': 'active' });
        const dead = await paidTenant('rnh', 3, { 'subscription.razorpaySubscriptionId': 'sub_dead', 'subscription.razorpayStatus': 'cancelled' });
        const expired = await paidTenant('rne', -2);
        await run(() => job.runRenewalReminders());
        for (const t of [trial, susp, canc, live, expired]) expect(mailTo(t)).toHaveLength(0);
        expect(mailTo(dead)).toHaveLength(1); // a cancelled subscription does not auto-renew
    });
});

describe('failure isolation', () => {
    test('an email failure for one tenant releases its marker (retried next run) and does not stop another tenant', async () => {
        const X = await paidTenant('rnfx', 4); const Y = await paidTenant('rnfy', 4);
        mockFailFor = X.restaurant.contactEmail;
        const r = await run(() => job.runRenewalReminders());
        expect(mailTo(Y)).toHaveLength(1);
        expect(mailTo(X)).toHaveLength(0);
        expect(r.sent.map((s) => s.id)).toContain(String(Y.restaurant._id));
        expect((await get(X)).subscription.renewalReminderSentFor || []).toHaveLength(0);
        mockFailFor = null;
        await run(() => job.runRenewalReminders());
        expect(mailTo(X)).toHaveLength(1);
        expect(mailTo(Y)).toHaveLength(1); // not re-sent
    });

    test('a DB error while claiming one tenant does not stop the next tenant', async () => {
        const X = await paidTenant('rnfa', 4); const Y = await paidTenant('rnfb', 4);
        const real = Restaurant.findOneAndUpdate;
        const spy = jest.spyOn(Restaurant, 'findOneAndUpdate').mockImplementation(function (filter, ...rest) {
            if (filter && String(filter._id) === String(X.restaurant._id)) return Promise.reject(new Error('claim db error'));
            return real.call(this, filter, ...rest);
        });
        try { await run(() => job.runRenewalReminders()); } finally { spy.mockRestore(); }
        expect(mailTo(X)).toHaveLength(0);
        expect(mailTo(Y)).toHaveLength(1);
    });
});

describe('lapse rule', () => {
    test('only an active, non-auto-renewing tenant past period end + grace goes past_due; others untouched', async () => {
        const lapsed = await paidTenant('rla', -4);
        const inGrace = await paidTenant('rlb', -1);
        const future = await paidTenant('rlc', 10);
        const live = await paidTenant('rld', -10, { 'subscription.razorpaySubscriptionId': 'sub_l', 'subscription.razorpayStatus': 'active' });
        const trial = await paidTenant('rle', -10, { status: 'trial', 'subscription.status': 'trial' });
        const susp = await paidTenant('rlf', -10, { status: 'suspended' });
        const invalidated = [];
        const r = await run(() => job.runLapseCheck({ onLapsed: (t) => invalidated.push(String(t._id)) }));
        expect(r.lapsed).toContain(String(lapsed.restaurant._id));
        const l = await get(lapsed);
        expect(l.status).toBe('past_due'); expect(l.subscription.status).toBe('past_due');
        for (const t of [inGrace, future, live]) { const d = await get(t); expect(d.status).toBe('active'); expect(d.subscription.status).toBe('active'); }
        expect((await get(trial)).status).toBe('trial');
        expect((await get(susp)).status).toBe('suspended');
        expect(invalidated).toEqual(expect.arrayContaining([String(lapsed.restaurant._id)]));
        expect(invalidated).not.toContain(String(live.restaurant._id));
        // idempotent
        const r2 = await run(() => job.runLapseCheck());
        expect(r2.lapsed).not.toContain(String(lapsed.restaurant._id));
    });

    test('a failure lapsing one tenant does not stop another', async () => {
        const X = await paidTenant('rlfx', -5); const Y = await paidTenant('rlfy', -5);
        const real = Restaurant.findOneAndUpdate;
        const spy = jest.spyOn(Restaurant, 'findOneAndUpdate').mockImplementation(function (filter, ...rest) {
            if (filter && String(filter._id) === String(X.restaurant._id)) return Promise.reject(new Error('db error'));
            return real.call(this, filter, ...rest);
        });
        try { await run(() => job.runLapseCheck()); } finally { spy.mockRestore(); }
        expect((await get(X)).status).toBe('active');
        expect((await get(Y)).status).toBe('past_due');
    });
});

describe('scheduled downgrades', () => {
    const sched = (slug, effectiveMs) => ({
        'subscription.scheduledDowngrade': { planSlug: slug, planName: `Down-${slug}`, billingCycle: 'monthly', effectiveAt: new Date(Date.now() + effectiveMs) },
    });
    test('a due downgrade is applied to its own tenant only; a future one waits; second run is a no-op', async () => {
        const due = await paidTenant('rda', 1, sched('silver-a', -DAY));
        const later = await paidTenant('rdb', 1, sched('silver-b', 5 * DAY));
        const plain = await paidTenant('rdc', 1);
        const r = await run(() => job.runDueDowngrades());
        expect(r.applied).toEqual([String(due.restaurant._id)]);
        const d = await get(due);
        expect(d.subscription.planSlug).toBe('silver-a'); expect(d.subscription.planName).toBe('Down-silver-a');
        expect(d.subscription.scheduledDowngrade?.planSlug).toBeUndefined();
        const l = await get(later);
        expect(l.subscription.planSlug).not.toBe('silver-b'); expect(l.subscription.scheduledDowngrade.planSlug).toBe('silver-b');
        expect((await get(plain)).subscription.planName).toBe('Plan-rdc');
        const r2 = await run(() => job.runDueDowngrades());
        expect(r2.applied).toHaveLength(0);
    });

    test('a failure applying one tenant downgrade does not stop another', async () => {
        const X = await paidTenant('rdfx', 1, sched('s-x', -DAY)); const Y = await paidTenant('rdfy', 1, sched('s-y', -DAY));
        const real = Restaurant.findById;
        const spy = jest.spyOn(Restaurant, 'findById').mockImplementation(function (id, ...rest) {
            if (String(id) === String(X.restaurant._id)) throw new Error('db error');
            return real.call(this, id, ...rest);
        });
        try { await run(() => job.runDueDowngrades()); } finally { spy.mockRestore(); }
        expect((await get(X)).subscription.planSlug).not.toBe('s-x');
        expect((await get(Y)).subscription.planSlug).toBe('s-y');
    });
});

describe('whole job', () => {
    test('a failing reminders phase does not skip the lapse and downgrade phases', async () => {
        const lapsed = await paidTenant('rwa', -6);
        const due = await paidTenant('rwb', 1, { 'subscription.scheduledDowngrade': { planSlug: 'w-b', planName: 'Down-w-b', billingCycle: 'monthly', effectiveAt: new Date(Date.now() - DAY) } });
        const real = Restaurant.find;
        let first = true;
        const spy = jest.spyOn(Restaurant, 'find').mockImplementation(function (...args) {
            if (first) { first = false; throw new Error('reminder query failed'); }
            return real.apply(this, args);
        });
        let out;
        try { out = await run(() => job.runRenewalJob()); } finally { spy.mockRestore(); }
        expect(out.reminders).toEqual({ checked: 0, sent: [] });
        expect((await get(lapsed)).status).toBe('past_due');
        expect((await get(due)).subscription.planSlug).toBe('w-b');
    });
});

describe('JobLock', () => {
    test('only one of two instances runs the renewal-reminders tick per interval', async () => {
        const fn = jest.fn(() => job.runRenewalJob());
        const s1 = createScheduler({ lock: createJobLock({ owner: 'rn-1' }) });
        const s2 = createScheduler({ lock: createJobLock({ owner: 'rn-2' }) });
        for (const s of [s1, s2]) s.scheduleJob('renewal-reminders', DAY, fn, { initialDelayMs: 7 * DAY });
        await Promise.all([s1._runTick('renewal-reminders'), s2._runTick('renewal-reminders')]);
        await s1._runTick('renewal-reminders'); await s2._runTick('renewal-reminders');
        expect(fn).toHaveBeenCalledTimes(1);
        const lock = await JobLock.findOne({ name: 'renewal-reminders' }).lean();
        expect(lock.lockedUntil.getTime()).toBeGreaterThan(Date.now());
        expect(['rn-1', 'rn-2']).toContain(lock.owner);
        await Promise.all([s1.stopAll(), s2.stopAll()]);
    });
});
