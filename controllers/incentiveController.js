/**
 * Incentives API (CAPTAIN_FLOW §8-9). Mounted at /api/v1/incentives.
 *
 *   Staff (captain / waiter) - own figures only, enforced by always
 *   filtering on req.user._id:
 *     GET /me       summary (totals, today, per-item)
 *     GET /items    eligible items + campaign status
 *     GET /entries  own ledger rows, paginated
 *
 *   Admin / permitted manager (permission `incentives`):
 *     GET|POST /campaigns, PUT|DELETE /campaigns/:id
 *     GET /report, GET /report.csv
 *
 * All routes sit behind featureGate('incentives') (FEATURE_LOCKED / _REVOKED).
 */
const mongoose = require('mongoose');
const IncentiveCampaign = require('../models/incentiveCampaign');
const IncentiveEntry = require('../models/incentiveEntry');
const MenuItem = require('../models/menuItem');
const Shift = require('../models/shift');
const User = require('../models/user');
const Branch = require('../models/branch');
const logger = require('../utils/logger');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { resolveOwnedBranch } = require('../utils/branchOwnership');
const svc = require('../services/incentiveService');

const isBlank = (v) => v === null || v === undefined || v === '';
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const tzOf = (req) => svc.safeTz(req.restaurant?.timezone);

const fail = (res, status, message, code) =>
    res.status(status).json({ success: false, ...(code ? { code } : {}), message });

// --- date helpers ----------------------------------------------------------
/** Parse ?from / ?to (YYYY-MM-DD). Defaults to today. Returns {from,to} or {error}. */
function dayRange(req) {
    const today = svc.dayKey(new Date(), tzOf(req));
    const from = isBlank(req.query.from) ? (isBlank(req.query.to) ? today : req.query.to) : req.query.from;
    const to = isBlank(req.query.to) ? (isBlank(req.query.from) ? today : req.query.from) : req.query.to;
    if (!svc.isDayString(from) || !svc.isDayString(to)) return { error: 'from / to must be dates formatted YYYY-MM-DD' };
    if (to < from) return { error: 'to cannot be before from' };
    if ((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 > 366) return { error: 'Date range cannot exceed 366 days' };
    return { from, to, today };
}

/** Staff may narrow by their active/latest shift instead of by day. */
async function shiftWindow(req) {
    const shift = await Shift.findOne({ staff: req.user._id, ...tenantFilter(req) }).sort({ clockIn: -1 }).lean();
    if (!shift) return null;
    return { id: shift._id, clockIn: shift.clockIn, clockOut: shift.clockOut || null, status: shift.status };
}

function sumByState(rows) {
    const t = { estimated: 0, confirmed: 0, pending: 0, reversed: 0 };
    for (const r of rows) {
        const amt = money(r.amount);
        if (r._id === 'confirmed') t.confirmed += amt;
        else if (r._id === 'pending') t.pending += amt;
        else if (r._id === 'reversed') t.reversed += amt;
    }
    t.estimated = t.confirmed + t.pending;
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)]));
}

// AUDIT-EXEMPT: every caller passes a match built from tenantFilter(req) (getMyIncentives base, reportMatch); aggregate needs the ObjectId form, so it is set by the caller
const stateGroup = (match) => IncentiveEntry.aggregate([
    { $match: match },
    { $group: { _id: '$state', amount: { $sum: '$amount' }, quantity: { $sum: '$quantity' } } },
]);

