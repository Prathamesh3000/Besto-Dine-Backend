/**
 * STRICT tenant campaign / jobs: menu auto-restore
 * (utils/menuAutoRestoreScheduler.runMenuAutoRestoreScan, 'menu-auto-restore').
 *
 * The scan is one cross-tenant updateMany with no tenant settings, branch,
 * timezone or credentials involved (expiry is an absolute Date). What must
 * hold: only expired temporary inactivations are restored, in every tenant,
 * without touching ownership or any other field; permanent / not-yet-expired /
 * already-active items are left alone; run inside one tenant's context it can
 * only ever touch that tenant; a second run restores nothing; a DB failure is
 * swallowed; the JobLock admits one instance per interval.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const JobLock = require(path.join(BACKEND, 'models/jobLock'));
const { runMenuAutoRestoreScan } = require(path.join(BACKEND, 'utils/menuAutoRestoreScheduler'));
const { runAsSystem, runAsTenant } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { createScheduler } = require(path.join(BACKEND, 'utils/scheduler'));
const { createJobLock } = require(path.join(BACKEND, 'utils/jobLock'));

useIntegrationApp();
const HOUR = 3600 * 1000;
const rid = () => crypto.randomBytes(3).toString('hex');
const scan = () => runAsSystem('job:menu-auto-restore', () => runMenuAutoRestoreScan());
const get = (i) => runAsSystem('r', () => MenuItem.findById(i._id).lean());

const mk = (t, fields) => runAsSystem('seed', () => MenuItem.create({
    restaurant: t.restaurant._id, category: t.category._id, name: `Dish ${rid()}`, description: 'x',
    prepStation: 'kitchen', vegType: 'veg', basePrice: 123, ...fields,
}));
const hidden = (t, untilMs, extra = {}) => mk(t, {
    status: 'archived', inStock: false, inactivationReason: 'out of stock',
    inactivationUntil: untilMs === null ? null : new Date(Date.now() + untilMs), ...extra,
});

let A; let B;
beforeAll(async () => {
    A = await seedTenant({ label: 'mra' });
    B = await seedTenant({ label: 'mrb' });
});

describe('menu auto-restore across two tenants', () => {
    let aExp; let bExp; let aFuture; let bPermanent; let aActive;
    test('expired temporary inactivations are restored in both tenants; everything else is untouched', async () => {
        aExp = await hidden(A, -HOUR); bExp = await hidden(B, -2 * HOUR);
        aFuture = await hidden(A, 5 * HOUR);
        bPermanent = await hidden(B, null);
        aActive = await mk(A, { status: 'active', inactivationUntil: new Date(Date.now() - HOUR) });

        const r = await scan();
        expect(r.restored).toBeGreaterThanOrEqual(2);

        for (const [item, t] of [[aExp, A], [bExp, B]]) {
            const d = await get(item);
            expect(d.status).toBe('active'); expect(d.inStock).toBe(true);
            expect(d.inactivationUntil).toBeNull(); expect(d.inactivationReason).toBe('');
            expect(String(d.restaurant)).toBe(String(t.restaurant._id)); // ownership never changes
            expect(d.basePrice).toBe(123); expect(d.name).toBe(item.name);
        }
        expect((await get(aFuture)).status).toBe('archived');
        expect((await get(aFuture)).inactivationReason).toBe('out of stock');
        expect((await get(bPermanent)).status).toBe('archived');
        expect((await get(aActive)).status).toBe('active');
    });

    test('idempotent: running again restores nothing and changes nothing', async () => {
        const before = await get(aFuture);
        const r = await scan();
        expect(r.restored).toBe(0);
        const after = await get(aFuture);
        expect(String(after.updatedAt)).toBe(String(before.updatedAt));
        expect((await get(aExp)).status).toBe('active');
    });

    test('a not-yet-expired item is restored on the next run once its time passes (no early restore)', async () => {
        await MenuItem.collection.updateOne({ _id: aFuture._id }, { $set: { inactivationUntil: new Date(Date.now() - 1000) } });
        const r = await scan();
        expect(r.restored).toBe(1);
        expect((await get(aFuture)).status).toBe('active');
    });
});

describe('tenant-context safety', () => {
    test('even if invoked inside tenant A context, only tenant A items are restored', async () => {
        const a = await hidden(A, -HOUR); const b = await hidden(B, -HOUR);
        await runAsTenant(A.restaurant._id, () => runMenuAutoRestoreScan());
        expect((await get(a)).status).toBe('active');
        expect((await get(b)).status).toBe('archived');
        await scan();
        expect((await get(b)).status).toBe('active');
    });
});

describe('failure handling', () => {
    test('a DB failure is swallowed (restored: 0) and nothing is changed', async () => {
        const a = await hidden(A, -HOUR);
        const spy = jest.spyOn(MenuItem, 'updateMany').mockRejectedValueOnce(new Error('db down'));
        try { await expect(scan()).resolves.toEqual({ restored: 0 }); } finally { spy.mockRestore(); }
        expect((await get(a)).status).toBe('archived');
        await scan();
        expect((await get(a)).status).toBe('active');
    });
});

describe('JobLock', () => {
    test('only one of two instances runs the menu-auto-restore tick per interval', async () => {
        const fn = jest.fn(() => runMenuAutoRestoreScan());
        const s1 = createScheduler({ lock: createJobLock({ owner: 'mr-1' }) });
        const s2 = createScheduler({ lock: createJobLock({ owner: 'mr-2' }) });
        for (const s of [s1, s2]) s.scheduleJob('menu-auto-restore', 15 * 60 * 1000, fn, { initialDelayMs: 24 * HOUR });
        await Promise.all([s1._runTick('menu-auto-restore'), s2._runTick('menu-auto-restore')]);
        await s1._runTick('menu-auto-restore'); await s2._runTick('menu-auto-restore');
        expect(fn).toHaveBeenCalledTimes(1);
        const lock = await JobLock.findOne({ name: 'menu-auto-restore' }).lean();
        expect(lock.lockedUntil.getTime()).toBeGreaterThan(Date.now());
        expect(['mr-1', 'mr-2']).toContain(lock.owner);
        await Promise.all([s1.stopAll(), s2.stopAll()]);
    });
});
