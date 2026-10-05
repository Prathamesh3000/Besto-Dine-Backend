// ADM-064 — coupon item-scope eligibility helper.
//
// A coupon with scope='food' or scope='beverages' must only discount the
// matching slice of an order, not the whole subtotal. Before this helper
// existed, every coupon discounted everything because the controller
// fell back to `orderValue × discount%` without ever looking at items.
//
// Classification rule — Decision 6 (2026-10):
//   1. item.categoryKind ('food' | 'beverages') wins when present. The
//      admin picks Food / Drink per menu category (Category.kind) and the
//      kind is snapshotted onto each order line (see withCategoryKinds).
//      So a Coke in a "Drinks" category is a beverage even though
//      utils/prepStationInfer routes sealed drinks to the 'counter'.
//   2. Fallback for old orders / items without the snapshot — prep station:
//        prepStation === 'bar'                → beverages
//        prepStation === 'kitchen' / 'counter' → food
//      (only the bar is unambiguously beverages-only.)
//
// `items` is an order.items[] array (or pseudo-items with the same
// fields). Falls back to 'kitchen' if a legacy row is missing prepStation.

const CATEGORY_KINDS = Object.freeze(['food', 'beverages']);

function normalizeKind(kind) {
    const k = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
    return CATEGORY_KINDS.includes(k) ? k : null;
}

function classifyItem(item) {
    const kind = normalizeKind(item?.categoryKind);
    if (kind) return kind;
    const station = (item?.prepStation || 'kitchen').toLowerCase();
    return station === 'bar' ? 'beverages' : 'food';
}

/**
 * Category kind of a MenuItem doc (lean or hydrated) whose `category` is
 * populated with at least `kind`. Returns null when the category is not
 * populated / has no valid kind — classifyItem then falls back to the
 * prep-station rule.
 */
function menuCategoryKind(menu) {
    const cat = menu?.category;
    if (!cat || typeof cat !== 'object') return null;
    return normalizeKind(cat.kind);
}

/**
 * Decision 6 — stamp `categoryKind` onto order lines / coupon pseudo-items
 * from their menu item's category. Returns NEW objects; never mutates.
 * An item that already carries a valid categoryKind keeps it (an order
 * snapshot must not shift when the admin re-labels a category later).
 *
 * @param {Array} items     — lines with `menuItem` (id or populated doc)
 * @param {Map}   menuById  — Map<String(id), MenuItem> whose `category` is
 *                            populated with 'kind' (populate('category', 'name kind'))
 * @returns {Array}
 */
function withCategoryKinds(items, menuById) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        if (normalizeKind(item.categoryKind)) return { ...item };
        const ref = item.menuItem;
        const id = ref && typeof ref === 'object' ? (ref._id ?? ref.id) : ref;
        const menu = (menuById && typeof menuById.get === 'function' && id != null)
            ? menuById.get(String(id))
            : null;
        const kind = menuCategoryKind(menu || (ref && typeof ref === 'object' ? ref : null));
        return kind ? { ...item, categoryKind: kind } : { ...item };
    });
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
 * @param {Array}  items  — order.items[] with categoryKind and/or prepStation + price + quantity
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
    CATEGORY_KINDS,
    classifyItem,
    menuCategoryKind,
    withCategoryKinds,
    isEligible,
    eligibleSubtotal,
    computeCouponDiscount,
};
