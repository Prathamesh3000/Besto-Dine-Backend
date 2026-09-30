const mongoose = require('mongoose');

/**
 * Branch — a physical location within a single tenant.
 *
 * Phase 6 step 1. Foundation only: this commit just adds the model
 * and the CRUD endpoints so a chain can manage their locations.
 * Subsequent steps will start scoping other entities (tables, menu,
 * orders) to a branch via a `branch` field on each. Until then,
 * branches have no children and existing data is unaffected.
 *
 * Access model:
 *   - Branches are TENANT-SCOPED. A tenant's admin can CRUD their
 *     own branches but never another tenant's.
 *   - Branch CRUD is behind the `multiBranch` feature gate, which is
 *     already in the feature flag set from Phase 2.5. Tenants on a
 *     plan without multiBranch get FEATURE_LOCKED 403 and the UI
 *     falls back to the existing single-location flow.
 *   - Every tenant implicitly has ONE branch-equivalent today: the
 *     tenant itself. When multiBranch activates, the tenant admin
 *     creates at least one named branch and existing data migrates
 *     to it (handled in step 2+, not this commit).
 *
 * Slug uniqueness is compound on (restaurant, slug) so two tenants
 * can both have a branch called "main" without colliding.
 */
const branchSchema = new mongoose.Schema({
    // Tenant link — required (Phase 3 step 4 baseline).
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },

    name: {
        type: String,
        required: [true, 'Branch name is required'],
        trim: true,
        maxlength: 80,
    },

    // Optional short label used in the admin card title and customer
    // picker, e.g. "Wakad Road" or "FC Road". Lets the admin keep the
    // legal `name` set to the full identity ("Hotel Tip Top") while
    // surfacing a compact location hint in lists. When empty, callers
    // fall back to addressLine1, then city.
    displayLabel: {
        type: String,
        default: '',
        trim: true,
        maxlength: 60,
    },

    // URL-safe identifier unique within the tenant (not globally).
    // Used in future per-branch QR codes / deep links.
    slug: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        maxlength: 60,
    },

    // Human-readable address fields. Kept flat rather than nested
    // so they're easy to render in a single card without a loader.
    addressLine1: { type: String, default: '', trim: true, maxlength: 200 },
    addressLine2: { type: String, default: '', trim: true, maxlength: 200 },
    city:         { type: String, default: '', trim: true, maxlength: 80 },
    state:        { type: String, default: '', trim: true, maxlength: 80 },
    postalCode:   { type: String, default: '', trim: true, maxlength: 20 },
    country:      { type: String, default: 'India', trim: true, maxlength: 80 },

    // Map coordinates of this branch. Used as the origin for home-delivery
    // distance; null falls back to Settings.delivery.origin (tenant-level).
    latitude:     { type: Number, default: null, min: -90, max: 90 },
    longitude:    { type: Number, default: null, min: -180, max: 180 },

    // Contact info for THIS branch — may differ from the tenant's
    // primary contact (e.g. each location has its own manager).
    contactPhone: { type: String, default: '', trim: true, maxlength: 30 },
    contactEmail: { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },

    // Soft-disable. We never hard-delete a branch that has historical
    // data (orders, invoices) — instead we mark it inactive so the
    // UI hides it from dropdowns but references don't break.
    isActive: { type: Boolean, default: true, index: true },

    // Optional display ordering for the admin UI / customer picker.
    sortOrder: { type: Number, default: 0 },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
}, { timestamps: true });

// ─── Indexes ─────────────────────────────────────────────────────────
// Compound unique: within a tenant, the slug must be unique so
// /api/public/branches/:tenant/:slug remains unambiguous. Two
// different tenants can both use "main" or "downtown".
branchSchema.index({ restaurant: 1, slug: 1 }, { unique: true });

// Sort branches for the admin list — most recently active first
// within each tenant.
branchSchema.index({ restaurant: 1, isActive: -1, sortOrder: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
branchSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Branch', branchSchema);
