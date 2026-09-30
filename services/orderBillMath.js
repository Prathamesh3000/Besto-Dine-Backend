/**
 * orderBillMath — pure bill arithmetic for orders (no DB / sockets), so it
 * can be unit-tested in isolation. Built on utils/billing.computeBill, the
 * same function createOrder uses for the tax breakdown.
 */
const { computeBill } = require('../utils/billing');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Sum of line items at their stored unit price + selected toppings.
// Same arithmetic the counter-side split docs have always used for their
// bare (pre-tax) total.
function lineItemsSubtotal(items) {
  return (items || []).reduce((sum, item) => {
    const toppings = Array.isArray(item.selectedToppings)
      ? item.selectedToppings.reduce((s, t) => s + (Number(t.price) || 0), 0)
      : 0;
    return sum + ((Number(item.price) || 0) + toppings) * (Number(item.quantity) || 1);
  }, 0);
}

// ── Append-items bill recompute (bug fix) ────────────────────────────
// appendOrderItems used to add only the bare item price to order.total
// and never touched gst / serviceCharge / additionalCharges, so every
// "one more naan" round was billed tax-free and the stored breakdown no
// longer added up to the total.
//
// The bill is now recomputed with utils/billing.computeBill — the same
// function createOrder uses — over ALL of the order's items (items carry
// no per-line cancellation; appending to a cancelled order is refused),
// once for the item set before the append and once after. The
// difference is applied to the stored breakdown and total:
//
//   gst'   = gst   + bill(after).gst   − bill(before).gst
//   (likewise serviceCharge and each additional charge, by name)
//   total' = total + Δsubtotal + Δ(gst + serviceCharge + additional))
//
// For an ordinary order (stored breakdown == bill(own items)) this is
// exactly the from-scratch recompute:
//   total' = bill(all items).total − coupon − points + tip + delivery.
// Coupon discount, redeemed points, tip and delivery fee are carried
// through untouched. Applying the difference instead of overwriting also
// keeps two real cases correct that a blind overwrite would break:
//   • mixed-cart split: the kitchen doc's breakdown was computed on the
//     whole cart (it also carries the counter items' tax), and
//   • legacy orders created before the breakdown existed, whose
//     client-computed taxes are folded into total with a zero breakdown.
// Flat additional charges (e.g. packaging) are per bill, so they are not
// charged again on an append (their difference is 0).
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function billOrderType(order) {
  return order?.delivery?.requested ? 'delivery' : order?.type;
}

/**
 * Pure. Returns the new money fields for an order after an append.
 * @param {object} p
 * @param {object} p.bill            current stored fields: total, gst,
 *                                   serviceCharge, additionalCharges[],
 *                                   additionalChargesTotal
 * @param {number} p.subtotalBefore  item subtotal before the append
 * @param {number} p.subtotalAfter   item subtotal after the append
 * @param {object} p.taxConfig       toTaxConfig(settings.taxes)
 * @param {string} p.orderType       'dine-in' | 'takeaway' | 'delivery'
 */
function recomputeBillAfterAppend({ bill = {}, subtotalBefore = 0, subtotalAfter = 0, taxConfig = {}, orderType = 'dine-in' }) {
  const before = computeBill({ subtotal: subtotalBefore, taxConfig, orderType });
  const after = computeBill({ subtotal: subtotalAfter, taxConfig, orderType });

  const gst = round2(Math.max(0, num(bill.gst) + after.gst - before.gst));
  const serviceCharge = round2(Math.max(0, num(bill.serviceCharge) + after.serviceCharge - before.serviceCharge));

  const additionalCharges = (bill.additionalCharges || []).map((c) => ({
    name: c.name, type: c.type, value: num(c.value), amount: num(c.amount),
  }));
  const beforeByName = new Map(before.additionalCharges.map((c) => [c.name, c.amount]));
  for (const c of after.additionalCharges) {
    const delta = round2(c.amount - (beforeByName.get(c.name) || 0));
    if (delta === 0) continue;
    const existing = additionalCharges.find((s) => s.name === c.name);
    if (existing) {
      existing.amount = round2(Math.max(0, existing.amount + delta));
    } else if (delta > 0) {
      additionalCharges.push({ name: c.name, type: c.type, value: num(c.value), amount: delta });
    }
  }
  const additionalChargesTotal = round2(Math.max(0,
    num(bill.additionalChargesTotal) + after.additionalChargesTotal - before.additionalChargesTotal));

  const deltaSubtotal = round2(after.subtotal - before.subtotal);
  const deltaCharges = round2(
    (gst - num(bill.gst)) + (serviceCharge - num(bill.serviceCharge))
    + (additionalChargesTotal - num(bill.additionalChargesTotal)),
  );
  const total = round2(Math.max(0, num(bill.total) + deltaSubtotal + deltaCharges));

  return {
    total,
    gst,
    gstPercentage: after.gstPct,
    serviceCharge,
    serviceChargePercentage: after.serviceChargePct,
    additionalCharges,
    additionalChargesTotal,
    deltaSubtotal,
    deltaCharges,
  };
}

/**
 * Pure. Money fields for a brand-new order whose items total `subtotal`
 * — the same computeBill breakdown createOrder stamps (flat additional
 * charges included, since this is a fresh bill). Used by the repeat
 * flows that create a new order instead of appending.
 */
function billFieldsForNewOrder({ subtotal = 0, taxConfig = {}, orderType = 'dine-in' }) {
  const b = computeBill({ subtotal, taxConfig, orderType });
  return {
    total: b.total,
    gst: b.gst,
    gstPercentage: b.gstPct,
    serviceCharge: b.serviceCharge,
    serviceChargePercentage: b.serviceChargePct,
    additionalCharges: b.additionalCharges,
    additionalChargesTotal: b.additionalChargesTotal,
  };
}

module.exports = {
  round2,
  lineItemsSubtotal,
  billOrderType,
  recomputeBillAfterAppend,
  billFieldsForNewOrder,
};
