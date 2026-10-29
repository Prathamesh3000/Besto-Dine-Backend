const mongoose = require('mongoose');
const Inventory = require('../../models/inventory');
const Recipe = require('../../models/recipe');
const Order = require('../../models/order');
const { tenantFilter } = require('../../utils/tenantScope');
const { devError } = require('../../utils/AppError');
const { branchFilter, convertUnits } = require('./_shared');

// ═══════════════════════════════════════════════════════════════════════════
//  FOOD COST ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/inventory/food-cost — food cost report for all menu items that have recipes
exports.getFoodCostReport = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        // Sales window for the profitability join (default 30 days).
        const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
        const since = new Date();
        since.setDate(since.getDate() - days);

        const recipes = await Recipe.find({ ...tf, ...bf })
            .populate('menuItem', 'name basePrice finalPrice category inStock')
            .populate('ingredients.inventoryItem', 'name unit costPerUnit')
            .lean();

        let report = recipes
            .filter(r => r.menuItem) // skip orphaned recipes
            .map(r => {
                let foodCost = 0;
                const ingredientCosts = [];
                for (const ing of r.ingredients) {
                    if (!ing.inventoryItem) continue;
                    const converted = convertUnits(ing.quantity, ing.unit, ing.inventoryItem.unit);
                    const qty = converted !== null ? converted : ing.quantity;
                    const cost = qty * ing.inventoryItem.costPerUnit;
                    foodCost += cost;
                    ingredientCosts.push({
                        name: ing.inventoryItem.name,
                        quantity: ing.quantity,
                        unit: ing.unit,
                        unitCost: ing.inventoryItem.costPerUnit,
                        lineCost: Math.round(cost * 100) / 100,
                    });
                }
                foodCost = foodCost / (r.yield || 1) / (1 - Math.min(95, Math.max(0, r.prepLossPercent || 0)) / 100);
                const sellingPrice = r.menuItem.finalPrice || r.menuItem.basePrice || 0;
                const margin = sellingPrice > 0 ? ((sellingPrice - foodCost) / sellingPrice) * 100 : 0;
                const costPct = sellingPrice > 0 ? (foodCost / sellingPrice) * 100 : 0;

                return {
                    menuItemId: r.menuItem._id,
                    menuItemName: r.menuItem.name,
                    category: r.menuItem.category || '',
                    sellingPrice,
                    foodCost: Math.round(foodCost * 100) / 100,
                    margin: Math.round(margin * 10) / 10,
                    costPercentage: Math.round(costPct * 10) / 10,
                    ingredientCosts,
                };
            });

        // ── Profitability join — how many of each dish actually sold in the
        //    window, so we can rank by REAL profit (margin × popularity), not
        //    just per-plate margin. A high-margin dish nobody orders earns
        //    less than a thin-margin dish that flies out the kitchen.
        const orders = await Order.find({
            ...tf,
            ...bf,
            status: { $in: ['preparing', 'ready', 'served'] },
            createdAt: { $gte: since },
        }).select('items').lean();

        const soldMap = {};
        for (const o of orders) {
            for (const it of (o.items || [])) {
                const id = it.menuItem?.toString?.() || it.menuItem;
                if (!id) continue;
                soldMap[id] = (soldMap[id] || 0) + (it.quantity || 1);
            }
        }

        report = report.map(row => {
            const unitsSold = soldMap[row.menuItemId.toString()] || 0;
            const profitPerUnit = Math.round((row.sellingPrice - row.foodCost) * 100) / 100;
            return {
                ...row,
                unitsSold,
                profitPerUnit,
                totalProfit: Math.round(profitPerUnit * unitsSold * 100) / 100,
                totalRevenue: Math.round(row.sellingPrice * unitsSold * 100) / 100,
            };
        });

        // ── Menu-engineering classification (Star / Plowhorse / Puzzle / Dog)
        //    Popularity = units sold vs the average; Profitability = profit
        //    per unit vs the average. Only dishes that actually sold get a
        //    class — an unsold dish can't be a "Star" yet.
        const sold = report.filter(r => r.unitsSold > 0);
        const avgUnits = sold.length ? sold.reduce((s, r) => s + r.unitsSold, 0) / sold.length : 0;
        const avgProfitPerUnit = report.length ? report.reduce((s, r) => s + r.profitPerUnit, 0) / report.length : 0;
        report = report.map(r => {
            let menuClass = 'unsold';
            if (r.unitsSold > 0) {
                const popular = r.unitsSold >= avgUnits;
                const profitable = r.profitPerUnit >= avgProfitPerUnit;
                menuClass = popular && profitable ? 'star'
                    : popular && !profitable ? 'plowhorse'
                    : !popular && profitable ? 'puzzle'
                    : 'dog';
            }
            return { ...r, menuClass };
        });

        // Default order: most total profit first (the "what makes me money"
        // view). The client can re-sort by any column.
        report.sort((a, b) => b.totalProfit - a.totalProfit);

        res.status(200).json({ success: true, report, period: { days, since } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to generate food cost report', ...devError(error) });
    }
};