// --- staff -----------------------------------------------------------------
exports.getMyIncentives = async (req, res) => {
    try {
        const range = dayRange(req);
        if (range.error) return fail(res, 400, range.error);
        const base = { ...tenantFilter(req), staff: req.user._id };
        let match = { ...base, day: { $gte: range.from, $lte: range.to } };
        let shift = null;
        if (String(req.query.shift) === 'true') {
            shift = await shiftWindow(req);
            match = { ...base, createdAt: shift
                ? { $gte: shift.clockIn, ...(shift.clockOut ? { $lte: shift.clockOut } : {}) }
                : { $gte: new Date(0), $lt: new Date(0) } };
        }
        const [totals, today, items] = await Promise.all([
            stateGroup(match),
            stateGroup({ ...base, day: range.today }),
            IncentiveEntry.aggregate([
                { $match: match },
                { $group: {
                    _id: { menuItem: '$menuItem', campaign: '$campaign', rate: '$rate' },
                    name: { $first: '$itemName' },
                    quantity: { $sum: { $cond: [{ $ne: ['$state', 'reversed'] }, '$quantity', 0] } },
                    confirmedQty: { $sum: { $cond: [{ $eq: ['$state', 'confirmed'] }, '$quantity', 0] } },
                    pendingQty: { $sum: { $cond: [{ $eq: ['$state', 'pending'] }, '$quantity', 0] } },
                    reversedQty: { $sum: { $cond: [{ $eq: ['$state', 'reversed'] }, '$quantity', 0] } },
                    amount: { $sum: { $cond: [{ $ne: ['$state', 'reversed'] }, '$amount', 0] } },
                    confirmedAmount: { $sum: { $cond: [{ $eq: ['$state', 'confirmed'] }, '$amount', 0] } },
                    pendingAmount: { $sum: { $cond: [{ $eq: ['$state', 'pending'] }, '$amount', 0] } },
                } },
                { $sort: { amount: -1 } },
            ]),
        ]);
        const campaignIds = [...new Set(items.map((i) => String(i._id.campaign)))];
        const camps = await IncentiveCampaign.find({ _id: { $in: campaignIds }, ...tenantFilter(req) }).select('name').lean();
        const campName = new Map(camps.map((c) => [String(c._id), c.name]));
        return res.status(200).json({
            success: true,
            range: { from: range.from, to: range.to, today: range.today },
            shift,
            totals: sumByState(totals),
            today: sumByState(today),
            byItem: items.map((i) => ({
                menuItem: i._id.menuItem, name: i.name, campaign: i._id.campaign,
                campaignName: campName.get(String(i._id.campaign)) || '',
                rate: i._id.rate, quantity: i.quantity, confirmedQty: i.confirmedQty,
                pendingQty: i.pendingQty, reversedQty: i.reversedQty,
                amount: money(i.amount), confirmedAmount: money(i.confirmedAmount), pendingAmount: money(i.pendingAmount),
            })),
        });
    } catch (err) {
        logger.error('getMyIncentives failed', { error: err.message });
        return fail(res, 500, 'Failed to load incentives');
    }
};

exports.getEligibleItems = async (req, res) => {
    try {
        const now = new Date();
        const role = req.user.role;
        const pinned = pinnedBranchId(req) || req.user.branch?._id || req.user.branch || null;
        const horizon = new Date(now.getTime() - 30 * 86400000);
        const camps = await IncentiveCampaign.find({
            ...tenantFilter(req), staffRoles: role, endDate: { $gte: horizon },
            ...(pinned ? { $or: [{ branch: null }, { branch: pinned }] } : {}),
        }).sort({ startDate: -1 }).lean();
        const itemIds = [...new Set(camps.flatMap((c) => c.items.map(String)))];
        const menu = await MenuItem.find({ _id: { $in: itemIds }, ...tenantFilter(req) }).select('name').lean();
        const nameOf = new Map(menu.map((m) => [String(m._id), m.name]));
        const out = [];
        for (const c of camps) {
            const status = svc.campaignStatus(c, now);
            const note = status === 'active' ? '' : status === 'upcoming'
                ? `Starts ${c.startDate.toISOString().slice(0, 10)}`
                : status === 'paused' ? 'This campaign is paused - not earning right now' : 'This campaign has ended';
            for (const id of c.items) {
                out.push({
                    menuItem: id, name: nameOf.get(String(id)) || 'Item',
                    campaign: { _id: c._id, name: c.name, stacking: c.stacking },
                    rate: c.rule.ratePerItem, ruleType: c.rule.type,
                    period: { startDate: c.startDate, endDate: c.endDate },
                    conditions: {
                        staffRoles: c.staffRoles, maxPerStaffPerDay: c.maxPerStaffPerDay,
                        hasBudgetCap: c.budgetCap > 0, branch: c.branch || null,
                        earnedWhen: 'Item served and bill paid',
                    },
                    status, earningNow: status === 'active', message: note,
                });
            }
        }
        return res.status(200).json({ success: true, items: out });
    } catch (err) {
        logger.error('getEligibleItems failed', { error: err.message });
        return fail(res, 500, 'Failed to load incentive items');
    }
};

