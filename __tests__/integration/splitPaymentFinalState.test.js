/**
 * Split payment (wallet part, then Razorpay for the rest): what the order
 * finally stores and where a refund goes.
 *
 * Flow under test (the order of writes decides the final paymentMethod):
 *   1. order exists (₹500, owned by a customer)
 *   2. POST /wallet/pay for ₹200   -> paymentMethod 'wallet', Partially Paid
 *   3. POST /razorpay/verify-payment for the ₹300 capture
 *      -> markOrderPaidAtomically
 * Then POST /razorpay/refund of the whole bill.
 *
 * Tests whose name starts with "BUG:" pin behaviour the code gets wrong
 * today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const { getTenders, summarizeTenders } = require(path.join(BACKEND, 'utils/tenders'));

const ctx = useIntegrationApp();
let A;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'split-final' });
});

/** ₹500 order: ₹200 from the wallet, then a ₹300 Razorpay capture verified. */
async function payByWalletThenRazorpay(label) {
    const cust = await createCustomer(label);
    await Wallet.create({ user: cust._id, restaurant: A.restaurant._id, balance: 1000 });
    const rzpOrderId = `order_${rid()}`;
    const order = (await Order.create({
        restaurant: A.restaurant._id,
        branch: A.branch._id,
        orderId: `SPL-${rid()}`,
        type: 'takeaway',
        user: cust._id,
        items: [{ menuItem: A.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500,
        razorpayOrderId: rzpOrderId,
    })).toObject();

    const pay = await ctx.api.as(cust, A).post('/wallet/pay').send({ orderId: String(order._id), amount: 200 });
    expect(pay.status).toBe(200);
    const afterWallet = await Order.findById(order._id).lean();

    const paymentId = `pay_${rid()}`;
    const notes = { cafeOrderId: String(order._id), restaurantId: String(A.restaurant._id), purpose: 'cafe_order' };
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: rzpOrderId, status: 'captured', amount: 30000, currency: 'INR', notes,
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: rzpOrderId, entity: 'order', amount: 30000, notes });
    const ver = await ctx.api.as(cust, A).post('/razorpay/verify-payment').send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sig(rzpOrderId, paymentId),
        cafeOrderId: String(order._id),
    });
    expect(ver.status).toBe(200);
    return { cust, order, paymentId, afterWallet, final: await Order.findById(order._id).lean() };
}

describe('wallet debit, then Razorpay verify', () => {
    test('the wallet part leaves the order wallet / Partially Paid, then the verify stores mixed with walletAmountPaid 200', async () => {
        const { cust, order, afterWallet, final } = await payByWalletThenRazorpay('split-final');

        expect(afterWallet).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'Partially Paid', amountPaid: 200 });
        expect(afterWallet.walletAmountPaid || 0).toBe(0);

        expect(final).toMatchObject({ paymentStatus: 'Paid', paymentMethod: 'mixed', amountPaid: 500, walletAmountPaid: 200 });
        expect(final.pointsRedeemed || 0).toBe(0);

        // tender lines agree with the scalar fields
        expect(getTenders(final).map((t) => [t.method, t.amount])).toEqual([['wallet', 200], ['razorpay', 300]]);
        expect(summarizeTenders(final)).toMatchObject({ walletAmountPaid: 200 });

        // ledger: one wallet debit of 200, balance 1000 -> 800
        const rows = await Transaction.find({ order: order._id, type: 'order_payment' }).lean();
        expect(rows.map((r) => r.amount)).toEqual([-200]);
        expect((await Wallet.findOne({ user: cust._id })).balance).toBe(800);
    });

    // Refunding the whole bill of a mixed order should return the wallet part to
    // the wallet and the online part to the gateway. On qa-merge-backend the
    // endpoint answers 200 "refunded successfully" but moves no money: the
    // wallet stays at 800, the gateway is never called, and refunds[] has no
    // destination (a mixed order is treated like a cash hand-back).
    test('BUG: refunding a mixed order returns ₹200 to the wallet and ₹300 to the gateway', async () => {
        const { cust, order, paymentId } = await payByWalletThenRazorpay('split-refund');
        rzp.instance.payments.refund.mockImplementation(async (pid, params) => ({
            id: `rfnd_${rid()}`, entity: 'refund', payment_id: pid, amount: params?.amount, status: 'processed',
        }));

        const res = await ctx.api.as(A.users.admin).post('/razorpay/refund')
            .send({ orderId: String(order._id), amount: 500, reason: 'split payment refund check' });

        expect(res.status).toBe(200);
        expect(rzp.instance.payments.refund).toHaveBeenCalledTimes(1);
        expect(rzp.instance.payments.refund.mock.calls[0][0]).toBe(paymentId);
        expect(rzp.instance.payments.refund.mock.calls[0][1].amount).toBe(30000);
        expect((await Wallet.findOne({ user: cust._id })).balance).toBe(1000);
        const after = await Order.findById(order._id).lean();
        expect(after.refundedAmount).toBe(500);
        expect((after.refunds || []).map((r) => [r.destination, r.amount]).sort())
            .toEqual([['gateway', 300], ['wallet', 200]]);
    });
});
