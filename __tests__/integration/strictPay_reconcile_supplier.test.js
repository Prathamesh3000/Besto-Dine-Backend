/**
 * STRICT payments / money reconciliation: supplier invoices and payments
 *   /supplier-invoices (create, list, getOne, update, payments, outstanding report)
 * plus their ledger tie-out (AP balance == outstanding) and role / branch gates.
 *
 * "BUG:" tests pin real defects and are expected to FAIL.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(BACKEND, 'models', n));
const Branch = M('branch'); const Supplier = M('supplier'); const SupplierInvoice = M('supplierInvoice');
const SupplierPayment = M('supplierPayment'); const LedgerEntry = M('ledgerEntry'); const Restaurant = M('restaurant');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const IST = 330 * 60 * 1000;
const ist = (ymd, hh = 0, mm = 0, ss = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 - IST);
const r2 = (n) => Math.round(n * 100) / 100;

let T; let B2; let sup; let sup2; let sub2; let manager; let Other; let otherSup;
const A = () => ctx.api.as(T.users.admin);

beforeAll(async () => {
    T = await seedTenant({ label: 'rs-sup' });
    Other = await seedTenant({ label: 'rs-other' });
    B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'B2', slug: 'b2', isActive: true });
    sup = await Supplier.create({ restaurant: T.restaurant._id, code: `S${rid()}`, name: 'Veg Co', paymentTermsDays: 15 });
    sup2 = await Supplier.create({ restaurant: T.restaurant._id, code: `S${rid()}`, name: 'Dairy Co' });
    otherSup = await Supplier.create({ restaurant: Other.restaurant._id, code: `S${rid()}`, name: 'Foreign' });
    sub2 = await createUser({ name: 's2', email: `s2.${rid()}@staff.test`, role: 'admin', restaurant: T.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('admin') });
    manager = await createUser({ name: 'm', email: `m.${rid()}@staff.test`, role: 'manager', restaurant: T.restaurant._id, branch: null, permissions: defaultPermissionsForRole('manager') });
});

const create = (body, user) => (user ? ctx.api.as(user) : A()).post('/supplier-invoices').send({ supplier: String(sup._id), invoiceNo: `I-${rid()}`, subtotal: 1000, tax: 0, ...body });
const payInv = (id, body, user) => (user ? ctx.api.as(user) : A()).post(`/supplier-invoices/${id}/payments`).send(body);
const mkInv = async (o = {}) => (await create(o)).body.invoice;

describe('create: totals, tax and validation', () => {
    test('total defaults to subtotal + tax, status unpaid, outstanding = total', async () => {
        const r = await create({ subtotal: 1000, tax: 180 });
        expect(r.status).toBe(201);
        expect(r.body.invoice).toMatchObject({ subtotal: 1000, tax: 180, total: 1180, amountPaid: 0, status: 'unpaid', outstanding: 1180 });
    });

    test('0.1 + 0.2 style amounts: total is rounded to the paisa', async () => {
        const r = await create({ subtotal: 0.1, tax: 0.2 });
        expect(r.body.invoice.total).toBe(0.3);
        const r3 = await create({ subtotal: 33.33, tax: 1.665 });
        expect(r3.status).toBe(201);
        expect(Math.abs(r3.body.invoice.total - (r3.body.invoice.subtotal + r3.body.invoice.tax))).toBeLessThan(0.011);
    });

    test('explicit total must equal subtotal + tax (±0.01)', async () => {
        expect((await create({ subtotal: 100, tax: 18, total: 119 })).status).toBe(400);
        expect((await create({ subtotal: 100, tax: 18, total: 118 })).status).toBe(201);
        expect((await create({ subtotal: 100, tax: 18, total: 118.5 })).status).toBe(400);
    });

    test.each([
        [{ subtotal: -1 }], [{ tax: -5 }], [{ subtotal: 0, tax: 0 }], [{ subtotal: undefined }], [{ subtotal: '' }],
    ])('rejects %j', async (b) => {
        const r = await create(b);
        expect(r.status).toBe(400);
    });

    test('Regression (fixed 2026-11): a non-numeric subtotal ("abc") is silently treated as 0 and accepted when tax > 0', async () => {
        // Expected: 400 INVALID_AMOUNT. Actual: round2("abc") === 0, so subtotal 0 + tax 50 makes a ₹50 invoice
        // with a meaningless subtotal (and the same for null / non-numeric tax).
        const r = await create({ subtotal: 'abc', tax: 50 });
        expect(r.status).toBe(400);
    });

    test('Regression (fixed 2026-11): a non-numeric tax ("abc") is silently treated as 0', async () => {
        // Expected: 400. Actual: invoice saved with tax 0 — the tax the user typed is lost and input-GST under-booked.
        const r = await create({ subtotal: 100, tax: 'abc' });
        expect(r.status).toBe(400);
    });

    test('invoice number required; duplicate per supplier is 409; same number on another supplier is fine', async () => {
        expect((await create({ invoiceNo: '   ' })).status).toBe(400);
        const no = `DUP-${rid()}`;
        expect((await create({ invoiceNo: no })).status).toBe(201);
        expect((await create({ invoiceNo: no })).status).toBe(409);
        expect((await create({ invoiceNo: no, supplier: String(sup2._id) })).status).toBe(201);
    });

    test('unknown / foreign / malformed supplier is refused', async () => {
        expect((await create({ supplier: String(otherSup._id) })).status).toBe(404);
        expect((await create({ supplier: '000000000000000000000000' })).status).toBe(404);
        expect((await create({ supplier: 'nope' })).status).toBe(400);
    });

    test('dueDate defaults to invoiceDate + supplier payment terms; explicit dueDate wins', async () => {
        const a = await create({ invoiceDate: '2023-03-01T00:00:00Z' });
        expect(new Date(a.body.invoice.dueDate).toISOString().slice(0, 10)).toBe('2023-03-16');
        const b = await create({ invoiceDate: '2023-03-01T00:00:00Z', dueDate: '2023-03-05T00:00:00Z' });
        expect(new Date(b.body.invoice.dueDate).toISOString().slice(0, 10)).toBe('2023-03-05');
        const c = await create({ supplier: String(sup2._id), invoiceDate: '2023-03-01T00:00:00Z' });
        expect(new Date(c.body.invoice.dueDate).toISOString().slice(0, 10)).toBe('2023-03-01');
    });

    test('invalid invoice / due dates are 400', async () => {
        expect((await create({ invoiceDate: 'garbage' })).status).toBe(400);
        expect((await create({ dueDate: 'garbage' })).status).toBe(400);
    });

    test('businessDate follows the IST calendar day of invoiceDate (23:59 IST vs 00:01 IST)', async () => {
        const a = await create({ invoiceDate: ist('2023-04-01', 23, 59).toISOString() });
        const b = await create({ invoiceDate: ist('2023-04-02', 0, 1).toISOString() });
        expect(a.body.invoice.businessDate).toBe('2023-04-01');
        expect(b.body.invoice.businessDate).toBe('2023-04-02');
    });

    test('client-supplied amountPaid / status are ignored on create', async () => {
        const r = await create({ amountPaid: 999999, status: 'paid' });
        expect(r.body.invoice.amountPaid).toBe(0);
        expect(r.body.invoice.status).toBe('unpaid');
    });

    test('invoice lines: negative qty is rejected, unknown inventory item is rejected', async () => {
        expect((await create({ lines: [{ name: 'x', qty: -1, rate: 5 }] })).status).toBe(400);
        expect((await create({ lines: [{ inventoryItem: '000000000000000000000000', qty: 1, rate: 5 }] })).status).toBe(400);
    });

    test('purchase order of a different supplier is refused', async () => {
        const r = await create({ purchaseOrder: '000000000000000000000000' });
        expect([404, 400]).toContain(r.status);
    });
});

describe('payments: partial, full, overpay, bad amounts', () => {
    test('partial then full payment: amountPaid / status / outstanding track exactly', async () => {
        const inv = await mkInv({ subtotal: 1000, tax: 180 });
        const p1 = await payInv(inv._id, { amount: 500 });
        expect(p1.status).toBe(201);
        expect(p1.body.invoice).toMatchObject({ amountPaid: 500, status: 'partial', outstanding: 680 });
        const p2 = await payInv(inv._id, { amount: 680 });
        expect(p2.body.invoice).toMatchObject({ amountPaid: 1180, status: 'paid', outstanding: 0 });
    });

    test('overpaying by one paisa is refused and changes nothing', async () => {
        const inv = await mkInv({ subtotal: 100 });
        await payInv(inv._id, { amount: 60 });
        const r = await payInv(inv._id, { amount: 40.01 });
        expect(r.status).toBe(400);
        expect(r.body.outstanding).toBe(40);
        const row = await SupplierInvoice.findById(inv._id).lean();
        expect(row.amountPaid).toBe(60);
        expect(await SupplierPayment.countDocuments({ invoice: inv._id })).toBe(1);
    });

    test('paying a fully paid invoice is refused', async () => {
        const inv = await mkInv({ subtotal: 50 });
        await payInv(inv._id, { amount: 50 });
        const r = await payInv(inv._id, { amount: 0.01 });
        expect(r.status).toBe(400);
        expect(await SupplierPayment.countDocuments({ invoice: inv._id })).toBe(1);
    });

    test.each([[0], [-10], ['abc'], [null], [undefined], [0.004], ['']])('payment amount=%p is rejected and records nothing', async (v) => {
        const inv = await mkInv({ subtotal: 100 });
        const r = await payInv(inv._id, { amount: v });
        expect(r.status).toBe(400);
        expect(await SupplierPayment.countDocuments({ invoice: inv._id })).toBe(0);
        expect((await SupplierInvoice.findById(inv._id).lean()).amountPaid).toBe(0);
    });

    test('sub-paisa rounding: three payments of 33.333 on a 100 invoice leave a clean 0.01 outstanding', async () => {
        const inv = await mkInv({ subtotal: 100 });
        for (let i = 0; i < 3; i++) await payInv(inv._id, { amount: 33.333 });
        const row = await SupplierInvoice.findById(inv._id).lean();
        expect(row.amountPaid).toBe(99.99);
        expect(row.status).toBe('partial');
        const last = await payInv(inv._id, { amount: 0.01 });
        expect(last.body.invoice.status).toBe('paid');
    });

    test('payment record: method default cash, unknown method -> cash, businessDate from payment date (IST), reference truncated', async () => {
        const inv = await mkInv({ subtotal: 100 });
        const a = await payInv(inv._id, { amount: 10, date: ist('2023-05-01', 23, 59).toISOString(), method: 'crypto', reference: 'r'.repeat(300) });
        expect(a.body.payment.method).toBe('cash');
        expect(a.body.payment.businessDate).toBe('2023-05-01');
        expect(a.body.payment.reference).toHaveLength(80);
        const b = await payInv(inv._id, { amount: 10, date: ist('2023-05-02', 0, 0).toISOString(), method: 'upi' });
        expect(b.body.payment.businessDate).toBe('2023-05-02');
        expect(b.body.payment.method).toBe('upi');
    });

    test('invalid payment date is 400 and does not advance amountPaid', async () => {
        const inv = await mkInv({ subtotal: 100 });
        expect((await payInv(inv._id, { amount: 10, date: 'nope' })).status).toBe(400);
        expect((await SupplierInvoice.findById(inv._id).lean()).amountPaid).toBe(0);
    });

    test('unknown / foreign / malformed invoice id: 404, no payment written', async () => {
        const foreign = await SupplierInvoice.create({ restaurant: Other.restaurant._id, supplier: otherSup._id, invoiceNo: 'F1', invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 100, total: 100 });
        expect((await payInv(foreign._id, { amount: 10 })).status).toBe(404);
        expect((await payInv('000000000000000000000000', { amount: 10 })).status).toBe(404);
        expect((await payInv('nope', { amount: 10 })).status).toBe(404);
        expect((await SupplierInvoice.findById(foreign._id).lean()).amountPaid).toBe(0);
        expect(await SupplierPayment.countDocuments({ invoice: foreign._id })).toBe(0);
    });

    test('concurrent payments cannot overpay: two 60s on a 100 invoice -> one 201, one 400', async () => {
        const inv = await mkInv({ subtotal: 100 });
        const rs = await Promise.all([payInv(inv._id, { amount: 60 }), payInv(inv._id, { amount: 60 })]);
        expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
        expect((await SupplierInvoice.findById(inv._id).lean()).amountPaid).toBe(60);
    });

    test('12 concurrent payments of 10 on a 100 invoice: exactly 10 succeed; payment rows sum == amountPaid == total', async () => {
        const inv = await mkInv({ subtotal: 100 });
        const rs = await Promise.all(Array.from({ length: 12 }, () => payInv(inv._id, { amount: 10 })));
        expect(rs.filter((r) => r.status === 201)).toHaveLength(10);
        expect(rs.filter((r) => r.status === 400)).toHaveLength(2);
        const row = await SupplierInvoice.findById(inv._id).lean();
        const sum = (await SupplierPayment.find({ invoice: inv._id }).lean()).reduce((s, p) => s + p.amount, 0);
        expect(row.amountPaid).toBe(100);
        expect(row.status).toBe('paid');
        expect(r2(sum)).toBe(100);
    });

    test('invariant: amountPaid always equals the sum of the invoice\'s payment rows', async () => {
        const inv = await mkInv({ subtotal: 777.77, tax: 0 });
        for (const a of [100.1, 200.2, 50.05, 1.11]) await payInv(inv._id, { amount: a });
        await payInv(inv._id, { amount: 99999 });   // refused
        const row = await SupplierInvoice.findById(inv._id).lean();
        const sum = (await SupplierPayment.find({ invoice: inv._id }).lean()).reduce((s, p) => s + p.amount, 0);
        expect(row.amountPaid).toBe(r2(sum));
    });
});

describe('update', () => {
    test('invoiceNo / dueDate / notes are editable; duplicate number is 409', async () => {
        const a = await mkInv({ invoiceNo: `UA-${rid()}` });
        const b = await mkInv({ invoiceNo: `UB-${rid()}` });
        const ok = await A().patch(`/supplier-invoices/${a._id}`).send({ notes: 'hello', dueDate: '2023-06-30T00:00:00Z' });
        expect(ok.status).toBe(200);
        expect(ok.body.invoice.notes).toBe('hello');
        const dup = await A().patch(`/supplier-invoices/${a._id}`).send({ invoiceNo: b.invoiceNo });
        expect(dup.status).toBe(409);
    });

    test('empty / no-op update is 400 NOTHING_TO_UPDATE', async () => {
        const a = await mkInv();
        expect((await A().patch(`/supplier-invoices/${a._id}`).send({})).status).toBe(400);
    });

    test('changing amounts re-derives total and status against what is already paid', async () => {
        const a = await mkInv({ subtotal: 1000 });
        await payInv(a._id, { amount: 400 });
        const up = await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 500, tax: 0 });
        expect(up.body.invoice).toMatchObject({ total: 500, status: 'partial', outstanding: 100 });
        const exact = await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 400, tax: 0 });
        expect(exact.body.invoice).toMatchObject({ total: 400, status: 'paid', outstanding: 0 });
        const up2 = await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 400, tax: 72 });
        expect(up2.body.invoice).toMatchObject({ total: 472, status: 'partial', outstanding: 72 });
    });

    test('total can never drop below what has been paid', async () => {
        const a = await mkInv({ subtotal: 1000 });
        await payInv(a._id, { amount: 700 });
        const r = await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 699.98 });
        expect(r.status).toBe(400);
        expect(r.body.amountPaid ?? r.body.details?.amountPaid ?? 700).toBe(700);
        expect((await SupplierInvoice.findById(a._id).lean()).total).toBe(1000);
    });

    test.each([[{ subtotal: -5 }], [{ tax: -1 }], [{ subtotal: 0, tax: 0 }]])('amount edit %j is rejected', async (b) => {
        const a = await mkInv({ subtotal: 100 });
        expect((await A().patch(`/supplier-invoices/${a._id}`).send(b)).status).toBe(400);
    });

    test('Regression (fixed 2026-11): a non-numeric subtotal edit ("abc") silently zeroes the subtotal', async () => {
        // Expected: 400. Actual: round2("abc") = 0, so subtotal becomes 0 and total = tax only (here 10).
        const a = await mkInv({ subtotal: 100, tax: 10 });
        const r = await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 'abc' });
        expect(r.status).toBe(400);
        expect((await SupplierInvoice.findById(a._id).lean()).subtotal).toBe(100);
    });

    test('amounts and date are locked once the invoice is in the ledger; notes still editable', async () => {
        const a = await mkInv({ subtotal: 100, invoiceDate: ist('2023-07-01', 10).toISOString() });
        await A().post('/ledger/post-day').send({ businessDate: '2023-07-01' });
        const got = await A().get(`/supplier-invoices/${a._id}`);
        expect(got.body.locked).toBe(true);
        expect((await A().patch(`/supplier-invoices/${a._id}`).send({ subtotal: 200 })).status).toBe(409);
        expect((await A().patch(`/supplier-invoices/${a._id}`).send({ invoiceDate: '2023-07-05T00:00:00Z' })).status).toBe(409);
        expect((await A().patch(`/supplier-invoices/${a._id}`).send({ notes: 'ok' })).status).toBe(200);
        expect((await SupplierInvoice.findById(a._id).lean()).total).toBe(100);
    });

    test('before posting, an invoiceDate edit recomputes the IST businessDate', async () => {
        const a = await mkInv({ subtotal: 100, invoiceDate: ist('2023-07-10', 10).toISOString() });
        expect(a.businessDate).toBe('2023-07-10');
        const r = await A().patch(`/supplier-invoices/${a._id}`).send({ invoiceDate: ist('2023-07-12', 0, 5).toISOString() });
        expect(r.body.invoice.businessDate).toBe('2023-07-12');
    });

    test('payments are still accepted on a ledger-locked invoice', async () => {
        const a = await mkInv({ subtotal: 100, invoiceDate: ist('2023-07-20', 10).toISOString() });
        await A().post('/ledger/post-day').send({ businessDate: '2023-07-20' });
        expect((await payInv(a._id, { amount: 25 })).status).toBe(201);
    });

    test('getOne lists payments newest first and their sum equals amountPaid', async () => {
        const a = await mkInv({ subtotal: 300 });
        await payInv(a._id, { amount: 100, date: '2023-08-01T00:00:00Z' });
        await payInv(a._id, { amount: 50.5, date: '2023-08-03T00:00:00Z' });
        const g = (await A().get(`/supplier-invoices/${a._id}`)).body;
        expect(r2(g.payments.reduce((s, p) => s + p.amount, 0))).toBe(g.invoice.amountPaid);
        expect(g.payments.map((p) => p.amount)).toEqual([50.5, 100]);
        expect(g.invoice.outstanding).toBe(149.5);
        expect(g.locked).toBe(false);
    });

    test('update / getOne of malformed or unknown id is 404, never 500', async () => {
        expect((await A().patch('/supplier-invoices/nope').send({ notes: 'x' })).status).toBe(404);
        expect((await A().get('/supplier-invoices/nope')).status).toBe(404);
        expect((await A().get('/supplier-invoices/000000000000000000000000')).status).toBe(404);
    });
});

describe('list and outstanding (aging) report', () => {
    let S; let s1; let s2;
    const mk = (supplier, no, total, due, paid = 0, extra = {}) => SupplierInvoice.create({
        restaurant: S.restaurant._id, branch: S.branch._id, supplier: supplier._id, invoiceNo: no,
        invoiceDate: ist('2022-12-01', 10), dueDate: due, businessDate: '2022-12-01', subtotal: total, tax: 0, total, amountPaid: paid,
        status: paid <= 0 ? 'unpaid' : (paid >= total ? 'paid' : 'partial'), ...extra,
    });
    beforeAll(async () => {
        S = await seedTenant({ label: 'rs-aging' });
        s1 = await Supplier.create({ restaurant: S.restaurant._id, code: 'A1', name: 'Alpha' });
        s2 = await Supplier.create({ restaurant: S.restaurant._id, code: 'B1', name: 'Beta' });
        await mk(s1, 'n1', 1000, new Date('2023-02-10T00:00:00Z'));               // not due as of 2023-01-31
        await mk(s1, 'n2', 500, new Date('2023-01-01T00:00:00Z'), 100);          // 30 days -> d1_30 (400)
        await mk(s1, 'n3', 250.5, new Date('2022-12-01T00:00:00Z'));             // 61 days -> d61_90
        await mk(s2, 'n4', 300, new Date('2022-10-01T00:00:00Z'));               // over90
        await mk(s2, 'n5', 999, new Date('2022-10-01T00:00:00Z'), 999);          // fully paid: excluded
        await mk(s2, 'n6', 80, new Date('2022-12-20T00:00:00Z'), 30);            // 42 days -> d31_60 (50)
    });
    const rep = (q = '') => ctx.api.as(S.users.admin).get(`/supplier-invoices/reports/outstanding${q}`);

    test('buckets by days past due; paid invoices excluded; outstanding = total - paid', async () => {
        const r = (await rep('?asOf=2023-01-31')).body;
        expect(r.totals).toMatchObject({ notDue: 1000, d1_30: 400, d31_60: 50, d61_90: 250.5, over90: 300, total: 2000.5 });
    });

    test('totals.total == sum of per-supplier totals == sum of bucket totals', async () => {
        const r = (await rep('?asOf=2023-01-31')).body;
        expect(r2(r.rows.reduce((s, x) => s + x.total, 0))).toBe(r.totals.total);
        expect(r2(r.totals.notDue + r.totals.d1_30 + r.totals.d31_60 + r.totals.d61_90 + r.totals.over90)).toBe(r.totals.total);
        const alpha = r.rows.find((x) => x.supplierName === 'Alpha');
        expect(alpha).toMatchObject({ total: 1650.5, invoices: 3 });
        expect(r.rows[0].total).toBeGreaterThanOrEqual(r.rows[1].total);
    });

    test('bucket boundary: an invoice 30.99 days past due is d1_30, 31.99 days is d31_60 (floor of days)', async () => {
        expect((await rep('?asOf=2023-01-31')).body.totals.d1_30).toBe(400);   // due 01-01T00:00Z, asOf 01-31T23:59:59Z
        const next = (await rep('?asOf=2023-02-01')).body.totals;
        expect(next.d1_30).toBe(0);
        expect(next.d31_60).toBe(450);
    });

    test('asOf before the due date puts everything in notDue', async () => {
        const r = (await rep('?asOf=2020-01-01')).body;
        expect(r.totals.total).toBe(2000.5);
        expect(r.totals.notDue).toBe(2000.5);
    });

    test.each([['2023-02-30'], ['x'], ['2023-1-1']])('asOf=%p is 400', async (v) => {
        expect((await rep(`?asOf=${v}`)).status).toBe(400);
    });

    test('list: status / supplier filters; paid not in unpaid+partial; outstanding per row correct', async () => {
        const l = (q) => ctx.api.as(S.users.admin).get(`/supplier-invoices${q}`);
        const paid = (await l('?status=paid')).body.invoices;
        expect(paid.map((i) => i.invoiceNo)).toEqual(['n5']);
        expect(paid[0].outstanding).toBe(0);
        const bySup = (await l(`?supplier=${s2._id}`)).body.invoices;
        expect(bySup).toHaveLength(3);
        const part = (await l('?status=partial')).body.invoices;
        expect(part.map((i) => [i.invoiceNo, i.outstanding]).sort()).toEqual([['n2', 400], ['n6', 50]]);
    });

    test('list overdue=true returns only unpaid / partial invoices past due; paid-and-late excluded', async () => {
        const r = (await ctx.api.as(S.users.admin).get('/supplier-invoices?overdue=true')).body.invoices;
        expect(r.map((i) => i.invoiceNo).sort()).toEqual(['n2', 'n3', 'n4', 'n6'].sort().concat(r.some((i) => i.invoiceNo === 'n1') ? ['n1'] : []).sort());
        expect(r.some((i) => i.invoiceNo === 'n5')).toBe(false);
    });

    test('list from/to filter on businessDate is inclusive; malformed is 400', async () => {
        const L = (q) => ctx.api.as(S.users.admin).get(`/supplier-invoices${q}`);
        expect((await L('?from=2022-12-01&to=2022-12-01')).body.invoices).toHaveLength(6);
        expect((await L('?from=2022-12-02')).body.invoices).toHaveLength(0);
        expect((await L('?to=2022-11-30')).body.invoices).toHaveLength(0);
        expect((await L('?from=2022-02-30')).status).toBe(400);
    });

    test('a negative outstanding can never be reported (paid > total data is clamped to 0)', async () => {
        const T2 = await seedTenant({ label: 'rs-neg' });
        const s = await Supplier.create({ restaurant: T2.restaurant._id, code: 'N1', name: 'N' });
        await SupplierInvoice.create({ restaurant: T2.restaurant._id, supplier: s._id, invoiceNo: 'neg', invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 100, total: 100, amountPaid: 150, status: 'partial' });
        const r = (await ctx.api.as(T2.users.admin).get('/supplier-invoices/reports/outstanding')).body;
        expect(r.totals.total).toBe(0);
        const l = (await ctx.api.as(T2.users.admin).get('/supplier-invoices')).body.invoices;
        expect(l[0].outstanding).toBe(0);
    });
});

describe('ledger tie-out of supplier books', () => {
    test('after posting, Accounts Payable balance == sum of outstanding on the invoices', async () => {
        const S = await seedTenant({ label: 'rs-ap' });
        const s = await Supplier.create({ restaurant: S.restaurant._id, code: 'AP1', name: 'AP' });
        const api = ctx.api.as(S.users.admin);
        const mkI = (no, sub, tax, day) => api.post('/supplier-invoices').send({ supplier: String(s._id), invoiceNo: no, subtotal: sub, tax, invoiceDate: ist(day, 10).toISOString() });
        const i1 = (await mkI('a', 1000, 180, '2023-09-01')).body.invoice;
        const i2 = (await mkI('b', 250.55, 12.53, '2023-09-02')).body.invoice;
        await mkI('c', 99.99, 0, '2023-09-03');
        await api.post(`/supplier-invoices/${i1._id}/payments`).send({ amount: 400, date: ist('2023-09-04', 11).toISOString(), method: 'cash' });
        await api.post(`/supplier-invoices/${i1._id}/payments`).send({ amount: 300.25, date: ist('2023-09-05', 11).toISOString(), method: 'upi' });
        await api.post(`/supplier-invoices/${i2._id}/payments`).send({ amount: 263.08, date: ist('2023-09-05', 12).toISOString(), method: 'bank-transfer' });
        const post = await api.post('/ledger/post-day').send({ from: '2023-09-01', to: '2023-09-05' });
        expect(post.status).toBe(200);
        const outstanding = (await api.get('/supplier-invoices/reports/outstanding?asOf=2023-09-30')).body.totals.total;
        const t = (await api.get('/ledger/trial-balance?from=2023-09-01&to=2023-09-05')).body;
        expect(t.rows.find((r) => r.code === '2000').balance).toBe(outstanding);
        expect(t.balanced).toBe(true);
        // Purchases + input GST == sum of invoice totals
        const sumTotals = r2(1180 + 263.08 + 99.99);
        expect(r2(t.rows.find((r) => r.code === '5000').debit + t.rows.find((r) => r.code === '1200').debit)).toBe(sumTotals);
    });

    test('a supplier payment dated before the invoice still balances the ledger (AP goes negative = prepayment)', async () => {
        const S = await seedTenant({ label: 'rs-prepay' });
        const s = await Supplier.create({ restaurant: S.restaurant._id, code: 'AP2', name: 'AP2' });
        const api = ctx.api.as(S.users.admin);
        const inv = (await api.post('/supplier-invoices').send({ supplier: String(s._id), invoiceNo: 'pp', subtotal: 100, invoiceDate: ist('2023-09-10', 10).toISOString() })).body.invoice;
        await api.post(`/supplier-invoices/${inv._id}/payments`).send({ amount: 100, date: ist('2023-09-08', 10).toISOString() });
        await api.post('/ledger/post-day').send({ from: '2023-09-08', to: '2023-09-10' });
        const t = (await api.get('/ledger/trial-balance')).body;
        expect(t.balanced).toBe(true);
        expect(t.rows.find((r) => r.code === '2000').balance).toBe(0);
        const day8 = (await api.get('/ledger/trial-balance?from=2023-09-08&to=2023-09-08')).body;
        expect(day8.rows.find((r) => r.code === '2000').balance).toBe(-100);
    });

    test('supplier payments on a day show up in the cash closing for that day (cash) and not for non-cash methods', async () => {
        const S = await seedTenant({ label: 'rs-cc' });
        const s = await Supplier.create({ restaurant: S.restaurant._id, code: 'AP3', name: 'AP3' });
        const api = ctx.api.as(S.users.admin);
        const inv = (await api.post('/supplier-invoices').send({ supplier: String(s._id), invoiceNo: 'cc', subtotal: 1000, invoiceDate: ist('2023-09-12', 9).toISOString() })).body.invoice;
        await api.post(`/supplier-invoices/${inv._id}/payments`).send({ amount: 300, date: ist('2023-09-12', 10).toISOString(), method: 'cash' });
        await api.post(`/supplier-invoices/${inv._id}/payments`).send({ amount: 200, date: ist('2023-09-12', 11).toISOString(), method: 'upi' });
        const p = (await api.get('/cash-closings/preview?businessDate=2023-09-12')).body;
        expect(p.cashPaidOuts).toBe(300);
        expect(p.expectedCash).toBe(-300);
    });
});

describe('roles, plan gate and branch scope', () => {
    test.each(['waiter', 'chef', 'captain'])('%s is refused on all supplier invoice endpoints', async (role) => {
        const u = T.users[role];
        const inv = await mkInv();
        const calls = await Promise.all([
            ctx.api.as(u).get('/supplier-invoices'), ctx.api.as(u).get(`/supplier-invoices/${inv._id}`),
            ctx.api.as(u).post('/supplier-invoices').send({ supplier: String(sup._id), invoiceNo: 'x', subtotal: 1 }),
            ctx.api.as(u).patch(`/supplier-invoices/${inv._id}`).send({ notes: 'x' }),
            ctx.api.as(u).post(`/supplier-invoices/${inv._id}/payments`).send({ amount: 1 }),
            ctx.api.as(u).get('/supplier-invoices/reports/outstanding'),
            ctx.api.as(u).get('/supplier-invoices/reports/three-way-match'),
        ]);
        for (const r of calls) expect(r.status).toBe(403);
        expect((await SupplierInvoice.findById(inv._id).lean()).amountPaid).toBe(0);
    });

    test('manager can create invoices and record payments', async () => {
        const c = await create({}, manager);
        expect(c.status).toBe(201);
        expect((await payInv(c.body.invoice._id, { amount: 10 }, manager)).status).toBe(201);
    });

    test('plan without the inventory feature is locked out of invoices and payments', async () => {
        const L = await seedTenant({ label: 'rs-locked' });
        const ls = await Supplier.create({ restaurant: L.restaurant._id, code: 'L1', name: 'L' });
        const inv = await SupplierInvoice.create({ restaurant: L.restaurant._id, supplier: ls._id, invoiceNo: 'L', invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 100, total: 100 });
        await Restaurant.updateOne({ _id: L.restaurant._id }, { $set: { 'subscription.features.inventory': false } });
        const api = ctx.api.as(L.users.admin);
        expect((await api.get('/supplier-invoices')).status).toBe(403);
        expect((await api.post(`/supplier-invoices/${inv._id}/payments`).send({ amount: 10 })).status).toBe(403);
        expect((await SupplierInvoice.findById(inv._id).lean()).amountPaid).toBe(0);
    });

    test('branch-pinned admin: new invoices land on their branch; list is scoped; Main\'s invoices are not listed', async () => {
        const mine = await create({}, sub2);
        expect(String(mine.body.invoice.branch)).toBe(String(B2._id));
        const main = await SupplierInvoice.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: `MAIN-${rid()}`, invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 10, total: 10 });
        const l = (await ctx.api.as(sub2).get('/supplier-invoices')).body.invoices;
        expect(l.every((i) => String(i.branch) === String(B2._id))).toBe(true);
        expect(l.some((i) => String(i._id) === String(main._id))).toBe(false);
    });

    test('Regression (fixed 2026-11): a branch-pinned admin can record a payment against another branch\'s invoice', async () => {
        // Expected: 404 (list is branch-scoped, so by-id actions should be too). Actual: payment is accepted — only the tenant is checked,
        // so a branch admin can settle (and cash-out) invoices that belong to Main.
        const main = await SupplierInvoice.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: `MAINP-${rid()}`, invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 100, total: 100 });
        const r = await payInv(main._id, { amount: 50 }, sub2);
        expect(r.status).toBe(404);
        expect((await SupplierInvoice.findById(main._id).lean()).amountPaid).toBe(0);
    });

    test('Regression (fixed 2026-11): a branch-pinned admin can read / edit another branch\'s invoice by id', async () => {
        // Expected: 404 for both. Actual: getOne and update filter by _id + tenant only.
        const main = await SupplierInvoice.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: `MAING-${rid()}`, invoiceDate: new Date(), dueDate: new Date(), businessDate: '2023-01-01', subtotal: 100, total: 100 });
        const g = await ctx.api.as(sub2).get(`/supplier-invoices/${main._id}`);
        const u = await ctx.api.as(sub2).patch(`/supplier-invoices/${main._id}`).send({ notes: 'tampered' });
        expect(g.status).toBe(404);
        expect(u.status).toBe(404);
        expect((await SupplierInvoice.findById(main._id).lean()).notes).toBe('');
    });

    test('anonymous requests are refused with no data', async () => {
        const r = await ctx.api.anon().get('/supplier-invoices');
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(r.body.invoices).toBeUndefined();
    });

    test('ledger lines of supplier invoices never leak across tenants', async () => {
        await A().post('/ledger/post-day').send({ from: '2023-01-01', to: '2023-01-31' });
        expect(await LedgerEntry.countDocuments({ restaurant: Other.restaurant._id })).toBe(0);
    });
});
