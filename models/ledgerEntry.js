const mongoose = require('mongoose');

/**
 * One debit-or-credit line of a posting batch (Plan 3B.3). A batch is all
 * lines sharing `ref.type + ref.id` and always balances (debits == credits).
 *
 * `key` makes posting idempotent: it is derived from the source document
 * (`<refType>:<refId>:<account>:<dr|cr>`), unique per tenant, so re-running
 * the post-day job upserts nothing new.
 */
const ledgerEntrySchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    businessDate: { type: String, required: true },          // 'YYYY-MM-DD' in the restaurant time zone
    account: { type: String, required: true },               // LedgerAccount.code
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    ref: {
        type: { type: String, required: true },              // order-tender | order-refund | expense | supplier-invoice | supplier-payment | po-payment
        id: { type: String, required: true },
    },
    narration: { type: String, default: '', maxlength: 300 },
    key: { type: String, required: true },
    postedAt: { type: Date, default: Date.now },
}, { timestamps: false });

ledgerEntrySchema.index({ restaurant: 1, key: 1 }, { unique: true });
ledgerEntrySchema.index({ restaurant: 1, businessDate: 1, account: 1 });
ledgerEntrySchema.index({ restaurant: 1, branch: 1, businessDate: 1 });
ledgerEntrySchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
