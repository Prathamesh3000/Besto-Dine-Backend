const mongoose = require('mongoose');

const areaSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch-scoping: a Sub Admin pinned to a branch owns areas they
    // create. null = tenant-level (default for pre-migration data and
    // for the tenant owner). Per product rule, sub-branches see only
    // their own areas — enforcement lives in areaController via
    // strictBranchFilter.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // Area names are unique per tenant+branch — Branch A and Branch B
    // can both have an "Indoor" area.
    name: {
        type: String,
        required: [true, 'Area name is required'],
        trim: true
    },
    note: {
        type: String,
        trim: true
    },
    // Customer-facing description of the seating option (QA N12) —
    // shown on the booking review step. Optional; the review falls back
    // to a generated description when empty.
    description: {
        type: String,
        trim: true,
        maxlength: [300, 'Description cannot exceed 300 characters'],
        default: ''
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Uniqueness on (name, restaurant, branch). The per-tenant index
// (`name_1_restaurant_1`) is superseded by this one — run
// `db.areas.dropIndex('name_1_restaurant_1')` once against existing
// environments so the new index takes over.
areaSchema.index({ name: 1, restaurant: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
areaSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Area', areaSchema);
