/**
 * utils/advanceBookingPricing.applyBookingDetailsEdit — pricing for the
 * admin "Edit booking" drawer (PATCH /advance-booking/:id/details).
 */
const { applyBookingDetailsEdit } = require('../utils/advanceBookingPricing');

const baseBooking = () => ({
  bookingType: 'table',
  cakeDetails: { quantity: 1, flavor: 'Choco', size: '1 kg', isSkipped: false },
  addons: { otherAddons: [{ id: 'a1', title: 'DJ', price: 400, options: [] }] },
  parkingDetails: { vehicleType: 'car', count: 1, timeDuration: '2hrs', isSkipped: false },
  payment: {
    totalAmount: 2000,
    advancePaid: 1000,
    status: 'Partial',
    priceBreakdown: { cake: 500, parking: 100, addon: 400 },
  },
});

describe('applyBookingDetailsEdit', () => {
  test('adds extra cake + add-on and re-prices parking by difference', () => {
    const r = applyBookingDetailsEdit({
      booking: baseBooking(),
      parkingRate: 50,
      edit: {
        cakes: [{ name: 'Choco (1 kg)', price: 0, quantity: 1 }, { name: 'Vanilla', price: 300, quantity: 2 }],
        addons: [{ title: 'DJ', price: 400 }, { title: 'Balloons', price: 150 }],
        parking: { vehicleCount: 2, hours: 3 },
        discount: 0,
      },
    });
    // addons: +150 balloons +600 cakes; parking 2*3*50=300 vs 100 → +200
    expect(r.delta).toBe(950);
    expect(r.total).toBe(2950);
    expect(r.set['addons.otherAddons']).toEqual([
      { id: 'a1', title: 'DJ', price: 400, options: [] },
      { title: 'Balloons', price: 150 },
      { title: 'Cake: Vanilla ×2', price: 600 },
    ]);
    expect(r.set['parkingDetails.count']).toBe(2);
    expect(r.set['parkingDetails.timeDuration']).toBe('3hrs');
    expect(r.set['payment.status']).toBe('Partial');
  });

  test('removing the original cake subtracts its catalog price', () => {
    const r = applyBookingDetailsEdit({ booking: baseBooking(), edit: { cakes: [] } });
    expect(r.set['cakeDetails.isSkipped']).toBe(true);
    expect(r.total).toBe(1500);
  });

  test('discount is capped to the remaining balance; total never below amount paid', () => {
    const r = applyBookingDetailsEdit({ booking: baseBooking(), edit: { discount: 5000 } });
    expect(r.discount).toBe(1000);
    expect(r.total).toBe(1000);
    expect(r.set['payment.status']).toBe('Paid');

    const r2 = applyBookingDetailsEdit({ booking: baseBooking(), edit: { addons: [], cakes: [] } });
    // −400 DJ −500 cake = 1100, still above the 1000 paid
    expect(r2.total).toBe(1100);
  });

  test('hall bookings never bill parking', () => {
    const b = baseBooking();
    b.bookingType = 'hall';
    const r = applyBookingDetailsEdit({ booking: b, parkingRate: 50, edit: { parking: { vehicleCount: 10, hours: 5 } } });
    expect(r.delta).toBe(0);
    expect(r.total).toBe(2000);
  });

  test('a fully paid booking that gains items goes back to Partial', () => {
    const b = baseBooking();
    b.payment.advancePaid = 2000;
    b.payment.status = 'Paid';
    const r = applyBookingDetailsEdit({ booking: b, edit: { addons: [{ title: 'DJ', price: 400 }, { title: 'Host', price: 200 }] } });
    expect(r.total).toBe(2200);
    expect(r.set['payment.status']).toBe('Partial');
  });
});
