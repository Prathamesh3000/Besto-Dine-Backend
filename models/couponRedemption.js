const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch of the coupon that was redeemed — stamped at creation so
    // Sub Admin analytics only count redemptions of their own coupons.
    // null = tenant-level coupon (tenant-owner scope).
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  coupon: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true,
    index: true
  },
  // Backref to the order that triggered this redemption. Populated for
  // all new redemptions; null for pre-fix legacy rows. Used as the
  // dedup key by Seed/backfillCouponRedemptions.js so the script can be
  // re-run safely without creating duplicate log rows.
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
    index: true,
    sparse: true,
  },
  couponCode: { type: String, required: true },
  couponTitle: { type: String, required: true },
  // Optional: guests / QR-scan diners place orders without an account,
  // but they still consume the coupon's usageLimit. We log redemption
  // rows for them with `user: null` so the redemption table matches the
  // Coupon.usageCount counter — otherwise the parent stat (which sums
  // usageCount) reads e.g. 12 while this collection shows 0.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  orderValue: { type: Number, required: true },
  discountAmount: { type: Number, required: true },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed_amount', 'shipping_discount', 'bogo'],
    required: true
  },
  discountValue: { type: Number, required: true }
}, { timestamps: true });

couponRedemptionSchema.index({ createdAt: -1 });
couponRedemptionSchema.index({ coupon: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
couponRedemptionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
