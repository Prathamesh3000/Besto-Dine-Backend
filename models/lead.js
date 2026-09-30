const mongoose = require('mongoose');

/**
 * Lead — a prospect captured by the standalone marketing site
 * (the "BestoDine-Marketing" project) via POST /api/v1/public/lead.
 *
 * Leads are intentionally GLOBAL / tenant-agnostic: a prospect has not
 * picked or been assigned a tenant yet, so there is NO `restaurant` field
 * here. The lead is reviewed in the Super Admin "Leads" tab and, once the
 * deal closes, converted into a real Restaurant (the `convertedToRestaurant`
 * link records that). Because this model carries no tenant scope it is
 * exempt from the tenant-isolation audit — see scripts/audit-tenant-scope.js.
 */
const leadSchema = new mongoose.Schema({
    name:           { type: String, required: true, trim: true, maxlength: 100 },
    restaurantName: { type: String, required: true, trim: true, maxlength: 100 },
    phone:          { type: String, required: true, trim: true, maxlength: 20 },
    email:          { type: String, trim: true, lowercase: true, maxlength: 120 },
    message:        { type: String, trim: true, maxlength: 500 },

    // Which form / page produced the lead (marketing-home-hero, marketing-pricing, …).
    source:         { type: String, default: 'unknown', trim: true, maxlength: 60 },
    // Free-form extra context the wizard collects (approx table count, plan interest, …).
    meta:           { type: mongoose.Schema.Types.Mixed },

    status: {
        type: String,
        enum: ['new', 'contacted', 'demoed', 'converted', 'lost'],
        default: 'new',
        index: true,
    },
    notes: [{
        text:      { type: String, required: true, trim: true, maxlength: 1000 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
    }],

    convertedToRestaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' },
    convertedAt:           Date,

    // Lightweight abuse/forensics context — captured server-side, never
    // from the client body.
    ip:        { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 400 },
}, { timestamps: true });

leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ phone: 1 });

module.exports = mongoose.model('Lead', leadSchema);
