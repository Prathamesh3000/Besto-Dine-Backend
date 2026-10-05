/**
 * priceResolver — resolves the correct price for a menu item based
 * on the customer's branch context.
 *
 * Strategy: if branchPrices[] has an entry matching the given branchId,
 * use that entry's basePrice/finalPrice. Otherwise fall back to the
 * item's top-level basePrice/finalPrice (the default / tenant-wide price).
 *
 * Usage:
 *   const resolved = resolvePrice(menuItem, req.branch?._id);
 *   // resolved.basePrice, resolved.finalPrice, resolved.offerPercentage
 */

// Round a rupee amount to whole paise (₹89.99 − 10% → 80.99, not 80.991).
const toPaise = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

function resolvePrice(menuItem, branchId) {
    const now = new Date();
    // The stored finalPrice is computed at save time without looking at
    // offerExpiryDate, so a tenant-wide offer whose end date has passed
    // must be dropped here (mirrored in Frontend utils/pricing.js).
    const defaultExpiry = menuItem.offerExpiryDate ? new Date(menuItem.offerExpiryDate) : null;
    const defaultExpired = !!defaultExpiry && !Number.isNaN(defaultExpiry.getTime()) && defaultExpiry <= now;
    const defaults = {
        basePrice: menuItem.basePrice,
        finalPrice: defaultExpired ? menuItem.basePrice : toPaise(menuItem.finalPrice),
        offerPercentage: defaultExpired ? 0 : (menuItem.offerPercentage || 0),
        offerExpiryDate: menuItem.offerExpiryDate || null,
        pricingSource: 'default',
    };

    if (!branchId || !menuItem.branchPrices?.length) {
        return defaults;
    }

    const branchStr = branchId.toString();
    const bp = menuItem.branchPrices.find(
        (p) => p.branch && p.branch.toString() === branchStr
    );

    if (!bp) return defaults;

    // Check if offer has expired for this branch
    const offerActive = bp.offerPercentage > 0 && (!bp.offerExpiryDate || bp.offerExpiryDate > now);

    return {
        basePrice: bp.basePrice,
        finalPrice: offerActive
            ? toPaise(bp.basePrice - (bp.basePrice * (bp.offerPercentage / 100)))
            : bp.basePrice,
        offerPercentage: offerActive ? bp.offerPercentage : 0,
        offerExpiryDate: bp.offerExpiryDate || null,
        pricingSource: 'branch',
    };
}

/**
 * Apply resolved branch pricing to a menu item object (mutates).
 * Used when returning menu items to customers so they see the
 * correct price for their branch.
 */
function applyBranchPrice(item, branchId) {
    const resolved = resolvePrice(item, branchId);
    item.basePrice = resolved.basePrice;
    item.finalPrice = resolved.finalPrice;
    item.offerPercentage = resolved.offerPercentage;
    item.offerExpiryDate = resolved.offerExpiryDate;
    item._pricingSource = resolved.pricingSource;
    return item;
}

module.exports = { resolvePrice, applyBranchPrice };
