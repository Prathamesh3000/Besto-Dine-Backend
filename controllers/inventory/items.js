const mongoose = require('mongoose');
const Inventory = require('../../models/inventory');
const Recipe = require('../../models/recipe');
const { tenantFilter, tenantId, pinnedBranchId } = require('../../utils/tenantScope');
const { tenantBulkWrite } = require('../../utils/tenantSafe');
const { devError } = require('../../utils/AppError');
const { ALLOWED_CATEGORIES, ALLOWED_UNITS, roundQty, escapeRegex, branchFilter, computeStatus, generateNextId, validateItemFields } = require('./_shared');

// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/inventory
exports.getAllItems = async (req, res) => {
    try {
        const { search, category, status, sortBy, sortOrder, page = 1, limit = 50 } = req.query;
        const filter = { ...tenantFilter(req), ...branchFilter(req) };

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));

        if (category) filter.category = category;
        // Translate ?status=... into a currentStock/minStock filter because
        // the stored `status` field may be stale (seeded rows, direct DB
        // writes). The live computation below relies on currentStock vs
        // minStock only, so keep the query side aligned with that.
        if (status === 'out-of-stock') filter.currentStock = { $lte: 0 };
        else if (status === 'in-stock') filter.$expr = { $gt: ['$currentStock', '$minStock'] };
        else if (status === 'low-stock') filter.$expr = {
            $and: [
                { $gt: ['$currentStock', 0] },
                { $lte: ['$currentStock', '$minStock'] },
            ],
        };
        // Expiring soon — same window the summary card counts (next 3 days,
        // not already expired). Lets the "Expiring Soon" card drill into the
        // exact rows it's counting.
        else if (status === 'expiring') {
            const now = new Date();
            filter.expiryDate = { $gte: now, $lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) };
        }
        if (search) {
            const safe = escapeRegex(search.trim());
            filter.$or = [
                { name: { $regex: safe, $options: 'i' } },
                { itemId: { $regex: safe, $options: 'i' } },
                { 'supplier.name': { $regex: safe, $options: 'i' } }
            ];
        }

        const allowedSortFields = ['name', 'currentStock', 'costPerUnit', 'category', 'status', 'createdAt', 'updatedAt', 'expiryDate'];
        const sort = {};
        if (sortBy && allowedSortFields.includes(sortBy)) {
            sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
        } else {
            sort.createdAt = -1;
        }

        const [items, total] = await Promise.all([
            Inventory.find(filter)
                .sort(sort)
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .populate('branch', 'name')
                .select('-adjustmentHistory'),
            Inventory.countDocuments(filter)
        ]);

        // Override stored status with the computed one for the response,
        // and lazily self-heal any stale DB rows in the background. This
        // is the safety net for seeded / legacy data that bypassed the
        // pre('save') status hook.
        const drifted = [];
        const corrected = items.map(item => {
            const right = computeStatus(item.currentStock, item.minStock);
            if (item.status !== right) {
                drifted.push({ _id: item._id, right });
                item.status = right;
            }
            return item;
        });
        if (drifted.length > 0) {
            const bulk = drifted.map(d => ({
                updateOne: { filter: { _id: d._id }, update: { $set: { status: d.right } } },
            }));
            tenantBulkWrite(Inventory, bulk, tenantId(req), { ordered: false }).catch(() => {});
        }

        res.status(200).json({
            success: true,
            items: corrected,
            pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch inventory', ...devError(error) });
    }
};

// GET /api/inventory/next-id
exports.getNextId = async (req, res) => {
    try {
        const nextId = await generateNextId(req);
        res.status(200).json({ success: true, nextId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to generate ID' });
    }
};

// GET /api/inventory/:id
exports.getItemById = async (req, res) => {
    try {
        // Branch-pinned staff must not see cross-branch items via direct ID.
        const item = await Inventory.findOne({
            _id: req.params.id,
            ...tenantFilter(req),
            ...branchFilter(req),
        })
            .populate('adjustmentHistory.adjustedBy', 'name role staffId')
            .populate('branch', 'name');

        if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });

        if (item.adjustmentHistory && item.adjustmentHistory.length > 50) {
            item.adjustmentHistory = item.adjustmentHistory.slice(-50);
        }

        // Override stored status with the live computation (see getAllItems).
        // R-10: the `item` was fetched with tenantFilter(req) above so the
        // identity is already in-tenant, but keep the scope in the write
        // filter too — defense-in-depth, and the audit flagged the bare
        // `{_id}` shape specifically.
        const right = computeStatus(item.currentStock, item.minStock);
        if (item.status !== right) {
            item.status = right;
            Inventory.updateOne(
                { _id: item._id, ...tenantFilter(req) },
                { $set: { status: right } }
            ).catch(() => {});
        }

        res.status(200).json({ success: true, item });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch item', ...devError(error) });
    }
};

