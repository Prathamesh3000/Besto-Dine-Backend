'use strict';
/**
 * Tally Prime import XML for paid bills (pure: no DB).
 *
 * One Sales voucher per paid bill:
 *   credit  Sales (taxable value), Output CGST, Output SGST,
 *           service charge, other charges, tips
 *   debit   one entry per tender actually used (Cash / UPI / Card / ...)
 *           taken from order.payments[] or the legacy paymentMethod
 *           (utils/orderTenders), loyalty points redeemed, manual
 *           discount, and the remainder on the party ledger
 *           ('Cash' or 'Sundry Debtors', configurable)
 *   a Round Off line only when an older bill's stored parts do not add
 *   up to its total, so every voucher balances exactly.
 *
 * Ledgers must already exist in Tally under these names (or be created by
 * the accountant); names are configurable in settings (taxExport.ledgers).
 *
 * EXPORT AID ONLY. Not a tax filing tool: ask your CA / accountant to
 * review the import. E-invoice (IRN) is not covered.
 */
const { computeInvoice, isRegisterOrder, DISCLAIMER } = require('./gstReport');
const { localParts } = require('./reportDates');

const DEFAULT_LEDGERS = Object.freeze({
    sales: 'Sales - Restaurant',
    outputCgst: 'Output CGST',
    outputSgst: 'Output SGST',
    serviceCharge: 'Service Charge Income',
    otherCharges: 'Other Charges Income',
    tips: 'Tips Payable',
    roundOff: 'Round Off',
    discount: 'Discount Allowed',
    partyCash: 'Cash',
    partyDebtors: 'Sundry Debtors',
    cash: 'Cash',
    upi: 'UPI Receipts',
    card: 'Card Receipts',
    wallet: 'Wallet / Loyalty Redemption',
    online: 'Online Payment Gateway',
    other: 'Other Receipts',
});

function resolveLedgers(custom = {}) {
    const out = { ...DEFAULT_LEDGERS };
    for (const k of Object.keys(DEFAULT_LEDGERS)) {
        const v = typeof custom?.[k] === 'string' ? custom[k].trim() : '';
        if (v) out[k] = v;
    }
    return out;
}

