/**
 * Controllable stand-in for the `razorpay` SDK (jest.mock'd in mocks.js).
 *
 * Every `new Razorpay(...)` in the app (razorpayController, orderRefund,
 * razorpayBilling) returns the SAME shared instance, so a test can do:
 *
 *   const rzp = require('./helpers/razorpayMock');
 *   rzp.instance.payments.fetch.mockResolvedValue({ ... });
 *
 * Nothing ever reaches the network. `reset()` restores the fail-closed
 * defaults (every call rejects) between tests.
 */
const notMocked = (name) => () => Promise.reject(new Error(`razorpay mock: ${name} not stubbed in this test`));

const instance = {
    payments: { fetch: jest.fn(), refund: jest.fn(), capture: jest.fn() },
    orders: { fetch: jest.fn(), create: jest.fn(), fetchPayments: jest.fn() },
    refunds: { fetch: jest.fn() },
    subscriptions: { create: jest.fn(), fetch: jest.fn(), cancel: jest.fn() },
    plans: { create: jest.fn(), fetch: jest.fn() },
    customers: { create: jest.fn(), fetch: jest.fn() },
};

function reset() {
    for (const [group, fns] of Object.entries(instance)) {
        for (const [name, fn] of Object.entries(fns)) {
            fn.mockReset();
            fn.mockImplementation(notMocked(`${group}.${name}`));
        }
    }
}
reset();

class Razorpay {
    constructor() {
        return instance; // eslint-disable-line no-constructor-return
    }
}
Razorpay.validateWebhookSignature = () => false;

module.exports = { Razorpay, instance, reset };
