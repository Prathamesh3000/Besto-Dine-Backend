'use strict';
/**
 * Ledger-lite posting builders (Plan 3B.3). Pure, no DB: each builder turns
 * one source document into a balanced batch of lines
 * { branch, businessDate, account, debit, credit, refType, refId, narration, key }.
 *
 * Orders are read through utils/tenders.getTenders, which uses payments[]
 * when present and falls back to the legacy paymentMethod / amountPaid, so
 * this file never depends on the payment flow itself.
 */
const { getTenders, normalizeMethod, totalsByMethod } = require('./tenders');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const ACCOUNTS = {
    CASH: '1000',
    BANK: '1010',
    CARD: '1020',
    INVENTORY: '1100',
    INPUT_GST: '1200',
    AP: '2000',
    WALLET: '2100',
    OUTPUT_GST: '2200',
    EQUITY: '3000',
    SALES: '4000',
    PURCHASES: '5000',
    EXPENSES: '5100',
};

const DEFAULT_CHART = [
    { code: ACCOUNTS.CASH, name: 'Cash in hand', type: 'asset' },
    { code: ACCOUNTS.BANK, name: 'Bank / UPI / Online', type: 'asset' },
    { code: ACCOUNTS.CARD, name: 'Card receipts', type: 'asset' },
    { code: ACCOUNTS.INVENTORY, name: 'Inventory', type: 'asset' },
    { code: ACCOUNTS.INPUT_GST, name: 'Input GST (on purchases)', type: 'asset' },
    { code: ACCOUNTS.AP, name: 'Accounts payable (suppliers)', type: 'liability' },
    { code: ACCOUNTS.WALLET, name: 'Customer wallet liability', type: 'liability' },
    { code: ACCOUNTS.OUTPUT_GST, name: 'Output GST payable', type: 'liability' },
    { code: ACCOUNTS.EQUITY, name: "Owner's equity", type: 'equity' },
    { code: ACCOUNTS.SALES, name: 'Sales', type: 'income' },
    { code: ACCOUNTS.PURCHASES, name: 'Purchases / COGS', type: 'expense' },
    { code: ACCOUNTS.EXPENSES, name: 'Operating expenses', type: 'expense' },
];

/** Where a customer tender lands. */
function accountForTender(method) {
    switch (normalizeMethod(method) || 'other') {
        case 'cash': return ACCOUNTS.CASH;
        case 'card': return ACCOUNTS.CARD;
        case 'wallet': return ACCOUNTS.WALLET;
        default: return ACCOUNTS.BANK; // upi, razorpay, other
    }
}

/** Where a payment we make (expense / supplier payment) is drawn from. */
function accountForPayout(method) {
    const m = String(method || '').toLowerCase();
    if (m === 'cash') return ACCOUNTS.CASH;
    if (m === 'card') return ACCOUNTS.CARD;
    return ACCOUNTS.BANK;
}

const idStr = (v) => (v === null || v === undefined ? null : String(v._id || v));

/** Method that took most of the order's money; refunds are assumed to go back the same way. */
function dominantMethod(order) {
    const by = totalsByMethod(getTenders(order));
    let best = '';
    let bestAmt = -1;
    for (const [m, a] of Object.entries(by)) if (a > bestAmt) { best = m; bestAmt = a; }
    return best || 'other';
}

/** Share of an order's billed total that is GST (0..1). */
function gstRatio(order) {
    const gross = Number(order.total) > 0 ? Number(order.total) : Number(order.amountPaid) || 0;
    const gst = Number(order.gst) || 0;
    if (gross <= 0 || gst <= 0) return 0;
    return Math.min(1, gst / gross);
}

function batch(base, spec) {
    const out = [];
    for (const [account, side, amount, narration] of spec) {
        const amt = round2(amount);
        if (amt <= 0) continue;
        out.push({
            branch: base.branch ?? null,
            businessDate: base.businessDate,
            account,
            debit: side === 'dr' ? amt : 0,
            credit: side === 'cr' ? amt : 0,
            refType: base.refType,
            refId: base.refId,
            narration: narration || base.narration || '',
            key: `${base.refType}:${base.refId}:${account}:${side}`,
        });
    }
    return out;
}

