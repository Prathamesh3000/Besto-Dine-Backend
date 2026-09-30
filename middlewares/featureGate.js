/**
 * featureGate(featureKey)
 *
 * Middleware factory that blocks the request unless the active tenant's
 * subscription includes the named feature.
 *
 * Resolution rules (most specific wins):
 *   1. `restaurant.featureOverrides[key] === false` → BLOCK (Super Admin
 *       has explicitly revoked this feature for this tenant).
 *   2. `restaurant.featureOverrides[key] === true`  → ALLOW (Super Admin
 *       has explicitly granted this feature outside the base plan).
 *   3. `restaurant.subscription.features[key] === true`     → ALLOW
 *      `restaurant.subscription.features[key] === 'advanced'` → ALLOW (tiered)
 *   4. Otherwise → BLOCK with FEATURE_LOCKED + role-aware message.
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
    inventory:           'inventory management',
    crm:                 'customer management',
    tipManagement:       'tip management',
    multiBranch:         'multi-branch support',
    staffPerformance:    'staff performance tracking',
    paymentGateway:      'online payment gateway',
    dataExport:          'data export',
    webhooks:            'webhook integrations',
    revenueAnalytics:    'revenue analytics',
    kiosk:               'self-order kiosk',
};

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

const featureGate = (featureKey) => {
    if (!featureKey || typeof featureKey !== 'string') {
        throw new Error('featureGate requires a feature key');
    }

    return (req, res, next) => {
        // Legacy / single-tenant — allow.
        if (!req.restaurant) return next();

        const overrides = req.restaurant.featureOverrides || {};
        const customerFacing = isCustomerRequest(req);
        const label = labelFor(featureKey);

        if (overrides[featureKey] === false) {
            return res.status(403).json({
                success: false,
                code: 'FEATURE_REVOKED',
                feature: featureKey,
                message: customerFacing
                    ? `This restaurant doesn't currently offer ${label}.`
                    : `The "${featureKey}" feature has been disabled for your restaurant. Contact support for details.`,
            });
        }
        if (overrides[featureKey] === true) return next();

        const features = req.restaurant.subscription?.features || {};
        const value = features[featureKey];
        if (value === true || value === 'advanced' || value === 'standard' || value === 'basic') {
            return next();
        }

        return res.status(403).json({
            success: false,
            code: 'FEATURE_LOCKED',
            feature: featureKey,
            currentPlan: req.restaurant.subscription?.planName || 'Unknown',
            message: customerFacing
                ? `This restaurant doesn't offer ${label}.`
                : `Your current plan does not include "${featureKey}". Upgrade your subscription to enable it.`,
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
 * Resolution rules per key match featureGate (overrides → subscription
 * features), and an explicit `false` override on one key does not block
 * the request — another key may still grant access.
 */
const featureGateAny = (...featureKeys) => {
    if (!featureKeys.length || featureKeys.some(k => typeof k !== 'string')) {
        throw new Error('featureGateAny requires at least one feature key string');
    }

    return (req, res, next) => {
        if (!req.restaurant) return next();

        const overrides = req.restaurant.featureOverrides || {};
        const features = req.restaurant.subscription?.features || {};

        for (const key of featureKeys) {
            if (overrides[key] === true) return next();
            if (overrides[key] === false) continue;
            const v = features[key];
            if (v === true || v === 'advanced' || v === 'standard' || v === 'basic') {
                return next();
            }
        }

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

module.exports = { featureGate, featureGateAny, FEATURE_LABELS };
