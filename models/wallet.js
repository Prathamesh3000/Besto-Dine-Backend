const mongoose = require('mongoose');
const { skipScope } = require('../utils/tenantScopePlugin');

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

// Guard against overdraw through update operators: schema `min` only runs on
// save(). Any negative $inc on balance / loyaltyPoints gets an extra filter
// condition so it only matches when the stored value can absorb it (a no-match
// behaves like the existing call-site $gte guards: null / nModified 0).
// Pipeline updates (the rounding follow-up below) are left alone.
const guardNegativeInc = function () {
  const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null;
  if (!update || Array.isArray(update) || !update.$inc) return;
  for (const field of ['balance', 'loyaltyPoints']) {
    const v = update.$inc[field];
    if (typeof v === 'number' && v < 0) {
      this.and([{ [field]: { $gte: -v - 1e-6 } }]);
    }
  }
};
walletSchema.pre('findOneAndUpdate', guardNegativeInc);
walletSchema.pre('updateOne', guardNegativeInc);
walletSchema.pre('updateMany', guardNegativeInc);

// Round after findOneAndUpdate ($inc can cause floating point drift).
//
// The rounding is done IN the database with a pipeline update that rounds
// whatever value is stored at that moment, and only matches when a value
// is actually off-paise. The old hook save()d the absolute balance it had
// read, which overwrote any $inc that landed in between (concurrent
// recharges lost money) and, when the caller did not ask for
// returnDocument:'after', wrote back the stale pre-update value.
const round2Expr = (field) => ({
  $cond: [{ $isNumber: `$${field}` }, { $round: [`$${field}`, 2] }, `$${field}`],
});
const offPaiseExpr = (field) => ({
  $and: [{ $isNumber: `$${field}` }, { $ne: [`$${field}`, { $round: [`$${field}`, 2] }] }],
});

walletSchema.post('findOneAndUpdate', async function (doc) {
  if (!doc || !doc._id) return;
  const opts = this.getOptions ? this.getOptions() : {};
  const isAfterDoc = opts.returnDocument === 'after' || opts.new === true;
  const round = (v) => Math.round(v * 100) / 100;
  const drift = typeof doc.balance === 'number' && doc.balance !== round(doc.balance)
    || typeof doc.loyaltyPoints === 'number' && doc.loyaltyPoints !== round(doc.loyaltyPoints);
  // A post-update doc that is already on paise needs nothing. A pre-update
  // doc tells us nothing about the stored value, so let the conditional
  // update decide (it is a no-op match when nothing drifted).
  if (isAfterDoc && !drift) return;

  // AUDIT-EXEMPT: follow-up on the exact wallet _id this hook just received from the
  // originating update; it must run whatever context the update ran in (tenant, job, system).
  await skipScope(this.model.updateOne(
    { _id: doc._id, $expr: { $or: [offPaiseExpr('balance'), offPaiseExpr('loyaltyPoints')] } },
    [{ $set: { balance: round2Expr('balance'), loyaltyPoints: round2Expr('loyaltyPoints') } }],
    { session: opts.session || null, updatePipeline: true }
  ));

  if (isAfterDoc) {
    // Reflect the rounding in the returned doc without marking it dirty,
    // so a later save() by the caller doesn't write an absolute balance.
    for (const field of ['balance', 'loyaltyPoints']) {
      if (typeof doc[field] !== 'number') continue;
      if (typeof doc.set === 'function') {
        doc.set(field, round(doc[field]));
        doc.unmarkModified(field);
      } else {
        doc[field] = round(doc[field]); // lean result
      }
    }
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
