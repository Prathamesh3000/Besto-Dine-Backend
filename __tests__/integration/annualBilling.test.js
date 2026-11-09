/**
 * Annual / 2-year billing, end to end (PRICING_PACKAGING §3).
 *
 *   - plan cards + public plans expose prices / cycles / GST
 *   - upgrade { planId, billingCycle } -> order = base x 1.18 -> verify -> term
 *     is +12 / +24 months, invoice carries cycle + base + GST + total
 *   - webhook payment.captured and subscription.charged for prepaid cycles
 *     (period start = current_start, not start_at)
 *   - GST-aware amount check (base-only payment is refused)
 *   - term rules: no plan change inside a prepaid term, renewal window,
 *     same price at renewal, trial owner can buy the plan they trialled
 *   - MRR is normalised by cycle
 *   - stale Razorpay plan ids are invalidated when a price is edited
 *   - renewal reminders + lapse rule, migrations (dry-run + idempotent)
 *
 * Units: Razorpay + SubscriptionInvoice amounts are PAISE, plan prices RUPEES.
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');
const { V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));
const { LINEUP } = require(path.join(BACKEND, 'config/planLineup'));
const { applyPlanLineup } = require(path.join(BACKEND, 'migrations/applyPlanLineup2026'));
const { backfillBillingCycle } = require(path.join(BACKEND, 'migrations/backfillBillingCycle'));
const renewal = require(path.join(BACKEND, 'utils/renewalReminderJob'));

const ctx = useIntegrationApp();

const DAY = 24 * 60 * 60 * 1000;
const sign = (orderId, paymentId) => crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const whSign = (raw) => crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
const rid = () => crypto.randomBytes(5).toString('hex');

let silver;
let gold;
let superadmin;

const owner = (t) => ctx.api.as(t.users.admin);
const sub = async (t) => (await Restaurant.findById(t.restaurant._id).lean()).subscription;

async function putOnPlan(t, plan, extra = {}, restaurantSet = {}) {
    const p = plan.toObject();
    await Restaurant.updateOne({ _id: t.restaurant._id }, {
        $set: {
            ...restaurantSet,
            subscription: {
                plan: p._id, planName: p.name, planSlug: p.slug, price: p.price, billingCycle: 'monthly',
                features: p.features, limits: p.limits, status: 'active', ...extra,
            },
        },
    });
}

/** Fallback (Orders API) path: plan sync 401s, customer + order succeed. */
function stubOrders(orderId) {
    rzp.instance.plans.create.mockRejectedValue({ statusCode: 401, error: { description: 'Subscriptions not enabled' } });
    rzp.instance.customers.create.mockResolvedValue({ id: 'cust_ab' });
    rzp.instance.orders.create.mockImplementation(async (args) => ({ id: orderId, amount: args.amount, currency: args.currency }));
}

function verify(t, { orderId, paymentId, amount, planSlug }) {
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
        notes: { type: 'plan_payment', restaurantId: String(t.restaurant._id), planSlug },
    });
    return owner(t).post('/tenant/billing/upgrade/verify').send({
        razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId),
    });
}

const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());

beforeAll(async () => {
    // The real line-up prices (Silver 699 / 6,999 / 11,199 ...).
    for (const spec of LINEUP.filter(p => ['silver', 'gold'].includes(p.slug))) {
        await SubscriptionPlan.create({ ...spec, slug: `${spec.slug}-ab`, name: spec.name });
    }
    silver = await SubscriptionPlan.findOne({ slug: 'silver-ab' });
    gold = await SubscriptionPlan.findOne({ slug: 'gold-ab' });
    superadmin = await createUser({ name: 'Root', email: 'root.ab@platform.test', role: 'superadmin', superadminLevel: 'full' });
});

