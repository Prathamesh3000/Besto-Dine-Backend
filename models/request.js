const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 branch-scoping: optional branch link. null = tenant-
    // level (the default for single-location tenants and for every
    // doc created before this migration).
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  table: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
    required: true
  },
  waiter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  type: {
    type: String,
    enum: ['water', 'waiter', 'bill', 'other'],
    required: true
  },
  items: [{
    label: String, // e.g., 'Normal (x2)', 'Chilled (x1)'
    qty: Number
  }],
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'completed'],
    default: 'pending'
  },
  acceptedAt: Date,
  completedAt: Date
}, { timestamps: true });

// Performance indexes for common queries
requestSchema.index({ status: 1, createdAt: -1 });
requestSchema.index({ waiter: 1, status: 1 });
requestSchema.index({ table: 1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
requestSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Request', requestSchema);
