const mongoose = require('mongoose');

const hallSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 step 7 — multi-branch scoping. A hall belongs to exactly
    // one physical branch (banquet hall at "Durga 1" is a different
    // space from the one at "Durga 2"). null = tenant-level / legacy
    // hall shared across branches. Branch-pinned Sub Admins see only
    // their own branch's halls; tenant owners see everything.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  name: {
    type: String,
    required: [true, 'Hall name is required'],
    trim: true
  },
  type: {
    type: String,
    required: [true, 'Hall type is required'],
    enum: ['Banquet Hall', 'Auditorium', 'Conference Room', 'Outdoor Space']
  },
  description: {
    type: String,
    trim: true
  },
  
  // Capacity
  minCapacity: Number,
  maxCapacity: {
    type: Number,
    required: [true, 'Maximum capacity is required']
  },
  optimalCapacity: Number,
  
  // Pricing
  basePrice: {
    type: Number,
    required: [true, 'Base price is required']
  },
  hourlyRate: Number,
  cleaningCharges: Number,
  securityDeposit: Number,
  
  // Location
  floorLevel: String,
  buildingWing: String,
  
  // Amenities & UI Fields
  amenities: {
    soundSystem: { type: Boolean, default: false },
    projector: { type: Boolean, default: false },
    wifi: { type: Boolean, default: false },
    ledScreen: { type: Boolean, default: false },
    airConditioning: { type: Boolean, default: false },
    elevator: { type: Boolean, default: false },
    powerBackup: { type: Boolean, default: false },
    parking: { type: Boolean, default: false },
    kitchen: { type: Boolean, default: false }
  },
  features: [String],
  audioVisual: [String],
  policies: [String],
  bestFor: [String],
  badges: [String], // ['Active', 'Featured', 'AC Indoor']
  contact: {
    name: String,
    phone: String,
    email: String
  },
  
  // Media
  images: [String],
  
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
hallSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Hall', hallSchema);
