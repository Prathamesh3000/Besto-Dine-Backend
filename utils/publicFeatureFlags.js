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
 * Resolution is utils/featureAccess.hasFeature — the same function the
 * backend `featureGate` middleware uses — so the UI and the gate never
 * disagree (overrides → paid add-ons → plan snapshot).
 *
 * Used by publicController (restaurant list + by-slug) and tableController
 * (QR scan response) so every place the frontend learns about a tenant
 * gets the same features map.
 */

const { hasFeature } = require('./featureAccess');

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
    // Online payments — when the plan has no payment gateway the customer
    // apps hide "Pay online" and offer pay-at-counter only.
    'paymentGateway',
];

function publicFeaturesOf(restaurant) {
    const out = {};
    for (const key of CUSTOMER_FACING_FEATURE_KEYS) {
        out[key] = restaurant ? hasFeature(restaurant, key) : false;
    }
    return out;
}

module.exports = { publicFeaturesOf, CUSTOMER_FACING_FEATURE_KEYS };
