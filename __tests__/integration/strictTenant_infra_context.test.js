/**
 * STRICT tenant campaign / infra: AsyncLocalStorage isolation under
 * concurrency, and in-memory caches / counters / idempotency keys.
 *
 * "BUG:" tests are expected to FAIL until the source is fixed.
 */
const path = require('path');
const crypto = require('crypto');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const { runAsTenant, runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { getContext, runWithoutContext } = require(path.join(BACKEND, 'utils/requestContext'));
const settingsCache = require(path.join(BACKEND, 'utils/settingsCache'));
const listCache = require(path.join(BACKEND, 'utils/listCache'));
const { nextTokenNumber } = require(path.join(BACKEND, 'utils/orderToken'));
const { nextBillNo } = require(path.join(BACKEND, 'utils/billWorkspace'));
const Settings = require(path.join(BACKEND, 'models/settings'));

const ctx = useIntegrationApp();
let A; let B;
const rid = (t) => String(t.restaurant._id);

beforeAll(async () => {
    A = await seedTenant({ label: 'ca' });
    B = await seedTenant({ label: 'cb' });
    for (let i = 0; i < 4; i++) { await createTable(A, { name: `CA-T${i}` }); await createTable(B, { name: `CB-T${i}` }); }
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'general.cafeName': 'CAFE-A' } });
    await Settings.updateOne({ restaurant: B.restaurant._id, branch: null }, { $set: { 'general.cafeName': 'CAFE-B' } });
});

const rnd = (n) => new Promise((r) => setTimeout(r, Math.floor(Math.random() * n)));

describe('concurrent HTTP requests: zero cross-contamination', () => {
    test('60 interleaved staff requests from A and B (tables, live orders, menu) each see only their own data', async () => {
        const jobs = [];
        for (let i = 0; i < 60; i++) {
            const t = i % 2 === 0 ? A : B;
            const other = t === A ? B : A;
            jobs.push((async () => {
                await rnd(30);
                const [tables, menu, live] = await Promise.all([
                    ctx.api.as(t.users.admin, t).get('/tables'),
                    ctx.api.as(t.users.admin, t).get('/menu'),
                    ctx.api.as(t.users.waiter, t).get('/orders/live'),
                ]);
                const tt = JSON.stringify(tables.body);
                const mm = JSON.stringify(menu.body);
                return {
                    who: t.label,
                    ok: tables.status === 200,
                    leakTables: tt.includes(`CA-T`) && t === B || tt.includes(`CB-T`) && t === A,
                    leakMenu: mm.includes(String(other.items.paneer._id)) || mm.includes(rid(other)),
                    ownMenu: mm.includes(String(t.items.paneer._id)),
                    leakLive: JSON.stringify(live.body).includes(rid(other)),
                };
            })());
        }
        const out = await Promise.all(jobs);
        expect(out.every((r) => r.ok)).toBe(true);
        expect(out.filter((r) => r.leakTables || r.leakMenu || r.leakLive)).toEqual([]);
        expect(out.every((r) => r.ownMenu)).toBe(true);
    });

    test('guest requests with different slugs interleaved never get the other tenant menu', async () => {
        const out = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
            const t = i % 2 ? A : B; const other = t === A ? B : A;
            await rnd(20);
            const r = await ctx.api.guest(t).get('/menu');
            const s = JSON.stringify(r.body);
            return r.status === 200 && s.includes(String(t.items.paneer._id)) && !s.includes(String(other.items.paneer._id));
        }));
        expect(out.every(Boolean)).toBe(true);
    });

    test('concurrent writes: 30 table creations by A and B land in the right tenant', async () => {
        const mk = (t, i) => ctx.api.as(t.users.admin, t).post('/tables').send({ name: `W-${t.label}-${i}`, capacity: 2, area: String(t.area._id) });
        const res = await Promise.all(Array.from({ length: 30 }, (_, i) => mk(i % 2 ? A : B, i)));
        expect(res.filter((r) => r.status >= 400 && r.status !== 403 && r.status !== 400).length).toBe(0);
        const rows = await runAsSystem('verify', async () => Table.find({ name: /^W-/ }).lean());
        for (const row of rows) {
            const expected = row.name.startsWith('W-ca') ? rid(A) : rid(B);
            expect([row.name, String(row.restaurant)]).toEqual([row.name, expected]);
        }
    });
});

