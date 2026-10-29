/**
 * GST report + Tally export: pure builders (no DB).
 * Export aid only, not a tax filing tool.
 */
const {
    allocate, buildGstReport, gstReportCsv, dailySalesCsv, csvCell, computeInvoice, DISCLAIMER,
} = require('../utils/gstReport');
const { orderTenders } = require('../utils/orderTenders');
const { buildTallyXml, esc, resolveLedgers, voucherEntries } = require('../utils/tallyExport');
const { resolveRange, dayStartUtc, localYmd } = require('../utils/reportDates');

const D = (s) => new Date(s);

// 1000 food, 5% GST = 50, 5% service = 50, total 1100. Paid half cash half UPI.
function order(over = {}) {
    return {
        orderId: 'ORD-1', status: 'served', paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 1100,
        items: [
            { menuItem: 'a1', name: 'Paneer', category: 'Main', price: 300, quantity: 2 },
            { menuItem: 'a2', name: 'Naan', category: 'Bread', price: 100, quantity: 4 },
        ],
        total: 1100, gst: 50, gstPercentage: 5, serviceCharge: 50, couponDiscount: 0,
        bill: { billNo: 7, financialYear: '2026-27' },
        paidAt: D('2026-10-10T08:00:00Z'), createdAt: D('2026-10-10T07:00:00Z'),
        ...over,
    };
}

describe('allocate', () => {
    test('parts always sum to the total', () => {
        for (const [t, w] of [[10, [1, 1, 1]], [1, [5, 5]], [99999, [333, 777, 1]], [0, [1, 2]], [7, [0, 0]]]) {
            expect(allocate(t, w).reduce((s, v) => s + v, 0)).toBe(t);
        }
    });
});

describe('computeInvoice / buildGstReport', () => {
    test('tie-out: lines == register == totals, and parts add to total', () => {
        const orders = [
            order(),
            order({ orderId: 'ORD-2', bill: { billNo: 8, financialYear: '2026-27' }, items: [{ menuItem: 'a1', name: 'X', category: 'Main', price: 333.33, quantity: 3 }], total: 999.99 + 50 + 50, gst: 50, serviceCharge: 50, couponDiscount: 0 }),
        ];
        const r = buildGstReport({ orders, itemHsn: { a1: '996331' }, categoryHsn: { bread: '1905' }, tz: 'Asia/Kolkata', range: { from: '2026-10-10', to: '2026-10-10' } });
        expect(r.totals.invoiceCount).toBe(2);
        const regTaxable = r.invoices.reduce((s, i) => s + i.taxable, 0);
        const hsnTaxable = r.hsn.reduce((s, h) => s + h.taxable, 0);
        const rateTaxable = r.byRate.reduce((s, h) => s + h.taxable, 0);
        expect(Math.abs(regTaxable - hsnTaxable)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(regTaxable - rateTaxable)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(r.totals.tax - r.hsn.reduce((s, h) => s + h.cgst + h.sgst, 0))).toBeLessThanOrEqual(0.01);
        // sum of invoice totals == taxable + tax + charges
        expect(Math.abs(r.totals.invoiceTotal - (r.totals.taxable + r.totals.tax + r.totals.serviceCharge + r.totals.otherCharges + r.totals.tip - r.totals.pointsRedeemed))).toBeLessThanOrEqual(0.01);
        expect(r.selfCheck.ok).toBe(true);
        expect(r.invoices[0].billNo).toBe('2026-27/7');
        expect(r.meta.disclaimer).toBe(DISCLAIMER);
    });

    test('coupon reduces the taxable base (same rule as computeBill)', () => {
        const o = order({ couponDiscount: 100, gst: 45, total: 1000 - 100 + 45 + 50 });
        const inv = computeInvoice(o, {});
        expect(inv.taxable).toBe(90000);
        expect(inv.tax).toBe(4500);
        expect(inv.reconciled).toBe(true);
    });

    test('HSN grouping: item > category > default, split per rate', () => {
        const r = buildGstReport({
            orders: [order()],
            itemHsn: { a1: '996331' },
            categoryHsn: { bread: '1905' },
            defaultHsn: '9999',
        });
        const codes = Object.fromEntries(r.hsn.map((h) => [h.hsn, h]));
        expect(Object.keys(codes).sort()).toEqual(['1905', '996331']);
        expect(codes['996331'].qty).toBe(2);
        expect(codes['1905'].qty).toBe(4);
        expect(codes['996331'].taxable + codes['1905'].taxable).toBeCloseTo(1000, 2);
        // unknown item + category falls to the default
        const r2 = buildGstReport({ orders: [order({ items: [{ menuItem: 'zz', name: 'Q', category: 'Nope', price: 1000, quantity: 1 }] })], defaultHsn: '9999' });
        expect(r2.hsn[0].hsn).toBe('9999');
        expect(r2.hsn[0].uqc).toBe('NOS');
    });

    test('cancelled / fully refunded are listed separately and excluded; partial refunds noted', () => {
        const r = buildGstReport({
            orders: [
                order(),
                order({ orderId: 'C', status: 'cancelled' }),
                order({ orderId: 'R', paymentStatus: 'Refunded' }),
                order({ orderId: 'P', refundedAmount: 100 }),
                order({ orderId: 'H', status: 'awaiting-payment', paymentStatus: 'Pending' }),
                order({ orderId: 'U', paymentStatus: 'Pending' }),
            ],
        });
        expect(r.invoices.map((i) => i.orderId).sort()).toEqual(['ORD-1', 'P']);
        expect(r.cancelled.map((i) => i.orderId)).toEqual(['C']);
        expect(r.refunded.map((i) => i.orderId)).toEqual(['R']);
        expect(r.partialRefunds.map((i) => i.orderId)).toEqual(['P']);
        expect(r.totals.taxable).toBe(2000);
    });

    test('an older bill whose parts do not add up is flagged, not hidden', () => {
        const r = buildGstReport({ orders: [order({ total: 1111 })] });
        expect(r.selfCheck.ok).toBe(false);
        expect(r.selfCheck.unreconciledInvoices[0].difference).toBe(11);
        expect(r.invoices[0].reconciled).toBe(false);
    });

    test('customer GSTIN kept only when valid', () => {
        const r = buildGstReport({ orders: [order({ customerGstin: '29ABCDE1234F1Z5' }), order({ orderId: 'B', customerGstin: 'junk' })] });
        expect(r.invoices.map((i) => i.customerGstin)).toEqual(['29ABCDE1234F1Z5', '']);
    });

    test('CSV: sections, disclaimer, BOM and formula-injection guard', () => {
        const r = buildGstReport({ orders: [order()], tz: 'Asia/Kolkata', range: { from: '2026-10-10', to: '2026-10-10' }, taxpayer: { name: '=HYPERLINK("x")', gstin: '' } });
        const csv = gstReportCsv(r);
        expect(csv.charCodeAt(0)).toBe(0xFEFF);
        expect(csv).toContain('HSN summary (GSTR-1 table 12 layout)');
        expect(csv).toContain('Invoice register');
        expect(csv).toContain('Export aid only');
        expect(csv).toContain("'=HYPERLINK");
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(dailySalesCsv(r)).toContain('Collected by tender');
    });
});

