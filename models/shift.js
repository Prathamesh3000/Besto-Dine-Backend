const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    staff: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    status: {
        type: String,
        enum: ['active', 'completed', 'missed'],
        default: 'active',
    },
    clockIn: {
        type: Date,
        default: Date.now,
    },
    clockOut: {
        type: Date,
        default: null,
    },
    totalHours: {
        type: Number,
        default: 0,
    },
    note: {
        type: String,
        default: '',
    },
    // Captain handover confirmation (POST /shifts/handover). A snapshot of
    // what was open when the captain confirmed; it does NOT end the shift.
    handover: {
        type: new mongoose.Schema({
            note: { type: String, default: '' },
            cashCounted: { type: Number, default: null },
            cashExpected: { type: Number, default: 0 },
            variance: { type: Number, default: null },     // cashCounted - cashExpected
            openTables: { type: [mongoose.Schema.Types.Mixed], default: [] },
            unpaidBills: { type: [mongoose.Schema.Types.Mixed], default: [] },
            confirmedAt: { type: Date, default: null },
        }, { _id: false }),
        default: undefined,
    },
}, { timestamps: true });

// At most one active shift per staff member per tenant — makes clock-in
// race-safe (concurrent inserts lose with E11000).
shiftSchema.index(
    { restaurant: 1, staff: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } },
);

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
shiftSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Shift', shiftSchema);
