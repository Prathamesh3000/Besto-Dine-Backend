const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Inventory = require('../models/inventory');
const Recipe = require('../models/recipe');
const MenuItem = require('../models/menuItem');
const Order = require('../models/order');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { parseCsv } = require('../utils/csvParser');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');

// ─── Allowed enums (mirrored from the Inventory schema) ─────────────────────
const ALLOWED_CATEGORIES = [
    'Raw Ingredients', 'Beverages', 'Dairy & Eggs', 'Spices & Seasonings',
    'Packaging', 'Cleaning Supplies', 'Kitchen Equipment', 'Bakery Items',
    'Fruits & Vegetables', 'Frozen Goods', 'Oils & Sauces', 'Other'
];
const ALLOWED_UNITS = ['kg', 'g', 'L', 'mL', 'pcs', 'dozen', 'box', 'pack', 'bottle', 'can'];

// ─── Helpers ────────────────────────────────────────────────────────────────

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a branch filter for inventory reads.
 *
 * Branch-pinned staff are FORCED to their own branch — they cannot
 * widen scope via ?branch=all or ?branch=<otherId>. For tenant owners
 * the query param controls scope as before.
 *
 * Inventory `branch: null` historically meant "tenant-wide / unassigned",
 * NOT "shared with all branches". The migration in
 * Seed/migrateLegacyBranchNulls.js reassigns those legacy rows to the
 * tenant's main branch so Sub Admins no longer see them by accident.
 */
function branchFilter(req) {
    return strictBranchFilter(req);
}

/** Unit conversion table — convert `from` unit to `to` unit. Returns
 *  a multiplier, or null if units are incompatible. */
const UNIT_CONVERSIONS = {
    'kg_g': 1000, 'g_kg': 0.001,
    'L_mL': 1000, 'mL_L': 0.001,
};
function convertUnits(qty, from, to) {
    if (from === to) return qty;
    const key = `${from}_${to}`;
    if (UNIT_CONVERSIONS[key]) return qty * UNIT_CONVERSIONS[key];
    return null; // incompatible
}

/**
 * Single source of truth for status — used on both the write path
 * (adjustStock, deductInventoryForOrder, restoreInventoryForOrder)
 * and the read path (getAllItems, getSummary, getItemById), so rows
 * seeded via insertMany (which bypass the pre('save') hook) or edited
 * via updateOne don't drift out of sync with currentStock/minStock.
 */
function computeStatus(currentStock, minStock) {
    if (currentStock <= 0) return 'out-of-stock';
    if (currentStock <= (minStock || 0)) return 'low-stock';
    return 'in-stock';
}

/**
 * Persist + broadcast a stock-status alert to the admin audience when
 * an inventory item TRANSITIONS into low-stock or out-of-stock. Skips
 * silently when:
 *   - the status didn't actually change (nothing newsworthy),
 *   - the item recovered into 'in-stock' (no alert needed, the bell
 *     already cleared last time),
 *   - inputs are missing.
 *
 * Why a Notification doc + a socket event (not just one):
 *   - The Notification persists so an admin who walks up to the
 *     dashboard after the alert fired still sees it in the bell list
 *     and the unread count.
 *   - The socket `notification:new` triggers the existing live toast
 *     handler in NotificationContext, so connected admins get an
 *     immediate audible/visual ping without polling.
 *   - The legacy `inventory:alert` is kept for any inventory-specific
 *     consumers that want richer payload than the generic notification.
 *
 * Best-effort: all failures are swallowed so a notification miss can
 * never block the underlying stock write (which is the higher-stakes
 * operation).
 */
async function notifyAdminInventoryStatus({
    invItem,
    oldStatus,
    newStatus,
    restaurantId,
    branchId = null,
    trigger = '',
}) {
    try {
        if (!invItem || !restaurantId) return;
        if (oldStatus === newStatus) return;
        if (newStatus === 'in-stock') return;

        const isOut = newStatus === 'out-of-stock';
        const title = isOut
            ? 'Out of stock'
            : 'Low stock alert';
        const stockText = `${Math.round((invItem.currentStock ?? 0) * 1000) / 1000} ${invItem.unit || ''}`.trim();
        const description = isOut
            ? `${invItem.name} is out of stock${trigger ? ` (after ${trigger})` : ''}. Restock to keep dependent menu items orderable.`
            : `${invItem.name} dropped to ${stockText}${trigger ? ` (after ${trigger})` : ''}. Below the minimum threshold.`;

        await notify({
            restaurant: restaurantId,
            branch: branchId || invItem.branch || null,
            audience: 'admin',
            notification: {
                recipient: null,
                recipientRole: 'admin',
                category: 'System',
                priority: isOut ? 'high' : 'medium',
                title,
                description,
                meta: {
                    amount: invItem.currentStock ?? 0,
                },
            },
            // Generic notification event so the standard admin notification
            // handler picks it up (bell + toast + sound).
            payload: {
                title,
                description,
                category: 'System',
                priority: isOut ? 'high' : 'medium',
            },
            // Keep the legacy inventory-specific channel for any
            // dashboards that want the richer payload (item id, unit).
            also: [{
                event: EVENTS.INVENTORY_ALERT,
                payload: {
                    itemId: invItem.itemId,
                    name: invItem.name,
                    status: newStatus,
                    currentStock: invItem.currentStock ?? 0,
                    unit: invItem.unit,
                    trigger: trigger || undefined,
                },
            }],
        });
    } catch (err) {
        logger.warn('Inventory status alert failed (non-fatal):', err.message);
    }
}

// ─── ID Generation ──────────────────────────────────────────────────────────

const generateNextId = async (req, retries = 3) => {
    const tf = tenantFilter(req);
    for (let attempt = 0; attempt < retries; attempt++) {
        const last = await Inventory.findOne(tf).sort({ itemId: -1 });
        if (!last || !last.itemId) return 'INV-001';
        const num = parseInt(last.itemId.split('-')[1]) + 1;
        const nextId = `INV-${num.toString().padStart(3, '0')}`;
        const exists = await Inventory.findOne({ itemId: nextId, ...tf });
        if (!exists) return nextId;
    }
    return `INV-${Date.now().toString(36).toUpperCase()}`;
};

// ─── Validation ─────────────────────────────────────────────────────────────

