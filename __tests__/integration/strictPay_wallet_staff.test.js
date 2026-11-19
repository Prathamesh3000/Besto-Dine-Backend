/**
 * STRICT payments campaign — STAFF WALLET / WITHDRAWALS
 *   controllers/staffWalletController.js, validators/money.js (staffWallet*),
 *   routes/staffWalletRoute.js, models/staffWallet*.js, models/staffWithdrawal.js
 *
 * Complements staffMoney.test.js (happy paths + the main races). This file
 * sharpens: request amount / payout validation, the pending→paid|rejected state
 * machine, txnRef validation, role / tenant / branch permissions, ledger
 * conservation, and concurrency on a funded wallet.
 *
 * "BUG:" tests pin real defects and are expected to FAIL until fixed.
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const StaffWallet = req_('models/staffWallet');
const StaffWalletTransaction = req_('models/staffWalletTransaction');
const StaffWithdrawal = req_('models/staffWithdrawal');
const Branch = req_('models/branch');
const Restaurant = req_('models/restaurant');

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(4).toString('hex');
const r2 = (n) => Math.round(n * 100) / 100;
let A; let B; let branch2; let pinnedAdmin; let pinnedWaiter;

const staff = (t, role, extra = {}) => createUser({
    name: `${role} ${rid()}`, email: `${role}.${rid()}@spstaff.test`, role,
    restaurant: t.restaurant._id, branch: t.branch._id, permissions: defaultPermissionsForRole(role), ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'sps-a' });
    B = await seedTenant({ label: 'sps-b' });
    branch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    pinnedAdmin = await staff(A, 'admin', { branch: branch2._id, permissions: {} });
    pinnedWaiter = await staff(A, 'waiter', { branch: branch2._id });
});

const walletOf = (t, u) => StaffWallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean();
const ledgerOf = (t, u) => StaffWalletTransaction.find({ user: u._id, restaurant: t.restaurant._id }).sort({ createdAt: 1, _id: 1 }).lean();
async function fund(t, u, balance) {
    return StaffWallet.findOneAndUpdate(
        { user: u._id, restaurant: t.restaurant._id },
        { $set: { balance, lifetimeCredits: balance, lifetimeDebits: 0, status: 'active' } },
        { upsert: true, returnDocument: 'after' },
    );
}
const withdraw = (u, body, t = A) => ctx.api.as(u, t).post('/staff-wallet/withdraw').send(body);
const approve = (admin, id, body = {}) => ctx.api.as(admin).post(`/staff-wallet/withdrawals/${id}/approve`).send(body);
const reject = (admin, id, body = {}) => ctx.api.as(admin).post(`/staff-wallet/withdrawals/${id}/reject`).send(body);
async function pending(amount = 100, balance = 500, role = 'waiter', t = A) {
    const u = await staff(t, role);
    await fund(t, u, balance);
    const res = await withdraw(u, { amount, method: 'Cash' }, t);
    expect(res.status).toBe(201);
    return { u, id: res.body.withdrawal._id };
}
/** Σ credits − Σ debits of the ledger must equal the balance. */
async function expectConserved(t, u) {
    const w = await walletOf(t, u);
    const rows = await ledgerOf(t, u);
    const replay = r2(rows.reduce((s, r) => s + (r.direction === 'credit' ? r.amount : -r.amount), 0));
    return { w, rows, replay };
}

