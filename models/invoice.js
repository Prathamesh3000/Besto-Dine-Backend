const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
  // Phase 1 SaaS: invoice numbers are unique PER TENANT (each restaurant
  // generates INV-001, INV-002, …). The compound index at the bottom of
  // this file replaces the old global `unique: true` on invoiceNumber.
  invoiceNumber: {
    type: String,
    required: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  customerName: String,
  customerEmail: String,
  customerMobile: String,
  items: [{
    name: String,
    quantity: Number,
    price: Number,
    total: Number,
    image: String,
    description: String,
    addons: [{
      name: String,
      price: Number
    }]
  }],
  subtotal: {
    type: Number,
    required: true,
    min: [0, 'Subtotal cannot be negative']
  },
  tax: {
    type: Number,
    default: 0,
    min: [0, 'Tax cannot be negative']
  },
  discount: {
    type: Number,
    default: 0,
    min: [0, 'Discount cannot be negative']
  },
  total: {
    type: Number,
    required: true,
    min: [0, 'Total cannot be negative']
  },
  paymentStatus: {
    type: String,
    enum: ['paid', 'unpaid', 'partially_paid'],
    default: 'unpaid'
  },
  paymentMethod: String,
  issuedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Per-tenant uniqueness on invoiceNumber. `Seed/dropLegacyIndexes.js`
// drops the old `invoiceNumber_1` global index.
invoiceSchema.index({ invoiceNumber: 1, restaurant: 1 }, { unique: true });
// Prevent duplicate invoices for the same order per tenant
invoiceSchema.index({ order: 1, restaurant: 1 }, { unique: true });
// Customer invoice history
invoiceSchema.index({ customer: 1, restaurant: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
invoiceSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Invoice', invoiceSchema);
