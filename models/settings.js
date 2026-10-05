const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch-scoping: each branch owns its own Settings document so a
    // Sub Admin can configure their branch without touching tenant-wide
    // config. null = tenant-level (the owner's doc). Uniqueness is on
    // (restaurant, branch) so each pair has exactly one Settings row.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  general: {
    cafeName: { type: String, default: 'The Coffee House' },
    contactNumber: { type: String },
    email: { type: String },
    // Kept for backward compatibility — older clients read the full
    // formatted address from this single string. Writes go via the
    // structured addressDetails below; syncRestaurantFromGeneral
    // formats a joined version and mirrors it here too.
    address: { type: String },
    addressDetails: {
      line1:   { type: String, default: '' },
      line2:   { type: String, default: '' },
      city:    { type: String, default: '' },
      state:   { type: String, default: '' },
      pincode: { type: String, default: '' },
      country: { type: String, default: 'India' },
    },
    legal: {
      legalBusinessName: { type: String, default: '' },
      fssaiLicense:      { type: String, default: '' },
      gstin:             { type: String, default: '' },
      pan:               { type: String, default: '' },
    },
    timezone: { type: String, default: 'Asia/Kolkata' },
    logoUrl: { type: String },
    banners: [{ type: String }]
  },
  operatingHours: [{
    day: { type: String, required: true },
    start: { type: String, default: '09:00' },
    end: { type: String, default: '23:00' },
    isOpen: { type: Boolean, default: true }
  }],
  taxes: {
    serviceCharge: {
      enabled: { type: Boolean, default: true },
      value: { type: Number, default: 5, min: [0, 'Service charge cannot be negative'], max: [100, 'Service charge cannot exceed 100%'] }
    },
    gst: {
      enabled: { type: Boolean, default: true },
      value: { type: Number, default: 10, min: [0, 'GST cannot be negative'], max: [100, 'GST cannot exceed 100%'] }
    },
    additionalCharges: [{
      name: { type: String, required: true },
      value: { type: Number, required: true, min: [0, 'Charge value cannot be negative'] },
      type: { type: String, enum: ['Flat', 'Percentage'], default: 'Flat' },
      enabled: { type: Boolean, default: true }
    }]
  },
  notifications: {
    newOrder: { type: Boolean, default: true },
    orderReady: { type: Boolean, default: true },
    repeatQR: { type: Boolean, default: true },
    earlyCancellation: { type: Boolean, default: true },
    waiterCall: { type: Boolean, default: true },
    tableMerge: { type: Boolean, default: true }
  },
  branches: [{
    name: { type: String, required: true },
    addressLine1: { type: String, default: '' },
    addressLine2: { type: String, default: '' },
    hours: { type: String, default: '' },
    phone: { type: String, default: '' },
    isActive: { type: Boolean, default: true }
  }],
  reservation: {
    enableLateArrival: { type: Boolean, default: true },
    gracePeriod: { type: String, default: '10 min', enum: ['5 min', '10 min', '15 min', '30 min', '60 min'] },
    deductionType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
    priceDeduction: { type: Number, default: 0, min: [0, 'Price deduction cannot be negative'] },
    // Parking for table bookings (QA N10/N11). Billed hourly per vehicle:
    // Σ (pricePerHour × count) × hours. Customers pick "whole event"
    // (billed at `eventHours`) or a start time + 1..`maxDuration` hours.
    // An empty `vehicles` list means the built-in Bike/Car/Bus defaults
    // (utils/parkingConfig.DEFAULT_PARKING_VEHICLES).
    parking: {
      vehicles: {
        type: [{
          id: { type: String, required: true, trim: true, lowercase: true, maxlength: 30 },
          label: { type: String, required: true, trim: true, maxlength: 40 },
          pricePerHour: { type: Number, default: 0, min: [0, 'Parking price cannot be negative'], max: [100000, 'Parking price is too high'] },
          _id: false,
        }],
        default: [],
      },
      maxDuration: { type: Number, default: 6, min: [1, 'Max parking duration must be at least 1 hour'], max: [24, 'Max parking duration cannot exceed 24 hours'] },
      eventHours: { type: Number, default: 3, min: [1, 'Whole-event parking must be at least 1 hour'], max: [24, 'Whole-event parking cannot exceed 24 hours'] },
    }
  },
  // ── Home delivery ───────────────────────────────────────────────
  // Distance-slab based delivery charging. When `enabled`, the customer
  // checkout offers "Home Delivery"; they pick the km range that covers
  // their address and the matching `charge` is added to the bill. Slabs
  // are tenant-configured (add/remove rows) and must be non-overlapping
  // and sorted — enforced in settingsController.validateDelivery.
  delivery: {
    enabled: { type: Boolean, default: false },
    slabs: [{
      fromKm: { type: Number, required: true, min: [0, 'fromKm cannot be negative'] },
      toKm:   { type: Number, required: true, min: [0, 'toKm cannot be negative'] },
      charge: { type: Number, required: true, min: [0, 'Delivery charge cannot be negative'] },
    }],
    // Optional minimum cart value before delivery is allowed (0 = no minimum).
    minOrderValue: { type: Number, default: 0, min: [0, 'Minimum order value cannot be negative'] },
    // Restaurant (pickup) coordinates the delivery distance is measured
    // from. A branch with its own latitude/longitude overrides this. When
    // neither is set, checkout falls back to the customer picking a slab.
    origin: {
      lat: { type: Number, default: null, min: -90, max: 90 },
      lng: { type: Number, default: null, min: -180, max: 180 },
    },
  },
  wallet: {
    enableWallet: { type: Boolean, default: true },
    enableLoyalty: { type: Boolean, default: false },
    pointsPerRupee: { type: Number, default: 1, min: [0, 'Points per rupee cannot be negative'] },
    minBillToEarn: { type: Number, default: 100, min: [0, 'Minimum bill cannot be negative'] },
    maxRedeemPercent: { type: Number, default: 50, min: [0, 'Max redeem cannot be negative'], max: [100, 'Max redeem cannot exceed 100%'] },
    pointsToRupee: { type: Number, default: 0.1, min: [0, 'Points to rupee cannot be negative'] },
    pointsExpiryDays: { type: Number, default: 365, min: [0, '0 means never expire'] },
    // Decision 1 (2026-10): refunds go back to the original payment method
    // by default (same as PAYMENT_DEFAULTS.refundMode). Tenants that stored
    // 'wallet' under the old default are flipped by
    // migrations/setRefundModeOriginal.js.
    refundMode: { type: String, enum: ['wallet', 'original'], default: 'original' },
    allowNegativeBalance: { type: Boolean, default: false },
    multiBranchMode: { type: Boolean, default: false },
    branchRefundMode: { type: String, enum: ['global', 'per_branch'], default: 'global' },
    branchSpecificPoints: { type: Boolean, default: false }
  },
  // ── Public landing page (/<restaurantSlug>) ─────────────────────
  // Edited from Admin → Settings → Landing Page (PATCH
  // /settings/landingPage) and served by the unauthenticated
  // GET /public/restaurants/:slug/landing. Lives on the TENANT-level
  // doc (branch: null); branch docs may override it in future.
  // featuredItems ownership (same tenant) is enforced in the controller.
  landingPage: {
    enabled: { type: Boolean, default: true },
    tagline: { type: String, default: '', trim: true, maxlength: [120, 'Tagline cannot exceed 120 characters'] },
    about: { type: String, default: '', trim: true, maxlength: [2000, 'About cannot exceed 2000 characters'] },
    coverImages: {
      type: [{ type: String, trim: true, maxlength: [2000, 'Image URL is too long'] }],
      default: [],
      validate: { validator: (v) => !v || v.length <= 6, message: 'At most 6 cover images are allowed' },
    },
    social: {
      instagram:     { type: String, default: '', trim: true, maxlength: [300, 'Instagram link cannot exceed 300 characters'] },
      facebook:      { type: String, default: '', trim: true, maxlength: [300, 'Facebook link cannot exceed 300 characters'] },
      website:       { type: String, default: '', trim: true, maxlength: [300, 'Website cannot exceed 300 characters'] },
      whatsapp:      { type: String, default: '', trim: true, maxlength: [300, 'WhatsApp cannot exceed 300 characters'] },
      googleMapsUrl: { type: String, default: '', trim: true, maxlength: [300, 'Google Maps link cannot exceed 300 characters'] },
    },
    featuredItems: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }],
      default: [],
      validate: { validator: (v) => !v || v.length <= 8, message: 'At most 8 featured items are allowed' },
    },
    sections: {
      featured: { type: Boolean, default: true },
      about:    { type: Boolean, default: true },
      hours:    { type: Boolean, default: true },
      location: { type: Boolean, default: true },
      branches: { type: Boolean, default: true },
      gallery:  { type: Boolean, default: true },
    },
    accentColor: {
      type: String,
      default: '',
      trim: true,
      validate: {
        validator: (v) => !v || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v),
        message: 'Accent colour must be a hex code like #FE8301',
      },
    },
  }
}, { timestamps: true });

// One Settings doc per (restaurant, branch) — tenant-level uses branch=null.
settingsSchema.index({ restaurant: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
settingsSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Settings', settingsSchema);