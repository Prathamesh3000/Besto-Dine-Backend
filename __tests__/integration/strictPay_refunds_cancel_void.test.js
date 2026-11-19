/**
 * STRICT payments campaign — REFUNDS, part 2: cancellations / voids /
 * refund requests and everything that must be reversed with them.
 *
 *  - staff cancel / void  PATCH /orders/:id/status {status:'cancelled'}
 *  - customer cancel      PATCH /orders/:id/cancel
 *  - refund-request workflow (approve / reject)
 *  - reversal of side effects: incentives, tips, coupon usage, loyalty
 *    points, stock, KOT / kitchen list
 *  - cash closing (cashRefunds) and tenant audit trail
 *
 * Tests named "BUG:" pin behaviour that is wrong today and are expected to
 * FAIL until the source is fixed (expected vs actual in the comment above).
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const { settle, V1 } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Order = req_('models/order');
const Wallet = req_('models/wallet');
const Settings = req_('models/settings');
const Coupon = req_('models/coupon');
const Tip = req_('models/tip');
const Transaction = req_('models/transaction');
const RefundRequest = req_('models/refundRequest');
const IncentiveEntry = req_('models/incentiveEntry');
const TenantAudit = req_('models/tenantAudit');
const Inventory = req_('models/inventory');
const Recipe = req_('models/recipe');
const MenuItem = req_('models/menuItem');
const incentiveSvc = req_('services/incentiveService');
const { computeBill, toTaxConfig } = req_('utils/billing');

const ctx = useIntegrationApp();
let A; let W; let B; let NOCANCEL;
const rid = () => crypto.randomBytes(5).toString('hex');
const mongoId = () => new (require('mongoose').Types.ObjectId)();

beforeAll(async () => {
    A = await seedTenant({ label: 'sc-a' });
    W = await seedTenant({ label: 'sc-w' });
    B = await seedTenant({ label: 'sc-b' });
    NOCANCEL = await seedTenant({ label: 'sc-n' });
    const w = { 'wallet.pointsPerRupee': 1, 'wallet.enableLoyalty': true, 'wallet.minBillToEarn': 100 };
    await Settings.updateOne({ restaurant: A.restaurant._id, branch: null }, { $set: { ...w, 'wallet.refundMode': 'original' } });
    await Settings.updateOne({ restaurant: W.restaurant._id, branch: null }, { $set: { ...w, 'wallet.refundMode': 'wallet' } });
    await Settings.updateOne({ restaurant: NOCANCEL.restaurant._id, branch: null }, { $set: { 'notifications.earlyCancellation': false } });
});

async function mkOrder(t, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `SC-${rid()}`, type: 'takeaway',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, status: 'new', paymentStatus: 'Pending', ...fields,
    });
    return doc.toObject();
}
const paid = (t, f = {}) => mkOrder(t, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500, paidAt: new Date(), ...f });
const paidOnline = (t, f = {}) => paid(t, { paymentMethod: 'online', razorpayPaymentId: `pay_${rid()}`, ...f });
const reload = (o) => Order.findById(o._id).lean();
const walletOf = (t, u) => Wallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean();
const setStatus = (user, o, body) => ctx.api.as(user).patch(`/orders/${o._id}/status`).send(body);
const cancel = (user, o, extra = {}) => setStatus(user, o, { status: 'cancelled', ...extra });
const mkStaff = (t, role, perms = {}, f = {}) => createUser({
    name: `${role} ${rid()}`, email: `${role}.${rid()}@staff.test`, role, restaurant: t.restaurant._id, branch: t.branch._id, permissions: perms, ...f,
});
function stubGateway() {
    rzp.instance.payments.refund.mockImplementation(async (pid, p) => ({ id: `rfnd_${rid()}`, entity: 'refund', payment_id: pid, amount: p.amount, status: 'processed' }));
}
const gwCalls = () => rzp.instance.payments.refund.mock.calls;
async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms; let v;
    while (Date.now() < end) { v = await fn(); if (v) return v; await settle(50); }
    return v;
}
const auditRows = (t, o, action) => waitFor(async () => {
    const r = await TenantAudit.find({ restaurant: t.restaurant._id, action, entityId: o.orderId }).lean();
    return r.length ? r : null;
}).then((r) => r || []);
async function entry(t, o, fields = {}) {
    return IncentiveEntry.create({
        restaurant: t.restaurant._id, branch: t.branch._id, campaign: mongoId(), order: o._id, orderId: o.orderId,
        itemKey: String(mongoId()), itemName: 'Paneer Tikka', quantity: 1, rate: 20, amount: 20,
        staff: t.users.waiter._id, staffRole: 'waiter', state: 'pending', day: '2026-11-10', ...fields,
    });
}
const entryStates = async (o) => { await incentiveSvc.idle(); return (await IncentiveEntry.find({ order: o._id }).lean()).map((e) => e.state); };

// ═══ staff cancel: state machine + reason + role rules ═══════════════
describe('staff cancel / void: state machine', () => {
    test.each(['new', 'awaiting-payment'])('%s -> cancelled is allowed, no reason needed', async (st) => {
        const o = await mkOrder(A, { status: st });
        const res = await cancel(A.users.admin, o);
        expect(res.status).toBe(200);
        expect((await reload(o)).status).toBe('cancelled');
    });

    test.each(['preparing', 'served', 'new'])('cancelled order cannot go back to %s (409 INVALID_TRANSITION)', async (to) => {
        const o = await mkOrder(A, { status: 'cancelled' });
        const res = await setStatus(A.users.admin, o, { status: to });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVALID_TRANSITION');
        expect((await reload(o)).status).toBe('cancelled');
    });

    test('a second cancel is refused and does not rewrite who/when/why', async () => {
        const o = await mkOrder(A);
        expect((await cancel(A.users.admin, o, { cancellationReason: 'first reason' })).status).toBe(200);
        const first = await reload(o);
        expect((await cancel(A.users.captain, o, { cancellationReason: 'second reason' })).status).toBe(409);
        const after = await reload(o);
        expect(after.cancellationReason).toBe('first reason');
        expect(String(after.cancelledBy)).toBe(String(first.cancelledBy));
        expect(after.cancelledAt.getTime()).toBe(first.cancelledAt.getTime());
    });

    test('who / when / why are stored on an early cancel', async () => {
        const o = await mkOrder(A);
        await cancel(A.users.captain, o, { cancellationReason: 'guest left' });
        const a = await reload(o);
        expect(String(a.cancelledBy)).toBe(String(A.users.captain._id));
        expect(a.cancelledAt).toBeInstanceOf(Date);
        expect(a.cancellationReason).toBe('guest left');
    });

    test('cancel of another tenant order is 404 and leaves it untouched', async () => {
        const o = await mkOrder(B);
        expect((await cancel(A.users.admin, o)).status).toBe(404);
        expect((await reload(o)).status).toBe('new');
    });

    test('an invalid status string is refused', async () => {
        const o = await mkOrder(A);
        const res = await setStatus(A.users.admin, o, { status: 'voided' });
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).status).toBe('new');
    });
});

describe('staff cancel: reasons and privileges for prepared food', () => {
    test.each([
        ['missing', {}], ['too short', { cancellationReason: 'ab' }], ['whitespace', { cancellationReason: '     ' }],
    ])('cancelling a READY order with a %s reason is 400 CANCEL_REASON_REQUIRED and changes nothing', async (_n, extra) => {
        const o = await mkOrder(A, { status: 'ready' });
        const res = await cancel(A.users.admin, o, extra);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
        expect((await reload(o)).status).toBe('ready');
    });

    test('a waiter may cancel a READY order when giving a reason', async () => {
        const o = await mkOrder(A, { status: 'ready' });
        const res = await cancel(A.users.waiter, o, { cancellationReason: 'customer walked out' });
        expect(res.status).toBe(200);
        expect((await reload(o))).toMatchObject({ status: 'cancelled', cancellationReason: 'customer walked out' });
    });

    test.each(['waiter', 'chef'])('a %s cannot cancel a SERVED order (403 CANCEL_REQUIRES_PRIVILEGE)', async (role) => {
        const o = await mkOrder(A, { status: 'served' });
        const res = await cancel(A.users[role], o, { cancellationReason: 'valid reason' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('CANCEL_REQUIRES_PRIVILEGE');
        expect((await reload(o)).status).toBe('served');
    });

    test.each(['captain', 'manager', 'admin'])('a %s can void a SERVED order with a reason', async (role) => {
        const o = await mkOrder(A, { status: 'served' });
        const user = role === 'manager' ? await mkStaff(A, 'manager', { updateOrderStatus: true }) : (A.users[role]);
        const res = await cancel(user, o, { cancellationReason: 'billing error' });
        expect(res.status).toBe(200);
        const a = await reload(o);
        expect(a).toMatchObject({ status: 'cancelled', cancellationReason: 'billing error' });
        expect(String(a.cancelledBy)).toBe(String(user._id));
    });

    test('a captain voiding a SERVED order without a reason is refused', async () => {
        const o = await mkOrder(A, { status: 'served' });
        const res = await cancel(A.users.captain, o);
        expect(res.status).toBe(400);
        expect((await reload(o)).status).toBe('served');
    });

    test('a waiter cannot smuggle payment fields into a cancel', async () => {
        const o = await mkOrder(A, { status: 'new' });
        const res = await cancel(A.users.waiter, o, { paymentStatus: 'Paid' });
        expect(res.status).toBe(403);
        expect(await reload(o)).toMatchObject({ status: 'new', paymentStatus: 'Pending' });
    });

    test('a customer cannot use the staff status endpoint to cancel', async () => {
        const c = await createCustomer('sc');
        const o = await mkOrder(A, { user: c._id });
        const res = await ctx.api.as(c, A).patch(`/orders/${o._id}/status`).send({ status: 'cancelled' });
        expect([401, 403]).toContain(res.status);
        expect((await reload(o)).status).toBe('new');
    });

    test('an anonymous guest cannot cancel through the staff status endpoint', async () => {
        const o = await mkOrder(A);
        const res = await ctx.api.guest(A).patch(`/orders/${o._id}/status`).send({ status: 'cancelled' });
        expect(res.status).toBe(401);
        expect((await reload(o)).status).toBe('new');
    });

    test('a refused cancel (403) writes no audit row', async () => {
        const o = await mkOrder(A, { status: 'served' });
        await cancel(A.users.waiter, o, { cancellationReason: 'valid reason' });
        await settle(200);
        expect(await TenantAudit.countDocuments({ restaurant: A.restaurant._id, entityId: o.orderId })).toBe(0);
    });
});

// ═══ audit ═══════════════════════════════════════════════════════════
describe('cancel / void audit trail', () => {
    test('an unpaid cancel is audited as order.cancel with actor and reason', async () => {
        const o = await mkOrder(A);
        await cancel(A.users.captain, o, { cancellationReason: 'wrong table' });
        const rows = await auditRows(A, o, 'order.cancel');
        expect(rows).toHaveLength(1);
        expect(String(rows[0].actor.id)).toBe(String(A.users.captain._id));
        expect(rows[0].actor.role).toBe('captain');
        expect(rows[0].after).toMatchObject({ status: 'cancelled', reason: 'wrong table' });
        expect(rows[0].before).toMatchObject({ status: 'new', paymentStatus: 'Pending' });
    });

    test('a PAID cancel is audited as order.void (not order.cancel)', async () => {
        const o = await paid(A);
        await cancel(A.users.admin, o, { cancellationReason: 'dispute' });
        expect(await auditRows(A, o, 'order.void')).toHaveLength(1);
        await settle(100);
        expect(await TenantAudit.countDocuments({ restaurant: A.restaurant._id, entityId: o.orderId, action: 'order.cancel' })).toBe(0);
    });

    test('a customer cancel is audited too (actor = the customer)', async () => {
        const c = await createCustomer('sc-aud');
        const o = await mkOrder(A, { user: c._id });
        expect((await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'changed mind' })).status).toBe(200);
        const rows = await auditRows(A, o, 'order.cancel');
        expect(rows).toHaveLength(1);
        expect(String(rows[0].actor.id)).toBe(String(c._id));
    });

    test('double cancel writes one audit row', async () => {
        const o = await mkOrder(A);
        await cancel(A.users.admin, o);
        await cancel(A.users.admin, o);
        await settle(250);
        expect(await TenantAudit.countDocuments({ restaurant: A.restaurant._id, entityId: o.orderId })).toBe(1);
    });
});

// ═══ paid order cancelled: no money moves by itself ══════════════════
describe('cancelling a PAID order', () => {
    test('staff cancel never moves money: no gateway call, no wallet credit, paymentStatus stays Paid', async () => {
        stubGateway();
        const c = await createCustomer('sc-pc');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: 10 });
        const o = await paidOnline(A, { user: c._id });
        expect((await cancel(A.users.admin, o)).status).toBe(200);
        await settle(200);
        expect(gwCalls()).toHaveLength(0);
        expect((await walletOf(A, c)).balance).toBe(10);
        expect(await reload(o)).toMatchObject({ status: 'cancelled', paymentStatus: 'Paid', refundedAmount: 0 });
    });

    test('a cancelled+paid order is visible in the refunds work list; an unpaid cancelled one is not', async () => {
        const p = await paid(A);
        const u = await mkOrder(A);
        await cancel(A.users.admin, p);
        await cancel(A.users.admin, u);
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds?limit=100');
        expect(res.status).toBe(200);
        const s = JSON.stringify(res.body);
        expect(s).toContain(p.orderId);
        expect(s).not.toContain(u.orderId);
    });

    test('after refunding a cancelled order in full it stays in the list as Refunded', async () => {
        const p = await paid(A);
        await cancel(A.users.admin, p);
        expect((await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(p._id), amount: 500, reason: 'void' })).status).toBe(200);
        const res = await ctx.api.as(A.users.admin).get('/orders/refunds?status=refunded&limit=100');
        expect(JSON.stringify(res.body)).toContain(p.orderId);
    });

    // Expected: cancelling a paid order revokes its pending tip (the waiter must not
    // be settled for a voided sale). Actual: only refunds revoke tips
    // (utils/tipHelpers.revokeTipsForOrder is called from refunds only);
    // orderStatusService / orderLifecycleService cancel never calls it.
    test('Regression (fixed 2026-11): staff cancel of a paid order revokes the pending tip', async () => {
        const o = await paid(A, { tipAmount: 25 });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: o._id, amount: 25 });
        expect((await cancel(A.users.admin, o)).status).toBe(200);
        await settle(250);
        expect((await Tip.findOne({ order: o._id }).lean()).status).toBe('refunded');
    });

    test('Regression (fixed 2026-11): customer cancel of a paid order revokes the pending tip', async () => {
        const c = await createCustomer('sc-tip');
        const o = await paid(A, { user: c._id, tipAmount: 25 });
        await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: o._id, amount: 25 });
        expect((await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' })).status).toBe(200);
        await settle(250);
        expect((await Tip.findOne({ order: o._id }).lean()).status).toBe('refunded');
    });
});

// ═══ customer cancel ═════════════════════════════════════════════════
describe('customer cancel (PATCH /orders/:id/cancel)', () => {
    const custCancel = (c, t, o, body = { reason: 'changed mind' }) => ctx.api.as(c, t).patch(`/orders/${o._id}/cancel`).send(body);

    test('own unpaid new order: cancelled, no refund request, note records the reason', async () => {
        const c = await createCustomer('cc1');
        const o = await mkOrder(A, { user: c._id });
        const res = await custCancel(c, A, o);
        expect(res.status).toBe(200);
        expect(res.body.refundRequest).toBeFalsy();
        expect(await RefundRequest.countDocuments({ order: o._id })).toBe(0);
        expect((await reload(o)).note).toContain('changed mind');
    });

    test('own paid order: exactly one pending refund request for the paid balance, no money moved', async () => {
        stubGateway();
        const c = await createCustomer('cc2');
        const o = await paidOnline(A, { user: c._id, refundedAmount: 120.5 });
        const res = await custCancel(c, A, o);
        expect(res.status).toBe(200);
        expect(res.body.refundRequest).toMatchObject({ status: 'pending', amount: 379.5 });
        expect(gwCalls()).toHaveLength(0);
        expect((await reload(o)).refundedAmount).toBe(120.5);
    });

    test('a fully refunded order cancelled afterwards queues no new request', async () => {
        const c = await createCustomer('cc3');
        const o = await mkOrder(A, { user: c._id, paymentStatus: 'Refunded', paymentMethod: 'cash', amountPaid: 500, refundedAmount: 500 });
        const res = await custCancel(c, A, o);
        expect(res.status).toBe(200);
        expect(await RefundRequest.countDocuments({ order: o._id })).toBe(0);
    });

    test.each(['preparing', 'ready', 'served', 'cancelled'])('cannot cancel an order that is %s (403)', async (st) => {
        const c = await createCustomer('cc4');
        const o = await mkOrder(A, { user: c._id, status: st });
        expect((await custCancel(c, A, o)).status).toBe(403);
        expect((await reload(o)).status).toBe(st);
    });

    test("another customer cannot cancel my order", async () => {
        const mine = await createCustomer('cc5a');
        const other = await createCustomer('cc5b');
        const o = await mkOrder(A, { user: mine._id });
        expect((await custCancel(other, A, o)).status).toBe(403);
        expect((await reload(o)).status).toBe('new');
    });

    test("a guest without the order's scan session cannot cancel it", async () => {
        const o = await mkOrder(A, { scanSessionId: `sess-${rid()}` });
        const res = await ctx.api.guest(A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' });
        expect(res.status).toBe(403);
        expect((await reload(o)).status).toBe('new');
    });

    test('cancellation can be switched off by the restaurant (403) and the order stays', async () => {
        const c = await createCustomer('cc6');
        const o = await mkOrder(NOCANCEL, { user: c._id });
        const res = await ctx.api.as(c, NOCANCEL).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' });
        expect(res.status).toBe(403);
        expect((await reload(o)).status).toBe('new');
    });

    test("another tenant's order cannot be cancelled by a customer of this tenant (404/403)", async () => {
        const c = await createCustomer('cc7');
        const o = await mkOrder(B);
        const res = await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' });
        expect([403, 404]).toContain(res.status);
        expect((await reload(o)).status).toBe('new');
    });

    test('two simultaneous cancels: one wins, one refund request, order cancelled once', async () => {
        const c = await createCustomer('cc8');
        const o = await paid(A, { user: c._id });
        const rs = await Promise.all([custCancel(c, A, o), custCancel(c, A, o), custCancel(c, A, o)]);
        expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
        expect(rs.every((r) => r.status < 500)).toBe(true);
        expect(await RefundRequest.countDocuments({ order: o._id })).toBe(1);
        expect((await reload(o)).status).toBe('cancelled');
    });

    test('a cancel races a chef moving the order to preparing: never both (no cancelled food in the kitchen)', async () => {
        const c = await createCustomer('cc9');
        const o = await mkOrder(A, { user: c._id });
        const [a, b] = await Promise.all([custCancel(c, A, o), setStatus(A.users.chef, o, { status: 'preparing' })]);
        const final = (await reload(o)).status;
        expect(['cancelled', 'preparing']).toContain(final);
        expect(!(a.status === 200 && b.status === 200 && final === 'preparing')).toBe(true);
    });

    test('end to end: wallet-paid order cancelled by the customer, admin approves -> wallet credited exactly once', async () => {
        const c = await createCustomer('cc10');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: 0 });
        const o = await paid(A, { user: c._id, paymentMethod: 'wallet' });
        const res = await custCancel(c, A, o);
        const rrId = res.body.refundRequest.id;
        const ap = () => ctx.api.as(A.users.admin).post(`/refund-requests/${rrId}/approve`).send({});
        expect((await ap()).status).toBe(200);
        expect((await ap()).status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(500);
        expect(await Transaction.countDocuments({ order: o._id, type: 'refund' })).toBe(1);
        expect(await reload(o)).toMatchObject({ paymentStatus: 'Refunded', refundedAmount: 500, status: 'cancelled' });
    });
});

// ═══ reversal of coupon usage / loyalty points ═══════════════════════
describe('reversal of coupon usage and redeemed points on cancel', () => {
    const mkCoupon = (t, usageCount = 1) => Coupon.create({
        restaurant: t.restaurant._id, code: `CP${rid().toUpperCase()}`, title: 'Ten off', discountType: 'fixed_amount', discountValue: 50,
        usageLimit: 10, usageCount, startDate: new Date(Date.now() - 864e5), endDate: new Date(Date.now() + 864e5), isActive: true,
    });

    // Expected: cancelling an order that consumed a coupon gives the use back
    // (usageCount 1 -> 0). Actual: orderCreateService.js:988 increments usageCount
    // at order creation; no cancel / refund path ever decrements it, so a cancelled
    // order burns one use of a limited coupon permanently.
    test('Regression (fixed 2026-11): staff cancel returns the coupon use (usageCount decremented)', async () => {
        const cp = await mkCoupon(A);
        const o = await mkOrder(A, { couponCode: cp.code, couponDiscount: 50 });
        expect((await cancel(A.users.admin, o)).status).toBe(200);
        await settle(200);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });

    test('Regression (fixed 2026-11): customer cancel returns the coupon use', async () => {
        const cp = await mkCoupon(A);
        const c = await createCustomer('cp-c');
        const o = await mkOrder(A, { user: c._id, couponCode: cp.code, couponDiscount: 50 });
        expect((await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' })).status).toBe(200);
        await settle(200);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });

    test('Regression (fixed 2026-11): a full refund of a coupon order returns the coupon use', async () => {
        const cp = await mkCoupon(A);
        const o = await paid(A, { couponCode: cp.code, couponDiscount: 50 });
        expect((await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 500, reason: 'full' })).status).toBe(200);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(0);
    });

    // Expected: points redeemed at checkout (deducted at creation, orderCreateService.js:943)
    // are returned when the order is cancelled. Actual: nothing restores
    // wallet.loyaltyPoints on any cancel path.
    test('Regression (fixed 2026-11): staff cancel gives the redeemed loyalty points back to the wallet', async () => {
        const c = await createCustomer('pt-s');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: 0, loyaltyPoints: 0 });
        const o = await mkOrder(A, { user: c._id, pointsRedeemed: 100 });
        expect((await cancel(A.users.admin, o)).status).toBe(200);
        await settle(200);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(100);
    });

    test('Regression (fixed 2026-11): customer cancel gives the redeemed loyalty points back', async () => {
        const c = await createCustomer('pt-c');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: 0, loyaltyPoints: 0 });
        const o = await mkOrder(A, { user: c._id, pointsRedeemed: 60 });
        expect((await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' })).status).toBe(200);
        await settle(200);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(60);
    });

    test('cancelling an order that used no coupon and no points leaves coupons and wallets alone', async () => {
        const cp = await mkCoupon(A, 3);
        const c = await createCustomer('none');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: 5, loyaltyPoints: 7 });
        const o = await mkOrder(A, { user: c._id });
        await cancel(A.users.admin, o);
        await settle(150);
        expect((await Coupon.findById(cp._id).lean()).usageCount).toBe(3);
        expect(await walletOf(A, c)).toMatchObject({ balance: 5, loyaltyPoints: 7 });
    });
});

// ═══ incentive reversal ══════════════════════════════════════════════
describe('incentive reversal on void / cancel / refund', () => {
    test('staff cancel reverses pending AND confirmed entries with a reason; reversed entries are left as they were', async () => {
        const o = await mkOrder(A, { status: 'ready' });
        await entry(A, o, { state: 'pending' });
        await entry(A, o, { state: 'confirmed' });
        const old = await entry(A, o, { state: 'reversed', reversedAt: new Date(0), reverseReason: 'manual earlier' });
        expect((await cancel(A.users.admin, o, { cancellationReason: 'voided' })).status).toBe(200);
        expect((await entryStates(o)).sort()).toEqual(['reversed', 'reversed', 'reversed']);
        const rows = await IncentiveEntry.find({ order: o._id }).lean();
        expect(rows.find((r) => String(r._id) === String(old._id)).reverseReason).toBe('manual earlier');
        expect(rows.filter((r) => r.reverseReason === 'order cancelled').length).toBe(2);
    });

    test('cancelling one order never reverses another order\'s entries', async () => {
        const o1 = await mkOrder(A); const o2 = await mkOrder(A);
        await entry(A, o1); await entry(A, o2);
        await cancel(A.users.admin, o1);
        expect(await entryStates(o1)).toEqual(['reversed']);
        expect(await entryStates(o2)).toEqual(['pending']);
    });

    test('customer cancel reverses incentive entries', async () => {
        const c = await createCustomer('inc-c');
        const o = await mkOrder(A, { user: c._id });
        await entry(A, o);
        await ctx.api.as(c, A).patch(`/orders/${o._id}/cancel`).send({ reason: 'x' });
        expect(await entryStates(o)).toEqual(['reversed']);
    });

    test('a refused cancel (waiter on a SERVED order) leaves entries untouched', async () => {
        const o = await mkOrder(A, { status: 'served' });
        await entry(A, o, { state: 'confirmed' });
        await cancel(A.users.waiter, o, { cancellationReason: 'valid reason' });
        expect(await entryStates(o)).toEqual(['confirmed']);
    });

    test('a PARTIAL refund keeps the entries', async () => {
        const o = await paid(A);
        await entry(A, o, { state: 'confirmed' });
        await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 100, reason: 'part' });
        expect(await entryStates(o)).toEqual(['confirmed']);
    });

    test('a FULL refund reverses the entries', async () => {
        const o = await paid(A);
        await entry(A, o, { state: 'confirmed' });
        await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 500, reason: 'full' });
        expect(await entryStates(o)).toEqual(['reversed']);
    });

    test('two partials that together refund the order reverse the entries on the last one', async () => {
        const o = await paid(A);
        await entry(A, o, { state: 'pending' });
        await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 200, reason: 'a' });
        expect(await entryStates(o)).toEqual(['pending']);
        await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 300, reason: 'b' });
        expect(await entryStates(o)).toEqual(['reversed']);
    });

    test('approving a full refund request reverses the entries too', async () => {
        const o = await paid(A);
        await entry(A, o, { state: 'confirmed' });
        const rr = await RefundRequest.create({ restaurant: A.restaurant._id, branch: A.branch._id, order: o._id, orderIdRef: o.orderId, amount: 500, reason: 'cold', source: 'customer-request', status: 'pending' });
        expect((await ctx.api.as(A.users.admin).post(`/refund-requests/${rr._id}/approve`).send({})).status).toBe(200);
        expect(await entryStates(o)).toEqual(['reversed']);
    });

    test('reversal is terminal: reversed entries are never revived by a later call', async () => {
        const o = await mkOrder(A);
        await entry(A, o);
        await cancel(A.users.admin, o);
        const r1 = await incentiveSvc.reverseForOrder(o._id, 'again');
        expect(r1.reversed).toBe(0);
        expect(await entryStates(o)).toEqual(['reversed']);
    });
});

// ═══ KOT / kitchen ═══════════════════════════════════════════════════
describe('KOT and kitchen after a cancel', () => {
    test('a cancelled order disappears from the kitchen list and its KOT rounds report cancelled', async () => {
        const o = await mkOrder(A, { status: 'new', kots: [{ kotNo: 1, ticketNo: 1, sentAt: new Date() }] });
        const before = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(JSON.stringify(before.body)).toContain(o.orderId);
        expect((await cancel(A.users.admin, o)).status).toBe(200);
        const after = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(JSON.stringify(after.body)).not.toContain(o.orderId);
        const kots = await ctx.api.as(A.users.admin).get(`/orders/${o._id}/kots`);
        expect(kots.status).toBe(200);
        for (const k of kots.body.kots) expect(k.status).toBe('cancelled');
    });

    test('the chef cannot resurrect a cancelled order (409) and it stays out of the kitchen', async () => {
        const o = await mkOrder(A, { status: 'cancelled' });
        expect((await setStatus(A.users.chef, o, { status: 'preparing' })).status).toBe(409);
        expect(JSON.stringify((await ctx.api.as(A.users.chef).get('/orders/kitchen')).body)).not.toContain(o.orderId);
    });
});

// ═══ stock ═══════════════════════════════════════════════════════════
describe('stock on cancel', () => {
    const uniq = () => Math.random().toString(16).slice(2, 8);
    async function dishWithStock() {
        const dish = await MenuItem.create({ restaurant: A.restaurant._id, category: A.category._id, name: `Dish ${uniq()}`, description: 'x', basePrice: 100, prepStation: 'kitchen', vegType: 'veg' });
        const inv = await Inventory.create({ restaurant: A.restaurant._id, branch: null, itemId: `INV-S${uniq()}`, name: `Ing ${uniq()}`, category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 0, costPerUnit: 10 });
        await Recipe.create({ restaurant: A.restaurant._id, branch: null, menuItem: dish._id, ingredients: [{ inventoryItem: inv._id, quantity: 1, unit: 'kg' }], yield: 1 });
        const subtotal = 100;
        const total = computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway' }).total;
        const res = await ctx.api.guest(A).post('/orders').send({ type: 'takeaway', pickupLocation: 'Counter', items: [{ menuItem: String(dish._id), quantity: 1 }], total });
        expect(res.status).toBe(201);
        return { inv, order: res.body.order };
    }
    const stock = async (inv) => (await Inventory.findById(inv._id).lean()).currentStock;

    test('cancel after preparing puts the stock back exactly once even with two racing cancels', async () => {
        const { inv, order } = await dishWithStock();
        expect((await setStatus(A.users.chef, order, { status: 'preparing' })).status).toBe(200);
        expect(await waitFor(async () => (await stock(inv)) === 9)).toBe(true);
        await settle(150);
        const rs = await Promise.all([cancel(A.users.admin, order), cancel(A.users.captain, order)]);
        expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
        expect(await waitFor(async () => (await stock(inv)) === 10)).toBe(true);
        await settle(300);
        expect(await stock(inv)).toBe(10);
    });

    // Expected: cancelling a SERVED order writes the food off (the code itself says
    // "Cancelling from ready/served writes off food that was actually made",
    // orderStatusService.js:62); the stock that was consumed must NOT come back.
    // Actual: restoreInventoryForOrder runs for any cancel of a deducted order
    // (orderStatusService.js:501), so voiding a served order inflates inventory
    // by food that was cooked and eaten.
    test('Regression (fixed 2026-11): voiding a SERVED order does not restore the stock that was consumed', async () => {
        const { inv, order } = await dishWithStock();
        expect((await setStatus(A.users.chef, order, { status: 'preparing' })).status).toBe(200);
        expect(await waitFor(async () => (await stock(inv)) === 9)).toBe(true);
        await settle(150);
        expect((await setStatus(A.users.admin, order, { status: 'served' })).status).toBe(200);
        expect((await cancel(A.users.admin, order, { cancellationReason: 'billing dispute' })).status).toBe(200);
        await settle(600);
        expect(await stock(inv)).toBe(9);
    });
});

// ═══ refund-request workflow ═════════════════════════════════════════
describe('refund requests: roles, reasons, side effects', () => {
    const mkRR = (t, o, f = {}) => RefundRequest.create({
        restaurant: t.restaurant._id, branch: o.branch, order: o._id, orderIdRef: o.orderId, user: o.user || null,
        amount: o.amountPaid - (o.refundedAmount || 0), reason: 'cold food', source: 'customer-request', status: 'pending', ...f,
    });
    const approve = (u, rr, body = {}) => ctx.api.as(u).post(`/refund-requests/${rr._id}/approve`).send(body);
    const reject = (u, rr, body = {}) => ctx.api.as(u).post(`/refund-requests/${rr._id}/reject`).send(body);

    test.each(['waiter', 'captain', 'chef'])('a %s cannot approve or reject (403) and the request stays pending', async (role) => {
        const o = await paid(A);
        const rr = await mkRR(A, o);
        expect((await approve(A.users[role], rr)).status).toBe(403);
        expect((await reject(A.users[role], rr)).status).toBe(403);
        expect((await RefundRequest.findById(rr._id).lean()).status).toBe('pending');
        expect((await reload(o)).refundedAmount).toBe(0);
    });

    test('a partial request amount refunds only that amount; the order stays Paid; refund-request holds mode', async () => {
        const o = await paid(A);
        const rr = await mkRR(A, o, { amount: 123.45 });
        expect((await approve(A.users.admin, rr, { note: 'ok' })).status).toBe(200);
        expect(await reload(o)).toMatchObject({ refundedAmount: 123.45, paymentStatus: 'Paid' });
        expect(await RefundRequest.findById(rr._id).lean()).toMatchObject({ status: 'approved', refundMode: 'manual', decisionNote: 'ok' });
    });

    test('a rejected request moves no money, and the order can still be refunded directly afterwards', async () => {
        const o = await paid(A);
        const rr = await mkRR(A, o);
        expect((await reject(A.users.admin, rr, { note: 'no' })).status).toBe(200);
        expect((await reload(o)).refundedAmount).toBe(0);
        expect((await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 500, reason: 'goodwill' })).status).toBe(200);
    });

    test('approving after a direct full refund is refused and leaves the request pending', async () => {
        const o = await paid(A);
        const rr = await mkRR(A, o);
        await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 500, reason: 'direct' });
        expect((await approve(A.users.admin, rr)).status).toBe(400);
        expect((await RefundRequest.findById(rr._id).lean()).status).toBe('pending');
        expect((await reload(o)).refundedAmount).toBe(500);
    });

    test('approving an ONLINE request refunds the exact paise via the gateway and returns the refund id', async () => {
        stubGateway();
        const o = await paidOnline(A, { amountPaid: 512.4, total: 512.4 });
        const rr = await mkRR(A, o);
        const res = await approve(A.users.admin, rr);
        expect(res.status).toBe(200);
        expect(gwCalls()[0][1].amount).toBe(51240);
        expect(res.body.refund.razorpayRefundId).toMatch(/^rfnd_/);
    });

    // Expected: customer refund requests carry a reason (the admin decides on it).
    // Actual: createRefundRequest stores String(reason||'').trim() - empty is accepted.
    test('Regression (fixed 2026-11): a customer refund request without a reason is refused', async () => {
        const c = await createCustomer('rr-r');
        const o = await paid(A, { user: c._id });
        const res = await ctx.api.as(c, A).post('/refund-requests').send({ orderId: String(o._id) });
        expect(res.status).toBe(400);
        expect(await RefundRequest.countDocuments({ order: o._id })).toBe(0);
    });

    // Expected: the order's refunds[] trail records EVERY refund (actor, reason,
    // gateway id) regardless of which endpoint made it. Actual: only
    // POST /razorpay/refund pushes refunds[]; utils/orderRefund.processOrderRefund
    // (used by approve) updates refundedAmount but never pushes a refunds[] row.
    test('BUG: an approved request writes a refunds[] audit row with actor and gateway id', async () => {
        stubGateway();
        const o = await paidOnline(A);
        const rr = await mkRR(A, o);
        expect((await approve(A.users.admin, rr)).status).toBe(200);
        const after = await reload(o);
        expect(after.refunds).toHaveLength(1);
        expect(after.refunds[0].razorpayRefundId).toMatch(/^rfnd_/);
        expect(String(after.refunds[0].actor)).toBe(String(A.users.admin._id));
        expect(after.refunds[0].amount).toBe(500);
    });

    // Expected: webhook refund.processed for a refund already issued by approve is
    // deduped by its gateway id (as it is for the direct endpoint). Actual: the
    // approve path never stores the refund id on the order, so the webhook sees
    // "not recorded" and increments refundedAmount a second time (1000 on a 500 order).
    test('BUG: the refund.processed webhook after an approved online request does not double count', async () => {
        stubGateway();
        const o = await paidOnline(A);
        const rr = await mkRR(A, o);
        const ap = await approve(A.users.admin, rr);
        const refundId = ap.body.refund.razorpayRefundId;
        const evt = {
            entity: 'event', event: 'refund.processed', id: `evt_${rid()}`,
            payload: {
                refund: { entity: { id: refundId, entity: 'refund', amount: 50000, payment_id: o.razorpayPaymentId, notes: { reason: 'cold food' } } },
                payment: { entity: { id: o.razorpayPaymentId, entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', order_id: o.razorpayOrderId, notes: { cafeOrderId: String(o._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' } } },
            },
        };
        const raw = JSON.stringify(evt);
        const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
        const wh = await ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).send(raw);
        expect(wh.status).toBe(200);
        await settle(200);
        expect((await reload(o)).refundedAmount).toBe(500);
    });

    test('the webhook after a DIRECT admin refund is deduped by gateway id (control for the bug above)', async () => {
        stubGateway();
        const o = await paidOnline(A);
        const res = await ctx.api.as(A.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount: 500, reason: 'direct' });
        const evt = {
            entity: 'event', event: 'refund.processed', id: `evt_${rid()}`,
            payload: {
                refund: { entity: { id: res.body.razorpayRefundId, entity: 'refund', amount: 50000, payment_id: o.razorpayPaymentId, notes: { reason: 'direct' } } },
                payment: { entity: { id: o.razorpayPaymentId, entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', order_id: o.razorpayOrderId, notes: { cafeOrderId: String(o._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' } } },
            },
        };
        const raw = JSON.stringify(evt);
        const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
        await ctx.api.raw.post(`${V1}/razorpay/webhook`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).send(raw);
        await settle(200);
        const after = await reload(o);
        expect(after.refundedAmount).toBe(500);
        expect(after.refunds).toHaveLength(1);
    });

    // Expected: audit row for an approved refund names the order by its human id
    // (like order.refund from the direct endpoint) and carries the paymentStatus.
    // Actual: approveRefundRequest passes { _id, orderId: rr.orderId } but the
    // RefundRequest field is orderIdRef, so orderId is undefined: entityId falls back
    // to the Mongo _id, and paymentStatus is hard-coded null.
    test('BUG: the audit row of an approved request uses the human order number', async () => {
        const o = await paid(A);
        const rr = await mkRR(A, o);
        expect((await approve(A.users.admin, rr)).status).toBe(200);
        const rows = await waitFor(async () => {
            const r = await TenantAudit.find({ restaurant: A.restaurant._id, action: 'order.refund', $or: [{ entityId: o.orderId }, { entityId: String(o._id) }] }).lean();
            return r.length ? r : null;
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].entityId).toBe(o.orderId);
    });
});

// ═══ cash closing / ledger ═══════════════════════════════════════════
describe('cash closing: cash refunds reduce expected cash', () => {
    let C;
    beforeAll(async () => { C = await seedTenant({ label: 'sc-c' }); });
    const preview = async (t = C) => (await ctx.api.as(t.users.admin).get('/cash-closings/preview')).body;
    const refund = (t, o, amount, reason = 'r') => ctx.api.as(t.users.admin).post('/razorpay/refund').send({ orderId: String(o._id), amount, reason });

    test('a direct cash refund lowers expected cash by exactly the refunded amount; sales unchanged', async () => {
        const o = await paid(C);
        const before = await preview();
        expect((await refund(C, o, 120.5)).status).toBe(200);
        const after = await preview();
        expect(after.success).toBe(true);
        expect(after.cashRefunds - before.cashRefunds).toBeCloseTo(120.5, 2);
        expect(after.expectedCash - before.expectedCash).toBeCloseTo(-120.5, 2);
        expect(after.cashSales).toBe(before.cashSales);
    });

    test('two partial cash refunds add up (paise exact)', async () => {
        const o = await paid(C);
        const before = await preview();
        await refund(C, o, 100.1); await refund(C, o, 33.33);
        const after = await preview();
        expect(Math.round((after.cashRefunds - before.cashRefunds) * 100)).toBe(13343);
    });

    test('an ONLINE refund is not a cash movement', async () => {
        stubGateway();
        const o = await paidOnline(C);
        const before = await preview();
        expect((await refund(C, o, 500)).status).toBe(200);
        expect((await preview()).cashRefunds).toBe(before.cashRefunds);
    });

    test('a refused refund changes nothing in the cash closing numbers', async () => {
        const o = await paid(C);
        const before = await preview();
        await refund(C, o, 99999);
        expect((await preview()).cashRefunds).toBe(before.cashRefunds);
    });

    // Expected: an approved refund REQUEST on a cash order is a cash hand-back
    // ("will be refunded at the counter") and reduces expected cash like a direct
    // refund. Actual: ledgerSources.loadSources reads order.refunds[]; the approve
    // path never writes refunds[], so cashRefunds stays 0 and the drawer shows a
    // phantom surplus equal to every approved cash refund.
    test('BUG: an approved cash refund request is counted in cashRefunds', async () => {
        const o = await paid(C);
        const rr = await RefundRequest.create({ restaurant: C.restaurant._id, branch: C.branch._id, order: o._id, orderIdRef: o.orderId, amount: 200, reason: 'cold', source: 'customer-request', status: 'pending' });
        const before = await preview();
        expect((await ctx.api.as(C.users.admin).post(`/refund-requests/${rr._id}/approve`).send({})).status).toBe(200);
        expect((await preview()).cashRefunds - before.cashRefunds).toBeCloseTo(200, 2);
    });

    // Expected: a cash order refunded to the customer's WALLET (refundMode 'wallet')
    // pays no cash out of the drawer. Actual: refunds[] has no destination field and
    // ledgerSources.summarizeCash classifies by the order's original method, so the
    // full wallet credit is subtracted from expected cash (false shortage).
    test('BUG: a cash order refunded to the wallet is not counted as cash paid out', async () => {
        const t = W;
        const c = await createCustomer('cc-w');
        await Wallet.create({ user: c._id, restaurant: t.restaurant._id, balance: 0 });
        const o = await paid(t, { user: c._id });
        const before = await preview(t);
        expect((await refund(t, o, 300)).status).toBe(200);
        expect((await walletOf(t, c)).balance).toBe(300);
        expect((await preview(t)).cashRefunds - before.cashRefunds).toBe(0);
    });

    test('a closed day stores the refund total in the closing record', async () => {
        const T = await seedTenant({ label: 'sc-cl' });
        const o = await paid(T);
        await refund(T, o, 150);
        const p = await preview(T);
        const res = await ctx.api.as(T.users.admin).post('/cash-closings/close').send({ countedCash: p.expectedCash });
        expect(res.status).toBe(200);
        expect(res.body.closing).toMatchObject({ cashRefunds: 150, variance: 0 });
    });

    test('a waiter cannot read or close the cash closing', async () => {
        expect((await ctx.api.as(C.users.waiter).get('/cash-closings/preview')).status).toBe(403);
        expect((await ctx.api.as(C.users.captain).post('/cash-closings/close').send({ countedCash: 0 })).status).toBe(403);
    });
});
