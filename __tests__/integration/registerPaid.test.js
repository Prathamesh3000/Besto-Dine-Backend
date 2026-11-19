/**
 * /register-restaurant plan rules + paid signup (TRIAL_SIGNUP_AND_LEADS_PLAN.md §5):
 *   - POST /public/register-order → Razorpay order for base + GST
 *   - free plan → active tenant, no trial, registrationSource 'self_service'
 *   - trial-enabled plan → trial on that plan, 'self_service_trial'
 *   - paid plan: payment required; signature / order / notes / amount
 *     verified (400 PAYMENT_MISMATCH); success → active tenant with
 *     price, billingCycle, lastChargedAt, currentPeriodEnd + invoice;
 *     reused payment → 409 PAYMENT_ALREADY_USED
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const User = require(path.join(BACKEND, 'models/user'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const { priceWithGst, addCycle } = require(path.join(BACKEND, 'utils/billingCycles'));

const ctx = useIntegrationApp();
const PASSWORD = 'Signup#Pass1234';
const DAY = 24 * 60 * 60 * 1000;

const uniq = () => Math.random().toString(16).slice(2, 8);
let phoneSeq = 0;
const uniquePhone = () => `9${String(800000000 + (++phoneSeq) * 7919 + Math.floor(Math.random() * 1000)).padStart(9, '0')}`.slice(0, 10);
const signupBody = (extra = {}) => ({
    restaurantName: `Paid Hub ${uniq()}`,
    ownerName: 'Priya Owner',
    contactEmail: `owner.${uniq()}@hotels.test`,
    contactPhone: uniquePhone(),
    city: 'Mumbai',
    password: PASSWORD,
    acceptTerms: true,
    ...extra,
});
const signup = (body) => ctx.api.anon().post('/public/register-restaurant').send(body);
const order = (body) => ctx.api.anon().post('/public/register-order').send(body);

const sign = (orderId, paymentId) => crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');

let plans;
const SILVER_MONTHLY = priceWithGst(999);     // 99900 base + 17982 GST = 117882 paise
const SILVER_ANNUAL = priceWithGst(9990);

/** Stub payments.fetch with a payment that (by default) pays for Silver monthly. */
function stubPayment(overrides = {}) {
    const id = overrides.id || `pay_${uniq()}`;
    const payment = {
        id,
        entity: 'payment',
        order_id: overrides.order_id || `order_${uniq()}`,
        amount: SILVER_MONTHLY.totalPaise,
        currency: 'INR',
        status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
        ...overrides,
        notes: {
            type: 'signup_plan_payment', planSlug: 'silver', planName: 'Silver', billingCycle: 'monthly',
            ...(overrides.notes || {}),
        },
    };
    rzp.instance.payments.fetch.mockResolvedValue(payment);
    return payment;
}
const paymentFor = (p) => ({ razorpayOrderId: p.order_id, razorpayPaymentId: p.id, razorpaySignature: sign(p.order_id, p.id) });

beforeAll(async () => {
    plans = {
        free: await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0, tier: 0, sortOrder: 0 }),
        silver: await SubscriptionPlan.create({
            name: 'Silver', slug: 'silver', price: 999, prices: { monthly: 999, annual: 9990 }, tier: 10, sortOrder: 1,
        }),
        // Default trial plan, trial switch ON with its own length.
        gold: await SubscriptionPlan.create({
            name: 'Gold', slug: 'gold', price: 2999, tier: 20, sortOrder: 2, trial: { enabled: true, durationDays: 10 },
        }),
        enterprise: await SubscriptionPlan.create({ name: 'Enterprise', slug: 'enterprise', price: 0, tier: 30, sortOrder: 9 }),
        hidden: await SubscriptionPlan.create({ name: 'Hidden', slug: 'hidden', price: 499, tier: 5, isPublic: false }),
    };
});

