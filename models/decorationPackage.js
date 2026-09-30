const mongoose = require('mongoose');

const decorationPackageSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch link — 2026-05-19. null = tenant-level (legacy/seeded);
    // ObjectId = owned by that branch. Branch-pinned admins see ONLY
    // their branch's decorations via the strict filter in
    // decorationPackageController + bookingInfoController.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // Basic Info
    name: { type: String, required: true },
    category: { type: String, required: true },
    description: String,
    themeStyle: String,
    primaryColor: String,
    secondaryColor: String,
    accentColor: String,
    suitableFor: {
        Indoor: { type: Boolean, default: false },
        Outdoor: { type: Boolean, default: false },
        Hall: { type: Boolean, default: false },
        Banquet: { type: Boolean, default: false },
        Garden: { type: Boolean, default: false },
        Terrace: { type: Boolean, default: false },
        Beach: { type: Boolean, default: false },
        Restaurant: { type: Boolean, default: false }
    },
    minArea: Number,
    maxArea: Number,
    ceilingHeight: Number,
    searchTags: [String],
    isFeatured: { type: Boolean, default: false },
    isPopular: { type: Boolean, default: false },

    // UI-card fields used by Admin → Bookings → Decorations grid.
    // Kept on the schema so the seeded values persist (Mongoose strict
    // mode would drop them otherwise) and the card's Tag pill + Team
    // size text render correctly without UI hacks.
    tag:       { type: String, default: 'Standard' },
    tagColor:  { type: String, default: 'bg-blue-100 text-blue-600' },
    teamSize:  { type: String, default: '2 - 3 Team' },

    // Items & Materials
    categories: [{
        name: String,
        items: [{
            name: String,
            quantity: Number,
            unit: String
        }]
    }],
    materialsUsed: [String],

    // Setup Details
    setupTime: String,
    advanceBookingDays: Number,
    waterRequired: { type: Boolean, default: false },
    technicalSupport: { type: Boolean, default: false },
    onSiteSupervision: { type: Boolean, default: false },
    numberOfCaretakers: Number,

    // Pricing
    basePrice: { type: Number, required: true },
    dismantlingCharges: { type: Number, default: 0 },
    setupCharges: { type: Number, default: 0 },
    transportCharges: { type: Number, default: 0 },
    isCustomizable: { type: Boolean, default: false },

    // Add-ons & Restrictions
    addons: [{
        name: String,
        description: String,
        basePrice: Number,
        hasFullEventPrice: Boolean,
        fullEventPrice: Number,
        extraHours: [String],
        extraHoursChargesApply: Boolean,
        count: String,
        deliverables: [String]
    }],
    allowCustomization: { type: Boolean, default: false },
    additionalChargesPercent: Number,
    restrictions: {
        indoorOnly: { type: Boolean, default: false },
        outdoorOnly: { type: Boolean, default: false },
        weatherDependent: { type: Boolean, default: false },
        fireHazard: { type: Boolean, default: false },
        specialPermission: { type: Boolean, default: false },
        notSuitableForKids: { type: Boolean, default: false }
    },
    bestFor: [String],
    notRecommendedFor: [String],
    simultaneousBookings: Number,
    seasonalAvailability: {
        spring: { type: Boolean, default: true },
        summer: { type: Boolean, default: true },
        fall: { type: Boolean, default: true },
        winter: { type: Boolean, default: true }
    },
    clientNotes: String,
    isActive: { type: Boolean, default: true },

    // Media & Vendor
    images: [String],
    vendorName: String,
    vendorEmail: String,
    vendorPhone: String,
    vendorRating: Number
}, { timestamps: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
decorationPackageSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('DecorationPackage', decorationPackageSchema);
