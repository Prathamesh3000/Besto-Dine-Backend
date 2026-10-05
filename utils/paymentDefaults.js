/**
 * Centralized default values for payment & loyalty configuration.
 *
 * These are used as fallbacks when per-tenant settings are missing or
 * incomplete. All controllers should import from here instead of
 * hardcoding their own fallback values.
 */

const PAYMENT_DEFAULTS = {
    // Loyalty points
    enableLoyalty: true,
    minBillToEarn: 100,        // Minimum order total (₹) to earn points
    pointsPerRupee: 1,        // Points earned per ₹1 spent
    pointsToRupee: 0.1,       // ₹ per point when redeeming (10 points = ₹1)
    pointsExpiryDays: 365,    // Days before points expire

    // Refund
    refundMode: 'original',   // 'original' | 'wallet'

    // Wallet recharge
    maxRechargeAmount: 10_000, // ₹ maximum single recharge
};

/**
 * Extract loyalty settings from a settings object with centralized defaults.
 *
 * @param {Object|null} settings - The tenant settings object (from getSettings)
 * @returns {Object} Resolved loyalty config with no missing fields
 */
// A stored number wins even when it is 0 — the Settings schema allows 0
// (e.g. minBillToEarn 0 = earn on every bill, pointsExpiryDays 0 = never
// expire). Only a missing / non-numeric value falls back to the default.
function numberOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function resolveLoyaltySettings(settings) {
    const w = settings?.wallet || {};
    return {
        enableLoyalty: w.enableLoyalty !== undefined ? w.enableLoyalty : PAYMENT_DEFAULTS.enableLoyalty,
        minBillToEarn: numberOr(w.minBillToEarn, PAYMENT_DEFAULTS.minBillToEarn),
        pointsPerRupee: numberOr(w.pointsPerRupee, PAYMENT_DEFAULTS.pointsPerRupee),
        pointsToRupee: numberOr(w.pointsToRupee, PAYMENT_DEFAULTS.pointsToRupee),
        pointsExpiryDays: numberOr(w.pointsExpiryDays, PAYMENT_DEFAULTS.pointsExpiryDays),
        refundMode: w.refundMode || PAYMENT_DEFAULTS.refundMode,
    };
}

module.exports = { PAYMENT_DEFAULTS, resolveLoyaltySettings };
