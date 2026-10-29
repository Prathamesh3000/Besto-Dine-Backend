const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Inventory = require('../../models/inventory');
const Recipe = require('../../models/recipe');
const MenuItem = require('../../models/menuItem');
const logger = require('../../utils/logger');
const { parseCsv } = require('../../utils/csvParser');
const { tenantFilter, tenantId, pinnedBranchId } = require('../../utils/tenantScope');

// GET /api/v1/inventory/recipes/template
// Streams the pre-filled Recipes master CSV. One row per ingredient line;
// rows sharing the same menuItemName get merged into a single Recipe by
// the import endpoint below. Admin downloads, deletes rows for menu items
// the cafe doesn't carry, edits quantities, and uploads.
const RECIPES_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'data', 'recipes-master-template.csv');

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
