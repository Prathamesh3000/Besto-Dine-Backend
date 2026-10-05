/**
 * Tenant self-service billing + plan enforcement, end to end
 * (QA checklist 6.1 / 6.2 / 6.3).
 *
 *   /tenant/billing/plans | upgrade | upgrade/verify | sync | invoices |
 *   invoices/:id/download | downgrade-request | scheduled-downgrade/cancel
 *   + superadmin approve of a tenant downgrade (scheduled → lazy apply)
 *   + plan feature gates / limits on real routes.
 *
 * Razorpay is the shared fail-closed mock (helpers/razorpayMock.js).
 * Units: Razorpay + SubscriptionInvoice amounts are PAISE, plan prices
 * are RUPEES.
 *
 * Tests named "BUG: ..." fail against the current source on purpose and
 * document a real defect (root cause in the comment above each).
 * verifyUpgradePayment's signature / tenant / replay guards are covered
 * by __tests__/tenantBillingVerify.test.js and not repeated.
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const PlanChangeRequest = require(path.join(BACKEND, 'models/planChangeRequest'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const { applyPaidPlanUpgrade } = require(path.join(BACKEND, 'utils/planPaymentApply'));

const ctx = useIntegrationApp();

let plans;
let superadmin;

const DAY = 24 * 60 * 60 * 1000;

const sign = (orderId, paymentId) => crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

/** Stamp a plan snapshot onto a tenant (what assignPlan / approval do). */
async function putOnPlan(tenant, plan, extra = {}) {
    const p = plan.toObject();
    await Restaurant.updateOne({ _id: tenant.restaurant._id }, {
        $set: {
            subscription: {
                plan: p._id, planName: p.name, planSlug: p.slug, price: p.price,
                features: p.features, limits: p.limits, status: 'active', ...extra,
            },
        },
    });
}

const sub = async (tenant) => (await Restaurant.findById(tenant.restaurant._id).lean()).subscription;

const owner = (tenant) => ctx.api.as(tenant.users.admin);

/** Stub the fallback (Orders API) path: plan sync 401s, customer + order succeed. */
function stubFallbackOrder(orderId = 'order_fb_1') {
    rzp.instance.plans.create.mockRejectedValue({ statusCode: 401, error: { description: 'Subscriptions not enabled' } });
    rzp.instance.customers.create.mockResolvedValue({ id: 'cust_fb' });
    rzp.instance.orders.create.mockImplementation(async (args) => ({ id: orderId, amount: args.amount, currency: args.currency }));
}

beforeAll(async () => {
    plans = {
        free: await SubscriptionPlan.create({ name: 'Free', slug: 'free-sb', price: 0, sortOrder: 0 }),
        basic: await SubscriptionPlan.create({
            name: 'Basic', slug: 'basic-sb', price: 999, sortOrder: 1,
            features: { dineIn: true, takeaway: true },
            limits: { maxBranches: 1, maxTables: 2, maxStaff: 4, maxMenuItems: 3 },
        }),
        pro: await SubscriptionPlan.create({
            name: 'Pro', slug: 'pro-sb', price: 1999, sortOrder: 2, razorpayPlanId: 'plan_pro_rzp',
            features: { dineIn: true, takeaway: true, crm: true, inventory: true, multiBranch: true, revenueAnalytics: 'advanced' },
            limits: { maxBranches: 3, maxTables: 50, maxStaff: 20, maxMenuItems: 400 },
        }),
        // Never synced to Razorpay → upgrade goes through the Orders fallback.
        premium: await SubscriptionPlan.create({
            name: 'Premium', slug: 'premium-sb', price: 2999, sortOrder: 3,
            features: { dineIn: true, takeaway: true, crm: true, inventory: true, dataExport: true },
            limits: { maxBranches: 5, maxTables: 100, maxStaff: 50, maxMenuItems: 1000 },
        }),
        archived: await SubscriptionPlan.create({ name: 'Old', slug: 'old-sb', price: 500, isActive: false }),
        bespoke: await SubscriptionPlan.create({ name: 'Bespoke', slug: 'bespoke-sb', price: 100, isPublic: false }),
    };
    superadmin = await createUser({ name: 'Root', email: 'root.sb@platform.test', role: 'superadmin', superadminLevel: 'full' });
});

