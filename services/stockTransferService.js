'use strict';

/**
 * Inter-branch stock transfer (Phase 5). All stock effects are claimed on the
 * transfer line BEFORE the stock write (outAppliedAt / inAppliedAt /
 * returnedAt, set with a conditional update), so send / receive / cancel are
 * idempotent and a stock movement can never run twice. Stock itself moves via
 * Inventory.incStock (atomic $inc; a deduction is guarded by
 * currentStock >= qty so it can never go negative).
 *
 * Errors are AppError (4xx) so asyncHandler maps them to JSON.
 */
const mongoose = require('mongoose');
const Inventory = require('../models/inventory');
const Branch = require('../models/branch');
const StockTransfer = require('../models/stockTransfer');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { tenantId, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const { recordReceiptCost, isCost } = require('./inventoryCostService');

const roundQty = Inventory.roundQty;
const MAX_LINES = 100;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sid = (v) => String(v && v._id ? v._id : v);
const statusOf = (stock, min) => (stock <= 0 ? 'out-of-stock' : stock <= (min || 0) ? 'low-stock' : 'in-stock');

function assertCanActOn(req, branchId, verb) {
    const pinned = pinnedBranchId(req);
    if (pinned && sid(pinned) !== sid(branchId)) {
        throw AppError.forbidden(`Your account is limited to its own branch; you cannot ${verb} for another branch`, 'BRANCH_FORBIDDEN');
    }
}

async function loadBranch(restaurant, id, label) {
    if (!mongoose.isValidObjectId(id)) throw AppError.badRequest(`${label} is required`, 'BRANCH_REQUIRED');
    const b = await Branch.findOne({ _id: id, restaurant: restaurant }).select('name displayLabel').lean();
    if (!b) throw AppError.badRequest(`${label} does not belong to this restaurant`, 'BRANCH_NOT_FOUND');
    return b;
}

async function loadTransfer(req, id) {
    if (!mongoose.isValidObjectId(id)) throw AppError.badRequest('Invalid transfer id', 'INVALID_ID');
    const t = await StockTransfer.findOne({ _id: id, restaurant: tenantId(req) }).lean();
    if (!t) throw AppError.notFound('Transfer not found');
    return t;
}

const fresh = (req, id) => StockTransfer.findOne({ _id: id, restaurant: tenantId(req) }).lean();

// Atomic stock move + history row (+ weighted-average cost for receipts).
async function moveStock(itemFilter, delta, { type, reason, userId, unitCost = null }) {
    const filter = delta < 0 ? { ...itemFilter, currentStock: { $gte: -delta } } : itemFilter;
    const inc = await Inventory.incStock(filter, delta);
    if (!inc) return null;
    const { previousStock, newStock, doc } = inc;
    await Inventory.updateOne({ _id: doc._id, restaurant: doc.restaurant }, {
        $set: { status: statusOf(newStock, doc.minStock), ...(delta > 0 ? { lastRestocked: new Date() } : {}) },
        $push: { adjustmentHistory: { $each: [{
            type, quantity: Math.abs(delta), previousStock, newStock, reason, adjustedBy: userId || null, date: new Date(),
        }], $slice: -200 } },
    });
    if (delta > 0 && unitCost !== null) {
        await recordReceiptCost({ Inventory, filter: { _id: doc._id, restaurant: doc.restaurant }, doc, previousStock, inQty: delta, unitCost });
    }
    return inc;
}

async function nextItemId(restaurant, bump = 0) {
    const last = await Inventory.findOne({ restaurant: restaurant }).sort({ itemId: -1 }).select('itemId').lean();
    const n = last && last.itemId ? (parseInt(String(last.itemId).split('-')[1], 10) || 0) + 1 : 1;
    return `INV-${String(n + bump).padStart(3, '0')}`;
}

// Destination item: same name (case-insensitive) + unit in the destination
// branch, else a new zero-stock item copied from the source item.
async function findOrCreateDestItem(req, transfer, line) {
    const restaurant = tenantId(req);
    const scope = branchScopeClause(req, transfer.toBranch);
    const existing = await Inventory.findOne({
        restaurant, ...scope, unit: line.unit, name: { $regex: `^${escapeRegex(line.itemName)}$`, $options: 'i' },
    });
    if (existing) return existing;
    const src = await Inventory.findOne({ _id: line.item, restaurant: restaurant }).lean();
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await Inventory.create({
                restaurant,
                branch: transfer.toBranch,
                itemId: await nextItemId(restaurant, attempt),
                name: line.itemName,
                category: src?.category || 'Other',
                unit: line.unit,
                currentStock: 0,
                minStock: 0,
                maxStock: 0,
                costPerUnit: src?.costPerUnit || 0,
                supplier: src?.supplier || undefined,
                expiryTracking: !!src?.expiryTracking,
                shelfLifeDays: src?.shelfLifeDays || 0,
            });
        } catch (e) {
            if (!(e && e.code === 11000) || attempt === 4) throw e;
        }
    }
    return null;
}

