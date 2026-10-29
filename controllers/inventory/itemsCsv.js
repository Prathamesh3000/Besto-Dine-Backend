const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Inventory = require('../../models/inventory');
const logger = require('../../utils/logger');
const { parseCsv } = require('../../utils/csvParser');
const { tenantFilter, tenantId, pinnedBranchId } = require('../../utils/tenantScope');
const { ALLOWED_CATEGORIES, ALLOWED_UNITS, ADJUSTMENT_HISTORY_MAX, roundQty, escapeRegex, generateNextId } = require('./_shared');


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
const INVENTORY_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'data', 'inventory-master-template.csv');

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
                const currentStock = currentStockRaw === '' ? 0 : roundQty(Number(currentStockRaw));
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
                        // Same cap as every `$push … $slice: -200` on this
                        // array (adjustStock, deduct/restore, production,
                        // purchase receipts). This was the one uncapped
                        // writer: an item re-imported on every stock count
                        // grew its history without limit. Keep the newest
                        // 200, like the atomic writers do.
                        if (existing.adjustmentHistory.length > ADJUSTMENT_HISTORY_MAX) {
                            existing.adjustmentHistory.splice(0, existing.adjustmentHistory.length - ADJUSTMENT_HISTORY_MAX);
                        }
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
