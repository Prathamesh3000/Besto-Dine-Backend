'use strict';
/**
 * Bill workspace (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 3, D4): Save Bill,
 * Reopen and Bill Preview for staff.
 *
 *   POST /orders/:id/bill/save    { final?: boolean }  draft (default) | final
 *   POST /orders/:id/bill/reopen  { reason }           captain / admin / manager
 *   GET  /orders/:id/bill/preview                      the exact slip the printer gets
 *
 * Saving never touches paymentStatus or any payment field. A FINAL bill
 * locks items and discount (utils/billWorkspace.assertBillNotFinal is
 * called by every item/discount-changing path). The payable total is
 * snapshotted with utils/receiptRenderer.billTotals, the same derivation
 * the printed slip uses.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const logger = require('../utils/logger');
const { tenantFilter, pinnedBranchId } = require('../utils/tenantScope');
const { httpError, reply } = require('./orderErrors');
const { emitOrderEvent } = require('./orderHelpers');
const printService = require('./printService');
const { billTotals, toPlainText } = require('../utils/receiptRenderer');
const { formatBillNo } = require('../utils/billNumber');
const { allocateBillNo, publicBill } = require('../utils/billWorkspace');
const upiPayment = require('./upiPayment');
const { recordTenantAudit } = require('./tenantAuditService');
const { buildUpiUri, buildNote, amountDue, maskVpa, qrDataUrl, MAX_UPI_AMOUNT } = require('../utils/upiQr');

const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v);
const notFound = () => httpError(404, { success: false, message: 'Order not found' });

async function loadOrder(req, { lean = false, populate = false } = {}) {
    const { id } = req.params;
    if (!isObjectId(id)) throw notFound();
    let q = Order.findOne({ _id: id, ...tenantFilter(req) });
    if (populate) q = q.populate('table', 'name mergedWith status').populate('waiter', 'name');
    if (lean) q = q.lean();
    const order = await q;
    if (!order) throw notFound();
    const pinned = pinnedBranchId(req);
    if (pinned && order.branch && String(order.branch) !== String(pinned)) throw notFound();
    return order;
}

function assertSavable(order) {
    if (order.status === 'cancelled') {
        throw httpError(409, { success: false, code: 'ORDER_CANCELLED', message: `Order ${order.orderId} is cancelled — there is no bill to save.` });
    }
    if (order.paymentStatus === 'Paid' || order.paymentStatus === 'Refunded') {
        throw httpError(409, { success: false, code: 'ORDER_ALREADY_PAID', message: `Order ${order.orderId} is already ${String(order.paymentStatus).toLowerCase()} — its bill can no longer be changed.` });
    }
}

/** Reserve the order's bill number (+ its financial year) once; concurrent saves converge on one number. */
async function claimBillNo(order) {
    if (order.bill && order.bill.billNo != null) return { billNo: order.bill.billNo, financialYear: order.bill.financialYear || null };
    const { billNo: n, financialYear } = await allocateBillNo(order.restaurant, order.branch || null);
    const won = await Order.findOneAndUpdate(
        { _id: order._id, restaurant: order.restaurant, 'bill.billNo': null },
        { $set: { 'bill.billNo': n, 'bill.financialYear': financialYear } },
        { returnDocument: 'after', projection: { bill: 1 } },
    ).lean();
    if (won) return { billNo: won.bill.billNo, financialYear: won.bill.financialYear || null };
    // Lost a race: another save already stamped the order (our number is simply skipped).
    const current = await Order.findOne({ _id: order._id, restaurant: order.restaurant }).select('bill').lean();
    return current?.bill?.billNo != null
        ? { billNo: current.bill.billNo, financialYear: current.bill.financialYear || null }
        : { billNo: n, financialYear };
}

async function saveBill(req) {
    const order = await loadOrder(req);
    assertSavable(order);
    const wantFinal = req.body?.final === true;

    if (order.bill?.status === 'final') {
        if (wantFinal) return reply(200, { success: true, orderId: order.orderId, paymentStatus: order.paymentStatus, bill: publicBill(order), unchanged: true });
        throw httpError(409, { success: false, code: 'BILL_FINALIZED', message: 'This bill is finalised. Ask a captain to reopen it before saving it as a draft.' });
    }

    const { billNo, financialYear } = await claimBillNo(order);
    const total = billTotals(order).payable;
    const now = new Date();
    const entry = { action: wantFinal ? 'finalize' : 'save', at: now, by: req.user?._id || null, total };
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, restaurant: order.restaurant, 'bill.status': { $ne: 'final' } },
        {
            $set: { 'bill.status': wantFinal ? 'final' : 'draft', 'bill.billNo': billNo, 'bill.financialYear': financialYear, 'bill.savedAt': now, 'bill.savedBy': req.user?._id || null, 'bill.total': total },
            $push: { 'bill.history': { $each: [entry], $slice: -20 } },
        },
        { returnDocument: 'after' },
    ).lean();
    if (!updated) {
        throw httpError(409, { success: false, code: 'BILL_FINALIZED', message: 'This bill was finalised just now. Ask a captain to reopen it.' });
    }
    logger.info(`bill: ${wantFinal ? 'finalised' : 'saved'} ${updated.orderId} billNo=${formatBillNo({ billNo, financialYear })} total=${total} by ${req.user?._id}`);
    recordTenantAudit(req, { action: wantFinal ? 'bill.finalize' : 'bill.edit', entityType: 'order', entityId: updated.orderId, summary: `Bill ${wantFinal ? 'finalised' : 'saved as draft'} for order ${updated.orderId}`, before: { status: order.bill?.status || null }, after: { status: wantFinal ? 'final' : 'draft', billNo, total } });
    const bill = publicBill(updated);
    return reply(200, { success: true, orderId: updated.orderId, paymentStatus: updated.paymentStatus, bill }, [
        ['bill-saved-event', async () => emitOrderEvent('order:updated', { orderId: updated.orderId, bill: { status: bill.status, billNo: bill.billNo, financialYear: bill.financialYear, billNoDisplay: bill.billNoDisplay } }, updated)],
    ]);
}

