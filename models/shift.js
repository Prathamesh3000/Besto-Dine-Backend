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
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
shiftSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Shift', shiftSchema);
