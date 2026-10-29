const Expense = require('../models/expense');
const LedgerAccount = require('../models/ledgerAccount');
const ledger = require('../services/ledgerService');
const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { resolveBranchId, restaurantTz, businessDateParam } = require('../utils/ledgerScope');
const { isValidYmd, businessDateOf, eachDate } = require('../utils/businessDate');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_POST_DAYS = 31;

function rangeParams(q) {
    const from = q.from ? String(q.from) : undefined;
    const to = q.to ? String(q.to) : undefined;
    if ((from && !isValidYmd(from)) || (to && !isValidYmd(to))) {
        throw new AppError(400, 'INVALID_DATE', 'from / to must be YYYY-MM-DD');
    }
    if (from && to && from > to) throw new AppError(400, 'INVALID_RANGE', 'from must not be after to');
    return { from, to };
}

// GET /ledger/accounts - the chart of accounts (created on first use).
exports.accounts = asyncHandler(async (req, res) => {
    const rid = tenantId(req);
    await ledger.ensureChart(rid);
    const accounts = await LedgerAccount.find({ restaurant: rid }).sort({ code: 1 }).lean();
    res.json({ success: true, accounts });
}, 'Failed to load chart of accounts');

// POST /ledger/post-day  { businessDate } or { from, to } (max 31 days). Idempotent.
exports.postDay = asyncHandler(async (req, res) => {
    const rid = tenantId(req);
    const body = req.body || {};
    const timeZone = restaurantTz(req);
    let from = body.from; let to = body.to;
    if (!from && !to) from = to = businessDateParam(req, body.businessDate);
    if (!isValidYmd(String(from)) || !isValidYmd(String(to || from))) {
        throw new AppError(400, 'INVALID_DATE', 'businessDate / from / to must be YYYY-MM-DD');
    }
    to = to || from;
    if (from > to) throw new AppError(400, 'INVALID_RANGE', 'from must not be after to');
    if (eachDate(from, to, MAX_POST_DAYS + 1).length > MAX_POST_DAYS) throw new AppError(400, 'RANGE_TOO_LONG', `At most ${MAX_POST_DAYS} days per request`);
    const result = await ledger.postRange(rid, from, to, { timeZone });
    res.json({ success: true, ...result });
}, 'Failed to post the day');

// GET /ledger/trial-balance?from&to&branch
exports.trialBalance = asyncHandler(async (req, res) => {
    const data = await ledger.trialBalance(tenantId(req), { ...rangeParams(req.query), branchClause: strictBranchFilter(req) });
    res.json({ success: true, ...data });
}, 'Failed to load trial balance');

// GET /ledger/accounts/:code/ledger?from&to&branch
exports.accountLedger = asyncHandler(async (req, res) => {
    const data = await ledger.accountLedger(tenantId(req), String(req.params.code), {
        ...rangeParams(req.query), branchClause: strictBranchFilter(req), limit: req.query.limit,
    });
    if (!data) throw new AppError(404, 'NOT_FOUND', 'Account not found');
    res.json({ success: true, ...data });
}, 'Failed to load account ledger');

// GET /ledger/pnl?from&to&branch
exports.pnl = asyncHandler(async (req, res) => {
    const data = await ledger.profitAndLoss(tenantId(req), { ...rangeParams(req.query), branchClause: strictBranchFilter(req) });
    res.json({ success: true, ...data });
}, 'Failed to load profit and loss');

// ── Expenses (cash pay-outs) ───────────────────────────────────────────
const METHODS = ['cash', 'upi', 'bank-transfer', 'card', 'cheque', 'other'];

exports.createExpense = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const amount = round2(b.amount);
    if (!(amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be greater than 0');
    const method = METHODS.includes(b.method) ? b.method : 'cash';
    const date = b.date ? new Date(b.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
    const branchId = resolveBranchId(req);
    const expense = await Expense.create({
        restaurant: tenantId(req),
        branch: branchId,
        businessDate: businessDateOf(date, restaurantTz(req)),
        date,
        category: String(b.category || 'General').trim().slice(0, 60) || 'General',
        amount,
        method,
        note: String(b.note || '').slice(0, 300),
        createdBy: req.user?._id,
    });
    res.status(201).json({ success: true, expense });
}, 'Failed to record expense');

exports.listExpenses = asyncHandler(async (req, res) => {
    const { from, to } = rangeParams(req.query);
    const filter = { ...tenantFilter(req), ...strictBranchFilter(req), status: 'active' };
    if (from || to) filter.businessDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const expenses = await Expense.find(filter).sort({ date: -1 }).limit(500).lean();
    res.json({ success: true, expenses, total: round2(expenses.reduce((s, e) => s + e.amount, 0)) });
}, 'Failed to list expenses');

// POST /ledger/expenses/:id/void { reason } - soft delete; already-posted ledger lines are not removed.
exports.voidExpense = asyncHandler(async (req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to void an expense');
    const expense = await Expense.findOneAndUpdate(
        { _id: req.params.id, ...tenantFilter(req), status: 'active' },
        { $set: { status: 'void', voidReason: reason.slice(0, 300) } },
        { returnDocument: 'after' },
    );
    if (!expense) throw new AppError(404, 'NOT_FOUND', 'Expense not found or already void');
    res.json({ success: true, expense });
}, 'Failed to void expense');
