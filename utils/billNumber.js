'use strict';
/**
 * Shared bill-number formatter. Bill numbers restart each Indian financial
 * year per branch, so the printed form carries the FY: '2026-27/5'.
 * Bills saved before the FY was recorded have no `financialYear`; they print
 * as the plain number, exactly as before.
 *
 * Accepts the order.bill subdocument (or any { billNo, financialYear }).
 * Returns '' when there is no bill number.
 */
function formatBillNo(bill) {
    if (!bill || bill.billNo == null || bill.billNo === '') return '';
    const fy = typeof bill.financialYear === 'string' ? bill.financialYear.trim() : '';
    return fy ? `${fy}/${bill.billNo}` : String(bill.billNo);
}

module.exports = { formatBillNo };