describe('AsyncLocalStorage under stress (no HTTP)', () => {
    test('300 interleaved runAsTenant tasks keep their own tenant across timers, immediates, ticks, Promise.all, events, transactions', async () => {
        const EE = require('events');
        const mongoose = require('mongoose');
        const tenants = [A, B];
        const bad = [];
        await Promise.all(Array.from({ length: 300 }, (_, i) => {
            const t = tenants[i % 2];
            return runAsTenant(t.restaurant._id, async () => {
                const check = async (label) => {
                    if (String(getContext()?.tenantId) !== rid(t)) bad.push(`${i}:${label}:ctx`);
                    const docs = await Table.find({}).lean();
                    if (!docs.length || docs.some((d) => String(d.restaurant) !== rid(t))) bad.push(`${i}:${label}:data`);
                };
                await rnd(10); await check('after-timer');
                await new Promise((r) => setImmediate(r)); await check('after-immediate');
                await new Promise((r) => process.nextTick(r)); await check('after-tick');
                await Promise.all([check('all-1'), rnd(5).then(() => check('all-2'))]);
                const ee = new EE();
                const done = new Promise((r) => ee.once('go', async () => { await check('emitter'); r(); }));
                setTimeout(() => ee.emit('go'), Math.random() * 10);
                await done;
                if (i % 5 === 0) {
                    const s = await mongoose.startSession();
                    try { await s.withTransaction(async () => { await check('txn'); }); } finally { await s.endSession(); }
                    await check('after-txn');
                }
                await new Promise((r) => setTimeout(r, 1)).then(() => check('late'));
            });
        }));
        expect(bad).toEqual([]);
    });

    test('runWithoutContext inside a tenant context gives an unscoped (system-like) view; the outer context is intact afterwards', async () => {
        await runAsTenant(A.restaurant._id, async () => {
            const inner = await runWithoutContext(async () => getContext());
            expect(inner).toBeNull();
            expect(String(getContext().tenantId)).toBe(rid(A));
        });
    });

    test('a callback queued from tenant A (setTimeout) still reports A even after B ran in between; never B', async () => {
        let seen;
        const p = runAsTenant(A.restaurant._id, async () => new Promise((resolve) => setTimeout(async () => { seen = String(getContext().tenantId); resolve(); }, 30)));
        await runAsTenant(B.restaurant._id, async () => { await rnd(5); });
        await p;
        expect(seen).toBe(rid(A));
    });

    test('Regression (fixed 2026-11): a query built in A context but executed in B context is refused (TenantMismatchError), never B-scoped', async () => {
        const q = runAsTenant(A.restaurant._id, () => Table.find({ name: /^CB-T/ }).lean());
        await expect(runAsTenant(B.restaurant._id, async () => q)).rejects.toMatchObject({ name: 'TenantMismatchError' });
    });

    test('Regression (fixed 2026-11): a Query created inside runAsTenant(A) but awaited in B never returns B rows (refused)', async () => {
        const q = runAsTenant(A.restaurant._id, () => Table.find({}).lean());
        let rows = null;
        try { rows = await runAsTenant(B.restaurant._id, async () => q); } catch (e) { expect(e.name).toBe('TenantMismatchError'); }
        expect(rows === null || rows.every((r) => String(r.restaurant) === rid(A))).toBe(true);
    });

    test('Regression (fixed 2026-11): a query built in A and awaited with no context is scoped by A (builder), not unscoped', async () => {
        const q = runAsTenant(A.restaurant._id, () => Table.find({}).lean());
        const rows = await runWithoutContext(async () => q);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => String(r.restaurant) === rid(A))).toBe(true);
    });

    test('legit flows: built with no context then run in A is scoped by A; built in A and run in the same A context works; runAsSystem exec is unscoped; aggregate built in A run in B is refused', async () => {
        const q0 = Table.find({}).lean();
        const rowsA = await runAsTenant(A.restaurant._id, async () => q0);
        expect(rowsA.length).toBeGreaterThan(0);
        expect(rowsA.every((r) => String(r.restaurant) === rid(A))).toBe(true);
        const same = await runAsTenant(A.restaurant._id, async () => { const q = Table.find({}).lean(); return q; });
        expect(same.every((r) => String(r.restaurant) === rid(A))).toBe(true);
        const qa = runAsTenant(A.restaurant._id, () => Table.find({}).lean());
        const sys = await runAsSystem('test', async () => qa);
        expect(new Set(sys.map((r) => String(r.restaurant))).size).toBeGreaterThan(1);
        const ag = runAsTenant(A.restaurant._id, () => Table.aggregate([{ $group: { _id: '$restaurant', n: { $sum: 1 } } }]));
        await expect(runAsTenant(B.restaurant._id, async () => ag)).rejects.toMatchObject({ name: 'TenantMismatchError' });
        const agOk = await runAsTenant(A.restaurant._id, async () => ag);
        expect(agOk.map((g) => String(g._id))).toEqual([rid(A)]);
    });
});

