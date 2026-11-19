/**
 * STRICT tenant campaign / data-model: unique indexes, per-tenant counters,
 * legacy (null-restaurant) docs, requests without a tenant, env flags.
 *
 *  1. Every unique index in the REAL database (not just the schema) either
 *     contains `restaurant` or is on an explicit allow-list of identities that
 *     are global by design. For every per-tenant unique index the same key is
 *     inserted for tenant A and tenant B (must both succeed) and twice for one
 *     tenant (must collide).
 *  2. Same names / codes / emails / staff ids created over HTTP in two tenants.
 *  3. Counters (order token, KOT ticket, bill number) are independent per tenant
 *     and per branch and gap-free under concurrency.
 *  4. Docs with no restaurant never reach a tenant; requests with no tenant
 *     resolved never see any tenant's data.
 *  5. Behaviour under TENANT_SCOPE_PLUGIN / TENANT_STRICT_CONTEXT.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const fs = require('fs');

const ctx = useIntegrationApp();
let A;
let B;
const rid = () => Math.random().toString(36).slice(2, 8);
const OID = () => new mongoose.Types.ObjectId();
const DAY = 86400000;

beforeAll(async () => {
    A = await seedTenant({ label: 'uq-a' });
    B = await seedTenant({ label: 'uq-b' });
});

// ── 1. Index audit against the real collections ─────────────────────────
// Unique indexes that are GLOBAL on purpose, with the reason. Anything not
// listed here must be per-tenant (contain `restaurant`).
const GLOBAL_UNIQUE = {
    'ApiKey:prefix': 'random public key prefix',
    'BlogPost:slug': 'platform marketing content',
    'IdempotencyRecord:key': 'sha256(caller|tenant|method|path|client key)',
    'JobLock:name': 'platform scheduler lock',
    'MarketingSetting:key': 'platform config',
    'Order:orderId': 'random per-order suffix; create retries on collision (see test below)',
    'OtpSendCounter:mobile,day': 'customer mobile is a global identity',
    'PaymentClaim:paymentId': 'a gateway payment id can be claimed once, platform-wide',
    'RefreshSession:tokenHash': 'random token hash',
    'Restaurant:slug': 'tenant URL slug is global',
    'Restaurant:contactEmailNormalized': 'one tenant per owner e-mail',
    'Restaurant:contactPhoneNormalized': 'one tenant per owner phone',
    'SubscriptionInvoice:razorpayPaymentId': 'gateway payment id',
    'SubscriptionPlan:slug': 'platform plan catalogue',
    'Table:qrToken': 'random 48-bit QR token, resolves the tenant at scan time',
    // `area` is a tenant-owned ObjectId, so {name, area} is per tenant ONLY while
    // Table.area is guaranteed to belong to the tenant - see the BUG tests in
    // strictTenant_schema_refs.test.js (createTable accepts a foreign area).
    'Table:name,area': 'area _id is tenant-owned (relies on area ownership validation)',
    'Transaction:razorpayPaymentId': 'gateway payment id',
    'User:googleId': 'Google sub is a global identity',
    'User:email': 'customers and superadmins are global identities (partial)',
    // keyed by order id (an ObjectId, globally unique) - cannot collide across tenants
    'IncentiveEntry:order,itemKey,campaign': 'order _id is globally unique',
    'RefundRequest:order,status': 'order _id is globally unique',
};

function loadAllModels() {
    const dir = path.join(BACKEND, 'models');
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.join(dir, f));
    return mongoose.models;
}

function sampleFor(model, field) {
    const p = model.schema.path(field);
    const t = p && p.instance;
    if (t === 'ObjectId' || t === 'ObjectID') return OID();
    if (t === 'Date') return new Date('2030-01-01T00:00:00Z');
    if (t === 'Number') return 7;
    if (t === 'Boolean') return true;
    if (!p && /(staff|user|order|supplier|run|branch|area|campaign|menuItem)$/.test(field)) return OID();
    return `dup-${field}`;
}

function setDeep(doc, dotted, value) {
    const parts = dotted.split('.');
    let cur = doc;
    parts.slice(0, -1).forEach((k) => { cur[k] = cur[k] || {}; cur = cur[k]; });
    cur[parts[parts.length - 1]] = value;
}

function applyPartial(doc, pfe) {
    if (!pfe) return;
    for (const [k, v] of Object.entries(pfe)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (v.$exists === true || v.$type) setDeep(doc, k, `p-${k}`);
            else if (Array.isArray(v.$in)) setDeep(doc, k, v.$in[0]);
            else if (v.$gt !== undefined) setDeep(doc, k, typeof v.$gt === 'number' ? v.$gt + 1 : 'p');
            else if (v.$ne !== undefined) setDeep(doc, k, v.$ne === true ? false : true);
        } else setDeep(doc, k, v);
    }
}

describe('unique indexes (real collections)', () => {
    let rows = [];

    beforeAll(async () => {
        const models = loadAllModels();
        for (const [name, model] of Object.entries(models)) {
            await model.init();
            const idx = await model.collection.indexes();
            for (const i of idx) {
                if (!i.unique || i.name === '_id_') continue;
                const keys = Object.keys(i.key);
                rows.push({ name, model, index: i, keys, id: `${name}:${keys.join(',')}` });
            }
        }
    });

    test('there are unique indexes to audit', () => {
        expect(rows.length).toBeGreaterThan(30);
    });

    test('every unique index contains restaurant or is a documented global identity', () => {
        const wrong = rows
            .filter((r) => !r.keys.includes('restaurant') && !GLOBAL_UNIQUE[r.id])
            .map((r) => r.id);
        expect(wrong).toEqual([]);
    });

    test('the global allow-list has no stale entries (each one still exists)', () => {
        const live = new Set(rows.map((r) => r.id));
        // User:email is declared twice (global partial + per tenant partial)
        const stale = Object.keys(GLOBAL_UNIQUE).filter((k) => !live.has(k));
        expect(stale).toEqual([]);
    });

    test('no per-tenant unique index is keyed only on restaurant plus a global-looking field (sanity)', () => {
        const bad = rows.filter((r) => r.keys.includes('restaurant') && r.keys.length === 1).map((r) => r.id);
        // a unique index on restaurant alone = one document per tenant (Settings is {restaurant,branch})
        expect(bad).toEqual([]);
    });

    test('per-tenant unique keys: the SAME value is accepted for tenant A and tenant B, and rejected twice inside one tenant', async () => {
        const failures = [];
        const perTenant = rows.filter((r) => r.keys.includes('restaurant'));
        for (const r of perTenant) {
            const doc = (tenantId) => {
                const d = { createdAt: new Date(), updatedAt: new Date() };
                for (const k of r.keys) {
                    if (k === 'restaurant') continue;
                    // the same sample value for both tenants (cached per index+key)
                    r.cache = r.cache || {};
                    r.cache[k] = r.cache[k] !== undefined ? r.cache[k] : sampleFor(r.model, k);
                    setDeep(d, k, r.cache[k]);
                }
                applyPartial(d, r.index.partialFilterExpression);
                // other GLOBAL single-field unique indexes of the model need a
                // distinct value per insert, or the null/dup would collide there
                for (const g of rows.filter((x) => x.name === r.name && x !== r && !x.keys.includes('restaurant') && x.keys.length === 1)) {
                    if (r.keys.includes(g.keys[0])) continue;
                    const sv = sampleFor(r.model, g.keys[0]);
                    setDeep(d, g.keys[0], typeof sv === 'string' ? `${sv}-${rid()}${rid()}` : sv instanceof mongoose.Types.ObjectId ? OID() : sv);
                }
                d.restaurant = tenantId;
                return d;
            };
            const tA = OID();
            const tB = OID();
            const col = r.model.collection;
            try {
                await col.insertOne(doc(tA));
            } catch (e) { failures.push(`${r.id}: first insert failed ${e.message.slice(0, 80)}`); continue; }
            try {
                await col.insertOne(doc(tB));
            } catch (e) { failures.push(`${r.id}: tenant B could NOT reuse tenant A's value (${e.codeName || e.code})`); }
            let dup = null;
            try { await col.insertOne(doc(tA)); } catch (e) { dup = e; }
            if (!dup || dup.code !== 11000) failures.push(`${r.id}: duplicate inside ONE tenant was not rejected`);
        }
        expect(failures).toEqual([]);
    });

    // models/order.js:123 `orderId: unique` is global. Two tenants that draw the
    // same random suffix collide; services/orderCreateService.js re-issues the id
    // (ORDER_ID_MAX_RETRIES). Documented as intentional: the collision is the
    // ONLY cross-tenant signal and it is absorbed by the retry.
    test('Order.orderId is globally unique (intentional) - a clash across tenants is rejected, not merged', async () => {
        const Order = req_('models/order');
        const id = `ORD-TEST-${rid()}`;
        await Order.collection.insertOne({ restaurant: A.restaurant._id, orderId: id });
        await expect(Order.collection.insertOne({ restaurant: B.restaurant._id, orderId: id })).rejects.toMatchObject({ code: 11000 });
    });

    test('order idempotency key is per tenant: A and B may use the same client key', async () => {
        const Order = req_('models/order');
        const key = `idem-${rid()}`;
        await Order.collection.insertOne({ restaurant: A.restaurant._id, orderId: `ORD-${rid()}x`, clientIdempotencyKey: key });
        await Order.collection.insertOne({ restaurant: B.restaurant._id, orderId: `ORD-${rid()}y`, clientIdempotencyKey: key });
        await expect(
            Order.collection.insertOne({ restaurant: A.restaurant._id, orderId: `ORD-${rid()}z`, clientIdempotencyKey: key }),
        ).rejects.toMatchObject({ code: 11000 });
    });
});

// ── 2. Same values over real HTTP in both tenants ───────────────────────
describe('the same name / code / e-mail is usable in two tenants over HTTP', () => {
    const as = (t) => ctx.api.as(t.users.admin);

    test('table name', async () => {
        const name = `Shared-${rid()}`;
        const a = await as(A).post('/tables').send({ name, capacity: 2, area: String(A.area._id) });
        const b = await as(B).post('/tables').send({ name, capacity: 2, area: String(B.area._id) });
        expect([a.status, b.status]).toEqual([201, 201]);
        const again = await as(A).post('/tables').send({ name, capacity: 2, area: String(A.area._id) });
        expect(again.status).toBe(400); // intentional: unique inside one area
    });

    test('area name', async () => {
        const name = `Patio-${rid()}`;
        const a = await as(A).post('/areas').send({ name });
        const b = await as(B).post('/areas').send({ name });
        expect([a.status, b.status]).toEqual([201, 201]);
    });

    test('coupon code', async () => {
        const body = () => ({
            code: 'SAMECODE10', title: 'Ten', discountType: 'percentage', discountValue: 10,
            startDate: new Date(Date.now() - DAY).toISOString(), endDate: new Date(Date.now() + DAY).toISOString(),
        });
        const a = await as(A).post('/promotions/coupons').send(body());
        const b = await as(B).post('/promotions/coupons').send(body());
        expect([a.status, b.status]).toEqual([201, 201]);
        expect((await as(A).post('/promotions/coupons').send(body())).status).toBe(409);
    });

    test('inventory item name + auto itemId (INV-001) in both tenants', async () => {
        const body = { name: 'Rice', category: 'Raw Ingredients', unit: 'kg', currentStock: 5, minStock: 1, costPerUnit: 10 };
        const a = await as(A).post('/inventory').send(body);
        const b = await as(B).post('/inventory').send(body);
        expect([a.status, b.status]).toEqual([201, 201]);
        const idA = (a.body.item || a.body.data || {}).itemId;
        const idB = (b.body.item || b.body.data || {}).itemId;
        expect(idA).toBe(idB); // independent per-tenant sequence
    });

    test('staff: same e-mail local part is a different person per tenant; EMP-001 sequence is per tenant', async () => {
        const email = `shared.${rid()}@staffmail.test`;
        const a = await as(A).post('/staff').send({ name: 'Same Person', email, role: 'waiter', branch: String(A.branch._id) });
        const b = await as(B).post('/staff').send({ name: 'Same Person', email, role: 'waiter', branch: String(B.branch._id) });
        expect([a.status, b.status]).toEqual([201, 201]);
        const User = req_('models/user');
        const idA = (await User.findOne({ email: email.toLowerCase(), restaurant: A.restaurant._id }).lean() || {}).staffId;
        const idB = (await User.findOne({ email: email.toLowerCase(), restaurant: B.restaurant._id }).lean() || {}).staffId;
        expect(idA).toBeTruthy();
        expect(idA).toBe(idB);
        // inside ONE tenant the e-mail stays unique
        const again = await as(A).post('/staff').send({ name: 'Same Person', email, role: 'waiter', branch: String(A.branch._id) });
        expect(again.status).toBeGreaterThanOrEqual(400);
    });

    test('staff next-id preview of tenant A never reflects tenant B staff', async () => {
        const User = req_('models/user');
        await User.insertMany([{
            name: 'B high', email: `bhigh.${rid()}@x.test`, role: 'waiter', password: 'Passw0rd-12345', status: 'active',
            restaurant: B.restaurant._id, branch: null, staffId: 'EMP-900',
        }]);
        const res = await as(A).get('/staff/next-id');
        expect(res.status).toBe(200);
        expect(res.body.nextId).toBe('EMP-001');
    });

    test('a customer e-mail is a GLOBAL identity: staff cannot be created with it (intentional)', async () => {
        const cust = await createCustomer('uqglobal');
        const res = await as(A).post('/staff').send({ name: 'Imposter', email: cust.email, role: 'waiter' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ── 3. Counters ──────────────────────────────────────────────────────────
describe('per-tenant / per-branch counters', () => {
    const { nextTokenNumber } = req_('utils/orderToken');
    const { nextTicketNo } = req_('utils/kotRounds');
    const { nextBillNo } = req_('utils/billWorkspace');
    const N = 25;
    const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const num = (t) => Number(String(t).replace(/^\D+-?/, ''));

    test('order tokens: concurrent allocations are gap-free and unique; tenants and branches are independent', async () => {
        const day = '2031-01-15';
        const bA2 = OID();
        const run = (t, br) => Promise.all(seq(N).map(() => nextTokenNumber(t.restaurant._id, br, day)));
        const [a, b, aBranch] = await Promise.all([run(A, A.branch._id), run(B, B.branch._id), run(A, bA2)]);
        for (const list of [a, b, aBranch]) {
            expect(new Set(list).size).toBe(N);
            expect(list.map(num).sort((x, y) => x - y)).toEqual(seq(N));
        }
        // next one continues the series, never jumps into another tenant's
        expect(num(await nextTokenNumber(A.restaurant._id, A.branch._id, day))).toBe(N + 1);
        expect(num(await nextTokenNumber(B.restaurant._id, B.branch._id, day))).toBe(N + 1);
        // a new day restarts
        expect(num(await nextTokenNumber(A.restaurant._id, A.branch._id, '2031-01-16'))).toBe(1);
    });

    test('order token requires a tenant', async () => {
        await expect(nextTokenNumber(null)).rejects.toThrow();
    });

    test('KOT ticket numbers: per tenant + branch, gap-free under concurrency', async () => {
        const day = '2031-02-01';
        const run = (t) => Promise.all(seq(N).map(() => nextTicketNo(t.restaurant._id, t.branch._id, day)));
        const [a, b] = await Promise.all([run(A), run(B)]);
        expect([...a].sort((x, y) => x - y)).toEqual(seq(N));
        expect([...b].sort((x, y) => x - y)).toEqual(seq(N));
        expect(await nextTicketNo(null)).toBeNull();
    });

    test('bill numbers: per tenant + branch + financial year, gap-free under concurrency', async () => {
        const opts = { timeZone: 'Asia/Kolkata', now: new Date('2031-06-01T10:00:00Z') };
        const run = (t, br) => Promise.all(seq(N).map(() => nextBillNo(t.restaurant._id, br, opts)));
        const bA2 = OID();
        const [a, b, a2] = await Promise.all([run(A, A.branch._id), run(B, B.branch._id), run(A, bA2)]);
        for (const list of [a, b, a2]) expect([...list].sort((x, y) => x - y)).toEqual(seq(N));
        // a different financial year restarts at 1 for the same branch
        expect(await nextBillNo(A.restaurant._id, A.branch._id, { timeZone: 'Asia/Kolkata', now: new Date('2032-06-01T10:00:00Z') })).toBe(1);
        expect(await nextBillNo(null)).toBeNull();
    });

    test('tenant-level (null branch) series is independent of every real branch', async () => {
        const day = '2031-03-01';
        await nextTokenNumber(A.restaurant._id, A.branch._id, day);
        await nextTokenNumber(A.restaurant._id, A.branch._id, day);
        expect(num(await nextTokenNumber(A.restaurant._id, null, day))).toBe(1);
    });

    test('counter documents are keyed by restaurant: one counter row per tenant/branch/day', async () => {
        const OrderTokenCounter = req_('models/orderTokenCounter');
        const rowsA = await OrderTokenCounter.collection.find({ restaurant: A.restaurant._id, day: '2031-01-15' }).toArray();
        const rowsB = await OrderTokenCounter.collection.find({ restaurant: B.restaurant._id, day: '2031-01-15' }).toArray();
        expect(rowsA.length).toBe(2); // main branch + the second branch
        expect(rowsB.length).toBe(1);
    });
});

// ── 4. Legacy docs without restaurant + requests without a tenant ───────
describe('null-restaurant docs and tenant-less requests', () => {
    const MARK = `LEGACY-${rid()}`;
    const MARK_T = `TNT-${rid()}`;
    let Category;
    let MenuItem;
    let Combo;
    let Hall;
    let Area;
    let Coupon;
    let Notification;

    beforeAll(async () => {
        Category = req_('models/category');
        MenuItem = req_('models/menuItem');
        Combo = req_('models/combo');
        Hall = req_('models/hall');
        Area = req_('models/area');
        Coupon = req_('models/coupon');
        Notification = req_('models/notification');
        const now = new Date();
        // legacy rows: restaurant field missing entirely
        await Category.collection.insertOne({ name: `${MARK}-cat`, status: 'active', isActive: true, createdAt: now, updatedAt: now });
        await Area.collection.insertOne({ name: `${MARK}-area`, isActive: true, createdAt: now, updatedAt: now });
        await Hall.collection.insertOne({ name: `${MARK}-hall`, type: 'Banquet Hall', isActive: true, status: 'active', maxCapacity: 10, basePrice: 1, createdAt: now, updatedAt: now });
        await Combo.collection.insertOne({ name: `${MARK}-combo`, status: 'active', price: 1, description: 'd', createdAt: now, updatedAt: now });
        await MenuItem.collection.insertOne({ name: `${MARK}-item`, status: 'active', basePrice: 1, description: 'd', createdAt: now, updatedAt: now });
        await Coupon.collection.insertOne({
            code: `${MARK}-CPN`, title: 'legacy', status: 'active', isActive: true, discountType: 'percentage', discountValue: 5,
            startDate: new Date(now - DAY), endDate: new Date(+now + DAY), createdAt: now, updatedAt: now,
        });
        // tenant markers so a tenant-less request that returns "everything" is visible too
        await Category.create({ restaurant: A.restaurant._id, branch: null, name: `${MARK_T}-A-cat` });
        await Category.create({ restaurant: B.restaurant._id, branch: null, name: `${MARK_T}-B-cat` });
        await Hall.create({ restaurant: B.restaurant._id, name: `${MARK_T}-B-hall`, type: 'Banquet Hall', minCapacity: 1, maxCapacity: 10, basePrice: 1 });
        await Area.create({ restaurant: B.restaurant._id, branch: B.branch._id, name: `${MARK_T}-B-area` });
        await Notification.collection.insertOne({
            restaurant: B.restaurant._id, branch: null, recipient: null, recipientRole: 'all', title: `${MARK_T}-B-note`,
            description: 'broadcast', category: 'system', status: 'unread', priority: 'low', createdAt: now, updatedAt: now,
        });
    });

    const seen = (res) => JSON.stringify(res.body || {});

    test('legacy rows without a restaurant are not listed for tenant A (staff or guest)', async () => {
        for (const p of ['/categories', '/areas', '/halls', '/combos', '/menu', '/promotions/coupons/active']) {
            const staff = await ctx.api.as(A.users.admin).get(p);
            const guest = await ctx.api.guest(A).get(p);
            expect(seen(staff)).not.toContain(`${MARK}-`);
            expect(seen(guest)).not.toContain(`${MARK}-`);
        }
    });

    test('a request with NO tenant resolved (anonymous, no slug) sees no tenant data and no legacy rows', async () => {
        const leaks = [];
        for (const p of ['/categories', '/areas', '/halls', '/combos', '/menu', '/promotions/coupons/active', '/promotions']) {
            const res = await ctx.api.anon().get(p);
            if (seen(res).includes(MARK) || seen(res).includes(MARK_T)) leaks.push(`${p} -> ${res.status}`);
        }
        expect(leaks).toEqual([]);
    });

    test('a customer without a tenant header does not receive another tenant broadcast notifications', async () => {
        const cust = await createCustomer('uqnote');
        const res = await ctx.api.as(cust).get('/notifications'); // no tenant
        expect(seen(res)).not.toContain(`${MARK_T}-B-note`);
    });

    // A staff/admin row whose `restaurant` is missing (legacy / bad import / a
    // detached default-tenant user). tenantFilter() would return {} for it, so any
    // endpoint that trusts it would span every tenant.
    test('an admin or waiter user with NO restaurant gets no tenant data from any staff endpoint', async () => {
        const { createUser } = require('./helpers/seed');
        const ghost = await createUser({ name: 'Ghost Admin', email: `ghost.${rid()}@orphans.test`, role: 'admin', restaurant: null, branch: null, isTenantOwner: true });
        const ghostW = await createUser({ name: 'Ghost Waiter', email: `ghostw.${rid()}@orphans.test`, role: 'waiter', restaurant: null, branch: null });
        const ids = [String(A.restaurant._id), String(B.restaurant._id)];
        const leaks = [];
        for (const u of [ghost, ghostW]) {
            for (const p of ['/staff', '/tables', '/areas', '/categories', '/menu', '/combos', '/halls', '/inventory', '/inventory/recipes',
                '/promotions/coupons', '/orders/live', '/orders/past', '/reservations', '/settings', '/branches', '/notifications',
                '/analytics/revenue', '/suppliers', '/purchases', '/campaigns', '/advance-booking/admin/all']) {
                const res = await ctx.api.as(u).get(p);
                const body = seen(res);
                if (ids.some((id) => body.includes(id)) || body.includes('Integration ')) leaks.push(`${u.role} ${p} -> ${res.status}`);
            }
        }
        expect(leaks).toEqual([]);
    });

    test('tenant A staff never see tenant B broadcast notification', async () => {
        const res = await ctx.api.as(A.users.admin).get('/notifications');
        expect(seen(res)).not.toContain(`${MARK_T}-B-note`);
    });

    test('the plugin cannot rescue a legacy no-restaurant doc: inside runAsTenant(A) it is not returned', async () => {
        const { runAsTenant } = req_('utils/tenantSafe');
        const rows = await runAsTenant(A.restaurant._id, async () => Category.find({ name: new RegExp(`^(${MARK}|${MARK_T})`) }).lean());
        expect(rows.map((r) => r.name)).toEqual([`${MARK_T}-A-cat`]);
    });
});

// ── 5. Env flags ─────────────────────────────────────────────────────────
describe('TENANT_SCOPE_PLUGIN / TENANT_STRICT_CONTEXT', () => {
    const saved = {};
    const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete saved[k]; } });

    const catsSeenInTenantA = async (n) => {
        const { runAsTenant } = req_('utils/tenantSafe');
        const Category = req_('models/category');
        await Category.create({ restaurant: A.restaurant._id, branch: null, name: `ENV-A-${n}` });
        await Category.create({ restaurant: B.restaurant._id, branch: null, name: `ENV-B-${n}` });
        return runAsTenant(A.restaurant._id, async () => Category.find({ name: new RegExp(`^ENV-.*-${n}$`) }).lean());
    };

    test('default (variable unset) = enforce: an unscoped query inside a tenant sees only that tenant', async () => {
        setEnv('TENANT_SCOPE_PLUGIN', undefined);
        const rows = await catsSeenInTenantA('def');
        expect(rows.map((r) => r.name)).toEqual(['ENV-A-def']);
    });

    test('unknown / mistyped values fall back to enforce (fail safe)', async () => {
        for (const [i, v] of ['ENFORCE', 'true', '1', 'on', 'enable', ' off', 'of'].entries()) {
            setEnv('TENANT_SCOPE_PLUGIN', v);
            const rows = await catsSeenInTenantA(`typo${i}`);
            expect(rows.map((r) => r.name)).toEqual([`ENV-A-typo${i}`]);
        }
    });

    test('warn and off documented behaviour: warn logs only, off disables - both let an unscoped query span tenants', async () => {
        setEnv('TENANT_SCOPE_PLUGIN', 'warn');
        expect((await catsSeenInTenantA('warn')).map((r) => r.name).sort()).toEqual(['ENV-A-warn', 'ENV-B-warn']);
        setEnv('TENANT_SCOPE_PLUGIN', 'off');
        expect((await catsSeenInTenantA('off')).map((r) => r.name).sort()).toEqual(['ENV-A-off', 'ENV-B-off']);
    });

    // Fixed 2026-11: mode() used to trust the env var in every NODE_ENV, so a stray
    // TENANT_SCOPE_PLUGIN=off in a production env file silently removed the safety net.
    // It is now ignored (error logged) when NODE_ENV=production.
    test('Regression (fixed 2026-11): with NODE_ENV=production the safety net cannot be switched off by env', async () => {
        setEnv('NODE_ENV', 'production');
        setEnv('TENANT_SCOPE_PLUGIN', 'off');
        const rows = await catsSeenInTenantA('prodoff');
        expect(rows.map((r) => r.name)).toEqual(['ENV-A-prodoff']);
    });

    test('TENANT_STRICT_CONTEXT=true: a tenant-less insertMany throws, runAsSystem and stamped docs are allowed', async () => {
        const { runAsSystem } = req_('utils/tenantSafe');
        const Category = req_('models/category');
        setEnv('TENANT_STRICT_CONTEXT', 'true');
        await expect(Category.insertMany([{ name: `STRICT-${rid()}` }])).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
        await expect(runAsSystem('test', async () => Category.insertMany([{ restaurant: A.restaurant._id, name: `SYS-${rid()}` }]))).resolves.toBeTruthy();
        await expect(Category.insertMany([{ restaurant: A.restaurant._id, name: `STAMPED-${rid()}` }])).resolves.toBeTruthy();
    });

    test('TENANT_STRICT_CONTEXT=true: inside tenant A a doc naming tenant B is rejected (explicit mismatch)', async () => {
        const { runAsTenant } = req_('utils/tenantSafe');
        const Category = req_('models/category');
        setEnv('TENANT_STRICT_CONTEXT', 'true');
        await expect(runAsTenant(A.restaurant._id, async () => Category.insertMany([{ restaurant: B.restaurant._id, name: `MM-${rid()}` }])))
            .rejects.toMatchObject({ name: 'TenantMismatchError' });
    });

    // Fixed 2026-11: strict mode used to be opt-in even in production, so a restaurant-less
    // bulkWrite outside any context only logged a warning and wrote an orphan document.
    // In production (required-restaurant models) it now throws by default.
    test('Regression (fixed 2026-11): in production a tenant-less bulkWrite without a restaurant is rejected by default', async () => {
        const Category = req_('models/category');
        setEnv('NODE_ENV', 'production');
        setEnv('TENANT_STRICT_CONTEXT', undefined);
        let threw = false; let thrown = null;
        try { await Category.bulkWrite([{ insertOne: { document: { name: `ORPHAN-${rid()}` } } }], { skipValidation: true }); } catch (e) { threw = true; thrown = e; }
        expect(thrown && thrown.name).toBe('TenantContextError');
        expect(threw).toBe(true);
    });
});
