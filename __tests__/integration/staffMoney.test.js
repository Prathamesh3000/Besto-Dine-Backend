/**
 * Staff money: tips → settlement → staff wallet → withdrawal.
 *
 *   controllers/tipController.js      GET /tips/my, /tips/pending, /tips/history, POST /tips/settle
 *   utils/tipHelpers.js               createTipForPaidOrder / revokeTipsForOrder
 *   controllers/staffWalletController GET /staff-wallet/me, POST /staff-wallet/withdraw,
 *                                     GET /staff-wallet/withdrawals, POST .../:id/approve|reject
 *   models/staffWallet, staffWalletTransaction, staffWithdrawal
 *
 * Money is asserted to the paisa (toBe, never toBeCloseTo) and every
 * money-moving endpoint is also fired concurrently (Promise.all).
 *
 * Already covered elsewhere (not repeated here): tip creation on PATCH
 * paid + replay idempotency + negative clamp (orderStatusLifecycle),
 * tip revoke on refund (orderRefund), branch scoping of the settlement
 * history / withdrawals list (tenantIsolationSweep2).
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const { createTipForPaidOrder, revokeTipsForOrder } = req_('utils/tipHelpers');
const Order = req_('models/order');
const Table = req_('models/table');
const Tip = req_('models/tip');
const TipSettlement = req_('models/tipSettlement');
const Branch = req_('models/branch');
const StaffWallet = req_('models/staffWallet');
const StaffWalletTransaction = req_('models/staffWalletTransaction');
const StaffWithdrawal = req_('models/staffWithdrawal');

const ctx = useIntegrationApp();
let A;          // tenant under test
let B;          // other tenant
let second;     // { branch, admin, waiter } pinned to A's second branch

const rid = () => Math.random().toString(16).slice(2, 10);
const staff = (t, role, extra = {}) => createUser({
    name: `${role} ${rid()}`,
    email: `${role}.${rid()}@staffmoney.test`,
    role,
    restaurant: t.restaurant._id,
    branch: t.branch._id,
    permissions: defaultPermissionsForRole(role),
    ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'sm-a' });
    B = await seedTenant({ label: 'sm-b' });
    const branch = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    second = {
        branch,
        admin: await staff(A, 'admin', { branch: branch._id, permissions: {} }),
        waiter: await staff(A, 'waiter', { branch: branch._id }),
    };
});

// ── helpers ──────────────────────────────────────────────────────────────
const walletOf = (t, user) => StaffWallet.findOne({ user: user._id, restaurant: t.restaurant._id }).lean();
const ledgerOf = (t, user) => StaffWalletTransaction.find({ user: user._id, restaurant: t.restaurant._id }).sort({ createdAt: 1, _id: 1 }).lean();

/** Put money in a waiter's staff wallet (as a settled tip would). */
async function fund(t, user, balance) {
    return StaffWallet.findOneAndUpdate(
        { user: user._id, restaurant: t.restaurant._id },
        { $set: { balance, lifetimeCredits: balance, lifetimeDebits: 0, status: 'active' } },
        { upsert: true, returnDocument: 'after' },
    );
}

async function tip(t, waiter, amount, status = 'pending') {
    return Tip.create({
        restaurant: t.restaurant._id,
        waiter: waiter._id,
        order: new mongoose.Types.ObjectId(),
        amount,
        status,
    });
}

const withdraw = (user, body) => ctx.api.as(user).post('/staff-wallet/withdraw').send(body);
const approve = (admin, id, body = {}) => ctx.api.as(admin).post(`/staff-wallet/withdrawals/${id}/approve`).send(body);
const reject = (admin, id, body = {}) => ctx.api.as(admin).post(`/staff-wallet/withdrawals/${id}/reject`).send(body);
const settleTips = (admin, body) => ctx.api.as(admin).post('/tips/settle').send(body);

/** Ledger replay must equal the stored balance, and each row's balanceAfter must chain. */
async function expectLedgerConsistent(t, user) {
    const w = await walletOf(t, user);
    const rows = await ledgerOf(t, user);
    const replay = rows.reduce((s, r) => Math.round((s + (r.direction === 'credit' ? r.amount : -r.amount)) * 100) / 100, 0);
    return { balance: w.balance, replay, rows };
}

