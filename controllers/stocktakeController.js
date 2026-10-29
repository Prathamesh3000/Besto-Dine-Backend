// Stocktake (plan 3B.6): count -> submit -> apply as 'correction' adjustments.
const mongoose = require('mongoose');
const Stocktake = require('../models/stocktake');
const Inventory = require('../models/inventory');
const logger = require('../utils/logger');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');

const roundQty = Inventory.roundQty;
const isCounted = (l) => l.countedQty !== null && l.countedQty !== undefined;

function resolveBranchId(req) {
    const pinned = pinnedBranchId(req);
    if (pinned) return pinned._id || pinned;
    if (req.branch?._id) return req.branch._id;
    const b = req.body?.branch;
    return b && mongoose.isValidObjectId(b) ? b : null;
}

const summarise = (s) => {
    const lines = s.lines || [];
    return {
        ...s,
        lines: undefined,
        lineCount: lines.length,
        countedCount: lines.filter(isCounted).length,
        varianceCount: lines.filter((l) => l.variance).length,
    };
};

// POST /api/inventory/stocktakes
exports.createStocktake = async (req, res) => {
    try {
        const restaurant = tenantId(req);
        const branchId = resolveBranchId(req);
        const itemFilter = { restaurant, ...(branchId ? branchScopeClause(req, branchId) : {}) };
        if (req.body?.category) itemFilter.category = String(req.body.category);
        const items = await Inventory.find(itemFilter).sort({ name: 1 }).select('name itemId unit currentStock').lean();
        if (items.length === 0) return res.status(400).json({ success: false, message: 'No inventory items to count' });

        const doc = await Stocktake.create({
            restaurant,
            branch: branchId || null,
            name: String(req.body?.name || '').trim().slice(0, 120),
            status: 'draft',
            createdBy: req.user?._id,
            lines: items.map((i) => ({
                item: i._id,
                itemName: i.name,
                itemCode: i.itemId,
                expectedQty: roundQty(i.currentStock),
                unit: i.unit,
            })),
        });
        res.status(201).json({ success: true, stocktake: doc });
    } catch (error) {
        if (error.name === 'ValidationError') return res.status(400).json({ success: false, message: error.message });
        res.status(500).json({ success: false, message: 'Failed to create stocktake', ...devError(error) });
    }
};

// GET /api/inventory/stocktakes
exports.listStocktakes = async (req, res) => {
    try {
        const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
        if (['draft', 'submitted', 'applied'].includes(req.query.status)) filter.status = req.query.status;
        const rows = await Stocktake.find(filter).sort({ createdAt: -1 }).limit(100).lean();
        res.json({ success: true, stocktakes: rows.map(summarise) });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to list stocktakes', ...devError(error) });
    }
};

// GET /api/inventory/stocktakes/:id
exports.getStocktake = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const s = await Stocktake.findOne({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Stocktake not found' });
        res.json({ success: true, stocktake: s });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load stocktake', ...devError(error) });
    }
};

// PUT /api/inventory/stocktakes/:id/counts   { counts: [{ item|line, countedQty, note? }] }
exports.updateCounts = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const counts = Array.isArray(req.body?.counts) ? req.body.counts : null;
        if (!counts || counts.length === 0) return res.status(400).json({ success: false, message: 'counts[] is required' });

        const s = await Stocktake.findOne({ _id: req.params.id, ...tf, ...strictBranchFilter(req) }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Stocktake not found' });
        if (s.status !== 'draft') return res.status(409).json({ success: false, message: `Stocktake is ${s.status}; counts are locked` });

        const $set = {};
        const arrayFilters = [];
        let n = 0;
        for (const c of counts) {
            const line = s.lines.find((l) => (c.line && String(l._id) === String(c.line)) || (c.item && String(l.item) === String(c.item)));
            if (!line) return res.status(400).json({ success: false, message: 'Unknown line in counts' });
            const clear = c.countedQty === null || c.countedQty === '';
            const qty = clear ? null : roundQty(Number(c.countedQty));
            if (!clear && (!Number.isFinite(qty) || qty < 0)) {
                return res.status(400).json({ success: false, message: `Invalid count for ${line.itemName}` });
            }
            const k = `l${n++}`;
            arrayFilters.push({ [`${k}._id`]: line._id });
            $set[`lines.$[${k}].countedQty`] = qty;
            $set[`lines.$[${k}].variance`] = qty === null ? null : roundQty(qty - line.expectedQty);
            if (c.note !== undefined) $set[`lines.$[${k}].note`] = String(c.note || '').slice(0, 300);
        }
        const r = await Stocktake.updateOne({ _id: s._id, ...tf, status: 'draft' }, { $set }, { arrayFilters });
        if (!r.matchedCount) return res.status(409).json({ success: false, message: 'Stocktake changed; reload and retry' });
        const fresh = await Stocktake.findOne({ _id: s._id, ...tf }).lean();
        res.json({ success: true, stocktake: fresh });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update counts', ...devError(error) });
    }
};