// ─── create / read ───────────────────────────────────────────────────────────

async function createDraft(req, body = {}) {
    const restaurant = tenantId(req);
    if (!restaurant) throw AppError.badRequest('No restaurant context', 'NO_TENANT');
    const { fromBranch, toBranch, lines, note } = body;
    if (String(fromBranch) === String(toBranch)) throw AppError.badRequest('Source and destination branch must differ', 'SAME_BRANCH');
    const [from] = await Promise.all([loadBranch(restaurant, fromBranch, 'Source branch'), loadBranch(restaurant, toBranch, 'Destination branch')]);
    assertCanActOn(req, fromBranch, 'create a transfer');
    if (!Array.isArray(lines) || lines.length === 0) throw AppError.badRequest('Add at least one item', 'NO_LINES');
    if (lines.length > MAX_LINES) throw AppError.badRequest(`At most ${MAX_LINES} lines per transfer`, 'TOO_MANY_LINES');

    const scope = branchScopeClause(req, fromBranch);
    const seen = new Set();
    const outLines = [];
    for (const l of lines) {
        if (!mongoose.isValidObjectId(l?.item)) throw AppError.badRequest('Each line needs an item', 'INVALID_ITEM');
        if (seen.has(String(l.item))) throw AppError.badRequest('An item can appear only once per transfer', 'DUPLICATE_ITEM');
        seen.add(String(l.item));
        const qty = roundQty(Number(l.qty));
        if (!(qty > 0)) throw AppError.badRequest('Quantity must be greater than zero', 'INVALID_QTY');
        const item = await Inventory.findOne({ _id: l.item, restaurant: restaurant, ...scope }).select('name itemId unit avgCost').lean();
        if (!item) throw AppError.badRequest('An item does not exist in the source branch', 'ITEM_NOT_IN_BRANCH');
        outLines.push({ item: item._id, itemName: item.name, itemCode: item.itemId, qty, unit: item.unit, unitCost: isCost(item.avgCost) ? item.avgCost : null });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
        const last = await StockTransfer.findOne({ restaurant: restaurant }).sort({ number: -1 }).select('number').lean();
        const n = last && last.number ? (parseInt(String(last.number).split('-')[1], 10) || 0) + 1 : 1;
        try {
            const doc = await StockTransfer.create({
                restaurant, number: `TRF-${String(n + attempt).padStart(4, '0')}`,
                fromBranch, toBranch, lines: outLines, status: 'draft',
                note: String(note || '').slice(0, 500), createdBy: req.user?._id,
            });
            return { transfer: doc, fromName: from.name };
        } catch (e) {
            if (!(e && e.code === 11000) || attempt === 4) throw e;
        }
    }
    return null;
}

// ─── send ────────────────────────────────────────────────────────────────────

