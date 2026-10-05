/**
 * Order invoices, invoice PDFs, public tenant payloads and the admin
 * first-paint bootstrap:
 *   - POST /invoices/generate/:orderId — money fields vs the order,
 *     payment status, numbering, idempotency, validation, roles
 *   - GET /invoices/:id (lookup shapes + who sees PII) and /my-invoices
 *   - utils/invoicePdf — unicode / long / empty input never crashes,
 *     output is a real PDF; GET /tenant/billing/invoices/:id/download
 *   - GET /public/restaurants[/:slug[/branches|/landing]] — only active
 *     tenants / branches, no internal fields
 *   - GET /public/menu-bootstrap — only live items, branch scope,
 *     public-safe settings, response shape
 *   - GET /admin/bootstrap — sections, branch pinning, role scoping
 *
 * The anonymous-redaction rule of GET /invoices/:id is covered by
 * securityRegressions.test.js (#19); cross-tenant isolation by the
 * tenantIsolation sweeps.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, createCustomer, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Invoice = require(path.join(BACKEND, 'models/invoice'));
const SubscriptionInvoice = require(path.join(BACKEND, 'models/subscriptionInvoice'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));
const Category = require(path.join(BACKEND, 'models/category'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Combo = require(path.join(BACKEND, 'models/combo'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Promotion = require(path.join(BACKEND, 'models/promotion'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const { renderInvoicePdfBuffer } = require(path.join(BACKEND, 'utils/invoicePdf'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;

const rid = () => crypto.randomBytes(5).toString('hex');
const DAY = 86400000;
const PAN = 'ABCDE1234F';
const GSTIN = '27ABCDE1234F1Z5';

beforeAll(async () => {
    A = await seedTenant({ label: 'inv' });
    await Restaurant.updateOne({ _id: A.restaurant._id }, {
        $set: {
            owner: A.users.admin._id,
            legal: { legalBusinessName: 'Secret Legal Pvt Ltd', gstin: GSTIN, fssaiLicense: '12345678901234', pan: PAN },
        },
    });
    await Settings.updateOne({ _id: A.settings._id }, {
        $set: { 'general.legal': { legalBusinessName: 'Secret Legal Pvt Ltd', gstin: GSTIN, fssaiLicense: '12345678901234', pan: PAN } },
    });
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Paid dine-in order with a known breakdown, as orderController stamps it:
 * 2 × Paneer 200 = 400; GST 5% = 20; service 10% = 40; packaging ₹20;
 * coupon −30; manual −10 → total 440. (Fixture corrected 2026-10: it
 * previously said 480, which does not add up — the old invoice code
 * ignored the breakdown, so the inconsistency went unnoticed.)
 */
const BREAKDOWN = {
    items: [{ name: 'Paneer Tikka', price: 200, quantity: 2 }],
    gst: 20, gstPercentage: 5,
    serviceCharge: 40, serviceChargePercentage: 10,
    additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 20, amount: 20 }],
    additionalChargesTotal: 20,
    couponCode: 'SAVE30', couponDiscount: 30, manualDiscount: 10,
    total: 440,
};

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `ORD-${rid()}`,
        type: 'dine-in',
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', price: 200, quantity: 1 }],
        total: 200,
        paymentStatus: 'Paid',
        paymentMethod: 'UPI',
        amountPaid: 200,
        paidAt: new Date(),
        ...fields,
    });
    return doc.toObject();
}

const generate = (t, order, user = t.users.admin) => ctx.api.as(user).post(`/invoices/generate/${order._id || order}`).send({});

/** Scan a fresh table + place a real dine-in order (guest or logged-in). */
async function placeOrder(t, { customer = null } = {}) {
    const tbl = await createTable(t, { capacity: 6 });
    const headers = customer ? { Authorization: `Bearer ${customer.token}` } : {};
    const { scanToken } = await scanTable(ctx.api, tbl, headers);
    const client = customer ? ctx.api.customerAtTable(customer, t, scanToken) : ctx.api.guest(t, scanToken);
    const res = await client.post('/orders').send({
        type: 'dine-in', tableId: String(tbl._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }],
        total: 250,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, scanToken };
}

/** supertest parser that keeps a binary body as a Buffer. */
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const isPdf = (buf) => {
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.subarray(-8).toString('latin1')).toContain('%%EOF');
};

/** Fields that must never appear in a public tenant payload. */
const FORBIDDEN_KEYS = ['legal', 'gstin', 'pan', 'owner', 'subscription', 'featureOverrides', 'password',
    'razorpayKeyId', 'razorpayKeySecret', 'razorpayCustomerId', 'contactEmail', 'signupMeta', 'qrToken'];

/** Recursively collect every object key in a JSON payload. */
function allKeys(value, out = new Set()) {
    if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
    }
    return out;
}

async function seedSuspendedTenants() {
    const mk = (status) => Restaurant.create({
        name: `Hidden ${status} ${rid()}`, slug: `hidden-${status.replace('_', '-')}-${rid()}`,
        contactEmail: `${status}.${rid()}@tenants.test`, status,
    });
    return { suspended: await mk('suspended'), cancelled: await mk('cancelled'), pastDue: await mk('past_due') };
}

// ═════════════════════════════════════════════════════════════════════
// Order invoices
// ═════════════════════════════════════════════════════════════════════

