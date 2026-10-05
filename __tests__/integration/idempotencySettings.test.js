/**
 * Idempotency-Key over real HTTP + Mongo, and the Settings write/read
 * surface (checklist 10.1, 10.13 settings):
 *
 *   middlewares/idempotency.js   unique index, malformed key, validation-
 *                                before-idempotency, 5xx not cached, 4xx
 *                                cached (stale PAYMENT_NOT_CAPTURED replay),
 *                                cross-caller isolation, concurrent same-key
 *                                money calls (verify-wallet-recharge,
 *                                wallet/pay)
 *   controllers/settingsController.js + routes/settingsRoute.js
 *                                taxes / loyalty / refundMode / reservation /
 *                                delivery slab / landing page validation,
 *                                restaurant / branch / landingPage smuggling
 *                                on PUT, sub-branch inheritance (403 + strip),
 *                                customer branch view inherits tenant taxes,
 *                                guest GET hides general.legal
 *   utils/settingsCache.js       invalidation after PATCH, cross-instance
 *                                invalidation via cacheBus (publish + deliver)
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const IdempotencyRecord = require(path.join(BACKEND, 'models/idempotencyRecord'));
const settingsCache = require(path.join(BACKEND, 'utils/settingsCache'));
const cacheBus = require(path.join(BACKEND, 'utils/cacheBus'));

const ctx = useIntegrationApp();
let A;
let B;

const rid = () => crypto.randomBytes(5).toString('hex');
const key = (p = 'k') => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const sig = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'ids-a' });
    B = await seedTenant({ label: 'ids-b' });
});

// ── helpers ──────────────────────────────────────────────────────────

const withHeaders = (r, headers = {}) => {
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r;
};

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `IDS-${rid()}`,
        type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        ...fields,
    });
    return doc.toObject();
}

/** An order stamped with a Razorpay checkout + the browser's verify body. */
async function orderCheckout(t, fields = {}) {
    const rzpOrderId = `order_${rid()}`;
    const paymentId = `pay_${rid()}`;
    const order = await makeOrder(t, { razorpayOrderId: rzpOrderId, ...fields });
    return {
        order, rzpOrderId, paymentId,
        body: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig(rzpOrderId, paymentId), cafeOrderId: String(order._id) },
    };
}

function stubOrderGateway(c, { status = 'captured', amount = 50000 } = {}) {
    const notes = { cafeOrderId: String(c.order._id), restaurantId: String(c.order.restaurant), purpose: 'cafe_order' };
    rzp.instance.payments.fetch.mockResolvedValue({ id: c.paymentId, entity: 'payment', order_id: c.rzpOrderId, status, amount, currency: 'INR', notes });
    rzp.instance.orders.fetch.mockResolvedValue({ id: c.rzpOrderId, entity: 'order', amount, notes });
}

/** Stub one wallet-recharge checkout for `cust` in `t`. */
function recharge(cust, t, { amount = 25000, status = 'captured' } = {}) {
    const paymentId = `pay_${rid()}`;
    const orderId = `order_${rid()}`;
    const notes = { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(t.restaurant._id) };
    const stub = (st) => {
        rzp.instance.payments.fetch.mockResolvedValue({ id: paymentId, entity: 'payment', order_id: orderId, amount, currency: 'INR', status: st, notes: {} });
        rzp.instance.orders.fetch.mockResolvedValue({ id: orderId, entity: 'order', amount, notes });
    };
    stub(status);
    return { paymentId, orderId, stub, body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig(orderId, paymentId) } };
}

const verifyPayment = (client, body, headers) => withHeaders(client.post('/razorpay/verify-payment'), headers).send(body);
const verifyRecharge = (cust, t, body, headers) => withHeaders(ctx.api.as(cust, t).post('/razorpay/verify-wallet-recharge'), headers).send(body);
const balanceOf = async (t, cust) => (await Wallet.findOne({ user: cust._id, restaurant: t.restaurant._id }).lean())?.balance;
const reload = (o) => Order.findById(o._id).lean();

// ═══════════════════════ idempotency ═════════════════════════════════

