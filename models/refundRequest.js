const mongoose = require('mongoose');

// ADM-049 — customer-initiated refund request workflow.
//
// Before this model existed, customers had no way to "ask for" a refund:
// cancelling a paid order kicked off an immediate auto-refund inside
// cancelOrder, and there was no separate request artefact for the admin
// to review. That hid the decision from the tenant (no chance to verify
// the cancel was legitimate) and from the customer (no audit trail).
//
// A RefundRequest is created in two situations:
//   1. The customer cancels a paid order — cancelOrder now creates the
//      request automatically with the cancellation reason. The order
//      stays paymentStatus: 'Paid' until the admin approves; that's
//      what surfaces it as Pending in /admin/refunds.
//   2. The customer hits POST /orders/:id/refund-request explicitly
//      (e.g. "the food was cold" on a delivered order). Same lifecycle.
//
// Lifecycle:
//   pending  → admin can approve or reject
//   approved → processOrderRefund has run; money moved; terminal
//   rejected → admin declined; no money moved; terminal
//
// Only one PENDING request per order is allowed (enforced by the partial
// unique index at the bottom). Once a request is decided the customer can
// open a new one if there's still an unrefunded balance.

const refundRequestSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true,
        index: true,
    },
    // Snapshot of the order id string at request time. Surfaces in the
    // admin table without a populate round-trip and is stable even if
    // the order id ever gets re-stamped.
    orderIdRef: { type: String, default: '' },
    // The customer who initiated the request. Nullable so a guest
    // cancellation (rare for paid orders) still records the request.
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    customerName: { type: String, default: '' },
    customerPhone: { type: String, default: '' },
    // The amount the customer is asking back. Defaults to the full
    // unrefunded balance at creation time.
    amount: {
        type: Number,
        required: true,
        min: [0, 'Refund amount cannot be negative'],
    },
    reason: { type: String, default: '' },
    // Origin tag so we can tell automatic (cancel-triggered) requests
    // apart from explicit customer-initiated ones in reporting.
    source: {
        type: String,
        enum: ['customer-cancel', 'customer-request', 'admin'],
        default: 'customer-cancel',
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true,
    },
    decidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    // When approved, the snapshot of how processOrderRefund routed the
    // money (wallet / original / manual) and the Razorpay refund id if
    // one was created. Useful for the admin row's secondary line.
    refundMode: { type: String, default: '' },
    razorpayRefundId: { type: String, default: '' },
}, { timestamps: true });

// Enforce "one pending per order" — a customer can't queue three
// requests on the same order while the admin hasn't decided the first.
// Partial filter so approved/rejected rows don't conflict with a new
// pending one created later (e.g. partial refund first, then a second
// request for the remainder).
refundRequestSchema.index(
    { order: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' } }
);

// Common admin list query: pending refunds for a tenant, newest first.
refundRequestSchema.index({ restaurant: 1, status: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
refundRequestSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('RefundRequest', refundRequestSchema);