describe('POST /invoices/generate/:orderId — money fields', () => {
    test('total, line items, payment status and method are copied from the paid order', async () => {
        const cust = await createCustomer('inv-money', { mobile: '9876500001' });
        const order = await makeOrder(A, { ...BREAKDOWN, user: cust._id, amountPaid: 440 });

        const res = await generate(A, order);
        expect(res.status).toBe(201);
        const inv = res.body.invoice;
        expect(inv.total).toBe(440);
        expect(inv.items).toHaveLength(1);
        expect(inv.items[0]).toMatchObject({ name: 'Paneer Tikka', quantity: 2, price: 200, total: 400 });
        expect(inv.paymentStatus).toBe('paid');
        expect(inv.paymentMethod).toBe('UPI');
        expect(inv.customerName).toBe(cust.name);
        expect(inv.customerEmail).toBe(cust.email);
        expect(inv.customerMobile).toBe('9876500001');
        expect(String(inv.restaurant)).toBe(String(A.restaurant._id));
        expect(String(inv.order)).toBe(String(order._id));
        expect(inv.invoiceNumber).toBe(inv.invoiceNumber.trim());
        expect(inv.invoiceNumber).toMatch(new RegExp(`^INV-\\d+-${order.orderId}$`));
    });

    // Regression (fixed 2026-10): generateInvoice reads subtotal from the line items and tax from gst + serviceCharge + additionalCharges.
    test('invoice tax and subtotal reflect the order\'s GST + service + charges', async () => {
        const order = await makeOrder(A, { ...BREAKDOWN, amountPaid: 440 });
        const res = await generate(A, order);
        expect(res.status).toBe(201);
        const inv = res.body.invoice;
        expect(inv.tax).toBe(20 + 40 + 20);
        expect(inv.subtotal).toBe(400);
    });

    // Regression (fixed 2026-10): generateInvoice sets discount from couponDiscount + manualDiscount (+ points remainder).
    test('invoice discount carries the order\'s coupon + manual discount', async () => {
        const order = await makeOrder(A, { ...BREAKDOWN, amountPaid: 440 });
        const res = await generate(A, order);
        expect(res.status).toBe(201);
        const inv = res.body.invoice;
        expect(inv.discount).toBe(40);
        expect(inv.subtotal + inv.tax - inv.discount).toBe(inv.total);
    });

    test('guest order → Walk-in Customer; sizes / toppings / instructions → line description; menu image attached', async () => {
        await MenuItem.updateOne({ _id: A.items.thali._id }, { $set: { images: ['/uploads/thali.png'] } });
        const order = await makeOrder(A, {
            items: [{
                menuItem: String(A.items.thali._id), name: 'Veg Thali', price: 225, quantity: 3,
                selectedSizes: [{ id: 's1', name: 'Full' }],
                selectedToppings: [{ id: 't1', name: 'Extra Ghee', price: 0 }],
                instructions: 'less spicy',
            }],
            total: 675,
        });
        const res = await generate(A, order);
        expect(res.status).toBe(201);
        const inv = res.body.invoice;
        expect(inv.customerName).toBe('Walk-in Customer');
        expect(inv.customerEmail).toBe('');
        expect(inv.customer).toBeUndefined();
        expect(inv.items[0]).toMatchObject({
            name: 'Veg Thali', quantity: 3, price: 225, total: 675,
            description: 'Full · Extra Ghee · less spicy',
            image: '/uploads/thali.png',
            addons: [],
        });
        expect(inv.total).toBe(675);
    });

    test.each([
        ['Pending', 'unpaid'],
        ['Partially Paid', 'unpaid'],
        ['Refunded', 'unpaid'],
        ['Paid', 'paid'],
    ])('order paymentStatus %s → invoice paymentStatus %s (never claims paid for an unpaid bill)', async (orderStatus, invStatus) => {
        const order = await makeOrder(A, { paymentStatus: orderStatus, amountPaid: orderStatus === 'Paid' ? 200 : 0 });
        const res = await generate(A, order);
        expect(res.status).toBe(201);
        expect(res.body.invoice.paymentStatus).toBe(invStatus);
    });

    test('order with no payment method → invoice defaults to the order\'s placeholder, zero total is accepted', async () => {
        const order = await makeOrder(A, { items: [{ name: 'Water', price: 0, quantity: 1 }], total: 0, paymentMethod: undefined });
        const res = await generate(A, order);
        expect(res.status).toBe(201);
        expect(res.body.invoice.total).toBe(0);
        expect(res.body.invoice.paymentMethod).toBe('Not selected');
    });
});

describe('POST /invoices/generate/:orderId — itemised tax lines', () => {
    // Regression (fixed 2026-10): invoices stored only a combined `tax`, so
    // receipts fell back to hard-coded 5% / 10% lines.
    test('copies GST, service charge and each additional charge from the order', async () => {
        const order = await makeOrder(A, { ...BREAKDOWN, amountPaid: 440 });

        const res = await generate(A, order);

        expect(res.status).toBe(201);
        expect(res.body.invoice).toMatchObject({
            gst: 20, gstPercentage: 5, serviceCharge: 40, serviceChargePercentage: 10, tax: 80,
        });
        expect(res.body.invoice.additionalCharges).toEqual([{ name: 'Packaging', type: 'Flat', value: 20, amount: 20 }]);
    });
});

