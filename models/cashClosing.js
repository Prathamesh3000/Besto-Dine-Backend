const mongoose = require('mongoose');

/**
 * Daily cash closing (Plan 3B.5): one document per tenant + branch + business
 * date (unique). expectedCash = openingCash + cash tenders - cash refunds -
 * cash pay-outs, computed by the server at close time (utils/cashMath.js).
 * A closed day is immutable except through an admin edit with a reason,
 * which is appended to `edits[]` (before/after snapshot).
 */
const editSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, required: true, maxlength: 300 },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const cashClosingSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    businessDate: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openingCash: { type: Number, default: 0, min: 0 },
    cashSales: { type: Number, default: 0 },
    cashRefunds: { type: Number, default: 0 },
    cashPaidOuts: { type: Number, default: 0 },
    expectedCash: { type: Number, default: 0 },
    countedCash: { type: Number, default: null },
    variance: { type: Number, default: null },               // counted - expected (negative = short)
    notes: { type: String, default: '', maxlength: 500 },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    edits: [editSchema],
}, { timestamps: true });

cashClosingSchema.index({ restaurant: 1, branch: 1, businessDate: 1 }, { unique: true });
cashClosingSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('CashClosing', cashClosingSchema);
