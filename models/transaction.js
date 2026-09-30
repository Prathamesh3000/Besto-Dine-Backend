const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch-scoping: transactions happen at a specific branch (an order
    // paid at Branch A, a manual adjustment made by Branch A's Sub Admin).
    // null = tenant-level (legacy / tenant-owner-initiated). Sub Admin
    // wallet analytics filter by this so they don't see other branches'
    // activity.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  type: {
    type: String,
    // 'wallet_status_change' is a zero-amount audit row written by
    // walletController.setWalletStatus so admins can trace who flipped
    // a customer wallet between active / suspended / blocked.
    enum: ['order_payment', 'wallet_recharge', 'refund', 'points_earned', 'points_redeemed', 'wallet_status_change'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'INR'
  },
  paymentMethod: {
    type: String,
    enum: ['upi', 'card', 'wallet', 'cash', 'points'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'completed'
  },
  description: {
    type: String
  },
  // Phase 1 SaaS: transactionIds are unique PER TENANT. The compound
  // index at the bottom of this file replaces the old global
  // `unique: true` on transactionId.
  transactionId: {
    type: String,
    required: true
  },
  balanceBefore: {
    type: Number
  },
  balanceAfter: {
    type: Number
  },
  // Razorpay payment that funded this row (wallet recharges). Single-use:
  // the partial unique index below guarantees one payment id can credit
  // at most one Transaction. Left unset (not null) on every other row so
  // the partial filter skips them.
  razorpayPaymentId: {
    type: String
  },
  razorpayOrderId: {
    type: String
  }
}, { timestamps: true });

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ status: 1 });
// Per-tenant uniqueness on transactionId. `Seed/dropLegacyIndexes.js`
// drops the old `transactionId_1` global index.
transactionSchema.index({ transactionId: 1, restaurant: 1 }, { unique: true });
// Tenant-scoped transaction reports and wallet analytics
transactionSchema.index({ restaurant: 1, type: 1, createdAt: -1 });
transactionSchema.index({ restaurant: 1, user: 1, createdAt: -1 });
// A Razorpay payment id may fund at most one Transaction. Partial filter
// on string type so the (many) legacy rows without the field — or with
// null — never collide, and the index builds cleanly on existing data.
transactionSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } }
);

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
transactionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Transaction', transactionSchema);
