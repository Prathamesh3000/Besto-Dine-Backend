'use strict';
/**
 * Bill workspace helpers (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 3, D4).
 *
 *  - nextBillNo   sequential bill number per restaurant + branch, restarting
 *                 each Indian financial year (1 Apr - 31 Mar) (atomic
 *                 $inc upsert on models/billCounter.js). The codebase had no
 *                 sequential bill/invoice number to reuse: Invoice.invoiceNumber
 *                 is `INV-<timestamp>-<orderId>` and orderId is per order.
 *  - assertBillNotFinal  the item/discount lock: every path that adds to or
 *                 re-prices a bill calls this and gets a 409 BILL_FINALIZED
 *                 while the bill is final (a captain+ must reopen it first).
 */
const BillCounter = require('../models/billCounter');
const Restaurant = require('../models/restaurant');
const { httpError } = require('../services/orderErrors');
const { formatBillNo } = require('./billNumber');

const DEFAULT_TZ = 'Asia/Kolkata';

/** Indian financial year ('2026-27': 1 Apr 2026 - 31 Mar 2027) of `now` in `timeZone`. */
function financialYearOf(timeZone, now = new Date()) {
    let parts;
    const fmt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
    try { parts = fmt(timeZone || DEFAULT_TZ); } catch (_) { parts = fmt(DEFAULT_TZ); }
    const year = Number(parts.find((p) => p.type === 'year').value);
    const month = Number(parts.find((p) => p.type === 'month').value);
    const start = month >= 4 ? year : year - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

let legacyIndexDropped = false;
async function dropLegacyIndexOnce() {
    if (legacyIndexDropped) return;
    legacyIndexDropped = true;
    try { await BillCounter.collection.dropIndex('bill_counter_per_branch'); } catch (_) { /* already gone */ }
}

/**
 * Next bill number for restaurant + branch in the current financial year
 * (null branch = tenant-level orders). The series restarts each FY (1 April,
 * restaurant time zone). A pre-FY counter document is adopted once as the
 * first FY's series so existing numbering continues without a gap or reuse.
 */
async function nextBillNo(restaurantId, branchId = null, opts = {}) {
    const r = await allocateBillNo(restaurantId, branchId, opts);
    return r ? r.billNo : null;
}

/**
 * Same as nextBillNo but also returns the financial year whose counter was
 * used: { billNo, financialYear } (null when there is no restaurant). Callers
 * that store the number must store this FY with it (never recompute it).
 */
async function allocateBillNo(restaurantId, branchId = null, { timeZone, now } = {}) {
    if (!restaurantId) return null;
    let tz = timeZone;
    if (!tz) {
        const r = await Restaurant.findById(restaurantId).select('timezone').lean();
        tz = r?.timezone || DEFAULT_TZ;
    }
    const financialYear = financialYearOf(tz, now);
    const base = { restaurant: restaurantId, branch: branchId || null };
    const opts = { upsert: true, returnDocument: 'after' };

    await dropLegacyIndexOnce();
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            // 1) this FY's counter already exists -> plain atomic $inc.
            let counter = await BillCounter.findOneAndUpdate(
                { ...base, financialYear }, { $inc: { seq: 1 } }, { returnDocument: 'after' },
            ).lean();
            if (counter) return { billNo: counter.seq, financialYear };
            // 2) adopt the legacy (no-FY) counter, atomically, exactly once.
            counter = await BillCounter.findOneAndUpdate(
                { ...base, financialYear: null }, { $inc: { seq: 1 }, $set: { financialYear } }, { returnDocument: 'after' },
            ).lean();
            if (counter) return { billNo: counter.seq, financialYear };
            // 3) brand-new series for this FY.
            counter = await BillCounter.findOneAndUpdate(
                { ...base, financialYear }, { $inc: { seq: 1 } }, opts,
            ).lean();
            return { billNo: counter.seq, financialYear };
        } catch (err) {
            // Two first-saves of a new FY raced on the upsert: retry the $inc path.
            if (!(err && err.code === 11000) || attempt === 2) throw err;
        }
    }
    return null;
}

const isBillFinal = (order) => order?.bill?.status === 'final';

function billFinalizedError(order) {
    const no = order?.bill?.billNo != null ? ` (Bill No ${formatBillNo(order.bill)})` : '';
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
        financialYear: b.financialYear || null,
        billNoDisplay: formatBillNo(b) || null,
        savedAt: b.savedAt || null,
        savedBy: b.savedBy ? String(b.savedBy) : null,
        reopenedAt: b.reopenedAt || null,
        reopenedBy: b.reopenedBy ? String(b.reopenedBy) : null,
        reopenReason: b.reopenReason || '',
        total: Number(b.total) || 0,
    };
}

module.exports = { nextBillNo, allocateBillNo, formatBillNo, financialYearOf, isBillFinal, assertBillNotFinal, billFinalizedError, publicBill };
