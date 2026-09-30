const mongoose = require('mongoose');

const eventTypeSchema = new mongoose.Schema({
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
    // see ONLY their branch's event types via the strict filter in
    // bookingInfoController. Copy-from-Main at branch-create clones
    // tenant-level + Main event types into the new branch.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  title: { type: String, required: true },
  description: String,
  guests: { type: String, default: '10-200' },
  icon: { type: String, default: 'Cake' },
  color: { type: String, default: 'border-purple-500' },
  iconColor: { type: String, default: 'text-purple-500' },
  services: [String],
  tags: [String],
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
eventTypeSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('EventType', eventTypeSchema);