describe('POST /public/register-order', () => {
    test('creates a Razorpay order for base + GST with signup notes', async () => {
        rzp.instance.orders.create.mockResolvedValue({ id: 'order_signup_1', amount: SILVER_MONTHLY.totalPaise, currency: 'INR' });
        const res = await order({ planId: String(plans.silver._id), billingCycle: 'monthly' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            orderId: 'order_signup_1',
            amount: 117882,
            currency: 'INR',
            keyId: process.env.RAZORPAY_KEY_ID,
            plan: { _id: String(plans.silver._id), slug: 'silver', name: 'Silver' },
            billingCycle: 'monthly',
            baseAmount: 99900,
            gstAmount: 17982,
            gstRate: 18,
        });
        expect(res.headers['cache-control']).toBe('no-store');
        const sent = rzp.instance.orders.create.mock.calls[0][0];
        expect(sent).toMatchObject({
            amount: 117882,
            currency: 'INR',
            notes: { type: 'signup_plan_payment', planSlug: 'silver', billingCycle: 'monthly', basePaise: '99900', gstRate: '18' },
        });
        expect(sent.receipt.length).toBeLessThanOrEqual(40);
    });

    test('annual cycle prices the annual list price; missing cycle defaults to monthly', async () => {
        rzp.instance.orders.create.mockResolvedValue({ id: 'order_signup_2' });
        const annual = await order({ planId: String(plans.silver._id), billingCycle: 'annual' });
        expect(annual.status).toBe(200);
        expect(annual.body.data).toMatchObject({ amount: SILVER_ANNUAL.totalPaise, baseAmount: 999000, billingCycle: 'annual' });
        const monthly = await order({ planId: String(plans.silver._id) });
        expect(monthly.body.data.billingCycle).toBe('monthly');
    });

    test('free / trial / contact-sales / hidden plans and unsold cycles are refused', async () => {
        const cases = [
            [{ planId: String(plans.free._id) }, 'PLAN_NOT_PAYABLE'],
            [{ planId: String(plans.gold._id) }, 'PLAN_NOT_PAYABLE'],
            [{ planId: String(plans.enterprise._id) }, 'PLAN_NOT_SELF_SERVE'],
            [{ planId: String(plans.hidden._id) }, 'INVALID_PLAN'],
            [{ planId: 'nope' }, 'INVALID_PLAN'],
            [{ planId: String(plans.silver._id), billingCycle: 'biennial' }, 'INVALID_CYCLE'],
            [{ planId: String(plans.silver._id), billingCycle: 'weekly' }, 'INVALID_CYCLE'],
        ];
        for (const [body, code] of cases) {
            const res = await order(body);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe(code);
        }
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('503 BILLING_NOT_CONFIGURED without Razorpay keys', async () => {
        const saved = process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_ID;
        try {
            const res = await order({ planId: String(plans.silver._id), billingCycle: 'monthly' });
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('BILLING_NOT_CONFIGURED');
        } finally {
            process.env.RAZORPAY_KEY_ID = saved;
        }
    });

    test('502 BILLING_SETUP_FAILED when Razorpay rejects the order', async () => {
        rzp.instance.orders.create.mockRejectedValue({ statusCode: 400, error: { description: 'nope' } });
        const res = await order({ planId: String(plans.silver._id), billingCycle: 'monthly' });
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('BILLING_SETUP_FAILED');
    });
});

describe('POST /public/register-restaurant — plan rules', () => {
    test('free plan → active tenant, no trial, registrationSource self_service', async () => {
        const body = signupBody({ planId: String(plans.free._id) });
        const res = await signup(body);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            signupStatus: 'approved',
            registrationSource: 'self_service',
            subscriptionStatus: 'active',
            trialStarted: false,
            trialDays: 0,
            trialEndDate: null,
            planName: 'Free',
            planSlug: 'free',
            autoLogin: true,
            requestedPlan: { name: 'Free' },
        });
        expect(res.body.token).toBeTruthy();
        expect(res.body.tenant).toMatchObject({ status: 'active', trialExpired: false, planSlug: 'free' });

        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({
            status: 'active', signupStatus: 'approved', signupSource: 'self', registrationSource: 'self_service',
            contactPhone: body.contactPhone, city: 'Mumbai',
        });
        expect(r.subscription).toMatchObject({ status: 'active', planSlug: 'free', price: 0 });
        expect(r.subscription.trialEndDate).toBeFalsy();
        expect(r.subscription.trialStartDate).toBeFalsy();
        expect(r.signupMeta.ownerName).toBe('Priya Owner');
        const owner = await User.findById(r.owner).lean();
        expect(owner).toMatchObject({ name: 'Priya Owner', mobile: body.contactPhone, isTenantOwner: true });
        expect(res.body.data.message).toMatch(/Free plan is active/);
    });

    test('trial-enabled plan → trial on that plan with its own length, self_service_trial', async () => {
        const res = await signup(signupBody({ planId: String(plans.gold._id) }));
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            registrationSource: 'self_service_trial', trialStarted: true, trialDays: 10, planSlug: 'gold',
        });
        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({ status: 'trial', registrationSource: 'self_service_trial' });
        expect(r.subscription.status).toBe('trial');
        expect(Math.abs(new Date(r.subscription.trialEndDate) - (Date.now() + 10 * DAY))).toBeLessThan(60 * 1000);
    });

    test('no plan ("decide later") → trial on the default trial plan, self_service_trial', async () => {
        const res = await signup(signupBody());
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ trialStarted: true, planSlug: 'gold', trialDays: 10, requestedPlan: null });
        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r.registrationSource).toBe('self_service_trial');
    });

    test('contact-sales plan → 400 PLAN_NOT_SELF_SERVE', async () => {
        const res = await signup(signupBody({ planId: String(plans.enterprise._id) }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ field: 'planId', code: 'PLAN_NOT_SELF_SERVE' });
    });
});

