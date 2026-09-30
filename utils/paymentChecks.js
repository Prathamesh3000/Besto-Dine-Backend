// Pure (DB-free, network-free) checks for Razorpay payment flows.
//
// Every function here takes already-fetched Razorpay entities (payment,
// order) plus our own server-side facts and returns either
//   { ok: true, ... }                         or
//   { ok: false, status, code, message }
// so controllers can map the result straight onto an HTTP response and
// the rules can be unit-tested without Mongo or the Razorpay SDK.

const crypto = require('crypto');

// Payment states that mean the money is actually committed. 'authorized'
// is included because accounts with auto-capture settle authorized
// payments without further action from us.
const SETTLED_PAYMENT_STATES = new Set(['captured', 'authorized']);

// Razorpay order notes.purpose / notes.type / notes.kind values that mark
// a payment as belonging to a flow OTHER than a cafe order. Such payments
// may never be applied to a cafe order or orphan-refunded.
const NON_ORDER_PURPOSES = new Set(['wallet_recharge', 'plan_payment', 'advance-booking-remaining']);

// Orphan refunds are fired from the payment handler seconds after the
// capture. Anything older than this is not the "order creation just
// failed" case and must go through staff.
const ORPHAN_REFUND_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(status, code, message) {
    return { ok: false, status, code, message };
}

function paiseToRupees(paise) {
    const n = Number(paise);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n) / 100;
}

