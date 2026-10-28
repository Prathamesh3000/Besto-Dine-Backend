'use strict';
/**
 * Bill workspace helpers (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 3, D4).
 *
 *  - nextBillNo   sequential bill number per restaurant + branch (atomic
 *                 $inc upsert on models/billCounter.js). The codebase had no
 *                 sequential bill/invoice number to reuse: Invoice.invoiceNumber
 *                 is `INV-<timestamp>-<orderId>` and orderId is per order.
 *  - assertBillNotFinal  the item/discount lock: every path that adds to or
 *                 re-prices a bill calls this and gets a 409 BILL_FINALIZED
 *                 while the bill is final (a captain+ must reopen it first).
 */
const BillCounter = require('../models/billCounter');
const { httpError } = require('../services/orderErrors');

/** Next bill number for restaurant + branch (null branch = tenant-level orders). */
async function nextBillNo(restaurantId, branchId = null) {
    if (!restaurantId) return null;
    const counter = await BillCounter.findOneAndUpdate(
        { restaurant: restaurantId, branch: branchId || null },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
    ).lean();
    return counter.seq;
}

const isBillFinal = (order) => order?.bill?.status === 'final';

function billFinalizedError(order) {
    const no = order?.bill?.billNo != null ? ` (Bill No ${order.bill.billNo})` : '';
    return httpError(409, {
        success: false,
        code: 'BILL_FINALIZED',
        message: `The bill for ${order?.orderId || 'this order'} is finalised${no}. Ask a captain to reopen it before changing items or discounts.`,
    });
}

/** Throws 409 BILL_FINALIZED when the order's bill is final. */
function assertBillNotFinal(order) {
    if (isBillFinal(order)) throw billFinalizedError(order);
}

/** Client-safe shape of order.bill. */
function publicBill(order) {
    const b = order?.bill;
    if (!b) return null;
    return {
        status: b.status || 'draft',
        billNo: b.billNo ?? null,
        savedAt: b.savedAt || null,
        savedBy: b.savedBy ? String(b.savedBy) : null,
        reopenedAt: b.reopenedAt || null,
        reopenedBy: b.reopenedBy ? String(b.reopenedBy) : null,
        reopenReason: b.reopenReason || '',
        total: Number(b.total) || 0,
    };
}

module.exports = { nextBillNo, isBillFinal, assertBillNotFinal, billFinalizedError, publicBill };
