/**
 * The legacy `{ skipTenantScope: true }` option is ignored inside a tenant
 * context. Seven call sites relied on it; each is now either explicit
 * (skipScope() / runAsSystem) or scoped by the right tenant. Every test here
 * runs the code from tenant B's context against tenant A's data - the case
 * that silently broke.
 */
const path = require('path');
const mongoose = require('mongoose');
const { EventEmitter } = require('events');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const req = (p) => require(path.join(BACKEND, p));
const { runAsTenant, runAsSystem } = req('utils/tenantSafe');
const { skipScope } = req('utils/tenantScopePlugin');
const SubscriptionInvoice = req('models/subscriptionInvoice');
const ApiKey = req('models/apiKey');
const Wallet = req('models/wallet');
const Order = req('models/order');
const IncentiveEntry = req('models/incentiveEntry');
const WebhookEndpoint = req('models/webhookEndpoint');
const WebhookDelivery = req('models/webhookDelivery');
const Restaurant = req('models/restaurant');
const Table = req('models/table');

useIntegrationApp();
let A; let B;
beforeAll(async () => {
    A = await seedTenant({ label: 'ssa' });
    B = await seedTenant({ label: 'ssb' });
});

const oid = () => new mongoose.Types.ObjectId();
const inSystem = (fn) => runAsSystem('test', async () => await fn());

describe('legacy skipTenantScope option is inert in a tenant context (baseline)', () => {
    test('option does not escape tenant B, skipScope() does', async () => {
        const pid = `pay_${oid()}`;
        await inSystem(() => SubscriptionInvoice.create({
            restaurant: A.restaurant._id, invoiceNumber: `INV-${pid}`, amount: 100, razorpayPaymentId: pid,
        }));
        const legacy = await runAsTenant(B.restaurant._id, () => SubscriptionInvoice.findOne({ razorpayPaymentId: pid }, null, { skipTenantScope: true }).lean());
        expect(legacy).toBeNull();
        const explicit = await runAsTenant(B.restaurant._id, () => skipScope(SubscriptionInvoice.findOne({ razorpayPaymentId: pid })).lean());
        expect(explicit).toBeTruthy();
    });
});

describe('tenantBillingController.syncFromRazorpay / utils/planPaymentApply idempotency', () => {
    test('a payment already invoiced under another tenant is seen as alreadyInvoiced from a tenant context', async () => {
        const { applyPaidPlanUpgrade } = req('utils/planPaymentApply');
        const pid = `pay_${oid()}`;
        await inSystem(() => SubscriptionInvoice.create({
            restaurant: A.restaurant._id, invoiceNumber: `INV-${pid}`, amount: 100, razorpayPaymentId: pid,
        }));
        const r = await runAsTenant(B.restaurant._id, async () => applyPaidPlanUpgrade({
            restaurant: await Restaurant.findById(B.restaurant._id), payment: { id: pid, amount: 100, status: 'captured' },
        }));
        expect(r).toMatchObject({ applied: false, invoiceCreated: false, alreadyInvoiced: true });
    });

    test('same tenant: still alreadyInvoiced (no regression); no tenant (webhook): works too', async () => {
        const { applyPaidPlanUpgrade } = req('utils/planPaymentApply');
        const pid = `pay_${oid()}`;
        await inSystem(() => SubscriptionInvoice.create({
            restaurant: A.restaurant._id, invoiceNumber: `INV-${pid}`, amount: 100, razorpayPaymentId: pid,
        }));
        const rest = await inSystem(() => Restaurant.findById(A.restaurant._id));
        const own = await runAsTenant(A.restaurant._id, () => applyPaidPlanUpgrade({ restaurant: rest, payment: { id: pid } }));
        expect(own.alreadyInvoiced).toBe(true);
        const none = await applyPaidPlanUpgrade({ restaurant: rest, payment: { id: pid } });
        expect(none.alreadyInvoiced).toBe(true);
    });
});

describe('middlewares/apiKeyAuth: prefix lookup is tenant discovery', () => {
    test('resolves the key owner even when an unrelated tenant context is ambient', async () => {
        const { generateApiKey } = req('utils/apiKeys');
        const { apiKeyAuth } = req('middlewares/apiKeyAuth');
        const { key, prefix, hash } = generateApiKey();
        await inSystem(() => ApiKey.create({ restaurant: A.restaurant._id, name: 'k', prefix, hash, scopes: ['read:menu'] }));
        const r = { headers: { authorization: `Bearer ${key}` }, get(h) { return this.headers[h.toLowerCase()]; }, ip: '127.0.0.1' };
        const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, set() {} };
        let nexted = false;
        await runAsTenant(B.restaurant._id, async () => {
            await apiKeyAuth('read:menu')(r, res, () => { nexted = true; });
        });
        expect(res.body).toBeUndefined();
        expect(nexted).toBe(true);
        expect(String(r.restaurant._id)).toBe(String(A.restaurant._id));
    });
});

