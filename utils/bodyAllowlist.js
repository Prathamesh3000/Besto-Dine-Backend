/**
 * bodyAllowlist — explicit per-endpoint field allowlists for admin write
 * endpoints, plus the small pure helpers that apply them.
 *
 * Why: several controllers used to spread `req.body` straight onto the
 * document (`{ ...req.body }` / `Object.assign`). That let any caller with
 * the route's role set server-owned fields (counters, computed prices,
 * soft-delete flags, QR tokens, the tenant link, even Mongo update
 * operators such as `$inc`). Each list below is derived from what the
 * admin UI actually sends for that endpoint — anything else is dropped.
 *
 * Everything here is PURE (no DB, no req) so it can be unit-tested.
 */

// PUT /tables/:id — AddTableModal { name, capacity, area, branch } and the
// floor views' { status } / { status, isActive } toggles. Waiter
// assignment goes through PUT /tables/:id/assign (tenant/branch checks,
// request handover, notification); qrToken via POST /:id/qr-token;
// merge state via /merge + /unmerge; activeOrder / currentDiner /
// alerts / soft-delete are server-owned.
const TABLE_UPDATE_FIELDS = Object.freeze([
    'name', 'capacity', 'area', 'branch', 'status', 'isActive',
]);

// POST /menu + PUT /menu/:id — AddMenuItemModal + MenuManagement
// (status toggles / inactivation modal). finalPrice is computed server
// side, orderCount is a server counter, inactivationUntil is derived
// from inactivationDuration/inactivationDateRange (handled separately by
// the controller), branchPrices has its own owner-only endpoint.
const MENU_ITEM_FIELDS = Object.freeze([
    'name', 'category', 'branch', 'description', 'images',
    'cookingTime', 'prepTimeMinutes', 'serveUpto', 'ingredients',
    'vegType', 'isFeatured', 'availableDays', 'startTime', 'endTime',
    'basePrice', 'offerPercentage', 'offerExpiryDate', 'unit',
    'sizes', 'toppings', 'isHealthy', 'healthLevel', 'healthTags',
    'nutritionalInfo', 'healthyIngredients', 'inStock', 'prepStation',
    'status', 'hsnCode',
]);

// POST /categories + PUT /categories/:id — AddCategoryModal
// { name, displayOrder, image, showOnKiosk } and the status toggle.
const CATEGORY_FIELDS = Object.freeze([
    'name', 'displayOrder', 'image', 'status', 'showOnKiosk', 'branch', 'kind', 'hsnCode',
]);

// PUT /branches/:id — Branches.jsx edit form. isActive is NOT here:
// disabling goes through DELETE /:id and reactivation through
// PATCH /:id/reactivate (which enforces the plan's maxBranches).
// syncFromMain is read separately by the controller (not a branch field).
const BRANCH_UPDATE_FIELDS = Object.freeze([
    'name', 'slug', 'displayLabel',
    'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
    'latitude', 'longitude', 'contactPhone', 'contactEmail', 'sortOrder',
]);

// POST /promotions/coupons + PUT /promotions/coupons/:id — Offers.jsx
// toApi() plus the route-validated limits (usageLimit / usagePerUser).
// usageCount is a server counter (bumped on real redemption); targetUsers
// is never set by any UI.
const COUPON_FIELDS = Object.freeze([
    'code', 'title', 'description', 'discountType', 'discountValue',
    'minOrderValue', 'maxDiscountAmount', 'startDate', 'endDate',
    'startTime', 'endTime', 'usageLimit', 'usagePerUser',
    'couponCategory', 'scope', 'isActive', 'branch',
]);

// POST /promotions — mirrors createPromotionRules.
const PROMOTION_FIELDS = Object.freeze([
    'title', 'description', 'image', 'link', 'type', 'targetAudience',
    'startDate', 'endDate', 'isActive', 'displayOrder', 'branch',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Copy only the allowlisted own keys of `body` whose value is not
 * `undefined`. Non-object bodies yield `{}`. Never returns a key that is
 * not in `allowed` (so `$`-operators, `restaurant`, counters etc. are
 * always dropped).
 */
function pickAllowed(body, allowed) {
    const out = {};
    if (!isPlainObject(body)) return out;
    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
            out[key] = body[key];
        }
    }
    return out;
}

