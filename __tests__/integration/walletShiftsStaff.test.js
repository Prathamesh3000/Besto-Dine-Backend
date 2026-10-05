/**
 * Customer-wallet admin surface, staff shifts and staff management.
 *
 *   controllers/walletController.js   admin adjust, points add/redeem, set-status,
 *                                     customer search, stats, reports, manual history,
 *                                     per-tenant wallet auto-create
 *   controllers/shiftController.js    clock-in/out, my shifts, admin staff shifts,
 *                                     force clock-out, run-autoclose
 *   controllers/staffController.js    add / update / status / delete / reset-password,
 *   utils/staffUtils.js               bulk CSV import, next-id, maxStaff, role + branch gates
 *
 * Already covered elsewhere (not repeated): pay-with-wallet (wallet.test.js),
 * recharge (walletRecharge.test.js), the shift auto-closer unit
 * (schedulers.test.js), body allowlist helpers (bodyAllowlist.test.js),
 * customers clocking in (known issue).
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const Wallet = req_('models/wallet');
const Transaction = req_('models/transaction');
const Shift = req_('models/shift');
const User = req_('models/user');
const Branch = req_('models/branch');
const Restaurant = req_('models/restaurant');

const ctx = useIntegrationApp();
let A;          // wallet + shifts tenant
let B;          // other tenant
let R;          // isolated tenant for wallet reports
let S;          // staff-management tenant (maxStaff raised)
let A2;         // A's second branch { branch, admin, waiter }
let S2;         // S's second branch { branch, admin, waiter }
let sManager;   // tenant-level manager in S

const rid = () => Math.random().toString(16).slice(2, 10);
const staff = (t, role, extra = {}) => createUser({
    name: `${role} ${rid()}`,
    email: `${role}.${rid()}@wss.test`,
    role,
    restaurant: t.restaurant._id,
    branch: t.branch._id,
    permissions: defaultPermissionsForRole(role),
    ...extra,
});
async function secondBranch(t) {
    const branch = await Branch.create({ restaurant: t.restaurant._id, name: 'Second', slug: `second-${rid()}`, isActive: true });
    return {
        branch,
        admin: await staff(t, 'admin', { branch: branch._id, permissions: {} }),
        waiter: await staff(t, 'waiter', { branch: branch._id }),
    };
}
const setMaxStaff = (t, n) => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.limits.maxStaff': n } });

beforeAll(async () => {
    A = await seedTenant({ label: 'wss-a' });
    B = await seedTenant({ label: 'wss-b' });
    R = await seedTenant({ label: 'wss-r' });
    S = await seedTenant({ label: 'wss-s' });
    A2 = await secondBranch(A);
    S2 = await secondBranch(S);
    sManager = await staff(S, 'manager', { branch: null });
    await setMaxStaff(S, 500);
});

const balanceOf = async (t, u) => (await Wallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean())?.balance;
const pointsOf = async (t, u) => (await Wallet.findOne({ user: u._id, restaurant: t.restaurant._id }).lean())?.loyaltyPoints;
const adjust = (admin, body) => ctx.api.as(admin).post('/wallet/admin/adjust').send(body);
const addPoints = (admin, body) => ctx.api.as(admin).post('/wallet/points/add').send(body);
/** A revoked / deactivated token must never get data back (401 or the 400 tenant refusal — see BUG below). */
const revokedStatus = async (u) => [400, 401].includes((await ctx.api.as(u).get('/tips/my')).status)
    && (await ctx.api.as(u).get('/auth/me')).status === 401;
const setStatus = (admin, body) => ctx.api.as(admin).post('/wallet/admin/set-status').send(body);