const validateItemFields = ({ name, minStock, maxStock, costPerUnit, currentStock, expiryDate, shelfLifeDays }, isCreate = false) => {
    const errors = [];
    if (name !== undefined) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) errors.push('Item name cannot be empty');
        if (trimmed.length > 100) errors.push('Item name must be under 100 characters');
    }
    if (minStock !== undefined) {
        const n = Number(minStock);
        if (isNaN(n) || n < 0) errors.push('Min stock must be a non-negative number');
    }
    if (maxStock !== undefined) {
        const n = Number(maxStock);
        if (isNaN(n) || n < 0) errors.push('Max stock must be a non-negative number');
    }
    if (costPerUnit !== undefined) {
        const n = Number(costPerUnit);
        if (isNaN(n) || n < 0) errors.push('Cost per unit must be a non-negative number');
    }
    if (maxStock !== undefined && minStock !== undefined) {
        const max = Number(maxStock);
        const min = Number(minStock);
        if (max > 0 && min > max) errors.push(`Min stock (${min}) cannot exceed max stock (${max})`);
    }
    // currentStock must never be negative — neither on create nor on a
    // direct update. Stock-deduction flows (orders consuming inventory)
    // should clamp at 0 separately; this guard catches direct admin
    // typos like setting "current stock = -5" in the edit form.
    if (currentStock !== undefined) {
        const stock = Number(currentStock);
        if (isNaN(stock) || stock < 0) errors.push('Current stock cannot be negative');
    }
    if (isCreate && currentStock !== undefined && maxStock !== undefined) {
        const stock = Number(currentStock);
        const max = Number(maxStock);
        if (max > 0 && stock > max) errors.push(`Initial stock (${stock}) cannot exceed max stock (${max})`);
    }
    if (expiryDate) {
        const d = new Date(expiryDate);
        if (isNaN(d.getTime())) errors.push('Invalid expiry date');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (d < today) errors.push('Expiry date cannot be in the past');
    }
    if (shelfLifeDays !== undefined && shelfLifeDays !== null && shelfLifeDays !== '') {
        const n = Number(shelfLifeDays);
        if (isNaN(n) || n < 0) errors.push('Shelf life (days) must be a non-negative number');
    }
    return errors;
};

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
            Inventory.bulkWrite(bulk, { ordered: false }).catch(() => {});
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
                        'adjustmentHistory.type': { $in: ['usage', 'waste'] },
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
        (todayResult || []).forEach(r => {
            if (today[r._id]) today[r._id] = { value: Math.round(r.value * 100) / 100, count: r.count };
        });
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
            const Branch = require('../models/branch');
            const branchExists = await Branch.exists({ _id: branch, ...tf, isActive: true });
            if (branchExists) branchId = branch;
        }

        const itemId = await generateNextId(req);
        const stockQty = Number(currentStock) || 0;

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
        res.status(500).json({ success: false, message: 'Failed to create inventory item', ...devError(error) });
    }
};

// ADM-083 — POST /api/inventory/import — bulk CSV import.
//
// Behaviour: rows whose (name, category) match an existing item are
// UPDATED (stock-relevant fields applied; an `restock` adjustmentHistory
// entry is appended when currentStock changes). Rows with no match are
// CREATED with a fresh INV-### id.
//
// CSV columns (header row required, case-insensitive, order-free):
//   name*, category*, unit*, minStock*, costPerUnit*,
//   currentStock (default 0),
//   maxStock (default 0 = no cap),
//   supplierName, supplierContact, expiryDate
// GET /api/v1/inventory/template
// Streams the pre-filled A-Z ingredients master CSV (300+ rows across all
// 12 categories) so admins can delete unwanted rows and re-upload via
// /import — same quick-onboarding pattern Tables/Staff use.
const INVENTORY_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'inventory-master-template.csv');

