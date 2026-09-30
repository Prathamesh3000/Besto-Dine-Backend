const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
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
  title: {
    type: String,
    required: [true, 'Promotion title is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  image: {
    type: String, // URL to the banner image
    required: [true, 'Promotion image is required']
  },
  type: {
    type: String,
    enum: ['banner', 'popup', 'featured_item', 'offer'],
    default: 'banner'
  },
  link: {
    type: String, // Deep link to category/item or external URL
    default: ''
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: [true, 'End date is required']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  displayOrder: {
    type: Number,
    default: 0
  },
  targetAudience: {
    type: String,
    enum: ['all', 'new_customers', 'loyal_customers', 'membership_holders'],
    default: 'all'
  }
}, { timestamps: true });

// Check if promotion is currently valid
promotionSchema.virtual('isValid').get(function() {
  const now = new Date();
  return this.isActive && now >= this.startDate && now <= this.endDate;
});

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
promotionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Promotion', promotionSchema);
