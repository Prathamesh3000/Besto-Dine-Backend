const mongoose = require('mongoose');

// A withdrawal is a request from the waiter to convert their wallet
// balance into real money. The system DOES NOT physically move money —
// the admin still hands over cash / does the UPI transfer outside the
// app. Status machine:
//
//   pending  → admin sees in queue
//   paid     → admin marked as handed over (debit becomes permanent)
//   rejected → admin declined; balance is refunded back to the wallet
//
// The wallet balance is debited at REQUEST time (so a waiter can't
// double-spend by tapping Withdraw twice). Reject path refunds.
const staffWithdrawalSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    wallet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffWallet',
        required: true,
    },
    amount: {
        type: Number,
        required: true,
        min: [1, 'Withdrawal must be at least ₹1'],
    },
    method: {
        type: String,
        enum: ['Cash', 'UPI', 'Bank'],
        required: true,
    },
    // Optional payout details — only filled in when the waiter chose
    // Online (UPI / Bank). Sanitised at the controller, not the model,
    // so future shapes (Paytm, etc.) don't require schema migrations.
    upiId: { type: String, trim: true, maxlength: 100 },
    bankName: { type: String, trim: true, maxlength: 100 },
    accountHolder: { type: String, trim: true, maxlength: 100 },
    accountNumber: { type: String, trim: true, maxlength: 30 },
    ifsc: { type: String, trim: true, maxlength: 20 },
    note: { type: String, maxlength: 300 },

    status: {
        type: String,
        enum: ['pending', 'paid', 'rejected'],
        default: 'pending',
    },
    rejectReason: { type: String, maxlength: 300 },

    // Filled when admin marks paid / rejected.
    handledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    handledAt: { type: Date },
    txnRef: { type: String, trim: true, maxlength: 100 },   // UPI txn id / bank ref
}, { timestamps: true });

// Per-staff history.
staffWithdrawalSchema.index({ user: 1, createdAt: -1 });
// Admin "pending requests" listing.
staffWithdrawalSchema.index({ restaurant: 1, status: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
staffWithdrawalSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('StaffWithdrawal', staffWithdrawalSchema);
