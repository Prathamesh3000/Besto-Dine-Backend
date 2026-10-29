'use strict';
/**
 * Ledger-lite (Plan 3B.3): lazy chart of accounts, the idempotent "post day"
 * service and the trial balance / account ledger / P&L reads.
 *
 * Posting never edits payment flows: it reads paid orders, refunds, expenses,
 * supplier invoices / payments for a business date (services/ledgerSources.js),
 * builds balanced batches (utils/ledgerPostings.js) and upserts them by a
 * deterministic key, so running a day twice writes nothing the second time.
 * Posted lines are append-only: later changes to a source document are not
 * re-posted (a refund after posting is its own batch on its own day).
 */
const mongoose = require('mongoose');
const LedgerAccount = require('../models/ledgerAccount');
const LedgerEntry = require('../models/ledgerEntry');
const { tenantBulkWrite } = require('../utils/tenantSafe');
const { loadSources } = require('./ledgerSources');
const P = require('../utils/ledgerPostings');
const { dayBounds, eachDate, isValidYmd, safeTz } = require('../utils/businessDate');

const round2 = P.round2;
const oid = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));
const seeded = new Set();

/** Create the default chart for a tenant once (idempotent). */
async function ensureChart(restaurantId) {
    const key = String(restaurantId);
    if (seeded.has(key)) return;
    await tenantBulkWrite(LedgerAccount, P.DEFAULT_CHART.map((a) => ({
        updateOne: {
            filter: { restaurant: restaurantId, code: a.code },
            update: { $setOnInsert: { restaurant: restaurantId, ...a, isSystem: true } },
            upsert: true,
        },
    })), restaurantId, { ordered: false });
    seeded.add(key);
}

/** Every balanced posting line for one business date (pure aside from the loads). */
async function buildDayLines({ restaurantId, businessDate, timeZone, branchClause = {} }) {
    const { start, end } = dayBounds(businessDate, safeTz(timeZone));
    const src = await loadSources({ restaurantId, start, end, branchClause });
    const lines = [];
    src.tenders.forEach((t) => lines.push(...P.buildTenderPosting({ order: t.order, line: t.line, index: t.index, businessDate })));
    src.refunds.forEach((r) => lines.push(...P.buildRefundPosting({ order: r.order, refund: r.refund, index: r.index, businessDate })));
    src.expenses.forEach((expense) => lines.push(...P.buildExpensePosting({ expense, businessDate })));
    src.invoices.forEach((invoice) => lines.push(...P.buildInvoicePosting({ invoice, businessDate })));
    src.supplierPayments.forEach((payment) => lines.push(...P.buildSupplierPaymentPosting({ payment, businessDate })));
    src.poPayments.forEach(({ po, payment }) => lines.push(...P.buildPoPaymentPosting({ po, payment, businessDate })));
    return lines;
}

/** Upsert lines by key. Returns { inserted, skipped }. */
async function writeLines(restaurantId, lines) {
    if (!lines.length) return { inserted: 0, skipped: 0 };
    const postedAt = new Date();
    const ops = lines.map((l) => ({
        updateOne: {
            filter: { restaurant: restaurantId, key: l.key },
            update: {
                $setOnInsert: {
                    restaurant: restaurantId,
                    branch: l.branch ? oid(l.branch) : null,
                    businessDate: l.businessDate,
                    account: l.account,
                    debit: l.debit,
                    credit: l.credit,
                    ref: { type: l.refType, id: l.refId },
                    narration: l.narration,
                    key: l.key,
                    postedAt,
                },
            },
            upsert: true,
        },
    }));
    let inserted = 0;
    try {
        const res = await tenantBulkWrite(LedgerEntry, ops, restaurantId, { ordered: false });
        inserted = res.upsertedCount ?? 0;
    } catch (err) {
        // A concurrent run won the unique-key race for some lines: that is fine.
        const errs = err?.writeErrors || err?.result?.getWriteErrors?.() || [];
        const onlyDup = errs.length > 0 && errs.every((e) => (e.code ?? e.err?.code) === 11000);
        if (!onlyDup) throw err;
        inserted = err?.result?.upsertedCount ?? err?.result?.nUpserted ?? 0;
    }
    return { inserted, skipped: lines.length - inserted };
}

/** Post one business date for a tenant. Idempotent. */
async function postDay(restaurantId, businessDate, { timeZone, branchClause } = {}) {
    if (!isValidYmd(businessDate)) throw new Error('businessDate must be YYYY-MM-DD');
    await ensureChart(restaurantId);
    const lines = await buildDayLines({ restaurantId, businessDate, timeZone, branchClause });
    P.assertBalanced(lines);
    const { inserted, skipped } = await writeLines(restaurantId, lines);
    return { businessDate, lines: lines.length, inserted, skipped };
}

