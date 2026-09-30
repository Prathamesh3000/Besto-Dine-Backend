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

/** Order types that attract a service charge. Dine-in only. */
const SERVICE_CHARGE_TYPES = new Set(['dine-in']);

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/** Normalise the order-type spellings in play across the codebase. */
function normaliseOrderType(orderType) {
    const t = String(orderType || '').toLowerCase().replace(/[\s_]/g, '-');
    if (t === 'dinein' || t === 'dine-in') return 'dine-in';
    if (t === 'takeaway' || t === 'take-away' || t === 'pickup') return 'takeaway';
    if (t === 'delivery' || t === 'home-delivery') return 'delivery';
    if (t === 'kiosk') return 'kiosk';
    return t || 'dine-in';
}

/**
 * Flatten a Settings.taxes sub-document into the shape computeBill
 * wants. Disabled charges are dropped here so no downstream caller
 * has to remember the `enabled` flag.
 */
function toTaxConfig(taxes) {
    if (!taxes) return { gstPct: 0, servicePct: 0, additionalCharges: [] };
    return {
        gstPct: taxes.gst?.enabled ? num(taxes.gst.value) : 0,
        servicePct: taxes.serviceCharge?.enabled ? num(taxes.serviceCharge.value) : 0,
        additionalCharges: (taxes.additionalCharges || []).filter((c) => c.enabled !== false),
    };
}

/**
 * Compute the full bill for an order.
 *
 * Taxes are levied on the gross subtotal, then discounts come off the
 * taxed figure. That mirrors what the client has always done; changing
 * the order of operations is a pricing decision, not a refactor, so it
 * is deliberately preserved.
 */
function computeBill({
    subtotal = 0,
    taxConfig = {},
    orderType = 'dine-in',
    couponDiscount = 0,
    pointsRedeemed = 0,
    tipAmount = 0,
    deliveryFee = 0,
} = {}) {
    const sub = round2(num(subtotal));
    const type = normaliseOrderType(orderType);

    const gstPct = num(taxConfig.gstPct);
    const serviceApplies = SERVICE_CHARGE_TYPES.has(type);
    const servicePct = serviceApplies ? num(taxConfig.servicePct) : 0;

    const gst = round2(sub * (gstPct / 100));
    const serviceCharge = round2(sub * (servicePct / 100));

    // A ₹0 cart attracts no flat charges — otherwise a packaging fee
    // lands on an empty bill.
    const additionalCharges = sub <= 0 ? [] : (taxConfig.additionalCharges || [])
        .map((c) => ({
            name: c.name,
            type: c.type,
            value: num(c.value),
            amount: c.type === 'Percentage' ? round2(sub * (num(c.value) / 100)) : round2(num(c.value)),
        }))
        .filter((c) => c.amount > 0);

    const additionalChargesTotal = round2(
        additionalCharges.reduce((s, c) => s + c.amount, 0),
    );

    const total = round2(
        sub + gst + serviceCharge + additionalChargesTotal
        - num(couponDiscount) - num(pointsRedeemed)
        + num(tipAmount) + num(deliveryFee),
    );

    return {
        subtotal: sub,
        gst,
        gstPct,
        serviceCharge,
        serviceChargePct: servicePct,
        serviceChargeApplies: serviceApplies,
        additionalCharges,
        additionalChargesTotal,
        total: total < 0 ? 0 : total,
    };
}

module.exports = {
    computeBill,
    toTaxConfig,
    normaliseOrderType,
    SERVICE_CHARGE_TYPES,
};