exports.downloadInventoryTemplate = (req, res) => {
    try {
        if (!fs.existsSync(INVENTORY_TEMPLATE_PATH)) {
            logger.error('Inventory template missing on disk', { path: INVENTORY_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="inventory-master-template.csv"');
        // No-store so admins picking up a fresh copy after we ship template
        // updates don't get stuck on a cached older version.
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(INVENTORY_TEMPLATE_PATH).pipe(res);
    } catch (error) {
        logger.error('downloadInventoryTemplate error', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

exports.importItemsCsv = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
        }

        const rows = parseCsv(req.file.buffer.toString('utf8'));
        if (rows.length < 2) {
            return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
        }

        const header = rows[0].map(h => String(h || '').trim().toLowerCase());
        const idx = {
            name:           header.indexOf('name'),
            category:       header.indexOf('category'),
            unit:           header.indexOf('unit'),
            minStock:       header.indexOf('minstock'),
            costPerUnit:    header.indexOf('costperunit'),
            currentStock:   header.indexOf('currentstock'),
            maxStock:       header.indexOf('maxstock'),
            supplierName:   header.indexOf('suppliername'),
            supplierContact:header.indexOf('suppliercontact'),
            expiryDate:     header.indexOf('expirydate'),
        };
        const missing = ['name', 'category', 'unit', 'minStock', 'costPerUnit']
            .filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`,
            });
        }

        const tf = tenantFilter(req);
        const restaurantId = tenantId(req);
        // Branch-pinned Sub Admins import into their own branch only —
        // matches the createItem behavior. Tenant owners can leave the
        // branch null (tenant-level) for now; per-row branch column is
        // intentionally out of scope to keep the CSV simple.
        //
        // 2026-05-27: pinned staff still forced to their branch (correct).
        // For a non-pinned tenant owner, prefer the branch they have
        // selected in the admin switcher (sent via `?branch=<id>` by the
        // axios interceptor) over `null`. Without this, every CSV row
        // landed at branch:null and was then HIDDEN by the strict
        // `branchFilter` when the owner viewed any specific branch — so
        // the master template "imported 394 items" but the list page
        // showed 0. Pinning to the active-view branch makes the items
        // visible where they were imported.
        let branchId = pinnedBranchId(req);
        if (!branchId) {
            const rawBranchParam = req?.query?.branch || req?.body?.branch;
            if (rawBranchParam && mongoose.isValidObjectId(rawBranchParam)) {
                branchId = new mongoose.Types.ObjectId(String(rawBranchParam));
            } else if (req?.branch?._id) {
                branchId = req.branch._id;
            } else {
                branchId = null;
            }
        }

        const errors = [];
        let created = 0;
        let updated = 0;

        for (let i = 1; i < rows.length; i++) {
            const rowNum = i + 1; // CSV header is row 1
            const cells = rows[i];
            const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

            try {
                const name = get('name');
                const category = get('category');
                const unit = get('unit');
                const minStockRaw = get('minStock');
                const costPerUnitRaw = get('costPerUnit');

                if (!name) throw new Error('name is required');
                if (!ALLOWED_CATEGORIES.includes(category)) {
                    throw new Error(`category must be one of: ${ALLOWED_CATEGORIES.join(' | ')}`);
                }
                if (!ALLOWED_UNITS.includes(unit)) {
                    throw new Error(`unit must be one of: ${ALLOWED_UNITS.join(' | ')}`);
                }
                const minStock = Number(minStockRaw);
                if (!Number.isFinite(minStock) || minStock < 0) {
                    throw new Error('minStock must be a non-negative number');
                }
                const costPerUnit = Number(costPerUnitRaw);
                if (!Number.isFinite(costPerUnit) || costPerUnit < 0) {
                    throw new Error('costPerUnit must be a non-negative number');
                }

                const currentStockRaw = get('currentStock');
                const currentStock = currentStockRaw === '' ? 0 : Number(currentStockRaw);
                if (!Number.isFinite(currentStock) || currentStock < 0) {
                    throw new Error('currentStock must be a non-negative number');
                }
                const maxStockRaw = get('maxStock');
                const maxStock = maxStockRaw === '' ? 0 : Number(maxStockRaw);
                if (!Number.isFinite(maxStock) || maxStock < 0) {
                    throw new Error('maxStock must be a non-negative number');
                }
                if (maxStock > 0 && minStock > maxStock) {
                    throw new Error(`minStock (${minStock}) cannot exceed maxStock (${maxStock})`);
                }

                let expiryDate;
                const expiryRaw = get('expiryDate');
                if (expiryRaw) {
                    const d = new Date(expiryRaw);
                    if (Number.isNaN(d.getTime())) throw new Error(`invalid expiryDate "${expiryRaw}"`);
                    expiryDate = d;
                }

                // Upsert key — case-insensitive name within the same
                // (category, tenant) — mirrors the duplicate check in
                // createItem so the CSV path can't create a row the UI
                // would reject.
                const safeName = escapeRegex(name);
                const existing = await Inventory.findOne({
                    name: { $regex: new RegExp(`^${safeName}$`, 'i') },
                    category,
                    ...tf,
                });

                if (existing) {
                    // Mutate in place so the pre('save') status hook runs.
                    const stockDelta = currentStock - existing.currentStock;
                    existing.unit = unit;
                    existing.minStock = minStock;
                    existing.maxStock = maxStock;
                    existing.costPerUnit = costPerUnit;
                    if (get('supplierName') || get('supplierContact')) {
                        existing.supplier = {
                            name: get('supplierName') || existing.supplier?.name || '',
                            contact: get('supplierContact') || existing.supplier?.contact || '',
                        };
                    }
                    if (expiryDate) existing.expiryDate = expiryDate;
                    if (stockDelta !== 0) {
                        const previous = existing.currentStock;
                        existing.currentStock = currentStock;
                        existing.lastRestocked = stockDelta > 0 ? new Date() : existing.lastRestocked;
                        existing.adjustmentHistory.push({
                            type: stockDelta > 0 ? 'restock' : 'correction',
                            quantity: Math.abs(stockDelta),
                            previousStock: previous,
                            newStock: currentStock,
                            reason: 'CSV import',
                            adjustedBy: req.user._id,
                            date: new Date(),
                        });
                    }
                    await existing.save();
                    updated += 1;
                } else {
                    const itemId = await generateNextId(req);
                    const doc = new Inventory({
                        itemId,
                        restaurant: restaurantId,
                        branch: branchId,
                        name,
                        category,
                        unit,
                        currentStock,
                        minStock,
                        maxStock,
                        costPerUnit,
                        supplier: {
                            name: get('supplierName') || '',
                            contact: get('supplierContact') || '',
                        },
                        ...(expiryDate ? { expiryDate } : {}),
                        ...(currentStock > 0 ? { lastRestocked: new Date() } : {}),
                        adjustmentHistory: currentStock > 0 ? [{
                            type: 'restock',
                            quantity: currentStock,
                            previousStock: 0,
                            newStock: currentStock,
                            reason: 'CSV import — initial stock',
                            adjustedBy: req.user._id,
                            date: new Date(),
                        }] : [],
                    });
                    await doc.save();
                    created += 1;
                }
            } catch (rowErr) {
                errors.push({ row: rowNum, message: rowErr.message });
            }
        }

        return res.status(200).json({
            success: true,
            created,
            updated,
            errorCount: errors.length,
            errors,
        });
    } catch (err) {
        logger.error('Inventory CSV import error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to import CSV' });
    }
};

// PUT /api/inventory/:id
exports.updateItem = async (req, res) => {
    try {
        const { name, category, unit, minStock, maxStock, costPerUnit, supplier, expiryDate, branch, expiryTracking, shelfLifeDays } = req.body;

        const validationErrors = validateItemFields({ name, minStock, maxStock, costPerUnit, expiryDate, shelfLifeDays });
        if (validationErrors.length > 0) {
            return res.status(400).json({ success: false, message: validationErrors[0], errors: validationErrors });
        }

        const tf = tenantFilter(req);
        const item = await Inventory.findOne({ _id: req.params.id, ...tf });
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
                const Branch = require('../models/branch');
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
        res.status(500).json({ success: false, message: 'Failed to update item', ...devError(error) });
    }
};

// PATCH /api/inventory/:id/adjust
exports.adjustStock = async (req, res) => {
    try {
        const { type, quantity, reason } = req.body;

        if (!type || quantity === undefined || quantity === null) {
            return res.status(400).json({ success: false, message: 'Type and quantity are required' });
        }

        const qty = Number(quantity);
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
        const item = await Inventory.findOne({ _id: req.params.id, ...tf });
        if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });

        const previousStock = item.currentStock;
        let newStock;

        if (type === 'restock' || type === 'return') {
            newStock = previousStock + qty;
            if (item.maxStock > 0 && newStock > item.maxStock) {
                return res.status(400).json({
                    success: false,
                    message: `Cannot exceed max stock of ${item.maxStock} ${item.unit}. Current: ${previousStock}, Trying to add: ${qty}`
                });
            }
        } else if (type === 'usage' || type === 'waste' || type === 'order-deduction') {
            newStock = previousStock - qty;
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

// DELETE /api/inventory/:id
exports.deleteItem = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const item = await Inventory.findOneAndDelete({ _id: req.params.id, ...tf });
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

// ═══════════════════════════════════════════════════════════════════════════
//  RECIPE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/inventory/recipes — list all recipes (with populated names)
exports.getRecipes = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const recipes = await Recipe.find({ ...tf, ...bf })
            .populate('menuItem', 'name basePrice finalPrice images category inStock')
            .populate('ingredients.inventoryItem', 'name unit costPerUnit currentStock status')
            .sort({ updatedAt: -1 })
            .lean();

        // An orphaned recipe points at a deleted MenuItem and populates
        // `menuItem: null`. It used to show up in the admin Recipes tab
        // as a "—" row with a phantom food cost. Self-heal by deleting
        // them on read — the cascade in menuController.deleteMenuItem
        // handles new deletes, this catches any that slipped through.
        const orphanIds = recipes.filter(r => !r.menuItem).map(r => r._id);
        if (orphanIds.length > 0) {
            Recipe.deleteMany({ _id: { $in: orphanIds } }).catch(() => {});
        }
        const live = recipes.filter(r => r.menuItem);

        // Calculate food cost for each recipe
        const enriched = live.map(r => {
            let foodCost = 0;
            for (const ing of r.ingredients) {
                if (ing.inventoryItem) {
                    const converted = convertUnits(ing.quantity, ing.unit, ing.inventoryItem.unit);
                    const qty = converted !== null ? converted : ing.quantity;
                    foodCost += qty * (ing.inventoryItem.costPerUnit || 0);
                }
            }
            // Per serving, then inflated for prep loss (yield shrinkage).
            foodCost = foodCost / (r.yield || 1) / (1 - Math.min(95, Math.max(0, r.prepLossPercent || 0)) / 100);
            const sellingPrice = r.menuItem.finalPrice || r.menuItem.basePrice || 0;
            const margin = sellingPrice > 0 ? ((sellingPrice - foodCost) / sellingPrice) * 100 : 0;
            return { ...r, foodCost: Math.round(foodCost * 100) / 100, margin: Math.round(margin * 10) / 10 };
        });

        res.status(200).json({ success: true, recipes: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch recipes', ...devError(error) });
    }
};

// GET /api/inventory/recipes/:menuItemId — single recipe by menu item
exports.getRecipeByMenuItem = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const recipe = await Recipe.findOne({ menuItem: req.params.menuItemId, ...tf, ...bf })
            .populate('menuItem', 'name basePrice finalPrice images')
            .populate('ingredients.inventoryItem', 'name unit costPerUnit currentStock status category');

        if (!recipe) return res.status(404).json({ success: false, message: 'No recipe found for this menu item' });

        let foodCost = 0;
        for (const ing of recipe.ingredients) {
            if (ing.inventoryItem) {
                const converted = convertUnits(ing.quantity, ing.unit, ing.inventoryItem.unit);
                const qty = converted !== null ? converted : ing.quantity;
                foodCost += qty * (ing.inventoryItem.costPerUnit || 0);
            }
        }
        foodCost = foodCost / (recipe.yield || 1) / (1 - Math.min(95, Math.max(0, recipe.prepLossPercent || 0)) / 100);
        const sellingPrice = recipe.menuItem?.finalPrice || recipe.menuItem?.basePrice || 0;
        const margin = sellingPrice > 0 ? ((sellingPrice - foodCost) / sellingPrice) * 100 : 0;

        res.status(200).json({
            success: true,
            recipe: recipe.toObject(),
            foodCost: Math.round(foodCost * 100) / 100,
            margin: Math.round(margin * 10) / 10,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch recipe', ...devError(error) });
    }
};

// POST /api/inventory/recipes — create or update recipe
exports.saveRecipe = async (req, res) => {
    try {
        const { menuItemId, ingredients, yield: recipeYield, notes, recipeType, prepLossPercent } = req.body;
        const tf = tenantFilter(req);

        if (!menuItemId || !mongoose.isValidObjectId(menuItemId)) {
            return res.status(400).json({ success: false, message: 'Valid menuItemId is required' });
        }
        if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one ingredient is required' });
        }

        // Verify menu item belongs to this tenant
        const menuItem = await MenuItem.findOne({ _id: menuItemId, ...tf });
        if (!menuItem) return res.status(404).json({ success: false, message: 'Menu item not found' });

        // Verify all inventory items belong to this tenant
        const invIds = ingredients.map(i => i.inventoryItem).filter(Boolean);
        const invItems = await Inventory.find({ _id: { $in: invIds }, ...tf }).select('_id');
        const validIds = new Set(invItems.map(i => i._id.toString()));

        const cleanIngredients = ingredients
            .filter(i => i.inventoryItem && validIds.has(i.inventoryItem.toString()) && i.quantity > 0)
            .map(i => ({
                inventoryItem: i.inventoryItem,
                quantity: Number(i.quantity),
                unit: i.unit,
            }));

        if (cleanIngredients.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid ingredients provided' });
        }

        // Sub Admin owns the recipe at their branch; tenant owner creates
        // branch-less (null) recipes unless body.branch is explicitly set.
        const ownerBranch = pinnedBranchId(req) || req.body.branch || null;

        const recipe = await Recipe.findOneAndUpdate(
            { menuItem: menuItemId, restaurant: tenantId(req), branch: ownerBranch },
            {
                restaurant: tenantId(req),
                branch: ownerBranch,
                menuItem: menuItemId,
                ingredients: cleanIngredients,
                yield: Number(recipeYield) || 1,
                recipeType: recipeType === 'semi-finished' ? 'semi-finished' : 'finished',
                prepLossPercent: Math.min(95, Math.max(0, Number(prepLossPercent) || 0)),
                notes: (notes || '').slice(0, 500),
            },
            { upsert: true, returnDocument: 'after', runValidators: true }
        );

        // Also update menuItem.ingredients text array for backward compat
        const invDocs = await Inventory.find({ _id: { $in: invIds }, ...tf }).select('name');
        const nameMap = Object.fromEntries(invDocs.map(d => [d._id.toString(), d.name]));
        menuItem.ingredients = cleanIngredients.map(i => nameMap[i.inventoryItem.toString()] || '');
        await menuItem.save();

        res.status(200).json({ success: true, recipe });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Recipe already exists for this menu item' });
        }
        res.status(500).json({ success: false, message: 'Failed to save recipe', ...devError(error) });
    }
};

// GET /api/v1/inventory/recipes/template
// Streams the pre-filled Recipes master CSV. One row per ingredient line;
// rows sharing the same menuItemName get merged into a single Recipe by
// the import endpoint below. Admin downloads, deletes rows for menu items
// the cafe doesn't carry, edits quantities, and uploads.
const RECIPES_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'recipes-master-template.csv');

exports.downloadRecipesTemplate = (req, res) => {
    try {
        if (!fs.existsSync(RECIPES_TEMPLATE_PATH)) {
            logger.error('Recipes template missing on disk', { path: RECIPES_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="recipes-master-template.csv"');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(RECIPES_TEMPLATE_PATH).pipe(res);
    } catch (error) {
        logger.error('downloadRecipesTemplate error', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

// POST /api/v1/inventory/recipes/import
// CSV columns (header required, case-insensitive, order-free):
//   menuItemName*, inventoryItemName*, quantity*, unit*, yield, notes
// Rows are GROUPED BY menuItemName — each group becomes ONE Recipe doc
// with all matching ingredients. `yield` and `notes` are read from the
// FIRST row of each group; later rows can repeat or leave them blank.
// Behaviour: UPSERT by (menuItem, tenant, branch) — re-uploading the
// same CSV updates the existing recipe (overwrites ingredients list).
exports.importRecipesCsv = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
        }

        const rows = parseCsv(req.file.buffer.toString('utf8'));
        if (rows.length < 2) {
            return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
        }

        const header = rows[0].map(h => String(h || '').trim().toLowerCase());
        const idx = {
            menuItemName:      header.indexOf('menuitemname'),
            inventoryItemName: header.indexOf('inventoryitemname'),
            quantity:          header.indexOf('quantity'),
            unit:              header.indexOf('unit'),
            yield:             header.indexOf('yield'),
            notes:             header.indexOf('notes'),
        };
        const missing = ['menuItemName', 'inventoryItemName', 'quantity', 'unit']
            .filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`,
            });
        }

        const tf = tenantFilter(req);
        const tenantIdValue = tenantId(req);
        // Same admin-active-branch fallback as importItemsCsv above —
        // see the comment there for the full rationale.
        let branchId = pinnedBranchId(req);
        if (!branchId) {
            const rawBranchParam = req?.query?.branch || req?.body?.branch;
            if (rawBranchParam && mongoose.isValidObjectId(rawBranchParam)) {
                branchId = new mongoose.Types.ObjectId(String(rawBranchParam));
            } else if (req?.branch?._id) {
                branchId = req.branch._id;
            } else {
                branchId = null;
            }
        }

        // Pre-load all menu items + inventory items for this tenant so we
        // can do case-insensitive name lookups in JS instead of one query
        // per row (300+ row CSV would otherwise cost 300+ trips to Mongo).
        const [menuDocs, invDocs] = await Promise.all([
            MenuItem.find(tf).select('_id name').lean(),
            Inventory.find(tf).select('_id name unit').lean(),
        ]);
        const menuByName = new Map(menuDocs.map(m => [m.name.toLowerCase(), m]));
        const invByName = new Map(invDocs.map(i => [i.name.toLowerCase(), i]));

        // ── Group rows by menu item name ──────────────────────────────
        const groups = new Map(); // menuItemNameLower -> { rowNum, menuItemName, yield, notes, ingredients:[{rowNum, name, qty, unit}], errors:[] }
        const groupErrors = [];   // errors for rows we couldn't even group (e.g. missing menuItemName)

        for (let i = 1; i < rows.length; i++) {
            const rowNum = i + 1;
            const cells = rows[i];
            const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

            const menuItemName = get('menuItemName');
            if (!menuItemName) {
                // Blank line — skip silently. A row with no menu name is
                // commonly an Excel trailing empty row, not user intent.
                if (cells.every(c => !String(c || '').trim())) continue;
                groupErrors.push({ row: rowNum, message: 'menuItemName is required' });
                continue;
            }

            const key = menuItemName.toLowerCase();
            if (!groups.has(key)) {
                groups.set(key, {
                    firstRowNum: rowNum,
                    menuItemName,
                    yield: Number(get('yield')) || 1,
                    notes: (get('notes') || '').slice(0, 500),
                    ingredients: [],
                });
            }
            const grp = groups.get(key);
            // Allow later rows to fill in yield/notes if the first row left them blank.
            if (!grp.notes && get('notes')) grp.notes = get('notes').slice(0, 500);
            if (grp.yield === 1 && Number(get('yield')) > 0) grp.yield = Number(get('yield'));

            grp.ingredients.push({
                rowNum,
                inventoryItemName: get('inventoryItemName'),
                quantity: get('quantity'),
                unit: get('unit'),
            });
        }

        // ── Validate + upsert each group ──────────────────────────────
        const ALLOWED_RECIPE_UNITS = ['kg', 'g', 'L', 'mL', 'pcs', 'dozen', 'box', 'pack', 'bottle', 'can'];
        const errors = [...groupErrors];
        let created = 0;
        let updated = 0;

        for (const grp of groups.values()) {
            try {
                const menuDoc = menuByName.get(grp.menuItemName.toLowerCase());
                if (!menuDoc) {
                    errors.push({
                        row: grp.firstRowNum,
                        message: `menuItemName "${grp.menuItemName}" not found in this restaurant's menu`,
                    });
                    continue;
                }

                const cleanIngredients = [];
                let groupHadRowError = false;
                for (const ing of grp.ingredients) {
                    if (!ing.inventoryItemName) {
                        errors.push({ row: ing.rowNum, message: 'inventoryItemName is required' });
                        groupHadRowError = true;
                        continue;
                    }
                    const invDoc = invByName.get(ing.inventoryItemName.toLowerCase());
                    if (!invDoc) {
                        errors.push({
                            row: ing.rowNum,
                            message: `inventoryItemName "${ing.inventoryItemName}" not found in this restaurant's inventory`,
                        });
                        groupHadRowError = true;
                        continue;
                    }
                    const qty = Number(ing.quantity);
                    // Mirror the Recipe schema's `min: 0.001` rule here so
                    // the user sees a clean per-row message ("quantity must
                    // be at least 0.001") instead of a generic mongoose
                    // validation failure that points at an array index.
                    if (!Number.isFinite(qty) || qty < 0.001) {
                        errors.push({
                            row: ing.rowNum,
                            message: `quantity must be a positive number ≥ 0.001 (got "${ing.quantity}")`,
                        });
                        groupHadRowError = true;
                        continue;
                    }
                    if (!ALLOWED_RECIPE_UNITS.includes(ing.unit)) {
                        errors.push({
                            row: ing.rowNum,
                            message: `unit must be one of: ${ALLOWED_RECIPE_UNITS.join(' | ')}`,
                        });
                        groupHadRowError = true;
                        continue;
                    }
                    cleanIngredients.push({
                        inventoryItem: invDoc._id,
                        quantity: qty,
                        unit: ing.unit,
                    });
                }

                if (cleanIngredients.length === 0) {
                    // If we already logged per-row errors for this group, no
                    // need for a duplicate group-level message.
                    if (!groupHadRowError) {
                        errors.push({
                            row: grp.firstRowNum,
                            message: `Recipe for "${grp.menuItemName}" has no valid ingredients`,
                        });
                    }
                    continue;
                }

                const existing = await Recipe.findOne({
                    menuItem: menuDoc._id,
                    restaurant: tenantIdValue,
                    branch: branchId,
                });

                await Recipe.findOneAndUpdate(
                    { menuItem: menuDoc._id, restaurant: tenantIdValue, branch: branchId },
                    {
                        restaurant: tenantIdValue,
                        branch: branchId,
                        menuItem: menuDoc._id,
                        ingredients: cleanIngredients,
                        yield: grp.yield,
                        notes: grp.notes,
                    },
                    { upsert: true, runValidators: true },
                );

                // Mirror the ingredient name list onto the menu item (the
                // saveRecipe controller does this for backward-compat with
                // the customer-facing "Ingredients" display).
                const invNamesById = new Map(invDocs.map(i => [String(i._id), i.name]));
                menuDoc.ingredients = cleanIngredients.map(i => invNamesById.get(String(i.inventoryItem)) || '');
                await MenuItem.updateOne({ _id: menuDoc._id }, { $set: { ingredients: menuDoc.ingredients } });

                if (existing) updated += 1;
                else created += 1;
            } catch (groupErr) {
                errors.push({ row: grp.firstRowNum, message: groupErr.message });
            }
        }

        return res.status(200).json({
            success: true,
            created,
            updated,
            errorCount: errors.length,
            errors,
        });
    } catch (err) {
        logger.error('Recipes CSV import error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to import recipes CSV' });
    }
};

