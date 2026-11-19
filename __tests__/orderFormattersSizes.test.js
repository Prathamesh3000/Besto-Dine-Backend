const { formatLiveOrder, formatKitchenOrder } = require('../services/orderFormatters');

const mk = () => ({
  _id: 'o1', orderId: 'ORD-1', status: 'new', createdAt: new Date(), updatedAt: new Date(),
  table: { _id: 't1', name: 'T5' },
  items: [
    { name: 'Biryani', price: 100, quantity: 1, selectedSizes: [{ name: 'Half' }], selectedToppings: [{ name: 'Raita' }] },
    { name: 'Biryani', price: 180, quantity: 1, selectedSizes: [{ name: 'Full' }] },
    { name: 'Tea', price: 20, quantity: 1 },
  ],
});

test('waiter live order items carry size and toppings (BUG-42)', () => {
  const out = formatLiveOrder(mk());
  expect(out.items[0].selectedSizes).toEqual([{ name: 'Half' }]);
  expect(out.items[0].selectedToppings).toEqual([{ name: 'Raita' }]);
  expect(out.items[1].selectedSizes).toEqual([{ name: 'Full' }]);
  expect(out.items[2].selectedSizes).toEqual([]);
});

test('kitchen (KDS) order items carry the size name', () => {
  const out = formatKitchenOrder(mk(), Date.now(), () => null);
  expect(out.items.map(i => i.selectedSizes.map(s => s.name))).toEqual([['Half'], ['Full'], []]);
});
