const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
  // Phase 1 SaaS: a customer can have one wallet PER restaurant they
  // order from (loyalty points + balance are tenant-specific). The
  // global `unique: true` on user is replaced by the compound unique
  // index `{ user, restaurant }` declared below.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  balance: {
    type: Number,
    default: 0, // In currency units (₹)
    min: [0, 'Wallet balance cannot be negative']
  },
  loyaltyPoints: {
    type: Number,
    default: 0, // In points units
    min: [0, 'Loyalty points cannot be negative']
  },
  status: {
    type: String,
    enum: ['active', 'blocked', 'suspended'],
    default: 'active'
  }
}, { timestamps: true });

// Round balance and loyaltyPoints to 2 decimal places before saving
walletSchema.pre('save', function () {
  if (this.isModified('balance')) {
    this.balance = Math.round(this.balance * 100) / 100;
  }
  if (this.isModified('loyaltyPoints')) {
    this.loyaltyPoints = Math.round(this.loyaltyPoints * 100) / 100;
  }
});

// Round after findOneAndUpdate ($inc can cause floating point drift)
walletSchema.post('findOneAndUpdate', async function (doc) {
  if (!doc) return;
  const roundedBalance = Math.round(doc.balance * 100) / 100;
  const roundedPoints = Math.round(doc.loyaltyPoints * 100) / 100;
  if (doc.balance !== roundedBalance || doc.loyaltyPoints !== roundedPoints) {
    doc.balance = roundedBalance;
    doc.loyaltyPoints = roundedPoints;
    await doc.save({ validateBeforeSave: false });
  }
});

// Optional: Add calculation logic for conversion if needed on query
walletSchema.virtual('totalValueInCurrency').get(function() {
  const pointsToCurrencyRatio = 0.1; // 10 points = ₹1
  return this.balance + (this.loyaltyPoints * pointsToCurrencyRatio);
});

// Compound unique index — one wallet per (user, restaurant) pair.
// Replaces the old global `unique: true` on the user field. The Phase 1
// migration script `Seed/dropLegacyIndexes.js` drops the old `user_1`
// index from the live MongoDB collection.
walletSchema.index({ user: 1, restaurant: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
walletSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Wallet', walletSchema);