describe('Idempotency-Key — storage + key validation', () => {
    test('idempotencyrecords has a UNIQUE index on key and a 24h TTL on createdAt', async () => {
        await IdempotencyRecord.init();
        const indexes = await IdempotencyRecord.collection.indexes();
        const byKey = indexes.find((i) => i.key && i.key.key === 1);
        expect(byKey).toEqual(expect.objectContaining({ unique: true }));
        const ttl = indexes.find((i) => i.key && i.key.createdAt === 1);
        expect(ttl).toEqual(expect.objectContaining({ expireAfterSeconds: 86400 }));
    });

    test('a malformed key is refused before the handler runs (no gateway call, no record)', async () => {
        const c = await orderCheckout(A);
        stubOrderGateway(c);
        const before = await IdempotencyRecord.countDocuments();
        const res = await verifyPayment(ctx.api.guest(A), c.body, { 'Idempotency-Key': 'bad key!' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect(await IdempotencyRecord.countDocuments()).toBe(before);
        expect((await reload(c.order)).paymentStatus).toBe('Pending');
    });

    test('route validation runs BEFORE idempotency: a malformed body is not cached under the key', async () => {
        const c = await orderCheckout(A);
        stubOrderGateway(c);
        const headers = { 'Idempotency-Key': key('val') };
        const bad = await verifyPayment(ctx.api.guest(A), { ...c.body, razorpay_payment_id: undefined }, headers);
        expect(bad.status).toBe(400);
        await settle();
        const good = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(good.status).toBe(200);
        expect(good.headers['idempotent-replayed']).toBeUndefined();
        expect((await reload(c.order)).paymentStatus).toBe('Paid');
    });

    test('the stored record holds the scoped hash (never the raw key) + endpoint + tenant', async () => {
        const c = await orderCheckout(A);
        stubOrderGateway(c);
        const raw = key('raw');
        await verifyPayment(ctx.api.guest(A), c.body, { 'Idempotency-Key': raw });
        await settle();
        const rec = await IdempotencyRecord.findOne({ endpoint: 'POST /api/v1/razorpay/verify-payment', 'response.paymentId': c.paymentId }).lean();
        expect(rec).toBeTruthy();
        expect(rec.key).toMatch(/^[a-f0-9]{64}$/);
        expect(rec.key).not.toContain(raw);
        expect(String(rec.restaurant)).toBe(String(A.restaurant._id));
        expect(await IdempotencyRecord.countDocuments({ key: raw })).toBe(0);
    });
});

describe('Idempotency-Key — what gets cached', () => {
    test('5xx is NOT cached: a gateway outage (502) then a retry with the same key settles the order', async () => {
        const c = await orderCheckout(A);
        const headers = { 'Idempotency-Key': key('5xx') };
        rzp.instance.payments.fetch.mockRejectedValue(new Error('ETIMEDOUT'));
        const first = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(first.status).toBe(502);
        await settle();
        stubOrderGateway(c);
        const second = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(second.status).toBe(200);
        expect(second.headers['idempotent-replayed']).toBeUndefined();
        expect((await reload(c.order)).paymentStatus).toBe('Paid');
    });

    // Changed 2026-10: a 400 is no longer cached (only 2xx + 409 are), so an
    // identical retry re-asks the gateway instead of replaying the 400.
    test('4xx is NOT cached: an identical retry re-checks with the gateway', async () => {
        const c = await orderCheckout(A);
        const headers = { 'Idempotency-Key': key('4xx') };
        stubOrderGateway(c, { status: 'created' });
        const first = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(first.status).toBe(400);
        expect(first.body.code).toBe('PAYMENT_NOT_CAPTURED');
        await settle();
        const second = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(second.status).toBe(400);
        expect(second.headers['idempotent-replayed']).toBeUndefined();
        expect(rzp.instance.payments.fetch).toHaveBeenCalledTimes(2);
    });

    // Regression (fixed 2026-10): idempotency caches only 2xx/409, so a transient 400 is not replayed to the retry.
    test('verify-payment retry with the same key after the payment is captured settles the order', async () => {
        const c = await orderCheckout(A);
        const headers = { 'Idempotency-Key': key('stale') };

        stubOrderGateway(c, { status: 'created' });
        const first = await verifyPayment(ctx.api.guest(A), c.body, headers);
        expect(first.status).toBe(400);
        expect(first.body.code).toBe('PAYMENT_NOT_CAPTURED');
        await settle();

        stubOrderGateway(c, { status: 'captured' });             // payment now settled at Razorpay
        const retry = await verifyPayment(ctx.api.guest(A), c.body, headers);

        expect({ status: retry.status, replayed: retry.headers['idempotent-replayed'] || null, code: retry.body.code || null })
            .toEqual({ status: 200, replayed: null, code: null });
        expect((await reload(c.order)).paymentStatus).toBe('Paid');
    });

    // Regression (fixed 2026-10): same fix (only 2xx/409 cached) on verify-wallet-recharge.
    test('verify-wallet-recharge retry with the same key after capture credits the wallet', async () => {
        const cust = await createCustomer('ids-stale-wr');
        const r = recharge(cust, A, { amount: 40000, status: 'created' });
        const headers = { 'Idempotency-Key': key('wrstale') };

        const first = await verifyRecharge(cust, A, r.body, headers);
        expect(first.status).toBe(400);
        expect(first.body.code).toBe('PAYMENT_NOT_CAPTURED');
        await settle();

        r.stub('captured');
        const retry = await verifyRecharge(cust, A, r.body, headers);

        expect(retry.status).toBe(200);
        expect(await balanceOf(A, cust)).toBe(400);
    });
});

describe('Idempotency-Key — scoping across callers', () => {
    test("another customer re-using the same key never receives the first customer's cached response", async () => {
        const c1 = await createCustomer('ids-scope-1');
        const c2 = await createCustomer('ids-scope-2');
        const sharedKey = key('shared');
        const r1 = recharge(c1, A, { amount: 10000 });
        const first = await verifyRecharge(c1, A, r1.body, { 'Idempotency-Key': sharedKey });
        expect(first.status).toBe(200);
        await settle();

        const r2 = recharge(c2, A, { amount: 20000 });
        const second = await verifyRecharge(c2, A, r2.body, { 'Idempotency-Key': sharedKey });
        expect(second.status).toBe(200);
        expect(second.headers['idempotent-replayed']).toBeUndefined();
        expect(await balanceOf(A, c2)).toBe(200);
        expect(await balanceOf(A, c1)).toBe(100);
    });

    test('the same caller + key on a DIFFERENT endpoint is not a replay', async () => {
        const cust = await createCustomer('ids-ep');
        const k = key('ep');
        const r = recharge(cust, A, { amount: 10000 });
        await verifyRecharge(cust, A, r.body, { 'Idempotency-Key': k });
        await settle();
        const c = await orderCheckout(A, { user: cust._id });
        stubOrderGateway(c);
        const res = await verifyPayment(ctx.api.as(cust, A), c.body, { 'Idempotency-Key': k });
        expect(res.status).toBe(200);
        expect(res.headers['idempotent-replayed']).toBeUndefined();
        expect(res.body.paymentId).toBe(c.paymentId);
    });
});

describe('Idempotency-Key — concurrent same-key money calls', () => {
    test('three simultaneous verify-wallet-recharge calls with ONE key credit the wallet once', async () => {
        const cust = await createCustomer('ids-conc');
        const r = recharge(cust, A, { amount: 25000 });
        const headers = { 'Idempotency-Key': key('conc') };

        const results = await Promise.all([1, 2, 3].map(() => verifyRecharge(cust, A, r.body, headers)));
        await settle(300);

        results.forEach((res) => expect(res.status).toBe(200));
        expect(await balanceOf(A, cust)).toBe(250);
        expect(await Transaction.countDocuments({ razorpayPaymentId: r.paymentId })).toBe(1);
        // The middleware has no in-flight lock: concurrent twins all miss the
        // lookup and run the handler; the unique index lets one record win.
        // Money safety here comes from the controller's PaymentClaim, not
        // from idempotency.
        const replayed = results.filter((res) => res.headers['idempotent-replayed'] === 'true').length;
        expect(replayed).toBeLessThan(3);
        expect(rzp.instance.payments.fetch.mock.calls.length).toBe(3 - replayed);
        const recs = await IdempotencyRecord.countDocuments({ endpoint: 'POST /api/v1/razorpay/verify-wallet-recharge', user: cust._id });
        expect(recs).toBe(1);
    });

    test('three simultaneous POST /wallet/pay with one key debit once (key is ignored — route has no idempotency(); the DB transaction protects it)', async () => {
        const cust = await createCustomer('ids-pay');
        await setWallet(A, cust, { balance: 1000 });
        const order = await makeOrder(A, { user: cust._id, total: 300, items: [{ menuItem: A.items.paneer._id, name: 'Paneer Tikka', price: 300, quantity: 1 }] });
        const headers = { 'Idempotency-Key': key('wpay') };

        const results = await Promise.all([1, 2, 3].map(() => withHeaders(ctx.api.as(cust, A).post('/wallet/pay'), headers)
            .send({ orderId: String(order._id), amount: 300 })));
        await settle();

        expect(results.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
        expect(results.some((r) => r.headers['idempotent-replayed'])).toBe(false);
        expect(await balanceOf(A, cust)).toBe(700);
        expect((await reload(order)).paymentStatus).toBe('Paid');
        expect(await IdempotencyRecord.countDocuments({ endpoint: 'POST /api/v1/wallet/pay' })).toBe(0);
    });
});

// ═══════════════════════ settings ════════════════════════════════════

const patch = (user, section, body, t) => ctx.api.as(user, t).patch(`/settings/${section}`).send(body);
const put = (user, body, t) => ctx.api.as(user, t).put('/settings').send(body);
const tenantDoc = (t) => Settings.findOne({ restaurant: t.restaurant._id, branch: null }).lean();

describe('settings validation', () => {
    test.each([
        ['GST > 100%', { gst: { enabled: true, value: 150 }, serviceCharge: { enabled: true, value: 5 } }, 'taxes.gst.value'],
        ['negative GST', { gst: { enabled: true, value: -1 }, serviceCharge: { enabled: true, value: 5 } }, 'taxes.gst.value'],
        ['negative service charge', { gst: { enabled: true, value: 5 }, serviceCharge: { enabled: true, value: -3 } }, 'taxes.serviceCharge.value'],
        ['negative additional charge', { additionalCharges: [{ name: 'X', value: -1, type: 'Flat' }] }, 'taxes.additionalCharges.0.value'],
    ])('PATCH taxes: %s → 400 with field error', async (_l, body, field) => {
        const res = await patch(A.users.admin, 'taxes', body);
        expect(res.status).toBe(400);
        expect(Object.keys(res.body.errors || {})).toContain(field);
    });

    test('PATCH taxes: bad additional-charge type is refused by the route', async () => {
        const res = await patch(A.users.admin, 'taxes', { additionalCharges: [{ name: 'X', value: 1, type: 'Weird' }] });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Charge type must be Flat or Percentage');
    });

    test('PUT taxes: schema min/max also run on the full-document update (runValidators)', async () => {
        const res = await put(A.users.admin, { taxes: { gst: { enabled: true, value: 101 } } });
        expect(res.status).toBe(400);
        expect((await tenantDoc(A)).taxes.gst.value).toBe(5);
    });

    test('a Percentage additional charge has no upper bound (500% accepted)', async () => {
        // Characterisation (risk): GST and service charge are capped at 100%,
        // a "Percentage" additional charge is only checked for >= 0.
        const res = await patch(B.users.admin, 'taxes', {
            gst: { enabled: true, value: 5 }, serviceCharge: { enabled: true, value: 10 },
            additionalCharges: [{ name: 'Surge', value: 500, type: 'Percentage', enabled: true }],
        });
        expect(res.status).toBe(200);
        expect((await tenantDoc(B)).taxes.additionalCharges[0].value).toBe(500);
        await patch(B.users.admin, 'taxes', { gst: { enabled: true, value: 5 }, serviceCharge: { enabled: true, value: 10 }, additionalCharges: [] });
    });

    test.each([
        ['refundMode enum', { refundMode: 'cash' }, 'Refund mode must be wallet or original'],
        ['branchRefundMode enum', { branchRefundMode: 'random' }, 'Branch refund mode must be global or per_branch'],
    ])('PATCH wallet: %s → 400', async (_l, body, msg) => {
        const res = await patch(A.users.admin, 'wallet', body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(msg);
    });

    test.each([
        ['maxRedeemPercent > 100', { maxRedeemPercent: 150 }, 'wallet.maxRedeemPercent'],
        ['negative pointsPerRupee', { pointsPerRupee: -1 }, 'wallet.pointsPerRupee'],
        ['negative minBillToEarn', { minBillToEarn: -10 }, 'wallet.minBillToEarn'],
        ['negative pointsToRupee', { pointsToRupee: -0.5 }, 'wallet.pointsToRupee'],
    ])('PATCH wallet loyalty: %s → 400', async (_l, body, field) => {
        const res = await patch(A.users.admin, 'wallet', body);
        expect(res.status).toBe(400);
        expect(Object.keys(res.body.errors)).toContain(field);
    });

    test('PATCH wallet: valid loyalty config saves; refundMode original accepted', async () => {
        const res = await patch(A.users.admin, 'wallet', { enableLoyalty: true, pointsPerRupee: 2, maxRedeemPercent: 40, refundMode: 'original' });
        expect(res.status).toBe(200);
        expect((await tenantDoc(A)).wallet).toEqual(expect.objectContaining({ pointsPerRupee: 2, maxRedeemPercent: 40, refundMode: 'original' }));
    });

    test.each([
        ['gracePeriod enum', { gracePeriod: '7 min' }],
        ['deductionType enum', { deductionType: 'bogus' }],
        ['parking maxDuration > 24', { parking: { maxDuration: 48 } }],
        ['duplicate parking vehicles', { parking: { vehicles: [{ label: 'Car', pricePerHour: 10 }, { label: 'car', pricePerHour: 20 }] } }],
        ['negative parking price', { parking: { vehicles: [{ label: 'Car', pricePerHour: -5 }] } }],
    ])('PATCH reservation: %s → 400', async (_l, body) => {
        expect((await patch(A.users.admin, 'reservation', body)).status).toBe(400);
    });

    const slab = (fromKm, toKm, charge) => ({ fromKm, toKm, charge });
    test.each([
        ['overlapping slabs', [slab(0, 5, 20), slab(4, 8, 30)], /overlap/],
        ['from >= to', [slab(5, 5, 20)], /from-km must be less than to-km/],
        ['negative charge', [slab(0, 5, -1)], /cannot be negative/],
        ['negative km', [slab(-1, 5, 1)], /cannot be negative/],
        ['non-numeric', [slab('a', 5, 1)], /valid from-km/],
        ['overlap hidden by order', [slab(10, 20, 5), slab(0, 11, 5)], /overlap/],
    ])('PATCH delivery: %s → 400', async (_l, slabs, re) => {
        const res = await patch(A.users.admin, 'delivery', { enabled: true, slabs });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(re);
    });

    test.each([
        ['negative minOrderValue', { minOrderValue: -1 }, /cannot be negative/],
        ['latitude without longitude', { origin: { lat: 18.5 } }, /latitude/],
        ['latitude out of range', { origin: { lat: 95, lng: 73 } }, /latitude/],
    ])('PATCH delivery: %s → 400', async (_l, extra, re) => {
        const res = await patch(A.users.admin, 'delivery', { enabled: true, slabs: [], ...extra });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(re);
    });

    test('PATCH delivery: adjacent unsorted slabs are accepted but stored in the order sent (not sorted)', async () => {
        const res = await patch(A.users.admin, 'delivery', { enabled: true, slabs: [slab(5, 10, 40), slab(0, 5, 20)] });
        expect(res.status).toBe(200);
        expect((await tenantDoc(A)).delivery.slabs.map((s) => s.fromKm)).toEqual([5, 0]);
    });

    test('PUT delivery runs the same slab validation', async () => {
        const res = await put(A.users.admin, { delivery: { enabled: true, slabs: [slab(0, 5, 20), slab(3, 8, 30)] } });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/overlap/);
    });

    test.each([
        ['bad pincode', { addressDetails: { pincode: '12' } }, 'Pincode must be a 6-digit number'],
        ['bad GSTIN', { legal: { gstin: 'NOTAGSTIN' } }, 'GSTIN must be a valid 15-character identifier'],
        ['bad PAN', { legal: { pan: '123' } }, 'PAN must be a valid 10-character identifier'],
        ['bad FSSAI', { legal: { fssaiLicense: '12' } }, 'FSSAI license must be a 14-digit number'],
        ['bad email', { email: 'not-an-email' }, 'Invalid email format'],
        ['bad phone', { contactNumber: 'call me' }, 'Invalid contact number format'],
    ])('PATCH general: %s → 400', async (_l, body, msg) => {
        const res = await patch(A.users.admin, 'general', { cafeName: 'Integration IDS-A', ...body });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(msg);
    });

    test.each([
        ['accent colour', { accentColor: 'red' }],
        ['javascript: cover image', { coverImages: ['javascript:alert(1)'] }],
        ['7 cover images', { coverImages: Array.from({ length: 7 }, (_, i) => `https://img.test/${i}.jpg`) }],
        ['tagline > 120 chars', { tagline: 'x'.repeat(121) }],
        ['non-boolean section toggle', { sections: { about: 'yes' } }],
        ['javascript: social link', { social: { website: 'javascript:alert(1)' } }],
        ['malformed featured item id', { featuredItems: ['nope'] }],
    ])('PATCH landingPage: %s → 400', async (_l, body) => {
        expect((await patch(A.users.admin, 'landingPage', body)).status).toBe(400);
    });

    test("PATCH landingPage: another tenant's menu item cannot be featured", async () => {
        const res = await patch(A.users.admin, 'landingPage', { featuredItems: [String(B.items.paneer._id)] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_FEATURED_ITEMS');
    });

    test('PATCH landingPage: own items + valid fields save on the tenant doc', async () => {
        const res = await patch(A.users.admin, 'landingPage', { tagline: ' Fresh ', featuredItems: [String(A.items.paneer._id)], accentColor: '#FE8301' });
        expect(res.status).toBe(200);
        const lp = (await tenantDoc(A)).landingPage;
        expect(lp.tagline).toBe('Fresh');
        expect(lp.featuredItems.map(String)).toEqual([String(A.items.paneer._id)]);
    });

    test('opening hours: day names / time strings are not validated (garbage accepted)', async () => {
        // Characterisation (risk): operatingHours entries only require `day`;
        // "Funday" / "25:99" are stored and later fed to open/closed checks.
        const res = await patch(B.users.admin, 'operatingHours', [{ day: 'Funday', start: '25:99', end: 'late', isOpen: true }]);
        expect(res.status).toBe(200);
        expect((await tenantDoc(B)).operatingHours[0]).toEqual(expect.objectContaining({ day: 'Funday', start: '25:99', end: 'late' }));
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        await patch(B.users.admin, 'operatingHours', days.map((day) => ({ day, start: '09:00', end: '23:00', isOpen: true })));
    });

    test('unknown section → 400; array section with an object body → 400', async () => {
        expect((await patch(A.users.admin, 'secrets', {})).status).toBe(400);
        const res = await patch(A.users.admin, 'operatingHours', { day: 'Monday' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('operatingHours must be a list');
    });

    test('non-admin staff and customers cannot write settings', async () => {
        expect((await patch(A.users.waiter, 'taxes', { gst: { value: 1 } })).status).toBe(403);
        const cust = await createCustomer('ids-set');
        expect((await patch(cust, 'taxes', { gst: { value: 1 } }, A)).status).toBe(403);
        expect((await ctx.api.guest(A).patch('/settings/taxes').send({ gst: { value: 1 } })).status).toBe(401);
    });
});

describe('settings allowlist / smuggling', () => {
    test('PUT cannot move the doc to another tenant / branch, cannot write landingPage, $-keys stripped', async () => {
        const beforeB = await tenantDoc(B);
        const beforeA = await tenantDoc(A);
        const res = await put(A.users.admin, {
            restaurant: String(B.restaurant._id),
            branch: String(B.branch._id),
            landingPage: { tagline: 'pwned via PUT', enabled: false },
            general: { cafeName: 'Integration IDS-A', $where: 'sleep(1000)' },
            $set: { 'taxes.gst.value': 99 },
        });
        expect(res.status).toBe(200);
        const afterA = await tenantDoc(A);
        expect(String(afterA._id)).toBe(String(beforeA._id));
        expect(String(afterA.restaurant)).toBe(String(A.restaurant._id));
        expect(afterA.branch).toBeNull();
        expect(afterA.landingPage.tagline).toBe(beforeA.landingPage.tagline);
        expect(afterA.taxes.gst.value).toBe(beforeA.taxes.gst.value);
        expect(afterA.general.$where).toBeUndefined();
        const afterB = await tenantDoc(B);
        expect(afterB.general).toEqual(beforeB.general);
        expect(await Settings.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });

    test('PATCH general: restaurant smuggled inside the section body is dropped (strict schema)', async () => {
        const res = await patch(A.users.admin, 'general', { cafeName: 'Integration IDS-A', restaurant: String(B.restaurant._id) });
        expect(res.status).toBe(200);
        const doc = await tenantDoc(A);
        expect(doc.general.restaurant).toBeUndefined();
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
        expect((await Restaurant.findById(B.restaurant._id).lean()).name).toBe('Integration IDS-B');
    });

    describe('sub-branch admin', () => {
        let sub;
        let subAdmin;
        beforeAll(async () => {
            sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Sub', slug: `sub-${rid()}`, isActive: true });
            subAdmin = await createUser({ name: 'Sub Admin', email: `sub.${rid()}@staff.test`, role: 'admin', restaurant: A.restaurant._id, branch: sub._id, permissions: {} });
        });

        test.each(['taxes', 'wallet', 'delivery', 'reservation', 'notifications'])('PATCH %s → 403 INHERITED_FROM_MAIN', async (section) => {
            const res = await patch(subAdmin, section, {});
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('INHERITED_FROM_MAIN');
        });

        test('PATCH landingPage → 403 (tenant-level only)', async () => {
            const res = await patch(subAdmin, 'landingPage', { tagline: 'sub' });
            expect(res.status).toBe(403);
        });

        test('GET merges the main-branch doc\'s inherited sections and flags them', async () => {
            await Settings.updateOne(
                { restaurant: A.restaurant._id, branch: A.branch._id },
                { $set: { 'taxes.gst.value': 13, 'wallet.maxRedeemPercent': 33 } },
                { upsert: true },
            );
            const res = await ctx.api.as(subAdmin).get('/settings');
            expect(res.status).toBe(200);
            expect(String(res.body.branch)).toBe(String(sub._id));
            expect(res.body.taxes.gst.value).toBe(13);
            expect(res.body.wallet.maxRedeemPercent).toBe(33);
            expect(res.body.inheritedFromMain).toEqual(expect.objectContaining({ branch: String(A.branch._id) }));
            expect(res.body.inheritedFromMain.sections).toEqual(expect.arrayContaining(['taxes', 'wallet', 'delivery']));
        });

        test('PUT silently strips inherited sections but saves its own general on its OWN doc', async () => {
            const tenantBefore = await tenantDoc(A);
            const res = await put(subAdmin, { taxes: { gst: { enabled: true, value: 0 } }, general: { cafeName: 'Sub Cafe' } });
            expect(res.status).toBe(200);
            const subDoc = await Settings.findOne({ restaurant: A.restaurant._id, branch: sub._id }).lean();
            expect(subDoc.general.cafeName).toBe('Sub Cafe');
            expect(subDoc.taxes.gst.value).not.toBe(0);
            expect((await tenantDoc(A)).taxes).toEqual(tenantBefore.taxes);
            // A branch-pinned general edit must not rename the tenant.
            expect((await Restaurant.findById(A.restaurant._id).lean()).name).not.toBe('Sub Cafe');
        });
    });
});

describe('settings → Restaurant / main Branch sync', () => {
    test('tenant-level general edit mirrors name, contact, structured address and legal ids', async () => {
        const res = await put(B.users.admin, {
            general: {
                cafeName: 'Integration IDS-B', contactNumber: '+91 98765 43210', email: 'Owner@IDS-B.test',
                addressDetails: { line1: '1 MG Road', line2: 'Floor 2', city: 'Pune', state: 'MH', pincode: '411001', country: 'India' },
                legal: { gstin: '27abcde1234f1z5', pan: 'abcde1234f', fssaiLicense: '12345678901234', legalBusinessName: ' IDS B LLP ' },
                timezone: 'Asia/Kolkata',
            },
        });
        expect(res.status).toBe(200);
        expect(res.body.general.address).toBe('1 MG Road, Floor 2, Pune, MH, 411001, India');
        const r = await Restaurant.findById(B.restaurant._id).lean();
        expect(r).toEqual(expect.objectContaining({ name: 'Integration IDS-B', contactPhone: '+91 98765 43210', contactEmail: 'owner@ids-b.test', city: 'Pune' }));
        expect(r.address).toEqual(expect.objectContaining({ line1: '1 MG Road', pincode: '411001' }));
        expect(r.legal).toEqual(expect.objectContaining({ gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', legalBusinessName: 'IDS B LLP' }));
        const main = await Branch.findById(B.branch._id).lean();
        expect(main).toEqual(expect.objectContaining({ addressLine1: '1 MG Road', city: 'Pune', postalCode: '411001', contactEmail: 'owner@ids-b.test' }));
    });

    test('legacy single-string address still lands on the main branch', async () => {
        const res = await patch(B.users.admin, 'general', { cafeName: 'Integration IDS-B', address: ' 9 Old Street ', city: ' Nashik ' });
        expect(res.status).toBe(200);
        expect((await Branch.findById(B.branch._id).lean())).toEqual(expect.objectContaining({ addressLine1: '9 Old Street', city: 'Nashik' }));
    });
});

describe('settingsCache fallbacks', () => {
    test('branch read with no tenant-level doc inherits from the MAIN branch doc', async () => {
        const C = await seedTenant({ label: 'ids-c' });
        const sub = await Branch.create({ restaurant: C.restaurant._id, name: 'Sub', slug: `sub-${rid()}`, isActive: true });
        await Settings.deleteOne({ restaurant: C.restaurant._id, branch: null });
        await Settings.create({ restaurant: C.restaurant._id, branch: C.branch._id, taxes: { gst: { enabled: true, value: 9 } } });
        await Settings.create({ restaurant: C.restaurant._id, branch: sub._id, general: { cafeName: 'Sub C' } });
        settingsCache.invalidateCache();
        const s = await settingsCache.getSettings({ restaurant: { _id: C.restaurant._id }, branch: { _id: sub._id } });
        expect(s.general.cafeName).toBe('Sub C');
        expect(s.taxes.gst.value).toBe(9);
    });

    test('branch read with no branch doc returns the authoritative doc; staff pin beats X-Branch-Id', async () => {
        const C = await seedTenant({ label: 'ids-d' });
        settingsCache.invalidateCache();
        const sub = await Branch.create({ restaurant: C.restaurant._id, name: 'S2', slug: `s2-${rid()}`, isActive: true });
        const s = await settingsCache.getSettings({ restaurant: { _id: C.restaurant._id }, branch: { _id: sub._id } });
        expect(s.branch).toBeNull();
        // Unpinned staff ignore req.branch (tenant-level key).
        await settingsCache.getSettings({ restaurant: { _id: C.restaurant._id }, user: { role: 'admin' }, branch: { _id: sub._id } });
        expect(settingsCache._internals.cache.has(`${C.restaurant._id}:null`)).toBe(true);
        await settingsCache.getSettings({ restaurant: { _id: C.restaurant._id }, user: { role: 'waiter', branch: { _id: C.branch._id } } });
        expect(settingsCache._internals.cache.has(`${C.restaurant._id}:${C.branch._id}`)).toBe(true);
    });

    test('a load that started before an invalidation is not re-cached (generation guard)', async () => {
        settingsCache.invalidateCache();
        const p = settingsCache.getSettings(A.restaurant._id);
        settingsCache.invalidateCache(A.restaurant._id);          // write lands mid-load
        await p;
        expect(settingsCache._internals.cache.has(`${A.restaurant._id}:null`)).toBe(false);
    });
});

describe('settings read: precedence + secrets', () => {
    test('guest GET hides general.legal; tenant admin sees it; no credential-like keys anywhere', async () => {
        const upd = await patch(A.users.admin, 'general', { cafeName: 'Integration IDS-A', legal: { gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', legalBusinessName: 'IDS Pvt Ltd' } });
        expect(upd.status).toBe(200);

        const guest = await ctx.api.guest(A).get('/settings');
        expect(guest.status).toBe(200);
        expect(guest.body.general.legal).toBeUndefined();
        expect(JSON.stringify(guest.body)).not.toMatch(/27ABCDE1234F1Z5|ABCDE1234F|keySecret|webhookSecret|smtp|password|apiKey/i);

        const admin = await ctx.api.as(A.users.admin).get('/settings');
        expect(admin.body.general.legal).toEqual(expect.objectContaining({ gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F' }));
    });

    test('customer GET at a branch inherits tenant taxes over branch-doc schema defaults', async () => {
        await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'taxes.gst.value': 7 } });
        settingsCache.invalidateCache();
        // A lazily-created branch doc carries the schema default (GST 10).
        await Settings.deleteOne({ restaurant: A.restaurant._id, branch: A.branch._id });
        await Settings.create({ restaurant: A.restaurant._id, branch: A.branch._id });
        const res = await withHeaders(ctx.api.guest(A).get('/settings'), { 'X-Branch-Id': String(A.branch._id) });
        expect(res.status).toBe(200);
        expect(String(res.body.branch)).toBe(String(A.branch._id));
        expect(res.body.taxes.gst.value).toBe(7);
    });

    test('server-side settingsCache: branch read inherits INHERITED sections from the tenant doc', async () => {
        settingsCache.invalidateCache();
        const fakeReq = { restaurant: { _id: A.restaurant._id }, branch: { _id: A.branch._id } };
        const s = await settingsCache.getSettings(fakeReq);
        expect(s.taxes.gst.value).toBe((await tenantDoc(A)).taxes.gst.value);
        expect(String(s.branch)).toBe(String(A.branch._id));
    });
});

describe('settings cache invalidation', () => {
    afterEach(() => cacheBus.setTransport(null));

    test('PATCH invalidates this instance: next getSettings returns the new value', async () => {
        const before = await settingsCache.getSettings(A.restaurant._id);
        const next = before.taxes.serviceCharge.value === 11 ? 12 : 11;
        const res = await patch(A.users.admin, 'taxes', { ...before.taxes, serviceCharge: { enabled: true, value: next } });
        expect(res.status).toBe(200);
        expect((await settingsCache.getSettings(A.restaurant._id)).taxes.serviceCharge.value).toBe(next);
    });

    test('PUT also invalidates', async () => {
        await settingsCache.getSettings(A.restaurant._id);
        const res = await put(A.users.admin, { notifications: { newOrder: false } });
        expect(res.status).toBe(200);
        expect((await settingsCache.getSettings(A.restaurant._id)).notifications.newOrder).toBe(false);
    });

    test('a write publishes { tenantPrefix } on the "settings" bus channel for other instances', async () => {
        const publish = jest.fn();
        cacheBus.setTransport({ publish });
        const res = await patch(A.users.admin, 'notifications', { newOrder: true });
        expect(res.status).toBe(200);
        expect(publish).toHaveBeenCalledWith('settings', { tenantPrefix: `${A.restaurant._id}:` });
    });

    test('a bus message from another instance evicts the stale entry here', async () => {
        settingsCache.invalidateCache();
        const primed = await settingsCache.getSettings(A.restaurant._id);
        const fresh = primed.taxes.gst.value + 1;
        // Another instance wrote the DB directly and broadcast — simulate both.
        await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { 'taxes.gst.value': fresh } });
        expect((await settingsCache.getSettings(A.restaurant._id)).taxes.gst.value).toBe(primed.taxes.gst.value); // still cached
        cacheBus.deliver('settings', { tenantPrefix: `${A.restaurant._id}:` });
        expect((await settingsCache.getSettings(A.restaurant._id)).taxes.gst.value).toBe(fresh);
    });

    test("invalidating tenant A does not evict tenant B's entry", async () => {
        await settingsCache.getSettings(B.restaurant._id);
        const { cache } = settingsCache._internals;
        cacheBus.deliver('settings', { tenantPrefix: `${A.restaurant._id}:` });
        expect(cache.has(`${B.restaurant._id}:null`)).toBe(true);
        expect([...cache.keys()].some((k) => k.startsWith(`${A.restaurant._id}:`))).toBe(false);
    });
});
