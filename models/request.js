const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
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
  table: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
    required: true
  },
  waiter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  type: {
    type: String,
    enum: ['water', 'waiter', 'bill', 'other'],
    required: true
  },
  items: [{
    label: String, // e.g., 'Normal (x2)', 'Chilled (x1)'
    qty: Number
  }],
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'completed'],
    default: 'pending'
  },
  acceptedAt: Date,
  completedAt: Date
}, { timestamps: true });

// Performance indexes for common queries
requestSchema.index({ status: 1, createdAt: -1 });
requestSchema.index({ waiter: 1, status: 1 });
requestSchema.index({ table: 1 });

// Retention (DATABASE_SCALING_PLAN.md A2-now #1): a handled service
// request (water / waiter / bill call) is not a financial record and has
// no use 90 days after it was raised, so Mongo's TTL monitor deletes it.
// The partial filter keeps `pending` / `accepted` rows forever no matter
// how old — an unanswered call must never vanish on its own. Note the
// TTL counts from `createdAt` (not `completedAt`): a request completed
// late still goes 90 days after it was raised, which is the intent.
// Existing databases: see migrations/README.md "Request TTL index".
const REQUEST_TTL_SECONDS = 90 * 24 * 60 * 60;
requestSchema.index(
  { createdAt: 1 },
  {
    name: 'completed_request_ttl',
    expireAfterSeconds: REQUEST_TTL_SECONDS,
    partialFilterExpression: { status: 'completed' },
  }
);

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
requestSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Request', requestSchema);