/** XML 1.0 escape; also drops characters XML forbids. */
function esc(v) {
    return String(v == null ? '' : v)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const amt = (paise) => (paise / 100).toFixed(2);

/**
 * Ledger entries for one invoice row. Returns [{ledger, paise, debit:boolean}]
 * with debits == credits exactly (paise).
 */
function voucherEntries(row, ledgers, partyMode) {
    const credits = [];
    const pushC = (ledger, paise) => { if (paise > 0) credits.push({ ledger, paise, debit: false }); };
    pushC(ledgers.sales, row.taxable);
    pushC(ledgers.outputCgst, row.cgst);
    pushC(ledgers.outputSgst, row.sgst);
    pushC(ledgers.serviceCharge, row.serviceCharge);
    pushC(ledgers.otherCharges, row.otherCharges);
    pushC(ledgers.tips, row.tip);
    const creditSum = credits.reduce((s, e) => s + e.paise, 0);

    const debits = [];
    const pushD = (ledger, paise) => { if (paise > 0) debits.push({ ledger, paise, debit: true }); };
    pushD(ledgers.wallet, row.points);
    pushD(ledgers.discount, row.manualDiscount);
    let remaining = creditSum - debits.reduce((s, e) => s + e.paise, 0);

    // Tenders, capped so we never debit more than the bill is worth.
    for (const t of row.tenders) {
        const take = Math.min(t.paise, Math.max(0, remaining));
        if (take > 0) {
            pushD(ledgers[t.method] || ledgers.other, take);
            remaining -= take;
        }
    }
    const party = partyMode === 'debtors' ? ledgers.partyDebtors : ledgers.partyCash;
    if (remaining > 0) pushD(party, remaining);
    // remaining < 0 cannot happen: the discount / points are part of the credit total.
    return { entries: [...debits, ...credits], party, creditSum };
}

function voucherXml(row, ledgers, tz, partyMode) {
    const p = localParts(new Date(row.date), tz);
    const date = `${p.y}${String(p.mo).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
    const { entries, party } = voucherEntries(row, ledgers, partyMode);
    const number = row.billNo || row.orderId || '';
    const narration = `Order ${row.orderId || ''}${row.billNo ? ` / Bill ${row.billNo}` : ''}${row.diff ? ' (older bill: parts do not sum to total)' : ''}`;
    const out = [];
    out.push('      <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    out.push('        <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">');
    out.push(`          <DATE>${date}</DATE>`);
    out.push('          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>');
    out.push(`          <VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER>`);
    out.push(`          <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>`);
    out.push(`          <NARRATION>${esc(narration)}</NARRATION>`);
    out.push('          <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>');
    // Round-off keeps legacy bills balanced.
    let first = true;
    let debitSum = 0;
    let creditSum = 0;
    for (const e of entries) { if (e.debit) debitSum += e.paise; else creditSum += e.paise; }
    const all = [...entries];
    if (debitSum !== creditSum) {
        const d = creditSum - debitSum;
        all.push({ ledger: ledgers.roundOff, paise: Math.abs(d), debit: d > 0 });
    }
    for (const e of all) {
        out.push('          <ALLLEDGERENTRIES.LIST>');
        out.push(`            <LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`);
        out.push(`            <ISDEEMEDPOSITIVE>${e.debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`);
        if (e.debit && first) { out.push('            <ISPARTYLEDGER>Yes</ISPARTYLEDGER>'); first = false; }
        out.push(`            <AMOUNT>${e.debit ? '-' : ''}${amt(e.paise)}</AMOUNT>`);
        out.push('          </ALLLEDGERENTRIES.LIST>');
    }
    out.push('        </VOUCHER>');
    out.push('      </TALLYMESSAGE>');
    return out.join('\n');
}

/**
 * @param {object} p
 * @param {object[]} p.orders          lean orders (non-register ones are skipped)
 * @param {object}  [p.ledgers]        settings.taxExport.ledgers
 * @param {string}  [p.partyMode]      'cash' | 'debtors'
 * @param {string}  [p.company]        Tally company name (SVCURRENTCOMPANY); blank = whatever is open
 * @param {string}  [p.tz]
 * @param {object}  [p.hsnCtx]         passed to computeInvoice
 */
function buildTallyXml({ orders = [], ledgers, partyMode = 'cash', company = '', tz, hsnCtx = {} } = {}) {
    const L = resolveLedgers(ledgers);
    const rows = orders.filter(isRegisterOrder)
        .map((o) => computeInvoice(o, hsnCtx))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<!-- ${esc(DISCLAIMER)} -->`);
    parts.push('<ENVELOPE>');
    parts.push('  <HEADER>');
    parts.push('    <TALLYREQUEST>Import Data</TALLYREQUEST>');
    parts.push('  </HEADER>');
    parts.push('  <BODY>');
    parts.push('    <IMPORTDATA>');
    parts.push('      <REQUESTDESC>');
    parts.push('        <REPORTNAME>Vouchers</REPORTNAME>');
    parts.push('        <STATICVARIABLES>');
    if (company) parts.push(`          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>`);
    parts.push('        </STATICVARIABLES>');
    parts.push('      </REQUESTDESC>');
    parts.push('      <REQUESTDATA>');
    for (const r of rows) parts.push(voucherXml(r, L, tz, partyMode));
    parts.push('      </REQUESTDATA>');
    parts.push('    </IMPORTDATA>');
    parts.push('  </BODY>');
    parts.push('</ENVELOPE>');
    return { xml: `${parts.join('\n')}\n`, voucherCount: rows.length, ledgers: L };
}

module.exports = { DEFAULT_LEDGERS, resolveLedgers, esc, voucherEntries, buildTallyXml };
