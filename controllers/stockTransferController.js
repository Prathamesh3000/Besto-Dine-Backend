'use strict';

// Inter-branch stock transfers + inventory valuation report. Mounted by
// routes/stockTransferRoute.js under /api/inventory (before inventoryRoute).
const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const StockTransfer = require('../models/stockTransfer');
const Inventory = require('../models/inventory');
const Branch = require('../models/branch');
const svc = require('../services/stockTransferService');
const { buildValuation } = require('../services/inventoryCostService');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');

const STATUSES = ['draft', 'in_transit', 'received', 'cancelled'];

async function branchNames(req) {
    const rows = await Branch.find({ ...tenantFilter(req) }).select('name displayLabel').lean();
    const map = {};
    for (const b of rows || []) map[String(b._id)] = b.displayLabel || b.name;
    return map;
}

const withNames = (t, names) => ({ ...t, fromName: names[String(t.fromBranch)] || '', toName: names[String(t.toBranch)] || '' });

// One guarded audit call per state change (never throws, never blocks).
function audit(req, action, t, extra = {}) {
    try {
        require('../services/tenantAuditService').recordTenantAudit(req, {
            action: 'other', entityType: 'StockTransfer', entityId: t && t._id,
            summary: `Stock transfer ${t && t.number} ${action}`,
            after: { status: t && t.status, from: t && t.fromBranch, to: t && t.toBranch, lines: (t && t.lines || []).length, ...extra },
        });
    } catch { /* audit must never affect the transfer */ }
}

exports.listTransfers = asyncHandler(async (req, res) => {
    const filter = { ...tenantFilter(req) };
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const pinned = pinnedBranchId(req);
    if (pinned) filter.$or = [{ fromBranch: pinned }, { toBranch: pinned }];
    const [rows, names] = await Promise.all([
        StockTransfer.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
        branchNames(req),
    ]);
    res.json({ success: true, transfers: rows.map((t) => withNames(t, names)) });
}, 'Failed to list transfers');

exports.getTransfer = asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw AppError.badRequest('Invalid transfer id', 'INVALID_ID');
    const t = await StockTransfer.findOne({ _id: req.params.id, ...tenantFilter(req) }).lean();
    if (!t) throw AppError.notFound('Transfer not found');
    const pinned = pinnedBranchId(req);
    if (pinned && String(pinned) !== String(t.fromBranch) && String(pinned) !== String(t.toBranch)) throw AppError.notFound('Transfer not found');
    res.json({ success: true, transfer: withNames(t, await branchNames(req)) });
}, 'Failed to load transfer');

exports.createTransfer = asyncHandler(async (req, res) => {
    const { transfer } = await svc.createDraft(req, req.body || {});
    audit(req, 'created (draft)', transfer);
    res.status(201).json({ success: true, transfer });
}, 'Failed to create transfer');

exports.sendTransfer = asyncHandler(async (req, res) => {
    const { transfer, already } = await svc.send(req, req.params.id);
    if (!already) audit(req, 'sent', transfer);
    res.json({ success: true, already, transfer });
}, 'Failed to send transfer');

exports.receiveTransfer = asyncHandler(async (req, res) => {
    const { transfer, already } = await svc.receive(req, req.params.id, req.body || {});
    if (!already) {
        const shortfall = (transfer.lines || []).filter((l) => l.shortfallQty > 0).map((l) => ({ item: l.itemName, shortfall: l.shortfallQty, unit: l.unit }));
        audit(req, transfer.status === 'received' ? 'received' : 'partially received', transfer, shortfall.length ? { shortfall } : {});
    }
    res.json({ success: true, already, transfer });
}, 'Failed to receive transfer');

exports.cancelTransfer = asyncHandler(async (req, res) => {
    const { transfer, already, returned } = await svc.cancel(req, req.params.id);
    if (!already) audit(req, 'cancelled', transfer, { stockReturnedLines: returned });
    res.json({ success: true, already, transfer });
}, 'Failed to cancel transfer');

// GET /api/inventory/reports/valuation
exports.getValuation = asyncHandler(async (req, res) => {
    const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
    const [items, names] = await Promise.all([
        Inventory.find(filter).select('itemId name category unit branch currentStock costPerUnit avgCost').limit(20000).lean(),
        branchNames(req),
    ]);
    res.json({ success: true, restaurant: tenantId(req), ...buildValuation(items, names) });
}, 'Failed to build valuation report');
