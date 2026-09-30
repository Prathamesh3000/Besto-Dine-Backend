/**
 * Wallet payments (POST /wallet/pay): server-priced, atomic debit, no
 * double spend under concurrency, ownership + tenant scoping.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));

const ctx = useIntegrationApp();
let A;
let B;
const TOTAL = 250; // 200 + 5% GST + 10% service + ₹20 packaging

beforeAll(async () => {
    A = await seedTenant({ label: 'wal-a' });
    B = await seedTenant({ label: 'wal-b' });
});

async function customerOrder(t, cust, table) {
    const tbl = table || await createTable(t, { capacity: 6 });
    const { scanToken } = await scanTable(ctx.api, tbl, { Authorization: `Bearer ${cust.token}` });
    const res = await ctx.api.customerAtTable(cust, t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(tbl._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, table: tbl };
}

const pay = (t, cust, orderId, amount) => ctx.api.as(cust, t).post('/wallet/pay').send({ orderId: String(orderId), amount });
const balanceOf = async (t, cust) => (await Wallet.findOne({ user: cust._id, restaurant: t.restaurant._id }).lean()).balance;

describe('pay with wallet', () => {
    test('debits the wallet, settles the order and writes a ledger row; a retry is a no-op', async () => {
        const cust = await createCustomer('w-pay');
        await setWallet(A, cust, { balance: 1000 });
        const { order } = await customerOrder(A, cust);

        const res = await pay(A, cust, order._id, TOTAL);
        expect(res.status).toBe(200);
        expect(res.body.orderPaid).toBe(true);
        expect(res.body.newBalance).toBe(750);
        expect(await balanceOf(A, cust)).toBe(750);

        const saved = await Order.findById(order._id).lean();
        expect(saved.paymentStatus).toBe('Paid');
        expect(saved.amountPaid).toBe(TOTAL);
        expect(saved.paymentMethod).toBe('wallet');
        const ledger = await Transaction.find({ order: order._id, type: 'order_payment' }).lean();
        expect(ledger).toHaveLength(1);
        expect(ledger[0].amount).toBe(-TOTAL);
        expect(ledger[0].balanceAfter).toBe(750);

        const retry = await pay(A, cust, order._id, TOTAL);
        expect(retry.status).toBe(200);
        expect(retry.body.alreadyPaid).toBe(true);
        expect(await balanceOf(A, cust)).toBe(750);

        // Wallet-settled order finalize via customerPayment awards points once.
        const fin = await ctx.api.as(cust, A).patch(`/orders/${order._id}/payment`).send({ paymentStatus: 'Paid' });
        expect(fin.status).toBe(200);
        await settle();
    });

    test('partial payments accumulate to Paid; over-payment is refused', async () => {
        const cust = await createCustomer('w-partial');
        await setWallet(A, cust, { balance: 1000 });
        const { order } = await customerOrder(A, cust);

        const over = await pay(A, cust, order._id, TOTAL + 50);
        expect(over.status).toBe(400);
        expect(over.body.code).toBe('AMOUNT_EXCEEDS_PAYABLE');

        const p1 = await pay(A, cust, order._id, 100);
        expect(p1.status).toBe(200);
        expect(p1.body.paymentStatus).toBe('Partially Paid');
        const p2 = await pay(A, cust, order._id, 150);
        expect(p2.status).toBe(200);
        expect(p2.body.paymentStatus).toBe('Paid');
        expect(await balanceOf(A, cust)).toBe(750);
    });

    test("cannot pay another customer's order, or an order of another tenant", async () => {
        const owner = await createCustomer('w-owner');
        const other = await createCustomer('w-other');
        await setWallet(A, other, { balance: 1000 });
        await setWallet(B, other, { balance: 1000 });
        const { order } = await customerOrder(A, owner);

        const notYours = await pay(A, other, order._id, TOTAL);
        expect(notYours.status).toBe(403);
        expect(notYours.body.code).toBe('ORDER_NOT_YOURS');

        const { order: orderB } = await customerOrder(B, other);
        const crossTenant = await pay(A, other, orderB._id, TOTAL); // browsing tenant A
        expect(crossTenant.status).toBe(404);

        expect(await balanceOf(A, other)).toBe(1000);
        expect(await balanceOf(B, other)).toBe(1000);
        expect((await Order.findById(order._id).lean()).paymentStatus).toBe('Pending');
    });

    test('a blocked wallet cannot pay', async () => {
        const cust = await createCustomer('w-blocked');
        await setWallet(A, cust, { balance: 1000 });
        await Wallet.updateOne({ user: cust._id, restaurant: A.restaurant._id }, { $set: { status: 'blocked' } });
        const { order } = await customerOrder(A, cust);
        const res = await pay(A, cust, order._id, TOTAL);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WALLET_BLOCKED');
        expect(await balanceOf(A, cust)).toBe(1000);
    });

    test('the balance is per tenant', async () => {
        const cust = await createCustomer('w-tenant');
        await setWallet(B, cust, { balance: 1000 }); // money only at B
        const { order } = await customerOrder(A, cust);
        const res = await pay(A, cust, order._id, TOTAL);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('WALLET_NOT_FOUND');
        expect(await balanceOf(B, cust)).toBe(1000);
    });
});

describe('concurrency', () => {
    test('two concurrent payments that together exceed the balance: exactly one succeeds', async () => {
        const cust = await createCustomer('w-race');
        await setWallet(A, cust, { balance: 400 });
        const table = await createTable(A, { capacity: 6 });
        const { order: o1 } = await customerOrder(A, cust, table);
        const { order: o2 } = await customerOrder(A, cust, table);

        const results = await Promise.all([pay(A, cust, o1._id, TOTAL), pay(A, cust, o2._id, TOTAL)]);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, 400]);
        expect(results.find((r) => r.status === 400).body.code).toBe('INSUFFICIENT_BALANCE');

        expect(await balanceOf(A, cust)).toBe(150);
        const paid = await Order.countDocuments({ _id: { $in: [o1._id, o2._id] }, paymentStatus: 'Paid' });
        expect(paid).toBe(1);
        expect(await Transaction.countDocuments({ user: cust._id, type: 'order_payment' })).toBe(1);
    });

    test('many concurrent payments never drive the balance negative', async () => {
        const cust = await createCustomer('w-burst');
        await setWallet(A, cust, { balance: 600 });
        const table = await createTable(A, { capacity: 10 });
        const orders = [];
        for (let i = 0; i < 5; i++) {
            // eslint-disable-next-line no-await-in-loop
            orders.push((await customerOrder(A, cust, table)).order);
        }
        const results = await Promise.all(orders.map((o) => pay(A, cust, o._id, TOTAL)));
        const ok = results.filter((r) => r.status === 200).length;
        expect(ok).toBe(2); // 600 covers two ₹250 bills
        expect(await balanceOf(A, cust)).toBe(100);
    });

    // Regression: payWithWallet read the order, debited the wallet (atomic
    // $gte guard on the BALANCE only), then saved the order - two
    // concurrent pays for the SAME order both passed the "not yet paid"
    // check and both debited.
    test('two concurrent payments for the SAME order debit the wallet only once', async () => {
        const cust = await createCustomer('w-double');
        await setWallet(A, cust, { balance: 1000 });
        const { order } = await customerOrder(A, cust);

        const results = await Promise.all([pay(A, cust, order._id, TOTAL), pay(A, cust, order._id, TOTAL)]);
        // Both answer 200: one pays, the other is the idempotent replay.
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(results.filter((r) => r.body.alreadyPaid).length).toBe(1);

        expect(await Transaction.countDocuments({ order: order._id, type: 'order_payment' })).toBe(1);
        expect(await balanceOf(A, cust)).toBe(750);
        const saved = await Order.findById(order._id).lean();
        expect(saved.amountPaid).toBe(TOTAL);
        expect(saved.paymentStatus).toBe('Paid');
    });

    test('a burst of concurrent payments for the SAME order debits exactly the bill', async () => {
        const cust = await createCustomer('w-double-burst');
        await setWallet(A, cust, { balance: 1000 });
        const { order } = await customerOrder(A, cust);

        const results = await Promise.all(Array.from({ length: 6 }, () => pay(A, cust, order._id, TOTAL)));
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(await Transaction.countDocuments({ order: order._id, type: 'order_payment' })).toBe(1);
        expect(await balanceOf(A, cust)).toBe(750);
    });
});
