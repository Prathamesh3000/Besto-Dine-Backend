const mongoose = require('mongoose');

const sizeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: String },  // e.g. "250", "500", "1"
});

const toppingSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    type: { type: String, enum: ['veg', 'non-veg'], default: 'veg' }
});

const nutritionalInfoSchema = new mongoose.Schema({
    calories: { type: Number, default: 0, min: [0, 'Value cannot be negative'] },
    protein: { type: Number, default: 0, min: [0, 'Value cannot be negative'] },
    fat: { type: Number, default: 0, min: [0, 'Value cannot be negative'] },
    carbs: { type: Number, default: 0, min: [0, 'Value cannot be negative'] },
    fibre: { type: Number, default: 0, min: [0, 'Value cannot be negative'] },
    iron: { type: Number, default: 0, min: [0, 'Value cannot be negative'] }
});

const menuItemSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 step 3: optional branch link. null = tenant-level
    // item (shared across every branch — the default for single-
    // location tenants and for every menu item created before this
    // migration). When a tenant with multiBranch assigns an item to
    // a specific branch, only that branch's customers see it.
    // Branch validation that the id belongs to the same tenant
    // happens in the controller.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    name: {
        type: String,
        required: [true, 'Please provide item name'],
        trim: true
    },
    category: {
        type: mongoose.Schema.ObjectId,
        ref: 'Category',
        required: [true, 'Please select a category'],
        index: true
    },
    description: {
        type: String,
        required: [true, 'Please provide description']
    },
    images: [{ type: String }],
    cookingTime: { type: String },
    // Estimated kitchen prep time in minutes. Drives the takeaway chef
    // queue: an order's "start prep" moment = pickupTime − Σ(item.prep ×
    // qty), so the chef sees "Prepare Now" exactly when cooking should
    // begin to deliver fresh food at pickup. Default 15 keeps the math
    // sane for items the admin hasn't tuned yet.
    prepTimeMinutes: {
        type: Number,
        default: 15,
        min: [0, 'Prep time cannot be negative'],
        max: [240, 'Prep time cannot exceed 240 minutes'],
    },
    serveUpto: { type: String },
    ingredients: [{ type: String }],
    vegType: {
        type: String,
        enum: ['veg', 'non-veg'],
        default: 'veg'
    },
    isFeatured: {
        type: Boolean,
        default: false
    },
    availableDays: [{
        type: String,
        enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    }],
    startTime: { type: String },
    endTime: { type: String },
    basePrice: {
        type: Number,
        required: [true, 'Please provide base price'],
        min: [0, 'Base price cannot be negative']
    },
    offerPercentage: {
        type: Number,
        default: 0,
        min: [0, 'Offer percentage cannot be negative'],
        max: [100, 'Offer percentage cannot exceed 100%']
    },
    finalPrice: {
        type: Number
    },
    offerExpiryDate: { type: Date },
    // Phase C — per-branch price overrides. When a customer orders from
    // a specific branch, the system checks branchPrices first. If an
    // entry exists for that branch, its basePrice/offerPercentage are
    // used instead of the top-level values. This allows area-wise pricing
    // (e.g. premium locations charge more, IT parks charge less).
    branchPrices: [{
        _id: false,
        branch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Branch',
            required: true,
        },
        basePrice:       { type: Number, required: true, min: 0 },
        offerPercentage: { type: Number, default: 0, min: 0, max: 100 },
        finalPrice:      { type: Number },
        offerExpiryDate: { type: Date },
    }],
    unit: {
        type: String,
        enum: ['pieces', 'plate', 'bowl', 'glass', 'bottle', 'kg', 'gm', 'liter', 'ml', 'serving', 'slice', 'cup', 'portion'],
        default: 'pieces'
    },
    sizes: [sizeSchema],
    toppings: [toppingSchema],
    isHealthy: {
        type: Boolean,
        default: false
    },
    healthLevel: { type: String },
    healthTags: [{ type: String }],
    nutritionalInfo: nutritionalInfoSchema,
    healthyIngredients: [{ type: String }],
    inStock: {
        type: Boolean,
        default: true,
        index: true
    },
    // Where this item is prepared. Drives the kitchen-bypass flow:
    // 'counter' items (water, packaged ice cream, bottled drinks) are
    // ready-to-serve and skip the chef workflow — orders containing
    // ONLY counter items are saved as `status: 'ready'` and never
    // appear on the chef KDS. 'kitchen' items are the default and run
    // the normal new → preparing → ready → served flow. 'bar' is
    // reserved for a future bartender dashboard; until that ships it
    // behaves like 'kitchen'. Existing items default to 'kitchen' so
    // pre-migration data is unaffected.
    prepStation: {
        type: String,
        enum: ['kitchen', 'bar', 'counter'],
        default: 'kitchen',
        index: true,
    },
    status: {
        type: String,
        enum: ['active', 'draft', 'archived'],
        default: 'active',
        index: true
    },
    // ADM-036 — temporary inactivation. When an admin inactivates an item
    // with a duration, we stamp inactivationUntil so the auto-restore
    // scheduler can flip the item back to 'active' once the window ends.
    // `null` means permanent (must be reactivated manually). Cleared
    // whenever the item is reactivated. The reason is kept for the
    // audit trail and so the UI can render "Hidden — sold out (until 12 May)".
    inactivationUntil: {
        type: Date,
        default: null,
        index: true,
    },
    inactivationReason: {
        type: String,
        default: '',
    },
    // Running tally of how many units of this item have ever been
    // ordered. Incremented on every order-create / order-append by
    // orderController.bumpMenuItemOrderCounts (qty-weighted, not order-
    // count). Used as the default sort for the menu list so bestsellers
    // bubble to the top. Indexed descending for a single-column sort
    // path on the common query.
    orderCount: {
        type: Number,
        default: 0,
        index: true,
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Calculate final price before saving — both the top-level default
// price and every branch-specific override in branchPrices[].
// A basePrice of 0 is a legitimate free item and must recompute too
// (finalPrice 0), so the guard is "is a number", not truthiness. Results
// are rounded to paise so 12.5% off ₹99 doesn't store 86.625.
const offerPrice = (base, pct) => Math.round((base - (base * ((Number(pct) || 0) / 100))) * 100) / 100;
menuItemSchema.pre('save', function () {
    if (typeof this.basePrice === 'number' && !(this.offerPercentage < 0)) {
        this.finalPrice = offerPrice(this.basePrice, this.offerPercentage);
    }
    if (this.branchPrices?.length) {
        for (const bp of this.branchPrices) {
            if (typeof bp.basePrice === 'number' && !(bp.offerPercentage < 0)) {
                bp.finalPrice = offerPrice(bp.basePrice, bp.offerPercentage);
            }
        }
    }
});

// ─── Performance indexes ──────────────────────────────────────────────────────
// Most common customer query: category + active status
menuItemSchema.index({ category: 1, status: 1 });
// Featured items on home screen
menuItemSchema.index({ status: 1, isFeatured: 1 });
// Veg/non-veg filter combined with status
menuItemSchema.index({ vegType: 1, status: 1 });
// Multi-tenant hot path — bootstrap + /menu list both filter by
// (restaurant, status) and the bootstrap sorts on createdAt desc.
// This compound index lets Mongo serve the customer's first-paint
// query straight from the index without a collection scan.
menuItemSchema.index({ restaurant: 1, status: 1, createdAt: -1 });
// Branch-scoped /menu list for branch-pinned admins + branch-aware
// customer flows. Covers `{ restaurant, branch, status }` filter.
menuItemSchema.index({ restaurant: 1, branch: 1, status: 1 });
// Category drill-down within a tenant — used by future server-side
// category pagination if we move off client-side filtering.
menuItemSchema.index({ restaurant: 1, category: 1, status: 1 });
// Full-text search on name and description (replaces slow $regex)
menuItemSchema.index({ name: 'text', description: 'text' }, { weights: { name: 10, description: 1 } });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
menuItemSchema.plugin(require('../utils/tenantScopePlugin'));

const MenuItem = mongoose.model('MenuItem', menuItemSchema);

module.exports = MenuItem;
