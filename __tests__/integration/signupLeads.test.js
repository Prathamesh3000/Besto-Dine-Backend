/**
 * Signup Leads API (TRIAL_SIGNUP_AND_LEADS_PLAN.md §8) — /superadmin/signup-leads.
 *
 * One self-registered tenant per segment (trial active, trial ended, free
 * plan, paid/converted) plus one admin-created tenant that must never show
 * up. Everything goes through the real app; the DB is the per-file
 * in-memory replica set from the harness (no afterAll touches it).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const User = require(path.join(BACKEND, 'models/user'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));

const ctx = useIntegrationApp();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const days = (n) => new Date(NOW + n * DAY);

let sa;
let support;
const T = {};

const SA = () => ctx.api.as(sa);
const SUP = () => ctx.api.as(support);
const BASE = '/superadmin/signup-leads';

// Raw $set on the tenant document; `timestamps: false` lets us pin createdAt
// so "newest first" is deterministic.
const set = (t, $set) => Restaurant.updateOne({ _id: t.restaurant._id }, { $set }, { timestamps: false });

beforeAll(async () => {
    sa = await createUser({ name: 'Lead Owner SA', email: `sa.full.leads.${Date.now()}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
    support = await createUser({ name: 'Lead Support SA', email: `sa.support.leads.${Date.now()}@platform.test`, role: 'superadmin', superadminLevel: 'support' });

    T.admin = await seedTenant({ label: 'ladmin' });          // admin-created, never a lead
    T.free = await seedTenant({ label: 'lfree' });
    T.trialEnded = await seedTenant({ label: 'lended' });
    T.trialActive = await seedTenant({ label: 'lactive' });
    T.paid = await seedTenant({ label: 'lpaid' });

    // Owners: the seeded admin is the tenant owner; give the paid one a mobile.
    for (const t of [T.free, T.trialEnded, T.trialActive, T.paid]) {
        await set(t, { owner: t.users.admin._id });
    }
    await User.updateOne({ _id: T.paid.users.admin._id }, { $set: { mobile: '9876501234' } });

    await set(T.free, {
        name: 'Free "Quoted" Cafe, Pune',
        city: 'Pune',
        createdAt: days(-4),
        signupSource: 'self', registrationSource: 'self_service',
        status: 'active',
        'subscription.status': 'active', 'subscription.planSlug': 'free', 'subscription.planName': 'Free', 'subscription.price': 0,
    });
    await set(T.trialEnded, {
        createdAt: days(-3),
        signupSource: 'self', registrationSource: 'self_service_trial',
        status: 'suspended',
        'subscription.status': 'expired', 'subscription.planSlug': 'gold', 'subscription.planName': 'Gold', 'subscription.price': 2999,
        'subscription.trialStartDate': days(-19), 'subscription.trialEndDate': days(-5),
        'lead.stage': 'contacted', 'lead.nextFollowUpAt': days(-1), 'lead.lastContactedAt': days(-2),
    });
    await set(T.trialActive, {
        createdAt: days(-2),
        signupSource: 'self', registrationSource: 'self_service_trial',
        status: 'trial',
        'subscription.status': 'trial', 'subscription.planSlug': 'gold', 'subscription.planName': 'Gold', 'subscription.price': 2999,
        'subscription.trialStartDate': days(-3), 'subscription.trialEndDate': days(11),
        'subscription.trialReminders': [
            { type: 't-3', queuedAt: days(-2), sentAt: days(-2) },
            { type: 't-1', queuedAt: days(-1), sentAt: null },
        ],
        'lead.nextFollowUpAt': days(1),
    });
    await set(T.paid, {
        createdAt: days(-1),
        signupSource: 'self', registrationSource: 'self_service_trial',
        status: 'active',
        'subscription.status': 'active', 'subscription.planSlug': 'gold', 'subscription.planName': 'Gold', 'subscription.price': 2999,
        'subscription.trialStartDate': days(-20), 'subscription.trialEndDate': days(-6), 'subscription.lastChargedAt': days(-5),
        'lead.stage': 'interested',                         // must DISPLAY as converted
    });
});

const slugs = (res) => res.body.data.map((l) => l.slug);

describe('GET /superadmin/signup-leads', () => {
    test('lists only self-registered leads, newest first, with segment + counts and no raw lead sub-document', async () => {
        const res = await SA().get(BASE);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(slugs(res)).toEqual([T.paid.slug, T.trialActive.slug, T.trialEnded.slug, T.free.slug]);
        expect(slugs(res)).not.toContain(T.admin.slug);
        expect(res.body.pagination).toEqual({ page: 1, limit: 25, total: 4, pages: 1 });

        const by = Object.fromEntries(res.body.data.map((l) => [l.slug, l]));
        expect(by[T.paid.slug]).toMatchObject({ segment: 'paid', stage: 'converted', subscriptionStatus: 'active', source: 'self_service_trial' });
        expect(by[T.trialActive.slug]).toMatchObject({ segment: 'trial_active', stage: 'new', daysLeft: 11, daysSinceTrialEnd: 0 });
        expect(by[T.trialEnded.slug]).toMatchObject({ segment: 'trial_ended', stage: 'contacted', daysLeft: 0, daysSinceTrialEnd: 5 });
        expect(by[T.free.slug]).toMatchObject({ segment: 'free', stage: 'new', plan: { slug: 'free', isFree: true }, trialEndsAt: null, lockAt: null, daysLeft: null });

        // lockAt = trialEnd + 3 days
        const active = by[T.trialActive.slug];
        expect(new Date(active.lockAt).getTime() - new Date(active.trialEndsAt).getTime()).toBe(3 * DAY);
        // owner contact wins over tenant contact fields
        expect(active.owner).toBe(T.trialActive.users.admin.name);
        expect(active.email).toBe(T.trialActive.users.admin.email);
        // seeded tenants have 3 menu items and 4 staff
        expect(active.menuItemCount).toBe(3);
        expect(active.staffCount).toBe(4);
        // reminders newest first
        expect(active.reminders.map((r) => r.type)).toEqual(['t-1', 't-3']);
        // the stored CRM sub-document is flattened, never exposed raw
        for (const l of res.body.data) expect(l).not.toHaveProperty('lead');
    });

    test('pagination: page/limit honoured, limit capped at 100', async () => {
        const p2 = await SA().get(`${BASE}?limit=2&page=2`);
        expect(p2.status).toBe(200);
        expect(slugs(p2)).toEqual([T.trialEnded.slug, T.free.slug]);
        expect(p2.body.pagination).toEqual({ page: 2, limit: 2, total: 4, pages: 2 });

        const big = await SA().get(`${BASE}?limit=500`);
        expect(big.status).toBe(400);                        // validator: limit must be 1–100
        const max = await SA().get(`${BASE}?limit=100`);
        expect(max.body.pagination.limit).toBe(100);
    });

    test('segment filter', async () => {
        for (const [segment, t] of [['paid', T.paid], ['trial_active', T.trialActive], ['trial_ended', T.trialEnded], ['free', T.free]]) {
            const res = await SA().get(`${BASE}?segment=${segment}`);
            expect(res.status).toBe(200);
            expect(slugs(res)).toEqual([t.slug]);
        }
        expect((await SA().get(`${BASE}?segment=bogus`)).status).toBe(400);
    });

    test('stage filter: paid tenants match "converted" and nothing else, whatever is stored', async () => {
        expect(slugs(await SA().get(`${BASE}?stage=converted`))).toEqual([T.paid.slug]);
        expect(slugs(await SA().get(`${BASE}?stage=interested`))).toEqual([]);
        expect(slugs(await SA().get(`${BASE}?stage=contacted`))).toEqual([T.trialEnded.slug]);
        expect(slugs(await SA().get(`${BASE}?stage=new`))).toEqual([T.trialActive.slug, T.free.slug]);
        expect((await SA().get(`${BASE}?stage=demoed`)).status).toBe(400);
    });

    test('followUp=due returns leads whose next follow-up is in the past', async () => {
        const res = await SA().get(`${BASE}?followUp=due`);
        expect(slugs(res)).toEqual([T.trialEnded.slug]);
    });

    test('search covers name, slug, owner name and owner mobile, case-insensitive, regex-safe', async () => {
        expect(slugs(await SA().get(`${BASE}?search=${encodeURIComponent('cafe, PUNE')}`))).toEqual([T.free.slug]);
        expect(slugs(await SA().get(`${BASE}?search=${T.trialEnded.slug.toUpperCase()}`))).toEqual([T.trialEnded.slug]);
        expect(slugs(await SA().get(`${BASE}?search=${encodeURIComponent(T.paid.users.admin.name)}`))).toEqual([T.paid.slug]);
        expect(slugs(await SA().get(`${BASE}?search=98765`))).toEqual([T.paid.slug]);
        const weird = await SA().get(`${BASE}?search=${encodeURIComponent('a.*(b')}`);
        expect(weird.status).toBe(200);
        expect(weird.body.data).toEqual([]);
    });

    test('support-level superadmin can read; tenant admin cannot', async () => {
        expect((await SUP().get(BASE)).status).toBe(200);
        expect((await ctx.api.as(T.paid.users.admin).get(BASE)).status).toBe(403);
    });
});

describe('GET /superadmin/signup-leads/summary', () => {
    test('counts by segment, follow-ups due and conversion rate', async () => {
        const res = await SA().get(`${BASE}/summary`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            total: 4, free: 1, trialActive: 1, trialEnded: 1, paid: 1, followUpsDue: 1, conversionRate: 25,
        });
    });
});

describe('PATCH /superadmin/signup-leads/:slug', () => {
    test('stage contacted stamps lastContactedAt and writes an audit row', async () => {
        const before = Date.now();
        const res = await SA().patch(`${BASE}/${T.trialActive.slug}`).send({ stage: 'contacted' });
        expect(res.status).toBe(200);
        expect(res.body.data.stage).toBe('contacted');
        expect(new Date(res.body.data.lastContactedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

        const stored = await Restaurant.findById(T.trialActive.restaurant._id).select('+lead').lean();
        expect(stored.lead.stage).toBe('contacted');
        expect(stored.lead.lastContactedAt).toBeInstanceOf(Date);

        const audit = await AuditLog.findOne({ action: 'superadmin.signup_lead_stage', targetId: T.trialActive.restaurant._id }).lean();
        expect(audit).toBeTruthy();
        expect(audit.details).toMatchObject({ from: 'new', to: 'contacted', segment: 'trial_active' });
        expect(audit.actor.toString()).toBe(sa._id.toString());
    });

    test('nextFollowUpAt accepts an ISO date and null; explicit lastContactedAt is kept', async () => {
        const when = days(3).toISOString();
        const r1 = await SA().patch(`${BASE}/${T.free.slug}`).send({ nextFollowUpAt: when, lastContactedAt: days(-7).toISOString(), stage: 'contacted' });
        expect(r1.status).toBe(200);
        expect(new Date(r1.body.data.nextFollowUpAt).toISOString()).toBe(when);
        expect(new Date(r1.body.data.lastContactedAt).toISOString()).toBe(days(-7).toISOString());

        const r2 = await SA().patch(`${BASE}/${T.free.slug}`).send({ nextFollowUpAt: null });
        expect(r2.status).toBe(200);
        expect(r2.body.data.nextFollowUpAt).toBeNull();
        expect(r2.body.data.stage).toBe('contacted');            // untouched

        // follow-ups due now also counts the free tenant once its date is in the past
        await SA().patch(`${BASE}/${T.free.slug}`).send({ nextFollowUpAt: days(-1).toISOString() });
        expect((await SA().get(`${BASE}/summary`)).body.data.followUpsDue).toBe(2);
        await SA().patch(`${BASE}/${T.free.slug}`).send({ nextFollowUpAt: null });
    });

    test('a paid tenant keeps displaying converted after a stage edit', async () => {
        const res = await SA().patch(`${BASE}/${T.paid.slug}`).send({ stage: 'lost' });
        expect(res.status).toBe(200);
        expect(res.body.data.stage).toBe('converted');
        expect(res.body.data.segment).toBe('paid');
    });

    test('validation: bad stage, bad date, empty body', async () => {
        expect((await SA().patch(`${BASE}/${T.free.slug}`).send({ stage: 'demoed' })).status).toBe(400);
        expect((await SA().patch(`${BASE}/${T.free.slug}`).send({ nextFollowUpAt: 'tomorrow-ish' })).status).toBe(400);
        expect((await SA().patch(`${BASE}/${T.free.slug}`).send({})).status).toBe(400);
    });

    test('404 NOT_A_LEAD for an admin-created tenant and for an unknown slug', async () => {
        const r1 = await SA().patch(`${BASE}/${T.admin.slug}`).send({ stage: 'contacted' });
        expect(r1.status).toBe(404);
        expect(r1.body.code).toBe('NOT_A_LEAD');
        const r2 = await SA().patch(`${BASE}/no-such-tenant-xyz`).send({ stage: 'contacted' });
        expect(r2.status).toBe(404);
        expect(r2.body.code).toBe('NOT_A_LEAD');
        const stored = await Restaurant.findById(T.admin.restaurant._id).select('+lead').lean();
        expect(stored.lead.stage).toBe('new');
    });

    test('support-level superadmin is refused', async () => {
        expect((await SUP().patch(`${BASE}/${T.free.slug}`).send({ stage: 'lost' })).status).toBe(403);
    });
});

describe('POST /superadmin/signup-leads/:slug/notes', () => {
    test('appends human notes (newest first) and stamps lastContactedAt', async () => {
        const r1 = await SA().post(`${BASE}/${T.trialEnded.slug}/notes`).send({ text: '  Called, no answer  ' });
        expect(r1.status).toBe(201);
        expect(r1.body.data.notes).toHaveLength(1);
        expect(r1.body.data.notes[0]).toMatchObject({ text: 'Called, no answer', byName: 'Lead Owner SA', kind: 'human' });
        expect(r1.body.data.notes[0].by).toBe(sa._id.toString());

        const r2 = await SA().post(`${BASE}/${T.trialEnded.slug}/notes`).send({ text: 'Spoke to owner, wants annual' });
        expect(r2.status).toBe(201);
        expect(r2.body.data.notes.map((n) => n.text)).toEqual(['Spoke to owner, wants annual', 'Called, no answer']);
        expect(new Date(r2.body.data.lastContactedAt).getTime()).toBeGreaterThan(days(-2).getTime());

        const stored = await Restaurant.findById(T.trialEnded.restaurant._id).select('+lead').lean();
        expect(stored.lead.notes).toHaveLength(2);
        expect(stored.lead.notes[0].text).toBe('Called, no answer');   // stored in insertion order
    });

    test('system notes are not shown in the human note history', async () => {
        await Restaurant.updateOne({ _id: T.trialEnded.restaurant._id }, {
            $push: { 'lead.notes': { text: 'Reminder t-3 sent', kind: 'system', at: new Date() } },
        });
        const res = await SA().get(`${BASE}?search=${T.trialEnded.slug}`);
        expect(res.body.data[0].notes.map((n) => n.kind)).toEqual(['human', 'human']);
    });

    test('validation and NOT_A_LEAD', async () => {
        expect((await SA().post(`${BASE}/${T.free.slug}/notes`).send({ text: '   ' })).status).toBe(400);
        expect((await SA().post(`${BASE}/${T.free.slug}/notes`).send({ text: 'x'.repeat(1001) })).status).toBe(400);
        expect((await SA().post(`${BASE}/${T.free.slug}/notes`).send({})).status).toBe(400);
        const r = await SA().post(`${BASE}/${T.admin.slug}/notes`).send({ text: 'hello' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('NOT_A_LEAD');
        expect((await SUP().post(`${BASE}/${T.free.slug}/notes`).send({ text: 'hello' })).status).toBe(403);
    });
});

describe('GET /superadmin/signup-leads/export.csv', () => {
    const QUOTED_LINE = /^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/;

    test('UTF-8 BOM, header row, every cell quoted, one row per lead, attachment filename', async () => {
        const res = await SA().get(`${BASE}/export.csv`).buffer(true).parse((r, cb) => {
            let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { s += c; }); r.on('end', () => cb(null, s));
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="signup-leads-\d{4}-\d{2}-\d{2}\.csv"$/);

        const text = res.body;
        expect(text.charCodeAt(0)).toBe(0xFEFF);
        const lines = text.slice(1).split('\r\n').filter(Boolean);
        expect(lines).toHaveLength(5);                     // header + 4 leads
        for (const line of lines) expect(line).toMatch(QUOTED_LINE);
        expect(lines[0].startsWith('"name","slug","owner","email","phone"')).toBe(true);
        expect(lines[1]).toContain(`"${T.paid.slug}"`);       // newest first
        expect(lines[4]).toContain('"Free ""Quoted"" Cafe, Pune"');
        expect(text).not.toContain(T.admin.slug);
    });

    test('export respects the same filters', async () => {
        const res = await SA().get(`${BASE}/export.csv?segment=trial_active`).buffer(true).parse((r, cb) => {
            let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { s += c; }); r.on('end', () => cb(null, s));
        });
        const lines = res.body.slice(1).split('\r\n').filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain(`"${T.trialActive.slug}"`);
        expect(lines[1]).toContain('"trial_active"');
    });
});

describe('lead data never reaches a tenant', () => {
    test('GET /auth/me as the tenant owner has no `lead` key anywhere', async () => {
        const res = await ctx.api.as(T.trialEnded.users.admin).get('/auth/me').catch((e) => e.response);
        // the trial-ended tenant is suspended; use an active lead tenant instead if login is refused
        const target = res && res.status === 200 ? res : await ctx.api.as(T.paid.users.admin).get('/auth/me');
        expect(target.status).toBe(200);
        expect(JSON.stringify(target.body)).not.toMatch(/"lead"/);
    });

    test('GET /superadmin/restaurants/:id (generic tenant payload) does not include lead either', async () => {
        const res = await SA().get(`/superadmin/restaurants/${T.paid.restaurant._id}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(/"lead"/);
    });
});
