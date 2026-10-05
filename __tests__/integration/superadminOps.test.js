/**
 * Super Admin operations (QA checklist 6.4): tenant create / suspend /
 * reactivate / assign-plan / cancel-subscription / payment confirm,
 * plan CRUD (incl. "price edits never retro-change existing tenants"),
 * plan-change approval, support-vs-full permissions, audit rows for every
 * mutation, and no secrets in tenant payloads.
 *
 * Not present in the codebase (so not tested): tenant DELETE endpoint,
 * impersonation. See the QA report.
 *
 * Razorpay = shared fail-closed mock; email is mocked.
 * Tests named "BUG: ..." fail on purpose and document a real defect.
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const PlanChangeRequest = require(path.join(BACKEND, 'models/planChangeRequest'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const User = require(path.join(BACKEND, 'models/user'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));

const ctx = useIntegrationApp();

let full;
let support;
let plans;
let tenant;

const SA = () => ctx.api.as(full);
const SUP = () => ctx.api.as(support);

const BCRYPT_RE = /\$2[aby]\$\d{2}\$/;

async function putOnPlan(t, plan, extra = {}) {
    const p = plan.toObject();
    await Restaurant.updateOne({ _id: t.restaurant._id }, {
        $set: {
            subscription: {
                plan: p._id, planName: p.name, planSlug: p.slug, price: p.price,
                features: p.features, limits: p.limits, status: 'active', ...extra,
            },
        },
    });
}

const auditFor = (action, targetId) => AuditLog.findOne({ action, targetId }).sort({ createdAt: -1 }).lean();

function newRestaurantBody(extra = {}) {
    const n = Math.random().toString(36).slice(2, 7);
    return {
        name: `Ops Cafe ${n}`,
        contactEmail: `owner.${n}@ops.test`,
        contactPhone: '9876543210',
        ownerName: 'Ops Owner',
        planId: String(plans.pro._id),
        addressLine1: '1 MG Road',
        city: 'Pune',
        state: 'MH',
        pincode: '411001',
        legalBusinessName: 'Ops Cafe Pvt Ltd',
        fssaiLicense: '12345678901234',
        trialDays: 0,
        ...extra,
    };
}

beforeAll(async () => {
    plans = {
        basic: await SubscriptionPlan.create({
            name: 'Basic', slug: 'basic-op', price: 999, sortOrder: 1,
            features: { dineIn: true, inventory: false },
            limits: { maxBranches: 1, maxStaff: 10 },
        }),
        pro: await SubscriptionPlan.create({
            name: 'Pro', slug: 'pro-op', price: 1999, sortOrder: 2, razorpayPlanId: 'plan_op_secret',
            features: { dineIn: true, inventory: true, crm: true },
            limits: { maxBranches: 3, maxStaff: 20 },
        }),
    };
    full = await createUser({ name: 'Root', email: 'root.op@platform.test', role: 'superadmin', superadminLevel: 'full' });
    support = await createUser({ name: 'Helper', email: 'help.op@platform.test', role: 'superadmin', superadminLevel: 'support' });
    tenant = await seedTenant({ label: 'op' });
    await putOnPlan(tenant, plans.pro);
});

beforeEach(() => sendEmail.mockClear());

// ═══════════════════════════════════════════════════════════════════════
describe('access control', () => {
    test('anonymous → 401, tenant admin → 403 on superadmin routes', async () => {
        expect((await ctx.api.anon().get('/superadmin/restaurants')).status).toBe(401);
        expect((await ctx.api.as(tenant.users.admin).get('/superadmin/restaurants')).status).toBe(403);
        expect((await ctx.api.as(tenant.users.admin).post('/superadmin/plans').send({ name: 'X', price: 1 })).status).toBe(403);
    });

    test.each([
        '/superadmin/restaurants', '/superadmin/plans', '/superadmin/audit-logs',
        '/superadmin/subscription-payments', '/superadmin/pending-approvals', '/superadmin/analytics',
    ])('support can READ %s', async (url) => {
        expect((await SUP().get(url)).status).toBe(200);
    });

    // Every mutating route must refuse a support-level superadmin and
    // leave no trace (no state change, no audit row by that actor).
    const id = () => String(tenant.restaurant._id);
    const MUTATIONS = [
        ['post', () => '/superadmin/restaurants', () => newRestaurantBody()],
        ['patch', () => `/superadmin/restaurants/${id()}`, () => ({ name: 'Hijacked' })],
        ['post', () => `/superadmin/restaurants/${id()}/assign-plan`, () => ({ planId: String(plans.basic._id) })],
        ['post', () => `/superadmin/restaurants/${id()}/suspend`, () => ({ reason: 'nope' })],
        ['post', () => `/superadmin/restaurants/${id()}/reactivate`, () => ({ reason: 'nope' })],
        ['post', () => `/superadmin/restaurants/${id()}/resend-invitation`, () => ({})],
        ['post', () => `/superadmin/restaurants/${id()}/cancel-subscription`, () => ({ immediate: true })],
        ['post', () => `/superadmin/restaurants/${id()}/approve-signup`, () => ({})],
        ['post', () => `/superadmin/restaurants/${id()}/reject-signup`, () => ({ reason: 'x' })],
        ['post', () => `/superadmin/restaurants/${id()}/confirm-payment`, () => ({})],
        ['post', () => `/superadmin/restaurants/${id()}/plan-change-request`, () => ({ planId: String(plans.basic._id) })],
        ['post', () => `/superadmin/restaurants/${id()}/backup`, () => ({})],
        ['post', () => '/superadmin/plans', () => ({ name: 'Sneaky', price: 1 })],
        ['put', () => `/superadmin/plans/${plans.pro._id}`, () => ({ price: 1 })],
        ['patch', () => `/superadmin/plans/${plans.pro._id}/archive`, () => ({})],
        ['delete', () => `/superadmin/plans/${plans.basic._id}`, () => ({})],
        ['post', () => '/superadmin/audit-logs/purge', () => ({ dryRun: false })],
        ['put', () => '/superadmin/marketing', () => ({})],
    ];
    test.each(MUTATIONS.map(([m, u, b]) => [m.toUpperCase(), u, m, b]))(
        'support %s %p → 403, no side effects',
        async (_M, url, method, body) => {
            const before = await Restaurant.findById(tenant.restaurant._id).lean();
            const planBefore = await SubscriptionPlan.findById(plans.pro._id).lean();
            const res = await SUP()[method](url()).send(body());
            expect(res.status).toBe(403);
            const after = await Restaurant.findById(tenant.restaurant._id).lean();
            expect(after.name).toBe(before.name);
            expect(after.status).toBe(before.status);
            expect(after.subscription.planSlug).toBe(before.subscription.planSlug);
            const planAfter = await SubscriptionPlan.findById(plans.pro._id).lean();
            expect(planAfter.price).toBe(planBefore.price);
            expect(planAfter.isActive).toBe(planBefore.isActive);
            expect(await AuditLog.exists({ actor: support._id })).toBeNull();
        },
    );

    test('plan-change approve / reject are full-only', async () => {
        const reqDoc = await PlanChangeRequest.create({
            restaurant: tenant.restaurant._id, requestedPlan: plans.basic._id, requestedPlanName: 'Basic',
            currentPlanName: 'Pro', requestSource: 'tenant',
        });
        expect((await SUP().post(`/superadmin/plan-change-requests/${reqDoc._id}/approve`).send({})).status).toBe(403);
        expect((await SUP().post(`/superadmin/plan-change-requests/${reqDoc._id}/reject`).send({ reason: 'x' })).status).toBe(403);
        expect((await PlanChangeRequest.findById(reqDoc._id).lean()).status).toBe('pending');
        await PlanChangeRequest.deleteOne({ _id: reqDoc._id });
    });

    // Regression (fixed 2026-10): /internal/run-dormancy-check now requires superAdminFull.
    test('support superadmin cannot trigger the dormancy scan (it sends tenant emails)', async () => {
        const res = await SUP().post('/superadmin/internal/run-dormancy-check').send({});
        // Before the fix: 200 { success: true, summary }.
        expect(res.status).toBe(403);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('tenant lifecycle', () => {
    test('create: owner + Main branch + snapshot + audit; temp password once; no hashes in the payload', async () => {
        const body = newRestaurantBody();
        const res = await SA().post('/superadmin/restaurants').send(body);
        expect(res.status).toBe(201);
        const d = res.body.data;
        expect(d.temporaryPassword).toEqual(expect.any(String));
        expect(d.temporaryPassword.length).toBeGreaterThanOrEqual(12);
        expect(JSON.stringify(res.body)).not.toMatch(BCRYPT_RE);
        expect(JSON.stringify(res.body)).not.toContain('plan_op_secret');
        expect(d.restaurant.subscription).toMatchObject({ planSlug: 'pro-op', price: 1999, status: 'active' });
        expect(d.restaurant.status).toBe('active');

        const ownerUser = await User.findOne({ email: body.contactEmail.toLowerCase() }).select('+password').lean();
        expect(ownerUser).toMatchObject({ role: 'admin', isTenantOwner: true, mustChangePassword: true });
        expect(ownerUser.password).toMatch(BCRYPT_RE);
        expect(ownerUser.password).not.toBe(d.temporaryPassword);
        expect(await Branch.exists({ restaurant: d.restaurant._id, slug: 'main' })).toBeTruthy();

        const audit = await auditFor('restaurant.create', d.restaurant._id);
        expect(audit).toMatchObject({ actorEmail: 'root.op@platform.test', actorLevel: 'full', actorRole: 'superadmin' });
        expect(audit.details).toMatchObject({ plan: 'pro-op', price: 1999, paymentStatus: 'pending' });
        expect(JSON.stringify(audit)).not.toContain(d.temporaryPassword);
        expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: body.contactEmail.toLowerCase() }));
    });

    test('create with trialDays → status trial, trialEndDate = now + N days', async () => {
        const before = Date.now();
        const res = await SA().post('/superadmin/restaurants').send(newRestaurantBody({ trialDays: 7 }));
        expect(res.status).toBe(201);
        const s = res.body.data.restaurant.subscription;
        expect(res.body.data.restaurant.status).toBe('trial');
        const end = new Date(s.trialEndDate).getTime();
        expect(end).toBeGreaterThanOrEqual(before + 7 * 86400000);
        expect(end).toBeLessThan(before + 7 * 86400000 + 60000);
    });

    test.each([
        [{ fssaiLicense: '123' }, /FSSAI/],
        [{ pincode: '12' }, /Pincode/],
        [{ planId: 'zzz' }, /plan/i],
        [{ contactEmail: 'not-an-email' }, /email/i],
    ])('create validation %j → 400', async (patch, msg) => {
        const res = await SA().post('/superadmin/restaurants').send(newRestaurantBody(patch));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(msg);
    });

    test('duplicate owner email → 400 and no orphan restaurant', async () => {
        const body = newRestaurantBody({ contactEmail: tenant.users.admin.email });
        const count = await Restaurant.countDocuments({});
        const res = await SA().post('/superadmin/restaurants').send(body);
        expect(res.status).toBe(400);
        expect(await Restaurant.countDocuments({})).toBe(count);
    });

    test('suspend (reason required) → tenant locked out; reactivate → restored; both audited + emailed', async () => {
        const t = await seedTenant({ label: 'sr' });
        await putOnPlan(t, plans.pro);
        const id = t.restaurant._id;

        expect((await SA().post(`/superadmin/restaurants/${id}/suspend`).send({ reason: '   ' })).status).toBe(400);

        const s = await SA().post(`/superadmin/restaurants/${id}/suspend`).send({ reason: 'Chargeback fraud' });
        expect(s.status).toBe(200);
        expect(s.body.data).toMatchObject({ status: 'suspended', suspendedReason: 'Chargeback fraud' });
        const locked = await ctx.api.as(t.users.admin).get('/crm/customers');
        expect(locked.status).toBe(403);
        expect(locked.body.code).toBe('TENANT_SUSPENDED');
        expect((await auditFor('restaurant.suspend', id)).details.reason).toBe('Chargeback fraud');
        expect(sendEmail).toHaveBeenCalled();

        expect((await SA().post(`/superadmin/restaurants/${id}/reactivate`).send({})).status).toBe(400);
        const r = await SA().post(`/superadmin/restaurants/${id}/reactivate`).send({ reason: 'Resolved with bank' });
        expect(r.status).toBe(200);
        expect(r.body.data.status).toBe('active');
        expect(r.body.data.suspendedReason).toBe('');
        expect((await ctx.api.as(t.users.admin).get('/crm/customers')).status).toBe(200);
        expect(await auditFor('restaurant.reactivate', id)).toBeTruthy();
    });

    test('reactivate during a live trial → status trial', async () => {
        const t = await seedTenant({ label: 'srt' });
        await putOnPlan(t, plans.pro, { trialEndDate: new Date(Date.now() + 3 * 86400000) });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { status: 'suspended' } });
        const r = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/reactivate`).send({ reason: 'ok' });
        expect(r.body.data.status).toBe('trial');
    });

    test('PATCH featureOverrides takes effect on the next request (no stale tenant cache) + audited', async () => {
        const t = await seedTenant({ label: 'fo' });
        await putOnPlan(t, plans.pro);
        expect((await ctx.api.as(t.users.admin).get('/inventory')).status).not.toBe(403);
        const res = await SA().patch(`/superadmin/restaurants/${t.restaurant._id}`).send({ featureOverrides: { inventory: false } });
        expect(res.status).toBe(200);
        const gated = await ctx.api.as(t.users.admin).get('/inventory');
        expect(gated.status).toBe(403);
        expect(gated.body.code).toBe('FEATURE_REVOKED');
        const audit = await auditFor('restaurant.update', t.restaurant._id);
        expect(audit.details.after.featureOverrides).toEqual({ inventory: false });
    });

    test('tenant payloads (detail + list) never carry password hashes or Razorpay secrets', async () => {
        await Restaurant.updateOne({ _id: tenant.restaurant._id }, { $set: { owner: tenant.users.admin._id } });
        const detail = await SA().get(`/superadmin/restaurants/${tenant.restaurant._id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.data.ownerProfile).toMatchObject({ email: tenant.users.admin.email });
        expect(detail.body.data.ownerProfile.password).toBeUndefined();
        const list = await SA().get('/superadmin/restaurants?limit=100');
        for (const res of [detail, list]) {
            const json = JSON.stringify(res.body);
            expect(json).not.toMatch(BCRYPT_RE);
            expect(json).not.toMatch(/"password"/);
            expect(json).not.toContain(process.env.RAZORPAY_KEY_SECRET);
            expect(json).not.toContain('plan_op_secret');
            expect(json).not.toContain('signupReviewNote');
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('billing actions', () => {
    test('assign-plan: cancels the previous Razorpay subscription, creates the new one, snapshots, audits', async () => {
        const t = await seedTenant({ label: 'ap' });
        await putOnPlan(t, plans.basic, { razorpaySubscriptionId: 'sub_prev_ap', razorpayCustomerId: 'cust_ap' });
        rzp.instance.subscriptions.cancel.mockResolvedValue({ id: 'sub_prev_ap', status: 'cancelled' });
        rzp.instance.subscriptions.create.mockResolvedValue({ id: 'sub_new_ap', status: 'created', short_url: 'https://rzp.io/i/ap' });

        const res = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/assign-plan`).send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(200);
        expect(rzp.instance.subscriptions.cancel).toHaveBeenCalledWith('sub_prev_ap', false);
        expect(rzp.instance.customers.create).not.toHaveBeenCalled(); // reused cust_ap
        expect(rzp.instance.subscriptions.create.mock.calls[0][0]).toMatchObject({
            plan_id: 'plan_op_secret', notes: { restaurantId: String(t.restaurant._id) },
        });
        expect(res.body.billing).toMatchObject({ subscriptionCreated: true, subscriptionId: 'sub_new_ap' });
        const s = (await Restaurant.findById(t.restaurant._id).lean()).subscription;
        expect(s).toMatchObject({
            planSlug: 'pro-op', price: 1999, razorpaySubscriptionId: 'sub_new_ap', razorpayCustomerId: 'cust_ap',
            shortUrl: 'https://rzp.io/i/ap', status: 'active',
        });
        expect(s.features.crm).toBe(true);
        expect((await auditFor('restaurant.plan.assign', t.restaurant._id)).details).toMatchObject({ from: 'basic-op', to: 'pro-op' });
    });

    test('assign-plan: Razorpay failure does not block the assignment; error surfaced', async () => {
        const t = await seedTenant({ label: 'apf' });
        await putOnPlan(t, plans.basic);
        rzp.instance.customers.create.mockRejectedValue({ statusCode: 403, error: { description: 'KYC pending' } });
        const res = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/assign-plan`).send({ planId: String(plans.pro._id) });
        expect(res.status).toBe(200);
        expect(res.body.billing).toMatchObject({ subscriptionCreated: false, error: 'KYC pending', statusCode: 403 });
        expect(res.body.billing.hint).toMatch(/KYC/);
        expect((await Restaurant.findById(t.restaurant._id).lean()).subscription.planSlug).toBe('pro-op');
    });

    test('cancel-subscription: none → 400; default at cycle end; immediate clears ids; Razorpay reject → 502 unchanged', async () => {
        const t = await seedTenant({ label: 'cs' });
        const id = t.restaurant._id;
        await putOnPlan(t, plans.pro);
        expect((await SA().post(`/superadmin/restaurants/${id}/cancel-subscription`).send({})).status).toBe(400);

        await putOnPlan(t, plans.pro, { razorpaySubscriptionId: 'sub_cs', shortUrl: 'u', razorpayStatus: 'active' });
        rzp.instance.subscriptions.cancel.mockRejectedValueOnce(new Error('already cancelled'));
        const bad = await SA().post(`/superadmin/restaurants/${id}/cancel-subscription`).send({});
        expect(bad.status).toBe(502);
        expect((await Restaurant.findById(id).lean()).subscription.razorpayStatus).toBe('active');

        rzp.instance.subscriptions.cancel.mockResolvedValue({});
        const cycleEnd = await SA().post(`/superadmin/restaurants/${id}/cancel-subscription`).send({});
        expect(cycleEnd.status).toBe(200);
        expect(rzp.instance.subscriptions.cancel).toHaveBeenLastCalledWith('sub_cs', true);
        let s = (await Restaurant.findById(id).lean()).subscription;
        expect(s).toMatchObject({ razorpayStatus: 'cancelled', razorpaySubscriptionId: 'sub_cs' });

        const now = await SA().post(`/superadmin/restaurants/${id}/cancel-subscription`).send({ immediate: true });
        expect(now.status).toBe(200);
        expect(rzp.instance.subscriptions.cancel).toHaveBeenLastCalledWith('sub_cs', false);
        s = (await Restaurant.findById(id).lean()).subscription;
        expect(s).toMatchObject({ razorpaySubscriptionId: '', shortUrl: '' });
        expect(await AuditLog.countDocuments({ action: 'restaurant.subscription.cancel', targetId: id })).toBe(2);
    });

    test('confirm-payment: pending → received + audit; only payment suspensions are lifted; repeat → 400', async () => {
        const t = await seedTenant({ label: 'cp' });
        const id = t.restaurant._id;
        await Restaurant.updateOne({ _id: id }, { $set: { paymentStatus: 'pending', status: 'suspended', suspendedReason: 'Awaiting payment' } });
        const ok = await SA().post(`/superadmin/restaurants/${id}/confirm-payment`).send({ note: 'UPI ref 123' });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ paymentStatus: 'received', status: 'active', paymentNote: 'UPI ref 123' });
        expect(await auditFor('restaurant.payment_confirm', id)).toBeTruthy();
        expect((await SA().post(`/superadmin/restaurants/${id}/confirm-payment`).send({})).status).toBe(400);

        const t2 = await seedTenant({ label: 'cp2' });
        await Restaurant.updateOne({ _id: t2.restaurant._id }, { $set: { paymentStatus: 'pending', status: 'suspended', suspendedReason: 'ToS violation' } });
        const r2 = await SA().post(`/superadmin/restaurants/${t2.restaurant._id}/confirm-payment`).send({});
        expect(r2.body.data).toMatchObject({ paymentStatus: 'received', status: 'suspended' });
    });

    // Regression (fixed 2026-10): listPendingApprovals planPrice uses the snapshot subscription.price (catalogue only as fallback).
    test('pending-payments queue shows the AGREED price (priceOverride), not the catalog price', async () => {
        const created = await SA().post('/superadmin/restaurants').send(newRestaurantBody({ priceOverride: 500 }));
        expect(created.status).toBe(201);
        const rid = created.body.data.restaurant._id;
        expect(created.body.data.restaurant.subscription.price).toBe(500);

        const detail = await SA().get(`/superadmin/approvals/payments/${rid}`);
        expect(detail.body.data.amountDue).toBe(500);
        expect(detail.body.data.plan).toMatchObject({ price: 1999, agreedPrice: 500 });

        const queue = await SA().get('/superadmin/pending-approvals');
        const row = queue.body.data.paymentPending.find(r => String(r._id) === String(rid));
        expect(row).toBeTruthy();
        // Before the fix: 1999.
        expect(row.planPrice).toBe(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('plan CRUD', () => {
    test('create → audited, visible on /public/plans immediately, public shape hides Razorpay id', async () => {
        const res = await SA().post('/superadmin/plans').send({
            name: 'Growth Op', price: 1499, sortOrder: 5, features: { dineIn: true, crm: true }, limits: { maxTables: 25 },
        });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ slug: 'growth-op', price: 1499, isPublic: true, isActive: true });
        expect(await auditFor('plan.create', res.body.data._id)).toBeTruthy();

        const pub = await ctx.api.anon().get('/public/plans');
        const p = (pub.body.data || pub.body.plans || []).find(x => x.slug === 'growth-op');
        expect(p).toBeTruthy();
        expect(p.limits.tables).toBe(25);
        expect(JSON.stringify(pub.body)).not.toContain('plan_op_secret');
        expect(JSON.stringify(pub.body)).not.toContain('apiRateLimit');

        expect((await SA().post('/superadmin/plans').send({ name: 'Growth Op', price: 1 })).status).toBe(400);
        expect((await SA().post('/superadmin/plans').send({ name: 'Neg', price: -1 })).status).toBe(400);
    });

    test('price / feature edits never retro-change existing tenants; change is audited with from→to', async () => {
        const plan = await SubscriptionPlan.create({
            name: 'Retro', slug: 'retro-op', price: 1000, features: { dineIn: true, crm: true }, limits: { maxStaff: 7 },
        });
        const t = await seedTenant({ label: 'retro' });
        await putOnPlan(t, plan);

        const res = await SA().put(`/superadmin/plans/${plan._id}`).send({
            price: 2500, features: { dineIn: true, crm: false }, limits: { maxStaff: 2 },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.price).toBe(2500);

        const s = (await Restaurant.findById(t.restaurant._id).lean()).subscription;
        expect(s.price).toBe(1000);
        expect(s.features.crm).toBe(true);
        expect(s.limits.maxStaff).toBe(7);
        expect((await ctx.api.as(t.users.admin).get('/crm/customers')).status).toBe(200);

        const audit = await auditFor('plan.update', plan._id);
        expect(audit.details.changedFields).toEqual(expect.arrayContaining(['price', 'features', 'limits']));
        expect(audit.details.changes.price).toEqual({ from: '1000', to: '2500' });
    });

    test('archive → hidden from /public/plans and the tenant catalogue; delete in use → PLAN_IN_USE; unused → deleted', async () => {
        const plan = await SubscriptionPlan.create({ name: 'Temp', slug: 'temp-op', price: 300, sortOrder: 9 });
        await ctx.api.anon().get('/public/plans'); // warm the cache
        const arch = await SA().patch(`/superadmin/plans/${plan._id}/archive`).send({});
        expect(arch.status).toBe(200);
        expect(arch.body.data.isActive).toBe(false);
        const pub = await ctx.api.anon().get('/public/plans');
        expect(JSON.stringify(pub.body)).not.toContain('temp-op');
        const cat = await ctx.api.as(tenant.users.admin).get('/tenant/billing/plans');
        expect(cat.body.data.plans.map(p => p.slug)).not.toContain('temp-op');
        expect(await auditFor('plan.archive', plan._id)).toBeTruthy();

        const t = await seedTenant({ label: 'inuse' });
        await putOnPlan(t, plan);
        const inUse = await SA().delete(`/superadmin/plans/${plan._id}`);
        expect(inUse.status).toBe(400);
        expect(inUse.body).toMatchObject({ code: 'PLAN_IN_USE', assignedCount: 1 });

        await putOnPlan(t, plans.basic);
        const del = await SA().delete(`/superadmin/plans/${plan._id}`);
        expect(del.status).toBe(200);
        expect(await SubscriptionPlan.exists({ _id: plan._id })).toBeNull();
        expect(await auditFor('plan.delete', plan._id)).toBeTruthy();
    });

    test('making a plan private hides it publicly but keeps it in the superadmin list', async () => {
        const plan = await SubscriptionPlan.create({ name: 'Priv', slug: 'priv-op', price: 10 });
        await SA().put(`/superadmin/plans/${plan._id}`).send({ isPublic: false });
        expect(JSON.stringify((await ctx.api.anon().get('/public/plans')).body)).not.toContain('priv-op');
        const list = await SA().get('/superadmin/plans');
        expect(list.body.data.find(p => p.slug === 'priv-op')).toMatchObject({ isPublic: false });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('plan-change approval', () => {
    test('operator upgrade request: approve applies immediately; reject needs a reason; both audited', async () => {
        const t = await seedTenant({ label: 'pcr' });
        await putOnPlan(t, plans.basic);
        const create = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/plan-change-request`).send({ planId: String(plans.pro._id), note: 'paid cash' });
        expect(create.status).toBe(201);
        expect((await SA().post(`/superadmin/restaurants/${t.restaurant._id}/plan-change-request`).send({ planId: String(plans.pro._id) })).status).toBe(400);
        const appr = await SA().post(`/superadmin/plan-change-requests/${create.body.data._id}/approve`).send({});
        expect(appr.status).toBe(200);
        expect(appr.body.data.scheduled).toBe(false);
        const s = (await Restaurant.findById(t.restaurant._id).lean()).subscription;
        expect(s).toMatchObject({ planSlug: 'pro-op', price: 1999 });
        expect(await auditFor('plan_change.approve', t.restaurant._id)).toBeTruthy();
        expect((await SA().post(`/superadmin/plan-change-requests/${create.body.data._id}/approve`).send({})).status).toBe(400);

        const second = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/plan-change-request`).send({ planId: String(plans.basic._id) });
        expect((await SA().post(`/superadmin/plan-change-requests/${second.body.data._id}/reject`).send({ reason: '' })).status).toBe(400);
        const rej = await SA().post(`/superadmin/plan-change-requests/${second.body.data._id}/reject`).send({ reason: 'Not paid' });
        expect(rej.status).toBe(200);
        expect(rej.body.data).toMatchObject({ status: 'rejected', rejectedReason: 'Not paid' });
        expect(await auditFor('plan_change.reject', t.restaurant._id)).toBeTruthy();
    });

    // Regression (fixed 2026-10): approvePlanChangeRequest (and upgradePlan) compare against the snapshot subscription.price, not the catalogue price.
    test('tenant downgrade is judged against the price the tenant pays (snapshot), not the edited catalog price', async () => {
        const plan = await SubscriptionPlan.create({
            name: 'Legacy Pro', slug: 'legacy-pro-op', price: 1999, features: { dineIn: true, crm: true },
        });
        const t = await seedTenant({ label: 'snap' });
        await putOnPlan(t, plan, { razorpaySubscriptionId: 'sub_snap', currentPeriodEnd: new Date(Date.now() + 5 * 86400000) });
        // Catalog price later cut for NEW customers.
        await SA().put(`/superadmin/plans/${plan._id}`).send({ price: 500 });

        const req = await ctx.api.as(t.users.admin).post('/tenant/billing/downgrade-request')
            .send({ planId: String(plans.basic._id), reason: 'Moving to the basic tier please.' });
        expect(req.status).toBe(201);
        rzp.instance.subscriptions.cancel.mockResolvedValue({});
        const appr = await SA().post(`/superadmin/plan-change-requests/${req.body.data._id}/approve`).send({});
        expect(appr.status).toBe(200);
        // Before the fix: scheduled false, plan swapped to basic-op immediately,
        // subscriptions.cancel never called.
        expect(appr.body.data.scheduled).toBe(true);
        expect(rzp.instance.subscriptions.cancel).toHaveBeenCalledWith('sub_snap', true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('coverage of remaining mutating / money endpoints', () => {
    const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));

    test('resend-invitation: new temp password replaces the old one, hidden when the email was sent, audited', async () => {
        const t = await seedTenant({ label: 'inv' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { owner: t.users.admin._id } });
        const before = (await User.findById(t.users.admin._id).select('+password').lean()).password;

        const res = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/resend-invitation`).send({});
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ sent: true, temporaryPassword: null, email: t.users.admin.email });
        const after = await User.findById(t.users.admin._id).select('+password').lean();
        expect(after.password).not.toBe(before);
        expect(after.mustChangePassword).toBe(true);
        const mail = sendEmail.mock.calls.map(([m]) => m).find(m => m.to === t.users.admin.email);
        expect(mail).toBeTruthy();
        const audit = await auditFor('restaurant.resend_invitation', t.restaurant._id);
        expect(audit.details.ownerEmail).toBe(t.users.admin.email);
        expect(JSON.stringify(audit)).not.toMatch(BCRYPT_RE);

        // Email provider not configured → the operator gets the password once.
        sendEmail.mockResolvedValueOnce({ sent: false, provider: 'none', dev: true });
        const dev = await SA().post(`/superadmin/restaurants/${t.restaurant._id}/resend-invitation`).send({});
        expect(dev.body.data.temporaryPassword).toEqual(expect.any(String));

        const noOwner = await seedTenant({ label: 'inv2' });
        expect((await SA().post(`/superadmin/restaurants/${noOwner.restaurant._id}/resend-invitation`).send({})).status).toBe(400);
    });

    test('approve / reject signup: only pending signups, audited, approve unlocks with a fresh trial', async () => {
        const mk = (n) => Restaurant.create({
            name: `Signup ${n}`, slug: `signup-op-${n}`, contactEmail: `s${n}@signup.test`, status: 'suspended',
            signupSource: 'self', signupStatus: 'pending',
            subscription: { plan: plans.basic._id, planName: 'Basic', planSlug: 'basic-op' },
        });
        const a = await mk('a');
        const b = await mk('b');
        const ok = await SA().post(`/superadmin/restaurants/${a._id}/approve-signup`).send({});
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ status: 'trial', signupStatus: 'approved' });
        const trialEnd = new Date(ok.body.data.subscription.trialEndDate).getTime();
        expect(trialEnd - Date.now()).toBeGreaterThan(13 * 86400000);   // SELF_SIGNUP_TRIAL_DAYS default 14
        expect(await auditFor('restaurant.signup_approve', a._id)).toBeTruthy();
        expect((await SA().post(`/superadmin/restaurants/${a._id}/approve-signup`).send({})).status).toBe(400);
        expect((await SA().post(`/superadmin/restaurants/${a._id}/reject-signup`).send({ reason: 'x' })).status).toBe(400);

        expect((await SA().post(`/superadmin/restaurants/${b._id}/reject-signup`).send({ reason: '' })).status).toBe(400);
        const rej = await SA().post(`/superadmin/restaurants/${b._id}/reject-signup`).send({ reason: 'Fake FSSAI' });
        expect(rej.status).toBe(200);
        expect(rej.body.data).toMatchObject({ signupStatus: 'rejected', status: 'suspended', signupRejectedReason: 'Fake FSSAI' });
        expect(await auditFor('restaurant.signup_reject', b._id)).toBeTruthy();
    });

    test('audit purge: dry-run counts only; real run deletes only rows past each tenant\'s retention', async () => {
        const t = await seedTenant({ label: 'pur' });
        await putOnPlan(t, plans.basic);
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.limits.auditRetentionDays': 30 } });
        const old = await AuditLog.create({ action: 'x.old', targetType: 'restaurant', targetId: t.restaurant._id, actorEmail: 'sys' });
        const fresh = await AuditLog.create({ action: 'x.fresh', targetType: 'restaurant', targetId: t.restaurant._id, actorEmail: 'sys' });
        await AuditLog.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 31 * 86400000) } });

        const dry = await SA().post('/superadmin/audit-logs/purge').send({ dryRun: true });
        expect(dry.status).toBe(200);
        expect(dry.body.byTenant.find(r => r.slug === t.slug)).toMatchObject({ purged: 1, retentionDays: 30 });
        expect(await AuditLog.exists({ _id: old._id })).toBeTruthy();

        const real = await SA().post('/superadmin/audit-logs/purge').send({});
        expect(real.body.dryRun).toBe(false);
        expect(await AuditLog.exists({ _id: old._id })).toBeNull();
        expect(await AuditLog.exists({ _id: fresh._id })).toBeTruthy();
    });

    test('subscription-payments ledger: summary sums PAISE exactly by status', async () => {
        const t = await seedTenant({ label: 'led' });
        const base = { restaurant: t.restaurant._id, restaurantName: 'Ledger', planName: 'Pro', currency: 'INR' };
        await SubscriptionInvoice.create([
            { ...base, invoiceNumber: 'L-1', amount: 199900, razorpayPaymentId: 'pay_led1', status: 'paid' },
            { ...base, invoiceNumber: 'L-2', amount: 99900, razorpayPaymentId: 'pay_led2', status: 'partially_refunded' },
            { ...base, invoiceNumber: 'L-3', amount: 50000, razorpayPaymentId: 'pay_led3', status: 'refunded' },
        ]);
        const res = await SUP().get('/superadmin/subscription-payments?search=Ledger');
        expect(res.status).toBe(200);
        expect(res.body.data.payments).toHaveLength(3);
        const all = await SUP().get('/superadmin/subscription-payments');
        const s = all.body.data.summary;
        // Only this file writes invoices with these statuses besides the ledger rows above.
        const rows = await SubscriptionInvoice.find({}).lean();
        const sum = (st) => rows.filter(r => st.includes(r.status)).reduce((a, r) => a + r.amount, 0);
        expect(s.grossAmount).toBe(sum(['paid', 'partially_refunded']));
        expect(s.refundedAmount).toBe(sum(['refunded']));
        expect(s.refundedAmount).toBe(50000);
        expect(Number.isInteger(s.grossAmount)).toBe(true);
        expect(s.totalCount).toBe(rows.length);
    });
});
