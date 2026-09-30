const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch-scoping: a Sub Admin pinned to a branch owns coupons they
    // create (branch = their branch). Tenant owner's coupons stay null
    // but, per product decision, sub-branches do NOT see null/tenant-
    // level coupons — enforcement lives in promotionController via
    // strictBranchFilter.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  // Coupon codes are unique per tenant+branch — Branch A and Branch B
  // can both run "WELCOME10". The compound index at the bottom of this
  // file replaces the old global `unique: true` on code.
  code: {
    type: String,
    required: [true, 'Coupon code is required'],
    uppercase: true,
    trim: true
  },
  title: {
    type: String,
    required: [true, 'Coupon title is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed_amount', 'shipping_discount', 'bogo'],
    default: 'percentage'
  },
  discountValue: {
    type: Number,
    required: [true, 'Discount value is required'],
    min: [0.01, 'Discount value must be greater than 0']
  },
  minOrderValue: {
    type: Number,
    default: 0,
    min: [0, 'Min order value cannot be negative']
  },
  maxDiscountAmount: {
    type: Number, // Cap for percentage-based discounts
    default: 0
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: [true, 'Expiry date is required']
  },
  usageLimit: {
    type: Number, // Total times this coupon can be used across all customers
    default: 1000
  },
  usageCount: {
    type: Number,
    default: 0
  },
  usagePerUser: {
    type: Number, // How many times a single user can use this coupon
    default: 1
  },
  isActive: {
    type: Boolean,
    default: true
  },
  couponCategory: {
    type: String,
    enum: ['all', 'specific_item', 'specific_category', 'first_order', 'specific_user'],
    default: 'all'
  },
  // ADM-064 — item-scope filter for the discount. 'all' is the legacy
  // behavior (apply to every line item). 'food' / 'beverages' restrict
  // the eligible subtotal to items whose menu-item prepStation matches
  // (kitchen / counter → food, bar → beverages). The minOrderValue check
  // is still evaluated against the FULL order subtotal — the coupon
  // requires the customer to spend ₹X overall, but only discounts the
  // matching slice.
  scope: {
    type: String,
    enum: ['all', 'food', 'beverages'],
    default: 'all',
    index: true,
  },
  startTime: { type: String }, // e.g. "12:00"
  endTime:   { type: String }, // e.g. "15:00"
  targetUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, { timestamps: true });

// Check if coupon is currently valid
couponSchema.virtual('isValid').get(function() {
  const now = new Date();
  return this.isActive && now >= this.startDate && now <= this.endDate && this.usageCount < this.usageLimit;
});

// Uniqueness on (code, restaurant, branch). `Seed/dropLegacyIndexes.js`
// drops the old global `code_1` index. The per-tenant index added in
// Phase 1 (`code_1_restaurant_1`) is superseded by this one — run
// `db.coupons.dropIndex('code_1_restaurant_1')` once against existing
// environments so the new index takes over.
couponSchema.index({ code: 1, restaurant: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
couponSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Coupon', couponSchema);
