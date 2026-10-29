'use strict';
/**
 * GST report builder (pure: no DB). Turns paid Orders into
 *   - totals + by-rate table (taxable value, CGST / SGST / IGST)
 *   - HSN-wise summary (GSTR-1 table 12 layout)
 *   - invoice register
 *   - cancelled / fully refunded bills, listed separately and excluded
 *   - partial refunds (informational: a credit note may be needed)
 *   - a self-check that the tables tie out
 *
 * EXPORT AID ONLY. This is not a tax return and not a filing tool: the
 * numbers come from what each order stored at billing time
 * (order.gst, order.gstPercentage, couponDiscount ...). Give the files to
 * your CA, who is responsible for the actual GST return. E-invoicing (IRN)
 * is not covered.
 *
 * The bill maths itself is NOT redone here (utils/billing.computeBill owns
 * it). We only re-split what the order stored:
 *   taxable value = max(0, items subtotal - couponDiscount)   (GST base)
 *   tax           = order.gst (split 50/50 into CGST and SGST)
 * Everything runs in integer paise so lines add up exactly.
 */
const { formatBillNo } = require('./billNumber');
const { orderTenders } = require('./orderTenders');
const { localYmd } = require('./reportDates');

const DISCLAIMER = 'Export aid only - not a GST return and not a filing tool. Figures are taken from the bills as stored. Please have your CA verify before filing. E-invoice (IRN) is not covered.';
const DEFAULT_HSN = '996331';
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const rupees = (p) => Math.round(p) / 100;

/** Split `total` paise over `weights`; the remainder is spread so the parts sum exactly. */
function allocate(total, weights) {
    const n = weights.length;
    if (!n) return [];
    const sum = weights.reduce((s, w) => s + w, 0);
    if (!(sum > 0)) {
        const out = new Array(n).fill(0);
        out[0] = total;
        return out;
    }
    const out = weights.map((w) => Math.floor((total * w) / sum));
    const rem = total - out.reduce((s, v) => s + v, 0);
    out[weights.indexOf(Math.max(...weights))] += rem;
    return out;
}

function splitTax(taxPaise) {
    const cgst = Math.round(taxPaise / 2);
    return { cgst, sgst: taxPaise - cgst };
}

function lineGrossPaise(it) {
    const toppings = Array.isArray(it?.selectedToppings)
        ? it.selectedToppings.reduce((s, t) => s + (Number(t?.price) || 0), 0)
        : 0;
    return toPaise(((Number(it?.price) || 0) + toppings) * (Number(it?.quantity) || 1));
}

function resolveHsn(item, { itemHsn = {}, categoryHsn = {}, defaultHsn = DEFAULT_HSN } = {}) {
    // The code stamped on the order line at sale time wins; older orders
    // (no line hsnCode) fall back to today's menu / category lookup.
    const onLine = String(item?.hsnCode || '').trim();
    if (onLine) return { hsn: onLine, source: 'order' };
    const byItem = itemHsn[String(item?.menuItem || '')];
    if (byItem) return { hsn: byItem, source: 'item' };
    const byCat = categoryHsn[String(item?.category || '').trim().toLowerCase()];
    if (byCat) return { hsn: byCat, source: 'category' };
    return { hsn: defaultHsn || DEFAULT_HSN, source: 'default' };
}

function sanitiseGstin(v) {
    const s = String(v || '').trim().toUpperCase();
    return GSTIN_RE.test(s) ? s : '';
}

