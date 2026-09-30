const mongoose = require('mongoose');

const tipSettlementSchema = new mongoose.Schema({
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
  amount: {
    type: Number,
    required: true,
    min: [0, 'Settlement amount cannot be negative']
  },
  tipsSettledCount: {
    type: Number,
    required: true,
    min: [1, 'Must settle at least one tip']
  },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'Online'],
    required: true
  },
  settledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Admin
    required: true
  },
  note: {
    type: String
  }
}, { timestamps: true });

// Tenant-scoped settlement history queries
tipSettlementSchema.index({ restaurant: 1, createdAt: -1 });
tipSettlementSchema.index({ waiter: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
tipSettlementSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('TipSettlement', tipSettlementSchema);