const entryRow = (e) => ({
    _id: e._id, order: e.order, orderId: e.orderId, billNo: e.billNo, campaign: e.campaign,
    menuItem: e.menuItem, itemName: e.itemName, quantity: e.quantity, rate: e.rate,
    amount: e.amount, state: e.state, day: e.day, branch: e.branch,
    staff: e.staff, staffRole: e.staffRole,
    servedAt: e.servedAt, paidAt: e.paidAt, reversedAt: e.reversedAt,
    reverseReason: e.reverseReason, createdAt: e.createdAt,
});

exports.getMyEntries = async (req, res) => {
    try {
        const range = dayRange(req);
        if (range.error) return fail(res, 400, range.error);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
        const filter = { ...tenantFilter(req), staff: req.user._id, day: { $gte: range.from, $lte: range.to } };
        if (!isBlank(req.query.state)) {
            if (!['pending', 'confirmed', 'reversed'].includes(req.query.state)) return fail(res, 400, 'Invalid state');
            filter.state = req.query.state;
        }
        const [rows, total] = await Promise.all([
            IncentiveEntry.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            IncentiveEntry.countDocuments(filter),
        ]);
        return res.status(200).json({
            success: true, entries: rows.map(entryRow), page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (err) {
        logger.error('getMyEntries failed', { error: err.message });
        return fail(res, 500, 'Failed to load incentive history');
    }
};

// --- admin: campaigns -------------------------------------------------------
const WRITABLE = ['name', 'branch', 'items', 'rule', 'startDate', 'endDate', 'staffRoles',
    'maxPerStaffPerDay', 'budgetCap', 'stacking', 'status'];

/** Date-only strings snap to the tenant's local day; ISO strings are kept. */
function parseDate(v, tz, edge) {
    if (typeof v === 'string' && svc.isDayString(v)) {
        const b = svc.dayBounds(v, tz);
        return edge === 'end' ? b.end : b.start;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

async function buildCampaignFields(req, body, current) {
    const f = {};
    const tz = tzOf(req);
    if ('name' in body || !current) {
        const name = String(body.name ?? '').trim();
        if (!name) return { error: 'Campaign name is required' };
        if (name.length > 80) return { error: 'Campaign name cannot exceed 80 characters' };
        f.name = name;
    }
    if ('items' in body || !current) {
        if (!Array.isArray(body.items) || !body.items.length) return { error: 'Pick at least one menu item' };
        if (body.items.length > 100) return { error: 'A campaign can have at most 100 items' };
        if (!body.items.every((i) => mongoose.isValidObjectId(i))) return { error: 'Invalid menu item id' };
        const ids = [...new Set(body.items.map(String))];
        const found = await MenuItem.countDocuments({ _id: { $in: ids }, ...tenantFilter(req) });
        if (found !== ids.length) return { error: 'One or more menu items were not found in your restaurant' };
        f.items = ids;
    }
    if ('rule' in body || !current) {
        const rule = body.rule || {};
        if ((rule.type ?? 'per_item') !== 'per_item') {
            return { error: 'Only the flat per-item rule is supported', code: 'UNSUPPORTED_RULE' };
        }
        const rate = Number(rule.ratePerItem);
        if (isBlank(rule.ratePerItem) || !Number.isFinite(rate) || rate <= 0 || rate > 100000) {
            return { error: 'ratePerItem must be a number greater than 0' };
        }
        f.rule = { type: 'per_item', ratePerItem: money(rate) };
    }
    if ('startDate' in body || !current) {
        const d = isBlank(body.startDate) ? null : parseDate(body.startDate, tz, 'start');
        if (!d) return { error: 'A valid startDate is required' };
        f.startDate = d;
    }
    if ('endDate' in body || !current) {
        const d = isBlank(body.endDate) ? null : parseDate(body.endDate, tz, 'end');
        if (!d) return { error: 'A valid endDate is required' };
        f.endDate = d;
    }
    if ((f.startDate || current?.startDate) > (f.endDate || current?.endDate)) {
        return { error: 'End date cannot be before start date' };
    }
    if ('staffRoles' in body) {
        const roles = body.staffRoles;
        if (!Array.isArray(roles) || !roles.length || !roles.every((r) => ['captain', 'waiter'].includes(r))) {
            return { error: "staffRoles must be a non-empty list of 'captain' / 'waiter'" };
        }
        f.staffRoles = [...new Set(roles)];
    }
    for (const k of ['maxPerStaffPerDay', 'budgetCap']) {
        if (k in body) {
            const n = Number(isBlank(body[k]) ? 0 : body[k]);
            if (!Number.isFinite(n) || n < 0) return { error: `${k} must be 0 (no limit) or a positive number` };
            f[k] = k === 'maxPerStaffPerDay' ? Math.floor(n) : money(n);
        }
    }
    if ('stacking' in body) {
        if (!['stack', 'exclusive'].includes(body.stacking)) return { error: "stacking must be 'stack' or 'exclusive'" };
        f.stacking = body.stacking;
    }
    if ('status' in body) {
        if (!['active', 'paused'].includes(body.status)) return { error: "status can only be set to 'active' or 'paused'" };
        f.paused = body.status === 'paused';
    }
    if ('branch' in body || !current) {
        const r = await resolveOwnedBranch(req, body.branch);
        if (!r.ok) return { error: r.message, status: r.status, code: r.code };
        f.branch = r.branchId || null;
    }
    return { fields: f };
}

const present = (c, now = new Date()) => ({ ...(c.toObject ? c.toObject() : c), status: svc.campaignStatus(c, now) });

exports.listCampaigns = async (req, res) => {
    try {
        const pinned = pinnedBranchId(req);
        const filter = { ...tenantFilter(req), ...(pinned ? { $or: [{ branch: null }, { branch: pinned }] } : {}) };
        if (!isBlank(req.query.branch) && !pinned && mongoose.isValidObjectId(req.query.branch)) filter.branch = req.query.branch;
        const camps = await IncentiveCampaign.find(filter).sort({ createdAt: -1 }).lean();
        const now = new Date();
        const spent = await IncentiveEntry.aggregate([
            { $match: { ...tenantFilter(req), campaign: { $in: camps.map((c) => c._id) }, state: { $ne: 'reversed' } } },
            { $group: { _id: '$campaign', amount: { $sum: '$amount' }, quantity: { $sum: '$quantity' } } },
        ]);
        const spentBy = new Map(spent.map((s) => [String(s._id), s]));
        return res.status(200).json({
            success: true,
            campaigns: camps.map((c) => ({
                ...present(c, now),
                spent: money(spentBy.get(String(c._id))?.amount), quantityEarned: spentBy.get(String(c._id))?.quantity || 0,
            })),
        });
    } catch (err) {
        logger.error('listCampaigns failed', { error: err.message });
        return fail(res, 500, 'Failed to load campaigns');
    }
};

exports.createCampaign = async (req, res) => {
    try {
        const body = req.body || {};
        const built = await buildCampaignFields(req, body, null);
        if (built.error) return fail(res, built.status || 400, built.error, built.code);
        const doc = await IncentiveCampaign.create({
            ...built.fields, restaurant: tenantId(req), createdBy: req.user._id,
        });
        return res.status(201).json({ success: true, campaign: present(doc) });
    } catch (err) {
        if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, err.message);
        logger.error('createCampaign failed', { error: err.message });
        return fail(res, 500, 'Failed to create campaign');
    }
};

async function loadOwned(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) { fail(res, 400, 'Invalid campaign id'); return null; }
    const doc = await IncentiveCampaign.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!doc) { fail(res, 404, 'Campaign not found'); return null; }
    const pinned = pinnedBranchId(req);
    if (pinned && String(doc.branch || '') !== String(pinned)) {
        fail(res, 403, 'You can only manage campaigns of your own branch.', 'BRANCH_MISMATCH');
        return null;
    }
    return doc;
}

exports.updateCampaign = async (req, res) => {
    try {
        const doc = await loadOwned(req, res);
        if (!doc) return undefined;
        const body = {};
        for (const k of WRITABLE) if (k in (req.body || {})) body[k] = req.body[k];
        const built = await buildCampaignFields(req, body, doc);
        if (built.error) return fail(res, built.status || 400, built.error, built.code);
        Object.assign(doc, built.fields);
        await doc.save();
        return res.status(200).json({ success: true, campaign: present(doc) });
    } catch (err) {
        if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, err.message);
        logger.error('updateCampaign failed', { error: err.message });
        return fail(res, 500, 'Failed to update campaign');
    }
};

exports.deleteCampaign = async (req, res) => {
    try {
        const doc = await loadOwned(req, res);
        if (!doc) return undefined;
        // A campaign with ledger rows is financial history - pause / end it instead.
        if (await IncentiveEntry.exists({ campaign: doc._id, ...tenantFilter(req) })) {
            return fail(res, 409, 'This campaign already has earnings. Pause it or set an end date instead.', 'CAMPAIGN_HAS_ENTRIES');
        }
        await doc.deleteOne();
        return res.status(200).json({ success: true, message: 'Campaign deleted' });
    } catch (err) {
        logger.error('deleteCampaign failed', { error: err.message });
        return fail(res, 500, 'Failed to delete campaign');
    }
};

// --- admin: report ----------------------------------------------------------
async function reportMatch(req) {
    const range = dayRange(req);
    if (range.error) return { error: range.error };
    const match = { ...tenantFilter(req), ...strictBranchFilter(req), day: { $gte: range.from, $lte: range.to } };
    for (const [param, field] of [['staff', 'staff'], ['campaign', 'campaign'], ['item', 'menuItem']]) {
        if (!isBlank(req.query[param])) {
            if (!mongoose.isValidObjectId(req.query[param])) return { error: `Invalid ${param} id` };
            match[field] = oid(req.query[param]);
        }
    }
    if (!isBlank(req.query.state)) {
        if (!['pending', 'confirmed', 'reversed'].includes(req.query.state)) return { error: 'Invalid state' };
        match.state = req.query.state;
    }
    // strictBranchFilter may carry ObjectIds already; tenantFilter ids need casting for aggregate.
    if (match.restaurant) match.restaurant = oid(match.restaurant);
    return { match, range };
}

const cell = () => ({ quantity: 0, estimated: 0, confirmed: 0, pending: 0, reversed: 0 });
function addTo(c, row) {
    const amt = row.amount;
    if (row.state === 'reversed') c.reversed += amt;
    else {
        c.quantity += row.quantity;
        c.estimated += amt;
        c[row.state] += amt;
    }
}
const MONEY_FIELDS = new Set(['estimated', 'confirmed', 'pending', 'reversed']);
const round = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, MONEY_FIELDS.has(k) ? money(v) : v]));

