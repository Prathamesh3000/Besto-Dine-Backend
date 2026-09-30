// ADM-064 — coupon item-scope eligibility helper.
//
// A coupon with scope='food' or scope='beverages' must only discount the
// matching slice of an order, not the whole subtotal. Before this helper
// existed, every coupon discounted everything because the controller
// fell back to `orderValue × discount%` without ever looking at items.
//
// Classification rule (cafe-friendly default):
//   - prepStation === 'bar'                → beverages
//   - prepStation === 'kitchen' / 'counter' → food
//
// Reasoning: only the bar station is unambiguously beverages-only.
// 'counter' rolls up packaged snacks AND bottled drinks, but in real
// menus counter is dominated by ready-to-serve food (chips, ice
// cream, parathas-on-display) so we group it with food. If a tenant
// needs finer control they can re-tag specific items to prepStation:
// 'bar' (e.g. bottled juices) to flip their category.
//
// `items` is an order.items[] array — each entry carries a prepStation
// snapshot stamped at order-create time, so we don't need a MenuItem
// lookup. Falls back to 'kitchen' if a legacy row is missing the field.

function classifyItem(item) {
    const station = (item?.prepStation || 'kitchen').toLowerCase();
    return station === 'bar' ? 'beverages' : 'food';
}

function isEligible(item, scope) {
    if (!scope || scope === 'all') return true;
    return classifyItem(item) === scope;
}

/**
 * Sum the price × quantity of every item eligible under the given scope.
 * Returns 0 when items is empty or no item matches — caller decides
 * whether that's a hard reject ("coupon doesn't apply to this order")
 * or a silent zero-discount.
 */
function eligibleSubtotal(items, scope) {
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const it of items) {
        if (!isEligible(it, scope)) continue;
        const price = Number(it.price) || 0;
        const qty = Number(it.quantity) || 0;
        total += price * qty;
    }
    return Math.round(total * 100) / 100;
}

/**
 * Compute the discount the coupon contributes against an order.
 *
 * @param {Object} coupon — lean coupon doc (discountType, discountValue,
 *                          maxDiscountAmount, scope)
 * @param {Array}  items  — order.items[] with prepStation + price + quantity
 * @returns {{ discount: number, eligibleSubtotal: number, scope: string }}
 */
function computeCouponDiscount(coupon, items) {
    const scope = coupon?.scope || 'all';
    const eligible = eligibleSubtotal(items, scope);
    if (eligible <= 0) return { discount: 0, eligibleSubtotal: 0, scope };

    let discount = 0;
    if (coupon.discountType === 'percentage') {
        discount = Math.round(eligible * (Number(coupon.discountValue) || 0)) / 100;
        if (coupon.maxDiscountAmount > 0 && discount > coupon.maxDiscountAmount) {
            discount = coupon.maxDiscountAmount;
        }
    } else if (coupon.discountType === 'fixed_amount') {
        discount = Number(coupon.discountValue) || 0;
    }
    // Can't discount more than the eligible slice — otherwise a ₹500 fixed
    // coupon on a ₹100 beverage tab would create a negative line.
    discount = Math.min(discount, eligible);
    return { discount, eligibleSubtotal: eligible, scope };
}

module.exports = {
    classifyItem,
    isEligible,
    eligibleSubtotal,
    computeCouponDiscount,
};
