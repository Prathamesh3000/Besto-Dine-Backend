/**
 * Operations profile — per-branch overrides over HTTP
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.1).
 *
 *   - GET  /superadmin/restaurants/:id/operations lists every ACTIVE branch
 *     with its override (or null) and what it resolves to
 *   - PUT / DELETE …/operations/branches/:branchId: normalise + validate the
 *     MERGED profile, audit with branchId, 409 OPERATIONS_STALE, 404 for a
 *     foreign / inactive branch, superAdminFull only
 *   - preview accepts branchId and writes nothing
 *   - tenant:operations-updated carries branchId
 *   - /auth/me: a waiter pinned to branch B sees B's override, Main staff
 *     and the unpinned admin see the tenant profile; admin ?branch=B / X-Branch-Id sees B
 *   - QR scan and menu bootstrap resolve for the table's / picked branch
 *   - no override anywhere → exactly today's payloads
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
const { profileFromPreset } = require(path.join(BACKEND, 'utils/operationsProfile'));

const ctx = useIntegrationApp();
let T;        // tenant with Main (T.branch) + Annex (B)
let B;        // second active branch
let INACTIVE; // deactivated branch of T
let tableB;   // a table at B
let waiterB;  // waiter pinned to B
let OTHER;    // another tenant
let saFull;
let saSupport;

const base = () => `/superadmin/restaurants/${T.restaurant._id}/operations`;
const branchUrl = (b) => `${base()}/branches/${b._id || b}`;
const SA = () => ctx.api.as(saFull);

// Branch B runs pay-first with cash at the counter, nobody at the table.
const PAY_FIRST = { modules: { waiter: false, captain: false }, answers: { counterCash: true } };
// Keeps the waiter role so a waiter's /auth/me is unaffected by role gates.
const PAY_FIRST_WITH_WAITERS = { answers: { dineInPayment: 'payFirst', counterCash: true } };

const reload = () => Restaurant.findById(T.restaurant._id).lean();
const auditFor = (action) => AuditLog.findOne({ action, targetId: T.restaurant._id }).sort({ createdAt: -1 }).lean();

beforeAll(async () => {
    T = await seedTenant({ label: 'opsb' });
    B = await Branch.create({ restaurant: T.restaurant._id, name: 'Annex', slug: 'annex', isActive: true });
    INACTIVE = await Branch.create({ restaurant: T.restaurant._id, name: 'Closed', slug: 'closed', isActive: false });
    tableB = await createTable(T, { name: 'Annex-1', branch: B._id });
    waiterB = await createUser({
        name: 'waiter annex', email: 'waiter.annex@staff.test', role: 'waiter',
        restaurant: T.restaurant._id, branch: B._id, permissions: defaultPermissionsForRole('waiter'),
    });
    OTHER = await seedTenant({ label: 'opsb2' });
    saFull = await createUser({ name: 'Root', email: 'root.opsb@platform.test', role: 'superadmin', superadminLevel: 'full' });
    saSupport = await createUser({ name: 'Support', email: 'support.opsb@platform.test', role: 'superadmin', superadminLevel: 'support' });
});

afterEach(async () => {
    await Restaurant.updateOne({ _id: T.restaurant._id }, { $unset: { operations: 1 }, $set: { operationsByBranch: [] } });
});

describe('GET — branches block', () => {
    test('every ACTIVE branch is listed with overrides null and the tenant resolution; inactive branches are not', async () => {
        const res = await ctx.api.as(saSupport).get(base());
        expect(res.status).toBe(200);
        const ids = res.body.data.branches.map((b) => b.branch._id);
        expect(ids).toEqual(expect.arrayContaining([String(T.branch._id), String(B._id)]));
        expect(ids).not.toContain(String(INACTIVE._id));
        expect(ids).not.toContain(String(OTHER.branch._id));
        for (const b of res.body.data.branches) {
            expect(b.branch).toEqual({ _id: b.branch._id, name: expect.any(String), isActive: true });
            expect(b.overrides).toBeNull();
            expect(b.hasOverride).toBe(false);
            expect(b.updatedAt).toBeNull();
            expect(b.resolved).toEqual(res.body.data.resolved);
            expect(b.validation).toEqual({ errors: [], warnings: [] });
        }
    });

    test('with an override on B: B resolves differently, Main and the tenant do not', async () => {
        await Restaurant.updateOne({ _id: T.restaurant._id }, {
            $set: { operations: profileFromPreset('fullService'), operationsByBranch: [{ branch: B._id, overrides: PAY_FIRST, updatedAt: new Date() }] },
        });
        const res = await SA().get(base());
        const main = res.body.data.branches.find((b) => b.branch._id === String(T.branch._id));
        const annex = res.body.data.branches.find((b) => b.branch._id === String(B._id));
        expect(res.body.data.resolved.payment.dineIn).toBe('payAfter');
        expect(main.resolved.payment.dineIn).toBe('payAfter');
        expect(main.overrides).toBeNull();
        expect(annex.overrides).toEqual(PAY_FIRST);
        expect(annex.hasOverride).toBe(true);
        expect(annex.updatedAt).toBeTruthy();
        expect(annex.resolved.payment.dineIn).toBe('payFirst');
        expect(annex.resolved.roles).toEqual({ waiter: false, captain: false, chef: true });
        expect(annex.validation.errors).toEqual([]);
    });
});

describe('PUT / DELETE …/operations/branches/:branchId', () => {
    test('PUT stores the sparse override (unknown keys dropped), resolves the branch, keeps the tenant, audits with branchId', async () => {
        const res = await SA().put(branchUrl(B)).send({ overrides: { ...PAY_FIRST, junk: { a: 1 }, modules: { ...PAY_FIRST.modules, cashier: true } } });
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.branchId).toBe(String(B._id));
        expect(d.branch.branch._id).toBe(String(B._id));
        expect(d.branch.overrides).toEqual(PAY_FIRST);
        expect(d.branch.hasOverride).toBe(true);
        expect(d.branch.updatedAt).toBeTruthy();
        expect(d.branch.resolved.payment.dineIn).toBe('payFirst');
        expect(d.branch.resolved.payment.holdUntilPaid).toBe(true);
        expect(d.resolved.payment.dineIn).toBe('payAfter');                 // tenant unchanged
        expect(d.isDefault).toBe(true);                                      // tenant profile still unset
        expect(Array.isArray(d.warnings)).toBe(true);
        expect(d.impact.map((i) => i.message).join(' | ')).toMatch(/Dine-in: pay after the meal → pay first/);
        expect(d.branches.find((b) => b.branch._id === String(B._id)).overrides).toEqual(PAY_FIRST);

        const stored = await reload();
        expect(stored.operations).toBeUndefined();
        expect(stored.operationsByBranch).toHaveLength(1);
        expect(String(stored.operationsByBranch[0].branch)).toBe(String(B._id));
        expect(stored.operationsByBranch[0].overrides).toEqual(PAY_FIRST);
        expect(stored.operationsByBranch[0].updatedAt).toBeTruthy();

        const audit = await auditFor('restaurant.operations.branch.update');
        expect(audit).toBeTruthy();
        expect(audit.details.branchId).toBe(String(B._id));
        expect(audit.details.branchName).toBe('Annex');
        expect(audit.details.before).toBeNull();
        expect(audit.details.after).toEqual(PAY_FIRST);
        expect(audit.details.merged.modules.waiter).toBe(false);

        // a second PUT replaces (not appends) and records the previous override
        const again = await SA().put(branchUrl(B)).send({ overrides: { modules: { chef: false } } });
        expect(again.status).toBe(200);
        expect(again.body.data.branch.overrides).toEqual({ modules: { chef: false } });
        expect((await reload()).operationsByBranch).toHaveLength(1);
        expect((await auditFor('restaurant.operations.branch.update')).details.before).toEqual(PAY_FIRST);
    });

    test('the MERGED profile is validated: 400 INVALID_OPERATIONS on errors, bad types and empty overrides', async () => {
        const noPay = await SA().put(branchUrl(B)).send({ overrides: { modules: { waiter: false, captain: false, customerPayment: false }, answers: { counterCash: false } } });
        expect(noPay.status).toBe(400);
        expect(noPay.body.code).toBe('INVALID_OPERATIONS');
        expect(noPay.body.message).toMatch(/no way to pay first/);

        const badType = await SA().put(branchUrl(B)).send({ overrides: { modules: { waiter: 'yes' } } });
        expect(badType.status).toBe(400);
        expect(badType.body.errors).toEqual(expect.arrayContaining(['modules.waiter must be true or false']));

        expect((await SA().put(branchUrl(B)).send({ overrides: { junk: 1 } })).status).toBe(400);
        expect((await SA().put(branchUrl(B)).send({})).status).toBe(400);
        expect((await SA().put(branchUrl(B)).send({ overrides: 'x' })).status).toBe(400);

        // the tenant profile takes part in the merge: tenant says no customer payment,
        // branch turns floor staff off without counter cash → nothing left to pay with
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { operations: { modules: { customerPayment: false } } } });
        const merged = await SA().put(branchUrl(B)).send({ overrides: { modules: { waiter: false, captain: false }, answers: { counterCash: false } } });
        expect(merged.status).toBe(400);
        expect((await reload()).operationsByBranch).toEqual([]);
    });

    test('expectedUpdatedAt: null saves a first override; a stale stamp → 409 OPERATIONS_STALE with the GET payload; retry with the stamp works', async () => {
        const first = await SA().put(branchUrl(B)).send({ overrides: PAY_FIRST, expectedUpdatedAt: null });
        expect(first.status).toBe(200);
        const stamp = first.body.data.branch.updatedAt;
        expect(stamp).toBeTruthy();

        const stale = await SA().put(branchUrl(B)).send({ overrides: { modules: { chef: false } }, expectedUpdatedAt: null });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('OPERATIONS_STALE');
        expect(stale.body.data.branchId).toBe(String(B._id));
        expect(stale.body.data.branch.overrides).toEqual(PAY_FIRST);
        expect(stale.body.data.branch.updatedAt).toBe(stamp);
        expect(Array.isArray(stale.body.data.branches)).toBe(true);
        expect(stale.body.data.profile).toBeTruthy();
        expect((await reload()).operationsByBranch[0].overrides).toEqual(PAY_FIRST);

        const wrong = await SA().put(branchUrl(B)).send({ overrides: { modules: { chef: false } }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
        expect(wrong.status).toBe(409);

        const garbage = await SA().put(branchUrl(B)).send({ overrides: { modules: { chef: false } }, expectedUpdatedAt: 'yesterday-ish' });
        expect(garbage.status).toBe(400);

        const retry = await SA().put(branchUrl(B)).send({ overrides: { modules: { chef: false } }, expectedUpdatedAt: stamp });
        expect(retry.status).toBe(200);
        expect(retry.body.data.branch.overrides).toEqual({ modules: { chef: false } });
        expect(retry.body.data.branch.updatedAt).not.toBe(stamp);

        // the tenant stamp is independent of the branch stamp
        expect(retry.body.data.updatedAt).toBeNull();
    });

    test('404 for another tenant\'s branch and for an inactive branch; 400 for garbage; 403 for support / tenant admin', async () => {
        const foreign = await SA().put(branchUrl(OTHER.branch)).send({ overrides: PAY_FIRST });
        expect(foreign.status).toBe(404);
        expect(foreign.body.code).toBe('BRANCH_NOT_FOUND');
        expect((await SA().put(branchUrl(INACTIVE)).send({ overrides: PAY_FIRST })).status).toBe(404);
        expect((await SA().delete(branchUrl(OTHER.branch))).status).toBe(404);
        expect((await SA().put(`${base()}/branches/not-an-id`).send({ overrides: PAY_FIRST })).status).toBe(400);

        expect((await ctx.api.as(saSupport).put(branchUrl(B)).send({ overrides: PAY_FIRST })).status).toBe(403);
        expect((await ctx.api.as(saSupport).delete(branchUrl(B))).status).toBe(403);
        expect((await ctx.api.as(T.users.admin, T).put(branchUrl(B)).send({ overrides: PAY_FIRST })).status).toBe(403);
        expect((await reload()).operationsByBranch).toEqual([]);
        expect((await Restaurant.findById(OTHER.restaurant._id).lean()).operationsByBranch).toEqual([]);
    });

    test('DELETE removes the override, audits with branchId, 404 when there is none', async () => {
        expect((await SA().delete(branchUrl(B))).status).toBe(404);
        expect((await SA().delete(branchUrl(B))).body.code).toBe('OVERRIDE_NOT_FOUND');

        await SA().put(branchUrl(B)).send({ overrides: PAY_FIRST });
        await SA().put(branchUrl(T.branch)).send({ overrides: { modules: { chef: false } } });
        expect((await reload()).operationsByBranch).toHaveLength(2);

        const res = await SA().delete(branchUrl(B));
        expect(res.status).toBe(200);
        expect(res.body.data.branchId).toBe(String(B._id));
        expect(res.body.data.branch.overrides).toBeNull();
        expect(res.body.data.branch.hasOverride).toBe(false);
        expect(res.body.data.branch.resolved.payment.dineIn).toBe('payAfter');
        expect(res.body.data.impact.map((i) => i.message).join(' | ')).toMatch(/pay first → pay after the meal/);

        const stored = await reload();
        expect(stored.operationsByBranch).toHaveLength(1);
        expect(String(stored.operationsByBranch[0].branch)).toBe(String(T.branch._id));   // the other branch kept

        const audit = await auditFor('restaurant.operations.branch.delete');
        expect(audit.details.branchId).toBe(String(B._id));
        expect(audit.details.before).toEqual(PAY_FIRST);
        expect(audit.details.after).toBeNull();
    });

    test('preview with branchId reports the branch impact and writes nothing', async () => {
        const res = await SA().post(`${base()}/preview`).send({ branchId: String(B._id), overrides: PAY_FIRST });
        expect(res.status).toBe(200);
        expect(res.body.data.branchId).toBe(String(B._id));
        expect(res.body.data.overrides).toEqual(PAY_FIRST);
        expect(res.body.data.errors).toEqual([]);
        expect(res.body.data.resolved.payment.dineIn).toBe('payFirst');
        expect(res.body.data.resolved.roles.waiter).toBe(false);
        const msgs = res.body.data.impact.map((i) => i.message).join(' | ');
        expect(msgs).toMatch(/Waiter app switched off/);
        expect(msgs).toMatch(/1 active waiter account/);          // only the Annex waiter, not Main's
        expect((await reload()).operationsByBranch).toEqual([]);

        expect((await SA().post(`${base()}/preview`).send({ branchId: String(OTHER.branch._id), overrides: PAY_FIRST })).status).toBe(404);
        // tenant preview is unchanged
        const tenantPrev = await SA().post(`${base()}/preview`).send({ operations: profileFromPreset('hotelPayFirstSelfOrder') });
        expect(tenantPrev.status).toBe(200);
        expect(tenantPrev.body.data.branchId).toBeUndefined();
    });

    test('a branch save tells the staff rooms with branchId in the payload', async () => {
        const { io: connectClient } = require('socket.io-client');
        const connect = (token) => new Promise((resolve, reject) => {
            const s = connectClient(ctx.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
            const events = [];
            s.onAny((event, payload) => events.push({ event, payload }));
            s.on('connect', () => resolve({ s, events }));
            s.on('connect_error', reject);
        });
        const listeners = await Promise.all([connect(T.users.admin.token), connect(waiterB.token)]);
        try {
            const res = await SA().put(branchUrl(B)).send({ overrides: PAY_FIRST_WITH_WAITERS });
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
                expect(hit.payload).toMatchObject({ restaurant: String(T.restaurant._id), branchId: String(B._id) });
                expect(hit.payload.updatedAt).toBeTruthy();
            }
        } finally {
            for (const { s } of listeners) s.close();
        }
    });
});

describe('/auth/me, /settings/operations and customer payloads resolve for the caller\'s branch', () => {
    const setOverride = (branch, overrides) => Restaurant.updateOne({ _id: T.restaurant._id }, {
        $set: { operationsByBranch: [{ branch: branch._id, overrides, updatedAt: new Date() }] },
    });

    test('no override anywhere → every caller and payload sees today\'s flow (and no operationsBranch surprises)', async () => {
        for (const u of [T.users.admin, T.users.waiter, waiterB]) {
            const me = await ctx.api.as(u, T).get('/auth/me');
            expect(me.status).toBe(200);
            expect(me.body.user.tenant.operations.payment.dineIn).toBe('payAfter');
            expect(me.body.user.tenant.operations.roles).toEqual({ waiter: true, captain: true, chef: true });
        }
        expect((await ctx.api.as(T.users.admin, T).get('/auth/me')).body.user.tenant.operationsBranch).toBeNull();
        expect((await ctx.api.as(waiterB, T).get('/auth/me')).body.user.tenant.operationsBranch).toBe(String(B._id));
        const { res } = await scanTable(ctx.api, tableB);
        expect(res.status).toBe(200);
        expect(res.body.restaurant.operations.payment.dineIn).toBe('payAfter');
        const boot = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&branch=${B._id}`);
        expect(boot.body.data.restaurant.operations.payment.dineIn).toBe('payAfter');
    });

    test('waiter pinned to B sees B\'s override; Main waiter, Main captain and the unpinned admin see the tenant default', async () => {
        await setOverride(B, PAY_FIRST_WITH_WAITERS);
        const meB = await ctx.api.as(waiterB, T).get('/auth/me');
        expect(meB.status).toBe(200);
        expect(meB.body.user.tenant.operations.payment.dineIn).toBe('payFirst');
        expect(meB.body.user.tenant.operations.customerApp.requestBill).toBe(false);
        expect(meB.body.user.tenant.operationsBranch).toBe(String(B._id));

        for (const u of [T.users.waiter, T.users.captain]) {
            const me = await ctx.api.as(u, T).get('/auth/me');
            expect(me.body.user.tenant.operations.payment.dineIn).toBe('payAfter');
            expect(me.body.user.tenant.operations.customerApp.requestBill).toBe(true);
            expect(me.body.user.tenant.operationsBranch).toBe(String(T.branch._id));
        }
        const admin = await ctx.api.as(T.users.admin, T).get('/auth/me');
        expect(admin.body.user.tenant.operations.payment.dineIn).toBe('payAfter');          // Main
        expect(admin.body.user.tenant.operationsBranch).toBe(String(T.branch._id));

        // the unpinned admin viewing branch B (switcher) gets B's profile
        const viaQuery = await ctx.api.as(T.users.admin, T).get(`/auth/me?branch=${B._id}`);
        expect(viaQuery.body.user.tenant.operations.payment.dineIn).toBe('payFirst');
        expect(viaQuery.body.user.tenant.operationsBranch).toBe(String(B._id));
        const viaHeader = await ctx.api.as(T.users.admin, T).get('/auth/me').set('X-Branch-Id', String(B._id));
        expect(viaHeader.body.user.tenant.operations.payment.dineIn).toBe('payFirst');
        // a foreign / inactive branch id falls back to Main
        const foreign = await ctx.api.as(T.users.admin, T).get(`/auth/me?branch=${OTHER.branch._id}`);
        expect(foreign.body.user.tenant.operations.payment.dineIn).toBe('payAfter');
        expect(foreign.body.user.tenant.operationsBranch).toBe(String(T.branch._id));

        // a pinned waiter cannot pivot to another branch's profile
        const pivot = await ctx.api.as(T.users.waiter, T).get(`/auth/me?branch=${B._id}`);
        expect(pivot.body.user.tenant.operations.payment.dineIn).toBe('payAfter');
    });

    test('an override on Main is what the unpinned admin and Main staff see', async () => {
        await setOverride(T.branch, PAY_FIRST_WITH_WAITERS);
        expect((await ctx.api.as(T.users.admin, T).get('/auth/me')).body.user.tenant.operations.payment.dineIn).toBe('payFirst');
        expect((await ctx.api.as(T.users.waiter, T).get('/auth/me')).body.user.tenant.operations.payment.dineIn).toBe('payFirst');
        expect((await ctx.api.as(waiterB, T).get('/auth/me')).body.user.tenant.operations.payment.dineIn).toBe('payAfter');
    });

    test('/settings/operations follows the request branch (pinned, ?branch, Main)', async () => {
        await setOverride(B, PAY_FIRST_WITH_WAITERS);
        const main = await ctx.api.as(T.users.admin, T).get('/settings/operations');
        expect(main.status).toBe(200);
        expect(main.body.data.resolved.payment.dineIn).toBe('payAfter');
        expect(main.body.data.branchOverridden).toBe(false);
        expect(main.body.data.branchId).toBe(String(T.branch._id));
        const annex = await ctx.api.as(T.users.admin, T).get(`/settings/operations?branch=${B._id}`);
        expect(annex.status).toBe(200);
        expect(annex.body.data.resolved.payment.dineIn).toBe('payFirst');
        expect(annex.body.data.branchOverridden).toBe(true);
        expect(annex.body.data.isDefault).toBe(false);
    });

    test('QR scan and menu bootstrap resolve for the table\'s / picked branch; no branch picked → Main', async () => {
        await setOverride(B, PAY_FIRST);
        const scanB = await scanTable(ctx.api, tableB);
        expect(scanB.res.status).toBe(200);
        expect(scanB.res.body.restaurant.operations.payment.dineIn).toBe('payFirst');
        expect(scanB.res.body.restaurant.operations.customerApp.callWaiter).toBe(false);
        expect(scanB.res.body.restaurant.operations).not.toHaveProperty('roles');

        const scanMain = await scanTable(ctx.api, T.tables.main);
        expect(scanMain.res.body.restaurant.operations.payment.dineIn).toBe('payAfter');
        expect(scanMain.res.body.restaurant.operations.customerApp.callWaiter).toBe(true);

        const bootB = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&branch=${B._id}`);
        expect(bootB.status).toBe(200);
        expect(bootB.body.data.restaurant.operations.payment.dineIn).toBe('payFirst');
        const bootMain = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&branch=${T.branch._id}`);
        expect(bootMain.body.data.restaurant.operations.payment.dineIn).toBe('payAfter');
        const bootNone = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}`);
        expect(bootNone.body.data.restaurant.operations.payment.dineIn).toBe('payAfter');

        // an override on Main reaches the branch-less bootstrap and the Main table
        await setOverride(T.branch, PAY_FIRST);
        expect((await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}`)).body.data.restaurant.operations.payment.dineIn).toBe('payFirst');
        expect((await scanTable(ctx.api, T.tables.main)).res.body.restaurant.operations.payment.dineIn).toBe('payFirst');
        expect((await scanTable(ctx.api, tableB)).res.body.restaurant.operations.payment.dineIn).toBe('payAfter');
    });

    test('kiosk bootstrap uses the device branch', async () => {
        await setOverride(B, { answers: { useTables: false } });
        const kioskB = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&branch=${B._id}&kiosk=true`);
        expect(kioskB.status).toBe(200);
        expect(kioskB.body.data.restaurant.operations.tables.useTables).toBe(false);
        const kioskMain = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&branch=${T.branch._id}&kiosk=true`);
        expect(kioskMain.body.data.restaurant.operations.tables.useTables).toBe(true);
    });
});
