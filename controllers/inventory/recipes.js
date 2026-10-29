const mongoose = require('mongoose');
const Inventory = require('../../models/inventory');
const Recipe = require('../../models/recipe');
const MenuItem = require('../../models/menuItem');
const { tenantFilter, tenantId, pinnedBranchId } = require('../../utils/tenantScope');
const { devError } = require('../../utils/AppError');
const { ALLOWED_UNITS, branchFilter, convertUnits } = require('./_shared');

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
        // Out-of-enum unit → 400 here (used to 500 from the schema enum).
        const badUnit = ingredients.find(i => i && !ALLOWED_UNITS.includes(i.unit));
        if (badUnit) {
            return res.status(400).json({ success: false, message: `Ingredient unit must be one of: ${ALLOWED_UNITS.join(', ')}` });
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
        if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ success: false, message: error.message });
        res.status(500).json({ success: false, message: 'Failed to save recipe', ...devError(error) });
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
