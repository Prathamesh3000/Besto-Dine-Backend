/* eslint-disable */
/* Generated from packages/types - do not edit. */
/**
 * The ONE bill engine. Pure, dependency-free (no zod, no Node/DOM APIs) so it
 * runs unchanged in the Express backend, the React frontend and React Native.
 *
 * It reproduces, to the paisa, what Backend/utils/billing.js computed when
 * this file was written (the behaviour is frozen by golden-vectors.json).
 * Do NOT "improve" the arithmetic here without regenerating the vectors on
 * purpose and agreeing the change - see README.md.
 *
 * Rules (unchanged from the three copies this replaces):
 *  - GST is levied on max(0, subtotal - coupon); points are a payment method
 *    and never reduce the GST base.
 *  - Service charge applies to dine-in only, on the gross subtotal.
 *  - Additional charges (Flat | Percentage) are on the gross subtotal; a
 *    zero/negative subtotal attracts none; zero-amount charges are dropped.
 *  - total = subtotal + gst + service + additional - coupon - points + tip
 *    + delivery, floored at 0. Tip and delivery fee are outside the tax base.
 *  - There is no tax-inclusive pricing mode: every price is tax-exclusive.
 */
/** Order types that attract a service charge. Dine-in only. */
export const SERVICE_CHARGE_TYPES = new Set(['dine-in']);
export function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
export function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}
/** Normalise the order-type spellings in play across the codebase. */
export function normaliseOrderType(orderType) {
    const t = String(orderType || '').toLowerCase().replace(/[\s_]/g, '-');
    if (t === 'dinein' || t === 'dine-in')
        return 'dine-in';
    if (t === 'takeaway' || t === 'take-away' || t === 'pickup')
        return 'takeaway';
    if (t === 'delivery' || t === 'home-delivery')
        return 'delivery';
    if (t === 'kiosk')
        return 'kiosk';
    return t || 'dine-in';
}
/** Flatten a Settings.taxes sub-document; disabled charges are dropped. */
export function toTaxConfig(taxes) {
    if (!taxes)
        return { gstPct: 0, servicePct: 0, additionalCharges: [] };
    return {
        gstPct: taxes.gst?.enabled ? num(taxes.gst.value) : 0,
        servicePct: taxes.serviceCharge?.enabled ? num(taxes.serviceCharge.value) : 0,
        additionalCharges: (taxes.additionalCharges || []).filter((c) => c.enabled !== false),
    };
}
export function computeBill(input = {}) {
    const { subtotal = 0, taxConfig = {}, orderType = 'dine-in', couponDiscount = 0, pointsRedeemed = 0, tipAmount = 0, deliveryFee = 0, } = input;
    const sub = round2(num(subtotal));
    const type = normaliseOrderType(orderType);
    const gstPct = num(taxConfig.gstPct);
    const serviceApplies = SERVICE_CHARGE_TYPES.has(type);
    const servicePct = serviceApplies ? num(taxConfig.servicePct) : 0;
    // GST base = subtotal after the coupon (never negative).
    const gstBase = Math.max(0, round2(sub - num(couponDiscount)));
    const gst = round2(gstBase * (gstPct / 100));
    const serviceCharge = round2(sub * (servicePct / 100));
    const additionalCharges = sub <= 0 ? [] : (taxConfig.additionalCharges || [])
        .map((c) => ({
        name: c.name,
        type: c.type,
        value: num(c.value),
        amount: c.type === 'Percentage' ? round2(sub * (num(c.value) / 100)) : round2(num(c.value)),
    }))
        .filter((c) => c.amount > 0);
    const additionalChargesTotal = round2(additionalCharges.reduce((s, c) => s + c.amount, 0));
    const total = round2(sub + gst + serviceCharge + additionalChargesTotal
        - num(couponDiscount) - num(pointsRedeemed)
        + num(tipAmount) + num(deliveryFee));
    return {
        subtotal: sub,
        gst,
        gstPct,
        serviceCharge,
        serviceChargePct: servicePct,
        serviceChargeApplies: serviceApplies,
        additionalCharges,
        additionalChargesTotal,
        couponDiscount: round2(num(couponDiscount)),
        pointsRedeemed: round2(num(pointsRedeemed)),
        tipAmount: round2(num(tipAmount)),
        deliveryFee: round2(num(deliveryFee)),
        total: total < 0 ? 0 : total,
    };
}
