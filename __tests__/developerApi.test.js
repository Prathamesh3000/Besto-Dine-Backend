/**
 * Developers admin endpoints (API keys + webhooks) and the read-only
 * public API router. Models are spied (no database); the express apps are
 * tiny harnesses around the real controllers / router.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/rateLimitStore', () => ({ makeLimiter: () => (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const ApiKey = require('../models/apiKey');
const WebhookEndpoint = require('../models/webhookEndpoint');
const WebhookDelivery = require('../models/webhookDelivery');
const Restaurant = require('../models/restaurant');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const Inventory = require('../models/inventory');
const AdvanceBooking = require('../models/advanceBooking');
const Category = require('../models/category');
const { generateApiKey, sha256Hex, parseApiKey } = require('../utils/apiKeys');
const { hasFeature } = require('../utils/featureAccess');
const { GOLD_FEATURES, SILVER_FEATURES, PREMIUM_FEATURES } = require('../config/planLineup');

const RID = '64b000000000000000000001';
const oid = (n) => `64c00000000000000000000${n}`;

afterEach(() => jest.restoreAllMocks());

// ─── Feature gating ─────────────────────────────────────────────────────
describe('publicApi feature', () => {
    test('Silver off; Gold and Premium on; add-on and override can grant it', () => {
        expect(SILVER_FEATURES.publicApi).toBe(false);
        expect(GOLD_FEATURES.publicApi).toBe(true);
        expect(PREMIUM_FEATURES.publicApi).toBe(true);
        const silver = { subscription: { features: { publicApi: false } } };
        expect(hasFeature(silver, 'publicApi')).toBe(false);
        expect(hasFeature({ ...silver, addons: [{ key: 'publicApi', status: 'active' }] }, 'publicApi')).toBe(true);
        expect(hasFeature({ ...silver, featureOverrides: { publicApi: true } }, 'publicApi')).toBe(true);
        expect(hasFeature({ subscription: { features: { publicApi: true } }, featureOverrides: { publicApi: false } }, 'publicApi')).toBe(false);
    });

    test('is a plan feature key and an add-on in the catalog', () => {
        const SubscriptionPlan = require('../models/subscriptionPlan');
        expect(SubscriptionPlan.schema.path('features.publicApi')).toBeDefined();
        expect(require('../utils/featureAccess').ADDON_CATALOG.publicApi).toBeDefined();
    });
});

// ─── Management endpoints ───────────────────────────────────────────────
// The real router starts with protect/adminExclusive/attachTenant (JWT); wire
// the same handlers behind a fake auth so the controller logic is exercised.
function controllerApp(restaurantId = RID) {
    const c = require('../controllers/developerController');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.restaurant = { _id: restaurantId }; req.user = { _id: oid(9), role: 'admin' }; next(); });
    app.get('/meta', c.meta);
    app.get('/api-keys', c.listKeys);
    app.post('/api-keys', c.createKey);
    app.delete('/api-keys/:id', c.revokeKey);
    app.post('/api-keys/:id/rotate', c.rotateKey);
    app.get('/webhooks', c.listEndpoints);
    app.post('/webhooks', c.createEndpoint);
    app.patch('/webhooks/:id', c.updateEndpoint);
    app.delete('/webhooks/:id', c.deleteEndpoint);
    app.post('/webhooks/:id/test', c.sendTest);
    app.get('/webhooks/:id/deliveries', c.listDeliveries);
    app.post('/webhook-deliveries/:id/redeliver', c.redeliver);
    return app;
}

describe('developer route wiring', () => {
    test('router is owner-only, tenant-attached and feature-gated before any handler', () => {
        const route = require('../routes/developerRoute');
        const names = route.stack.slice(0, 4).map((l) => l.handle.name || 'anonymous');
        expect(names[0]).toBe('protect');
        expect(names[1]).toBe('adminExclusive');
        expect(names[2]).toBe('attachTenant');
        expect(route.stack.filter((l) => l.route).length).toBeGreaterThanOrEqual(12);
        // everything after the 4 guards is a real route
        expect(route.stack.slice(0, 4).every((l) => !l.route)).toBe(true);
    });
});

describe('API key management', () => {
    test('create: validates scopes / name, returns the key once, stores only prefix + hash, tenant-scoped', async () => {
        jest.spyOn(ApiKey, 'countDocuments').mockResolvedValue(0);
        const create = jest.spyOn(ApiKey, 'create').mockImplementation(async (d) => ({ ...d, _id: oid(1), createdAt: new Date() }));
        const app = controllerApp();

        expect((await request(app).post('/api-keys').send({ scopes: ['read:orders'] })).status).toBe(400);
        expect((await request(app).post('/api-keys').send({ name: 'x', scopes: [] })).status).toBe(400);
        expect((await request(app).post('/api-keys').send({ name: 'x', scopes: ['write:orders'] })).status).toBe(400);
        expect((await request(app).post('/api-keys').send({ name: 'x', scopes: ['read:orders'], expiresInDays: 0 })).status).toBe(400);

        const res = await request(app).post('/api-keys').send({ name: 'Zapier', scopes: ['read:orders', 'read:menu'], expiresInDays: 30 });
        expect(res.status).toBe(201);
        expect(res.body.key).toMatch(/^bd_live_/);
        const stored = create.mock.calls[0][0];
        expect(String(stored.restaurant)).toBe(RID);
        expect(stored.hash).toBe(sha256Hex(parseApiKey(res.body.key).secret));
        expect(JSON.stringify(stored)).not.toContain(parseApiKey(res.body.key).secret);
        expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(res.body.apiKey.hash).toBeUndefined();
        expect(JSON.stringify(res.body.apiKey)).not.toContain(parseApiKey(res.body.key).secret);
    });

    test('create: enforces the active-key cap', async () => {
        jest.spyOn(ApiKey, 'countDocuments').mockResolvedValue(20);
        const res = await request(controllerApp()).post('/api-keys').send({ name: 'x', scopes: ['read:menu'] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('KEY_LIMIT');
    });

    test('list: tenant filter, never returns secret or hash, shows status', async () => {
        const gen = generateApiKey();
        const find = jest.spyOn(ApiKey, 'find').mockReturnValue({ sort: () => ({ lean: async () => [
            { _id: oid(1), name: 'A', prefix: gen.prefix, hash: gen.hash, scopes: ['read:menu'], revokedAt: null, expiresAt: null, createdAt: new Date() },
            { _id: oid(2), name: 'B', prefix: 'abcdef1234', hash: 'h', scopes: [], revokedAt: new Date(), createdAt: new Date() },
            { _id: oid(3), name: 'C', prefix: '1234abcdef', hash: 'h', scopes: [], expiresAt: new Date(Date.now() - 1000), createdAt: new Date() },
        ] }) });
        const res = await request(controllerApp()).get('/api-keys');
        expect(find).toHaveBeenCalledWith({ restaurant: RID });
        expect(res.body.keys.map((k) => k.status)).toEqual(['active', 'revoked', 'expired']);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(gen.hash);
        expect(text).not.toMatch(/"hash"|"secret"/);
        expect(res.body.keys[0].masked).toBe(`bd_live_${gen.prefix}_********`);
    });

    test('revoke: scoped to the tenant; unknown / foreign / already revoked -> 404', async () => {
        const upd = jest.spyOn(ApiKey, 'findOneAndUpdate').mockResolvedValueOnce({ _id: oid(1), name: 'A', prefix: 'p', scopes: [], revokedAt: new Date() }).mockResolvedValueOnce(null);
        const app = controllerApp();
        const ok = await request(app).delete(`/api-keys/${oid(1)}`);
        expect(ok.status).toBe(200);
        expect(ok.body.apiKey.status).toBe('revoked');
        expect(upd.mock.calls[0][0]).toEqual({ _id: oid(1), restaurant: RID, revokedAt: null });
        expect((await request(app).delete(`/api-keys/${oid(1)}`)).status).toBe(404);
        expect((await request(app).delete('/api-keys/not-an-id')).status).toBe(404);
    });

    test('rotate: new prefix + hash on the same record, new key returned once, old one replaced', async () => {
        const upd = jest.spyOn(ApiKey, 'findOneAndUpdate').mockImplementation(async (f, u) => ({ _id: oid(1), name: 'A', scopes: ['read:menu'], ...u.$set, createdAt: new Date() }));
        const res = await request(controllerApp()).post(`/api-keys/${oid(1)}/rotate`);
        expect(res.status).toBe(200);
        const { prefix, secret } = parseApiKey(res.body.key);
        expect(upd.mock.calls[0][0]).toEqual({ _id: oid(1), restaurant: RID, revokedAt: null });
        expect(upd.mock.calls[0][1].$set).toMatchObject({ prefix, hash: sha256Hex(secret) });
        expect(res.body.apiKey.prefix).toBe(prefix);
    });
});

describe('webhook endpoint management', () => {
    test('create: https-only + SSRF-screened URL, events validated, secret returned once and not in the view', async () => {
        jest.spyOn(WebhookEndpoint, 'countDocuments').mockResolvedValue(0);
        const create = jest.spyOn(WebhookEndpoint, 'create').mockImplementation(async (d) => ({ ...d, _id: oid(1), active: true, createdAt: new Date() }));
        const app = controllerApp();
        for (const url of ['http://example.com/h', 'https://127.0.0.1/h', 'https://169.254.169.254/', 'https://localhost/h']) {
            expect((await request(app).post('/webhooks').send({ url, events: ['order.paid'] })).status).toBe(400);
        }
        expect((await request(app).post('/webhooks').send({ url: 'https://hooks.example.com/h', events: ['nope'] })).status).toBe(400);
        expect((await request(app).post('/webhooks').send({ url: 'https://hooks.example.com/h', events: [] })).status).toBe(400);

        const res = await request(app).post('/webhooks').send({ url: 'https://hooks.example.com/h', events: ['order.paid', 'stock.low'], description: 'ERP' });
        expect(res.status).toBe(201);
        expect(res.body.secret).toMatch(/^whsec_/);
        expect(String(create.mock.calls[0][0].restaurant)).toBe(RID);
        expect(res.body.endpoint.secret).toBeUndefined();
        expect(JSON.stringify(res.body.endpoint)).not.toContain(res.body.secret);
    });

    test('list: tenant filter and no secrets', async () => {
        const find = jest.spyOn(WebhookEndpoint, 'find').mockReturnValue({ sort: () => ({ lean: async () => [
            { _id: oid(1), url: 'https://a.example.com', secret: 'whsec_leak', events: ['order.paid'], active: false, consecutiveFailures: 10, disabledAt: new Date(), disabledReason: 'Disabled after 10 consecutive failed deliveries.' },
        ] }) });
        const res = await request(controllerApp()).get('/webhooks');
        expect(find).toHaveBeenCalledWith({ restaurant: RID });
        expect(JSON.stringify(res.body)).not.toContain('whsec_leak');
        expect(res.body.endpoints[0]).toMatchObject({ active: false, consecutiveFailures: 10, disabledReason: expect.stringMatching(/Disabled/) });
    });

    test('re-enabling resets the failure counter and disabled markers', async () => {
        const upd = jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockImplementation(async (f, u) => ({ _id: oid(1), url: 'https://a.example.com', events: [], ...u.$set }));
        const res = await request(controllerApp()).patch(`/webhooks/${oid(1)}`).send({ active: true });
        expect(res.status).toBe(200);
        expect(upd.mock.calls[0][0]).toEqual({ _id: oid(1), restaurant: RID });
        expect(upd.mock.calls[0][1].$set).toMatchObject({ active: true, consecutiveFailures: 0, disabledAt: null, disabledReason: '' });
        expect((await request(controllerApp()).patch(`/webhooks/${oid(1)}`).send({ url: 'http://bad.example.com' })).status).toBe(400);
        expect((await request(controllerApp()).patch(`/webhooks/${oid(1)}`).send({})).status).toBe(400);
    });

    test('delete is tenant-scoped; foreign id -> 404', async () => {
        const del = jest.spyOn(WebhookEndpoint, 'findOneAndDelete').mockResolvedValueOnce({ _id: oid(1) }).mockResolvedValueOnce(null);
        jest.spyOn(WebhookDelivery, 'deleteMany').mockResolvedValue({});
        const app = controllerApp();
        expect((await request(app).delete(`/webhooks/${oid(1)}`)).status).toBe(200);
        expect(del.mock.calls[0][0]).toEqual({ _id: oid(1), restaurant: RID });
        expect((await request(app).delete(`/webhooks/${oid(2)}`)).status).toBe(404);
    });

    test('send-test: signs + sends a webhook.test event, reports the result, does not count failures', async () => {
        const ep = { _id: oid(1), restaurant: RID, url: 'https://127.0.0.1/blocked', secret: 'whsec_x', active: true, toObject() { return { ...this, toObject: undefined }; } };
        jest.spyOn(WebhookEndpoint, 'findOne').mockReturnValue({ select: async () => ep });
        const create = jest.spyOn(WebhookDelivery, 'create').mockImplementation(async (d) => ({ ...d, _id: oid(5), createdAt: new Date() }));
        jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
        const fou = jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockResolvedValue({});
        const res = await request(controllerApp()).post(`/webhooks/${oid(1)}/test`);
        expect(res.status).toBe(200);
        expect(create.mock.calls[0][0]).toMatchObject({ type: 'webhook.test', restaurant: RID });
        expect(res.body.result.ok).toBe(false);          // loopback target is blocked by the SSRF guard
        expect(res.body.delivery.status).toBe('failed'); // no retry for tests
        expect(fou).not.toHaveBeenCalled();
    });

    test('deliveries log: tenant + endpoint filter, payload omitted', async () => {
        const find = jest.spyOn(WebhookDelivery, 'find').mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
            { _id: oid(5), endpoint: oid(1), eventId: 'evt_1', type: 'order.paid', status: 'failed', attempts: 6, responseCode: 500, lastError: 'HTTP 500', createdAt: new Date() },
        ] }) }) }) });
        const res = await request(controllerApp()).get(`/webhooks/${oid(1)}/deliveries?status=failed`);
        expect(find).toHaveBeenCalledWith({ restaurant: RID, endpoint: oid(1), status: 'failed' });
        expect(res.body.deliveries[0]).toMatchObject({ status: 'failed', attempts: 6, responseCode: 500 });
        expect(res.body.deliveries[0].payload).toBeUndefined();
    });

    test('redeliver: refuses a disabled endpoint, otherwise resets attempts and resends', async () => {
        const mkDelivery = () => ({ _id: oid(5), restaurant: RID, endpoint: oid(1), type: 'order.paid', payload: { id: 'evt_1' }, attempts: 6, status: 'failed', save: jest.fn(async () => {}) });
        const dlv = mkDelivery();
        jest.spyOn(WebhookDelivery, 'findOne').mockResolvedValue(dlv);
        const epFind = jest.spyOn(WebhookEndpoint, 'findOne');
        epFind.mockReturnValueOnce({ select: async () => ({ _id: oid(1), restaurant: RID, active: false, toObject() { return {}; } }) });
        expect((await request(controllerApp()).post(`/webhook-deliveries/${oid(5)}/redeliver`)).status).toBe(409);

        epFind.mockReturnValueOnce({ select: async () => ({ _id: oid(1), restaurant: RID, url: 'https://10.0.0.1/x', secret: 's', active: true, toObject() { return { _id: oid(1), restaurant: RID, url: 'https://10.0.0.1/x', secret: 's', active: true }; } }) });
        jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
        jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockResolvedValue({});
        const res = await request(controllerApp()).post(`/webhook-deliveries/${oid(5)}/redeliver`);
        expect(res.status).toBe(200);
        expect(dlv.save).toHaveBeenCalled();
        expect(res.body.delivery.attempts).toBe(1);
    });
});

// ─── Public API v1 ──────────────────────────────────────────────────────
describe('public API v1 router', () => {
    let issued; let keyDoc; let restaurant;
    const app = () => {
        const a = express();
        a.use('/api/public/v1', require('../routes/publicApiRoute'));
        return a;
    };
    const auth = () => ({ Authorization: `Bearer ${issued.key}` });
    const chain = (rows) => {
        const q = { sort: () => q, skip: () => q, limit: () => q, select: () => q, lean: async () => rows };
        return q;
    };

    beforeEach(() => {
        issued = generateApiKey();
        keyDoc = { _id: oid(1), restaurant: RID, name: 'K', prefix: issued.prefix, hash: issued.hash,
            scopes: ['read:orders', 'read:menu', 'read:sales', 'read:inventory', 'read:bookings'], revokedAt: null, expiresAt: null, lastUsedAt: new Date() };
        restaurant = { _id: RID, status: 'active', timezone: 'Asia/Kolkata', subscription: { features: { publicApi: true } } };
        jest.spyOn(ApiKey, 'findOne').mockImplementation((q) => ({ select: () => ({ setOptions: () => Promise.resolve(q.prefix === keyDoc.prefix ? keyDoc : null) }) }));
        jest.spyOn(Restaurant, 'findById').mockImplementation(() => Promise.resolve(restaurant));
    });

    test('no key -> 401; wrong scope -> 403; non-GET -> 405; unknown path -> 404', async () => {
        expect((await request(app()).get('/api/public/v1/orders')).status).toBe(401);
        keyDoc.scopes = ['read:menu'];
        expect((await request(app()).get('/api/public/v1/orders').set(auth())).status).toBe(403);
        expect((await request(app()).post('/api/public/v1/orders').set(auth())).status).toBe(405);
        expect((await request(app()).get('/api/public/v1/nothing').set(auth())).status).toBe(404);
    });

    test('revoked key is rejected on a real route', async () => {
        keyDoc.revokedAt = new Date();
        const res = await request(app()).get('/api/public/v1/menu').set(auth());
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('API_KEY_REVOKED');
    });

    test('GET /orders: tenant from the key, filters + pagination, stable field names, no internal fields', async () => {
        const find = jest.spyOn(Order, 'find').mockReturnValue(chain([{
            orderId: 'ORD-0001', type: 'dine-in', source: 'staff', status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash',
            customerName: 'Asha', phone: '9999999999', total: 450, gst: 22.5, amountPaid: 450,
            items: [{ name: 'Paneer', quantity: 2, price: 200, category: 'Main' }],
            guestAccess: { tokenHash: 'SECRET_HASH' }, clientIdempotencyKey: 'IDEM', scanSessionId: 'SCAN', razorpayPaymentId: 'pay_x',
            createdAt: new Date('2026-10-01T10:00:00Z'), paidAt: new Date('2026-10-01T10:30:00Z'),
        }]));
        const count = jest.spyOn(Order, 'countDocuments').mockResolvedValue(120);
        const res = await request(app())
            .get('/api/public/v1/orders?status=served&payment_status=Paid&from=2026-10-01&to=2026-10-31&page=2&limit=50')
            .set(auth()).set('X-Restaurant-Slug', 'someone-else');
        expect(res.status).toBe(200);
        const filter = find.mock.calls[0][0];
        expect(String(filter.restaurant)).toBe(RID);
        expect(filter).toMatchObject({ status: 'served', paymentStatus: 'Paid' });
        expect(filter.createdAt.$gte.toISOString()).toBe('2026-10-01T00:00:00.000Z');
        expect(filter.createdAt.$lte.toISOString()).toBe('2026-10-31T23:59:59.999Z');
        expect(count.mock.calls[0][0]).toEqual(filter);
        expect(res.body.pagination).toEqual({ page: 2, limit: 50, total: 120, has_more: true });
        const o = res.body.data[0];
        expect(o).toMatchObject({ id: 'ORD-0001', status: 'served', payment_status: 'Paid', total: 450, customer_name: 'Asha' });
        expect(o.items).toEqual([{ name: 'Paneer', quantity: 2, price: 200, category: 'Main' }]);
        const text = JSON.stringify(res.body);
        for (const leak of ['SECRET_HASH', 'IDEM', 'SCAN', 'pay_x', '9999999999', 'guestAccess', 'tokenHash']) expect(text).not.toContain(leak);
    });

    test('GET /orders: bad filters -> 400; limit capped at 100', async () => {
        const find = jest.spyOn(Order, 'find').mockReturnValue(chain([]));
        jest.spyOn(Order, 'countDocuments').mockResolvedValue(0);
        expect((await request(app()).get('/api/public/v1/orders?status=bogus').set(auth())).status).toBe(400);
        expect((await request(app()).get('/api/public/v1/orders?from=banana').set(auth())).body.code).toBe('INVALID_DATE');
        expect((await request(app()).get('/api/public/v1/orders?from=2026-10-10&to=2026-10-01').set(auth())).body.code).toBe('INVALID_RANGE');
        expect((await request(app()).get('/api/public/v1/orders?from=2020-01-01&to=2026-10-01').set(auth())).body.code).toBe('RANGE_TOO_LARGE');
        expect((await request(app()).get('/api/public/v1/orders?branch_id=zzz').set(auth())).body.code).toBe('INVALID_BRANCH');
        const ok = await request(app()).get('/api/public/v1/orders?limit=9999').set(auth());
        expect(ok.body.pagination.limit).toBe(100);
        expect(find).toHaveBeenCalled();
    });

    test('GET /orders/:id is scoped to the key tenant: other tenant order -> 404', async () => {
        const findOne = jest.spyOn(Order, 'findOne').mockReturnValue({ lean: async () => null });
        const res = await request(app()).get('/api/public/v1/orders/ORD-9999').set(auth());
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ORDER_NOT_FOUND');
        expect(findOne.mock.calls[0][0]).toMatchObject({ orderId: 'ORD-9999' });
        expect(String(findOne.mock.calls[0][0].restaurant)).toBe(RID);
        findOne.mockReturnValue({ lean: async () => ({ orderId: 'ORD-1', status: 'new', paymentStatus: 'Pending', total: 10, items: [] }) });
        const ok = await request(app()).get('/api/public/v1/orders/ORD-1').set(auth());
        expect(ok.body.data.id).toBe('ORD-1');
    });

    test('GET /menu: active items of the tenant with category names', async () => {
        const find = jest.spyOn(MenuItem, 'find').mockReturnValue(chain([{ _id: oid(7), name: 'Dosa', category: oid(8), description: 'Crisp', basePrice: 100, finalPrice: 90, offerPercentage: 10, vegType: 'veg', inStock: true, images: ['a.png'], sizes: [], hsnCode: '1234', branchPrices: [{ price: 1 }] }]));
        jest.spyOn(MenuItem, 'countDocuments').mockResolvedValue(1);
        jest.spyOn(Category, 'find').mockReturnValue(chain([{ _id: oid(8), name: 'Breakfast' }]));
        const res = await request(app()).get('/api/public/v1/menu?in_stock=true').set(auth());
        expect(find.mock.calls[0][0]).toMatchObject({ status: 'active', inStock: true });
        expect(String(find.mock.calls[0][0].restaurant)).toBe(RID);
        expect(res.body.data[0]).toMatchObject({ name: 'Dosa', category: 'Breakfast', final_price: 90, base_price: 100 });
        expect(JSON.stringify(res.body)).not.toMatch(/hsnCode|branchPrices|1234/);
    });

    test('GET /sales/summary: paid, non-cancelled orders of the tenant; default 30-day window', async () => {
        const agg = jest.spyOn(Order, 'aggregate')
            .mockResolvedValueOnce([{ _id: null, revenue: 1000, orders: 4, refunded: 50 }])
            .mockResolvedValueOnce([{ _id: '2026-10-01', revenue: 600, orders: 2 }])
            .mockResolvedValueOnce([{ _id: 'Dosa', quantity: 9, revenue: 810 }]);
        const res = await request(app()).get('/api/public/v1/sales/summary').set(auth());
        expect(res.status).toBe(200);
        const match = agg.mock.calls[0][0][0].$match;
        expect(String(match.restaurant)).toBe(RID);
        expect(match).toMatchObject({ paymentStatus: 'Paid', status: { $nin: ['cancelled', 'awaiting-payment'] } });
        expect(match.createdAt.$gte).toBeInstanceOf(Date);
        for (const call of agg.mock.calls) expect(String(call[0][0].$match.restaurant)).toBe(RID);
        expect(res.body.data).toMatchObject({ revenue: 1000, orders: 4, average_order_value: 250, refunded: 50, timezone: 'Asia/Kolkata' });
        expect(res.body.data.daily).toEqual([{ date: '2026-10-01', revenue: 600, orders: 2 }]);
        expect(res.body.data.top_items).toEqual([{ name: 'Dosa', quantity: 9, revenue: 810 }]);
    });

    test('GET /inventory/low-stock: tenant + stock <= min, history not exposed', async () => {
        const find = jest.spyOn(Inventory, 'find').mockReturnValue(chain([{ itemId: 'INV-001', name: 'Rice', category: 'Raw Ingredients', unit: 'kg', currentStock: 2, minStock: 5, status: 'low-stock', costPerUnit: 55, supplier: { name: 'ACME', contact: '1' }, adjustmentHistory: [{ reason: 'x' }] }]));
        jest.spyOn(Inventory, 'countDocuments').mockResolvedValue(1);
        const res = await request(app()).get('/api/public/v1/inventory/low-stock').set(auth());
        expect(String(find.mock.calls[0][0].restaurant)).toBe(RID);
        expect(find.mock.calls[0][0].$expr).toBeDefined();
        expect(res.body.data[0]).toMatchObject({ id: 'INV-001', current_stock: 2, min_stock: 5 });
        expect(JSON.stringify(res.body)).not.toMatch(/costPerUnit|ACME|adjustmentHistory|supplier/);
    });

    test('GET /bookings: tenant, date + status filters, no customer/payment internals', async () => {
        const find = jest.spyOn(AdvanceBooking, 'find').mockReturnValue(chain([{ bookingId: 'TBL-001', bookingType: 'table', status: 'Confirmed', bookingDate: new Date('2026-11-01'), bookingTime: '7:00 PM', timeSlot: 'Dinner', guestCount: 4, user: oid(3), payment: { advancePaid: 500 }, notes: 'private' }]));
        jest.spyOn(AdvanceBooking, 'countDocuments').mockResolvedValue(1);
        const res = await request(app()).get('/api/public/v1/bookings?status=Confirmed&type=table&from=2026-11-01').set(auth());
        const f = find.mock.calls[0][0];
        expect(String(f.restaurant)).toBe(RID);
        expect(f).toMatchObject({ status: 'Confirmed', bookingType: 'table' });
        expect(f.bookingDate.$gte).toBeInstanceOf(Date);
        expect(res.body.data[0]).toMatchObject({ id: 'TBL-001', guest_count: 4, time_slot: 'Dinner' });
        expect(JSON.stringify(res.body)).not.toMatch(/advancePaid|private|"user"/);
    });
});
