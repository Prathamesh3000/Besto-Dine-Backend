/**
 * Plan card fields + trial extension (TRIAL_SIGNUP_AND_LEADS_PLAN §2, §6):
 *   - POST /superadmin/plans keeps tier 0 (0 is a valid rank), rejects a
 *     non-numeric tier with 400, round-trips { trial, badge, highlights }
 *     and keeps the legacy trialDays in sync with `trial`
 *   - PUT /superadmin/plans/:id edits tier / trial / badge / highlights
 *   - GET /public/plans exposes tier / trial / badge / highlights (sortOrder stays internal; the list is pre-sorted)
 *   - migrations/backfillPlanTiers fills tier + trial on old rows (dry run first)
 *   - POST /superadmin/restaurants/:id/extend-trial adds days from
 *     max(now, trialEndDate), re-opens a locked tenant, clears reminders,
 *     is audited, and refuses paid tenants / support-level superadmins
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const { runTrialExpirySweep } = require(path.join(BACKEND, 'utils/trialExpirySweeper'));
const { backfillPlanTiers } = require(path.join(BACKEND, 'migrations/backfillPlanTiers'));

const ctx = useIntegrationApp();
const DAY = 24 * 60 * 60 * 1000;
const uniq = () => Math.random().toString(16).slice(2, 8);

let sa;         // superadmin, level full
let support;    // superadmin, level support (read-only)
const SA = () => ctx.api.as(sa);

beforeAll(async () => {
    sa = await createUser({ name: 'Root PT', email: `root.pt.${uniq()}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
    support = await createUser({ name: 'Support PT', email: `support.pt.${uniq()}@platform.test`, role: 'superadmin', superadminLevel: 'support' });
});

/** A seeded tenant turned into an unpaid trial ending `endsInMs` from now. */
async function trialTenant(label, endsInMs, sub = {}) {
    const t = await seedTenant({ label });
    const now = Date.now();
    await Restaurant.updateOne({ _id: t.restaurant._id }, {
        $set: {
            status: 'trial',
            'subscription.status': 'trial',
            'subscription.trialStartDate': new Date(now - 14 * DAY + endsInMs),
            'subscription.trialEndDate': new Date(now + endsInMs),
            'subscription.lastChargedAt': null,
            ...sub,
        },
    });
    return t;
}
const reload = (t) => Restaurant.findById(t.restaurant._id).lean();
const extend = (t, body, who = SA()) => who.post(`/superadmin/restaurants/${t.restaurant._id}/extend-trial`).send(body);
const closeTo = (actual, expected, toleranceMs = 60 * 1000) =>
    Math.abs(new Date(actual).getTime() - expected) <= toleranceMs;