async function send(req, id) {
    const restaurant = tenantId(req);
    const userId = req.user?._id;
    const t = await loadTransfer(req, id);
    assertCanActOn(req, t.fromBranch, 'send');
    if (t.status === 'cancelled' || t.status === 'received') throw AppError.conflict(`Transfer is ${t.status}`, 'INVALID_STATE');
    const pending = t.lines.filter((l) => !l.outAppliedAt);
    if (t.status === 'in_transit' && pending.length === 0) return { transfer: t, already: true };

    // Pre-check every line so a refusal changes nothing.
    const scope = branchScopeClause(req, t.fromBranch);
    const items = new Map();
    const shortages = [];
    for (const l of pending) {
        const item = await Inventory.findOne({ _id: l.item, restaurant: restaurant, ...scope }).select('name currentStock avgCost unit').lean();
        if (!item) { shortages.push({ item: l.item, name: l.itemName, reason: 'Item not found in source branch' }); continue; }
        items.set(sid(l._id), item);
        if (roundQty(item.currentStock) < l.qty) shortages.push({ item: l.item, name: l.itemName, available: roundQty(item.currentStock), requested: l.qty, unit: l.unit });
    }
    if (shortages.length) throw new AppError(400, 'INSUFFICIENT_STOCK', 'Insufficient stock at the source branch', { shortages });

    let flippedToTransit = false;
    if (t.status === 'draft') {
        const claimed = await StockTransfer.findOneAndUpdate(
            { _id: id, restaurant: restaurant, status: 'draft' },
            { $set: { status: 'in_transit', sentBy: userId, sentAt: new Date() } },
            { returnDocument: 'after' }
        );
        flippedToTransit = !!claimed;
    }

    const done = [];
    for (const l of pending) {
        const item = items.get(sid(l._id));
        const unitCost = isCost(item.avgCost) ? item.avgCost : null;
        const claim = await StockTransfer.findOneAndUpdate(
            { _id: id, restaurant: restaurant, lines: { $elemMatch: { _id: l._id, outAppliedAt: null } } },
            { $set: { 'lines.$.outAppliedAt': new Date(), 'lines.$.unitCost': unitCost } },
            { returnDocument: 'after' }
        );
        if (!claim) continue; // a parallel send took this line
        let moved = null;
        try {
            moved = await moveStock({ _id: l.item, restaurant: restaurant }, -l.qty, { type: 'transfer_out', reason: `Transfer ${t.number} sent`, userId });
        } catch (e) { logger.error('stock transfer send failed: ' + e.message); }
        if (!moved) {
            await releaseLine(id, restaurant, l._id, 'outAppliedAt');
            await rollbackSent(req, t, done, flippedToTransit);
            throw AppError.conflict(`Stock for "${l.itemName}" changed while sending; nothing was moved. Please retry.`, 'STOCK_CHANGED');
        }
        done.push({ line: l, unitCost });
    }
    return { transfer: await fresh(req, id), already: false };
}

function releaseLine(id, restaurant, lineId, field) {
    return StockTransfer.findOneAndUpdate(
        { _id: id, restaurant: restaurant, lines: { $elemMatch: { _id: lineId, [field]: { $ne: null } } } },
        { $set: { [`lines.$.${field}`]: null } },
        { returnDocument: 'after' }
    );
}

async function rollbackSent(req, t, done, flippedToTransit) {
    const restaurant = tenantId(req);
    for (const d of done) {
        try {
            await moveStock({ _id: d.line.item, restaurant: restaurant }, d.line.qty, { type: 'transfer_in', reason: `Transfer ${t.number} send rolled back`, userId: req.user?._id, unitCost: d.unitCost });
            await releaseLine(t._id, restaurant, d.line._id, 'outAppliedAt');
        } catch (e) { logger.error('stock transfer rollback failed: ' + e.message); }
    }
    if (flippedToTransit) {
        // Only revert to draft when no line remains sent.
        const cur = await fresh(req, t._id);
        if (cur && cur.status === 'in_transit' && cur.lines.every((l) => !l.outAppliedAt)) {
            await StockTransfer.findOneAndUpdate({ _id: t._id, restaurant: restaurant, status: 'in_transit' }, { $set: { status: 'draft' } }, { returnDocument: 'after' });
        }
    }
}

// ─── receive ─────────────────────────────────────────────────────────────────

