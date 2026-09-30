/**
 * Shared helper for resolving the *customer-facing* subset of a tenant's
 * feature flags.
 *
 * The full feature flag set (inventory, crm, multiBranch, staffPerformance…)
 * contains admin-only modules customers should never see. This helper
 * returns only the flags that affect the customer UI — the ones the
 * frontend uses to hide buttons for locked modules (Wallet, Bookings,
 * Coupons) so users don't tap through to a 403.
 *
 * Resolution mirrors the backend `featureGate` middleware exactly so the
 * UI and the gate never disagree:
 *   featureOverrides[key] === false → OFF
 *   featureOverrides[key] === true  → ON
 *   subscription.features[key] truthy → ON
 *   otherwise → OFF
 *
 * Used by publicController (restaurant list + by-slug) and tableController
 * (QR scan response) so every place the frontend learns about a tenant
 * gets the same features map.
 */

const CUSTOMER_FACING_FEATURE_KEYS = [
    'dineIn',
    'takeaway',
    'advanceBookingTable',
    'advanceBookingHall',
    'walletLoyalty',
    'couponPromotions',
    // Kiosk is a customer-facing surface (the kiosk LandingPage gates
    // itself on this flag via /public/restaurants/:slug). Without it
    // here, every kiosk install was stuck on the "Self-Order Kiosk
    // not enabled" screen even when the Super Admin had the kiosk
    // toggle turned ON for the tenant — the public endpoint just
    // wasn't reporting the flag.
    'kiosk',
];

function publicFeaturesOf(restaurant) {
    const source = restaurant?.subscription?.features || {};
    const overrides = restaurant?.featureOverrides || {};
    const out = {};
    for (const key of CUSTOMER_FACING_FEATURE_KEYS) {
        if (overrides[key] === false) { out[key] = false; continue; }
        if (overrides[key] === true)  { out[key] = true;  continue; }
        const v = source[key];
        out[key] = v === true || v === 'advanced' || v === 'standard' || v === 'basic';
    }
    return out;
}

module.exports = { publicFeaturesOf, CUSTOMER_FACING_FEATURE_KEYS };