/** Post an inclusive date range (max 62 days). */
async function postRange(restaurantId, from, to, opts = {}) {
    const days = [];
    for (const d of eachDate(from, to)) days.push(await postDay(restaurantId, d, opts));
    return {
        days,
        lines: days.reduce((s, d) => s + d.lines, 0),
        inserted: days.reduce((s, d) => s + d.inserted, 0),
        skipped: days.reduce((s, d) => s + d.skipped, 0),
    };
}

function dateMatch(from, to) {
    const m = {};
    if (from) m.$gte = from;
    if (to) m.$lte = to;
    return Object.keys(m).length ? { businessDate: m } : {};
}

async function chartMap(restaurantId) {
    await ensureChart(restaurantId);
    const accounts = await LedgerAccount.find({ restaurant: restaurantId }).sort({ code: 1 }).lean();
    return { accounts, byCode: new Map(accounts.map((a) => [a.code, a])) };
}

const naturalBalance = (type, debit, credit) => round2(['asset', 'expense'].includes(type) ? debit - credit : credit - debit);

/** Trial balance: per-account debit / credit totals for the period; debits equal credits. */
async function trialBalance(restaurantId, { from, to, branchClause = {} } = {}) {
    const { accounts } = await chartMap(restaurantId);
    const sums = await LedgerEntry.aggregate([
        { $match: { restaurant: oid(restaurantId), ...dateMatch(from, to), ...branchClause } },
        { $group: { _id: '$account', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const by = new Map(sums.map((s) => [s._id, s]));
    const rows = accounts.map((a) => {
        const s = by.get(a.code) || { debit: 0, credit: 0 };
        const debit = round2(s.debit);
        const credit = round2(s.credit);
        return { code: a.code, name: a.name, type: a.type, debit, credit, balance: naturalBalance(a.type, debit, credit) };
    });
    const totals = {
        debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
        credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
    };
    return { from: from || null, to: to || null, rows, totals, balanced: Math.abs(totals.debit - totals.credit) < 0.01 };
}

/** One account's entries with a running balance (opening balance = everything before `from`). */
async function accountLedger(restaurantId, code, { from, to, branchClause = {}, limit = 1000 } = {}) {
    const { byCode } = await chartMap(restaurantId);
    const account = byCode.get(code);
    if (!account) return null;
    let opening = 0;
    if (from) {
        const [o] = await LedgerEntry.aggregate([
            { $match: { restaurant: oid(restaurantId), account: code, businessDate: { $lt: from }, ...branchClause } },
            { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
        ]);
        if (o) opening = naturalBalance(account.type, o.debit, o.credit);
    }
    const entries = await LedgerEntry.find({
        restaurant: restaurantId, account: code, ...dateMatch(from, to), ...branchClause,
    }).sort({ businessDate: 1, postedAt: 1, _id: 1 }).limit(Math.min(Number(limit) || 1000, 5000)).lean();
    let running = opening;
    const rows = entries.map((e) => {
        running = round2(running + naturalBalance(account.type, e.debit, e.credit));
        return {
            _id: e._id, businessDate: e.businessDate, debit: e.debit, credit: e.credit,
            narration: e.narration, ref: e.ref, branch: e.branch, balance: running,
        };
    });
    return { account: { code: account.code, name: account.name, type: account.type }, openingBalance: opening, closingBalance: running, entries: rows };
}

/** Simple P&L from the ledger: income - purchases/COGS - other expenses. */
async function profitAndLoss(restaurantId, { from, to, branchClause = {} } = {}) {
    const tb = await trialBalance(restaurantId, { from, to, branchClause });
    const income = tb.rows.filter((r) => r.type === 'income' && (r.debit || r.credit));
    const cogsRow = tb.rows.find((r) => r.code === P.ACCOUNTS.PURCHASES);
    const expenses = tb.rows.filter((r) => r.type === 'expense' && r.code !== P.ACCOUNTS.PURCHASES && (r.debit || r.credit));
    const totalIncome = round2(income.reduce((s, r) => s + r.balance, 0));
    const cogs = round2(cogsRow ? cogsRow.balance : 0);
    const totalExpenses = round2(expenses.reduce((s, r) => s + r.balance, 0));
    const grossProfit = round2(totalIncome - cogs);
    return {
        from: from || null, to: to || null,
        income, totalIncome,
        cogs, grossProfit,
        expenses, totalExpenses,
        netProfit: round2(grossProfit - totalExpenses),
        note: 'Sales are net of GST. COGS = purchases booked from supplier invoices / PO payments (cash basis, no stock-movement adjustment).',
    };
}

module.exports = {
    ensureChart, buildDayLines, writeLines, postDay, postRange, trialBalance, accountLedger, profitAndLoss, _resetSeeded: () => seeded.clear(),
};
