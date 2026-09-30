/**
 * Tests for the ADM-106 fix: frontend-driven verify endpoint that
 * creates the SubscriptionInvoice when the Razorpay webhook can't
 * reach the server.
 *
 * Coverage:
 *   Shared helper (applyPaidPlanUpgrade):
 *     A. Happy path: applies upgrade, creates invoice
 *     B. Idempotency: second call (existing invoice) is a no-op
 *     C. E11000 race: webhook + verify hit at same time, second one
 *        swallows the duplicate-key error gracefully
 *
 *   Controller (verifyUpgradePayment):
 *     1. Rejects missing signature fields → 400
 *     2. Rejects bad signature → 400 SIGNATURE_INVALID
 *     3. Rejects tenant mismatch → 403 TENANT_MISMATCH
 *     4. Rejects non-plan_payment notes → 400 NOT_A_PLAN_PAYMENT
 *     5. Rejects payment not yet captured → 409 PAYMENT_NOT_CAPTURED
 *     6. Happy path → 200 + invoice created
 *     7. Idempotent: second call → 200 + alreadyInvoiced: true
 */

const crypto = require('crypto');

// ── Mocks ──────────────────────────────────────────────────────────────
const mockRestaurant = {
    findById: jest.fn(),
};
const mockSubscriptionInvoice = {
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    create: jest.fn(),
};
const mockSubscriptionPlan = {
    findById: jest.fn(),
};
const mockPaymentsFetch = jest.fn();

jest.mock('../models/restaurant', () => mockRestaurant);
jest.mock('../models/subscriptionInvoice', () => mockSubscriptionInvoice);
jest.mock('../models/subscriptionPlan', () => mockSubscriptionPlan);
jest.mock('../models/user', () => ({ findById: jest.fn() }));
jest.mock('../models/auditLog', () => ({ create: jest.fn() }));
// upgradePlan now consults PlanChangeRequest for the
// DOWNGRADE_REQUEST_PENDING collision guard. Default to "no pending
// requests" — individual tests can override per-call as needed.
jest.mock('../models/planChangeRequest', () => ({
    findOne: jest.fn(() => ({ lean: () => Promise.resolve(null) })),
    create: jest.fn(),
}));

// Razorpay SDK — return a constructor that yields { payments: { fetch } }
jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        payments: { fetch: mockPaymentsFetch },
    }));
});

// Silence logger
jest.mock('../utils/logger', () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
}));

// Razorpay billing utilities — only need to no-op them for these tests
jest.mock('../utils/razorpayBilling', () => ({
    isBillingConfigured: () => true,
    ensureRazorpayPlan: jest.fn(),
    ensureRazorpayCustomer: jest.fn(),
    createRazorpaySubscription: jest.fn(),
    cancelRazorpaySubscription: jest.fn(),
}));

jest.mock('../utils/invoicePdf', () => ({
    streamInvoicePdf: jest.fn(),
}));

// ── Env setup BEFORE requiring controller ──────────────────────────────
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret_for_hmac';

const { applyPaidPlanUpgrade } = require('../utils/planPaymentApply');
const { verifyUpgradePayment, upgradePlan } = require('../controllers/tenantBillingController');

// ── Helpers ────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TENANT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function makeRestaurantDoc(overrides = {}) {
    return {
        _id: TENANT_ID,
        name: 'Test Cafe',
        slug: 'test-cafe',
        status: 'trial',
        subscription: {
            planName: 'Free',
            planSlug: 'free',
            status: 'trial',
            pendingUpgrade: {
                plan: 'pid1',
                planName: 'Pro',
                planSlug: 'pro',
                features: { dineIn: true },
                limits:   { maxStaff: 10 },
            },
        },
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makePayment(overrides = {}) {
    return {
        id: 'pay_test_1',
        order_id: 'order_test_1',
        amount: 99900,
        currency: 'INR',
        status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
        notes: {
            type: 'plan_payment',
            restaurantId: TENANT_ID,
            planSlug: 'pro',
            planName: 'Pro',
        },
        ...overrides,
    };
}

function makeReq(overrides = {}) {
    return {
        restaurant: { _id: TENANT_ID, slug: 'test-cafe' },
        user: { _id: 'u1', role: 'admin', email: 'owner@test.com' },
        body: {},
        headers: {},
        ip: '127.0.0.1',
        ...overrides,
    };
}

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data)   { res.body = data;       return res; },
    };
    return res;
}

