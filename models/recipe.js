const mongoose = require('mongoose');

/**
 * Recipe — links a MenuItem to its Inventory ingredients with exact
 * quantities.  When an order moves to "preparing", the system reads
 * the recipe and auto-deducts each ingredient from inventory.
 *
 * One recipe per menu-item per tenant.  A menu item without a recipe
 * simply skips the auto-deduction step (backwards-compatible).
 *
 * The `yield` field says how many servings one batch of this recipe
 * produces. When 3 portions are ordered the system divides each
 * ingredient quantity by `yield` and multiplies by the order quantity.
 */

const recipeIngredientSchema = new mongoose.Schema({
    inventoryItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Inventory',
        required: true,
    },
    quantity: {
        type: Number,
        required: true,
        min: [0.001, 'Quantity must be positive'],
    },
    // Unit for this recipe line — should match or be convertible to
    // the inventory item's unit.  Stored here so the recipe is
    // self-describing even without populating the inventory doc.
    unit: {
        type: String,
        enum: ['kg', 'g', 'L', 'mL', 'pcs', 'dozen', 'box', 'pack', 'bottle', 'can'],
        required: true,
    },
}, { _id: false });

const recipeSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch-scoping: a Sub Admin owns recipes they create at their
    // branch (default null = tenant-level / shared with all branches).
    // Per product rule "sub-branches see no other branch data", the
    // admin recipe list filters by this via strictBranchFilter.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    menuItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MenuItem',
        required: true,
    },
    ingredients: {
        type: [recipeIngredientSchema],
        validate: [arr => arr.length > 0, 'Recipe must have at least one ingredient'],
    },
    // How many servings this recipe yields.  Default 1 = one order
    // of the menu item consumes exactly the listed quantities.
    yield: {
        type: Number,
        default: 1,
        min: [0.01, 'Yield must be positive'],
    },
    // Spec 10.3.3 — recipe master metadata.
    // `recipeType`: 'finished' (sold as-is) vs 'semi-finished' (a
    // prep/sub-recipe like a sauce batch consumed by other dishes).
    // `prepLossPercent`: expected yield loss during prep (trimming,
    // evaporation, spillage). Raises the effective per-serving food
    // cost — foodCost is divided by (1 - prepLossPercent/100).
    recipeType: {
        type: String,
        enum: ['finished', 'semi-finished'],
        default: 'finished',
    },
    prepLossPercent: {
        type: Number,
        min: 0,
        max: 95,
        default: 0,
    },
    notes: {
        type: String,
        default: '',
        maxlength: 500,
    },
}, { timestamps: true });

// One recipe per menu item per (tenant, branch). Branch A and Branch B
// can each have their own version of a recipe for the same menu item.
// The legacy `restaurant_1_menuItem_1` index is superseded — run
// `db.recipes.dropIndex('restaurant_1_menuItem_1')` once on existing
// environments so the new index takes over.
recipeSchema.index({ restaurant: 1, menuItem: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
recipeSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Recipe', recipeSchema);
