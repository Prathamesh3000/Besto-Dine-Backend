/**
 * services/orderPaymentService.js — payment-side order flows:
 *
 *   recordPaidOrderLedger  ← PATCH /orders/:id/status (staff mark-paid)
 *   requestCounterPayment  ← POST  /orders/:id/request-counter-payment
 *   applyCouponToOrder     ← PATCH /orders/:id/coupon
 *   customerPayment        ← PATCH /orders/:id/payment
 *     └ finalizeCustomerPaidOrder (wallet-settled orders)
 *
 * Coverage:
 *   - ledger: exact loyalty points, payment ledger row, wallet untouched,
 *     ownerless / below-minimum orders, repeat + concurrent mark-paid,
 *     wallet split
 *   - counter payment: table-aggregated amount (exact paise), notifications
 *     once, paid / cancelled / unknown / cross-tenant, caller ownership,
 *     partly-paid rounds
 *   - coupon: staff-only, % / capped % / flat / flat > subtotal, scope,
 *     minimum order, dates, inactive, cross-tenant, locked orders, total
 *     recompute, usage limit, branch-pinned coupons
 *   - customer payment: intent only (money fields ignored), validation,
 *     owner / guest scan session / staff / cross-tenant access, wallet
 *     finalize exactly once (repeat, concurrent, staff already awarded)
 *
 * Tests whose name starts with "BUG:" pin behaviour the service gets
 * wrong today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Table = require(path.join(BACKEND, 'models/table'));

const ctx = useIntegrationApp();
let A;
let B;

const rid = () => crypto.randomBytes(5).toString('hex');
const DAY = 86400000;

beforeAll(async () => {
    A = await seedTenant({ label: 'ops-a' });
    B = await seedTenant({ label: 'ops-b' });
    // Loyalty: ₹1 → 1 point from a ₹100 bill.
    await Settings.updateOne(
        { restaurant: A.restaurant._id, branch: null },
        { $set: { 'wallet.enableLoyalty': true, 'wallet.pointsPerRupee': 1, 'wallet.minBillToEarn': 100 } },
    );
});

// ── Helpers ──────────────────────────────────────────────────────────

// Updated 2026-10 (decision 6): coupon scope follows the menu CATEGORY's
// Food / Drink kind, snapshotted on each order line as `categoryKind`.
// Drink lines in these fixtures therefore carry categoryKind 'beverages'
// (what a real Cola order now records) — without it the line would be
// classified by its menu item, which here is always Paneer Tikka (food).
const item = (t, { price = 500, quantity = 1, prepStation = 'kitchen', name = 'Paneer Tikka', categoryKind } = {}) => ({
    menuItem: t.items.paneer._id, name, price, quantity, prepStation,
    ...(categoryKind ? { categoryKind } : {}),
});

async function makeOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: `OPS-${rid()}`,
        type: 'takeaway',
        items: [item(t)],
        total: 500,
        ...fields,
    });
    return doc.toObject();
}

const reload = (order) => Order.findById(order._id).lean();
const ledger = (order, type) => Transaction.find({ order: order._id, type }).lean();
const walletOf = (t, user) => Wallet.findOne({ user: user._id, restaurant: t.restaurant._id }).lean();

async function makeCoupon(t, fields = {}) {
    return (await Coupon.create({
        restaurant: t.restaurant._id,
        code: `SAVE${rid().toUpperCase()}`,
        title: 'Test coupon',
        discountType: 'fixed_amount',
        discountValue: 100,
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + 30 * DAY),
        ...fields,
    })).toObject();
}

// ── recordPaidOrderLedger (staff mark-paid) ──────────────────────────

describe('staff mark-paid ledger', () => {
    const markPaid = (t, order, body = {}) => ctx.api.as(t.users.admin)
        .patch(`/orders/${order._id}/status`)
        .send({ paymentStatus: 'Paid', paymentMethod: 'cash', ...body });

    test('awards exact loyalty points and writes one points row and one cash payment row', async () => {
        const cust = await createCustomer('led-ok');
        const order = await makeOrder(A, { user: cust._id, total: 512.4 });

        const res = await markPaid(A, order);

        expect(res.status).toBe(200);
        const points = await ledger(order, 'points_earned');
        expect(points).toHaveLength(1);
        expect(points[0]).toMatchObject({ amount: 512, balanceBefore: 0, balanceAfter: 512, paymentMethod: 'points' });
        const pay = await ledger(order, 'order_payment');
        expect(pay).toHaveLength(1);
        expect(pay[0]).toMatchObject({ amount: 512.4, paymentMethod: 'cash' });
        expect(String(pay[0].restaurant)).toBe(String(A.restaurant._id));

        const wallet = await walletOf(A, cust);
        expect(wallet.loyaltyPoints).toBe(512);
        expect(wallet.balance).toBe(0);
    });

    test('adds to an existing wallet without touching its money balance', async () => {
        const cust = await createCustomer('led-existing');
        await Wallet.create({ user: cust._id, restaurant: A.restaurant._id, balance: 250, loyaltyPoints: 40 });
        const order = await makeOrder(A, { user: cust._id, total: 300 });

        expect((await markPaid(A, order)).status).toBe(200);

        const wallet = await walletOf(A, cust);
        expect(wallet).toMatchObject({ balance: 250, loyaltyPoints: 340 });
        const [points] = await ledger(order, 'points_earned');
        expect(points).toMatchObject({ balanceBefore: 40, balanceAfter: 340 });
    });

    test('an order without a customer writes no ledger rows', async () => {
        const order = await makeOrder(A);

        expect((await markPaid(A, order)).status).toBe(200);

        expect(await Transaction.countDocuments({ order: order._id })).toBe(0);
    });

    test('a bill below the earning minimum awards no points', async () => {
        const cust = await createCustomer('led-small');
        const order = await makeOrder(A, { user: cust._id, total: 99.99 });

        expect((await markPaid(A, order)).status).toBe(200);

        expect((await walletOf(A, cust)).loyaltyPoints).toBe(0);
        const points = await ledger(order, 'points_earned');
        points.forEach((p) => expect(p.amount).toBe(0));
    });

    test('a tenant with loyalty switched off awards no points', async () => {
        const cust = await createCustomer('led-off');
        const order = await makeOrder(B, { user: cust._id, total: 800 });

        expect((await markPaid(B, order)).status).toBe(200);

        expect((await walletOf(B, cust)).loyaltyPoints).toBe(0);
    });

    test('marking an already-paid order Paid again writes nothing new', async () => {
        const cust = await createCustomer('led-twice');
        const order = await makeOrder(A, { user: cust._id });

        expect((await markPaid(A, order)).status).toBe(200);
        expect((await markPaid(A, order)).status).toBe(200);

        expect(await ledger(order, 'points_earned')).toHaveLength(1);
        expect(await ledger(order, 'order_payment')).toHaveLength(1);
        expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
    });

    // Regression (fixed 2026-10): commitStatusUpdate pins paymentStatus != 'Paid' on the paid transition, so only one tap runs the ledger.
    test('concurrent mark-paid requests write the ledger once', async () => {
        const cust = await createCustomer('led-race');
        const order = await makeOrder(A, { user: cust._id });

        const results = await Promise.all([markPaid(A, order), markPaid(A, order), markPaid(A, order)]);
        results.forEach((r) => expect(r.status).toBeLessThan(500));

        expect(await ledger(order, 'order_payment')).toHaveLength(1);
        expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
    });

    // Regression (fixed 2026-10): recordPaidOrderLedger books total − the prior wallet amountPaid as the cash collected.
    test('settling the rest of a part-wallet-paid order books only the cash collected', async () => {
        const cust = await createCustomer('led-split');
        const order = await makeOrder(A, {
            user: cust._id, total: 500, amountPaid: 200, paymentStatus: 'Partially Paid', paymentMethod: 'wallet',
        });

        expect((await markPaid(A, order, { amountPaid: 500 })).status).toBe(200);

        const [pay] = await ledger(order, 'order_payment');
        expect(pay.paymentMethod).toBe('cash');
        expect(pay.amount).toBe(300);
    });
});

// ── requestCounterPayment ────────────────────────────────────────────

describe('POST /orders/:id/request-counter-payment', () => {
    const request = (client, order) => client.post(`/orders/${order._id}/request-counter-payment`).send({});
    const counterNotes = (order) => Notification.find({ 'meta.orderId': order.orderId, title: 'Counter Payment Requested' }).lean();

    test('stamps the request, defaults the method to cash and tells admin, captain and the table waiter the table total', async () => {
        const cust = await createCustomer('cp-ok');
        const table = await createTable(A);
        const order = await makeOrder(A, {
            user: cust._id, type: 'dine-in', table: table._id, total: 100.1, waiter: A.users.waiter._id, paymentMethod: 'online',
        });
        await makeOrder(A, { type: 'dine-in', table: table._id, total: 200.2, manualDiscount: 50 });
        await makeOrder(A, { type: 'dine-in', table: table._id, total: 999, paymentStatus: 'Paid' }); // excluded
        await makeOrder(A, { type: 'dine-in', table: table._id, total: 999, status: 'cancelled' });   // excluded

        const res = await request(ctx.api.as(cust, A), order);

        expect(res.status).toBe(200);
        expect(res.body.order.orderId).toBe(order.orderId);
        const after = await reload(order);
        expect(after.counterPaymentRequestedAt).toBeTruthy();
        expect(after.paymentMethod).toBe('cash');
        expect(after.paymentStatus).toBe('Pending');

        await settle();
        const notes = await counterNotes(order);
        const byRole = Object.fromEntries(notes.map((n) => [n.recipient ? 'waiter' : n.recipientRole, n]));
        expect(byRole.admin.meta.amount).toBe(250.3);
        expect(byRole.admin.description).toContain('₹250.3');
        expect(byRole.captain.meta.amount).toBe(250.3);
        expect(String(byRole.waiter.recipient)).toBe(String(A.users.waiter._id));
    });

    test('a repeated request refreshes the timestamp without duplicating notifications', async () => {
        const cust = await createCustomer('cp-repeat');
        const order = await makeOrder(A, { user: cust._id });

        expect((await request(ctx.api.as(cust, A), order)).status).toBe(200);
        await settle();
        const first = (await reload(order)).counterPaymentRequestedAt;
        const countAfterFirst = (await counterNotes(order)).length;
        expect(countAfterFirst).toBeGreaterThan(0);

        expect((await request(ctx.api.as(cust, A), order)).status).toBe(200);
        await settle();

        expect(new Date((await reload(order)).counterPaymentRequestedAt).getTime())
            .toBeGreaterThanOrEqual(new Date(first).getTime());
        expect(await counterNotes(order)).toHaveLength(countAfterFirst);
    });

    test.each([
        ['already paid', { paymentStatus: 'Paid', amountPaid: 500 }, 'ALREADY_PAID'],
        ['cancelled', { status: 'cancelled' }, 'ORDER_CANCELLED'],
    ])('refuses an order that is %s', async (_label, fields, code) => {
        const cust = await createCustomer('cp-locked');
        const order = await makeOrder(A, { user: cust._id, ...fields });

        const res = await request(ctx.api.as(cust, A), order);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect((await reload(order)).counterPaymentRequestedAt).toBeUndefined();
    });

    test("an unknown order or another tenant's order is not found", async () => {
        const foreign = await makeOrder(B);

        const unknown = await ctx.api.as(A.users.waiter).post(`/orders/OPS-${rid()}/request-counter-payment`).send({});
        const cross = await request(ctx.api.as(A.users.waiter), foreign);

        expect(unknown.status).toBe(404);
        expect(cross.status).toBe(404);
        expect((await reload(foreign)).counterPaymentRequestedAt).toBeUndefined();
    });

    // Regression (fixed 2026-10): requestCounterPayment checks orderAccessForCaller (401 anonymous / 403 other customer).
    test.each([
        ['another customer', async () => ctx.api.as(await createCustomer('cp-stranger'), A)],
        ['a guest without a scan session', async () => ctx.api.guest(A)],
    ])("%s cannot raise a counter-payment request on someone else's order", async (_label, makeClient) => {
        const owner = await createCustomer('cp-owner');
        const order = await makeOrder(A, { user: owner._id, paymentMethod: 'online' });

        const res = await request(await makeClient(), order);

        expect([401, 403]).toContain(res.status);
        const after = await reload(order);
        expect(after.counterPaymentRequestedAt).toBeUndefined();
        expect(after.paymentMethod).toBe('online');
    });

    // Regression (fixed 2026-10): the counter-payment amount is total − manualDiscount − amountPaid per unpaid round.
    test('a round already part-paid from the wallet asks only for the remaining due', async () => {
        const cust = await createCustomer('cp-partial');
        const order = await makeOrder(A, {
            user: cust._id, total: 500, amountPaid: 200, paymentStatus: 'Partially Paid', paymentMethod: 'wallet',
        });

        expect((await request(ctx.api.as(cust, A), order)).status).toBe(200);
        await settle();

        const [admin] = (await counterNotes(order)).filter((n) => n.recipientRole === 'admin' && !n.recipient);
        expect(admin.meta.amount).toBe(300);
    });
});

// ── applyCouponToOrder ───────────────────────────────────────────────

describe('PATCH /orders/:id/coupon', () => {
    const apply = (client, order, code) => client.patch(`/orders/${order._id}/coupon`).send({ code });
    const waiter = () => ctx.api.as(A.users.captain);

    test.each([
        ['a customer', async () => ctx.api.as(await createCustomer('cpn-cust'), A), 403],
        ['a chef', async () => ctx.api.as(A.users.chef), 403],
        ['a guest', async () => ctx.api.guest(A), 401],
    ])('%s cannot apply a coupon to an order', async (_label, makeClient, status) => {
        const coupon = await makeCoupon(A);
        const order = await makeOrder(A);

        const res = await apply(await makeClient(), order, coupon.code);

        expect(res.status).toBe(status);
        expect((await reload(order)).couponDiscount).toBe(0);
    });

    test.each([
        ['10% of ₹500', { discountType: 'percentage', discountValue: 10 }, 50],
        ['12.5% of ₹500', { discountType: 'percentage', discountValue: 12.5 }, 62.5],
        ['33% of ₹500, capped at ₹100', { discountType: 'percentage', discountValue: 33, maxDiscountAmount: 100 }, 100],
        ['a ₹75 flat discount', { discountType: 'fixed_amount', discountValue: 75 }, 75],
        ['a ₹900 flat discount on a ₹500 order', { discountType: 'fixed_amount', discountValue: 900 }, 500],
    ])('applies %s as exactly ₹%s', async (_label, fields, expected) => {
        const coupon = await makeCoupon(A, fields);
        const order = await makeOrder(A);

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(expected);
        const after = await reload(order);
        expect(after.couponCode).toBe(coupon.code);
        expect(after.couponDiscount).toBe(expected);
    });

    test('percentage discounts round to the paisa', async () => {
        const coupon = await makeCoupon(A, { discountType: 'percentage', discountValue: 7 });
        const order = await makeOrder(A, { items: [item(A, { price: 333.33 })], total: 333.33 });

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(23.33);
    });

    test('accepts a lowercase code with surrounding spaces', async () => {
        const coupon = await makeCoupon(A);
        const order = await makeOrder(A);

        const res = await apply(waiter(), order, `  ${coupon.code.toLowerCase()} `);

        expect(res.status).toBe(200);
        expect((await reload(order)).couponCode).toBe(coupon.code);
    });

    test('an empty code clears the coupon', async () => {
        const order = await makeOrder(A, { couponCode: 'OLD', couponDiscount: 40 });

        const res = await apply(waiter(), order, '');

        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(0);
        expect(await reload(order)).toMatchObject({ couponCode: '', couponDiscount: 0 });
    });

    // Regression (fixed 2026-10): applyCouponToOrder moves order.total by (old coupon − new coupon).
    test('applying, swapping and clearing a coupon keeps order.total in step', async () => {
        const c100 = await makeCoupon(A, { discountValue: 100 });
        const c50 = await makeCoupon(A, { discountValue: 50 });
        const order = await makeOrder(A, { total: 500 });

        expect((await apply(waiter(), order, c100.code)).status).toBe(200);
        expect((await reload(order)).total).toBe(400);

        expect((await apply(waiter(), order, c50.code)).status).toBe(200);
        expect((await reload(order)).total).toBe(450);

        expect((await apply(waiter(), order, '')).status).toBe(200);
        expect((await reload(order)).total).toBe(500);
    });

    // Pricing decision: GST is levied on (subtotal − coupon), so a coupon
    // change on an open order re-stamps GST at the order's stamped rate.
    test('applying, swapping and clearing a coupon recomputes the stored GST and total', async () => {
        const c100 = await makeCoupon(A, { discountValue: 100 });
        const c50 = await makeCoupon(A, { discountValue: 50 });
        // ₹1000 food, 5 % GST stamped at placement → 1000 + 50 = 1050
        const order = await makeOrder(A, {
            items: [item(A, { price: 1000 })], total: 1050, gst: 50, gstPercentage: 5,
        });

        const applied = await apply(waiter(), order, c100.code);
        expect(applied.status).toBe(200);
        // 5 % of (1000 − 100) = 45 → 1000 + 45 − 100 = 945
        expect(await reload(order)).toMatchObject({ couponDiscount: 100, gst: 45, total: 945 });

        expect((await apply(waiter(), order, c50.code)).status).toBe(200);
        // 5 % of 950 = 47.50 → 1000 + 47.50 − 50 = 997.50
        expect(await reload(order)).toMatchObject({ couponDiscount: 50, gst: 47.5, total: 997.5 });

        expect((await apply(waiter(), order, '')).status).toBe(200);
        expect(await reload(order)).toMatchObject({ couponDiscount: 0, gst: 50, total: 1050 });
    });

    test('a food-only coupon is refused when the order has no food', async () => {
        const coupon = await makeCoupon(A, { scope: 'food' });
        const order = await makeOrder(A, { items: [item(A, { prepStation: 'bar', name: 'Cola', price: 120, categoryKind: 'beverages' })], total: 120 });

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/food/);
        expect((await reload(order)).couponDiscount).toBe(0);
    });

    test('a beverages coupon discounts only the drinks on a mixed order', async () => {
        const coupon = await makeCoupon(A, { scope: 'beverages', discountType: 'percentage', discountValue: 50 });
        const order = await makeOrder(A, {
            items: [item(A, { price: 400 }), item(A, { prepStation: 'bar', name: 'Cola', price: 60, quantity: 2, categoryKind: 'beverages' })],
            total: 520,
        });

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(60);
        expect(res.body.coupon.scope).toBe('beverages');
    });

    test('a coupon whose minimum order is not met is refused', async () => {
        const coupon = await makeCoupon(A, { minOrderValue: 500.01 });
        const order = await makeOrder(A);

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Minimum order value/);
    });

    test('the minimum order is met exactly at the threshold', async () => {
        const coupon = await makeCoupon(A, { minOrderValue: 500 });
        const order = await makeOrder(A);

        expect((await apply(waiter(), order, coupon.code)).status).toBe(200);
    });

    test.each([
        ['expired', { endDate: new Date(Date.now() - 1000) }, 400, /expired/],
        ['not yet active', { startDate: new Date(Date.now() + DAY) }, 400, /not yet active/],
        ['inactive', { isActive: false }, 404, /Invalid or inactive/],
    ])('a coupon that is %s is refused', async (_label, fields, status, message) => {
        const coupon = await makeCoupon(A, fields);
        const order = await makeOrder(A);

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(status);
        expect(res.body.message).toMatch(message);
        expect((await reload(order)).couponDiscount).toBe(0);
    });

    test("an unknown code or another tenant's coupon is refused", async () => {
        const foreign = await makeCoupon(B);
        const order = await makeOrder(A);

        const unknown = await apply(waiter(), order, `NOPE${rid()}`);
        const cross = await apply(waiter(), order, foreign.code);

        expect(unknown.status).toBe(404);
        expect(cross.status).toBe(404);
        expect((await reload(order)).couponDiscount).toBe(0);
    });

    test.each([
        ['paid', { paymentStatus: 'Paid', amountPaid: 500 }],
        ['cancelled', { status: 'cancelled' }],
    ])('a %s order is locked', async (_label, fields) => {
        const coupon = await makeCoupon(A);
        const order = await makeOrder(A, fields);

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ORDER_LOCKED');
    });

    test("another tenant's order is not found", async () => {
        const coupon = await makeCoupon(A);
        const foreign = await makeOrder(B);

        const res = await apply(waiter(), foreign, coupon.code);

        expect(res.status).toBe(404);
        expect((await reload(foreign)).couponDiscount).toBe(0);
    });

    // Regression (fixed 2026-10): applyCouponToOrder refuses a coupon whose usageCount has reached usageLimit.
    test('a coupon that has reached its usage limit is refused', async () => {
        const coupon = await makeCoupon(A, { usageLimit: 5, usageCount: 5 });
        const order = await makeOrder(A);

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBe(400);
        expect((await reload(order)).couponDiscount).toBe(0);
    });

    // Regression (fixed 2026-10): the coupon lookup only matches tenant-level coupons or the order's own branch.
    test("a coupon pinned to another branch is refused", async () => {
        const otherBranch = await Branch.create({ restaurant: A.restaurant._id, name: `North ${rid()}`, slug: `north-${rid()}`, isActive: true });
        const coupon = await makeCoupon(A, { branch: otherBranch._id });
        const order = await makeOrder(A); // main branch

        const res = await apply(waiter(), order, coupon.code);

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(order)).couponDiscount).toBe(0);
    });
});

// ── customerPayment ──────────────────────────────────────────────────

describe('PATCH /orders/:id/payment', () => {
    const pay = (client, order, body) => client.patch(`/orders/${order._id}/payment`).send(body);

    describe('payment intent', () => {
        test('the owner can record a method; money fields in the body are ignored', async () => {
            const cust = await createCustomer('pi-owner');
            const order = await makeOrder(A, { user: cust._id });

            const res = await pay(ctx.api.as(cust, A), order, { paymentMethod: 'UPI', amountPaid: 500, total: 1, paymentStatus: 'Pending' });

            expect(res.status).toBe(200);
            expect(await reload(order)).toMatchObject({ paymentMethod: 'upi', paymentStatus: 'Pending', amountPaid: 0, total: 500 });
        });

        test.each([
            ['an unknown status', { paymentStatus: 'Refunded' }, /Invalid payment status/],
            ['an unknown method', { paymentMethod: 'free' }, /Invalid payment method/],
            ['a non-string method', { paymentMethod: { $ne: null } }, /Invalid payment method/],
        ])('rejects %s', async (_label, body, message) => {
            const cust = await createCustomer('pi-bad');
            const order = await makeOrder(A, { user: cust._id });

            const res = await pay(ctx.api.as(cust, A), order, body);

            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(message);
        });

        test('a request with no method changes nothing', async () => {
            const cust = await createCustomer('pi-empty');
            const order = await makeOrder(A, { user: cust._id, paymentMethod: 'upi' });

            const res = await pay(ctx.api.as(cust, A), order, {});

            expect(res.status).toBe(200);
            expect((await reload(order)).paymentMethod).toBe('upi');
        });

        test('a paid order cannot take a new intent', async () => {
            const cust = await createCustomer('pi-paid');
            const order = await makeOrder(A, { user: cust._id, paymentStatus: 'Paid', paymentMethod: 'online', amountPaid: 500 });

            const res = await pay(ctx.api.as(cust, A), order, { paymentMethod: 'cash' });

            expect(res.status).toBe(400);
            expect((await reload(order)).paymentMethod).toBe('online');
        });

        test("another customer is refused with 403", async () => {
            const owner = await createCustomer('pi-o');
            const other = await createCustomer('pi-x');
            const order = await makeOrder(A, { user: owner._id });

            const res = await pay(ctx.api.as(other, A), order, { paymentMethod: 'cash' });

            expect(res.status).toBe(403);
            expect((await reload(order)).paymentMethod).toBe('Not selected');
        });

        test('a guest needs the scan session that placed the order', async () => {
            const table = await createTable(A);
            const mine = await scanTable(ctx.api, table);
            const theirs = await scanTable(ctx.api, await createTable(A));
            const order = await makeOrder(A, { type: 'dine-in', table: table._id, scanSessionId: String(mine.sessionId) });

            const none = await pay(ctx.api.guest(A), order, { paymentMethod: 'cash' });
            const wrong = await pay(ctx.api.guest(A, theirs.scanToken), order, { paymentMethod: 'cash' });
            const right = await pay(ctx.api.guest(A, mine.scanToken), order, { paymentMethod: 'cash' });

            expect(none.status).toBe(401);
            expect(none.body.code).toBe('SCAN_TOKEN_REQUIRED');
            expect(wrong.status).toBe(401);
            expect(wrong.body.code).toBe('SCAN_SESSION_MISMATCH');
            expect(right.status).toBe(200);
            expect((await reload(order)).paymentMethod).toBe('cash');
        });

        test("staff may record an intent on a customer's order", async () => {
            const cust = await createCustomer('pi-staff');
            const order = await makeOrder(A, { user: cust._id });

            const res = await pay(ctx.api.as(A.users.captain), order, { paymentMethod: 'card' });

            expect(res.status).toBe(200);
            expect((await reload(order)).paymentMethod).toBe('card');
        });

        test("another tenant's order is not found", async () => {
            const foreign = await makeOrder(B);

            const res = await pay(ctx.api.as(A.users.admin), foreign, { paymentMethod: 'cash' });

            expect(res.status).toBe(404);
        });
    });

    describe('finalize a wallet-settled order', () => {
        const finalize = (client, order) => pay(client, order, { paymentStatus: 'Paid' });
        const walletPaid = (cust, fields = {}) => makeOrder(A, {
            user: cust._id, paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 500, paidAt: new Date(), ...fields,
        });

        test('a guest must log in to finalize', async () => {
            const table = await createTable(A);
            const { scanToken, sessionId } = await scanTable(ctx.api, table);
            const order = await makeOrder(A, { scanSessionId: String(sessionId) });

            const res = await finalize(ctx.api.guest(A, scanToken), order);

            expect(res.status).toBe(401);
        });

        test('an unpaid order cannot be finalized and no points are awarded', async () => {
            const cust = await createCustomer('fz-unpaid');
            const order = await makeOrder(A, { user: cust._id });

            const res = await finalize(ctx.api.as(cust, A), order);

            expect(res.status).toBe(409);
            expect(res.body.code).toBe('PAYMENT_NOT_SETTLED');
            expect((await reload(order)).paymentStatus).toBe('Pending');
            expect(await ledger(order, 'points_earned')).toHaveLength(0);
        });

        test('an order paid online is reported as-is with no extra bookkeeping', async () => {
            const cust = await createCustomer('fz-online');
            const order = await walletPaid(cust, { paymentMethod: 'online' });

            const res = await finalize(ctx.api.as(cust, A), order);

            expect(res.status).toBe(200);
            expect(await ledger(order, 'points_earned')).toHaveLength(0);
            expect((await reload(order)).customerPaymentFinalizedAt).toBeNull();
        });

        test('awards exact points once, stamps the finalize and releases a served table', async () => {
            const cust = await createCustomer('fz-ok');
            const table = await createTable(A);
            await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });
            const order = await walletPaid(cust, { type: 'dine-in', table: table._id, status: 'served', total: 640.75, amountPaid: 640.75 });

            const res = await finalize(ctx.api.as(cust, A), order);

            expect(res.status).toBe(200);
            const [points] = await ledger(order, 'points_earned');
            expect(points).toMatchObject({ amount: 640, balanceBefore: 0, balanceAfter: 640 });
            expect((await walletOf(A, cust)).loyaltyPoints).toBe(640);
            const after = await reload(order);
            expect(after.customerPaymentFinalizedAt).toBeTruthy();
            expect(after).toMatchObject({ amountPaid: 640.75, total: 640.75, paymentStatus: 'Paid' });
            expect((await Table.findById(table._id).lean()).status).toBe('free');
        });

        test('a repeated finalize is a no-op', async () => {
            const cust = await createCustomer('fz-repeat');
            const order = await walletPaid(cust);

            expect((await finalize(ctx.api.as(cust, A), order)).status).toBe(200);
            expect((await finalize(ctx.api.as(cust, A), order)).status).toBe(200);

            expect(await ledger(order, 'points_earned')).toHaveLength(1);
            expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
        });

        test('concurrent finalizes award points exactly once', async () => {
            const cust = await createCustomer('fz-race');
            const order = await walletPaid(cust);

            const results = await Promise.all([1, 2, 3].map(() => finalize(ctx.api.as(cust, A), order)));

            results.forEach((r) => expect(r.status).toBe(200));
            expect(await ledger(order, 'points_earned')).toHaveLength(1);
            expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
        });

        test('points already awarded by staff mark-paid are not awarded again', async () => {
            const cust = await createCustomer('fz-staff');
            const order = await makeOrder(A, { user: cust._id, paymentMethod: 'wallet' });
            expect((await ctx.api.as(A.users.admin).patch(`/orders/${order._id}/status`)
                .send({ paymentStatus: 'Paid', paymentMethod: 'wallet' })).status).toBe(200);

            expect((await finalize(ctx.api.as(cust, A), order)).status).toBe(200);

            expect(await ledger(order, 'points_earned')).toHaveLength(1);
            expect((await walletOf(A, cust)).loyaltyPoints).toBe(500);
        });

        test('staff finalizing an ownerless wallet order releases the table and awards no points', async () => {
            const table = await createTable(A);
            await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });
            const order = await makeOrder(A, {
                type: 'dine-in', table: table._id, status: 'served',
                paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 500,
            });

            expect((await finalize(ctx.api.as(A.users.admin), order)).status).toBe(200);

            expect((await Table.findById(table._id).lean()).status).toBe('free');
            expect(await Transaction.countDocuments({ order: order._id })).toBe(0);
        });

        test('a wallet order below the earning minimum is finalized with no points', async () => {
            const cust = await createCustomer('fz-small');
            const order = await walletPaid(cust, { total: 80, amountPaid: 80 });

            expect((await finalize(ctx.api.as(cust, A), order)).status).toBe(200);

            expect(await ledger(order, 'points_earned')).toHaveLength(0);
            expect((await reload(order)).customerPaymentFinalizedAt).toBeTruthy();
        });
    });
});