describe('POST /invoices/generate/:orderId — numbering, idempotency, validation', () => {
    test('concurrent generation for different orders → every invoice number is unique', async () => {
        const orders = await Promise.all(Array.from({ length: 6 }, () => makeOrder(A)));
        const results = await Promise.all(orders.map((o) => generate(A, o)));
        expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
        const numbers = results.map((r) => r.body.invoice.invoiceNumber);
        expect(new Set(numbers).size).toBe(6);
    });

    test('concurrent generation for the SAME order persists exactly one invoice', async () => {
        const order = await makeOrder(A);
        const results = await Promise.all(Array.from({ length: 5 }, () => generate(A, order)));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(await Invoice.countDocuments({ order: order._id })).toBe(1);
    });

    // Regression (fixed 2026-10): generateInvoice returns the existing invoice (200) on a re-generate, including the E11000 race.
    test('generating an invoice twice for one order is not a 500', async () => {
        const order = await makeOrder(A);
        const first = await generate(A, order);
        expect(first.status).toBe(201);
        const again = await generate(A, order);
        expect(again.status).not.toBe(500);
        expect([200, 201, 409]).toContain(again.status);
        expect(await Invoice.countDocuments({ order: order._id })).toBe(1);
    });

    test('unknown order id → 404', async () => {
        const res = await generate(A, '64b000000000000000000000');
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Order not found');
    });

    // Regression (fixed 2026-10): generateInvoice validates :orderId (400 on a malformed id).
    test('malformed order id is a client error, not a 500', async () => {
        const res = await generate(A, 'not-an-object-id');
        expect([400, 404]).toContain(res.status);
    });

    test.each(['waiter', 'chef', 'captain'])('%s cannot generate invoices (403)', async (role) => {
        const order = await makeOrder(A);
        const res = await generate(A, order, A.users[role]);
        expect(res.status).toBe(403);
        expect(await Invoice.countDocuments({ order: order._id })).toBe(0);
    });

    test('customer → 403, anonymous → rejected (400 no tenant / 401)', async () => {
        const order = await makeOrder(A);
        const cust = await createCustomer('inv-gen');
        expect((await ctx.api.as(cust, A).post(`/invoices/generate/${order._id}`).send({})).status).toBe(403);
        expect([400, 401]).toContain((await ctx.api.anon().post(`/invoices/generate/${order._id}`).send({})).status);
    });
});