function signPayment(orderId, paymentId, secret = process.env.RAZORPAY_KEY_SECRET) {
    return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

// Mongoose query-style helper — findOne(...).lean() returns a promise
function leanOf(value) {
    return { lean: () => Promise.resolve(value) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSubscriptionInvoice.findOne.mockReturnValue(leanOf(null));
    mockSubscriptionInvoice.countDocuments.mockResolvedValue(0);
    mockSubscriptionInvoice.create.mockResolvedValue({ _id: 'inv1' });
});

// ── A. Shared helper tests ─────────────────────────────────────────────

describe('applyPaidPlanUpgrade (shared helper)', () => {
    test('A. happy path — applies pending upgrade and creates invoice', async () => {
        const restaurant = makeRestaurantDoc();
        const payment = makePayment();

        const result = await applyPaidPlanUpgrade({
            restaurant, payment, logTag: 'test',
        });

        expect(result.applied).toBe(true);
        expect(result.invoiceCreated).toBe(true);
        expect(result.alreadyInvoiced).toBe(false);
        expect(result.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);

        // Pending upgrade was cleared, live fields populated
        expect(restaurant.subscription.planSlug).toBe('pro');
        expect(restaurant.subscription.planName).toBe('Pro');
        expect(restaurant.subscription.status).toBe('active');
        expect(restaurant.subscription.pendingUpgrade).toBeUndefined();
        expect(restaurant.subscription.razorpayStatus).toBe('active');
        expect(restaurant.subscription.lastChargedAt).toBeInstanceOf(Date);
        expect(restaurant.subscription.currentPeriodEnd).toBeInstanceOf(Date);

        // Trial flipped to active
        expect(restaurant.status).toBe('active');

        // Invoice was persisted with the right shape
        expect(mockSubscriptionInvoice.create).toHaveBeenCalledTimes(1);
        const invArg = mockSubscriptionInvoice.create.mock.calls[0][0];
        expect(invArg).toMatchObject({
            restaurant: TENANT_ID,
            restaurantName: 'Test Cafe',
            planName: 'Pro',
            planSlug: 'pro',
            amount: 99900,
            currency: 'INR',
            razorpayPaymentId: 'pay_test_1',
            status: 'paid',
        });

        expect(restaurant.save).toHaveBeenCalled();
    });

    test('B. idempotency — pre-existing invoice short-circuits', async () => {
        mockSubscriptionInvoice.findOne.mockReturnValue(leanOf({ _id: 'existing-inv' }));

        const restaurant = makeRestaurantDoc();
        const payment = makePayment();

        const result = await applyPaidPlanUpgrade({
            restaurant, payment, logTag: 'test',
        });

        expect(result.alreadyInvoiced).toBe(true);
        expect(result.invoiceCreated).toBe(false);
        expect(result.applied).toBe(false);
        expect(restaurant.save).not.toHaveBeenCalled();
        expect(mockSubscriptionInvoice.create).not.toHaveBeenCalled();
    });

    test('C. E11000 race — duplicate-key on create is treated as deduped', async () => {
        const dupeErr = Object.assign(new Error('E11000'), { code: 11000 });
        mockSubscriptionInvoice.create.mockRejectedValueOnce(dupeErr);

        const restaurant = makeRestaurantDoc();
        const payment = makePayment();

        const result = await applyPaidPlanUpgrade({
            restaurant, payment, logTag: 'test',
        });

        expect(result.alreadyInvoiced).toBe(true);
        expect(result.invoiceCreated).toBe(false);
        // Upgrade was still applied (the save() ran before create() failed)
        expect(restaurant.save).toHaveBeenCalled();
    });
});

// ── Controller integration tests ───────────────────────────────────────

describe('verifyUpgradePayment controller', () => {
    test('1. missing signature fields → 400', async () => {
        const req = makeReq({ body: { razorpay_order_id: 'o1' } });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('2. bad signature → 400 SIGNATURE_INVALID', async () => {
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: 'totally-bogus-sig',
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('SIGNATURE_INVALID');
        expect(mockPaymentsFetch).not.toHaveBeenCalled();
    });

    test('3. tenant mismatch → 403 TENANT_MISMATCH', async () => {
        mockPaymentsFetch.mockResolvedValue(makePayment({
            notes: { type: 'plan_payment', restaurantId: OTHER_TENANT_ID },
        }));

        const sig = signPayment('order_test_1', 'pay_test_1');
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: sig,
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('TENANT_MISMATCH');
        expect(mockRestaurant.findById).not.toHaveBeenCalled();
    });

    test('4. non-plan_payment notes → 400 NOT_A_PLAN_PAYMENT', async () => {
        mockPaymentsFetch.mockResolvedValue(makePayment({
            notes: { type: 'wallet_recharge', restaurantId: TENANT_ID },
        }));

        const sig = signPayment('order_test_1', 'pay_test_1');
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: sig,
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('NOT_A_PLAN_PAYMENT');
    });

    test('5. payment not yet captured → 409 PAYMENT_NOT_CAPTURED', async () => {
        mockPaymentsFetch.mockResolvedValue(makePayment({ status: 'authorized' }));

        const sig = signPayment('order_test_1', 'pay_test_1');
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: sig,
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('PAYMENT_NOT_CAPTURED');
    });

    test('6. happy path → 200 + invoice created', async () => {
        const restaurantDoc = makeRestaurantDoc();
        mockPaymentsFetch.mockResolvedValue(makePayment());
        mockRestaurant.findById.mockResolvedValue(restaurantDoc);

        const sig = signPayment('order_test_1', 'pay_test_1');
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: sig,
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.upgradeApplied).toBe(true);
        expect(res.body.data.alreadyInvoiced).toBe(false);
        expect(res.body.data.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);
        expect(mockSubscriptionInvoice.create).toHaveBeenCalledTimes(1);
    });

    test('7a. payment.order_id mismatch → 400 PAYMENT_MISMATCH', async () => {
        mockPaymentsFetch.mockResolvedValue(makePayment({ order_id: 'order_DIFFERENT' }));
        const sig = signPayment('order_test_1', 'pay_test_1');
        const req = makeReq({
            body: {
                razorpay_order_id: 'order_test_1',
                razorpay_payment_id: 'pay_test_1',
                razorpay_signature: sig,
            },
        });
        const res = makeRes();
        await verifyUpgradePayment(req, res);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('PAYMENT_MISMATCH');
    });

    test('7. idempotency — second call returns alreadyInvoiced', async () => {
        // First call: no existing invoice
        const restaurantDoc = makeRestaurantDoc();
        mockPaymentsFetch.mockResolvedValue(makePayment());
        mockRestaurant.findById.mockResolvedValue(restaurantDoc);

        const sig = signPayment('order_test_1', 'pay_test_1');
        const body = {
            razorpay_order_id: 'order_test_1',
            razorpay_payment_id: 'pay_test_1',
            razorpay_signature: sig,
        };

        // 1st call
        await verifyUpgradePayment(makeReq({ body }), makeRes());

        // Simulate the invoice now existing in DB
        mockSubscriptionInvoice.findOne.mockReturnValue(leanOf({ _id: 'inv1' }));
        mockSubscriptionInvoice.create.mockClear();

        // 2nd call
        const res = makeRes();
        await verifyUpgradePayment(makeReq({ body }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data.alreadyInvoiced).toBe(true);
        expect(res.body.data.upgradeApplied).toBe(false);
        expect(mockSubscriptionInvoice.create).not.toHaveBeenCalled();
    });
});

// ── Downgrade-block tests (paid → cheaper paid) ────────────────────────

describe('upgradePlan downgrade block', () => {
    const CURRENT_PLAN_ID = 'cccccccccccccccccccccccc';
    const NEW_PLAN_ID = 'dddddddddddddddddddddddd';

    function mockPlanLookup({ newPlan, currentPlan }) {
        // 1st call: SubscriptionPlan.findById(planId) — full doc
        mockSubscriptionPlan.findById.mockImplementationOnce(() =>
            Promise.resolve(newPlan)
        );
        // 2nd call: SubscriptionPlan.findById(currentPlanId).select('name price')
        mockSubscriptionPlan.findById.mockImplementationOnce(() => ({
            select: () => Promise.resolve(currentPlan),
        }));
    }

    test('D1. paid → cheaper paid downgrade → 400 DOWNGRADE_NOT_SUPPORTED', async () => {
        const enterpriseDoc = { _id: TENANT_ID, slug: 'test-cafe', subscription: { plan: CURRENT_PLAN_ID, planSlug: 'enterprise' } };
        mockRestaurant.findById.mockResolvedValue(enterpriseDoc);
        mockPlanLookup({
            newPlan: { _id: NEW_PLAN_ID, slug: 'premium', name: 'Premium', price: 3000, isActive: true },
            currentPlan: { _id: CURRENT_PLAN_ID, name: 'Enterprise', price: 10000 },
        });

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('DOWNGRADE_NOT_SUPPORTED');
        expect(res.body.message).toMatch(/Enterprise/);
        expect(res.body.message).toMatch(/Premium/);
    });

    test('D2. paid → equal-priced different plan → not blocked by downgrade rule', async () => {
        // Same price, different slug — not a downgrade. Should proceed
        // past the downgrade check (will fail later in the Razorpay flow
        // since we don't mock that fully — but the downgrade rule alone
        // shouldn't reject).
        const enterpriseDoc = { _id: TENANT_ID, slug: 'test-cafe', subscription: { plan: CURRENT_PLAN_ID, planSlug: 'enterprise' } };
        mockRestaurant.findById.mockResolvedValue(enterpriseDoc);
        mockPlanLookup({
            newPlan: { _id: NEW_PLAN_ID, slug: 'enterprise-alt', name: 'Enterprise Alt', price: 10000, isActive: true },
            currentPlan: { _id: CURRENT_PLAN_ID, name: 'Enterprise', price: 10000 },
        });

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        // Whatever happens next, it's NOT a DOWNGRADE_NOT_SUPPORTED.
        expect(res.body.code).not.toBe('DOWNGRADE_NOT_SUPPORTED');
    });

    test('D3. paid → more expensive paid (real upgrade) → not blocked', async () => {
        const basicDoc = { _id: TENANT_ID, slug: 'test-cafe', subscription: { plan: CURRENT_PLAN_ID, planSlug: 'basic' } };
        mockRestaurant.findById.mockResolvedValue(basicDoc);
        mockPlanLookup({
            newPlan: { _id: NEW_PLAN_ID, slug: 'premium', name: 'Premium', price: 5000, isActive: true },
            currentPlan: { _id: CURRENT_PLAN_ID, name: 'Basic', price: 1000 },
        });

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.body.code).not.toBe('DOWNGRADE_NOT_SUPPORTED');
    });

    test('D4. trial (no current plan) → first paid upgrade not blocked', async () => {
        // Brand-new tenant with no current plan stamped → currentPlanId
        // is falsy, so the downgrade check is skipped entirely.
        const trialDoc = { _id: TENANT_ID, slug: 'test-cafe', subscription: {} };
        mockRestaurant.findById.mockResolvedValue(trialDoc);
        // Only the 1st findById call matters here — the 2nd (currentPlan
        // lookup) is gated behind `if (currentPlanId)`.
        mockSubscriptionPlan.findById.mockImplementationOnce(() =>
            Promise.resolve({ _id: NEW_PLAN_ID, slug: 'basic', name: 'Basic', price: 1000, isActive: true })
        );

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.body.code).not.toBe('DOWNGRADE_NOT_SUPPORTED');
    });
});

// ── State-collision guards (audit fix) ────────────────────────────────
// upgradePlan must reject when conflicting state is in flight so the
// tenant can't race themselves into two Razorpay subscriptions or two
// pending plan-change records.

describe('upgradePlan state-collision guards', () => {
    const CURRENT_PLAN_ID = 'cccccccccccccccccccccccc';
    const NEW_PLAN_ID     = 'dddddddddddddddddddddddd';

    function freshRestaurantDoc(extra = {}) {
        return {
            _id: TENANT_ID, slug: 'test-cafe',
            subscription: { plan: CURRENT_PLAN_ID, planSlug: 'standard', ...extra },
        };
    }

    const PlanChangeRequest = require('../models/planChangeRequest');

    test('G1. pending upgrade in flight → 409 UPGRADE_ALREADY_PENDING', async () => {
        mockRestaurant.findById.mockResolvedValue(freshRestaurantDoc({
            pendingUpgrade: { planSlug: 'enterprise', planName: 'Enterprise', shortUrl: 'https://rzp.io/x' },
        }));
        mockSubscriptionPlan.findById.mockImplementationOnce(() =>
            Promise.resolve({ _id: NEW_PLAN_ID, slug: 'premium', name: 'Premium', price: 5000, isActive: true })
        );
        // currentPlan lookup
        mockSubscriptionPlan.findById.mockImplementationOnce(() => ({
            select: () => Promise.resolve({ _id: CURRENT_PLAN_ID, name: 'Standard', price: 2999 }),
        }));

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('UPGRADE_ALREADY_PENDING');
        expect(res.body.data.pendingUpgrade.planName).toBe('Enterprise');
    });

    test('G2. scheduled downgrade in flight → 409 DOWNGRADE_SCHEDULED', async () => {
        mockRestaurant.findById.mockResolvedValue(freshRestaurantDoc({
            scheduledDowngrade: { planSlug: 'basic', planName: 'Basic', effectiveAt: new Date('2026-06-30') },
        }));
        mockSubscriptionPlan.findById.mockImplementationOnce(() =>
            Promise.resolve({ _id: NEW_PLAN_ID, slug: 'premium', name: 'Premium', price: 5000, isActive: true })
        );
        mockSubscriptionPlan.findById.mockImplementationOnce(() => ({
            select: () => Promise.resolve({ _id: CURRENT_PLAN_ID, name: 'Standard', price: 2999 }),
        }));

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('DOWNGRADE_SCHEDULED');
    });

    test('G3. pending downgrade request awaiting super admin → 409 DOWNGRADE_REQUEST_PENDING', async () => {
        mockRestaurant.findById.mockResolvedValue(freshRestaurantDoc());
        mockSubscriptionPlan.findById.mockImplementationOnce(() =>
            Promise.resolve({ _id: NEW_PLAN_ID, slug: 'premium', name: 'Premium', price: 5000, isActive: true })
        );
        mockSubscriptionPlan.findById.mockImplementationOnce(() => ({
            select: () => Promise.resolve({ _id: CURRENT_PLAN_ID, name: 'Standard', price: 2999 }),
        }));
        // Override the default PlanChangeRequest.findOne to return a pending request
        PlanChangeRequest.findOne.mockReturnValueOnce({
            lean: () => Promise.resolve({ requestedPlanName: 'Basic', status: 'pending' }),
        });

        const req = makeReq({ body: { planId: NEW_PLAN_ID } });
        const res = makeRes();
        await upgradePlan(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('DOWNGRADE_REQUEST_PENDING');
    });
});
