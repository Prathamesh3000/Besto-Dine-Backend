const { summarizeCash } = require('../services/ledgerSources');

const src = (refunds) => ({ tenders: [], expenses: [], supplierPayments: [], poPayments: [], invoices: [], refunds });

describe('summarizeCash: refund destination classification', () => {
    test('a wallet-destination refund of a cash order is not a cash refund; a cash-destination one is', () => {
        const order = { paymentMethod: 'cash', amountPaid: 500 };
        const out = summarizeCash(src([
            { order, refund: { amount: 100, destination: 'wallet' } },
            { order, refund: { amount: 40, destination: 'cash' } },
        ]));
        expect(out.cashRefunds).toBe(40);
    });

    test('an online order refunded to the gateway is not cash', () => {
        const out = summarizeCash(src([{ order: { paymentMethod: 'online', amountPaid: 500, razorpayPaymentId: 'pay_1' }, refund: { amount: 500, destination: 'gateway' } }]));
        expect(out.cashRefunds).toBe(0);
    });

    test('legacy refund rows without a destination fall back to the order payment method', () => {
        const out = summarizeCash(src([{ order: { paymentMethod: 'cash', amountPaid: 500 }, refund: { amount: 70 } }]));
        expect(out.cashRefunds).toBe(70);
    });
});
