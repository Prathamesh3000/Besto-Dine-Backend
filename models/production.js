const mongoose = require('mongoose');

/**
 * Production / Batch Cooking entry (Inventory spec 10.6.2).
 *
 * Records a batch-cooking run: a recipe (usually a semi-finished prep
 * like a sauce or stock) is produced in bulk. On save the controller:
 *   1. DEDUCTS the recipe's raw ingredients from inventory (scaled by
 *      the produced batch quantity), and
 *   2. ADDS the produced output back to a finished/semi-finished
 *      inventory item, if one is linked.
 *
 * This is the manual counterpart to order-driven auto-deduction: a chef
 * cooks a 5-litre batch of gravy ahead of service, consuming onions /
 * tomatoes / oil now and banking 5 L of gravy stock for later orders.
 */

const consumedLineSchema = new mongoose.Schema({
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    name: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0 },   // actual deducted (inventory unit)
    unit: { type: String, default: '' },
}, { _id: false });

const productionSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    batchNumber: { type: String, required: true },   // PRD-001 per tenant
    recipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe' },
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    recipeName: { type: String, default: '' },       // snapshot
    // How many recipe-yields were produced (multiplier on the recipe).
    batchQuantity: { type: Number, required: true, min: 0.01 },
    // Optional: the inventory item this production REPLENISHES (the
    // semi-finished/finished good). null = ingredients consumed only.
    outputItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    outputQty: { type: Number, default: 0, min: 0 },
    outputUnit: { type: String, default: '' },
    consumed: [consumedLineSchema],                  // what was deducted
    totalCost: { type: Number, default: 0 },         // ingredient cost of the batch
    productionDate: { type: Date, default: Date.now },
    producedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    producedByName: { type: String, default: '' },
    notes: { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

productionSchema.index({ restaurant: 1, batchNumber: 1 }, { unique: true });
productionSchema.index({ restaurant: 1, productionDate: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
productionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Production', productionSchema);
