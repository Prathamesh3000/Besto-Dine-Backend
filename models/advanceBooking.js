const mongoose = require('mongoose');

const advanceBookingSchema = new mongoose.Schema({
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
    // Phase 1 SaaS: bookingId is generated PER TENANT (e.g. TBL-001).
    // The legacy global `unique: true` is replaced by the compound index
    // `{ bookingId, restaurant }` declared at the bottom of this file.
    bookingId: {
        type: String,
        required: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    bookingType: {
        type: String,
        enum: ['table', 'hall'],
        default: 'table'
    },
    area: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Area',
        required: false // Optional for hall bookings
    },
    tables: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table'
    }],
    hall: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hall',
        required: false
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package',
        required: false
    },
    bookingDate: {
        type: Date,
        required: true
    },
    bookingTime: {
        type: String,
        required: true
    },
    timeSlot: { // Lunch / Dinner
        type: String,
        enum: ['Lunch', 'Dinner'],
        required: true
    },
    // Block start as "HH:MM" (24h) and its length in hours. Used by the
    // hall overlap check so two bookings on the same day only conflict
    // when their time windows actually intersect. Legacy docs have
    // neither; the controller derives a start from `bookingTime`.
    startTime: {
        type: String,
        default: null
    },
    durationHours: {
        type: Number,
        min: 1,
        max: 24,
        default: null
    },
    guestCount: {
        type: Number,
        required: true,
        min: 1
    },
    specialEvent: {
        type: String,
        default: 'None'
    },
    cakeDetails: {
        quantity: { type: Number, default: 0 },
        flavor: { type: String },
        size: { type: String },
        specialMessage: { type: String },
        isVeg: { type: Boolean, default: true },
        isSkipped: { type: Boolean, default: false }
    },
    addons: {
        decoration: {
            id: { type: String },
            title: { type: String },
            price: { type: Number }
        },
        otherAddons: [{
            id: { type: String },
            title: { type: String },
            price: { type: Number },
            options: [String]
        }],
        isSkipped: { type: Boolean, default: false }
    },
    parkingDetails: {
        vehicleType: { type: String },
        count: { type: Number, default: 0 },
        timeDuration: { type: String, default: '2hrs' },
        isSkipped: { type: Boolean, default: false }
    },
    payment: {
        totalAmount: { type: Number, required: true },
        advancePaid: { type: Number, default: 0 },
        method: { type: String, default: 'cash' },
        status: {
            type: String,
            enum: ['Pending', 'Confirmed', 'Paid', 'Partial'],
            default: 'Pending'
        },
        couponCode: { type: String },
        walletPointsUsed: { type: Number, default: 0 },

        // Razorpay reference for the FIRST-leg (advance / full) charge.
        // Only set after the server verified the checkout signature and
        // fetched the payment from Razorpay; the payment id is also
        // claimed in PaymentClaim so it can't fund a second booking.
        razorpayPaymentId: { type: String, default: null, index: true },
        razorpayOrderId: { type: String, default: null },
        // Server-computed price lines at booking time (audit trail for
        // the totalAmount above; never taken from the browser).
        priceBreakdown: { type: mongoose.Schema.Types.Mixed, default: null },

        // Razorpay reference for the second-leg "pay remaining" charge.
        // Stamped by createRemainingPaymentOrder so the verify endpoint
        // (and any future reconciliation job) can resolve the booking
        // from a Razorpay-only payload without trusting the client.
        remainingRazorpayOrderId: { type: String, default: null, index: true },
        // Set when verifyRemainingPayment lands the second leg. Gives
        // admin / receipts a "fully paid at" timestamp distinct from
        // the original advance-paid timestamp.
        fullyPaidAt: { type: Date, default: null },
        // Marker for the reminder scheduler so it never sends a second
        // "balance due" notification for the same booking. Reset only
        // if admin re-opens a cancelled booking (rare, manual).
        balanceReminderSentAt: { type: Date, default: null }
    },
    status: {
        type: String,
        enum: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
        default: 'Pending'
    },
    // CUS-075 — customer / admin cancellation audit. Populated only when
    // status flips to 'Cancelled'. refundAmount reflects the policy at
    // cancellation time so a later refund-policy tweak doesn't change
    // what was already promised to this customer.
    cancellation: {
        cancelledAt: { type: Date, default: null },
        cancelledBy: { type: String, enum: ['customer', 'admin', 'system'], default: null },
        refundPct: { type: Number, default: 0 },
        refundAmount: { type: Number, default: 0 },
        refundTier: { type: String, default: '' },
        hoursBeforeEvent: { type: Number, default: 0 },
        policy: { type: String, default: '' },
        reason: { type: String, default: '' }
    },
    notes: {
        type: String,
        trim: true
    }
}, {
    timestamps: true
});

advanceBookingSchema.index({ user: 1, bookingDate: -1 });
advanceBookingSchema.index({ status: 1, createdAt: -1 });
advanceBookingSchema.index({ bookingDate: 1 });
// Branch-scoped admin advance bookings list — admin Bookings page
// filters by (tenant, branch, bookingDate, status) when listing
// upcoming bookings for a specific branch.
advanceBookingSchema.index({ restaurant: 1, branch: 1, bookingDate: 1, status: 1 });
// Phase 1 SaaS: per-tenant uniqueness on bookingId.
// `Seed/dropLegacyIndexes.js` drops the old `bookingId_1` global index.
advanceBookingSchema.index({ bookingId: 1, restaurant: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
advanceBookingSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('AdvanceBooking', advanceBookingSchema);