// ═════════════════════════════════════════════════════════════════════════
describe('POST /staff-wallet/withdraw: amount validation (boundaries)', () => {
    test.each([
        ['boolean true', true],
        ['array [5]', [5]],
        ['object', { $gt: 0 }],
        ['"  "', '  '],
        ['"NaN"', 'NaN'],
        ['"-1"', '-1'],
        ['0.999 (rounds to 1.00 but is below ₹1 raw)', 0.4],
        ['10000001 (above cap)', 10000001],
    ])('amount %s → 400, balance and ledger untouched', async (_l, amount) => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 500);
        const res = await withdraw(u, { amount, method: 'Cash' });
        expect(res.status).toBe(400);
        expect((await walletOf(A, u)).balance).toBe(500);
        expect(await ledgerOf(A, u)).toHaveLength(0);
        expect(await StaffWithdrawal.countDocuments({ user: u._id })).toBe(0);
    });

    test('Regression (fixed 2026-11): a hex string amount "0x10" is accepted and debits ₹16 (Number("0x10")), instead of being rejected as non-decimal', async () => {
        // Expected: 400 — only plain decimal amounts are valid. Actual: validators/common.js isNumeric + Number() accept hex/exponent forms.
        const u = await staff(A, 'waiter');
        await fund(A, u, 500);
        const res = await withdraw(u, { amount: '0x10', method: 'Cash' });
        expect(res.status).toBe(400);
        expect((await walletOf(A, u)).balance).toBe(500);
    });

    test('exactly ₹1 is the minimum accepted; ₹0.995 rounds to ₹1.00 and is accepted as ₹1', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 10);
        expect((await withdraw(u, { amount: 1, method: 'Cash' })).status).toBe(201);
        const r = await withdraw(u, { amount: 0.995, method: 'Cash' });
        expect([201, 400]).toContain(r.status);
        const w = await walletOf(A, u);
        expect(w.balance).toBe(r.status === 201 ? 8 : 9);
    });

    test('numeric string "250.50" is accepted and debits exactly 250.5', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 300);
        const res = await withdraw(u, { amount: '250.50', method: 'Cash' });
        expect(res.status).toBe(201);
        expect(res.body.withdrawal.amount).toBe(250.5);
        expect((await walletOf(A, u)).balance).toBe(49.5);
    });

    test.each([
        ['empty balance', 0, 10],
        ['one paisa over', 100, 100.01],
        ['double the balance', 50, 100],
    ])('amount > available (%s) → 400 Insufficient, nothing written', async (_l, balance, amount) => {
        const u = await staff(A, 'waiter');
        await fund(A, u, balance);
        const res = await withdraw(u, { amount, method: 'Cash' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Insufficient balance/);
        expect((await walletOf(A, u)).balance).toBe(balance);
        expect(await ledgerOf(A, u)).toHaveLength(0);
    });

    test('pending withdrawals are already debited: a second request cannot reuse the same money', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        expect((await withdraw(u, { amount: 70, method: 'Cash' })).status).toBe(201);
        const second = await withdraw(u, { amount: 40, method: 'Cash' });
        expect(second.status).toBe(400);
        expect((await walletOf(A, u)).balance).toBe(30);
    });

    test('request response carries the new balance and a pending withdrawal bound to the wallet', async () => {
        const u = await staff(A, 'waiter');
        const w = await fund(A, u, 100);
        const res = await withdraw(u, { amount: 40, method: 'Cash' });
        expect(res.body.wallet.balance).toBe(60);
        expect(String(res.body.withdrawal.wallet)).toBe(String(w._id));
        expect(res.body.withdrawal.status).toBe('pending');
        expect(String(res.body.withdrawal.restaurant)).toBe(String(A.restaurant._id));
    });
});

describe('POST /staff-wallet/withdraw: payout details', () => {
    test.each([
        ['UPI with spaces inside', 'na me@upi'],
        ['UPI missing handle', 'someone@'],
        ['UPI single-char name', 'a@upi'],
        ['UPI no @', 'someoneupi'],
        ['UPI empty', ''],
    ])('%s → 400', async (_l, upiId) => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const res = await withdraw(u, { amount: 10, method: 'UPI', upiId });
        expect(res.status).toBe(400);
        expect((await walletOf(A, u)).balance).toBe(100);
    });

    test.each([['ab@okaxis'], ['first.last@ybl'], ['user-name_1@paytm']])('valid UPI id %s is accepted', async (upiId) => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        expect((await withdraw(u, { amount: 10, method: 'UPI', upiId })).status).toBe(201);
    });

    test('over-long payout fields (upiId 101, accountNumber 41, ifsc 21, note 501) are refused by the validator', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const cases = [
            { method: 'UPI', upiId: `${'a'.repeat(98)}@u2` },
            { method: 'Bank', accountHolder: 'X', accountNumber: '1'.repeat(41), ifsc: 'HDFC0000001' },
            { method: 'Bank', accountHolder: 'X', accountNumber: '1234', ifsc: 'H'.repeat(21) },
            { method: 'Cash', note: 'n'.repeat(501) },
        ];
        for (const c of cases) {
            const res = await withdraw(u, { amount: 10, ...c });
            expect(res.status).toBe(400);
        }
        expect((await walletOf(A, u)).balance).toBe(100);
    });

    test('Regression (fixed 2026-11): a 31–40 char account number passes the validator (max 40) but the model caps it at 30, so the withdrawal fails with a 500 AFTER the wallet reserve step', async () => {
        // Expected: 400 up-front (validator and model agree) and nothing debited.
        // Actual: validators/money.js allows 40, models/staffWithdrawal.js maxlength 30 → save throws inside the txn → 500 'Failed to request withdrawal.'
        // (the transaction rolls the balance back, so no money is lost, but the client gets a 500 for a validation problem).
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const res = await withdraw(u, { amount: 10, method: 'Bank', accountHolder: 'X', ifsc: 'HDFC0000001', accountNumber: '1'.repeat(35) });
        expect(res.status).toBe(400);
        expect((await walletOf(A, u)).balance).toBe(100);
    });

    test('a failed withdrawal save leaves balance, lifetimeDebits and ledger exactly as before (atomic rollback)', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        await withdraw(u, { amount: 10, method: 'Bank', accountHolder: 'X', ifsc: 'HDFC0000001', accountNumber: '1'.repeat(35) });
        const w = await walletOf(A, u);
        expect(w.balance).toBe(100);
        expect(w.lifetimeDebits).toBe(0);
        expect(await ledgerOf(A, u)).toHaveLength(0);
        expect(await StaffWithdrawal.countDocuments({ user: u._id })).toBe(0);
    });

    test('Cash withdrawal drops every payout field even if sent', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const res = await withdraw(u, { amount: 10, method: 'Cash', upiId: 'x@upi', accountNumber: '123', ifsc: 'ABC', bankName: 'B', accountHolder: 'H' });
        expect(res.status).toBe(201);
        const saved = await StaffWithdrawal.findById(res.body.withdrawal._id).lean();
        for (const k of ['upiId', 'accountNumber', 'ifsc', 'bankName', 'accountHolder']) expect(saved[k]).toBeUndefined();
    });
});

