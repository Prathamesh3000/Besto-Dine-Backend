/**
 * Super Admin → Pending Approvals detail endpoints:
 *   - GET   /superadmin/approvals/signups/:id          (shape + duplicate checks)
 *   - PATCH /superadmin/approvals/signups/:id/note     (full superadmin only)
 *   - GET   /superadmin/approvals/plan-changes/:requestId (comparison, usage, violations)
 *   - GET   /superadmin/approvals/payments/:id         (amount due, invoices)
 * plus permission (non-superadmin 403) and id validation / 404s.
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const PlanChangeRequest = require(path.join(BACKEND, 'models/planChangeRequest'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const Lead = require(path.join(BACKEND, 'models/lead'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));

const ctx = useIntegrationApp();
const FRONTEND = 'http://localhost:5173';

let full;
let support;
let tenant;
let plans;
let signupRestaurant;
let signupOwner;
let adminCreated;

beforeAll(async () => {
    plans = {
        free: await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0 }),
        basic: await SubscriptionPlan.create({
            name: 'Basic', slug: 'basic', price: 999, trialDays: 7,
            features: { dineIn: true, inventory: true, revenueAnalytics: 'basic' },
            limits: { maxBranches: 1, maxTables: 1, maxStaff: 50, maxMenuItems: 500 },
        }),
        pro: await SubscriptionPlan.create({
            name: 'Pro', slug: 'pro', price: 1999, razorpayPlanId: 'plan_secret_xyz',
            features: { dineIn: true, inventory: true, crm: true, revenueAnalytics: 'advanced' },
            limits: { maxBranches: 3, maxTables: 50, maxStaff: 20, maxMenuItems: 400 },
        }),
    };
    full = await createUser({ name: 'Root', email: 'root@platform.test', role: 'superadmin', superadminLevel: 'full' });
    support = await createUser({ name: 'Helper', email: 'help@platform.test', role: 'superadmin', superadminLevel: 'support' });
    tenant = await seedTenant({ label: 'apd' });

    // ── The self-signup under review ─────────────────────────────────
    signupRestaurant = await Restaurant.create({
        name: 'Spice Garden',
        slug: 'spice-garden-apd',
        contactEmail: 'Owner.Spice@Hotels.test',
        contactPhone: '9876543210',
        city: 'Pune',
        status: 'suspended',
        signupSource: 'self',
        signupStatus: 'pending',
        signupNote: 'Opening next month',
        subscription: { plan: plans.free._id, planName: 'Free', planSlug: 'free' },
        requestedPlan: { plan: plans.pro._id, planName: 'Pro', planSlug: 'pro' },
        signupMeta: {
            ownerName: 'Asha', source: 'home-hero', utmSource: 'google', utmCampaign: 'launch',
            termsAcceptedAt: new Date(), ip: '10.1.2.3',
        },
    });
    // createdAt is immutable through Mongoose — backdate via the driver.
    await Restaurant.collection.updateOne(
        { _id: signupRestaurant._id },
        { $set: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 60000) } },
    );
    signupOwner = await createUser({
        name: 'Asha Owner', email: 'owner.spice@hotels.test', mobile: '9876543210',
        role: 'admin', restaurant: signupRestaurant._id, isTenantOwner: true,
    });
    await Restaurant.updateOne({ _id: signupRestaurant._id }, { $set: { owner: signupOwner._id } });
    await AuditLog.create({
        actor: null, actorEmail: 'self-signup', actorRole: 'system',
        action: 'restaurant.self_signup', targetType: 'restaurant', targetId: signupRestaurant._id,
        targetName: 'Spice Garden', details: { plan: 'free', requestedPlan: 'pro', source: 'home-hero' },
    });

    // ── Records that the checks must find ────────────────────────────
    await Restaurant.create({   // same email (stored lowercase by the schema)
        name: 'Other Place', slug: 'other-place-apd', contactEmail: 'OWNER.SPICE@hotels.test', city: 'Mumbai',
    });
    await Restaurant.create({   // same phone, different formatting + a previous rejection
        name: 'Spice Garden Old', slug: 'spice-old-apd', contactEmail: 'old@hotels.test',
        contactPhone: '+91 98765-43210', city: 'Nashik',
        signupSource: 'self', signupStatus: 'rejected', signupRejectedReason: 'Fake FSSAI', signupReviewedAt: new Date(),
    });
    await Restaurant.create({   // same name + city, different case
        name: 'SPICE GARDEN', slug: 'spice-garden-2-apd', contactEmail: 'x@hotels.test', city: 'pune',
    });
    await Restaurant.create({   // unrelated — must not appear anywhere
        name: 'Unrelated', slug: 'unrelated-apd', contactEmail: 'u@hotels.test', contactPhone: '9123456789', city: 'Pune',
    });
    await Lead.create({ name: 'Asha', restaurantName: 'Spice Garden', phone: '09876543210', source: 'marketing-home-hero' });
    await Lead.create({ name: 'Nobody', restaurantName: 'Nope', phone: '9000000000', email: 'nobody@x.test' });

    adminCreated = await Restaurant.create({
        name: 'Admin Made', slug: 'admin-made-apd', contactEmail: 'admin-made@hotels.test',
    });
});

describe('GET /superadmin/approvals/signups/:id', () => {
    test('returns the application, owner, plan, meta, checks and activity', async () => {
        const res = await ctx.api.as(support).get(`/superadmin/approvals/signups/${signupRestaurant._id}`);
        expect(res.status).toBe(200);
        const d = res.body.data;

        expect(d.application).toMatchObject({
            name: 'Spice Garden', slug: 'spice-garden-apd', city: 'Pune',
            contactEmail: 'owner.spice@hotels.test', contactPhone: '9876543210',
            signupNote: 'Opening next month', signupStatus: 'pending', status: 'suspended',
            pageUrl: `${FRONTEND}/spice-garden-apd`,
        });
        expect(d.application.waitingSince).toBe(3);

        expect(d.owner).toMatchObject({ name: 'Asha Owner', email: 'owner.spice@hotels.test', mobile: '9876543210' });
        expect(d.owner.password).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);          // no bcrypt hashes
        expect(JSON.stringify(res.body)).not.toContain('plan_secret_xyz');    // no Razorpay ids

        expect(d.requestedPlan).toMatchObject({ name: 'Pro', price: 1999, currency: 'INR', billingCycle: 'monthly' });
        expect(d.requestedPlan.features.crm).toBe(true);
        expect(d.requestedPlan.limits.maxTables).toBe(50);
        expect(d.subscriptionPlan.planName).toBe('Free');
        expect(d.signupMeta).toMatchObject({ source: 'home-hero', utmSource: 'google', utmCampaign: 'launch', ip: '10.1.2.3' });
        expect(d.signupMeta.termsAcceptedAt).toBeTruthy();

        const names = (list) => list.map((x) => x.name).sort();
        expect(names(d.checks.duplicateEmail)).toEqual(['Other Place']);
        expect(names(d.checks.duplicatePhone)).toEqual(['Spice Garden Old']);
        expect(names(d.checks.sameNameCity)).toEqual(['SPICE GARDEN']);
        expect(d.checks.previousRejections).toEqual([
            expect.objectContaining({ name: 'Spice Garden Old', reason: 'Fake FSSAI' }),
        ]);
        expect(d.checks.matchingLeads).toEqual([
            expect.objectContaining({ name: 'Asha', restaurantName: 'Spice Garden', status: 'new' }),
        ]);
        // The application itself is never reported as its own duplicate.
        const allIds = Object.values(d.checks).flat().map((x) => String(x._id));
        expect(allIds).not.toContain(String(signupRestaurant._id));

        expect(d.activity[0]).toMatchObject({ action: 'restaurant.self_signup', actorName: 'self-signup' });
        expect(d.activity[0].summary).toMatch(/requestedPlan: pro/);
        expect(d.reviewNote).toEqual({ text: '', updatedAt: null, updatedByName: '' });
    });

    test('404 for an admin-created tenant, a missing id; 400 for a malformed id', async () => {
        const a = await ctx.api.as(full).get(`/superadmin/approvals/signups/${adminCreated._id}`);
        expect(a.status).toBe(404);
        const b = await ctx.api.as(full).get('/superadmin/approvals/signups/0123456789abcdef01234567');
        expect(b.status).toBe(404);
        const c = await ctx.api.as(full).get('/superadmin/approvals/signups/not-an-id');
        expect(c.status).toBe(400);
    });

    test('non-superadmin gets 403', async () => {
        const res = await ctx.api.as(tenant.users.admin).get(`/superadmin/approvals/signups/${signupRestaurant._id}`);
        expect(res.status).toBe(403);
    });
});

describe('PATCH /superadmin/approvals/signups/:id/note', () => {
    const url = () => `/superadmin/approvals/signups/${signupRestaurant._id}/note`;

    test('support-level superadmin and tenant admin are refused', async () => {
        expect((await ctx.api.as(support).patch(url()).send({ reviewNote: 'x' })).status).toBe(403);
        expect((await ctx.api.as(tenant.users.admin).patch(url()).send({ reviewNote: 'x' })).status).toBe(403);
    });

    test('rejects notes over 1000 characters', async () => {
        const res = await ctx.api.as(full).patch(url()).send({ reviewNote: 'a'.repeat(1001) });
        expect(res.status).toBe(400);
    });

    test('full superadmin saves the note; it is audited and hidden from default reads', async () => {
        const res = await ctx.api.as(full).patch(url()).send({ reviewNote: '  Called owner, legit.  ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ text: 'Called owner, legit.', updatedByName: 'Root' });

        const detail = await ctx.api.as(support).get(`/superadmin/approvals/signups/${signupRestaurant._id}`);
        expect(detail.body.data.reviewNote).toMatchObject({ text: 'Called owner, legit.', updatedByName: 'Root' });
        expect(detail.body.data.activity[0].action).toBe('restaurant.signup_note');

        // select:false — ordinary reads (e.g. tenant-facing code) never see it.
        const plain = await Restaurant.findById(signupRestaurant._id).lean();
        expect(plain.signupReviewNote).toBeUndefined();
        const general = await ctx.api.as(full).get(`/superadmin/restaurants/${signupRestaurant._id}`);
        expect(JSON.stringify(general.body)).not.toContain('Called owner');

        const audit = await AuditLog.findOne({ action: 'restaurant.signup_note', targetId: signupRestaurant._id }).lean();
        expect(audit).toBeTruthy();
        expect(String(audit.actor)).toBe(String(full._id));
    });

    test('404 for a non-signup restaurant', async () => {
        const res = await ctx.api.as(full).patch(`/superadmin/approvals/signups/${adminCreated._id}/note`).send({ reviewNote: 'x' });
        expect(res.status).toBe(404);
    });
});

describe('GET /superadmin/approvals/plan-changes/:requestId', () => {
    let downgrade;
    let upgrade;

    beforeAll(async () => {
        // Tenant is on Pro (snapshot) with 2 tables in use.
        await Restaurant.updateOne({ _id: tenant.restaurant._id }, {
            $set: {
                'subscription.plan': plans.pro._id,
                'subscription.planName': 'Pro',
                'subscription.price': 1999,
                'subscription.features': plans.pro.features.toObject(),
                'subscription.limits': plans.pro.limits.toObject(),
                'subscription.currentPeriodEnd': new Date('2030-01-31T00:00:00Z'),
            },
        });
        downgrade = await PlanChangeRequest.create({
            restaurant: tenant.restaurant._id,
            requestedPlan: plans.basic._id, requestedPlanName: 'Basic', requestedPlanPrice: 999,
            currentPlan: plans.pro._id, currentPlanName: 'Pro',
            note: 'Cutting costs', requestSource: 'tenant', requestedByEmail: 'owner@x.test',
        });
        upgrade = await PlanChangeRequest.create({
            restaurant: tenant.restaurant._id,
            requestedPlan: plans.basic._id, requestedPlanName: 'Basic', requestedPlanPrice: 999,
            currentPlan: plans.pro._id, currentPlanName: 'Pro',
            requestSource: 'operator', status: 'rejected', rejectedReason: 'dup',
        });
    });

    test('tenant downgrade: cycle-end timing, comparison, usage and violations', async () => {
        const res = await ctx.api.as(support).get(`/superadmin/approvals/plan-changes/${downgrade._id}`);
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.request).toMatchObject({ status: 'pending', note: 'Cutting costs', requestSource: 'tenant', direction: 'downgrade' });
        expect(d.request.timing.mode).toBe('cycle_end');
        expect(d.request.timing.effectiveAt).toBe('2030-01-31T00:00:00.000Z');
        expect(d.restaurant).toMatchObject({ name: tenant.restaurant.name, slug: tenant.slug });
        expect(d.currentPlan).toMatchObject({ name: 'Pro', price: 1999, billingCycle: 'monthly' });
        expect(d.requestedPlan).toMatchObject({ name: 'Basic', price: 999, trialDays: 7 });

        expect(d.comparison.featuresRemoved).toContain('crm');
        expect(d.comparison.featuresAdded).toEqual([]);
        expect(d.comparison.featureChanges).toEqual([{ key: 'revenueAnalytics', from: 'advanced', to: 'basic' }]);
        expect(d.comparison.limitChanges).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'maxTables', from: 50, to: 1, change: 'decrease' }),
            expect.objectContaining({ key: 'maxStaff', from: 20, to: 50, change: 'increase' }),
        ]));

        expect(d.usage).toEqual({ branches: 1, tables: 2, staff: 4, menuItems: 3 });
        expect(d.limitViolations).toEqual([
            expect.objectContaining({ key: 'maxTables', used: 2, limit: 1, message: 'Tables: 2 in use, new plan allows 1' }),
        ]);
        expect(Array.isArray(d.activity)).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain('plan_secret_xyz');
    });

    test('operator request is applied immediately (resolved requests still readable)', async () => {
        const res = await ctx.api.as(full).get(`/superadmin/approvals/plan-changes/${upgrade._id}`);
        expect(res.status).toBe(200);
        expect(res.body.data.request).toMatchObject({ status: 'rejected', rejectedReason: 'dup' });
        expect(res.body.data.request.timing.mode).toBe('immediate');
    });

    test('404 unknown, 400 malformed, 403 non-superadmin', async () => {
        expect((await ctx.api.as(full).get('/superadmin/approvals/plan-changes/0123456789abcdef01234567')).status).toBe(404);
        expect((await ctx.api.as(full).get('/superadmin/approvals/plan-changes/zzz')).status).toBe(400);
        expect((await ctx.api.as(tenant.users.admin).get(`/superadmin/approvals/plan-changes/${downgrade._id}`)).status).toBe(403);
    });
});

describe('GET /superadmin/approvals/payments/:id', () => {
    let payTenant;

    beforeAll(async () => {
        payTenant = await Restaurant.create({
            name: 'Cash Cafe', slug: 'cash-cafe-apd', contactEmail: 'cash@hotels.test', contactPhone: '9988776655',
            status: 'suspended', suspendedReason: 'Awaiting payment',
            paymentStatus: 'pending', paymentNote: 'Will pay by UPI on Friday',
            subscription: { plan: plans.pro._id, planName: 'Pro', planSlug: 'pro', price: 1500 },
        });
        await SubscriptionInvoice.create({
            restaurant: payTenant._id, restaurantName: 'Cash Cafe', invoiceNumber: 'INV-20300101-0001',
            planName: 'Pro', amount: 199900, razorpayPaymentId: 'pay_apd_1', paidAt: new Date('2030-01-01T00:00:00Z'),
        });
        // Another tenant's invoice must never leak into this page.
        await SubscriptionInvoice.create({
            restaurant: tenant.restaurant._id, invoiceNumber: 'INV-OTHER', amount: 100, razorpayPaymentId: 'pay_apd_other',
        });
    });

    test('returns restaurant, plan, amount due and the tenant\'s own invoices', async () => {
        const res = await ctx.api.as(support).get(`/superadmin/approvals/payments/${payTenant._id}`);
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.restaurant).toMatchObject({
            name: 'Cash Cafe', paymentStatus: 'pending', paymentNote: 'Will pay by UPI on Friday', status: 'suspended',
        });
        expect(d.plan).toMatchObject({ name: 'Pro', price: 1999, agreedPrice: 1500, currency: 'INR', billingCycle: 'monthly' });
        expect(d.amountDue).toBe(1500);
        expect(d.invoices).toEqual([
            expect.objectContaining({ number: 'INV-20300101-0001', amount: 199900, status: 'paid', method: 'razorpay' }),
        ]);
        expect(JSON.stringify(res.body)).not.toContain('pay_apd_1');
    });

    test('404 unknown, 400 malformed, 403 non-superadmin', async () => {
        expect((await ctx.api.as(full).get('/superadmin/approvals/payments/0123456789abcdef01234567')).status).toBe(404);
        expect((await ctx.api.as(full).get('/superadmin/approvals/payments/nope')).status).toBe(400);
        expect((await ctx.api.as(tenant.users.waiter).get(`/superadmin/approvals/payments/${payTenant._id}`)).status).toBe(403);
    });
});
