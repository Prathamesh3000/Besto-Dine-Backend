const mongoose = require('mongoose');

// A physical stock count. create snapshots every inventory item's current
// quantity as `expectedQty`; staff enter `countedQty`; submit freezes the
// count; apply writes 'correction' adjustments (history stays in
// Inventory.adjustmentHistory). Each line carries its own `appliedAt` claim
// so apply is atomic per line and can never be applied twice.
const lineSchema = new mongoose.Schema({
    item:        { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    itemName:    { type: String, default: '' },
    itemCode:    { type: String, default: '' },
    expectedQty: { type: Number, required: true },
    countedQty:  { type: Number, default: null, min: 0 },
    variance:    { type: Number, default: null },   // countedQty - expectedQty
    unit:        { type: String, default: '' },
    note:        { type: String, default: '', maxlength: 300 },
    appliedAt:   { type: Date, default: null },
    appliedStock: { type: Number, default: null },  // stock after the correction
    applyError:  { type: String, default: '' },
});

const stocktakeSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    name:       { type: String, default: '', trim: true, maxlength: 120 },
    status:     { type: String, enum: ['draft', 'submitted', 'applied'], default: 'draft', index: true },
    lines:      { type: [lineSchema], default: [] },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    appliedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    appliedAt:   { type: Date },
}, { timestamps: true });

stocktakeSchema.index({ restaurant: 1, createdAt: -1 });

stocktakeSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.models.Stocktake || mongoose.model('Stocktake', stocktakeSchema);
