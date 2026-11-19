/**
 * STRICT payments / money reconciliation: daily cash closing
 *   /cash-closings (preview, open, close, amend, list, getOne)
 *
 * Every test owns a distinct business date so closings never collide.
 * Times are IST (UTC+05:30, no DST). Tests whose names start with "BUG:" pin a
 * real defect and are expected to FAIL until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(BACKEND, 'models', n));
const Order = M('order'); const Expense = M('expense'); const CashClosing = M('cashClosing');
const Branch = M('branch'); const Supplier = M('supplier'); const SupplierInvoice = M('supplierInvoice');
const SupplierPayment = M('supplierPayment'); const PurchaseOrder = M('purchaseOrder');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const IST = 330 * 60 * 1000;
const ist = (ymd, hh = 0, mm = 0, ss = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 - IST);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let dayCounter = 0;
const nextDay = () => addDays('2023-01-01', ++dayCounter * 3); // gaps so prev/next-day fixtures never share a date

let T; let B2; let manager; let sub2; let subMain;

beforeAll(async () => {
    T = await seedTenant({ label: 'rc-cash' });
    B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'B2', slug: 'b2', isActive: true });
    manager = await createUser({ name: 'mgr', email: `mgr.${rid()}@staff.test`, role: 'manager', restaurant: T.restaurant._id, branch: null, permissions: defaultPermissionsForRole('manager') });
    sub2 = await createUser({ name: 'sub2', email: `sub2.${rid()}@staff.test`, role: 'admin', restaurant: T.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('admin') });
    subMain = await createUser({ name: 'subm', email: `subm.${rid()}@staff.test`, role: 'admin', restaurant: T.restaurant._id, branch: T.branch._id, permissions: defaultPermissionsForRole('admin') });
});

/** Paid order with explicit tender lines, bill time `at`. */
async function pay(t, at, lines, extra = {}) {
    const paid = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    return Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `RC-${rid()}`, type: 'takeaway',
        items: [{ name: 'Item', price: paid, quantity: 1 }], total: paid, status: 'served', paymentStatus: 'Paid',
        paymentMethod: lines.length > 1 ? 'mixed' : lines[0].method, amountPaid: paid, paidAt: at,
        payments: lines.map((l) => ({ method: l.method, amount: l.amount, at })),
        ...extra,
    });
}
const cash = (t, at, amount, extra) => pay(t, at, [{ method: 'cash', amount }], extra);
const close = (user, body) => ctx.api.as(user).post('/cash-closings/close').send(body);
const open = (user, body) => ctx.api.as(user).post('/cash-closings/open').send(body);
const preview = (user, q) => ctx.api.as(user).get(`/cash-closings/preview?${new URLSearchParams(q)}`);

describe('close totals = sum of that day\'s cash tenders', () => {
    test('only cash tenders count; upi / card / wallet / razorpay do not', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 300);
        await pay(T, ist(d, 13), [{ method: 'upi', amount: 200 }]);
        await pay(T, ist(d, 14), [{ method: 'card', amount: 100 }]);
        await pay(T, ist(d, 15), [{ method: 'wallet', amount: 50 }]);
        await pay(T, ist(d, 16), [{ method: 'razorpay', amount: 75 }]);
        const res = await close(T.users.admin, { businessDate: d, countedCash: 300 });
        expect(res.status).toBe(200);
        expect(res.body.closing.cashSales).toBe(300);
        expect(res.body.closing.expectedCash).toBe(300);
        expect(res.body.closing.variance).toBe(0);
    });

    test('split tender: only the cash line of a mixed order counts', async () => {
        const d = nextDay();
        await pay(T, ist(d, 12), [{ method: 'cash', amount: 150 }, { method: 'upi', amount: 350 }]);
        const res = await preview(T.users.admin, { businessDate: d });
        expect(res.body.cashSales).toBe(150);
    });

    test('legacy order (no payments[]) paid in cash is counted from amountPaid', async () => {
        const d = nextDay();
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RC-${rid()}`, type: 'takeaway',
            items: [{ name: 'I', price: 250, quantity: 1 }], total: 250, status: 'served', paymentStatus: 'Paid',
            paymentMethod: 'cash', amountPaid: 250, paidAt: ist(d, 12),
        });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(250);
    });

    test('many small tenders sum without float drift (0.1 x 3, 33.33 x 3)', async () => {
        const d = nextDay();
        for (let i = 0; i < 3; i++) await cash(T, ist(d, 10 + i), 0.1);
        for (let i = 0; i < 3; i++) await cash(T, ist(d, 14 + i), 33.33);
        const res = await close(T.users.admin, { businessDate: d, countedCash: 100.29 });
        expect(res.body.closing.cashSales).toBe(100.29);
        expect(res.body.closing.variance).toBe(0);
    });

    test('a partially paid bill contributes only the cash actually taken', async () => {
        const d = nextDay();
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RC-${rid()}`, type: 'dine-in',
            items: [{ name: 'I', price: 300, quantity: 1 }], total: 300, status: 'served', paymentStatus: 'Partially Paid',
            paymentMethod: 'cash', amountPaid: 100, paidAt: ist(d, 12), payments: [{ method: 'cash', amount: 100, at: ist(d, 12) }],
        });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(100);
    });

    test('unpaid / open orders add nothing to expected cash', async () => {
        const d = nextDay();
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RC-${rid()}`, type: 'dine-in',
            items: [{ name: 'I', price: 900, quantity: 1 }], total: 900, status: 'preparing', paymentStatus: 'Pending',
        });
        const res = await close(T.users.admin, { businessDate: d, countedCash: 0 });
        expect(res.status).toBe(200);
        expect(res.body.closing.cashSales).toBe(0);
        expect(res.body.closing.expectedCash).toBe(0);
    });

    test('a cancelled order whose cash was NOT refunded still counts (cash is physically in the drawer)', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 400, { status: 'cancelled' });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(400);
    });

    test('zero / negative tender lines never inflate cash', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        await Order.collection.insertOne({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RC-${rid()}`, type: 'takeaway', status: 'served',
            paymentStatus: 'Paid', total: 50, amountPaid: 0, paidAt: ist(d, 13),
            payments: [{ method: 'cash', amount: 0, at: ist(d, 13) }, { method: 'cash', amount: -40, at: ist(d, 13) }], items: [],
            createdAt: new Date(), updatedAt: new Date(),
        });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(100);
    });
});

