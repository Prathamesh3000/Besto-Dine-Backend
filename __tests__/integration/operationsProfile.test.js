/**
 * Operations profile, phase (a) — end-to-end over HTTP
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §3.2, §7).
 *
 *   - /auth/me carries the resolved profile (staff), intersected with the plan
 *   - QR scan, restaurant-by-slug and menu bootstrap carry the customer-safe subset
 *   - a tenant with no profile resolves to today's behaviour
 *   - migrations/applyOperationsDefaults: dry run writes nothing, real run is
 *     idempotent and never overwrites a profile the Super Admin set
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const { applyOperationsDefaults } = require(path.join(BACKEND, 'migrations/applyOperationsDefaults'));
const { profileFromPreset, DEFAULT_PROFILE } = require(path.join(BACKEND, 'utils/operationsProfile'));

const ctx = useIntegrationApp();
let T;
let saFull;
let saSupport;

beforeAll(async () => {
    T = await seedTenant({ label: 'ops' });
    saFull = await createUser({ name: 'Root', email: 'root.ops@platform.test', role: 'superadmin', superadminLevel: 'full' });
    saSupport = await createUser({ name: 'Support', email: 'support.ops@platform.test', role: 'superadmin', superadminLevel: 'support' });
});

const setOps = (ops) => Restaurant.updateOne({ _id: T.restaurant._id }, ops
    ? { $set: { operations: ops } }
    : { $unset: { operations: 1 } });

afterEach(async () => {
    await setOps(null);
    await Restaurant.updateOne({ _id: T.restaurant._id }, {
        $set: { 'subscription.features.waiterDashboard': true, featureOverrides: {} },
    });
});

describe('staff snapshot — /auth/me', () => {
    test('no profile → today\'s behaviour', async () => {
        const res = await ctx.api.as(T.users.admin, T).get('/auth/me');
        expect(res.status).toBe(200);
        const ops = res.body.user.tenant.operations;
        expect(ops.preset).toBe('fullService');
        expect(ops.payment.dineIn).toBe('payAfter');
        expect(ops.orderFlow.servedStep).toBe(true);
        expect(ops.customerApp.callWaiter).toBe(true);
    });

    test('hotel preset → no waiter / captain / chef, pay first, no tracking', async () => {
        await setOps(profileFromPreset('hotelPayFirstSelfOrder'));
        const ops = (await ctx.api.as(T.users.admin, T).get('/auth/me')).body.user.tenant.operations;
        expect(ops.roles).toEqual({ waiter: false, captain: false, chef: false });
        expect(ops.payment.dineIn).toBe('payFirst');
        expect(ops.orderFlow.customerTracking).toBe(false);
        expect(ops.customerApp.callWaiter).toBe(false);
    });

    test('plan intersection: waiter app not in plan → waiter role off even with the default profile', async () => {
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { 'subscription.features.waiterDashboard': false } });
        const ops = (await ctx.api.as(T.users.admin, T).get('/auth/me')).body.user.tenant.operations;
        expect(ops.roles.waiter).toBe(false);
        expect(ops.roles.captain).toBe(false);
        expect(ops.orderFlow.servedStep).toBe(true);          // behaviour unchanged
        expect(ops.planBlocks.map(b => b.module)).toEqual(expect.arrayContaining(['waiter', 'captain']));
    });
});

describe('customer snapshots', () => {
    test('QR scan carries the customer-safe subset', async () => {
        await setOps(profileFromPreset('hotelPayFirstSelfOrder'));
        const { res } = await scanTable(ctx.api, T.tables.main);
        expect(res.status).toBe(200);
        const ops = res.body.restaurant.operations;
        expect(ops.payment.dineIn).toBe('payFirst');
        expect(ops.customerApp.callWaiter).toBe(false);
        expect(ops).not.toHaveProperty('roles');
        expect(ops).not.toHaveProperty('planBlocks');
    });

    test('restaurant-by-slug and menu bootstrap carry the same subset', async () => {
        await setOps(profileFromPreset('cafeCounterPayFirst'));
        const slug = T.slug;
        const bySlug = await ctx.api.anon().get(`/public/restaurants/${slug}`);
        expect(bySlug.status).toBe(200);
        expect(bySlug.body.data.operations.orderFlow.customerTracking).toBe(true);
        expect(bySlug.body.data.operations.payment.dineIn).toBe('payFirst');

        const boot = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${slug}`);
        expect(boot.status).toBe(200);
        expect(boot.body.data.restaurant.operations).toEqual(bySlug.body.data.operations);
    });

    test('no profile → customers see today\'s flow', async () => {
        const boot = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}`);
        expect(boot.body.data.restaurant.operations.payment.dineIn).toBe('payAfter');
        expect(boot.body.data.restaurant.operations.customerApp.requestBill).toBe(true);
    });
});

describe('migrations/applyOperationsDefaults', () => {
    const silent = () => {};

    test('dry run writes nothing; real run writes the default only where missing; re-run is a no-op', async () => {
        const other = await seedTenant({ label: 'ops2' });
        const custom = profileFromPreset('hotelPayFirstSelfOrder');
        await Restaurant.updateOne({ _id: other.restaurant._id }, { $set: { operations: custom } });

        const dry = await applyOperationsDefaults({ Restaurant }, { dryRun: true, log: silent });
        expect(dry.written).toBeGreaterThanOrEqual(1);
        expect((await Restaurant.findById(T.restaurant._id).lean()).operations).toBeUndefined();

        const real = await applyOperationsDefaults({ Restaurant }, { log: silent });
        expect(real.written).toBe(dry.written);
        const t = (await Restaurant.findById(T.restaurant._id).lean()).operations;
        expect(t).toMatchObject({ preset: DEFAULT_PROFILE.preset, modules: DEFAULT_PROFILE.modules });

        // the Super Admin's profile is never overwritten
        const o = (await Restaurant.findById(other.restaurant._id).lean()).operations;
        expect(o.preset).toBe('hotelPayFirstSelfOrder');
        expect(o.modules.waiter).toBe(false);

        const again = await applyOperationsDefaults({ Restaurant }, { log: silent });
        expect(again.written).toBe(0);
        expect(again.alreadySet).toBe(again.scanned);
    });

    test('a migrated default profile still resolves to today\'s behaviour', async () => {
        await applyOperationsDefaults({ Restaurant }, { log: silent });
        const ops = (await ctx.api.as(T.users.admin, T).get('/auth/me')).body.user.tenant.operations;
        expect(ops.payment.dineIn).toBe('payAfter');
        expect(ops.roles).toEqual({ waiter: true, captain: true, chef: true });
    });
});

describe('Super Admin API — /superadmin/restaurants/:id/operations', () => {
    const base = () => `/superadmin/restaurants/${T.restaurant._id}/operations`;
    const hotel = () => profileFromPreset('hotelPayFirstSelfOrder');

    test('presets catalogue lists modules, presets, questions and advanced paths', async () => {
        const res = await ctx.api.as(saSupport).get('/superadmin/operations/presets');
        expect(res.status).toBe(200);
        expect(res.body.data.modules.map(m => m.key)).toEqual(['qrOrdering', 'waiter', 'captain', 'chef', 'customerPayment']);
        expect(res.body.data.presets.map(p => p.key)).toEqual(expect.arrayContaining(['fullService', 'hotelPayFirstSelfOrder']));
        expect(res.body.data.questions.length).toBeGreaterThan(0);
        expect(res.body.data.advancedPaths).toHaveProperty(['customerApp.tips']);
    });

    test('GET: support super admin can read; an unset profile is reported as default', async () => {
        const res = await ctx.api.as(saSupport).get(base());
        expect(res.status).toBe(200);
        expect(res.body.data.isDefault).toBe(true);
        expect(res.body.data.profile.preset).toBe('fullService');
        expect(res.body.data.resolved.payment.dineIn).toBe('payAfter');
    });

    test('tenant admin and support super admin cannot preview or save', async () => {
        expect((await ctx.api.as(saSupport).put(base()).send({ operations: hotel() })).status).toBe(403);
        expect((await ctx.api.as(saSupport).post(`${base()}/preview`).send({ operations: hotel() })).status).toBe(403);
        expect((await ctx.api.as(T.users.admin, T).get(base())).status).toBe(403);
    });

    test('preview reports impact and staff counts but writes nothing', async () => {
        const res = await ctx.api.as(saFull).post(`${base()}/preview`).send({ operations: hotel() });
        expect(res.status).toBe(200);
        expect(res.body.data.errors).toEqual([]);
        expect(res.body.data.resolved.roles).toEqual({ waiter: false, captain: false, chef: false });
        const msgs = res.body.data.impact.map(i => i.message).join(' | ');
        expect(msgs).toMatch(/Waiter app switched off/);
        expect(msgs).toMatch(/active waiter account/);
        expect((await Restaurant.findById(T.restaurant._id).lean()).operations).toBeUndefined();
    });

    test('bad input → 400 INVALID_OPERATIONS with every error listed', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: { modules: { cashier: true }, preset: 'nope' } });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_OPERATIONS');
        expect(res.body.errors).toEqual(expect.arrayContaining(['unknown module "cashier"']));
        expect((await ctx.api.as(saFull).put(base()).send({})).status).toBe(400);
    });

    test('a profile that leaves no way to pay is rejected on save', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: {
            modules: { waiter: false, captain: false, customerPayment: false }, answers: { counterCash: false },
        } });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/no way to pay first/);
    });

    test('save stores the profile, stamps who/when, audits before/after, and /auth/me follows', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: { ...hotel(), updatedBy: 'spoofed' } });
        expect(res.status).toBe(200);
        expect(res.body.data.isDefault).toBe(false);
        expect(res.body.data.resolved.payment.dineIn).toBe('payFirst');

        const stored = (await Restaurant.findById(T.restaurant._id).lean()).operations;
        expect(stored.preset).toBe('hotelPayFirstSelfOrder');
        expect(String(stored.updatedBy)).toBe(String(saFull._id));
        expect(stored.updatedAt).toBeTruthy();

        const audit = await AuditLog.findOne({ action: 'restaurant.operations.update', targetId: T.restaurant._id }).lean();
        expect(audit).toBeTruthy();
        expect(audit.details.after.preset).toBe('hotelPayFirstSelfOrder');
        expect(audit.details.before).toBeNull();

        const me = await ctx.api.as(T.users.admin, T).get('/auth/me');
        expect(me.body.user.tenant.operations.roles.waiter).toBe(false);
    });

    test('tenant admin reads its own profile read-only via /settings/operations', async () => {
        await setOps(hotel());
        const res = await ctx.api.as(T.users.admin, T).get('/settings/operations');
        expect(res.status).toBe(200);
        expect(res.body.data.isDefault).toBe(false);
        expect(res.body.data.resolved.payment.dineIn).toBe('payFirst');
        expect((await ctx.api.as(T.users.waiter, T).get('/settings/operations')).status).toBe(403);
    });
});

// ── Ops-panel review fixes: A10 (migration null), A11 (409 + live refresh), B12, B17 ──
describe('review fixes — Super Admin save concurrency (A11)', () => {
    const base = () => `/superadmin/restaurants/${T.restaurant._id}/operations`;
    const hotel = () => profileFromPreset('hotelPayFirstSelfOrder');
    const cafe = () => profileFromPreset('cafeCounterPayFirst');

    test('no expectedUpdatedAt (older client) → saves as before', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: hotel() });
        expect(res.status).toBe(200);
    });

    test('expectedUpdatedAt null on an unset profile → saves; the response carries the new updatedAt', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: null });
        expect(res.status).toBe(200);
        expect(res.body.data.profile.updatedAt).toBeTruthy();
        expect(res.body.data.updatedAt).toBe(new Date(res.body.data.profile.updatedAt).toISOString());
    });

    test('stale expectedUpdatedAt → 409 OPERATIONS_STALE with the current profile; nothing written', async () => {
        const first = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: null });
        expect(first.status).toBe(200);
        const loadedAt = first.body.data.updatedAt;

        // somebody else saves in between
        const other = await ctx.api.as(saFull).put(base()).send({ operations: cafe(), expectedUpdatedAt: loadedAt });
        expect(other.status).toBe(200);
        expect(other.body.data.updatedAt).not.toBe(loadedAt);

        // our save, based on the first load → stale
        const stale = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: loadedAt });
        expect(stale.status).toBe(409);
        expect(stale.body.success).toBe(false);
        expect(stale.body.code).toBe('OPERATIONS_STALE');
        expect(stale.body.data.profile.preset).toBe('cafeCounterPayFirst');
        expect(stale.body.data.updatedAt).toBe(other.body.data.updatedAt);
        expect(stale.body.data.resolved.roles.chef).toBe(true);
        expect((await Restaurant.findById(T.restaurant._id).lean()).operations.preset).toBe('cafeCounterPayFirst');

        // null ("I loaded no profile") is also stale once a profile exists
        const nul = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: null });
        expect(nul.status).toBe(409);

        // retry with the current stamp succeeds
        const retry = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: other.body.data.updatedAt });
        expect(retry.status).toBe(200);
        expect(retry.body.data.profile.preset).toBe('hotelPayFirstSelfOrder');
    });

    test('garbage expectedUpdatedAt → 400', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: hotel(), expectedUpdatedAt: 'yesterday-ish' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_OPERATIONS');
    });

    test('a save tells every staff role in every branch room (tenant:operations-updated)', async () => {
        const { io: connectClient } = require('socket.io-client');
        const Branch = require(path.join(BACKEND, 'models/branch'));
        const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
        const B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'Annex', slug: `annex-${Date.now()}`, isActive: true });
        const captainB2 = await createUser({
            name: 'cap b2', email: `cap.b2.${Date.now()}@staff.test`, role: 'captain',
            restaurant: T.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('captain'),
        });
        const connect = (token) => new Promise((resolve, reject) => {
            const s = connectClient(ctx.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
            const events = [];
            s.onAny((event, payload) => events.push({ event, payload }));
            s.on('connect', () => resolve({ s, events }));
            s.on('connect_error', reject);
        });
        const listeners = await Promise.all([
            connect(T.users.admin.token), connect(T.users.chef.token), connect(T.users.waiter.token),
            connect(T.users.captain.token), connect(captainB2.token),
        ]);
        try {
            const res = await ctx.api.as(saFull).put(base()).send({ operations: profileFromPreset('fullService') });
            expect(res.status).toBe(200);
            const got = (events) => new Promise((resolve, reject) => {
                const t0 = Date.now();
                const tick = () => {
                    const hit = events.find((e) => e.event === 'tenant:operations-updated');
                    if (hit) return resolve(hit);
                    if (Date.now() - t0 > 4000) return reject(new Error(`not received; got ${events.map((e) => e.event)}`));
                    return setTimeout(tick, 25);
                };
                tick();
            });
            for (const { events } of listeners) {
                const hit = await got(events);
                expect(hit.payload).toMatchObject({ restaurant: String(T.restaurant._id), preset: 'fullService' });
                expect(hit.payload.updatedAt).toBeTruthy();
            }
        } finally {
            for (const { s } of listeners) s.close();
        }
    });
});

describe('review fixes — migration, useTables guard, printer question (A10, B12, B17)', () => {
    const base = () => `/superadmin/restaurants/${T.restaurant._id}/operations`;
    const silent = () => {};

    test('A10: a restaurant stored with operations: null gets the default and is counted as written', async () => {
        const N = await seedTenant({ label: 'opsnull' });
        await Restaurant.updateOne({ _id: N.restaurant._id }, { $set: { operations: null } });
        expect((await Restaurant.findById(N.restaurant._id).lean()).operations).toBeNull();

        const dry = await applyOperationsDefaults({ Restaurant }, { dryRun: true, log: silent });
        expect((await Restaurant.findById(N.restaurant._id).lean()).operations).toBeNull();

        const real = await applyOperationsDefaults({ Restaurant }, { log: silent });
        expect(real.written).toBe(dry.written);
        expect(real.raced).toBe(0);
        const n = (await Restaurant.findById(N.restaurant._id).lean()).operations;
        expect(n).toMatchObject({ preset: DEFAULT_PROFILE.preset, modules: DEFAULT_PROFILE.modules });

        const again = await applyOperationsDefaults({ Restaurant }, { log: silent });
        expect(again.written).toBe(0);
    });

    test('B12: useTables:false saves with tables kept on and a warning in preview AND save', async () => {
        const body = { operations: { modules: { waiter: false, captain: false }, answers: { counterCash: true, useTables: false } } };
        const prev = await ctx.api.as(saFull).post(`${base()}/preview`).send(body);
        expect(prev.status).toBe(200);
        expect(prev.body.data.errors).toEqual([]);
        expect(prev.body.data.warnings.join(' | ')).toMatch(/tables\.useTables: token-number mode is not available yet/);
        expect(prev.body.data.profile.answers.useTables).toBe(true);

        const save = await ctx.api.as(saFull).put(base()).send(body);
        expect(save.status).toBe(200);
        expect(save.body.data.warnings.join(' | ')).toMatch(/token-number mode is not available yet/);
        const stored = (await Restaurant.findById(T.restaurant._id).lean()).operations;
        expect(stored.answers.useTables).toBe(true);
        expect(save.body.data.resolved.tables.useTables).toBe(true);
    });

    test('B16: QR ordering off + staff ordering off is rejected on save', async () => {
        const res = await ctx.api.as(saFull).put(base()).send({ operations: {
            modules: { qrOrdering: false }, advanced: { 'orderFlow.staffOrder': false },
        } });
        expect(res.status).toBe(400);
        expect(res.body.errors.join(' ')).toMatch(/orderFlow\.staffOrder/);
    });

    test('B17: the presets catalogue carries the printer question; the answer is stored and resolved, nothing else changes', async () => {
        const cat = await ctx.api.as(saSupport).get('/superadmin/operations/presets');
        const q = cat.body.data.questions.find((x) => x.key === 'kotPrinter');
        expect(q).toBeTruthy();
        expect(q.informational).toBe(true);
        expect(q.options.map((o) => o.value)).toEqual([null, 'kitchen', 'counter', 'none']);
        expect(cat.body.data.questions.map((x) => x.key)).toEqual(['dineInPayment', 'counterCash', 'kotPrinter', 'useTables']);
        const useTables = cat.body.data.questions.find((x) => x.key === 'useTables');
        expect(useTables.options.find((o) => o.value === false).disabled).toBe(true);

        const res = await ctx.api.as(saFull).put(base()).send({ operations: { answers: { kotPrinter: 'none' } } });
        expect(res.status).toBe(200);
        expect(res.body.data.resolved.printing).toEqual({ kotAt: 'none' });
        expect(res.body.data.resolved.payment.dineIn).toBe('payAfter');
        expect(res.body.data.resolved.roles).toEqual({ waiter: true, captain: true, chef: true });
        const me = await ctx.api.as(T.users.admin, T).get('/auth/me');
        expect(me.body.user.tenant.operations.printing.kotAt).toBe('none');

        // default: kitchen with the chef module, counter without
        const d = await ctx.api.as(saFull).post(`${base()}/preview`).send({ operations: profileFromPreset('hotelPayFirstSelfOrder') });
        expect(d.body.data.resolved.printing.kotAt).toBe('counter');
    });
});
