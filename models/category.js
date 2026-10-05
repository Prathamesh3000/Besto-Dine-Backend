const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
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
    // category (shared across all branches — the default). Assigned
    // categories are only visible to customers at that specific
    // branch. Non-breaking: every existing category stays tenant-
    // level until explicitly moved.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // Phase 1 SaaS: category names are unique PER TENANT. The compound
    // index at the bottom replaces the old global `unique: true` on name.
    name: {
        type: String,
        required: [true, 'Please add a category name'],
        trim: true
    },
    displayOrder: {
        type: Number,
        default: 0,
        index: true
    },
    image: {
        type: String,
        default: '/uploads/Thumbnil.png'
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
        index: true
    },
    // Kiosk visibility toggle. When false, the category (and its items)
    // are hidden from the self-serve kiosk flow but stay visible to
    // dine-in / takeaway / admin. Default true so existing categories
    // keep showing on kiosks after the migration.
    showOnKiosk: {
        type: Boolean,
        default: true,
        index: true,
    },
    // Decision 6 (2026-10): the admin decides whether a category is Food
    // or Drink. Values match Coupon.scope ('food' / 'beverages') so a
    // scoped coupon classifies order items by their category's kind
    // (utils/couponScope.classifyItem reads the item.categoryKind
    // snapshot). Legacy categories default to food.
    kind: {
        type: String,
        enum: { values: ['food', 'beverages'], message: 'Category type must be food or beverages' },
        default: 'food',
    },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for item count (this would be populated from MenuItem model)
categorySchema.virtual('itemCount', {
    ref: 'MenuItem',
    localField: '_id',
    foreignField: 'category',
    count: true
});

// Per-tenant + per-branch uniqueness on name. Branch A and Branch B can
// both have a "Beverages" category — each branch owns its own copy after
// "Copy from Main" runs at branch-create time. branch:null is the
// tenant-level / legacy shared slot.
// Phase 6 final: this index replaces the older { name, restaurant }-only
// uniqueness so per-branch clones don't collide. Existing tenants need
// `node Seed/migrateCategoryIndex.js` to drop the old index in MongoDB.
categorySchema.index({ name: 1, restaurant: 1, branch: 1 }, { unique: true });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
categorySchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Category', categorySchema);