/** Customer tender line: Dr tender account / Cr Sales + Cr Output GST. */
function buildTenderPosting({ order, line, index, businessDate }) {
    const amount = round2(line.amount);
    const gst = round2(amount * gstRatio(order));
    const base = {
        branch: idStr(order.branch), businessDate, refType: 'order-tender',
        refId: `${idStr(order._id)}:${index}`, narration: `Order ${order.orderId || idStr(order._id)} (${line.method})`,
    };
    return batch(base, [
        [accountForTender(line.method), 'dr', amount],
        [ACCOUNTS.SALES, 'cr', amount - gst],
        [ACCOUNTS.OUTPUT_GST, 'cr', gst],
    ]);
}

/** Refund: Dr Sales + Dr Output GST (reversal) / Cr the tender account it went back to. */
function buildRefundPosting({ order, refund, index, businessDate }) {
    const amount = round2(refund.amount);
    const gst = round2(amount * gstRatio(order));
    const base = {
        branch: idStr(order.branch), businessDate, refType: 'order-refund',
        refId: `${idStr(order._id)}:${index}`, narration: `Refund ${order.orderId || idStr(order._id)}`,
    };
    return batch(base, [
        [ACCOUNTS.SALES, 'dr', amount - gst],
        [ACCOUNTS.OUTPUT_GST, 'dr', gst],
        [accountForTender(dominantMethod(order)), 'cr', amount],
    ]);
}

function buildExpensePosting({ expense, businessDate }) {
    const base = {
        branch: idStr(expense.branch), businessDate, refType: 'expense', refId: idStr(expense._id),
        narration: `Expense: ${expense.category || 'General'}${expense.note ? ` - ${expense.note}` : ''}`.slice(0, 300),
    };
    return batch(base, [
        [ACCOUNTS.EXPENSES, 'dr', expense.amount],
        [accountForPayout(expense.method), 'cr', expense.amount],
    ]);
}

/** Supplier invoice: Dr Purchases (net) + Dr Input GST / Cr Accounts payable. */
function buildInvoicePosting({ invoice, businessDate }) {
    const total = round2(invoice.total);
    const tax = Math.min(round2(invoice.tax), total);
    const base = {
        branch: idStr(invoice.branch), businessDate, refType: 'supplier-invoice', refId: idStr(invoice._id),
        narration: `Supplier invoice ${invoice.invoiceNo}`,
    };
    return batch(base, [
        [ACCOUNTS.PURCHASES, 'dr', total - tax],
        [ACCOUNTS.INPUT_GST, 'dr', tax],
        [ACCOUNTS.AP, 'cr', total],
    ]);
}

function buildSupplierPaymentPosting({ payment, businessDate }) {
    const base = {
        branch: idStr(payment.branch), businessDate, refType: 'supplier-payment', refId: idStr(payment._id),
        narration: `Supplier payment${payment.reference ? ` ${payment.reference}` : ''}`,
    };
    return batch(base, [
        [ACCOUNTS.AP, 'dr', payment.amount],
        [accountForPayout(payment.method), 'cr', payment.amount],
    ]);
}

/** Legacy PO payment on a PO that has no SupplierInvoice: Dr Purchases / Cr cash-or-bank. */
function buildPoPaymentPosting({ po, payment, businessDate }) {
    const base = {
        branch: idStr(po.branch), businessDate, refType: 'po-payment', refId: `${idStr(po._id)}:${idStr(payment._id)}`,
        narration: `PO ${po.poNumber} payment`,
    };
    return batch(base, [
        [ACCOUNTS.PURCHASES, 'dr', payment.amount],
        [accountForPayout(payment.mode), 'cr', payment.amount],
    ]);
}

/** Group lines by batch (refType:refId) and verify debits == credits. Throws on imbalance. */
function assertBalanced(lines) {
    const sums = new Map();
    for (const l of lines) {
        const k = `${l.refType}:${l.refId}`;
        const s = sums.get(k) || { dr: 0, cr: 0 };
        s.dr += l.debit;
        s.cr += l.credit;
        sums.set(k, s);
    }
    for (const [k, s] of sums) {
        if (Math.abs(round2(s.dr) - round2(s.cr)) > 0.005) {
            throw new Error(`Unbalanced ledger batch ${k}: debit ${round2(s.dr)} != credit ${round2(s.cr)}`);
        }
    }
    return true;
}

module.exports = {
    ACCOUNTS, DEFAULT_CHART, round2, accountForTender, accountForPayout, dominantMethod, gstRatio,
    buildTenderPosting, buildRefundPosting, buildExpensePosting, buildInvoicePosting,
    buildSupplierPaymentPosting, buildPoPaymentPosting, assertBalanced,
};