describe('POST /public/register-restaurant — paid plan', () => {
    const silver = (extra = {}) => signupBody({ planId: String(plans.silver._id), billingCycle: 'monthly', ...extra });

    test('paid plan without payment → 400 PAYMENT_REQUIRED, nothing created', async () => {
        const body = silver();
        const res = await signup(body);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ field: 'payment', code: 'PAYMENT_REQUIRED' });
        expect(await Restaurant.exists({ contactEmail: body.contactEmail })).toBeNull();
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('unsold cycle → 400 INVALID_CYCLE', async () => {
        const res = await signup(silver({ billingCycle: 'biennial', payment: { razorpayOrderId: 'o', razorpayPaymentId: 'p', razorpaySignature: 's' } }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_CYCLE');
    });

    test('bad signature → 400 PAYMENT_MISMATCH before Razorpay is asked', async () => {
        const p = stubPayment();
        const body = silver({ payment: { ...paymentFor(p), razorpaySignature: 'deadbeef' } });
        const res = await signup(body);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ field: 'payment', code: 'PAYMENT_MISMATCH' });
        expect(res.body.message).toMatch(/review/i);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect(await Restaurant.exists({ contactEmail: body.contactEmail })).toBeNull();
    });

    test('underpaid / wrong plan / wrong cycle / wrong order / foreign currency / failed → 400 PAYMENT_MISMATCH', async () => {
        const variants = [
            { amount: SILVER_MONTHLY.totalPaise - 101 },                 // below tolerance
            { notes: { planSlug: 'gold' } },                              // another plan's order
            { notes: { billingCycle: 'annual' } },                        // cycle differs from the request
            { notes: { type: 'plan_payment' } },                          // a tenant upgrade order
            { order_id: 'order_other', mismatchOrder: true },
            { currency: 'USD' },
            { status: 'failed' },
        ];
        for (const v of variants) {
            rzp.reset();
            const { mismatchOrder, ...over } = v;
            const p = stubPayment(over);
            const pay = paymentFor(p);
            if (mismatchOrder) {
                pay.razorpayOrderId = 'order_sent';
                pay.razorpaySignature = sign('order_sent', p.id);
            }
            const body = silver({ payment: pay });
            const res = await signup(body);
            expect([res.status, res.body.code]).toEqual([400, 'PAYMENT_MISMATCH']);
            expect(await Restaurant.exists({ contactEmail: body.contactEmail })).toBeNull();
        }
        expect(await SubscriptionInvoice.countDocuments({})).toBe(0);
    });

    test('an amount within 100 paise of the price is accepted', async () => {
        const p = stubPayment({ amount: SILVER_MONTHLY.totalPaise - 50 });
        const res = await signup(silver({ payment: paymentFor(p) }));
        expect(res.status).toBe(201);
    });

    test('correct payment → active tenant with price / cycle / period / invoice, self_service', async () => {
        const p = stubPayment({ id: 'pay_good_1', order_id: 'order_good_1' });
        const body = silver({ payment: paymentFor(p) });
        const res = await signup(body);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            registrationSource: 'self_service',
            subscriptionStatus: 'active',
            trialStarted: false,
            trialDays: 0,
            planSlug: 'silver',
            billingCycle: 'monthly',
            autoLogin: true,
        });
        expect(res.body.data.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);
        expect(res.body.data.currentPeriodEnd).toBeTruthy();
        expect(res.body.token).toBeTruthy();
        expect(res.body.tenant).toMatchObject({ status: 'active', planSlug: 'silver' });

        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r).toMatchObject({ status: 'active', signupStatus: 'approved', registrationSource: 'self_service' });
        expect(r.subscription).toMatchObject({
            status: 'active', planSlug: 'silver', price: 999, billingCycle: 'monthly', razorpayStatus: 'active',
        });
        expect(r.subscription.trialEndDate).toBeFalsy();
        expect(Math.abs(new Date(r.subscription.lastChargedAt) - Date.now())).toBeLessThan(60 * 1000);
        const expectedEnd = addCycle(new Date(r.subscription.startDate), 'monthly');
        expect(Math.abs(new Date(r.subscription.currentPeriodEnd) - expectedEnd)).toBeLessThan(1000);

        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: 'pay_good_1' }).lean();
        expect(inv).toMatchObject({
            restaurant: r._id,
            invoiceNumber: res.body.data.invoiceNumber,
            planSlug: 'silver',
            billingCycle: 'monthly',
            amount: 117882,
            baseAmount: 99900,
            gstAmount: 17982,
            gstRate: 18,
            currency: 'INR',
            status: 'paid',
        });
        expect(new Date(inv.periodEnd).getTime()).toBe(new Date(r.subscription.currentPeriodEnd).getTime());

        const audit = await AuditLog.findOne({ targetId: r._id, action: 'restaurant.self_signup' }).lean();
        expect(audit.details).toMatchObject({
            mode: 'paid', registrationSource: 'self_service', razorpayPaymentId: 'pay_good_1', billingCycle: 'monthly',
        });

        // The paid tenant is a normal, unlocked tenant.
        const me = await ctx.api.as(res.body.token).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.tenant).toMatchObject({ subscriptionStatus: 'active', trialExpired: false });
    });

    test('the same payment cannot register a second tenant → 409 PAYMENT_ALREADY_USED', async () => {
        const p = stubPayment({ id: 'pay_good_1', order_id: 'order_good_1' });
        const body = silver({ payment: paymentFor(p) });
        const res = await signup(body);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ field: 'payment', code: 'PAYMENT_ALREADY_USED' });
        expect(await Restaurant.exists({ contactEmail: body.contactEmail })).toBeNull();
        expect(await SubscriptionInvoice.countDocuments({ razorpayPaymentId: 'pay_good_1' })).toBe(1);
    });

    test('annual payment → 12-month term', async () => {
        const p = stubPayment({ amount: SILVER_ANNUAL.totalPaise, notes: { billingCycle: 'annual' } });
        const res = await signup(silver({ billingCycle: 'annual', payment: paymentFor(p) }));
        expect(res.status).toBe(201);
        expect(res.body.data.billingCycle).toBe('annual');
        const r = await Restaurant.findOne({ slug: res.body.data.restaurant.slug }).lean();
        expect(r.subscription).toMatchObject({ price: 9990, billingCycle: 'annual' });
        const expectedEnd = addCycle(new Date(r.subscription.startDate), 'annual');
        expect(Math.abs(new Date(r.subscription.currentPeriodEnd) - expectedEnd)).toBeLessThan(1000);
        const inv = await SubscriptionInvoice.findOne({ razorpayPaymentId: p.id }).lean();
        expect(inv).toMatchObject({ billingCycle: 'annual', amount: SILVER_ANNUAL.totalPaise, baseAmount: 999000 });
    });

    test('duplicate email is refused before the payment is consumed', async () => {
        const existing = await Restaurant.findOne({ registrationSource: 'self_service', 'subscription.planSlug': 'silver' }).lean();
        const p = stubPayment();
        const res = await signup(silver({ contactEmail: existing.contactEmail, payment: paymentFor(p) }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EMAIL_IN_USE');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('Razorpay fetch failure → 502 RAZORPAY_FETCH_FAILED, nothing created', async () => {
        const orderId = `order_${uniq()}`;
        const paymentId = `pay_${uniq()}`;
        const body = silver({ payment: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sign(orderId, paymentId) } });
        const res = await signup(body);
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('RAZORPAY_FETCH_FAILED');
        expect(await Restaurant.exists({ contactEmail: body.contactEmail })).toBeNull();
    });
});