// POST /api/inventory/stocktakes/:id/submit
exports.submitStocktake = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const s = await Stocktake.findOne({ _id: req.params.id, ...tf, ...strictBranchFilter(req) }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Stocktake not found' });
        if (s.status !== 'draft') return res.status(409).json({ success: false, message: `Stocktake is already ${s.status}` });
        if (!s.lines.some(isCounted)) {
            return res.status(400).json({ success: false, message: 'Enter at least one count before submitting' });
        }
        const done = await Stocktake.findOneAndUpdate(
            { _id: s._id, ...tf, status: 'draft' },
            { $set: { status: 'submitted', submittedBy: req.user?._id, submittedAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (!done) return res.status(409).json({ success: false, message: 'Stocktake already submitted' });
        res.json({ success: true, stocktake: done });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to submit stocktake', ...devError(error) });
    }
};

/**
 * Apply one line: a relative correction by the counted variance, so sales
 * that happened since the snapshot are kept (never clobbered with a stale
 * absolute). Stock cannot go below 0. History row: type 'correction',
 * quantity = resulting stock (same convention as PATCH /:id/adjust).
 */
async function applyLine(stocktake, line, userId, restaurant) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await Inventory.findOne({ _id: line.item, restaurant: restaurant });
        if (!cur) throw new Error('Inventory item no longer exists');
        const previousStock = cur.currentStock;
        const newStock = Math.max(0, roundQty(previousStock + line.variance));
        if (cur.maxStock > 0 && newStock > cur.maxStock) throw new Error(`Counted stock exceeds max stock of ${cur.maxStock} ${cur.unit}`);
        const status = newStock <= 0 ? 'out-of-stock' : newStock <= cur.minStock ? 'low-stock' : 'in-stock';
        const updated = await Inventory.findOneAndUpdate(
            { _id: cur._id, restaurant: restaurant, currentStock: previousStock },
            {
                $set: { currentStock: newStock, status },
                $push: {
                    adjustmentHistory: {
                        $each: [{
                            type: 'correction',
                            quantity: newStock,
                            previousStock,
                            newStock,
                            reason: `Stocktake ${stocktake._id}: counted ${line.countedQty}, expected ${line.expectedQty} ${line.unit}`.slice(0, 500),
                            adjustedBy: userId || null,
                            date: new Date(),
                        }],
                        $slice: -200,
                    },
                },
            },
            { returnDocument: 'after' }
        );
        if (updated) return newStock;
    }
    throw new Error('Stock changed concurrently');
}

// POST /api/inventory/stocktakes/:id/apply
exports.applyStocktake = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const restaurant = tenantId(req);
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const s = await Stocktake.findOne({ _id: req.params.id, ...tf, ...strictBranchFilter(req) }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Stocktake not found' });
        if (s.status === 'applied') return res.json({ success: true, alreadyApplied: true, applied: 0, failed: [], stocktake: s });
        if (s.status !== 'submitted') return res.status(409).json({ success: false, message: 'Submit the stocktake before applying it' });

        let applied = 0;
        const failed = [];
        for (const line of s.lines) {
            if (!isCounted(line) || line.appliedAt || !line.variance) continue; // uncounted, done, or no change
            // Claim the line first: exactly one caller wins, so a double click
            // or two admins applying together can never correct a line twice.
            const claim = await Stocktake.findOneAndUpdate(
                { _id: s._id, ...tf, status: 'submitted', lines: { $elemMatch: { _id: line._id, appliedAt: null } } },
                { $set: { 'lines.$.appliedAt': new Date(), 'lines.$.applyError': '' } },
                { returnDocument: 'after' }
            );
            if (!claim) continue;
            try {
                const stock = await applyLine(s, line, req.user?._id, restaurant);
                await Stocktake.updateOne(
                    { _id: s._id, ...tf, 'lines._id': line._id },
                    { $set: { 'lines.$.appliedStock': stock } }
                );
                applied += 1;
            } catch (err) {
                // Release the claim so a retry can pick this line up again.
                await Stocktake.updateOne(
                    { _id: s._id, ...tf, 'lines._id': line._id },
                    { $set: { 'lines.$.appliedAt': null, 'lines.$.applyError': String(err.message).slice(0, 200) } }
                );
                failed.push({ item: line.item, name: line.itemName, reason: err.message });
                logger.warn(`Stocktake ${s._id} line ${line.itemName} failed: ${err.message}`);
            }
        }

        let stocktake = await Stocktake.findOne({ _id: s._id, ...tf }).lean();
        if (failed.length === 0) {
            const stillOpen = stocktake.lines.some((l) => isCounted(l) && l.variance && !l.appliedAt);
            if (!stillOpen) {
                const closed = await Stocktake.findOneAndUpdate(
                    { _id: s._id, ...tf, status: 'submitted' },
                    { $set: { status: 'applied', appliedBy: req.user?._id, appliedAt: new Date() } },
                    { returnDocument: 'after' }
                ).lean();
                if (closed) stocktake = closed;
            }
        }
        res.status(failed.length ? 207 : 200).json({ success: failed.length === 0, applied, failed, stocktake });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to apply stocktake', ...devError(error) });
    }
};