// ═════════════════════════════════════════════════════════════════════════
describe('staff wallet: GET /staff-wallet/me', () => {
    test('a waiter gets an auto-created empty wallet; the second call reuses it', async () => {
        const waiter = await staff(A, 'waiter');
        const r1 = await ctx.api.as(waiter).get('/staff-wallet/me');
        expect(r1.status).toBe(200);
        expect(r1.body.wallet).toMatchObject({ balance: 0, lifetimeCredits: 0, lifetimeDebits: 0, status: 'active', pendingWithdrawalAmount: 0 });
        const r2 = await ctx.api.as(waiter).get('/staff-wallet/me');
        expect(String(r2.body.wallet._id)).toBe(String(r1.body.wallet._id));
        expect(await StaffWallet.countDocuments({ user: waiter._id })).toBe(1);
    });

    test.each(['chef', 'admin', 'customer'])('%s cannot open or create a staff wallet', async (role) => {
        const user = role === 'customer' ? await createCustomer('sm-me')
            : role === 'admin' ? A.users.admin : await staff(A, role);
        const res = await ctx.api.as(user, A).get('/staff-wallet/me');
        expect([400, 403]).toContain(res.status);   // customer: tenant/role refusal
        const res2 = await withdraw(user, { amount: 10, method: 'Cash' });
        expect([400, 403]).toContain(res2.status);
        expect(await StaffWallet.countDocuments({ user: user._id })).toBe(0);
    });

    test('a waiter only sees their own ledger and withdrawals; pending amount is summed exactly', async () => {
        const w1 = await staff(A, 'waiter');
        const w2 = await staff(A, 'waiter');
        await fund(A, w1, 100);
        await fund(A, w2, 100);
        expect((await withdraw(w1, { amount: 12.34, method: 'Cash' })).status).toBe(201);
        expect((await withdraw(w1, { amount: 0.66 + 1, method: 'Cash' })).status).toBe(201);
        expect((await withdraw(w2, { amount: 50, method: 'Cash' })).status).toBe(201);

        const me = await ctx.api.as(w1).get('/staff-wallet/me');
        expect(me.status).toBe(200);
        expect(me.body.wallet.balance).toBe(86);
        expect(me.body.wallet.pendingWithdrawalAmount).toBe(14);
        expect(me.body.withdrawals).toHaveLength(2);
        expect(me.body.withdrawals.every((w) => String(w.user) === String(w1._id))).toBe(true);
        expect(me.body.transactions.every((tx) => String(tx.user) === String(w1._id))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('staff wallet: POST /staff-wallet/withdraw', () => {
    const invalid = [
        ['zero amount', { amount: 0, method: 'Cash' }],
        ['negative amount', { amount: -50, method: 'Cash' }],
        ['non-numeric amount', { amount: 'abc', method: 'Cash' }],
        ['missing amount', { method: 'Cash' }],
        ['Infinity-like amount', { amount: '1e400', method: 'Cash' }],
        ['unknown method', { amount: 10, method: 'Crypto' }],
        ['lower-case method', { amount: 10, method: 'cash' }],
        ['UPI without id', { amount: 10, method: 'UPI' }],
        ['UPI malformed id', { amount: 10, method: 'UPI', upiId: 'not-a-upi' }],
        ['UPI id as object', { amount: 10, method: 'UPI', upiId: { $gt: '' } }],
        ['Bank without IFSC', { amount: 10, method: 'Bank', accountHolder: 'X', accountNumber: '1234' }],
        ['Bank without holder', { amount: 10, method: 'Bank', ifsc: 'HDFC0001', accountNumber: '1234' }],
    ];
    test.each(invalid)('%s → 400 and the balance is untouched', async (_label, body) => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 100);
        const res = await withdraw(waiter, body);
        expect(res.status).toBe(400);
        expect((await walletOf(A, waiter)).balance).toBe(100);
        expect(await StaffWithdrawal.countDocuments({ user: waiter._id })).toBe(0);
        expect(await StaffWalletTransaction.countDocuments({ user: waiter._id })).toBe(0);
    });

    test('more than the balance is refused; exactly the balance empties the wallet with an exact ledger row', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 123.45);
        const over = await withdraw(waiter, { amount: 123.46, method: 'Cash' });
        expect(over.status).toBe(400);
        expect(over.body.message).toMatch(/Insufficient balance/);

        const res = await withdraw(waiter, { amount: 123.45, method: 'UPI', upiId: ' waiter.one@okaxis ' });
        expect(res.status).toBe(201);
        expect(res.body.wallet.balance).toBe(0);
        expect(res.body.withdrawal).toMatchObject({ amount: 123.45, method: 'UPI', upiId: 'waiter.one@okaxis', status: 'pending' });

        const w = await walletOf(A, waiter);
        expect(w.balance).toBe(0);
        expect(w.lifetimeDebits).toBe(123.45);
        expect(w.lifetimeCredits).toBe(123.45);
        const rows = await ledgerOf(A, waiter);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'withdrawal-debit', direction: 'debit', amount: 123.45, balanceAfter: 0, referenceKind: 'StaffWithdrawal' });
        expect(String(rows[0].referenceId)).toBe(String(res.body.withdrawal._id));
    });

    test('amounts are rounded to the paisa before the debit', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 10);
        const res = await withdraw(waiter, { amount: 3.333333, method: 'Cash' });
        expect(res.status).toBe(201);
        expect(res.body.withdrawal.amount).toBe(3.33);
        expect((await walletOf(A, waiter)).balance).toBe(6.67);
    });

    test('Bank details are trimmed and IFSC upper-cased; payout fields of other methods are dropped', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 500);
        const res = await withdraw(waiter, {
            amount: 200, method: 'Bank', accountHolder: ' Ravi K ', accountNumber: ' 001122 ', ifsc: ' hdfc0000123 ',
            bankName: ' HDFC ', upiId: 'ignored@upi', note: 'x'.repeat(400),
        });
        expect(res.status).toBe(201);
        const saved = await StaffWithdrawal.findById(res.body.withdrawal._id).lean();
        expect(saved).toMatchObject({ accountHolder: 'Ravi K', accountNumber: '001122', ifsc: 'HDFC0000123', bankName: 'HDFC' });
        expect(saved.upiId).toBeUndefined();
        expect(saved.note).toHaveLength(300);
    });

    test('a frozen wallet cannot withdraw', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 100);
        await StaffWallet.updateOne({ user: waiter._id }, { $set: { status: 'frozen' } });
        const res = await withdraw(waiter, { amount: 10, method: 'Cash' });
        expect(res.status).toBe(403);
        expect((await walletOf(A, waiter)).balance).toBe(100);
    });

    test('a waiter with no wallet yet gets one created and an insufficient-balance 400', async () => {
        const waiter = await staff(A, 'waiter');
        const res = await withdraw(waiter, { amount: 1, method: 'Cash' });
        expect(res.status).toBe(400);
        // The wallet created inside the aborted transaction is rolled back.
        expect(await StaffWallet.countDocuments({ user: waiter._id })).toBe(0);
    });

    // Regression (fixed 2026-10): requestWithdrawal refuses amounts below the model's ₹1 minimum with a 400 before any write.
    test('a sub-rupee withdrawal (₹0.50) is a 400, not a 500', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 10);
        const res = await withdraw(waiter, { amount: 0.5, method: 'Cash' });
        expect((await walletOf(A, waiter)).balance).toBe(10);
        expect(res.status).toBe(400);
    });

    test('concurrent withdrawals can never overspend: Σ accepted = balance drop, ledger replays exactly', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 1000);
        const results = await Promise.all(Array.from({ length: 6 }, () => withdraw(waiter, { amount: 300, method: 'Cash' })));
        const ok = results.filter((r) => r.status === 201);
        expect(ok.length).toBeGreaterThanOrEqual(1);
        expect(ok.length).toBeLessThanOrEqual(3);
        results.filter((r) => r.status !== 201).forEach((r) => expect([400, 500]).toContain(r.status));

        const w = await walletOf(A, waiter);
        expect(w.balance).toBe(1000 - 300 * ok.length);
        expect(w.lifetimeDebits).toBe(300 * ok.length);
        expect(await StaffWithdrawal.countDocuments({ user: waiter._id, status: 'pending' })).toBe(ok.length);
        const { rows } = await expectLedgerConsistent(A, waiter);
        expect(rows).toHaveLength(ok.length);
        expect(rows.map((r) => r.balanceAfter).sort((a, b) => b - a)).toEqual(
            Array.from({ length: ok.length }, (_, i) => 1000 - 300 * (i + 1)),
        );
    });

    test('two concurrent full-balance withdrawals: exactly one wins', async () => {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, 600);
        const results = await Promise.all([
            withdraw(waiter, { amount: 600, method: 'Cash' }),
            withdraw(waiter, { amount: 600, method: 'Cash' }),
        ]);
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect((await walletOf(A, waiter)).balance).toBe(0);
        expect(await StaffWithdrawal.countDocuments({ user: waiter._id })).toBe(1);
    });

    test('first-ever concurrent withdraw calls (wallet created in-flight) never create two wallets', async () => {
        const waiter = await staff(A, 'waiter');
        const results = await Promise.all([
            withdraw(waiter, { amount: 5, method: 'Cash' }),
            withdraw(waiter, { amount: 5, method: 'Cash' }),
            ctx.api.as(waiter).get('/staff-wallet/me'),
        ]);
        results.forEach((r) => expect(r.status).not.toBe(201));
        expect(await StaffWallet.countDocuments({ user: waiter._id })).toBeLessThanOrEqual(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('staff wallet: admin approve / reject', () => {
    async function pending(amount = 400, balance = 1000) {
        const waiter = await staff(A, 'waiter');
        await fund(A, waiter, balance);
        const res = await withdraw(waiter, { amount, method: 'Cash' });
        expect(res.status).toBe(201);
        return { waiter, id: res.body.withdrawal._id };
    }

    test('admin list shows the request and the pending badge count', async () => {
        const { id } = await pending(10, 10);
        const res = await ctx.api.as(A.users.admin).get('/staff-wallet/withdrawals?status=pending');
        expect(res.status).toBe(200);
        expect(res.body.withdrawals.map((w) => String(w._id))).toContain(String(id));
        expect(res.body.withdrawals.every((w) => w.status === 'pending')).toBe(true);
        expect(res.body.pendingCount).toBe(await StaffWithdrawal.countDocuments({ restaurant: A.restaurant._id, status: 'pending' }));
    });

    test('approve marks paid with txnRef + handler, leaves the balance alone, and is not repeatable', async () => {
        const { waiter, id } = await pending(400, 1000);
        const res = await approve(A.users.admin, id, { txnRef: `  UTR-${'9'.repeat(120)}  ` });
        expect(res.status).toBe(200);
        const w = await StaffWithdrawal.findById(id).lean();
        expect(w.status).toBe('paid');
        expect(w.txnRef).toBe(`UTR-${'9'.repeat(96)}`);
        expect(String(w.handledBy)).toBe(String(A.users.admin._id));
        expect(w.handledAt).toBeTruthy();
        expect((await walletOf(A, waiter)).balance).toBe(600);

        expect((await approve(A.users.admin, id)).status).toBe(409);
        const rej = await reject(A.users.admin, id, { reason: 'late' });
        expect(rej.status).toBe(409);
        expect((await walletOf(A, waiter)).balance).toBe(600);
        expect(await StaffWalletTransaction.countDocuments({ user: waiter._id, type: 'withdrawal-refund' })).toBe(0);
    });

    test('reject re-credits exactly once with a refund ledger row; a second reject / approve is a 409', async () => {
        const { waiter, id } = await pending(333.33, 1000);
        expect((await walletOf(A, waiter)).balance).toBe(666.67);
        const res = await reject(A.users.admin, id, { reason: '  wrong UPI  ' });
        expect(res.status).toBe(200);
        expect(res.body.wallet.balance).toBe(1000);
        const w = await walletOf(A, waiter);
        expect(w.balance).toBe(1000);
        expect(w.lifetimeDebits).toBe(0);
        const saved = await StaffWithdrawal.findById(id).lean();
        expect(saved).toMatchObject({ status: 'rejected', rejectReason: 'wrong UPI' });

        expect((await reject(A.users.admin, id)).status).toBe(409);
        expect((await approve(A.users.admin, id)).status).toBe(409);
        expect((await walletOf(A, waiter)).balance).toBe(1000);
        const { balance, replay, rows } = await expectLedgerConsistent(A, waiter);
        expect(rows.map((r) => [r.type, r.amount, r.balanceAfter])).toEqual([
            ['withdrawal-debit', 333.33, 666.67],
            ['withdrawal-refund', 333.33, 1000],
        ]);
        expect(replay).toBe(0);           // fund() wrote no ledger row; debit + refund cancel out
        expect(balance).toBe(1000);
    });

    test('reject without a reason stores the default reason', async () => {
        const { id } = await pending(10, 10);
        expect((await reject(A.users.admin, id)).status).toBe(200);
        expect((await StaffWithdrawal.findById(id).lean()).rejectReason).toBe('No reason provided');
    });

    test.each([
        ['approve', approve],
        ['reject', reject],
    ])('%s: malformed id 400, unknown id 404, other tenant 404, non-admin 403', async (_n, fn) => {
        const { waiter, id } = await pending(50, 100);
        expect((await fn(A.users.admin, 'not-an-id')).status).toBe(400);
        expect((await fn(A.users.admin, new mongoose.Types.ObjectId())).status).toBe(404);
        expect((await fn(B.users.admin, id)).status).toBe(404);
        expect((await fn(waiter, id)).status).toBe(403);
        expect((await fn(A.users.captain, id)).status).toBe(403);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
        expect((await walletOf(A, waiter)).balance).toBe(50);
    });

    test('concurrent double reject re-credits the wallet exactly once', async () => {
        const { waiter, id } = await pending(400, 1000);
        const results = await Promise.all([reject(A.users.admin, id), reject(A.users.admin, id), reject(A.users.admin, id)]);
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await walletOf(A, waiter)).balance).toBe(1000);
        expect(await StaffWalletTransaction.countDocuments({ user: waiter._id, type: 'withdrawal-refund' })).toBe(1);
    });

    // Regression (fixed 2026-10): approveWithdrawal is an atomic findOneAndUpdate pending→paid; the loser gets 409.
    test('concurrent double approve — exactly one request succeeds', async () => {
        const { waiter, id } = await pending(100, 100);
        const results = await Promise.all([
            approve(A.users.admin, id, { txnRef: 'UTR-1' }),
            approve(A.users.admin, id, { txnRef: 'UTR-2' }),
        ]);
        expect((await walletOf(A, waiter)).balance).toBe(0);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    // Regression (fixed 2026-10): approve and reject both claim the row atomically from status pending (reject inside its refund transaction).
    test('concurrent approve + reject: exactly one wins and the row agrees with the money', async () => {
        const outcomes = [];
        for (let i = 0; i < 40; i += 1) {
            const { waiter, id } = await pending(400, 1000);
            const [a, r] = await Promise.all([
                approve(A.users.admin, id),
                reject(A.users.admin, id),
            ]);
            const w = await StaffWithdrawal.findById(id).lean();
            const bal = (await walletOf(A, waiter)).balance;
            outcomes.push({ approve: a.status, reject: r.status, status: w.status, balance: bal });
        }
        // Invariant: exactly one of the two may win, and the final row
        // must agree with the money: paid ⇒ 600 left, rejected ⇒ 1000.
        const broken = outcomes.filter((o) => [o.approve, o.reject].filter((s) => s === 200).length !== 1
            || o.balance !== (o.status === 'paid' ? 600 : 1000));
        expect(broken).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('tips: settlement (POST /tips/settle)', () => {
    test('settles only that waiter’s pending tips of this tenant, sums exactly, credits the wallet atomically', async () => {
        const waiter = await staff(A, 'waiter');
        const other = await staff(A, 'waiter');
        const t1 = await tip(A, waiter, 49.99);
        const t2 = await tip(A, waiter, 10.01);
        const t3 = await tip(A, waiter, 25.5);
        const alreadySettled = await tip(A, waiter, 70, 'settled');
        const refunded = await tip(A, waiter, 30, 'refunded');
        const othersTip = await tip(A, other, 15);
        const foreign = await Tip.create({ restaurant: B.restaurant._id, waiter: waiter._id, order: new mongoose.Types.ObjectId(), amount: 999, status: 'pending' });

        const res = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash', note: 'Friday' });
        expect(res.status).toBe(200);
        expect(res.body.settlement.amount).toBe(85.5);
        expect(res.body.settlement.tipsSettledCount).toBe(3);
        const sid = res.body.settlement._id;

        for (const t of [t1, t2, t3]) {
            const saved = await Tip.findById(t._id).lean();
            expect(saved.status).toBe('settled');
            expect(String(saved.settlement)).toBe(String(sid));
        }
        expect((await Tip.findById(alreadySettled._id).lean()).settlement).toBeUndefined();
        expect((await Tip.findById(refunded._id).lean()).status).toBe('refunded');
        expect((await Tip.findById(othersTip._id).lean()).status).toBe('pending');
        expect((await Tip.findById(foreign._id).lean()).status).toBe('pending');

        const w = await walletOf(A, waiter);
        expect(w.balance).toBe(85.5);
        expect(w.lifetimeCredits).toBe(85.5);
        const rows = await ledgerOf(A, waiter);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'tip-credit', direction: 'credit', amount: 85.5, balanceAfter: 85.5, referenceKind: 'TipSettlement' });
        expect(String(rows[0].referenceId)).toBe(String(sid));
        const record = await TipSettlement.findById(sid).lean();
        expect(record).toMatchObject({ amount: 85.5, tipsSettledCount: 3, paymentMethod: 'Cash', note: 'Friday' });
        expect(String(record.settledBy)).toBe(String(A.users.admin._id));
        expect(String(record.restaurant)).toBe(String(A.restaurant._id));

        // Nothing left → 400, no second credit.
        const again = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(again.status).toBe(400);
        expect((await walletOf(A, waiter)).balance).toBe(85.5);
        expect(await TipSettlement.countDocuments({ waiter: waiter._id })).toBe(1);
    });

    test('a second settlement credits on top of the existing balance with a chained ledger', async () => {
        const waiter = await staff(A, 'waiter');
        await tip(A, waiter, 20);
        expect((await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Online' })).status).toBe(200);
        expect((await withdraw(waiter, { amount: 5.25, method: 'Cash' })).status).toBe(201);
        await tip(A, waiter, 0.75);
        expect((await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' })).status).toBe(200);
        const w = await walletOf(A, waiter);
        expect(w.balance).toBe(15.5);
        expect(w.lifetimeCredits).toBe(20.75);
        expect(w.lifetimeDebits).toBe(5.25);
        const rows = await ledgerOf(A, waiter);
        expect(rows.map((r) => [r.type, r.amount, r.balanceAfter])).toEqual([
            ['tip-credit', 20, 20],
            ['withdrawal-debit', 5.25, 14.75],
            ['tip-credit', 0.75, 15.5],
        ]);
    });

    const invalid = [
        ['missing waiterId', { paymentMethod: 'Cash' }, 400],
        ['missing paymentMethod', { waiterId: 'W' }, 400],
        ['paymentMethod UPI (not allowed)', { waiterId: 'W', paymentMethod: 'UPI' }, 400],
        ['paymentMethod lower-case', { waiterId: 'W', paymentMethod: 'cash' }, 400],
    ];
    test.each(invalid)('%s → %i, nothing settled', async (_label, body, status) => {
        const waiter = await staff(A, 'waiter');
        const t = await tip(A, waiter, 40);
        const payload = { ...body };
        if (payload.waiterId === 'W') payload.waiterId = String(waiter._id);
        const res = await settleTips(A.users.admin, payload);
        expect(res.status).toBe(status);
        expect((await Tip.findById(t._id).lean()).status).toBe('pending');
        expect(await StaffWallet.countDocuments({ user: waiter._id })).toBe(0);
    });

    // Regression (fixed 2026-10): settleTips validates waiterId as an ObjectId before touching the transaction.
    test('a malformed waiterId is a 400, not a 500', async () => {
        const res = await settleTips(A.users.admin, { waiterId: 'not-an-id', paymentMethod: 'Cash' });
        expect(res.status).toBe(400);
    });

    test('unknown waiter / waiter with no tips → 400; waiter of another tenant gets nothing', async () => {
        const res = await settleTips(A.users.admin, { waiterId: String(new mongoose.Types.ObjectId()), paymentMethod: 'Cash' });
        expect(res.status).toBe(400);
        const foreignWaiter = await staff(B, 'waiter');
        const bt = await tip(B, foreignWaiter, 55);
        const cross = await settleTips(A.users.admin, { waiterId: String(foreignWaiter._id), paymentMethod: 'Cash' });
        expect(cross.status).toBe(400);
        expect((await Tip.findById(bt._id).lean()).status).toBe('pending');
        expect(await StaffWallet.countDocuments({ user: foreignWaiter._id })).toBe(0);
    });

    test.each(['waiter', 'captain', 'chef', 'customer'])('%s cannot settle tips', async (role) => {
        const waiter = await staff(A, 'waiter');
        const t = await tip(A, waiter, 40);
        const caller = role === 'customer' ? await createCustomer('sm-settle') : role === 'waiter' ? waiter : A.users[role];
        const res = await ctx.api.as(caller, A).post('/tips/settle').send({ waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(res.status).toBe(403);
        expect((await Tip.findById(t._id).lean()).status).toBe('pending');
    });

    test('branch-pinned admin: sees and settles only own-branch waiters', async () => {
        const mainWaiter = await staff(A, 'waiter');
        await tip(A, mainWaiter, 11);
        await tip(A, second.waiter, 22);

        const pend = await ctx.api.as(second.admin).get('/tips/pending');
        expect(pend.status).toBe(200);
        const ids = pend.body.waiters.map((w) => String(w._id));
        expect(ids).toContain(String(second.waiter._id));
        expect(ids).not.toContain(String(mainWaiter._id));

        const cross = await settleTips(second.admin, { waiterId: String(mainWaiter._id), paymentMethod: 'Cash' });
        expect(cross.status).toBe(403);
        expect(await Tip.countDocuments({ waiter: mainWaiter._id, status: 'pending' })).toBe(1);

        const own = await settleTips(second.admin, { waiterId: String(second.waiter._id), paymentMethod: 'Cash' });
        expect(own.status).toBe(200);
        expect(own.body.settlement.amount).toBe(22);
    });

    test('GET /tips/pending groups per waiter with exact sums and only pending tips', async () => {
        const waiter = await staff(A, 'waiter');
        await tip(A, waiter, 12.34);
        await tip(A, waiter, 7.66);
        await tip(A, waiter, 100, 'refunded');
        await tip(A, waiter, 100, 'settled');
        const res = await ctx.api.as(A.users.admin).get('/tips/pending');
        expect(res.status).toBe(200);
        const row = res.body.waiters.find((w) => String(w._id) === String(waiter._id));
        expect(row).toMatchObject({ pendingCount: 2, pendingAmount: 20, settleAmount: 20 });
        expect(row.pendingTips).toHaveLength(2);
        const other = await ctx.api.as(B.users.admin).get('/tips/pending');
        expect(other.body.waiters.map((w) => String(w._id))).not.toContain(String(waiter._id));
    });

    // Regression (fixed 2026-10): settleTips rounds the sum and creditWallet rounds the ledger amount to the paisa.
    test('settlement amount and ledger row are rounded to the paisa (0.1 + 0.2)', async () => {
        const waiter = await staff(A, 'waiter');
        await tip(A, waiter, 0.1);
        await tip(A, waiter, 0.2);
        const res = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(res.status).toBe(200);
        expect((await walletOf(A, waiter)).balance).toBe(0.3);
        const [row] = await ledgerOf(A, waiter);
        const record = await TipSettlement.findById(res.body.settlement._id).lean();
        expect({ settlement: record.amount, ledger: row.amount }).toEqual({ settlement: 0.3, ledger: 0.3 });
    });

    test('concurrent settles of the same waiter credit the wallet exactly once', async () => {
        const waiter = await staff(A, 'waiter');
        await tip(A, waiter, 40);
        await tip(A, waiter, 60.25);
        const results = await Promise.all([1, 2, 3].map(() => settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        results.filter((r) => r.status !== 200).forEach((r) => expect([400, 500]).toContain(r.status));
        expect((await walletOf(A, waiter)).balance).toBe(100.25);
        expect(await TipSettlement.countDocuments({ waiter: waiter._id })).toBe(1);
        expect(await StaffWalletTransaction.countDocuments({ user: waiter._id, type: 'tip-credit' })).toBe(1);
        expect(await Tip.countDocuments({ waiter: waiter._id, status: 'settled' })).toBe(2);
    });

    test('a tip revoked while pending drops out; a settled tip is left alone by a later revoke', async () => {
        const waiter = await staff(A, 'waiter');
        const a = await tip(A, waiter, 30);
        const b = await tip(A, waiter, 45);
        expect((await revokeTipsForOrder(a.order)).updated).toBe(1);
        const res = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(res.body.settlement.amount).toBe(45);
        expect((await revokeTipsForOrder(b.order)).updated).toBe(0);
        expect((await Tip.findById(b._id).lean()).status).toBe('settled');
        expect((await walletOf(A, waiter)).balance).toBe(45);
    });

    test('settlement history lists this tenant’s settlements only', async () => {
        const waiter = await staff(A, 'waiter');
        await tip(A, waiter, 5);
        const s = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        const hist = await ctx.api.as(A.users.admin).get('/tips/history');
        expect(hist.status).toBe(200);
        expect(hist.body.history.map((h) => String(h._id))).toContain(String(s.body.settlement._id));
        const histB = await ctx.api.as(B.users.admin).get('/tips/history');
        expect(histB.body.history.map((h) => String(h._id))).not.toContain(String(s.body.settlement._id));
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('tips: GET /tips/my', () => {
    test('a waiter sees only their own tips; refunded tips are listed but excluded from totals', async () => {
        const waiter = await staff(A, 'waiter');
        const other = await staff(A, 'waiter');
        await tip(A, waiter, 10.5);
        await tip(A, waiter, 4.5, 'settled');
        await tip(A, waiter, 99, 'refunded');
        await tip(A, other, 1000);
        const res = await ctx.api.as(waiter).get('/tips/my');
        expect(res.status).toBe(200);
        expect(res.body.tips).toHaveLength(3);
        expect(res.body.stats).toMatchObject({
            pendingTotal: 10.5, pendingCount: 1, settledTotal: 4.5, settledCount: 1, totalEarned: 15, totalCount: 2,
            todayTotal: 15, todayCount: 2,
        });
        expect(res.body.tips.map((t) => t.status).sort()).toEqual(['Pending', 'Refunded', 'Settled']);
    });

    test('a waiter of another tenant sees none of these tips', async () => {
        const res = await ctx.api.as(B.users.waiter).get('/tips/my');
        expect(res.status).toBe(200);
        expect(res.body.tips).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('tips: creation from a paid order (end to end into the wallet)', () => {
    async function customerOrderWithWaiter(waiter) {
        const table = await createTable(A, { capacity: 4 });
        if (waiter) await Table.updateOne({ _id: table._id }, { $set: { assignedWaiter: waiter._id } });
        const cust = await createCustomer('sm-tip');
        const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const res = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }], total: 250,
        });
        expect(res.status).toBe(201);
        return res.body.order;
    }
    const pay = (id, body) => ctx.api.as(A.users.admin).patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash', ...body });

    test('paid order tip → pending Tip for the assigned waiter → settle → withdraw → approve', async () => {
        const waiter = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(waiter);
        expect((await pay(order._id, { tipAmount: 37.75 })).status).toBe(200);
        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0]).toMatchObject({ amount: 37.75, status: 'pending' });
        expect(String(tips[0].waiter)).toBe(String(waiter._id));

        const s = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(s.status).toBe(200);
        expect(s.body.settlement.amount).toBe(37.75);
        const wd = await withdraw(waiter, { amount: 37.75, method: 'Cash' });
        expect(wd.status).toBe(201);
        expect((await approve(A.users.admin, wd.body.withdrawal._id, { txnRef: 'CASH-1' })).status).toBe(200);
        const w = await walletOf(A, waiter);
        expect(w).toMatchObject({ balance: 0, lifetimeCredits: 37.75, lifetimeDebits: 37.75 });
    });

    test('an order with no waiter creates no Tip on payment; the waiter who picks it up gets it', async () => {
        const order = await customerOrderWithWaiter(null);
        await Order.updateOne({ _id: order._id }, { $set: { waiter: null } });
        expect((await pay(order._id, { tipAmount: 20, status: undefined })).status).toBe(200);
        expect(await Tip.countDocuments({ order: order._id })).toBe(0);

        // Direct helper: re-running with the waiter stamped creates exactly one.
        const waiter = await staff(A, 'waiter');
        const doc = await Order.findById(order._id);
        doc.waiter = waiter._id;
        await createTipForPaidOrder(doc, A.restaurant._id);
        await createTipForPaidOrder(doc, A.restaurant._id);
        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0].amount).toBe(20);
    });

    test.each([
        ['negative', -10, 0],
        ['non-numeric string', 'abc', 0],
        ['numeric string', '15.5', 15.5],
    ])('tipAmount %s → stored %p', async (_l, value, expected) => {
        const waiter = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(waiter);
        expect((await pay(order._id, { tipAmount: value })).status).toBe(200);
        expect((await Order.findById(order._id).lean()).tipAmount).toBe(expected);
        expect(await Tip.countDocuments({ order: order._id })).toBe(expected > 0 ? 1 : 0);
    });

    test('a refunded tip is revived (pending, re-synced amount) when the order is paid again', async () => {
        const waiter = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(waiter);
        await pay(order._id, { tipAmount: 30 });
        expect((await revokeTipsForOrder(order._id)).updated).toBe(1);
        const doc = await Order.findById(order._id);
        doc.tipAmount = 35.5;
        await createTipForPaidOrder(doc, A.restaurant._id);
        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0]).toMatchObject({ status: 'pending', amount: 35.5 });
    });

    test('a re-attributed pending tip follows the order’s new waiter; a settled one does not', async () => {
        const w1 = await staff(A, 'waiter');
        const w2 = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(w1);
        await pay(order._id, { tipAmount: 12 });
        const doc = await Order.findById(order._id);
        doc.waiter = w2._id;
        await createTipForPaidOrder(doc, A.restaurant._id);
        expect(String((await Tip.findOne({ order: order._id }).lean()).waiter)).toBe(String(w2._id));
        await settleTips(A.users.admin, { waiterId: String(w2._id), paymentMethod: 'Cash' });
        doc.waiter = w1._id;
        await createTipForPaidOrder(doc, A.restaurant._id);
        expect(String((await Tip.findOne({ order: order._id }).lean()).waiter)).toBe(String(w2._id));
    });

    // Regression (fixed 2026-10): unique { order, restaurant } index on Tip; losers of the insert race fall back to the winner's row on E11000.
    test('concurrent createTipForPaidOrder calls create exactly one Tip', async () => {
        const waiter = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(waiter);
        await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'Paid', tipAmount: 25 } });
        const doc = await Order.findById(order._id);
        await Promise.all(Array.from({ length: 5 }, () => createTipForPaidOrder(doc, A.restaurant._id)));
        expect(await Tip.countDocuments({ order: order._id })).toBe(1);
    });

    // Regression (fixed 2026-10): same unique Tip index makes the pickup → createTipForPaidOrder path idempotent.
    test('two concurrent pickups of a paid order settle the waiter tip once', async () => {
        const waiter = await staff(A, 'waiter');
        const order = await customerOrderWithWaiter(waiter);
        await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'Paid', tipAmount: 50, status: 'ready' } });
        const results = await Promise.all([
            ctx.api.as(waiter).patch(`/orders/${order._id}/pickup`).send({}),
            ctx.api.as(waiter).patch(`/orders/${order._id}/pickup`).send({}),
            ctx.api.as(waiter).patch(`/orders/${order._id}/pickup`).send({}),
        ]);
        results.forEach((r) => expect(r.status).toBe(200));
        const s = await settleTips(A.users.admin, { waiterId: String(waiter._id), paymentMethod: 'Cash' });
        expect(s.status).toBe(200);
        expect({ tips: await Tip.countDocuments({ order: order._id }), credited: (await walletOf(A, waiter)).balance })
            .toEqual({ tips: 1, credited: 50 });
    });
});