async function reopenBill(req) {
    const order = await loadOrder(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3) {
        throw httpError(400, { success: false, code: 'REASON_REQUIRED', message: 'Give a reason (at least 3 characters) for reopening the bill.' });
    }
    assertSavable(order);
    if (order.bill?.status !== 'final') {
        throw httpError(409, { success: false, code: 'BILL_NOT_FINAL', message: 'This bill is not finalised, so there is nothing to reopen.' });
    }
    const now = new Date();
    const entry = { action: 'reopen', at: now, by: req.user?._id || null, reason: reason.slice(0, 300), total: Number(order.bill.total) || 0 };
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, restaurant: order.restaurant, 'bill.status': 'final' },
        {
            $set: { 'bill.status': 'draft', 'bill.reopenedAt': now, 'bill.reopenedBy': req.user?._id || null, 'bill.reopenReason': reason.slice(0, 300) },
            $push: { 'bill.history': { $each: [entry], $slice: -20 } },
        },
        { returnDocument: 'after' },
    ).lean();
    if (!updated) throw httpError(409, { success: false, code: 'BILL_NOT_FINAL', message: 'This bill is not finalised, so there is nothing to reopen.' });
    logger.info(`bill: REOPENED ${updated.orderId} billNo=${formatBillNo(updated.bill)} by ${req.user?._id} (${req.user?.role}) reason="${reason.slice(0, 300)}"`);
    recordTenantAudit(req, { action: 'bill.edit', entityType: 'order', entityId: updated.orderId, summary: `Bill reopened for order ${updated.orderId}: ${reason.slice(0, 200)}`, before: { status: 'final', total: Number(order.bill.total) || 0 }, after: { status: 'draft', reason: reason.slice(0, 300) } });
    const bill = publicBill(updated);
    return reply(200, { success: true, orderId: updated.orderId, paymentStatus: updated.paymentStatus, bill }, [
        ['bill-reopened-event', async () => emitOrderEvent('order:updated', { orderId: updated.orderId, bill: { status: bill.status, billNo: bill.billNo, financialYear: bill.financialYear, billNoDisplay: bill.billNoDisplay } }, updated)],
    ]);
}

async function previewBill(req) {
    const order = await loadOrder(req, { lean: true, populate: true });
    const { document, printer } = await printService.previewBillDocument({ order });
    return reply(200, {
        success: true,
        orderId: order.orderId,
        bill: { status: order.bill?.status || null, billNo: order.bill?.billNo ?? null, financialYear: order.bill?.financialYear || null, billNoDisplay: formatBillNo(order.bill) || null, savedAt: order.bill?.savedAt || null },
        paymentStatus: order.paymentStatus,
        width: document.width,
        printer,
        totals: billTotals(order),
        lines: document.lines,
        text: toPlainText(document),
    });
}

/**
 * GET /orders/:id/upi-qr — UPI QR for the CURRENT amount due (total, which
 * already contains the tip, minus manual discount minus what was already
 * paid: the same figure a staff settle records). The money goes straight to
 * the restaurant's own UPI id (Settings -> payments); the app cannot see
 * it, so the captain confirms it with PATCH /orders/:id/status.
 */
async function upiQr(req) {
    const order = await loadOrder(req, { lean: true, populate: true });
    assertSavable(order); // 409 ORDER_CANCELLED | ORDER_ALREADY_PAID
    const payee = await upiPayment.resolvePayee(order.restaurant, order.branch);
    if (!payee) {
        throw httpError(409, { success: false, code: 'UPI_NOT_CONFIGURED', message: 'No UPI ID is set up for this restaurant. Ask an admin to add it in Settings.' });
    }
    const amount = amountDue(order);
    if (!(amount > 0)) {
        throw httpError(409, { success: false, code: 'NOTHING_DUE', message: `Order ${order.orderId} has nothing left to pay.` });
    }
    if (amount > MAX_UPI_AMOUNT) {
        throw httpError(409, { success: false, code: 'UPI_AMOUNT_TOO_HIGH', message: `The amount is above the UPI limit of ${MAX_UPI_AMOUNT}. Take part of it in cash or by card.` });
    }
    const { tableLabel } = await printService.resolveNames(order, String(order.restaurant));
    const upiUri = buildUpiUri({
        vpa: payee.vpa, payeeName: payee.name, amount,
        orderRef: order.orderId, note: buildNote({ tableLabel, orderId: order.orderId }),
    });
    return reply(200, {
        success: true,
        orderId: order.orderId,
        amount,
        payee: { name: payee.name, upiIdMasked: maskVpa(payee.vpa) },
        upiUri,
        qrDataUrl: await qrDataUrl(upiUri),
        billStatus: order.bill?.status || null,
        paymentStatus: order.paymentStatus,
        note: 'Amount is the balance due now; regenerate if the bill changes',
    });
}

module.exports = { saveBill, reopenBill, previewBill, upiQr };
