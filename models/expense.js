const mongoose = require('mongoose');

/**
 * Operating expense / cash pay-out (Plan 3B.3 / 3B.5). The codebase had no
 * expense record. Cash expenses reduce the expected drawer cash in the daily
 * cash closing; all expenses post to the ledger (Dr Expenses, Cr Cash/Bank).
 * Voided rows are kept (status 'void') but ignored everywhere.
 */
const expenseSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    businessDate: { type: String, required: true },
    date: { type: Date, default: Date.now },                 // when the money left
    category: { type: String, default: 'General', trim: true, maxlength: 60 },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ['cash', 'upi', 'bank-transfer', 'card', 'cheque', 'other'], default: 'cash' },
    note: { type: String, default: '', maxlength: 300 },
    status: { type: String, enum: ['active', 'void'], default: 'active' },
    voidReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

expenseSchema.index({ restaurant: 1, businessDate: 1, status: 1 });
expenseSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Expense', expenseSchema);