// DELETE /api/inventory/recipes/:menuItemId
exports.deleteRecipe = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = branchFilter(req);
        const recipe = await Recipe.findOneAndDelete({ menuItem: req.params.menuItemId, ...tf, ...bf });
        if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found' });
        res.status(200).json({ success: true, message: 'Recipe deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete recipe', ...devError(error) });
    }
};

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

/**
 * Pre-flight stock check for an incoming / appended order. Called from
 * orderController.createOrder + appendOrderItems BEFORE the order is
 * persisted, so the customer is told up-front when an ingredient is
 * out of stock instead of finding out at "Start Preparing" time when
 * the chef silently fails to deduct.
 *
 * Items without a recipe are skipped (treated as "no inventory tracked"
 * — same backwards-compatible behaviour the deduction path uses).
 *
 * @param {Array}    items        — order line items (must carry menuItem id + quantity)
 * @param {ObjectId} restaurantId — tenant id
 * @param {ObjectId|null} branch  — order's branch (null = tenant-wide)
 * @returns {Promise<{ ok: boolean, shortages: Array, byItem: Object }>}
 *
 *   shortages → [{ menuItem, name, ingredient, needed, available, unit }]
 *   byItem    → totals across the whole order (for atomic checks vs.
 *               per-line so two coffees competing for the same beans
 *               don't both pass when only one of them fits)
 */