/** Compute one invoice (all money in paise). */
function computeInvoice(order, ctx) {
    const items = Array.isArray(order.items) ? order.items : [];
    const grosses = items.map(lineGrossPaise);
    const subtotal = grosses.reduce((s, v) => s + v, 0);
    const coupon = toPaise(order.couponDiscount);
    const taxable = subtotal > 0 ? Math.max(0, subtotal - coupon) : 0;
    const tax = toPaise(order.gst);
    let rate = Number(order.gstPercentage) || 0;
    if (!rate && taxable > 0 && tax > 0) rate = Math.round((tax / taxable) * 10000) / 100;

    const serviceCharge = toPaise(order.serviceCharge);
    const addl = Number(order.additionalChargesTotal) > 0
        ? toPaise(order.additionalChargesTotal)
        : (order.additionalCharges || []).reduce((s, c) => s + toPaise(c?.amount), 0);
    const delivery = toPaise(order.delivery?.fee);
    const tip = toPaise(order.tipAmount);
    const points = toPaise(order.pointsRedeemed);
    const manualDiscount = toPaise(order.manualDiscount);
    const total = toPaise(order.total);

    const expected = taxable + tax + serviceCharge + addl + delivery + tip - points;
    const diff = total - expected;
    const reconciled = Math.abs(diff) <= 1;

    // Line split of taxable value and tax (sums equal the invoice exactly).
    let lines;
    if (items.length && subtotal > 0) {
        const t = allocate(taxable, grosses);
        const x = allocate(tax, t);
        lines = items.map((it, i) => ({
            ...resolveHsn(it, ctx),
            name: it.name,
            qty: Number(it.quantity) || 1,
            taxable: t[i],
            tax: x[i],
        }));
    } else if (tax > 0 || taxable > 0) {
        lines = [{ ...resolveHsn({}, ctx), name: 'Bill', qty: 1, taxable, tax }];
    } else {
        lines = [];
    }

    const { cgst, sgst } = splitTax(tax);
    return {
        orderId: order.orderId,
        billNo: formatBillNo(order.bill) || '',
        date: order.paidAt || order.createdAt,
        customerGstin: sanitiseGstin(order.customerGstin || order.gstin),
        rate, taxable, cgst, sgst, igst: 0, tax,
        serviceCharge, otherCharges: addl + delivery, tip, points, manualDiscount,
        total, diff, reconciled, lines,
        tenders: orderTenders(order),
        refunded: toPaise(order.refundedAmount),
    };
}

/** True when the order belongs in the invoice register (paid, not cancelled / refunded). */
function isRegisterOrder(o) {
    return !!o && o.status !== 'awaiting-payment' && o.status !== 'cancelled' && o.paymentStatus === 'Paid';
}

/**
 * @param {object} p
 * @param {object[]} p.orders           lean orders (any mix; classified here)
 * @param {object}  [p.itemHsn]         menuItem id -> HSN
 * @param {object}  [p.categoryHsn]     lowercase category name -> HSN
 * @param {string}  [p.defaultHsn]
 * @param {string}  [p.tz]
 * @param {{from:string,to:string}} [p.range]
 * @param {{name?:string,gstin?:string}} [p.taxpayer]
 */
