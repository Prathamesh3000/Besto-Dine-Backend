const mongoose = require('mongoose');
const Production = require('../models/production');
const Recipe = require('../models/recipe');
const Inventory = require('../models/inventory');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// Same stock precision as every other inventory write (3 decimals).
const round3 = Inventory.roundQty;
const stockStatus = (stock, min) => (stock <= 0 ? 'out-of-stock' : stock <= (min || 0) ? 'low-stock' : 'in-stock');

// Branch + shared(null) scope — see supplierController.branchScopeFilter.
function branchFilter(req) {
    const pinned = pinnedBranchId(req);
    const raw = req?.query?.branch;
    let bid = null;
    if (pinned) bid = pinned._id || pinned;
    else if (raw && raw !== 'all' && mongoose.isValidObjectId(raw)) bid = raw;
    else if (req?.branch) bid = req.branch._id || req.branch;
    if (!bid) return {};
    return { branch: { $in: [new mongoose.Types.ObjectId(String(bid)), null] } };
}

const UNIT_CONVERSIONS = { kg_g: 1000, g_kg: 0.001, L_mL: 1000, mL_L: 0.001 };
function convertUnits(qty, from, to) {
    if (from === to) return qty;
    const k = `${from}_${to}`;
    return UNIT_CONVERSIONS[k] ? qty * UNIT_CONVERSIONS[k] : null;
}

const generateBatchNumber = async (req, retries = 3) => {
    const tf = tenantFilter(req);
    for (let i = 0; i < retries; i++) {
        const last = await Production.findOne(tf).sort({ batchNumber: -1 });
        let next = 'PRD-001';
        if (last && last.batchNumber) {
            const num = parseInt(last.batchNumber.split('-')[1], 10) + 1;
            next = `PRD-${num.toString().padStart(3, '0')}`;
        }
        if (!(await Production.findOne({ batchNumber: next, ...tf }))) return next;
    }
    return `PRD-${Date.now().toString(36).toUpperCase()}`;
};

// GET /api/v1/production
exports.list = asyncHandler(async (req, res) => {
    const { days, page = 1, limit = 20 } = req.query;
    const filter = { ...tenantFilter(req), ...branchFilter(req) };
    if (days) {
        const d = Math.min(365, Math.max(1, parseInt(days)));
        filter.productionDate = { $gte: new Date(Date.now() - d * 24 * 60 * 60 * 1000) };
    }
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const [entries, total] = await Promise.all([
        Production.find(filter).sort({ productionDate: -1 })
            .skip((pageNum - 1) * limitNum).limit(limitNum)
            .populate('outputItem', 'name unit').populate('branch', 'name').lean(),
        Production.countDocuments(filter),
    ]);
    res.json({ success: true, entries, pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) } });
}, 'Failed to fetch production entries');