// ═══════════════════════════════════════════════════════════════════════
describe('GET /tenant/billing/plans', () => {
    test('lists active public plans only, sorted, with the current slug', async () => {
        const t = await seedTenant({ label: 'pl' });
        await putOnPlan(t, plans.basic);
        const res = await owner(t).get('/tenant/billing/plans');
        expect(res.status).toBe(200);
        const slugs = res.body.data.plans.map(p => p.slug);
        expect(slugs).toEqual(['free-sb', 'basic-sb', 'pro-sb', 'premium-sb']);
        expect(res.body.data.currentPlanSlug).toBe('basic-sb');
        expect(JSON.stringify(res.body)).not.toContain('plan_pro_rzp');
    });

    test.each(['waiter', 'chef', 'captain'])('%s → 403 OWNER_ONLY on every billing route', async (role) => {
        const t = await seedTenant({ label: `r${role.slice(0, 2)}` });
        const as = ctx.api.as(t.users[role]);
        for (const [m, url] of [['get', '/tenant/billing/current'], ['get', '/tenant/billing/plans'],
            ['post', '/tenant/billing/upgrade'], ['post', '/tenant/billing/upgrade/verify'],
            ['post', '/tenant/billing/sync'], ['get', '/tenant/billing/invoices']]) {
            const res = await as[m](url).send({});
            expect(res.status).toBe(403);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /tenant/billing/upgrade', () => {
    test('Razorpay subscription path: pending upgrade stashed, live plan untouched, notes carry the tenant', async () => {
        const t = await seedTenant({ label: 'up1' });
        await putOnPlan(t, plans.basic);
        rzp.instance.customers.create.mockResolvedValue({ id: 'cust_up1' });
        rzp.instance.subscriptions.create.mockResolvedValue({ id: 'sub_up1', status: 'created', short_url: 'https://rzp.io/i/up1' });

        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(200);
        expect(res.body.data.pendingUpgrade).toMatchObject({
            planSlug: 'pro-sb', subscriptionId: 'sub_up1', shortUrl: 'https://rzp.io/i/up1', fallbackOrder: false,
        });
        expect(res.body.data.subscription.planSlug).toBe('basic-sb');

        const args = rzp.instance.subscriptions.create.mock.calls[0][0];
        expect(args.plan_id).toBe('plan_pro_rzp');
        expect(args.notes.restaurantId).toBe(String(t.restaurant._id));
        expect(args.notes.planSlug).toBe('pro-sb');
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();

        const s = await sub(t);
        expect(s.planSlug).toBe('basic-sb');
        expect(s.features.crm).toBe(false);                 // NOT applied before payment
        expect(s.pendingUpgrade).toMatchObject({ planSlug: 'pro-sb', price: 1999, razorpaySubscriptionId: 'sub_up1' });
        expect(s.pendingUpgrade.features.crm).toBe(true);

        const audit = await AuditLog.findOne({ action: 'restaurant.self_upgrade', targetId: t.restaurant._id }).lean();
        expect(audit).toBeTruthy();
        expect(audit.details).toMatchObject({ from: 'basic-sb', to: 'pro-sb' });
    });

    // Regression (fixed 2026-10): upgradePlan persists the customer id returned by ensureRazorpayCustomer instead of the pre-call value.
    test('the Razorpay customer created during upgrade is persisted (idempotent customer)', async () => {
        const t = await seedTenant({ label: 'cust' });
        await putOnPlan(t, plans.basic);
        rzp.instance.customers.create.mockResolvedValue({ id: 'cust_keep_me' });
        rzp.instance.subscriptions.create.mockResolvedValue({ id: 'sub_cust', status: 'created', short_url: 'u' });
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(200);
        expect(rzp.instance.customers.create).toHaveBeenCalledTimes(1);
        // Before the fix: '' — the id was overwritten before save().
        expect((await sub(t)).razorpayCustomerId).toBe('cust_keep_me');
    });

    test('an existing customer id is reused — no second customer created', async () => {
        const t = await seedTenant({ label: 'cust2' });
        await putOnPlan(t, plans.basic, { razorpayCustomerId: 'cust_existing' });
        rzp.instance.subscriptions.create.mockResolvedValue({ id: 'sub_c2', status: 'created', short_url: 'u' });
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(200);
        expect(rzp.instance.customers.create).not.toHaveBeenCalled();
        expect(rzp.instance.subscriptions.create).toHaveBeenCalled();
        expect((await sub(t)).razorpayCustomerId).toBe('cust_existing');
    });

    test('fallback Orders path: order amount = plan price in PAISE, notes.type plan_payment + restaurantId', async () => {
        const t = await seedTenant({ label: 'fb' });
        await putOnPlan(t, plans.basic);
        stubFallbackOrder('order_fb_A');

        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.premium._id) });
        expect(res.status).toBe(200);
        expect(res.body.data.billing).toMatchObject({
            fallbackOrder: true, orderId: 'order_fb_A', amount: 299900, currency: 'INR',
            key: process.env.RAZORPAY_KEY_ID, status: 'pending_payment',
        });
        const args = rzp.instance.orders.create.mock.calls[0][0];
        expect(args.amount).toBe(299900);
        expect(args.notes).toMatchObject({
            type: 'plan_payment', restaurantId: String(t.restaurant._id), planSlug: 'premium-sb', planName: 'Premium',
        });
        expect(rzp.instance.subscriptions.create).not.toHaveBeenCalled();
        const s = await sub(t);
        expect(s.pendingUpgrade).toMatchObject({ planSlug: 'premium-sb', razorpayOrderId: 'order_fb_A', fallbackOrder: true });
        expect(s.planSlug).toBe('basic-sb');
    });

    test('Razorpay failure → 502 BILLING_SETUP_FAILED, nothing stashed', async () => {
        const t = await seedTenant({ label: 'fail' });
        await putOnPlan(t, plans.basic);
        rzp.instance.customers.create.mockRejectedValue({ statusCode: 500, error: { description: 'gateway down' } });
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('BILLING_SETUP_FAILED');
        expect(res.body.details.error).toBe('gateway down');
        expect((await sub(t)).pendingUpgrade?.planSlug).toBeFalsy();
    });

    test.each([
        ['bad id', () => 'nope', 400, undefined],
        ['unknown plan', () => String(new mongoose.Types.ObjectId()), 400, undefined],
        ['archived plan', () => String(plans.archived._id), 400, undefined],
        ['same plan', () => String(plans.basic._id), 400, 'SAME_PLAN'],
        ['free plan', () => String(plans.free._id), 400, 'DOWNGRADE_NOT_SUPPORTED'],
    ])('%s → %p %p, no Razorpay call', async (_l, planId, status, code) => {
        const t = await seedTenant({ label: 'rej' });
        await putOnPlan(t, plans.basic);
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: planId() });
        expect(res.status).toBe(status);
        if (code) expect(res.body.code).toBe(code);
        expect(rzp.instance.customers.create).not.toHaveBeenCalled();
    });

    test('paid → cheaper paid is blocked (DOWNGRADE_NOT_SUPPORTED)', async () => {
        const t = await seedTenant({ label: 'dg' });
        await putOnPlan(t, plans.pro);
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.basic._id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DOWNGRADE_NOT_SUPPORTED');
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /tenant/billing/upgrade/verify — amount / order binding', () => {
    async function startFallbackUpgrade(label, orderId) {
        const t = await seedTenant({ label });
        await putOnPlan(t, plans.basic);
        stubFallbackOrder(orderId);
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.premium._id) });
        expect(up.status).toBe(200);
        return t;
    }

    function verify(t, { orderId, paymentId, amount, status = 'captured', notes }) {
        rzp.instance.payments.fetch.mockResolvedValue({
            id: paymentId, order_id: orderId, amount, currency: 'INR', status,
            created_at: Math.floor(Date.now() / 1000),
            notes: notes || { type: 'plan_payment', restaurantId: String(t.restaurant._id), planSlug: 'premium-sb' },
        });
        return owner(t).post('/tenant/billing/upgrade/verify').send({
            razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId),
        });
    }

    test('full payment → plan applied, invoice in PAISE, listed + downloadable', async () => {
        const t = await startFallbackUpgrade('vok', 'order_vok');
        const res = await verify(t, { orderId: 'order_vok', paymentId: 'pay_vok', amount: 299900 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ upgradeApplied: true, alreadyInvoiced: false });
        expect(res.body.data.invoiceNumber).toMatch(/^INV-\d{8}-0001$/);

        const s = await sub(t);
        expect(s).toMatchObject({ planSlug: 'premium-sb', price: 2999, status: 'active', razorpayStatus: 'active' });
        expect(s.features.dataExport).toBe(true);
        expect(s.pendingUpgrade?.planSlug).toBeFalsy();

        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: 'pay_vok' }).lean();
        expect(inv).toMatchObject({ amount: 299900, currency: 'INR', planSlug: 'premium-sb', status: 'paid' });
        expect(String(inv.restaurant)).toBe(String(t.restaurant._id));

        const list = await owner(t).get('/tenant/billing/invoices');
        expect(list.status).toBe(200);
        expect(list.body.data).toHaveLength(1);
        expect(list.body.data[0]).toMatchObject({ amount: 299900, planName: 'Premium', invoiceNumber: inv.invoiceNumber });
        expect(list.body.data[0]).not.toHaveProperty('razorpayPaymentId');

        const pdf = await owner(t).get(`/tenant/billing/invoices/${inv._id}/download`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
        expect(pdf.headers['content-disposition']).toContain(`${inv.invoiceNumber}.pdf`);

        // Replay → idempotent
        const again = await verify(t, { orderId: 'order_vok', paymentId: 'pay_vok', amount: 299900 });
        expect(again.body.data).toMatchObject({ alreadyInvoiced: true, upgradeApplied: false });
        expect(await SubscriptionInvoice.countDocuments({ restaurant: t.restaurant._id })).toBe(1);
    });

    // Regression (fixed 2026-10): applyPaidPlanUpgrade skips a payment below toPaise(pendingUpgrade.price); verify returns 400 PAYMENT_PLAN_MISMATCH.
    test('paying ₹1 for a ₹2,999 plan must NOT apply the upgrade', async () => {
        const t = await startFallbackUpgrade('v1r', 'order_v1r');
        const res = await verify(t, { orderId: 'order_v1r', paymentId: 'pay_v1r', amount: 100 });
        // Before the fix: 200 { upgradeApplied: true }, plan → premium-sb, invoice amount 100.
        const s = await sub(t);
        expect(s.planSlug).toBe('basic-sb');
        expect(s.features.dataExport).toBe(false);
        expect(res.body.data?.upgradeApplied).not.toBe(true);
    });

    // Regression (fixed 2026-10): applyPaidPlanUpgrade skips a payment whose order_id is not pendingUpgrade.razorpayOrderId.
    test('a payment for a different (older) plan order must NOT apply the pending upgrade', async () => {
        const t = await startFallbackUpgrade('vord', 'order_current');
        const res = await verify(t, { orderId: 'order_OLD_basic', paymentId: 'pay_old', amount: 99900 });
        const s = await sub(t);
        expect(s.planSlug).toBe('basic-sb');
        expect(res.body.data?.upgradeApplied).not.toBe(true);
    });

    test('non-captured payment → 409, nothing applied', async () => {
        const t = await startFallbackUpgrade('vauth', 'order_vauth');
        const res = await verify(t, { orderId: 'order_vauth', paymentId: 'pay_vauth', amount: 299900, status: 'authorized' });
        expect(res.status).toBe(409);
        expect((await sub(t)).planSlug).toBe('basic-sb');
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('invoices — ownership + numbering', () => {
    test('another tenant cannot list or download my invoice (404), bad id → 400', async () => {
        const a = await seedTenant({ label: 'iva' });
        const b = await seedTenant({ label: 'ivb' });
        const r = await Restaurant.findById(a.restaurant._id);
        const { invoiceNumber } = await applyPaidPlanUpgrade({ restaurant: r, payment: { id: 'pay_own_a', amount: 99900, currency: 'INR' } });
        const inv = await SubscriptionInvoice.findOne({ invoiceNumber, restaurant: a.restaurant._id }).lean();

        const dl = await owner(b).get(`/tenant/billing/invoices/${inv._id}/download`);
        expect(dl.status).toBe(404);
        expect(dl.headers['content-type']).not.toMatch(/pdf/);
        const listB = await owner(b).get('/tenant/billing/invoices');
        expect(listB.body.data.map(i => String(i._id))).not.toContain(String(inv._id));
        expect((await owner(a).get('/tenant/billing/invoices/not-an-id/download')).status).toBe(400);
        // Waiter of the owning tenant is still refused.
        expect((await ctx.api.as(a.users.waiter).get(`/tenant/billing/invoices/${inv._id}/download`)).status).toBe(403);
    });

    test('per tenant per day: two tenants both start at -0001', async () => {
        const a = await seedTenant({ label: 'ina' });
        const b = await seedTenant({ label: 'inb' });
        const ra = await applyPaidPlanUpgrade({ restaurant: await Restaurant.findById(a.restaurant._id), payment: { id: 'pay_na', amount: 1 } });
        const rb = await applyPaidPlanUpgrade({ restaurant: await Restaurant.findById(b.restaurant._id), payment: { id: 'pay_nb', amount: 1 } });
        expect(ra.invoiceNumber).toMatch(/-0001$/);
        expect(rb.invoiceNumber).toMatch(/-0001$/);
        const rb2 = await applyPaidPlanUpgrade({ restaurant: await Restaurant.findById(b.restaurant._id), payment: { id: 'pay_nb2', amount: 1 } });
        expect(rb2.invoiceNumber).toMatch(/-0002$/);
    });

    test('6 concurrent charges for one tenant → 6 invoices, 6 distinct numbers (retry on the unique index)', async () => {
        const t = await seedTenant({ label: 'conc' });
        await SubscriptionInvoice.init(); // make sure the unique indexes exist
        const runs = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
            const r = await Restaurant.findById(t.restaurant._id);
            return applyPaidPlanUpgrade({ restaurant: r, payment: { id: `pay_conc_${i}`, amount: 99900 } });
        }));
        expect(runs.every(r => r.invoiceCreated)).toBe(true);
        const numbers = runs.map(r => r.invoiceNumber);
        expect(new Set(numbers).size).toBe(6);
        expect(numbers.map(n => n.slice(-4)).sort()).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
        expect(await SubscriptionInvoice.countDocuments({ restaurant: t.restaurant._id })).toBe(6);
    });

    test('same payment applied twice concurrently → exactly one invoice', async () => {
        const t = await seedTenant({ label: 'dupe' });
        const runs = await Promise.all([0, 1].map(async () => applyPaidPlanUpgrade({
            restaurant: await Restaurant.findById(t.restaurant._id),
            payment: { id: 'pay_same_twice', amount: 99900 },
        })));
        expect(runs.filter(r => r.invoiceCreated)).toHaveLength(1);
        expect(await SubscriptionInvoice.countDocuments({ razorpayPaymentId: 'pay_same_twice' })).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /tenant/billing/sync', () => {
    beforeEach(() => {
        // The shared mock has no `invoices` group; razorpayBilling calls
        // client.invoices.all — attach a per-test stub to the shared instance.
        rzp.instance.invoices = { all: jest.fn() };
    });

    test('no Razorpay subscription linked → 400 NO_RAZORPAY_SUBSCRIPTION', async () => {
        const t = await seedTenant({ label: 'sync0' });
        await putOnPlan(t, plans.basic);
        const res = await owner(t).post('/tenant/billing/sync').send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NO_RAZORPAY_SUBSCRIPTION');
    });

    test('materialises the paid cycle of the pending subscription, applies the upgrade, idempotent', async () => {
        const t = await seedTenant({ label: 'sync1' });
        await putOnPlan(t, plans.basic, {
            shortUrl: 'https://rzp.io/i/stale',
            pendingUpgrade: {
                plan: plans.pro._id, planName: 'Pro', planSlug: 'pro-sb', price: 1999,
                features: plans.pro.toObject().features, limits: plans.pro.toObject().limits,
                razorpaySubscriptionId: 'sub_sync1', shortUrl: 'https://rzp.io/i/stale',
            },
        });
        const currentEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
        rzp.instance.subscriptions.fetch.mockResolvedValue({
            id: 'sub_sync1', status: 'active', paid_count: 1, current_end: currentEnd,
            charge_at: currentEnd, customer_id: 'cust_sync1',
        });
        rzp.instance.invoices.all.mockResolvedValue({ items: [
            { payment_id: 'pay_sync1', status: 'paid' },
            { payment_id: null, status: 'issued' },
            { payment_id: 'pay_unpaid', status: 'issued' },
        ] });
        rzp.instance.payments.fetch.mockImplementation(async (id) => ({
            id, amount: 199900, currency: 'INR', status: 'captured', created_at: Math.floor(Date.now() / 1000),
        }));

        const res = await owner(t).post('/tenant/billing/sync').send({});
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ razorpayStatus: 'active', paidCount: 1, invoicesCreated: 1, upgradeApplied: true });
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(1);

        const s = await sub(t);
        expect(s).toMatchObject({ planSlug: 'pro-sb', razorpaySubscriptionId: 'sub_sync1', razorpayStatus: 'active', shortUrl: '', razorpayCustomerId: 'cust_sync1' });
        expect(new Date(s.currentPeriodEnd).getTime()).toBe(currentEnd * 1000);
        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: 'pay_sync1' }).lean();
        expect(inv.amount).toBe(199900);

        const again = await owner(t).post('/tenant/billing/sync').send({});
        expect(again.body.data.invoicesCreated).toBe(0);
        expect(await SubscriptionInvoice.countDocuments({ restaurant: t.restaurant._id })).toBe(1);
    });

    test('Razorpay fetch failure is tolerated (200, nothing created)', async () => {
        const t = await seedTenant({ label: 'sync2' });
        await putOnPlan(t, plans.pro, { razorpaySubscriptionId: 'sub_dead' });
        rzp.instance.subscriptions.fetch.mockRejectedValue(new Error('rzp down'));
        const res = await owner(t).post('/tenant/billing/sync').send({});
        expect(res.status).toBe(200);
        expect(res.body.data.invoicesCreated).toBe(0);
        expect((await sub(t)).planSlug).toBe('pro-sb');
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('downgrade request → superadmin approve → scheduled → applied at cycle end', () => {
    test('full flow incl. guards, lazy apply and feature loss', async () => {
        const t = await seedTenant({ label: 'dgf' });
        const periodEnd = new Date(Date.now() + 10 * DAY);
        await putOnPlan(t, plans.pro, { currentPeriodEnd: periodEnd, razorpaySubscriptionId: 'sub_live_dgf' });

        // Reason guard
        const short = await owner(t).post('/tenant/billing/downgrade-request').send({ planId: String(plans.basic._id), reason: 'too pricey' .slice(0, 5) });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('REASON_REQUIRED');

        const ok = await owner(t).post('/tenant/billing/downgrade-request')
            .send({ planId: String(plans.basic._id), reason: 'We only use dine-in now, please downgrade.' });
        expect(ok.status).toBe(201);
        expect(ok.body.data).toMatchObject({ status: 'pending', currentPlanName: 'Pro', requestedPlanName: 'Basic', requestedPlanPrice: 999 });
        const requestId = ok.body.data._id;

        // No stacking; upgrade blocked while pending; visible on /current.
        expect((await owner(t).post('/tenant/billing/downgrade-request')
            .send({ planId: String(plans.free._id), reason: 'Actually free would be better.' })).body.code).toBe('REQUEST_ALREADY_PENDING');
        expect((await owner(t).post('/tenant/billing/upgrade').send({ planId: String(plans.premium._id) })).body.code)
            .toBe('DOWNGRADE_REQUEST_PENDING');
        expect((await owner(t).get('/tenant/billing/current')).body.data.downgradeRequest._id).toBe(requestId);

        // Another tenant can't cancel it.
        const other = await seedTenant({ label: 'dgo' });
        expect((await owner(other).delete(`/tenant/billing/downgrade-request/${requestId}`)).status).toBe(404);

        // Superadmin approves → scheduled at currentPeriodEnd, old sub cancelled at cycle end.
        rzp.instance.subscriptions.cancel.mockResolvedValue({ id: 'sub_live_dgf', status: 'active' });
        const appr = await ctx.api.as(superadmin).post(`/superadmin/plan-change-requests/${requestId}/approve`).send({});
        expect(appr.status).toBe(200);
        expect(appr.body.data.scheduled).toBe(true);
        expect(new Date(appr.body.data.effectiveAt).getTime()).toBe(periodEnd.getTime());
        expect(rzp.instance.subscriptions.cancel).toHaveBeenCalledWith('sub_live_dgf', true);
        expect(await AuditLog.exists({ action: 'plan_change.approve.scheduled', targetId: t.restaurant._id })).toBeTruthy();

        // Before cycle end: still Pro, CRM still reachable.
        let cur = await owner(t).get('/tenant/billing/current');
        expect(cur.body.data.subscription.planSlug).toBe('pro-sb');
        expect(cur.body.data.scheduledDowngrade).toMatchObject({ planSlug: 'basic-sb', fromPlanName: 'Pro' });
        expect((await owner(t).get('/crm/customers')).status).toBe(200);
        // Cancelled request is locked.
        expect((await owner(t).delete(`/tenant/billing/downgrade-request/${requestId}`)).body.code).toBe('REQUEST_LOCKED');

        // Cycle end passes → next page load lazily applies Basic.
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.scheduledDowngrade.effectiveAt': new Date(Date.now() - 1000) } });
        cur = await owner(t).get('/tenant/billing/current');
        expect(cur.body.data.subscription).toMatchObject({ planSlug: 'basic-sb', razorpaySubscriptionId: '' });
        expect(cur.body.data.scheduledDowngrade).toBeNull();
        const s = await sub(t);
        expect(s.price).toBe(999);
        expect(s.limits.maxStaff).toBe(4);
        const crm = await owner(t).get('/crm/customers');
        expect(crm.status).toBe(403);
        expect(crm.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'crm', currentPlan: 'Basic' });
    });

    test('tenant can withdraw a pending request; cancel scheduled downgrade; nothing to cancel → 404', async () => {
        const t = await seedTenant({ label: 'dgw' });
        await putOnPlan(t, plans.pro);
        const req = await owner(t).post('/tenant/billing/downgrade-request')
            .send({ planId: String(plans.basic._id), reason: 'Changing my mind later probably.' });
        const del = await owner(t).delete(`/tenant/billing/downgrade-request/${req.body.data._id}`);
        expect(del.status).toBe(200);
        expect(del.body.data.status).toBe('cancelled');
        expect((await owner(t).get('/tenant/billing/downgrade-request')).body.data).toBeNull();

        expect((await owner(t).post('/tenant/billing/scheduled-downgrade/cancel').send({})).body.code).toBe('NO_SCHEDULED_DOWNGRADE');
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.scheduledDowngrade': {
            planSlug: 'basic-sb', planName: 'Basic', effectiveAt: new Date(Date.now() + DAY),
        } } });
        const c = await owner(t).post('/tenant/billing/scheduled-downgrade/cancel').send({});
        expect(c.status).toBe(200);
        expect((await sub(t)).scheduledDowngrade?.planSlug).toBeFalsy();
        expect(await AuditLog.exists({ action: 'plan_change.tenant_cancel_schedule', targetId: t.restaurant._id })).toBeTruthy();
    });

    // Regression (fixed 2026-10): requestDowngrade only accepts an active public plan cheaper than subscription.price; tenant approvals that aren't downgrades are refused.
    test('a "downgrade" request for a MORE expensive plan is refused', async () => {
        const t = await seedTenant({ label: 'dgx' });
        await putOnPlan(t, plans.basic);
        const res = await owner(t).post('/tenant/billing/downgrade-request')
            .send({ planId: String(plans.premium._id), reason: 'Please give me premium for free.' });
        // Before the fix: 201 pending request for Premium (₹2,999 > ₹999).
        expect(res.status).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6.1 — plan limits + feature gates on real routes
// ═══════════════════════════════════════════════════════════════════════
describe('plan limits enforced at create time', () => {
    // seedTenant creates: 4 staff (admin/waiter/chef/captain), 1 branch,
    // 2 tables, 3 menu items. Basic plan: maxStaff 4, maxBranches 1,
    // maxTables 2, maxMenuItems 3 — every create below is one over.
    let t;
    beforeAll(async () => {
        t = await seedTenant({ label: 'lim' });
        await putOnPlan(t, plans.basic);
        // multiBranch on (override) so the branch route reaches the limit check
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { featureOverrides: { multiBranch: true } } });
    });

    test('maxStaff → 403 STAFF_LIMIT_REACHED', async () => {
        const res = await owner(t).post('/staff').send({
            name: 'Fifth Person', email: `fifth.${t.slug}@staff.test`, mobile: '9876500011', role: 'waiter',
            branch: String(t.branch._id),
        });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'STAFF_LIMIT_REACHED', limit: 4, current: 4 });
    });

    test('maxBranches → 403 BRANCH_LIMIT_REACHED', async () => {
        const res = await owner(t).post('/branches').send({
            name: 'Second', managerName: 'Mgr', managerEmail: `mgr.${t.slug}@staff.test`, managerPassword: 'Integration#Pass123',
        });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'BRANCH_LIMIT_REACHED', limit: 1 });
    });

    test('upgrading the plan raises the limit (snapshot read at request time)', async () => {
        const t2 = await seedTenant({ label: 'lim2' });
        await putOnPlan(t2, plans.pro);
        const res = await owner(t2).post('/staff').send({
            name: 'Fifth Person', email: `fifth.${t2.slug}@staff.test`, mobile: '9876500012', role: 'waiter',
            branch: String(t2.branch._id),
        });
        expect(res.status).toBe(201);
    });

    // Regression (fixed 2026-10): tableController.createTable enforces req.restaurant.getLimit('maxTables') (403 TABLE_LIMIT_REACHED).
    test('maxTables → creating a 3rd table on a 2-table plan is refused', async () => {
        const res = await owner(t).post('/tables').send({
            name: `Over-${Date.now()}`, capacity: 2, area: String(t.area._id), branch: String(t.branch._id),
        });
        expect(res.status).toBe(403);
    });

    // Regression (fixed 2026-10): menuController.createMenuItem (and CSV import) enforce req.restaurant.getLimit('maxMenuItems') (403 MENU_ITEM_LIMIT_REACHED).
    test('maxMenuItems → creating a 4th item on a 3-item plan is refused', async () => {
        const res = await owner(t).post('/menu').send({
            name: `Over Item ${Date.now()}`, category: String(t.category._id), basePrice: 10,
            description: 'over the limit', prepStation: 'kitchen', vegType: 'veg',
        });
        expect(res.status).toBe(403);
    });
});