describe('IST day boundaries', () => {
    test('00:00:00.000 IST belongs to the new day, 23:59:59 IST to the old one', async () => {
        const d = nextDay(); const prev = addDays(d, -1); const next = addDays(d, 1);
        await cash(T, ist(d, 0, 0, 0), 10);
        await cash(T, ist(d, 23, 59, 59), 20);
        await cash(T, new Date(ist(d, 0).getTime() - 1), 400);   // 1 ms before d -> prev
        await cash(T, ist(next, 0, 0, 0), 800);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(30);
        expect((await preview(T.users.admin, { businessDate: prev })).body.cashSales).toBe(400);
        expect((await preview(T.users.admin, { businessDate: next })).body.cashSales).toBe(800);
    });

    test('paid at 00:30 IST (= previous UTC date) lands on the IST date, not the UTC date', async () => {
        const d = nextDay();
        await cash(T, ist(d, 0, 30), 55);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(55);
        expect((await preview(T.users.admin, { businessDate: addDays(d, -1) })).body.cashSales).toBe(0);
    });

    test('05:00 IST (=23:30Z previous day) and 05:31 IST are the same IST day', async () => {
        const d = nextDay();
        await cash(T, ist(d, 5, 0), 11);
        await cash(T, ist(d, 5, 31), 22);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(33);
    });

    test('bill created the day before but PAID on d counts on d (paidAt drives it, not createdAt)', async () => {
        const d = nextDay();
        await cash(T, ist(d, 9), 77, { createdAt: ist(addDays(d, -1), 20) });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(77);
        expect((await preview(T.users.admin, { businessDate: addDays(d, -1) })).body.cashSales).toBe(0);
    });

    test('tender lines dated d and d+1 on one order split across the two days (per-line date)', async () => {
        const d = nextDay();
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RC-${rid()}`, type: 'dine-in',
            items: [{ name: 'I', price: 300, quantity: 1 }], total: 300, status: 'served', paymentStatus: 'Paid',
            paymentMethod: 'cash', amountPaid: 300, paidAt: ist(addDays(d, 1), 1),
            payments: [{ method: 'cash', amount: 100, at: ist(d, 22) }, { method: 'cash', amount: 200, at: ist(addDays(d, 1), 1) }],
        });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(100);
        expect((await preview(T.users.admin, { businessDate: addDays(d, 1) })).body.cashSales).toBe(200);
    });

    test('restaurant timezone America/New_York shifts the day window', async () => {
        const Z = await seedTenant({ label: 'rc-ny' });
        await M('restaurant').updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
        // 2023-03-04 22:00 EST = 2023-03-05 03:00Z
        await cash(Z, new Date('2023-03-05T03:00:00Z'), 60);
        expect((await preview(Z.users.admin, { businessDate: '2023-03-04' })).body.cashSales).toBe(60);
        expect((await preview(Z.users.admin, { businessDate: '2023-03-05' })).body.cashSales).toBe(0);
    });

    test('DST spring-forward day (23h long) captures exactly its own orders', async () => {
        const Z = await seedTenant({ label: 'rc-dst' });
        await M('restaurant').updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
        // 2023-03-12: 05:00Z .. 2023-03-13T04:00Z
        await cash(Z, new Date('2023-03-12T04:59:59Z'), 1);
        await cash(Z, new Date('2023-03-12T05:00:00Z'), 2);
        await cash(Z, new Date('2023-03-13T03:59:59Z'), 4);
        await cash(Z, new Date('2023-03-13T04:00:00Z'), 8);
        expect((await preview(Z.users.admin, { businessDate: '2023-03-12' })).body.cashSales).toBe(6);
    });
});

describe('cash refunds and pay-outs', () => {
    test('refund of a cash order reduces expected cash on the day the refund was made', async () => {
        const d = nextDay();
        const o = await cash(T, ist(d, 12), 500);
        await Order.updateOne({ _id: o._id }, { $set: { refundedAmount: 120 }, $push: { refunds: { amount: 120, reason: 'cold', createdAt: ist(d, 15) } } });
        const res = await close(T.users.admin, { businessDate: d, countedCash: 380, openingCash: 0 });
        expect(res.body.closing).toMatchObject({ cashSales: 500, cashRefunds: 120, expectedCash: 380, variance: 0 });
    });

    test('refund made the NEXT day hits the next day, not the sale day', async () => {
        const d = nextDay();
        const o = await cash(T, ist(d, 12), 500);
        await Order.updateOne({ _id: o._id }, { $push: { refunds: { amount: 200, createdAt: ist(addDays(d, 1), 10) } } });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashRefunds).toBe(0);
        const next = (await preview(T.users.admin, { businessDate: addDays(d, 1) })).body;
        expect(next.cashRefunds).toBe(200);
        expect(next.expectedCash).toBe(-200);
    });

    test('refund of a UPI order does not touch the cash drawer', async () => {
        const d = nextDay();
        const o = await pay(T, ist(d, 12), [{ method: 'upi', amount: 500 }]);
        await Order.updateOne({ _id: o._id }, { $push: { refunds: { amount: 500, createdAt: ist(d, 13) } } });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashRefunds).toBe(0);
    });

    test('several refunds on one order are all counted, zero-amount refunds ignored', async () => {
        const d = nextDay();
        const o = await cash(T, ist(d, 12), 600);
        await Order.updateOne({ _id: o._id }, { $push: { refunds: { $each: [{ amount: 100, createdAt: ist(d, 13) }, { amount: 50.5, createdAt: ist(d, 14) }, { amount: 0, createdAt: ist(d, 15) }] } } });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashRefunds).toBe(150.5);
    });

    test('cancelled-and-fully-refunded cash order nets to zero in the drawer', async () => {
        const d = nextDay();
        const o = await cash(T, ist(d, 12), 250, { status: 'cancelled' });
        await Order.updateOne({ _id: o._id }, { $push: { refunds: { amount: 250, createdAt: ist(d, 13) } } });
        const p = (await preview(T.users.admin, { businessDate: d })).body;
        expect(p.cashSales - p.cashRefunds).toBe(0);
        expect(p.expectedCash).toBe(0);
    });

    test('expected = opening + sales - refunds - cash expenses - cash supplier payments - cash PO payments', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 1000);
        await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 13), amount: 120, category: 'Gas', method: 'cash' });
        await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 13), amount: 999, category: 'Rent', method: 'upi' });
        const sup = await Supplier.create({ restaurant: T.restaurant._id, code: `S${rid()}`, name: 'Veg' });
        const inv = await SupplierInvoice.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: `I-${rid()}`, invoiceDate: ist(d, 8), dueDate: ist(d, 8), businessDate: d, subtotal: 500, tax: 0, total: 500, amountPaid: 150, status: 'partial' });
        await SupplierPayment.create({ restaurant: T.restaurant._id, branch: T.branch._id, invoice: inv._id, supplier: sup._id, amount: 80, method: 'cash', date: ist(d, 14), businessDate: d });
        await SupplierPayment.create({ restaurant: T.restaurant._id, branch: T.branch._id, invoice: inv._id, supplier: sup._id, amount: 70, method: 'bank-transfer', date: ist(d, 14), businessDate: d });
        const po = await PurchaseOrder.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, status: 'received', orderDate: ist(d, 7), items: [], payments: [{ amount: 30, mode: 'cash', paidAt: ist(d, 15) }, { amount: 40, mode: 'upi', paidAt: ist(d, 15) }] }).catch((e) => e);
        const poOk = !(po instanceof Error);
        const res = await close(T.users.admin, { businessDate: d, openingCash: 200, countedCash: 1000 });
        expect(res.status).toBe(200);
        const paidOuts = 120 + 80 + (poOk ? 30 : 0);
        expect(res.body.closing.cashPaidOuts).toBe(paidOuts);
        expect(res.body.closing.expectedCash).toBe(200 + 1000 - paidOuts);
        expect(res.body.closing.variance).toBe(1000 - (200 + 1000 - paidOuts));
    });

    test('a voided expense is excluded from the drawer maths', async () => {
        const d = nextDay();
        const e = await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 13), amount: 300, category: 'Misc', method: 'cash' });
        expect((await preview(T.users.admin, { businessDate: d })).body.cashPaidOuts).toBe(300);
        const v = await ctx.api.as(T.users.admin).post(`/ledger/expenses/${e._id}/void`).send({ reason: 'dup' });
        expect(v.status).toBe(200);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashPaidOuts).toBe(0);
    });

    test('expense booked through the API with a backdated date lands on that date\'s drawer', async () => {
        const d = nextDay();
        const r = await ctx.api.as(T.users.admin).post('/ledger/expenses').send({ amount: 45.5, method: 'cash', category: 'Ice', date: ist(d, 11).toISOString() });
        expect(r.status).toBe(201);
        expect(r.body.expense.businessDate).toBe(d);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashPaidOuts).toBe(45.5);
    });

    test('expense dated 23:59 IST vs 00:01 IST next day gets the right businessDate', async () => {
        const d = nextDay();
        const a = await ctx.api.as(T.users.admin).post('/ledger/expenses').send({ amount: 1, date: ist(d, 23, 59).toISOString() });
        const b = await ctx.api.as(T.users.admin).post('/ledger/expenses').send({ amount: 1, date: ist(addDays(d, 1), 0, 1).toISOString() });
        expect(a.body.expense.businessDate).toBe(d);
        expect(b.body.expense.businessDate).toBe(addDays(d, 1));
    });
});

describe('expected vs counted variance', () => {
    test('short drawer gives a negative variance, over gives positive, exact gives 0', async () => {
        const d1 = nextDay(); const d2 = nextDay(); const d3 = nextDay();
        for (const d of [d1, d2, d3]) await cash(T, ist(d, 12), 1000);
        expect((await close(T.users.admin, { businessDate: d1, countedCash: 940 })).body.closing.variance).toBe(-60);
        expect((await close(T.users.admin, { businessDate: d2, countedCash: 1010.5 })).body.closing.variance).toBe(10.5);
        expect((await close(T.users.admin, { businessDate: d3, countedCash: 1000 })).body.closing.variance).toBe(0);
    });

    test('counted cash of exactly 0 is accepted and gives variance = -expected', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 80);
        const res = await close(T.users.admin, { businessDate: d, countedCash: 0 });
        expect(res.status).toBe(200);
        expect(res.body.closing.countedCash).toBe(0);
        expect(res.body.closing.variance).toBe(-80);
    });

    test('countedCash given as a numeric string is parsed; decimals rounded to 2dp', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        const res = await close(T.users.admin, { businessDate: d, countedCash: '99.999' });
        expect(res.body.closing.countedCash).toBe(100);
        expect(res.body.closing.variance).toBe(0);
    });

    test.each([[undefined], [''], [null], [-1], [-0.01], ['abc'], ['1,000']])('countedCash=%p is rejected with 400 and nothing is saved', async (v) => {
        const d = nextDay();
        const res = await close(T.users.admin, { businessDate: d, countedCash: v });
        expect(res.status).toBe(400);
        expect(await CashClosing.countDocuments({ restaurant: T.restaurant._id, businessDate: d })).toBe(0);
    });

    test('Regression (fixed 2026-11): countedCash=true is coerced to 1 instead of rejected', async () => {
        // Expected: 400 INVALID_AMOUNT. Actual: isMoney() uses Number(v), so true -> 1 passes and a ₹1 count is saved.
        const d = nextDay();
        const res = await close(T.users.admin, { businessDate: d, countedCash: true });
        expect(res.status).toBe(400);
    });

    test('Regression (fixed 2026-11): countedCash=[] (empty array) is coerced to 0 instead of rejected', async () => {
        // Expected: 400. Actual: Number([]) === 0 so a zero count is recorded and a full-drawer shortage booked.
        const d = nextDay();
        const res = await close(T.users.admin, { businessDate: d, countedCash: [] });
        expect(res.status).toBe(400);
    });

    test('negative openingCash on close without open record never yields a negative opening', async () => {
        const d = nextDay();
        const res = await close(T.users.admin, { businessDate: d, countedCash: 0, openingCash: -500 });
        expect(res.status).toBe(200);
        expect(res.body.closing.openingCash).toBe(0);
        expect(res.body.closing.expectedCash).toBe(0);
    });

    test('notes truncated to 500 chars; object notes do not crash', async () => {
        const d = nextDay(); const d2 = nextDay();
        const r1 = await close(T.users.admin, { businessDate: d, countedCash: 0, notes: 'x'.repeat(900) });
        expect(r1.body.closing.notes).toHaveLength(500);
        const r2 = await close(T.users.admin, { businessDate: d2, countedCash: 0, notes: { $ne: 1 } });
        expect(r2.status).toBeLessThan(500);
    });
});

describe('open / close lifecycle', () => {
    test('open then close uses the stored openingCash and ignores a different one in the close body', async () => {
        const d = nextDay();
        expect((await open(T.users.admin, { businessDate: d, openingCash: 500 })).status).toBe(201);
        await cash(T, ist(d, 12), 100);
        const res = await close(T.users.admin, { businessDate: d, openingCash: 99999, countedCash: 600 });
        expect(res.body.closing.openingCash).toBe(500);
        expect(res.body.closing.expectedCash).toBe(600);
        expect(res.body.closing.status).toBe('closed');
        expect(await CashClosing.countDocuments({ restaurant: T.restaurant._id, businessDate: d })).toBe(1);
    });

    test('opening twice is 409 and keeps the first row', async () => {
        const d = nextDay();
        await open(T.users.admin, { businessDate: d, openingCash: 10 });
        const again = await open(T.users.admin, { businessDate: d, openingCash: 20 });
        expect(again.status).toBe(409);
        expect((await CashClosing.find({ restaurant: T.restaurant._id, businessDate: d }).lean()).map((c) => c.openingCash)).toEqual([10]);
    });

    test('opening a day that is already closed is 409', async () => {
        const d = nextDay();
        await close(T.users.admin, { businessDate: d, countedCash: 0 });
        expect((await open(T.users.admin, { businessDate: d, openingCash: 5 })).status).toBe(409);
    });

    test('closing twice is 409 and the first record is untouched', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        const first = await close(T.users.admin, { businessDate: d, countedCash: 100, notes: 'first' });
        await cash(T, ist(d, 18), 900);
        const second = await close(T.users.admin, { businessDate: d, countedCash: 1000, notes: 'second' });
        expect(second.status).toBe(409);
        const row = await CashClosing.findById(first.body.closing._id).lean();
        expect(row.notes).toBe('first');
        expect(row.cashSales).toBe(100);
        expect(row.countedCash).toBe(100);
    });

    test('closing an open day twice is also 409 (open -> close -> close)', async () => {
        const d = nextDay();
        await open(T.users.admin, { businessDate: d, openingCash: 0 });
        expect((await close(T.users.admin, { businessDate: d, countedCash: 0 })).status).toBe(200);
        expect((await close(T.users.admin, { businessDate: d, countedCash: 0 })).status).toBe(409);
    });

    test('two simultaneous closes of an open day: exactly one wins, one row, consistent totals', async () => {
        const d = nextDay();
        await open(T.users.admin, { businessDate: d, openingCash: 0 });
        await cash(T, ist(d, 12), 250);
        const [a, b] = await Promise.all([
            close(T.users.admin, { businessDate: d, countedCash: 250 }),
            close(manager, { businessDate: d, countedCash: 250 }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const rows = await CashClosing.find({ restaurant: T.restaurant._id, businessDate: d }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].cashSales).toBe(250);
    });

    test('two simultaneous closes with NO prior open: one 200 and one 409, one row', async () => {
        const d = nextDay();
        const [a, b] = await Promise.all([
            close(T.users.admin, { businessDate: d, countedCash: 0 }),
            close(T.users.admin, { businessDate: d, countedCash: 0 }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect(await CashClosing.countDocuments({ restaurant: T.restaurant._id, businessDate: d })).toBe(1);
    });

    test('opening cash defaults to the last closed day\'s counted cash (not expected)', async () => {
        const base = nextDay();
        await cash(T, ist(base, 12), 100);
        await close(T.users.admin, { businessDate: base, countedCash: 95 });
        const r = await open(T.users.admin, { businessDate: addDays(base, 1) });
        expect(r.body.closing.openingCash).toBe(95);
    });

    test('opening cash default skips days that are only open (never closed)', async () => {
        const base = nextDay();
        await close(T.users.admin, { businessDate: base, countedCash: 70 });
        await open(T.users.admin, { businessDate: addDays(base, 1), openingCash: 9999 });
        const r = await open(T.users.admin, { businessDate: addDays(base, 2) });
        expect(r.body.closing.openingCash).toBe(70);
    });

    test('opening cash default is 0 for the very first day', async () => {
        const Z = await seedTenant({ label: 'rc-first' });
        const r = await open(Z.users.admin, { businessDate: '2023-01-05' });
        expect(r.status).toBe(201);
        expect(r.body.closing.openingCash).toBe(0);
    });

    test.each([[-1], ['abc']])('open with openingCash=%p is rejected', async (v) => {
        const res = await open(T.users.admin, { businessDate: nextDay(), openingCash: v });
        expect(res.status).toBe(400);
    });

    test('future business date is refused for preview, open and close', async () => {
        const f = addDays(new Date().toISOString().slice(0, 10), 3);
        expect((await preview(T.users.admin, { businessDate: f })).status).toBe(400);
        expect((await open(T.users.admin, { businessDate: f })).status).toBe(400);
        expect((await close(T.users.admin, { businessDate: f, countedCash: 0 })).status).toBe(400);
    });

    test.each([['2023-02-30'], ['2023-13-01'], ['2023-1-1'], ['yesterday'], ['2023-03-01T00:00:00Z']])('malformed businessDate %p is 400', async (v) => {
        expect((await preview(T.users.admin, { businessDate: v })).status).toBe(400);
        expect((await close(T.users.admin, { businessDate: v, countedCash: 0 })).status).toBe(400);
    });

    test('closed snapshot is frozen; later cash sales change the live preview but not the record', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        const c = await close(T.users.admin, { businessDate: d, countedCash: 100 });
        await cash(T, ist(d, 20), 50);
        const live = (await preview(T.users.admin, { businessDate: d })).body;
        expect(live.status).toBe('closed');
        expect(live.cashSales).toBe(150);
        const stored = await CashClosing.findById(c.body.closing._id).lean();
        expect(stored.cashSales).toBe(100);
        expect(stored.expectedCash).toBe(100);
    });

    test('preview agrees with the close figures when nothing changes in between', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 321.45);
        await Expense.create({ restaurant: T.restaurant._id, branch: null, businessDate: d, date: ist(d, 13), amount: 21.45, category: 'x', method: 'cash' });
        const p = (await preview(T.users.admin, { businessDate: d, openingCash: 50 })).body;
        const c = (await close(T.users.admin, { businessDate: d, openingCash: 50, countedCash: p.expectedCash })).body.closing;
        for (const k of ['openingCash', 'cashSales', 'cashRefunds', 'cashPaidOuts', 'expectedCash']) expect(c[k]).toBe(p[k]);
        expect(c.variance).toBe(0);
    });

    test('closing stores who closed it and when', async () => {
        const d = nextDay();
        const res = await close(manager, { businessDate: d, countedCash: 0 });
        expect(String(res.body.closing.closedBy)).toBe(String(manager._id));
        expect(new Date(res.body.closing.closedAt).getTime()).toBeGreaterThan(Date.now() - 60000);
    });
});

describe('amending a closing', () => {
    test('manager may amend an OPEN day, but not a CLOSED one (admin only)', async () => {
        const d = nextDay(); const d2 = nextDay();
        const o = await open(T.users.admin, { businessDate: d, openingCash: 100 });
        const ok = await ctx.api.as(manager).patch(`/cash-closings/${o.body.closing._id}`).send({ openingCash: 120 });
        expect(ok.status).toBe(200);
        expect(ok.body.closing.openingCash).toBe(120);
        const c = await close(T.users.admin, { businessDate: d2, countedCash: 0 });
        const no = await ctx.api.as(manager).patch(`/cash-closings/${c.body.closing._id}`).send({ countedCash: 5, reason: 'x' });
        expect(no.status).toBe(403);
        expect((await CashClosing.findById(c.body.closing._id).lean()).countedCash).toBe(0);
    });

    test('closed-day amend needs a reason; with one, expected/variance are recomputed and the edit trail records before/after', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 1000);
        const c = await close(T.users.admin, { businessDate: d, openingCash: 100, countedCash: 1000 });
        expect(c.body.closing.variance).toBe(-100);
        const id = c.body.closing._id;
        expect((await ctx.api.as(T.users.admin).patch(`/cash-closings/${id}`).send({ countedCash: 1100 })).status).toBe(400);
        const ok = await ctx.api.as(T.users.admin).patch(`/cash-closings/${id}`).send({ countedCash: 1100, reason: 'recount' });
        expect(ok.status).toBe(200);
        expect(ok.body.closing.variance).toBe(0);
        expect(ok.body.closing.expectedCash).toBe(1100);
        expect(ok.body.closing.edits).toHaveLength(1);
        expect(ok.body.closing.edits[0].before.variance).toBe(-100);
        expect(ok.body.closing.edits[0].after.variance).toBe(0);
        expect(ok.body.closing.edits[0].reason).toBe('recount');
    });

    test('amending opening cash of a closed day moves expected and variance together; sales snapshot untouched', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 500);
        const c = await close(T.users.admin, { businessDate: d, openingCash: 100, countedCash: 600 });
        const r = await ctx.api.as(T.users.admin).patch(`/cash-closings/${c.body.closing._id}`).send({ openingCash: 150, reason: 'float was 150' });
        expect(r.body.closing.cashSales).toBe(500);
        expect(r.body.closing.expectedCash).toBe(650);
        expect(r.body.closing.variance).toBe(-50);
    });

    test('amend rejects negative / garbage amounts and records nothing', async () => {
        const d = nextDay();
        const c = await close(T.users.admin, { businessDate: d, countedCash: 10 });
        for (const body of [{ countedCash: -5 }, { openingCash: 'abc' }]) {
            const r = await ctx.api.as(T.users.admin).patch(`/cash-closings/${c.body.closing._id}`).send({ ...body, reason: 'x' });
            expect(r.status).toBe(400);
        }
        expect((await CashClosing.findById(c.body.closing._id).lean()).edits).toHaveLength(0);
    });

    test('amend / getOne of an unknown (well-formed) id is 404', async () => {
        const r1 = await ctx.api.as(T.users.admin).patch('/cash-closings/000000000000000000000000').send({ notes: 'x' });
        expect(r1.status).toBe(404);
        expect((await ctx.api.as(T.users.admin).get('/cash-closings/000000000000000000000000')).status).toBe(404);
    });

    test('Regression (fixed 2026-11): amend / getOne with a malformed id returns 500 (CastError) instead of 404', async () => {
        // Expected: 404 (or 400). Actual: 500 — the controllers do not validate the ObjectId.
        const r2 = await ctx.api.as(T.users.admin).patch('/cash-closings/not-an-id').send({ notes: 'x' });
        const r3 = await ctx.api.as(T.users.admin).get('/cash-closings/not-an-id');
        expect(r2.status).toBeLessThan(500);
        expect(r3.status).toBeLessThan(500);
    });

    test('closed day amended only with notes keeps its variance and logs an edit', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 200);
        const c = await close(T.users.admin, { businessDate: d, countedCash: 190 });
        const r = await ctx.api.as(T.users.admin).patch(`/cash-closings/${c.body.closing._id}`).send({ notes: 'explained', reason: 'note' });
        expect(r.body.closing.variance).toBe(-10);
        expect(r.body.closing.notes).toBe('explained');
        expect(r.body.closing.edits).toHaveLength(1);
    });

    test('amending an open day with a counted figure leaves the day OPEN', async () => {
        const d = nextDay();
        const o = await open(T.users.admin, { businessDate: d, openingCash: 10 });
        const r = await ctx.api.as(T.users.admin).patch(`/cash-closings/${o.body.closing._id}`).send({ countedCash: 10 });
        expect(r.body.closing.status).toBe('open');
    });

    test('Regression (fixed 2026-11): amending countedCash on an OPEN day stores a variance computed without the day\'s live cash sales', async () => {
        // Expected: variance left null until close, or computed against live expected (10 + 500 = 510 -> -500).
        // Actual: amend() uses the open doc's stale cashSales=0, so expected=10, variance=0 although 500 cash was taken.
        const d = nextDay();
        await cash(T, ist(d, 12), 500);
        const o = await open(T.users.admin, { businessDate: d, openingCash: 10 });
        const r = await ctx.api.as(T.users.admin).patch(`/cash-closings/${o.body.closing._id}`).send({ countedCash: 10 });
        expect(r.body.closing.variance === null || r.body.closing.variance === -500).toBe(true);
    });
});

describe('list / getOne', () => {
    test('from/to inclusive on both ends; status filter works', async () => {
        const a = nextDay(); const b = addDays(a, 1); const c = addDays(a, 2);
        await close(T.users.admin, { businessDate: a, countedCash: 0 });
        await open(T.users.admin, { businessDate: b, openingCash: 0 });
        await close(T.users.admin, { businessDate: c, countedCash: 0 });
        const all = await ctx.api.as(T.users.admin).get(`/cash-closings?from=${a}&to=${c}`);
        expect(all.body.closings.map((x) => x.businessDate).sort()).toEqual([a, b, c]);
        const edge = await ctx.api.as(T.users.admin).get(`/cash-closings?from=${b}&to=${b}`);
        expect(edge.body.closings.map((x) => x.businessDate)).toEqual([b]);
        const closed = await ctx.api.as(T.users.admin).get(`/cash-closings?from=${a}&to=${c}&status=closed`);
        expect(closed.body.closings.map((x) => x.businessDate).sort()).toEqual([a, c]);
        const opened = await ctx.api.as(T.users.admin).get(`/cash-closings?from=${a}&to=${c}&status=open`);
        expect(opened.body.closings.map((x) => x.businessDate)).toEqual([b]);
    });

    test('list is newest first and invalid dates are 400', async () => {
        expect((await ctx.api.as(T.users.admin).get('/cash-closings?from=2023-02-30')).status).toBe(400);
        const ok = await ctx.api.as(T.users.admin).get('/cash-closings');
        const ds = ok.body.closings.map((x) => x.businessDate);
        expect([...ds].sort().reverse()).toEqual(ds);
    });

    test('sum of closings\' cashSales equals the sum of the cash orders for those dates', async () => {
        const Z = await seedTenant({ label: 'rc-sum' });
        let expected = 0;
        for (let i = 0; i < 4; i++) {
            const d = addDays('2023-05-01', i);
            await cash(Z, ist(d, 10), 100 + i);
            await cash(Z, ist(d, 11), 20.5);
            await pay(Z, ist(d, 12), [{ method: 'upi', amount: 999 }]);
            expected += 120.5 + i;
            await close(Z.users.admin, { businessDate: d, countedCash: 0 });
        }
        const list = await ctx.api.as(Z.users.admin).get('/cash-closings?from=2023-05-01&to=2023-05-04');
        const sum = list.body.closings.reduce((s, c) => s + c.cashSales, 0);
        expect(Math.round(sum * 100) / 100).toBe(Math.round(expected * 100) / 100);
    });
});

describe('roles', () => {
    test.each(['waiter', 'chef', 'captain'])('%s cannot preview / open / close / list / amend', async (role) => {
        const u = T.users[role];
        const d = nextDay();
        expect((await preview(u, { businessDate: d })).status).toBe(403);
        expect((await open(u, { businessDate: d })).status).toBe(403);
        expect((await close(u, { businessDate: d, countedCash: 0 })).status).toBe(403);
        expect((await ctx.api.as(u).get('/cash-closings')).status).toBe(403);
        expect((await ctx.api.as(u).patch('/cash-closings/000000000000000000000000').send({ notes: 'x' })).status).toBe(403);
        expect(await CashClosing.countDocuments({ restaurant: T.restaurant._id, businessDate: d })).toBe(0);
    });

    test('anonymous requests are refused (4xx) and return no data', async () => {
        const a = await ctx.api.anon().get('/cash-closings');
        const b = await ctx.api.anon().post('/cash-closings/close').send({ countedCash: 0 });
        for (const r of [a, b]) { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); expect(r.body.closings).toBeUndefined(); }
    });

    test('manager and admin can both close', async () => {
        expect((await close(manager, { businessDate: nextDay(), countedCash: 0 })).status).toBe(200);
        expect((await close(T.users.admin, { businessDate: nextDay(), countedCash: 0 })).status).toBe(200);
    });
});

describe('branches', () => {
    test('a branch-pinned admin closes only their branch\'s cash', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        await cash(T, ist(d, 12), 40, { branch: B2._id });
        const mine = await close(sub2, { businessDate: d, countedCash: 40 });
        expect(mine.body.closing.cashSales).toBe(40);
        expect(String(mine.body.closing.branch)).toBe(String(B2._id));
        const main = await close(subMain, { businessDate: d, countedCash: 100 });
        expect(main.body.closing.cashSales).toBe(100);
    });

    test('same date closes independently per branch; tenant-level preview = sum of branches', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        await cash(T, ist(d, 12), 40, { branch: B2._id });
        expect((await close(sub2, { businessDate: d, countedCash: 40 })).status).toBe(200);
        expect((await close(subMain, { businessDate: d, countedCash: 100 })).status).toBe(200);
        expect((await preview(T.users.admin, { businessDate: d })).body.cashSales).toBe(140);
    });

    test('legacy orders with branch=null belong to Main (main-pinned admin counts them, B2 admin does not)', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 33, { branch: null });
        expect((await preview(subMain, { businessDate: d })).body.cashSales).toBe(33);
        expect((await preview(sub2, { businessDate: d })).body.cashSales).toBe(0);
    });

    test('pinned admin cannot widen scope with ?branch=all or ?branch=<other>', async () => {
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        const r1 = await ctx.api.as(sub2).get(`/cash-closings/preview?businessDate=${d}&branch=all`);
        expect(r1.body.cashSales).toBe(0);
        const r2 = await ctx.api.as(sub2).get(`/cash-closings/preview?businessDate=${d}&branch=${T.branch._id}`);
        expect(r2.body.cashSales).toBe(0);
    });

    test('Regression (fixed 2026-11): a branch-pinned admin can read another branch\'s closing by id', async () => {
        // Expected: 404 (list is branch-scoped via strictBranchFilter; getOne should be too). Actual: 200 — only tenantFilter applied.
        const d = nextDay();
        const c = await close(subMain, { businessDate: d, countedCash: 0 });
        const r = await ctx.api.as(sub2).get(`/cash-closings/${c.body.closing._id}`);
        expect(r.status).toBe(404);
    });

    test('Regression (fixed 2026-11): a branch-pinned admin can amend a CLOSED closing of another branch', async () => {
        // Expected: 403/404. Actual: amend() looks up by _id + tenant only, so sub2 rewrites Main's counted cash.
        const d = nextDay();
        await cash(T, ist(d, 12), 100);
        const c = await close(subMain, { businessDate: d, countedCash: 100 });
        const r = await ctx.api.as(sub2).patch(`/cash-closings/${c.body.closing._id}`).send({ countedCash: 1, reason: 'sneaky' });
        expect([403, 404]).toContain(r.status);
        expect((await CashClosing.findById(c.body.closing._id).lean()).countedCash).toBe(100);
    });

    test('a foreign tenant\'s branch id on close is rejected', async () => {
        const Z = await seedTenant({ label: 'rc-foreign' });
        const r = await ctx.api.as(T.users.admin).post('/cash-closings/close').send({ businessDate: nextDay(), countedCash: 0, branch: String(Z.branch._id) });
        expect(r.status).toBe(400);
    });
});
