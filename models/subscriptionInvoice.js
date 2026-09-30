const mongoose = require('mongoose');

/**
 * SubscriptionInvoice — one row per successful Razorpay subscription
 * charge. Phase 5 step 5.
 *
 * These are PLATFORM billing invoices (tenant → BestoDine), not
 * order invoices (customer → tenant). The existing `invoice.js` model
 * handles customer-facing order receipts; this is a different domain
 * with different fields and a different lifecycle.
 *
 * Populated by the razorpayController webhook handler on every
 * `subscription.charged` event. Idempotent — the razorpayPaymentId
 * is uniquely indexed so retried webhooks can't duplicate a row.
 *
 * Retention: like auditLog, these are append-only. They're financial
 * records and must be kept for the platform's contractual / tax
 * window. Do NOT add a TTL index.
 */
const subscriptionInvoiceSchema = new mongoose.Schema({
    // Tenant link — required for every row. Reads are always scoped
    // by this field so a tenant can only see their own invoices.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },

    // Denormalised for fast UI rendering without a join.
    restaurantName: { type: String, default: '' },

    // Per-tenant invoice number (INV-YYYYMMDD-XXXX where XXXX is a
    // zero-padded counter scoped to this tenant for that day).
    invoiceNumber: {
        type: String,
        required: true,
        index: true,
    },

    // Plan snapshot — denormalised so future plan rename/archive
    // doesn't rewrite historical invoices.
    planName:  { type: String, default: '' },
    planSlug:  { type: String, default: '' },

    // Amount in the smallest currency unit (paise for INR) to match
    // Razorpay's convention. Frontend divides by 100 for display.
    amount:   { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    // Billing period covered by this charge.
    periodStart: { type: Date },
    periodEnd:   { type: Date },

    // Razorpay references — subscriptionId is denormalised so an
    // operator can group invoices by subscription without a join.
    razorpayPaymentId:      {
        type: String,
        required: true,
        unique: true,  // idempotency: retried webhook = same paymentId = no-op
        index: true,
    },
    razorpaySubscriptionId: { type: String, default: '' },

    // Status: 'paid' on create (this model only represents successful
    // charges); 'refunded' if a refund webhook later flips it.
    status: {
        type: String,
        enum: ['paid', 'refunded', 'partially_refunded'],
        default: 'paid',
    },

    // When Razorpay captured the payment. May differ from createdAt
    // if the webhook arrives late.
    paidAt: { type: Date },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

// Chronological queries per tenant (the most common access pattern).
subscriptionInvoiceSchema.index({ restaurant: 1, createdAt: -1 });

// Composite unique on (restaurant, invoiceNumber) — the per-day
// invoice counter is computed in the app layer and previously raced
// (two concurrent webhooks for the same tenant on the same day both
// got N+1). The applyPaidPlanUpgrade helper now retries with the
// next slot when this index rejects the insert, but the index itself
// is what makes the race detectable in the first place.
subscriptionInvoiceSchema.index(
    { restaurant: 1, invoiceNumber: 1 },
    { unique: true, name: 'restaurant_invoiceNumber_unique' }
);

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
subscriptionInvoiceSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('SubscriptionInvoice', subscriptionInvoiceSchema);
