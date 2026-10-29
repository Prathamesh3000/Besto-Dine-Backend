/**
 * featureAccess — the single source of truth for "may this tenant use
 * module X?".
 *
 * Every place that answers that question (featureGate middleware, the
 * Restaurant#hasFeature helper, the customer-facing flag map, the tenant
 * snapshot sent to the frontend at login) goes through here so the rules
 * can never drift apart.
 *
 * Resolution order (first match wins):
 *   1. featureOverrides[key] === false → OFF  (Super Admin revoked it)
 *   2. featureOverrides[key] === true  → ON   (Super Admin granted it)
 *   3. an active paid add-on for key   → ON   (restaurant.addons[])
 *   4. subscription.features[key]      → plan snapshot value
 *   5. key missing from the snapshot   → LEGACY_FALLBACK[key] (see below)
 *
 * No restaurant (legacy single-tenant / superadmin) → everything ON, the
 * same "never break existing flows" rule featureGate has always used.
 *
 * Tiered keys (revenueAnalytics) resolve to 'none' | 'basic' |
 * 'standard' | 'advanced'. A boolean `true` on a tiered key (override or
 * add-on) means the top tier.
 */

const TIERS = ['none', 'basic', 'standard', 'advanced'];
const TIER_RANK = { none: 0, basic: 1, standard: 2, advanced: 3 };

const TIERED_KEYS = new Set(['revenueAnalytics']);

// Keys added after tenants already had plan snapshots. A snapshot that
// pre-dates the key has no entry for it at all (undefined, not false);
// those tenants keep the access they had before the module was split
// out — e.g. campaigns used to be part of couponPromotions.
const LEGACY_FALLBACK = {
    campaigns: 'couponPromotions',
};

// Paid add-ons: modules a restaurant can buy on top of its plan. Prices
// are the catalog defaults (INR per month, before GST); the Super Admin
// can record a different agreed price per restaurant.
const ADDON_CATALOG = {
    advanceBookingHall: { label: 'Banquet / hall bookings', monthlyPrice: 799 },
    kiosk:              { label: 'Self-order kiosk',        monthlyPrice: 499 },
    eInvoice:           { label: 'GST e-invoice (IRN)',     monthlyPrice: 0 },
    incentives:         { label: 'Staff incentives',        monthlyPrice: 299 },
    publicApi:          { label: 'API keys & webhooks',     monthlyPrice: 499 },
};

function isOn(value) {
    return value === true || value === 'basic' || value === 'standard' || value === 'advanced';
}

function isAddonActive(addon, now = new Date()) {
    if (!addon || addon.status !== 'active') return false;
    if (addon.startDate && new Date(addon.startDate) > now) return false;
    if (addon.endDate && new Date(addon.endDate) <= now) return false;
    return true;
}

/** Keys of the add-ons currently in force for this restaurant. */
function activeAddonKeys(restaurant, now = new Date()) {
    const out = new Set();
    for (const a of restaurant?.addons || []) {
        if (a && a.key && isAddonActive(a, now)) out.add(a.key);
    }
    return out;
}

function planValue(restaurant, key) {
    const features = restaurant?.subscription?.features || {};
    if (features[key] !== undefined) return features[key];
    const legacy = LEGACY_FALLBACK[key];
    if (legacy && features[legacy] !== undefined) return features[legacy];
    return undefined;
}

/**
 * Effective tier for a tiered key, or 'advanced' / 'none' for a boolean
 * key (so callers can treat both uniformly).
 */
function featureTier(restaurant, key, now = new Date()) {
    if (!restaurant) return 'advanced';
    const override = restaurant.featureOverrides?.[key];
    if (override === false) return 'none';
    if (override === true) return 'advanced';
    if (typeof override === 'string' && TIER_RANK[override] !== undefined) return override;
    if (activeAddonKeys(restaurant, now).has(key)) return 'advanced';
    const v = planValue(restaurant, key);
    if (v === true) return 'advanced';
    if (typeof v === 'string' && TIER_RANK[v] !== undefined) return v;
    return 'none';
}

function hasFeature(restaurant, key, now = new Date()) {
    return featureTier(restaurant, key, now) !== 'none';
}

/** True when the tenant's tier for `key` is at least `minTier`. */
function hasTier(restaurant, key, minTier, now = new Date()) {
    return TIER_RANK[featureTier(restaurant, key, now)] >= (TIER_RANK[minTier] ?? 1);
}

/**
 * Fully-resolved feature map for the frontend snapshot: boolean keys →
 * true/false, tiered keys → tier string. Includes add-ons and legacy
 * fallbacks, so the UI never has to re-implement these rules.
 */
function effectiveFeatures(restaurant, allKeys, now = new Date()) {
    const keys = new Set([
        ...(allKeys || []),
        ...Object.keys(restaurant?.subscription?.features || {}),
        ...Object.keys(restaurant?.featureOverrides || {}),
    ]);
    const out = {};
    for (const key of keys) {
        const tier = featureTier(restaurant, key, now);
        out[key] = TIERED_KEYS.has(key) ? tier : tier !== 'none';
    }
    return out;
}

module.exports = {
    TIERS,
    TIER_RANK,
    TIERED_KEYS,
    LEGACY_FALLBACK,
    ADDON_CATALOG,
    isOn,
    isAddonActive,
    activeAddonKeys,
    featureTier,
    hasFeature,
    hasTier,
    effectiveFeatures,
};
