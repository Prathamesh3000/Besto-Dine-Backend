const mongoose = require('mongoose');

const addonSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch link — 2026-05-19. null = tenant-level / legacy shared.
    // Branch-pinned admins only see their branch's addons. Sharing
    // happens at branch-create via "Copy from Main".
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  title: { type: String, required: true },
  // Per-tenant + per-branch uniqueness on slug. Compound index at the
  // bottom now includes `branch` so two branches can each own a
  // "balloon-arch" addon without colliding.
  slug: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  icon: String,
  options: [String],
  category: String,
  detailConfig: { type: mongoose.Schema.Types.Mixed, default: null },
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  isPopular: { type: Boolean, default: false }
}, { timestamps: true });

// Per-tenant + per-branch uniqueness on slug. The legacy
// `{ slug, restaurant }` unique index is migrated via
// `Seed/migrateAddonIndex.js` for existing DBs; fresh DBs pick up the
// new index on first connect.
addonSchema.index({ slug: 1, restaurant: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
addonSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Addon', addonSchema);
