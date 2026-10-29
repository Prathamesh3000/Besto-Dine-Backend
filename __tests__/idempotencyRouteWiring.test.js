/**
 * Which routes carry the idempotency middleware (and in which mode).
 * The middleware factory is mocked to tag each instance; no DB, no server.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-unit-test-secret!!';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('../middlewares/idempotency', () => ({
    idempotency: (opts = {}) => {
        const fn = (req, res, next) => next();
        fn.__idem = opts;
        return fn;
    },
}));

function idemFor(router, method, path) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`route not found: ${method} ${path}`);
    const tagged = layer.route.stack.map((s) => s.handle).find((h) => h && h.__idem);
    return tagged ? tagged.__idem : null;
}

const REQUIRED = [
    ['../routes/orderRoute', 'post', '/'],
    ['../routes/orderRoute', 'patch', '/:id/payment'],
    ['../routes/razorpayRoute', 'post', '/verify-payment'],
    ['../routes/razorpayRoute', 'post', '/refund'],
    ['../routes/razorpayRoute', 'post', '/orphan-refund'],
    ['../routes/razorpayRoute', 'post', '/verify-wallet-recharge'],
    ['../routes/walletRoute', 'post', '/pay'],
    ['../routes/advanceBookingRoute', 'post', '/create'],
    ['../routes/advanceBookingRoute', 'post', '/:id/create-remaining-payment'],
    ['../routes/advanceBookingRoute', 'post', '/:id/verify-remaining-payment'],
];

describe('idempotency wiring', () => {
    test.each(REQUIRED)('%s %s %s requires the key', (mod, method, path) => {
        expect(idemFor(require(mod), method, path)).toEqual(expect.objectContaining({ required: true }));
    });

    test('PATCH /orders/:id/status uses requiredWhen: paymentStatus / amountPaid only', () => {
        const opts = idemFor(require('../routes/orderRoute'), 'patch', '/:id/status');
        expect(opts.required).toBeUndefined();
        expect(typeof opts.requiredWhen).toBe('function');
        expect(opts.requiredWhen({ body: { paymentStatus: 'Paid' } })).toBe(true);
        expect(opts.requiredWhen({ body: { amountPaid: 100 } })).toBe(true);
        expect(opts.requiredWhen({ body: { status: 'preparing' } })).toBe(false);
        expect(opts.requiredWhen({ body: { status: 'cancelled', cancellationReason: 'x' } })).toBe(false);
        expect(opts.requiredWhen({})).toBe(false);
    });

    test('status route: idempotency runs after auth (protect/staffOnly) and before the controller', () => {
        const router = require('../routes/orderRoute');
        const layer = router.stack.find((l) => l.route && l.route.path === '/:id/status' && l.route.methods.patch);
        const handles = layer.route.stack.map((s) => s.handle);
        const i = handles.findIndex((h) => h && h.__idem);
        expect(i).toBeGreaterThanOrEqual(2);
        expect(i).toBe(handles.length - 2);
    });

    test('gateway-order creation routes stay un-keyed', () => {
        const rz = require('../routes/razorpayRoute');
        expect(idemFor(rz, 'post', '/create-order')).toBeNull();
        expect(idemFor(rz, 'post', '/create-wallet-recharge')).toBeNull();
    });
});
