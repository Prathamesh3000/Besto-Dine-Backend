const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  menuItem: { type: String }, // Flexible for both real IDs and mock IDs
  name: { type: String, required: true }, // Keep a copy of name at time of order
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  category: { type: String, default: '' },   // Category name snapshot (e.g. "Main Course")
  vegType: { type: String, enum: ['veg', 'non-veg', ''], default: '' }, // For kitchen routing
  // Decision 6 — snapshot of the menu category's kind ('food' |
  // 'beverages') at order time. utils/couponScope.classifyItem prefers it
  // over the prep-station fallback when scoping food / beverages coupons.
  // '' = unknown (legacy line / category without a kind).
  categoryKind: { type: String, enum: ['food', 'beverages', ''], default: '' },
  // Snapshot of MenuItem.prepStation at order time. Used by the kitchen
  // KDS filter and the create-order auto-ready logic. Defaults to
  // 'kitchen' so legacy line items continue to flow through the chef.
  prepStation: { type: String, enum: ['kitchen', 'bar', 'counter'], default: 'kitchen' },
  // Snapshot of MenuItem.prepTimeMinutes at order time. Frozen so that
  // editing prep time in Menu Management later cannot retro-shift a
  // takeaway order's "Prepare Now" moment. The takeaway chef queue
  // sums these (× quantity) to compute when cooking should start.
  prepTimeMinutes: { type: Number, default: 15, min: 0 },
  selectedSizes: [{
    id: String,
    name: String,
    priceDetails: mongoose.Schema.Types.Mixed
  }],
  selectedToppings: [{
    id: String,
    name: String,
    price: Number
  }],
  instructions: { type: String, default: '' },
  // When the item was added. Original items get `order.createdAt`; items
  // appended via POST /orders/:id/append get a later timestamp so the
  // chef card can split "Original order" from "Added later" instead of
  // merging everything into one indistinguishable list.
  addedAt: { type: Date, default: Date.now },
});

const orderSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 step 4: optional branch link. Inherited from the
    // table's branch on dine-in orders. For takeaway, the caller
    // can optionally pass a branch in the body (validated against
    // the tenant). null = unscoped / tenant-level (the default for
    // every order created before this migration).
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  orderId: { type: String, required: true, unique: true }, // e.g., ORD-0001
  type: { type: String, enum: ['dine-in', 'takeaway'], default: 'dine-in' },

  // Channel that produced this order. Lets dashboards split kiosk vs
  // QR vs staff vs web customer instead of inferring from
  // pickupLocation substrings. Defaults to 'web-customer' so legacy
  // orders backfill cleanly.
  source: {
    type: String,
    enum: ['web-customer', 'qr-scan', 'kiosk', 'staff', 'pos', 'admin'],
    default: 'web-customer',
    index: true,
  },

  // Idempotency key supplied by the client on createOrder. Combined
  // with `restaurant` it forms a tenant-scoped unique constraint so
  // a network blip / payment-handler retry on the same logical order
  // returns the original instead of creating a twin in the kitchen.
  clientIdempotencyKey: { type: String, default: null, index: true },

  // Relations
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Logged-in customer
  customerName: { type: String, default: 'Guest' }, // Fallback for guests
  phone: { type: String },
  table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table' },

  // CRIT-12 — per-QR-scan session id copied from the guest's scanToken
  // at order create time. The socket `order:<id>` room gate compares
  // this against the diner's current scanToken.sessionId so a new
  // scanToken at the same physical table cannot read past orders.
  scanSessionId: { type: String, default: null, index: true },

  // Takeaway-specific
  pickupTime: { type: String },  // e.g. "02:30 PM"
  // Phase 6 step 4 rename: the legacy `branch: String` field was
  // a free-text label for the takeaway pickup location (tenant /
  // branch name), shown on receipts. It's been renamed to
  // `pickupLocation` so the canonical `branch: ObjectId ref Branch`
  // field above can hold the real branch reference. Existing
  // orders created before this migration have `branch: <string>`
  // which needs a one-time `$rename` in Mongo — see
  // Seed/migrateOrderPickupLocation.js.
  pickupLocation: { type: String },  // Display label for takeaway pickup location

  // ── Home delivery ───────────────────────────────────────────────
  // A delivery order is a takeaway (no table, packed) that the diner
  // wants brought to their address instead of collecting themselves.
  // We model it as a sub-document on the takeaway order rather than a
  // distinct `type` so all the existing takeaway branch / validation
  // / kitchen-routing logic keeps working unchanged — `delivery.requested`
  // is the only switch that turns a takeaway into a delivery.
  //
  // The distance-based charge is settings-driven (Settings.delivery.slabs):
  // the customer picks the km range that covers their address, the server
  // looks up the authoritative `charge` for that range, and we SNAPSHOT
  // the chosen slab + fee onto the order so a later edit of the slab table
  // can't retro-change a placed order's bill.
  //
  // Delivery has its own lifecycle (`delivery.status`) layered on top of
  // the normal kitchen flow: the order still goes new → preparing → ready
  // in the KDS, then delivery.status drives pending → assigned →
  // out-for-delivery → delivered. The order's top-level `status` reaches
  // 'served' when the food is handed to the delivery person.
  delivery: {
    requested: { type: Boolean, default: false },
    address: { type: String, maxlength: [500, 'Delivery address cannot exceed 500 characters'] },
    // Snapshot of the Settings slab the customer selected at checkout.
    slab: {
      fromKm: { type: Number },
      toKm:   { type: Number },
      charge: { type: Number },
    },
    fee: { type: Number, default: 0, min: [0, 'Delivery fee cannot be negative'] },
    // Server-measured straight-line distance (km) from the branch /
    // restaurant to the customer, and the customer's coordinates. null
    // when the fee came from a manually chosen slab (no coordinates).
    distanceKm: { type: Number, default: null, min: 0 },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'out-for-delivery', 'delivered'],
      default: 'pending',
    },
    // Phase 1: free-text delivery person name typed by the admin (no
    // dedicated delivery-staff role yet). Phase 2 will add `partner` as
    // a User ref when the delivery-boy role lands.
    partnerName: { type: String, maxlength: [80, 'Partner name cannot exceed 80 characters'] },
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date },
    outForDeliveryAt: { type: Date },
    deliveredAt: { type: Date },
  },

  // Order contents
  items: [orderItemSchema],
  total: { type: Number, required: true, min: [0, 'Total cannot be negative'] },

  // ── Tax & charge breakdown (stamped at creation) ──────────────────
  // Previously the server modelled no taxes at all: these fields did
  // not exist, so `order.serviceCharge` read by paymentController was
  // ALWAYS undefined, and every bill screen re-derived the numbers
  // from the *current* Settings. That meant an admin editing the GST
  // rate retroactively rewrote what historical orders appear to have
  // charged. Persisting the breakdown makes each order an immutable
  // record of what the customer was actually billed.
  //
  // serviceCharge is 0 for takeaway/delivery/kiosk by policy — see
  // utils/billing.SERVICE_CHARGE_TYPES. It pays for table service,
  // which those channels never receive.
  gst:                { type: Number, default: 0, min: [0, 'GST cannot be negative'] },
  gstPercentage:      { type: Number, default: 0, min: 0, max: 100 },
  serviceCharge:      { type: Number, default: 0, min: [0, 'Service charge cannot be negative'] },
  serviceChargePercentage: { type: Number, default: 0, min: 0, max: 100 },
  additionalCharges: [{
    name:   { type: String },
    type:   { type: String, enum: ['Flat', 'Percentage'], default: 'Flat' },
    value:  { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
  }],
  additionalChargesTotal: { type: Number, default: 0, min: 0 },
  note: { type: String, maxlength: [500, 'Note cannot exceed 500 characters'] }, // General order instruction

  // Statuses
  status: {
    type: String,
    // 'awaiting-payment' — a pay-first order that exists (so the counter
    // can find it) but is HELD from the kitchen until it is paid. Only
    // tenants whose operations profile sets payment.holdUntilPaid ever
    // produce it (services/orderHoldService.js). Every kitchen / waiter
    // list uses a $in whitelist of the other statuses, so a held order is
    // invisible to them by default.
    enum: ['awaiting-payment', 'new', 'preparing', 'ready', 'served', 'cancelled'],
    default: 'new'
  },
  // Hold bookkeeping (status 'awaiting-payment' only).
  //   holdReason        — how the customer said they'd pay first
  //   holdReleaseStatus — the status the order takes when released
  //                       ('new' for kitchen work, 'ready' for counter-only)
  //   holdExpiresAt     — after this an unpaid hold is cancelled
  //                       (utils/heldOrderSweeper.js)
  //   releasedAt        — when payment released it to the kitchen
  holdReason: { type: String, enum: ['counterCash', 'online', 'wallet', null], default: undefined },
  holdReleaseStatus: { type: String, enum: ['new', 'ready', null], default: undefined },
  holdExpiresAt: { type: Date },
  //   onlinePaymentFailedAt — Razorpay reported payment.failed while the
  //                       order was held with holdReason 'online'; the
  //                       sweeper may cancel it after holdExpiresAt once
  //                       reconciliation finds no capture
  onlinePaymentFailedAt: { type: Date },
  releasedAt: { type: Date },
  // How THIS dine-in round pays, decided once at creation from the
  // operations profile (orderCreateService.resolveOperationsGate):
  //   'payFirst' — paid before the kitchen (held or prepaid checkout)
  //   'payAfter' — the table bill is settled after the meal
  // Only set for customer dine-in orders under a profile; a tenant whose
  // profile lets the customer choose ('either') gets both kinds on one
  // table. Unset (every order before this field, staff / POS orders,
  // tenants without a profile) → the tenant's dine-in mode decides
  // (utils/operationsProfile.orderIsPayFirst).
  paymentChannel: { type: String, enum: ['payFirst', 'payAfter'], default: undefined },

  // ── Cancellation audit ─────────────────────────────────────────
  // Populated when status transitions to 'cancelled'. Separates
  // WHY from WHO/WHEN so reports can tell a "walkout" (revenue
  // loss) apart from a "customer changed their mind before cook"
  // (no loss), and an auto-sweeper cleanup (system event).
  //
  // The free-form legacy "Cancelled by customer: X" note lives in
  // the `note` field alongside customer order instructions — these
  // dedicated fields are the new canonical source.
  cancelReason: {
    type: String,
    enum: [
      'customer-cancel',   // guest cancelled before prep
      'walkout',           // guest left without paying after items were placed
      'emergency',         // guest had to leave urgently
      'complaint',         // quality/service complaint, food comped
      'kitchen-issue',     // kitchen couldn't fulfill
      'admin-void',        // generic admin override
      'auto-sweeper',      // empty-order sweeper cleanup
      'payment-timeout',   // held pay-first order never paid (heldOrderSweeper)
      'other',
    ],
    default: null,
  },
  cancelReasonNote: { type: String, default: '', maxlength: [500, 'Cancellation note cannot exceed 500 characters'] },
  cancelledAt: { type: Date },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Partially Paid', 'Paid', 'Refunded'],
    default: 'Pending'
  },
  paymentMethod: { type: String, default: 'Not selected' },
  amountPaid: { type: Number, default: 0, min: [0, 'Amount paid cannot be negative'] },
  // Wallet portion of a split-rail payment (wallet rupees + Razorpay).
  // Stored separately from amountPaid so the breakdown survives —
  // Razorpay's verify hook would otherwise overwrite order.total with
  // its captured amount and the wallet contribution would be lost from
  // the order's history. Sum invariant: amountPaid = capturedRzp + walletAmountPaid.
  walletAmountPaid: { type: Number, default: 0, min: [0, 'Wallet amount paid cannot be negative'] },
  razorpayOrderId: { type: String },    // Razorpay order ID (for reconciliation & refunds)
  // Every Razorpay checkout ever opened for this order (decision 4a).
  // razorpayOrderId is the latest / the one that settled it; a payment
  // made through ANY checkout listed here may settle the order, so a
  // customer who pays an older checkout is never charged for nothing.
  razorpayOrderIds: { type: [String], default: undefined },
  razorpayPaymentId: { type: String },  // Razorpay payment ID (needed for refunds)
  paidAt: { type: Date },               // When paymentStatus first transitioned to Paid
  // Set once PATCH /orders/:id/payment has run the post-payment
  // bookkeeping (loyalty points, notifications, table release) for a
  // wallet-settled order. Claimed atomically so a replayed call can't
  // award points twice.
  customerPaymentFinalizedAt: { type: Date, default: null },
  refundedAmount: { type: Number, default: 0, min: [0, 'Refunded amount cannot be negative'] },
  // Per-refund audit trail. Each entry captures one refund event so the
  // admin dashboard can show a full history (amount, who/what triggered
  // it, Razorpay refund ID for reconciliation) instead of just the
  // aggregate `refundedAmount`. Backfilled to `[]` on existing orders.
  refunds: [{
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, default: '' },
    razorpayRefundId: { type: String, default: null },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    source: { type: String, enum: ['admin', 'webhook'], default: 'admin' },
    createdAt: { type: Date, default: Date.now },
  }],
  tipAmount: { type: Number, default: 0, min: [0, 'Tip amount cannot be negative'] },
  // Coupon / wallet adjustments captured at checkout. Stored so the
  // admin bill view matches what the customer saw — without these the
  // table drawer was showing an inflated total with no discount line.
  couponCode: { type: String, default: '' },
  couponDiscount: { type: Number, default: 0, min: [0, 'Coupon discount cannot be negative'] },
  pointsRedeemed: { type: Number, default: 0, min: [0, 'Points redeemed cannot be negative'] },
  // Manual discount the admin/waiter applies from the table drawer. Stored
  // so it shows on the CUSTOMER's bill (bill-preview) before they pay — not
  // just at the moment of settlement — and so the admin drawer + customer
  // bill agree on the final amount.
  manualDiscount: { type: Number, default: 0, min: [0, 'Manual discount cannot be negative'] },
  // Mixed-cart split (services/orderCreateService.buildOrderDocs): the
  // counter-side doc of a checkout points at the primary (kitchen) doc
  // it was split from. One online payment of the checkout settles both —
  // see razorpayController.settleSplitSiblings. null on every other order.
  splitParent: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  waiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  chef: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Performance tracking timestamps
  preparationStartedAt: { type: Date },
  preparationCompletedAt: { type: Date },
  // When the order was actually picked up / served. updatedAt is too
  // fuzzy as a proxy because any unrelated save bumps it; this is a
  // dedicated marker for the customer tracking timeline.
  servedAt: { type: Date },

  // ── Cancellation audit ────────────────────────────────────────────
  // Cancelling an order that was already 'ready' or 'served' writes
  // off food that was actually produced, so it must be attributable.
  // updateOrderStatus requires a reason and a captain/manager role for
  // those two states; early cancellations record who/when only.
  cancellationReason: { type: String, trim: true },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: { type: Date },
  // Customer-initiated "settle bill at counter" request. Set when the
  // dine-in customer chooses Pay-at-Counter on the bill preview;
  // cleared (left as-is — historical record) when admin marks the
  // order paid via the table drawer alert. Drives the red alert
  // banner inside the admin TablesDashboard drawer.
  counterPaymentRequestedAt: { type: Date },

  // Tracks whether deductInventoryForOrder has already run against
  // this order. Gates the deduction (idempotency — don't double-deduct
  // if status somehow re-enters 'preparing') and drives the restore
  // path when an in-progress order is cancelled.
  inventoryDeducted: { type: Boolean, default: false },
  inventoryDeductedAt: { type: Date },

  // Customer feedback
  rating: { type: Number, min: 1, max: 5 },
  feedback: { type: String, default: '', maxlength: [500, 'Feedback cannot exceed 500 characters'] },
  ratedAt: { type: Date },

}, { timestamps: true });