beforeEach(() => {
    rzp.instance.orders.create.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════
describe('plan cards + public plans', () => {
    test('tenant plan card: prices, gstRate and cycles with GST / per-month / savings', async () => {
        const t = await seedTenant({ label: 'card' });
        await putOnPlan(t, silver);
        const res = await owner(t).get('/tenant/billing/plans');
        expect(res.status).toBe(200);
        expect(res.body.data.gstRate).toBe(18);
        expect(res.body.data.currentBillingCycle).toBe('monthly');
        const card = res.body.data.plans.find(p => p.slug === 'gold-ab');
        expect(card.prices).toEqual({ monthly: 1799, annual: 17999, biennial: 28799 });
        expect(card.price).toBe(1799);
        expect(card.cycles).toEqual([
            { cycle: 'monthly', months: 1, price: 1799, gst: 323.82, total: 2122.82, perMonthEquivalent: 1799, savingsPctVsMonthly: 0 },
            { cycle: 'annual', months: 12, price: 17999, gst: 3239.82, total: 21238.82, perMonthEquivalent: 1499.92, savingsPctVsMonthly: 17 },
            { cycle: 'biennial', months: 24, price: 28799, gst: 5183.82, total: 33982.82, perMonthEquivalent: 1199.96, savingsPctVsMonthly: 33 },
        ]);
    });

    test('public plans keep the old fields and add prices / cycles / gstRate', async () => {
        const res = await ctx.api.raw.get(`${V1}/public/plans`);
        expect(res.status).toBe(200);
        const list = res.body.data || res.body.plans || res.body;
        const s = list.find(p => p.slug === 'silver-ab');
        expect(s).toMatchObject({ price: 699, billingCycle: 'monthly', gstRate: 18 });
        expect(s.prices).toEqual({ monthly: 699, annual: 6999, biennial: 11199 });
        expect(s.cycles.map(c => c.cycle)).toEqual(['monthly', 'annual', 'biennial']);
        expect(JSON.stringify(s)).not.toMatch(/razorpayPlan/);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('purchase through the Orders path (upgrade -> verify)', () => {
    test.each([
        ['annual', 12, 6999, 825882, 125982, 'a12'],
        ['biennial', 24, 11199, 1321482, 201582, 'b24'],
    ])('Silver %s: order = base x 1.18, term +%i months, invoice carries cycle + GST', async (cycle, months, base, total, gst, tag) => {
        const t = await seedTenant({ label: `buy${tag}` });
        await putOnPlan(t, silver);                         // monthly Silver -> same plan, longer cycle
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.status': 'trial' } });
        stubOrders(`order_${tag}`);

        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(silver._id), billingCycle: cycle });
        expect(up.status).toBe(200);
        expect(up.body.data.pendingUpgrade).toMatchObject({ billingCycle: cycle, price: base, total: total / 100, renewal: false });
        expect(up.body.data.billing.amount).toBe(total);
        const args = rzp.instance.orders.create.mock.calls[0][0];
        expect(args.amount).toBe(total);
        expect(args.notes).toMatchObject({ billingCycle: cycle, basePaise: String(base * 100), gstRate: '18' });
        expect((await sub(t)).pendingUpgrade).toMatchObject({ billingCycle: cycle, price: base });

        const res = await verify(t, { orderId: `order_${tag}`, paymentId: `pay_${tag}`, amount: total, planSlug: 'silver-ab' });
        expect(res.status).toBe(200);
        const s = await sub(t);
        expect(s).toMatchObject({ billingCycle: cycle, price: base, status: 'active' });
        const start = new Date();
        const end = new Date(s.currentPeriodEnd);
        expect(monthsBetween(start, end)).toBe(months);
        expect(Math.abs(end.getDate() - start.getDate())).toBeLessThanOrEqual(3);

        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: `pay_${tag}` }).lean();
        expect(inv).toMatchObject({ billingCycle: cycle, amount: total, baseAmount: base * 100, gstAmount: gst, gstRate: 18 });
        expect(inv.baseAmount + inv.gstAmount).toBe(inv.amount);
        expect(new Date(inv.periodEnd).getTime()).toBe(end.getTime());

        const list = await owner(t).get('/tenant/billing/invoices');
        expect(list.body.data[0]).toMatchObject({ billingCycle: cycle, baseAmount: base * 100, gstAmount: gst, gstRate: 18, amount: total });
        const pdf = await owner(t).get(`/tenant/billing/invoices/${inv._id}/download`);
        expect(pdf.status).toBe(200);
    });

    test('paying only the base price (no GST) is refused: PAYMENT_PLAN_MISMATCH, nothing applied', async () => {
        const t = await seedTenant({ label: 'nogst' });
        await putOnPlan(t, silver, { status: 'trial' });
        stubOrders('order_nogst');
        await owner(t).post('/tenant/billing/upgrade').send({ planId: String(silver._id), billingCycle: 'annual' });
        const res = await verify(t, { orderId: 'order_nogst', paymentId: 'pay_nogst', amount: 699900, planSlug: 'silver-ab' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_PLAN_MISMATCH');
        expect(await SubscriptionInvoice.countDocuments({ razorpayPaymentId: 'pay_nogst' })).toBe(0);
        expect((await sub(t)).billingCycle).toBe('monthly');
    });

    test('validation: unknown cycle -> INVALID_CYCLE; cycle the plan does not sell -> CYCLE_NOT_AVAILABLE', async () => {
        const t = await seedTenant({ label: 'val' });
        await putOnPlan(t, silver);
        const bad = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(gold._id), billingCycle: 'weekly' });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('INVALID_CYCLE');
        const only = await SubscriptionPlan.create({ name: 'MonthlyOnly', slug: 'monthly-only-ab', price: 2500, prices: { monthly: 2500 }, sortOrder: 9 });
        const na = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(only._id), billingCycle: 'annual' });
        expect(na.status).toBe(400);
        expect(na.body.code).toBe('CYCLE_NOT_AVAILABLE');
    });

    test('omitting billingCycle behaves as before: monthly, order = price + GST', async () => {
        const t = await seedTenant({ label: 'dflt' });
        await putOnPlan(t, silver);
        stubOrders('order_dflt');
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(gold._id) });
        expect(up.status).toBe(200);
        expect(up.body.data.billing.amount).toBe(212282);   // 1,799 + 18%
        expect((await sub(t)).pendingUpgrade).toMatchObject({ billingCycle: 'monthly', price: 1799 });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('term rules (no proration, no credits)', () => {
    async function onAnnual(label, plan = silver, daysLeft = 200) {
        const t = await seedTenant({ label });
        await putOnPlan(t, plan, {
            billingCycle: 'annual', price: plan.prices.annual, razorpayStatus: 'active',
            currentPeriodEnd: new Date(Date.now() + daysLeft * DAY),
        });
        return t;
    }

    test('inside a prepaid term a different plan is refused: TERM_ACTIVE with the dates', async () => {
        const t = await onAnnual('ta1');
        stubOrders('order_ta1');
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(gold._id), billingCycle: 'annual' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TERM_ACTIVE');
        expect(res.body.data.currentPeriodEnd).toBeTruthy();
        expect(res.body.data.renewalWindowOpensAt).toBeTruthy();
        expect((await sub(t)).pendingUpgrade?.planSlug || '').toBe('');
    });

    test('same plan, other cycle, before the renewal window: TERM_ACTIVE too', async () => {
        const t = await onAnnual('ta2');
        const res = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(silver._id), billingCycle: 'biennial' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TERM_ACTIVE');
    });

    test('same plan inside the 30-day renewal window = renewal: same price, new term starts at the old end', async () => {
        const t = await onAnnual('ta3', silver, 10);
        const oldEnd = new Date((await sub(t)).currentPeriodEnd);
        stubOrders('order_ta3');
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(silver._id), billingCycle: 'annual' });
        expect(up.status).toBe(200);
        expect(up.body.data.pendingUpgrade).toMatchObject({ renewal: true, price: 6999 });   // same price at renewal
        expect(up.body.data.pendingUpgrade.subscriptionId).toBe('');                          // one-time order, no overlapping subscription
        expect(up.body.data.billing.amount).toBe(825882);

        const res = await verify(t, { orderId: 'order_ta3', paymentId: 'pay_ta3', amount: 825882, planSlug: 'silver-ab' });
        expect(res.status).toBe(200);
        const s = await sub(t);
        expect(monthsBetween(oldEnd, new Date(s.currentPeriodEnd))).toBe(12);   // extends from the END, no lost days
        expect(s.renewalReminderSentFor).toEqual([]);
        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: 'pay_ta3' }).lean();
        expect(new Date(inv.periodStart).getTime()).toBe(oldEnd.getTime());
    });

    test('/current exposes cycle, price, gstRate and when the renewal window opens', async () => {
        const t = await onAnnual('ta4');
        const res = await owner(t).get('/tenant/billing/current');
        expect(res.status).toBe(200);
        expect(res.body.data.subscription).toMatchObject({ billingCycle: 'annual', price: 6999, gstRate: 18 });
        expect(res.body.data.subscription.renewalWindowOpensAt).toBeTruthy();
    });

    test('downgrade request compares monthly equivalents: annual Gold (1,500/mo) -> Silver is a downgrade, Silver annual -> Silver monthly list is not', async () => {
        const t = await onAnnual('ta5', gold);
        const reason = 'We are a small cafe and do not need the extra features.';
        const ok = await owner(t).post('/tenant/billing/downgrade-request').send({ planId: String(silver._id), reason });
        expect(ok.status).toBe(201);
    });

    test('a trial owner can buy the plan they trialled (same plan is not SAME_PLAN)', async () => {
        const t = await seedTenant({ label: 'trl' });
        await putOnPlan(t, gold, { status: 'trial', trialEndDate: new Date(Date.now() + 5 * DAY) });
        stubOrders('order_trl');
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(gold._id), billingCycle: 'annual' });
        expect(up.status).toBe(200);
        expect(up.body.data.billing.amount).toBe(2123882);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('webhooks', () => {
    function deliver(payload) {
        const body = JSON.stringify(payload);
        return ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json')
            .set('X-Razorpay-Signature', whSign(body)).send(body);
    }

    test('payment.captured plan_payment for an annual pending upgrade: +12 months, GST invoice, once', async () => {
        const t = await seedTenant({ label: 'whp' });
        await putOnPlan(t, silver, { status: 'trial' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.pendingUpgrade': {
            plan: gold._id, planName: 'Gold', planSlug: 'gold-ab', price: 17999, billingCycle: 'annual', fallbackOrder: true,
            features: {}, limits: {},
        } } });
        const evt = { event: 'payment.captured', payload: { payment: { entity: {
            id: `pay_${rid()}`, amount: 2123882, currency: 'INR', status: 'captured', order_id: `order_${rid()}`,
            notes: { type: 'plan_payment', restaurantId: String(t.restaurant._id) }, created_at: 1767225600,
        } } } };
        expect((await deliver(evt)).status).toBe(200);
        expect((await deliver(evt)).status).toBe(200);
        const s = await sub(t);
        expect(s).toMatchObject({ planSlug: 'gold-ab', billingCycle: 'annual', price: 17999 });
        expect(monthsBetween(new Date(), new Date(s.currentPeriodEnd))).toBe(12);
        const invs = await SubscriptionInvoice.find({ razorpayPaymentId: evt.payload.payment.entity.id }, null, { skipTenantScope: true }).lean();
        expect(invs).toHaveLength(1);
        expect(invs[0]).toMatchObject({ billingCycle: 'annual', baseAmount: 1799900, gstAmount: 323982, gstRate: 18, amount: 2123882 });
    });

    test('subscription.charged on a yearly Razorpay subscription: period = current_start..current_end, cycle + GST on the invoice', async () => {
        const t = await seedTenant({ label: 'whs' });
        const subId = `sub_${rid()}`;
        await putOnPlan(t, silver, { status: 'trial', razorpaySubscriptionId: subId, razorpayStatus: 'authenticated' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.pendingUpgrade': {
            plan: silver._id, planName: 'Silver', planSlug: 'silver-ab', price: 6999, billingCycle: 'annual',
            razorpaySubscriptionId: subId, features: {}, limits: {},
        } } });
        const currentStart = 1767225600;                       // 2026-01-01
        const currentEnd = 1798761600;                         // 2027-01-01
        const pmt = { id: `pay_${rid()}`, amount: 825882, currency: 'INR', created_at: currentStart };
        const evt = { event: 'subscription.charged', payload: {
            subscription: { entity: { id: subId, status: 'active', current_start: currentStart, current_end: currentEnd, start_at: currentStart - 400 * 86400 } },
            payment: { entity: pmt },
        } };
        expect((await deliver(evt)).status).toBe(200);
        const s = await sub(t);
        expect(s).toMatchObject({ billingCycle: 'annual', price: 6999, status: 'active' });
        expect(new Date(s.currentPeriodEnd).toISOString()).toBe('2027-01-01T00:00:00.000Z');
        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: pmt.id }, null, { skipTenantScope: true }).lean();
        expect(inv).toMatchObject({ billingCycle: 'annual', amount: 825882, baseAmount: 699900, gstAmount: 125982, gstRate: 18, razorpaySubscriptionId: subId });
        expect(new Date(inv.periodStart).toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(new Date(inv.periodEnd).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    test('a pre-GST charge on an old monthly subscription is invoiced as base only (no GST invented)', async () => {
        const t = await seedTenant({ label: 'whl' });
        const subId = `sub_${rid()}`;
        await putOnPlan(t, silver, { razorpaySubscriptionId: subId, razorpayStatus: 'active' });
        const pmt = { id: `pay_${rid()}`, amount: 69900, currency: 'INR', created_at: 1767225600 };
        const evt = { event: 'subscription.charged', payload: {
            subscription: { entity: { id: subId, status: 'active', current_start: 1767225600, current_end: 1769904000 } },
            payment: { entity: pmt },
        } };
        expect((await deliver(evt)).status).toBe(200);
        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: pmt.id }, null, { skipTenantScope: true }).lean();
        expect(inv).toMatchObject({ billingCycle: 'monthly', amount: 69900, baseAmount: 69900, gstAmount: 0, gstRate: 0 });
    });

    test('scheduled downgrade on a prepaid term is NOT forced by subscription.completed before the term ends', async () => {
        const t = await seedTenant({ label: 'whd' });
        const subId = `sub_${rid()}`;
        await putOnPlan(t, gold, {
            billingCycle: 'annual', razorpaySubscriptionId: subId, razorpayStatus: 'active',
            currentPeriodEnd: new Date(Date.now() + 100 * DAY),
            scheduledDowngrade: { plan: silver._id, planName: 'Silver', planSlug: 'silver-ab', price: 699, features: {}, limits: {}, effectiveAt: new Date(Date.now() + 100 * DAY) },
        });
        const evt = { event: 'subscription.completed', payload: { subscription: { entity: { id: subId, status: 'completed' } } } };
        expect((await deliver(evt)).status).toBe(200);
        const s = await sub(t);
        expect(s.planSlug).toBe('gold-ab');
        expect(s.scheduledDowngrade.planSlug).toBe('silver-ab');
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('MRR is normalised by billing cycle', () => {
    test('annual 6,999 counts as 583.25/month, biennial 11,199 as 466.63/month, monthly unchanged', async () => {
        const full = ctx.api.as(superadmin);
        const base = (await full.get('/superadmin/restaurants?limit=1')).body.summary.mrr;
        const baseAnalytics = (await full.get('/superadmin/analytics')).body;
        const a = await seedTenant({ label: 'mrra' });
        const b = await seedTenant({ label: 'mrrb' });
        const c = await seedTenant({ label: 'mrrc' });
        await putOnPlan(a, silver, { billingCycle: 'annual', price: 6999 }, { status: 'active' });
        await putOnPlan(b, silver, { billingCycle: 'biennial', price: 11199 }, { status: 'active' });
        await putOnPlan(c, silver, { billingCycle: 'monthly', price: 699 }, { status: 'active' });

        const after = (await full.get('/superadmin/restaurants?limit=1')).body.summary.mrr;
        expect(after - base).toBeCloseTo(6999 / 12 + 11199 / 24 + 699, 2);

        const an = (await full.get('/superadmin/analytics')).body;
        const mrrOf = (r) => (r.data || r).mrr.amount;
        expect(mrrOf(an) - mrrOf(baseAnalytics)).toBeCloseTo(6999 / 12 + 11199 / 24 + 699, 2);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('Super Admin plan editor', () => {
    test('prices are accepted and a changed price drops the stale Razorpay plan id of that cycle only', async () => {
        const full = ctx.api.as(superadmin);
        const p = await SubscriptionPlan.create({
            name: 'Edit', slug: 'edit-ab', price: 1000, prices: { monthly: 1000, annual: 10000, biennial: 16000 }, sortOrder: 8,
            razorpayPlanId: 'plan_m', razorpayPlanIds: { monthly: 'plan_m', annual: 'plan_a' },
            razorpayPlanAmounts: { monthly: 118000, annual: 1180000 },
        });
        const res = await full.put(`/superadmin/plans/${p._id}`).send({ prices: { annual: 12000 } });
        expect(res.status).toBe(200);
        expect(res.body.data.prices).toEqual({ monthly: 1000, annual: 12000, biennial: 16000 });
        const fresh = await SubscriptionPlan.findById(p._id).lean();
        expect(fresh.razorpayPlanIds.annual).toBe('');
        expect(fresh.razorpayPlanIds.monthly).toBe('plan_m');          // untouched cycle keeps its id
        expect(fresh.razorpayPlanId).toBe('plan_m');

        const monthly = await full.put(`/superadmin/plans/${p._id}`).send({ price: 1200 });
        expect(monthly.status).toBe(200);
        const f2 = await SubscriptionPlan.findById(p._id).lean();
        expect(f2.prices.monthly).toBe(1200);
        expect(f2.razorpayPlanId).toBe('');                             // legacy monthly alias invalidated too

        const bad = await full.put(`/superadmin/plans/${p._id}`).send({ prices: { annual: -5 } });
        expect(bad.status).toBe(400);
    });

    test('the next purchase after a price edit creates a NEW Razorpay plan at the new amount', async () => {
        const t = await seedTenant({ label: 'stale' });
        const p = await SubscriptionPlan.create({
            name: 'Stale', slug: 'stale-ab', price: 1000, prices: { monthly: 1000, annual: 10000 }, sortOrder: 7,
            razorpayPlanIds: { annual: 'plan_old_annual' }, razorpayPlanAmounts: { annual: 1180000 },
        });
        await SubscriptionPlan.updateOne({ _id: p._id }, { $set: { 'prices.annual': 11000 } });   // price edited out of band
        await putOnPlan(t, silver, { status: 'trial' });
        rzp.instance.customers.create.mockResolvedValue({ id: 'cust_st' });
        rzp.instance.plans.create.mockResolvedValue({ id: 'plan_new_annual' });
        rzp.instance.subscriptions.create.mockResolvedValue({ id: 'sub_st', status: 'created', short_url: 'https://rzp.io/st' });
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(p._id), billingCycle: 'annual' });
        expect(up.status).toBe(200);
        expect(rzp.instance.plans.create.mock.calls[0][0]).toMatchObject({ period: 'yearly', interval: 1, item: expect.objectContaining({ amount: 1298000 }) });
        expect(rzp.instance.subscriptions.create.mock.calls[0][0].plan_id).toBe('plan_new_annual');
        expect(rzp.instance.subscriptions.create.mock.calls[0][0].total_count).toBe(10);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('renewal reminders + lapse rule', () => {
    test('emails at 7 and 1 days once each; auto-renewing tenants are skipped; paying resets the markers', async () => {
        sendEmail.mockClear();
        const t = await seedTenant({ label: 'rem' });
        const auto = await seedTenant({ label: 'remauto' });
        const end = new Date(Date.now() + 6 * DAY);
        await putOnPlan(t, silver, { billingCycle: 'annual', currentPeriodEnd: end }, { contactEmail: 'owner-rem@x.test' });
        await putOnPlan(auto, silver, { billingCycle: 'annual', currentPeriodEnd: end, razorpaySubscriptionId: 'sub_auto', razorpayStatus: 'active' });

        const r1 = await renewal.runRenewalReminders();
        expect(r1.sent.map(x => x.id)).toContain(String(t.restaurant._id));
        expect(r1.sent.map(x => x.id)).not.toContain(String(auto.restaurant._id));
        expect(r1.sent.find(x => x.id === String(t.restaurant._id)).days).toBe(7);
        const mail = sendEmail.mock.calls.find(c => c[0].to === 'owner-rem@x.test')[0];
        expect(mail.subject).toMatch(/renews in 7 days/);

        const again = await renewal.runRenewalReminders();
        expect(again.sent.map(x => x.id)).not.toContain(String(t.restaurant._id));       // deduped

        const t1 = await renewal.runRenewalReminders({ now: new Date(Date.now() + 5.5 * DAY) });
        expect(t1.sent.find(x => x.id === String(t.restaurant._id)).days).toBe(1);        // the 1-day reminder
        const s = await sub(t);
        expect(s.renewalReminderSentFor).toHaveLength(2);
    });

    test('lapse: period end + 3 days with no live subscription -> past_due; auto-renew and in-grace tenants untouched', async () => {
        const lapsed = await seedTenant({ label: 'lap1' });
        const grace = await seedTenant({ label: 'lap2' });
        const auto = await seedTenant({ label: 'lap3' });
        await putOnPlan(lapsed, silver, { billingCycle: 'annual', currentPeriodEnd: new Date(Date.now() - 4 * DAY) }, { status: 'active' });
        await putOnPlan(grace, silver, { billingCycle: 'annual', currentPeriodEnd: new Date(Date.now() - 2 * DAY) }, { status: 'active' });
        await putOnPlan(auto, silver, { billingCycle: 'annual', currentPeriodEnd: new Date(Date.now() - 9 * DAY), razorpaySubscriptionId: 'sub_l', razorpayStatus: 'active' }, { status: 'active' });
        const out = await renewal.runLapseCheck();
        expect(out.lapsed).toContain(String(lapsed.restaurant._id));
        expect(out.lapsed).not.toContain(String(grace.restaurant._id));
        expect(out.lapsed).not.toContain(String(auto.restaurant._id));
        const r = await Restaurant.findById(lapsed.restaurant._id).lean();
        expect(r.status).toBe('past_due');
        expect(r.subscription.status).toBe('past_due');
    });

    test('paying a renewal lifts the lapse (past_due -> active)', async () => {
        const t = await seedTenant({ label: 'lap4' });
        await putOnPlan(t, silver, { billingCycle: 'annual', currentPeriodEnd: new Date(Date.now() - 4 * DAY), status: 'past_due' }, { status: 'past_due' });
        stubOrders('order_lap4');
        const up = await owner(t).post('/tenant/billing/upgrade').send({ planId: String(silver._id), billingCycle: 'annual' });
        expect(up.status).toBe(200);
        const res = await verify(t, { orderId: 'order_lap4', paymentId: 'pay_lap4', amount: 825882, planSlug: 'silver-ab' });
        expect(res.status).toBe(200);
        const r = await Restaurant.findById(t.restaurant._id).lean();
        expect(r.status).toBe('active');
        expect(r.subscription.status).toBe('active');
        expect(new Date(r.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    });

    test('due scheduled downgrades are applied by the job (keyed on effectiveAt)', async () => {
        const t = await seedTenant({ label: 'dd' });
        await putOnPlan(t, gold, {
            billingCycle: 'annual', currentPeriodEnd: new Date(Date.now() - DAY),
            scheduledDowngrade: { plan: silver._id, planName: 'Silver', planSlug: 'silver-ab', price: 699, features: {}, limits: {}, effectiveAt: new Date(Date.now() - DAY) },
        });
        const out = await renewal.runDueDowngrades();
        expect(out.applied).toContain(String(t.restaurant._id));
        expect(await sub(t)).toMatchObject({ planSlug: 'silver-ab', billingCycle: 'monthly' });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('migrations', () => {
    test('applyPlanLineup writes the three prices per plan, is idempotent and honours --dry-run', async () => {
        const log = () => {};
        const dry = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { dryRun: true, log });
        expect(dry.created.length + dry.refreshed.length).toBeGreaterThan(0);
        const before = await SubscriptionPlan.findOne({ slug: 'premium', isPublic: true }).lean();
        expect(before?.prices?.annual ?? null).toBeNull();                        // dry run wrote nothing

        await applyPlanLineup({ SubscriptionPlan, Restaurant }, { log });
        const prices = Object.fromEntries((await SubscriptionPlan.find({ slug: { $in: ['silver', 'gold', 'premium'] } }).lean())
            .map(p => [p.slug, p.prices]));
        expect(prices.silver).toEqual({ monthly: 699, annual: 6999, biennial: 11199 });
        expect(prices.gold).toEqual({ monthly: 1799, annual: 17999, biennial: 28799 });
        expect(prices.premium).toEqual({ monthly: 2999, annual: 29999, biennial: 47999 });

        const again = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { log });
        expect(again.created).toEqual([]);
        expect((await SubscriptionPlan.findOne({ slug: 'gold' }).lean()).prices).toEqual(prices.gold);
        expect(await SubscriptionPlan.countDocuments({ slug: 'gold' })).toBe(1);
    });

    test('backfillBillingCycle: dry-run touches nothing, real run sets monthly once, re-run is a no-op', async () => {
        const t = await seedTenant({ label: 'bf' });
        await Restaurant.collection.updateOne({ _id: t.restaurant._id },
            { $set: { 'subscription.plan': silver._id }, $unset: { 'subscription.billingCycle': '' } });
        const log = () => {};
        const dry = await backfillBillingCycle({ Restaurant }, { dryRun: true, log });
        expect(dry.matched).toBeGreaterThanOrEqual(1);
        expect(dry.updated).toBe(0);
        expect((await Restaurant.collection.findOne({ _id: t.restaurant._id })).subscription.billingCycle).toBeUndefined();

        const real = await backfillBillingCycle({ Restaurant }, { log });
        expect(real.updated).toBe(dry.matched);
        expect((await Restaurant.collection.findOne({ _id: t.restaurant._id })).subscription.billingCycle).toBe('monthly');
        expect((await backfillBillingCycle({ Restaurant }, { log })).matched).toBe(0);
    });
});
