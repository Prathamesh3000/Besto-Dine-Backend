/**
 * Pure-function tests for the payment security fixes:
 *   #3  wallet recharge credits only settled, correctly-bound payments
 *   #4  orphan refund eligibility (tenant, orphan-ness, payer proof, age)
 *   #9  advance-booking server pricing + payment outcome
 *   #10 order payment binding (razorpayOrderId / notes / amount)
 *   #21 idempotency keys scoped per caller + method + path
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const jwt = require('jsonwebtoken');
const {
    checkWalletRechargePayment,
    checkOrderPaymentBinding,
    checkOrphanRefundEligibility,
    isValidCheckoutSignature,
    expectedCheckoutSignature,
    resolveBookingPaymentOutcome,
} = require('../utils/paymentChecks');
const { computeBookingPrice, addonLinePrice } = require('../utils/advanceBookingPricing');
const { scopedIdempotencyKey } = require('../middlewares/idempotency');

const TENANT = '507f1f77bcf86cd799439011';
const USER = '507f1f77bcf86cd799439022';
const OTHER = '507f1f77bcf86cd799439033';

const payment = (o = {}) => ({ id: 'pay_1', order_id: 'order_1', status: 'captured', currency: 'INR', amount: 50000, created_at: Math.floor(Date.now() / 1000), notes: {}, ...o });

describe('#3 checkWalletRechargePayment', () => {
    const rzpOrder = (notes) => ({ id: 'order_1', notes: { purpose: 'wallet_recharge', userId: USER, restaurantId: TENANT, ...notes } });

    test('credits the gateway amount, not a client amount', () => {
        const r = checkWalletRechargePayment({ payment: payment({ amount: 100 }), rzpOrder: rzpOrder(), razorpayOrderId: 'order_1', userId: USER, tenant: TENANT });
        expect(r).toEqual({ ok: true, amount: 1 });
    });
    test('rejects another user\'s recharge order', () => {
        const r = checkWalletRechargePayment({ payment: payment(), rzpOrder: rzpOrder({ userId: OTHER }), razorpayOrderId: 'order_1', userId: USER, tenant: TENANT });
        expect(r.code).toBe('RECHARGE_USER_MISMATCH');
    });
    test('rejects a non-recharge (food order) payment', () => {
        const r = checkWalletRechargePayment({ payment: payment(), rzpOrder: rzpOrder({ purpose: 'cafe_order' }), razorpayOrderId: 'order_1', userId: USER, tenant: TENANT });
        expect(r.code).toBe('NOT_A_RECHARGE');
    });
    test('rejects un-captured and mismatched-order payments', () => {
        expect(checkWalletRechargePayment({ payment: payment({ status: 'failed' }), rzpOrder: rzpOrder(), razorpayOrderId: 'order_1', userId: USER }).code).toBe('PAYMENT_NOT_CAPTURED');
        expect(checkWalletRechargePayment({ payment: payment({ order_id: 'order_2' }), rzpOrder: rzpOrder(), razorpayOrderId: 'order_1', userId: USER }).code).toBe('PAYMENT_ORDER_MISMATCH');
    });
    test('accepts authorized payments', () => {
        expect(checkWalletRechargePayment({ payment: payment({ status: 'authorized' }), rzpOrder: rzpOrder(), razorpayOrderId: 'order_1', userId: USER, tenant: TENANT }).ok).toBe(true);
    });
});

describe('#10 checkOrderPaymentBinding', () => {
    const order = (o = {}) => ({ _id: 'oid1', orderId: 'ORD-1', total: 500, amountPaid: 0, restaurant: TENANT, user: USER, razorpayOrderId: null, ...o });
    const rzp = (notes = {}) => ({ id: 'order_1', notes: { restaurantId: TENANT, cafeOrderId: 'none', purpose: 'cafe_order', userId: USER, payerRole: 'customer', ...notes } });

    test('stamped razorpayOrderId must match', () => {
        expect(checkOrderPaymentBinding({ order: order({ razorpayOrderId: 'order_9' }), payment: payment(), rzpOrder: rzp(), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('RAZORPAY_ORDER_MISMATCH');
        expect(checkOrderPaymentBinding({ order: order({ razorpayOrderId: 'order_1' }), payment: payment(), rzpOrder: rzp(), razorpayOrderId: 'order_1', tenant: TENANT }).ok).toBe(true);
    });
    test('deferred binding: notes pointing at another order are rejected', () => {
        expect(checkOrderPaymentBinding({ order: order(), payment: payment(), rzpOrder: rzp({ cafeOrderId: 'otherId' }), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('PAYMENT_ORDER_MISMATCH');
    });
    test('deferred binding: wallet-recharge payment cannot pay an order', () => {
        expect(checkOrderPaymentBinding({ order: order(), payment: payment(), rzpOrder: rzp({ purpose: 'wallet_recharge' }), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('PAYMENT_PURPOSE_MISMATCH');
    });
    test('deferred binding: other customer / other tenant rejected', () => {
        expect(checkOrderPaymentBinding({ order: order(), payment: payment(), rzpOrder: rzp({ userId: OTHER }), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('PAYER_MISMATCH');
        expect(checkOrderPaymentBinding({ order: order(), payment: payment(), rzpOrder: rzp({ restaurantId: OTHER }), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('TENANT_MISMATCH');
    });
    test('staff payer may settle a customer order', () => {
        expect(checkOrderPaymentBinding({ order: order(), payment: payment(), rzpOrder: rzp({ userId: OTHER, payerRole: 'waiter' }), razorpayOrderId: 'order_1', tenant: TENANT }).ok).toBe(true);
    });
    test('amount must cover what is due (wallet part already paid counts)', () => {
        expect(checkOrderPaymentBinding({ order: order(), payment: payment({ amount: 100 }), rzpOrder: rzp(), razorpayOrderId: 'order_1', tenant: TENANT }).code).toBe('AMOUNT_INSUFFICIENT');
        expect(checkOrderPaymentBinding({ order: order({ amountPaid: 300 }), payment: payment({ amount: 20000 }), rzpOrder: rzp(), razorpayOrderId: 'order_1', tenant: TENANT }).ok).toBe(true);
    });
});

describe('#4 checkOrphanRefundEligibility', () => {
    const rzp = (notes = {}) => ({ id: 'order_1', notes: { restaurantId: TENANT, cafeOrderId: 'none', purpose: 'cafe_order', userId: USER, ...notes } });

    test('owner (logged-in) can refund a fresh orphan', () => {
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp(), tenant: TENANT, caller: { userId: USER } }).ok).toBe(true);
    });
    test('anonymous caller without proof is refused', () => {
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp(), tenant: TENANT, caller: {} }).code).toBe('PAYER_MISMATCH');
    });
    test('valid checkout signature is sufficient proof', () => {
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp({ userId: undefined }), tenant: TENANT, caller: {}, signatureValid: true }).ok).toBe(true);
    });
    test('guest scan session proof', () => {
        const r = checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp({ userId: undefined, scanSessionId: 's1' }), tenant: TENANT, caller: { scanSessionId: 's1' } });
        expect(r.ok).toBe(true);
    });
    test('payment created for an existing order is not an orphan', () => {
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp({ cafeOrderId: 'ORD-1' }), tenant: TENANT, caller: { userId: USER } }).code).toBe('PAYMENT_IN_USE');
    });
    test('old payments and wallet recharges are refused', () => {
        const old = payment({ created_at: Math.floor(Date.now() / 1000) - 3 * 3600 });
        expect(checkOrphanRefundEligibility({ payment: old, rzpOrder: rzp(), tenant: TENANT, caller: { userId: USER } }).code).toBe('REFUND_WINDOW_EXPIRED');
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp({ purpose: 'wallet_recharge' }), tenant: TENANT, caller: { userId: USER } }).code).toBe('PAYMENT_NOT_REFUNDABLE');
    });
    test('other tenant refused', () => {
        expect(checkOrphanRefundEligibility({ payment: payment(), rzpOrder: rzp(), tenant: OTHER, caller: { userId: USER } }).code).toBe('TENANT_MISMATCH');
    });
});

describe('checkout signature', () => {
    test('round-trips and rejects tampering', () => {
        const sig = expectedCheckoutSignature('order_1', 'pay_1', 'k');
        expect(isValidCheckoutSignature({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', signature: sig, secret: 'k' })).toBe(true);
        expect(isValidCheckoutSignature({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_2', signature: sig, secret: 'k' })).toBe(false);
    });
});

describe('#9 advance booking pricing', () => {
    test('mirrors BookingReview.calculatePrices', () => {
        const r = computeBookingPrice({
            bookingType: 'hall', guests: 10,
            hallPrice: 5000, packagePrice: 300,
            cake: { unitPrice: 800, quantity: 2 },
            decorationPrice: 2000,
            parking: { rate: 50, count: 2, hours: 3 }, // ignored for halls
            addons: [{ price: 1000, slug: 'photographer', duration: '2' }, { price: 500, slug: 'kids' }],
            couponDiscount: 100, pointsRupees: 50,
        });
        // 5000 + 3000 + 1600 + 2000 + 400 + 500 = 12500 − 100 − 50
        expect(r.subtotal).toBe(12500);
        expect(r.total).toBe(12350);
        expect(r.advance).toBe(6175);
    });
    test('table booking includes parking, excludes hall/package', () => {
        const r = computeBookingPrice({ bookingType: 'table', guests: 4, hallPrice: 9999, packagePrice: 99, parking: { rate: 50, count: 2, hours: 3 } });
        expect(r.total).toBe(300);
    });
    test('discounts can never make the total negative', () => {
        expect(computeBookingPrice({ bookingType: 'table', guests: 1, decorationPrice: 100, couponDiscount: 500, pointsRupees: 500 }).total).toBe(0);
    });
    test('addon duration scaling', () => {
        expect(addonLinePrice(1000, 'dj', '4')).toBe(800);
        expect(addonLinePrice(1000, 'dj', 'full')).toBe(1000);
        expect(addonLinePrice(1000, 'florist', '2')).toBe(1000);
    });
    test('payment outcome is derived from the verified amount', () => {
        expect(resolveBookingPaymentOutcome({ total: 1000, paidAmount: 1000 })).toMatchObject({ ok: true, status: 'Paid', advancePaid: 1000 });
        expect(resolveBookingPaymentOutcome({ total: 1000, paidAmount: 500 })).toMatchObject({ ok: true, status: 'Partial', advancePaid: 500 });
        expect(resolveBookingPaymentOutcome({ total: 1000, paidAmount: 1 }).code).toBe('AMOUNT_INSUFFICIENT');
    });
});

describe('#21 scopedIdempotencyKey', () => {
    const req = (o = {}) => ({
        method: 'POST', originalUrl: '/api/v1/razorpay/verify-payment?x=1', ip: '1.1.1.1',
        headers: {}, get(h) { return this.headers[h.toLowerCase()]; }, ...o,
    });

    test('different users with the same client key get different storage keys', () => {
        const a = scopedIdempotencyKey(req({ user: { _id: USER } }), 'abcdefgh');
        const b = scopedIdempotencyKey(req({ user: { _id: OTHER } }), 'abcdefgh');
        expect(a).not.toBe(b);
    });
    test('same caller + key but different route or method differ', () => {
        const base = scopedIdempotencyKey(req({ user: { _id: USER } }), 'abcdefgh');
        expect(scopedIdempotencyKey(req({ user: { _id: USER }, originalUrl: '/api/v1/orders' }), 'abcdefgh')).not.toBe(base);
        expect(scopedIdempotencyKey(req({ user: { _id: USER }, method: 'PUT' }), 'abcdefgh')).not.toBe(base);
    });
    test('stable for the same caller (retry replays) and ignores query string', () => {
        const a = scopedIdempotencyKey(req({ user: { _id: USER } }), 'abcdefgh');
        const b = scopedIdempotencyKey(req({ user: { _id: USER }, originalUrl: '/api/v1/razorpay/verify-payment' }), 'abcdefgh');
        expect(a).toBe(b);
    });
    test('guests are scoped by verified scan session, forged tokens fall back to IP', () => {
        // Scan tokens carry typ:'scan' (legacy ones a tableId) — see
        // authMiddleware.verifyTypedToken.
        const t1 = jwt.sign({ typ: 'scan', tableId: 't1', sessionId: 's1' }, process.env.JWT_SECRET);
        const t2 = jwt.sign({ tableId: 't1', sessionId: 's2' }, process.env.JWT_SECRET);
        const forged = jwt.sign({ typ: 'scan', tableId: 't1', sessionId: 's1' }, 'wrong');
        const userToken = jwt.sign({ typ: 'user', id: 'u1', sessionId: 's1' }, process.env.JWT_SECRET);
        const ku = scopedIdempotencyKey(req({ headers: { 'x-scan-token': userToken } }), 'abcdefgh');
        const k1 = scopedIdempotencyKey(req({ headers: { 'x-scan-token': t1 } }), 'abcdefgh');
        const k2 = scopedIdempotencyKey(req({ headers: { 'x-scan-token': t2 } }), 'abcdefgh');
        const kf = scopedIdempotencyKey(req({ headers: { 'x-scan-token': forged } }), 'abcdefgh');
        expect(k1).not.toBe(k2);
        expect(kf).not.toBe(k1);
        // A non-scan token is never accepted as a scan session.
        expect(ku).not.toBe(k1);
    });
});
