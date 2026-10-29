const CashClosing = require('../models/cashClosing');
const { loadSources, summarizeCash } = require('../services/ledgerSources');
const { computeCash } = require('../utils/cashMath');
const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { resolveBranchId, branchClauseFor, restaurantTz, businessDateParam } = require('../utils/ledgerScope');
const { dayBounds, isValidYmd, businessDateOf } = require('../utils/businessDate');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const isMoney = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0;

function dateOrThrow(req, value) {
    const d = businessDateParam(req, value);
    if (!d) throw new AppError(400, 'INVALID_DATE', 'businessDate must be YYYY-MM-DD');
    if (d > businessDateOf(new Date(), restaurantTz(req))) throw new AppError(400, 'FUTURE_DATE', 'Cannot open or close a future business date');
    return d;
}

async function liveCash(req, businessDate, branchId) {
    const { start, end } = dayBounds(businessDate, restaurantTz(req));
    const src = await loadSources({ restaurantId: tenantId(req), start, end, branchClause: branchClauseFor(req, branchId) });
    return summarizeCash(src);
}

const dayKey = (businessDate, branchId) => ({ branch: branchId || null, businessDate });

// GET /cash-closings/preview?businessDate=&openingCash= - live expected cash, nothing saved.
exports.preview = asyncHandler(async (req, res) => {
    const businessDate = dateOrThrow(req, req.query.businessDate);
    const branchId = resolveBranchId(req);
    const existing = await CashClosing.findOne({ ...tenantFilter(req), ...dayKey(businessDate, branchId) }).lean();
    const cash = await liveCash(req, businessDate, branchId);
    const opening = existing ? existing.openingCash : (isMoney(req.query.openingCash) ? Number(req.query.openingCash) : 0);
    res.json({ success: true, businessDate, status: existing?.status || 'none', closing: existing || null, ...computeCash({ openingCash: opening, ...cash }) });
}, 'Failed to preview cash closing');

// POST /cash-closings/open { businessDate?, openingCash? } - openingCash defaults to the last closed count.
exports.open = asyncHandler(async (req, res) => {
    const businessDate = dateOrThrow(req, req.body?.businessDate);
    const branchId = resolveBranchId(req);
    let openingCash = req.body?.openingCash;
    if (openingCash === undefined || openingCash === '' || openingCash === null) {
        const prev = await CashClosing.findOne({
            ...tenantFilter(req), branch: branchId || null, status: 'closed', businessDate: { $lt: businessDate },
        }).sort({ businessDate: -1 }).lean();
        openingCash = prev?.countedCash ?? 0;
    }
    if (!isMoney(openingCash)) throw new AppError(400, 'INVALID_AMOUNT', 'openingCash must be a number of 0 or more');
    try {
        const doc = await CashClosing.create({
            restaurant: tenantId(req), branch: branchId || null, businessDate,
            status: 'open', openingCash: Number(openingCash), openedBy: req.user?._id,
        });
        res.status(201).json({ success: true, closing: doc });
    } catch (err) {
        if (err?.code === 11000) throw new AppError(409, 'ALREADY_OPENED', `${businessDate} already has a cash closing record`);
        throw err;
    }
}, 'Failed to open cash day');

// POST /cash-closings/close { businessDate?, countedCash, notes? } - expected cash is computed by the server.
exports.close = asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!isMoney(b.countedCash)) throw new AppError(400, 'INVALID_AMOUNT', 'countedCash must be a number of 0 or more');
    const businessDate = dateOrThrow(req, b.businessDate);
    const branchId = resolveBranchId(req);
    const existing = await CashClosing.findOne({ ...tenantFilter(req), ...dayKey(businessDate, branchId) }).lean();
    if (existing && existing.status === 'closed') {
        throw new AppError(409, 'ALREADY_CLOSED', `${businessDate} is already closed. An admin can amend it with a reason.`);
    }
    const cash = await liveCash(req, businessDate, branchId);
    const calc = computeCash({ openingCash: existing ? existing.openingCash : (isMoney(b.openingCash) ? Number(b.openingCash) : 0), ...cash, countedCash: b.countedCash });
    const fields = {
        ...calc, status: 'closed', notes: String(b.notes || '').slice(0, 500), closedBy: req.user?._id, closedAt: new Date(),
    };
    let doc;
    if (existing) {
        // Conditional on still being open, so two simultaneous closes cannot both win.
        doc = await CashClosing.findOneAndUpdate(
            { _id: existing._id, ...tenantFilter(req), status: 'open' }, { $set: fields }, { returnDocument: 'after' },
        );
        if (!doc) throw new AppError(409, 'ALREADY_CLOSED', `${businessDate} is already closed.`);
    } else {
        try {
            doc = await CashClosing.create({ restaurant: tenantId(req), branch: branchId || null, businessDate, openedBy: req.user?._id, ...fields });
        } catch (err) {
            if (err?.code === 11000) throw new AppError(409, 'ALREADY_CLOSED', `${businessDate} already has a cash closing record`);
            throw err;
        }
    }
    res.json({ success: true, closing: doc });
}, 'Failed to close cash day');