// POST /api/inventory
exports.createItem = async (req, res) => {
    try {
        const { name, category, unit, currentStock, minStock, maxStock, costPerUnit, supplier, expiryDate, branch, expiryTracking, shelfLifeDays } = req.body;

        const validationErrors = validateItemFields({ name, minStock, maxStock, costPerUnit, currentStock, expiryDate, shelfLifeDays }, true);
        // Required + enum checks up front → 400 (these used to surface as a
        // 500 from a TypeError on name.trim() or a Mongoose ValidationError).
        if (typeof name !== 'string') validationErrors.unshift('Item name is required');
        if (!ALLOWED_CATEGORIES.includes(category)) validationErrors.push(`category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
        if (!ALLOWED_UNITS.includes(unit)) validationErrors.push(`unit must be one of: ${ALLOWED_UNITS.join(', ')}`);
        if (validationErrors.length > 0) {
            return res.status(400).json({ success: false, message: validationErrors[0], errors: validationErrors });
        }

        const tf = tenantFilter(req);
        const safeName = escapeRegex(name.trim());
        const exists = await Inventory.findOne({ name: { $regex: new RegExp(`^${safeName}$`, 'i') }, category, ...tf });
        if (exists) {
            return res.status(400).json({ success: false, message: 'An item with this name already exists in this category' });
        }

        // Validate branch belongs to this tenant. A branch-pinned Sub Admin
        // is FORCED to their own branch — body.branch is ignored for them.
        let branchId = null;
        const pinned = pinnedBranchId(req);
        if (pinned) {
            branchId = pinned;
        } else if (branch && mongoose.isValidObjectId(branch)) {
            const Branch = require('../../models/branch');
            const branchExists = await Branch.exists({ _id: branch, ...tf, isActive: true });
            if (branchExists) branchId = branch;
        }

        const itemId = await generateNextId(req);
        const stockQty = roundQty(Number(currentStock) || 0);

        const item = new Inventory({
            itemId,
            restaurant: tenantId(req),
            branch: branchId,
            name: name.trim(),
            category,
            unit,
            currentStock: stockQty,
            minStock: Number(minStock),
            maxStock: Number(maxStock) || 0,
            costPerUnit: Number(costPerUnit),
            supplier: supplier || {},
            expiryTracking: expiryTracking === true || expiryTracking === 'true',
            shelfLifeDays: Number(shelfLifeDays) || 0,
            expiryDate: expiryDate || undefined,
            lastRestocked: stockQty > 0 ? new Date() : undefined,
            adjustmentHistory: stockQty > 0 ? [{
                type: 'restock',
                quantity: stockQty,
                previousStock: 0,
                newStock: stockQty,
                reason: 'Initial stock',
                adjustedBy: req.user._id,
                date: new Date()
            }] : []
        });

        await item.save();
        res.status(201).json({ success: true, item });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Duplicate item ID — please try again' });
        }
        if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ success: false, message: error.message });
        res.status(500).json({ success: false, message: 'Failed to create inventory item', ...devError(error) });
    }
};

// PUT /api/inventory/:id
exports.updateItem = async (req, res) => {
    try {
        const { name, category, unit, minStock, maxStock, costPerUnit, supplier, expiryDate, branch, expiryTracking, shelfLifeDays } = req.body;

        const validationErrors = validateItemFields({ name, minStock, maxStock, costPerUnit, expiryDate, shelfLifeDays });
        if (category !== undefined && !ALLOWED_CATEGORIES.includes(category)) validationErrors.push(`category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
        if (unit !== undefined && !ALLOWED_UNITS.includes(unit)) validationErrors.push(`unit must be one of: ${ALLOWED_UNITS.join(', ')}`);
        if (validationErrors.length > 0) {
            return res.status(400).json({ success: false, message: validationErrors[0], errors: validationErrors });
        }

        const tf = tenantFilter(req);
        // Same branch scope as the read path — a branch-pinned Sub Admin
        // cannot edit another branch's item by id.
        const item = await Inventory.findOne({ _id: req.params.id, ...tf, ...branchFilter(req) });
        if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });

        if (name && name.trim().toLowerCase() !== item.name.toLowerCase()) {
            const safeName = escapeRegex(name.trim());
            const targetCategory = category || item.category;
            const duplicate = await Inventory.findOne({
                _id: { $ne: item._id },
                name: { $regex: new RegExp(`^${safeName}$`, 'i') },
                category: targetCategory,
                ...tf,
            });
            if (duplicate) {
                return res.status(400).json({ success: false, message: 'An item with this name already exists in this category' });
            }
        }

        const effectiveMin = minStock !== undefined ? Number(minStock) : item.minStock;
        const effectiveMax = maxStock !== undefined ? Number(maxStock) : item.maxStock;
        if (effectiveMax > 0 && effectiveMin > effectiveMax) {
            return res.status(400).json({ success: false, message: `Min stock (${effectiveMin}) cannot exceed max stock (${effectiveMax})` });
        }

        // Handle branch update
        let branchId = undefined;
        if (branch !== undefined) {
            if (branch === null || branch === '') {
                branchId = null;
            } else if (mongoose.isValidObjectId(branch)) {
                const Branch = require('../../models/branch');
                const branchExists = await Branch.exists({ _id: branch, ...tf, isActive: true });
                branchId = branchExists ? branch : item.branch;
            }
        }

        const updateData = {
            name: name?.trim(), category, unit,
            minStock: minStock !== undefined ? Number(minStock) : undefined,
            maxStock: maxStock !== undefined ? Number(maxStock) : undefined,
            costPerUnit: costPerUnit !== undefined ? Number(costPerUnit) : undefined,
            supplier, expiryDate,
            expiryTracking: expiryTracking !== undefined ? (expiryTracking === true || expiryTracking === 'true') : undefined,
            shelfLifeDays: shelfLifeDays !== undefined ? (Number(shelfLifeDays) || 0) : undefined,
            branch: branchId,
        };
        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        Object.assign(item, updateData);
        await item.save();

        res.status(200).json({ success: true, item });
    } catch (error) {
        if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ success: false, message: error.message });
        res.status(500).json({ success: false, message: 'Failed to update item', ...devError(error) });
    }
};

// DELETE /api/inventory/:id
exports.deleteItem = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const item = await Inventory.findOneAndDelete({ _id: req.params.id, ...tf, ...branchFilter(req) });
        if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });
        // Also clean up any recipe references
        await Recipe.updateMany(
            { restaurant: tenantId(req) },
            { $pull: { ingredients: { inventoryItem: req.params.id } } }
        );
        res.status(200).json({ success: true, message: 'Inventory item deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete item', ...devError(error) });
    }
};
