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
    // Stamped when staff free the table (utils/tableSessions.endTableSessions).
    // A scan token issued before this moment is rejected by
    // middlewares/tableSessionGuard (401 TABLE_SESSION_ENDED), which signs
    // out the diners who were seated here.
    sessionEpoch: { type: Date, default: null },
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
    // Who held this table, newest last, capped at the last 20 (written by
    // PUT /tables/:id/assign, read by GET /tables/:id/assignments).
    // `reason` carries a workload-limit override reason. select:false so
    // the floor listings stay light.
    assignmentHistory: {
        type: [{
            waiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            waiterName: { type: String, default: '' },
            assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            assignedByName: { type: String, default: '' },
            at: { type: Date, default: Date.now },
            reason: { type: String, default: '' },
            cleared: { type: Boolean, default: false },
        }],
        default: [],
        select: false,
    },
    // QA #13 — seat reservations. One entry per diner PARTY currently
    // seated (a phone that scanned the QR, optionally logged in). A seat
    // is claimed atomically at scan time (utils/tableSeats.claimSeat) so
    // a table can never hold more parties than its capacity — even when
    // several phones scan / order at the same instant. `keys` are the
    // party's identities ('s:<scanSessionId>', 'u:<userId>').
    // For a merge group, seats live on the group LEADER only and are
    // counted against the group's summed capacity.
    // Released when the table is freed / unmerged / disabled / deleted;
    // idle seats without an open order are pruned after
    // TABLE_SEAT_IDLE_MINUTES. select:false — keys are session ids and
    // must never reach a customer response; staff listings expose only
    // the count (`seatsTaken`).
    seats: {
        type: [{
            keys: { type: [String], default: [] },
            joinedAt: { type: Date, default: Date.now },
            lastSeenAt: { type: Date, default: Date.now },
        }],
        default: [],
        select: false,
    },
    mergedWith: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table'
    }],
    // A sub-document field literally named `type` must be spelled
    // `type: { type: String }` — a bare `type: String` makes Mongoose
    // read the whole element as the String type ([String]) and every
    // alert object pushed here fails to cast.
    alerts: [{
        reason: String,
        type: { type: String },
        requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request' },
        delay: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, {
    timestamps: true,
    // Never serialise seat identities — replace them with a count.
    toJSON: {
        transform(doc, ret) {
            if (Array.isArray(ret.seats)) {
                ret.seatsTaken = ret.seats.length;
                delete ret.seats;
            }
            return ret;
        },
    },
});

// Ensure table name is unique within an area — among LIVE tables only,
// so a soft-deleted table's name can be reused. Explicit name: the old
// full-collection unique index `name_1_area_1` must be dropped on
// existing databases (Mongoose never drops indexes by itself).
tableSchema.index(
    { name: 1, area: 1 },
    { unique: true, name: 'name_area_unique_live', partialFilterExpression: { isDeleted: false } },
);
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