function buildGstReport({ orders = [], itemHsn = {}, categoryHsn = {}, defaultHsn = DEFAULT_HSN, tz, range = {}, taxpayer = {}, truncated = false } = {}) {
    const ctx = { itemHsn, categoryHsn, defaultHsn };
    const inv = [];
    const cancelled = [];
    const refunded = [];
    const partialRefunds = [];

    for (const o of orders) {
        if (!o || o.status === 'awaiting-payment') continue;
        const row = computeInvoice(o, ctx);
        const brief = {
            orderId: row.orderId, billNo: row.billNo, date: row.date,
            taxable: rupees(row.taxable), tax: rupees(row.tax), total: rupees(row.total),
            refunded: rupees(row.refunded),
        };
        if (o.status === 'cancelled') { cancelled.push(brief); continue; }
        if (o.paymentStatus === 'Refunded') { refunded.push(brief); continue; }
        if (o.paymentStatus !== 'Paid') continue;
        inv.push(row);
        if (row.refunded > 0) partialRefunds.push(brief);
    }
    inv.sort((a, b) => new Date(a.date) - new Date(b.date));

    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);

    // By rate
    const rateMap = new Map();
    for (const r of inv) {
        const e = rateMap.get(r.rate) || { rate: r.rate, invoices: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
        e.invoices += 1; e.taxable += r.taxable; e.cgst += r.cgst; e.sgst += r.sgst; e.igst += r.igst; e.tax += r.tax;
        rateMap.set(r.rate, e);
    }
    const byRate = [...rateMap.values()].sort((a, b) => a.rate - b.rate);

    // HSN-wise (GSTR-1 table 12): per HSN + rate
    const hsnMap = new Map();
    for (const r of inv) {
        for (const l of r.lines) {
            const k = `${l.hsn}|${r.rate}`;
            const e = hsnMap.get(k) || { hsn: l.hsn, rate: r.rate, qty: 0, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0, totalValue: 0 };
            const sp = splitTax(l.tax);
            e.qty += l.qty; e.taxable += l.taxable; e.tax += l.tax;
            e.cgst += sp.cgst; e.sgst += sp.sgst;
            e.totalValue += l.taxable + l.tax;
            hsnMap.set(k, e);
        }
    }
    const hsn = [...hsnMap.values()].sort((a, b) => (a.hsn < b.hsn ? -1 : a.hsn > b.hsn ? 1 : a.rate - b.rate));

    // Tender totals (what customers actually paid with)
    const tenderMap = new Map();
    for (const r of inv) for (const t of r.tenders) tenderMap.set(t.method, (tenderMap.get(t.method) || 0) + t.paise);

    const totalsP = {
        taxable: sum(inv, 'taxable'), cgst: sum(inv, 'cgst'), sgst: sum(inv, 'sgst'), igst: sum(inv, 'igst'),
        tax: sum(inv, 'tax'), serviceCharge: sum(inv, 'serviceCharge'), otherCharges: sum(inv, 'otherCharges'),
        tip: sum(inv, 'tip'), points: sum(inv, 'points'), manualDiscount: sum(inv, 'manualDiscount'),
        invoiceTotal: sum(inv, 'total'),
    };

    // Self-check: every table ties out to the invoice register, and the
    // parts of each bill add up to its stored total.
    const hsnTaxable = hsn.reduce((s, e) => s + e.taxable, 0);
    const hsnTax = hsn.reduce((s, e) => s + e.tax, 0);
    const rateTaxable = byRate.reduce((s, e) => s + e.taxable, 0);
    const rateTax = byRate.reduce((s, e) => s + e.tax, 0);
    const componentTotal = totalsP.taxable + totalsP.tax + totalsP.serviceCharge + totalsP.otherCharges + totalsP.tip - totalsP.points;
    const unreconciled = inv.filter((r) => !r.reconciled);
    const tablesTieOut = [
        hsnTaxable - totalsP.taxable, hsnTax - totalsP.tax,
        rateTaxable - totalsP.taxable, rateTax - totalsP.tax,
    ].every((d) => Math.abs(d) <= 1);
    const totalsTieOut = Math.abs(componentTotal - totalsP.invoiceTotal) <= 1 + unreconciled.length;
    const ok = tablesTieOut && unreconciled.length === 0;
    const selfCheck = {
        ok,
        tablesTieOut,
        totalsTieOut,
        hsnTaxableVsRegister: rupees(hsnTaxable - totalsP.taxable),
        hsnTaxVsRegister: rupees(hsnTax - totalsP.tax),
        rateTaxableVsRegister: rupees(rateTaxable - totalsP.taxable),
        rateTaxVsRegister: rupees(rateTax - totalsP.tax),
        componentsVsInvoiceTotals: rupees(componentTotal - totalsP.invoiceTotal),
        unreconciledInvoices: unreconciled.map((r) => ({ orderId: r.orderId, billNo: r.billNo, difference: rupees(r.diff) })),
        note: ok
            ? 'Taxable value, tax and invoice totals tie out within 0.01.'
            : 'Some bills do not add up from their stored parts (usually older bills created before the tax breakdown was stored). The difference is shown per bill; ask your CA how to treat them.',
    };

    const money = rupees;
    return {
        meta: {
            from: range.from || null, to: range.to || null, tz: tz || null,
            generatedAt: new Date().toISOString(),
            taxpayerName: taxpayer.name || '', gstin: taxpayer.gstin || '',
            disclaimer: DISCLAIMER, truncated: !!truncated, defaultHsn,
        },
        totals: {
            invoiceCount: inv.length,
            taxable: money(totalsP.taxable), cgst: money(totalsP.cgst), sgst: money(totalsP.sgst), igst: money(totalsP.igst),
            tax: money(totalsP.tax), serviceCharge: money(totalsP.serviceCharge), otherCharges: money(totalsP.otherCharges),
            tip: money(totalsP.tip), pointsRedeemed: money(totalsP.points), manualDiscount: money(totalsP.manualDiscount),
            invoiceTotal: money(totalsP.invoiceTotal),
            byTender: Object.fromEntries([...tenderMap.entries()].map(([k, v]) => [k, money(v)])),
        },
        byRate: byRate.map((e) => ({ ...e, taxable: money(e.taxable), cgst: money(e.cgst), sgst: money(e.sgst), igst: money(e.igst), tax: money(e.tax) })),
        hsn: hsn.map((e) => ({
            hsn: e.hsn, description: 'Restaurant service', uqc: 'NOS', rate: e.rate, qty: e.qty,
            totalValue: money(e.totalValue), taxable: money(e.taxable),
            igst: money(e.igst), cgst: money(e.cgst), sgst: money(e.sgst), cess: 0,
        })),
        invoices: inv.map((r) => ({
            orderId: r.orderId, billNo: r.billNo, date: r.date, customerGstin: r.customerGstin,
            rate: r.rate, taxable: money(r.taxable), cgst: money(r.cgst), sgst: money(r.sgst), igst: money(r.igst),
            tax: money(r.tax), otherCharges: money(r.serviceCharge + r.otherCharges), tip: money(r.tip),
            total: money(r.total), reconciled: r.reconciled,
            tenders: r.tenders.map((t) => ({ method: t.method, amount: money(t.paise) })),
        })),
        cancelled, refunded, partialRefunds,
        selfCheck,
    };
}