describe('feature gates on real routes', () => {
    test('plan without inventory → 403 FEATURE_LOCKED; override true unlocks; override false revokes', async () => {
        const t = await seedTenant({ label: 'fg' });
        await putOnPlan(t, plans.basic);
        let res = await owner(t).get('/inventory');
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'inventory', currentPlan: 'Basic' });

        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { featureOverrides: { inventory: true } } });
        res = await owner(t).get('/inventory');
        expect(res.status).not.toBe(403);

        await putOnPlan(t, plans.pro);
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { featureOverrides: { inventory: false } } });
        res = await owner(t).get('/inventory');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FEATURE_REVOKED');
    });

    test('past_due subscription keeps its features (status not consulted by the gate)', async () => {
        const t = await seedTenant({ label: 'pd' });
        await putOnPlan(t, plans.pro, { status: 'past_due' });
        expect((await owner(t).get('/crm/customers')).status).toBe(200);
    });

    test('suspended tenant is hard-blocked before any gate (TENANT_SUSPENDED)', async () => {
        const t = await seedTenant({ label: 'sus' });
        await putOnPlan(t, plans.pro);
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { status: 'suspended' } });
        const res = await owner(t).get('/crm/customers');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    // Regression (fixed 2026-10): /tenant/export is behind featureGate('dataExport') and /analytics/* behind featureGate('revenueAnalytics').
    test('GET /tenant/export is gated by the dataExport feature', async () => {
        const t = await seedTenant({ label: 'dx' });
        await putOnPlan(t, plans.basic); // dataExport: false
        const res = await owner(t).get('/tenant/export');
        // Before the fix: 200 (zip streamed).
        expect(res.status).toBe(403);
    });

    test('GET /analytics/summary is gated by the revenueAnalytics feature', async () => {
        const t = await seedTenant({ label: 'ra' });
        await putOnPlan(t, plans.basic); // revenueAnalytics: 'none'
        const res = await owner(t).get('/analytics/summary');
        // Before the fix: 200.
        expect(res.status).toBe(403);
    });
});
