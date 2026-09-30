const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch link — 2026-05-19. null = tenant-level (legacy/seeded
    // shared); ObjectId = owned by that branch. Branch-pinned admins
    // see ONLY their branch's packages via the strict filter.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  name: { type: String, required: true },
  // High-level package category surfaced in AddPackageModal as the
  // "Package type" dropdown (Wedding / Birthday / Corporate). Stored
  // lowercase to match the modal's setField call. Open string (no
  // enum) so the bulk-import CSV can ship additional categories
  // (anniversary, festival, etc.) for tenants who want them without
  // requiring a schema migration.
  type: { type: String, default: '' },
  price: { type: Number, required: true },
  description: String,
  items: [String], // Legacy, keeping for compatibility
  
  // UI Specific Categorized Items
  starters: [{ name: String }],
  mainCourse: [{ name: String }],
  drinks: [{ name: String }],
  features: [String], // Package specific features like 'Free Wifi', 'Stage Included'

  image: String,
  category: { type: String, enum: ['All', 'Classic', 'Royal', 'Gold', 'Elite'], default: 'All' },
  badge: { type: String, default: 'Silver' },
  badgeColor: { type: String, default: 'bg-gray-100 text-gray-600' },
  minPeople: { type: Number, default: 0 },
  maxPeople: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
packageSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Package', packageSchema);