// ═══════════════════════════════════════════════════════════════════════
describe('plan create / update with card fields', () => {
    test('tier 0 is stored as 0 (not defaulted away); trial object round-trips and syncs trialDays', async () => {
        const res = await SA().post('/superadmin/plans').send({
            name: `Free ${uniq()}`, price: 0, tier: 0,
            trial: { enabled: true, durationDays: 21 },
            badge: '  Starter  ',
            highlights: [' Billing ', '', 'QR ordering', '   '],
            features: { dineIn: true },
        });
        expect(res.status).toBe(201);
        expect(res.body.data.tier).toBe(0);
        expect(res.body.data.trial).toEqual({ enabled: true, durationDays: 21 });
        expect(res.body.data.trialDays).toBe(21);
        expect(res.body.data.badge).toBe('Starter');
        expect(res.body.data.highlights).toEqual(['Billing', 'QR ordering']);

        const row = await SubscriptionPlan.findById(res.body.data._id).lean();
        expect(row.tier).toBe(0);
        expect(row.trialDays).toBe(21);
        expect(row.trial).toMatchObject({ enabled: true, durationDays: 21 });
    });

    test('a non-numeric tier is a 400 with a clear message, not a stripped field', async () => {
        const res = await SA().post('/superadmin/plans').send({ name: `Std ${uniq()}`, price: 999, tier: 'standard' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/tier/i);
        expect((await SA().post('/superadmin/plans').send({ name: `Neg ${uniq()}`, price: 999, tier: -1 })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ name: `Frac ${uniq()}`, price: 999, tier: 1.5 })).status).toBe(400);
    });

    test('tier is required on create; a numeric string is accepted and stored as a Number', async () => {
        const missing = await SA().post('/superadmin/plans').send({ name: `NoTier ${uniq()}`, price: 999 });
        expect(missing.status).toBe(400);
        expect(missing.body.message).toMatch(/tier/i);

        const str = await SA().post('/superadmin/plans').send({ name: `StrTier ${uniq()}`, price: 999, tier: '20' });
        expect(str.status).toBe(201);
        expect(str.body.data.tier).toBe(20);
    });

    test('trial disabled → trialDays 0; legacy trialDays-only payload derives trial', async () => {
        const off = await SA().post('/superadmin/plans').send({
            name: `Off ${uniq()}`, price: 100, tier: 10, trial: { enabled: false, durationDays: 30 },
        });
        expect(off.status).toBe(201);
        expect(off.body.data.trialDays).toBe(0);
        expect(off.body.data.trial).toEqual({ enabled: false, durationDays: 30 });

        const legacy = await SA().post('/superadmin/plans').send({ name: `Legacy ${uniq()}`, price: 100, tier: 10, trialDays: 7 });
        expect(legacy.status).toBe(201);
        expect(legacy.body.data.trial).toEqual({ enabled: true, durationDays: 7 });
        expect(legacy.body.data.trialDays).toBe(7);
    });

    test('validator rejects bad trial / badge / highlights shapes', async () => {
        const base = { name: `Bad ${uniq()}`, price: 100, tier: 10 };
        expect((await SA().post('/superadmin/plans').send({ ...base, trial: { enabled: 'yes' } })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, trial: { enabled: true, durationDays: 4000 } })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, trial: 'two weeks' })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, badge: 'x'.repeat(41) })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, highlights: 'not a list' })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, highlights: Array.from({ length: 9 }, (_, i) => `h${i}`) })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, highlights: ['ok', 42] })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ ...base, highlights: ['y'.repeat(121)] })).status).toBe(400);
    });

    test('update edits tier / trial / badge / highlights, tier 0 included, and is audited', async () => {
        const plan = await SubscriptionPlan.create({
            name: 'Edit Me', slug: `edit-me-${uniq()}`, price: 500, tier: 20, trial: { enabled: true, durationDays: 14 },
        });
        const res = await SA().put(`/superadmin/plans/${plan._id}`).send({
            tier: 0, trial: { enabled: false }, badge: 'Legacy', highlights: ['One', ' Two '],
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ tier: 0, badge: 'Legacy', highlights: ['One', 'Two'], trialDays: 0 });
        expect(res.body.data.trial).toEqual({ enabled: false, durationDays: 14 });

        const row = await SubscriptionPlan.findById(plan._id).lean();
        expect(row.tier).toBe(0);
        expect(row.trial.enabled).toBe(false);
        expect(row.trialDays).toBe(0);

        const audit = await AuditLog.findOne({ action: 'plan.update', targetId: plan._id }).sort({ createdAt: -1 }).lean();
        expect(audit).toBeTruthy();
        expect(audit.details.changedFields).toEqual(expect.arrayContaining(['tier', 'badge', 'highlights', 'trial.enabled']));

        expect((await SA().put(`/superadmin/plans/${plan._id}`).send({ tier: 'gold' })).status).toBe(400);
        // Untouched when omitted.
        const keep = await SA().put(`/superadmin/plans/${plan._id}`).send({ description: 'still zero' });
        expect(keep.status).toBe(200);
        expect(keep.body.data.tier).toBe(0);
    });

    test('support-level superadmin cannot create a plan with the new fields', async () => {
        const res = await ctx.api.as(support).post('/superadmin/plans').send({ name: 'Sneaky', price: 1, tier: 10 });
        expect(res.status).toBe(403);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('GET /public/plans', () => {
    test('exposes tier, trial, badge and highlights for public plans (sortOrder stays internal); cache is refreshed on write', async () => {
        const slug = `pub-${uniq()}`;
        const res = await SA().post('/superadmin/plans').send({
            name: `Pub ${slug}`, slug, price: 1799, tier: 20, sortOrder: 7,
            trial: { enabled: true, durationDays: 14 }, badge: 'Most popular', highlights: ['Loyalty', 'CRM'],
            highlight: true,
        });
        expect(res.status).toBe(201);

        const pub = await ctx.api.anon().get('/public/plans');
        expect(pub.status).toBe(200);
        const p = (pub.body.data || pub.body.plans || []).find((x) => x.slug === slug);
        expect(p).toBeTruthy();
        expect(p).toMatchObject({
            tier: 20, badge: 'Most popular', highlights: ['Loyalty', 'CRM'],
            trialDays: 14, highlight: true,
        });
        expect(p.trial).toEqual({ enabled: true, durationDays: 14 });

        // Edit → the 5-minute public cache is invalidated by the controller.
        await SA().put(`/superadmin/plans/${res.body.data._id}`).send({ tier: 25, badge: '' });
        const again = await ctx.api.anon().get('/public/plans');
        const p2 = (again.body.data || again.body.plans || []).find((x) => x.slug === slug);
        expect(p2.tier).toBe(25);
        expect(p2.badge).toBe('');
    });

    test('a pre-migration row (no tier / trial) reads as tier 0 and trial derived from trialDays', async () => {
        const slug = `old-${uniq()}`;
        await SubscriptionPlan.collection.insertOne({
            name: 'Old Row', slug, price: 300, trialDays: 10, isActive: true, isPublic: true, sortOrder: 9,
            limits: {}, features: {}, createdAt: new Date(), updatedAt: new Date(),
        });
        const { publicPlansCache } = require(path.join(BACKEND, 'utils/publicPlans'));
        publicPlansCache.invalidate();
        const pub = await ctx.api.anon().get('/public/plans');
        const p = (pub.body.data || pub.body.plans || []).find((x) => x.slug === slug);
        expect(p).toBeTruthy();
        expect(p.tier).toBe(0);
        expect(p.trial).toEqual({ enabled: true, durationDays: 10 });
        expect(p.highlights).toEqual([]);
        expect(p.badge).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('migrations/backfillPlanTiers', () => {
    test('dry run writes nothing; --apply fills tier from slug map / sortOrder and trial from trialDays', async () => {
        const tag = uniq();
        const rows = [
            { name: 'Gold BF', slug: 'gold', trialDays: 14, sortOrder: 2 },
            { name: 'Free BF', slug: 'free', trialDays: 0, sortOrder: 0 },
            { name: 'Custom BF', slug: `custom-${tag}`, trialDays: 30, sortOrder: 4 },
        ];
        // Insert raw so no model default supplies tier / trial.
        await SubscriptionPlan.collection.insertMany(rows.map((r) => ({
            ...r, price: 100, isActive: true, isPublic: false, limits: {}, features: {}, createdAt: new Date(), updatedAt: new Date(),
        })));
        const slugs = rows.map((r) => r.slug);
        const mine = (report) => report.changed.filter((c) => slugs.includes(c.slug));

        const dry = await backfillPlanTiers({ apply: false, log: () => {} });
        expect(mine(dry)).toHaveLength(3);
        for (const s of slugs) {
            const row = await SubscriptionPlan.collection.findOne({ slug: s });
            expect(row.tier).toBeUndefined();
            expect(row.trial).toBeUndefined();
        }

        const applied = await backfillPlanTiers({ apply: true, log: () => {} });
        expect(mine(applied)).toHaveLength(3);
        const gold = await SubscriptionPlan.collection.findOne({ slug: 'gold' });
        expect(gold.tier).toBe(20);
        expect(gold.trial).toEqual({ enabled: true, durationDays: 14 });
        const free = await SubscriptionPlan.collection.findOne({ slug: 'free' });
        expect(free.tier).toBe(0);
        expect(free.trial).toEqual({ enabled: false, durationDays: 14 });
        const custom = await SubscriptionPlan.collection.findOne({ slug: `custom-${tag}` });
        expect(custom.tier).toBe(40);
        expect(custom.trial).toEqual({ enabled: true, durationDays: 30 });

        // Idempotent: nothing left to do for these rows.
        const second = await backfillPlanTiers({ apply: false, log: () => {} });
        expect(mine(second)).toHaveLength(0);
        await SubscriptionPlan.deleteMany({ slug: { $in: slugs } });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /superadmin/restaurants/:id/extend-trial', () => {
    test('active trial: days are added to the current end date (not to today); start date kept; audited', async () => {
        const t = await trialTenant('ext-live', 3 * DAY);
        const before = await reload(t);
        const res = await extend(t, { days: 7 });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('trial');
        expect(closeTo(res.body.data.trialEndDate, new Date(before.subscription.trialEndDate).getTime() + 7 * DAY)).toBe(true);
        expect(new Date(res.body.data.trialStartDate).getTime()).toBe(new Date(before.subscription.trialStartDate).getTime());

        const audit = await AuditLog.findOne({ action: 'restaurant.trial_extended', targetId: t.restaurant._id }).lean();
        expect(audit).toBeTruthy();
        expect(audit.details).toMatchObject({ days: 7 });
        expect(audit.details.from).toBeTruthy();
        expect(audit.details.to).toBeTruthy();

        // Tenant keeps working.
        expect((await ctx.api.as(t.users.admin).get('/orders/live')).status).toBe(200);
    });

    test('locked tenant: access is restored, dates count from today, reminders cleared, lock fields reset', async () => {
        const t = await trialTenant('ext-lock', -10 * DAY, {
            'subscription.trialReminders': [{ type: 't-3', queuedAt: new Date(), sentAt: new Date() }],
            'subscription.trialRemindersSent': [3],
        });
        await runTrialExpirySweep();
        const locked = await reload(t);
        expect(locked.status).toBe('suspended');
        expect(locked.subscription.status).toBe('expired');
        expect((await ctx.api.as(t.users.admin).get('/orders/live')).status).toBe(403);
        expect((await ctx.api.as(t.users.waiter).get('/orders/live')).status).toBe(403);

        const res = await extend(t, { days: 14 });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('trial');
        expect(closeTo(res.body.data.trialEndDate, Date.now() + 14 * DAY)).toBe(true);

        const r = await reload(t);
        expect(r.status).toBe('trial');
        expect(r.subscription.status).toBe('trial');
        expect(r.subscription.trialExpiredAt).toBeFalsy();
        expect(r.suspendedAt).toBeFalsy();
        expect(r.suspendedReason || '').toBe('');
        expect(r.subscription.trialReminders).toEqual([]);
        expect(r.subscription.trialRemindersSent).toEqual([3]);   // legacy markers left alone

        // The tenant cache was invalidated: the very next request is served.
        expect((await ctx.api.as(t.users.admin).get('/orders/live')).status).toBe(200);
        expect((await ctx.api.as(t.users.waiter).get('/orders/live')).status).toBe(200);
        const me = await ctx.api.as(t.users.admin).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant.trialExpired).toBe(false);
    });

    test('backstop-locked trial (past end date, sweeper not yet run) is reopened too', async () => {
        const t = await trialTenant('ext-back', -10 * DAY);
        expect((await ctx.api.as(t.users.admin).get('/orders/live')).status).toBe(403);
        const res = await extend(t, { days: 5 });
        expect(res.status).toBe(200);
        expect(closeTo(res.body.data.trialEndDate, Date.now() + 5 * DAY)).toBe(true);
        expect((await ctx.api.as(t.users.admin).get('/orders/live')).status).toBe(200);
    });

    test('missing trialStartDate is set to now', async () => {
        const t = await trialTenant('ext-nostart', 2 * DAY);
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $unset: { 'subscription.trialStartDate': 1 } });
        const res = await extend(t, { days: 3 });
        expect(res.status).toBe(200);
        expect(closeTo(res.body.data.trialStartDate, Date.now())).toBe(true);
    });

    test('validation: days must be an integer 1..90; unknown id → 404', async () => {
        const t = await trialTenant('ext-val', 2 * DAY);
        for (const body of [{}, { days: 0 }, { days: 91 }, { days: 'seven' }, { days: 2.5 }, { days: -3 }]) {
            const res = await extend(t, body);
            expect(res.status).toBe(400);
        }
        const missing = await SA().post(`/superadmin/restaurants/${new mongoose.Types.ObjectId()}/extend-trial`).send({ days: 7 });
        expect(missing.status).toBe(404);
        expect((await SA().post('/superadmin/restaurants/not-an-id/extend-trial').send({ days: 7 })).status).toBe(400);
    });

    test('a paid tenant has no trial to extend → 400 NOT_ON_TRIAL; support superadmin → 403, no change', async () => {
        const paid = await seedTenant({ label: 'ext-paid' });   // seedTenant = active subscription
        const res = await extend(paid, { days: 7 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_ON_TRIAL');

        const t = await trialTenant('ext-support', 2 * DAY);
        const before = await reload(t);
        const denied = await extend(t, { days: 7 }, ctx.api.as(support));
        expect(denied.status).toBe(403);
        const after = await reload(t);
        expect(new Date(after.subscription.trialEndDate).getTime()).toBe(new Date(before.subscription.trialEndDate).getTime());
        expect(await AuditLog.findOne({ action: 'restaurant.trial_extended', targetId: t.restaurant._id })).toBeNull();
    });
});
