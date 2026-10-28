'use strict';
/**
 * UPI "pay at the table": resolves the restaurant's payee (Settings ->
 * `payments`) and builds the QR block for an order's CURRENT amount due.
 * Shared by GET /orders/:id/upi-qr (orderBillService) and the printed /
 * previewed bill (printService.buildBillDocument), so the QR on the slip
 * and the one in the app can never disagree.
 */
const { getSettings } = require('../utils/settingsCache');
const { getMainBranchId } = require('../utils/mainBranch');
const { buildUpiUri, buildNote, amountDue, normalizeVpa, cleanText, MAX_UPI_AMOUNT } = require('../utils/upiQr');

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : (v ? String(v) : null));

/**
 * The payee for an order's branch: the branch's own Settings doc when it
 * has a UPI id, otherwise the tenant-level doc (one UPI id for the whole
 * restaurant is the common case). null = not configured.
 * @returns {Promise<{ vpa: string, name: string } | null>}
 */
async function resolvePayee(restaurantId, branchId) {
    const rid = idOf(restaurantId);
    const mainId = idOf(await getMainBranchId({ restaurant: { _id: rid } }));
    const bid = idOf(branchId) || mainId;
    // The order's own branch doc first (a branch-pinned admin saves there,
    // main-branch included), then the tenant-level doc.
    const scopeBranch = bid || null;

    const branchDoc = scopeBranch ? await getSettings({ restaurant: { _id: rid }, branch: { _id: scopeBranch } }) : null;
    const tenantDoc = (!branchDoc || !normalizeVpa(branchDoc.payments?.upiId)) ? await getSettings(rid) : null;

    const pick = [branchDoc, tenantDoc].find((d) => d && normalizeVpa(d.payments?.upiId));
    if (!pick) return null;
    const general = pick.general || tenantDoc?.general || branchDoc?.general || {};
    return {
        vpa: normalizeVpa(pick.payments.upiId),
        name: cleanText(pick.payments.upiPayeeName) || cleanText(general.cafeName) || '',
    };
}

/** Is an order still collectable (not paid, refunded or cancelled)? */
function isUnpaid(order) {
    if (!order) return false;
    if (order.status === 'cancelled') return false;
    return order.paymentStatus !== 'Paid' && order.paymentStatus !== 'Refunded';
}

/**
 * QR block for an order, or null when the bill must print without one
 * (paid / cancelled order, nothing due, no UPI id configured, amount out
 * of UPI range).
 * @returns {Promise<null | { uri: string, amount: number, payeeName: string, vpa: string }>}
 */
async function billUpiBlock(order, { tableLabel = '' } = {}) {
    if (!isUnpaid(order)) return null;
    const amount = amountDue(order);
    if (!(amount > 0) || amount > MAX_UPI_AMOUNT) return null;
    const payee = await resolvePayee(order.restaurant, order.branch);
    if (!payee) return null;
    const uri = buildUpiUri({
        vpa: payee.vpa, payeeName: payee.name, amount,
        orderRef: order.orderId, note: buildNote({ tableLabel, orderId: order.orderId }),
    });
    return { uri, amount, payeeName: payee.name, vpa: payee.vpa };
}

module.exports = { resolvePayee, billUpiBlock, isUnpaid };
