/**
 * STRICT payments / money reconciliation: GST summary / Tally / CSV exports and
 * the sales + payment-method report (telemetry /reports).
 *
 *   /reports/gst/summary, /reports/tally/export, /reports/gst/config
 *   /telemetry/reports (byPayment, totals)
 *
 * Times IST (UTC+05:30). "BUG:" tests pin real defects and are expected to FAIL.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(BACKEND, 'models', n));
const Order = M('order'); const Branch = M('branch'); const Restaurant = M('restaurant');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
const { buildGstReport } = require(path.join(BACKEND, 'utils/gstReport'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const IST = 330 * 60 * 1000;
const ist = (ymd, hh = 0, mm = 0, ss = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 - IST);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

async function bill(t, at, { items, total, method = 'cash', gst = 0, gstPercentage = 0, ...extra } = {}) {
    const its = items || [{ name: 'Dish', price: total - gst, quantity: 1 }];
    return Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `RG-${rid()}`, type: 'takeaway',
        items: its, total, gst, gstPercentage, status: 'served', paymentStatus: 'Paid', paymentMethod: method,
        amountPaid: total, paidAt: at, payments: [{ method, amount: total, at }], ...extra,
    });
}
const gstSummary = (t, q, user) => ctx.api.as(user || t.users.admin).get(`/reports/gst/summary?${q}`);

// ═════════════════════════════════════════════════════════════════════
describe('GST summary math', () => {
    let G; const d = '2023-02-10';
    beforeAll(async () => {
        G = await seedTenant({ label: 'rg-math' });
        // A: 2 x 200, coupon 40 -> taxable 360, 5% = 18, total 378 (cash)
        await bill(G, ist(d, 12), { items: [{ name: 'Dosa', price: 200, quantity: 2 }], couponDiscount: 40, gst: 18, gstPercentage: 5, total: 378 });
        // B: 100 + 12% = 112 (upi)
        await bill(G, ist(d, 13), { items: [{ name: 'Wine', price: 100, quantity: 1 }], gst: 12, gstPercentage: 12, total: 112, method: 'upi' });
        // C: 33.33 x 3 = 99.99, 5% -> 5.00, total 104.99 (card)
        await bill(G, ist(d, 14), { items: [{ name: 'Tea', price: 33.33, quantity: 3 }], gst: 5, gstPercentage: 5, total: 104.99, method: 'card' });
        // D: odd tax paise: 1.00 + 0.05
        await bill(G, ist(d, 15), { items: [{ name: 'Mint', price: 1, quantity: 1 }], gst: 0.05, gstPercentage: 5, total: 1.05 });
        // E: with service charge, packaging and tip: 500 + 25 gst + 50 svc + 20 pack + 30 tip = 625
        await bill(G, ist(d, 16), { items: [{ name: 'Thali', price: 500, quantity: 1 }], gst: 25, gstPercentage: 5, serviceCharge: 50, additionalChargesTotal: 20, tipAmount: 30, total: 625 });
        // Excluded
        await bill(G, ist(d, 17), { total: 700, gst: 35, gstPercentage: 5, status: 'cancelled' });
        await bill(G, ist(d, 18), { total: 300, gst: 15, gstPercentage: 5, paymentStatus: 'Refunded', refundedAmount: 300 });
        await Order.create({ restaurant: G.restaurant._id, branch: G.branch._id, orderId: `RG-${rid()}`, type: 'dine-in', items: [{ name: 'x', price: 250, quantity: 1 }], total: 250, status: 'served', paymentStatus: 'Pending', createdAt: ist(d, 19) });
        await bill(G, ist(d, 20), { total: 222, gst: 0, status: 'awaiting-payment' });
        // Partial refund stays in the register
        await bill(G, ist(d, 21), { items: [{ name: 'Cake', price: 400, quantity: 1 }], gst: 20, gstPercentage: 5, total: 420, refundedAmount: 50 });
    });
    const rep = async () => (await gstSummary(G, `from=${d}&to=${d}`)).body.report;

    test('only Paid, non-cancelled, non-held bills are in the register', async () => {
        const r = await rep();
        expect(r.totals.invoiceCount).toBe(6);
        expect(r.cancelled).toHaveLength(1);
        expect(r.refunded).toHaveLength(1);
        expect(r.partialRefunds).toHaveLength(1);
        expect(r.partialRefunds[0].refunded).toBe(50);
        expect(r.invoices.every((i) => i.total !== 700 && i.total !== 300 && i.total !== 250 && i.total !== 222)).toBe(true);
    });

    test('taxable value = items subtotal - coupon; tax = stored gst; CGST + SGST == tax exactly', async () => {
        const r = await rep();
        expect(r.totals.taxable).toBe(r2(360 + 100 + 99.99 + 1 + 500 + 400));
        expect(r.totals.tax).toBe(r2(18 + 12 + 5 + 0.05 + 25 + 20));
        expect(r2(r.totals.cgst + r.totals.sgst)).toBe(r.totals.tax);
        expect(r.totals.igst).toBe(0);
        for (const i of r.invoices) expect(r2(i.cgst + i.sgst)).toBe(i.tax);
    });

    test('odd paise tax is split without losing a paisa (0.05 -> 0.03 + 0.02)', async () => {
        const r = await rep();
        const inv = r.invoices.find((i) => i.tax === 0.05);
        expect(inv.cgst + inv.sgst).toBe(0.05);
        expect(Math.abs(inv.cgst - inv.sgst)).toBeLessThanOrEqual(0.01);
    });

    test('invoice total of the report == sum of stored order totals of the register', async () => {
        const r = await rep();
        expect(r.totals.invoiceTotal).toBe(r2(378 + 112 + 104.99 + 1.05 + 625 + 420));
        expect(r2(r.invoices.reduce((s, i) => s + i.total, 0))).toBe(r.totals.invoiceTotal);
    });

    test('components add up: taxable + tax + service + other + tip - points == invoice total (every bill reconciled)', async () => {
        const r = await rep();
        expect(r.selfCheck.ok).toBe(true);
        expect(r.selfCheck.unreconciledInvoices).toEqual([]);
        expect(r.selfCheck.componentsVsInvoiceTotals).toBe(0);
        expect(r.totals.serviceCharge).toBe(50);
        expect(r.totals.otherCharges).toBe(20);
        expect(r.totals.tip).toBe(30);
        expect(r2(r.totals.taxable + r.totals.tax + r.totals.serviceCharge + r.totals.otherCharges + r.totals.tip)).toBe(r.totals.invoiceTotal);
    });

    test('by-rate table: one row per rate, taxable / tax add up to the totals', async () => {
        const r = await rep();
        expect(r.byRate.map((x) => x.rate)).toEqual([5, 12]);
        expect(r2(r.byRate.reduce((s, x) => s + x.taxable, 0))).toBe(r.totals.taxable);
        expect(r2(r.byRate.reduce((s, x) => s + x.tax, 0))).toBe(r.totals.tax);
        expect(r.byRate.find((x) => x.rate === 12)).toMatchObject({ invoices: 1, taxable: 100, tax: 12, cgst: 6, sgst: 6 });
    });

    test('HSN table ties out to the register (taxable and tax)', async () => {
        const r = await rep();
        expect(r2(r.hsn.reduce((s, x) => s + x.taxable, 0))).toBe(r.totals.taxable);
        expect(r2(r.hsn.reduce((s, x) => s + x.cgst + x.sgst + x.igst, 0))).toBe(r.totals.tax);
        expect(r2(r.hsn.reduce((s, x) => s + x.totalValue, 0))).toBe(r2(r.totals.taxable + r.totals.tax));
        expect(r.hsn.every((x) => /^\d{4,8}$/.test(x.hsn))).toBe(true);
    });

    test('tender breakdown sums to the invoice total and matches each method', async () => {
        const r = await rep();
        expect(r.totals.byTender).toEqual({ cash: r2(378 + 1.05 + 625 + 420), upi: 112, card: 104.99 });
        expect(r2(Object.values(r.totals.byTender).reduce((s, v) => s + v, 0))).toBe(r.totals.invoiceTotal);
    });

    test('a bill whose stored parts do not add up is flagged (selfCheck.ok=false) rather than silently reported', async () => {
        const T2 = await seedTenant({ label: 'rg-bad' });
        await bill(T2, ist(d, 12), { items: [{ name: 'x', price: 100, quantity: 1 }], gst: 5, gstPercentage: 5, total: 999 });
        const r = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report;
        expect(r.selfCheck.ok).toBe(false);
        expect(r.selfCheck.unreconciledInvoices).toHaveLength(1);
        expect(r.selfCheck.unreconciledInvoices[0].difference).toBe(894);
        expect(r.invoices[0].reconciled).toBe(false);
    });

    test('points redeemed reduce the payable total and still reconcile', async () => {
        const T2 = await seedTenant({ label: 'rg-pts' });
        await bill(T2, ist(d, 12), { items: [{ name: 'x', price: 200, quantity: 1 }], gst: 10, gstPercentage: 5, pointsRedeemed: 20, total: 190 });
        const r = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report;
        expect(r.selfCheck.ok).toBe(true);
        expect(r.totals.pointsRedeemed).toBe(20);
    });

    test('a manual discount is not double-subtracted from taxable value (only coupon reduces the GST base)', async () => {
        const T2 = await seedTenant({ label: 'rg-man' });
        await bill(T2, ist(d, 12), { items: [{ name: 'x', price: 200, quantity: 1 }], manualDiscount: 20, gst: 10, gstPercentage: 5, total: 190 });
        const r = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report;
        expect(r.totals.taxable).toBe(200);
    });

    test('GST-free bills (0%) still appear with tax 0', async () => {
        const T2 = await seedTenant({ label: 'rg-zero' });
        await bill(T2, ist(d, 12), { items: [{ name: 'x', price: 80, quantity: 1 }], total: 80 });
        const r = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report;
        expect(r.totals).toMatchObject({ invoiceCount: 1, taxable: 80, tax: 0, invoiceTotal: 80 });
    });

    test('pure builder: 200 bills of ₹0.07 tax keep CGST+SGST == tax to the paisa (no rounding drift)', () => {
        const orders = Array.from({ length: 200 }, (_, i) => ({
            orderId: `o${i}`, status: 'served', paymentStatus: 'Paid', total: 1.47, gst: 0.07, gstPercentage: 5,
            items: [{ name: 'x', price: 1.4, quantity: 1 }], paidAt: new Date(), payments: [{ method: 'cash', amount: 1.47 }],
        }));
        const r = buildGstReport({ orders, tz: 'Asia/Kolkata', range: { from: 'a', to: 'b' } });
        expect(r.totals.tax).toBe(14);
        expect(r2(r.totals.cgst + r.totals.sgst)).toBe(14);
        expect(r.selfCheck.ok).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('GST report date range, timezone and scope', () => {
    let G; let B2; let sub2; let manager;
    beforeAll(async () => {
        G = await seedTenant({ label: 'rg-range' });
        B2 = await Branch.create({ restaurant: G.restaurant._id, name: 'B2', slug: 'b2', isActive: true });
        sub2 = await createUser({ name: 's2', email: `s2.${rid()}@staff.test`, role: 'admin', restaurant: G.restaurant._id, branch: B2._id, permissions: defaultPermissionsForRole('admin') });
        manager = await createUser({ name: 'm', email: `m.${rid()}@staff.test`, role: 'manager', restaurant: G.restaurant._id, branch: null, permissions: defaultPermissionsForRole('manager') });
        const base = '2023-03-10';
        await bill(G, ist(base, 0, 0, 0), { total: 10 });
        await bill(G, ist(base, 23, 59, 59), { total: 20 });
        await bill(G, new Date(ist(base, 0).getTime() - 1), { total: 400 });
        await bill(G, ist(addDays(base, 1), 0, 0, 0), { total: 800 });
        await bill(G, ist(base, 12), { total: 5, branch: B2._id });
    });
    const tot = async (q, user) => (await gstSummary(G, q, user)).body.report.totals.invoiceTotal;

    test('range is inclusive of both days in IST, half-open at midnight', async () => {
        expect(await tot('from=2023-03-10&to=2023-03-10')).toBe(35);
        expect(await tot('from=2023-03-09&to=2023-03-09')).toBe(400);
        expect(await tot('from=2023-03-11&to=2023-03-11')).toBe(800);
        expect(await tot('from=2023-03-09&to=2023-03-11')).toBe(1235);
    });

    test('sum of single-day reports == the multi-day report (no bill dropped or counted twice at midnight)', async () => {
        const days = ['2023-03-09', '2023-03-10', '2023-03-11'];
        let s = 0;
        for (const x of days) s += await tot(`from=${x}&to=${x}`);
        expect(r2(s)).toBe(await tot('from=2023-03-09&to=2023-03-11'));
    });

    test('bill without paidAt falls back to createdAt for its day', async () => {
        const T2 = await seedTenant({ label: 'rg-nopaid' });
        const o = await Order.create({ restaurant: T2.restaurant._id, branch: T2.branch._id, orderId: `RG-${rid()}`, type: 'takeaway', items: [{ name: 'x', price: 61, quantity: 1 }], total: 61, status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 61 });
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ist('2023-03-15', 12) } });
        expect((await gstSummary(T2, 'from=2023-03-15&to=2023-03-15')).body.report.totals.invoiceTotal).toBe(61);
        expect((await gstSummary(T2, 'from=2023-03-14&to=2023-03-14')).body.report.totals.invoiceTotal).toBe(0);
    });

    test('bill created the day before but paid on the day is reported on the PAID day', async () => {
        const T2 = await seedTenant({ label: 'rg-paidlater' });
        await bill(T2, ist('2023-03-16', 1), { total: 90, createdAt: ist('2023-03-15', 21) });
        expect((await gstSummary(T2, 'from=2023-03-16&to=2023-03-16')).body.report.totals.invoiceTotal).toBe(90);
        expect((await gstSummary(T2, 'from=2023-03-15&to=2023-03-15')).body.report.totals.invoiceTotal).toBe(0);
    });

    test('a New York tenant is reported on New York days', async () => {
        const Z = await seedTenant({ label: 'rg-ny' });
        await Restaurant.updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
        await bill(Z, new Date('2023-03-18T03:30:00Z'), { total: 45 });    // 03-17 23:30 EDT
        expect((await gstSummary(Z, 'from=2023-03-17&to=2023-03-17')).body.report.totals.invoiceTotal).toBe(45);
        expect((await gstSummary(Z, 'from=2023-03-18&to=2023-03-18')).body.report.totals.invoiceTotal).toBe(0);
    });

    test('branch-pinned admin only sees own branch; tenant admin sees all; ?branch=all cannot widen', async () => {
        expect(await tot('from=2023-03-10&to=2023-03-10', sub2)).toBe(5);
        expect(await tot('from=2023-03-10&to=2023-03-10&branch=all', sub2)).toBe(5);
        expect(await tot('from=2023-03-10&to=2023-03-10&branch=all')).toBe(35);
    });

    test.each([['from=2023-03-12&to=2023-03-10'], ['from=2023-02-30&to=2023-03-01'], ['from=x&to=y'], ['from=2022-01-01&to=2023-12-31']])('range %s is 400 BAD_RANGE', async (q) => {
        const r = await gstSummary(G, q);
        expect(r.status).toBe(400);
    });

    test('exactly 366 days is allowed; 367 is refused', async () => {
        expect((await gstSummary(G, 'from=2023-01-01&to=2024-01-01')).status).toBe(200);
        expect((await gstSummary(G, 'from=2023-01-01&to=2024-01-02')).status).toBe(400);
    });

    test('roles: waiter / chef / captain refused; manager allowed', async () => {
        for (const role of ['waiter', 'chef', 'captain']) expect((await gstSummary(G, 'from=2023-03-10&to=2023-03-10', G.users[role])).status).toBe(403);
        expect((await gstSummary(G, 'from=2023-03-10&to=2023-03-10', manager)).status).toBe(200);
    });

    test('plan without revenueAnalytics is locked out of every report endpoint', async () => {
        const L = await seedTenant({ label: 'rg-locked' });
        await Restaurant.updateOne({ _id: L.restaurant._id }, { $set: { 'subscription.features.revenueAnalytics': false } });
        for (const p of ['/reports/gst/summary', '/reports/tally/export', '/reports/gst/config']) {
            expect((await ctx.api.as(L.users.admin).get(p)).status).toBe(403);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('exports (CSV / XLSX / Tally) agree with the JSON report', () => {
    let G; const d = '2023-04-05';
    beforeAll(async () => {
        G = await seedTenant({ label: 'rg-export' });
        await bill(G, ist(d, 12), { items: [{ name: 'Dosa', price: 200, quantity: 2 }], couponDiscount: 40, gst: 18, gstPercentage: 5, total: 378 });
        await bill(G, ist(d, 13), { items: [{ name: 'Wine', price: 100, quantity: 1 }], gst: 12, gstPercentage: 12, total: 112, method: 'upi' });
        await bill(G, ist(d, 14), { total: 700, status: 'cancelled' });
        await bill(G, ist(d, 15), { total: 300, paymentStatus: 'Refunded', refundedAmount: 300 });
    });

    test('CSV: content type, attachment name with range, every register bill present, cancelled listed separately', async () => {
        const r = await ctx.api.as(G.users.admin).get(`/reports/gst/summary?from=${d}&to=${d}&format=csv`);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('text/csv');
        expect(r.headers['content-disposition']).toContain(`gst-summary-${d}_to_${d}.csv`);
        const json = (await ctx.api.as(G.users.admin).get(`/reports/gst/summary?from=${d}&to=${d}`)).body.report;
        for (const inv of json.invoices) expect(r.text).toContain(inv.orderId);
        expect(r.text).toContain('Cancelled bills');
        expect(r.text).toContain('378.00');
        expect(r.text).toContain('112.00');
    });

    test('XLSX export returns a real spreadsheet', async () => {
        const r = await ctx.api.as(G.users.admin).get(`/reports/gst/summary?from=${d}&to=${d}&format=xlsx`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('spreadsheetml');
        expect(r.body.slice(0, 2).toString()).toBe('PK');
    });

    test('Tally XML voucher count == number of invoices in the GST register (cancelled / refunded bills are not vouchers)', async () => {
        const r = await ctx.api.as(G.users.admin).get(`/reports/tally/export?from=${d}&to=${d}`);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('xml');
        const json = (await ctx.api.as(G.users.admin).get(`/reports/gst/summary?from=${d}&to=${d}`)).body.report;
        expect(Number(r.headers['x-voucher-count'])).toBe(json.totals.invoiceCount);
    });

    test('GST config: HSN must be 4-8 digits, partyMode whitelisted, empty body is 400; manager may update', async () => {
        const api = ctx.api.as(G.users.admin);
        expect((await api.put('/reports/gst/config').send({ defaultHsn: 'abc' })).status).toBe(400);
        expect((await api.put('/reports/gst/config').send({ partyMode: 'whatever' })).status).toBe(400);
        expect((await api.put('/reports/gst/config').send({})).status).toBe(400);
        expect((await api.put('/reports/gst/config').send({ defaultHsn: '996332' })).status).toBe(200);
        const rep = (await api.get(`/reports/gst/summary?from=${d}&to=${d}`)).body.report;
        expect(rep.meta.defaultHsn).toBe('996332');
        expect(rep.hsn.every((h) => h.hsn === '996332')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('sales report: totals and payment-method breakdown (telemetry /reports)', () => {
    let S; const d = '2023-05-10';
    const rep = async (t, q = `from=${d}&to=${d}`) => (await ctx.api.as(t.users.admin).get(`/telemetry/reports?${q}`)).body;
    const mk = (t, at, fields) => bill(t, at, fields).then(async (o) => { await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: at } }); return o; });

    beforeAll(async () => {
        S = await seedTenant({ label: 'rg-sales' });
        await mk(S, ist(d, 10), { total: 1000, method: 'cash' });
        await mk(S, ist(d, 11), { total: 500, method: 'upi' });
        await mk(S, ist(d, 12), { total: 250, method: 'card' });
        await mk(S, ist(d, 13), { total: 300, method: 'cash' });
        await mk(S, ist(d, 14), { total: 777, method: 'cash', status: 'cancelled' });       // excluded
        await mk(S, ist(d, 15), { total: 333, method: 'upi', paymentStatus: 'Refunded', refundedAmount: 333 });   // excluded
        await Order.create({ restaurant: S.restaurant._id, branch: S.branch._id, orderId: `RG-${rid()}`, type: 'dine-in', items: [{ name: 'x', price: 99, quantity: 1 }], total: 99, status: 'served', paymentStatus: 'Pending', createdAt: ist(d, 16) });
    });

    test('earnings == sum of Paid, non-cancelled order totals (whole-rupee data)', async () => {
        const r = await rep(S);
        expect(r.totals.earnings).toBe(2050);
        expect(r.totals.paidOrders).toBe(4);
    });

    test('payment-method breakdown sums to total earnings and each method is right', async () => {
        const r = await rep(S);
        const by = Object.fromEntries(r.patterns.byPayment.map((x) => [x.label, x.earnings]));
        expect(by).toEqual({ cash: 1300, upi: 500, card: 250 });
        expect(r.patterns.byPayment.reduce((s, x) => s + x.earnings, 0)).toBe(r.totals.earnings);
        expect(r.patterns.byPayment.reduce((s, x) => s + x.orders, 0)).toBe(r.totals.paidOrders);
    });

    test('channel, weekday, hour and day breakdowns all sum to the same earnings', async () => {
        const r = await rep(S);
        expect(r.patterns.byChannel.reduce((s, x) => s + x.earnings, 0)).toBe(r.totals.earnings);
        expect(r.patterns.byWeekday.reduce((s, x) => s + (x.earnings || 0), 0)).toBe(r.totals.earnings);
        expect(r.patterns.byHour.reduce((s, x) => s + (x.earnings || 0), 0)).toBe(r.totals.earnings);
        expect(r.earnings.data.reduce((s, x) => s + (x.earnings ?? x.value ?? 0), 0)).toBe(r.totals.earnings);
    });

    test('IST day edges: an order at 23:59:59 IST counts for the day, 00:00:00 IST next day does not', async () => {
        const T2 = await seedTenant({ label: 'rg-sales-edge' });
        await mk(T2, ist(d, 23, 59, 59), { total: 10 });
        await mk(T2, ist(addDays(d, 1), 0, 0, 0), { total: 20 });
        await mk(T2, new Date(ist(d, 0).getTime() - 1), { total: 40 });
        expect((await rep(T2)).totals.earnings).toBe(10);
        expect((await rep(T2, `from=${addDays(d, 1)}&to=${addDays(d, 1)}`)).totals.earnings).toBe(20);
        expect((await rep(T2, `from=${addDays(d, -1)}&to=${addDays(d, -1)}`)).totals.earnings).toBe(40);
    });

    test('legacy mixed order WITHOUT payments[] falls back to its paymentMethod label ("mixed")', async () => {
        const T2 = await seedTenant({ label: 'rg-mixed' });
        const o = await Order.create({
            restaurant: T2.restaurant._id, branch: T2.branch._id, orderId: `RG-${rid()}`, type: 'takeaway', items: [{ name: 'x', price: 1000, quantity: 1 }], total: 1000,
            status: 'served', paymentStatus: 'Paid', paymentMethod: 'mixed', amountPaid: 1000, paidAt: ist(d, 12),
        });
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ist(d, 12) } });
        const r = await rep(T2);
        expect(r.patterns.byPayment).toEqual([{ label: 'mixed', orders: 1, earnings: 1000 }]);
    });

    test('Regression (fixed 2026-11): payment-method breakdown splits mixed-tender orders per tender line and reconciles to the cash drawer', async () => {
        // Expected: byPayment (cash 300 / upi 700) matches the per-tender truth that cash-closing and ledger use.
        // Actual: groups by the legacy order.paymentMethod ("mixed" -> 1000), so cash is reported as 0 here while the drawer holds 300.
        const T2 = await seedTenant({ label: 'rg-mixed2' });
        const o = await Order.create({
            restaurant: T2.restaurant._id, branch: T2.branch._id, orderId: `RG-${rid()}`, type: 'takeaway', items: [{ name: 'x', price: 1000, quantity: 1 }], total: 1000,
            status: 'served', paymentStatus: 'Paid', paymentMethod: 'mixed', amountPaid: 1000, paidAt: ist(d, 12),
            payments: [{ method: 'cash', amount: 300, at: ist(d, 12) }, { method: 'upi', amount: 700, at: ist(d, 12) }],
        });
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ist(d, 12) } });
        const by = Object.fromEntries((await rep(T2)).patterns.byPayment.map((x) => [x.label, x.earnings]));
        const cc = (await ctx.api.as(T2.users.admin).get(`/cash-closings/preview?businessDate=${d}`)).body;
        expect(by.cash).toBe(cc.cashSales);
        expect(by).toEqual({ cash: 300, upi: 700 });
    });

    test('Regression (fixed 2026-11): sub-rupee amounts: the breakdown sums to the headline earnings (largest-remainder rounding)', async () => {
        // Expected: sections of one report agree (largest-remainder rounding, or paise precision).
        // Actual: each group is Math.round()ed separately: 3 x ₹10.40 on three methods -> 10+10+10 = 30 vs headline round(31.2) = 31.
        const T2 = await seedTenant({ label: 'rg-round' });
        for (const m of ['cash', 'upi', 'card']) await mk(T2, ist(d, 12), { total: 10.4, method: m });
        const r = await rep(T2);
        expect(r.patterns.byPayment.reduce((s, x) => s + x.earnings, 0)).toBe(r.totals.earnings);
    });

    test('a bill paid on a later day than it was created is reported on its PAID day in sales, GST, ledger and cash closing', async () => {
        const T2 = await seedTenant({ label: 'rg-daymismatch' });
        const created = ist(d, 22); const paid = ist(addDays(d, 1), 1);
        const o = await bill(T2, paid, { total: 640 });
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: created } });
        const sales = (await rep(T2)).totals.earnings;
        const gst = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report.totals.invoiceTotal;
        // Both reports bucket by paidAt: the created day has nothing, the paid day has the bill.
        expect(sales).toBe(0);
        expect(gst).toBe(0);
        expect((await rep(T2, `from=${addDays(d, 1)}&to=${addDays(d, 1)}`)).totals.earnings).toBe(640);
    });

    test('Regression (fixed 2026-11): sales report and GST report agree on the day of a bill that straddles midnight', async () => {
        // Expected: for any single day, sales earnings == GST invoice total when all bills are paid and unrefunded.
        // Actual: telemetry uses createdAt, GST uses paidAt, so a bill straddling midnight moves between days.
        const T2 = await seedTenant({ label: 'rg-daymismatch2' });
        const o = await bill(T2, ist(addDays(d, 1), 1), { total: 640 });
        await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ist(d, 22) } });
        const sales = (await rep(T2)).totals.earnings;
        const gst = (await gstSummary(T2, `from=${d}&to=${d}`)).body.report.totals.invoiceTotal;
        expect(sales).toBe(gst);
        const d2 = addDays(d, 1);
        const sales2 = (await rep(T2, `from=${d2}&to=${d2}`)).totals.earnings;
        const gst2 = (await gstSummary(T2, `from=${d2}&to=${d2}`)).body.report.totals.invoiceTotal;
        expect(sales2).toBe(640);
        expect(sales2).toBe(gst2);
    });

    test('range validation: reversed range 400, > 2 years 400; roles: waiter refused', async () => {
        expect((await ctx.api.as(S.users.admin).get(`/telemetry/reports?from=${addDays(d, 5)}&to=${d}`)).status).toBe(400);
        expect((await ctx.api.as(S.users.admin).get('/telemetry/reports?from=2020-01-01&to=2023-01-01')).status).toBe(400);
        expect((await ctx.api.as(S.users.waiter).get(`/telemetry/reports?from=${d}&to=${d}`)).status).toBe(403);
    });
});
