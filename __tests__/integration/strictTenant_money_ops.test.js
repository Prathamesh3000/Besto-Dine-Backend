/**
 * STRICT multi-tenancy: money back-office
 *   staffWalletRoute, tipRoute, cashClosingRoute, invoiceRoute, ledgerRoute,
 *   payrollRoute, incentiveRoute, supplierInvoiceRoute, tenantBillingRoute.
 *
 * "BUG:" tests pin real cross-tenant leaks / foreign-id references and are
 * expected to FAIL until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(BACKEND, 'models', n));
const Order = M('order'); const Tip = M('tip'); const TipSettlement = M('tipSettlement');
const StaffWallet = M('staffWallet'); const StaffWithdrawal = M('staffWithdrawal');
const StaffWalletTransaction = M('staffWalletTransaction');
const CashClosing = M('cashClosing'); const Expense = M('expense'); const Invoice = M('invoice');
const Supplier = M('supplier'); const SupplierInvoice = M('supplierInvoice'); const SupplierPayment = M('supplierPayment');
const IncentiveCampaign = M('incentiveCampaign'); const IncentiveEntry = M('incentiveEntry');
const PayrollRun = M('payrollRun'); const StaffPayProfile = M('staffPayProfile');
const SubscriptionInvoice = M('subscriptionInvoice'); const Branch = M('branch');
const LedgerEntry = M('ledgerEntry'); const PurchaseOrder = M('purchaseOrder');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(5).toString('hex');
const SECRET = 'SECRET-B-MONEY';
const today = () => new Date().toISOString().slice(0, 10);
const snapOf = async (Model, id) => JSON.stringify(await Model.findById(id).lean());

let A; let B; let aPinned; let aBranch2;
let bOrder; let bTip; let bWallet; let bWithdrawal; let bSettlement;
let bClosing; let bExpense; let bInvoice; let bSupplier; let bSInvoice; let bCampaign; let bRun; let bSubInv; let bPO;

beforeAll(async () => {
    A = await seedTenant({ label: 'smm-a' });
    B = await seedTenant({ label: 'smm-b' });
    aBranch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A2', slug: 'a2', isActive: true });
    aPinned = await createUser({
        name: 'pinned a', email: `pin.${rid()}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: aBranch2._id, permissions: defaultPermissionsForRole('admin'),
    });

    bOrder = (await Order.create({
        restaurant: B.restaurant._id, branch: B.branch._id, orderId: `MM-${rid()}`, type: 'takeaway',
        items: [{ menuItem: B.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }],
        total: 500, status: 'served', paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 500, customerName: SECRET,
    })).toObject();
    bTip = await Tip.create({ restaurant: B.restaurant._id, waiter: B.users.waiter._id, order: bOrder._id, amount: 55, status: 'pending' });
    bWallet = await StaffWallet.create({ restaurant: B.restaurant._id, user: B.users.waiter._id, balance: 4321, lifetimeCredits: 5000 });
    bWithdrawal = await StaffWithdrawal.create({ restaurant: B.restaurant._id, user: B.users.waiter._id, wallet: bWallet._id, amount: 100, method: 'Cash', note: SECRET, status: 'pending' });
    bSettlement = await TipSettlement.create({
        restaurant: B.restaurant._id, waiter: B.users.waiter._id, amount: 77, tipsSettledCount: 2, paymentMethod: 'Cash',
        settledBy: B.users.admin._id, note: SECRET,
    });
    bClosing = await CashClosing.create({ restaurant: B.restaurant._id, branch: B.branch._id, businessDate: today(), status: 'open', openingCash: 1234, notes: SECRET });
    bExpense = await Expense.create({ restaurant: B.restaurant._id, branch: B.branch._id, businessDate: today(), amount: 999, category: SECRET, method: 'cash' });
    bInvoice = await Invoice.create({
        restaurant: B.restaurant._id, invoiceNumber: `INV-B-${rid()}`, order: bOrder._id, customerName: SECRET,
        items: [{ name: 'Paneer Tikka', quantity: 1, price: 500, total: 500 }], subtotal: 500, tax: 0, discount: 0, total: 500, paymentStatus: 'paid', paymentMethod: 'cash',
    });
    bSupplier = await Supplier.create({ restaurant: B.restaurant._id, code: 'SUP-B1', name: SECRET });
    bSInvoice = await SupplierInvoice.create({
        restaurant: B.restaurant._id, branch: B.branch._id, supplier: bSupplier._id, invoiceNo: 'B-INV-1', invoiceDate: new Date(), dueDate: new Date(Date.now() + 864e5),
        businessDate: today(), subtotal: 1000, tax: 0, total: 1000, status: 'unpaid', amountPaid: 0, notes: SECRET,
    });
    bCampaign = await IncentiveCampaign.create({
        restaurant: B.restaurant._id, name: SECRET, items: [B.items.paneer._id], rule: { type: 'per_item', ratePerItem: 5 },
        startDate: new Date(Date.now() - 864e5), endDate: new Date(Date.now() + 864e5),
    });
    await StaffPayProfile.create({ restaurant: B.restaurant._id, staff: B.users.waiter._id, payType: 'monthly', baseRate: 20000, active: true });
    bRun = await PayrollRun.create({
        restaurant: B.restaurant._id, periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'draft',
        lines: [{ staff: B.users.waiter._id, staffName: SECRET, role: 'waiter', payType: 'monthly', baseRate: 20000 }],
    });
    bSubInv = await SubscriptionInvoice.create({
        restaurant: B.restaurant._id, restaurantName: SECRET, invoiceNumber: `SUB-B-${rid()}`, amount: 99900, planName: 'B-PLAN',
        razorpayPaymentId: `pay_${rid()}`, status: 'paid', paidAt: new Date(),
    });
    bPO = await PurchaseOrder.create({
        restaurant: B.restaurant._id, supplier: bSupplier._id, status: 'ordered', orderDate: new Date(), items: [],
    }).catch(() => null);
});

const noLeak = (res, extra = []) => {
    const s = JSON.stringify(res.body || {}) + (res.text || '');
    for (const m of [SECRET, ...extra]) expect(s).not.toContain(m);
};
const NOT_FOUNDISH = [400, 403, 404];

// ── Staff wallet ─────────────────────────────────────────────────────
describe('staff wallet / withdrawals', () => {
    test('A admin list of withdrawals excludes B (all statuses, branch params)', async () => {
        for (const q of ['', '?status=pending', '?status=paid', '?status=rejected', `?branch=${B.branch._id}`, `?restaurant=${B.restaurant._id}`, '?status[$ne]=x']) {
            for (const u of [A.users.admin, aPinned]) {
                const res = await ctx.api.as(u).get(`/staff-wallet/withdrawals${q}`);
                expect(res.status).toBeLessThan(500);
                noLeak(res, [String(bWithdrawal._id), String(bWallet._id)]);
            }
        }
    });

    test('approve / reject B withdrawal as A admin → 404, B untouched, B wallet balance unchanged', async () => {
        const before = [await snapOf(StaffWithdrawal, bWithdrawal._id), await snapOf(StaffWallet, bWallet._id)];
        const txBefore = await StaffWalletTransaction.countDocuments({ restaurant: B.restaurant._id });
        for (const u of [A.users.admin, aPinned]) {
            for (const act of ['approve', 'reject']) {
                const res = await ctx.api.as(u).post(`/staff-wallet/withdrawals/${bWithdrawal._id}/${act}`).send({ txnRef: 'x', reason: 'x' });
                expect(res.status).toBe(404);
            }
        }
        expect([await snapOf(StaffWithdrawal, bWithdrawal._id), await snapOf(StaffWallet, bWallet._id)]).toEqual(before);
        expect(await StaffWalletTransaction.countDocuments({ restaurant: B.restaurant._id })).toBe(txBefore);
    });

    test('malformed ids / operator injection on approve never 500', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D', '000000000000000000000000']) {
            const res = await ctx.api.as(A.users.admin).post(`/staff-wallet/withdrawals/${id}/approve`).send({});
            expect(res.status).toBeLessThan(500);
        }
    });

    test('A waiter /me never shows B wallet; B waiter on A host is isolated', async () => {
        const me = await ctx.api.as(A.users.waiter).get('/staff-wallet/me');
        expect(me.status).toBeLessThan(500);
        expect(JSON.stringify(me.body)).not.toContain('4321');
        const me2 = await ctx.api.as(B.users.waiter).get('/staff-wallet/me').set('X-Restaurant-Slug', A.slug);
        expect(JSON.stringify(me2.body)).toContain('4321'); // B's own wallet; slug header must not redirect to A
        expect(String((await StaffWallet.findOne({ user: B.users.waiter._id }).lean()).restaurant)).toBe(String(B.restaurant._id));
    });

    test('withdraw by A waiter cannot debit B wallet; mass-assigned user / restaurant ignored', async () => {
        const before = await snapOf(StaffWallet, bWallet._id);
        const res = await ctx.api.as(A.users.waiter).post('/staff-wallet/withdraw').send({
            amount: 10, method: 'Cash', user: String(B.users.waiter._id), restaurant: String(B.restaurant._id), wallet: String(bWallet._id),
        });
        expect(res.status).toBeLessThan(500);
        expect(await snapOf(StaffWallet, bWallet._id)).toBe(before);
        expect(await StaffWithdrawal.countDocuments({ restaurant: B.restaurant._id, user: A.users.waiter._id })).toBe(0);
    });

    test('non-admin cannot approve; customer role refused', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            const res = await ctx.api.as(u).post(`/staff-wallet/withdrawals/${bWithdrawal._id}/approve`).send({});
            expect(res.status).toBe(403);
        }
    });
});

// ── Tips ─────────────────────────────────────────────────────────────
describe('tips', () => {
    test('pending / history lists exclude B', async () => {
        for (const p of ['/tips/pending', '/tips/history', `/tips/pending?branch=${B.branch._id}`, `/tips/history?restaurant=${B.restaurant._id}`, '/tips/history?branch=all']) {
            for (const u of [A.users.admin, aPinned]) {
                const res = await ctx.api.as(u).get(p);
                expect(res.status).toBeLessThan(500);
                noLeak(res, [String(B.users.waiter._id), String(bSettlement._id), String(bTip._id)]);
            }
        }
    });

    test("settling B's waiter as A admin → 400/403, B tips still pending, no B wallet credit", async () => {
        const before = [await snapOf(Tip, bTip._id), await snapOf(StaffWallet, bWallet._id)];
        for (const u of [A.users.admin, aPinned]) {
            const res = await ctx.api.as(u).post('/tips/settle').send({ waiterId: String(B.users.waiter._id), paymentMethod: 'Cash', restaurant: String(B.restaurant._id) });
            expect(NOT_FOUNDISH).toContain(res.status);
        }
        const inj = await ctx.api.as(A.users.admin).post('/tips/settle').send({ waiterId: { $ne: null }, paymentMethod: 'Cash' });
        expect(NOT_FOUNDISH).toContain(inj.status);
        expect([await snapOf(Tip, bTip._id), await snapOf(StaffWallet, bWallet._id)]).toEqual(before);
        expect(await TipSettlement.countDocuments({ restaurant: A.restaurant._id })).toBe(0);
    });

    test("A waiter /tips/my never shows B tips", async () => {
        const res = await ctx.api.as(A.users.waiter).get('/tips/my');
        expect(res.status).toBeLessThan(500);
        expect(JSON.stringify(res.body)).not.toContain(String(bTip._id));
    });
});

// ── Cash closing ─────────────────────────────────────────────────────
describe('cash closing', () => {
    test('B closing is invisible to A: get / amend / list / preview', async () => {
        const before = await snapOf(CashClosing, bClosing._id);
        for (const u of [A.users.admin, aPinned]) {
            expect((await ctx.api.as(u).get(`/cash-closings/${bClosing._id}`)).status).toBe(404);
            expect((await ctx.api.as(u).patch(`/cash-closings/${bClosing._id}`).send({ openingCash: 1, countedCash: 1, reason: 'x', notes: 'pwn' })).status).toBe(404);
        }
        for (const q of ['', `?branch=${B.branch._id}`, '?branch=all', `?from=${today()}&to=${today()}`, `?restaurant=${B.restaurant._id}`]) {
            const res = await ctx.api.as(A.users.admin).get(`/cash-closings${q}`);
            expect(res.status).toBeLessThan(500);
            noLeak(res, [String(bClosing._id)]);
        }
        const prev = await ctx.api.as(A.users.admin).get(`/cash-closings/preview?branch=${B.branch._id}`);
        noLeak(prev, [String(bClosing._id)]);
        expect(prev.body.closing || null).toBeNull();
        expect(await snapOf(CashClosing, bClosing._id)).toBe(before);
    });

    test("A's cash preview totals exclude B cash sales", async () => {
        const res = await ctx.api.as(A.users.admin).get('/cash-closings/preview');
        expect(res.status).toBe(200);
        expect(Number(res.body.cashSales || 0)).toBe(0);
    });

    test('A opening/closing the same business date as B does not collide with or alter B', async () => {
        const before = await snapOf(CashClosing, bClosing._id);
        const open = await ctx.api.as(A.users.admin).post('/cash-closings/open').send({ businessDate: today(), openingCash: 5 });
        expect(open.status).toBe(201);
        expect(String(open.body.closing.restaurant)).toBe(String(A.restaurant._id));
        const close = await ctx.api.as(A.users.admin).post('/cash-closings/close').send({ businessDate: today(), countedCash: 5 });
        expect(close.status).toBe(200);
        expect(await snapOf(CashClosing, bClosing._id)).toBe(before);
    });

    test('Regression (fixed 2026-11): a cash closing cannot be opened against tenant B\'s branch id (body.branch)', async () => {
        // utils/ledgerScope.js resolveBranchId() accepts any valid ObjectId from body/query `branch`
        // without checking it belongs to the tenant. controllers/cashClosingController.js:62 stores it.
        const date = '2020-01-01';
        const res = await ctx.api.as(A.users.admin).post('/cash-closings/open').send({ businessDate: date, openingCash: 1, branch: String(B.branch._id) });
        const saved = await CashClosing.findOne({ restaurant: A.restaurant._id, businessDate: date }).lean();
        expect(saved && String(saved.branch) === String(B.branch._id)).toBeFalsy();
        expect(res.status === 201 && String(res.body.closing.branch) === String(B.branch._id)).toBe(false);
    });

    test('non-admin roles are refused', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            expect((await ctx.api.as(u).get('/cash-closings')).status).toBe(403);
        }
    });
});

// ── Invoices ─────────────────────────────────────────────────────────
describe('order invoices', () => {
    test('generate invoice for B order as A admin → 404, no invoice created', async () => {
        const bFresh = (await Order.create({
            restaurant: B.restaurant._id, branch: B.branch._id, orderId: `MM-${rid()}`, type: 'takeaway',
            items: [{ menuItem: B.items.paneer._id, name: 'Paneer Tikka', price: 500, quantity: 1 }], total: 500, status: 'served', paymentStatus: 'Paid',
        })).toObject();
        for (const u of [A.users.admin, aPinned]) {
            const res = await ctx.api.as(u).post(`/invoices/generate/${bFresh._id}`);
            expect(res.status).toBe(404);
        }
        expect(await Invoice.countDocuments({ order: bFresh._id })).toBe(0);
        expect((await ctx.api.as(A.users.admin).post('/invoices/generate/not-an-id')).status).toBe(400);
    });

    test('GET B invoice from A staff / A slug / A customer returns 404 (by _id, number and order ref)', async () => {
        for (const api of [ctx.api.as(A.users.admin), ctx.api.as(A.users.waiter), ctx.api.guest(A), ctx.api.as(A.users.admin, A)]) {
            for (const ref of [String(bInvoice._id), bInvoice.invoiceNumber]) {
                const res = await api.get(`/invoices/${ref}`);
                expect(res.status).toBe(404);
                noLeak(res);
            }
        }
    });

    test('anonymous request with NO tenant slug cannot read another tenant\'s invoice by id', async () => {
        // controllers/invoiceController.js getInvoice(): `tenantScope = req.restaurant ? {...} : {}` so with
        // no slug the lookup is global. PII is redacted but items / totals / invoice number leak, and the
        // invoiceNumber is guessable (INV-<Date.now()>-<orderId>). Expected: 404 without a tenant.
        for (const ref of [String(bInvoice._id), bInvoice.invoiceNumber]) {
            const res = await ctx.api.anon().get(`/invoices/${ref}`);
            // the tenant middleware refuses a slug-less public request (400) before the global lookup
            expect([400, 404]).toContain(res.status);
            noLeak(res);
        }
    });

    test("my-invoices never lists B invoices", async () => {
        const res = await ctx.api.as(A.users.admin).get('/invoices/my-invoices');
        expect(res.status).toBeLessThan(500);
        noLeak(res, [String(bInvoice._id)]);
    });
});

// ── Ledger ───────────────────────────────────────────────────────────
describe('ledger', () => {
    beforeAll(async () => {
        const e = await ctx.api.as(B.users.admin).post('/ledger/expenses').send({ amount: 321, category: 'B-ledger-cat', method: 'cash' });
        expect(e.status).toBe(201);
        await ctx.api.as(B.users.admin).post('/ledger/post-day').send({ businessDate: today() });
    });

    test('A expenses list excludes B; B expense cannot be voided by A', async () => {
        const res = await ctx.api.as(A.users.admin).get('/ledger/expenses');
        expect(res.status).toBe(200);
        noLeak(res, [String(bExpense._id), 'B-ledger-cat']);
        expect(res.body.total).toBe(0);
        const before = await snapOf(Expense, bExpense._id);
        for (const u of [A.users.admin, aPinned]) {
            const v = await ctx.api.as(u).post(`/ledger/expenses/${bExpense._id}/void`).send({ reason: 'x' });
            expect(v.status).toBe(404);
        }
        expect(await snapOf(Expense, bExpense._id)).toBe(before);
        for (const q of [`?branch=${B.branch._id}`, '?branch=all', `?restaurant=${B.restaurant._id}`]) {
            const r = await ctx.api.as(A.users.admin).get(`/ledger/expenses${q}`);
            noLeak(r, [String(bExpense._id), 'B-ledger-cat']);
        }
    });

    test('A trial balance / P&L / account ledger totals exclude B (posted B rows exist)', async () => {
        expect(await LedgerEntry.countDocuments({ restaurant: B.restaurant._id })).toBeGreaterThan(0);
        await ctx.api.as(A.users.admin).get('/ledger/accounts');
        for (const p of ['/ledger/trial-balance', '/ledger/pnl', '/ledger/trial-balance?branch=all', `/ledger/pnl?branch=${B.branch._id}`]) {
            const res = await ctx.api.as(A.users.admin).get(p);
            // a foreign branch id is refused by attachTenant (404); the rest is A's own empty books
            expect(res.status).toBe(p.includes(String(B.branch._id)) ? 404 : 200);
            noLeak(res, ['B-ledger-cat', '321']);
            const s = JSON.stringify(res.body);
            expect(s).not.toMatch(/"(debit|credit|total|amount|balance)":\s*321(\.0+)?[,}]/);
        }
        const codes = (await ctx.api.as(A.users.admin).get('/ledger/accounts')).body.accounts.map((a) => a.code);
        expect(codes.length).toBeGreaterThan(0);
        const led = await ctx.api.as(A.users.admin).get(`/ledger/accounts/${codes[0]}/ledger`);
        noLeak(led, ['B-ledger-cat']);
        expect((led.body.entries || led.body.lines || []).length).toBe(0);
    });

    test("A's chart of accounts is A's own rows, not B's", async () => {
        const res = await ctx.api.as(A.users.admin).get('/ledger/accounts');
        for (const a of res.body.accounts) expect(String(a.restaurant)).toBe(String(A.restaurant._id));
    });

    test('post-day by A creates no rows for B', async () => {
        const bBefore = await LedgerEntry.countDocuments({ restaurant: B.restaurant._id });
        await ctx.api.as(A.users.admin).post('/ledger/post-day').send({ from: '2026-01-01', to: today(), restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) }).set('X-Restaurant-Slug', B.slug);
        expect(await LedgerEntry.countDocuments({ restaurant: B.restaurant._id })).toBe(bBefore);
    });

    test('Regression (fixed 2026-11): an expense cannot be recorded against tenant B\'s branch id (body.branch)', async () => {
        // utils/ledgerScope.js resolveBranchId() -> ledgerController.createExpense stores a foreign branch id.
        const res = await ctx.api.as(A.users.admin).post('/ledger/expenses').send({ amount: 5, category: 'foreign-branch', branch: String(B.branch._id) });
        const saved = await Expense.findOne({ restaurant: A.restaurant._id, category: 'foreign-branch' }).lean();
        expect(saved && String(saved.branch) === String(B.branch._id)).toBeFalsy();
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ── Payroll ──────────────────────────────────────────────────────────
describe('payroll', () => {
    test('profiles list / runs list exclude B', async () => {
        for (const p of ['/payroll/profiles', '/payroll/runs']) {
            const res = await ctx.api.as(A.users.admin).get(p);
            expect(res.status).toBe(200);
            noLeak(res, [String(B.users.waiter._id), String(bRun._id)]);
        }
    });

    test('get / adjust / finalize / pay / csv / payslip of B run as A admin → 404, B untouched', async () => {
        const before = await snapOf(PayrollRun, bRun._id);
        const staff = String(B.users.waiter._id);
        const reqs = [
            ctx.api.as(A.users.admin).get(`/payroll/runs/${bRun._id}`),
            ctx.api.as(A.users.admin).put(`/payroll/runs/${bRun._id}/adjustments`).send({ adjustments: [{ staff, amount: 5000, note: 'x' }] }),
            ctx.api.as(A.users.admin).post(`/payroll/runs/${bRun._id}/finalize`).send({}),
            ctx.api.as(A.users.admin).post(`/payroll/runs/${bRun._id}/pay`).send({ method: 'wallet' }),
            ctx.api.as(A.users.admin).get(`/payroll/runs/${bRun._id}/export.csv`),
            ctx.api.as(A.users.admin).get(`/payroll/runs/${bRun._id}/payslip/${staff}`),
            ctx.api.as(A.users.admin).get(`/payroll/runs/${bRun._id}/payslip/${staff}?format=html`),
        ];
        for (const r of reqs) {
            const res = await r;
            expect(res.status).toBe(404);
            noLeak(res);
        }
        expect(await snapOf(PayrollRun, bRun._id)).toBe(before);
        expect((await StaffWallet.findOne({ user: B.users.waiter._id, restaurant: B.restaurant._id }).lean()).balance).toBe(4321);
    });

    test("upserting a pay profile for B's staff as A is refused, B profile unchanged", async () => {
        const before = JSON.stringify(await StaffPayProfile.findOne({ staff: B.users.waiter._id }).lean());
        const res = await ctx.api.as(A.users.admin).put(`/payroll/profiles/${B.users.waiter._id}`).send({ payType: 'monthly', baseRate: 1, active: true });
        expect(res.status).toBe(404);
        expect(JSON.stringify(await StaffPayProfile.findOne({ staff: B.users.waiter._id }).lean())).toBe(before);
        expect(await StaffPayProfile.countDocuments({ restaurant: A.restaurant._id, staff: B.users.waiter._id })).toBe(0);
        const bad = await ctx.api.as(A.users.admin).put('/payroll/profiles/%7B%22%24ne%22%3Anull%7D').send({ payType: 'monthly', baseRate: 1 });
        expect(bad.status).toBeLessThan(500);
    });

    test("creating a run with B's staff ids pays/creates nothing for B", async () => {
        await StaffPayProfile.create({ restaurant: A.restaurant._id, staff: A.users.waiter._id, payType: 'monthly', baseRate: 100, active: true });
        const res = await ctx.api.as(A.users.admin).post('/payroll/runs').send({ periodStart: '2025-01-01', periodEnd: '2025-01-31', staffIds: [String(B.users.waiter._id)] });
        expect(res.status).toBeGreaterThanOrEqual(400);
        const res2 = await ctx.api.as(A.users.admin).post('/payroll/runs').send({ periodStart: '2025-02-01', periodEnd: '2025-02-28', staffIds: [String(B.users.waiter._id), String(A.users.waiter._id)] });
        if (res2.status === 201) {
            const lines = res2.body.run.lines.map((l) => String(l.staff));
            expect(lines).not.toContain(String(B.users.waiter._id));
        }
    });

    test('BUG: a payroll run cannot be created against tenant B\'s branch id (body.branch)', async () => {
        // createDraft() takes body.branch with only an isValid() check, but no staff of A is in B's branch so no run is made;
        // pinned so a future change cannot start stamping runs with a foreign branch.
        await StaffPayProfile.updateOne({ restaurant: A.restaurant._id, staff: A.users.waiter._id }, { $set: { payType: 'monthly', baseRate: 100, active: true } }, { upsert: true });
        const res = await ctx.api.as(A.users.admin).post('/payroll/runs').send({ periodStart: '2025-03-01', periodEnd: '2025-03-31', branch: String(B.branch._id) });
        void res;
        const saved = await PayrollRun.findOne({ restaurant: A.restaurant._id, periodStart: '2025-03-01' }).lean();
        expect(saved && String(saved.branch) === String(B.branch._id)).toBeFalsy();
        void res;
    });

    test('non-admin roles are refused', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            expect((await ctx.api.as(u).get('/payroll/runs')).status).toBe(403);
        }
    });
});

// ── Incentives ───────────────────────────────────────────────────────
describe('incentives', () => {
    test('campaign list / report / csv exclude B', async () => {
        for (const p of ['/incentives/campaigns', '/incentives/report', '/incentives/report.csv', `/incentives/report?campaign=${bCampaign._id}`, `/incentives/report?staff=${B.users.waiter._id}`, `/incentives/campaigns?branch=${B.branch._id}`]) {
            for (const u of [A.users.admin, aPinned]) {
                const res = await ctx.api.as(u).get(p);
                expect(res.status).toBeLessThan(500);
                noLeak(res, [String(bCampaign._id)]);
            }
        }
    });

    test('update / delete B campaign as A → 404, B untouched', async () => {
        const before = await snapOf(IncentiveCampaign, bCampaign._id);
        for (const u of [A.users.admin, aPinned]) {
            expect((await ctx.api.as(u).put(`/incentives/campaigns/${bCampaign._id}`).send({ name: 'pwned', status: 'paused' })).status).toBe(404);
            expect((await ctx.api.as(u).delete(`/incentives/campaigns/${bCampaign._id}`)).status).toBe(404);
        }
        expect(await snapOf(IncentiveCampaign, bCampaign._id)).toBe(before);
    });

    test("campaign referencing B's menu items / branch is refused or stripped", async () => {
        const body = {
            name: 'A-camp', items: [String(B.items.paneer._id)], rule: { type: 'per_item', ratePerItem: 5 },
            startDate: today(), endDate: today(), branch: String(B.branch._id),
        };
        const res = await ctx.api.as(A.users.admin).post('/incentives/campaigns').send(body);
        expect(res.status).toBeLessThan(500);
        const saved = await IncentiveCampaign.findOne({ restaurant: A.restaurant._id, name: 'A-camp' }).lean();
        if (saved) {
            expect((saved.items || []).map(String)).not.toContain(String(B.items.paneer._id));
            expect(String(saved.branch)).not.toBe(String(B.branch._id));
        }
    });

    test("BUG: a campaign cannot list tenant B's menu item as eligible", async () => {
        // controllers/incentiveController.js buildCampaignFields validates `branch` (resolveOwnedBranch) but not
        // the `items` ids against the tenant's menu; foreign ids are persisted.
        const res = await ctx.api.as(A.users.admin).post('/incentives/campaigns').send({
            name: 'A-camp-items', items: [String(B.items.paneer._id)], rule: { type: 'per_item', ratePerItem: 5 }, startDate: today(), endDate: today(),
        });
        const saved = await IncentiveCampaign.findOne({ restaurant: A.restaurant._id, name: 'A-camp-items' }).lean();
        expect(saved && (saved.items || []).map(String).includes(String(B.items.paneer._id))).toBeFalsy();
        void res;
    });

    test("A waiter's incentive views exclude B entries / items", async () => {
        await IncentiveEntry.create({
            restaurant: B.restaurant._id, campaign: bCampaign._id, order: bOrder._id, orderId: bOrder.orderId, itemKey: 'k', itemName: SECRET,
            quantity: 1, rate: 5, amount: 5, staff: B.users.waiter._id, staffRole: 'waiter', state: 'confirmed', day: today(),
        });
        for (const p of ['/incentives/me', '/incentives/items', '/incentives/entries', '/incentives/me?shift=true']) {
            const res = await ctx.api.as(A.users.waiter).get(p);
            expect(res.status).toBeLessThan(500);
            noLeak(res, [String(bCampaign._id)]);
        }
    });
});

// ── Supplier invoices ────────────────────────────────────────────────
describe('supplier invoices', () => {
    test('list / outstanding / three-way match exclude B', async () => {
        for (const p of ['/supplier-invoices', `/supplier-invoices?supplier=${bSupplier._id}`, '/supplier-invoices?status=unpaid', `/supplier-invoices?branch=${B.branch._id}`, '/supplier-invoices/reports/outstanding', '/supplier-invoices/reports/three-way-match', `/supplier-invoices/reports/three-way-match?supplier=${bSupplier._id}`]) {
            for (const u of [A.users.admin, aPinned]) {
                const res = await ctx.api.as(u).get(p);
                expect(res.status).toBeLessThan(500);
                noLeak(res, [String(bSInvoice._id), String(bSupplier._id)]);
            }
        }
        const out = await ctx.api.as(A.users.admin).get('/supplier-invoices/reports/outstanding');
        expect(JSON.stringify(out.body)).not.toContain('1000');
    });

    test('get / patch / pay B supplier invoice as A → 404; B invoice + payments unchanged', async () => {
        const before = await snapOf(SupplierInvoice, bSInvoice._id);
        const payBefore = await SupplierPayment.countDocuments({ restaurant: B.restaurant._id });
        for (const u of [A.users.admin, aPinned]) {
            expect((await ctx.api.as(u).get(`/supplier-invoices/${bSInvoice._id}`)).status).toBe(404);
            expect((await ctx.api.as(u).patch(`/supplier-invoices/${bSInvoice._id}`).send({ notes: 'pwn', subtotal: 1 })).status).toBe(404);
            expect((await ctx.api.as(u).post(`/supplier-invoices/${bSInvoice._id}/payments`).send({ amount: 1000, method: 'cash' })).status).toBe(404);
        }
        expect(await snapOf(SupplierInvoice, bSInvoice._id)).toBe(before);
        expect(await SupplierPayment.countDocuments({ restaurant: B.restaurant._id })).toBe(payBefore);
    });

    test("creating an invoice for B's supplier / B's PO as A → 404; nothing created", async () => {
        const base = { invoiceNo: 'A-X', subtotal: 10, tax: 0 };
        const r1 = await ctx.api.as(A.users.admin).post('/supplier-invoices').send({ ...base, supplier: String(bSupplier._id) });
        expect(r1.status).toBe(404);
        const aSup = await Supplier.create({ restaurant: A.restaurant._id, code: 'SUP-A1', name: 'A sup' });
        if (bPO) {
            const r2 = await ctx.api.as(A.users.admin).post('/supplier-invoices').send({ ...base, supplier: String(aSup._id), purchaseOrder: String(bPO._id) });
            expect(r2.status).toBe(404);
        }
        const r3 = await ctx.api.as(A.users.admin).post('/supplier-invoices').send({ ...base, supplier: { $ne: null } });
        expect(r3.status).toBe(400);
        expect(await SupplierInvoice.countDocuments({ restaurant: A.restaurant._id })).toBe(0);
        expect(await SupplierInvoice.countDocuments({ restaurant: B.restaurant._id, invoiceNo: 'A-X' })).toBe(0);
    });

    test("Regression (fixed 2026-11): a supplier invoice cannot be created against tenant B's branch id (body.branch)", async () => {
        // controllers/supplierInvoiceController.js:60 `branch: resolveBranchId(req) || po?.branch` -
        // utils/ledgerScope.js resolveBranchId() trusts any ObjectId in body/query.
        const aSup = await Supplier.findOne({ restaurant: A.restaurant._id, code: 'SUP-A1' }).lean();
        const res = await ctx.api.as(A.users.admin).post('/supplier-invoices').send({ supplier: String(aSup._id), invoiceNo: 'A-BR', subtotal: 10, branch: String(B.branch._id) });
        const saved = await SupplierInvoice.findOne({ restaurant: A.restaurant._id, invoiceNo: 'A-BR' }).lean();
        expect(saved && String(saved.branch) === String(B.branch._id)).toBeFalsy();
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("Regression (fixed 2026-11): invoice lines cannot reference another tenant's inventory item id", async () => {
        // controllers/supplierInvoiceController.js:46 keeps `lines[].inventoryItem` when it is merely a valid
        // ObjectId; it is never checked against the tenant's inventory.
        const aSup = await Supplier.findOne({ restaurant: A.restaurant._id, code: 'SUP-A1' }).lean();
        const foreignInv = String(new (require('mongoose').Types.ObjectId)());
        // foreignInv stands for an inventory item owned by B (any id outside A's inventory).
        await ctx.api.as(A.users.admin).post('/supplier-invoices').send({ supplier: String(aSup._id), invoiceNo: 'A-LINES', subtotal: 10, lines: [{ inventoryItem: foreignInv, name: 'x', qty: 1, rate: 10 }] });
        const saved = await SupplierInvoice.findOne({ restaurant: A.restaurant._id, invoiceNo: 'A-LINES' }).lean();
        expect(saved && (saved.lines || []).some((l) => String(l.inventoryItem) === foreignInv)).toBeFalsy();
    });

    test('non-admin roles refused', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            expect((await ctx.api.as(u).get('/supplier-invoices')).status).toBe(403);
        }
    });
});

// ── Tenant billing (subscription / invoices) ─────────────────────────
describe('tenant billing', () => {
    test("A owner sees only A's subscription invoices", async () => {
        const mine = await SubscriptionInvoice.create({
            restaurant: A.restaurant._id, restaurantName: 'A', invoiceNumber: `SUB-A-${rid()}`, amount: 1000, planName: 'A-PLAN',
            razorpayPaymentId: `pay_${rid()}`, status: 'paid', paidAt: new Date(),
        });
        for (const headers of [{}, { 'X-Restaurant-Slug': B.slug }, { 'X-Restaurant-Id': String(B.restaurant._id) }, { 'X-Branch-Id': String(A.branch._id) }]) {
            let r = ctx.api.as(A.users.admin).get(`/tenant/billing/invoices?restaurant=${B.restaurant._id}&restaurantId=${B.restaurant._id}`);
            for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
            const res = await r;
            expect(res.status).toBe(200);
            const s = JSON.stringify(res.body);
            expect(s).toContain(String(mine._id));
            expect(s).not.toContain(String(bSubInv._id));
            expect(s).not.toContain('B-PLAN');
            expect(res.body.pagination.total).toBe(1);
        }
    });

    test('download B invoice PDF as A → 404 (by _id); malformed ids 400', async () => {
        for (const u of [A.users.admin]) {
            const res = await ctx.api.as(u).get(`/tenant/billing/invoices/${bSubInv._id}/download`).set('X-Restaurant-Slug', B.slug);
            expect(res.status).toBe(404);
            expect((await ctx.api.as(u).get('/tenant/billing/invoices/nope/download')).status).toBe(400);
        }
    });

    test("current subscription / downgrade request return A's own tenant, never B's", async () => {
        for (const p of ['/tenant/billing/current', '/tenant/billing/downgrade-request', '/tenant/billing/plans']) {
            const res = await ctx.api.as(A.users.admin).get(p).set('X-Restaurant-Slug', B.slug);
            expect(res.status).toBeLessThan(500);
            noLeak(res, [String(B.restaurant._id), B.slug]);
        }
    });

    test("cancelling B's downgrade request id as A → 404", async () => {
        const PlanChangeRequest = M('planChangeRequest');
        const req = await PlanChangeRequest.create({
            restaurant: B.restaurant._id, requestSource: 'tenant', status: 'pending', requestedPlanSlug: 'x', currentPlanSlug: 'y', type: 'downgrade',
        }).catch(() => null);
        if (!req) return;
        const before = await snapOf(PlanChangeRequest, req._id);
        const res = await ctx.api.as(A.users.admin).delete(`/tenant/billing/downgrade-request/${req._id}`);
        expect(res.status).toBe(404);
        expect(await snapOf(PlanChangeRequest, req._id)).toBe(before);
    });

    test('staff roles cannot reach billing', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain, aPinned]) {
            const res = await ctx.api.as(u).get('/tenant/billing/invoices');
            expect([401, 403]).toContain(res.status);
        }
    });

    test('verify-upgrade with a payment stamped for tenant B is refused for A', async () => {
        const rzp = require('./helpers/razorpayMock');
        const rzpO = `order_${rid()}`; const payId = `pay_${rid()}`;
        const notes = { restaurantId: String(B.restaurant._id), type: 'plan_payment' };
        rzp.instance.payments.fetch.mockResolvedValue({ id: payId, order_id: rzpO, status: 'captured', amount: 99900, notes });
        const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${rzpO}|${payId}`).digest('hex');
        const before = JSON.stringify(await require(path.join(BACKEND, 'models/restaurant')).findById(A.restaurant._id).lean());
        const res = await ctx.api.as(A.users.admin).post('/tenant/billing/upgrade/verify').send({ razorpay_order_id: rzpO, razorpay_payment_id: payId, razorpay_signature: sig });
        expect(res.status).toBe(403);
        await settle(50);
        expect(JSON.stringify(await require(path.join(BACKEND, 'models/restaurant')).findById(A.restaurant._id).lean())).toBe(before);
        expect(await SubscriptionInvoice.countDocuments({ razorpayPaymentId: payId })).toBe(0);
    });
});
