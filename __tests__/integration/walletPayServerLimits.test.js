/**
 * Server-side limits of paying an order from the wallet (BUG-45 / BUG-46).
 * The client (cart / bill preview) is never trusted: the server alone
 * decides what may be debited, how often, and how a wallet + Razorpay
 * split adds up.
 *
 * Already covered elsewhere (not repeated here):
 *   - above-balance single pay -> 400 INSUFFICIENT_BALANCE, no debit, order Pending:
 *       strictPay_wallet_customer.test.js 'insufficient balance -> 400 INSUFFICIENT_BALANCE ...'
 *   - repeat / concurrent pay -> one debit + alreadyPaid:
 *       wallet.test.js 'two concurrent payments for the SAME order debit the wallet only once',
 *       strictPay_wallet_customer.test.js '3 parallel pays of the SAME order ...'
 *   - Razorpay amounts below Rs 1 are rejected: razorpayOrderPayment.test.js 'rejects an amount below Rs 1 ...'
 * Added here: dine-in pay-after, fractional (paise) bills, full-wallet takeaway
 * with a Rs 226.80 bill, and the wallet + Razorpay split agreeing to the paisa.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Table = require(path.join(BACKEND, 'models/table'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));

const ctx = useIntegrationApp();
let A;
let seq = 0;

beforeAll(async () => { A = await seedTenant({ label: 'wps-a' }); });

const balanceOf = async (cust) => (await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).balance;
const pay = (cust, orderId, amount, key) => {
    let r = ctx.api.as(cust, A).post('/wallet/pay');
    if (key) r = r.set('Idempotency-Key', key);
    return r.send({ orderId: String(orderId), amount });
};
const debits = (order) => Transaction.countDocuments({ order: order._id, type: 'order_payment' });

async function takeaway(cust, total) {
    seq += 1;
    return Order.create({
        restaurant: A.restaurant._id, branch: A.branch._id, orderId: `WPS-${Date.now()}-${seq}`, type: 'takeaway',
        user: cust._id, items: [{ menuItem: A.items.paneer._id, name: 'Paneer Tikka', price: total, quantity: 1 }],
        total, status: 'new', paymentStatus: 'Pending',
    });
}

describe('dine-in pay-after with the wallet', () => {
    test('order at a table, paid from the wallet after service: one debit, Paid, table freed; a replay is alreadyPaid', async () => {
        const cust = await createCustomer('wps-dine');
        await setWallet(A, cust, { balance: 1000 });
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const placed = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
        });
        expect(placed.status).toBe(201);
        const order = placed.body.order;
        expect((await Table.findById(table._id).lean()).status).not.toBe('free');

        const res = await pay(cust, order._id, order.total);
        expect(res.status).toBe(200);
        expect(res.body.orderPaid).toBe(true);
        expect(await balanceOf(cust)).toBe(1000 - order.total);
        const saved = await Order.findById(order._id).lean();
        expect(saved.paymentStatus).toBe('Paid');
        expect(saved.amountPaid).toBe(order.total);
        expect((await Table.findById(table._id).lean()).status).toBe('free');

        const replay = await pay(cust, order._id, order.total);
        expect(replay.status).toBe(200);
        expect(replay.body.alreadyPaid).toBe(true);
        expect(await debits(order)).toBe(1);
        expect(await balanceOf(cust)).toBe(1000 - order.total);
        await settle();
    });
});

describe('fractional bill Rs 226.80', () => {
    test('above the balance (balance 226): 400, no debit, order stays unpaid', async () => {
        const cust = await createCustomer('wps-short');
        await setWallet(A, cust, { balance: 226 });
        const order = await takeaway(cust, 226.8);
        const res = await pay(cust, order._id, 226.8);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
        expect(await balanceOf(cust)).toBe(226);
        const saved = await Order.findById(order._id).lean();
        expect(saved.paymentStatus).toBe('Pending');
        expect(saved.amountPaid || 0).toBe(0);
        expect(await debits(order)).toBe(0);
    });

    test('full-wallet takeaway: wallet pays exactly 226.80 once, order Paid, ledger and balance agree to the paisa', async () => {
        const cust = await createCustomer('wps-full');
        await setWallet(A, cust, { balance: 300 });
        const order = await takeaway(cust, 226.8);
        const key = 'wps-full-key';
        const res = await pay(cust, order._id, 226.8, key);
        expect(res.status).toBe(200);
        expect(res.body.orderPaid).toBe(true);
        expect(res.body.newBalance).toBe(73.2);
        expect(await balanceOf(cust)).toBe(73.2);
        const saved = await Order.findById(order._id).lean();
        expect(saved).toMatchObject({ paymentStatus: 'Paid', amountPaid: 226.8, paymentMethod: 'wallet' });
        const rows = await Transaction.find({ order: order._id, type: 'order_payment' }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(-226.8);

        // Same key: the stored response is replayed; a different key reaches the
        // controller, which answers alreadyPaid. Neither debits again.
        const sameKey = await pay(cust, order._id, 226.8, key);
        expect(sameKey.status).toBe(200);
        const otherKey = await pay(cust, order._id, 226.8, 'wps-full-other');
        expect(otherKey.status).toBe(200);
        expect(otherKey.body.alreadyPaid).toBe(true);
        expect(await balanceOf(cust)).toBe(73.2);
        expect(await debits(order)).toBe(1);
    });

    test('whole-rupee wallet part Rs 226 leaves Rs 0.80: the server tracks it in paise (Partially Paid), never rounds to Rs 1', async () => {
        const cust = await createCustomer('wps-frac');
        await setWallet(A, cust, { balance: 226 });
        const order = await takeaway(cust, 226.8);
        const res = await pay(cust, order._id, 226);
        expect(res.status).toBe(200);
        expect(res.body.paymentStatus).toBe('Partially Paid');
        const saved = await Order.findById(order._id).lean();
        expect(saved.amountPaid).toBe(226);
        expect(Math.round((saved.total - saved.amountPaid) * 100)).toBe(80);
        expect(await balanceOf(cust)).toBe(0);
    });

    test('over-paying the fraction is refused: Rs 227 on a Rs 226.80 bill -> AMOUNT_EXCEEDS_PAYABLE, no debit', async () => {
        const cust = await createCustomer('wps-over');
        await setWallet(A, cust, { balance: 500 });
        const order = await takeaway(cust, 226.8);
        const res = await pay(cust, order._id, 227);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_EXCEEDS_PAYABLE');
        expect(await balanceOf(cust)).toBe(500);
        expect(await debits(order)).toBe(0);
    });
});

describe('wallet + Razorpay split agrees to the paisa', () => {
    beforeEach(() => {
        rzp.instance.orders.create.mockImplementation(async (opts) => ({
            id: `order_wps${Date.now()}`, entity: 'order', amount: opts.amount, currency: opts.currency, receipt: opts.receipt, notes: opts.notes, status: 'created',
        }));
    });
    const create = (cust, body) => ctx.api.as(cust, A).post('/razorpay/create-order').send(body);

    test('wallet 225.80 paid, Razorpay opens for exactly Rs 1.00 (100 paise) = the remainder', async () => {
        const cust = await createCustomer('wps-split');
        await setWallet(A, cust, { balance: 226 });
        const order = await takeaway(cust, 226.8);
        expect((await pay(cust, order._id, 225.8)).status).toBe(200);
        expect(await balanceOf(cust)).toBe(0.2);

        const res = await create(cust, { amount: 1, cafeOrderId: String(order._id) });
        expect(res.status).toBe(200);
        expect(res.body.razorpayOrder.amount).toBe(100);
        expect(rzp.instance.orders.create.mock.calls.at(-1)[0].amount).toBe(100);
        const saved = await Order.findById(order._id).lean();
        expect(Math.round((saved.total - saved.amountPaid) * 100)).toBe(100);
    });

    test('a Rs 0.80 Razorpay remainder is refused before the gateway (below the Rs 1 minimum); a fractional remainder like 26.80 is sent in exact paise', async () => {
        const cust = await createCustomer('wps-min');
        await setWallet(A, cust, { balance: 200 });
        const order = await takeaway(cust, 226.8);
        const before = rzp.instance.orders.create.mock.calls.length;
        const low = await create(cust, { amount: 0.8, cafeOrderId: String(order._id) });
        expect(low.status).toBe(400);
        expect(rzp.instance.orders.create.mock.calls.length).toBe(before);

        expect((await pay(cust, order._id, 200)).status).toBe(200);
        const ok = await create(cust, { amount: 26.8, cafeOrderId: String(order._id) });
        expect(ok.status).toBe(200);
        expect(ok.body.razorpayOrder.amount).toBe(2680);
    });
});
