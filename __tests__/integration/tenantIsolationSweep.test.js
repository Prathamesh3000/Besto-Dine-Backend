/**
 * Tenant isolation sweep, part 1 (checklist 3.4) — the money / back-office
 * surfaces that tenantIsolation.test.js does not cover: invoices, the
 * customer wallet + transactions, settings, inventory (items, recipes,
 * suppliers, purchase orders, production), coupons / promotions /
 * campaigns, analytics / telemetry / payments / tenant export, and the
 * subscription billing invoices.
 *
 * Pattern for every resource: the record is written straight into tenant
 * B through its Mongoose model, then tenant A's owner (holding B's real
 * ids) tries read-by-id, list, update and delete. Each attempt is checked
 * twice — the HTTP answer (403/404, no B data in the body) AND the B
 * document re-read from the database (unchanged). Every family ends with
 * a positive control: B's own owner gets the same record through the
 * same route, proving the route path is right.
 */
const path = require('path');
const JSZip = require('jszip');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, setWallet } = require('./helpers/seed');
const { settle, V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const model = (name) => require(path.join(BACKEND, 'models', name));
const Order = model('order');
const Invoice = model('invoice');
const Wallet = model('wallet');
const Transaction = model('transaction');
const Settings = model('settings');
const Inventory = model('inventory');
const Recipe = model('recipe');
const Supplier = model('supplier');
const PurchaseOrder = model('purchaseOrder');
const Production = model('production');
const Coupon = model('coupon');
const Promotion = model('promotion');
const Campaign = model('campaign');
const SubscriptionInvoice = model('subscriptionInvoice');
const PlanChangeRequest = model('planChangeRequest');
const SubscriptionPlan = model('subscriptionPlan');

const ctx = useIntegrationApp();
let A;
let B;
let customerB;
let visitorB;                         // a second B-only customer used for the tenant-A visit
const rec = {};                       // tenant-B records under attack

const DENIED = [403, 404];
const B_TOTAL = 98765;                // distinctive revenue figure for tenant B
const B_DISH = 'B-Exclusive-Dish';
const DAY = 24 * 3600 * 1000;

const adminA = () => ctx.api.as(A.users.admin);
const adminB = () => ctx.api.as(B.users.admin);
const bodyText = (res) => JSON.stringify(res.body || {});
const lean = (Model, id) => Model.findById(id).lean();

beforeAll(async () => {
    A = await seedTenant({ label: 'sweep-a' });
    B = await seedTenant({ label: 'sweep-b' });
    const ownB = { restaurant: B.restaurant._id, branch: B.branch._id };

    // ── Orders / invoices / money ────────────────────────────────────
    customerB = await createCustomer('sweep-b-only');
    rec.order = await Order.create({
        ...ownB,
        orderId: 'ORD-BSWEEP-001',
        type: 'dine-in',
        user: customerB._id,
        items: [{ menuItem: String(B.items.paneer._id), name: B_DISH, price: B_TOTAL, quantity: 1 }],
        total: B_TOTAL,
        status: 'served',
        paymentStatus: 'Paid',
        paymentMethod: 'cash',
    });
    rec.invoice = await Invoice.create({
        restaurant: B.restaurant._id,
        invoiceNumber: 'INV-BSWEEP-001',
        order: rec.order._id,
        customer: customerB._id,
        customerName: 'B Invoice Guest',
        subtotal: B_TOTAL,
        total: B_TOTAL,
    });
    rec.wallet = await setWallet(B, customerB, { balance: 300, loyaltyPoints: 40 });
    visitorB = await createCustomer('sweep-b-visitor');
    rec.visitorWallet = await setWallet(B, visitorB, { balance: 300, loyaltyPoints: 40 });
    rec.txn = await Transaction.create({
        ...ownB,
        user: customerB._id,
        type: 'points_earned',
        amount: 40,
        paymentMethod: 'points',
        description: 'B-secret-credit',
        transactionId: 'TXN-BSWEEP-001',
    });

    // ── Settings marker ──────────────────────────────────────────────
    await Settings.updateOne(
        { _id: B.settings._id },
        { $set: { 'taxes.additionalCharges': [{ name: 'B-Secret-Charge', value: 7, type: 'Flat', enabled: true }] } },
    );

    // ── Inventory family ─────────────────────────────────────────────
    rec.inventory = await Inventory.create({
        ...ownB,
        itemId: 'INV-B-001',
        name: 'B-Secret-Saffron',
        category: 'Spices & Seasonings',
        unit: 'g',
        currentStock: 500,
        minStock: 10,
        costPerUnit: 3,
    });
    rec.recipe = await Recipe.create({
        ...ownB,
        menuItem: B.items.paneer._id,
        ingredients: [{ inventoryItem: rec.inventory._id, quantity: 5, unit: 'g' }],
    });
    rec.supplier = await Supplier.create({ ...ownB, code: 'SUP-B-001', name: 'B-Secret-Supplier' });
    rec.po = await PurchaseOrder.create({
        ...ownB,
        poNumber: 'PO-B-001',
        supplier: rec.supplier._id,
        supplierName: 'B-Secret-Supplier',
        items: [{ inventoryItem: rec.inventory._id, name: 'B-Secret-Saffron', unit: 'g', orderedQty: 100, rate: 3 }],
        subTotal: 300,
        grandTotal: 300,
        notes: 'B-secret-po',
    });
    rec.production = await Production.create({ ...ownB, batchNumber: 'BATCH-B-001', batchQuantity: 2 });

    // ── Marketing ────────────────────────────────────────────────────
    rec.coupon = await Coupon.create({
        ...ownB,
        code: 'BSECRET50',
        title: 'B Secret Coupon',
        discountValue: 50,
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
    });
    rec.promotion = await Promotion.create({
        ...ownB,
        title: 'B-Secret-Banner',
        image: 'https://example.test/b.png',
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
        isActive: true,
    });
    rec.campaign = await Campaign.create({ ...ownB, name: 'B-Secret-Campaign', points: 25 });

    // ── Platform billing ─────────────────────────────────────────────
    rec.subInvoice = await SubscriptionInvoice.create({
        restaurant: B.restaurant._id,
        invoiceNumber: 'SUB-BSWEEP-001',
        amount: 4999,
        razorpayPaymentId: 'pay_bsweep001',
    });
    const plan = await SubscriptionPlan.create({ name: 'Sweep Plan', slug: `sweep-${Date.now()}`, price: 0 })
        .catch(() => null);
    rec.planRequest = await PlanChangeRequest.create({
        restaurant: B.restaurant._id,
        requestedPlan: plan ? plan._id : B.restaurant._id,
        requestSource: 'tenant',
        status: 'pending',
    });
    await settle();
});

describe('invoices', () => {
    test("A admin cannot open B's invoice by id or number", async () => {
        for (const id of [String(rec.invoice._id), 'INV-BSWEEP-001', 'ORD-BSWEEP-001']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(`/invoices/${id}`);
            expect(res.status).toBe(404);
            expect(bodyText(res)).not.toContain('B Invoice Guest');
        }
    });

    test("a guest on tenant A cannot open B's invoice", async () => {
        const res = await ctx.api.guest(A).get(`/invoices/${rec.invoice._id}`);
        expect(res.status).toBe(404);
        expect(bodyText(res)).not.toContain(String(B_TOTAL));
    });

    test("B's customer browsing tenant A does not see the B invoice in /my-invoices", async () => {
        const res = await ctx.api.as(customerB, A).get('/invoices/my-invoices');
        expect(res.status).toBe(200);
        expect(res.body.invoices).toHaveLength(0);
    });

    test('positive control: B admin and B customer see the invoice', async () => {
        const own = await adminB().get(`/invoices/${rec.invoice._id}`);
        expect(own.status).toBe(200);
        expect(bodyText(own)).toContain('B Invoice Guest');
        const mine = await ctx.api.as(customerB, B).get('/invoices/my-invoices');
        expect(mine.body.invoices).toHaveLength(1);
    });
});

describe('customer wallet + transactions', () => {
    const walletUnchanged = async () => {
        const w = await Wallet.findById(rec.wallet._id).lean();
        expect(w.balance).toBe(300);
        expect(w.loyaltyPoints).toBe(40);
        expect(w.status).toBe('active');
    };

    test("a B customer browsing tenant A sees an empty A wallet, not B's balance", async () => {
        const res = await ctx.api.as(visitorB, A).get('/wallet');
        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(0);
        expect(res.body.loyaltyPoints).toBe(0);
        expect(res.body.transactions).toHaveLength(0);
        const saved = await lean(Wallet, rec.visitorWallet._id);
        expect(saved.balance).toBe(300);
        expect(saved.loyaltyPoints).toBe(40);
    });

    test.each([
        ['stats', '/wallet/admin/stats'],
        ['customer search', `/wallet/admin/customers?q=${encodeURIComponent('sweep-b-only')}`],
        ['manual history', '/wallet/admin/manual-history'],
        ...['Wallet Balance Summary', 'Points Issued vs Redeemed', 'Expired Points Report', 'Refunds to Wallet Report',
            'Top Wallet Users', 'Wallet Liability Report']
            .map((r) => [`report "${r}"`, `/wallet/admin/reports?report=${encodeURIComponent(r)}&filter=This Year`]),
    ])("A admin wallet %s never shows B's wallet or transactions", async (_label, url) => {
        const res = await adminA().get(url);
        expect(res.status).toBe(200);
        const text = bodyText(res);
        expect(text).not.toContain(String(customerB._id));
        expect(text).not.toContain('TXN-BSWEEP-001');
        expect(text).not.toContain('B-secret-credit');
    });

    test.each([
        ['block', () => adminA().post('/wallet/admin/set-status').send({ targetUserId: String(customerB._id), status: 'blocked' })],
        ['deduct balance', () => adminA().post('/wallet/admin/adjust').send({ targetUserId: String(customerB._id), amount: 100, type: 'balance', action: 'deduct' })],
        ['deduct points', () => adminA().post('/wallet/admin/adjust').send({ targetUserId: String(customerB._id), amount: 10, type: 'points', action: 'deduct' })],
    ])("A admin cannot %s on B's wallet", async (_label, call) => {
        const res = await call();
        // The customer has no wallet in A: set-status → 404 "Wallet not
        // found", a deduction → 400 "Insufficient …" (nothing to deduct from).
        expect([400, 404]).toContain(res.status);
        await walletUnchanged();
    });

    test("an A admin credit lands in an A wallet, never in B's", async () => {
        const res = await adminA().post('/wallet/points/add').send({ targetUserId: String(customerB._id), points: 5 });
        expect(res.status).toBe(200);
        await walletUnchanged();
        const aWallet = await Wallet.findOne({ user: customerB._id, restaurant: A.restaurant._id }).lean();
        expect(aWallet.loyaltyPoints).toBe(5);
        expect((await lean(Transaction, rec.txn._id)).amount).toBe(40);
    });

    test('positive control: B admin stats and the B customer wallet show the B data', async () => {
        expect(bodyText(await adminB().get('/wallet/admin/stats'))).toContain(String(customerB._id));
        const own = await ctx.api.as(customerB, B).get('/wallet');
        expect(own.status).toBe(200);
        expect(own.body.balance).toBe(300);
        expect(bodyText(own)).toContain('B-secret-credit');
    });
});

describe('settings', () => {
    test("A cannot read B's settings (staff or guest)", async () => {
        for (const caller of [adminA(), ctx.api.guest(A)]) {
            // eslint-disable-next-line no-await-in-loop
            const res = await caller.get('/settings');
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('B-Secret-Charge');
        }
    });

    test("A admin pointing X-Branch-Id at B's branch is rejected", async () => {
        const res = await ctx.api.raw.get(`${V1}/settings`)
            .set('Authorization', `Bearer ${A.users.admin.token}`)
            .set('X-Branch-Id', String(B.branch._id));
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BRANCH_NOT_FOUND');
        expect(bodyText(res)).not.toContain('B-Secret-Charge');
    });

    test.each([
        ['PATCH taxes', () => adminA().patch('/settings/taxes').send({ gst: { enabled: true, value: 18 } })],
        ['PUT with restaurant=B in body', () => adminA().put('/settings').send({
            restaurant: String(B.restaurant._id), taxes: { gst: { enabled: true, value: 18 } },
        })],
    ])("A admin %s only ever writes A's settings", async (_label, call) => {
        const res = await call();
        expect(res.status).toBe(200);
        const b = await Settings.findById(B.settings._id).lean();
        expect(b.taxes.gst.value).toBe(5);
        expect(b.taxes.additionalCharges[0].name).toBe('B-Secret-Charge');
        expect(String(b.restaurant)).toBe(String(B.restaurant._id));
    });

    test('positive control: B sees its own settings marker', async () => {
        expect(bodyText(await adminB().get('/settings'))).toContain('B-Secret-Charge');
    });
});

describe('inventory items', () => {
    test("B's stock is not listed or reported for A", async () => {
        for (const url of ['/inventory', '/inventory/summary', '/inventory/alerts', '/inventory/reports/stock',
            '/inventory/reports/consumption', '/inventory/food-cost', '/inventory/actual-vs-theoretical',
            '/inventory/menu-issues']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('B-Secret-Saffron');
        }
    });

    test.each([
        ['read', (id) => adminA().get(`/inventory/${id}`)],
        ['update', (id) => adminA().put(`/inventory/${id}`).send({ name: 'pwned', currentStock: 0 })],
        ['adjust stock', (id) => adminA().patch(`/inventory/${id}/adjust`).send({ type: 'usage', quantity: 400, reason: 'x' })],
        ['delete', (id) => adminA().delete(`/inventory/${id}`)],
    ])('A admin cannot %s a B inventory item', async (_label, call) => {
        const res = await call(rec.inventory._id);
        expect(DENIED).toContain(res.status);
        expect(bodyText(res)).not.toContain('B-Secret-Saffron');
        const saved = await lean(Inventory, rec.inventory._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Saffron');
        expect(saved.currentStock).toBe(500);
    });

    test('positive control: B admin reads the item', async () => {
        const res = await adminB().get(`/inventory/${rec.inventory._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('B-Secret-Saffron');
    });
});

describe('recipes', () => {
    const recipeUnchanged = async () => {
        const saved = await lean(Recipe, rec.recipe._id);
        expect(saved).not.toBeNull();
        expect(saved.ingredients).toHaveLength(1);
        expect(saved.ingredients[0].quantity).toBe(5);
    };

    test("B's recipes are not listed for A", async () => {
        const res = await adminA().get('/inventory/recipes');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(rec.recipe._id));
    });

    test.each([
        ['read', () => adminA().get(`/inventory/recipes/${B.items.paneer._id}`)],
        ['delete', () => adminA().delete(`/inventory/recipes/${B.items.paneer._id}`)],
        ['overwrite', () => adminA().post('/inventory/recipes').send({
            menuItemId: String(B.items.paneer._id),
            ingredients: [{ inventoryItem: String(rec.inventory._id), quantity: 99, unit: 'g' }],
        })],
    ])("A admin cannot %s B's recipe", async (_label, call) => {
        const res = await call();
        expect(DENIED).toContain(res.status);
        await recipeUnchanged();
    });

    test('positive control: B admin reads the recipe', async () => {
        const res = await adminB().get(`/inventory/recipes/${B.items.paneer._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain(String(rec.recipe._id));
    });
});

describe('suppliers', () => {
    test("B's suppliers are not listed for A", async () => {
        const res = await adminA().get('/suppliers');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('B-Secret-Supplier');
    });

    test.each([
        ['read', (id) => adminA().get(`/suppliers/${id}`)],
        ['update', (id) => adminA().put(`/suppliers/${id}`).send({ name: 'pwned' })],
        ['delete', (id) => adminA().delete(`/suppliers/${id}`)],
    ])('A admin cannot %s a B supplier', async (_label, call) => {
        const res = await call(rec.supplier._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Supplier, rec.supplier._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Supplier');
        expect(saved.isActive === undefined || saved.isActive === true).toBe(true);
    });

    test('positive control: B admin reads the supplier', async () => {
        const res = await adminB().get(`/suppliers/${rec.supplier._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('B-Secret-Supplier');
    });
});

describe('purchase orders', () => {
    test("B's purchase orders are not listed or reported for A", async () => {
        for (const url of ['/purchase-orders', '/purchase-orders/summary', '/purchase-orders/reports/purchase', '/purchase-orders/reports/payments']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('PO-B-001');
            expect(bodyText(res)).not.toContain('B-Secret-Supplier');
        }
    });

    test.each([
        ['read', (id) => adminA().get(`/purchase-orders/${id}`)],
        ['update', (id) => adminA().put(`/purchase-orders/${id}`).send({ notes: 'pwned' })],
        ['receive goods', (id) => adminA().post(`/purchase-orders/${id}/receive`).send({
            items: [{ inventoryItem: String(rec.inventory._id), qty: 100 }],
        })],
        ['record payment', (id) => adminA().post(`/purchase-orders/${id}/payment`).send({ amount: 300, mode: 'cash' })],
        ['cancel', (id) => adminA().patch(`/purchase-orders/${id}/cancel`).send({})],
    ])('A admin cannot %s a B purchase order', async (_label, call) => {
        const res = await call(rec.po._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(PurchaseOrder, rec.po._id);
        expect(saved.status).toBe('ordered');
        expect(saved.notes).toBe('B-secret-po');
        expect(saved.amountPaid).toBe(0);
        expect(saved.grns || []).toHaveLength(0);
        expect((await lean(Inventory, rec.inventory._id)).currentStock).toBe(500);
    });

    test("A admin cannot raise a PO against B's supplier", async () => {
        const res = await adminA().post('/purchase-orders').send({
            supplier: String(rec.supplier._id),
            items: [{ inventoryItem: String(rec.inventory._id), orderedQty: 1, rate: 1 }],
        });
        expect([400, 404]).toContain(res.status);
        expect(await PurchaseOrder.countDocuments({ supplier: rec.supplier._id })).toBe(1);
    });

    test('positive control: B admin reads the PO', async () => {
        const res = await adminB().get(`/purchase-orders/${rec.po._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('PO-B-001');
    });
});

describe('production batches', () => {
    test("B's batches are not listed for A", async () => {
        for (const url of ['/production', '/production/summary']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('BATCH-B-001');
        }
    });

    test("A admin cannot cook a batch from B's recipe (B stock untouched)", async () => {
        const res = await adminA().post('/production').send({ recipeId: String(rec.recipe._id), batchQuantity: 10 });
        expect(DENIED).toContain(res.status);
        expect((await lean(Inventory, rec.inventory._id)).currentStock).toBe(500);
        expect(await Production.countDocuments({ restaurant: A.restaurant._id })).toBe(0);
    });

    test('positive control: B admin lists the batch', async () => {
        expect(bodyText(await adminB().get('/production'))).toContain('BATCH-B-001');
    });
});

describe('coupons', () => {
    test("B's coupons are not listed for A (admin list, stats, active list)", async () => {
        for (const res of [
            await adminA().get('/promotions/coupons'),
            await adminA().get('/promotions/coupons/performance'),
            await adminA().get('/promotions/coupons/redemptions'),
            await ctx.api.guest(A).get('/promotions/coupons/active'),
        ]) {
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('BSECRET50');
        }
    });

    test.each([
        ['update', (id) => adminA().put(`/promotions/coupons/${id}`).send({ title: 'pwned', discountValue: 99 })],
        ['delete', (id) => adminA().delete(`/promotions/coupons/${id}`)],
    ])('A admin cannot %s a B coupon', async (_label, call) => {
        const res = await call(rec.coupon._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Coupon, rec.coupon._id);
        expect(saved).not.toBeNull();
        expect(saved.title).toBe('B Secret Coupon');
        expect(saved.discountValue).toBe(50);
        expect(saved.isActive).toBe(true);
    });

    test("a customer on tenant A cannot apply B's coupon code", async () => {
        const res = await ctx.api.as(customerB, A).post('/promotions/apply-coupon').send({ code: 'BSECRET50', orderValue: 500 });
        expect(res.status).toBe(404);
        expect((await lean(Coupon, rec.coupon._id)).usageCount || 0).toBe(0);
    });

    test('positive control: B admin lists the coupon and B customer can apply it', async () => {
        expect(bodyText(await adminB().get('/promotions/coupons'))).toContain('BSECRET50');
        const apply = await ctx.api.as(customerB, B).post('/promotions/apply-coupon').send({ code: 'BSECRET50', orderValue: 500 });
        expect(apply.status).toBe(200);
    });
});

describe('promotions + campaigns', () => {
    test("B's promotion banner is not shown on tenant A", async () => {
        const res = await ctx.api.guest(A).get('/promotions');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('B-Secret-Banner');
        expect(bodyText(await ctx.api.guest(B).get('/promotions'))).toContain('B-Secret-Banner');
        expect((await lean(Promotion, rec.promotion._id)).title).toBe('B-Secret-Banner');
    });

    test("B's campaigns are not listed for A", async () => {
        for (const url of ['/campaigns', '/campaigns/stats']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain('B-Secret-Campaign');
        }
    });

    test.each([
        ['toggle', (id) => adminA().patch(`/campaigns/${id}/toggle`).send({})],
        ['update', (id) => adminA().put(`/campaigns/${id}`).send({ name: 'pwned', points: 1 })],
        ['delete', (id) => adminA().delete(`/campaigns/${id}`)],
    ])('A admin cannot %s a B campaign', async (_label, call) => {
        const before = await lean(Campaign, rec.campaign._id);
        const res = await call(rec.campaign._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Campaign, rec.campaign._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Campaign');
        expect(saved.points).toBe(25);
        expect(saved.enabled).toBe(before.enabled);
    });

    test('positive control: B admin lists the campaign', async () => {
        expect(bodyText(await adminB().get('/campaigns'))).toContain('B-Secret-Campaign');
    });

    // Regression (fixed 2026-10): getCustomerCRM is adminOnly + crm permission and only reveals customers with activity in the caller's tenant.
    test('A admin cannot read the name + email of a tenant-B user via /promotions/customer/:userId', async () => {
        const res = await adminA().get(`/promotions/customer/${B.users.waiter._id}`);
        expect(bodyText(res)).not.toContain(B.users.waiter.email);
        expect(DENIED).toContain(res.status);
    });

    test('a customer cannot read another (tenant-B) customer\'s email via /promotions/customer/:userId', async () => {
        const snoop = await createCustomer('sweep-snoop');
        const res = await ctx.api.as(snoop, A).get(`/promotions/customer/${customerB._id}`);
        expect(bodyText(res)).not.toContain(customerB.email);
        expect(DENIED).toContain(res.status);
    });
});

describe('analytics / telemetry / payments', () => {
    test("A's analytics never include B's revenue, orders or dishes", async () => {
        const summary = await adminA().get('/analytics/summary');
        expect(summary.status).toBe(200);
        expect(summary.body.summary.revenue).toBe(0);
        expect(summary.body.summary.orders).toBe(0);
        for (const url of ['/analytics/sales-history', '/analytics/peak-hours', '/analytics/top-items']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain(String(B_TOTAL));
            expect(bodyText(res)).not.toContain(B_DISH);
        }
    });

    test.each([
        ['/telemetry/stats'],
        ['/telemetry/reports'],
        ['/telemetry/forecast'],
        ['/payments/admin/all'],
    ])("A admin %s carries no B order data", async (url) => {
        const res = await adminA().get(url);
        expect(res.status).toBe(200);
        const text = bodyText(res);
        expect(text).not.toContain('ORD-BSWEEP-001');
        expect(text).not.toContain(B_DISH);
        expect(text).not.toContain(String(B_TOTAL));
    });

    test("positive control: B's analytics + payments include the B order", async () => {
        const summary = await adminB().get('/analytics/summary');
        expect(summary.body.summary.revenue).toBe(B_TOTAL);
        expect(bodyText(await adminB().get('/analytics/top-items'))).toContain(B_DISH);
        expect(bodyText(await adminB().get('/payments/admin/all'))).toContain('ORD-BSWEEP-001');
    });
});

describe('tenant data export', () => {
    const binary = (res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const exportAs = (user) => ctx.api.raw.get(`${V1}/tenant/export`)
        .set('Authorization', `Bearer ${user.token}`)
        .buffer(true).parse(binary);
    const unzipJson = async (buf) => {
        const zip = await JSZip.loadAsync(buf);
        const out = {};
        for (const name of Object.keys(zip.files).filter((n) => n.startsWith('json/') && n.endsWith('.json'))) {
            // eslint-disable-next-line no-await-in-loop
            out[name] = await zip.file(name).async('string');
        }
        return out;
    };

    test("A's export bundle contains none of B's records; B's does", async () => {
        const res = await exportAs(A.users.admin);
        expect(res.status).toBe(200);
        const all = Object.values(await unzipJson(res.body)).join('\n');
        expect(all.length).toBeGreaterThan(0);
        for (const marker of [String(B.restaurant._id), 'ORD-BSWEEP-001', 'B-Secret-Saffron', 'BSECRET50',
            'B-Secret-Campaign', 'SUB-BSWEEP-001', B.users.waiter.email]) {
            expect(all).not.toContain(marker);
        }

        const own = await exportAs(B.users.admin);
        expect(own.status).toBe(200);
        const ownAll = Object.values(await unzipJson(own.body)).join('\n');
        expect(ownAll).toContain('ORD-BSWEEP-001');
        expect(ownAll).toContain('B-Secret-Saffron');
    });
});

describe('subscription billing', () => {
    test("B's subscription invoices are not listed or downloadable for A", async () => {
        const list = await adminA().get('/tenant/billing/invoices');
        expect(list.status).toBe(200);
        expect(bodyText(list)).not.toContain('SUB-BSWEEP-001');

        const dl = await adminA().get(`/tenant/billing/invoices/${rec.subInvoice._id}/download`);
        expect(dl.status).toBe(404);
        expect((await lean(SubscriptionInvoice, rec.subInvoice._id)).amount).toBe(4999);
    });

    test("A cannot see or cancel B's downgrade request", async () => {
        const get = await adminA().get('/tenant/billing/downgrade-request');
        expect(get.status).toBe(200);
        expect(bodyText(get)).not.toContain(String(rec.planRequest._id));

        const del = await adminA().delete(`/tenant/billing/downgrade-request/${rec.planRequest._id}`);
        expect(del.status).toBe(404);
        expect((await lean(PlanChangeRequest, rec.planRequest._id)).status).toBe('pending');
    });

    test('positive control: B owner lists its own subscription invoice', async () => {
        const res = await adminB().get('/tenant/billing/invoices');
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('SUB-BSWEEP-001');
    });
});
