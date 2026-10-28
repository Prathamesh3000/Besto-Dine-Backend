/**
 * Repeat-order bill: the customer "repeat item" / "repeat order" flows used
 * to add repeated items at bare price (no GST / service charge / additional
 * charges). They now reuse the append recompute (applyAppendToBill) when
 * folding into an active order, and stamp a full computeBill breakdown
 * (applyNewOrderBill) when creating a fresh order.
 */

// idGenerator pulls in ESM-only uuid; not needed for bill math.
jest.mock('../utils/idGenerator', () => ({ orderId: () => 'ORD-T', takeawayOrderId: () => 'TK-T' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// KOT round allocation needs the DB (atomic counter on the order); these
// are pure bill-math tests on plain objects, so stub it out.
jest.mock('../utils/kotRounds', () => ({
  beginAppendRound: jest.fn(async (order, items) => {
    for (const it of items) it.kotNo = 2;
    return { kotNo: 2, ticketNo: 7, sentBy: null, sentAt: new Date() };
  }),
  recordRound: jest.fn(),
}));

const TAXES = {
  gst: { enabled: true, value: 5 },
  serviceCharge: { enabled: true, value: 10 },
  additionalCharges: [
    { name: 'Packaging', type: 'Flat', value: 20, enabled: true },
    { name: 'Green Tax', type: 'Percentage', value: 2, enabled: true },
  ],
};

const mockGetSettings = jest.fn(async () => ({ taxes: TAXES }));
jest.mock('../utils/settingsCache', () => ({
  getSettings: (...args) => mockGetSettings(...args),
}));

const { computeBill, toTaxConfig } = require('../utils/billing');
const { billFieldsForNewOrder } = require('../services/orderBillMath');
const pricing = require('../services/orderPricingService');
const { appendRepeatItemsToOrder } = require('../services/orderItemsService');

const taxConfig = toTaxConfig(TAXES);
const req = { restaurant: { _id: 'r1' } };

function orderWithBill(items, type = 'dine-in') {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const b = computeBill({ subtotal, taxConfig, orderType: type });
  return {
    type,
    createdAt: new Date('2026-01-01'),
    items: items.map((i) => ({ ...i })),
    total: b.total,
    gst: b.gst,
    serviceCharge: b.serviceCharge,
    additionalCharges: b.additionalCharges,
    additionalChargesTotal: b.additionalChargesTotal,
  };
}

beforeEach(() => mockGetSettings.mockClear());

describe('billFieldsForNewOrder', () => {
  test('matches computeBill for a fresh order, including flat charges', () => {
    const f = billFieldsForNewOrder({ subtotal: 300, taxConfig, orderType: 'dine-in' });
    const b = computeBill({ subtotal: 300, taxConfig, orderType: 'dine-in' });
    expect(f.total).toBe(b.total); // 300 + 15 + 30 + 20 + 6 = 371
    expect(f.total).toBe(371);
    expect(f.gst).toBe(15);
    expect(f.serviceCharge).toBe(30);
    expect(f.additionalChargesTotal).toBe(26);
    expect(f.gstPercentage).toBe(5);
    expect(f.serviceChargePercentage).toBe(10);
  });

  test('takeaway gets no service charge', () => {
    const f = billFieldsForNewOrder({ subtotal: 100, taxConfig, orderType: 'takeaway' });
    expect(f.serviceCharge).toBe(0);
    expect(f.total).toBe(100 + 5 + 20 + 2);
  });
});

describe('applyNewOrderBill (repeat → new order)', () => {
  test('stamps taxes on the new order instead of the bare subtotal', async () => {
    const order = { type: 'dine-in', items: [{ name: 'Naan', price: 50, quantity: 2 }], total: 100 };
    await pricing.applyNewOrderBill(req, order);
    const b = computeBill({ subtotal: 100, taxConfig, orderType: 'dine-in' });
    expect(order.total).toBe(b.total);
    expect(order.total).toBeGreaterThan(100);
    expect(order.gst).toBe(5);
    expect(order.serviceCharge).toBe(10);
    expect(order.additionalChargesTotal).toBe(22);
  });

  test('counts selected toppings in the subtotal', async () => {
    const order = {
      type: 'takeaway',
      items: [{ name: 'Pizza', price: 200, quantity: 1, selectedToppings: [{ price: 50 }] }],
    };
    await pricing.applyNewOrderBill(req, order);
    expect(order.total).toBe(computeBill({ subtotal: 250, taxConfig, orderType: 'takeaway' }).total);
  });

  test('falls back to the bare subtotal when settings cannot be read', async () => {
    mockGetSettings.mockRejectedValueOnce(new Error('db down'));
    const order = { type: 'dine-in', items: [{ name: 'Tea', price: 30, quantity: 3 }] };
    await pricing.applyNewOrderBill(req, order);
    expect(order.total).toBe(90);
  });
});

describe('appendRepeatItemsToOrder (repeat → active order)', () => {
  test('repeated items attract GST / service charge; bill equals a from-scratch recompute', async () => {
    const order = orderWithBill([{ name: 'Curry', price: 200, quantity: 1 }]);
    const delta = await appendRepeatItemsToOrder(req, order, [{ name: 'Naan', price: 50, quantity: 2 }], 100);

    const full = computeBill({ subtotal: 300, taxConfig, orderType: 'dine-in' });
    expect(order.total).toBe(full.total);
    expect(order.gst).toBe(full.gst);
    expect(order.serviceCharge).toBe(full.serviceCharge);
    // Flat packaging is per bill — not charged again on the repeat.
    expect(order.additionalChargesTotal).toBe(full.additionalChargesTotal);
    // Delta = 100 items + 5 GST + 10 service + 2 green tax.
    expect(delta).toBe(117);
    expect(order.items).toHaveLength(2);
  });

  test('repeating the same line merges quantity and still taxes the increase', async () => {
    const order = orderWithBill([{ name: 'Naan', price: 50, quantity: 1 }]);
    const before = order.total;
    const delta = await appendRepeatItemsToOrder(req, order, [{ name: 'Naan', price: 50, quantity: 1 }], 50);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(2);
    expect(delta).toBe(50 + 2.5 + 5 + 1);
    expect(order.total).toBe(Math.round((before + delta) * 100) / 100);
  });

  test('preserves coupon / tip already folded into the stored total', async () => {
    const order = orderWithBill([{ name: 'Curry', price: 200, quantity: 1 }]);
    order.total = order.total - 30 + 10; // coupon 30, tip 10
    const delta = await appendRepeatItemsToOrder(req, order, [{ name: 'Rice', price: 100, quantity: 1 }], 100);
    const full = computeBill({ subtotal: 300, taxConfig, orderType: 'dine-in' });
    expect(order.total).toBe(Math.round((full.total - 30 + 10) * 100) / 100);
    expect(delta).toBe(117);
  });

  test('back-fills addedAt on legacy items so the save default does not restamp them', async () => {
    const order = orderWithBill([{ name: 'Curry', price: 200, quantity: 1 }]);
    await appendRepeatItemsToOrder(req, order, [{ name: 'Rice', price: 100, quantity: 1, addedAt: new Date() }], 100);
    expect(order.items[0].addedAt).toEqual(order.createdAt);
  });
});