// ── CSV / Excel ───────────────────────────────────────────────────────

function csvCell(v) {
    if (v == null) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    // Spreadsheet formula-injection guard for text cells.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');
const dayOf = (d, tz) => (d ? localYmd(new Date(d), tz) : '');
const money2 = (n) => (Number(n) || 0).toFixed(2);
const BOM = '﻿';

const EXCLUDED_SECTIONS = (report) => [
    ['Cancelled bills (excluded from the tables above)', report.cancelled],
    ['Fully refunded bills (excluded from the tables above)', report.refunded],
    ['Partially refunded bills (included above; a credit note may be needed)', report.partialRefunds],
];

function gstReportCsv(report) {
    const tz = report.meta.tz;
    const t = report.totals;
    const L = [];
    L.push(csvRow(['GST report (export aid)', `${report.meta.from} to ${report.meta.to}`]));
    L.push(csvRow([report.meta.disclaimer]));
    L.push(csvRow(['Taxpayer', report.meta.taxpayerName, 'GSTIN', report.meta.gstin]));
    L.push(csvRow(['Self-check', report.selfCheck.ok ? 'OK' : 'REVIEW', report.selfCheck.note]));
    L.push('');
    L.push(csvRow(['Tax by rate']));
    L.push(csvRow(['Rate %', 'Invoices', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total tax']));
    for (const r of report.byRate) L.push(csvRow([r.rate, r.invoices, money2(r.taxable), money2(r.cgst), money2(r.sgst), money2(r.igst), money2(r.tax)]));
    L.push('');
    L.push(csvRow(['HSN summary (GSTR-1 table 12 layout)']));
    L.push(csvRow(['HSN', 'Description', 'UQC', 'Total quantity', 'Total value', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Rate %']));
    for (const h of report.hsn) L.push(csvRow([h.hsn, h.description, h.uqc, h.qty, money2(h.totalValue), money2(h.taxable), money2(h.igst), money2(h.cgst), money2(h.sgst), money2(h.cess), h.rate]));
    L.push('');
    L.push(csvRow(['Invoice register']));
    L.push(csvRow(['Bill no', 'Order', 'Date', 'Customer GSTIN', 'Rate %', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total tax', 'Service/other charges', 'Tip', 'Invoice total', 'Adds up']));
    for (const i of report.invoices) L.push(csvRow([i.billNo, i.orderId, dayOf(i.date, tz), i.customerGstin, i.rate, money2(i.taxable), money2(i.cgst), money2(i.sgst), money2(i.igst), money2(i.tax), money2(i.otherCharges), money2(i.tip), money2(i.total), i.reconciled ? 'yes' : 'NO']));
    L.push(csvRow(['TOTAL', t.invoiceCount, '', '', '', money2(t.taxable), money2(t.cgst), money2(t.sgst), money2(t.igst), money2(t.tax), money2(t.serviceCharge + t.otherCharges), money2(t.tip), money2(t.invoiceTotal), '']));
    for (const [title, rows] of EXCLUDED_SECTIONS(report)) {
        L.push('');
        L.push(csvRow([title]));
        L.push(csvRow(['Bill no', 'Order', 'Date', 'Taxable value', 'Tax', 'Total', 'Refunded']));
        for (const r of rows) L.push(csvRow([r.billNo, r.orderId, dayOf(r.date, tz), money2(r.taxable), money2(r.tax), money2(r.total), money2(r.refunded)]));
    }
    return `${BOM}${L.join('\r\n')}\r\n`;
}

/** Sales summary CSV (scheduled "daily-sales"). */
function dailySalesCsv(report) {
    const tz = report.meta.tz;
    const t = report.totals;
    const L = [];
    L.push(csvRow(['Sales summary', `${report.meta.from} to ${report.meta.to}`, report.meta.taxpayerName]));
    L.push(csvRow(['Bills', t.invoiceCount, 'Taxable', money2(t.taxable), 'Tax', money2(t.tax), 'Total', money2(t.invoiceTotal)]));
    L.push('');
    L.push(csvRow(['Collected by tender']));
    for (const [k, v] of Object.entries(t.byTender)) L.push(csvRow([k, money2(v)]));
    L.push('');
    L.push(csvRow(['Bill no', 'Order', 'Date', 'Taxable value', 'Tax', 'Service/other charges', 'Tip', 'Total']));
    for (const i of report.invoices) L.push(csvRow([i.billNo, i.orderId, dayOf(i.date, tz), money2(i.taxable), money2(i.tax), money2(i.otherCharges), money2(i.tip), money2(i.total)]));
    return `${BOM}${L.join('\r\n')}\r\n`;
}

async function gstReportXlsx(report) {
    const ExcelJS = require('exceljs');
    const tz = report.meta.tz;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'BestoDine';
    const addSheet = (name, header, rows) => {
        const ws = wb.addWorksheet(name);
        ws.addRow(header).font = { bold: true };
        rows.forEach((r) => ws.addRow(r));
        ws.columns.forEach((c) => { c.width = 18; });
        return ws;
    };
    const s = wb.addWorksheet('Summary');
    s.addRow(['GST report (export aid)']).font = { bold: true };
    s.addRow([report.meta.disclaimer]);
    s.addRow(['Period', `${report.meta.from} to ${report.meta.to}`]);
    s.addRow(['Taxpayer', report.meta.taxpayerName]);
    s.addRow(['GSTIN', report.meta.gstin]);
    s.addRow(['Self-check', report.selfCheck.ok ? 'OK' : 'REVIEW', report.selfCheck.note]);
    for (const [k, v] of Object.entries(report.totals)) if (typeof v === 'number') s.addRow([k, v]);
    s.getColumn(1).width = 24; s.getColumn(2).width = 30;
    addSheet('Tax by rate', ['Rate %', 'Invoices', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total tax'],
        report.byRate.map((r) => [r.rate, r.invoices, r.taxable, r.cgst, r.sgst, r.igst, r.tax]));
    addSheet('HSN (GSTR-1 table 12)', ['HSN', 'Description', 'UQC', 'Total quantity', 'Total value', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Rate %'],
        report.hsn.map((h) => [h.hsn, h.description, h.uqc, h.qty, h.totalValue, h.taxable, h.igst, h.cgst, h.sgst, h.cess, h.rate]));
    addSheet('Invoice register', ['Bill no', 'Order', 'Date', 'Customer GSTIN', 'Rate %', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total tax', 'Service/other charges', 'Tip', 'Invoice total', 'Adds up'],
        report.invoices.map((i) => [i.billNo, i.orderId, dayOf(i.date, tz), i.customerGstin, i.rate, i.taxable, i.cgst, i.sgst, i.igst, i.tax, i.otherCharges, i.tip, i.total, i.reconciled ? 'yes' : 'NO']));
    const x = wb.addWorksheet('Cancelled and refunded');
    for (const [title, rows] of EXCLUDED_SECTIONS(report)) {
        x.addRow([title]).font = { bold: true };
        x.addRow(['Bill no', 'Order', 'Date', 'Taxable value', 'Tax', 'Total', 'Refunded']).font = { bold: true };
        rows.forEach((r) => x.addRow([r.billNo, r.orderId, dayOf(r.date, tz), r.taxable, r.tax, r.total, r.refunded]));
        x.addRow([]);
    }
    x.columns.forEach((c) => { c.width = 18; });
    return wb.xlsx.writeBuffer();
}

module.exports = {
    DISCLAIMER, DEFAULT_HSN, allocate, splitTax, toPaise, rupees, computeInvoice, resolveHsn,
    buildGstReport, isRegisterOrder, gstReportCsv, dailySalesCsv, gstReportXlsx, csvCell, sanitiseGstin,
};
