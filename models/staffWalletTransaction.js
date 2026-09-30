const mongoose = require('mongoose');

// Append-only ledger for the staff wallet. Every balance change MUST
// produce a transaction row so the waiter (and admin) can audit "where
// did this ₹450 come from / where did it go". Stored balanceAfter so
// historic state is reconstructable without replaying the whole log.
const staffWalletTransactionSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    wallet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffWallet',
        required: true,
        index: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    type: {
        type: String,
        // tip-credit       : settled tip → wallet credit
        // withdrawal-debit : waiter requested a payout, balance reserved
        // withdrawal-refund: admin rejected the withdrawal, balance restored
        // adjustment       : admin manual balance correction (rare)
        enum: ['tip-credit', 'withdrawal-debit', 'withdrawal-refund', 'adjustment'],
        required: true,
    },
    direction: {
        type: String,
        enum: ['credit', 'debit'],
        required: true,
    },
    amount: {
        type: Number,
        required: true,
        min: [0, 'Transaction amount must be non-negative'],
    },
    balanceAfter: {
        type: Number,
        required: true,
        min: 0,
    },
    // Loose link to whatever drove the change. Mongoose `refPath` would
    // be stricter but we'd have to lock the model name; leaving free-text
    // here keeps the ledger forward-compatible if we add new sources.
    referenceKind: {
        type: String,
        enum: ['TipSettlement', 'StaffWithdrawal', 'AdminAdjustment'],
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
    },
    note: {
        type: String,
        maxlength: 300,
    },
}, { timestamps: true });

// Per-user history listing (waiter's "transactions" tab) — newest first.
staffWalletTransactionSchema.index({ user: 1, createdAt: -1 });
// Tenant-scoped audit queries.
staffWalletTransactionSchema.index({ restaurant: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
staffWalletTransactionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('StaffWalletTransaction', staffWalletTransactionSchema);