/** Own keys of `body` that are NOT in `allowed` (for route-level 400s). */
function disallowedKeys(body, allowed) {
    if (!isPlainObject(body)) return [];
    const set = new Set(allowed);
    return Object.keys(body).filter((k) => !set.has(k));
}

/**
 * Coerce a client-supplied order value to a finite positive number.
 * Returns the number, or `null` when it is missing / non-numeric /
 * non-finite / <= 0.
 */
function toPositiveAmount(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * True when `submitted` would change any permission flag relative to
 * `baseline` (both plain objects of booleans; missing = false). Used to
 * stop non-admin callers from editing permissions while still letting
 * them re-submit the unchanged permissions the edit form always echoes.
 */
function permissionsChanged(baseline, submitted) {
    const a = isPlainObject(baseline) ? baseline : {};
    const b = isPlainObject(submitted) ? submitted : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (Boolean(a[k]) !== Boolean(b[k])) return true;
    }
    return false;
}

/**
 * Normalise the identity fields of a staff update so an explicit
 * null / blank can't wipe a required value:
 *   - name, email (required on User), role, staffId, permissions:
 *     null or blank string → dropped (keep the stored value)
 *   - mobile (optional on User): null → '' (explicit clear)
 *   - kitchenResponsibility: null → ''
 *   - any remaining `undefined` → dropped
 * Returns a new object; does not mutate the input.
 */
function cleanStaffUpdate(update) {
    const out = { ...(isPlainObject(update) ? update : {}) };
    for (const k of ['name', 'email', 'role', 'staffId', 'permissions']) {
        const v = out[k];
        if (v === null || (typeof v === 'string' && v.trim() === '')) delete out[k];
    }
    if (out.mobile === null) out.mobile = '';
    if (out.kitchenResponsibility === null) out.kitchenResponsibility = '';
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

// Staff roles a non-admin caller (a Manager with manageStaff) may create,
// edit, or assign. 'manager' passes adminOnly on many routes and 'admin'
// bypasses checkPermission, so both are reserved for role:'admin' callers
// (creating an 'admin' is additionally tenant-owner only).
const FLOOR_STAFF_ROLES = Object.freeze(['waiter', 'chef', 'captain']);

/**
 * May a caller with `callerRole` create / edit / assign a staff row whose
 * role is `targetRole`? Admins may manage any role (owner-only rules for
 * 'admin' are enforced separately); everyone else only floor roles.
 * An absent targetRole (role not being set) is allowed.
 */
function canManageStaffRole(callerRole, targetRole) {
    if (targetRole === undefined || targetRole === null || targetRole === '') return true;
    if (callerRole === 'admin') return true;
    return FLOOR_STAFF_ROLES.includes(targetRole);
}

// 403 body returned when a non-admin caller touches a Manager / Admin role.
const ROLE_ADMIN_ONLY_BODY = Object.freeze({
    success: false,
    code: 'ROLE_ADMIN_ONLY',
    message: 'Only an Admin can create or manage Manager accounts. Managers can manage waiters, chefs and captains.',
});

/**
 * Gate for acting on / assigning a staff role (create, edit, status
 * toggle, delete, password reset). Returns null when allowed, else an
 * Express response descriptor `{ status: 403, body }`.
 */
function staffRoleGate(callerRole, targetRole) {
    if (canManageStaffRole(callerRole, targetRole)) return null;
    return { status: 403, body: { ...ROLE_ADMIN_ONLY_BODY } };
}

module.exports = {
    FLOOR_STAFF_ROLES,
    canManageStaffRole,
    staffRoleGate,
    ROLE_ADMIN_ONLY_BODY,
    TABLE_UPDATE_FIELDS,
    MENU_ITEM_FIELDS,
    CATEGORY_FIELDS,
    BRANCH_UPDATE_FIELDS,
    COUPON_FIELDS,
    PROMOTION_FIELDS,
    pickAllowed,
    disallowedKeys,
    toPositiveAmount,
    permissionsChanged,
    cleanStaffUpdate,
};
