const mongoose = require('mongoose');

/**
 * Ledger-lite chart of accounts (Plan 3B.3). One row per tenant per code;
 * the default chart is created lazily by services/ledgerService.ensureChart.
 */
const ledgerAccountSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['asset', 'liability', 'income', 'expense', 'equity'], required: true },
    isSystem: { type: Boolean, default: true },
}, { timestamps: true });

ledgerAccountSchema.index({ restaurant: 1, code: 1 }, { unique: true });
ledgerAccountSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('LedgerAccount', ledgerAccountSchema);