// GET /api/inventory/menu-issues
// Per-menu-item inventory health for the admin Menu page. For every menu item
// that has a recipe, we surface whether it can actually be made right now:
//   • out    — an ingredient is at/below zero stock (can't fulfil)
//   • low     — an ingredient is at/below its reorder point (will run out soon)
//   • config  — recipe references a missing ingredient OR a unit that can't be
//               converted to the inventory unit (admin must fix the recipe)
// Worst level per item wins. Items with no issues are omitted from the map.
exports.getMenuItemIssues = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const recipes = await Recipe.find({ ...tf, ...bf })
            .populate('menuItem', 'name')
            .populate('ingredients.inventoryItem', 'name unit currentStock minStock')
            .lean();

        const RANK = { ok: 0, low: 1, config: 2, out: 3 };
        const issues = {};
        const list = [];

        for (const r of recipes) {
            if (!r.menuItem) continue;
            let level = 'ok';
            const reasons = [];
            const bump = (lv) => { if (RANK[lv] > RANK[level]) level = lv; };

            for (const ing of r.ingredients) {
                const inv = ing.inventoryItem;
                if (!inv) { reasons.push('Recipe ingredient missing from inventory'); bump('config'); continue; }
                const conv = convertUnits(ing.quantity, ing.unit, inv.unit);
                if (conv === null) {
                    reasons.push(`${inv.name}: unit mismatch (recipe ${ing.unit} vs stock ${inv.unit})`);
                    bump('config');
                    continue;
                }
                if (inv.currentStock <= 0) { reasons.push(`${inv.name}: out of stock`); bump('out'); }
                else if (inv.currentStock <= (inv.minStock || 0)) { reasons.push(`${inv.name}: low stock`); bump('low'); }
            }

            if (level !== 'ok') {
                const id = r.menuItem._id.toString();
                issues[id] = { level, reasons };
                list.push({ menuItemId: id, name: r.menuItem.name, level, reasons });
            }
        }

        list.sort((a, b) => RANK[b.level] - RANK[a.level] || a.name.localeCompare(b.name));

        res.status(200).json({
            success: true,
            issues,
            list,
            counts: {
                out: list.filter(x => x.level === 'out').length,
                low: list.filter(x => x.level === 'low').length,
                config: list.filter(x => x.level === 'config').length,
                total: list.length,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to compute menu issues', ...devError(error) });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-DEDUCTION (called from orderController when status → preparing)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  ACTUAL vs THEORETICAL
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/inventory/actual-vs-theoretical
exports.getActualVsTheoretical = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const { days = 7 } = req.query;
        const since = new Date();
        since.setDate(since.getDate() - Math.min(90, Math.max(1, parseInt(days) || 7)));

        // Theoretical: sum recipe ingredients × order quantities for orders since `since`
        // Scoped to this branch's orders only for pinned Sub Admins.
        const orders = await Order.find({
            ...tf,
            ...bf,
            status: { $in: ['preparing', 'ready', 'served'] },
            createdAt: { $gte: since },
        }).select('items orderId').lean();

        // Build theoretical usage map: inventoryItemId → total qty needed
        const theoretical = {};
        const menuItemIds = [...new Set(
            orders.flatMap(o => o.items.map(i => i.menuItem?.toString?.() || i.menuItem).filter(Boolean))
        )];

        const recipes = await Recipe.find({ menuItem: { $in: menuItemIds }, ...tf, ...bf }).lean();
        const recipeMap = Object.fromEntries(recipes.map(r => [r.menuItem.toString(), r]));

        for (const order of orders) {
            for (const item of order.items) {
                const miId = item.menuItem?.toString?.() || item.menuItem;
                if (!miId || !recipeMap[miId]) continue;
                const recipe = recipeMap[miId];
                const orderQty = item.quantity || 1;
                const multiplier = orderQty / (recipe.yield || 1);

                for (const ing of recipe.ingredients) {
                    const invId = ing.inventoryItem.toString();
                    if (!theoretical[invId]) theoretical[invId] = { quantity: 0, unit: ing.unit };
                    theoretical[invId].quantity += ing.quantity * multiplier;
                }
            }
        }

        // Actual: sum usage/waste/order-deduction from adjustmentHistory
        const invIds = Object.keys(theoretical).filter(id => mongoose.isValidObjectId(id));
        if (invIds.length === 0) {
            return res.status(200).json({ success: true, report: [], period: { days: parseInt(days) || 7, since } });
        }

        const invItems = await Inventory.find({ _id: { $in: invIds }, ...tf, ...bf })
            .select('name itemId unit currentStock costPerUnit adjustmentHistory')
            .lean();

        const report = invItems.map(inv => {
            const th = theoretical[inv._id.toString()];
            const theoQty = th ? th.quantity : 0;

            // Sum actual usage from adjustment history in the period.
            // Includes `waste` because waste is stock actually gone (just
            // not sold) — excluding it hides spoilage in the variance.
            // 'return' rows (a prepared-then-cancelled order's stock given
            // back) reverse usage, so they are netted out — the cancelled
            // order is likewise absent from the theoretical side.
            const actualUsage = Math.max(0, (inv.adjustmentHistory || [])
                .filter(h => ['usage', 'waste', 'return'].includes(h.type) && new Date(h.date) >= since)
                .reduce((sum, h) => sum + (h.type === 'return' ? -h.quantity : h.quantity), 0));

            const converted = th ? convertUnits(theoQty, th.unit, inv.unit) : theoQty;
            const theoConverted = converted !== null ? converted : theoQty;

            const variance = actualUsage - theoConverted;
            const variancePct = theoConverted > 0 ? (variance / theoConverted) * 100 : 0;

            return {
                _id: inv._id,
                itemId: inv.itemId,
                name: inv.name,
                unit: inv.unit,
                theoreticalUsage: Math.round(theoConverted * 1000) / 1000,
                actualUsage: Math.round(actualUsage * 1000) / 1000,
                variance: Math.round(variance * 1000) / 1000,
                variancePercent: Math.round(variancePct * 10) / 10,
                costImpact: Math.round(variance * (inv.costPerUnit || 0) * 100) / 100,
            };
        }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

        res.status(200).json({ success: true, report, period: { days: parseInt(days) || 7, since } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to generate report', ...devError(error) });
    }
};

// GET /api/inventory/reports/stock — Opening & Closing Stock report (10.8.1)
// Opening stock at the window start is reconstructed by subtracting the
// net movement during the window from the live currentStock (closing).
// Net movement comes from adjustmentHistory deltas (newStock-previousStock),
// which correctly accounts for corrections too.
exports.getStockReport = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const items = await Inventory.find({ ...tf, ...bf })
            .select('itemId name category unit currentStock costPerUnit adjustmentHistory').lean();

        const report = items.map(it => {
            let received = 0, consumed = 0, net = 0;
            for (const h of (it.adjustmentHistory || [])) {
                if (!h.date || new Date(h.date) < since) continue;
                const delta = (h.newStock ?? 0) - (h.previousStock ?? 0);
                net += delta;
                if (h.type === 'restock' || h.type === 'return') received += h.quantity || 0;
                else if (h.type === 'usage' || h.type === 'waste') consumed += h.quantity || 0;
            }
            const closing = Math.round((it.currentStock || 0) * 1000) / 1000;
            const opening = Math.round((closing - net) * 1000) / 1000;
            return {
                itemId: it.itemId, name: it.name, category: it.category, unit: it.unit,
                opening, received: Math.round(received * 1000) / 1000,
                consumed: Math.round(consumed * 1000) / 1000, closing,
                closingValue: Math.round(closing * (it.costPerUnit || 0) * 100) / 100,
            };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const totals = report.reduce((a, r) => ({ closingValue: a.closingValue + r.closingValue }), { closingValue: 0 });
        res.json({ success: true, report, totals: { closingValue: Math.round(totals.closingValue * 100) / 100 }, period: { days, since } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to build stock report', ...devError(error) });
    }
};

// GET /api/inventory/reports/consumption — Item-wise + daily consumption (10.8.2)
exports.getConsumptionReport = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const match = { ...tf, ...bf };

        const [byItem, byDay] = await Promise.all([
            Inventory.aggregate([
                { $match: match },
                { $unwind: '$adjustmentHistory' },
                // 'return' rows (cancelled-order stock given back) net out usage.
                { $match: { 'adjustmentHistory.date': { $gte: since }, 'adjustmentHistory.type': { $in: ['usage', 'waste', 'return'] } } },
                { $group: {
                    _id: { id: '$_id', name: '$name', unit: '$unit', type: '$adjustmentHistory.type', cost: '$costPerUnit' },
                    qty: { $sum: '$adjustmentHistory.quantity' },
                } },
                { $group: {
                    _id: { id: '$_id.id', name: '$_id.name', unit: '$_id.unit', cost: '$_id.cost' },
                    usage: { $sum: { $switch: { branches: [
                        { case: { $eq: ['$_id.type', 'usage'] }, then: '$qty' },
                        { case: { $eq: ['$_id.type', 'return'] }, then: { $multiply: ['$qty', -1] } },
                    ], default: 0 } } },
                    waste: { $sum: { $cond: [{ $eq: ['$_id.type', 'waste'] }, '$qty', 0] } },
                } },
                { $set: { usage: { $max: [0, '$usage'] } } },
                { $match: { $or: [{ usage: { $gt: 0 } }, { waste: { $gt: 0 } }] } },
                { $project: {
                    _id: 0, name: '$_id.name', unit: '$_id.unit',
                    usage: { $round: ['$usage', 3] }, waste: { $round: ['$waste', 3] },
                    cost: { $round: [{ $multiply: [{ $add: ['$usage', '$waste'] }, '$_id.cost'] }, 2] },
                } },
                { $sort: { cost: -1 } },
            ]),
            Inventory.aggregate([
                { $match: match },
                { $unwind: '$adjustmentHistory' },
                { $match: { 'adjustmentHistory.date': { $gte: since }, 'adjustmentHistory.type': { $in: ['usage', 'waste', 'return'] } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$adjustmentHistory.date' } },
                    cost: { $sum: { $multiply: [
                        '$adjustmentHistory.quantity', '$costPerUnit',
                        { $cond: [{ $eq: ['$adjustmentHistory.type', 'return'] }, -1, 1] },
                    ] } },
                    consumed: { $sum: { $cond: [{ $eq: ['$adjustmentHistory.type', 'return'] }, 0, 1] } },
                } },
                { $match: { consumed: { $gt: 0 } } },
                { $project: { _id: 0, date: '$_id', cost: { $round: [{ $max: [0, '$cost'] }, 2] } } },
                { $sort: { date: 1 } },
            ]),
        ]);

        const totalCost = Math.round(byItem.reduce((s, r) => s + r.cost, 0) * 100) / 100;
        res.json({ success: true, byItem, byDay, totalCost, period: { days, since } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to build consumption report', ...devError(error) });
    }
};
