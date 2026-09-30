const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 step 2: optional branch link. null = unassigned / tenant-
    // level (the default for single-location tenants and for every
    // existing table created before this migration). Tenants on a
    // plan with `multiBranch` can assign tables to specific branches;
    // non-branch tenants leave this null and everything works like
    // before. Validation that the branch belongs to the same tenant
    // happens in the controller (we can't express cross-collection
    // constraints in Mongoose without a hook).
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    name: {
        type: String,
        required: [true, 'Table name/number is required'],
        trim: true
    },
    // Soft-delete marker. Tables were previously hard-deleted with
    // findOneAndDelete, which left every order, reservation and
    // customer localStorage session pointing at a document that no
    // longer existed — and the order-create path silently swallowed
    // the missing lookup, so orders kept being accepted against a
    // deleted table. Soft-deleting keeps referential integrity and
    // lets historical bills still resolve their table name.
    isDeleted: {
        type: Boolean,
        default: false,
        index: true,
    },
    deletedAt: { type: Date, default: null },

    capacity: {
        type: Number,
        required: [true, 'Capacity is required'],
        min: [1, 'Capacity must be at least 1']
    },
    area: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Area',
        required: [true, 'Area is required']
    },
    status: {
        type: String,
        enum: ['free', 'occupied', 'reserved', 'merged', 'alert', 'disabled'],
        default: 'free'
    },
    qrToken: {
        type: String,
        unique: true,
        required: true,
        select: false,
    },
    isActive: {
        type: Boolean,
        default: true
    },
    activeOrder: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    },
    // Snapshot of who is currently sitting at this table. Populated when
    // a logged-in customer claims the table after QR scan (POST /tables/
    // :id/claim) and when an order with a `user` link is created. Cleared
    // by freeTableOrUnmergeGroup. Lets the admin drawer render the actual
    // diner name instead of "Walk-in Guest" before any items are added.
    currentDiner: {
        user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        name:         { type: String, default: '' },
        phone:        { type: String, default: '' },
        isRegistered: { type: Boolean, default: false },
        claimedAt:    { type: Date,   default: null },
    },
    assignedWaiter: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    mergedWith: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table'
    }],
    alerts: [{
        reason: String,
        type: String,
        requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request' },
        delay: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, {
    timestamps: true
});

// Ensure table name is unique within an area
tableSchema.index({ name: 1, area: 1 }, { unique: true });
// Performance indexes for dashboard queries
tableSchema.index({ status: 1 });
tableSchema.index({ area: 1, status: 1 });
tableSchema.index({ assignedWaiter: 1 });
// Note: qrToken already has a unique index created automatically by
// `unique: true` on the field declaration above. Do NOT add an explicit
// `schema.index({ qrToken: 1 }, { unique: true })` here — Mongoose
// would warn about a duplicate index.

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
tableSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Table', tableSchema);
