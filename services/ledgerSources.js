'use strict';
/**
 * Read-only loaders for the ledger-lite "post day" service and the daily cash
 * closing (Plan 3B.3 / 3B.5). Everything is read through the existing models;
 * no payment flow is touched. Orders are read via utils/tenders.getTenders so
 * order.payments[] is used when present and the legacy fields otherwise.
 *
 * `branchClause` is {} (whole tenant), { branch: id } or { branch: { $in: [id, null] } }.
 */
const Order = require('../models/order');
const Expense = require('../models/expense');
const SupplierPayment = require('../models/supplierPayment');
const SupplierInvoice = require('../models/supplierInvoice');
const PurchaseOrder = require('../models/purchaseOrder');
const { getTenders } = require('../utils/tenders');
const { dominantMethod, round2 } = require('../utils/ledgerPostings');

const MAX_DOCS = 20000;
const inRange = (d, start, end) => !!d && new Date(d) >= start && new Date(d) < end;

async function loadSources({ restaurantId, start, end, branchClause = {} }) {
    const range = { $gte: start, $lt: end };

    const paidOrders = await Order.find({
        restaurant: restaurantId,
        ...branchClause,
        $or: [{ paidAt: range }, { 'payments.at': range }],
    }).select('orderId branch total gst amountPaid paymentMethod walletAmountPaid paidAt payments razorpayPaymentId').limit(MAX_DOCS).lean();

    const tenders = [];
    for (const order of paidOrders) {
        getTenders(order).forEach((line, index) => {
            if (inRange(line.at || order.paidAt, start, end)) tenders.push({ order, line, index });
        });
    }

    const refundOrders = await Order.find({
        restaurant: restaurantId,
        ...branchClause,
        'refunds.createdAt': range,
    }).select('orderId branch total gst amountPaid paymentMethod walletAmountPaid paidAt payments razorpayPaymentId refunds').limit(MAX_DOCS).lean();

    const refunds = [];
    for (const order of refundOrders) {
        (order.refunds || []).forEach((refund, index) => {
            if (inRange(refund.createdAt, start, end) && Number(refund.amount) > 0) refunds.push({ order, refund, index });
        });
    }

    const expenses = await Expense.find({
        restaurant: restaurantId, ...branchClause, status: 'active', date: range,
    }).limit(MAX_DOCS).lean();

    const supplierPayments = await SupplierPayment.find({
        restaurant: restaurantId, ...branchClause, date: range,
    }).limit(MAX_DOCS).lean();

    const invoices = await SupplierInvoice.find({
        restaurant: restaurantId, ...branchClause, invoiceDate: range,
    }).limit(MAX_DOCS).lean();

    // Legacy PO payments, only for POs that have no SupplierInvoice (those are
    // settled through SupplierPayment instead, so counting both would double up).
    const pos = await PurchaseOrder.find({
        restaurant: restaurantId, ...branchClause, 'payments.paidAt': range,
    }).select('poNumber branch payments').limit(MAX_DOCS).lean();
    let invoicedPoIds = new Set();
    if (pos.length) {
        const linked = await SupplierInvoice.find({
            restaurant: restaurantId, purchaseOrder: { $in: pos.map((p) => p._id) },
        }).select('purchaseOrder').lean();
        invoicedPoIds = new Set(linked.map((i) => String(i.purchaseOrder)));
    }
    const poPayments = [];
    for (const po of pos) {
        if (invoicedPoIds.has(String(po._id))) continue;
        for (const payment of po.payments || []) {
            if (inRange(payment.paidAt, start, end) && Number(payment.amount) > 0) poPayments.push({ po, payment });
        }
    }

    return { tenders, refunds, expenses, supplierPayments, invoices, poPayments };
}

/** Cash movements of a loaded day: { cashSales, cashRefunds, cashPaidOuts }. */
function summarizeCash(src) {
    const cashSales = src.tenders.filter((t) => t.line.method === 'cash').reduce((s, t) => s + t.line.amount, 0);
    const cashRefunds = src.refunds.filter((r) => dominantMethod(r.order) === 'cash').reduce((s, r) => s + Number(r.refund.amount), 0);
    const cashPaidOuts =
        src.expenses.filter((e) => e.method === 'cash').reduce((s, e) => s + Number(e.amount), 0)
        + src.supplierPayments.filter((p) => p.method === 'cash').reduce((s, p) => s + Number(p.amount), 0)
        + src.poPayments.filter((p) => p.payment.mode === 'cash').reduce((s, p) => s + Number(p.payment.amount), 0);
    return { cashSales: round2(cashSales), cashRefunds: round2(cashRefunds), cashPaidOuts: round2(cashPaidOuts) };
}

module.exports = { loadSources, summarizeCash };
