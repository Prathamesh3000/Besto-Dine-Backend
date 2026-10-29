/**
 * billing — server-side tax & charge computation.
 *
 * Why this exists
 * ---------------
 * Until now the server did not model taxes at all. createOrder's
 * sanity check computed only:
 *
 *     serverMinTotal = subtotal - coupon - points + tip + delivery
 *
 * and then accepted any client total at or above it, on the reasoning
 * that taxes "aren't modeled here yet". Two consequences:
 *
 *   1. GST / service charge / additional charges were whatever the
 *      browser said they were. Nothing on the server could disagree.
 *   2. The Order document had no gst / serviceCharge fields, so the
 *      persisted record of what a customer was charged did not exist.
 *      paymentController reads `order.serviceCharge || 0` — that was
 *      *always* 0. Every bill screen re-derived the numbers from the
 *      live settings instead, which is why an admin editing the GST
 *      rate retroactively changed historical bills.
 *
 * This module makes the server the authority. It is the exact mirror
 * of Frontend/src/utils/billing.js — the two must change together.
 *
 * The rule that motivated it: service charge pays for table service.
 * A takeaway, delivery or kiosk customer receives none, so billing
 * them for it is charging for a service never rendered. That policy
 * lives here, once, rather than in each of the twelve client-side
 * copies that used to own it.
 */

// The arithmetic lives in ONE place now: packages/types (vendored here by
// scripts/sync-types.js). This module keeps its historical public API.
const shared = require('../vendor/bestodine-types/cjs/engine');

/** Order types that attract a service charge. Dine-in only. */
const SERVICE_CHARGE_TYPES = shared.SERVICE_CHARGE_TYPES;

/** Normalise the order-type spellings in play across the codebase. */
const normaliseOrderType = shared.normaliseOrderType;

/**
 * Flatten a Settings.taxes sub-document into the shape computeBill
 * wants. Disabled charges are dropped here so no downstream caller
 * has to remember the `enabled` flag.
 */
const toTaxConfig = shared.toTaxConfig;

/**
 * Compute the full bill for an order.
 *
 * GST is levied on the DISCOUNTED value: (subtotal − couponDiscount),
 * floored at 0 — a coupon reduces the taxable value of the supply.
 * Service charge and additional charges stay on the gross subtotal.
 * Loyalty points are a payment method, not a discount, so they do NOT
 * reduce the GST base. Then:
 *
 *   total = subtotal + gst + serviceCharge + additionalCharges
 *           − coupon − points + tip + delivery            (≥ 0)
 *
 * e.g. ₹1000 food, 5% GST, ₹100 coupon → GST ₹45 → total ₹945.
 * Must stay in lockstep with Frontend/src/utils/billing.js.
 */
function computeBill(input = {}) {
    const b = shared.computeBill(input);
    // The server contract has always been these fields (the shared engine
    // also echoes coupon/points/tip/delivery for the UIs).
    return {
        subtotal: b.subtotal,
        gst: b.gst,
        gstPct: b.gstPct,
        serviceCharge: b.serviceCharge,
        serviceChargePct: b.serviceChargePct,
        serviceChargeApplies: b.serviceChargeApplies,
        additionalCharges: b.additionalCharges,
        additionalChargesTotal: b.additionalChargesTotal,
        total: b.total,
    };
}

module.exports = {
    computeBill,
    toTaxConfig,
    normaliseOrderType,
    SERVICE_CHARGE_TYPES,
};
