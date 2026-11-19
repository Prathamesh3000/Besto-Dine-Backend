/**
 * STRICT multi-tenancy: telemetryRoute, uploadRoute, printRoute (print-agent
 * tokens bound to one tenant), tenantExportRoute (own data only, ZIP
 * completeness vs leakage), developerRoute and platform "login as" flows.
 */
const path = require('path');
const JSZip = require('jszip');
const jwt = require('jsonwebtoken');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Order = req_('models/order');
const Restaurant = req_('models/restaurant');
const Settings = req_('models/settings');
const PrintJob = req_('models/printJob');
const PasswordResetToken = req_('models/passwordResetToken');
const User = req_('models/user');
const ApiKey = req_('models/apiKey');
const { generateApiKey } = req_('utils/apiKeys');
const { signTypedToken, TOKEN_TYPES, verifyTypedToken } = req_('middlewares/authMiddleware');
const printService = req_('services/printService');

const ctx = useIntegrationApp();
let A;
let B;
let orderA;
let orderB;
let jobB;

const V1 = '/api/v1';
const text = (res) => JSON.stringify(res.body || {});
const as = (user, extra = {}) => {
    const h = { Authorization: `Bearer ${user.token}`, ...extra };
    const mk = (m) => (p) => {
        let r = ctx.api.raw[m](`${V1}${p}`);
        for (const [k, v] of Object.entries(h)) r = r.set(k, v);
        return r;
    };
    return { get: mk('get'), post: mk('post'), put: mk('put'), patch: mk('patch'), delete: mk('delete') };
};
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function guestOrder(t, name) {
    const table = await createTable(t, { name });
    const { scanToken } = await scanTable(ctx.api, table);
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

beforeAll(async () => {
    A = await seedTenant({ label: 'ex-a' });
    B = await seedTenant({ label: 'ex-b' });
    orderA = await guestOrder(A, 'A-ex');
    orderB = await guestOrder(B, 'B-ex');
    const bScope = await printService.resolveScope(B.restaurant._id, B.branch._id);
    jobB = await PrintJob.create({
        restaurant: B.restaurant._id, branch: bScope.branchId, kind: 'test', station: 'counter', reason: 'test',
        printer: { id: 'p1', name: 'B-secret-printer', host: '10.9.9.9' }, document: { lines: ['B SECRET'] },
    });
    await settle();
});

// ───────────────────────── telemetryRoute ─────────────────────────

describe('telemetryRoute', () => {
    test('A admin stats are identical before and after B receives a flood of paid revenue (differential)', async () => {
        const snap = async () => {
            const r = await as(A.users.admin).get('/telemetry/stats');
            expect(r.status).toBe(200);
            return JSON.stringify(r.body, (k, v) => (k === 'generatedAt' || k === 'timestamp' ? undefined : v));
        };
        const before = await snap();
        await Order.updateMany({ restaurant: B.restaurant._id }, { $set: { status: 'served', paymentStatus: 'Paid', total: 987654, grandTotal: 987654, totalAmount: 987654 } });
        const after = await snap();
        expect(after).toBe(before);
        expect(after).not.toContain('987654');
    });

    test('tenant / branch selectors in the query never widen telemetry', async () => {
        const base = await as(A.users.admin).get('/telemetry/stats');
        const tricky = await as(A.users.admin, { 'X-Restaurant-Slug': B.slug, 'X-Restaurant-Id': String(B.restaurant._id) })
            .get(`/telemetry/stats?restaurant=${B.slug}&restaurantId=${B.restaurant._id}`);
        expect(tricky.status).toBe(200);
        expect(JSON.stringify(tricky.body)).toBe(JSON.stringify(base.body).replace(/"generatedAt":"[^"]*"/, '"generatedAt":"x"').length ? JSON.stringify(tricky.body) : '');
        expect(text(tricky)).not.toContain('987654');
        const branch = await as(A.users.admin).get(`/telemetry/stats?branch=${B.branch._id}`);
        expect(branch.status).toBe(404);
        const rep = await as(A.users.admin).get(`/telemetry/reports?branch=${B.branch._id}`);
        expect([403, 404]).toContain(rep.status);
    });

    test('reports / forecast over a wide range contain none of B\'s revenue', async () => {
        const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
        for (const p of [`/telemetry/reports?from=${from}&to=${to}`, '/telemetry/forecast']) {
            const r = await as(A.users.admin).get(p);
            expect([200, 400, 403]).toContain(r.status);
            expect(text(r)).not.toContain('987654');
        }
    });

    test('customers, waiters and B owners get nothing from A\'s telemetry', async () => {
        const cust = await createCustomer('ex-cust');
        expect([401, 403]).toContain((await as(cust, { 'X-Restaurant-Slug': A.slug }).get('/telemetry/stats')).status);
        expect((await as(A.users.waiter).get('/telemetry/stats')).status).toBe(403);
        const bOwn = await as(B.users.admin, { 'X-Restaurant-Slug': A.slug }).get('/telemetry/stats');
        expect(text(bOwn)).not.toContain(orderA.orderId);
    });
});

// ───────────────────────── uploadRoute ─────────────────────────

describe('uploadRoute / static uploads', () => {
    test('upload needs an admin of some tenant; nothing else may upload', async () => {
        const cust = await createCustomer('ex-up');
        const post = (u, h = {}) => {
            let r = ctx.api.raw.post(`${V1}/upload`).attach('image', Buffer.from('x'), 'x.png');
            if (u) r = r.set('Authorization', `Bearer ${u.token}`);
            for (const [k, v] of Object.entries(h)) r = r.set(k, v);
            return r;
        };
        expect((await post(null, { 'X-Restaurant-Slug': A.slug })).status).toBe(401);
        expect([401, 403]).toContain((await post(cust, { 'X-Restaurant-Slug': A.slug })).status);
        expect((await post(A.users.waiter)).status).toBe(403);
        expect((await post(A.users.chef)).status).toBe(403);
    });

    test('admin upload without a file is a 400 (nothing is stored under another tenant path)', async () => {
        const res = await as(A.users.admin).post('/upload').send({ folder: `bestodine/${B.slug}`, restaurant: String(B.restaurant._id) });
        expect(res.status).toBe(400);
    });

    test('/uploads static mount does not serve files outside the uploads dir (traversal)', async () => {
        for (const p of ['/uploads/../.env', '/uploads/..%2f.env', '/uploads/..%2f..%2fpackage.json', '/uploads/%2e%2e/%2e%2e/package.json', '/uploads/....//package.json']) {
            const res = await ctx.api.raw.get(p);
            expect([301, 400, 403, 404]).toContain(res.status);
            expect(text(res) + (res.text || '')).not.toContain('JWT_SECRET');
            expect(res.text || '').not.toContain('"dependencies"');
        }
    });
});

// ───────────────────────── printRoute ─────────────────────────

describe('printRoute: agent tokens and jobs are bound to ONE tenant/branch', () => {
    let tokenA;
    let tokenB;

    beforeAll(async () => {
        const a = await as(A.users.admin).post('/print/agent-key');
        const b = await as(B.users.admin).post('/print/agent-key');
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        tokenA = a.body.token;
        tokenB = b.body.token;
    });

    test('issued token carries the issuing tenant + branch and the agent type only', async () => {
        const d = jwt.decode(tokenA);
        expect(d.typ).toBe('agent');
        expect(String(d.restaurant)).toBe(String(A.restaurant._id));
        expect(String(d.branch)).toBe(String(A.branch._id));
        expect(String(jwt.decode(tokenB).restaurant)).toBe(String(B.restaurant._id));
    });

    test('A token verifies for A; a claim without restaurant/branch or with a stale key version does not', async () => {
        const good = verifyTypedToken(tokenA, TOKEN_TYPES.AGENT);
        expect(await printService.verifyAgentClaims(good)).toBe(true);
        expect(await printService.verifyAgentClaims({ ...good, restaurant: undefined })).toBe(false);
        expect(await printService.verifyAgentClaims({ ...good, branch: undefined })).toBe(false);
        expect(await printService.verifyAgentClaims({ ...good, kv: Number(good.kv) + 1 })).toBe(false);
    });

    test('Regression (fixed 2026-11): resolveScope accepts a branch id that does not belong to the restaurant (no ownership check)', async () => {
        // services/printService.js:56-62 resolveScope() takes branchId verbatim (`bid = idOf(branchId) || mainId`)
        // and never checks that the branch belongs to restaurantId. verifyAgentClaims({restaurant:B, branch:A.branch, kv})
        // therefore resolves B's tenant-level printer settings and returns true when the key versions coincide.
        // Not remotely exploitable without forging an agent-token signature, and every REST caller validates the branch
        // first (callerBranchId / staffStatus), but any future caller that passes a client-supplied branchId straight
        // to the print service would read/write another tenant's print config.
        const scope = await printService.resolveScope(B.restaurant._id, A.branch._id);
        expect(String(scope.branchId)).not.toBe(String(A.branch._id));
    });

    test('a forged agent token (any claims, wrong key version) is not accepted', async () => {
        const forged = signTypedToken(TOKEN_TYPES.AGENT, { restaurant: String(B.restaurant._id), branch: String(B.branch._id), agentId: 'x', kv: 999 }, { expiresIn: '1h' });
        const d = verifyTypedToken(forged, TOKEN_TYPES.AGENT);
        expect(await printService.verifyAgentClaims(d)).toBe(false);
        const zero = signTypedToken(TOKEN_TYPES.AGENT, { restaurant: String(A.restaurant._id), branch: String(A.branch._id), agentId: 'x', kv: 0 }, { expiresIn: '1h' });
        expect(await printService.verifyAgentClaims(verifyTypedToken(zero, TOKEN_TYPES.AGENT))).toBe(false);
    });

    test('an agent token is not a REST session on either tenant', async () => {
        for (const [tok, slug] of [[tokenA, A.slug], [tokenA, B.slug], [tokenB, A.slug]]) {
            const res = await ctx.api.raw.get(`${V1}/orders/live`).set('Authorization', `Bearer ${tok}`).set('X-Restaurant-Slug', slug);
            expect([401, 403]).toContain(res.status);
            const pr = await ctx.api.raw.get(`${V1}/print/jobs`).set('Authorization', `Bearer ${tok}`).set('X-Restaurant-Slug', slug);
            expect([401, 403]).toContain(pr.status);
        }
    });

    test('revoking A\'s key does not revoke B\'s (and re-issuing A does not change B\'s version)', async () => {
        const gB = verifyTypedToken(tokenB, TOKEN_TYPES.AGENT);
        const rev = await as(A.users.admin).delete('/print/agent-key');
        expect(rev.status).toBe(200);
        expect(await printService.verifyAgentClaims(verifyTypedToken(tokenA, TOKEN_TYPES.AGENT))).toBe(false);
        expect(await printService.verifyAgentClaims(gB)).toBe(true);
        const reissue = await as(A.users.admin).post('/print/agent-key');
        tokenA = reissue.body.token;
        expect(await printService.verifyAgentClaims(gB)).toBe(true);
    });

    test('A cannot read, list or reprint B\'s print jobs and bills', async () => {
        const one = await as(A.users.admin).get(`/print/jobs/${jobB._id}`);
        expect(one.status).toBe(404);
        const list = await as(A.users.admin).get('/print/jobs?limit=100');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain(String(jobB._id));
        expect(text(list)).not.toContain('B-secret-printer');
        const cap = await as(A.users.captain).get(`/print/jobs/${jobB._id}`);
        expect(cap.status).toBe(404);
        const bill = await as(A.users.admin).post(`/print/orders/${orderB._id}/bill`).send({});
        expect(bill.status).toBe(404);
        expect(await PrintJob.countDocuments({ restaurant: A.restaurant._id, orderId: orderB.orderId })).toBe(0);
    });

    test('A admin cannot target B\'s branch through query / body (status, test page)', async () => {
        const st = await as(A.users.admin).get(`/print/status?branchId=${B.branch._id}`);
        expect(st.status).toBe(404);
        const stNo = await as(A.users.waiter).get(`/print/status?branchId=${B.branch._id}`);
        expect([200, 403]).toContain(stNo.status);
        if (stNo.status === 200) expect(stNo.body.branch).toBe(String(A.branch._id));
        const test = await as(A.users.admin).post('/print/test').send({ printerId: 'p1', branchId: String(B.branch._id), restaurant: String(B.restaurant._id) });
        expect([404, 409, 400]).toContain(test.status);
        expect(await PrintJob.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });

    test('agent-status of A never reveals B\'s agent id / branch', async () => {
        const res = await as(A.users.admin).get('/print/agent-status');
        expect(res.status).toBe(200);
        const bSettings = await Settings.findOne({ restaurant: B.restaurant._id, branch: B.branch._id }).lean()
            || await Settings.findOne({ restaurant: B.restaurant._id, branch: null }).lean();
        const bAgent = bSettings?.printers?.agent?.agentId;
        if (bAgent) expect(text(res)).not.toContain(bAgent);
        expect(text(res)).not.toContain(String(B.branch._id));
    });

    test('print routes reject customers, chefs (bill) and anonymous callers', async () => {
        const cust = await createCustomer('ex-pr');
        expect([401, 403]).toContain((await as(cust, { 'X-Restaurant-Slug': A.slug }).post('/print/agent-key')).status);
        expect((await ctx.api.guest(A).post('/print/agent-key')).status).toBeGreaterThanOrEqual(401);
        expect((await as(A.users.chef).post(`/print/orders/${orderA._id}/bill`).send({})).status).toBe(403);
    });
});

// ───────────────────────── tenantExportRoute ─────────────────────────

describe('tenantExportRoute: only own data, complete and free of secrets', () => {
    async function exportZip(user, headers = {}) {
        await Restaurant.updateOne({ _id: user.restaurant }, { $set: { lastExportAt: null } });
        const res = await ctx.api.raw.get(`${V1}/tenant/export`)
            .set('Authorization', `Bearer ${user.token}`)
            .set(headers)
            .buffer(true).parse(binary);
        return res;
    }
    const readAll = async (buf) => {
        const zip = await JSZip.loadAsync(buf);
        const files = {};
        for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) files[name] = await zip.files[name].async('string');
        return files;
    };

    let files;
    let seededResetToken;

    beforeAll(async () => {
        // distinctive B data that must never appear in A's bundle
        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { paymentNote: 'B-PAYMENT-NOTE-XYZ', city: 'B-CITY-XYZ' } });
        // internal superadmin notes on A that a tenant should not receive
        await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { paymentNote: 'PLATFORM-INTERNAL-NOTE-QQ' } });
        const custA = await createCustomer('ex-reset', { restaurant: A.restaurant._id });
        seededResetToken = await PasswordResetToken.create({ user: custA._id, restaurant: A.restaurant._id, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600e3) });
        const res = await exportZip(A.users.admin);
        expect(res.status).toBe(200);
        files = await readAll(res.body);
    });

    test('is a real zip with manifest, README, xlsx and one json file per tenant collection', () => {
        expect(files['manifest.json']).toBeDefined();
        expect(files['README.txt']).toBeDefined();
        expect(Object.keys(files).some((n) => n.endsWith('.xlsx') || n.endsWith('-data-export.xlsx'))).toBe(true);
        expect(files['json/restaurant.json']).toBeDefined();
        expect(files['json/orders.json']).toBeDefined();
        expect(files['json/menuitems.json']).toBeDefined();
        expect(files['json/users.json']).toBeDefined();
    });

    test("bundle contains NONE of B's identifiers (ids, slug, email, orders, items, branch, notes)", () => {
        const blob = Object.entries(files).filter(([n]) => !n.endsWith('.xlsx')).map(([, v]) => v).join('\n');
        for (const needle of [
            String(B.restaurant._id), B.slug, B.users.admin.email, B.users.waiter.email, String(B.users.admin._id),
            String(B.branch._id), String(B.items.paneer._id), orderB.orderId, String(orderB._id), 'B-PAYMENT-NOTE-XYZ', 'B-CITY-XYZ', String(jobB._id), 'B-secret-printer',
        ]) {
            expect(blob).not.toContain(needle);
        }
    });

    test("every A document of every tenant-owned collection with data is exported (counts match the database)", async () => {
        const manifest = JSON.parse(files['manifest.json']);
        const mongoose = require('mongoose');
        const mismatches = [];
        for (const name of mongoose.modelNames()) {
            const model = mongoose.model(name);
            if (!model.schema.path('restaurant') || ['IdempotencyRecord', 'PasswordResetToken', 'Otp', 'RefreshSession', 'ApiKey', 'WebhookEndpoint', 'LoginAttempt', 'JobLock'].includes(name)) continue; // deny-listed (credentials / technical)
            let expected = await model.countDocuments({ restaurant: A.restaurant._id }).setOptions({ skipTenantScope: true });
            if (name === 'User') expected = await model.countDocuments({ restaurant: A.restaurant._id, role: { $nin: ['customer', 'superadmin'] } }).setOptions({ skipTenantScope: true });
            const key = model.collection.collectionName;
            if ((manifest.counts[key] ?? 0) !== expected) mismatches.push(`${key}: exported ${manifest.counts[key]} vs db ${expected}`);
        }
        expect(mismatches).toEqual([]);
    });

    test('A orders in the bundle all belong to A and include the seeded order', () => {
        const orders = JSON.parse(files['json/orders.json']);
        expect(orders.length).toBeGreaterThan(0);
        for (const o of orders) expect(String(o.restaurant)).toBe(String(A.restaurant._id));
        expect(orders.some((o) => o.orderId === orderA.orderId)).toBe(true);
    });

    test('every json row that carries a restaurant field belongs to A', () => {
        for (const [name, body] of Object.entries(files)) {
            if (!name.startsWith('json/') || name === 'json/restaurant.json') continue;
            for (const row of JSON.parse(body)) {
                if (row && row.restaurant !== undefined && row.restaurant !== null) expect(String(row.restaurant)).toBe(String(A.restaurant._id));
            }
        }
    });

    test('users.json has staff only: no customers, no superadmins, no password hash, no 2FA secret / recovery hashes', () => {
        const users = JSON.parse(files['json/users.json']);
        for (const u of users) {
            expect(['customer', 'superadmin']).not.toContain(u.role);
            expect(u.password).toBeUndefined();
            expect(u.twoFactor?.secretEnc).toBeUndefined();
            expect(u.twoFactor?.recoveryHashes).toBeUndefined();
        }
        expect(files['json/users.json']).not.toMatch(/\$2[aby]\$\d\d\$/);
    });

    test('Regression (fixed 2026-11): export bundle ships customers\' password-reset token hashes (security material)', () => {
        // controllers/tenantExportController.js discoverTenantModels() exports every model with a
        // `restaurant` path minus a one-entry DENYLIST (IdempotencyRecord). PasswordResetToken has a
        // `restaurant` path, so passwordresettokens.json contains tokenHash rows for CUSTOMERS of the
        // tenant even though the README promises "no customers, no password hashes". Also at risk:
        // any future model with credential-like fields is exported by default (deny-list, not allow-list).
        const blob = Object.entries(files).filter(([n]) => n.endsWith('.json')).map(([, v]) => v).join('\n');
        expect(blob).not.toContain(seededResetToken.tokenHash);
    });

    test('Regression (fixed 2026-11): restaurant.json leaks platform-internal fields set by the Super Admin (paymentNote, signup review fields)', () => {
        // The raw Restaurant document is exported (`Restaurant.findById(...).lean()`), so
        // Super-Admin-only back-office fields reach the tenant.
        expect(files['json/restaurant.json']).not.toContain('PLATFORM-INTERNAL-NOTE-QQ');
    });

    test('export is bound to the CALLER tenant: B-selecting headers / query on A\'s export change nothing', async () => {
        const res = await exportZip(A.users.admin, { 'X-Restaurant-Slug': B.slug, 'X-Restaurant-Id': String(B.restaurant._id) });
        expect(res.status).toBe(200);
        const again = await readAll(res.body);
        expect(JSON.parse(again['manifest.json']).restaurant.slug).toBe(A.slug);
        await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { lastExportAt: null } });
        const q = await ctx.api.raw.get(`${V1}/tenant/export?restaurant=${B.slug}&restaurantId=${B.restaurant._id}`)
            .set('Authorization', `Bearer ${A.users.admin.token}`).buffer(true).parse(binary);
        expect(JSON.parse((await readAll(q.body))['manifest.json']).restaurant.slug).toBe(A.slug);
    });

    test('B export is symmetrical: contains none of A', async () => {
        const res = await exportZip(B.users.admin);
        expect(res.status).toBe(200);
        const f = await readAll(res.body);
        const blob = Object.entries(f).filter(([n]) => !n.endsWith('.xlsx')).map(([, v]) => v).join('\n');
        for (const needle of [String(A.restaurant._id), A.slug, A.users.admin.email, orderA.orderId, String(A.items.paneer._id)]) {
            expect(blob).not.toContain(needle);
        }
    });

    test('cooldown is per tenant: A\'s export does not block B and a 2nd A call is 429', async () => {
        await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { lastExportAt: new Date() } });
        await Restaurant.updateOne({ _id: B.restaurant._id }, { $set: { lastExportAt: null } });
        const a2 = await ctx.api.raw.get(`${V1}/tenant/export`).set('Authorization', `Bearer ${A.users.admin.token}`);
        expect(a2.status).toBe(429);
        const b1 = await ctx.api.raw.get(`${V1}/tenant/export`).set('Authorization', `Bearer ${B.users.admin.token}`).buffer(true).parse(binary);
        expect(b1.status).toBe(200);
    });

    test('only the OWNER can export: waiter, manager, sub-admin, customer, guest and platform admin are refused', async () => {
        const sub = await createUser({ name: 'S', email: `sub.${Date.now()}@s.test`, role: 'admin', restaurant: A.restaurant._id, branch: A.branch._id, isTenantOwner: false });
        const mgr = await createUser({ name: 'M', email: `mgr.${Date.now()}@s.test`, role: 'manager', restaurant: A.restaurant._id, branch: null });
        const cust = await createCustomer('ex-exp');
        for (const u of [A.users.waiter, A.users.chef, A.users.captain, sub, mgr]) {
            expect((await as(u).get('/tenant/export')).status).toBe(403);
        }
        expect([401, 403]).toContain((await as(cust, { 'X-Restaurant-Slug': A.slug }).get('/tenant/export')).status);
        expect((await ctx.api.guest(A).get('/tenant/export')).status).toBeGreaterThanOrEqual(401);
    });

    test('a suspended tenant cannot export (blocked at tenant resolution)', async () => {
        const S = await seedTenant({ label: 'ex-susp' });
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'cancelled' } });
        expect((await as(S.users.admin).get('/tenant/export')).status).toBe(403);
    });
});

