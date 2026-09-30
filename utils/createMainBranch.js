const Branch = require('../models/branch');

/**
 * createMainBranchFor — auto-provisions a tenant's "Main" branch.
 *
 * Background: every tenant in the system needs at least one Branch
 * document so the customer-facing branch picker, branch-scoped data
 * model, and Sub Admin isolation all work uniformly. Historically,
 * tenants were created with zero branches and the first sub-branch
 * the owner added would silently inherit all legacy `branch=null`
 * data via migrations/migrateLegacyBranchNulls.js — confusing, because
 * the new sub-branch would suddenly own data that conceptually
 * belonged to the original location.
 *
 * Calling this immediately after `Restaurant.create(...)` creates
 * a "Main" branch that represents the original/HQ location:
 *   - name = `<TenantName>` — the tenant IS the Main location, so
 *     no "(Main)" suffix; the slug='main' marker is what the system
 *     uses to identify it. Sub-branches added later are typically
 *     named with a location suffix (e.g. "The Cup – Pune") so the
 *     customer picker shows a clear hierarchy by name alone.
 *   - slug = 'main' — clean URL, unique per tenant (compound index)
 *   - sortOrder = -1 — top of the customer-facing picker
 *   - contact details copied from the tenant for sensible defaults
 *
 * The tenant owner remains unpinned (`branch: null`) so they can
 * manage every branch, including Main. Sub-branches added later
 * via the regular branch CRUD endpoint sit as siblings of Main.
 *
 * Idempotent: returns the existing Main branch if one already
 * exists for the tenant, so the helper is safe to call from
 * backfill scripts as well.
 */
// Safely clamp a string to a Branch schema field's maxlength.
// Tenants in the wild have looser limits than Branch (e.g. legacy
// Restaurant.city is uncapped while Branch.city caps at 80) so a
// blind copy can throw ValidationError. Truncate instead of erroring
// — losing a few trailing characters on the auto-Main is far better
// than the tenant having no Main branch at all.
function clamp(value, max) {
    const s = String(value ?? '').trim();
    return s.length > max ? s.slice(0, max) : s;
}

async function createMainBranchFor(restaurant, createdBy = null) {
    const existing = await Branch.findOne({
        restaurant: restaurant._id,
        slug: 'main',
    });
    if (existing) return existing;

    const addr = restaurant.address || {};
    const branch = await Branch.create({
        restaurant: restaurant._id,
        name:         clamp(restaurant.name, 80),
        slug:         'main',
        sortOrder:    -1,
        isActive:     true,
        addressLine1: clamp(addr.line1, 200),
        addressLine2: clamp(addr.line2, 200),
        city:         clamp(restaurant.city, 80),
        state:        clamp(addr.state, 80),
        postalCode:   clamp(addr.pincode, 20),
        country:      clamp(addr.country || 'India', 80),
        contactPhone: clamp(restaurant.contactPhone, 30),
        contactEmail: clamp(restaurant.contactEmail, 120).toLowerCase(),
        createdBy:    createdBy || undefined,
    });
    return branch;
}

module.exports = { createMainBranchFor };
