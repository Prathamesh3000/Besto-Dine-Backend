/**
 * featureGate(featureKey, { minTier }?)
 *
 * Middleware factory that blocks the request unless the active tenant's
 * subscription includes the named feature.
 *
 * Resolution rules live in utils/featureAccess.js (overrides → active
 * paid add-ons → plan snapshot → legacy fallback). Anything that resolves
 * to "off" is blocked with FEATURE_REVOKED (Super Admin switched it off
 * for this tenant) or FEATURE_LOCKED (not in the plan).
 *
 * Tiered keys: `featureGate('revenueAnalytics', { minTier: 'advanced' })`
 * blocks tenants whose tier is below `minTier`; the 403 carries
 * `requiredTier` and `currentTier`.
 *
 * Role-aware messaging (added in Phase 2.5):
 *   - Admin / staff  → "Your current plan does not include X. Upgrade to enable."
 *   - Customer / guest → "This restaurant doesn't offer X."
 *
 * The distinction matters because telling a customer "upgrade your
 * subscription" is confusing — they'd think THEY need to upgrade. The
 * customer copy frames it as a restaurant-side limitation instead.
 *
 * Legacy fallback:
 *   If `req.restaurant === null` (single-tenant deployment, or a legacy
 *   admin/customer that pre-dates the SaaS migration), the gate ALLOWS
 *   the request. This guarantees we never break existing flows when a
 *   route is upgraded with feature gating.
 *
 * Must be mounted AFTER `attachTenant` (which populates `req.restaurant`).
 *
 * Usage:
 *   // Admin route
 *   router.get('/inventory',
 *       protect, adminOnly, attachTenant, featureGate('inventory'),
 *       inventoryController.getAllItems);
 *
 *   // Customer-facing route
 *   router.post('/advance-booking/create',
 *       protect, featureGate('advanceBookingTable'),
 *       advanceBookingController.create);
 */

const { hasFeature, hasTier, featureTier, TIER_RANK } = require('../utils/featureAccess');

// Human-readable labels for the built-in feature keys. Used in the
// customer-facing 403 message so "advanceBookingTable" becomes "advance
// table bookings". Falls back to the raw key for any feature not
// listed here.
const FEATURE_LABELS = {
    dineIn:              'dine-in ordering',
    takeaway:            'takeaway ordering',
    kitchenDisplay:      'kitchen display',
    waiterDashboard:     'waiter dashboard',
    advanceBookingTable: 'advance table bookings',
    advanceBookingHall:  'hall / event bookings',
    walletLoyalty:       'wallet and loyalty points',
    couponPromotions:    'coupons and promotions',
    campaigns:           'marketing campaigns',
    inventory:           'inventory management',
    crm:                 'customer management',
    tipManagement:       'tip management',
    multiBranch:         'multi-branch support',
    staffPerformance:    'staff performance tracking',
    paymentGateway:      'online payments',
    dataExport:          'data export',
    accountingExport:    'accounting (Tally) export',
    aggregatorOrders:    'Zomato / Swiggy orders',
    eInvoice:            'GST e-invoicing',
    webhooks:            'webhook integrations',
    whiteLabelBranding:  'own branding',
    revenueAnalytics:    'revenue analytics',
    kiosk:               'self-order kiosk',
    incentives:          'staff incentives',
};

const TIER_LABELS = { basic: 'Basic', standard: 'Standard', advanced: 'Advanced' };

function labelFor(key) {
    return FEATURE_LABELS[key] || key;
}

function isCustomerRequest(req) {
    // Treat unauthenticated requests (guests) and customer users as
    // customer-facing. Everything else (admin/manager/waiter/captain/
    // chef/superadmin) is staff.
    if (!req.user) return true;
    return req.user.role === 'customer';
}

function lockedResponse(req, res, featureKey, extra = {}) {
    const customerFacing = isCustomerRequest(req);
    const label = labelFor(featureKey);
    if (req.restaurant?.featureOverrides?.[featureKey] === false) {
        return res.status(403).json({
            success: false,
            code: 'FEATURE_REVOKED',
            feature: featureKey,
            message: customerFacing
                ? `This restaurant doesn't currently offer ${label}.`
                : `The "${featureKey}" feature has been disabled for your restaurant. Contact support for details.`,
        });
    }
    const tierText = extra.requiredTier
        ? ` (${TIER_LABELS[extra.requiredTier] || extra.requiredTier} level)`
        : '';
    return res.status(403).json({
        success: false,
        code: 'FEATURE_LOCKED',
        feature: featureKey,
        currentPlan: req.restaurant?.subscription?.planName || 'Unknown',
        ...extra,
        message: customerFacing
            ? `This restaurant doesn't offer ${label}.`
            : `Your current plan does not include "${featureKey}"${tierText}. Upgrade your subscription to enable it.`,
    });
}