describe('caches', () => {
    test('settingsCache: per-tenant keys, invalidating A leaves B cached and correct', async () => {
        const reqA = { restaurant: A.restaurant, user: null, branch: null };
        const reqB = { restaurant: B.restaurant, user: null, branch: null };
        expect((await settingsCache.getSettings(reqA)).general.cafeName).toBe('CAFE-A');
        expect((await settingsCache.getSettings(reqB)).general.cafeName).toBe('CAFE-B');
        expect((await settingsCache.getSettings(rid(A))).general.cafeName).toBe('CAFE-A');
        expect((await settingsCache.getSettings(rid(B))).general.cafeName).toBe('CAFE-B');
        const keys = [...settingsCache._internals.cache.keys()];
        expect(keys.filter((k) => k.startsWith(rid(A))).every((k) => !k.includes(rid(B)))).toBe(true);
        // mutate B directly, invalidate A only: B stays cached (stale) - nothing crosses
        await Settings.updateOne({ restaurant: B.restaurant._id, branch: null }, { $set: { 'general.cafeName': 'CAFE-B2' } });
        settingsCache.invalidateCache(reqA);
        expect((await settingsCache.getSettings(reqB)).general.cafeName).toBe('CAFE-B');
        settingsCache.invalidateCache(reqB);
        expect((await settingsCache.getSettings(reqB)).general.cafeName).toBe('CAFE-B2');
        expect((await settingsCache.getSettings(reqA)).general.cafeName).toBe('CAFE-A');
    });

    test('settingsCache: branch-scoped customer request resolves to its own tenant, not another with the same branch id shape', async () => {
        const req = { restaurant: A.restaurant, user: { role: 'customer' }, branch: { _id: B.branch._id } };
        // branch of B under tenant A: the settings load is keyed A:<B-branch> and must not pick B's settings
        const s = await settingsCache.getSettings(req);
        expect(s === null || String(s.restaurant) === rid(A)).toBe(true);
    });

    test('Regression (fixed 2026-11): settingsCache.getSettings() with no argument runs an unscoped findOne and caches it under a shared key, serving one tenant\'s settings to another', async () => {
        settingsCache.invalidateCache();
        const first = await runAsTenant(A.restaurant._id, async () => settingsCache.getSettings());
        const second = await runAsTenant(B.restaurant._id, async () => settingsCache.getSettings());
        // B must never be handed A's document
        expect(String(second?.restaurant)).not.toBe(String(first?.restaurant));
        settingsCache.invalidateCache();
    });

    test('settingsCache: a request-like object with no restaurant fails closed (throws) rather than returning any tenant data', async () => {
        settingsCache.invalidateCache();
        await expect(runAsTenant(A.restaurant._id, async () => settingsCache.getSettings({ user: null }))).rejects.toBeDefined();
        settingsCache.invalidateCache();
    });

    test('listCache: separate tenants never share an entry; invalidate(A) leaves B; shared key only for legacy no-arg', async () => {
        let loads = 0;
        const c = listCache.create({ name: `strict-infra-${Date.now()}`, ttlMs: 60000, loader: async (req) => { loads += 1; return { for: String(req.restaurant._id) }; } });
        const reqA = { restaurant: A.restaurant, user: { role: 'admin' }, query: {} };
        const reqB = { restaurant: B.restaurant, user: { role: 'admin' }, query: {} };
        expect((await c.get(reqA)).for).toBe(rid(A));
        expect((await c.get(reqB)).for).toBe(rid(B));
        expect((await c.get(reqA)).for).toBe(rid(A));
        expect(loads).toBe(2);
        // admin branch switcher values keep separate entries
        const reqAx = { ...reqA, query: { branch: String(B.branch._id) } };
        expect((await c.get(reqAx)).for).toBe(rid(A));
        c.invalidate(reqA);
        expect((await c.get(reqB)).for).toBe(rid(B));
        expect(loads).toBeLessThanOrEqual(4);
    });

    test('Regression (fixed 2026-11): listCache.get() / get({}) shares ONE entry across tenants (legacy key); the loader result of the first tenant is served to the second', async () => {
        const c = listCache.create({ name: `strict-infra-legacy-${Date.now()}`, ttlMs: 60000, loader: async () => ({ for: String(getContext()?.tenantId) }) });
        const a = await runAsTenant(A.restaurant._id, async () => c.get());
        const b = await runAsTenant(B.restaurant._id, async () => c.get());
        expect(b.for).toBe(rid(B));
        expect(a.for).toBe(rid(A));
    });

    test('slug cache: two tenants resolved by slug in alternation never swap', async () => {
        for (let i = 0; i < 8; i++) {
            const t = i % 2 ? A : B;
            const r = await ctx.api.guest(t).get('/menu');
            expect(JSON.stringify(r.body)).toContain(String(t.items.paneer._id));
        }
        const wrong = await ctx.api.raw.get('/api/v1/menu').set('X-Restaurant-Slug', `${A.slug.toUpperCase()}`);
        expect([200, 400, 404]).toContain(wrong.status);
        if (wrong.status === 200) expect(JSON.stringify(wrong.body)).not.toContain(String(B.items.paneer._id));
    });

    test('order-token and bill counters are independent per tenant (and per day / FY)', async () => {
        const day = '2099-01-01';
        const a1 = await nextTokenNumber(A.restaurant._id, null, day);
        const a2 = await nextTokenNumber(A.restaurant._id, null, day);
        const b1 = await nextTokenNumber(B.restaurant._id, null, day);
        expect([a1, a2, b1]).toEqual(['T-001', 'T-002', 'T-001']);
        const ba = await nextBillNo(A.restaurant._id, null, { timeZone: 'Asia/Kolkata' });
        const ba2 = await nextBillNo(A.restaurant._id, null, { timeZone: 'Asia/Kolkata' });
        const bb = await nextBillNo(B.restaurant._id, null, { timeZone: 'Asia/Kolkata' });
        expect([ba2 - ba, bb]).toEqual([1, 1]);
    });

    test('50 concurrent token allocations across two tenants: gapless 1..25 each, no sharing', async () => {
        const day = '2099-02-02';
        const res = await Promise.all(Array.from({ length: 50 }, (_, i) => nextTokenNumber((i % 2 ? A : B).restaurant._id, null, day).then((tok) => ({ t: i % 2 ? 'A' : 'B', tok }))));
        for (const t of ['A', 'B']) {
            const nums = res.filter((r) => r.t === t).map((r) => Number(r.tok.slice(2))).sort((x, y) => x - y);
            expect(nums).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
        }
    });
});

