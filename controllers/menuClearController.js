/**
 * POST /menu/clear: remove the whole menu in the current scope.
 *
 *   { dryRun: true }                                  → counts only, nothing changes
 *   { confirm: 'CLEAR MENU', includeCategories?: bool } → deletes
 *
 * Scope is the same as the menu list the owner is looking at: tenant-wide for
 * an owner with no branch selected, otherwise that branch (strictBranchFilter).
 * Owner-only at the route. Recipes of the removed dishes are deleted and combos
 * that bundled them are archived, exactly as deleting dishes one by one does.
 * Past orders keep their own copy of name and price, so history is untouched.
 */
'use strict';

const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Recipe = require('../models/recipe');
const Combo = require('../models/combo');
const logger = require('../utils/logger');
const { tenantFilter, strictBranchFilter } = require('../utils/tenantScope');

const CONFIRM_PHRASE = 'CLEAR MENU';

exports.clearMenu = async (req, res) => {
    try {
        const scope = { ...tenantFilter(req), ...strictBranchFilter(req) };
        if (!scope.restaurant) {
            return res.status(400).json({ success: false, message: 'No restaurant selected.' });
        }
        const items = await MenuItem.find(scope).select('_id').lean();
        const itemIds = items.map((i) => i._id);
        const comboFilter = {
            ...tenantFilter(req),
            'categories.items.menuItemId': { $in: itemIds },
            status: { $ne: 'archived' },
        };

        if (req.body?.dryRun === true) {
            const [recipes, combos, categories] = await Promise.all([
                Recipe.countDocuments({ menuItem: { $in: itemIds }, ...tenantFilter(req) }),
                itemIds.length ? Combo.countDocuments(comboFilter) : 0,
                Category.countDocuments(scope),
            ]);
            return res.json({ success: true, data: { items: itemIds.length, recipes, combos, categories, confirmPhrase: CONFIRM_PHRASE } });
        }

        const typed = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toUpperCase() : '';
        if (typed !== CONFIRM_PHRASE) {
            return res.status(400).json({ success: false, code: 'CONFIRM_REQUIRED', message: `Type ${CONFIRM_PHRASE} to confirm.` });
        }

        let combosArchived = 0;
        let recipesDeleted = 0;
        if (itemIds.length) {
            const rec = await Recipe.deleteMany({ menuItem: { $in: itemIds }, ...tenantFilter(req) });
            recipesDeleted = rec.deletedCount || 0;
            const cmb = await Combo.updateMany(comboFilter, { $set: { status: 'archived' } });
            combosArchived = cmb.modifiedCount || 0;
            await MenuItem.deleteMany({ _id: { $in: itemIds }, ...tenantFilter(req) });
        }

        let categoriesDeleted = 0;
        if (req.body?.includeCategories === true) {
            // Only categories that no dish (in any branch) still uses.
            const cats = await Category.find(scope).select('_id').lean();
            const catIds = cats.map((c) => c._id);
            const stillUsed = await MenuItem.distinct('category', { category: { $in: catIds }, ...tenantFilter(req) });
            const used = new Set(stillUsed.map(String));
            const removable = catIds.filter((id) => !used.has(String(id)));
            if (removable.length) {
                const r = await Category.deleteMany({ _id: { $in: removable }, ...tenantFilter(req) });
                categoriesDeleted = r.deletedCount || 0;
            }
        }

        logger.warn('menu cleared', {
            restaurant: String(scope.restaurant),
            by: String(req.user?._id || ''),
            items: itemIds.length,
            categories: categoriesDeleted,
        });
        try {
            require('../utils/socket').emitMenuUpdated(scope.restaurant, { itemIds: [], branch: null, reason: 'clear' });
        } catch { /* socket best-effort */ }

        return res.json({
            success: true,
            data: { items: itemIds.length, recipes: recipesDeleted, combosArchived, categories: categoriesDeleted },
        });
    } catch (err) {
        logger.error('menu clear failed', { error: err.message });
        return res.status(500).json({ success: false, message: 'Could not clear the menu. Nothing more was changed after the error; please check the menu and retry.' });
    }
};
