const mongoose = require('mongoose');

// Inter-branch stock transfer (same restaurant only).
// draft -> in_transit (send deducts source) -> received (receive adds to
// destination) ; draft/in_transit -> cancelled (in_transit returns stock).
// Each stock effect is claimed per line (outAppliedAt / inAppliedAt /
// returnedAt) BEFORE the stock write, so no step can run twice.
const lineSchema = new mongoose.Schema({
    item:      { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    itemName:  { type: String, default: '' },
    itemCode:  { type: String, default: '' },
    qty:       { type: Number, required: true, min: 0.001 },
    unit:      { type: String, required: true },
    // Source avgCost snapshot at send time; null = unknown.
    unitCost:  { type: Number, default: null, min: 0 },
    outAppliedAt: { type: Date, default: null },
    inAppliedAt:  { type: Date, default: null },
    returnedAt:   { type: Date, default: null },
    receivedQty:  { type: Number, default: null, min: 0 },
    shortfallQty: { type: Number, default: 0, min: 0 },
    destItem:     { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    error:        { type: String, default: '' },
});

const stockTransferSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    number:     { type: String, required: true },
    fromBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    toBranch:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    lines:      { type: [lineSchema], default: [] },
    status:     { type: String, enum: ['draft', 'in_transit', 'received', 'cancelled'], default: 'draft', index: true },
    note:       { type: String, default: '', maxlength: 500 },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentAt:     { type: Date },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
}, { timestamps: true });

stockTransferSchema.index({ restaurant: 1, number: 1 }, { unique: true });
stockTransferSchema.index({ restaurant: 1, createdAt: -1 });

stockTransferSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.models.StockTransfer || mongoose.model('StockTransfer', stockTransferSchema);