describe('idempotency keys are tenant-scoped', () => {
    const key = () => crypto.randomBytes(12).toString('hex');
    const order = (t, table, scan, k) => ctx.api.guest(t, scan).post('/orders').set('Idempotency-Key', k).send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
    });

    test('the same Idempotency-Key from tenant A and tenant B (same IP, same path) never replays A\'s response to B', async () => {
        const ta = await createTable(A, { name: 'IDEM-A' }); const tb = await createTable(B, { name: 'IDEM-B' });
        const sa = (await scanTable(ctx.api, ta)).scanToken; const sb = (await scanTable(ctx.api, tb)).scanToken;
        const k = key();
        const ra = await order(A, ta, sa, k);
        const rb = await order(B, tb, sb, k);
        expect(ra.status).toBe(201);
        expect(rb.status).toBe(201);
        expect(rb.headers['idempotent-replayed']).toBeUndefined();
        expect(String(rb.body.order.restaurant)).toBe(rid(B));
        expect(String(ra.body.order.restaurant)).toBe(rid(A));
        // true replay inside the same tenant works
        const again = await order(A, ta, sa, k);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.body.order.orderId).toBe(ra.body.order.orderId);
    });

    test('customer idempotency: A customer reusing a key on B yields a B order', async () => {
        const cust = await createCustomer('idem');
        const tb = await createTable(B, { name: 'IDEM-B2' }); const ta = await createTable(A, { name: 'IDEM-A2' });
        const sb = (await scanTable(ctx.api, tb)).scanToken; const sa = (await scanTable(ctx.api, ta)).scanToken;
        const k = key();
        const body = (t, table) => ({ type: 'dine-in', tableId: String(table._id), items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250 });
        const r1 = await ctx.api.customerAtTable(cust, A, sa).post('/orders').set('Idempotency-Key', k).send(body(A, ta));
        const r2 = await ctx.api.customerAtTable(cust, B, sb).post('/orders').set('Idempotency-Key', k).send(body(B, tb));
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        expect(String(r2.body.order.restaurant)).toBe(rid(B));
        await settle(100);
    });
});

afterAll(async () => { await settle(100); await MenuItem.countDocuments({}).catch(() => {}); });