// PATCH /cash-closings/:id { openingCash?, countedCash?, notes?, reason }
// Open day: any admin / manager. Closed day: tenant admin role only, `reason` required, recorded in edits[].
exports.amend = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const doc = await CashClosing.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Cash closing not found');
    const closed = doc.status === 'closed';
    const reason = String(b.reason || '').trim();
    if (closed) {
        if (req.user?.role !== 'admin') throw new AppError(403, 'ADMIN_ONLY', 'Only an admin can amend a closed day');
        if (!reason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to amend a closed day');
    }
    for (const k of ['openingCash', 'countedCash']) {
        if (b[k] !== undefined && !isMoney(b[k])) throw new AppError(400, 'INVALID_AMOUNT', `${k} must be a number of 0 or more`);
    }
    const before = { openingCash: doc.openingCash, countedCash: doc.countedCash, expectedCash: doc.expectedCash, variance: doc.variance, notes: doc.notes };
    const calc = computeCash({
        openingCash: b.openingCash !== undefined ? Number(b.openingCash) : doc.openingCash,
        cashSales: doc.cashSales, cashRefunds: doc.cashRefunds, cashPaidOuts: doc.cashPaidOuts,
        countedCash: b.countedCash !== undefined ? Number(b.countedCash) : doc.countedCash,
    });
    const set = { openingCash: calc.openingCash };
    if (closed || calc.countedCash !== null) Object.assign(set, { expectedCash: calc.expectedCash, countedCash: calc.countedCash, variance: calc.variance });
    if (b.notes !== undefined) set.notes = String(b.notes).slice(0, 500);
    const update = { $set: set };
    if (closed) update.$push = { edits: { at: new Date(), by: req.user?._id, reason: reason.slice(0, 300), before, after: { ...before, ...set } } };
    const saved = await CashClosing.findOneAndUpdate(
        { _id: doc._id, ...tenantFilter(req), status: doc.status }, update, { returnDocument: 'after' },
    );
    if (!saved) throw new AppError(409, 'CONFLICT', 'The cash closing changed while you were editing it. Reload and retry.');
    res.json({ success: true, closing: saved });
}, 'Failed to amend cash closing');

// GET /cash-closings?from&to&status
exports.list = asyncHandler(async (req, res) => {
    const { from, to, status } = req.query;
    if ((from && !isValidYmd(String(from))) || (to && !isValidYmd(String(to)))) throw new AppError(400, 'INVALID_DATE', 'from / to must be YYYY-MM-DD');
    const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
    if (['open', 'closed'].includes(status)) filter.status = status;
    if (from || to) filter.businessDate = { ...(from ? { $gte: String(from) } : {}), ...(to ? { $lte: String(to) } : {}) };
    const closings = await CashClosing.find(filter).sort({ businessDate: -1 }).limit(200).lean();
    res.json({ success: true, closings });
}, 'Failed to list cash closings');

exports.getOne = asyncHandler(async (req, res) => {
    const closing = await CashClosing.findOne({ _id: req.params.id, ...tenantFilter(req) }).lean();
    if (!closing) throw new AppError(404, 'NOT_FOUND', 'Cash closing not found');
    res.json({ success: true, closing });
}, 'Failed to load cash closing');