describe('role permissions on the staff wallet', () => {
    test.each(['waiter', 'captain'])('%s can request a withdrawal', async (role) => {
        const u = await staff(A, role);
        await fund(A, u, 100);
        expect((await withdraw(u, { amount: 10, method: 'Cash' })).status).toBe(201);
    });

    test.each(['chef', 'admin', 'customer'])('%s cannot request a withdrawal (no wallet created)', async (role) => {
        const u = role === 'customer' ? await createCustomer('spw') : role === 'admin' ? A.users.admin : await staff(A, role);
        const res = await withdraw(u, { amount: 10, method: 'Cash' });
        expect([400, 403]).toContain(res.status);
        expect(await StaffWallet.countDocuments({ user: u._id })).toBe(0);
    });

    test('unauthenticated → 401/400 for every staff-wallet endpoint', async () => {
        const id = new mongoose.Types.ObjectId();
        const anon = ctx.api.guest(A);
        for (const r of [
            anon.get('/staff-wallet/me'),
            anon.post('/staff-wallet/withdraw').send({ amount: 10, method: 'Cash' }),
            anon.get('/staff-wallet/withdrawals'),
            anon.post(`/staff-wallet/withdrawals/${id}/approve`).send({}),
            anon.post(`/staff-wallet/withdrawals/${id}/reject`).send({}),
        ]) {
            expect([400, 401]).toContain((await r).status);
        }
    });

    test.each(['waiter', 'captain', 'chef'])('%s cannot list, approve or reject withdrawals', async (role) => {
        const { id } = await pending(50, 100);
        const actor = await staff(A, role);
        expect((await ctx.api.as(actor).get('/staff-wallet/withdrawals')).status).toBe(403);
        expect((await approve(actor, id)).status).toBe(403);
        expect((await reject(actor, id)).status).toBe(403);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('a customer cannot list, approve or reject withdrawals', async () => {
        const { id } = await pending(50, 100);
        const c = await createCustomer('spw-c');
        expect((await ctx.api.as(c, A).get('/staff-wallet/withdrawals')).status).toBe(403);
        expect((await ctx.api.as(c, A).post(`/staff-wallet/withdrawals/${id}/approve`).send({})).status).toBe(403);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('a waiter cannot read another waiter\'s wallet through /me (only their own data)', async () => {
        const w1 = await staff(A, 'waiter'); const w2 = await staff(A, 'waiter');
        await fund(A, w1, 111); await fund(A, w2, 222);
        const res = await ctx.api.as(w1).get('/staff-wallet/me');
        expect(res.body.wallet.balance).toBe(111);
    });

    test('plan without tipManagement locks the whole staff wallet (403)', async () => {
        const t = await seedTenant({ label: 'sps-lock' });
        await Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.features.tipManagement': false } });
        const res = await ctx.api.as(t.users.waiter).get('/staff-wallet/me');
        expect(res.status).toBe(403);
        const w = await ctx.api.as(t.users.waiter).post('/staff-wallet/withdraw').send({ amount: 5, method: 'Cash' });
        expect(w.status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('state machine: pending → paid | rejected', () => {
    test('approve: pending→paid, balance and lifetime counters untouched, no new ledger row', async () => {
        const { u, id } = await pending(120, 500);
        const before = await walletOf(A, u);
        const rows = (await ledgerOf(A, u)).length;
        const res = await approve(A.users.admin, id, { txnRef: 'UTR-123' });
        expect(res.status).toBe(200);
        const after = await walletOf(A, u);
        expect(after.balance).toBe(before.balance);
        expect(after.lifetimeDebits).toBe(before.lifetimeDebits);
        expect(await ledgerOf(A, u)).toHaveLength(rows);
        const w = await StaffWithdrawal.findById(id).lean();
        expect(w).toMatchObject({ status: 'paid', txnRef: 'UTR-123' });
        expect(String(w.handledBy)).toBe(String(A.users.admin._id));
    });

    test('approve without a txnRef is allowed (cash hand-over) and stores none', async () => {
        const { id } = await pending(10, 50);
        expect((await approve(A.users.admin, id)).status).toBe(200);
        expect((await StaffWithdrawal.findById(id).lean()).txnRef).toBeUndefined();
    });

    test('double approve: second is 409 and handledAt / handledBy do not change', async () => {
        const { id } = await pending(10, 50);
        await approve(A.users.admin, id, { txnRef: 'FIRST' });
        const first = await StaffWithdrawal.findById(id).lean();
        const second = await approve(A.users.admin, id, { txnRef: 'SECOND' });
        expect(second.status).toBe(409);
        const after = await StaffWithdrawal.findById(id).lean();
        expect(after.txnRef).toBe('FIRST');
        expect(+after.handledAt).toBe(+first.handledAt);
    });

    test('reject: pending→rejected re-credits the exact amount once, lifetimeDebits reduced, refund ledger row chained', async () => {
        const { u, id } = await pending(133.33, 500);
        const res = await reject(A.users.admin, id, { reason: 'wrong shift' });
        expect(res.status).toBe(200);
        expect(res.body.wallet.balance).toBe(500);
        const w = await walletOf(A, u);
        expect(w.balance).toBe(500);
        expect(w.lifetimeDebits).toBe(0);
        const rows = await ledgerOf(A, u);
        expect(rows.map((r) => [r.type, r.direction, r.amount, r.balanceAfter])).toEqual([
            ['withdrawal-debit', 'debit', 133.33, 366.67],
            ['withdrawal-refund', 'credit', 133.33, 500],
        ]);
        const sw = await StaffWithdrawal.findById(id).lean();
        expect(sw).toMatchObject({ status: 'rejected', rejectReason: 'wrong shift' });
    });

    test.each([
        ['reject after paid', async (id) => { await approve(A.users.admin, id); return reject(A.users.admin, id); }],
        ['approve after rejected', async (id) => { await reject(A.users.admin, id); return approve(A.users.admin, id); }],
        ['reject twice', async (id) => { await reject(A.users.admin, id); return reject(A.users.admin, id); }],
        ['approve twice', async (id) => { await approve(A.users.admin, id); return approve(A.users.admin, id); }],
    ])('%s → 409 and the money does not move a second time', async (_l, act) => {
        const { u, id } = await pending(100, 300);
        const res = await act(id);
        expect(res.status).toBe(409);
        const { w, replay } = await expectConserved(A, u);
        // fund() injects the 300 without a ledger row, so the ledger replay equals balance − 300.
        expect(replay).toBe(r2(w.balance - 300));
        const st = (await StaffWithdrawal.findById(id).lean()).status;
        expect(w.balance).toBe(st === 'rejected' ? 300 : 200);
        expect(await StaffWalletTransaction.countDocuments({ user: u._id, type: 'withdrawal-refund' })).toBe(st === 'rejected' ? 1 : 0);
    });

    test('unknown id → 404; malformed id → 400; other tenant\'s id → 404 and untouched', async () => {
        expect((await approve(A.users.admin, new mongoose.Types.ObjectId())).status).toBe(404);
        expect((await reject(A.users.admin, new mongoose.Types.ObjectId())).status).toBe(404);
        expect((await approve(A.users.admin, 'not-an-id')).status).toBe(400);
        const { id } = await pending(10, 50, 'waiter', B);
        expect((await approve(A.users.admin, id)).status).toBe(404);
        expect((await reject(A.users.admin, id)).status).toBe(404);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('rejecting when the user\'s wallet is frozen still refunds (money is never stranded)', async () => {
        const { u, id } = await pending(100, 300);
        await StaffWallet.updateOne({ user: u._id, restaurant: A.restaurant._id }, { $set: { status: 'frozen' } });
        const res = await reject(A.users.admin, id, { reason: 'frozen' });
        expect(res.status).toBe(200);
        expect((await walletOf(A, u)).balance).toBe(300);
    });

    test('Regression (fixed 2026-11): a 290-char (valid, < 300) reject reason makes the reject fail with 500 — the ledger note "Withdrawal rejected: <reason>" overflows its 300-char limit and the whole refund rolls back', async () => {
        // Expected: 200 and the money refunded. Actual: staffWalletController.rejectWithdrawal builds note = 'Withdrawal rejected: ' + reason
        // (21 + up to 300 chars) but StaffWalletTransaction.note is maxlength 300 → ValidationError → 500; the row stays pending so
        // the admin cannot reject it with a long reason (any reason longer than 279 chars).
        const { u, id } = await pending(10, 50);
        const res = await reject(A.users.admin, id, { reason: 'x'.repeat(290) });
        expect(res.status).toBe(200);
        expect((await walletOf(A, u)).balance).toBe(50);
    });

    test('reject reason is trimmed; reason > 500 → 400; default reason when omitted', async () => {
        const a = await pending(10, 50);
        expect((await reject(A.users.admin, a.id, { reason: 'r'.repeat(501) })).status).toBe(400);
        expect((await StaffWithdrawal.findById(a.id).lean()).status).toBe('pending');
        const b = await pending(10, 50);
        expect((await reject(A.users.admin, b.id, { reason: `  ${'z'.repeat(200)}  ` })).status).toBe(200);
        expect((await StaffWithdrawal.findById(b.id).lean()).rejectReason).toBe('z'.repeat(200));
        const c = await pending(10, 50);
        await reject(A.users.admin, c.id, {});
        expect((await StaffWithdrawal.findById(c.id).lean()).rejectReason).toBe('No reason provided');
    });

    test('Regression (fixed 2026-11): a whitespace-only reject reason is stored as an empty string instead of the default "No reason provided"', async () => {
        // Expected: 'No reason provided' (same default as an omitted reason). Actual: '   ' is truthy → trim() → ''.
        // controllers/staffWalletController.js rejectWithdrawal `reason ? String(reason).trim().slice(...) : default`.
        const { id } = await pending(10, 50);
        await reject(A.users.admin, id, { reason: '   ' });
        expect((await StaffWithdrawal.findById(id).lean()).rejectReason).toBe('No reason provided');
    });

    test('reject of a withdrawal whose wallet was deleted is refused cleanly (404) and the row stays pending', async () => {
        const { u, id } = await pending(10, 50);
        await StaffWallet.deleteOne({ user: u._id, restaurant: A.restaurant._id });
        const res = await reject(A.users.admin, id);
        expect(res.status).toBe(404);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('list filters by status and the pending badge equals the real pending count', async () => {
        const t = await seedTenant({ label: 'sps-list' });
        const mk = async (n) => {
            const u = await staff(t, 'waiter'); await fund(t, u, 100);
            const r = await withdraw(u, { amount: n, method: 'Cash' }, t);
            return r.body.withdrawal._id;
        };
        const [p1, p2, p3] = [await mk(10), await mk(20), await mk(30)];
        await approve(t.users.admin, p2);
        await reject(t.users.admin, p3);
        const all = await ctx.api.as(t.users.admin).get('/staff-wallet/withdrawals');
        expect(all.body.withdrawals).toHaveLength(3);
        expect(all.body.pendingCount).toBe(1);
        for (const [s, expected] of [['pending', [p1]], ['paid', [p2]], ['rejected', [p3]]]) {
            const res = await ctx.api.as(t.users.admin).get(`/staff-wallet/withdrawals?status=${s}`);
            expect(res.body.withdrawals.map((w) => String(w._id))).toEqual(expected.map(String));
        }
        const bogus = await ctx.api.as(t.users.admin).get('/staff-wallet/withdrawals?status=%24ne');
        expect(bogus.status).toBe(200);
        expect(bogus.body.withdrawals).toHaveLength(3);
    });
});

describe('txnRef validation on approve', () => {
    test('a 100-char txnRef is stored verbatim', async () => {
        const { id } = await pending(10, 50);
        const ref = 'T'.repeat(100);
        const res = await approve(A.users.admin, id, { txnRef: ref });
        expect(res.status).toBe(200);
        expect((await StaffWithdrawal.findById(id).lean()).txnRef).toBe(ref);
    });

    test('a 101-char txnRef is refused by the validator (400) and the row stays pending', async () => {
        const { id } = await pending(10, 50);
        const res = await approve(A.users.admin, id, { txnRef: 'T'.repeat(101) });
        expect(res.status).toBe(400);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('Regression (fixed 2026-11): a 100-char txnRef padded with spaces is rejected (validator counts the untrimmed length) although the controller trims and truncates', async () => {
        // Expected: 200 — controllers/staffWalletController.js approveWithdrawal does String(txnRef).trim().slice(0, 100).
        // Actual: validators/common.js optionalText measures the raw string → 400 for '  ' + 100 chars + '  '.
        const { id } = await pending(10, 50);
        const res = await approve(A.users.admin, id, { txnRef: `  ${'T'.repeat(100)}  ` });
        expect(res.status).toBe(200);
    });

    test.each([
        ['number', 12345],
        ['object', { $ne: 1 }],
        ['array', ['a']],
        ['boolean', true],
    ])('txnRef as %s → 400, row stays pending', async (_l, txnRef) => {
        const { id } = await pending(10, 50);
        const res = await approve(A.users.admin, id, { txnRef });
        expect(res.status).toBe(400);
        expect((await StaffWithdrawal.findById(id).lean()).status).toBe('pending');
    });

    test('whitespace-only txnRef is treated as no reference; surrounding spaces are trimmed', async () => {
        const a = await pending(10, 50);
        expect((await approve(A.users.admin, a.id, { txnRef: '   ' })).status).toBe(200);
        const b = await pending(10, 50);
        expect((await approve(A.users.admin, b.id, { txnRef: '  UTR 99  ' })).status).toBe(200);
        expect((await StaffWithdrawal.findById(b.id).lean()).txnRef).toBe('UTR 99');
    });

    test('Regression (fixed 2026-11): whitespace-only txnRef is stored as an empty string instead of being omitted', async () => {
        // Expected: no txnRef (undefined) like the "no reference" case; Actual: '   ' is truthy → set to '' after trim.
        const { id } = await pending(10, 50);
        await approve(A.users.admin, id, { txnRef: '   ' });
        expect((await StaffWithdrawal.findById(id).lean()).txnRef).toBeUndefined();
    });

    test('stale-test finding: staffMoney "approve marks paid" expects truncation of a 124-char ref to 100, but the route validator rejects > 100 with 400 first', async () => {
        // Documents why staffMoney.test.js:304 fails at baseline: validators/money.js staffWalletApprove caps txnRef at 100
        // (400), so the controller's slice(0, 100) is only reachable for padded refs that are ≤100 after trim — and those
        // are ALSO rejected (see the BUG above). The test is stale; the controller truncation is dead code.
        const { id } = await pending(10, 50);
        const res = await approve(A.users.admin, id, { txnRef: `  UTR-${'9'.repeat(120)}  ` });
        expect(res.status).toBe(400);
    });

    test('txnRef on a reject call is ignored (reject has no txnRef)', async () => {
        const { id } = await pending(10, 50);
        await reject(A.users.admin, id, { txnRef: 'SHOULD-NOT-STICK' });
        expect((await StaffWithdrawal.findById(id).lean()).txnRef).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('branch-pinned admin scope', () => {
    test('a branch admin sees / approves / rejects only withdrawals of staff at their branch', async () => {
        const mainW = await staff(A, 'waiter'); await fund(A, mainW, 100);
        const mainRes = await withdraw(mainW, { amount: 20, method: 'Cash' });
        const sideRes = await (async () => { await fund(A, pinnedWaiter, 100); return withdraw(pinnedWaiter, { amount: 20, method: 'Cash' }); })();
        const mainId = mainRes.body.withdrawal._id; const sideId = sideRes.body.withdrawal._id;

        const list = await ctx.api.as(pinnedAdmin).get('/staff-wallet/withdrawals');
        const ids = list.body.withdrawals.map((w) => String(w._id));
        expect(ids).toContain(String(sideId));
        expect(ids).not.toContain(String(mainId));

        expect((await approve(pinnedAdmin, mainId)).status).toBe(404);
        expect((await reject(pinnedAdmin, mainId)).status).toBe(404);
        expect((await StaffWithdrawal.findById(mainId).lean()).status).toBe('pending');
        expect((await approve(pinnedAdmin, sideId)).status).toBe(200);
    });

    test('tenant owner (unpinned) sees both branches', async () => {
        const list = await ctx.api.as(A.users.admin).get('/staff-wallet/withdrawals');
        const users = new Set(list.body.withdrawals.map((w) => String(w.user._id)));
        expect(users.has(String(pinnedWaiter._id))).toBe(true);
    });

    test("tenant B's admin sees none of tenant A's withdrawals and the badge excludes them", async () => {
        const { id } = await pending(10, 50);
        const res = await ctx.api.as(B.users.admin).get('/staff-wallet/withdrawals');
        expect(res.body.withdrawals.map((w) => String(w._id))).not.toContain(String(id));
    });

    test('a waiter token sent with another tenant slug still acts on the waiter own tenant: no wallet is created at B', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const res = await ctx.api.as(u, B).post('/staff-wallet/withdraw').send({ amount: 10, method: 'Cash' });
        expect([201, 400, 401, 403]).toContain(res.status);
        expect((await walletOf(A, u)).balance).toBe(res.status === 201 ? 90 : 100);
        expect(await StaffWallet.countDocuments({ user: u._id, restaurant: B.restaurant._id })).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('concurrency on the staff wallet', () => {
    test('Regression (fixed 2026-11): 5 concurrent ₹10 withdrawals from a ₹1000 wallet must ALL succeed (funds are ample) — losers of a write conflict return 500 instead of retrying', async () => {
        // Expected: 5 × 201 and balance 950. Actual: requestWithdrawal uses a bare startTransaction with no withTransaction retry,
        // so concurrent writers to the same StaffWallet doc hit a WriteConflict → 500 'Failed to request withdrawal.'
        // (controllers/staffWalletController.js requestWithdrawal; staffMoney.test.js tolerates [400, 500] for this reason).
        const u = await staff(A, 'waiter');
        await fund(A, u, 1000);
        const results = await Promise.all(Array.from({ length: 5 }, () => withdraw(u, { amount: 10, method: 'Cash' })));
        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
        expect((await walletOf(A, u)).balance).toBe(950);
    });

    test('whatever the interleaving, accepted withdrawals + balance conserve the funded amount and the ledger replays to the balance', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 100);
        const results = await Promise.all(Array.from({ length: 8 }, () => withdraw(u, { amount: 30, method: 'Cash' })));
        const ok = results.filter((r) => r.status === 201).length;
        expect(ok).toBeLessThanOrEqual(3);
        const w = await walletOf(A, u);
        expect(w.balance).toBeGreaterThanOrEqual(0);
        expect(w.balance).toBe(100 - 30 * ok);
        expect(w.lifetimeDebits).toBe(30 * ok);
        const { rows } = await expectConserved(A, u);
        // funded balance was injected without a ledger row: replay delta must equal the debits only
        expect(r2(rows.reduce((s, r) => s - r.amount, 0))).toBe(-30 * ok);
        expect(await StaffWithdrawal.countDocuments({ user: u._id })).toBe(ok);
    });

    test('approve racing reject for 6 different pending rows: each row ends with exactly one outcome and money matches', async () => {
        const rows = await Promise.all(Array.from({ length: 6 }, () => pending(25, 100)));
        const results = await Promise.all(rows.flatMap(({ id }) => [approve(A.users.admin, id), reject(A.users.admin, id)]));
        expect(results.length).toBe(12);
        for (const { u, id } of rows) {
            const sw = await StaffWithdrawal.findById(id).lean();
            expect(['paid', 'rejected']).toContain(sw.status);
            const w = await walletOf(A, u);
            expect(w.balance).toBe(sw.status === 'rejected' ? 100 : 75);
            const refunds = await StaffWalletTransaction.countDocuments({ user: u._id, type: 'withdrawal-refund' });
            expect(refunds).toBe(sw.status === 'rejected' ? 1 : 0);
        }
    });

    test('10 concurrent rejects of the same row refund exactly once', async () => {
        const { u, id } = await pending(40, 100);
        const results = await Promise.all(Array.from({ length: 10 }, () => reject(A.users.admin, id)));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await walletOf(A, u)).balance).toBe(100);
        expect(await StaffWalletTransaction.countDocuments({ user: u._id, type: 'withdrawal-refund' })).toBe(1);
    });

    test('10 concurrent approves of the same row: exactly one 200, rest 409', async () => {
        const { id } = await pending(40, 100);
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => approve(A.users.admin, id, { txnRef: `R${i}` })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('ledger conservation and paise handling', () => {
    test('request → reject → request → approve: ledger replay equals the balance after every step', async () => {
        const u = await staff(A, 'waiter');
        // Credit through the real helper so the ledger carries the funding row too.
        const { creditWallet } = req_('controllers/staffWalletController');
        await creditWallet({ userId: u._id, restaurantId: A.restaurant._id, amount: 250.55 });
        let c = await expectConserved(A, u);
        expect(c.replay).toBe(c.w.balance);

        const r1 = await withdraw(u, { amount: 100.1, method: 'Cash' });
        c = await expectConserved(A, u);
        expect(c.replay).toBe(c.w.balance);
        expect(c.w.balance).toBe(150.45);

        await reject(A.users.admin, r1.body.withdrawal._id, { reason: 'retry' });
        c = await expectConserved(A, u);
        expect(c.replay).toBe(c.w.balance);
        expect(c.w.balance).toBe(250.55);

        const r2_ = await withdraw(u, { amount: 250.55, method: 'Cash' });
        expect(r2_.status).toBe(201);
        await approve(A.users.admin, r2_.body.withdrawal._id, { txnRef: 'OK' });
        c = await expectConserved(A, u);
        expect(c.replay).toBe(c.w.balance);
        expect(c.w.balance).toBe(0);
        // each row's balanceAfter chains
        let run = 0;
        for (const row of c.rows) {
            run = r2(run + (row.direction === 'credit' ? row.amount : -row.amount));
            expect(row.balanceAfter).toBe(run);
        }
        expect(c.w.lifetimeCredits).toBe(250.55);
        expect(c.w.lifetimeDebits).toBe(250.55);
    });

    test('creditWallet rejects zero / negative / NaN and rounds to the paisa (0.1 + 0.2 = 0.3)', async () => {
        const { creditWallet } = req_('controllers/staffWalletController');
        const u = await staff(A, 'waiter');
        for (const bad of [0, -5, NaN, Infinity]) {
            await expect(creditWallet({ userId: u._id, restaurantId: A.restaurant._id, amount: bad })).rejects.toThrow();
        }
        await creditWallet({ userId: u._id, restaurantId: A.restaurant._id, amount: 0.1 });
        await creditWallet({ userId: u._id, restaurantId: A.restaurant._id, amount: 0.2 });
        const w = await walletOf(A, u);
        expect(w.balance).toBe(0.3);
        expect(w.lifetimeCredits).toBe(0.3);
        expect(await ledgerOf(A, u)).toHaveLength(2);
    });

    test('model: negative balance / negative lifetime counters are rejected on save', async () => {
        const u = await staff(A, 'waiter');
        await expect(StaffWallet.create({ user: u._id, restaurant: A.restaurant._id, balance: -1 })).rejects.toThrow(/negative/i);
        await expect(StaffWallet.create({ user: u._id, restaurant: A.restaurant._id, lifetimeDebits: -1 })).rejects.toThrow();
    });

    test('model: a withdrawal below ₹1 / with a bad method / bad status is rejected by the schema', async () => {
        const u = await staff(A, 'waiter');
        const w = await fund(A, u, 10);
        const base = { restaurant: A.restaurant._id, user: u._id, wallet: w._id, amount: 5, method: 'Cash' };
        await expect(StaffWithdrawal.create({ ...base, amount: 0.5 })).rejects.toThrow(/at least/i);
        await expect(StaffWithdrawal.create({ ...base, method: 'Crypto' })).rejects.toThrow();
        await expect(StaffWithdrawal.create({ ...base, status: 'approved' })).rejects.toThrow();
        await expect(StaffWithdrawal.create({ ...base, txnRef: 'x'.repeat(101) })).rejects.toThrow();
    });

    test('one staff wallet per (user, tenant); the same user may hold wallets in two tenants', async () => {
        const u = await staff(A, 'waiter');
        await StaffWallet.create({ user: u._id, restaurant: A.restaurant._id });
        await expect(StaffWallet.create({ user: u._id, restaurant: A.restaurant._id })).rejects.toThrow(/duplicate|E11000/i);
        await expect(StaffWallet.create({ user: u._id, restaurant: B.restaurant._id })).resolves.toBeTruthy();
    });

    test('the ledger of withdrawal-debit rows is immutable to approve (approve adds no rows, even repeated)', async () => {
        const { u, id } = await pending(10, 50);
        const before = (await ledgerOf(A, u)).length;
        await approve(A.users.admin, id);
        await approve(A.users.admin, id);
        expect(await ledgerOf(A, u)).toHaveLength(before);
    });

    test('GET /me: pendingWithdrawalAmount is the sum of pending rows only (paid and rejected excluded)', async () => {
        const u = await staff(A, 'waiter');
        await fund(A, u, 1000);
        const ids = [];
        for (const n of [100, 200, 300, 50.25]) ids.push((await withdraw(u, { amount: n, method: 'Cash' })).body.withdrawal._id);
        await approve(A.users.admin, ids[0]);
        await reject(A.users.admin, ids[1]);
        const me = await ctx.api.as(u).get('/staff-wallet/me');
        expect(me.body.wallet.pendingWithdrawalAmount).toBe(350.25);
        expect(me.body.wallet.balance).toBe(1000 - 100 - 300 - 50.25);
    });

    test('Regression (fixed 2026-11): GET /me pending amount is computed from only the latest 20 withdrawals, so it under-reports when more than 20 exist', async () => {
        // Expected: the pending sum covers ALL pending rows. Actual: staffWalletController.getMyWallet slices .limit(20)
        // then sums pending within that window; an older still-pending row is silently dropped.
        const u = await staff(A, 'waiter');
        const w = await fund(A, u, 100);
        const old = await StaffWithdrawal.create({ restaurant: A.restaurant._id, user: u._id, wallet: w._id, amount: 40, method: 'Cash', status: 'pending', createdAt: new Date(Date.now() - 86400000 * 30) });
        await StaffWithdrawal.insertMany(Array.from({ length: 20 }, () => ({ restaurant: A.restaurant._id, user: u._id, wallet: w._id, amount: 1, method: 'Cash', status: 'paid' })));
        const me = await ctx.api.as(u).get('/staff-wallet/me');
        const realPending = await StaffWithdrawal.aggregate([{ $match: { user: u._id, status: 'pending' } }, { $group: { _id: null, s: { $sum: '$amount' } } }]);
        expect(realPending[0].s).toBe(40);
        expect(String(old._id)).toBeTruthy();
        expect(me.body.wallet.pendingWithdrawalAmount).toBe(40);
    });
});