// HMAC-SHA256(order_id|payment_id) with the key secret — the value
// Razorpay checkout hands ONLY to the paying browser.
function expectedCheckoutSignature(razorpayOrderId, razorpayPaymentId, secret) {
    return crypto
        .createHmac('sha256', secret || '')
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isValidCheckoutSignature({ razorpayOrderId, razorpayPaymentId, signature, secret }) {
    if (!razorpayOrderId || !razorpayPaymentId || !signature || !secret) return false;
    return safeEqual(expectedCheckoutSignature(razorpayOrderId, razorpayPaymentId, secret), signature);
}

// Server-set order notes win over payment notes (payment notes can be
// influenced by the checkout options the browser passes).
function mergedNotes(payment, rzpOrder) {
    return { ...(payment?.notes || {}), ...(rzpOrder?.notes || {}) };
}

function notePurpose(notes) {
    return notes?.purpose || notes?.type || notes?.kind || null;
}

// Shared first gate: the payment exists, belongs to the Razorpay order
// the caller named, and is in a settled state.
function checkSettledPayment(payment, razorpayOrderId) {
    if (!payment || !payment.id) {
        return fail(404, 'PAYMENT_NOT_FOUND', 'Payment record could not be located.');
    }
    if (razorpayOrderId && payment.order_id && payment.order_id !== razorpayOrderId) {
        return fail(400, 'PAYMENT_ORDER_MISMATCH', 'Payment does not belong to this checkout.');
    }
    if (!SETTLED_PAYMENT_STATES.has(payment.status)) {
        return fail(400, 'PAYMENT_NOT_CAPTURED', `Payment is in '${payment.status || 'unknown'}' state.`);
    }
    if (payment.currency && payment.currency !== 'INR') {
        return fail(400, 'PAYMENT_CURRENCY_MISMATCH', 'Unsupported payment currency.');
    }
    const amount = paiseToRupees(payment.amount);
    if (!(amount > 0)) {
        return fail(400, 'PAYMENT_AMOUNT_INVALID', 'Payment amount is invalid.');
    }
    return { ok: true, amount };
}

/**
 * Wallet top-up: credit only what Razorpay actually settled, and only
 * when the Razorpay order was minted by createWalletRechargeOrder for
 * THIS user (and, when stamped, this restaurant).
 */
function checkWalletRechargePayment({ payment, rzpOrder, razorpayOrderId, userId, tenant, maxAmount = 10000 }) {
    const base = checkSettledPayment(payment, razorpayOrderId);
    if (!base.ok) return base;

    const notes = rzpOrder?.notes || {};
    if (!rzpOrder || (razorpayOrderId && rzpOrder.id && rzpOrder.id !== razorpayOrderId)) {
        return fail(400, 'RECHARGE_ORDER_INVALID', 'Recharge order could not be verified.');
    }
    if (notes.purpose !== 'wallet_recharge') {
        return fail(400, 'NOT_A_RECHARGE', 'This payment is not a wallet recharge.');
    }
    if (!userId || String(notes.userId || '') !== String(userId)) {
        return fail(403, 'RECHARGE_USER_MISMATCH', 'This recharge belongs to a different account.');
    }
    if (notes.restaurantId && tenant && String(notes.restaurantId) !== String(tenant)) {
        return fail(403, 'TENANT_MISMATCH', 'This recharge belongs to a different restaurant.');
    }
    if (base.amount > maxAmount) {
        return fail(400, 'RECHARGE_AMOUNT_INVALID', 'Recharge amount exceeds the allowed maximum.');
    }
    return { ok: true, amount: base.amount };
}

/**
 * Cafe-order verify: decide whether this Razorpay payment may settle
 * this cafe order.
 *
 *   - When the order carries a stamped razorpayOrderId, it MUST equal
 *     the checkout's order id.
 *   - Otherwise (deferred takeaway: Razorpay order created before the
 *     cafe order existed) the Razorpay order's server-set notes must be
 *     a cafe-order checkout for this tenant whose cafeOrderId is either
 *     unset/'none' or points at this very order, and whose payer (when
 *     stamped) is the order's user.
 *   - The captured amount must cover what is still due.
 */
function checkOrderPaymentBinding({ order, payment, rzpOrder, razorpayOrderId, tenant }) {
    const base = checkSettledPayment(payment, razorpayOrderId);
    if (!base.ok) return base;

    const notes = mergedNotes(payment, rzpOrder);
    const purpose = notePurpose(notes);
    if (purpose && NON_ORDER_PURPOSES.has(purpose)) {
        return fail(400, 'PAYMENT_PURPOSE_MISMATCH', 'This payment was not made for a food order.');
    }
    const orderTenant = order?.restaurant ? String(order.restaurant) : (tenant ? String(tenant) : null);
    if (notes.restaurantId && orderTenant && String(notes.restaurantId) !== orderTenant) {
        return fail(403, 'TENANT_MISMATCH', 'This payment belongs to a different restaurant.');
    }

    if (order.razorpayOrderId) {
        if (order.razorpayOrderId !== razorpayOrderId) {
            return fail(400, 'RAZORPAY_ORDER_MISMATCH', 'Payment verification failed — Razorpay order ID mismatch.');
        }
    } else {
        if (!rzpOrder || rzpOrder.id !== razorpayOrderId) {
            return fail(400, 'RAZORPAY_ORDER_MISMATCH', 'Payment verification failed — Razorpay order could not be verified.');
        }
        if (!notes.restaurantId) {
            return fail(400, 'PAYMENT_UNBOUND', 'Payment verification failed — payment is not linked to this restaurant.');
        }
        const noteCafe = notes.cafeOrderId ? String(notes.cafeOrderId) : 'none';
        if (noteCafe !== 'none' && noteCafe !== String(order._id) && noteCafe !== String(order.orderId)) {
            return fail(400, 'PAYMENT_ORDER_MISMATCH', 'Payment verification failed — payment was made for a different order.');
        }
        // Payer binding applies to customer checkouts; staff / kiosk
        // devices legitimately take payment for someone else's order.
        const customerPayer = !notes.payerRole || notes.payerRole === 'customer';
        if (customerPayer && notes.userId && order.user && String(notes.userId) !== String(order.user)) {
            return fail(403, 'PAYER_MISMATCH', 'Payment verification failed — payment was made by a different customer.');
        }
    }

    const total = Math.round((Number(order.total) || 0) * 100) / 100;
    const priorPaid = Math.round((Number(order.amountPaid) || 0) * 100) / 100;
    const due = (priorPaid > 0 && priorPaid < total) ? Math.round((total - priorPaid) * 100) / 100 : total;
    if (base.amount < due - 1) {
        return fail(400, 'AMOUNT_INSUFFICIENT',
            `Payment verification failed — captured amount (₹${base.amount}) does not cover order total (₹${due}).`);
    }
    return { ok: true, amount: base.amount, priorPaid, total };
}

/**
 * Orphan refund ("charged but the order could not be saved"): the
 * payment must be a cafe-order checkout for this tenant that was never
 * bound to a cafe order, recent, and demonstrably the caller's own.
 *
 * Caller proof, strongest first:
 *   1. a valid checkout signature (only the paying browser has it);
 *   2. notes.userId === logged-in user;
 *   3. notes.scanSessionId === caller's verified scan-session id.
 */
function checkOrphanRefundEligibility({
    payment, rzpOrder, tenant, caller = {}, signatureValid = false,
    nowMs = Date.now(), maxAgeMs = ORPHAN_REFUND_MAX_AGE_MS,
}) {
    if (!payment || !payment.id) {
        return fail(404, 'PAYMENT_NOT_FOUND', 'Payment record could not be located.');
    }
    const notes = mergedNotes(payment, rzpOrder);
    if (!notes.restaurantId || !tenant || String(notes.restaurantId) !== String(tenant)) {
        return fail(403, 'TENANT_MISMATCH', 'This payment does not belong to the current restaurant.');
    }
    const purpose = notePurpose(notes);
    if (purpose && NON_ORDER_PURPOSES.has(purpose)) {
        return fail(403, 'PAYMENT_NOT_REFUNDABLE', 'This payment cannot be refunded automatically.');
    }
    const noteCafe = notes.cafeOrderId ? String(notes.cafeOrderId) : 'none';
    if (noteCafe !== 'none') {
        // Created against an existing cafe order — not an orphan.
        return fail(409, 'PAYMENT_IN_USE', 'This payment is linked to an order. Please contact staff.');
    }

    const createdMs = Number(payment.created_at) * 1000;
    if (!Number.isFinite(createdMs) || createdMs <= 0) {
        return fail(400, 'PAYMENT_AGE_UNKNOWN', 'Payment could not be validated.');
    }
    if (createdMs > nowMs + CLOCK_SKEW_MS || nowMs - createdMs > maxAgeMs) {
        return fail(403, 'REFUND_WINDOW_EXPIRED', 'This payment is too old for an automatic refund. Please contact staff.');
    }

    let proven = !!signatureValid;
    if (!proven && notes.userId && caller.userId && String(notes.userId) === String(caller.userId)) proven = true;
    if (!proven && notes.scanSessionId && caller.scanSessionId && String(notes.scanSessionId) === String(caller.scanSessionId)) proven = true;
    if (!proven) {
        return fail(403, 'PAYER_MISMATCH', 'We could not confirm this payment is yours. Please contact staff.');
    }
    return { ok: true };
}

/**
 * Advance booking: map a verified payment amount onto the booking's
 * payment status. `total` is the server-computed booking value.
 */
function resolveBookingPaymentOutcome({ total, paidAmount }) {
    const t = Math.max(0, Math.round((Number(total) || 0) * 100) / 100);
    const paid = Math.round((Number(paidAmount) || 0) * 100) / 100;
    const advanceDue = Math.round(t * 0.5);
    if (paid >= t - 1) return { ok: true, status: 'Paid', advancePaid: Math.min(paid, t) };
    if (paid >= advanceDue - 1) return { ok: true, status: 'Partial', advancePaid: paid };
    return fail(400, 'AMOUNT_INSUFFICIENT',
        `Payment of ₹${paid} does not cover the required advance of ₹${advanceDue}.`);
}

module.exports = {
    SETTLED_PAYMENT_STATES,
    ORPHAN_REFUND_MAX_AGE_MS,
    paiseToRupees,
    expectedCheckoutSignature,
    isValidCheckoutSignature,
    mergedNotes,
    checkSettledPayment,
    checkWalletRechargePayment,
    checkOrderPaymentBinding,
    checkOrphanRefundEligibility,
    resolveBookingPaymentOutcome,
};