const featureGate = (featureKey, opts = {}) => {
    if (!featureKey || typeof featureKey !== 'string') {
        throw new Error('featureGate requires a feature key');
    }
    const minTier = opts.minTier || null;
    if (minTier && !(minTier in TIER_RANK)) {
        throw new Error(`featureGate: unknown tier "${minTier}"`);
    }

    return (req, res, next) => {
        // Legacy / single-tenant — allow.
        if (!req.restaurant) return next();

        if (!minTier) {
            if (hasFeature(req.restaurant, featureKey)) return next();
            return lockedResponse(req, res, featureKey);
        }
        if (hasTier(req.restaurant, featureKey, minTier)) return next();
        return lockedResponse(req, res, featureKey, {
            requiredTier: minTier,
            currentTier: featureTier(req.restaurant, featureKey),
        });
    };
};

/**
 * featureGateAny(...featureKeys)
 *
 * Variant of featureGate that ALLOWS the request if ANY of the listed
 * features is enabled for the active tenant. Use this on routes that
 * serve resources shared across multiple billable features — e.g.
 * `/booking-info/cakes` is needed by both the table-booking and
 * hall-booking flows, so a tenant on a Basic plan with only
 * `advanceBookingTable` should still see cakes.
 *
 * An explicit `false` override on one key does not block the request —
 * another key may still grant access.
 */
const featureGateAny = (...featureKeys) => {
    if (!featureKeys.length || featureKeys.some(k => typeof k !== 'string')) {
        throw new Error('featureGateAny requires at least one feature key string');
    }

    return (req, res, next) => {
        if (!req.restaurant) return next();
        if (featureKeys.some(key => hasFeature(req.restaurant, key))) return next();

        const customerFacing = isCustomerRequest(req);
        const labels = featureKeys.map(labelFor).join(' or ');
        return res.status(403).json({
            success: false,
            code: 'FEATURE_LOCKED',
            feature: featureKeys[0],
            currentPlan: req.restaurant.subscription?.planName || 'Unknown',
            message: customerFacing
                ? `This restaurant doesn't offer ${labels}.`
                : `Your current plan does not include any of: ${featureKeys.join(', ')}. Upgrade your subscription to enable.`,
        });
    };
};

/**
 * staffAppGate — whole-app gate for the role-specific staff apps.
 *
 * The kitchen display (chef) and the waiter / captain app are modules in
 * their own right: a restaurant whose plan doesn't include them must not
 * be able to run them at all. Rather than tagging every endpoint those
 * apps touch, this gate keys off the caller's ROLE — every API call from
 * a chef needs `kitchenDisplay`, every call from a waiter or captain
 * needs `waiterDashboard`. Admins / managers are unaffected (they use the
 * admin panel, which has its own per-module gates).
 *
 * Mounted once on the v1 router after attachTenant. Auth endpoints stay
 * open so the staff member can still sign in / out and the app can show
 * an "ask your owner to upgrade" screen instead of failing silently.
 */
const STAFF_APP_FEATURE_BY_ROLE = {
    chef:    'kitchenDisplay',
    waiter:  'waiterDashboard',
    captain: 'waiterDashboard',
};
const STAFF_APP_EXEMPT_PREFIXES = ['/auth', '/public'];

const staffAppGate = (req, res, next) => {
    const featureKey = STAFF_APP_FEATURE_BY_ROLE[req.user?.role];
    if (!featureKey || !req.restaurant) return next();
    const path = req.path || '';
    if (STAFF_APP_EXEMPT_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) return next();
    if (!hasFeature(req.restaurant, featureKey)) return lockedResponse(req, res, featureKey);
    // Operations profile: the plan includes the app, but this restaurant
    // has switched the role off (e.g. a self-service hotel with no
    // waiters). Accounts are kept, just blocked — see utils/operationsProfile.
    if (!roleInUse(req.restaurant, req.user.role)) return roleNotInUseResponse(res, req.user.role);
    return next();
};

const ROLE_LABELS = { chef: 'kitchen screen', waiter: 'waiter app', captain: 'captain app' };

/** Is this staff role in use under the tenant's operations profile? */
function roleInUse(restaurant, role) {
    if (!restaurant || !STAFF_APP_FEATURE_BY_ROLE[role]) return true;
    const { resolveOperations } = require('../utils/operationsProfile');
    return resolveOperations(restaurant).roles[role] !== false;
}

function roleNotInUseResponse(res, role) {
    return res.status(403).json({
        success: false,
        code: 'ROLE_NOT_IN_USE',
        role,
        message: `Your restaurant doesn't use the ${ROLE_LABELS[role] || role}. Ask your manager if this is a mistake.`,
    });
}

module.exports = {
    featureGate,
    featureGateAny,
    staffAppGate,
    roleInUse,
    FEATURE_LABELS,
    STAFF_APP_FEATURE_BY_ROLE,
};