exports.checkInventoryForOrder = async (items, restaurantId, branch = null) => {
    const result = { ok: true, shortages: [], warnings: [], byItem: {} };

    const validItems = (Array.isArray(items) ? items : []).filter(it => {
        const id = it?.menuItem?.toString?.() || it?.menuItem;
        return id && mongoose.isValidObjectId(id) && (it.quantity || 1) > 0;
    });
    if (validItems.length === 0) return result;

    const menuItemIds = [...new Set(validItems.map(it =>
        (it.menuItem.toString?.() || it.menuItem)
    ))];

    // Branch-aware recipe lookup mirrors deductInventoryForOrder so the
    // pre-check uses the exact same recipe the deduction will later use.
    const recipes = await Recipe.find({
        menuItem: { $in: menuItemIds },
        restaurant: restaurantId,
        branch: { $in: [branch, null] },
    }).lean();

    const recipeMap = {};
    for (const r of recipes) {
        const key = r.menuItem.toString();
        const isBranchSpecific = r.branch && branch && String(r.branch) === String(branch);
        if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
    }

    // Aggregate ingredient needs across ALL line items first, then check
    // once per inventory id. Without aggregation, ordering 5 coffees in
    // five separate lines would each pass the stock check independently
    // even though together they exceed the bean stock.
    const needsByInv = {}; // invId → { needed (in inv unit), unitMatched, sources: [{name, qty}] }
    const skippedItems = [];

    for (const it of validItems) {
        const miId = it.menuItem.toString?.() || it.menuItem;
        const recipe = recipeMap[miId];
        if (!recipe) {
            skippedItems.push(miId);
            continue;
        }
        const orderQty = it.quantity || 1;
        const multiplier = orderQty / (recipe.yield || 1);
        for (const ing of recipe.ingredients) {
            const invId = ing.inventoryItem.toString?.() || ing.inventoryItem;
            const slot = needsByInv[invId] || (needsByInv[invId] = {
                rawByUnit: {},
                sources: [],
            });
            slot.rawByUnit[ing.unit] = (slot.rawByUnit[ing.unit] || 0) + ing.quantity * multiplier;
            slot.sources.push({ menuItem: miId, name: it.name || '', qty: orderQty });
        }
    }

    const invIds = Object.keys(needsByInv);
    if (invIds.length === 0) return result;

    const invItems = await Inventory.find({
        _id: { $in: invIds },
        restaurant: restaurantId,
    }).lean();

    const invMap = {};
    for (const inv of invItems) invMap[inv._id.toString()] = inv;

    for (const invId of invIds) {
        const inv = invMap[invId];
        const slot = needsByInv[invId];
        if (!inv) {
            // Recipe references an inventory item that no longer exists.
            // Surface it so the admin knows the recipe is broken.
            result.ok = false;
            result.shortages.push({
                ingredient: invId,
                name: '(deleted ingredient)',
                needed: 0, available: 0, unit: '',
                reason: 'INVENTORY_MISSING',
            });
            continue;
        }

        // Sum every (qty, recipe-unit) pair into the inventory's unit so
        // a recipe in g and inventory in kg still adds up correctly.
        let totalNeeded = 0;
        let unitMismatch = null;
        for (const [recipeUnit, qty] of Object.entries(slot.rawByUnit)) {
            const converted = convertUnits(qty, recipeUnit, inv.unit);
            if (converted === null) {
                unitMismatch = `${recipeUnit}↔${inv.unit}`;
                break;
            }
            totalNeeded += converted;
        }

        if (unitMismatch) {
            // A unit mismatch (e.g. recipe in mL but inventory in "bottle") is
            // an ADMIN recipe-configuration problem, not a real stock shortage.
            // Blocking a paying customer's order — and refunding them — over a
            // misconfiguration is the wrong trade-off. So we DON'T fail the
            // order: we skip this ingredient (the deduction path skips it the
            // same way) and record a warning for the admin to fix the recipe.
            logger.warn('Stock pre-check: skipped unconvertible ingredient', {
                ingredient: invId, name: inv.name, mismatch: unitMismatch, restaurant: String(restaurantId),
            });
            result.warnings.push({
                ingredient: invId,
                name: inv.name,
                available: inv.currentStock,
                unit: inv.unit,
                reason: `Unit mismatch ${unitMismatch} — ingredient not stock-checked`,
            });
            continue;
        }

        if (inv.currentStock < totalNeeded) {
            result.ok = false;
            result.shortages.push({
                ingredient: invId,
                name: inv.name,
                needed: Math.round(totalNeeded * 1000) / 1000,
                available: inv.currentStock,
                unit: inv.unit,
            });
        }
    }

    return result;
};

