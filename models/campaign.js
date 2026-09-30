const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch link — added so Bonus Points campaigns can be scoped per
    // location. null = tenant-level (legacy / shared); ObjectId =
    // owned by that branch. Branch-pinned admins (`pinnedBranchId(req)`)
    // see ONLY their branch's campaigns; the controller's
    // strictBranchFilter call enforces this.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  type: {
    type: String,
    enum: ['birthday', 'custom', 'first_order', 'referral'],
    default: 'custom'
  },
  points: {
    type: Number,
    required: true,
    min: 1
  },
  startDate: {
    type: Date
  },
  endDate: {
    type: Date
  },
  enabled: {
    type: Boolean,
    default: true
  },
  totalPointsIssued: {
    type: Number,
    default: 0
  },
  customersAffected: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

campaignSchema.virtual('status').get(function () {
  return this.enabled ? 'Active' : 'Inactive';
});

campaignSchema.set('toJSON', { virtuals: true });
campaignSchema.set('toObject', { virtuals: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
campaignSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Campaign', campaignSchema);