exports.getReport = async (req, res) => {
    try {
        const built = await reportMatch(req);
        if (built.error) return fail(res, 400, built.error);
        const { match, range } = built;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

        // AUDIT-EXEMPT: `match` comes from reportMatch(), which spreads tenantFilter(req) and casts it for aggregate
        const cells = await IncentiveEntry.aggregate([
            { $match: match },
            { $group: {
                _id: { day: '$day', branch: '$branch', staff: '$staff', campaign: '$campaign', menuItem: '$menuItem', state: '$state' },
                itemName: { $first: '$itemName' }, amount: { $sum: '$amount' }, quantity: { $sum: '$quantity' }, entries: { $sum: 1 },
            } },
            { $limit: 20000 },
        ]);
        const [staffDocs, campDocs, branchDocs] = await Promise.all([
            User.find({ _id: { $in: [...new Set(cells.map((c) => String(c._id.staff)))] } }).select('name role').lean(),
            IncentiveCampaign.find({ _id: { $in: [...new Set(cells.map((c) => String(c._id.campaign)))] } }).select('name').lean(),
            Branch.find({ _id: { $in: cells.map((c) => c._id.branch).filter(Boolean) }, ...tenantFilter(req) }).select('name').lean(),
        ]);
        const staffName = new Map(staffDocs.map((u) => [String(u._id), { name: u.name, role: u.role }]));
        const campName = new Map(campDocs.map((c) => [String(c._id), c.name]));
        const branchName = new Map(branchDocs.map((b) => [String(b._id), b.name]));

        const total = cell();
        const groups = { byDay: new Map(), byBranch: new Map(), byStaff: new Map(), byCampaign: new Map(), byItem: new Map() };
        const daily = new Map();
        const bump = (m, key, extra, row) => {
            if (!m.has(key)) m.set(key, { ...extra, ...cell() });
            addTo(m.get(key), row);
        };
        for (const c of cells) {
            const row = { state: c._id.state, amount: c.amount, quantity: c.quantity };
            const k = c._id;
            addTo(total, row);
            bump(groups.byDay, k.day, { day: k.day }, row);
            bump(groups.byBranch, String(k.branch || ''), { branch: k.branch || null, name: branchName.get(String(k.branch)) || 'Main' }, row);
            bump(groups.byStaff, String(k.staff), { staff: k.staff, ...(staffName.get(String(k.staff)) || { name: 'Unknown' }) }, row);
            bump(groups.byCampaign, String(k.campaign), { campaign: k.campaign, name: campName.get(String(k.campaign)) || 'Deleted campaign' }, row);
            bump(groups.byItem, String(k.menuItem || c.itemName), { menuItem: k.menuItem, name: c.itemName }, row);
            bump(daily, [k.day, k.branch, k.staff, k.campaign, k.menuItem].join('|'), {
                day: k.day, branch: k.branch || null, branchName: branchName.get(String(k.branch)) || 'Main',
                staff: k.staff, staffName: staffName.get(String(k.staff))?.name || 'Unknown',
                campaign: k.campaign, campaignName: campName.get(String(k.campaign)) || '',
                menuItem: k.menuItem, itemName: c.itemName,
            }, row);
        }
        const out = (m, sortKey) => [...m.values()].map((v) => round(v)).sort((a, b) =>
            (sortKey === 'day' ? String(a.day).localeCompare(String(b.day)) : b.estimated - a.estimated));

        const [rows, rowTotal] = await Promise.all([
            IncentiveEntry.find({ ...match, ...tenantFilter(req) }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            IncentiveEntry.countDocuments({ ...match, ...tenantFilter(req) }),
        ]);
        return res.status(200).json({
            success: true,
            range: { from: range.from, to: range.to },
            totals: round(total),
            byDay: out(groups.byDay, 'day'),
            byBranch: out(groups.byBranch),
            byStaff: out(groups.byStaff),
            byCampaign: out(groups.byCampaign),
            byItem: out(groups.byItem),
            daily: out(daily, 'day'),
            rows: rows.map((e) => ({
                ...entryRow(e),
                staffName: staffName.get(String(e.staff))?.name || '',
                campaignName: campName.get(String(e.campaign)) || '',
                branchName: branchName.get(String(e.branch)) || (e.branch ? '' : 'Main'),
            })),
            page, limit, total: rowTotal, pages: Math.max(1, Math.ceil(rowTotal / limit)),
        });
    } catch (err) {
        logger.error('getReport failed', { error: err.message });
        return fail(res, 500, 'Failed to build incentive report');
    }
};

// CSV cells that start with = + - @ are prefixed with ' so spreadsheet apps
// never evaluate them as formulas (item names are user-controlled).
const csvCell = (v) => {
    let s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

exports.exportReportCsv = async (req, res) => {
    try {
        const built = await reportMatch(req);
        if (built.error) return fail(res, 400, built.error);
        const { match, range } = built;
        const rows = await IncentiveEntry.find(match).sort({ day: 1, createdAt: 1 }).limit(50000).lean();
        const [staffDocs, campDocs, branchDocs] = await Promise.all([
            User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.staff)))] } }).select('name').lean(),
            IncentiveCampaign.find({ _id: { $in: [...new Set(rows.map((r) => String(r.campaign)))] } }).select('name').lean(),
            Branch.find({ _id: { $in: rows.map((r) => r.branch).filter(Boolean) }, ...tenantFilter(req) }).select('name').lean(),
        ]);
        const sn = new Map(staffDocs.map((u) => [String(u._id), u.name]));
        const cn = new Map(campDocs.map((c) => [String(c._id), c.name]));
        const bn = new Map(branchDocs.map((b) => [String(b._id), b.name]));
        const header = ['Date', 'Branch', 'Staff', 'Role', 'Campaign', 'Item', 'Quantity', 'Rate', 'Amount', 'State', 'Order', 'Bill', 'Served at', 'Paid at', 'Reversed at', 'Reverse reason'];
        const lines = [header.join(',')];
        for (const r of rows) {
            lines.push([
                r.day, bn.get(String(r.branch)) || 'Main', sn.get(String(r.staff)) || '', r.staffRole,
                cn.get(String(r.campaign)) || '', r.itemName, r.quantity, r.rate, r.amount, r.state,
                r.orderId, r.billNo, r.servedAt, r.paidAt, r.reversedAt, r.reverseReason,
            ].map(csvCell).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="incentives-${range.from}_${range.to}.csv"`);
        return res.status(200).send(`${lines.join('\n')}\n`);
    } catch (err) {
        logger.error('exportReportCsv failed', { error: err.message });
        return fail(res, 500, 'Failed to export incentive report');
    }
};
