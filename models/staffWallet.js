const mongoose = require('mongoose');

// Staff (waiter / captain) in-app wallet — earned tip settlements land
// here as a credit, withdrawals debit. Kept separate from the customer
// `Wallet` model on purpose: customer wallet carries loyalty points +
// guest-paid balance with very different invariants. One wallet per
// (user, restaurant) pair so multi-tenant staff isolate cleanly.
const staffWalletSchema = new mongoose.Schema({
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
    balance: {
        type: Number,
        default: 0,
        min: [0, 'Wallet balance cannot be negative'],
    },
    // Lifetime credits / debits — purely informational. Useful when an
    // admin wants to audit "how much did we ever owe this waiter" vs
    // current balance. Kept separate so a withdraw doesn't touch the
    // lifetime credit total.
    lifetimeCredits: {
        type: Number,
        default: 0,
        min: 0,
    },
    lifetimeDebits: {
        type: Number,
        default: 0,
        min: 0,
    },
    status: {
        type: String,
        enum: ['active', 'frozen'],
        default: 'active',
    },
}, { timestamps: true });

// One staff wallet per (user, restaurant) pair.
staffWalletSchema.index({ user: 1, restaurant: 1 }, { unique: true });

// Round to 2 decimal places after $inc — same drift-fix the customer
// Wallet model uses. Without this, repeated tip credits accumulate
// floating-point error (eg. 12.499999... balance).
staffWalletSchema.post('findOneAndUpdate', async function (doc) {
    if (!doc) return;
    const round = (n) => Math.round(n * 100) / 100;
    const next = {
        balance: round(doc.balance),
        lifetimeCredits: round(doc.lifetimeCredits),
        lifetimeDebits: round(doc.lifetimeDebits),
    };
    if (
        doc.balance !== next.balance
        || doc.lifetimeCredits !== next.lifetimeCredits
        || doc.lifetimeDebits !== next.lifetimeDebits
    ) {
        Object.assign(doc, next);
        await doc.save({ validateBeforeSave: false });
    }
});

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
staffWalletSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('StaffWallet', staffWalletSchema);
