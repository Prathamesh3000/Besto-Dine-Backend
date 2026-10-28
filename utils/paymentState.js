'use strict';
/**
 * Payment state block + derived table billing state
 * (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 4). Everything here is ADDITIVE: it
 * never touches order.paymentStatus or table.status.
 *
 *  - order.payment.state  none | pending | paid | failed
 *      pending  Razorpay checkout opened (create-order)
 *      paid     a verified path settled the order (verify / webhook /
 *               reconciliation) or staff settled it (cash / manual)
 *      failed   signature / amount mismatch on verify, or the gateway's
 *               payment.failed webhook
 *  - billingState (derived, per table)
 *      payment_pending | payment_failed | print_failed | billing_pending | null
 */
const Order = require('../models/order');
const logger = require('./logger');

const UNSETTLED = { $nin: ['Paid', 'Refunded'] };
const OPEN_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Client-safe shape of order.payment (always an object). */
function publicPayment(order) {
    const p = order?.payment || {};
    return {
        state: p.state || 'none',
        method: p.method || '',
        amount: Number(p.amount) || 0,
        reference: p.reference || '',
        cashReceived: p.cashReceived ?? null,
        changeDue: p.changeDue ?? null,
        failureReason: p.failureReason || '',
        updatedAt: p.updatedAt || null,
        updatedBy: p.updatedBy ? String(p.updatedBy) : null,
    };
}

/** $set fragment for a verified / staff-settled payment. */
function paidSet({ method = '', amount = 0, reference = '', cashReceived = null, changeDue = null, userId = null } = {}) {
    return {
        'payment.state': 'paid',
        'payment.method': String(method || ''),
        'payment.amount': round2(amount),
        'payment.reference': String(reference || ''),
        'payment.cashReceived': cashReceived,
        'payment.changeDue': changeDue,
        'payment.failureReason': '',
        'payment.updatedAt': new Date(),
        'payment.updatedBy': userId || null,
    };
}

/**
 * pending -> failed helpers. Both refuse to touch an order that is already
 * settled (a late failure must never downgrade a paid order) and report
 * whether the order changed.
 */
async function markPaymentPending(filter, { amount, method = 'online', reference = '', userId = null } = {}) {
    try {
        const res = await Order.updateOne(
            { ...filter, paymentStatus: UNSETTLED, 'payment.state': { $ne: 'paid' } },
            { $set: {
                'payment.state': 'pending',
                'payment.method': method,
                'payment.amount': round2(amount),
                'payment.reference': String(reference || ''),
                'payment.cashReceived': null,
                'payment.changeDue': null,
                'payment.failureReason': '',
                'payment.updatedAt': new Date(),
                'payment.updatedBy': userId || null,
            } },
        );
        return res.modifiedCount > 0;
    } catch (err) {
        logger.warn('markPaymentPending failed (non-fatal)', { error: err.message });
        return false;
    }
}

async function markPaymentFailed(filter, { reason = '', reference = '', amount = null, method = 'online', userId = null } = {}) {
    try {
        const set = {
            'payment.state': 'failed',
            'payment.method': method,
            'payment.failureReason': String(reason || '').slice(0, 200),
            'payment.updatedAt': new Date(),
            'payment.updatedBy': userId || null,
        };
        if (reference) set['payment.reference'] = String(reference);
        if (amount != null) set['payment.amount'] = round2(amount);
        const res = await Order.updateOne(
            { ...filter, paymentStatus: UNSETTLED, 'payment.state': { $ne: 'paid' } },
            { $set: set },
        );
        return res.modifiedCount > 0;
    } catch (err) {
        logger.warn('markPaymentFailed failed (non-fatal)', { error: err.message });
        return false;
    }
}

/** Billing state of ONE table from its unpaid orders (+ ids with a failed latest bill print). */
const STALE_PENDING_MS = 30 * 60 * 1000;
function isLivePending(o, now = Date.now()) {
    if (o.payment?.state !== 'pending') return false;
    const at = o.payment.updatedAt ? new Date(o.payment.updatedAt).getTime() : NaN;
    // An abandoned checkout (pending > 30 min) must not mask later chips.
    return !(Number.isFinite(at) && now - at > STALE_PENDING_MS);
}

function billingStateOf(orders, printFailedOrderIds = new Set()) {
    const unpaid = (orders || []).filter((o) => !['Paid', 'Refunded'].includes(o.paymentStatus));
    if (!unpaid.length) return null;
    if (unpaid.some((o) => isLivePending(o))) return 'payment_pending';
    if (unpaid.some((o) => o.payment?.state === 'failed')) return 'payment_failed';
    if (unpaid.some((o) => printFailedOrderIds.has(String(o._id)))) return 'print_failed';
    if (unpaid.some((o) => o.bill?.status === 'draft' || o.bill?.status === 'final' || o.counterPaymentRequestedAt)) {
        return 'billing_pending';
    }
    return null;
}

/**
 * Map<tableId, billingState|null> for the given tables. `restaurantFilter` is
 * the tenant clause ({ restaurant }) - always passed so the lookups stay scoped.
 */
async function billingStatesForTables(tableIds, restaurantFilter = {}) {
    const out = new Map();
    const ids = (tableIds || []).filter(Boolean);
    if (!ids.length) return out;
    const orders = await Order.find({
        table: { $in: ids },
        status: { $in: OPEN_STATUSES },
        paymentStatus: UNSETTLED,
        ...restaurantFilter,
    }).select('_id table paymentStatus bill.status payment.state payment.updatedAt counterPaymentRequestedAt').lean();
    if (!orders.length) return out;

    // Latest bill print job per order; failed => print_failed.
    const PrintJob = require('../models/printJob');
    const jobs = await PrintJob.find({
        order: { $in: orders.map((o) => o._id) },
        kind: 'bill',
        ...restaurantFilter,
    }).select('order status createdAt').sort({ createdAt: -1 }).lean();
    const latest = new Map();
    for (const j of jobs) { if (!latest.has(String(j.order))) latest.set(String(j.order), j.status); }
    const printFailed = new Set([...latest].filter(([, s]) => s === 'failed').map(([id]) => id));

    const byTable = new Map();
    for (const o of orders) {
        const k = String(o.table);
        if (!byTable.has(k)) byTable.set(k, []);
        byTable.get(k).push(o);
    }
    for (const [k, list] of byTable) out.set(k, billingStateOf(list, printFailed));
    return out;
}

/** Best-effort socket nudge so floor views refresh the chip. */
async function emitBillingState(order) {
    try {
        if (!order || !order.table) return;
        const Table = require('../models/table');
        const EVENTS = require('../realtime/events');
        const { getIO, emitToStaff } = require('./socket');
        const tableId = order.table._id || order.table;
        const table = await Table.findOne({ _id: tableId, restaurant: order.restaurant }).select('status branch').lean();
        if (!table) return;
        const map = await billingStatesForTables([table._id], { restaurant: order.restaurant });
        emitToStaff(getIO(), table.branch, EVENTS.TABLE_UPDATED, {
            tableId: String(table._id),
            status: table.status,
            billingState: map.get(String(table._id)) || null,
        });
    } catch { /* best-effort */ }
}

module.exports = {
    publicPayment, paidSet, markPaymentPending, markPaymentFailed,
    billingStateOf, billingStatesForTables, emitBillingState, round2,
};
