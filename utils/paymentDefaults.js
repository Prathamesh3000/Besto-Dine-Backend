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
function resolveLoyaltySettings(settings) {
    const w = settings?.wallet || {};
    return {
        enableLoyalty: w.enableLoyalty !== undefined ? w.enableLoyalty : PAYMENT_DEFAULTS.enableLoyalty,
        minBillToEarn: w.minBillToEarn || PAYMENT_DEFAULTS.minBillToEarn,
        pointsPerRupee: w.pointsPerRupee || PAYMENT_DEFAULTS.pointsPerRupee,
        pointsToRupee: w.pointsToRupee || PAYMENT_DEFAULTS.pointsToRupee,
        pointsExpiryDays: w.pointsExpiryDays || PAYMENT_DEFAULTS.pointsExpiryDays,
        refundMode: w.refundMode || PAYMENT_DEFAULTS.refundMode,
    };
}

module.exports = { PAYMENT_DEFAULTS, resolveLoyaltySettings };
