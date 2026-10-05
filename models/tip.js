const mongoose = require('mongoose');

const tipSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
  waiter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: [0, 'Tip amount cannot be negative']
  },
  status: {
    type: String,
    // 'refunded' is set by revokeTipsForOrder when the underlying order
    // is refunded or cancelled — keeps the audit trail intact while
    // excluding the tip from settlement aggregations.
    enum: ['pending', 'settled', 'refunded'],
    default: 'pending'
  },
  settlement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TipSettlement'
  }
}, { timestamps: true });

tipSchema.index({ waiter: 1, status: 1 });
tipSchema.index({ createdAt: -1 });
// Tenant-scoped tip queries (settlement dashboard)
tipSchema.index({ restaurant: 1, waiter: 1, status: 1 });
// One tip per order per tenant — makes createTipForPaidOrder idempotent
// under concurrent callers (PATCH paid + pickup + razorpay verify/webhook).
tipSchema.index({ order: 1, restaurant: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
tipSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Tip', tipSchema);
