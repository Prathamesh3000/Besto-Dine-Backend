/**
 * STRICT payments campaign: order payment correctness.
 *   PATCH /orders/:id/status   (staff settle: paymentStatus/Method/amountPaid/tip/discount/payments[])
 *   PATCH /orders/:id/payment  (customer intent / wallet finalize)
 *   PATCH /orders/:id/coupon, POST /orders/:id/bill/reopen, request-counter-payment
 *
 * "Regression (fixed 2026-11)" tests were BUG: tests pinning defects fixed in payments fix round 1.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const Tip = require(path.join(BACKEND, 'models/tip'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A; let B; let manager;
const rid = () => crypto.randomBytes(5).toString('hex');
const DAY = 86400000;

beforeAll(async () => {
    A = await seedTenant({ label: 'spo-a' });
    B = await seedTenant({ label: 'spo-b' });
    manager = await createUser({
        name: 'mgr', email: `mgr.${rid()}@staff.test`, role: 'manager',
        restaurant: A.restaurant._id, branch: A.branch._id, permissions: defaultPermissionsForRole('manager'),
    });
});

async function mk(t = A, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `SPO-${rid()}`,
        type: 'takeaway', status: 'new',
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, ...fields,
    });
    return doc.toObject();
}
const reload = (o) => Order.findById(o._id).lean();
const cap = () => ctx.api.as(A.users.captain, A);
const adm = () => ctx.api.as(A.users.admin, A);
const idem = () => ({ 'Idempotency-Key': `k-${rid()}` });
const settleReq = (client, o, body) => client.patch(`/orders/${o._id}/status`).set(idem()).send(body);
const paid = (o, body = {}) => settleReq(cap(), o, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: o.total, ...body });
const ledgerRows = (o, type) => Transaction.find({ order: o._id, type }).lean();

// ── 1. Happy path: states, amounts, methods ──────────────────────────
describe('settle: exact amounts and state', () => {
    test('exact cash settle: Paid, amountPaid, paidAt, payment block, changeDue 0', async () => {
        const o = await mk();
        const res = await paid(o);
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Paid');
        expect(d.amountPaid).toBe(500);
        expect(d.paidAt).toBeTruthy();
        expect(d.total).toBe(500);
        expect(d.payment).toMatchObject({ state: 'paid', method: 'cash', amount: 500, cashReceived: 500, changeDue: 0 });
    });
    test('cash overpayment records changeDue and keeps total untouched', async () => {
        const o = await mk();
        expect((await paid(o, { amountPaid: 600 })).status).toBe(200);
        const d = await reload(o);
        expect(d.total).toBe(500);
        expect(d.payment.changeDue).toBe(100);
        expect(d.payment.cashReceived).toBe(600);
    });
    test('explicit cashReceived field drives change', async () => {
        const o = await mk();
        expect((await paid(o, { amountPaid: 500, cashReceived: 1000 })).status).toBe(200);
        expect((await reload(o)).payment).toMatchObject({ cashReceived: 1000, changeDue: 500 });
    });
    test('cash short by more than INR 1 -> 400 AMOUNT_TOO_LOW and order untouched', async () => {
        const o = await mk();
        const res = await paid(o, { amountPaid: 498.5 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_TOO_LOW');
        expect(res.body.amountDue).toBe(500);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Pending');
        expect(d.amountPaid).toBe(0);
    });
    test('amount short by exactly INR 1 is tolerated (documented tolerance)', async () => {
        const o = await mk();
        expect((await paid(o, { amountPaid: 499 })).status).toBe(200);
    });
    test('cash received short by INR 1.01 is rejected', async () => {
        const o = await mk();
        const res = await paid(o, { amountPaid: 498.99 });
        expect(res.status).toBe(400);
    });
    test('card settle at exact amount', async () => {
        const o = await mk();
        expect((await paid(o, { paymentMethod: 'card' })).status).toBe(200);
        const d = await reload(o);
        expect(d.paymentMethod).toBe('card');
        expect(d.payment.cashReceived).toBeNull();
    });
    test('UPI settle by captain', async () => {
        const o = await mk();
        const res = await paid(o, { paymentMethod: 'UPI' });
        expect(res.status).toBe(200);
        expect((await reload(o)).paymentMethod).toBe('UPI');
    });
    test('UPI manualConfirm records upi-qr-manual and amount due when amountPaid omitted', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Paid', paymentMethod: 'UPI', manualConfirm: true, upiRef: '12345' });
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.amountPaid).toBe(500);
        expect(d.payment).toMatchObject({ method: 'upi-qr-manual', reference: '12345' });
    });
    test('manualConfirm without UPI -> 400', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Paid', paymentMethod: 'cash', manualConfirm: true });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MANUAL_CONFIRM_NEEDS_UPI');
    });
    test('upiRef over 40 chars -> 400', async () => {
        const o = await mk();
        const res = await paid(o, { paymentMethod: 'UPI', upiRef: 'x'.repeat(41) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_UPI_REF');
    });
    test('manualConfirm non-boolean -> 400', async () => {
        const o = await mk();
        const res = await paid(o, { paymentMethod: 'UPI', manualConfirm: 'yes' });
        expect(res.status).toBe(400);
    });
    test('paise-exact total 333.33 settles with amountPaid 333.33', async () => {
        const o = await mk(A, { total: 333.33 });
        expect((await paid(o)).status).toBe(200);
        const d = await reload(o);
        expect(d.amountPaid).toBe(333.33);
        expect(d.payment.amount).toBe(333.33);
    });
    test('float sum 0.1 + 0.2 as amountPaid against total 0.3 settles', async () => {
        const o = await mk(A, { total: 0.3 });
        expect((await paid(o, { amountPaid: 0.1 + 0.2 })).status).toBe(200);
    });
    test('change computed to paise for fractional overpay (1000 vs 333.33 -> 666.67)', async () => {
        const o = await mk(A, { total: 333.33 });
        expect((await paid(o, { amountPaid: 1000 })).status).toBe(200);
        expect((await reload(o)).payment.changeDue).toBe(666.67);
    });
    test('amountPaid sent as numeric string "500" is accepted and stored as number', async () => {
        const o = await mk();
        expect((await paid(o, { amountPaid: '500' })).status).toBe(200);
        expect((await reload(o)).amountPaid).toBe(500);
    });
    test('amountPaid 1e308 (huge) on cash settle is flagged or recorded as change, never corrupts total', async () => {
        const o = await mk();
        await paid(o, { amountPaid: 1e308 });
        expect((await reload(o)).total).toBe(500);
    });
    test('settle by orderId string works as well as _id', async () => {
        const o = await mk();
        const res = await cap().patch(`/orders/${o.orderId}/status`).set(idem())
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500 });
        expect(res.status).toBe(200);
    });
    test('Regression (fixed 2026-11): Paid settle without amountPaid (card/UPI) records amountPaid = amount due', async () => {
        // Expected: amountPaid 500. Actual: stays 0 on a Paid order, so every report that sums amountPaid under-reports revenue.
        const o = await mk();
        await settleReq(cap(), o, { paymentStatus: 'Paid', paymentMethod: 'card' });
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Paid');
        expect(d.amountPaid).toBe(500);
    });
});

// ── 2. Invalid amounts ───────────────────────────────────────────────
describe('settle: zero / negative / NaN / string amounts', () => {
    test.each([
        ['negative', -5],
        ['negative string', '-5'],
        ['NaN string', 'abc'],
        ['Infinity string', 'Infinity'],
        ['object', { a: 1 }],
    ])('amountPaid %s with Paid -> 4xx, order stays unpaid', async (_n, v) => {
        const o = await mk();
        const res = await paid(o, { amountPaid: v });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Pending');
        expect(d.amountPaid).toBe(0);
    });
    test('amountPaid 0 on a non-zero bill -> AMOUNT_TOO_LOW', async () => {
        const o = await mk();
        const res = await paid(o, { amountPaid: 0 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_TOO_LOW');
    });
    test('zero-total order settles with amountPaid 0', async () => {
        const o = await mk(A, { total: 0 });
        expect((await paid(o, { amountPaid: 0 })).status).toBe(200);
    });
    test('Regression (fixed 2026-11): negative amountPaid WITHOUT paymentStatus is rejected', async () => {
        // Expected: 400. Actual: applyPaymentFields only validates amountPaid when
        // paymentStatus==='Paid'; findOneAndUpdate skips schema min, so -50 is persisted.
        const o = await mk();
        const res = await settleReq(cap(), o, { amountPaid: -50 });
        const d = await reload(o);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(d.amountPaid).toBeGreaterThanOrEqual(0);
    });
    test('Regression (fixed 2026-11): NaN-string amountPaid WITHOUT paymentStatus is rejected / not persisted as garbage', async () => {
        // Expected: 400. Actual: cast error 500 or silently stored.
        const o = await mk();
        const res = await settleReq(cap(), o, { amountPaid: 'abc' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });
    test('Regression (fixed 2026-11): amountPaid above total without paymentStatus cannot be written arbitrarily', async () => {
        // Expected: rejected (or ignored). Actual: amountPaid=999999 is stored on a Pending order,
        // so the next settle computes due = 0 and any later settle "covers" the bill.
        const o = await mk();
        await settleReq(cap(), o, { amountPaid: 999999 });
        const d = await reload(o);
        expect(d.amountPaid).toBeLessThanOrEqual(d.total);
    });
    test('Regression (fixed 2026-11): bare amountPaid (no paymentStatus) below total does not mark Partially Paid silently nor lose the next settle due', async () => {
        // After a stray amountPaid=500 on a 500 bill, a Pending order should not be
        // settleable for amountPaid 0. Expected: due still 500 -> 400.
        const o = await mk();
        await settleReq(cap(), o, { amountPaid: 500 });
        const res = await settleReq(cap(), o, { paymentStatus: 'Paid', paymentMethod: 'card', amountPaid: 0 });
        expect(res.status).toBe(400);
    });
    test.each([
        ['negative tip', -10],
        ['NaN tip string', 'abc'],
    ])('tipAmount %s never persists a negative value', async (_n, v) => {
        const o = await mk();
        await paid(o, { tipAmount: v });
        expect((await reload(o)).tipAmount).toBeGreaterThanOrEqual(0);
    });
});

// ── 3. State validity ────────────────────────────────────────────────
describe('settle: paymentStatus values and transitions', () => {
    test('Regression (fixed 2026-11): arbitrary paymentStatus string is rejected', async () => {
        // Expected 400 (enum Pending/Partially Paid/Paid/Refunded). Actual: stored or 500.
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Banana' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect((await reload(o)).paymentStatus).not.toBe('Banana');
    });
    test('Regression (fixed 2026-11): captain cannot flip an unpaid order straight to Refunded through the settle route', async () => {
        // Expected: 400/403 (refunds have their own flow + ledger). Actual: accepted -> no money ledger.
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Refunded' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).paymentStatus).not.toBe('Refunded');
    });
    test('Regression (fixed 2026-11): a Paid order cannot be silently reverted to Pending (un-pay) via status route', async () => {
        // Expected: 400/409. Actual: paymentStatus is $set to Pending, amountPaid/ledger left behind.
        const o = await mk();
        await paid(o);
        const res = await settleReq(cap(), o, { paymentStatus: 'Pending' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });
    test('Regression (fixed 2026-11): staff cannot set Partially Paid with no tender / amount (state without money)', async () => {
        // Expected: 400. Actual: order flagged Partially Paid with amountPaid 0.
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Partially Paid' });
        const d = await reload(o);
        expect(res.status >= 400 || d.amountPaid > 0).toBe(true);
    });
    test('Regression (fixed 2026-11): settling a CANCELLED order is rejected', async () => {
        // Expected: 400/409 (void order cannot be paid). Actual: the status route has no
        // cancelled guard in applyPaymentFields, so a cancelled order becomes Paid + ledger row.
        const o = await mk(A, { status: 'cancelled' });
        const res = await paid(o);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).paymentStatus).not.toBe('Paid');
    });
    test('Regression (fixed 2026-11): cancelled order settle writes no ledger / revenue rows', async () => {
        const o = await mk(A, { status: 'cancelled', user: (await createCustomer('cx'))._id });
        await paid(o);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(0);
    });
    test('Regression (fixed 2026-11): settling an already Paid order -> 409 ALREADY_PAID (no re-write)', async () => {
        const o = await mk(A, { user: (await createCustomer('dup'))._id });
        expect((await paid(o)).status).toBe(200);
        const res = await paid(o);
        expect(res.status).toBe(409);
        await settle(200);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(1);
    });
    test('Regression (fixed 2026-11): second settle with a different amount does not change the stored amountPaid', async () => {
        const o = await mk();
        await paid(o);
        await paid(o, { amountPaid: 900 });
        expect((await reload(o)).amountPaid).toBe(500);
    });
    test('Regression (fixed 2026-11): re-sending Paid with another method on a Paid order never overwrites paymentMethod', async () => {
        // Expected: method stays cash. Actual: the Paid->Paid pin only exists when claiming Paid
        // (commitStatusUpdate claimsPaid), so a repeat settle overwrites method/amountPaid of a settled order.
        const o = await mk();
        await paid(o);
        await paid(o, { paymentMethod: 'card' });
        expect((await reload(o)).paymentMethod).toBe('cash');
    });
    test('Regression (fixed 2026-11): Refunded order cannot be re-settled to Paid through the status route', async () => {
        const o = await mk(A, { paymentStatus: 'Refunded', amountPaid: 500 });
        const res = await paid(o);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).paymentStatus).toBe('Refunded');
    });
    test('unknown order id -> 404', async () => {
        const res = await cap().patch(`/orders/${new (require('mongoose').Types.ObjectId)()}/status`).set(idem()).send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 1 });
        expect(res.status).toBe(404);
    });
    test('malformed order id -> 4xx not 500', async () => {
        const res = await cap().patch('/orders/not-an-id!!/status').set(idem()).send({ paymentStatus: 'Paid' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });
});

// ── 4. Concurrency ───────────────────────────────────────────────────
describe('settle: concurrent double-pay', () => {
    test('Regression (fixed 2026-11): (timing-dependent) two parallel cash settles: exactly one 200, one 409 (second must not re-write a Paid order)', async () => {
        const o = await mk(A, { user: (await createCustomer('cc1'))._id });
        const rs = await Promise.all([paid(o), paid(o)]);
        const codes = rs.map((r) => r.status).sort();
        expect(codes).toEqual([200, 409]);
        await settle(250);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(1);
        expect(await ledgerRows(o, 'points_earned')).toHaveLength(0); // no points earned -> no zero-point row
    });
    test('Regression (fixed 2026-11): five parallel settles: single winner, others 409', async () => {
        // Expected: 1x200 + 4x409. Actual: a request that reads the order after the winner committed sees Paid,
        // so claimsPaid=false, no atomic pin, and it returns 200 again (double-pay accepted, amountPaid/method overwritten).
        const o = await mk(A, { user: (await createCustomer('cc5'))._id });
        const rs = await Promise.all([1, 2, 3, 4, 5].map(() => paid(o)));
        expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
        expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
        await settle(250);
        expect((await reload(o)).amountPaid).toBe(500);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(1);
    });
    test('parallel cash + card settle: one ledger row and amountPaid not doubled', async () => {
        const o = await mk(A, { user: (await createCustomer('cc2'))._id });
        await Promise.all([paid(o, { paymentMethod: 'cash' }), paid(o, { paymentMethod: 'card' })]);
        await settle(300);
        expect((await reload(o)).amountPaid).toBe(500);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(1);
    });
    test('parallel settle of tipped order creates one Tip row', async () => {
        const o = await mk(A, { waiter: A.users.waiter._id });
        await Promise.all([paid(o, { tipAmount: 30 }), paid(o, { tipAmount: 30 })]);
        await settle(250);
        expect(await Tip.countDocuments({ order: o._id })).toBeLessThanOrEqual(1);
    });
    test('parallel split-tender settles: one wins, no double amountPaid', async () => {
        const o = await mk();
        const body = { payments: [{ method: 'cash', amount: 500 }] };
        const rs = await Promise.all([settleReq(cap(), o, body), settleReq(cap(), o, body)]);
        expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await reload(o)).amountPaid).toBe(500);
    });
    test('same Idempotency-Key replay returns the first response without a second ledger row', async () => {
        const o = await mk(A, { user: (await createCustomer('idk'))._id });
        const key = `k-${rid()}`;
        const send = () => cap().patch(`/orders/${o._id}/status`).set('Idempotency-Key', key)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500 });
        const r1 = await send();
        const r2 = await send();
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        await settle(200);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(1);
    });
});

// ── 5. Discount / tip / total invariants ─────────────────────────────
describe('settle: discount and tip', () => {
    test('manualDiscount lowers the amount due; total unchanged', async () => {
        const o = await mk();
        expect((await paid(o, { manualDiscount: 100, amountPaid: 400 })).status).toBe(200);
        const d = await reload(o);
        expect(d.total).toBe(500);
        expect(d.manualDiscount).toBe(100);
        expect(d.payment.amount).toBe(400);
    });
    test('amountPaid below due-after-discount is rejected', async () => {
        const o = await mk();
        const res = await paid(o, { manualDiscount: 100, amountPaid: 350 });
        expect(res.status).toBe(400);
        expect(res.body.amountDue).toBe(400);
    });
    test('discount equal to total allows zero payment', async () => {
        const o = await mk();
        expect((await paid(o, { manualDiscount: 500, amountPaid: 0 })).status).toBe(200);
    });
    test('Regression (fixed 2026-11): manualDiscount larger than the bill is rejected / capped', async () => {
        // Expected: 400 or discount capped at total. Actual: discount 9999 stored on a 500 bill
        // (negative net revenue in reports).
        const o = await mk();
        const res = await paid(o, { manualDiscount: 9999, amountPaid: 0 });
        const d = await reload(o);
        expect(res.status >= 400 || d.manualDiscount <= d.total).toBe(true);
    });
    test('negative manualDiscount is clamped to 0', async () => {
        const o = await mk();
        expect((await paid(o, { manualDiscount: -50 })).status).toBe(200);
        expect((await reload(o)).manualDiscount).toBe(0);
    });
    test('manualDiscount NaN string is ignored (not NaN in DB)', async () => {
        const o = await mk();
        await paid(o, { manualDiscount: 'abc' });
        const d = await reload(o);
        expect(Number.isFinite(d.manualDiscount)).toBe(true);
    });
    test('discount changed on a finalised bill -> 409/4xx (bill locked)', async () => {
        const o = await mk(A, { bill: { status: 'final', billNo: 1, financialYear: '2026-27', total: 500, savedAt: new Date() } });
        const res = await paid(o, { manualDiscount: 100, amountPaid: 400 });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await reload(o)).manualDiscount).toBe(0);
    });
    test('echoing the current discount on a finalised bill is allowed', async () => {
        const o = await mk(A, { manualDiscount: 50, bill: { status: 'final', billNo: 2, financialYear: '2026-27', total: 450, savedAt: new Date() } });
        expect((await paid(o, { manualDiscount: 50, amountPaid: 450 })).status).toBe(200);
    });
    test('tip stored: Tip row created for the waiter on a paid order', async () => {
        const o = await mk(A, { waiter: A.users.waiter._id, total: 550, tipAmount: 50 });
        expect((await paid(o, { amountPaid: 550 })).status).toBe(200);
        await settle(250);
        const tips = await Tip.find({ order: o._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0].amount).toBe(50);
    });
    test('raised tip adds only the extra to cash needed (stored tip not double counted)', async () => {
        const o = await mk(A, { total: 550, tipAmount: 50 });
        const res = await paid(o, { amountPaid: 560, tipAmount: 60 });
        expect(res.status).toBe(200);
        expect((await reload(o)).payment.changeDue).toBe(0);
    });
    test('raised tip with cash short of the extra -> CASH_SHORT', async () => {
        const o = await mk(A, { total: 550, tipAmount: 50 });
        const res = await paid(o, { amountPaid: 550, tipAmount: 70 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CASH_SHORT');
    });
    test('Regression (fixed 2026-11): a tip raised at settle time is added to order.total (bill + tip invariant)', async () => {
        // Expected: total 500 -> 550 once a 50 tip is settled (utils/billing adds tip into total),
        // so reports reconcile amountPaid==total+... Actual: tip lives in tipAmount only; total stays 500,
        // so amountPaid (550) > total (500) with no field explaining the gap.
        const o = await mk();
        await paid(o, { amountPaid: 550, tipAmount: 50 });
        const d = await reload(o);
        expect(d.total).toBe(550);
    });
    test('tipAmount alone (no paymentStatus) updates tip without marking paid', async () => {
        const o = await mk();
        await settleReq(cap(), o, { tipAmount: 25 });
        const d = await reload(o);
        expect(d.tipAmount).toBe(25);
        expect(d.paymentStatus).toBe('Pending');
    });
    test('Regression (fixed 2026-11): tip cannot be added to an already Paid order after the fact (money not collected)', async () => {
        // Expected: 4xx. Actual: tipAmount is $set on a Paid order and a Tip row is created for cash never taken.
        const o = await mk(A, { waiter: A.users.waiter._id });
        await paid(o);
        await settleReq(cap(), o, { tipAmount: 500 });
        await settle(250);
        expect((await reload(o)).tipAmount).toBe(0);
    });
});

// ── 6. Split tender ──────────────────────────────────────────────────
describe('split / partial payments', () => {
    test('cash + UPI covering the bill -> Paid with method mixed', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 300 }] });
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Paid');
        expect(d.paymentMethod).toBe('mixed');
        expect(d.amountPaid).toBe(500);
        expect(d.payments).toHaveLength(2);
    });
    test('underpaying tenders -> Partially Paid, not Paid, amountPaid = collected', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }] });
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Partially Paid');
        expect(d.amountPaid).toBe(200);
        expect(d.paidAt).toBeFalsy();
    });
    test('partial then remainder -> Paid, amountPaid cumulative = total', async () => {
        const o = await mk();
        await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }] });
        const res = await settleReq(cap(), o, { payments: [{ method: 'card', amount: 300 }] });
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Paid');
        expect(d.amountPaid).toBe(500);
        expect(d.payments).toHaveLength(2);
    });
    test('partial payment does not award loyalty / ledger until fully paid', async () => {
        const o = await mk(A, { user: (await createCustomer('sp1'))._id });
        await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 100 }] });
        await settle(200);
        expect(await ledgerRows(o, 'points_earned')).toHaveLength(0);
    });
    test('Regression (fixed 2026-11): mixed cash+UPI split completing a customer order writes the ledger and returns 200', async () => {
        const o = await mk(A, { user: (await createCustomer('sp2'))._id });
        // Expected: 200 + 1 order_payment row. Actual: the order is committed Paid with method 'mixed', then
        // Transaction (enum upi|card|wallet|cash|points) rejects 'mixed' -> 500, no ledger, no points, retry = ALREADY_PAID.
        await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }] });
        const res = await settleReq(cap(), o, { payments: [{ method: 'upi', amount: 300 }] });
        await settle(250);
        expect(res.status).toBe(200);
        const rows = await ledgerRows(o, 'order_payment');
        expect(rows).toHaveLength(1);
    });
    test('Regression (fixed 2026-11): single-leg "other" tender on a customer order does not 500 after committing Paid', async () => {
        // Expected 200 + ledger. Actual: Transaction.paymentMethod enum has no 'other' -> 500 after the order is already Paid.
        const o = await mk(A, { user: (await createCustomer('sp3'))._id });
        const res = await settleReq(cap(), o, { payments: [{ method: 'other', amount: 500 }] });
        expect(res.status).toBe(200);
    });
    test('Regression (fixed 2026-11): one-shot mixed cash+UPI split on a customer order does not 500', async () => {
        const o = await mk(A, { user: (await createCustomer('sp4'))._id });
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 300 }] });
        expect(res.status).toBe(200);
    });
    test('overpay with non-cash only -> OVERPAYMENT_NOT_CASH', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { payments: [{ method: 'card', amount: 700 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('OVERPAYMENT_NOT_CASH');
    });
    test('overpay with enough cash gives change', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 600 }] });
        expect(res.status).toBe(200);
        expect((await reload(o)).payment.changeDue).toBe(100);
    });
    test.each([
        ['empty list', []],
        ['not an array', 'cash'],
        ['11 lines', Array.from({ length: 11 }, () => ({ method: 'cash', amount: 1 }))],
        ['zero amount', [{ method: 'cash', amount: 0 }]],
        ['negative amount', [{ method: 'cash', amount: -5 }]],
        ['NaN amount', [{ method: 'cash', amount: 'abc' }]],
        ['wallet method (server only)', [{ method: 'wallet', amount: 500 }]],
        ['razorpay method (server only)', [{ method: 'razorpay', amount: 500 }]],
        ['ref too long', [{ method: 'upi', amount: 500, reference: 'x'.repeat(41) }]],
    ])('payments %s -> 400 and nothing persisted', async (_n, payments) => {
        const o = await mk();
        const res = await settleReq(cap(), o, { payments });
        expect(res.status).toBe(400);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Pending');
        expect(d.amountPaid).toBe(0);
    });
    test('payments with paymentStatus Pending -> 400 INVALID_PAYMENT_STATUS', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Pending', payments: [{ method: 'cash', amount: 500 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_PAYMENT_STATUS');
    });
    test('payments asserting Paid but underpaying -> AMOUNT_TOO_LOW', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 100 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_TOO_LOW');
    });
    test('payments on an already Paid order -> 400 ALREADY_PAID', async () => {
        const o = await mk();
        await paid(o);
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 500 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ALREADY_PAID');
    });
    test('payments with manualDiscount reduces required amount', async () => {
        const o = await mk();
        const res = await settleReq(cap(), o, { manualDiscount: 100, payments: [{ method: 'cash', amount: 400 }] });
        expect(res.status).toBe(200);
        expect((await reload(o)).paymentStatus).toBe('Paid');
    });
    test('Regression (fixed 2026-11): split payments on a CANCELLED order are rejected', async () => {
        const o = await mk(A, { status: 'cancelled' });
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 500 }] });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
    test('Regression (fixed 2026-11): split payments on a CANCELLED order write no money (paymentStatus stays unpaid)', async () => {
        // Expected: 4xx and unpaid. Actual: no cancelled guard in resolveTenderedBody.
        const o = await mk(A, { status: 'cancelled' });
        await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 200 }] });
        const d = await reload(o);
        expect(d.amountPaid).toBe(0);
    });
    test('float split 0.1 + 0.2 against total 0.3 -> Paid', async () => {
        const o = await mk(A, { total: 0.3 });
        const res = await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 0.1 }, { method: 'upi', amount: 0.2 }] });
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Paid');
        expect(d.amountPaid).toBe(0.3);
    });
    test('split amounts are rounded to paise (100.005 -> 100.01 or 100)', async () => {
        const o = await mk(A, { total: 100 });
        await settleReq(cap(), o, { payments: [{ method: 'cash', amount: 100.004 }] });
        const d = await reload(o);
        expect(d.payments[0].amount).toBe(100);
    });
    test('split tender on dine-in table requires sibling rounds due too', async () => {
        const table = await createTable(A);
        const o1 = await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 300 });
        await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 200 });
        const res = await settleReq(cap(), o1, { paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 300 }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_TOO_LOW');
        expect(res.body.amountDue).toBe(500);
    });
    test('dine-in settle covering siblings marks sibling rounds Paid with amountPaid 0', async () => {
        const table = await createTable(A);
        const o1 = await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 300 });
        const o2 = await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 200 });
        const res = await settleReq(cap(), o1, { payments: [{ method: 'cash', amount: 500 }] });
        expect(res.status).toBe(200);
        expect((await reload(o2)).paymentStatus).toBe('Paid');
    });
    test('Regression (fixed 2026-11): single-method settle of one dine-in round must cover sibling rounds it marks Paid', async () => {
        // Expected: settling round 1 (300) with 300 cash must not zero-pay round 2 (200 owed).
        // Actual: settleSiblingDineInRounds marks the sibling Paid with amountPaid 0 although only
        // the first round's amount was required -> 200 never collected (split-tender path checks siblings, this one does not).
        const table = await createTable(A);
        const o1 = await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 300 });
        const o2 = await mk(A, { type: 'dine-in', table: table._id, status: 'served', total: 200 });
        const res = await paid(o1, { amountPaid: 300 });
        const sib = await reload(o2);
        expect(res.status >= 400 || sib.paymentStatus !== 'Paid').toBe(true);
    });
});

// ── 7. Roles and access ──────────────────────────────────────────────
describe('roles and permissions on settle', () => {
    const body = { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500 };
    test('waiter settle -> 403 BILLING_CAPTAIN_ONLY, order untouched', async () => {
        const o = await mk();
        const res = await settleReq(ctx.api.as(A.users.waiter, A), o, body);
        expect(res.status).toBe(403);
        expect((await reload(o)).paymentStatus).toBe('Pending');
    });
    test.each(['paymentStatus', 'paymentMethod', 'amountPaid', 'cashReceived', 'manualDiscount', 'tipAmount'])(
        'waiter sending only %s is blocked', async (k) => {
            const o = await mk();
            const res = await settleReq(ctx.api.as(A.users.waiter, A), o, { [k]: k === 'paymentStatus' || k === 'paymentMethod' ? 'cash' : 10 });
            expect(res.status).toBe(403);
        });
    test('waiter split payments blocked', async () => {
        const o = await mk();
        const res = await settleReq(ctx.api.as(A.users.waiter, A), o, { payments: [{ method: 'cash', amount: 500 }] });
        expect(res.status).toBe(403);
        expect((await reload(o)).amountPaid).toBe(0);
    });
    test('captain settle OK', async () => {
        const o = await mk();
        expect((await settleReq(cap(), o, body)).status).toBe(200);
    });
    test('admin settle OK', async () => {
        const o = await mk();
        expect((await settleReq(adm(), o, body)).status).toBe(200);
    });
    test('manager settle OK', async () => {
        const o = await mk();
        expect((await settleReq(ctx.api.as(manager, A), o, body)).status).toBe(200);
    });
    test('Regression (fixed 2026-11): chef cannot mark an order Paid', async () => {
        // Expected: 403 (billing is captain/admin/manager). Actual: chef holds updateOrderStatus and
        // the billing-role check only fires for UPI / split-tender, so cash settle by a chef succeeds.
        const o = await mk();
        const res = await settleReq(ctx.api.as(A.users.chef, A), o, body);
        expect(res.status).toBe(403);
        expect((await reload(o)).paymentStatus).toBe('Pending');
    });
    test('Regression (fixed 2026-11): chef cannot apply a manual discount or tip', async () => {
        const o = await mk();
        await settleReq(ctx.api.as(A.users.chef, A), o, { manualDiscount: 400 });
        expect((await reload(o)).manualDiscount).toBe(0);
    });
    test('chef UPI settle -> 403', async () => {
        const o = await mk();
        const res = await settleReq(ctx.api.as(A.users.chef, A), o, { ...body, paymentMethod: 'UPI' });
        expect(res.status).toBe(403);
    });
    test('customer token -> 403 on status route', async () => {
        const c = await createCustomer('role');
        const o = await mk(A, { user: c._id });
        const res = await settleReq(ctx.api.as(c, A), o, body);
        expect(res.status).toBe(403);
        expect((await reload(o)).paymentStatus).toBe('Pending');
    });
    test('guest -> 401 on status route', async () => {
        const o = await mk();
        const res = await ctx.api.guest(A).patch(`/orders/${o._id}/status`).set(idem()).send(body);
        expect(res.status).toBe(401);
    });
    test('other tenant admin cannot settle -> 404 and untouched', async () => {
        const o = await mk();
        const res = await settleReq(ctx.api.as(B.users.admin, B), o, body);
        expect(res.status).toBe(404);
        expect((await reload(o)).paymentStatus).toBe('Pending');
    });
    test('captain pinned to another branch -> 403 BRANCH_MISMATCH', async () => {
        const Branch = require(path.join(BACKEND, 'models/branch'));
        const br = await Branch.create({ restaurant: A.restaurant._id, name: 'Other', slug: `o-${rid()}`, isActive: true });
        const o = await mk(A, { branch: br._id });
        const res = await settleReq(cap(), o, body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });
    test('mass-assignment: total / restaurant / paidAt in body are ignored', async () => {
        const o = await mk();
        await paid(o, { total: 1, restaurant: String(B.restaurant._id), paidAt: '2000-01-01', razorpayPaymentId: 'pay_evil' });
        const d = await reload(o);
        expect(d.total).toBe(500);
        expect(String(d.restaurant)).toBe(String(A.restaurant._id));
        expect(d.razorpayPaymentId).toBeFalsy();
        expect(new Date(d.paidAt).getFullYear()).toBeGreaterThan(2000);
    });
    test('Regression (fixed 2026-11): client-supplied payment.* / amountPaid cannot forge a gateway id via status body', async () => {
        const o = await mk();
        await paid(o, { 'payment.reference': 'FORGED', payment: { state: 'paid', reference: 'FORGED' } });
        expect((await reload(o)).payment.reference).not.toBe('FORGED');
    });
});

// ── 8. Ledger / loyalty / table side effects ─────────────────────────
describe('settle side effects', () => {
    test('ledger row amount equals total and method cash', async () => {
        const o = await mk(A, { user: (await createCustomer('l1'))._id, total: 250.75 });
        await paid(o);
        await settle(250);
        const rows = await ledgerRows(o, 'order_payment');
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(250.75);
    });
    test('Regression (fixed 2026-11): ledger records the discounted amount actually collected (total - manualDiscount)', async () => {
        // Expected: 400 (customer paid 400 after a 100 discount). Actual: recordPaidOrderLedger books order.total (500).
        const o = await mk(A, { user: (await createCustomer('l2'))._id });
        await paid(o, { manualDiscount: 100, amountPaid: 400 });
        await settle(250);
        const rows = await ledgerRows(o, 'order_payment');
        expect(rows[0].amount).toBe(400);
    });
    test('Regression (fixed 2026-11): loyalty points are earned on the discounted payable, not the pre-discount total', async () => {
        // Expected: points on 400. Actual: points floor(total=500*ppr).
        const c = await createCustomer('l3');
        const o = await mk(A, { user: c._id });
        await paid(o, { manualDiscount: 250, amountPaid: 250 });
        await settle(250);
        const w = await Wallet.findOne({ user: c._id }).lean();
        const pts = (w && w.loyaltyPoints) || 0;
        expect(pts).toBeLessThanOrEqual(250);
    });
    test('ownerless (guest) order settles without a ledger row and without error', async () => {
        const o = await mk();
        expect((await paid(o)).status).toBe(200);
        await settle(200);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(0);
    });
    test('dine-in settle frees the table', async () => {
        const table = await createTable(A);
        const o = await mk(A, { type: 'dine-in', table: table._id, status: 'served' });
        await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied', activeOrder: o._id } });
        await paid(o);
        await settle(250);
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });
    test('dine-in settle auto-promotes a ready order to served', async () => {
        const table = await createTable(A);
        const o = await mk(A, { type: 'dine-in', table: table._id, status: 'ready' });
        await paid(o);
        const d = await reload(o);
        expect(d.status).toBe('served');
        expect(d.servedAt).toBeTruthy();
    });
    test('takeaway settle does not change kitchen status', async () => {
        const o = await mk(A, { status: 'preparing' });
        await paid(o);
        expect((await reload(o)).status).toBe('preparing');
    });
    test('pay-first dine-in "new" order stays new (kitchen) after payment', async () => {
        const table = await createTable(A);
        const o = await mk(A, { type: 'dine-in', table: table._id, status: 'new' });
        await paid(o);
        expect((await reload(o)).status).toBe('new');
    });
    test('failed settle (too low) creates no tip, ledger or points', async () => {
        const o = await mk(A, { user: (await createCustomer('l4'))._id, waiter: A.users.waiter._id });
        await paid(o, { amountPaid: 10, tipAmount: 40 });
        await settle(200);
        expect(await ledgerRows(o, 'order_payment')).toHaveLength(0);
        expect(await Tip.countDocuments({ order: o._id })).toBe(0);
        expect((await reload(o)).tipAmount).toBe(0);
    });
    test('failed settle leaves manualDiscount unchanged (atomic)', async () => {
        const o = await mk();
        await paid(o, { manualDiscount: 300, amountPaid: 1 });
        expect((await reload(o)).manualDiscount).toBe(0);
    });
});

// ── 9. Customer PATCH /orders/:id/payment ────────────────────────────
describe('customer payment endpoint', () => {
    const custPay = (client, o, body) => client.patch(`/orders/${o._id}/payment`).set(idem()).send(body);
    test('customer cannot mark own order Paid (no settlement) -> 409', async () => {
        const c = await createCustomer('cp1');
        const o = await mk(A, { user: c._id });
        const res = await custPay(ctx.api.as(c, A), o, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500 });
        expect(res.status).toBe(409);
        expect((await reload(o)).paymentStatus).toBe('Pending');
    });
    test('customer amountPaid / total in body ignored on intent', async () => {
        const c = await createCustomer('cp2');
        const o = await mk(A, { user: c._id });
        await custPay(ctx.api.as(c, A), o, { paymentMethod: 'cash', amountPaid: 500, total: 1 });
        const d = await reload(o);
        expect(d.amountPaid).toBe(0);
        expect(d.total).toBe(500);
        expect(d.paymentMethod).toBe('cash');
    });
    test.each(['bitcoin', 'Refunded', 'mixed', 5, {}])('invalid intent method %p -> 400', async (m) => {
        const c = await createCustomer('cp3');
        const o = await mk(A, { user: c._id });
        const res = await custPay(ctx.api.as(c, A), o, { paymentMethod: m });
        expect(res.status).toBe(400);
    });
    test('invalid paymentStatus (Refunded) from customer -> 400', async () => {
        const c = await createCustomer('cp4');
        const o = await mk(A, { user: c._id });
        const res = await custPay(ctx.api.as(c, A), o, { paymentStatus: 'Refunded' });
        expect(res.status).toBe(400);
    });
    test('customer cannot pay someone else\'s order -> 403', async () => {
        const c = await createCustomer('cp5');
        const other = await createCustomer('cp5o');
        const o = await mk(A, { user: other._id });
        const res = await custPay(ctx.api.as(c, A), o, { paymentMethod: 'cash' });
        expect(res.status).toBe(403);
    });
    test('guest without scan session on owned order -> 401', async () => {
        const c = await createCustomer('cp6');
        const o = await mk(A, { user: c._id });
        const res = await ctx.api.guest(A).patch(`/orders/${o._id}/payment`).set(idem()).send({ paymentMethod: 'cash' });
        expect([401, 403]).toContain(res.status);
    });
    test('intent on an already Paid order -> 400', async () => {
        const c = await createCustomer('cp7');
        const o = await mk(A, { user: c._id, paymentStatus: 'Paid', amountPaid: 500, paymentMethod: 'online' });
        const res = await custPay(ctx.api.as(c, A), o, { paymentMethod: 'cash' });
        expect(res.status).toBe(400);
        expect((await reload(o)).paymentMethod).toBe('online');
    });
    test('Regression (fixed 2026-11): customer can change payment method intent on a CANCELLED order', async () => {
        // Expected: 400 (cancelled order). Actual: intent write succeeds (no cancelled guard in customerPayment).
        const c = await createCustomer('cp8');
        const o = await mk(A, { user: c._id, status: 'cancelled' });
        const res = await custPay(ctx.api.as(c, A), o, { paymentMethod: 'cash' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
    test('Regression (fixed 2026-11): customer can change payment method on a Partially Paid order to cash (hides split money)', async () => {
        // Expected: method locked once money was taken (mixed/online). Actual: overwritten to "cash".
        const c = await createCustomer('cp9');
        const o = await mk(A, { user: c._id, paymentStatus: 'Partially Paid', paymentMethod: 'wallet', amountPaid: 200, walletAmountPaid: 200 });
        await custPay(ctx.api.as(c, A), o, { paymentMethod: 'cash' });
        expect((await reload(o)).paymentMethod).toBe('wallet');
    });
    test('finalize of a non-settled order via Paid -> 409 PAYMENT_NOT_SETTLED', async () => {
        const c = await createCustomer('cp10');
        const o = await mk(A, { user: c._id });
        const res = await custPay(ctx.api.as(c, A), o, { paymentStatus: 'Paid' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_NOT_SETTLED');
    });
    test('wallet-paid finalize awards points once even when called twice in parallel', async () => {
        const c = await createCustomer('cp11');
        const o = await mk(A, { user: c._id, total: 500, paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 500, walletAmountPaid: 500, paidAt: new Date() });
        await Promise.all([1, 2].map(() => custPay(ctx.api.as(c, A), o, { paymentStatus: 'Paid' })));
        await settle(250);
        expect(await Transaction.countDocuments({ order: o._id, type: 'points_earned' })).toBeLessThanOrEqual(1);
    });
    test('finalize without login -> 401', async () => {
        const o = await mk(A, { paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 500 });
        const res = await ctx.api.guest(A).patch(`/orders/${o._id}/payment`).set(idem()).send({ paymentStatus: 'Paid' });
        expect([401, 403]).toContain(res.status);
    });
    test('other tenant customer -> 404/403', async () => {
        const c = await createCustomer('cp12');
        const o = await mk(A, { user: c._id });
        const res = await custPay(ctx.api.as(c, B), o, { paymentMethod: 'cash' });
        expect([403, 404]).toContain(res.status);
    });
});

// ── 10. Counter payment request ──────────────────────────────────────
describe('request-counter-payment', () => {
    const reqCounter = (client, o) => client.post(`/orders/${o._id}/request-counter-payment`).send({});
    test('sets method cash and timestamp on unpaid order', async () => {
        const c = await createCustomer('rc1');
        const o = await mk(A, { user: c._id });
        const res = await reqCounter(ctx.api.as(c, A), o);
        expect(res.status).toBe(200);
        const d = await reload(o);
        expect(d.paymentMethod).toBe('cash');
        expect(d.counterPaymentRequestedAt).toBeTruthy();
        expect(d.paymentStatus).toBe('Pending');
    });
    test('paid order -> 400 ALREADY_PAID', async () => {
        const c = await createCustomer('rc2');
        const o = await mk(A, { user: c._id, paymentStatus: 'Paid', amountPaid: 500 });
        const res = await reqCounter(ctx.api.as(c, A), o);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ALREADY_PAID');
    });
    test('cancelled order -> 400 ORDER_CANCELLED', async () => {
        const c = await createCustomer('rc3');
        const o = await mk(A, { user: c._id, status: 'cancelled' });
        const res = await reqCounter(ctx.api.as(c, A), o);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ORDER_CANCELLED');
    });
    test('Regression (fixed 2026-11): counter request does not overwrite the method of a Partially Paid online/wallet order', async () => {
        // Expected: method preserved (money already taken by wallet/online). Actual: forced to 'cash'.
        const c = await createCustomer('rc4');
        const o = await mk(A, { user: c._id, paymentStatus: 'Partially Paid', paymentMethod: 'wallet', amountPaid: 200, walletAmountPaid: 200 });
        await reqCounter(ctx.api.as(c, A), o);
        expect((await reload(o)).paymentMethod).toBe('wallet');
    });
    test('other customer -> 403', async () => {
        const c = await createCustomer('rc5');
        const other = await createCustomer('rc5o');
        const o = await mk(A, { user: other._id });
        expect((await reqCounter(ctx.api.as(c, A), o)).status).toBe(403);
    });
    test('cross tenant -> 404', async () => {
        const o = await mk();
        expect((await reqCounter(ctx.api.as(B.users.admin, B), o)).status).toBe(404);
    });
});

// ── 11. Coupons ──────────────────────────────────────────────────────
describe('coupon on open order, then pay', () => {
    const mkCoupon = (fields = {}) => Coupon.create({
        restaurant: A.restaurant._id, code: `C${rid().toUpperCase()}`, title: 't',
        discountType: 'percentage', discountValue: 10,
        startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + 30 * DAY), ...fields,
    }).then((c) => c.toObject());
    const apply = (client, o, code) => client.patch(`/orders/${o._id}/coupon`).send({ code });
    test('10% coupon on 500 without tax stamp reduces total by 50', async () => {
        const o = await mk();
        const c = await mkCoupon();
        const res = await apply(cap(), o, c.code);
        expect(res.status).toBe(200);
        expect(res.body.discount).toBe(50);
        expect((await reload(o)).total).toBe(450);
    });
    test('pay exact discounted total after coupon', async () => {
        const o = await mk();
        const c = await mkCoupon();
        await apply(cap(), o, c.code);
        const res = await paid(o, { amountPaid: 450 });
        expect(res.status).toBe(200);
    });
    test('paying the pre-coupon amount after coupon records change (overpay) not error', async () => {
        const o = await mk();
        const c = await mkCoupon();
        await apply(cap(), o, c.code);
        const res = await paid(o, { amountPaid: 500 });
        expect(res.status).toBe(200);
        expect((await reload(o)).payment.changeDue).toBe(50);
    });
    test('coupon on a Paid order -> 400 ORDER_LOCKED', async () => {
        const o = await mk();
        await paid(o);
        const c = await mkCoupon();
        const res = await apply(cap(), o, c.code);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ORDER_LOCKED');
    });
    test('coupon on a cancelled order -> 400', async () => {
        const o = await mk(A, { status: 'cancelled' });
        const c = await mkCoupon();
        expect((await apply(cap(), o, c.code)).status).toBe(400);
    });
    test('Regression (fixed 2026-11): coupon cannot be applied to a Partially Paid order (total drops below amountPaid)', async () => {
        // Expected: 400 ORDER_LOCKED. Actual: only Paid/cancelled are locked, so total can fall below amountPaid.
        const o = await mk(A, { paymentStatus: 'Partially Paid', amountPaid: 400, paymentMethod: 'cash' });
        const c = await mkCoupon({ discountValue: 50 });
        const res = await apply(cap(), o, c.code);
        const d = await reload(o);
        expect(res.status >= 400 || d.total >= d.amountPaid).toBe(true);
    });
    test('expired coupon -> 400', async () => {
        const o = await mk();
        const c = await mkCoupon({ endDate: new Date(Date.now() - 1000) });
        expect((await apply(cap(), o, c.code)).status).toBe(400);
    });
    test('usage limit reached -> 400', async () => {
        const o = await mk();
        const c = await mkCoupon({ usageLimit: 1, usageCount: 1 });
        expect((await apply(cap(), o, c.code)).status).toBe(400);
    });
    test('fixed coupon larger than subtotal is capped so total is not negative', async () => {
        const o = await mk();
        const c = await mkCoupon({ discountType: 'fixed_amount', discountValue: 9999 });
        await apply(cap(), o, c.code);
        expect((await reload(o)).total).toBeGreaterThanOrEqual(0);
    });
    test('Regression (fixed 2026-11): applying a coupon increments / consumes usageCount (limit enforcement)', async () => {
        // Expected: usageCount 0 -> 1 once applied to an order that is then paid, so usageLimit works.
        // Actual: applyCouponToOrder never records usage; the same single-use coupon can be applied to unlimited orders.
        const c = await mkCoupon({ usageLimit: 1, usageCount: 0 });
        const o1 = await mk();
        const o2 = await mk();
        await apply(cap(), o1, c.code);
        await paid(o1, { amountPaid: 450 });
        const res2 = await apply(cap(), o2, c.code);
        expect(res2.status).toBe(400);
    });
    test('waiter cannot apply coupon (role)', async () => {
        const o = await mk();
        const c = await mkCoupon();
        const res = await apply(ctx.api.as(A.users.waiter, A), o, c.code);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
    test('clearing coupon restores total', async () => {
        const o = await mk();
        const c = await mkCoupon();
        await apply(cap(), o, c.code);
        await apply(cap(), o, '');
        expect((await reload(o)).total).toBe(500);
    });
    test('coupon of another tenant -> 404', async () => {
        const o = await mk();
        const c = await Coupon.create({
            restaurant: B.restaurant._id, code: `X${rid().toUpperCase()}`, title: 't', discountType: 'fixed_amount', discountValue: 100,
            startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY),
        });
        expect((await apply(cap(), o, c.code)).status).toBe(404);
    });
});

// ── 12. Bill reopen ──────────────────────────────────────────────────
describe('bill save / reopen vs payment', () => {
    const reopen = (client, o, reason = 'customer asked') => client.post(`/orders/${o._id}/bill/reopen`).send({ reason });
    const finalBill = () => ({ status: 'final', billNo: Math.floor(Math.random() * 1e6), financialYear: '2026-27', total: 500, savedAt: new Date() });
    test('reopen a final unpaid bill -> draft', async () => {
        const o = await mk(A, { bill: finalBill() });
        const res = await reopen(cap(), o);
        expect(res.status).toBe(200);
        expect((await reload(o)).bill.status).toBe('draft');
    });
    test('reopen without reason -> 400 REASON_REQUIRED', async () => {
        const o = await mk(A, { bill: finalBill() });
        const res = await reopen(cap(), o, 'x');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('REASON_REQUIRED');
    });
    test('reopen a non-final bill -> 409', async () => {
        const o = await mk();
        expect((await reopen(cap(), o)).status).toBe(409);
    });
    test('Regression (fixed 2026-11): reopening the bill of a Paid order is rejected', async () => {
        // Expected: 4xx - the bill of a settled order must stay frozen (else amounts can be edited after collection).
        // Actual: reopen flips a Paid order's bill to draft, re-enabling discount/coupon edits post-payment.
        const o = await mk(A, { bill: finalBill() });
        await paid(o);
        const res = await reopen(cap(), o);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
    test('waiter cannot reopen', async () => {
        const o = await mk(A, { bill: finalBill() });
        expect((await reopen(ctx.api.as(A.users.waiter, A), o)).status).toBe(403);
    });
    test('customer cannot reopen', async () => {
        const c = await createCustomer('rb');
        const o = await mk(A, { user: c._id, bill: finalBill() });
        expect((await reopen(ctx.api.as(c, A), o)).status).toBe(403);
    });
    test('reopen keeps payment state untouched', async () => {
        const o = await mk(A, { bill: finalBill(), paymentStatus: 'Partially Paid', amountPaid: 100 });
        await reopen(cap(), o);
        const d = await reload(o);
        expect(d.paymentStatus).toBe('Partially Paid');
        expect(d.amountPaid).toBe(100);
    });
    test('cross tenant reopen -> 404', async () => {
        const o = await mk(A, { bill: finalBill() });
        expect((await reopen(ctx.api.as(B.users.admin, B), o)).status).toBe(404);
    });
});

// ── 13. Rounding / invariants ────────────────────────────────────────
describe('rounding and invariants', () => {
    test.each([
        [0.01], [0.1], [19.99], [1234.56], [99999.99],
    ])('total %p settles exactly and amountPaid === total', async (total) => {
        const o = await mk(A, { total });
        expect((await paid(o, { amountPaid: total })).status).toBe(200);
        expect((await reload(o)).amountPaid).toBe(total);
    });
    test('Regression (fixed 2026-11): amountPaid stored with sub-paise precision is normalised to 2dp', async () => {
        // Expected: 100.00. Actual: 100.0049 persisted verbatim -> report sums drift.
        const o = await mk(A, { total: 100 });
        await paid(o, { amountPaid: 100.0049 });
        expect((await reload(o)).amountPaid).toBe(100);
    });
    test('Regression (fixed 2026-11): tipAmount stored with sub-paise precision is normalised to 2dp', async () => {
        const o = await mk();
        await paid(o, { tipAmount: 10.0049, amountPaid: 511 });
        expect((await reload(o)).tipAmount).toBe(10);
    });
    test('Regression (fixed 2026-11): manualDiscount stored with sub-paise precision is normalised to 2dp', async () => {
        const o = await mk();
        await paid(o, { manualDiscount: 10.0049, amountPaid: 490 });
        expect((await reload(o)).manualDiscount).toBe(10);
    });
    test('cash settle of an enormous bill does not lose precision (9,999,999.99)', async () => {
        const o = await mk(A, { total: 9999999.99 });
        expect((await paid(o)).status).toBe(200);
        expect((await reload(o)).amountPaid).toBe(9999999.99);
    });
    test('payment.amount equals due after discount for every settle', async () => {
        const o = await mk(A, { total: 777.77 });
        await paid(o, { manualDiscount: 77.77, amountPaid: 700 });
        expect((await reload(o)).payment.amount).toBe(700);
    });
    test('paidAt set once; second rejected settle does not move it', async () => {
        const o = await mk();
        await paid(o);
        const first = (await reload(o)).paidAt;
        await paid(o);
        expect(String((await reload(o)).paidAt)).toBe(String(first));
    });
    test('Partially Paid order: settle Paid for the remaining due only', async () => {
        const o = await mk(A, { paymentStatus: 'Partially Paid', amountPaid: 200, paymentMethod: 'wallet', walletAmountPaid: 200 });
        const res = await paid(o, { amountPaid: 300 });
        expect(res.status).toBe(200);
    });
    test('Partially Paid order: settle Paid for less than the remaining due -> AMOUNT_TOO_LOW', async () => {
        const o = await mk(A, { paymentStatus: 'Partially Paid', amountPaid: 200, paymentMethod: 'wallet', walletAmountPaid: 200 });
        const res = await paid(o, { amountPaid: 100 });
        expect(res.status).toBe(400);
        expect(res.body.amountDue).toBe(300);
    });
    test('Regression (fixed 2026-11): after settling a Partially Paid order, amountPaid reflects the cumulative collected (500), not just the last leg', async () => {
        // Expected: 500 (200 wallet + 300 cash) so amountPaid === total. Actual: single-method path
        // $sets amountPaid=300 (the last leg), under-reporting collected revenue by the wallet part.
        const o = await mk(A, { paymentStatus: 'Partially Paid', amountPaid: 200, paymentMethod: 'wallet', walletAmountPaid: 200 });
        await paid(o, { amountPaid: 300 });
        expect((await reload(o)).amountPaid).toBe(500);
    });
});