describe('orderTenders', () => {
    test('uses payments[] when present', () => {
        expect(orderTenders({ payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 50.5 }, { method: 'cash', amount: 10 }] }))
            .toEqual([{ method: 'cash', paise: 11000 }, { method: 'upi', paise: 5050 }]);
    });
    test('falls back to legacy paymentMethod', () => {
        expect(orderTenders({ paymentMethod: 'Razorpay', amountPaid: 200 })).toEqual([{ method: 'online', paise: 20000 }]);
        expect(orderTenders({ paymentMethod: 'Card', amountPaid: 5 })).toEqual([{ method: 'card', paise: 500 }]);
    });
    test('unknown / empty is an empty list and never throws', () => {
        expect(orderTenders({ paymentMethod: 'Not selected', amountPaid: 100 })).toEqual([]);
        expect(orderTenders(null)).toEqual([]);
        expect(orderTenders({ payments: 'bad' })).toEqual([]);
    });
});

describe('Tally XML', () => {
    const fixtureOrder = order({
        orderId: 'ORD-<1>&', payments: [{ method: 'cash', amount: 600 }, { method: 'upi', amount: 500 }],
        bill: { billNo: 7, financialYear: '2026-27' }, paidAt: D('2026-10-10T08:00:00Z'),
    });

    test('matches the fixture', () => {
        const { xml, voucherCount } = buildTallyXml({ orders: [fixtureOrder, order({ orderId: 'X', status: 'cancelled' })], tz: 'Asia/Kolkata', company: 'Demo & Co' });
        expect(voucherCount).toBe(1);
        const expected = [
            '<ENVELOPE>', '  <HEADER>', '    <TALLYREQUEST>Import Data</TALLYREQUEST>', '  </HEADER>', '  <BODY>', '    <IMPORTDATA>',
            '      <REQUESTDESC>', '        <REPORTNAME>Vouchers</REPORTNAME>', '        <STATICVARIABLES>',
            '          <SVCURRENTCOMPANY>Demo &amp; Co</SVCURRENTCOMPANY>', '        </STATICVARIABLES>', '      </REQUESTDESC>', '      <REQUESTDATA>',
            '      <TALLYMESSAGE xmlns:UDF="TallyUDF">',
            '        <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">',
            '          <DATE>20261010</DATE>', '          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>',
            '          <VOUCHERNUMBER>2026-27/7</VOUCHERNUMBER>', '          <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>',
            '          <NARRATION>Order ORD-&lt;1&gt;&amp; / Bill 2026-27/7</NARRATION>',
            '          <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>',
        ];
        for (const line of expected) expect(xml).toContain(line);
        const entry = (name, deemed, amount, party) => [
            '          <ALLLEDGERENTRIES.LIST>', `            <LEDGERNAME>${name}</LEDGERNAME>`, `            <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`,
            ...(party ? ['            <ISPARTYLEDGER>Yes</ISPARTYLEDGER>'] : []), `            <AMOUNT>${amount}</AMOUNT>`, '          </ALLLEDGERENTRIES.LIST>',
        ].join('\n');
        expect(xml).toContain(entry('Cash', 'Yes', '-600.00', true));
        expect(xml).toContain(entry('UPI Receipts', 'Yes', '-500.00'));
        expect(xml).toContain(entry('Sales - Restaurant', 'No', '1000.00'));
        expect(xml).toContain(entry('Output CGST', 'No', '25.00'));
        expect(xml).toContain(entry('Output SGST', 'No', '25.00'));
        expect(xml).toContain(entry('Service Charge Income', 'No', '50.00'));
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        expect(xml.trim().endsWith('</ENVELOPE>')).toBe(true);
    });

    test('every voucher balances to the paisa, including legacy bills', () => {
        for (const o of [fixtureOrder, order({ total: 1111, paymentMethod: 'Not selected', amountPaid: 0 }), order({ pointsRedeemed: 20, total: 1080, manualDiscount: 30, payments: [{ method: 'wallet', amount: 20 }, { method: 'cash', amount: 5000 }] })]) {
            const row = computeInvoice(o, {});
            const { entries } = voucherEntries(row, resolveLedgers({}), 'cash');
            const d = entries.filter((e) => e.debit).reduce((s, e) => s + e.paise, 0);
            const c = entries.filter((e) => !e.debit).reduce((s, e) => s + e.paise, 0);
            expect(d).toBeLessThanOrEqual(c);
            // the XML builder adds a Round Off line for any gap
            const { xml } = buildTallyXml({ orders: [o], tz: 'Asia/Kolkata' });
            const amounts = [...xml.matchAll(/<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\n(?: *<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>\n)? *<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)];
            const sum = amounts.reduce((s, m) => s + Math.round(parseFloat(m[2]) * 100), 0);
            expect(sum).toBe(0);
        }
    });

    test('ledger names are configurable, party can be Sundry Debtors, untendered bills go to the party', () => {
        const { xml } = buildTallyXml({
            orders: [order({ paymentMethod: 'Not selected', amountPaid: 0 })], tz: 'Asia/Kolkata',
            ledgers: { sales: 'My <Sales>', outputCgst: 'CGST 2.5%' }, partyMode: 'debtors',
        });
        expect(xml).toContain('<LEDGERNAME>My &lt;Sales&gt;</LEDGERNAME>');
        expect(xml).toContain('<LEDGERNAME>CGST 2.5%</LEDGERNAME>');
        expect(xml).toContain('<PARTYLEDGERNAME>Sundry Debtors</PARTYLEDGERNAME>');
    });

    test('esc handles XML specials and control characters', () => {
        expect(esc('a&b<c>"d\'\u0001')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    });
});

describe('reportDates', () => {
    test('IST day boundaries and inclusive range', () => {
        expect(dayStartUtc('2026-10-10', 'Asia/Kolkata').toISOString()).toBe('2026-10-09T18:30:00.000Z');
        const r = resolveRange({ from: '2026-10-01', to: '2026-10-31' }, 'Asia/Kolkata');
        expect(r.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
        expect(r.end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
        expect(localYmd(D('2026-10-09T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-10');
    });
    test('bad input is rejected', () => {
        expect(resolveRange({ from: '2026-13-01', to: '2026-12-01' }, 'Asia/Kolkata').error).toBeTruthy();
        expect(resolveRange({ from: '2026-10-05', to: '2026-10-01' }, 'Asia/Kolkata').error).toBeTruthy();
        expect(resolveRange({ from: '2024-01-01', to: '2026-01-01' }, 'Asia/Kolkata').error).toMatch(/366/);
    });
});