/**
 * Deduct inventory for an order's items based on their recipes.
 * Called internally — not an HTTP endpoint.
 *
 * @param {Object} order    — the order document (with items populated)
 * @param {ObjectId} restaurantId — tenant id
 * @param {ObjectId|null} userId  — who triggered (chef or system)
 * @returns {{ deducted: Array, errors: Array }}
 */
exports.deductInventoryForOrder = async (order, restaurantId, userId = null) => {
    const results = { deducted: [], errors: [], skipped: [] };

    try {
        // Idempotency guard — if we already deducted for this order,
        // don't do it again. Atomic flip: the $set-if-false is the
        // single source of truth, so two concurrent "start preparing"
        // transitions can't both win.
        const Order = require('../models/order');
        const claim = await Order.findOneAndUpdate(
            { _id: order._id, restaurant: restaurantId, inventoryDeducted: { $ne: true } },
            { $set: { inventoryDeducted: true, inventoryDeductedAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (!claim) {
            results.skipped.push({ reason: 'already-deducted', order: order.orderId });
            return results;
        }

        // Collect unique menu item IDs from the order
        const menuItemIds = [...new Set(
            order.items
                .map(i => i.menuItem?.toString?.() || i.menuItem)
                .filter(id => id && mongoose.isValidObjectId(id))
        )];

        if (menuItemIds.length === 0) return results;

        // Fetch all recipes for these menu items in one query. Both
        // the branch-specific recipe (order.branch) and the tenant-
        // level fallback (branch: null) may exist — we prefer the
        // branch-specific one when deducting for this order.
        const orderBranch = order.branch || null;
        const recipes = await Recipe.find({
            menuItem: { $in: menuItemIds },
            restaurant: restaurantId,
            branch: { $in: [orderBranch, null] },
        }).lean();

        const recipeMap = {};
        for (const r of recipes) {
            const key = r.menuItem.toString();
            const isBranchSpecific = r.branch && orderBranch && String(r.branch) === String(orderBranch);
            // Prefer the branch-specific recipe; only fall back to the
            // null-branch one if no branch-specific recipe exists.
            if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
        }

        // Process each order item
        for (const orderItem of order.items) {
            const miId = orderItem.menuItem?.toString?.() || orderItem.menuItem;
            if (!miId) continue;

            const recipe = recipeMap[miId];
            if (!recipe) {
                results.skipped.push({ menuItem: miId, name: orderItem.name || miId, reason: 'No recipe defined' });
                continue;
            }

            const orderQty = orderItem.quantity || 1;
            const multiplier = orderQty / (recipe.yield || 1);

            for (const ing of recipe.ingredients) {
                const invId = ing.inventoryItem;
                const neededRaw = ing.quantity * multiplier;

                try {
                    // Read current inventory item
                    const invItem = await Inventory.findOne({ _id: invId, restaurant: restaurantId });
                    if (!invItem) {
                        results.errors.push({ inventoryItem: invId, reason: 'Inventory item not found' });
                        continue;
                    }

                    // Convert units if needed
                    const needed = convertUnits(neededRaw, ing.unit, invItem.unit);
                    if (needed === null) {
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Unit mismatch: recipe uses ${ing.unit}, inventory is ${invItem.unit}`,
                        });
                        continue;
                    }

                    const previousStock = invItem.currentStock;
                    const newStock = Math.max(0, previousStock - needed);

                    // Atomic deduction
                    const updated = await Inventory.findOneAndUpdate(
                        { _id: invId, restaurant: restaurantId, currentStock: { $gte: needed } },
                        {
                            $set: { currentStock: newStock },
                            $push: {
                                adjustmentHistory: {
                                    $each: [{
                                        type: 'usage',
                                        quantity: Math.round(needed * 1000) / 1000,
                                        previousStock,
                                        newStock,
                                        reason: `Auto: Order ${order.orderId} — ${orderItem.name || ''} ×${orderQty}`,
                                        adjustedBy: userId,
                                        date: new Date(),
                                    }],
                                    $slice: -200,
                                },
                            },
                        },
                        { returnDocument: 'after' }
                    );

                    if (updated) {
                        const newStatus = computeStatus(updated.currentStock, updated.minStock);
                        if (updated.status !== newStatus) {
                            // R-10: tenant-scope the status sync. `restaurantId` is the
                            // function parameter passed by the caller (orderController),
                            // so this is the authoritative tenant for the order being
                            // processed — not a client-controlled value.
                            await Inventory.updateOne(
                                { _id: invId, restaurant: restaurantId },
                                { status: newStatus }
                            );
                        }

                        results.deducted.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            deducted: Math.round(needed * 1000) / 1000,
                            unit: invItem.unit,
                            remaining: newStock,
                            status: newStatus,
                        });

                        // Persistent admin alert + live socket. Only fires
                        // when the status TRANSITIONS into low/out so a
                        // long-running low-stock streak doesn't repeatedly
                        // ping the admin every time the chef starts a new
                        // order with the same ingredient.
                        await notifyAdminInventoryStatus({
                            invItem: { ...invItem.toObject(), currentStock: newStock },
                            oldStatus: invItem.status,
                            newStatus,
                            restaurantId,
                            branchId: invItem.branch || order.branch || null,
                            trigger: `Order ${order.orderId}`,
                        });
                    } else {
                        // Insufficient stock — deduct what's available
                        const fallback = await Inventory.findOneAndUpdate(
                            { _id: invId, restaurant: restaurantId },
                            {
                                $set: { currentStock: 0, status: 'out-of-stock' },
                                $push: {
                                    adjustmentHistory: {
                                        $each: [{
                                            type: 'usage',
                                            quantity: previousStock,
                                            previousStock,
                                            newStock: 0,
                                            reason: `Auto (partial): Order ${order.orderId} — needed ${Math.round(needed * 1000) / 1000} ${invItem.unit}, had ${previousStock}`,
                                            adjustedBy: userId,
                                            date: new Date(),
                                        }],
                                        $slice: -200,
                                    },
                                },
                            },
                            { returnDocument: 'after' }
                        );
                        // The partial path forces newStock=0, so the item
                        // is definitely out-of-stock now. Notify regardless
                        // of the prior status — this is a real shortage
                        // the admin needs to address immediately.
                        await notifyAdminInventoryStatus({
                            invItem: { ...invItem.toObject(), currentStock: 0 },
                            oldStatus: invItem.status === 'out-of-stock' ? 'low-stock' : invItem.status,
                            newStatus: 'out-of-stock',
                            restaurantId,
                            branchId: invItem.branch || order.branch || null,
                            trigger: `Order ${order.orderId} (partial deduction)`,
                        });
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Insufficient: needed ${Math.round(needed * 1000) / 1000} ${invItem.unit}, had ${previousStock}`,
                        });
                    }
                } catch (err) {
                    results.errors.push({ inventoryItem: invId, reason: err.message });
                }
            }
        }
    } catch (err) {
        logger.error('deductInventoryForOrder failed:', err.message);
        results.errors.push({ reason: err.message });
    }

    return results;
};

/**
 * Reverse the deductions from deductInventoryForOrder. Called when an
 * in-progress order is cancelled so the kitchen doesn't lose stock for
 * food that was never actually made / sold.
 *
 * Uses the same recipe × yield × quantity math as the deduction path.
 * Writes a `type: 'return'` adjustmentHistory entry (not `restock`) so
 * the analytics tab doesn't treat a cancel as a supplier delivery.
 *
 * Safe to call even if `order.inventoryDeducted` is false (no-op) or
 * if some ingredient's recipe was since edited (it'll restore whatever
 * the current recipe says — which is the best we can do without
 * storing a frozen snapshot on the order).
 */
exports.restoreInventoryForOrder = async (order, restaurantId, userId = null) => {
    const results = { restored: [], errors: [], skipped: [] };

    try {
        const Order = require('../models/order');
        // Atomic claim so a double-cancel doesn't double-restore.
        const claim = await Order.findOneAndUpdate(
            { _id: order._id, restaurant: restaurantId, inventoryDeducted: true },
            { $set: { inventoryDeducted: false } },
            { returnDocument: 'after' }
        );
        if (!claim) {
            results.skipped.push({ reason: 'not-deducted', order: order.orderId });
            return results;
        }

        const menuItemIds = [...new Set(
            order.items
                .map(i => i.menuItem?.toString?.() || i.menuItem)
                .filter(id => id && mongoose.isValidObjectId(id))
        )];
        if (menuItemIds.length === 0) return results;

        const orderBranch = order.branch || null;
        const recipes = await Recipe.find({
            menuItem: { $in: menuItemIds },
            restaurant: restaurantId,
            branch: { $in: [orderBranch, null] },
        }).lean();

        const recipeMap = {};
        for (const r of recipes) {
            const key = r.menuItem.toString();
            const isBranchSpecific = r.branch && orderBranch && String(r.branch) === String(orderBranch);
            if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
        }

        for (const orderItem of order.items) {
            const miId = orderItem.menuItem?.toString?.() || orderItem.menuItem;
            if (!miId) continue;
            const recipe = recipeMap[miId];
            if (!recipe) continue;

            const orderQty = orderItem.quantity || 1;
            const multiplier = orderQty / (recipe.yield || 1);

            for (const ing of recipe.ingredients) {
                const invId = ing.inventoryItem;
                const neededRaw = ing.quantity * multiplier;

                try {
                    const invItem = await Inventory.findOne({ _id: invId, restaurant: restaurantId });
                    if (!invItem) {
                        results.errors.push({ inventoryItem: invId, reason: 'Inventory item not found' });
                        continue;
                    }

                    const needed = convertUnits(neededRaw, ing.unit, invItem.unit);
                    if (needed === null) {
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Unit mismatch: ${ing.unit} → ${invItem.unit}`,
                        });
                        continue;
                    }

                    const previousStock = invItem.currentStock;
                    // Capped at maxStock to avoid restoring above the ceiling
                    // (e.g. someone adjusted the max down after deduction).
                    const cap = invItem.maxStock > 0 ? invItem.maxStock : Number.POSITIVE_INFINITY;
                    const newStock = Math.min(cap, previousStock + needed);
                    const actualReturned = newStock - previousStock;
                    if (actualReturned <= 0) {
                        results.skipped.push({ inventoryItem: invId, name: invItem.name, reason: 'At max stock' });
                        continue;
                    }

                    await Inventory.updateOne(
                        { _id: invId, restaurant: restaurantId },
                        {
                            $set: { currentStock: newStock },
                            $push: {
                                adjustmentHistory: {
                                    $each: [{
                                        type: 'return',
                                        quantity: Math.round(actualReturned * 1000) / 1000,
                                        previousStock,
                                        newStock,
                                        reason: `Auto: Cancelled Order ${order.orderId} — ${orderItem.name || ''} ×${orderQty}`,
                                        adjustedBy: userId,
                                        date: new Date(),
                                    }],
                                    $slice: -200,
                                },
                            },
                        }
                    );

                    const newStatus = computeStatus(newStock, invItem.minStock);
                    if (invItem.status !== newStatus) {
                        // R-10: tenant-scope the status sync inside
                        // restoreInventoryForOrder. `restaurantId` is the
                        // function parameter from orderController.
                        await Inventory.updateOne(
                            { _id: invId, restaurant: restaurantId },
                            { status: newStatus }
                        );
                    }

                    results.restored.push({
                        inventoryItem: invId,
                        name: invItem.name,
                        restored: Math.round(actualReturned * 1000) / 1000,
                        unit: invItem.unit,
                        newStock,
                    });
                } catch (err) {
                    results.errors.push({ inventoryItem: invId, reason: err.message });
                }
            }
        }
    } catch (err) {
        logger.error('restoreInventoryForOrder failed:', err.message);
        results.errors.push({ reason: err.message });
    }

    return results;
};

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
            const actualUsage = (inv.adjustmentHistory || [])
                .filter(h => ['usage', 'waste'].includes(h.type) && new Date(h.date) >= since)
                .reduce((sum, h) => sum + h.quantity, 0);

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
                { $match: { 'adjustmentHistory.date': { $gte: since }, 'adjustmentHistory.type': { $in: ['usage', 'waste'] } } },
                { $group: {
                    _id: { id: '$_id', name: '$name', unit: '$unit', type: '$adjustmentHistory.type', cost: '$costPerUnit' },
                    qty: { $sum: '$adjustmentHistory.quantity' },
                } },
                { $group: {
                    _id: { id: '$_id.id', name: '$_id.name', unit: '$_id.unit', cost: '$_id.cost' },
                    usage: { $sum: { $cond: [{ $eq: ['$_id.type', 'usage'] }, '$qty', 0] } },
                    waste: { $sum: { $cond: [{ $eq: ['$_id.type', 'waste'] }, '$qty', 0] } },
                } },
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
                { $match: { 'adjustmentHistory.date': { $gte: since }, 'adjustmentHistory.type': { $in: ['usage', 'waste'] } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$adjustmentHistory.date' } },
                    cost: { $sum: { $multiply: ['$adjustmentHistory.quantity', '$costPerUnit'] } },
                } },
                { $project: { _id: 0, date: '$_id', cost: { $round: ['$cost', 2] } } },
                { $sort: { date: 1 } },
            ]),
        ]);

        const totalCost = Math.round(byItem.reduce((s, r) => s + r.cost, 0) * 100) / 100;
        res.json({ success: true, byItem, byDay, totalCost, period: { days, since } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to build consumption report', ...devError(error) });
    }
};
