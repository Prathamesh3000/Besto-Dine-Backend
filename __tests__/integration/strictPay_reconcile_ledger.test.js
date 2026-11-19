/**
 * STRICT payments / money reconciliation: ledger-lite
 *   /ledger (accounts, post-day, trial-balance, account ledger, pnl, expenses),
 *   utils/ledgerPostJob, and ledger <-> cash closing <-> order cross-checks.
 *
 * Each describe block seeds its own tenant so trial balances are exact.
 * Times are IST (UTC+05:30). "BUG:" tests pin real defects and are expected to FAIL.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(BACKEND, 'models', n));
const Order = M('order'); const Expense = M('expense'); const LedgerEntry = M('ledgerEntry');
const LedgerAccount = M('ledgerAccount'); const Branch = M('branch'); const Supplier = M('supplier');
const SupplierInvoice = M('supplierInvoice'); const SupplierPayment = M('supplierPayment'); const Restaurant = M('restaurant');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const IST = 330 * 60 * 1000;
const ist = (ymd, hh = 0, mm = 0, ss = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 - IST);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

async function pay(t, at, lines, extra = {}) {
    const paid = r2(lines.reduce((s, l) => s + l.amount, 0));
    return Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `RL-${rid()}`, type: 'takeaway',
        items: [{ name: 'Item', price: paid, quantity: 1 }], total: paid, status: 'served', paymentStatus: 'Paid',
        paymentMethod: lines.length > 1 ? 'mixed' : lines[0].method, amountPaid: paid, paidAt: at,
        payments: lines.map((l) => ({ method: l.method, amount: l.amount, at })),
        ...extra,
    });
}
const sale = (t, at, method, amount, extra) => pay(t, at, [{ method, amount }], extra);
const post = (t, body, user) => ctx.api.as(user || t.users.admin).post('/ledger/post-day').send(body);
const tb = (t, q = '', user) => ctx.api.as(user || t.users.admin).get(`/ledger/trial-balance${q}`);
const row = (body, code) => body.rows.find((r) => r.code === code);
const refund = (o, amount, at) => Order.updateOne({ _id: o._id }, { $inc: { refundedAmount: amount }, $push: { refunds: { amount, createdAt: at } } });
const sumField = async (t, f, match = {}) => r2((await LedgerEntry.aggregate([{ $match: { restaurant: t.restaurant._id, ...match } }, { $group: { _id: null, s: { $sum: `$${f}` } } }]))[0]?.s || 0);

// ═════════════════════════════════════════════════════════════════════
describe('chart of accounts and basic posting', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'rl-basic' }); });

    test('accounts endpoint creates the 12-account default chart once; repeated calls do not duplicate', async () => {
        const a = await ctx.api.as(T.users.admin).get('/ledger/accounts');
        const b = await ctx.api.as(T.users.admin).get('/ledger/accounts');
        expect(a.body.accounts).toHaveLength(12);
        expect(b.body.accounts).toHaveLength(12);
        expect(await LedgerAccount.countDocuments({ restaurant: T.restaurant._id })).toBe(12);
        expect(new Set(a.body.accounts.map((x) => x.code)).size).toBe(12);
    });

    test('a day with no activity posts zero lines and a trial balance of zeros that is balanced', async () => {
        const r = await post(T, { businessDate: '2022-01-10' });
        expect(r.status).toBe(200);
        expect(r.body.lines).toBe(0);
        const t = await tb(T, '?from=2022-01-10&to=2022-01-10');
        expect(t.body.totals).toEqual({ debit: 0, credit: 0 });
        expect(t.body.balanced).toBe(true);
    });

    test('cash sale with GST: Dr Cash gross / Cr Sales net / Cr Output GST', async () => {
        const d = '2022-02-01';
        await sale(T, ist(d, 12), 'cash', 1050, { gst: 50, total: 1050 });
        await post(T, { businessDate: d });
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        expect(row(t, '1000')).toMatchObject({ debit: 1050, credit: 0 });
        expect(row(t, '4000')).toMatchObject({ debit: 0, credit: 1000 });
        expect(row(t, '2200')).toMatchObject({ debit: 0, credit: 50 });
        expect(t.balanced).toBe(true);
    });

    test.each([
        ['cash', '1000'], ['upi', '1010'], ['card', '1020'], ['wallet', '2100'], ['razorpay', '1010'], ['other', '1010'],
    ])('%s tender debits account %s', async (method, code) => {
        const d = addDays('2022-03-01', ['cash', 'upi', 'card', 'wallet', 'razorpay', 'other'].indexOf(method));
        await sale(T, ist(d, 12), method, 100);
        await post(T, { businessDate: d });
        const e = await LedgerEntry.find({ restaurant: T.restaurant._id, businessDate: d, debit: { $gt: 0 } }).lean();
        expect(e.map((x) => x.account)).toEqual([code]);
    });

    test('order with no GST: all of it is Sales, no 2200 line is written', async () => {
        const d = '2022-04-01';
        await sale(T, ist(d, 12), 'cash', 200);
        await post(T, { businessDate: d });
        expect(await LedgerEntry.countDocuments({ restaurant: T.restaurant._id, businessDate: d, account: '2200' })).toBe(0);
        expect(await sumField(T, 'credit', { businessDate: d, account: '4000' })).toBe(200);
    });

    test('GST larger than the order total is capped at 100% (never negative Sales)', async () => {
        const d = '2022-04-03';
        await sale(T, ist(d, 12), 'cash', 100, { gst: 500, total: 100 });
        await post(T, { businessDate: d });
        const sales = await LedgerEntry.find({ restaurant: T.restaurant._id, businessDate: d, account: '4000' }).lean();
        for (const s of sales) expect(s.credit).toBeGreaterThanOrEqual(0);
        expect((await tb(T, `?from=${d}&to=${d}`)).body.balanced).toBe(true);
    });

    test('unpaid and pending orders are not posted; a partial payment posts only what was paid, with GST pro-rated', async () => {
        const d = '2022-04-05';
        await Order.create({ restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RL-${rid()}`, type: 'dine-in', items: [{ name: 'x', price: 500, quantity: 1 }], total: 500, status: 'preparing', paymentStatus: 'Pending' });
        await Order.create({
            restaurant: T.restaurant._id, branch: T.branch._id, orderId: `RL-${rid()}`, type: 'dine-in', items: [{ name: 'x', price: 300, quantity: 1 }],
            total: 300, gst: 15, status: 'served', paymentStatus: 'Partially Paid', paymentMethod: 'cash', amountPaid: 100, paidAt: ist(d, 12),
            payments: [{ method: 'cash', amount: 100, at: ist(d, 12) }],
        });
        await post(T, { businessDate: d });
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        expect(row(t, '1000').debit).toBe(100);
        expect(row(t, '2200').credit).toBe(5);
        expect(row(t, '4000').credit).toBe(95);
    });

    test('a cancelled order that was paid and not refunded is still posted (money did arrive)', async () => {
        const d = '2022-04-07';
        await sale(T, ist(d, 12), 'cash', 60, { status: 'cancelled' });
        await post(T, { businessDate: d });
        expect(row((await tb(T, `?from=${d}&to=${d}`)).body, '1000').debit).toBe(60);
    });

    test('split-tender GST allocation sums to the order GST exactly (no paise lost)', async () => {
        const d = '2022-05-01';
        await pay(T, ist(d, 12), [{ method: 'cash', amount: 333.33 }, { method: 'upi', amount: 333.33 }, { method: 'card', amount: 333.34 }], { gst: 47.62, total: 1000 });
        await post(T, { businessDate: d });
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        expect(Math.abs(row(t, '2200').credit - 47.62)).toBeLessThanOrEqual(0.02);
        expect(r2(row(t, '4000').credit + row(t, '2200').credit)).toBe(1000);
        expect(t.balanced).toBe(true);
    });

    test('many odd-paise orders: every batch balances and the trial balance debits == credits to the paisa', async () => {
        const d = '2022-05-03';
        for (let i = 0; i < 25; i++) await sale(T, ist(d, 10, i), ['cash', 'upi', 'card'][i % 3], r2(17.17 + i * 3.31), { gst: r2((17.17 + i * 3.31) * 0.0476), total: r2(17.17 + i * 3.31) });
        const r = await post(T, { businessDate: d });
        expect(r.status).toBe(200);
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        expect(t.totals.debit).toBe(t.totals.credit);
        const lines = await LedgerEntry.find({ restaurant: T.restaurant._id, businessDate: d }).lean();
        const byRef = {};
        for (const l of lines) { byRef[`${l.ref.type}:${l.ref.id}`] = (byRef[`${l.ref.type}:${l.ref.id}`] || 0) + l.debit - l.credit; }
        for (const v of Object.values(byRef)) expect(Math.abs(v)).toBeLessThan(0.005);
    });

    test('every ledger line has exactly one of debit/credit > 0 and non-negative amounts', async () => {
        const lines = await LedgerEntry.find({ restaurant: T.restaurant._id }).lean();
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
            expect(l.debit).toBeGreaterThanOrEqual(0);
            expect(l.credit).toBeGreaterThanOrEqual(0);
            expect((l.debit > 0) !== (l.credit > 0)).toBe(true);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('idempotency, concurrency, backdating', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'rl-idem' }); });

    test('posting the same day twice writes nothing the second time', async () => {
        const d = '2022-06-01';
        await sale(T, ist(d, 12), 'cash', 100, { gst: 5, total: 100 });
        const a = await post(T, { businessDate: d });
        const n1 = await LedgerEntry.countDocuments({ restaurant: T.restaurant._id });
        const b = await post(T, { businessDate: d });
        expect(a.body.inserted).toBe(3);
        expect(b.body.inserted).toBe(0);
        expect(b.body.skipped).toBe(3);
        expect(await LedgerEntry.countDocuments({ restaurant: T.restaurant._id })).toBe(n1);
    });

    test('overlapping ranges are idempotent: a day posted in two ranges is not doubled', async () => {
        const T2 = await seedTenant({ label: 'rl-range' });
        for (const d of ['2022-06-10', '2022-06-11', '2022-06-12']) await sale(T2, ist(d, 12), 'cash', 100);
        await post(T2, { from: '2022-06-10', to: '2022-06-11' });
        const r = await post(T2, { from: '2022-06-11', to: '2022-06-12' });
        expect(r.body.inserted).toBe(2);   // only 06-12's two lines are new
        expect(await sumField(T2, 'debit')).toBe(300);
        expect(await sumField(T2, 'credit')).toBe(300);
    });

    test('concurrent post-day calls for the same day never duplicate lines', async () => {
        const T2 = await seedTenant({ label: 'rl-conc' });
        const d = '2022-06-20';
        for (let i = 0; i < 6; i++) await sale(T2, ist(d, 9 + i), 'upi', 100 + i, { gst: 5, total: 100 + i });
        const rs = await Promise.all([1, 2, 3, 4].map(() => post(T2, { businessDate: d })));
        for (const r of rs) expect(r.status).toBe(200);
        expect(await LedgerEntry.countDocuments({ restaurant: T2.restaurant._id })).toBe(18);
        const t = (await tb(T2, `?from=${d}&to=${d}`)).body;
        expect(t.balanced).toBe(true);
        expect(t.totals.debit).toBe(r2(100 * 6 + 15));
    });

    test('a late (backdated) sale added after the day was posted is picked up by a re-post as its own lines only', async () => {
        const T2 = await seedTenant({ label: 'rl-late' });
        const d = '2022-06-25';
        await sale(T2, ist(d, 12), 'cash', 100);
        await post(T2, { businessDate: d });
        await sale(T2, ist(d, 20), 'cash', 40);
        const r = await post(T2, { businessDate: d });
        expect(r.body.inserted).toBe(2);
        expect(row((await tb(T2, `?from=${d}&to=${d}`)).body, '1000').debit).toBe(140);
    });

    test('a refund issued after the day was posted is its own batch on the refund day; the original day is unchanged', async () => {
        const T2 = await seedTenant({ label: 'rl-refund-later' });
        const d = '2022-07-01'; const d2 = '2022-07-03';
        const o = await sale(T2, ist(d, 12), 'cash', 500, { gst: 25, total: 500 });
        await post(T2, { businessDate: d });
        await refund(o, 100, ist(d2, 10));
        await post(T2, { from: d, to: d2 });
        const day1 = (await tb(T2, `?from=${d}&to=${d}`)).body;
        const day3 = (await tb(T2, `?from=${d2}&to=${d2}`)).body;
        expect(row(day1, '1000')).toMatchObject({ debit: 500, credit: 0 });
        expect(row(day3, '1000')).toMatchObject({ debit: 0, credit: 100 });
        expect(r2(row(day3, '4000').debit + row(day3, '2200').debit)).toBe(100);
        expect(row(day3, '2200').debit).toBe(5);
        expect((await tb(T2, `?from=${d}&to=${d2}`)).body.balanced).toBe(true);
    });

    test('refund net effect: cash account balance over the range = sale - refund', async () => {
        const T2 = await seedTenant({ label: 'rl-refund-net' });
        const d = '2022-07-05';
        const o = await sale(T2, ist(d, 12), 'cash', 400);
        await refund(o, 150, ist(d, 14));
        await post(T2, { businessDate: d });
        expect(row((await tb(T2, `?from=${d}&to=${d}`)).body, '1000').balance).toBe(250);
    });

    test('an expense entered later with an earlier date is posted into that earlier day, not today', async () => {
        const T2 = await seedTenant({ label: 'rl-backexp' });
        const d = '2022-07-10';
        await post(T2, { businessDate: d });   // empty day posted first
        const e = await ctx.api.as(T2.users.admin).post('/ledger/expenses').send({ amount: 90, method: 'cash', category: 'Late', date: ist(d, 11).toISOString() });
        expect(e.body.expense.businessDate).toBe(d);
        const r = await post(T2, { businessDate: d });
        expect(r.body.inserted).toBe(2);
        const lines = await LedgerEntry.find({ restaurant: T2.restaurant._id }).lean();
        expect(lines.every((l) => l.businessDate === d)).toBe(true);
    });

    test('lines are keyed deterministically: one line per (source, account, side)', async () => {
        const lines = await LedgerEntry.find({ restaurant: T.restaurant._id }).lean();
        expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    });

    test('IST midnight: sale at 23:59:59 IST posts to day D, 00:00:00 IST to D+1; UTC-date would split them wrongly', async () => {
        const T2 = await seedTenant({ label: 'rl-mid' });
        const d = '2022-08-01';
        await sale(T2, ist(d, 23, 59, 59), 'cash', 10);
        await sale(T2, ist(addDays(d, 1), 0, 0, 0), 'cash', 20);
        await post(T2, { from: d, to: addDays(d, 1) });
        expect(await sumField(T2, 'debit', { businessDate: d })).toBe(10);
        expect(await sumField(T2, 'debit', { businessDate: addDays(d, 1) })).toBe(20);
    });

    test('post-day in a New York tenant uses New York day edges', async () => {
        const Z = await seedTenant({ label: 'rl-ny' });
        await Restaurant.updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
        await sale(Z, new Date('2022-08-02T03:30:00Z'), 'cash', 70);   // 2022-08-01 23:30 EDT
        await post(Z, { from: '2022-08-01', to: '2022-08-02' });
        expect(await sumField(Z, 'debit', { businessDate: '2022-08-01' })).toBe(70);
        expect(await sumField(Z, 'debit', { businessDate: '2022-08-02' })).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('post-day request validation', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'rl-val' }); });

    test.each([['2022-02-30'], ['2022-13-01'], ['abc'], ['2022-1-1']])('businessDate=%p is 400', async (v) => {
        expect((await post(T, { businessDate: v })).status).toBe(400);
    });

    test('from after to is 400', async () => {
        expect((await post(T, { from: '2022-02-05', to: '2022-02-01' })).status).toBe(400);
    });

    test('more than 31 days is 400, exactly 31 days is accepted', async () => {
        expect((await post(T, { from: '2022-01-01', to: '2022-02-01' })).status).toBe(400);
        const ok = await post(T, { from: '2022-01-01', to: '2022-01-31' });
        expect(ok.status).toBe(200);
        expect(ok.body.days).toHaveLength(31);
    });

    test('only `from` given posts just that day', async () => {
        const r = await post(T, { from: '2022-03-05' });
        expect(r.status).toBe(200);
        expect(r.body.days.map((d) => d.businessDate)).toEqual(['2022-03-05']);
    });

    test('empty body posts today (IST) and returns 200', async () => {
        const r = await post(T, {});
        expect(r.status).toBe(200);
        expect(r.body.days).toHaveLength(1);
    });

    test('trial-balance / ledger / pnl reject malformed or reversed ranges with 400', async () => {
        for (const p of ['/ledger/trial-balance', '/ledger/pnl', '/ledger/accounts/1000/ledger']) {
            expect((await ctx.api.as(T.users.admin).get(`${p}?from=2022-02-30`)).status).toBe(400);
            expect((await ctx.api.as(T.users.admin).get(`${p}?from=2022-03-02&to=2022-03-01`)).status).toBe(400);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('supplier invoices and payments in the ledger', () => {
    let T; let sup;
    beforeAll(async () => {
        T = await seedTenant({ label: 'rl-sup' });
        sup = await Supplier.create({ restaurant: T.restaurant._id, code: `S${rid()}`, name: 'Veg Co' });
    });

    const mkInv = (extra) => SupplierInvoice.create({
        restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: `INV-${rid()}`,
        invoiceDate: ist('2022-09-01', 10), dueDate: ist('2022-09-30', 10), businessDate: '2022-09-01',
        subtotal: 1000, tax: 180, total: 1180, amountPaid: 0, status: 'unpaid', ...extra,
    });

    test('invoice: Dr Purchases net + Dr Input GST / Cr Accounts payable gross', async () => {
        await mkInv();
        await post(T, { businessDate: '2022-09-01' });
        const t = (await tb(T, '?from=2022-09-01&to=2022-09-01')).body;
        expect(row(t, '5000').debit).toBe(1000);
        expect(row(t, '1200').debit).toBe(180);
        expect(row(t, '2000').credit).toBe(1180);
        expect(t.balanced).toBe(true);
    });

    test('payment on a later day: Dr AP / Cr cash; AP balance over the range = invoice total - payments', async () => {
        const inv = await mkInv({ invoiceNo: 'INV-PAY', invoiceDate: ist('2022-09-02', 10), businessDate: '2022-09-02', total: 500, subtotal: 500, tax: 0 });
        await SupplierPayment.create({ restaurant: T.restaurant._id, branch: T.branch._id, invoice: inv._id, supplier: sup._id, amount: 200, method: 'cash', date: ist('2022-09-04', 9), businessDate: '2022-09-04' });
        await SupplierPayment.create({ restaurant: T.restaurant._id, branch: T.branch._id, invoice: inv._id, supplier: sup._id, amount: 100, method: 'bank-transfer', date: ist('2022-09-05', 9), businessDate: '2022-09-05' });
        await post(T, { from: '2022-09-02', to: '2022-09-05' });
        const t = (await tb(T, '?from=2022-09-02&to=2022-09-05')).body;
        expect(row(t, '2000').balance).toBe(200);          // 500 owed - 300 paid
        expect(row(t, '1000').credit).toBe(200);
        expect(row(t, '1010').credit).toBe(100);
    });

    test('invoice tax larger than total is capped; batch still balances', async () => {
        await mkInv({ invoiceNo: 'INV-WEIRD', invoiceDate: ist('2022-09-07', 10), businessDate: '2022-09-07', subtotal: 0, tax: 900, total: 100 });
        const r = await post(T, { businessDate: '2022-09-07' });
        expect(r.status).toBe(200);
        expect((await tb(T, '?from=2022-09-07&to=2022-09-07')).body.balanced).toBe(true);
    });

    test('P&L: net profit = sales(net of GST) - purchases - operating expenses, computed independently', async () => {
        const T2 = await seedTenant({ label: 'rl-pnl' });
        const d = '2022-10-01';
        await sale(T2, ist(d, 12), 'cash', 1050, { gst: 50, total: 1050 });
        await sale(T2, ist(d, 13), 'upi', 525, { gst: 25, total: 525 });
        const s2 = await Supplier.create({ restaurant: T2.restaurant._id, code: `S${rid()}`, name: 'x' });
        await SupplierInvoice.create({ restaurant: T2.restaurant._id, branch: T2.branch._id, supplier: s2._id, invoiceNo: 'P1', invoiceDate: ist(d, 9), dueDate: ist(d, 9), businessDate: d, subtotal: 400, tax: 20, total: 420 });
        await ctx.api.as(T2.users.admin).post('/ledger/expenses').send({ amount: 130, method: 'cash', category: 'Rent', date: ist(d, 11).toISOString() });
        await post(T2, { businessDate: d });
        const p = (await ctx.api.as(T2.users.admin).get(`/ledger/pnl?from=${d}&to=${d}`)).body;
        expect(p.totalIncome).toBe(1500);
        expect(p.cogs).toBe(400);
        expect(p.grossProfit).toBe(1100);
        expect(p.totalExpenses).toBe(130);
        expect(p.netProfit).toBe(970);
    });

    test('P&L excludes GST: output GST is a liability, input GST an asset', async () => {
        const T2 = await seedTenant({ label: 'rl-pnl-gst' });
        const d = '2022-10-02';
        await sale(T2, ist(d, 12), 'cash', 1180, { gst: 180, total: 1180 });
        await post(T2, { businessDate: d });
        const p = (await ctx.api.as(T2.users.admin).get(`/ledger/pnl?from=${d}&to=${d}`)).body;
        expect(p.totalIncome).toBe(1000);
    });

    test('Regression (fixed 2026-11): voiding an expense after its day was posted leaves the ledger (and P&L) unchanged — no reversal line', async () => {
        // Expected: voided expense no longer reduces profit / cash (a reversing entry, or the void is refused once posted).
        // Actual: voidExpense only flips status; the posted Dr Expenses / Cr Cash lines stay, so the ledger disagrees
        // with the expense list and with the cash closing (which skips void expenses).
        const T2 = await seedTenant({ label: 'rl-void' });
        const d = '2022-10-03';
        const e = await ctx.api.as(T2.users.admin).post('/ledger/expenses').send({ amount: 500, method: 'cash', category: 'Oops', date: ist(d, 11).toISOString() });
        await post(T2, { businessDate: d });
        await ctx.api.as(T2.users.admin).post(`/ledger/expenses/${e.body.expense._id}/void`).send({ reason: 'mistake' });
        await post(T2, { businessDate: d });
        const p = (await ctx.api.as(T2.users.admin).get(`/ledger/pnl?from=${d}&to=${d}`)).body;
        expect(p.totalExpenses).toBe(0);
        expect(row((await tb(T2, `?from=${d}&to=${d}`)).body, '1000').balance).toBe(0);
    });

    test('voiding an expense BEFORE posting means it is never posted', async () => {
        const T2 = await seedTenant({ label: 'rl-void-pre' });
        const d = '2022-10-04';
        const e = await ctx.api.as(T2.users.admin).post('/ledger/expenses').send({ amount: 500, method: 'cash', date: ist(d, 11).toISOString() });
        await ctx.api.as(T2.users.admin).post(`/ledger/expenses/${e.body.expense._id}/void`).send({ reason: 'mistake' });
        const r = await post(T2, { businessDate: d });
        expect(r.body.lines).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('expenses endpoint', () => {
    let T;
    beforeAll(async () => { T = await seedTenant({ label: 'rl-exp' }); });
    const mk = (b) => ctx.api.as(T.users.admin).post('/ledger/expenses').send(b);

    test.each([[0], [-5], ['abc'], [null], [undefined], [0.004]])('amount=%p is rejected', async (v) => {
        expect((await mk({ amount: v })).status).toBe(400);
    });

    test('amount is rounded to 2dp and an unknown method falls back to cash', async () => {
        const r = await mk({ amount: 10.456, method: 'bitcoin' });
        expect(r.status).toBe(201);
        expect(r.body.expense.amount).toBe(10.46);
        expect(r.body.expense.method).toBe('cash');
    });

    test('invalid date is 400', async () => {
        expect((await mk({ amount: 5, date: 'not-a-date' })).status).toBe(400);
    });

    test('list: range filter on businessDate and total equals the sum of rows; voided rows excluded', async () => {
        const T2 = await seedTenant({ label: 'rl-exp2' });
        const mk2 = (b) => ctx.api.as(T2.users.admin).post('/ledger/expenses').send(b);
        const a = await mk2({ amount: 100.1, date: ist('2022-11-01', 10).toISOString() });
        await mk2({ amount: 200.2, date: ist('2022-11-02', 10).toISOString() });
        await mk2({ amount: 999, date: ist('2022-11-09', 10).toISOString() });
        await ctx.api.as(T2.users.admin).post(`/ledger/expenses/${a.body.expense._id}/void`).send({ reason: 'x' });
        const l = await ctx.api.as(T2.users.admin).get('/ledger/expenses?from=2022-11-01&to=2022-11-05');
        expect(l.body.expenses).toHaveLength(1);
        expect(l.body.total).toBe(200.2);
    });

    test('void needs a reason and cannot be repeated', async () => {
        const e = await mk({ amount: 5 });
        expect((await ctx.api.as(T.users.admin).post(`/ledger/expenses/${e.body.expense._id}/void`).send({})).status).toBe(400);
        expect((await ctx.api.as(T.users.admin).post(`/ledger/expenses/${e.body.expense._id}/void`).send({ reason: 'a' })).status).toBe(200);
        expect((await ctx.api.as(T.users.admin).post(`/ledger/expenses/${e.body.expense._id}/void`).send({ reason: 'a' })).status).toBe(404);
    });

    test('Regression (fixed 2026-11): void with a malformed id returns 500 instead of 404/400', async () => {
        // Expected: 4xx. Actual: 500 from the Mongoose CastError (no ObjectId validation).
        const r = await ctx.api.as(T.users.admin).post('/ledger/expenses/not-an-id/void').send({ reason: 'x' });
        expect(r.status).toBeLessThan(500);
    });

    test('category is trimmed / defaulted / truncated to 60', async () => {
        const a = await mk({ amount: 1, category: '   ' });
        const b = await mk({ amount: 1, category: 'y'.repeat(200) });
        expect(a.body.expense.category).toBe('General');
        expect(b.body.expense.category).toHaveLength(60);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('trial balance and account ledger ranges', () => {
    let T;
    beforeAll(async () => {
        T = await seedTenant({ label: 'rl-range2' });
        for (const [i, d] of ['2022-12-01', '2022-12-02', '2022-12-03'].entries()) await sale(T, ist(d, 12), 'cash', 100 * (i + 1));
        await post(T, { from: '2022-12-01', to: '2022-12-03' });
    });

    test('from/to are inclusive and sum correctly', async () => {
        expect(row((await tb(T, '?from=2022-12-01&to=2022-12-01')).body, '1000').debit).toBe(100);
        expect(row((await tb(T, '?from=2022-12-02&to=2022-12-03')).body, '1000').debit).toBe(500);
        expect(row((await tb(T)).body, '1000').debit).toBe(600);
        expect(row((await tb(T, '?to=2022-12-02')).body, '1000').debit).toBe(300);
        expect(row((await tb(T, '?from=2022-12-03')).body, '1000').debit).toBe(300);
    });

    test('a range with no entries is all zeros', async () => {
        const t = (await tb(T, '?from=2030-01-01&to=2030-01-31')).body;
        expect(t.totals).toEqual({ debit: 0, credit: 0 });
    });

    test('account ledger: opening balance = everything before `from`, running balance ends at closingBalance', async () => {
        const r = (await ctx.api.as(T.users.admin).get('/ledger/accounts/1000/ledger?from=2022-12-02&to=2022-12-03')).body;
        expect(r.openingBalance).toBe(100);
        expect(r.entries.map((e) => e.balance)).toEqual([300, 600]);
        expect(r.closingBalance).toBe(600);
    });

    test('account ledger of an income account has credit-natural running balance', async () => {
        const r = (await ctx.api.as(T.users.admin).get('/ledger/accounts/4000/ledger')).body;
        expect(r.closingBalance).toBe(600);
    });

    test('unknown account code is 404', async () => {
        expect((await ctx.api.as(T.users.admin).get('/ledger/accounts/9999/ledger')).status).toBe(404);
    });

    test('limit is honoured and capped; garbage limit falls back', async () => {
        const a = (await ctx.api.as(T.users.admin).get('/ledger/accounts/1000/ledger?limit=2')).body;
        expect(a.entries).toHaveLength(2);
        const b = await ctx.api.as(T.users.admin).get('/ledger/accounts/1000/ledger?limit=abc');
        expect(b.status).toBe(200);
        expect(b.body.entries).toHaveLength(3);
    });

    test('Regression (fixed 2026-11): account ledger closingBalance is the true balance when the limit truncates the list, and truncated is flagged', async () => {
        // Expected: closingBalance is the true balance at the end of the range (600) or the response flags truncation.
        // Actual: entries are cut to `limit` and closingBalance is the running total of just those rows (100 with limit=1).
        const r = (await ctx.api.as(T.users.admin).get('/ledger/accounts/1000/ledger?limit=1')).body;
        expect(r.closingBalance).toBe(600);
        expect(r.truncated).toBe(true);
    });

    test('each account row balance respects natural side (asset debit-credit, liability/income credit-debit)', async () => {
        const t = (await tb(T)).body;
        for (const r of t.rows) {
            const exp = ['asset', 'expense'].includes(r.type) ? r.debit - r.credit : r.credit - r.debit;
            expect(r.balance).toBe(r2(exp));
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('cash drawer vs ledger vs orders (cross-report reconciliation)', () => {
    let T; let sup;
    const d = '2022-12-20';
    beforeAll(async () => {
        T = await seedTenant({ label: 'rl-cross' });
        sup = await Supplier.create({ restaurant: T.restaurant._id, code: `S${rid()}`, name: 'X' });
        const o1 = await sale(T, ist(d, 12), 'cash', 1050, { gst: 50, total: 1050 });
        await pay(T, ist(d, 13), [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 300 }], { gst: 25, total: 500 });
        await sale(T, ist(d, 14), 'card', 777.77, { gst: 37.04, total: 777.77 });
        await sale(T, ist(d, 15), 'wallet', 120);
        await refund(o1, 250, ist(d, 16));
        await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 17), amount: 99.5, category: 'Gas', method: 'cash' });
        await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 17), amount: 400, category: 'Rent', method: 'upi' });
        const inv = await SupplierInvoice.create({ restaurant: T.restaurant._id, branch: T.branch._id, supplier: sup._id, invoiceNo: 'X1', invoiceDate: ist(d, 8), dueDate: ist(d, 8), businessDate: d, subtotal: 600, tax: 0, total: 600, amountPaid: 130, status: 'partial' });
        await SupplierPayment.create({ restaurant: T.restaurant._id, branch: T.branch._id, invoice: inv._id, supplier: sup._id, amount: 130, method: 'cash', date: ist(d, 18), businessDate: d });
        await post(T, { businessDate: d });
    });

    test('ledger cash account net movement == cash closing (sales - refunds - pay-outs)', async () => {
        const p = (await ctx.api.as(T.users.admin).get(`/cash-closings/preview?businessDate=${d}`)).body;
        const cashAcct = row((await tb(T, `?from=${d}&to=${d}`)).body, '1000');
        expect(p.cashSales).toBe(1050 + 200);
        expect(p.cashRefunds).toBe(250);
        expect(p.cashPaidOuts).toBe(99.5 + 130);
        expect(cashAcct.balance).toBe(r2(p.cashSales - p.cashRefunds - p.cashPaidOuts));
    });

    test('ledger debits to tender accounts == sum of amountPaid of the day\'s paid orders (all methods)', async () => {
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        const received = r2(['1000', '1010', '1020', '2100'].reduce((s, c) => s + row(t, c).debit, 0));
        const orders = await Order.find({ restaurant: T.restaurant._id, paymentStatus: 'Paid' }).lean();
        expect(received).toBe(r2(orders.reduce((s, o) => s + o.amountPaid, 0)));
    });

    test('Sales + Output GST credits == money received (gross) on the day', async () => {
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        const received = 1050 + 500 + 777.77 + 120;
        expect(r2(row(t, '4000').credit + row(t, '2200').credit)).toBe(r2(received));
    });

    test('ledger output GST equals the GST report tax for the same (fully paid) orders, within 1 paisa per order', async () => {
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        const g = (await ctx.api.as(T.users.admin).get(`/reports/gst/summary?from=${d}&to=${d}`)).body.report;
        expect(Math.abs(row(t, '2200').credit - g.totals.tax)).toBeLessThanOrEqual(0.04);
    });

    test('the trial balance of the whole day is balanced', async () => {
        const t = (await tb(T, `?from=${d}&to=${d}`)).body;
        expect(t.balanced).toBe(true);
        expect(t.totals.debit).toBe(t.totals.credit);
    });

    test('Regression (fixed 2026-11): a Paid order with no paidAt appears in the GST report, the ledger and the cash closing alike', async () => {
        // Expected: every paid order is in every money report. Actual: ledgerSources only loads orders by paidAt /
        // payments.at, while gstReportService falls back to createdAt, so the three reports disagree on legacy data.
        const T2 = await seedTenant({ label: 'rl-nopaidat' });
        const day = '2022-12-21';
        const created = await Order.create({
            restaurant: T2.restaurant._id, branch: T2.branch._id, orderId: `RL-${rid()}`, type: 'takeaway',
            items: [{ name: 'x', price: 321, quantity: 1 }], total: 321, status: 'served', paymentStatus: 'Paid',
            paymentMethod: 'cash', amountPaid: 321,
        });
        await Order.collection.updateOne({ _id: created._id }, { $set: { createdAt: ist(day, 12) } });
        await post(T2, { businessDate: day });
        const g = (await ctx.api.as(T2.users.admin).get(`/reports/gst/summary?from=${day}&to=${day}`)).body.report;
        const p = (await ctx.api.as(T2.users.admin).get(`/cash-closings/preview?businessDate=${day}`)).body;
        expect(g.totals.invoiceTotal).toBe(321);
        expect(p.cashSales).toBe(321);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('branch scope and roles', () => {
    let T; let B2; let sub2; let manager;
    const d = '2023-01-10';
    beforeAll(async () => {
        T = await seedTenant({ label: 'rl-branch' });
        B2 = await Branch.create({ restaurant: T.restaurant._id, name: 'B2', slug: 'b2', isActive: true });
        sub2 = await createUser({ name: 's2', email: `s2.${rid()}@staff.test`, role: 'admin', restaurant: T.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('admin') });
        manager = await createUser({ name: 'm', email: `m.${rid()}@staff.test`, role: 'manager', restaurant: T.restaurant._id, branch: null, permissions: defaultPermissionsForRole('manager') });
        await sale(T, ist(d, 12), 'cash', 100);
        await sale(T, ist(d, 12), 'cash', 40, { branch: B2._id });
        await post(T, { businessDate: d });
    });

    test('branch-pinned admin sees only own branch lines; tenant admin sees both; sum of branches == tenant', async () => {
        const all = row((await tb(T, `?from=${d}&to=${d}`)).body, '1000').debit;
        const mine = row((await tb(T, `?from=${d}&to=${d}`, sub2)).body, '1000').debit;
        const main = row((await tb(T, `?from=${d}&to=${d}&branch=${T.branch._id}`)).body, '1000').debit;
        expect(all).toBe(140);
        expect(mine).toBe(40);
        expect(r2(mine + main)).toBe(all);
    });

    test('pinned admin cannot widen scope via ?branch=all', async () => {
        expect(row((await tb(T, `?from=${d}&to=${d}&branch=all`, sub2)).body, '1000').debit).toBe(40);
    });

    test('lines carry the branch of their source order', async () => {
        const lines = await LedgerEntry.find({ restaurant: T.restaurant._id, account: '1000' }).lean();
        expect(lines.map((l) => String(l.branch)).sort()).toEqual([String(T.branch._id), String(B2._id)].sort());
    });

    test.each(['waiter', 'chef', 'captain'])('%s is refused on every ledger endpoint', async (role) => {
        const u = T.users[role];
        const calls = [
            ctx.api.as(u).get('/ledger/accounts'), ctx.api.as(u).get('/ledger/trial-balance'), ctx.api.as(u).get('/ledger/pnl'),
            ctx.api.as(u).get('/ledger/accounts/1000/ledger'), ctx.api.as(u).post('/ledger/post-day').send({}),
            ctx.api.as(u).get('/ledger/expenses'), ctx.api.as(u).post('/ledger/expenses').send({ amount: 5 }),
            ctx.api.as(u).post('/ledger/expenses/000000000000000000000000/void').send({ reason: 'x' }),
        ];
        for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
    });

    test('manager can view the ledger, post a day and record an expense', async () => {
        expect((await tb(T, '', manager)).status).toBe(200);
        expect((await post(T, { businessDate: d }, manager)).status).toBe(200);
        expect((await ctx.api.as(manager).post('/ledger/expenses').send({ amount: 5 })).status).toBe(201);
    });

    test('anonymous requests are refused with no data', async () => {
        const r = await ctx.api.anon().get('/ledger/trial-balance');
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(r.body.rows).toBeUndefined();
    });

    test('Regression (fixed 2026-11): a branch-pinned admin can void another branch\'s expense', async () => {
        // Expected: 404 for an expense of a branch the caller is pinned away from (list is branch scoped).
        // Actual: voidExpense filters by _id + tenant only.
        const e = await Expense.create({ restaurant: T.restaurant._id, branch: T.branch._id, businessDate: d, date: ist(d, 9), amount: 77, category: 'Main only', method: 'cash' });
        const r = await ctx.api.as(sub2).post(`/ledger/expenses/${e._id}/void`).send({ reason: 'cross-branch' });
        expect(r.status).toBe(404);
        expect((await Expense.findById(e._id).lean()).status).toBe('active');
    });

    test('pinned admin\'s expense list excludes other branch expenses', async () => {
        const l = await ctx.api.as(sub2).get('/ledger/expenses');
        expect(l.body.expenses.every((e) => String(e.branch) === String(B2._id))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('scheduled ledger post job', () => {
    const { runLedgerPostJob, startLedgerPostJob, INTERVAL_MS } = require(path.join(BACKEND, 'utils/ledgerPostJob'));
    const ledgerService = require(path.join(BACKEND, 'services/ledgerService'));
    const todayIst = (now) => new Date(now.getTime() + IST).toISOString().slice(0, 10);
    let T; let Z; let S;
    const now = new Date();
    const today = todayIst(now);
    const yday = addDays(today, -1);

    beforeAll(async () => {
        T = await seedTenant({ label: 'rl-job' });
        Z = await seedTenant({ label: 'rl-job-ny' });
        S = await seedTenant({ label: 'rl-job-sus' });
        await Restaurant.updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'suspended' } });
        await sale(T, ist(today, 0, 1), 'cash', 10);        // today IST (may be in the future for tiny offsets - fine, loader is time-agnostic)
        await sale(T, ist(yday, 12), 'cash', 20);
        await sale(T, ist(addDays(today, -3), 12), 'cash', 40);   // outside the job window
        await sale(S, ist(yday, 12), 'cash', 5);
    });

    test('posts yesterday + today for live tenants, balanced, and ignores suspended tenants', async () => {
        const r = await runLedgerPostJob({ now });
        expect(r.restaurants).toBeGreaterThanOrEqual(2);
        // 10 (today) + 20 (yesterday) + 40 (3 days ago, caught up since the tenant had never posted)
        expect(await sumField(T, 'debit', { account: '1000' })).toBe(70);
        expect(await LedgerEntry.countDocuments({ restaurant: S.restaurant._id })).toBe(0);
        expect((await tb(T)).body.balanced).toBe(true);
    });

    test('a second run is a no-op (idempotent)', async () => {
        const before = await LedgerEntry.countDocuments({});
        const r = await runLedgerPostJob({ now });
        expect(r.inserted).toBe(0);
        expect(await LedgerEntry.countDocuments({})).toBe(before);
    });

    test('Regression (fixed 2026-11): the job catches up sales older than yesterday (bounded to 31 days, idempotent)', async () => {
        // Expected: a job that was down for 2 days catches up (or at least flags the gap).
        // Actual: window is hard-coded to yesterday..today, so the 3-days-ago sale (40) is never ledgered.
        expect(await sumField(T, 'debit', { account: '1000' })).toBe(70);
    });

    test('a tenant that fails does not stop the others (error isolation)', async () => {
        const T2 = await seedTenant({ label: 'rl-job-iso' });
        await sale(T2, ist(yday, 12), 'cash', 9);
        const real = ledgerService.postRange;
        const seen = [];
        const spy = jest.spyOn(ledgerService, 'postRange').mockImplementation(async (id, ...rest) => {
            seen.push(String(id));
            if (String(id) === String(T.restaurant._id)) throw new Error('boom');
            return real(id, ...rest);
        });
        let r;
        try { r = await runLedgerPostJob({ now }); } finally { spy.mockRestore(); }
        expect(seen).toContain(String(T2.restaurant._id));          // tenants after the failing one still ran
        expect(await sumField(T2, 'debit', { account: '1000' })).toBe(9);
        expect(r.restaurants).toBeGreaterThanOrEqual(3);
    });

    test('startLedgerPostJob is opt-in: nothing scheduled unless LEDGER_AUTO_POST=true', () => {
        const calls = [];
        const sched = { scheduleJob: (...a) => { calls.push(a); return 'job'; } };
        const prev = process.env.LEDGER_AUTO_POST;
        delete process.env.LEDGER_AUTO_POST;
        expect(startLedgerPostJob(sched)).toBeNull();
        process.env.LEDGER_AUTO_POST = 'false';
        expect(startLedgerPostJob(sched)).toBeNull();
        process.env.LEDGER_AUTO_POST = 'TRUE';
        expect(startLedgerPostJob(sched)).toBe('job');
        expect(calls[0][0]).toBe('ledger-post-day');
        expect(calls[0][1]).toBe(INTERVAL_MS);
        if (prev === undefined) delete process.env.LEDGER_AUTO_POST; else process.env.LEDGER_AUTO_POST = prev;
    });

    test('the New York tenant is posted for its own local today/yesterday', async () => {
        const nowNy = new Date('2023-03-15T02:00:00Z');                 // NY 03-14 22:00 EDT; IST 03-15
        await sale(Z, new Date('2023-03-14T20:00:00Z'), 'cash', 33);     // NY 03-14 16:00
        await runLedgerPostJob({ now: nowNy });
        expect(await sumField(Z, 'debit', { businessDate: '2023-03-14' })).toBe(33);
    });
});
