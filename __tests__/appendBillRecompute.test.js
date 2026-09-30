/**
 * Unit tests for services/orderBillMath.recomputeBillAfterAppend — the fix
 * for items appended to an existing order being added at bare price with
 * no GST / service charge / additional charges.
 *
 * The recompute uses utils/billing.computeBill (the same function
 * createOrder uses) over the order's items before and after the append
 * and applies the difference to the stored breakdown, so coupon, points,
 * tip and delivery fee carried on the order are preserved.
 */

const { computeBill, toTaxConfig } = require('../utils/billing');
const {
  recomputeBillAfterAppend,
  lineItemsSubtotal,
  billOrderType,
} = require('../services/orderBillMath');

const TAXES = {
  gst: { enabled: true, value: 5 },
  serviceCharge: { enabled: true, value: 10 },
  additionalCharges: [
    { name: 'Packaging', type: 'Flat', value: 20, enabled: true },
    { name: 'Green Tax', type: 'Percentage', value: 2, enabled: true },
  ],
};
const taxConfig = toTaxConfig(TAXES);

// What createOrder stores for a cart with this subtotal and adjustments.
function orderFromCreate(subtotal, { orderType = 'dine-in', couponDiscount = 0, pointsValue = 0, tipAmount = 0, deliveryFee = 0 } = {}) {
  const bill = computeBill({ subtotal, taxConfig, orderType });
  return {
    total: Math.round((bill.total - couponDiscount - pointsValue + tipAmount + deliveryFee) * 100) / 100,
    gst: bill.gst,
    serviceCharge: bill.serviceCharge,
    additionalCharges: bill.additionalCharges,
    additionalChargesTotal: bill.additionalChargesTotal,
  };
}

describe('recomputeBillAfterAppend', () => {
  test('dine-in: appended items attract GST, service charge and % charges', () => {
    const bill = orderFromCreate(200);
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 200, subtotalAfter: 300, taxConfig, orderType: 'dine-in' });

    const full = computeBill({ subtotal: 300, taxConfig, orderType: 'dine-in' });
    expect(next.gst).toBe(full.gst);                       // 15
    expect(next.serviceCharge).toBe(full.serviceCharge);   // 30
    expect(next.additionalChargesTotal).toBe(full.additionalChargesTotal); // 20 flat + 6
    expect(next.total).toBe(full.total);                   // 371
    expect(next.deltaSubtotal).toBe(100);
    expect(next.gstPercentage).toBe(5);
    expect(next.serviceChargePercentage).toBe(10);
  });

  test('equals a from-scratch recompute while preserving coupon / points / tip / delivery', () => {
    const adj = { couponDiscount: 25, pointsValue: 10, tipAmount: 15, deliveryFee: 40 };
    const bill = orderFromCreate(500, { orderType: 'delivery', ...adj });
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 500, subtotalAfter: 650, taxConfig, orderType: 'delivery' });

    const full = computeBill({ subtotal: 650, taxConfig, orderType: 'delivery' });
    const expected = Math.round((full.total - 25 - 10 + 15 + 40) * 100) / 100;
    expect(next.total).toBe(expected);
    expect(next.serviceCharge).toBe(0); // delivery never pays service charge
  });

  test('takeaway / delivery orders never gain a service charge', () => {
    const bill = orderFromCreate(100, { orderType: 'takeaway' });
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 100, subtotalAfter: 180, taxConfig, orderType: 'takeaway' });
    expect(next.serviceCharge).toBe(0);
    expect(next.gst).toBe(9);
  });

  test('flat charges are per bill — not charged again on append', () => {
    const bill = orderFromCreate(200);
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 200, subtotalAfter: 260, taxConfig });
    const packaging = next.additionalCharges.find((c) => c.name === 'Packaging');
    expect(packaging.amount).toBe(20);
    const green = next.additionalCharges.find((c) => c.name === 'Green Tax');
    expect(green.amount).toBe(5.2);
    expect(next.additionalChargesTotal).toBe(25.2);
  });

  test('stored breakdown that covers more than this doc (mixed-cart split kitchen doc) is kept', () => {
    // Kitchen doc of a split cart: breakdown computed on the whole cart
    // (kitchen 200 + counter 40) while its own items are only 200.
    const whole = computeBill({ subtotal: 240, taxConfig });
    const bill = {
      total: Math.round((whole.total - 40) * 100) / 100, // counter doc carries its bare 40
      gst: whole.gst, serviceCharge: whole.serviceCharge,
      additionalCharges: whole.additionalCharges, additionalChargesTotal: whole.additionalChargesTotal,
    };
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 200, subtotalAfter: 300, taxConfig });
    // The counter items' tax stays; only the appended 100 adds tax.
    expect(next.gst).toBe(Math.round((whole.gst + 5) * 100) / 100);
    expect(next.serviceCharge).toBe(Math.round((whole.serviceCharge + 10) * 100) / 100);
  });

  test('legacy order with no stored breakdown only gains the increment', () => {
    // Pre-breakdown order: client-computed taxes folded into total.
    const bill = { total: 262, gst: 0, serviceCharge: 0, additionalCharges: [], additionalChargesTotal: 0 };
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 200, subtotalAfter: 250, taxConfig });
    // +50 items, +2.5 GST, +5 service, +1 green tax (2% of 50), no new flat fee
    expect(next.total).toBe(320.5);
    expect(next.gst).toBe(2.5);
    expect(next.additionalCharges).toEqual([{ name: 'Green Tax', type: 'Percentage', value: 2, amount: 1 }]);
  });

  test('no tax config → only the item delta is added (old behaviour)', () => {
    const bill = { total: 100, gst: 0, serviceCharge: 0, additionalCharges: [], additionalChargesTotal: 0 };
    const next = recomputeBillAfterAppend({ bill, subtotalBefore: 100, subtotalAfter: 130, taxConfig: toTaxConfig(null) });
    expect(next.total).toBe(130);
    expect(next.deltaCharges).toBe(0);
  });
});

describe('lineItemsSubtotal / billOrderType', () => {
  test('sums unit price + toppings × quantity', () => {
    expect(lineItemsSubtotal([
      { price: 200, quantity: 2, selectedToppings: [{ price: 30 }] },
      { price: 20, quantity: 3 },
    ])).toBe(520);
  });

  test('delivery flag wins over the stored order type', () => {
    expect(billOrderType({ type: 'takeaway', delivery: { requested: true } })).toBe('delivery');
    expect(billOrderType({ type: 'dine-in' })).toBe('dine-in');
  });
});