// Performance indexes
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ user: 1, status: 1 });          // For "my active orders" queries
orderSchema.index({ table: 1, status: 1 });
orderSchema.index({ type: 1, status: 1 });
orderSchema.index({ paymentStatus: 1 });
// Tenant-scoped payment analytics (admin dashboard, reconciliation)
orderSchema.index({ restaurant: 1, paymentStatus: 1, createdAt: -1 });
// Branch-scoped admin orders list (most common admin query: filter by
// branch + status + date). Without the branch dimension, branch-pinned
// admins force a collection scan on top of the existing index.
orderSchema.index({ restaurant: 1, branch: 1, status: 1, createdAt: -1 });
// Branch-scoped payments dashboard + refund reports.
orderSchema.index({ restaurant: 1, branch: 1, paymentStatus: 1, createdAt: -1 });

// Webhook / orphan-refund lookups by Razorpay checkout id (decision 4a).
orderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
orderSchema.index({ razorpayOrderIds: 1 }, { sparse: true });

// CRIT-28 — Hard guarantee: only one active dine-in order per table
// within a tenant. Prevents two waiters / two devices from concurrently
// creating orders for the same table (read-then-insert race).
// "Active" = every status EXCEPT 'cancelled'. The partial filter also
// ensures takeaway orders (no table) don't collide on null.
//
// NOTE (deploy): if the cluster currently has duplicate active orders
// for the same table from pre-fix traffic, this index will fail to
// build until duplicates are cleaned up. Run a one-time check:
//   db.orders.aggregate([
//     { $match: { table: { $ne: null }, status: { $ne: 'cancelled' } } },
//     { $group: { _id: { restaurant: '$restaurant', table: '$table' },
//                 count: { $sum: 1 }, ids: { $push: '$_id' } } },
//     { $match: { count: { $gt: 1 } } }
//   ])
// and cancel or merge the older duplicates before the next boot.
// Independent-orders model — multiple active orders are now allowed
// on the same table simultaneously. Each customer "Place Order" tap
// creates a fresh Order document so the chef KDS shows it as its own
// card and the customer tracks it on its own timeline. Bill paying
// aggregates every unpaid order on the table at settle time.
//
// The previous `one_active_order_per_table` unique index forced
// every subsequent order to auto-append into the existing one,
// which is what produced the "all items go to chef as one merged
// card" complaint. Index removed; the unique-active constraint
// is replaced by a non-unique compound index for fast active-order
// queries (we still hit { table, status } a lot in admin views).
orderSchema.index(
    { restaurant: 1, table: 1, status: 1 },
    { name: 'orders_by_table_status' }
);

// Idempotency: per-tenant uniqueness on the client-supplied key. Sparse
// + partial filter so legacy / non-idempotent creates (key=null) don't
// collide.
orderSchema.index(
    { restaurant: 1, clientIdempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { clientIdempotencyKey: { $type: 'string' } },
        name: 'idempotency_per_tenant',
    }
);

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
orderSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Order', orderSchema);