// ═════════════════════════════════════════════════════════════════════════
describe('wallet: admin adjust (POST /wallet/admin/adjust)', () => {
    const invalid = [
        ['missing targetUserId', { amount: 10, type: 'balance', action: 'add' }],
        ['missing amount', { type: 'balance', action: 'add' }],
        ['missing type', { amount: 10, action: 'add' }],
        ['missing action', { amount: 10, type: 'balance' }],
        ['zero amount', { amount: 0, type: 'balance', action: 'add' }],
        ['negative amount', { amount: -10, type: 'balance', action: 'add' }],
        ['string amount', { amount: 'ten', type: 'balance', action: 'add' }],
        ['amount above 1 crore', { amount: 10000001, type: 'balance', action: 'add' }],
        ['bad type', { amount: 10, type: 'cash', action: 'add' }],
        ['bad action', { amount: 10, type: 'balance', action: 'multiply' }],
        ['malformed targetUserId', { targetUserId: 'abc', amount: 10, type: 'balance', action: 'add' }],
    ];
    test.each(invalid)('%s → 400, nothing written', async (_l, body) => {
        const cust = await createCustomer('adj-inv');
        await setWallet(A, cust, { balance: 100 });
        const payload = { targetUserId: String(cust._id), ...body };
        if (!('targetUserId' in body) && _l === 'missing targetUserId') delete payload.targetUserId;
        const res = await adjust(A.users.admin, payload);
        expect(res.status).toBe(400);
        expect(await balanceOf(A, cust)).toBe(100);
        expect(await Transaction.countDocuments({ user: cust._id })).toBe(0);
    });

    test('credit to a customer with no wallet yet creates it with the exact amount and a ledger row', async () => {
        const cust = await createCustomer('adj-new');
        const res = await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 123.45, type: 'balance', action: 'add', description: 'goodwill' });
        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(123.45);
        expect(await balanceOf(A, cust)).toBe(123.45);
        const [tx] = await Transaction.find({ user: cust._id }).lean();
        expect(tx).toMatchObject({ type: 'wallet_recharge', amount: 123.45, balanceBefore: 0, balanceAfter: 123.45, description: 'goodwill', status: 'completed' });
        expect(String(tx.restaurant)).toBe(String(A.restaurant._id));
        expect(await Wallet.countDocuments({ user: cust._id })).toBe(1);   // only at A
    });

    test('debit cannot overdraw; an exact debit empties the wallet with a signed ledger row', async () => {
        const cust = await createCustomer('adj-deb');
        await setWallet(A, cust, { balance: 75.5 });
        const over = await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 75.51, type: 'balance', action: 'deduct' });
        expect(over.status).toBe(400);
        expect(over.body.message).toMatch(/Insufficient balance/);
        expect(await balanceOf(A, cust)).toBe(75.5);

        const ok = await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 75.5, type: 'balance', action: 'deduct' });
        expect(ok.status).toBe(200);
        expect(await balanceOf(A, cust)).toBe(0);
        const [tx] = await Transaction.find({ user: cust._id }).lean();
        expect(tx).toMatchObject({ amount: -75.5, balanceBefore: 75.5, balanceAfter: 0 });

        const none = await createCustomer('adj-none');
        const noWallet = await adjust(A.users.admin, { targetUserId: String(none._id), amount: 1, type: 'balance', action: 'deduct' });
        expect(noWallet.status).toBe(400);
        expect(await Wallet.countDocuments({ user: none._id })).toBe(0);
    });

    test('points add / deduct move loyaltyPoints only', async () => {
        const cust = await createCustomer('adj-pts');
        await setWallet(A, cust, { balance: 10, loyaltyPoints: 50 });
        expect((await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 25, type: 'points', action: 'add' })).status).toBe(200);
        expect((await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 100, type: 'points', action: 'deduct' })).status).toBe(400);
        expect((await adjust(A.users.admin, { targetUserId: String(cust._id), amount: 75, type: 'points', action: 'deduct' })).status).toBe(200);
        expect(await pointsOf(A, cust)).toBe(0);
        expect(await balanceOf(A, cust)).toBe(10);
    });

    test('staff accounts and unknown users cannot be adjusted', async () => {
        const res = await adjust(A.users.admin, { targetUserId: String(A.users.waiter._id), amount: 10, type: 'balance', action: 'add' });
        expect(res.status).toBe(400);
        const unknown = await adjust(A.users.admin, { targetUserId: String(new mongoose.Types.ObjectId()), amount: 10, type: 'balance', action: 'add' });
        expect(unknown.status).toBe(404);
        expect(await Wallet.countDocuments({ user: A.users.waiter._id })).toBe(0);
    });

    test.each(['waiter', 'captain', 'chef', 'customer'])('%s cannot adjust wallets', async (role) => {
        const cust = await createCustomer('adj-role');
        await setWallet(A, cust, { balance: 5 });
        const caller = role === 'customer' ? cust : A.users[role];
        const res = await ctx.api.as(caller, A).post('/wallet/admin/adjust').send({ targetUserId: String(cust._id), amount: 1000, type: 'balance', action: 'add' });
        expect(res.status).toBe(403);
        expect(await balanceOf(A, cust)).toBe(5);
    });

    test('an admin of another tenant never touches this tenant’s wallet', async () => {
        const cust = await createCustomer('adj-x');
        await setWallet(A, cust, { balance: 40 });
        const res = await adjust(B.users.admin, { targetUserId: String(cust._id), amount: 40, type: 'balance', action: 'deduct' });
        expect(res.status).toBe(400);
        expect(await balanceOf(A, cust)).toBe(40);
    });

    test('concurrent debits never overdraw: exactly one of three ₹60 debits on ₹100 succeeds', async () => {
        const cust = await createCustomer('adj-race');
        await setWallet(A, cust, { balance: 100 });
        const results = await Promise.all([1, 2, 3].map(() => adjust(A.users.admin, { targetUserId: String(cust._id), amount: 60, type: 'balance', action: 'deduct' })));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect(await balanceOf(A, cust)).toBe(40);
        expect(await Transaction.countDocuments({ user: cust._id })).toBe(1);
    });

    test('concurrent credits on an existing wallet all land (integer amounts)', async () => {
        const cust = await createCustomer('adj-cred');
        await setWallet(A, cust, { balance: 0 });
        const results = await Promise.all(Array.from({ length: 5 }, () => adjust(A.users.admin, { targetUserId: String(cust._id), amount: 20, type: 'balance', action: 'add' })));
        results.forEach((r) => expect(r.status).toBe(200));
        expect(await balanceOf(A, cust)).toBe(100);
        const rows = await Transaction.find({ user: cust._id }).lean();
        expect(rows.map((r) => r.balanceAfter).sort((a, b) => a - b)).toEqual([20, 40, 60, 80, 100]);
    });

    test('concurrent first-ever credits: the balance equals Σ of the 200 responses (no silent loss)', async () => {
        const cust = await createCustomer('adj-first');
        const results = await Promise.all([1, 2, 3].map(() => adjust(A.users.admin, { targetUserId: String(cust._id), amount: 30, type: 'balance', action: 'add' })));
        const ok = results.filter((r) => r.status === 200).length;
        expect(ok).toBeGreaterThanOrEqual(1);
        expect(await balanceOf(A, cust)).toBe(30 * ok);
        expect(await Transaction.countDocuments({ user: cust._id })).toBe(ok);
        expect(await Wallet.countDocuments({ user: cust._id, restaurant: A.restaurant._id })).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('wallet: points add / redeem', () => {
    test.each([
        ['string', '50'],
        ['zero', 0],
        ['negative', -5],
        ['over 10,000', 10001],
        ['NaN-like', 'NaN'],
    ])('admin points add with %s points → 400', async (_l, points) => {
        const cust = await createCustomer('pts-inv');
        await setWallet(A, cust, { loyaltyPoints: 7 });
        const res = await addPoints(A.users.admin, { targetUserId: String(cust._id), points });
        expect(res.status).toBe(400);
        expect(await pointsOf(A, cust)).toBe(7);
    });

    test('admin adds points with an exact ledger row; blocked wallet refuses; customers cannot self-mint', async () => {
        const cust = await createCustomer('pts-ok');
        await setWallet(A, cust, { loyaltyPoints: 10 });
        const res = await addPoints(A.users.admin, { targetUserId: String(cust._id), points: 90, description: 'birthday' });
        expect(res.status).toBe(200);
        expect(res.body.points).toBe(100);
        const [tx] = await Transaction.find({ user: cust._id }).lean();
        expect(tx).toMatchObject({ type: 'points_earned', amount: 90, balanceBefore: 10, balanceAfter: 100, paymentMethod: 'points' });

        const self = await ctx.api.as(cust, A).post('/wallet/points/add').send({ points: 500 });
        expect(self.status).toBe(403);

        await Wallet.updateOne({ user: cust._id, restaurant: A.restaurant._id }, { $set: { status: 'blocked' } });
        const blocked = await addPoints(A.users.admin, { targetUserId: String(cust._id), points: 5 });
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('WALLET_BLOCKED');
        expect(await pointsOf(A, cust)).toBe(100);
    });

    test('concurrent point credits are all applied', async () => {
        const cust = await createCustomer('pts-race');
        await setWallet(A, cust, { loyaltyPoints: 0 });
        const results = await Promise.all(Array.from({ length: 6 }, () => addPoints(A.users.admin, { targetUserId: String(cust._id), points: 15 })));
        results.forEach((r) => expect(r.status).toBe(200));
        expect(await pointsOf(A, cust)).toBe(90);
    });

    // Regression (fixed 2026-10): addPoints only credits customer accounts (same rule as adjustWallet).
    test('points/add refuses a staff account (manager cannot mint points for themselves)', async () => {
        const manager = await staff(A, 'manager');
        const res = await addPoints(manager, { points: 10000 });
        const minted = await pointsOf(A, manager);
        expect({ status: res.status, minted: minted ?? 0 }).toEqual({ status: 400, minted: 0 });
    });

    test('redeem converts at pointsToRupee (default 0.1) to the paisa and cannot double-spend', async () => {
        const cust = await createCustomer('redeem');
        await setWallet(A, cust, { balance: 5, loyaltyPoints: 1005 });
        const r = await ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points: 333 });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ rupeesAdded: 33.3, newBalance: 38.3, newPoints: 672 });

        const results = await Promise.all([1, 2, 3].map(() => ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points: 300 })));
        const ok = results.filter((x) => x.status === 200).length;
        expect(ok).toBe(2);
        expect(await pointsOf(A, cust)).toBe(72);
        expect(await balanceOf(A, cust)).toBe(98.3);
    });

    test.each([['string', '100'], ['zero', 0], ['negative', -1]])('redeem with %s points → 400', async (_l, points) => {
        const cust = await createCustomer('redeem-inv');
        await setWallet(A, cust, { loyaltyPoints: 500 });
        const r = await ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points });
        expect(r.status).toBe(400);
        expect(await pointsOf(A, cust)).toBe(500);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('wallet: block / unblock (POST /wallet/admin/set-status)', () => {
    test('block → customer redeem refused; unblock → allowed; audit rows written; case-insensitive', async () => {
        const cust = await createCustomer('blk');
        await setWallet(A, cust, { balance: 0, loyaltyPoints: 100 });
        const b = await setStatus(A.users.admin, { targetUserId: String(cust._id), status: 'BLOCKED' });
        expect(b.status).toBe(200);
        expect(b.body.status).toBe('blocked');
        const refused = await ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points: 100 });
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('WALLET_BLOCKED');

        const s = await setStatus(A.users.admin, { targetUserId: String(cust._id), status: 'suspended' });
        expect(s.status).toBe(200);
        const susp = await ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points: 100 });
        expect(susp.body.code).toBe('WALLET_SUSPENDED');

        expect((await setStatus(A.users.admin, { targetUserId: String(cust._id), status: 'active' })).status).toBe(200);
        expect((await ctx.api.as(cust, A).post('/wallet/points/redeem').send({ points: 100 })).status).toBe(200);
        const audits = await Transaction.find({ user: cust._id, type: 'wallet_status_change' }).lean();
        expect(audits).toHaveLength(3);
        audits.forEach((a) => expect(a.amount).toBe(0));
    });

    test.each([
        ['missing targetUserId', { status: 'blocked' }, 400],
        ['unknown status', { status: 'frozen' }, 400],
        ['non-string status', { status: 5 }, 400],
    ])('%s → %i', async (_l, body, code) => {
        const cust = await createCustomer('blk-inv');
        await setWallet(A, cust, {});
        const payload = _l === 'missing targetUserId' ? body : { targetUserId: String(cust._id), ...body };
        const res = await setStatus(A.users.admin, payload);
        expect(res.status).toBe(code);
        expect((await Wallet.findOne({ user: cust._id }).lean()).status).toBe('active');
    });

    test('no wallet at this tenant → 404; other tenant admin cannot block', async () => {
        const cust = await createCustomer('blk-x');
        await setWallet(A, cust, {});
        expect((await setStatus(B.users.admin, { targetUserId: String(cust._id), status: 'blocked' })).status).toBe(404);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).status).toBe('active');
        expect((await setStatus(A.users.waiter, { targetUserId: String(cust._id), status: 'blocked' })).status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('wallet: customer view, search, history, reports', () => {
    test('GET /wallet auto-creates one wallet per tenant', async () => {
        const cust = await createCustomer('per-tenant');
        const a = await ctx.api.as(cust, A).get('/wallet');
        const b = await ctx.api.as(cust, B).get('/wallet');
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body).toMatchObject({ balance: 0, loyaltyPoints: 0 });
        await ctx.api.as(cust, A).get('/wallet');
        const wallets = await Wallet.find({ user: cust._id }).lean();
        expect(wallets.map((w) => String(w.restaurant)).sort()).toEqual([String(A.restaurant._id), String(B.restaurant._id)].sort());
    });

    test('customer search: ≥2 chars, only customers with activity at this tenant', async () => {
        const tag = `zq${rid()}`;
        const here = await createCustomer(`${tag}here`, { name: `Zed ${tag} Here` });
        const there = await createCustomer(`${tag}there`, { name: `Zed ${tag} There` });
        await setWallet(A, here, { loyaltyPoints: 12 });
        await setWallet(B, there, {});
        expect((await ctx.api.as(A.users.admin).get('/wallet/admin/customers?q=z')).body.customers).toEqual([]);
        const res = await ctx.api.as(A.users.admin).get(`/wallet/admin/customers?q=${tag}`);
        expect(res.status).toBe(200);
        expect(res.body.customers.map((c) => String(c._id))).toEqual([String(here._id)]);
        expect(res.body.customers[0]).toMatchObject({ loyaltyPoints: 12, walletStatus: 'active' });
        const rx = await ctx.api.as(A.users.admin).get('/wallet/admin/customers?q=.*');
        expect(rx.status).toBe(200);   // regex metacharacters are escaped
    });

    test('manual points history pages correctly', async () => {
        const cust = await createCustomer('hist');
        await setWallet(R, cust, {});
        for (const p of [1, 2, 3]) {
            expect((await addPoints(R.users.admin, { targetUserId: String(cust._id), points: p, description: `admin gift ${p}` })).status).toBe(200);
        }
        const p1 = await ctx.api.as(R.users.admin).get('/wallet/admin/manual-history?page=1&limit=2');
        const p2 = await ctx.api.as(R.users.admin).get('/wallet/admin/manual-history?page=2&limit=2');
        expect(p1.body).toMatchObject({ total: 3, pages: 2, page: 1 });
        expect(p1.body.actions).toHaveLength(2);
        expect(p2.body.actions).toHaveLength(1);
        const all = [...p1.body.actions, ...p2.body.actions].map((a) => a.points).sort();
        expect(all).toEqual(['+1', '+2', '+3']);
        const other = await ctx.api.as(B.users.admin).get('/wallet/admin/manual-history');
        expect(other.body.actions.map((a) => String(a.customerId))).not.toContain(String(cust._id));
    });

    test('admin stats: exact tenant totals', async () => {
        const T = await seedTenant({ label: 'wss-st' });
        const c1 = await createCustomer('st1');
        const c2 = await createCustomer('st2');
        await adjust(T.users.admin, { targetUserId: String(c1._id), amount: 100.25, type: 'balance', action: 'add' });
        await adjust(T.users.admin, { targetUserId: String(c2._id), amount: 49.75, type: 'balance', action: 'add' });
        await adjust(T.users.admin, { targetUserId: String(c2._id), amount: 9.75, type: 'balance', action: 'deduct' });
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/stats');
        expect(res.status).toBe(200);
        expect(res.body.stats).toMatchObject({
            totalWalletBalance: 140.25, totalCustomers: 2, activeCustomers: 2,
            totalRecharge: 150, totalSpent: 9.75, totalTransactions: 3, avgBalance: 70.125,
        });
    });

    test('Wallet Balance Summary: exact totals; invalid report → 400', async () => {
        const T = await seedTenant({ label: 'wss-bs' });
        for (const bal of [0, 100.5, 2000, 7000.25]) await setWallet(T, await createCustomer('bs'), { balance: bal });
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Wallet%20Balance%20Summary');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ totalBalance: 9100.75, activeWallets: 3, totalWallets: 4, highest: 7000.25, avgBalance: 2275.19 });
        expect(res.body.data.distribution.map((d) => d.count)).toEqual([2, 1, 0, 1]);
        expect((await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Nope')).status).toBe(400);
    });

    // Regression (fixed 2026-10): distribution buckets use contiguous (lo, hi] edges, so counts sum to totalWallets.
    test('Wallet Balance Summary counts balances between bucket edges (₹500.50)', async () => {
        const T = await seedTenant({ label: 'wss-gap' });
        await setWallet(T, await createCustomer('gap1'), { balance: 500.5 });
        await setWallet(T, await createCustomer('gap2'), { balance: 2000.5 });
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Wallet%20Balance%20Summary');
        const counted = res.body.data.distribution.reduce((s, d) => s + d.count, 0);
        expect(counted).toBe(res.body.data.totalWallets);
    });

    // Regression (fixed 2026-10): reports read negative points_redeemed rows as points (positive rows are rupees ÷ pointsToRupee) and exclude them from rupee inputs.
    test('an admin deduction of 100 points is reported as 100 points redeemed', async () => {
        const T = await seedTenant({ label: 'wss-pts' });
        const cust = await createCustomer('pts-rep');
        await setWallet(T, cust, { loyaltyPoints: 0 });
        expect((await adjust(T.users.admin, { targetUserId: String(cust._id), amount: 300, type: 'points', action: 'add' })).status).toBe(200);
        expect((await adjust(T.users.admin, { targetUserId: String(cust._id), amount: 100, type: 'points', action: 'deduct' })).status).toBe(200);
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Points%20Issued%20vs%20Redeemed');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ totalIssued: 300, totalRedeemed: 100, netOutstanding: 200 });
    });

    test('Points Issued vs Redeemed: customer redemption is converted back to points exactly', async () => {
        const T = await seedTenant({ label: 'wss-pir' });
        const cust = await createCustomer('pir');
        await setWallet(T, cust, {});
        await addPoints(T.users.admin, { targetUserId: String(cust._id), points: 500 });
        expect((await ctx.api.as(cust, T).post('/wallet/points/redeem').send({ points: 250 })).status).toBe(200);
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Points%20Issued%20vs%20Redeemed');
        expect(res.body.data).toMatchObject({ totalIssued: 500, totalRedeemed: 250, netOutstanding: 250 });
    });

    test('Refunds to Wallet: only wallet-credited refunds, exact sums; Expired Points: exact value lost', async () => {
        const T = await seedTenant({ label: 'wss-ref' });
        const cust = await createCustomer('ref');
        const base = { user: cust._id, restaurant: T.restaurant._id, status: 'completed', paymentMethod: 'wallet' };
        await Transaction.create([
            { ...base, type: 'refund', amount: 100.1, balanceBefore: 0, balanceAfter: 100.1, description: 'Late', transactionId: `T-${rid()}` },
            { ...base, type: 'refund', amount: 50.2, balanceBefore: 100.1, balanceAfter: 150.3, description: 'Late', transactionId: `T-${rid()}` },
            { ...base, type: 'refund', amount: 999, balanceBefore: 150.3, balanceAfter: 150.3, paymentMethod: 'upi', description: 'UPI', transactionId: `T-${rid()}` },
        ]);
        const res = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Refunds%20to%20Wallet%20Report');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ totalRefunds: 2, totalAmount: 150.3, avgRefund: 75.15 });
        expect(res.body.data.breakdown).toEqual([{ reason: 'Late', count: 2, amount: 150.3 }]);

        const old = await Transaction.create([
            { ...base, type: 'points_earned', amount: 120, paymentMethod: 'points', transactionId: `T-${rid()}` },
            { ...base, type: 'points_earned', amount: 80, paymentMethod: 'points', transactionId: `T-${rid()}` },
        ]);
        const longAgo = new Date(Date.now() - 400 * 86400000);
        await Transaction.collection.updateMany({ _id: { $in: old.map((o) => o._id) } }, { $set: { createdAt: longAgo } });
        const exp = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Expired%20Points%20Report');
        expect(exp.status).toBe(200);
        expect(exp.body.data).toMatchObject({ totalExpired: 200, affectedUsers: 1, valueLost: 20, monthlyExpiry: 200 });
    });

    test('Top Wallet Users / Liability: recharge and wallet spend sums are exact', async () => {
        const T = await seedTenant({ label: 'wss-top' });
        const cust = await createCustomer('top');
        await adjust(T.users.admin, { targetUserId: String(cust._id), amount: 250.5, type: 'balance', action: 'add' });
        const top = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Top%20Wallet%20Users');
        expect(top.status).toBe(200);
        expect(top.body.data.users[0]).toMatchObject({ balance: 250.5, recharge: 250.5, spent: 0, transactions: 1 });
        const lia = await ctx.api.as(T.users.admin).get('/wallet/admin/reports?report=Wallet%20Liability%20Report');
        expect(lia.body.data).toMatchObject({ totalLiability: 250.5, utilizationRate: 0, riskLevel: 'Low Risk' });
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('shifts', () => {
    const clockIn = (u) => ctx.api.as(u).post('/shifts/clock-in').send({});
    const clockOut = (u, body = {}) => ctx.api.as(u).post('/shifts/clock-out').send(body);

    test('clock-in → double clock-in refused → clock-out with exact hours → clock-out again refused', async () => {
        const waiter = await staff(A, 'waiter');
        const r1 = await clockIn(waiter);
        expect(r1.status).toBe(201);
        expect(r1.body.shift).toMatchObject({ status: 'active' });
        expect(String(r1.body.shift.restaurant)).toBe(String(A.restaurant._id));
        expect((await clockIn(waiter)).status).toBe(400);

        // Pretend the shift started 2h 30m ago.
        const start = new Date(Date.now() - 2.5 * 3600000);
        await Shift.updateOne({ _id: r1.body.shift._id }, { $set: { clockIn: start } });
        const out = await clockOut(waiter, { note: 'done' });
        expect(out.status).toBe(200);
        const saved = await Shift.findById(r1.body.shift._id).lean();
        expect(saved.status).toBe('completed');
        expect(saved.note).toBe('done');
        expect(saved.totalHours).toBe(Math.round(((saved.clockOut - saved.clockIn) / 3600000) * 100) / 100);
        expect(saved.totalHours).toBe(2.5);

        expect((await clockOut(waiter)).status).toBe(400);
        expect((await clockIn(waiter)).status).toBe(201);   // a fresh shift may start
        expect(await Shift.countDocuments({ staff: waiter._id })).toBe(2);
    });

    test('clock-out without any shift → 400', async () => {
        const chef = await staff(A, 'chef');
        const res = await clockOut(chef);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/No active shift/);
    });

    // Regression (fixed 2026-10): unique partial index { restaurant, staff } where status 'active' on Shift; clockIn maps E11000 to 400.
    test('concurrent clock-ins open exactly one active shift', async () => {
        const waiter = await staff(A, 'waiter');
        const results = await Promise.all([1, 2, 3, 4].map(() => clockIn(waiter)));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(await Shift.countDocuments({ staff: waiter._id, status: 'active' })).toBe(1);
    });

    test('GET /shifts/my pages and only returns own shifts', async () => {
        const waiter = await staff(A, 'waiter');
        const other = await staff(A, 'waiter');
        const base = Date.now() - 10 * 86400000;
        await Shift.insertMany([0, 1, 2].map((i) => ({
            restaurant: A.restaurant._id, staff: waiter._id, status: 'completed',
            clockIn: new Date(base + i * 86400000), clockOut: new Date(base + i * 86400000 + 3600000), totalHours: 1,
        })));
        await Shift.create({ restaurant: A.restaurant._id, staff: other._id, status: 'completed', totalHours: 9 });
        const p1 = await ctx.api.as(waiter).get('/shifts/my?page=1&limit=2');
        const p2 = await ctx.api.as(waiter).get('/shifts/my?page=2&limit=2');
        expect(p1.status).toBe(200);
        expect(p1.body.pagination).toMatchObject({ totalCount: 3, totalPages: 2 });
        expect(p1.body.shifts).toHaveLength(2);
        expect(p2.body.shifts).toHaveLength(1);
        expect(p1.body.activeShift).toBeNull();
    });

    test('admin staff shifts: exact total hours, tenant-scoped, bad id 400, non-admin 403', async () => {
        const waiter = await staff(A, 'waiter');
        await Shift.insertMany([
            { restaurant: A.restaurant._id, staff: waiter._id, status: 'completed', clockIn: new Date(Date.now() - 86400000), totalHours: 7.25 },
            { restaurant: A.restaurant._id, staff: waiter._id, status: 'missed', clockIn: new Date(Date.now() - 2 * 86400000), totalHours: 16 },
        ]);
        const res = await ctx.api.as(A.users.admin).get(`/shifts/staff/${waiter._id}`);
        expect(res.status).toBe(200);
        expect(res.body.stats).toEqual({ totalShifts: 2, totalHours: 23.25 });
        const other = await ctx.api.as(B.users.admin).get(`/shifts/staff/${waiter._id}`);
        expect(other.body.stats.totalShifts).toBe(0);
        expect((await ctx.api.as(A.users.admin).get('/shifts/staff/nope')).status).toBe(400);
        expect((await ctx.api.as(A.users.captain).get(`/shifts/staff/${waiter._id}`)).status).toBe(403);
    });

    test('force clock-out: closes with exact hours + audit note; not active 400; other tenant 404; non-admin 403', async () => {
        const waiter = await staff(A, 'waiter');
        const shift = await Shift.create({ restaurant: A.restaurant._id, staff: waiter._id, status: 'active', clockIn: new Date(Date.now() - 3 * 3600000) });
        expect((await ctx.api.as(A.users.waiter).post(`/shifts/${shift._id}/force-clockout`).send({})).status).toBe(403);
        expect((await ctx.api.as(B.users.admin).post(`/shifts/${shift._id}/force-clockout`).send({})).status).toBe(404);
        const res = await ctx.api.as(A.users.admin).post(`/shifts/${shift._id}/force-clockout`).send({ note: 'forgot' });
        expect(res.status).toBe(200);
        const saved = await Shift.findById(shift._id).lean();
        expect(saved.status).toBe('completed');
        expect(saved.totalHours).toBe(3);
        expect(saved.note).toMatch(/\[Force-closed by .*: forgot\]/);
        expect((await ctx.api.as(A.users.admin).post(`/shifts/${shift._id}/force-clockout`).send({})).status).toBe(400);
    });

    // Regression (fixed 2026-10): forceClockOut validates the shift id before querying.
    test('force clock-out with a malformed id is a 400', async () => {
        const res = await ctx.api.as(A.users.admin).post('/shifts/not-an-id/force-clockout').send({});
        expect(res.status).toBe(400);
    });

    // Regression (fixed 2026-10): forceClockOut / getStaffShifts check the shift's staff belongs to the pinned admin's branch.
    test('a branch-pinned admin cannot force-close another branch’s staff shift', async () => {
        const mainWaiter = await staff(A, 'waiter');
        const shift = await Shift.create({ restaurant: A.restaurant._id, staff: mainWaiter._id, status: 'active', clockIn: new Date(Date.now() - 3600000) });
        const res = await ctx.api.as(A2.admin).post(`/shifts/${shift._id}/force-clockout`).send({});
        expect((await Shift.findById(shift._id).lean()).status).toBe('active');
        expect(res.status).toBe(403);
    });

    test('run-autoclose only sweeps the caller’s tenant', async () => {
        const old = new Date(Date.now() - 20 * 3600000);
        const wa = await staff(A, 'waiter');
        const wb = await staff(B, 'waiter');
        const sa = await Shift.create({ restaurant: A.restaurant._id, staff: wa._id, status: 'active', clockIn: old });
        const sb = await Shift.create({ restaurant: B.restaurant._id, staff: wb._id, status: 'active', clockIn: old });
        const res = await ctx.api.as(A.users.admin).post('/shifts/admin/run-autoclose').send({});
        expect(res.status).toBe(200);
        expect(res.body.summary.count).toBeGreaterThanOrEqual(1);
        const a = await Shift.findById(sa._id).lean();
        expect(a).toMatchObject({ status: 'missed', totalHours: 16 });
        expect(a.clockOut.getTime()).toBe(old.getTime() + 16 * 3600000);
        expect((await Shift.findById(sb._id).lean()).status).toBe('active');
        expect((await ctx.api.as(A.users.waiter).post('/shifts/admin/run-autoclose').send({})).status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('staff management', () => {
    const add = (caller, body) => ctx.api.as(caller).post('/staff').send({
        name: `New ${rid()}`, email: `new.${rid()}@wss.test`, role: 'waiter', branch: String(S.branch._id), ...body,
    });

    test('staffId numbering is per branch (EMP-001 restarts in a new branch) and the temp password is single-use visible', async () => {
        const T = await seedTenant({ label: 'wss-id' });
        await setMaxStaff(T, 100);
        const tb2 = await Branch.create({ restaurant: T.restaurant._id, name: 'B2', slug: 'b2', isActive: true });
        const mk = (branch) => ctx.api.as(T.users.admin).post('/staff').send({ name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(branch) });
        const r1 = await mk(T.branch._id);
        const r2 = await mk(T.branch._id);
        const r3 = await mk(tb2._id);
        expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
        expect([r1.body.staffMember.staffId, r2.body.staffMember.staffId, r3.body.staffMember.staffId]).toEqual(['EMP-001', 'EMP-002', 'EMP-001']);
        expect(r1.body.tempPassword).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12}$/);
        const saved = await User.findById(r1.body.staffMember._id).select('+password').lean();
        expect(saved.password).not.toBe(r1.body.tempPassword);
        expect(saved.mustChangePassword).toBe(true);
        expect(saved.permissions).toMatchObject(defaultPermissionsForRole('waiter'));

        const preview = await ctx.api.as(T.users.admin).get(`/staff/next-id?branch=${T.branch._id}`);
        expect(preview.body.nextId).toBe('EMP-003');
        // a client-supplied staffId that collides is replaced by the next free id
        const r4 = await ctx.api.as(T.users.admin).post('/staff').send({ name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(T.branch._id), staffId: 'EMP-001' });
        expect(r4.body.staffMember.staffId).toBe('EMP-003');
    });

    test.each([
        ['superadmin', 400],
        ['customer', 400],
        ['owner', 400],
        ['', 400],
    ])('role %p cannot be created → %i', async (role, code) => {
        const res = await add(S.users.admin, { role });
        expect(res.status).toBe(code);
    });

    test('privilege gates: owner may hire admin; sub-admin and manager may not; manager may not hire manager', async () => {
        const owner = await add(S.users.admin, { role: 'admin', branch: '' });
        expect(owner.status).toBe(201);
        expect(owner.body.staffMember.isTenantOwner).toBe(false);

        const sub = await add(S2.admin, { role: 'admin' });
        expect(sub.status).toBe(403);
        expect(sub.body.code).toBe('OWNER_ONLY_ROLE');
        const mgrAdmin = await add(sManager, { role: 'admin' });
        expect(mgrAdmin.body.code).toBe('OWNER_ONLY_ROLE');
        const mgrMgr = await add(sManager, { role: 'manager' });
        expect(mgrMgr.status).toBe(403);
        expect(mgrMgr.body.code).toBe('ROLE_ADMIN_ONLY');
        expect((await add(sManager, { role: 'chef' })).status).toBe(201);
        expect((await add(S.users.waiter, { role: 'waiter' })).status).toBe(403);
    });

    test('smuggled fields (isTenantOwner, restaurant, status, tokenVersion) are ignored; pinned admin is forced to own branch', async () => {
        const res = await add(S2.admin, {
            role: 'waiter', branch: String(S.branch._id), isTenantOwner: true, restaurant: String(B.restaurant._id),
            status: 'inactive', tokenVersion: 99, mustChangePassword: false,
        });
        expect(res.status).toBe(201);
        const u = await User.findById(res.body.staffMember._id).lean();
        expect(u.isTenantOwner).not.toBe(true);
        expect(String(u.restaurant)).toBe(String(S.restaurant._id));
        expect(String(u.branch)).toBe(String(S2.branch._id));
        expect(u.status).toBe('active');
        expect(u.mustChangePassword).toBe(true);
        expect(Number(u.tokenVersion) || 0).toBe(0);
    });

    test('duplicate email in tenant 400; customer email 400; same email at another tenant is allowed', async () => {
        const email = `dup.${rid()}@wss.test`;
        expect((await add(S.users.admin, { email })).status).toBe(201);
        expect((await add(S.users.admin, { email: email.toUpperCase() })).status).toBe(400);
        const cust = await createCustomer('staffmail');
        expect((await add(S.users.admin, { email: cust.email })).status).toBe(400);
        await setMaxStaff(B, 100);
        expect((await ctx.api.as(B.users.admin).post('/staff').send({ name: 'X', email, role: 'waiter', branch: String(B.branch._id) })).status).toBe(201);
    });

    // Regression (fixed 2026-10): addStaff applies the PERMISSIONS_ADMIN_ONLY rule for non-admin callers.
    test('a manager cannot hire a waiter with arbitrary permissions (same rule as update)', async () => {
        const res = await add(sManager, { role: 'waiter', permissions: { accessKitchen: true, refund: true, manageStaff: true } });
        const u = res.status === 201 ? await User.findById(res.body.staffMember._id).lean() : null;
        expect(res.status === 403 || (u && u.permissions.accessKitchen !== true)).toBe(true);
    });

    test('maxStaff is enforced', async () => {
        const T = await seedTenant({ label: 'wss-max' });   // 4 active staff seeded
        await setMaxStaff(T, 5);
        const mk = () => ctx.api.as(T.users.admin).post('/staff').send({ name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(T.branch._id) });
        expect((await mk()).status).toBe(201);
        const over = await mk();
        expect(over.status).toBe(403);
        expect(over.body).toMatchObject({ code: 'STAFF_LIMIT_REACHED', current: 5, limit: 5 });
    });

    // Regression (fixed 2026-10): addStaff re-counts and inserts in one transaction serialised by a per-tenant lock row.
    test('concurrent hires into different branches never exceed the plan maxStaff', async () => {
        const T = await seedTenant({ label: 'wss-maxr' });   // 4 active
        await setMaxStaff(T, 5);
        const branches = [T.branch];
        for (let i = 0; i < 3; i += 1) {
            branches.push(await Branch.create({ restaurant: T.restaurant._id, name: `Br${i}`, slug: `br-${i}-${rid()}`, isActive: true }));
        }
        const results = await Promise.all(branches.map((b) => ctx.api.as(T.users.admin).post('/staff').send({
            name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(b._id),
        })));
        const active = await User.countDocuments({ restaurant: T.restaurant._id, role: { $ne: 'customer' }, status: 'active' });
        expect({ created: results.filter((r) => r.status === 201).length, active }).toEqual({ created: 1, active: 5 });
    });

    test('update gates: pinned admin cannot re-pin or touch other branch; manager cannot promote or change permissions', async () => {
        const w = await staff(S, 'waiter');
        const moved = await ctx.api.as(S2.admin).put(`/staff/${w._id}`).send({ name: 'x' });
        expect(moved.status).toBe(403);
        expect(moved.body.code).toBe('BRANCH_MISMATCH');
        const own = await staff(S, 'waiter', { branch: S2.branch._id });
        const repin = await ctx.api.as(S2.admin).put(`/staff/${own._id}`).send({ branch: String(S.branch._id) });
        expect(repin.body.code).toBe('BRANCH_LOCKED');
        const promote = await ctx.api.as(sManager).put(`/staff/${w._id}`).send({ role: 'admin' });
        expect(promote.body.code).toBe('OWNER_ONLY_ROLE');
        const perms = await ctx.api.as(sManager).put(`/staff/${w._id}`).send({ permissions: { ...defaultPermissionsForRole('waiter'), refund: true } });
        expect(perms.body.code).toBe('PERMISSIONS_ADMIN_ONLY');
        const same = await ctx.api.as(sManager).put(`/staff/${w._id}`).send({ name: 'Renamed', permissions: defaultPermissionsForRole('waiter') });
        expect(same.status).toBe(200);
        const u = await User.findById(w._id).lean();
        expect(u).toMatchObject({ name: 'Renamed', role: 'waiter', permissions: defaultPermissionsForRole('waiter') });
        const ownerEdit = await ctx.api.as(sManager).put(`/staff/${S.users.admin._id}`).send({ name: 'pwn' });
        expect(ownerEdit.status).toBe(403);
    });

    test('deactivation bumps tokenVersion and kills the old token; reactivation works', async () => {
        const w = await staff(S, 'waiter');
        expect((await ctx.api.as(w).get('/tips/my')).status).toBe(200);
        const res = await ctx.api.as(S.users.admin).patch(`/staff/${w._id}/status`).send({ status: 'inactive' });
        expect(res.status).toBe(200);
        const u = await User.findById(w._id).lean();
        expect(u.status).toBe('inactive');
        expect(u.tokenVersion).toBe(1);
        expect(await revokedStatus(w)).toBe(true);
        expect((await ctx.api.as(S.users.admin).patch(`/staff/${w._id}/status`).send({ status: 'active' })).status).toBe(200);
        expect((await ctx.api.as(S.users.admin).patch(`/staff/${w._id}/status`).send({ status: 'deleted' })).status).toBe(400);
    });

    // Regression (fixed 2026-10): optionalAuth flags a revoked/deactivated token and attachTenant answers 401 instead of 400 TENANT_REQUIRED.
    test('a deactivated staff token gets 401 SESSION_REVOKED, not 400 TENANT_REQUIRED, on tenant routes', async () => {
        const w = await staff(S, 'waiter');
        expect((await ctx.api.as(S.users.admin).patch(`/staff/${w._id}/status`).send({ status: 'inactive' })).status).toBe(200);
        const res = await ctx.api.as(w).get('/tips/my');
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    });

    test('status gates: pinned admin other branch 403, manager on admin 403, other tenant 404', async () => {
        const w = await staff(S, 'waiter');
        expect((await ctx.api.as(S2.admin).patch(`/staff/${w._id}/status`).send({ status: 'inactive' })).status).toBe(403);
        expect((await ctx.api.as(sManager).patch(`/staff/${S2.admin._id}/status`).send({ status: 'inactive' })).status).toBe(403);
        expect((await ctx.api.as(B.users.admin).patch(`/staff/${w._id}/status`).send({ status: 'inactive' })).status).toBe(404);
        expect((await User.findById(w._id).lean()).status).toBe('active');
    });

    // Regression (fixed 2026-10): updateStaffStatus refuses self-deactivation (400) and deactivating the tenant owner (403).
    test('the tenant owner cannot deactivate their own account (same rule as delete)', async () => {
        const T = await seedTenant({ label: 'wss-self' });
        const res = await ctx.api.as(T.users.admin).patch(`/staff/${T.users.admin._id}/status`).send({ status: 'inactive' });
        const after = await User.findById(T.users.admin._id).lean();
        expect({ status: res.status, user: after.status }).toEqual({ status: 400, user: 'active' });
    });

    test('delete: self 400, owner 403, other branch 403, manager on admin 403, success revokes the account', async () => {
        const T = await seedTenant({ label: 'wss-del' });
        await setMaxStaff(T, 100);
        const t2 = await secondBranch(T);
        const mgr = await staff(T, 'manager', { branch: null });
        expect((await ctx.api.as(mgr).delete(`/staff/${mgr._id}`)).status).toBe(400);
        expect((await ctx.api.as(t2.admin).delete(`/staff/${T.users.admin._id}`)).body.code).toBe('CANNOT_DELETE_OWNER');
        expect((await ctx.api.as(t2.admin).delete(`/staff/${T.users.waiter._id}`)).body.code).toBe('BRANCH_MISMATCH');
        expect((await ctx.api.as(mgr).delete(`/staff/${t2.admin._id}`)).status).toBe(403);
        expect((await ctx.api.as(B.users.admin).delete(`/staff/${T.users.waiter._id}`)).status).toBe(404);
        const ok = await ctx.api.as(t2.admin).delete(`/staff/${t2.waiter._id}`);
        expect(ok.status).toBe(200);
        expect(await User.countDocuments({ _id: t2.waiter._id })).toBe(0);
        expect(await revokedStatus(t2.waiter)).toBe(true);
    });

    test('reset password: self 400, owner 403, other branch 403; success rotates hash and revokes the old token', async () => {
        const w = await staff(S, 'waiter', { branch: S2.branch._id });
        expect((await ctx.api.as(S2.admin).post(`/staff/${S2.admin._id}/reset-password`).send({})).status).toBe(400);
        expect((await ctx.api.as(S2.admin).post(`/staff/${S.users.admin._id}/reset-password`).send({})).body.code).toBe('CANNOT_RESET_OWNER');
        expect((await ctx.api.as(S2.admin).post(`/staff/${S.users.waiter._id}/reset-password`).send({})).body.code).toBe('BRANCH_MISMATCH');
        expect((await ctx.api.as(sManager).post(`/staff/${S2.admin._id}/reset-password`).send({})).status).toBe(403);
        const before = await User.findById(w._id).select('+password').lean();
        const res = await ctx.api.as(S2.admin).post(`/staff/${w._id}/reset-password`).send({});
        expect(res.status).toBe(200);
        expect(typeof res.body.tempPassword).toBe('string');
        const after = await User.findById(w._id).select('+password').lean();
        expect(after.password).not.toBe(before.password);
        expect(after.mustChangePassword).toBe(true);
        expect(after.tokenVersion).toBe((before.tokenVersion || 0) + 1);
        expect(await revokedStatus(w)).toBe(true);
    });

    test('staff list: pinned admin sees only own branch; other tenants never listed', async () => {
        const res = await ctx.api.as(S2.admin).get('/staff');
        expect(res.status).toBe(200);
        const list = res.body.staff || res.body.data || res.body;
        const rows = Array.isArray(list) ? list : [];
        expect(rows.length).toBeGreaterThan(0);
        rows.forEach((r) => expect(String(r.branch?._id || r.branch)).toBe(String(S2.branch._id)));
        const next = await ctx.api.as(S2.admin).get(`/staff/next-id?branch=${S.branch._id}`);
        expect(next.status).toBe(200);
    });
});

describe('staff: assignments, branch moves, performance', () => {
    test('area/table assignment: other-branch area 400; own area + table stored; captain tables dropped; role -> chef wipes them', async () => {
        const Area = req_('models/area');
        const { createTable } = require('./helpers/seed');
        const otherArea = await Area.create({ restaurant: S.restaurant._id, branch: S2.branch._id, name: `A2 ${rid()}` });
        const table = await createTable(S, {});
        const bad = await ctx.api.as(S.users.admin).post('/staff').send({
            name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(S.branch._id), assignedAreas: [String(otherArea._id)],
        });
        expect(bad.status).toBe(400);
        const ok = await ctx.api.as(S.users.admin).post('/staff').send({
            name: 'W', email: `w.${rid()}@wss.test`, role: 'waiter', branch: String(S.branch._id),
            assignedAreas: [String(S.area._id), 'junk'], assignedTables: [String(table._id)], handlesTakeaway: true,
        });
        expect(ok.status).toBe(201);
        let u = await User.findById(ok.body.staffMember._id).lean();
        expect(u.assignedAreas.map(String)).toEqual([String(S.area._id)]);
        expect(u.assignedTables.map(String)).toEqual([String(table._id)]);
        expect(u.handlesTakeaway).toBe(true);

        const cap = await ctx.api.as(S.users.admin).post('/staff').send({
            name: 'C', email: `c.${rid()}@wss.test`, role: 'captain', branch: String(S.branch._id),
            assignedAreas: [String(S.area._id)], assignedTables: [String(table._id)],
        });
        expect((await User.findById(cap.body.staffMember._id).lean()).assignedTables).toEqual([]);

        const toChef = await ctx.api.as(S.users.admin).put(`/staff/${u._id}`).send({ role: 'chef' });
        expect(toChef.status).toBe(200);
        u = await User.findById(u._id).lean();
        expect(u).toMatchObject({ role: 'chef', assignedAreas: [], assignedTables: [], handlesTakeaway: false, kitchenResponsibility: '' });
    });

    test('owner branch moves: floor staff cannot become tenant-level; moving to another active branch works', async () => {
        const w = await staff(S, 'waiter');
        const toNull = await ctx.api.as(S.users.admin).put(`/staff/${w._id}`).send({ branch: '' });
        expect(toNull.body.code).toBe('BRANCH_REQUIRED');
        const foreign = await ctx.api.as(S.users.admin).put(`/staff/${w._id}`).send({ branch: String(B.branch._id) });
        expect(foreign.status).toBe(400);
        const moved = await ctx.api.as(S.users.admin).put(`/staff/${w._id}`).send({ branch: String(S2.branch._id) });
        expect(moved.status).toBe(200);
        expect(String((await User.findById(w._id).lean()).branch)).toBe(String(S2.branch._id));
        const m = await staff(S, 'manager');
        expect((await ctx.api.as(S.users.admin).put(`/staff/${m._id}`).send({ branch: null })).status).toBe(200);
        expect((await User.findById(m._id).lean()).branch).toBeNull();
    });

    test('waiter performance: revenue of served orders summed to the paisa; other tenant 404', async () => {
        const Order = req_('models/order');
        const { createTable } = require('./helpers/seed');
        const w = await staff(S, 'waiter');
        const ids = [];
        for (let i = 0; i < 3; i += 1) {
            const table = await createTable(S, {});
            const r = await ctx.api.as(w).post('/orders').send({
                type: 'dine-in', tableId: String(table._id), items: [{ menuItem: String(S.items.paneer._id), quantity: 1 }], total: 250,
            });
            expect(r.status).toBe(201);
            ids.push(r.body.order._id);
        }
        await Order.updateMany({ _id: { $in: ids.slice(0, 2) } }, { $set: { status: 'served' } });
        await Order.updateOne({ _id: ids[0] }, { $set: { total: 250.55 } });
        await Order.updateOne({ _id: ids[2] }, { $set: { status: 'cancelled' } });
        const res = await ctx.api.as(S.users.admin).get(`/staff/${w._id}/performance`);
        expect(res.status).toBe(200);
        expect(res.body.performance).toMatchObject({ role: 'waiter', totalRevenue: 500.55, ordersServed: 2, todayRevenue: 500.55 });
        expect((await ctx.api.as(B.users.admin).get(`/staff/${w._id}/performance`)).status).toBe(404);
        expect((await ctx.api.as(S.users.waiter).get(`/staff/${w._id}/performance`)).status).toBe(403);
    });

    // Regression (fixed 2026-10): getStaffPerformance runs staffBranchGate.
    test('a branch-pinned admin cannot read another branch staff member performance', async () => {
        const res = await ctx.api.as(S2.admin).get(`/staff/${S.users.waiter._id}/performance`);
        expect(res.status).toBe(403);
    });

    test('template download is a CSV attachment', async () => {
        const res = await ctx.api.as(S.users.admin).get('/staff/template');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.text.split('\n')[0].toLowerCase()).toMatch(/name.*email.*role/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
describe('staff bulk CSV import (POST /staff/import)', () => {
    const upload = (caller, csv, branch) => {
        let r = ctx.api.as(caller).post('/staff/import').attach('file', Buffer.from(csv, 'utf8'), 'staff.csv');
        if (branch !== undefined) r = r.field('branch', String(branch));
        return r;
    };

    test('creates valid rows with per-branch sequential ids and role-default permissions; reports skips + errors', async () => {
        const T = await seedTenant({ label: 'wss-csv' });
        await setMaxStaff(T, 100);
        const e1 = `c1.${rid()}@wss.test`;
        const csv = [
            'name,email,role,mobile',
            `Asha,${e1},waiter,9876543210`,
            `Ben,b.${rid()}@wss.test,chef,`,
            `Dup,${e1.toUpperCase()},waiter,`,
            `Old,${T.users.waiter.email},waiter,`,
            `Bad,bad.${rid()}@wss.test,superadmin,`,
            `NoMail,,waiter,`,
            `Mob,m.${rid()}@wss.test,waiter,12345`,
            ',,,',
        ].join('\n');
        const res = await upload(T.users.admin, csv, T.branch._id);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ created: 2, skippedCount: 2, errorCount: 3 });
        expect(res.body.tempPasswords).toHaveLength(2);
        const made = await User.find({ restaurant: T.restaurant._id, staffId: { $in: ['EMP-001', 'EMP-002'] } }).lean();
        expect(made).toHaveLength(2);
        const chef = made.find((u) => u.role === 'chef');
        expect(chef.permissions).toMatchObject(defaultPermissionsForRole('chef'));
        expect(chef.kitchenResponsibility).toBe('both');
        made.forEach((u) => expect(String(u.branch)).toBe(String(T.branch._id)));
    });

    test('whole batch refused when it would exceed maxStaff; sub-admin cannot import admins', async () => {
        const T = await seedTenant({ label: 'wss-csvmax' });   // 4 active
        await setMaxStaff(T, 5);
        const csv = ['name,email,role', `A,a.${rid()}@wss.test,waiter`, `B,b.${rid()}@wss.test,waiter`].join('\n');
        const res = await upload(T.users.admin, csv, T.branch._id);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'STAFF_LIMIT_REACHED', wouldAdd: 2 });
        expect(await User.countDocuments({ restaurant: T.restaurant._id })).toBe(4);

        const adm = await upload(S2.admin, ['name,email,role', `X,x.${rid()}@wss.test,admin`].join('\n'));
        expect(adm.status).toBe(200);
        expect(adm.body.created).toBe(0);
        expect(adm.body.errors[0].message).toMatch(/tenant owners/);
    });

    test('missing columns / empty file → 400; non-admin → 403', async () => {
        expect((await upload(S.users.admin, 'name,email\nA,a@b.co', S.branch._id)).status).toBe(400);
        expect((await upload(S.users.admin, 'name,email,role', S.branch._id)).status).toBe(400);
        expect((await upload(S.users.waiter, 'name,email,role\nA,a@b.co,waiter')).status).toBe(403);
    });

    // Regression (fixed 2026-10): importStaffCsv reports rows whose email belongs to a customer / superadmin as errors.
    test('CSV import refuses a customer’s email (same rule as single add)', async () => {
        const T = await seedTenant({ label: 'wss-csvcust' });
        await setMaxStaff(T, 100);
        const cust = await createCustomer('csvcust');
        const single = await ctx.api.as(T.users.admin).post('/staff').send({ name: 'C', email: cust.email, role: 'waiter', branch: String(T.branch._id) });
        expect(single.status).toBe(400);
        const res = await upload(T.users.admin, ['name,email,role', `C,${cust.email},waiter`].join('\n'), T.branch._id);
        expect(res.status).toBe(200);
        expect(await User.countDocuments({ email: cust.email.toLowerCase(), role: 'waiter' })).toBe(0);
    });

    // Regression (fixed 2026-10): CSV mobile check matches the schema (/^[6-9]\d{9}$/) and tempPasswords/created come from the rows that actually landed.
    test('CSV row with a schema-invalid mobile (1234567890) is an error and gets no tempPassword', async () => {
        const T = await seedTenant({ label: 'wss-csvmob' });
        await setMaxStaff(T, 100);
        const good = `g.${rid()}@wss.test`;
        const bad = `b.${rid()}@wss.test`;
        const res = await upload(T.users.admin, ['name,email,role,mobile', `G,${good},waiter,9876543210`, `B,${bad},waiter,1234567890`].join('\n'), T.branch._id);
        expect(res.status).toBe(200);
        const exists = await User.countDocuments({ email: bad });
        expect(res.body.created).toBe(1 + exists);
        expect(res.body.tempPasswords.map((t) => t.email)).toEqual(exists ? [good, bad] : [good]);
        expect(res.body.errorCount + res.body.created).toBe(2);
    });
});