async function receive(req, id, body = {}) {
    const restaurant = tenantId(req);
    const userId = req.user?._id;
    const t = await loadTransfer(req, id);
    assertCanActOn(req, t.toBranch, 'receive');
    if (t.status === 'received') return { transfer: t, already: true };
    if (t.status !== 'in_transit') throw AppError.conflict(t.status === 'draft' ? 'Transfer has not been sent yet' : `Transfer is ${t.status}`, 'INVALID_STATE');

    const pending = t.lines.filter((l) => l.outAppliedAt && !l.inAppliedAt && !l.returnedAt);
    const wanted = new Map();
    if (Array.isArray(body.lines)) for (const x of body.lines) wanted.set(String(x?.lineId), x?.receivedQty);
    const plan = [];
    for (const l of pending) {
        const raw = wanted.has(sid(l._id)) ? wanted.get(sid(l._id)) : l.qty;
        const rq = roundQty(Number(raw));
        if (!Number.isFinite(rq) || rq < 0) throw AppError.badRequest(`Invalid received quantity for "${l.itemName}"`, 'INVALID_QTY');
        if (rq > l.qty) throw AppError.badRequest(`Received quantity for "${l.itemName}" cannot exceed the ${l.qty} ${l.unit} sent`, 'RECEIVED_EXCEEDS_SENT');
        plan.push({ line: l, rq });
    }

    for (const { line: l, rq } of plan) {
        const claim = await StockTransfer.findOneAndUpdate(
            { _id: id, restaurant: restaurant, status: 'in_transit', lines: { $elemMatch: { _id: l._id, inAppliedAt: null, returnedAt: null } } },
            { $set: { 'lines.$.inAppliedAt': new Date(), 'lines.$.receivedQty': rq, 'lines.$.shortfallQty': roundQty(l.qty - rq) } },
            { returnDocument: 'after' }
        );
        if (!claim || rq === 0) continue;
        try {
            const dest = await findOrCreateDestItem(req, t, l);
            const moved = await moveStock({ _id: dest._id, restaurant: restaurant }, rq, {
                type: 'transfer_in', reason: `Transfer ${t.number} received`, userId, unitCost: isCost(l.unitCost) ? l.unitCost : null,
            });
            if (!moved) throw new Error('destination item vanished');
            await StockTransfer.updateOne(
                { _id: id, restaurant: restaurant, 'lines._id': l._id },
                { $set: { 'lines.$.destItem': dest._id } }
            );
        } catch (e) {
            logger.error('stock transfer receive failed: ' + e.message);
            await releaseLine(id, restaurant, l._id, 'inAppliedAt');
            throw new AppError(500, 'RECEIVE_FAILED', 'Could not add stock at the destination; nothing was lost, please retry.');
        }
    }

    const cur = await fresh(req, id);
    if (cur && cur.status === 'in_transit' && cur.lines.filter((l) => l.outAppliedAt).every((l) => l.inAppliedAt || l.returnedAt)) {
        await StockTransfer.findOneAndUpdate(
            { _id: id, restaurant: restaurant, status: 'in_transit' },
            { $set: { status: 'received', receivedBy: userId, receivedAt: new Date() } },
            { returnDocument: 'after' }
        );
    }
    return { transfer: await fresh(req, id), already: false };
}

// ─── cancel ──────────────────────────────────────────────────────────────────

async function cancel(req, id) {
    const restaurant = tenantId(req);
    const userId = req.user?._id;
    const t = await loadTransfer(req, id);
    assertCanActOn(req, t.fromBranch, 'cancel');
    if (t.status === 'cancelled') return { transfer: t, already: true, returned: 0 };
    if (t.status === 'received') throw AppError.conflict('A received transfer cannot be cancelled', 'INVALID_STATE');

    const claimed = await StockTransfer.findOneAndUpdate(
        { _id: id, restaurant: restaurant, status: { $in: ['draft', 'in_transit'] } },
        { $set: { status: 'cancelled', cancelledBy: userId, cancelledAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!claimed) throw AppError.conflict('Transfer changed state; refresh and retry', 'INVALID_STATE');

    let returned = 0;
    for (const l of t.lines.filter((x) => x.outAppliedAt && !x.inAppliedAt && !x.returnedAt)) {
        const claim = await StockTransfer.findOneAndUpdate(
            { _id: id, restaurant: restaurant, lines: { $elemMatch: { _id: l._id, inAppliedAt: null, returnedAt: null } } },
            { $set: { 'lines.$.returnedAt': new Date() } },
            { returnDocument: 'after' }
        );
        if (!claim) continue;
        try {
            const moved = await moveStock({ _id: l.item, restaurant: restaurant }, l.qty, {
                type: 'transfer_in', reason: `Transfer ${t.number} cancelled, stock returned`, userId, unitCost: isCost(l.unitCost) ? l.unitCost : null,
            });
            if (!moved) throw new Error('source item not found');
            returned += 1;
        } catch (e) {
            logger.error('stock transfer cancel return failed: ' + e.message);
            await releaseLine(id, restaurant, l._id, 'returnedAt');
            await StockTransfer.updateOne({ _id: id, restaurant: restaurant, 'lines._id': l._id }, { $set: { 'lines.$.error': 'Stock return failed: ' + String(e.message).slice(0, 150) } });
        }
    }
    return { transfer: await fresh(req, id), already: false, returned };
}

module.exports = { createDraft, send, receive, cancel, assertCanActOn };
