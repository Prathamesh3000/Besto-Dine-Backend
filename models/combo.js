const mongoose = require('mongoose');

// Each item within a category group in the Item Builder (Step 2)
// These are embedded documents (not refs), matching the frontend's local item objects
const comboItemSchema = new mongoose.Schema({
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    name:   { type: String, required: true },
    price:  { type: Number, required: true },
    isVeg:  { type: Boolean, default: true }
});

// Each category group (e.g. "Starter", "Main Course") with its selected items
const comboCategorySchema = new mongoose.Schema({
    name:  { type: String, required: true },
    items: [comboItemSchema]
});

const comboSchema = new mongoose.Schema(
    {
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch link — added 2026-05-19 so combos can be scoped per
    // branch. null = tenant-level (legacy / shared); ObjectId = owned
    // by that branch. Branch-pinned admins see ONLY their branch's
    // combos via the strict filter in comboController. Sharing across
    // branches happens via "Copy combos from Main" at branch-create.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
        // ─── Step 1 : Basic Details ────────────────────────────────────────────────
        name: {
            type: String,
            required: [true, 'Please provide a combo name'],
            trim: true
        },
        serveUpto: {
            type: String,
            enum: ['1-2 person', '2-3 person', '3-4 person', '4-6 person', '6+ person'],
            default: '2-3 person'
        },
        description: {
            type: String,
            required: [true, 'Please provide a description']
        },
        images: {
            type: [String],
            validate: {
                validator: function (arr) { return arr.length <= 5; },
                message: 'Maximum 5 images allowed'
            }
        },
        // "Veg" or "Non-Veg" radio in the form  (frontend stores 'veg' | 'nonveg')
        vegType: {
            type: String,
            enum: ['veg', 'non-veg'],
            default: 'veg'
        },
        // "Mark as Special/Featured Item" checkbox
        isSpecial: {
            type: Boolean,
            default: false
        },

        // ─── Step 2 : Item Builder ─────────────────────────────────────────────────
        // selectedItems in the frontend is: { "Starter": [{id, name, price, isVeg}], ... }
        // Stored as an array of category groups
        categories: [comboCategorySchema],

        // ─── Step 3 : Pricing & Rules ──────────────────────────────────────────────
        price: {
            type: Number,
            required: [true, 'Please provide the combo price']
        },
        originalPrice: {
            type: Number,
            default: 0
        },
        discount: {
            type: Number,
            default: 0,
            min: 0
        },
        discountType: {
            type: String,
            enum: ['Percentage', 'Flat'],
            default: 'Percentage'
        },
        unlimitedQuantity: {
            type: Boolean,
            default: true
        },
        taxApplicable: {
            type: Boolean,
            default: false
        },
        serviceCharge: {
            type: Boolean,
            default: false
        },
        // Savings amount (auto-calculated, stored for convenience)
        savings: {
            type: Number,
            default: 0
        },

        // Availability & Schedule
        availableDays: {
            type: [String],
            enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        },
        startTime: { type: String, default: '' }, // e.g. "11:00"
        endTime:   { type: String, default: '' }, // e.g. "23:00"

        // Health Mode toggle
        isHealthy: {
            type: Boolean,
            default: false
        },

        // ─── Lifecycle ─────────────────────────────────────────────────────────────
        status: {
            type: String,
            enum: ['active', 'draft', 'archived'],
            default: 'active'
        }
    },
    {
        timestamps: true  // adds createdAt + updatedAt automatically
    }
);

// Auto-calculate savings before saving
comboSchema.pre('save', function () {
    if (this.originalPrice && this.price) {
        this.savings = Math.max(0, this.originalPrice - this.price);
    }
});

// ─── Performance indexes ──────────────────────────────────────────────────────
comboSchema.index({ status: 1, createdAt: -1 });
comboSchema.index({ price: 1 });
comboSchema.index({ vegType: 1, status: 1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
comboSchema.plugin(require('../utils/tenantScopePlugin'));

const Combo = mongoose.model('Combo', comboSchema);

module.exports = Combo;