// POST /api/v1/production — run a batch: deduct ingredients, add output.
exports.create = async (req, res) => {
    try {
        const { recipeId, menuItemId, batchQuantity, outputItem, outputQty, notes, productionDate } = req.body;
        const tf = tenantFilter(req);

        const batches = Number(batchQuantity);
        if (!(batches > 0)) return res.status(400).json({ success: false, message: 'Batch quantity must be greater than 0' });

        // Resolve recipe by id or by menu item (prefer branch-specific).
        let recipe = null;
        if (recipeId && mongoose.isValidObjectId(recipeId)) {
            recipe = await Recipe.findOne({ _id: recipeId, ...tf }).populate('ingredients.inventoryItem', 'name unit costPerUnit currentStock').populate('menuItem', 'name');
        } else if (menuItemId && mongoose.isValidObjectId(menuItemId)) {
            recipe = await Recipe.findOne({ menuItem: menuItemId, ...tf, ...branchFilter(req) })
                .populate('ingredients.inventoryItem', 'name unit costPerUnit currentStock').populate('menuItem', 'name');
        }
        if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found' });

        // Compute the per-ingredient deduction (recipe qty × batches),
        // converted to the inventory unit, AGGREGATED per inventory item
        // (a recipe may list the same ingredient on two lines), and
        // verify stock against the total first.
        const needByInv = new Map(); // invId → { inv, needed }
        for (const ing of recipe.ingredients) {
            const inv = ing.inventoryItem;
            if (!inv) continue;
            const neededRaw = ing.quantity * batches;
            const needed = convertUnits(neededRaw, ing.unit, inv.unit);
            if (needed === null) {
                return res.status(400).json({ success: false, message: `Unit mismatch on ${inv.name} (${ing.unit} → ${inv.unit}). Fix the recipe unit first.` });
            }
            const key = String(inv._id);
            const slot = needByInv.get(key) || { inv, needed: 0 };
            slot.needed += needed;
            needByInv.set(key, slot);
        }
        const deductions = [];
        const shortages = [];
        let totalCost = 0;
        for (const { inv, needed } of needByInv.values()) {
            const need = round3(needed);
            if (round3(inv.currentStock) < need) {
                shortages.push({ name: inv.name, need, have: inv.currentStock, unit: inv.unit });
            }
            totalCost += need * (inv.costPerUnit || 0);
            deductions.push({ inventoryItem: inv._id, name: inv.name, qty: need, unit: inv.unit });
        }
        if (shortages.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Not enough stock: ${shortages.map(s => `${s.name} (need ${s.need}${s.unit}, have ${s.have})`).join('; ')}`,
                shortages,
            });
        }

        // Validate optional output item.
        let outItem = null, outUnit = '';
        if (outputItem && mongoose.isValidObjectId(outputItem)) {
            outItem = await Inventory.findOne({ _id: outputItem, ...tf });
            if (!outItem) return res.status(400).json({ success: false, message: 'Output item is invalid for this tenant' });
            outUnit = outItem.unit;
        }
        const outQty = outItem ? Math.max(0, round3(Number(outputQty) || 0)) : 0;

        const branchId = pinnedBranchId(req) || recipe.branch || (req.branch ? (req.branch._id || req.branch) : null);
        const production = new Production({
            restaurant: tenantId(req),
            branch: branchId,
            batchNumber: await generateBatchNumber(req),
            recipe: recipe._id,
            menuItem: recipe.menuItem?._id,
            recipeName: recipe.menuItem?.name || '',
            batchQuantity: batches,
            outputItem: outItem?._id || null,
            outputQty: outQty,
            outputUnit: outUnit,
            consumed: deductions,
            totalCost: Math.round(totalCost * 100) / 100,
            productionDate: productionDate ? new Date(productionDate) : new Date(),
            producedBy: req.user._id,
            producedByName: req.user.name || '',
            notes: notes || '',
        });
        await production.save();

        // Apply stock movements: deduct ingredients (usage), add output (restock).
        for (const d of deductions) {
            try {
                // Relative, guarded decrement (no lost concurrent updates);
                // if stock fell short meanwhile, clamp at 0 as before.
                let previousStock, newStock, minStock;
                const inc = await Inventory.incStock({ _id: d.inventoryItem, ...tf, currentStock: { $gte: d.qty } }, -d.qty);
                if (inc) {
                    ({ previousStock, newStock } = inc);
                    minStock = inc.doc.minStock;
                } else {
                    const before = await Inventory.findOneAndUpdate(
                        { _id: d.inventoryItem, ...tf, currentStock: { $lt: d.qty } },
                        { $set: { currentStock: 0 } },
                        { returnDocument: 'before' }
                    );
                    if (!before) continue;
                    previousStock = round3(before.currentStock); newStock = 0; minStock = before.minStock;
                }
                await Inventory.updateOne({ _id: d.inventoryItem, ...tf }, {
                    $set: { status: stockStatus(newStock, minStock) },
                    $push: { adjustmentHistory: { $each: [{
                        type: 'usage', quantity: d.qty, previousStock, newStock,
                        reason: `Production ${production.batchNumber} (${recipe.menuItem?.name || 'batch'})`,
                        adjustedBy: req.user._id, date: new Date(),
                    }], $slice: -200 } },
                });
            } catch { /* best effort */ }
        }
        if (outItem && outQty > 0) {
            try {
                const inc = await Inventory.incStock({ _id: outItem._id, ...tf }, outQty);
                if (inc) {
                    await Inventory.updateOne({ _id: outItem._id, ...tf }, {
                        $set: { lastRestocked: new Date(), status: stockStatus(inc.newStock, inc.doc.minStock) },
                        $push: { adjustmentHistory: { $each: [{
                            type: 'restock', quantity: outQty, previousStock: inc.previousStock, newStock: inc.newStock,
                            reason: `Production ${production.batchNumber}`, adjustedBy: req.user._id, date: new Date(),
                        }], $slice: -200 } },
                    });
                }
            } catch { /* best effort */ }
        }

        res.status(201).json({ success: true, production });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: 'Duplicate batch number — try again' });
        res.status(500).json({ success: false, message: 'Failed to record production', ...devError(err) });
    }
};

exports.summary = asyncHandler(async (req, res) => {
    const match = { ...tenantFilter(req), ...branchFilter(req) };
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [agg] = await Production.aggregate([
        { $match: match },
        { $group: {
            _id: null,
            totalBatches: { $sum: 1 },
            todayBatches: { $sum: { $cond: [{ $gte: ['$productionDate', todayStart] }, 1, 0] } },
            todayCost: { $sum: { $cond: [{ $gte: ['$productionDate', todayStart] }, '$totalCost', 0] } },
        } },
    ]);
    res.json({ success: true, summary: agg || { totalBatches: 0, todayBatches: 0, todayCost: 0 } });
}, 'Failed to fetch production summary');
