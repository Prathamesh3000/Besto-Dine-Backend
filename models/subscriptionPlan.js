const mongoose = require('mongoose');

/**
 * SubscriptionPlan — SaaS billing plan / package tier
 *
 * Defines what a tenant on this plan is allowed to do (features) and how
 * much of each resource they may consume (limits). Super Admin manages
 * these via /api/v1/superadmin/plans.
 *
 * NOTE: This is intentionally NOT named `Package` because the existing
 * `Backend/models/package.js` already defines an event/decoration package
 * used by Advance Bookings. The two domains share the word but mean very
 * different things — keeping them on distinct Mongoose model names avoids
 * a destructive name collision.
 */

const FEATURE_KEYS = [
    'dineIn',
    'takeaway',
    'kitchenDisplay',
    'waiterDashboard',
    'advanceBookingTable',
    'advanceBookingHall',
    'walletLoyalty',
    'couponPromotions',
    'inventory',
    'crm',
    'tipManagement',
    'multiBranch',
    'staffPerformance',
    'paymentGateway',
    'dataExport',
    'webhooks',
    'kiosk',
    // Added with the Silver / Gold / Premium line-up (PRICING_PACKAGING §4).
    // campaigns used to ride on couponPromotions — tenants whose snapshot
    // pre-dates the key fall back to that (utils/featureAccess).
    'campaigns',
    'aggregatorOrders',
    'accountingExport',
    'eInvoice',
    'whiteLabelBranding',
];

// Build the features sub-schema dynamically so adding a new feature key
// only requires touching FEATURE_KEYS above.
const featuresSchemaDefinition = FEATURE_KEYS.reduce((acc, key) => {
    acc[key] = { type: Boolean, default: false };
    return acc;
}, {});
// `revenueAnalytics` is tiered, not a boolean
featuresSchemaDefinition.revenueAnalytics = {
    type: String,
    enum: ['none', 'basic', 'standard', 'advanced'],
    default: 'none',
};

const subscriptionPlanSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: [60, 'Plan name cannot exceed 60 characters'],
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug may only contain lowercase letters, digits and hyphens'],
    },
    description: {
        type: String,
        default: '',
        maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    price: {
        type: Number,
        required: true,
        min: [0, 'Price cannot be negative'],
    },
    currency: {
        type: String,
        default: 'INR',
        uppercase: true,
        maxlength: 3,
    },
    billingCycle: {
        type: String,
        enum: ['monthly', 'quarterly', 'yearly'],
        default: 'monthly',
    },
    trialDays: {
        type: Number,
        default: 0,
        min: [0, 'Trial days cannot be negative'],
    },
    limits: {
        maxBranches:  { type: Number, default: 1, min: 0 },
        maxStaff:     { type: Number, default: 5, min: 0 },
        maxMenuItems: { type: Number, default: 50, min: 0 },
        maxTables:    { type: Number, default: 10, min: 0 },
        apiRateLimit: { type: Number, default: 100, min: 0 },
        // Phase 7.5 — audit log retention window in days. After this
        // many days, audit entries for tenants on this plan become
        // eligible for purging by the Super Admin retention endpoint.
        // 0 = unlimited (never purge). Defaults to 365 for paid
        // plans; Super Admin can set shorter/longer per tier.
        auditRetentionDays: { type: Number, default: 365, min: 0 },
    },
    features: featuresSchemaDefinition,
    isActive: {
        type: Boolean,
        default: true,
        index: true,
    },
    // Public plans appear in the tenant upgrade catalog (and any DB-driven
    // public pricing). Private plans are bespoke deals crafted for a single
    // tenant — the Super Admin assigns them directly; they never surface in
    // any tenant-facing list or on the marketing site.
    isPublic: {
        type: Boolean,
        default: true,
    },
    sortOrder: {
        type: Number,
        default: 0,
    },
    // Marketing emphasis on the public pricing list (GET /public/plans),
    // e.g. "Most popular". Purely presentational.
    highlight: {
        type: Boolean,
        default: false,
    },
    // ── Razorpay billing (Phase 2) ─────────────────────────────────
    // razorpayPlanId is stamped the first time a paid assignment
    // references this plan. We do not create a Razorpay plan eagerly
    // at seed time because free plans (price: 0) don't need one and
    // a Razorpay account may not be configured in dev.
    razorpayPlanId: {
        type: String,
        default: '',
    },
}, { timestamps: true });

subscriptionPlanSchema.index({ isActive: 1, sortOrder: 1 });

// Expose feature keys to consumers (controllers, validators, frontend).
subscriptionPlanSchema.statics.FEATURE_KEYS = FEATURE_KEYS;

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
