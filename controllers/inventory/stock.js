const Inventory = require('../../models/inventory');
const { tenantFilter, tenantId } = require('../../utils/tenantScope');
const { devError } = require('../../utils/AppError');
const { roundQty, branchFilter, computeStatus, notifyAdminInventoryStatus } = require('./_shared');

// GET /api/inventory/summary
exports.getSummary = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const match = { ...tf, ...bf };

        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const [summaryResult, categoryResult, expiringCount, todayResult] = await Promise.all([
            // Compute low/out-of-stock from live currentStock vs minStock.
            // The stored `status` field can lag if a row was inserted via
            // insertMany (which skips the pre('save') hook) — trust the
            // numbers, not the string.
            Inventory.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        totalItems: { $sum: 1 },
                        outOfStock: { $sum: { $cond: [{ $lte: ['$currentStock', 0] }, 1, 0] } },
                        lowStock: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$currentStock', 0] },
                                            { $lte: ['$currentStock', '$minStock'] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        totalValue: { $sum: { $multiply: ['$currentStock', '$costPerUnit'] } }
                    }
                }
            ]),
            Inventory.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: '$category',
                        count: { $sum: 1 },
                        value: { $sum: { $multiply: ['$currentStock', '$costPerUnit'] } }
                    }
                }
            ]),
            Inventory.countDocuments({
                ...match,
                expiryDate: { $lte: threeDaysFromNow, $gte: now },
            }),
            // Spec 10.2 dashboard widgets — Today's Consumption & Wastage
            // Today, valued at costPerUnit. Reads the adjustmentHistory
            // entries stamped today (auto order-deductions land as 'usage',
            // manual spoilage as 'waste').
            Inventory.aggregate([
                { $match: match },
                { $unwind: '$adjustmentHistory' },
                {
                    $match: {
                        'adjustmentHistory.date': { $gte: startOfToday },
                        // 'return' = cancelled-order stock given back; netted out of usage below.
                        'adjustmentHistory.type': { $in: ['usage', 'waste', 'return'] },
                    },
                },
                {
                    $group: {
                        _id: '$adjustmentHistory.type',
                        qty: { $sum: '$adjustmentHistory.quantity' },
                        value: { $sum: { $multiply: ['$adjustmentHistory.quantity', '$costPerUnit'] } },
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);

        const stats = summaryResult[0] || { totalItems: 0, lowStock: 0, outOfStock: 0, totalValue: 0 };
        const today = { usage: { value: 0, count: 0 }, waste: { value: 0, count: 0 } };
        let returnedValue = 0;
        (todayResult || []).forEach(r => {
            if (r._id === 'return') returnedValue = r.value;
            else if (today[r._id]) today[r._id] = { value: Math.round(r.value * 100) / 100, count: r.count };
        });
        if (returnedValue) {
            today.usage.value = Math.max(0, Math.round((today.usage.value - returnedValue) * 100) / 100);
        }
        const categoryBreakdown = {};
        categoryResult.forEach(cat => {
            categoryBreakdown[cat._id] = { count: cat.count, value: Math.round(cat.value * 100) / 100 };
        });

        res.status(200).json({
            success: true,
            summary: {
                totalItems: stats.totalItems,
                lowStock: stats.lowStock,
                outOfStock: stats.outOfStock,
                inStock: stats.totalItems - stats.lowStock - stats.outOfStock,
                totalValue: Math.round(stats.totalValue * 100) / 100,
                expiringSoon: expiringCount,
                todayConsumption: today.usage.value,
                todayConsumptionCount: today.usage.count,
                todayWastage: today.waste.value,
                todayWastageCount: today.waste.count,
                categoryBreakdown
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch summary', ...devError(error) });
    }
};

// GET /api/inventory/alerts  — low stock + out of stock + expiring soon
exports.getAlerts = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        // `status` is recomputed from currentStock/minStock in the response
        // (see .map below), so seeded rows with stale `status: 'in-stock'`
        // still surface here when their stock actually dropped.

        const [stockAlerts, expiryAlerts] = await Promise.all([
            Inventory.find({
                // Compute from stock vs min directly — the stored `status`
                // field can lag behind reality for seeded rows. Any item
                // with currentStock <= minStock qualifies.
                $expr: { $lte: ['$currentStock', '$minStock'] },
                ...tf, ...bf,
            })
                .sort({ currentStock: 1 })
                .populate('branch', 'name')
                .select('itemId name category unit currentStock minStock status branch'),
            Inventory.find({
                expiryDate: { $lte: threeDaysFromNow, $gte: now },
                ...tf, ...bf,
            })
                .sort({ expiryDate: 1 })
                .populate('branch', 'name')
                .select('itemId name category unit currentStock expiryDate status branch'),
        ]);

        // Override status on every alert row so recipients see the right label.
        const fix = (d) => ({ ...d.toObject(), status: computeStatus(d.currentStock, d.minStock) });
        res.status(200).json({
            success: true,
            stockAlerts: stockAlerts.map(fix),
            expiryAlerts,
            alerts: stockAlerts.map(fix), // backwards compat
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch alerts', ...devError(error) });
    }
};

// PATCH /api/inventory/:id/adjust
exports.adjustStock = async (req, res) => {
    try {
        const { type, quantity, reason } = req.body;

        if (!type || quantity === undefined || quantity === null) {
            return res.status(400).json({ success: false, message: 'Type and quantity are required' });
        }

        const qty = roundQty(Number(quantity));
        if (!['restock', 'usage', 'waste', 'correction', 'return', 'order-deduction'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid adjustment type' });
        }

        if (type === 'correction') {
            if (isNaN(qty) || qty < 0) {
                return res.status(400).json({ success: false, message: 'Correction quantity must be 0 or greater' });
            }
        } else {
            if (isNaN(qty) || qty <= 0) {
                return res.status(400).json({ success: false, message: 'Quantity must be a positive number' });
            }
        }

        if (reason && typeof reason === 'string' && reason.length > 500) {
            return res.status(400).json({ success: false, message: 'Reason must be under 500 characters' });
        }

        const tf = tenantFilter(req);
        // Branch scope as on the read path: a pinned Sub Admin cannot move
        // another branch's stock by id.
        const item = await Inventory.findOne({ _id: req.params.id, ...tf, ...branchFilter(req) });
        if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });

        const previousStock = item.currentStock;
        let newStock;

        if (type === 'restock' || type === 'return') {
            newStock = roundQty(previousStock + qty);
            if (item.maxStock > 0 && newStock > item.maxStock) {
                return res.status(400).json({
                    success: false,
                    message: `Cannot exceed max stock of ${item.maxStock} ${item.unit}. Current: ${previousStock}, Trying to add: ${qty}`
                });
            }
        } else if (type === 'usage' || type === 'waste' || type === 'order-deduction') {
            newStock = roundQty(previousStock - qty);
            if (newStock < 0) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient stock. Current: ${previousStock} ${item.unit}, Trying to deduct: ${qty}`
                });
            }
        } else if (type === 'correction') {
            newStock = qty;
            if (item.maxStock > 0 && newStock > item.maxStock) {
                return res.status(400).json({
                    success: false,
                    message: `Correction value (${qty}) exceeds max stock of ${item.maxStock} ${item.unit}`
                });
            }
        }

        newStock = roundQty(newStock);
        const historyEntry = {
            type: type === 'order-deduction' ? 'usage' : type,
            quantity: qty,
            previousStock,
            newStock,
            reason: (reason || '').trim().slice(0, 500),
            adjustedBy: req.user?._id || null,
            date: new Date()
        };

        const updateOps = {
            $set: { currentStock: newStock },
            $push: {
                adjustmentHistory: {
                    $each: [historyEntry],
                    $slice: -200
                }
            }
        };

        if (type === 'restock' || type === 'return') {
            updateOps.$set.lastRestocked = new Date();
        }

        const updated = await Inventory.findOneAndUpdate(
            { _id: req.params.id, currentStock: previousStock, ...tf },
            updateOps,
            { returnDocument: 'after', runValidators: true }
        );

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: 'Stock was modified by another operation. Please refresh and try again.'
            });
        }

        // Recalculate status
        const newStatus = computeStatus(updated.currentStock, updated.minStock);
        if (updated.status !== newStatus) {
            await Inventory.findOneAndUpdate({ _id: req.params.id, ...tf }, { status: newStatus });
        }

        // Fire a persistent admin notification (+ live socket ping) when
        // the status transitions away from 'in-stock'. The helper is a
        // no-op when nothing changed, so repeated adjustments that keep
        // the item at the same low/out level don't spam the admin bell.
        await notifyAdminInventoryStatus({
            invItem: { ...updated.toObject(), currentStock: newStock },
            oldStatus: updated.status,
            newStatus,
            restaurantId: tenantId(req),
            branchId: updated.branch || null,
            trigger: `manual ${type} of ${qty} ${updated.unit}`,
        });

        res.status(200).json({
            success: true,
            item: {
                _id: updated._id,
                itemId: updated.itemId,
                name: updated.name,
                previousStock,
                currentStock: newStock,
                status: newStatus
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to adjust stock', ...devError(error) });
    }
};