describe('models/wallet paise-rounding post hook', () => {
    test('rounds the stored balance for a tenant-context update and a system update', async () => {
        const u1 = oid(); const u2 = oid();
        await inSystem(() => Wallet.create([
            { restaurant: A.restaurant._id, user: u1, balance: 1 },
            { restaurant: A.restaurant._id, user: u2, balance: 1 },
        ]));
        await runAsTenant(A.restaurant._id, () => Wallet.findOneAndUpdate({ user: u1 }, { $set: { balance: 10.123 } }, { returnDocument: 'before' }));
        await inSystem(() => Wallet.findOneAndUpdate({ user: u2 }, { $set: { balance: 20.456 } }, { returnDocument: 'before' }));
        const w1 = await inSystem(() => Wallet.findOne({ user: u1 }).lean());
        const w2 = await inSystem(() => Wallet.findOne({ user: u2 }).lean());
        expect(w1.balance).toBe(10.12);
        expect(w2.balance).toBe(20.46);
    });
});

describe('services/incentiveService', () => {
    const svc = () => req('services/incentiveService');
    async function seedVoid(tenant) {
        const _id = oid();
        await Order.collection.insertOne({ _id, restaurant: tenant.restaurant._id, orderId: `ORD-${_id}`, status: 'cancelled', paymentStatus: 'Pending', updatedAt: new Date() });
        await IncentiveEntry.collection.insertOne({
            restaurant: tenant.restaurant._id, campaign: oid(), order: _id, itemKey: 'k', quantity: 1, rate: 1, amount: 1,
            staff: oid(), staffRole: 'waiter', state: 'pending', day: '2026-01-01',
        });
        return _id;
    }
    const state = (o) => inSystem(() => IncentiveEntry.findOne({ order: o }).lean()).then((e) => e.state);

    test('reconcile reverses voided orders of EVERY tenant even when called from one tenant context', async () => {
        const oa = await seedVoid(A); const ob = await seedVoid(B);
        const out = await runAsTenant(B.restaurant._id, () => svc().reconcile());
        expect(out.reversed).toBeGreaterThanOrEqual(2);
        expect(await state(oa)).toBe('reversed');
        expect(await state(ob)).toBe('reversed');
    });

    test('reconcile({ restaurant }) only touches that tenant', async () => {
        const oa = await seedVoid(A); const ob = await seedVoid(B);
        await svc().reconcile({ restaurant: A.restaurant._id });
        expect(await state(oa)).toBe('reversed');
        expect(await state(ob)).toBe('pending');
    });

    test('reverseIfVoid with the order document reads it under its own tenant', async () => {
        const oa = await seedVoid(A);
        const r = await runAsTenant(A.restaurant._id, () => svc().reverseIfVoid({ _id: oa, restaurant: A.restaurant._id }, 't'));
        expect(r.reversed).toBe(1);
        expect(await state(oa)).toBe('reversed');
    });

    test('reverseIfVoid with a bare id (no context) still resolves the order', async () => {
        const oa = await seedVoid(A);
        const r = await svc().reverseIfVoid(oa, 't');
        expect(r.reversed).toBe(1);
    });
});

describe('utils/webhookService.processDueDeliveries', () => {
    test('retries a due delivery of tenant A when invoked from tenant B context', async () => {
        const svc = req('utils/webhookService');
        const ep = await inSystem(() => WebhookEndpoint.create({
            restaurant: A.restaurant._id, url: 'https://hooks.example.com/in', secret: 's', events: ['order.paid'],
        }));
        await inSystem(() => WebhookDelivery.create({
            restaurant: A.restaurant._id, endpoint: ep._id, eventId: `e${oid()}`, type: 'order.paid', payload: { a: 1 },
            status: 'pending', nextAttemptAt: new Date(Date.now() - 1000),
        }));
        const calls = [];
        const request = (opts, onResponse) => {
            calls.push(opts);
            const r = new EventEmitter();
            r.write = () => {}; r.destroy = () => {};
            r.end = () => setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; onResponse(res); res.emit('end'); });
            return r;
        };
        const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
        const n = await runAsTenant(B.restaurant._id, () => svc.processDueDeliveries({ deps: { lookup, request } }));
        expect(n).toBeGreaterThanOrEqual(1);
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const left = await inSystem(() => WebhookDelivery.countDocuments({ restaurant: A.restaurant._id, status: 'pending' }));
        expect(left).toBe(0);
    });
});

describe('tableController.getTableByToken: tenant discovery', () => {
    test('resolves a table of tenant A from a request carrying tenant B context', async () => {
        const { getTableByToken } = req('controllers/tableController');
        const table = A.tables.main;
        await inSystem(() => Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { status: 'suspended' } }));
        const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        try {
            await runAsTenant(B.restaurant._id, () => getTableByToken({ params: { qrToken: table.qrToken }, query: {}, headers: {} }, res));
        } finally {
            await inSystem(() => Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { status: 'active' } }));
        }
        // 403 TENANT_SUSPENDED proves the table + populated restaurant were found (not the 404 of a scoped miss)
        expect(res.code).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
        expect(await inSystem(() => Table.countDocuments({ qrToken: table.qrToken }))).toBe(1);
    });
});
