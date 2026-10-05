/**
 * Unit tests — plan gating + billing helpers (QA checklist section 6).
 *
 * Modules under test:
 *   - middlewares/featureGate.js   featureGate / featureGateAny
 *   - utils/publicFeatureFlags.js  publicFeaturesOf (must mirror featureGate)
 *   - utils/publicPlans.js         public plan shape / query / cache
 *   - utils/razorpayBilling.js     plan / customer / subscription helpers
 *   - utils/planPaymentApply.js    applyPendingUpgrade / applyScheduledDowngrade /
 *                                  applyPaidPlanUpgrade (invoice numbering, money)
 *
 * tenantBillingVerify.test.js already covers the verify-endpoint guards
 * (signature / tenant / replay / downgrade) — not repeated here.
 *
 * Money: Razorpay amounts + SubscriptionInvoice.amount are PAISE; plan
 * prices (SubscriptionPlan.price, subscription.price) are RUPEES.
 *
 * Tests named "BUG: ..." fail on purpose against the current source and
 * document a real defect (root cause file:line in the comment above each).
 */

// The invoice-number tests depend on the server's local timezone. Pin it
// to IST (the production locale of every tenant) so the result is the
// same on every machine. Must be set before any Date is created.
process.env.TZ = 'Asia/Kolkata';

// ── Mocks ──────────────────────────────────────────────────────────────
const mockRzp = {
    plans: { create: jest.fn() },
    customers: { create: jest.fn(), all: jest.fn() },
    subscriptions: { create: jest.fn(), cancel: jest.fn(), fetch: jest.fn() },
    orders: { create: jest.fn() },
    payments: { fetch: jest.fn() },
    invoices: { all: jest.fn() },
};
const mockRazorpayCtor = jest.fn().mockImplementation(() => mockRzp);
jest.mock('razorpay', () => mockRazorpayCtor);

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../utils/logger', () => mockLogger);

const mockInvoice = { findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() };
jest.mock('../models/subscriptionInvoice', () => mockInvoice);
jest.mock('../models/restaurant', () => ({ findById: jest.fn() }));

const mockPlanFind = jest.fn();
jest.mock('../models/subscriptionPlan', () => ({ find: (...a) => mockPlanFind(...a) }));

jest.mock('../utils/cacheBus', () => ({ publish: jest.fn(), subscribe: jest.fn() }));

process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
process.env.RAZORPAY_KEY_SECRET = 'unit_secret';

const { featureGate, featureGateAny, FEATURE_LABELS } = require('../middlewares/featureGate');
const { publicFeaturesOf, CUSTOMER_FACING_FEATURE_KEYS } = require('../utils/publicFeatureFlags');
const publicPlans = require('../utils/publicPlans');
const billing = require('../utils/razorpayBilling');
const {
    applyPendingUpgrade,
    applyScheduledDowngrade,
    applyPaidPlanUpgrade,
} = require('../utils/planPaymentApply');

// ── Helpers ────────────────────────────────────────────────────────────
const ALL_KEYS = Object.keys(FEATURE_LABELS);

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(c) { res.statusCode = c; return res; },
        json(b) { res.body = b; return res; },
    };
    return res;
}

/** Run a middleware; resolve to { nextCalled, res }. */
function run(mw, req) {
    const res = makeRes();
    const next = jest.fn();
    mw(req, res, next);
    return { nextCalled: next.mock.calls.length === 1, res };
}

function tenant({ features, overrides, planName = 'Basic', status = 'active', subStatus = 'active', noSub = false } = {}) {
    return {
        _id: 'r1',
        status,
        featureOverrides: overrides,
        subscription: noSub ? undefined : { planName, status: subStatus, features: features || {} },
    };
}

const staffUser = { _id: 'u1', role: 'admin' };
const customerUser = { _id: 'c1', role: 'customer' };

const leanOf = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => {
    jest.clearAllMocks();
    mockInvoice.findOne.mockReturnValue(leanOf(null));
    mockInvoice.countDocuments.mockResolvedValue(0);
    mockInvoice.create.mockImplementation(async (doc) => ({ _id: 'inv', ...doc }));
});