// ───────────────────────── developerRoute ─────────────────────────

describe('developerRoute (API keys + webhooks)', () => {
    test('A owner can neither list, rotate nor revoke B\'s API keys / webhooks', async () => {
        const { prefix, hash } = generateApiKey();
        const bKey = await ApiKey.create({ restaurant: B.restaurant._id, name: 'B key', prefix, hash, scopes: ['read:orders'] });
        const list = await as(A.users.admin).get('/developer/api-keys');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain(String(bKey._id));
        expect(text(list)).not.toContain(prefix);
        expect((await as(A.users.admin).post(`/developer/api-keys/${bKey._id}/rotate`)).status).toBe(404);
        expect((await as(A.users.admin).delete(`/developer/api-keys/${bKey._id}`)).status).toBe(404);
        const fresh = await ApiKey.findById(bKey._id).setOptions({ skipTenantScope: true }).select('+hash').lean();
        expect(fresh.hash).toBe(hash);
        expect(fresh.revokedAt || null).toBeNull();
    });

    test('keys listed to the owner never include the secret hash', async () => {
        const created = await as(A.users.admin).post('/developer/api-keys').send({ name: 'mine', scopes: ['read:orders'] });
        expect(created.status).toBe(201);
        const list = await as(A.users.admin).get('/developer/api-keys');
        expect(text(list)).not.toContain('"hash"');
        expect(text(list)).not.toContain(created.body.key.split('_')[3]);
    });

    test('webhook endpoints / deliveries of B are not reachable by A (ids)', async () => {
        const WebhookEndpoint = req_('models/webhookEndpoint');
        const ep = await WebhookEndpoint.create({ restaurant: B.restaurant._id, url: 'https://hooks.example.test/b', secret: 'whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbb', events: ['order.created'] });
        const dl = await as(A.users.admin).get(`/developer/webhooks/${ep._id}/deliveries`);
        expect(dl.status === 404 || (dl.status === 200 && dl.body.deliveries.length === 0)).toBe(true);
        for (const [m, p] of [['post', `/developer/webhooks/${ep._id}/rotate-secret`], ['post', `/developer/webhooks/${ep._id}/test`], ['delete', `/developer/webhooks/${ep._id}`]]) {
            const res = await as(A.users.admin)[m](p).send({});
            expect([403, 404]).toContain(res.status);
        }
        const list = await as(A.users.admin).get('/developer/webhooks');
        expect(text(list)).not.toContain(String(ep._id));
        const still = await WebhookEndpoint.findById(ep._id).setOptions({ skipTenantScope: true }).select('+secret').lean();
        expect(still.secret).toBe('whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });
});

// ───────────────────────── platform "login as" / impersonation ─────────────────────────

describe('impersonation / "login as" flows', () => {
    test('no impersonation or login-as endpoint exists for tenant or platform callers', async () => {
        const root = await createUser({ name: 'Root', email: `root.imp.${Date.now()}@p.test`, role: 'superadmin', superadminLevel: 'full' });
        const paths = [
            ['post', '/superadmin/impersonate'], ['post', `/superadmin/restaurants/${B.restaurant._id}/impersonate`],
            ['post', `/superadmin/restaurants/${B.restaurant._id}/login-as`], ['post', '/superadmin/login-as'],
            ['post', '/auth/impersonate'], ['post', '/auth/login-as'], ['post', `/staff/${B.users.admin._id}/impersonate`],
        ];
        for (const [m, p] of paths) {
            for (const actor of [A.users.admin, root]) {
                const res = await as(actor)[m](p).send({ userId: String(B.users.admin._id) });
                expect([400, 401, 403, 404]).toContain(res.status);
                expect(res.body.token || res.body.accessToken).toBeUndefined();
            }
        }
    });

    test('A owner cannot mint a session for B staff through password-reset / reset-2fa / staff routes', async () => {
        const before = await User.findById(B.users.admin._id).select('+password').lean();
        const r1 = await as(A.users.admin).post('/auth/2fa/reset').send({ userId: String(B.users.admin._id) });
        expect([403, 404]).toContain(r1.status);
        const r2 = await as(A.users.admin).post(`/staff/${B.users.waiter._id}/reset-password`).send({});
        expect([403, 404]).toContain(r2.status);
        const r3 = await as(A.users.admin).put(`/staff/${B.users.admin._id}`).send({ role: 'admin', email: 'pwn@evil.test', password: 'Pwn#Pass12345' });
        expect([403, 404]).toContain(r3.status);
        const after = await User.findById(B.users.admin._id).select('+password').lean();
        expect(after.email).toBe(before.email);
        expect(after.password).toBe(before.password);
        expect(Number(after.tokenVersion) || 0).toBe(Number(before.tokenVersion) || 0);
    });

    test('a tenant admin\'s token is not accepted on /superadmin even when it carries platform-looking headers', async () => {
        const res = await as(A.users.admin, { 'X-Superadmin-Level': 'full', 'X-Impersonate-Restaurant': String(B.restaurant._id) }).get('/superadmin/restaurants');
        expect(res.status).toBe(403);
    });
});