describe('GET /invoices/:id lookup shapes + /my-invoices', () => {
    test('lookup by _id, by invoice number and by ORD- order id resolve the same bill; unknown → 404', async () => {
        const order = await makeOrder(A);
        const { invoice } = (await generate(A, order)).body;

        for (const key of [invoice._id, invoice.invoiceNumber, order.orderId]) {
            const res = await ctx.api.as(A.users.waiter).get(`/invoices/${encodeURIComponent(key)}`);
            expect(res.status).toBe(200);
            expect(res.body.invoice._id).toBe(invoice._id);
            expect(res.body.invoice.order.orderId).toBe(order.orderId);
            expect(res.body.redacted).toBeUndefined();
        }
        expect((await ctx.api.guest(A).get('/invoices/INV-does-not-exist')).status).toBe(404);
        expect((await ctx.api.guest(A).get('/invoices/ORD-does-not-exist')).status).toBe(404);
        expect((await ctx.api.guest(A).get('/invoices/64b000000000000000000000')).status).toBe(404);
    });

    test('a guest holding the ordering scan session sees the full bill; another session sees it redacted', async () => {
        const { order, scanToken } = await placeOrder(A);
        const gen = await generate(A, order);
        expect(gen.status).toBe(201);
        const id = gen.body.invoice._id;

        const own = await ctx.api.guest(A, scanToken).get(`/invoices/${id}`);
        expect(own.status).toBe(200);
        expect(own.body.redacted).toBeUndefined();
        expect(own.body.invoice.customerName).toBe('Walk-in Customer');

        const other = await placeOrder(A);
        const foreign = await ctx.api.guest(A, other.scanToken).get(`/invoices/${id}`);
        expect(foreign.status).toBe(200);
        expect(foreign.body.redacted).toBe(true);

        const garbage = await ctx.api.guest(A, 'not-a-jwt').get(`/invoices/${id}`);
        expect(garbage.body.redacted).toBe(true);
    });

    test('my-invoices lists only the caller\'s invoices for this tenant, newest first', async () => {
        const cust = await createCustomer('inv-mine');
        const other = await createCustomer('inv-other');
        const o1 = await makeOrder(A, { user: cust._id });
        const o2 = await makeOrder(A, { user: cust._id });
        const o3 = await makeOrder(A, { user: other._id });
        for (const o of [o1, o2, o3]) expect((await generate(A, o)).status).toBe(201);

        const res = await ctx.api.as(cust, A).get('/invoices/my-invoices');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.invoices.map((i) => i.order.orderId)).toEqual([o2.orderId, o1.orderId]);
        expect([400, 401]).toContain((await ctx.api.anon().get('/invoices/my-invoices')).status);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Invoice PDF (utils/invoicePdf — SaaS subscription invoices)
// ═════════════════════════════════════════════════════════════════════

describe('utils/invoicePdf', () => {
    const baseInvoice = () => ({
        invoiceNumber: 'INV-20260101-0001',
        planName: 'Premium',
        amount: 299900,
        currency: 'INR',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-02-01'),
        razorpayPaymentId: 'pay_123',
        razorpaySubscriptionId: 'sub_123',
        status: 'paid',
        createdAt: new Date('2026-01-01T10:00:00Z'),
        paidAt: new Date('2026-01-01T10:05:00Z'),
    });
    const baseTenant = () => ({
        name: 'Cafe One',
        contactEmail: 'owner@cafe.test',
        contactPhone: '9876543210',
        city: 'Pune',
        address: { line1: '12 FC Road', line2: 'Shivajinagar', state: 'MH', pincode: '411004', country: 'India' },
        legal: { legalBusinessName: 'Cafe One Pvt Ltd', gstin: GSTIN },
    });
    const LONG = 'Very Long Restaurant Name '.repeat(40);

    test.each([
        ['plain ASCII', {}, {}],
        ['rupee sign, Hindi and emoji in names', { planName: 'प्रीमियम ₹ 🍛' }, { name: 'शर्मा भोजनालय ₹ 🍕', legal: { legalBusinessName: 'स्वाद 😀 Pvt', gstin: GSTIN } }],
        ['very long names / address lines', { planName: LONG, invoiceNumber: `INV-${'9'.repeat(200)}` }, { name: LONG, address: { line1: LONG, line2: LONG, state: LONG, pincode: '411004', country: LONG } }],
        ['zero amount, no dates, no payment ids', { amount: 0, periodStart: null, periodEnd: null, createdAt: null, paidAt: null, razorpayPaymentId: '', razorpaySubscriptionId: '' }, {}],
        ['refunded status', { status: 'refunded' }, {}],
        ['partially refunded status, odd currency', { status: 'partially_refunded', currency: 'usd', amount: 12345 }, {}],
        ['invalid date + non-numeric amount', { createdAt: 'not-a-date', amount: 'abc', currency: '' }, {}],
    ])('%s → valid PDF buffer', async (_label, invPatch, tenantPatch) => {
        const buf = await renderInvoicePdfBuffer({ ...baseInvoice(), ...invPatch }, { ...baseTenant(), ...tenantPatch });
        isPdf(buf);
        expect(buf.length).toBeGreaterThan(1000);
    });

    test('no tenant at all (restaurant deleted) → falls back to the denormalised name, still a PDF', async () => {
        const buf = await renderInvoicePdfBuffer({ ...baseInvoice(), restaurantName: 'Gone Cafe' }, null);
        isPdf(buf);
    });

    test('tenant with no address / contact / legal → PDF', async () => {
        const buf = await renderInvoicePdfBuffer(baseInvoice(), { name: 'Bare' });
        isPdf(buf);
    });

    test('platform identity from env (phone + GSTIN rows) is rendered without error', async () => {
        const saved = { phone: process.env.PLATFORM_PHONE, gstin: process.env.PLATFORM_GSTIN, city: process.env.PLATFORM_CITY };
        process.env.PLATFORM_PHONE = '+91 80000 00000';
        process.env.PLATFORM_GSTIN = '29AAAAA0000A1Z5';
        process.env.PLATFORM_CITY = 'Bengaluru';
        try {
            isPdf(await renderInvoicePdfBuffer(baseInvoice(), baseTenant()));
        } finally {
            for (const [k, env] of [['phone', 'PLATFORM_PHONE'], ['gstin', 'PLATFORM_GSTIN'], ['city', 'PLATFORM_CITY']]) {
                if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
            }
        }
    });

    test('download endpoint streams a PDF for a tenant whose name/address are unicode', async () => {
        const t = await seedTenant({ label: 'pdf' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, {
            $set: { name: 'शर्मा ₹ Café 🍛', city: 'पुणे', address: { line1: 'गली 5 🏠', pincode: '411004' } },
        });
        const inv = await SubscriptionInvoice.create({
            restaurant: t.restaurant._id, restaurantName: 'शर्मा ₹ Café 🍛', invoiceNumber: 'INV-20260101-0001',
            planName: 'प्रीमियम', amount: 0, razorpayPaymentId: `pay_${rid()}`,
        });
        const res = await ctx.api.as(t.users.admin).get(`/tenant/billing/invoices/${inv._id}/download`)
            .buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        isPdf(res.body);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Public tenant endpoints
// ═════════════════════════════════════════════════════════════════════

describe('GET /public/restaurants (+ /:slug)', () => {
    let hidden;
    beforeAll(async () => { hidden = await seedSuspendedTenants(); });

    test('legacy list: only active / trial tenants, whitelisted fields only', async () => {
        const res = await ctx.api.anon().get('/public/restaurants');
        expect(res.status).toBe(200);
        const slugs = res.body.data.map((r) => r.slug);
        expect(slugs).toContain(A.slug);
        for (const h of Object.values(hidden)) expect(slugs).not.toContain(h.slug);
        for (const r of res.body.data) {
            expect(Object.keys(r).sort()).toEqual(['_id', 'city', 'features', 'logo', 'name', 'phone', 'slug']);
        }
        const keys = allKeys(res.body);
        for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain(PAN);
        expect(res.headers['cache-control']).toContain('public');
    });

    test('directory mode: search, landing-disabled tenants hidden, limit clamped to 30, { name, slug, city, logo } only', async () => {
        const t = await seedTenant({ label: 'dir' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { name: `Zebra Diner ${rid()}`, city: 'Nashik' } });
        const off = await seedTenant({ label: 'diroff' });
        await Restaurant.updateOne({ _id: off.restaurant._id }, { $set: { name: `Zebra Hidden ${rid()}` } });
        await Settings.updateOne({ _id: off.settings._id }, { $set: { 'landingPage.enabled': false } });

        const res = await ctx.api.anon().get('/public/restaurants?q=zebra');
        expect(res.status).toBe(200);
        expect(res.body.data.map((r) => r.slug)).toEqual([t.slug]);
        expect(Object.keys(res.body.data[0]).sort()).toEqual(['city', 'logo', 'name', 'slug']);
        expect(res.body.data[0].city).toBe('Nashik');

        expect((await ctx.api.anon().get('/public/restaurants?q=nashik')).body.data.map((r) => r.slug)).toContain(t.slug);
        // Regex metacharacters are literal, not a pattern.
        expect((await ctx.api.anon().get(`/public/restaurants?q=${encodeURIComponent('.*')}`)).body.count).toBe(0);
        // Suspended tenants never appear in the directory either.
        expect((await ctx.api.anon().get('/public/restaurants?q=hidden')).body.data
            .map((r) => r.slug)).not.toContain(hidden.suspended.slug);

        const big = await ctx.api.anon().get('/public/restaurants?limit=1000');
        expect(big.status).toBe(200);
        expect(big.body.count).toBeLessThanOrEqual(30);
        expect((await ctx.api.anon().get('/public/restaurants?limit=1')).body.count).toBe(1);
    });

    test.each([['0'], ['-5'], ['abc'], ['1001']])('directory limit=%s → 400 validation', async (limit) => {
        const res = await ctx.api.anon().get(`/public/restaurants?limit=${limit}`);
        expect(res.status).toBe(400);
    });

    test('/:slug: active tenant → whitelisted profile (case-insensitive slug); suspended / cancelled / past_due / unknown → 404', async () => {
        const res = await ctx.api.anon().get(`/public/restaurants/${A.slug.toUpperCase()}`);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(['_id', 'city', 'features', 'logo', 'name', 'phone', 'slug']);
        expect(typeof res.body.data.features).toBe('object');
        expect(res.headers['cache-control']).toContain('private');
        const keys = allKeys(res.body);
        for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);

        for (const h of [...Object.values(hidden), { slug: 'no-such-tenant-xyz' }]) {
            expect((await ctx.api.anon().get(`/public/restaurants/${h.slug}`)).status).toBe(404);
        }
    });
});

describe('GET /public/restaurants/:slug/branches', () => {
    let T;
    beforeAll(async () => {
        T = await seedTenant({ label: 'br' });
        await Branch.updateOne({ _id: T.branch._id }, { $set: { city: 'Pune', addressLine1: '1 Main St', sortOrder: 2 } });
        await Branch.create({ restaurant: T.restaurant._id, name: 'Airport', slug: 'airport', isActive: true, sortOrder: 1, contactPhone: '9000000001' });
        await Branch.create({ restaurant: T.restaurant._id, name: 'Closed', slug: 'closed', isActive: false });
    });

    test('active branches only, sorted by sortOrder, whitelisted fields', async () => {
        const res = await ctx.api.anon().get(`/public/restaurants/${T.slug}/branches`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((b) => b.slug)).toEqual(['airport', 'main']);
        for (const b of res.body.data) {
            expect(Object.keys(b).sort()).toEqual(['_id', 'addressLine1', 'addressLine2', 'city', 'contactPhone',
                'country', 'name', 'postalCode', 'slug', 'state']);
        }
        expect(res.body.data[0].contactPhone).toBe('9000000001');
    });

    // Regression (fixed 2026-10): getBranches selects the tenant name, so brand is sent.
    test('response carries the tenant brand label', async () => {
        const res = await ctx.api.anon().get(`/public/restaurants/${T.slug}/branches`);
        expect(res.status).toBe(200);
        expect(res.body.brand).toBe(T.restaurant.name);
    });

    test('suspended / unknown tenant → 200 with an empty list', async () => {
        const { suspended } = await seedSuspendedTenants();
        await Branch.create({ restaurant: suspended._id, name: 'Main', slug: 'main', isActive: true });
        for (const slug of [suspended.slug, 'no-such-tenant-xyz']) {
            const res = await ctx.api.anon().get(`/public/restaurants/${slug}/branches`);
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        }
    });
});

describe('GET /public/restaurants/:slug/landing — branch edge cases', () => {
    test('inactive branch slug, array branch param and over-long branch slug → BRANCH_NOT_FOUND', async () => {
        const t = await seedTenant({ label: 'lpb' });
        await Branch.create({ restaurant: t.restaurant._id, name: 'Shut', slug: 'shut', isActive: false });
        for (const q of ['?branch=shut', '?branch=a&branch=b', `?branch=${'x'.repeat(61)}`]) {
            const res = await ctx.api.anon().get(`/public/restaurants/${t.slug}/landing${q}`);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe('BRANCH_NOT_FOUND');
        }
        const bad = await ctx.api.anon().get('/public/restaurants/BAD_SLUG!/landing');
        expect(bad.status).toBe(404);
        expect(bad.body.code).toBe('RESTAURANT_NOT_FOUND');
    });
});

describe('GET /public/menu-bootstrap', () => {
    let T;
    let B2;
    let items;
    const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const notToday = () => SHORT_DAYS[(new Date().getDay() + 1) % 7];
    const boot = (q) => ctx.api.anon().get(`/public/menu-bootstrap${q}`);

    beforeAll(async () => {
        T = await seedTenant({ label: 'mb' });
        B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        const mk = (fields) => MenuItem.create({
            restaurant: T.restaurant._id, category: T.category._id, description: 'mb item',
            prepStation: 'kitchen', vegType: 'veg', basePrice: 100, ...fields,
        });
        const hiddenCat = await Category.create({ restaurant: T.restaurant._id, branch: null, name: `Off ${rid()}`, status: 'inactive' });
        const kioskOffCat = await Category.create({ restaurant: T.restaurant._id, branch: null, name: `NoKiosk ${rid()}`, showOnKiosk: false });
        items = {
            draft: await mk({ name: 'Draft Dish', status: 'draft' }),
            archived: await mk({ name: 'Archived Dish', status: 'archived' }),
            offDay: await mk({ name: 'Weekday Special', availableDays: [notToday()] }),
            today: await mk({ name: 'Everyday Dish', availableDays: SHORT_DAYS }),
            mainOnly: await mk({ name: 'Main Only', branch: T.branch._id }),
            secondOnly: await mk({ name: 'Second Only', branch: B2._id }),
            priced: await mk({ name: 'Branch Priced', basePrice: 300, branchPrices: [{ branch: B2._id, basePrice: 350 }] }),
            kioskOff: await mk({ name: 'Bar Snack', category: kioskOffCat._id }),
        };
        T.hiddenCat = hiddenCat;
        T.kioskOffCat = kioskOffCat;

        await Combo.create({
            restaurant: T.restaurant._id, name: 'Lunch Combo', description: 'combo', price: 399,
            categories: [{ name: 'Mains', items: [{ name: 'Paneer Tikka', price: 200 }] }],
        });
        await Combo.create({ restaurant: T.restaurant._id, name: 'Draft Combo', description: 'combo', price: 1, status: 'draft' });

        const coupon = (fields) => Coupon.create({
            restaurant: T.restaurant._id, code: `C${rid().toUpperCase()}`, title: 'c', discountType: 'fixed_amount',
            discountValue: 10, startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY), ...fields,
        });
        T.coupons = {
            live: await coupon({}),
            expired: await coupon({ endDate: new Date(Date.now() - 1000) }),
            future: await coupon({ startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 2 * DAY) }),
            inactive: await coupon({ isActive: false }),
        };
        const promo = (fields) => Promotion.create({
            restaurant: T.restaurant._id, title: `P ${rid()}`, image: '/p.png',
            startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY), ...fields,
        });
        T.promos = { live: await promo({}), inactive: await promo({ isActive: false }), expired: await promo({ endDate: new Date(Date.now() - 1000) }) };

        await Settings.updateOne({ _id: T.settings._id }, {
            $set: {
                'general.legal': { legalBusinessName: 'MB Legal Pvt Ltd', gstin: GSTIN, fssaiLicense: '1', pan: PAN },
                'general.logoUrl': '/logo-tenant.png',
            },
        });
    });

    const names = (res) => res.body.data.menu.map((m) => m.name);

    test('response shape + only active, in-window menu items / active categories / combos', async () => {
        const res = await boot(`?slug=${T.slug.toUpperCase()}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Object.keys(res.body.data).sort()).toEqual(['branch', 'categories', 'combos', 'coupons', 'menu', 'promotions', 'restaurant', 'settings']);
        expect(res.body.data.branch).toBeNull();
        expect(Object.keys(res.body.data.restaurant).sort()).toEqual(['_id', 'city', 'features', 'logo', 'name', 'phone', 'slug']);
        expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');

        const n = names(res);
        expect(n).toEqual(expect.arrayContaining(['Paneer Tikka', 'Everyday Dish', 'Main Only', 'Second Only']));
        for (const hiddenName of ['Draft Dish', 'Archived Dish', 'Weekday Special']) expect(n).not.toContain(hiddenName);
        const catNames = res.body.data.categories.map((c) => c.name);
        expect(catNames).toContain(T.category.name);
        expect(catNames).not.toContain(T.hiddenCat.name);
        expect(res.body.data.combos.map((c) => c.name)).toEqual(['Lunch Combo']);
        for (const m of res.body.data.menu) {
            expect(m.branchPrices).toBeUndefined();
            expect(m._pricingSource).toBeUndefined();
            expect(m.restaurant).toBeUndefined();
            expect(m.orderCount).toBeUndefined();
        }
    });

    test('only live coupons / promotions are returned', async () => {
        const res = await boot(`?slug=${T.slug}`);
        expect(res.body.data.coupons.map((c) => c.code)).toEqual([T.coupons.live.code]);
        expect(res.body.data.promotions.map((p) => p.title)).toEqual([T.promos.live.title]);
    });

    test('branch picked: tenant-wide + own-branch items only, branch price override applied', async () => {
        const res = await boot(`?slug=${T.slug}&branch=${B2._id}`);
        expect(res.status).toBe(200);
        expect(res.body.data.branch).toEqual({ _id: String(B2._id), name: 'Second', slug: 'second', city: '', addressLine1: '' });
        const n = names(res);
        expect(n).toContain('Second Only');
        expect(n).not.toContain('Main Only');
        const priced = res.body.data.menu.find((m) => m.name === 'Branch Priced');
        expect(priced.basePrice).toBe(350);
        expect(priced.branchPrices).toBeUndefined();

        const main = await boot(`?slug=${T.slug}&branch=${T.branch._id}`);
        expect(names(main)).toContain('Main Only');
        expect(names(main)).not.toContain('Second Only');
        expect(main.body.data.menu.find((m) => m.name === 'Branch Priced').basePrice).toBe(300);
    });

    test('inactive / foreign / malformed branch id → no branch (tenant-wide view), never another tenant\'s data', async () => {
        const closed = await Branch.create({ restaurant: T.restaurant._id, name: 'Closed', slug: `closed-${rid()}`, isActive: false });
        for (const b of [closed._id, A.branch._id, 'garbage']) {
            const res = await boot(`?slug=${T.slug}&branch=${b}`);
            expect(res.status).toBe(200);
            expect(res.body.data.branch).toBeNull();
            expect(names(res)).toContain('Second Only');
            for (const m of res.body.data.menu) expect(String(m.category._id || m.category)).not.toBe(String(A.category._id));
        }
    });

    test('kiosk mode hides categories flagged off for kiosk and the items inside them', async () => {
        const normal = await boot(`?slug=${T.slug}`);
        expect(names(normal)).toContain('Bar Snack');
        const kiosk = await boot(`?slug=${T.slug}&kiosk=true`);
        expect(names(kiosk)).not.toContain('Bar Snack');
        expect(kiosk.body.data.categories.map((c) => c.name)).not.toContain(T.kioskOffCat.name);
        expect(names(kiosk)).toContain('Paneer Tikka');
    });

    test('limit caps the menu list', async () => {
        const res = await boot(`?slug=${T.slug}&limit=2`);
        expect(res.body.data.menu).toHaveLength(2);
    });

    test('settings are trimmed to general / taxes / operatingHours / reservation (no wallet, notifications, delivery)', async () => {
        const res = await boot(`?slug=${T.slug}`);
        expect(Object.keys(res.body.data.settings).sort()).toEqual(['general', 'operatingHours', 'reservation', 'taxes']);
        expect(res.body.data.settings.taxes.gst).toMatchObject({ enabled: true, value: 5 });
        expect(res.body.data.settings.taxes.additionalCharges.map((c) => c.name)).toEqual(['Packaging']);
    });

    test('branch settings inherit tenant additional charges + logo when the branch doc has none', async () => {
        await Settings.create({ restaurant: T.restaurant._id, branch: B2._id, taxes: { gst: { enabled: true, value: 12 }, serviceCharge: { enabled: false, value: 0 }, additionalCharges: [] } });
        const res = await boot(`?slug=${T.slug}&branch=${B2._id}`);
        expect(res.body.data.settings.taxes.gst.value).toBe(12);
        expect(res.body.data.settings.taxes.additionalCharges.map((c) => c.name)).toEqual(['Packaging']);
        expect(res.body.data.settings.general.logoUrl).toBe('/logo-tenant.png');
    });

    // Regression (fixed 2026-10): publicMenuBootstrap strips general.legal from the public settings.
    test('anonymous bootstrap does not expose the tenant\'s legal block (PAN / GSTIN)', async () => {
        const res = await boot(`?slug=${T.slug}`);
        expect(res.status).toBe(200);
        expect(res.body.data.settings.general.legal).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain(PAN);
    });

    // Regression (fixed 2026-10): publicMenuBootstrap projects the real combo fields (price, categories, …).
    test('bootstrap combos carry their price and contents', async () => {
        const res = await boot(`?slug=${T.slug}`);
        const combo = res.body.data.combos.find((c) => c.name === 'Lunch Combo');
        expect(combo.price).toBe(399);
        expect(combo.categories?.[0]?.items?.[0]?.name).toBe('Paneer Tikka');
    });

    test('missing slug → 400; unknown / suspended / cancelled tenant → 404', async () => {
        expect((await boot('')).status).toBe(400);
        expect((await boot('?slug=%20%20')).status).toBe(400);
        expect((await boot('?slug=no-such-tenant-xyz')).status).toBe(404);
        const { suspended, cancelled } = await seedSuspendedTenants();
        expect((await boot(`?slug=${suspended.slug}`)).status).toBe(404);
        expect((await boot(`?slug=${cancelled.slug}`)).status).toBe(404);
    });

    test('payload contains no secrets / internal tenant fields', async () => {
        const res = await boot(`?slug=${T.slug}`);
        const keys = allKeys(res.body.data.restaurant);
        for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
        expect(JSON.stringify(res.body)).not.toMatch(/"password"|"qrToken"|"razorpayKey/);
        expect(res.body.data.settings.wallet).toBeUndefined();
        expect(res.body.data.settings.notifications).toBeUndefined();
    });
});

describe('POST /public/lead + GET /public/site-config', () => {
    const Lead = require(path.join(BACKEND, 'models/lead'));
    const lead = (body) => ctx.api.anon().post('/public/lead').send(body);
    const valid = () => ({ name: 'Asha', restaurantName: 'Asha Cafe', phone: '+91 98765-43210' });

    test('valid lead → 202; phone normalised, email lower-cased, message capped at 500', async () => {
        const res = await lead({ ...valid(), email: 'ASHA@Cafe.TEST', message: 'x'.repeat(800), source: 'pricing', meta: { plan: 'pro' } });
        expect(res.status).toBe(202);
        expect(Object.keys(res.body.data).sort()).toEqual(['leadId', 'submittedAt']);
        const doc = await Lead.findById(res.body.data.leadId).lean();
        expect(doc).toMatchObject({ phone: '9876543210', email: 'asha@cafe.test', source: 'pricing', restaurantName: 'Asha Cafe' });
        expect(doc.message).toHaveLength(500);
    });

    test.each([
        ['missing name', { name: '' }],
        ['1-char name', { name: 'A' }],
        ['missing restaurant', { restaurantName: ' ' }],
        ['landline-like phone', { phone: '0201234567' }],
        ['short phone', { phone: '98765' }],
        ['bad email', { email: 'not-an-email' }],
    ])('%s → 400', async (_label, patch) => {
        const res = await lead({ ...valid(), ...patch });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    // Regression (fixed 2026-10): submitLead rejects non-string text fields with 400.
    test.each([
        ['numeric name', { name: 12345 }],
        ['object phone', { phone: { $gt: '' } }],
        ['array restaurantName', { restaurantName: ['a', 'b'] }],
    ])('lead with %s is a 400, not a 500', async (_label, patch) => {
        const res = await lead({ ...valid(), ...patch });
        expect(res.status).toBe(400);
    });

    test('site-config: whitelisted marketing fields only, cacheable', async () => {
        const res = await ctx.api.anon().get('/public/site-config');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(['address', 'brandName', 'demoVideoUrl', 'heroHeadline',
            'heroSubtitle', 'logoUrl', 'platformShots', 'social', 'supportEmail', 'supportPhone', 'tagline', 'whatsappNumber']);
        expect(Object.keys(res.body.data.social).sort()).toEqual(['facebook', 'instagram', 'linkedin', 'twitter', 'youtube']);
        expect(res.headers['cache-control']).toContain('public');
    });
});

// ═════════════════════════════════════════════════════════════════════
// Admin bootstrap
// ═════════════════════════════════════════════════════════════════════

describe('GET /admin/bootstrap', () => {
    let T;
    let B2;
    let b2Waiter;
    let b2Table;
    let b2Area;
    const adminBoot = (user, q = '') => ctx.api.as(user).get(`/admin/bootstrap${q}`);

    beforeAll(async () => {
        T = await seedTenant({ label: 'ab' });
        B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        b2Area = await Area.create({ restaurant: T.restaurant._id, branch: B2._id, name: `B2 Hall ${rid()}` });
        b2Table = await createTable(T, { name: 'B2-T1', branch: B2._id, area: b2Area._id });
        b2Waiter = await createUser({
            name: 'b2 waiter', email: `b2w.${rid()}@staff.test`, mobile: '9811111111', role: 'waiter',
            restaurant: T.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('waiter'),
        });
    });

    test('anonymous → rejected (400 no tenant / 401), customer → 403', async () => {
        expect([400, 401]).toContain((await ctx.api.anon().get('/admin/bootstrap')).status);
        const cust = await createCustomer('ab-cust');
        expect((await ctx.api.as(cust, T).get('/admin/bootstrap')).status).toBe(403);
    });

    test('tenant owner: all five sections, no-store, QR tokens for printing, no password hashes / seat identities', async () => {
        const res = await adminBoot(T.users.admin);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body._errors).toBeUndefined();
        expect(Object.keys(res.body.data).sort()).toEqual(['areas', 'reservations', 'settings', 'staff', 'tables']);
        expect(res.headers['cache-control']).toBe('no-store');

        const tableNames = res.body.data.tables.map((t) => t.name);
        expect(tableNames).toEqual(expect.arrayContaining([T.tables.main.name, 'B2-T1']));
        const main = res.body.data.tables.find((t) => t.name === T.tables.main.name);
        expect(main.qrToken).toBe(T.tables.main.qrToken);
        expect(main.seats).toBeUndefined();
        expect(main.seatsTaken).toBe(0);

        const staffEmails = res.body.data.staff.map((s) => s.email);
        expect(staffEmails).toEqual(expect.arrayContaining([T.users.waiter.email, b2Waiter.email, T.users.admin.email]));
        for (const s of res.body.data.staff) {
            expect(s.password).toBeUndefined();
            expect(['customer', 'superadmin']).not.toContain(s.role);
        }
        expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$\d\d\$/);
        expect(res.body.data.settings.taxes.gst.value).toBe(5);
    });

    test('?sections= returns only the requested sections; unknown sections are ignored', async () => {
        const res = await adminBoot(T.users.admin, '?sections=tables, areas');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(['areas', 'tables']);

        const none = await adminBoot(T.users.admin, '?sections=bogus');
        expect(none.status).toBe(200);
        expect(none.body.data).toEqual({});
    });

    test('owner ?branch=<id> narrows tables / areas / staff to that branch; ?branch=none → tenant-level staff', async () => {
        const res = await adminBoot(T.users.admin, `?branch=${B2._id}`);
        expect(res.body.data.tables.map((t) => t.name)).toEqual(['B2-T1']);
        expect(res.body.data.areas.map((a) => a.name)).toEqual([b2Area.name]);
        expect(res.body.data.staff.map((s) => s.email)).toEqual([b2Waiter.email]);

        const none = await adminBoot(T.users.admin, '?branch=none&sections=staff');
        expect(none.body.data.staff.map((s) => s.email)).toEqual([T.users.admin.email]);
    });

    test('branch-pinned staff see only their own branch, even when asking for another', async () => {
        const res = await adminBoot(T.users.waiter, `?branch=${B2._id}&sections=tables,areas,reservations`);
        expect(res.status).toBe(200);
        const tables = res.body.data.tables.map((t) => t.name);
        expect(tables).toEqual(expect.arrayContaining([T.tables.main.name, T.tables.small.name]));
        expect(tables).not.toContain('B2-T1');
        for (const t of res.body.data.tables) expect(t.branch._id).toBe(String(T.branch._id));
        expect(res.body.data.areas.map((a) => a.name)).toEqual([T.area.name]);

        const b2 = await adminBoot(b2Waiter, '?sections=tables');
        expect(b2.body.data.tables.map((t) => t.name)).toEqual(['B2-T1']);
        expect(b2.body.data.tables[0].qrToken).toBe(b2Table.qrToken);
    });

    test('branch-pinned admin sees only own-branch staff', async () => {
        const subAdmin = await createUser({
            name: 'b2 admin', email: `b2a.${rid()}@staff.test`, role: 'admin',
            restaurant: T.restaurant._id, branch: B2._id, permissions: {},
        });
        const res = await adminBoot(subAdmin, '?sections=staff&branch=all');
        expect(res.status).toBe(200);
        const emails = res.body.data.staff.map((s) => s.email).sort();
        expect(emails).toEqual([b2Waiter.email, subAdmin.email].sort());
    });

    // Regression (fixed 2026-10): adminBootstrap only projects staff email/mobile/staffId for admin/manager callers.
    test('a chef cannot read the staff directory through the bootstrap when GET /staff is admin-only', async () => {
        expect((await ctx.api.as(T.users.chef).get('/staff')).status).toBe(403);
        const res = await adminBoot(T.users.chef, '?sections=staff');
        const leaked = res.status === 200 ? (res.body.data.staff || []) : [];
        expect(leaked.map((s) => s.email)).not.toContain(T.users.waiter.email);
    });
});
