const mongoose = require('mongoose');

const cakeSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
  flavor: { type: String, required: true },
  subtitle: String,
  pricePerKg: { type: Number, required: true },
  image: String,
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
cakeSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Cake', cakeSchema);