afterEach(() => {
    jest.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════
// 6.1 featureGate
// ═══════════════════════════════════════════════════════════════════════
describe('featureGate — every feature key', () => {
    test.each(ALL_KEYS)('%s: plan WITHOUT the feature → 403 FEATURE_LOCKED with upgrade copy', (key) => {
        const { nextCalled, res } = run(featureGate(key), {
            restaurant: tenant({ features: {} , planName: 'Starter' }),
            user: staffUser,
        });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({
            success: false,
            code: 'FEATURE_LOCKED',
            feature: key,
            currentPlan: 'Starter',
        });
        expect(res.body.message).toMatch(/Upgrade/);
    });

    test.each(ALL_KEYS)('%s: plan WITH the feature (true) → next()', (key) => {
        const { nextCalled, res } = run(featureGate(key), {
            restaurant: tenant({ features: { [key]: true } }),
            user: staffUser,
        });
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBeNull();
    });

    test.each(ALL_KEYS)('%s: explicitly false in the plan → blocked', (key) => {
        const { nextCalled, res } = run(featureGate(key), {
            restaurant: tenant({ features: { [key]: false } }),
            user: staffUser,
        });
        expect(nextCalled).toBe(false);
        expect(res.body.code).toBe('FEATURE_LOCKED');
    });
});

describe('featureGate — value semantics', () => {
    test.each([
        ['basic', true],
        ['standard', true],
        ['advanced', true],
        ['none', false],
        ['', false],
        [1, false],          // truthy but not a recognised value
        ['true', false],     // string "true" is NOT boolean true
        [null, false],
        [undefined, false],
    ])('revenueAnalytics = %p → allowed %p', (value, allowed) => {
        const { nextCalled, res } = run(featureGate('revenueAnalytics'), {
            restaurant: tenant({ features: { revenueAnalytics: value } }),
            user: staffUser,
        });
        expect(nextCalled).toBe(allowed);
        if (!allowed) expect(res.statusCode).toBe(403);
    });

    test('override false beats a plan that includes the feature → 403 FEATURE_REVOKED', () => {
        const { nextCalled, res } = run(featureGate('inventory'), {
            restaurant: tenant({ features: { inventory: true }, overrides: { inventory: false } }),
            user: staffUser,
        });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('FEATURE_REVOKED');
        expect(res.body.message).toMatch(/disabled for your restaurant/);
    });

    test('override true grants a feature the plan lacks', () => {
        const { nextCalled } = run(featureGate('crm'), {
            restaurant: tenant({ features: {}, overrides: { crm: true } }),
            user: staffUser,
        });
        expect(nextCalled).toBe(true);
    });

    test('override value other than true/false (e.g. null) falls through to the plan', () => {
        const blocked = run(featureGate('crm'), {
            restaurant: tenant({ features: {}, overrides: { crm: null } }), user: staffUser,
        });
        expect(blocked.nextCalled).toBe(false);
        const allowed = run(featureGate('crm'), {
            restaurant: tenant({ features: { crm: true }, overrides: { crm: null } }), user: staffUser,
        });
        expect(allowed.nextCalled).toBe(true);
    });

    test('missing subscription → blocked, currentPlan "Unknown"', () => {
        const { nextCalled, res } = run(featureGate('dineIn'), {
            restaurant: tenant({ noSub: true }), user: staffUser,
        });
        expect(nextCalled).toBe(false);
        expect(res.body.code).toBe('FEATURE_LOCKED');
        expect(res.body.currentPlan).toBe('Unknown');
    });

    test('subscription without a features object → blocked (no crash)', () => {
        const r = tenant();
        delete r.subscription.features;
        const { nextCalled, res } = run(featureGate('takeaway'), { restaurant: r, user: staffUser });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(403);
    });

    test('no tenant (legacy / single-tenant) → allowed', () => {
        const { nextCalled } = run(featureGate('inventory'), { restaurant: null, user: staffUser });
        expect(nextCalled).toBe(true);
    });

    test('factory rejects a missing / non-string key at mount time', () => {
        expect(() => featureGate()).toThrow(/feature key/);
        expect(() => featureGate(42)).toThrow(/feature key/);
    });
});

describe('featureGate — role-aware copy', () => {
    test.each([
        ['guest (no user)', undefined],
        ['customer', customerUser],
    ])('%s gets the restaurant-side message, never "upgrade"', (_label, user) => {
        const { res } = run(featureGate('advanceBookingTable'), {
            restaurant: tenant({ features: {} }), user,
        });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe("This restaurant doesn't offer advance table bookings.");
        expect(res.body.message).not.toMatch(/upgrade/i);
    });

    test('customer sees the revoked copy for an override=false', () => {
        const { res } = run(featureGate('walletLoyalty'), {
            restaurant: tenant({ features: { walletLoyalty: true }, overrides: { walletLoyalty: false } }),
            user: customerUser,
        });
        expect(res.body.code).toBe('FEATURE_REVOKED');
        expect(res.body.message).toBe("This restaurant doesn't currently offer wallet and loyalty points.");
    });

    test('unknown key falls back to the raw key in the label', () => {
        const { res } = run(featureGate('someNewThing'), { restaurant: tenant(), user: customerUser });
        expect(res.body.message).toBe("This restaurant doesn't offer someNewThing.");
    });

    test('superadmin has NO bypass: treated as staff and blocked like any other staff user', () => {
        // Documented behaviour: superadmin routes never pass through
        // featureGate, so there is no bypass. If one ever does, the
        // superadmin sees the staff ("upgrade") copy.
        const { nextCalled, res } = run(featureGate('inventory'), {
            restaurant: tenant({ features: {} }),
            user: { _id: 's1', role: 'superadmin', superadminLevel: 'full' },
        });
        expect(nextCalled).toBe(false);
        expect(res.body.message).toMatch(/Upgrade/);
    });
});

describe('featureGate — subscription status is NOT consulted (tenant status gating lives in tenantContext)', () => {
    // Documents current behaviour: trial / past_due / cancelled subscriptions
    // keep their feature set at the gate. Suspended / cancelled TENANTS are
    // hard-blocked earlier by tenantContext.ensureNotLocked; a past_due
    // subscription is not. Listed under risks in the QA report.
    test.each(['trial', 'active', 'past_due', 'cancelled', 'expired'])(
        'subscription.status=%s with feature → allowed',
        (subStatus) => {
            const { nextCalled } = run(featureGate('inventory'), {
                restaurant: tenant({ features: { inventory: true }, subStatus }),
                user: staffUser,
            });
            expect(nextCalled).toBe(true);
        },
    );
});

describe('featureGateAny', () => {
    const gate = featureGateAny('advanceBookingTable', 'advanceBookingHall');

    test.each([
        [{ advanceBookingTable: true }, {}, true],
        [{ advanceBookingHall: true }, {}, true],
        [{}, {}, false],
        [{ advanceBookingTable: true }, { advanceBookingTable: false }, false],
        [{ advanceBookingTable: true, advanceBookingHall: true }, { advanceBookingTable: false }, true],
        [{}, { advanceBookingHall: true }, true],
    ])('features=%j overrides=%j → allowed %p', (features, overrides, allowed) => {
        const { nextCalled, res } = run(gate, { restaurant: tenant({ features, overrides }), user: staffUser });
        expect(nextCalled).toBe(allowed);
        if (!allowed) {
            expect(res.statusCode).toBe(403);
            expect(res.body.code).toBe('FEATURE_LOCKED');
            expect(res.body.feature).toBe('advanceBookingTable');
            expect(res.body.message).toMatch(/advanceBookingTable, advanceBookingHall/);
        }
    });

    test('customer copy joins labels with "or"', () => {
        const { res } = run(gate, { restaurant: tenant(), user: customerUser });
        expect(res.body.message).toBe("This restaurant doesn't offer advance table bookings or hall / event bookings.");
    });

    test('no tenant → allowed', () => {
        expect(run(gate, { restaurant: null }).nextCalled).toBe(true);
    });

    test('factory validation', () => {
        expect(() => featureGateAny()).toThrow();
        expect(() => featureGateAny('a', 3)).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6.5 publicFeaturesOf
// ═══════════════════════════════════════════════════════════════════════
describe('publicFeaturesOf', () => {
    test('returns ONLY customer-facing keys (admin-only modules never leak)', () => {
        const out = publicFeaturesOf(tenant({ features: Object.fromEntries(ALL_KEYS.map(k => [k, true])) }));
        expect(Object.keys(out).sort()).toEqual([...CUSTOMER_FACING_FEATURE_KEYS].sort());
        for (const adminOnly of ['inventory', 'crm', 'multiBranch', 'staffPerformance', 'dataExport', 'webhooks']) {
            expect(out).not.toHaveProperty(adminOnly);
        }
    });

    test('null / empty restaurant → every key false', () => {
        for (const r of [null, undefined, {}]) {
            const out = publicFeaturesOf(r);
            expect(Object.values(out).every(v => v === false)).toBe(true);
        }
    });

    // Parity: the UI flag must agree with the server gate for every
    // combination, otherwise a button is shown that 403s (or vice versa).
    const VALUES = [true, false, undefined, 'basic', 'none', 1];
    const OVERRIDES = [undefined, true, false];
    const cases = [];
    for (const key of CUSTOMER_FACING_FEATURE_KEYS) {
        for (const v of VALUES) for (const o of OVERRIDES) cases.push([key, v, o]);
    }
    test.each(cases)('parity with featureGate: %s value=%p override=%p', (key, v, o) => {
        const r = tenant({ features: { [key]: v }, overrides: o === undefined ? {} : { [key]: o } });
        const flag = publicFeaturesOf(r)[key];
        const { nextCalled } = run(featureGate(key), { restaurant: r, user: customerUser });
        expect(flag).toBe(nextCalled);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6.5 publicPlans
// ═══════════════════════════════════════════════════════════════════════
describe('publicPlans', () => {
    const fullPlan = () => ({
        _id: 'p1',
        name: 'Pro',
        slug: 'pro',
        description: 'For busy cafes',
        price: 1999,
        currency: 'INR',
        billingCycle: 'monthly',
        trialDays: 14,
        isActive: true,
        isPublic: true,
        highlight: true,
        sortOrder: 2,
        razorpayPlanId: 'plan_SECRET',
        createdAt: new Date(),
        features: { _id: 'fid', dineIn: true, crm: true, revenueAnalytics: 'advanced' },
        limits: { maxBranches: 3, maxTables: 50, maxStaff: 20, maxMenuItems: 400, apiRateLimit: 999, auditRetentionDays: 30 },
    });

    test('shape keeps public fields and hides internal ones', () => {
        const out = publicPlans.publicPlanShape(fullPlan());
        expect(out).toEqual({
            _id: 'p1',
            name: 'Pro',
            slug: 'pro',
            description: 'For busy cafes',
            price: 1999,
            currency: 'INR',
            billingCycle: 'monthly',
            trialDays: 14,
            features: { dineIn: true, crm: true, revenueAnalytics: 'advanced' },
            limits: { branches: 3, tables: 50, staff: 20, menuItems: 400 },
            highlight: true,
        });
        const json = JSON.stringify(out);
        for (const hidden of ['razorpayPlanId', 'plan_SECRET', 'apiRateLimit', 'auditRetentionDays', 'isActive', 'isPublic', 'sortOrder', 'fid']) {
            expect(json).not.toContain(hidden);
        }
    });

    test('defaults: description "", currency INR, trialDays 0, highlight only when === true, missing limits → null', () => {
        const out = publicPlans.publicPlanShape({
            _id: 'p2', name: 'Lite', slug: 'lite', price: 0, billingCycle: 'monthly', highlight: 'yes',
        });
        expect(out.description).toBe('');
        expect(out.currency).toBe('INR');
        expect(out.trialDays).toBe(0);
        expect(out.highlight).toBe(false);
        expect(out.features).toEqual({});
        expect(out.limits).toEqual({ branches: null, tables: null, staff: null, menuItems: null });
    });

    test('limit of 0 is preserved (not turned into null)', () => {
        const out = publicPlans.publicPlanShape({ ...fullPlan(), limits: { maxBranches: 0, maxTables: 0, maxStaff: 0, maxMenuItems: 0 } });
        expect(out.limits).toEqual({ branches: 0, tables: 0, staff: 0, menuItems: 0 });
    });

    test('Mongoose subdocs are converted via toObject and not mutated', () => {
        const features = { dineIn: true, _id: 'x' };
        const sub = { toObject: () => ({ ...features }) };
        const out = publicPlans.publicPlanShape({ ...fullPlan(), features: sub });
        expect(out.features).toEqual({ dineIn: true });
        expect(features._id).toBe('x');
    });

    test('loadPublicPlans queries only public+active and sorts sortOrder, price, name', async () => {
        const sort = jest.fn().mockReturnValue({ lean: () => Promise.resolve([fullPlan()]) });
        mockPlanFind.mockReturnValue({ sort });
        const out = await publicPlans.loadPublicPlans();
        expect(mockPlanFind).toHaveBeenCalledWith({ isPublic: true, isActive: true });
        expect(sort).toHaveBeenCalledWith({ sortOrder: 1, price: 1, name: 1 });
        expect(out).toHaveLength(1);
        expect(out[0]).not.toHaveProperty('razorpayPlanId');
    });

    test('getPublicPlans is cached until invalidate()', async () => {
        const sort = jest.fn().mockReturnValue({ lean: () => Promise.resolve([fullPlan()]) });
        mockPlanFind.mockReturnValue({ sort });
        publicPlans.publicPlansCache.invalidate();
        await publicPlans.getPublicPlans();
        await publicPlans.getPublicPlans();
        expect(mockPlanFind).toHaveBeenCalledTimes(1);
        publicPlans.publicPlansCache.invalidate();
        await publicPlans.getPublicPlans();
        expect(mockPlanFind).toHaveBeenCalledTimes(2);
        expect(publicPlans.PUBLIC_PLANS_TTL_MS).toBe(5 * 60 * 1000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6.3 razorpayBilling
// ═══════════════════════════════════════════════════════════════════════
describe('razorpayBilling — pure helpers', () => {
    test.each([
        [999, 99900],
        [1999, 199900],
        ['499', 49900],
        [0.29, 29],          // 0.29*100 = 28.999… → must round, not truncate
        [1999.99, 199999],
        [0, 0],
    ])('toPaise(%p) = %p', (rupees, paise) => {
        expect(billing.toPaise(rupees)).toBe(paise);
    });

    test.each([
        ['monthly', 'monthly'],
        ['quarterly', 'quarterly'],
        ['yearly', 'yearly'],
        ['weekly', 'monthly'],
        [undefined, 'monthly'],
    ])('toRazorpayPeriod(%p) = %p', (cycle, period) => {
        expect(billing.toRazorpayPeriod(cycle)).toBe(period);
    });

    test('isBillingConfigured: true with keys, false without (fresh module)', () => {
        expect(billing.isBillingConfigured()).toBe(true);
        const saved = process.env.RAZORPAY_KEY_SECRET;
        delete process.env.RAZORPAY_KEY_SECRET;
        jest.isolateModules(() => {
            const fresh = require('../utils/razorpayBilling');
            expect(fresh.isBillingConfigured()).toBe(false);
        });
        process.env.RAZORPAY_KEY_SECRET = saved;
    });

    test('every SDK-backed helper throws "not configured" without keys', async () => {
        const saved = process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_ID;
        let fresh;
        jest.isolateModules(() => { fresh = require('../utils/razorpayBilling'); });
        try {
        await expect(fresh.ensureRazorpayPlan({ _id: 'p', price: 1 })).rejects.toThrow(/not configured/);
        await expect(fresh.ensureRazorpayCustomer({ _id: 'r' })).rejects.toThrow(/not configured/);
        await expect(fresh.createRazorpaySubscription({})).rejects.toThrow(/not configured/);
        await expect(fresh.cancelRazorpaySubscription('sub_1')).rejects.toThrow(/not configured/);
        await expect(fresh.fetchRazorpaySubscription('sub_1')).rejects.toThrow(/not configured/);
        await expect(fresh.listSubscriptionInvoices('sub_1')).rejects.toThrow(/not configured/);
        await expect(fresh.fetchRazorpayPayment('pay_1')).rejects.toThrow(/not configured/);
        } finally {
            process.env.RAZORPAY_KEY_ID = saved;
        }
    });
});

describe('razorpayBilling — ensureRazorpayPlan', () => {
    const plan = (extra = {}) => ({
        _id: { toString: () => 'pid1' },
        name: 'Pro', slug: 'pro', price: 1999, billingCycle: 'quarterly', description: '',
        razorpayPlanId: '',
        save: jest.fn().mockResolvedValue(undefined),
        ...extra,
    });

    test('idempotent: existing razorpayPlanId → no API call', async () => {
        const p = plan({ razorpayPlanId: 'plan_existing' });
        await expect(billing.ensureRazorpayPlan(p)).resolves.toBe(p);
        expect(mockRzp.plans.create).not.toHaveBeenCalled();
    });

    test('creates a plan with the price in PAISE and stamps the id', async () => {
        mockRzp.plans.create.mockResolvedValue({ id: 'plan_new' });
        const p = plan();
        await billing.ensureRazorpayPlan(p);
        expect(mockRzp.plans.create).toHaveBeenCalledWith({
            period: 'quarterly',
            interval: 1,
            item: { name: 'Pro', amount: 199900, currency: 'INR', description: 'BestoDine Pro plan' },
            notes: { planSlug: 'pro', planId: 'pid1' },
        });
        expect(p.razorpayPlanId).toBe('plan_new');
        expect(p.save).toHaveBeenCalled();
    });

    test.each([0, -5, undefined])('price %p → refuses to create a Razorpay plan', async (price) => {
        await expect(billing.ensureRazorpayPlan(plan({ price }))).rejects.toThrow(/zero-price/);
        expect(mockRzp.plans.create).not.toHaveBeenCalled();
    });

    test('missing plan doc → throws', async () => {
        await expect(billing.ensureRazorpayPlan(null)).rejects.toThrow(/requires a plan/);
    });

    test('401 propagates with statusCode (callers fall back to Orders API) and is logged', async () => {
        mockRzp.plans.create.mockRejectedValue({ statusCode: 401, error: { description: 'unauthorized' } });
        await expect(billing.ensureRazorpayPlan(plan())).rejects.toMatchObject({ statusCode: 401 });
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/401/));
    });

    test('other errors propagate untouched and the plan is not stamped', async () => {
        const p = plan();
        mockRzp.plans.create.mockRejectedValue({ statusCode: 400, error: { description: 'bad amount' } });
        await expect(billing.ensureRazorpayPlan(p)).rejects.toMatchObject({ statusCode: 400 });
        expect(p.razorpayPlanId).toBe('');
        expect(p.save).not.toHaveBeenCalled();
    });
});

describe('razorpayBilling — ensureRazorpayCustomer', () => {
    const restaurant = (sub = {}) => ({
        _id: { toString: () => 'rid1' },
        slug: 'cafe', name: 'Cafe', contactEmail: 'cafe@x.test', contactPhone: '9000000000',
        subscription: { ...sub },
    });

    test('idempotent: existing customer id → returned, no API call', async () => {
        const r = restaurant({ razorpayCustomerId: 'cust_existing' });
        await expect(billing.ensureRazorpayCustomer(r, null)).resolves.toBe('cust_existing');
        expect(mockRzp.customers.create).not.toHaveBeenCalled();
    });

    test('creates from the owner and stamps the id on the restaurant', async () => {
        mockRzp.customers.create.mockResolvedValue({ id: 'cust_1' });
        const r = restaurant();
        const id = await billing.ensureRazorpayCustomer(r, { name: 'Asha', email: 'asha@x.test', mobile: '9111111111' });
        expect(id).toBe('cust_1');
        expect(r.subscription.razorpayCustomerId).toBe('cust_1');
        expect(mockRzp.customers.create).toHaveBeenCalledWith({
            name: 'Asha', email: 'asha@x.test', contact: '9111111111',
            notes: { restaurantId: 'rid1', restaurantSlug: 'cafe' },
            fail_existing: '0',
        });
    });

    test('no owner → falls back to restaurant contact details', async () => {
        mockRzp.customers.create.mockResolvedValue({ id: 'cust_2' });
        await billing.ensureRazorpayCustomer(restaurant(), null);
        expect(mockRzp.customers.create).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Cafe', email: 'cafe@x.test', contact: '9000000000',
        }));
    });

    test('restaurant without a subscription object still gets the id', async () => {
        mockRzp.customers.create.mockResolvedValue({ id: 'cust_3' });
        const r = restaurant();
        delete r.subscription;
        await billing.ensureRazorpayCustomer(r, null);
        expect(r.subscription.razorpayCustomerId).toBe('cust_3');
    });

    test('"already exists" → looks the customer up by email (case-insensitive) and reuses it', async () => {
        mockRzp.customers.create.mockRejectedValue({ error: { description: 'Customer already exists for the merchant' } });
        mockRzp.customers.all.mockResolvedValue({ items: [{ id: 'cust_other', email: 'z@x.test' }, { id: 'cust_found', email: 'CAFE@X.TEST' }] });
        const r = restaurant();
        await expect(billing.ensureRazorpayCustomer(r, null)).resolves.toBe('cust_found');
        expect(r.subscription.razorpayCustomerId).toBe('cust_found');
    });

    test('"already exists" but not found in the list → original error rethrown', async () => {
        const createErr = { error: { description: 'Customer already exists' } };
        mockRzp.customers.create.mockRejectedValue(createErr);
        mockRzp.customers.all.mockResolvedValue({ items: [] });
        await expect(billing.ensureRazorpayCustomer(restaurant(), null)).rejects.toBe(createErr);
    });

    test('"already exists" and the lookup itself fails → original error rethrown', async () => {
        const createErr = { error: { description: 'Customer already exists' } };
        mockRzp.customers.create.mockRejectedValue(createErr);
        mockRzp.customers.all.mockRejectedValue(new Error('network'));
        await expect(billing.ensureRazorpayCustomer(restaurant(), null)).rejects.toBe(createErr);
    });

    test('other create errors are rethrown, nothing stamped', async () => {
        const err = { statusCode: 400, error: { description: 'invalid contact' } };
        mockRzp.customers.create.mockRejectedValue(err);
        const r = restaurant();
        await expect(billing.ensureRazorpayCustomer(r, null)).rejects.toBe(err);
        expect(r.subscription.razorpayCustomerId).toBeUndefined();
        expect(mockRzp.customers.all).not.toHaveBeenCalled();
    });

    test('missing restaurant → throws', async () => {
        await expect(billing.ensureRazorpayCustomer(null)).rejects.toThrow(/requires a restaurant/);
    });
});

describe('razorpayBilling — createRazorpaySubscription', () => {
    const restaurant = { _id: { toString: () => 'rid1' }, slug: 'cafe' };
    const plan = (extra = {}) => ({
        _id: 'pid', name: 'Pro', slug: 'pro', price: 1999, currency: 'INR', billingCycle: 'monthly',
        razorpayPlanId: 'plan_1', ...extra,
    });

    test.each([
        ['monthly', 120],
        ['quarterly', 40],
        ['yearly', 10],
        ['weird', 120],
    ])('subscription path: %s → total_count %p, notes carry the tenant', async (cycle, count) => {
        mockRzp.subscriptions.create.mockResolvedValue({ id: 'sub_1', status: 'created', short_url: 'https://rzp.io/x' });
        const sub = await billing.createRazorpaySubscription({ plan: plan({ billingCycle: cycle }), restaurant, customerId: 'cust_1' });
        expect(sub.id).toBe('sub_1');
        expect(mockRzp.subscriptions.create).toHaveBeenCalledWith({
            plan_id: 'plan_1', customer_notify: 1, quantity: 1, total_count: count,
            notes: { restaurantId: 'rid1', restaurantSlug: 'cafe', planSlug: 'pro' },
        });
        expect(mockRzp.orders.create).not.toHaveBeenCalled();
    });

    test('plan never synced → Orders-API fallback for the plan price in PAISE, stamped plan_payment', async () => {
        mockRzp.orders.create.mockResolvedValue({ id: 'order_1', currency: 'INR' });
        const out = await billing.createRazorpaySubscription({ plan: plan({ razorpayPlanId: '' }), restaurant, customerId: 'cust_1' });
        expect(mockRzp.subscriptions.create).not.toHaveBeenCalled();
        const args = mockRzp.orders.create.mock.calls[0][0];
        expect(args.amount).toBe(199900);
        expect(args.currency).toBe('INR');
        expect(args.notes).toEqual({
            type: 'plan_payment', restaurantId: 'rid1', restaurantSlug: 'cafe', planSlug: 'pro', planName: 'Pro',
        });
        expect(args.receipt.length).toBeLessThanOrEqual(40);
        expect(out).toEqual({
            id: 'order_1', status: 'created', short_url: '', fallbackOrder: true,
            orderId: 'order_1', amount: 199900, currency: 'INR', key: 'rzp_test_unit',
        });
    });

    test('long slug still yields a receipt within Razorpay\'s 40-char cap', async () => {
        mockRzp.orders.create.mockResolvedValue({ id: 'order_2', currency: 'INR' });
        await billing.createRazorpaySubscription({
            plan: plan({ razorpayPlanId: '', slug: 'enterprise-unlimited-platinum-annual-plan' }), restaurant, customerId: 'c',
        });
        expect(mockRzp.orders.create.mock.calls[0][0].receipt.length).toBeLessThanOrEqual(40);
    });

    test('Subscriptions API 401 → falls back to Orders', async () => {
        mockRzp.subscriptions.create.mockRejectedValue({ statusCode: 401, error: 'Unauthorized' });
        mockRzp.orders.create.mockResolvedValue({ id: 'order_3', currency: 'INR' });
        const out = await billing.createRazorpaySubscription({ plan: plan(), restaurant, customerId: 'cust_1' });
        expect(out.fallbackOrder).toBe(true);
        expect(out.amount).toBe(199900);
    });

    test.each([400, 500, undefined])('Subscriptions API error status %p → rethrown, no fallback order', async (statusCode) => {
        const err = { statusCode, error: { description: 'boom' } };
        mockRzp.subscriptions.create.mockRejectedValue(err);
        await expect(billing.createRazorpaySubscription({ plan: plan(), restaurant, customerId: 'cust_1' })).rejects.toBe(err);
        expect(mockRzp.orders.create).not.toHaveBeenCalled();
    });

    test('synced plan but no customerId → throws (no fallback)', async () => {
        await expect(billing.createRazorpaySubscription({ plan: plan(), restaurant, customerId: '' }))
            .rejects.toThrow(/customerId/);
        expect(mockRzp.orders.create).not.toHaveBeenCalled();
    });

    test('fallback order creation failure propagates', async () => {
        mockRzp.orders.create.mockRejectedValue(new Error('orders down'));
        await expect(billing.createRazorpaySubscription({ plan: plan({ razorpayPlanId: '' }), restaurant, customerId: 'c' }))
            .rejects.toThrow('orders down');
    });
});

describe('razorpayBilling — cancel / fetch / list', () => {
    test.each([[true, true], [false, false], [undefined, false]])(
        'cancel(id, %p) passes a BOOLEAN cancelAtCycleEnd=%p to the SDK',
        async (arg, expected) => {
            mockRzp.subscriptions.cancel.mockResolvedValue({ id: 'sub_1', status: 'cancelled' });
            await billing.cancelRazorpaySubscription('sub_1', arg);
            expect(mockRzp.subscriptions.cancel).toHaveBeenCalledWith('sub_1', expected);
        },
    );

    test('cancel requires an id', async () => {
        await expect(billing.cancelRazorpaySubscription('')).rejects.toThrow(/requires an id/);
    });

    test('fetch / payment fetch return null for an empty id without calling the SDK', async () => {
        await expect(billing.fetchRazorpaySubscription('')).resolves.toBeNull();
        await expect(billing.fetchRazorpayPayment('')).resolves.toBeNull();
        expect(mockRzp.subscriptions.fetch).not.toHaveBeenCalled();
        expect(mockRzp.payments.fetch).not.toHaveBeenCalled();
    });

    test('fetch passes through', async () => {
        mockRzp.subscriptions.fetch.mockResolvedValue({ id: 'sub_9', status: 'active' });
        mockRzp.payments.fetch.mockResolvedValue({ id: 'pay_9' });
        await expect(billing.fetchRazorpaySubscription('sub_9')).resolves.toEqual({ id: 'sub_9', status: 'active' });
        await expect(billing.fetchRazorpayPayment('pay_9')).resolves.toEqual({ id: 'pay_9' });
    });

    test('listSubscriptionInvoices: items, empty, missing id', async () => {
        mockRzp.invoices.all.mockResolvedValueOnce({ items: [{ id: 'inv_1' }] });
        await expect(billing.listSubscriptionInvoices('sub_1')).resolves.toEqual([{ id: 'inv_1' }]);
        expect(mockRzp.invoices.all).toHaveBeenCalledWith({ subscription_id: 'sub_1', count: 100 });
        mockRzp.invoices.all.mockResolvedValueOnce({});
        await expect(billing.listSubscriptionInvoices('sub_1')).resolves.toEqual([]);
        await expect(billing.listSubscriptionInvoices('')).resolves.toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6.2 planPaymentApply
// ═══════════════════════════════════════════════════════════════════════
function restaurantDoc(subscription = {}, extra = {}) {
    return {
        _id: 'rid1',
        name: 'Cafe',
        slug: 'cafe',
        status: 'active',
        subscription: {
            plan: 'basicId', planName: 'Basic', planSlug: 'basic', price: 999,
            features: { dineIn: true }, limits: { maxStaff: 5 }, status: 'active',
            ...subscription,
        },
        save: jest.fn().mockResolvedValue(undefined),
        ...extra,
    };
}

const PENDING_PRO = {
    plan: 'proId', planName: 'Pro', planSlug: 'pro', price: 1999,
    features: { dineIn: true, crm: true }, limits: { maxStaff: 20 },
};

describe('applyPendingUpgrade', () => {
    test('no pending upgrade → false, nothing touched', () => {
        const r = restaurantDoc();
        expect(applyPendingUpgrade(r)).toBe(false);
        expect(r.subscription.planSlug).toBe('basic');
    });

    test('moves the pending snapshot into the live fields and clears transient state', () => {
        const r = restaurantDoc({
            pendingUpgrade: { ...PENDING_PRO },
            shortUrl: 'https://rzp.io/stale',
            trialEndDate: new Date(),
            scheduledDowngrade: { planSlug: 'free' },
            status: 'trial',
        }, { status: 'trial' });
        expect(applyPendingUpgrade(r)).toBe(true);
        expect(r.subscription).toMatchObject({
            plan: 'proId', planName: 'Pro', planSlug: 'pro', price: 1999,
            features: { dineIn: true, crm: true }, limits: { maxStaff: 20 },
            shortUrl: '', status: 'active', endDate: null, trialEndDate: null,
        });
        expect(r.subscription.pendingUpgrade).toBeUndefined();
        expect(r.subscription.scheduledDowngrade).toBeUndefined();
        expect(r.status).toBe('active');
        // idempotent
        expect(applyPendingUpgrade(r)).toBe(false);
    });

    test('pending without a numeric price keeps the existing agreed price', () => {
        const r = restaurantDoc({ pendingUpgrade: { ...PENDING_PRO, price: undefined } });
        applyPendingUpgrade(r);
        expect(r.subscription.price).toBe(999);
    });

    test('a suspended tenant is NOT un-suspended by an upgrade', () => {
        const r = restaurantDoc({ pendingUpgrade: { ...PENDING_PRO } }, { status: 'suspended' });
        applyPendingUpgrade(r);
        expect(r.status).toBe('suspended');
    });

    // Regression (fixed 2026-10): applyPendingUpgrade cancels the old Razorpay subscription immediately via razorpayBilling.cancelRazorpaySubscription(id, false).
    test('switching to a new Razorpay subscription cancels the old one', () => {
        mockRzp.subscriptions.cancel.mockResolvedValue({});
        const r = restaurantDoc({
            razorpaySubscriptionId: 'sub_OLD',
            pendingUpgrade: { ...PENDING_PRO, razorpaySubscriptionId: 'sub_NEW' },
        });
        applyPendingUpgrade(r);
        expect(r.subscription.razorpaySubscriptionId).toBe('sub_NEW');
        // Before the fix: subscriptions.cancel never called; logger.warn received
        // 'Razorpay client error during sub cancel' (MODULE_NOT_FOUND).
        expect(mockRzp.subscriptions.cancel).toHaveBeenCalledWith('sub_OLD', false);
    });

    test('same subscription id → no cancel attempted', () => {
        const r = restaurantDoc({
            razorpaySubscriptionId: 'sub_SAME',
            pendingUpgrade: { ...PENDING_PRO, razorpaySubscriptionId: 'sub_SAME' },
        });
        applyPendingUpgrade(r);
        expect(mockRzp.subscriptions.cancel).not.toHaveBeenCalled();
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });
});

describe('applyScheduledDowngrade', () => {
    const SCHED = {
        plan: 'basicId', planName: 'Basic', planSlug: 'basic', price: 999,
        features: { dineIn: true }, limits: { maxStaff: 5 },
    };

    test('nothing scheduled → { applied:false }', () => {
        expect(applyScheduledDowngrade(restaurantDoc())).toEqual({ applied: false });
    });

    test('effectiveAt in the future → pending, nothing changes (fake clock)', () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00Z') });
        const r = restaurantDoc({ planSlug: 'pro', scheduledDowngrade: { ...SCHED, effectiveAt: new Date('2026-10-03T10:00:01Z') } });
        expect(applyScheduledDowngrade(r)).toEqual({ applied: false, pending: true });
        expect(r.subscription.planSlug).toBe('pro');
    });

    test('effectiveAt reached exactly → applied; Razorpay links cleared', () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00Z') });
        const r = restaurantDoc({
            planSlug: 'pro', price: 1999, razorpaySubscriptionId: 'sub_old', shortUrl: 'u', razorpayStatus: 'cancelled',
            scheduledDowngrade: { ...SCHED, effectiveAt: new Date('2026-10-03T10:00:00Z') },
        });
        expect(applyScheduledDowngrade(r)).toEqual({ applied: true });
        expect(r.subscription).toMatchObject({
            planSlug: 'basic', price: 999, features: { dineIn: true }, limits: { maxStaff: 5 },
            razorpaySubscriptionId: '', shortUrl: '', razorpayStatus: '', status: 'active',
        });
        expect(r.subscription.startDate.toISOString()).toBe('2026-10-03T10:00:00.000Z');
        expect(r.subscription.scheduledDowngrade).toBeUndefined();
    });

    test('force applies a future schedule', () => {
        const r = restaurantDoc({ scheduledDowngrade: { ...SCHED, effectiveAt: new Date(Date.now() + 86400000) } });
        expect(applyScheduledDowngrade(r, { force: true })).toEqual({ applied: true });
    });

    // Regression (fixed 2026-10): applyScheduledDowngrade only lifts payment-related suspensions (confirmPayment's rule).
    test('a manual (non-payment) suspension survives a scheduled downgrade', () => {
        const r = restaurantDoc(
            { scheduledDowngrade: { ...SCHED, effectiveAt: new Date(Date.now() - 1000) } },
            { status: 'suspended', suspendedReason: 'Terms of service violation' },
        );
        applyScheduledDowngrade(r);
        expect(r.status).toBe('suspended');
    });
});

describe('applyPaidPlanUpgrade — money + invoice numbering', () => {
    const payment = (extra = {}) => ({
        id: 'pay_1', amount: 199900, currency: 'INR', status: 'captured',
        created_at: 1790000000, ...extra,
    });

    test('requires restaurant + payment.id', async () => {
        await expect(applyPaidPlanUpgrade({ restaurant: null, payment: payment() })).rejects.toThrow(/requires/);
        await expect(applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: {} })).rejects.toThrow(/requires/);
    });

    test('invoice amount is the captured amount in PAISE (exact), paidAt from created_at', async () => {
        const r = restaurantDoc({ pendingUpgrade: { ...PENDING_PRO } });
        await applyPaidPlanUpgrade({ restaurant: r, payment: payment() });
        const doc = mockInvoice.create.mock.calls[0][0];
        expect(doc.amount).toBe(199900);
        expect(doc.currency).toBe('INR');
        expect(doc.paidAt.getTime()).toBe(1790000000 * 1000);
        expect(doc.planSlug).toBe('pro');
        expect(r.subscription.price).toBe(1999); // rupees on the tenant snapshot
    });

    test('missing amount/currency/created_at fall back to 0 / INR / now', async () => {
        await applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: { id: 'pay_x' } });
        const doc = mockInvoice.create.mock.calls[0][0];
        expect(doc.amount).toBe(0);
        expect(doc.currency).toBe('INR');
        expect(doc.paidAt).toBeInstanceOf(Date);
    });

    test('per-tenant per-day counter: today count 4 → -0005', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T12:00:00+05:30') });
        mockInvoice.countDocuments.mockResolvedValue(4);
        const out = await applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: payment() });
        // date part asserted by the BUG test below; here only the counter
        expect(out.invoiceNumber).toMatch(/^INV-\d{8}-0005$/);
        const q = mockInvoice.countDocuments.mock.calls[0][0];
        expect(q.restaurant).toBe('rid1');
        expect(q.createdAt.$gte.getTime()).toBe(new Date('2026-10-03T00:00:00+05:30').getTime());
    });

    test('invoiceNumber race → retries with the next slot', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T12:00:00+05:30') });
        const dup = Object.assign(new Error('E11000 duplicate key error index: restaurant_invoiceNumber_unique dup key { invoiceNumber: "INV-20261003-0001" }'), { code: 11000 });
        mockInvoice.create.mockRejectedValueOnce(dup).mockRejectedValueOnce(dup);
        const out = await applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: payment() });
        expect(out.invoiceCreated).toBe(true);
        expect(out.invoiceNumber).toMatch(/^INV-\d{8}-0003$/);
        expect(mockInvoice.create).toHaveBeenCalledTimes(3);
    });

    test('50 consecutive number collisions → throws (bounded retry)', async () => {
        const dup = Object.assign(new Error('E11000 dup key { invoiceNumber: "x" }'), { code: 11000 });
        mockInvoice.create.mockRejectedValue(dup);
        await expect(applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: payment() }))
            .rejects.toThrow(/after 50 attempts/);
        expect(mockInvoice.create).toHaveBeenCalledTimes(50);
    });

    test('non-duplicate DB error is rethrown', async () => {
        mockInvoice.create.mockRejectedValue(new Error('disk full'));
        await expect(applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: payment() })).rejects.toThrow('disk full');
    });

    // Regression (fixed 2026-10): invoice YYYYMMDD is the local calendar date (same basis as startOfDay), not the UTC date of local midnight.
    test('invoice number carries the LOCAL calendar date of the charge', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00+05:30') });
        const out = await applyPaidPlanUpgrade({ restaurant: restaurantDoc(), payment: payment() });
        expect(out.invoiceNumber).toBe('INV-20261003-0001');
    });

    test('currentPeriodEnd / invoice periodEnd = +1 month (mid-month)', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00+05:30') });
        const r = restaurantDoc();
        await applyPaidPlanUpgrade({ restaurant: r, payment: payment() });
        expect(r.subscription.currentPeriodEnd.toISOString()).toBe(new Date('2026-11-15T12:00:00+05:30').toISOString());
        expect(mockInvoice.create.mock.calls[0][0].periodEnd.getTime()).toBe(r.subscription.currentPeriodEnd.getTime());
    });

    // Regression (fixed 2026-10): +1 month is clamped to the last day of the next month (addOneMonth).
    test('+1 month from 31 Jan ends on the last day of February, not in March', async () => {
        jest.useFakeTimers({ now: new Date('2027-01-31T12:00:00+05:30') });
        const r = restaurantDoc();
        await applyPaidPlanUpgrade({ restaurant: r, payment: payment() });
        const end = r.subscription.currentPeriodEnd;
        expect(end.getMonth()).toBe(1); // February
        expect(end.getDate()).toBe(28);
    });
});
