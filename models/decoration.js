const mongoose = require('mongoose');

const decorationSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
  title: { type: String, required: true },
  description: String,
  category: { type: String, enum: ['Birthday', 'Wedding', 'Anniversary', 'Custom'], default: 'Birthday' },
  price: { type: Number, required: true },
  image: String,
  tags: [String],
  
  // UI Specific Fields
  tag: { type: String, default: 'Standard' }, // Small badge like 'Classic' or 'Premium'
  tagColor: { type: String, default: 'bg-blue-100 text-blue-600' },
  setupTime: { type: String, default: '2 hours' },
  teamSize: { type: String, default: '2 - 3 Team' },
  featured: { type: Boolean, default: false },

  details: {
    includedItems: [{
      group: String,
      items: [String]
    }],
    materials: [String],
    colors: [{ label: String, hex: String }]
  },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
decorationSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Decoration', decorationSchema);
