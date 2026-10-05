/**
 * razorpayMock — a stand-in payment gateway for LOCAL DEVELOPMENT ONLY.
 *
 * Why this exists
 * ---------------
 * Razorpay's sandbox still requires working API credentials. When those
 * are missing, wrong or rotated, `orders.create` returns 401 and the
 * entire checkout is blocked — which also blocks everything downstream
 * of it: order creation, the kitchen display, the bill, tips, refunds.
 * That stops all non-payment development dead over a credential
 * problem.
 *
 * With RAZORPAY_MOCK=true the server synthesises the two objects the
 * real gateway would return, the frontend skips the hosted checkout,
 * and the rest of the system runs untouched.
 *
 * ⚠️  THE SAFETY PROPERTY THAT MATTERS
 * ------------------------------------
 * A mock payment gateway reaching production means anyone can order
 * food for free. That is the single worst outcome in this file, so it
 * is guarded three ways rather than one:
 *
 *   1. It is OFF unless RAZORPAY_MOCK is explicitly 'true'.
 *   2. It REFUSES to activate when NODE_ENV === 'production', even if
 *      the flag is set — a copied .env cannot switch it on.
 *   3. assertMockSafe() throws at boot if both are somehow true, so the
 *      server dies loudly instead of silently accepting fake payments.
 *
 * Every mock id is also prefixed `_mock_`, so a fake payment is
 * recognisable at a glance in the database, in logs, and in reports —
 * and can be swept up with a single query later.
 */

const crypto = require('crypto');

const MOCK_ORDER_PREFIX = 'order_mock_';
const MOCK_PAYMENT_PREFIX = 'pay_mock_';
const MOCK_SIGNATURE = 'mock_signature_not_verified';

/** Is the mock gateway active? Never true in production. */
function isMockEnabled() {
    if (process.env.NODE_ENV === 'production') return false;
    return process.env.RAZORPAY_MOCK === 'true';
}

/**
 * Boot-time guard. Call from server.js alongside the other config
 * assertions: a production deploy that still carries RAZORPAY_MOCK=true
 * must fail to start, not quietly ignore the flag — because "quietly
 * ignored" is one refactor away from "quietly honoured".
 */
function assertMockSafe() {
    if (process.env.NODE_ENV === 'production' && process.env.RAZORPAY_MOCK === 'true') {
        throw new Error(
            'RAZORPAY_MOCK=true is set in production. Refusing to start — ' +
            'this would let anyone place orders without paying. Remove it from the environment.',
        );
    }
}

/** True for ids this module minted. Used to gate signature bypass. */
const isMockOrderId = (id) => typeof id === 'string' && id.startsWith(MOCK_ORDER_PREFIX);
const isMockPaymentId = (id) => typeof id === 'string' && id.startsWith(MOCK_PAYMENT_PREFIX);

/**
 * Build the object `razorpay.orders.create()` would have returned.
 * Field-for-field compatible with the real response so no caller needs
 * to know which gateway produced it.
 */
function createMockOrder({ amount, currency = 'INR', receipt, notes = {} }) {
    return {
        id: MOCK_ORDER_PREFIX + crypto.randomBytes(8).toString('hex'),
        entity: 'order',
        amount,                 // paise, exactly as the real API expects
        amount_paid: 0,
        amount_due: amount,
        currency,
        receipt,
        status: 'created',
        attempts: 0,
        notes,
        created_at: Math.floor(Date.now() / 1000),
        // Not a Razorpay field — our own marker so the frontend knows to
        // skip the hosted checkout.
        mock: true,
    };
}

/** The payload the frontend hands back in place of a real checkout result. */
function createMockPaymentResult(orderId) {
    return {
        razorpay_order_id: orderId,
        razorpay_payment_id: MOCK_PAYMENT_PREFIX + crypto.randomBytes(8).toString('hex'),
        razorpay_signature: MOCK_SIGNATURE,
    };
}

/**
 * Should signature verification be skipped for this request?
 *
 * Deliberately narrow: mock mode alone is not enough — the ids must
 * ALSO carry the mock prefixes. So even with the flag on, a real
 * Razorpay payment is still verified normally, and a forged signature
 * on a real order id is still rejected.
 */
function shouldBypassSignature(orderId, paymentId) {
    return isMockEnabled() && isMockOrderId(orderId) && isMockPaymentId(paymentId);
}

module.exports = {
    isMockEnabled,
    assertMockSafe,
    createMockOrder,
    createMockPaymentResult,
    shouldBypassSignature,
    isMockOrderId,
    isMockPaymentId,
    MOCK_ORDER_PREFIX,
    MOCK_PAYMENT_PREFIX,
};
