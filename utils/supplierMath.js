'use strict';
/**
 * Supplier invoice maths (Plan 3B.3). Pure, no DB: payment status, aging
 * buckets and the PO / GRN / invoice 3-way match.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPS = 0.005;

const outstandingOf = (inv) => Math.max(0, round2(round2(inv.total) - round2(inv.amountPaid)));

function statusFor(total, paid) {
    if (round2(paid) <= 0) return 'unpaid';
    return round2(paid) >= round2(total) - EPS ? 'paid' : 'partial';
}

const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'over90'];

function bucketOf(dueDate, asOf) {
    const days = Math.floor((new Date(asOf).getTime() - new Date(dueDate).getTime()) / DAY_MS);
    if (days <= 0) return 'notDue';
    if (days <= 30) return 'd1_30';
    if (days <= 60) return 'd31_60';
    if (days <= 90) return 'd61_90';
    return 'over90';
}

/**
 * Per-supplier aging of open invoices as of `asOf`, by days past due date.
 * invoices: [{ supplier, supplierName?, dueDate, total, amountPaid }]
 */
function agingBuckets(invoices, asOf = new Date()) {
    const bySupplier = new Map();
    const totals = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
    for (const inv of invoices || []) {
        const out = outstandingOf(inv);
        if (out <= 0) continue;
        const id = String(inv.supplier?._id || inv.supplier);
        if (!bySupplier.has(id)) {
            bySupplier.set(id, {
                supplier: id,
                supplierName: inv.supplierName || inv.supplier?.name || '',
                notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0, invoices: 0,
            });
        }
        const row = bySupplier.get(id);
        const b = bucketOf(inv.dueDate, asOf);
        row[b] = round2(row[b] + out);
        row.total = round2(row.total + out);
        row.invoices += 1;
        totals[b] = round2(totals[b] + out);
        totals.total = round2(totals.total + out);
    }
    return { asOf: new Date(asOf), rows: [...bySupplier.values()].sort((a, b) => b.total - a.total), totals };
}

const idOf = (v) => String(v?._id || v || '');

/**
 * 3-way match of one purchase order against its goods receipts and the
 * supplier invoices raised against it.
 *
 *   received value = sum(received qty * rate * (1 + tax%))    (from GRN lines)
 *   invoiced total = sum(invoice.total)
 *   AMOUNT_MISMATCH when they differ by more than `tolerance` (rupees).
 * Quantity flags need invoice.lines; invoices without lines are matched on
 * amount only.
 */
function threeWayMatch(po, invoices = [], { tolerance = 1 } = {}) {
    const receivedByItem = new Map();
    for (const r of po.receipts || []) {
        for (const l of r.lines || []) {
            const k = idOf(l.inventoryItem);
            receivedByItem.set(k, (receivedByItem.get(k) || 0) + (Number(l.qty) || 0));
        }
    }
    const withLines = invoices.filter((i) => Array.isArray(i.lines) && i.lines.length);
    const invoicedByItem = new Map();
    for (const inv of withLines) {
        for (const l of inv.lines) {
            const k = idOf(l.inventoryItem);
            invoicedByItem.set(k, (invoicedByItem.get(k) || 0) + (Number(l.qty) || 0));
        }
    }

    const flags = new Set();
    let receivedValue = 0;
    const lines = (po.lines || []).map((l) => {
        const k = idOf(l.inventoryItem);
        const ordered = Number(l.orderedQty) || 0;
        const received = round2(receivedByItem.get(k) || 0);
        const invoiced = withLines.length ? round2(invoicedByItem.get(k) || 0) : null;
        receivedValue += received * (Number(l.rate) || 0) * (1 + (Number(l.taxPercent) || 0) / 100);
        const lf = [];
        if (received > ordered + EPS) lf.push('OVER_RECEIVED');
        if (po.status === 'received' && received < ordered - EPS) lf.push('SHORT_RECEIVED');
        if (invoiced !== null) {
            if (invoiced > received + EPS) lf.push('INVOICED_QTY_EXCEEDS_RECEIVED');
            else if (invoiced < received - EPS) lf.push('RECEIVED_NOT_FULLY_INVOICED');
        }
        lf.forEach((f) => flags.add(f));
        return { inventoryItem: k, name: l.name, unit: l.unit, rate: l.rate, ordered, received, invoiced, flags: lf };
    });
    receivedValue = round2(receivedValue);
    const invoicedTotal = round2(invoices.reduce((s, i) => s + (Number(i.total) || 0), 0));
    const difference = round2(invoicedTotal - receivedValue);

    let status;
    if (!invoices.length) {
        flags.add('NO_INVOICE');
        status = receivedValue > 0 ? 'no-invoice' : 'pending';
    } else {
        if (receivedValue <= 0) flags.add('INVOICED_NOT_RECEIVED');
        if (Math.abs(difference) > tolerance) flags.add('AMOUNT_MISMATCH');
        const qtyOrAmountBad = [...flags].some((f) => f !== 'SHORT_RECEIVED' && f !== 'NO_INVOICE');
        status = qtyOrAmountBad ? 'mismatch' : 'matched';
    }
    return {
        purchaseOrder: idOf(po._id),
        poNumber: po.poNumber,
        supplier: idOf(po.supplier),
        supplierName: po.supplierName || '',
        poStatus: po.status,
        status,
        flags: [...flags],
        poValue: round2(po.grandTotal),
        receivedValue,
        invoicedTotal,
        difference,
        invoices: invoices.map((i) => ({ _id: idOf(i._id), invoiceNo: i.invoiceNo, total: round2(i.total) })),
        lines,
    };
}

module.exports = { round2, outstandingOf, statusFor, bucketOf, agingBuckets, threeWayMatch, BUCKETS };
