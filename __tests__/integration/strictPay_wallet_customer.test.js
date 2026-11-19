/**
 * STRICT payments campaign — CUSTOMER WALLET
 *   controllers/walletController.js (payWithWallet, adjustWallet, addPoints,
 *   redeemPoints, setWalletStatus, getWallet), models/wallet.js (paise hook),
 *   controllers/razorpay/wallet.js (recharge create / verify).
 *
 * Money is asserted to the paisa (toBe). "BUG:" tests pin real defects and
 * are expected to FAIL until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Order = req_('models/order');
const Wallet = req_('models/wallet');
const Transaction = req_('models/transaction');
const Settings = req_('models/settings');
const { invalidateCache } = req_('utils/settingsCache');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const KEY_SECRET = () => process.env.RAZORPAY_KEY_SECRET;
const hmac = (s, k) => crypto.createHmac('sha256', k).update(s).digest('hex');
const checkoutSig = (o, p) => hmac(`${o}|${p}`, KEY_SECRET());
const r2 = (n) => Math.round(n * 100) / 100;

let A; let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'spw-a' });
    B = await seedTenant({ label: 'spw-b' });
});

async function mkOrder(t, user, total = 100, fields = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id, branch: t.branch._id, orderId: `SPW-${rid()}`, type: 'takeaway',
        user: user ? user._id : undefined,
        items: [{ menuItem: t.items.paneer._id, name: 'Paneer Tikka', price: total, quantity: 1 }],
        total, status: 'new', paymentStatus: 'Pending', ...fields,
    });
    return doc;
}
const pay = (user, t, body, key = `k-${rid()}`) => ctx.api.as(user, t).post('/wallet/pay').set('Idempotency-Key', key).send(body);
const walletOf = (t, user) => Wallet.findOne({ user: user._id, restaurant: t.restaurant._id }).lean();
const ledger = (t, user, extra = {}) => Transaction.find({ user: user._id, restaurant: t.restaurant._id, ...extra }).sort({ createdAt: 1, _id: 1 }).lean();
async function customerWithBalance(label, balance, points = 0, t = A) {
    const c = await createCustomer(label);
    await setWallet(t, c, { balance, loyaltyPoints: points });
    return c;
}

// ═════════════════════════════════════════════════════════════════════════
describe('POST /wallet/pay: balance guards', () => {
    test('insufficient balance → 400 INSUFFICIENT_BALANCE; wallet, order and ledger all untouched (transaction rolled back)', async () => {
        const c = await customerWithBalance('pay-ins', 40);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
        expect((await walletOf(A, c)).balance).toBe(40);
        const after = await Order.findById(o._id).lean();
        expect(after.paymentStatus).toBe('Pending');
        expect(after.amountPaid || 0).toBe(0);
        expect(after.payments || []).toHaveLength(0);
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(0);
    });

    test('exact balance: wallet goes to exactly 0, order Paid, one debit row with before/after', async () => {
        const c = await customerWithBalance('pay-exact', 100);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, newBalance: 0, orderPaid: true, paymentStatus: 'Paid' });
        expect((await walletOf(A, c)).balance).toBe(0);
        const rows = await ledger(A, c, { type: 'order_payment' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: -100, balanceBefore: 100, balanceAfter: 0, paymentMethod: 'wallet', status: 'completed' });
        expect(String(rows[0].order)).toBe(String(o._id));
        const saved = await Order.findById(o._id).lean();
        expect(saved).toMatchObject({ paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 100 });
        expect(saved.paidAt).toBeTruthy();
    });

    test('one paisa short (balance 99.99 vs 100) is refused', async () => {
        const c = await customerWithBalance('pay-short', 99.99);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(99.99);
    });

    test('customer with no wallet row → 404 WALLET_NOT_FOUND and the order is not marked paid', async () => {
        const c = await createCustomer('pay-nowallet');
        const o = await mkOrder(A, c, 50);
        const res = await pay(c, A, { orderId: String(o._id), amount: 50 });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('WALLET_NOT_FOUND');
        expect((await Order.findById(o._id).lean()).paymentStatus).toBe('Pending');
        expect(await Wallet.countDocuments({ user: c._id })).toBe(0);
    });

    test('wallet is per tenant: a balance held at tenant B cannot pay a tenant A order', async () => {
        const c = await createCustomer('pay-xt');
        await setWallet(B, c, { balance: 500 });
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect([400, 404]).toContain(res.status);
        expect((await walletOf(B, c)).balance).toBe(500);
        expect((await Order.findById(o._id).lean()).paymentStatus).toBe('Pending');
    });
});

describe('POST /wallet/pay: amount / orderId validation', () => {
    test.each([
        ['zero', 0],
        ['negative', -50],
        ['string "abc"', 'abc'],
        ['string "NaN"', 'NaN'],
        ['"Infinity"', 'Infinity'],
        ['null', null],
        ['empty string', ''],
        ['missing', undefined],
        ['object', { $gt: 0 }],
    ])('amount %s → 400 AMOUNT_INVALID, nothing moves', async (_l, amount) => {
        const c = await customerWithBalance('pay-amt', 500);
        const o = await mkOrder(A, c, 100);
        const body = { orderId: String(o._id) };
        if (amount !== undefined) body.amount = amount;
        const res = await pay(c, A, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_INVALID');
        expect((await walletOf(A, c)).balance).toBe(500);
        expect((await Order.findById(o._id).lean()).paymentStatus).toBe('Pending');
    });

    test('Regression (fixed 2026-11): a boolean amount (true) is coerced to ₹1 and debited instead of being rejected', async () => {
        // Expected: 400 AMOUNT_INVALID (amount must be a number). Actual: Number(true) === 1 → partial ₹1 payment.
        // controllers/walletController.js:~565 `Number(amount)`; routes/walletRoute.js payValidation does not type-check amount.
        const c = await customerWithBalance('pay-bool', 500);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: true });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('Regression (fixed 2026-11): an array amount ([5]) is coerced to ₹5 and debited instead of being rejected', async () => {
        // Expected 400; Actual: Number([5]) === 5.
        const c = await customerWithBalance('pay-arr', 500);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: [5] });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('a numeric string "100" is accepted and debits exactly ₹100', async () => {
        const c = await customerWithBalance('pay-numstr', 500);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: '100' });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(400);
    });

    test.each([
        ['missing', undefined],
        ['malformed', 'not-an-id'],
        ['object', { $ne: null }],
        ['unknown id', String(new mongoose.Types.ObjectId())],
    ])('orderId %s → 400/404, wallet untouched', async (_l, orderId) => {
        const c = await customerWithBalance('pay-oid', 500);
        const body = { amount: 10 };
        if (orderId !== undefined) body.orderId = orderId;
        const res = await pay(c, A, body);
        expect([400, 404]).toContain(res.status);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('amount greater than the payable → 400 AMOUNT_EXCEEDS_PAYABLE (no over-payment, no debit)', async () => {
        const c = await customerWithBalance('pay-over', 500);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 150 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_EXCEEDS_PAYABLE');
        expect(res.body.payable).toBe(100);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('amount 1 paisa over the payable is tolerated by the 0.01 slack but never debits more than the amount sent', async () => {
        const c = await customerWithBalance('pay-slack', 500);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100.01 });
        expect(res.status).toBe(200);
        const w = await walletOf(A, c);
        const order = await Order.findById(o._id).lean();
        // Either debit is the payable (100) or the sent 100.01; but wallet debit and order.amountPaid must agree.
        expect(r2(500 - w.balance)).toBe(order.amountPaid);
        expect(order.amountPaid).toBeLessThanOrEqual(100.01);
    });

    test('paise rounding of the requested amount: 33.336 is debited as 33.34 (ledger, order and balance agree)', async () => {
        const c = await customerWithBalance('pay-round', 100);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 33.336 });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(66.66);
        const order = await Order.findById(o._id).lean();
        expect(order.amountPaid).toBe(33.34);
        expect(order.paymentStatus).toBe('Partially Paid');
        const [row] = await ledger(A, c, { type: 'order_payment' });
        expect(row.amount).toBe(-33.34);
        expect(row.balanceBefore).toBe(100);
        expect(row.balanceAfter).toBe(66.66);
    });

    test('Regression (fixed 2026-11): a sub-paisa pay amount (0.004) rounds to 0 and is accepted as a zero-value payment (order flips to Partially Paid)', async () => {
        const c = await customerWithBalance('pay-sub', 100);
        const o = await mkOrder(A, c, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 0.004 });
        // Expected: 400 (nothing to charge). Actual: deduct rounds to 0 → passes validation → 0-value debit row.
        expect(res.status).toBe(400);
        expect((await Order.findById(o._id).lean()).paymentStatus).toBe('Pending');
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(0);
    });
});

describe('POST /wallet/pay: ownership, state and idempotency', () => {
    test("another customer's order → 403 ORDER_NOT_YOURS, no debit", async () => {
        const owner = await createCustomer('pay-own');
        const thief = await customerWithBalance('pay-thief', 500);
        const o = await mkOrder(A, owner, 100);
        const res = await pay(thief, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORDER_NOT_YOURS');
        expect((await walletOf(A, thief)).balance).toBe(500);
    });

    test("tenant B's order id on tenant A → 404, no debit", async () => {
        const c = await customerWithBalance('pay-xorder', 500);
        const bo = await mkOrder(B, c, 100);
        const res = await pay(c, A, { orderId: String(bo._id), amount: 100 });
        expect(res.status).toBe(404);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('cancelled order → 400 ORDER_CANCELLED', async () => {
        const c = await customerWithBalance('pay-cancel', 500);
        const o = await mkOrder(A, c, 100, { status: 'cancelled' });
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ORDER_CANCELLED');
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('already-Paid order → 200 alreadyPaid, no second debit', async () => {
        const c = await customerWithBalance('pay-paid', 500);
        const o = await mkOrder(A, c, 100, { paymentStatus: 'Paid', amountPaid: 100, paymentMethod: 'cash' });
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(200);
        expect(res.body.alreadyPaid).toBe(true);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('replay with the same Idempotency-Key debits once', async () => {
        const c = await customerWithBalance('pay-idem', 500);
        const o = await mkOrder(A, c, 100);
        const key = `idem-${rid()}`;
        const r1 = await pay(c, A, { orderId: String(o._id), amount: 100 }, key);
        const r2_ = await pay(c, A, { orderId: String(o._id), amount: 100 }, key);
        expect(r1.status).toBe(200);
        expect(r2_.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(400);
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(1);
    });

    test('same order paid twice with DIFFERENT keys debits once (second is alreadyPaid)', async () => {
        const c = await customerWithBalance('pay-twice', 500);
        const o = await mkOrder(A, c, 100);
        expect((await pay(c, A, { orderId: String(o._id), amount: 100 })).status).toBe(200);
        const second = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(second.status).toBe(200);
        expect(second.body.alreadyPaid).toBe(true);
        expect((await walletOf(A, c)).balance).toBe(400);
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(1);
    });

    test('partial pay then settle the rest: two debit rows, amountPaid chains, final status Paid', async () => {
        const c = await customerWithBalance('pay-part', 500);
        const o = await mkOrder(A, c, 100);
        const r1 = await pay(c, A, { orderId: String(o._id), amount: 40 });
        expect(r1.body).toMatchObject({ orderPaid: false, paymentStatus: 'Partially Paid', newBalance: 460 });
        const r2_ = await pay(c, A, { orderId: String(o._id), amount: 60 });
        expect(r2_.body).toMatchObject({ orderPaid: true, paymentStatus: 'Paid', newBalance: 400 });
        const saved = await Order.findById(o._id).lean();
        expect(saved.amountPaid).toBe(100);
        expect(saved.payments).toHaveLength(2);
        const rows = await ledger(A, c, { type: 'order_payment' });
        expect(rows.map((r) => r.amount)).toEqual([-40, -60]);
        expect(rows.map((r) => r.balanceAfter)).toEqual([460, 400]);
    });

    test('over-paying the remainder after a partial is refused', async () => {
        const c = await customerWithBalance('pay-part2', 500);
        const o = await mkOrder(A, c, 100);
        expect((await pay(c, A, { orderId: String(o._id), amount: 70 })).status).toBe(200);
        const res = await pay(c, A, { orderId: String(o._id), amount: 40 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_EXCEEDS_PAYABLE');
        expect((await walletOf(A, c)).balance).toBe(430);
    });

    test('blocked / suspended wallet → 403 with code and nothing moves', async () => {
        for (const status of ['blocked', 'suspended']) {
            const c = await customerWithBalance(`pay-${status}`, 500);
            await Wallet.updateOne({ user: c._id, restaurant: A.restaurant._id }, { $set: { status } });
            const o = await mkOrder(A, c, 100);
            const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe(status === 'blocked' ? 'WALLET_BLOCKED' : 'WALLET_SUSPENDED');
            expect((await walletOf(A, c)).balance).toBe(500);
        }
    });

    test('unauthenticated → 401', async () => {
        const res = await ctx.api.guest(A).post('/wallet/pay').set('Idempotency-Key', `k-${rid()}`).send({ orderId: String(new mongoose.Types.ObjectId()), amount: 1 });
        expect(res.status).toBe(401);
    });

    test('a guest order (no user on the order) can be paid from any logged-in wallet of the tenant', async () => {
        // Documents the pre-auth flow comment in payWithWallet; wallet owner is debited.
        const c = await customerWithBalance('pay-guestorder', 500);
        const o = await mkOrder(A, null, 100);
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(400);
    });
});

describe('POST /wallet/pay: concurrency', () => {
    test('3 parallel pays of ₹50 against a ₹100 balance (3 different orders): exactly 2 succeed, balance 0, never negative', async () => {
        const c = await customerWithBalance('pay-race3', 100);
        const orders = await Promise.all([1, 2, 3].map(() => mkOrder(A, c, 50)));
        const results = await Promise.all(orders.map((o) => pay(c, A, { orderId: String(o._id), amount: 50 })));
        const ok = results.filter((r) => r.status === 200);
        const bad = results.filter((r) => r.status !== 200);
        expect(ok).toHaveLength(2);
        expect(bad).toHaveLength(1);
        expect(bad[0].status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(0);
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(2);
        const paid = await Order.countDocuments({ user: c._id, paymentStatus: 'Paid' });
        expect(paid).toBe(2);
    });

    test('3 parallel pays of the SAME order: one debit, the others alreadyPaid / conflict, no double charge', async () => {
        const c = await customerWithBalance('pay-race-same', 500);
        const o = await mkOrder(A, c, 100);
        const results = await Promise.all([1, 2, 3].map(() => pay(c, A, { orderId: String(o._id), amount: 100 })));
        expect(results.filter((r) => r.status === 200 && !r.body.alreadyPaid)).toHaveLength(1);
        expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
        expect((await walletOf(A, c)).balance).toBe(400);
        expect(await ledger(A, c, { type: 'order_payment' })).toHaveLength(1);
    });

    test('5 parallel pays of ₹30 vs a ₹100 balance: exactly 3 succeed, balance 10, ledger replays to the balance', async () => {
        const c = await customerWithBalance('pay-race5', 100);
        const orders = await Promise.all([1, 2, 3, 4, 5].map(() => mkOrder(A, c, 30)));
        const results = await Promise.all(orders.map((o) => pay(c, A, { orderId: String(o._id), amount: 30 })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(3);
        const w = await walletOf(A, c);
        expect(w.balance).toBe(10);
        const rows = await ledger(A, c, { type: 'order_payment' });
        expect(r2(100 + rows.reduce((s, r) => s + r.amount, 0))).toBe(w.balance);
    });

    test('pay racing an admin balance deduct never leaves the wallet negative', async () => {
        const c = await customerWithBalance('pay-vs-adj', 100);
        const o = await mkOrder(A, c, 100);
        const [p, a] = await Promise.all([
            pay(c, A, { orderId: String(o._id), amount: 100 }),
            ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 100, type: 'balance', action: 'deduct' }),
        ]);
        const w = await walletOf(A, c);
        expect(w.balance).toBeGreaterThanOrEqual(0);
        expect([p.status, a.status].filter((s) => s === 200)).toHaveLength(1);
    });
});

describe('POST /wallet/pay: fully-paid side effects', () => {
    test('a held pay-first (awaiting-payment) order is released once wallet pays it', async () => {
        const c = await customerWithBalance('pay-hold', 500);
        const o = await mkOrder(A, c, 100, { status: 'awaiting-payment' });
        const res = await pay(c, A, { orderId: String(o._id), amount: 100 });
        expect(res.status).toBe(200);
        await settle(200);
        const saved = await Order.findById(o._id).lean();
        expect(saved.paymentStatus).toBe('Paid');
        expect(saved.status).not.toBe('awaiting-payment');
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('wallet recharge (Razorpay): credits exactly once', () => {
    const noteFor = (c, t = A) => ({ purpose: 'wallet_recharge', userId: String(c._id), restaurantId: String(t.restaurant._id) });
    function stubPayment(c, { amount = 50000, status = 'captured', notes } = {}) {
        const payId = `pay_${rid()}`; const rzpO = `order_${rid()}`;
        const n = notes || noteFor(c);
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpO, status, amount, currency: 'INR', notes: n });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpO, entity: 'order', amount, notes: n });
        return { payId, rzpO };
    }
    const verify = (c, { payId, rzpO }, extra = {}) => ctx.api.as(c, A).post('/razorpay/verify-wallet-recharge')
        .set('Idempotency-Key', `k-${rid()}`)
        .send({ razorpay_order_id: rzpO, razorpay_payment_id: payId, razorpay_signature: checkoutSig(rzpO, payId), ...extra });

    test('a captured ₹500 recharge credits ₹500 and writes one ledger row bound to the payment id', async () => {
        const c = await customerWithBalance('rc-ok', 10);
        const p = stubPayment(c);
        const res = await verify(c, p);
        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(510);
        expect((await walletOf(A, c)).balance).toBe(510);
        const rows = await ledger(A, c, { type: 'wallet_recharge' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: 500, balanceBefore: 10, balanceAfter: 510, razorpayPaymentId: p.payId });
    });

    test('the credit is what Razorpay settled, never the client-sent amount', async () => {
        const c = await customerWithBalance('rc-amt', 0);
        const p = stubPayment(c, { amount: 10000 }); // ₹100
        const res = await verify(c, p, { amount: 9999 });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test('replaying the same verification credits once (alreadyCredited)', async () => {
        const c = await customerWithBalance('rc-replay', 0);
        const p = stubPayment(c, { amount: 20000 });
        const r1 = await verify(c, p);
        const r2_ = await verify(c, p);
        expect(r1.status).toBe(200);
        expect(r2_.status).toBe(200);
        expect(r2_.body.alreadyCredited).toBe(true);
        expect((await walletOf(A, c)).balance).toBe(200);
        expect(await ledger(A, c, { type: 'wallet_recharge' })).toHaveLength(1);
    });

    test('5 concurrent verifications of one payment credit exactly once', async () => {
        const c = await customerWithBalance('rc-conc', 0);
        const p = stubPayment(c, { amount: 20000 });
        const results = await Promise.all([1, 2, 3, 4, 5].map(() => verify(c, p)));
        expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
        expect((await walletOf(A, c)).balance).toBe(200);
        expect(await ledger(A, c, { type: 'wallet_recharge' })).toHaveLength(1);
    });

    test('a bad checkout signature is refused and credits nothing', async () => {
        const c = await customerWithBalance('rc-sig', 0);
        const p = stubPayment(c);
        const res = await ctx.api.as(c, A).post('/razorpay/verify-wallet-recharge').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: p.rzpO, razorpay_payment_id: p.payId, razorpay_signature: 'f'.repeat(64) });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(0);
    });

    test('a payment that is not captured is refused', async () => {
        const c = await customerWithBalance('rc-auth', 0);
        const p = stubPayment(c, { status: 'created' });
        const res = await verify(c, p);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await walletOf(A, c)).balance).toBe(0);
    });

    test("another user's recharge order cannot be claimed (RECHARGE_USER_MISMATCH)", async () => {
        const victim = await createCustomer('rc-victim');
        const thief = await customerWithBalance('rc-thief', 0);
        const p = stubPayment(victim);
        const res = await verify(thief, p);
        expect(res.status).toBe(403);
        expect((await walletOf(A, thief)).balance).toBe(0);
        // the victim can still claim it afterwards
        const ok = await verify(victim, p);
        expect(ok.status).toBe(200);
    });

    test('a non-recharge payment (purpose order) cannot top up the wallet', async () => {
        const c = await customerWithBalance('rc-purpose', 0);
        const p = stubPayment(c, { notes: { purpose: 'cafe_order', userId: String(c._id), restaurantId: String(A.restaurant._id) } });
        const res = await verify(c, p);
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(0);
    });

    test('recharge above ₹10,000 is refused at verify', async () => {
        const c = await customerWithBalance('rc-max', 0);
        const p = stubPayment(c, { amount: 1000100 });
        const res = await verify(c, p);
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(0);
    });

    test('gateway fetch failure fails closed (502) and credits nothing; the payment id stays claimable afterwards', async () => {
        const c = await customerWithBalance('rc-gw', 0);
        const p = stubPayment(c);
        rzp.instance.payments.fetch.mockRejectedValueOnce(new Error('network'));
        const res = await verify(c, p);
        expect(res.status).toBe(502);
        expect((await walletOf(A, c)).balance).toBe(0);
        stubPayment(c); // new ids irrelevant; re-stub the original to succeed
        rzp.instance.payments.fetch.mockResolvedValue({ id: p.payId, entity: 'payment', order_id: p.rzpO, status: 'captured', amount: 50000, currency: 'INR', notes: noteFor(c) });
        rzp.instance.orders.fetch.mockResolvedValue({ id: p.rzpO, entity: 'order', amount: 50000, notes: noteFor(c) });
        const ok = await verify(c, p);
        expect(ok.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(500);
    });

    test('a recharge for a customer with no wallet yet creates the wallet (upsert) with the exact credit', async () => {
        const c = await createCustomer('rc-new');
        const p = stubPayment(c, { amount: 12345 }); // ₹123.45
        const res = await verify(c, p);
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(123.45);
        expect(await Wallet.countDocuments({ user: c._id })).toBe(1);
    });

    test('two successive recharges of ₹0.10 + ₹0.20 land on exactly 0.3 (no float drift)', async () => {
        const c = await customerWithBalance('rc-drift', 0);
        // Razorpay minimum is ₹1 at create, but verify itself accepts whatever was settled.
        await verify(c, stubPayment(c, { amount: 10 }));
        await verify(c, stubPayment(c, { amount: 20 }));
        expect((await walletOf(A, c)).balance).toBe(0.3);
    });

    test.each([
        ['below ₹1', 0.5, 400],
        ['above ₹10,000', 10001, 400],
        ['zero', 0, 400],
        ['negative', -5, 400],
        ['string', '500', 400],
        ['null', null, 400],
        ['NaN-ish string', 'NaN', 400],
    ])('create-wallet-recharge amount %s → %i', async (_l, amount, status) => {
        const c = await customerWithBalance('rc-create-bad', 0);
        const res = await ctx.api.as(c, A).post('/razorpay/create-wallet-recharge').send({ amount });
        expect(res.status).toBe(status);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });

    test('create-wallet-recharge stamps purpose / userId / restaurantId in the order notes, amount in paise', async () => {
        const c = await customerWithBalance('rc-create', 0);
        rzp.instance.orders.create.mockResolvedValue({ id: 'order_x', amount: 12345, currency: 'INR', receipt: 'r' });
        const res = await ctx.api.as(c, A).post('/razorpay/create-wallet-recharge').send({ amount: 123.45 });
        expect(res.status).toBe(200);
        const arg = rzp.instance.orders.create.mock.calls[0][0];
        expect(arg.amount).toBe(12345);
        expect(arg.notes).toMatchObject({ purpose: 'wallet_recharge', userId: String(c._id), restaurantId: String(A.restaurant._id) });
        expect(arg.receipt.length).toBeLessThanOrEqual(40);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('wallet paise rounding hook (models/wallet.js)', () => {
    test('0.1 + 0.2 via $inc is stored as exactly 0.3', async () => {
        const c = await customerWithBalance('rnd-1', 0);
        await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.1 } });
        await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.2 } });
        expect((await walletOf(A, c)).balance).toBe(0.3);
    });

    test('sub-paisa $inc (0.004) is rounded away; 0.005 rounds up to a paisa', async () => {
        const c = await customerWithBalance('rnd-2', 10);
        await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.004 } }, { returnDocument: 'after' });
        expect((await walletOf(A, c)).balance).toBe(10);
        await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.006 } }, { returnDocument: 'after' });
        expect((await walletOf(A, c)).balance).toBe(10.01);
    });

    test('returned doc already reflects rounding and is not dirty', async () => {
        const c = await customerWithBalance('rnd-3', 0);
        const doc = await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.1 + 0.2 } }, { returnDocument: 'after' });
        expect(doc.balance).toBe(0.3);
        expect(doc.isModified('balance')).toBe(false);
    });

    test('rounding hook with returnDocument "before" still leaves the STORED value on paise', async () => {
        const c = await customerWithBalance('rnd-4', 0);
        await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.1 + 0.2 } });
        expect((await walletOf(A, c)).balance).toBe(0.3);
    });

    test('50 concurrent ₹0.10 credits sum to exactly ₹5.00 (no lost updates, no drift)', async () => {
        const c = await customerWithBalance('rnd-5', 0);
        await Promise.all(Array.from({ length: 50 }, () => Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.1 } })));
        expect((await walletOf(A, c)).balance).toBe(5);
    });

    test('schema rejects a negative balance / negative points on save', async () => {
        const c = await createCustomer('rnd-neg');
        await expect(Wallet.create({ user: c._id, restaurant: A.restaurant._id, balance: -1 })).rejects.toThrow(/negative/i);
        await expect(Wallet.create({ user: c._id, restaurant: A.restaurant._id, loyaltyPoints: -1 })).rejects.toThrow(/negative/i);
    });

    test('Regression (fixed 2026-11): findOneAndUpdate $inc can drive balance negative (min validator is not applied to updates)', async () => {
        // Expected: the schema guarantee "Wallet balance cannot be negative" holds for updates too.
        // Actual: no runValidators on findOneAndUpdate; only call-site $gte guards stop overdraw
        // (models/wallet.js:25 min validator is save()-only).
        const c = await customerWithBalance('rnd-neg2', 5);
        let threw = false;
        try {
            await Wallet.findOneAndUpdate({ user: c._id, restaurant: A.restaurant._id }, { $inc: { balance: -10 } });
        } catch (e) { threw = true; }
        const w = await walletOf(A, c);
        expect(threw || w.balance >= 0).toBe(true);
    });

    test('one wallet per (user, tenant): a second wallet for the same pair is rejected, a different tenant is fine', async () => {
        const c = await createCustomer('rnd-uniq');
        await Wallet.create({ user: c._id, restaurant: A.restaurant._id });
        await expect(Wallet.create({ user: c._id, restaurant: A.restaurant._id })).rejects.toThrow(/duplicate|E11000/i);
        await expect(Wallet.create({ user: c._id, restaurant: B.restaurant._id })).resolves.toBeTruthy();
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('admin /wallet/admin/adjust', () => {
    const adjust = (body, admin = A.users.admin) => ctx.api.as(admin).post('/wallet/admin/adjust').send(body);

    test('add balance: credits, writes wallet_recharge with before/after', async () => {
        const c = await customerWithBalance('adj-add', 10);
        const res = await adjust({ targetUserId: String(c._id), amount: 25.5, type: 'balance', action: 'add' });
        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(35.5);
        const [row] = await ledger(A, c, { type: 'wallet_recharge' });
        expect(row).toMatchObject({ amount: 25.5, balanceBefore: 10, balanceAfter: 35.5, paymentMethod: 'wallet' });
    });

    test('deduct more than the balance → 400, wallet unchanged, no ledger row', async () => {
        const c = await customerWithBalance('adj-over', 10);
        const res = await adjust({ targetUserId: String(c._id), amount: 10.01, type: 'balance', action: 'deduct' });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(10);
        expect(await ledger(A, c)).toHaveLength(0);
    });

    test('deduct exactly the balance → 0', async () => {
        const c = await customerWithBalance('adj-exact', 10);
        const res = await adjust({ targetUserId: String(c._id), amount: 10, type: 'balance', action: 'deduct' });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(0);
    });

    test('deduct points beyond held points → 400', async () => {
        const c = await customerWithBalance('adj-pts', 0, 10);
        const res = await adjust({ targetUserId: String(c._id), amount: 11, type: 'points', action: 'deduct' });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(10);
    });

    test('deduct on a customer with no wallet → 400 and no wallet is created', async () => {
        const c = await createCustomer('adj-nowallet');
        const res = await adjust({ targetUserId: String(c._id), amount: 5, type: 'balance', action: 'deduct' });
        expect(res.status).toBe(400);
        expect(await Wallet.countDocuments({ user: c._id })).toBe(0);
    });

    test('add on a customer with no wallet creates it', async () => {
        const c = await createCustomer('adj-new');
        const res = await adjust({ targetUserId: String(c._id), amount: 5, type: 'balance', action: 'add' });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).balance).toBe(5);
    });

    test.each([
        ['zero', 0],
        ['negative', -5],
        ['string abc', 'abc'],
        ['NaN string', 'NaN'],
        ['too big', 10000001],
        ['object', { $gt: 0 }],
    ])('amount %s → 400', async (_l, amount) => {
        const c = await customerWithBalance('adj-bad', 100);
        const res = await adjust({ targetUserId: String(c._id), amount, type: 'balance', action: 'add' });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test.each([
        ['type', { type: 'gold', action: 'add' }],
        ['action', { type: 'balance', action: 'multiply' }],
        ['missing type', { action: 'add' }],
        ['missing action', { type: 'balance' }],
    ])('bad %s → 400', async (_l, extra) => {
        const c = await customerWithBalance('adj-enum', 100);
        const res = await adjust({ targetUserId: String(c._id), amount: 5, ...extra });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test('a staff account cannot be adjusted (customers only)', async () => {
        const res = await adjust({ targetUserId: String(A.users.waiter._id), amount: 5, type: 'balance', action: 'add' });
        expect(res.status).toBe(400);
        expect(await Wallet.countDocuments({ user: A.users.waiter._id })).toBe(0);
    });

    test('unknown user → 404', async () => {
        const res = await adjust({ targetUserId: String(new mongoose.Types.ObjectId()), amount: 5, type: 'balance', action: 'add' });
        expect(res.status).toBe(404);
    });

    test.each(['waiter', 'chef', 'captain', 'customer'])('%s cannot adjust a wallet → 403', async (role) => {
        const actor = role === 'customer' ? await createCustomer('adj-role') : A.users[role];
        const c = await customerWithBalance(`adj-role-${role}`, 100);
        const res = await ctx.api.as(actor, A).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 5, type: 'balance', action: 'add' });
        expect([401, 403]).toContain(res.status);
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test('Regression (fixed 2026-11): 10 concurrent first-time admin adds to a wallet-less customer: losers get 500 (E11000 on the (user, restaurant) unique index), credits lost', async () => {
        // First-time wallet creation races on the (user, restaurant) unique index.
        const c = await createCustomer('adj-firstrace');
        const results = await Promise.all(Array.from({ length: 10 }, () => adjust({ targetUserId: String(c._id), amount: 1.1, type: 'balance', action: 'add' })));
        const failed = results.filter((r) => r.status !== 200);
        // Expected: all 200. Actual (if defect): losing racers return 500 'Failed to adjust wallet' because
        // Wallet.create() is used instead of an upsert (controllers/walletController.js:~268).
        expect(failed.map((r) => r.status)).toEqual([]);
        expect((await walletOf(A, c)).balance).toBe(11);
    });

    test('concurrent deducts of ₹60 against ₹100: exactly one succeeds', async () => {
        const c = await customerWithBalance('adj-dedrace', 100);
        const results = await Promise.all([1, 2, 3].map(() => adjust({ targetUserId: String(c._id), amount: 60, type: 'balance', action: 'deduct' })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await walletOf(A, c)).balance).toBe(40);
    });

    test('admin deduct on a blocked wallet still works (blocked gates the customer, not the admin)', async () => {
        const c = await customerWithBalance('adj-blocked', 100);
        await Wallet.updateOne({ user: c._id, restaurant: A.restaurant._id }, { $set: { status: 'blocked' } });
        const res = await adjust({ targetUserId: String(c._id), amount: 10, type: 'balance', action: 'deduct' });
        expect(res.status).toBe(200);
    });

    test("tenant B's admin cannot touch tenant A's customer wallet", async () => {
        const c = await customerWithBalance('adj-xt', 100);
        const res = await adjust({ targetUserId: String(c._id), amount: 10, type: 'balance', action: 'deduct' }, B.users.admin);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((await walletOf(A, c)).balance).toBe(100);
    });

    test('Regression (fixed 2026-11): an admin balance deduction is recorded as type order_payment, so reports count it as wallet spend', async () => {
        // Expected: a distinct adjustment type (or at least not an 'order_payment' with no order).
        // Actual: type 'order_payment', paymentMethod 'wallet', no order ref → inflates "Total Spent" / utilisation in
        // getWalletReports + getAdminWalletStats (controllers/walletController.js:~278).
        const c = await customerWithBalance('adj-report', 100);
        await adjust({ targetUserId: String(c._id), amount: 10, type: 'balance', action: 'deduct' });
        const [row] = await ledger(A, c);
        expect(row.type).not.toBe('order_payment');
    });
});

describe('admin /wallet/points/add', () => {
    const add = (body, admin = A.users.admin) => ctx.api.as(admin).post('/wallet/points/add').send(body);

    test('credits points to a customer with a ledger row', async () => {
        const c = await customerWithBalance('pa-ok', 0, 5);
        const res = await add({ targetUserId: String(c._id), points: 20, description: 'goodwill' });
        expect(res.status).toBe(200);
        expect(res.body.points).toBe(25);
        const [row] = await ledger(A, c, { type: 'points_earned' });
        expect(row).toMatchObject({ amount: 20, balanceBefore: 5, balanceAfter: 25, description: 'goodwill' });
    });

    test.each([
        ['zero', 0], ['negative', -5], ['string', '10'], ['null', null], ['> 10000', 10001], ['Infinity string', 'Infinity'],
    ])('points %s → 400', async (_l, points) => {
        const c = await customerWithBalance('pa-bad', 0, 5);
        const res = await add({ targetUserId: String(c._id), points });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(5);
    });

    test('exactly 10,000 points is allowed', async () => {
        const c = await customerWithBalance('pa-max', 0, 0);
        expect((await add({ targetUserId: String(c._id), points: 10000 })).status).toBe(200);
    });

    test.each(['waiter', 'chef', 'captain'])('%s → 403', async (role) => {
        const c = await customerWithBalance(`pa-role-${role}`, 0, 0);
        const res = await ctx.api.as(A.users[role], A).post('/wallet/points/add').send({ targetUserId: String(c._id), points: 5 });
        expect(res.status).toBe(403);
    });

    test('a customer cannot mint points for themselves', async () => {
        const c = await customerWithBalance('pa-self', 0, 0);
        const res = await ctx.api.as(c, A).post('/wallet/points/add').send({ points: 500 });
        expect([401, 403]).toContain(res.status);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(0);
    });

    test('points can only be added to customers; blocked wallet refuses', async () => {
        const staffRes = await add({ targetUserId: String(A.users.waiter._id), points: 5 });
        expect(staffRes.status).toBe(400);
        const c = await customerWithBalance('pa-blocked', 0, 0);
        await Wallet.updateOne({ user: c._id, restaurant: A.restaurant._id }, { $set: { status: 'blocked' } });
        expect((await add({ targetUserId: String(c._id), points: 5 })).status).toBe(403);
    });

    test('description longer than 500 chars → 400', async () => {
        const c = await customerWithBalance('pa-desc', 0, 0);
        const res = await add({ targetUserId: String(c._id), points: 5, description: 'x'.repeat(501) });
        expect(res.status).toBe(400);
    });

    test('20 concurrent +5 point credits sum exactly (no lost update)', async () => {
        const c = await customerWithBalance('pa-race', 0, 0);
        const results = await Promise.all(Array.from({ length: 20 }, () => add({ targetUserId: String(c._id), points: 5 })));
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(100);
        expect(await ledger(A, c, { type: 'points_earned' })).toHaveLength(20);
    });
});

describe('admin /wallet/admin/set-status', () => {
    const setStatus = (body, admin = A.users.admin) => ctx.api.as(admin).post('/wallet/admin/set-status').send(body);

    test.each(['blocked', 'suspended', 'active', 'BLOCKED'])('status %s is applied (case-insensitive) with an audit row', async (status) => {
        const c = await customerWithBalance('st-ok', 10);
        const res = await setStatus({ targetUserId: String(c._id), status });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).status).toBe(status.toLowerCase());
        const rows = await ledger(A, c, { type: 'wallet_status_change' });
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(0);
    });

    test.each([['bogus'], [''], [123], [null]])('invalid status %p → 400, wallet unchanged', async (status) => {
        const c = await customerWithBalance('st-bad', 10);
        const res = await setStatus({ targetUserId: String(c._id), status });
        expect(res.status).toBe(400);
        expect((await walletOf(A, c)).status).toBe('active');
    });

    test('no wallet → 404; tenant B admin cannot flip it; waiter → 403', async () => {
        const c = await createCustomer('st-none');
        expect((await setStatus({ targetUserId: String(c._id), status: 'blocked' })).status).toBe(404);
        const c2 = await customerWithBalance('st-xt', 10);
        expect((await setStatus({ targetUserId: String(c2._id), status: 'blocked' }, B.users.admin)).status).toBeGreaterThanOrEqual(400);
        expect((await walletOf(A, c2)).status).toBe('active');
        expect((await ctx.api.as(A.users.waiter, A).post('/wallet/admin/set-status').send({ targetUserId: String(c2._id), status: 'blocked' })).status).toBe(403);
    });

    test('a blocked wallet cannot redeem points or pay, then works again once re-activated', async () => {
        const c = await customerWithBalance('st-flow', 100, 100);
        await setStatus({ targetUserId: String(c._id), status: 'blocked' });
        const red = await ctx.api.as(c, A).post('/wallet/points/redeem').send({ points: 10 });
        expect(red.status).toBe(403);
        await setStatus({ targetUserId: String(c._id), status: 'active' });
        const red2 = await ctx.api.as(c, A).post('/wallet/points/redeem').send({ points: 10 });
        expect(red2.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('ledger sums to balance', () => {
    test('recharge + pay + points redeem + admin add/deduct: replayed ledger equals the stored balance', async () => {
        const c = await createCustomer('ledger-1');
        const notes = { purpose: 'wallet_recharge', userId: String(c._id), restaurantId: String(A.restaurant._id) };
        const payId = `pay_${rid()}`; const rzpO = `order_${rid()}`;
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, entity: 'payment', order_id: rzpO, status: 'captured', amount: 30000, currency: 'INR', notes });
        rzp.instance.orders.fetch.mockResolvedValue({ id: rzpO, entity: 'order', amount: 30000, notes });
        expect((await ctx.api.as(c, A).post('/razorpay/verify-wallet-recharge').set('Idempotency-Key', `k-${rid()}`)
            .send({ razorpay_order_id: rzpO, razorpay_payment_id: payId, razorpay_signature: checkoutSig(rzpO, payId) })).status).toBe(200);
        await ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 50, type: 'points', action: 'add' });
        await ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 12.5, type: 'balance', action: 'add' });
        expect((await ctx.api.as(c, A).post('/wallet/points/redeem').send({ points: 30 })).status).toBe(200);
        const o = await mkOrder(A, c, 99.99);
        expect((await pay(c, A, { orderId: String(o._id), amount: 99.99 })).status).toBe(200);
        await ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: 7.77, type: 'balance', action: 'deduct' });

        const w = await walletOf(A, c);
        const rows = await ledger(A, c);
        // rupee-affecting rows: wallet_recharge (+), order_payment (signed), points_redeemed with amount>0 (+₹)
        const rupees = rows.filter((r) => r.type === 'wallet_recharge' || r.type === 'order_payment' || r.type === 'admin_adjustment' || (r.type === 'points_redeemed' && r.amount > 0));
        const replay = r2(rupees.reduce((s, r) => s + r.amount, 0));
        expect(replay).toBe(w.balance);
        expect(w.balance).toBe(r2(300 + 12.5 + 3 - 99.99 - 7.77));
        // each rupee row's balanceAfter chains from balanceBefore
        for (const r of rupees) expect(r2(r.balanceBefore + r.amount)).toBe(r.balanceAfter);
        expect(w.loyaltyPoints).toBe(20);
    });

    test('rupee ledger rows chain: each balanceBefore equals the previous balanceAfter', async () => {
        const c = await customerWithBalance('ledger-2', 0);
        for (const a of [10, 20.5, 30.25]) {
            await ctx.api.as(A.users.admin).post('/wallet/admin/adjust').send({ targetUserId: String(c._id), amount: a, type: 'balance', action: 'add' });
        }
        const rows = await ledger(A, c, { type: 'wallet_recharge' });
        expect(rows.map((r) => r.balanceAfter)).toEqual([10, 30.5, 60.75]);
        for (let i = 1; i < rows.length; i++) expect(rows[i].balanceBefore).toBe(rows[i - 1].balanceAfter);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('GET /wallet and role permissions on the customer wallet', () => {
    test('auto-creates an empty wallet on first read, once', async () => {
        const c = await createCustomer('get-new');
        const r1 = await ctx.api.as(c, A).get('/wallet');
        expect(r1.status).toBe(200);
        expect(r1.body).toMatchObject({ balance: 0, loyaltyPoints: 0 });
        await ctx.api.as(c, A).get('/wallet');
        expect(await Wallet.countDocuments({ user: c._id })).toBe(1);
    });

    test('shows only the caller\'s own recent transactions', async () => {
        const c1 = await customerWithBalance('get-1', 10);
        const c2 = await customerWithBalance('get-2', 10);
        await Transaction.create({ user: c1._id, restaurant: A.restaurant._id, type: 'wallet_recharge', amount: 10, paymentMethod: 'wallet', transactionId: `T-${rid()}`, description: 'mine' });
        await Transaction.create({ user: c2._id, restaurant: A.restaurant._id, type: 'wallet_recharge', amount: 10, paymentMethod: 'wallet', transactionId: `T-${rid()}`, description: 'theirs' });
        const res = await ctx.api.as(c1, A).get('/wallet');
        expect(res.body.transactions.map((t) => t.label)).toEqual(['mine']);
    });

    test('admin stats totals equal the sum of wallet balances of the tenant', async () => {
        const t = await seedTenant({ label: 'spw-stats' });
        const c1 = await createCustomer('stat1'); const c2 = await createCustomer('stat2');
        await setWallet(t, c1, { balance: 100.1 });
        await setWallet(t, c2, { balance: 200.2 });
        const res = await ctx.api.as(t.users.admin).get('/wallet/admin/stats');
        expect(res.status).toBe(200);
        expect(r2(res.body.stats.totalWalletBalance)).toBe(300.3);
        expect(res.body.stats.totalCustomers).toBe(2);
    });

    test.each(['waiter', 'chef', 'captain'])('%s cannot read admin wallet endpoints', async (role) => {
        for (const p of ['/wallet/admin/stats', '/wallet/admin/customers?q=ab', '/wallet/admin/manual-history', '/wallet/admin/reports?report=x']) {
            const res = await ctx.api.as(A.users[role], A).get(p);
            expect(res.status).toBe(403);
        }
    });

    test('wallet endpoints are refused for a plan without walletLoyalty', async () => {
        const t = await seedTenant({ label: 'spw-nogate' });
        const Restaurant = req_('models/restaurant');
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.features.walletLoyalty': false } });
        const c = await createCustomer('nogate');
        const res = await ctx.api.as(c, t).get('/wallet');
        expect(res.status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('POST /wallet/points/redeem (points -> balance)', () => {
    const redeem = (c, body) => ctx.api.as(c, A).post('/wallet/points/redeem').send(body);

    test('100 points at the default 0.1 rate → ₹10: points -100, balance +10, one ledger row', async () => {
        const c = await customerWithBalance('rd-ok', 5, 250);
        const res = await redeem(c, { points: 100 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ rupeesAdded: 10, newBalance: 15, newPoints: 150, pointsRedeemed: 100 });
        const [row] = await ledger(A, c, { type: 'points_redeemed' });
        expect(row).toMatchObject({ amount: 10, balanceBefore: 5, balanceAfter: 15, paymentMethod: 'points' });
    });

    test('more than held → 400 and nothing changes', async () => {
        const c = await customerWithBalance('rd-over', 5, 50);
        const res = await redeem(c, { points: 51 });
        expect(res.status).toBe(400);
        const w = await walletOf(A, c);
        expect(w).toMatchObject({ balance: 5, loyaltyPoints: 50 });
    });

    test('exactly all points → points 0, never negative', async () => {
        const c = await customerWithBalance('rd-all', 0, 50);
        const res = await redeem(c, { points: 50 });
        expect(res.status).toBe(200);
        expect((await walletOf(A, c)).loyaltyPoints).toBe(0);
    });

    test.each([['zero', 0], ['negative', -5], ['string', '10'], ['null', null], ['NaN string', 'NaN'], ['object', { $gt: 0 }], ['huge', 1e12], ['missing', undefined]])(
        'points %s → 400', async (_l, points) => {
            const c = await customerWithBalance('rd-bad', 5, 1000);
            const body = {};
            if (points !== undefined) body.points = points;
            const res = await redeem(c, body);
            expect(res.status).toBe(400);
            expect((await walletOf(A, c))).toMatchObject({ balance: 5, loyaltyPoints: 1000 });
        });

    test('customer with no wallet → 404', async () => {
        const c = await createCustomer('rd-none');
        const res = await redeem(c, { points: 10 });
        expect(res.status).toBe(404);
    });

    test('redeeming twice: the second redeem of all points is refused (points redeemed twice)', async () => {
        const c = await customerWithBalance('rd-twice', 0, 100);
        expect((await redeem(c, { points: 100 })).status).toBe(200);
        const second = await redeem(c, { points: 100 });
        expect(second.status).toBe(400);
        expect((await walletOf(A, c))).toMatchObject({ balance: 10, loyaltyPoints: 0 });
    });

    test('3 concurrent redeems of 100 points against 100: exactly one wins, balance +10 once', async () => {
        const c = await customerWithBalance('rd-race', 0, 100);
        const results = await Promise.all([1, 2, 3].map(() => redeem(c, { points: 100 })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await walletOf(A, c))).toMatchObject({ balance: 10, loyaltyPoints: 0 });
        expect(await ledger(A, c, { type: 'points_redeemed' })).toHaveLength(1);
    });

    test('rate change is honoured: pointsToRupee 0.25 → 100 points = ₹25', async () => {
        const t = await seedTenant({ label: 'spw-rate' });
        await Settings.updateOne({ restaurant: t.restaurant._id, branch: null }, { $set: { 'wallet.pointsToRupee': 0.25 } });
        invalidateCache();
        const c = await createCustomer('rd-rate');
        await setWallet(t, c, { balance: 0, loyaltyPoints: 100 });
        const res = await ctx.api.as(c, t).post('/wallet/points/redeem').send({ points: 100 });
        expect(res.status).toBe(200);
        expect(res.body.rupeesAdded).toBe(25);
        expect((await Wallet.findOne({ user: c._id, restaurant: t.restaurant._id }).lean()).balance).toBe(25);
    });

    test('Regression (fixed 2026-11): fractional points are redeemable, so repeated tiny redemptions round UP the rupee value (arbitrage above the nominal rate)', async () => {
        // Expected: whole points only (as resolvePointsRedemption does with Math.floor) or rupee value never above points*rate.
        // Actual: 0.05 points → round(0.005*100)/100 = ₹0.01 credit, i.e. 2x the nominal rate (0.005).
        // controllers/walletController.js:~1218 (`points <= 0` is the only check; routes/walletRoute.js redeemPointsValidation allows any positive number).
        const c = await customerWithBalance('rd-frac', 0, 10);
        const res = await redeem(c, { points: 0.05 });
        const w = await walletOf(A, c);
        const nominal = 0.05 * 0.1;
        expect(res.status === 400 || w.balance <= nominal + 1e-9).toBe(true);
    });

    test('Regression (fixed 2026-11): redeeming sub-paisa points burns the points for ₹0 (0.04 points → 0.004 → ₹0)', async () => {
        // Expected: refuse (400) when the credit rounds to zero, never debit points for nothing.
        const c = await customerWithBalance('rd-zero', 0, 10);
        const res = await redeem(c, { points: 0.04 });
        const w = await walletOf(A, c);
        expect(res.status === 400 || w.balance > 0 || w.loyaltyPoints === 10).toBe(true);
    });

    test('redeem across tenants: points held at tenant B cannot be redeemed at tenant A', async () => {
        const c = await createCustomer('rd-xt');
        await setWallet(B, c, { balance: 0, loyaltyPoints: 500 });
        const res = await redeem(c, { points: 100 });
        expect([400, 404]).toContain(res.status);
        expect((await walletOf(B, c)).loyaltyPoints).toBe(500);
    });

    test('unauthenticated → 401', async () => {
        const res = await ctx.api.guest(A).post('/wallet/points/redeem').send({ points: 10 });
        expect(res.status).toBe(401);
    });
});
