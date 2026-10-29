/**
 * utils/tenders (per-tender payments, task 2.3) + the split-settle path
 * through services/orderStatusService.applyPaymentFields.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/orderPaymentService', () => ({ recordPaidOrderLedger: jest.fn() }));
jest.mock('../services/orderNotifications', () => ({ notifyStatusTransition: jest.fn(), emitStatusUpdateEvents: jest.fn(), notify: jest.fn() }));
jest.mock('../utils/settingsCache', () => ({ getSettings: jest.fn() }));
jest.mock('../models/order', () => ({ findOneAndUpdate: jest.fn(), find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() }));

const T = require('../utils/tenders');
const { applyPaymentFields } = require('../services/orderStatusService');
const { renderBill, toPlainText } = require('../utils/receiptRenderer');

describe('getTenders', () => {
    test('payments[] wins over legacy fields', () => {
        const l = T.getTenders({ amountPaid: 150, paymentMethod: 'mixed', payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 50, reference: 'u1' }] });
        expect(l.map((x) => [x.method, x.amount])).toEqual([['cash', 100], ['upi', 50]]);
        expect(l[1].reference).toBe('u1');
    });
    test('legacy single method is synthesised', () => {
        expect(T.getTenders({ amountPaid: 500, paymentMethod: 'cash' })).toEqual([expect.objectContaining({ method: 'cash', amount: 500, source: 'legacy' })]);
        expect(T.getTenders({ amountPaid: 500, paymentMethod: 'online', razorpayPaymentId: 'pay_1' })[0]).toEqual(expect.objectContaining({ method: 'razorpay', reference: 'pay_1' }));
        expect(T.getTenders({ amountPaid: 80, paymentMethod: 'UPI' })[0].method).toBe('upi');
    });
    test('legacy wallet + razorpay (mixed) splits into two lines', () => {
        const l = T.getTenders({ amountPaid: 300, paymentMethod: 'mixed', walletAmountPaid: 100, razorpayPaymentId: 'p' });
        expect(l.map((x) => [x.method, x.amount])).toEqual([['wallet', 100], ['razorpay', 200]]);
        expect(T.sumTenders(l)).toBe(300);
    });
    test('nothing paid / unknown method', () => {
        expect(T.getTenders({ amountPaid: 0, paymentMethod: 'cash' })).toEqual([]);
        expect(T.getTenders(null)).toEqual([]);
        expect(T.getTenders({ amountPaid: 10, paymentMethod: 'Not selected' })[0].method).toBe('other');
    });
    test('money in amountPaid but missing from payments[] shows as a legacy line (totals stay equal)', () => {
        const l = T.getTenders({ amountPaid: 150, paymentMethod: 'mixed', walletAmountPaid: 100, payments: [{ method: 'cash', amount: 50 }] });
        expect(T.sumTenders(l)).toBe(150);
        expect(l[0]).toEqual(expect.objectContaining({ method: 'wallet', amount: 100, source: 'legacy' }));
    });
    test('toObject docs are accepted', () => {
        expect(T.getTenders({ toObject: () => ({ amountPaid: 5, paymentMethod: 'card' }) })[0].method).toBe('card');
    });
});

describe('sumTenders / summarizeTenders rounding', () => {
    test('sums with 2dp rounding', () => {
        expect(T.sumTenders([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
        expect(T.sumTenders([{ amount: 33.333 }, { amount: 33.333 }, { amount: 33.334 }])).toBe(100);
    });
    test('mixed label, paid, status', () => {
        const s = T.summarizeTenders([{ method: 'cash', amount: 60 }, { method: 'upi', amount: 40 }], { due: 100 });
        expect(s).toEqual(expect.objectContaining({ method: 'mixed', amountPaid: 100, status: 'Paid', change: 0 }));
    });
    test('single method keeps legacy label', () => {
        expect(T.summarizeTenders([{ method: 'razorpay', amount: 10 }], { due: 10 }).method).toBe('online');
        expect(T.summarizeTenders([{ method: 'upi', amount: 10 }], { due: 10 }).method).toBe('UPI');
        expect(T.summarizeTenders([], { due: 10 })).toEqual(expect.objectContaining({ method: 'Not selected', status: 'Pending', amountPaid: 0 }));
    });
    test('status tolerance is one paisa; change is the excess', () => {
        expect(T.summarizeTenders([{ method: 'cash', amount: 99.99 }], { due: 100 }).status).toBe('Paid');
        expect(T.summarizeTenders([{ method: 'cash', amount: 99.98 }], { due: 100 }).status).toBe('Partially Paid');
        expect(T.summarizeTenders([{ method: 'cash', amount: 120 }], { due: 100 }).change).toBe(20);
    });
    test('wallet amount is carried', () => {
        expect(T.summarizeTenders([{ method: 'wallet', amount: 30 }, { method: 'cash', amount: 70 }], { due: 100 }).walletAmountPaid).toBe(30);
    });
});

describe('parseCounterTenders', () => {
    test('accepts counter methods, trims reference', () => {
        const r = T.parseCounterTenders([{ method: 'Cash', amount: '10.005' }, { method: 'upi', amount: 5, reference: ' x1 ' }]);
        expect(r.lines).toEqual([{ method: 'cash', amount: 10.01, reference: '' }, { method: 'upi', amount: 5, reference: 'x1' }]);
    });
    test.each([
        [[], 'INVALID_PAYMENTS'],
        ['x', 'INVALID_PAYMENTS'],
        [[{ method: 'wallet', amount: 5 }], 'INVALID_PAYMENT_METHOD'],
        [[{ method: 'razorpay', amount: 5 }], 'INVALID_PAYMENT_METHOD'],
        [[{ method: 'cash', amount: 0 }], 'INVALID_AMOUNT'],
        [[{ method: 'cash', amount: -3 }], 'INVALID_AMOUNT'],
        [[{ method: 'cash', amount: 'abc' }], 'INVALID_AMOUNT'],
        [[{ method: 'cash', amount: 5, reference: 'x'.repeat(41) }], 'INVALID_PAYMENT_REFERENCE'],
    ])('rejects %j', (input, code) => {
        expect(T.parseCounterTenders(input).error.code).toBe(code);
    });
});

describe('applyPaymentFields with payments[]', () => {
    const base = (o = {}) => ({ _id: 'o1', total: 500, amountPaid: 0, paymentStatus: 'Pending', type: 'takeaway', status: 'new', ...o });
    const run = (old, body, role = 'captain') => { const u = {}; applyPaymentFields(old, body, u, 'u1', role); return u; };
    const code = (fn) => { try { fn(); } catch (e) { return (e.body && e.body.code) || e.message; } return null; };

    test('cash + upi covering the bill -> Paid, mixed, lines + cumulative amountPaid', () => {
        const u = run(base(), { payments: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 300, reference: 'utr9' }] });
        expect(u.paymentStatus).toBe('Paid');
        expect(u.paymentMethod).toBe('mixed');
        expect(u.amountPaid).toBe(500);
        expect(u.payments.map((p) => [p.method, p.amount, p.source])).toEqual([['cash', 200, 'counter'], ['upi', 300, 'counter']]);
        expect(u.payments[0].receivedBy).toBe('u1');
        expect(u['payment.state']).toBe('paid');
        expect(u['payment.cashReceived']).toBe(200);
        expect(u['payment.changeDue']).toBe(0);
        expect(u.paidAt).toBeInstanceOf(Date);
    });
    test('short Paid claim -> AMOUNT_TOO_LOW; no status -> Partially Paid', () => {
        expect(code(() => run(base(), { paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 100 }] }))).toBe('AMOUNT_TOO_LOW');
        const u = run(base(), { payments: [{ method: 'cash', amount: 100 }] });
        expect(u.paymentStatus).toBe('Partially Paid');
        expect(u.amountPaid).toBe(100);
        expect(u.paidAt).toBeUndefined();
        expect(u['payment.state']).toBeUndefined();
    });
    test('manual discount lowers the amount due', () => {
        const u = run(base(), { manualDiscount: 50, payments: [{ method: 'cash', amount: 250 }, { method: 'card', amount: 200 }] });
        expect(u.paymentStatus).toBe('Paid');
        expect(u.manualDiscount).toBe(50);
        expect(u.amountPaid).toBe(450);
    });
    test('a raised tip is part of what must be collected', () => {
        const short = () => run(base(), { tipAmount: 40, paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 200 }] });
        expect(code(short)).toBe('AMOUNT_TOO_LOW');
        const u = run(base(), { tipAmount: 40, paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 240 }] });
        expect(u.amountPaid).toBe(540);
        expect(u.tipAmount).toBe(40);
    });
    test('overpayment only through cash (change)', () => {
        const u = run(base(), { payments: [{ method: 'upi', amount: 300 }, { method: 'cash', amount: 300 }] });
        expect(u.amountPaid).toBe(600);
        expect(u['payment.changeDue']).toBe(100);
        expect(code(() => run(base(), { payments: [{ method: 'upi', amount: 600 }] }))).toBe('OVERPAYMENT_NOT_CASH');
    });
    test('top-up of a wallet part-payment keeps the prior line', () => {
        const old = base({ amountPaid: 100, paymentMethod: 'wallet', paymentStatus: 'Partially Paid', payments: [{ method: 'wallet', amount: 100, source: 'wallet' }] });
        const u = run(old, { payments: [{ method: 'cash', amount: 400 }] });
        expect(u.paymentStatus).toBe('Paid');
        expect(u.paymentMethod).toBe('mixed');
        expect(u.amountPaid).toBe(500);
        expect(u.payments.map((p) => [p.method, p.amount])).toEqual([['wallet', 100], ['cash', 400]]);
    });
    test('legacy partial (no payments[]) is persisted as a line on top-up', () => {
        const old = base({ amountPaid: 100, paymentMethod: 'wallet', paymentStatus: 'Partially Paid' });
        const u = run(old, { payments: [{ method: 'cash', amount: 400 }] });
        expect(u.payments[0]).toEqual(expect.objectContaining({ method: 'wallet', amount: 100, source: 'legacy' }));
        expect(u.amountPaid).toBe(500);
    });
    test('single cash line behaves like the legacy cash settle (label + cash received)', () => {
        const u = run(base(), { payments: [{ method: 'cash', amount: 600 }] });
        expect(u.paymentMethod).toBe('cash');
        expect(u['payment.cashReceived']).toBe(600);
        expect(u['payment.changeDue']).toBe(100);
    });
    test('guards: role, already paid, bad status, bad lines', () => {
        expect(code(() => run(base(), { payments: [{ method: 'cash', amount: 500 }] }, 'waiter'))).toBe('BILLING_CAPTAIN_ONLY');
        expect(code(() => run(base({ paymentStatus: 'Paid' }), { payments: [{ method: 'cash', amount: 500 }] }))).toBe('ALREADY_PAID');
        expect(code(() => run(base(), { paymentStatus: 'Refunded', payments: [{ method: 'cash', amount: 500 }] }))).toBe('INVALID_PAYMENT_STATUS');
        expect(code(() => run(base(), { payments: [{ method: 'wallet', amount: 500 }] }))).toBe('INVALID_PAYMENT_METHOD');
    });
    test('multi-round table: tenders must cover the sibling rounds too', () => {
        const run2 = (body) => { const u = {}; applyPaymentFields(base(), body, u, 'u1', 'captain', { siblingDue: 300 }); return u; };
        expect(code(() => run2({ paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 500 }] }))).toBe('AMOUNT_TOO_LOW');
        expect(run2({ payments: [{ method: 'cash', amount: 500 }] }).paymentStatus).toBe('Partially Paid');
        const u = run2({ payments: [{ method: 'upi', amount: 500 }, { method: 'cash', amount: 300 }] });
        expect(u.paymentStatus).toBe('Paid');
        expect(u.amountPaid).toBe(800);
        expect(code(() => run2({ payments: [{ method: 'upi', amount: 801 }] }))).toBe('OVERPAYMENT_NOT_CASH');
    });
    test('requests without payments are untouched (no payments key)', () => {
        const u = run(base(), { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500 });
        expect(u.payments).toBeUndefined();
        expect(u.amountPaid).toBe(500);
        expect(u.paymentMethod).toBe('cash');
    });
});

describe('receipt tender lines', () => {
    const doc = (payments) => toPlainText(renderBill({
        settings: { general: { cafeName: 'X' } },
        order: { orderId: 'O1', type: 'takeaway', items: [{ name: 'A', price: 100, quantity: 1 }], total: 100, amountPaid: 100, paymentMethod: 'mixed', paymentStatus: 'Paid', payments },
        paperWidth: 80,
    }));
    test('more than one line is listed', () => {
        const t = doc([{ method: 'cash', amount: 60 }, { method: 'upi', amount: 40 }]);
        expect(t).toMatch(/Cash\s+60\.00/);
        expect(t).toMatch(/Upi\s+40\.00/);
    });
    test('a single line adds nothing', () => {
        expect(doc([{ method: 'cash', amount: 100 }])).not.toMatch(/ {2}Cash/);
    });
});

describe('siblingDueFor', () => {
    const Order = require('../models/order');
    const { siblingDueFor } = require('../services/orderTenderService');
    const sibs = (rows) => Order.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
    test('sums what the other unpaid rounds still owe; 0 for takeaway', async () => {
        sibs([{ total: 200, manualDiscount: 20, amountPaid: 0 }, { total: 100, amountPaid: 40 }]);
        expect(await siblingDueFor({}, { type: 'dine-in', table: 't1', _id: 'o1' }, {})).toBe(240);
        expect(await siblingDueFor({}, { type: 'takeaway' }, {})).toBe(0);
        expect(await siblingDueFor({}, { type: 'dine-in', table: 't1', holdReason: 'x' }, {})).toBe(0);
    });
});
