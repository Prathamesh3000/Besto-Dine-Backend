/**
 * utils/advanceBookingPricing.js — server-side advance-booking pricing.
 *
 * bookingDetailsEdit.test.js covers the basic admin edit; paymentSecurity
 * covers resolveBookingPaymentOutcome. This file adds:
 *
 *   - addonLinePrice duration scaling
 *   - computeBookingPrice: hall vs table components, guests, cake, parking
 *     (multi-row + legacy), coupon / points caps, total floor, advance
 *   - loadBookingPrice: every price from the tenant catalog (client prices
 *     ignored), tenant filter on every lookup, invalid ids, de-duplicated
 *     add-ons, parking validation errors, coupon re-validation
 *   - applyBookingDetailsEdit: add-on replacement, extra / removed cakes,
 *     multi-vehicle + legacy parking, hall bookings, discount cap, the
 *     never-below-paid floor and payment status
 *
 * Catalog models are mocked; parkingConfig and couponScope run for real.
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */

// ── Mocks ────────────────────────────────────────────────────────────
const mockModel = () => ({ findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() });
const mockHall = mockModel();
const mockPackage = mockModel();
const mockMenuItem = mockModel();
const mockDecor = mockModel();
const mockAddon = mockModel();
const mockCoupon = mockModel();
const mockRedemption = mockModel();
jest.mock('../models/hall', () => mockHall);
jest.mock('../models/package', () => mockPackage);
jest.mock('../models/menuItem', () => mockMenuItem);
jest.mock('../models/decorationPackage', () => mockDecor);
jest.mock('../models/addon', () => mockAddon);
jest.mock('../models/coupon', () => mockCoupon);
jest.mock('../models/couponRedemption', () => mockRedemption);

const {
    computeBookingPrice, addonLinePrice, loadBookingPrice, applyBookingDetailsEdit,
} = require('../utils/advanceBookingPricing');

// ── Helpers ──────────────────────────────────────────────────────────
const TF = { restaurant: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
const ID = (n) => String(n).padStart(24, '0');
const queryOf = (v) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
const PARKING = {
    vehicles: [
        { id: 'car', label: 'Car', pricePerHour: 50 },
        { id: 'bike', label: 'Bike', pricePerHour: 20 },
    ],
    eventHours: 4,
    maxDuration: 12,
};

beforeEach(() => {
    jest.clearAllMocks();
    for (const m of [mockHall, mockPackage, mockMenuItem, mockDecor]) m.findOne.mockReturnValue(queryOf(null));
    mockAddon.find.mockReturnValue(queryOf([]));
    mockCoupon.findOne.mockResolvedValue(null);
    mockRedemption.countDocuments.mockResolvedValue(0);
});

// ── addonLinePrice ───────────────────────────────────────────────────
describe('addonLinePrice', () => {
    test.each([
        ['photographer', '2', 999, 400],   // 399.6 → whole rupees
        ['dj', 4, 2500, 2000],
        ['host', 'full', 1800, 1800],
        ['photobooth', undefined, 1200, 1200],
        ['balloons', '2', 999, 999],       // not duration-scaled
        ['photographer', '2', -500, 0],
        ['dj', '4', 'abc', 0],
    ])('%s for %p hours at ₹%p costs ₹%i', (slug, duration, price, expected) => {
        expect(addonLinePrice(price, slug, duration)).toBe(expected);
    });
});

// ── computeBookingPrice ──────────────────────────────────────────────
describe('computeBookingPrice', () => {
    test('a hall booking charges hall + package per guest + cake + decoration + add-ons', () => {
        const p = computeBookingPrice({
            bookingType: 'hall', guests: 40.9, hallPrice: 15000, packagePrice: 450.5,
            cake: { unitPrice: 1299.99, quantity: 2 }, decorationPrice: 3500,
            parking: { lines: [{ rate: 50, count: 3 }], hours: 4 },
            addons: [{ price: 5000, slug: 'photographer', duration: '4' }, { price: 750, slug: 'balloons' }],
        });

        expect(p.breakdown).toEqual({
            hall: 15000, package: 18020, cake: 2599.98, decoration: 3500, parking: 0, addon: 4750, discount: 0, points: 0,
        });
        expect(p.subtotal).toBe(43869.98);
        expect(p.total).toBe(43869.98);
        expect(p.advance).toBe(21935);
    });

    test('a table booking ignores hall and package prices but charges parking', () => {
        const p = computeBookingPrice({
            bookingType: 'table', guests: 6, hallPrice: 15000, packagePrice: 500,
            parking: { lines: [{ rate: 50, count: 2 }, { rate: 20, count: 1.9 }], hours: 3 },
        });
        expect(p.breakdown).toMatchObject({ hall: 0, package: 0, parking: 360 }); // (100 + 20) × 3
        expect(p.total).toBe(360);
    });

    test.each([
        ['the legacy single-row shape', { rate: 50, count: 2, hours: 3 }, 300],
        ['a legacy row with no count (one vehicle)', { rate: 50, hours: 2 }, 100],
        ['missing hours (defaults to 2)', { lines: [{ rate: 50, count: 1 }] }, 100],
        ['negative rates and counts', { lines: [{ rate: -50, count: 4 }, { rate: 20, count: -3 }], hours: 5 }, 0],
    ])('parking with %s', (_label, parking, expected) => {
        expect(computeBookingPrice({ bookingType: 'table', parking }).breakdown.parking).toBe(expected);
    });

    test.each([
        [undefined, 1],
        [0, 1],
        [-5, 1],
        ['12', 12],
    ])('guests %p are charged as %i for the package', (guests, charged) => {
        expect(computeBookingPrice({ bookingType: 'hall', guests, packagePrice: 100 }).breakdown.package).toBe(100 * charged);
    });

    test('a cake with no quantity counts one', () => {
        expect(computeBookingPrice({ bookingType: 'table', cake: { unitPrice: 899, quantity: 0 } }).breakdown.cake).toBe(899);
    });

    test('the coupon is capped at the subtotal and points at what is left', () => {
        const base = { bookingType: 'table', decorationPrice: 1000 };
        expect(computeBookingPrice({ ...base, couponDiscount: 300, pointsRupees: 250.555 }))
            .toMatchObject({ total: 449.44, breakdown: expect.objectContaining({ discount: 300, points: 250.56 }) });
        expect(computeBookingPrice({ ...base, couponDiscount: 5000, pointsRupees: 100 }))
            .toMatchObject({ total: 0, breakdown: expect.objectContaining({ discount: 1000, points: 0 }) });
        expect(computeBookingPrice({ ...base, couponDiscount: 400, pointsRupees: 9999 }))
            .toMatchObject({ total: 0, breakdown: expect.objectContaining({ points: 600 }) });
    });

    test('negative discounts never raise the price', () => {
        expect(computeBookingPrice({ bookingType: 'table', decorationPrice: 500, couponDiscount: -100, pointsRupees: -50 }).total).toBe(500);
    });

    test.each([
        [999.99, 500],
        [1001, 501],
        [0, 0],
    ])('the advance on ₹%p is ₹%i', (decorationPrice, advance) => {
        expect(computeBookingPrice({ bookingType: 'table', decorationPrice }).advance).toBe(advance);
    });
});

// ── loadBookingPrice ─────────────────────────────────────────────────
describe('loadBookingPrice', () => {
    const HALL = ID(1); const PKG = ID(2); const CAKE = ID(3); const SIZE = ID(4); const DECOR = ID(5);
    const PHOTO = ID(6); const BALLOON = ID(7);

    function stubCatalog() {
        mockHall.findOne.mockReturnValue(queryOf({ basePrice: 20000 }));
        mockPackage.findOne.mockReturnValue(queryOf({ price: 650 }));
        mockMenuItem.findOne.mockReturnValue(queryOf({ sizes: [{ _id: SIZE, price: 1500 }, { _id: ID(9), price: 900 }] }));
        mockDecor.findOne.mockReturnValue(queryOf({ _id: DECOR, basePrice: 4000, name: 'Floral Arch' }));
        mockAddon.find.mockReturnValue(queryOf([
            { _id: PHOTO, price: 6000, slug: 'photographer', title: 'Photographer' },
            { _id: BALLOON, price: 800, slug: 'balloons', title: 'Balloons' },
        ]));
    }

    const hallBody = (extra = {}) => ({
        bookingType: 'hall', guests: 50,
        selectedHallId: HALL, hallPrice: 1,
        selectedPackage: { _id: PKG, price: 1 },
        selectedFlavor: CAKE, selectedSize: SIZE, quantity: 2,
        selectedDecor: { id: DECOR, basePrice: 1 },
        selectedAddons: [PHOTO, BALLOON, PHOTO, 'not-an-id'],
        addonSelections: { [PHOTO]: { duration: '2', options: ['drone'] } },
        selectedAddonDetails: [{ id: BALLOON, options: ['gold', 3] }],
        ...extra,
    });

    test('prices every component from the tenant catalog and ignores client prices', async () => {
        stubCatalog();

        const r = await loadBookingPrice({ body: hallBody(), tf: TF, userId: null });

        // 20000 + 650×50 + 1500×2 + 4000 + (6000×40% + 800)
        expect(r.breakdown).toMatchObject({ hall: 20000, package: 32500, cake: 3000, decoration: 4000, addon: 3200 });
        expect(r.total).toBe(62700);
        expect(r.lines.decoration).toEqual({ id: DECOR, title: 'Floral Arch', price: 4000 });
        expect(r.lines.addons).toEqual([
            { id: PHOTO, title: 'Photographer', price: 2400, options: ['drone'] },
            { id: BALLOON, title: 'Balloons', price: 800, options: ['gold', '3'] },
        ]);
        expect(r.parkingError).toBeNull();
    });

    test('every catalog lookup is scoped to the tenant and add-on ids are de-duplicated', async () => {
        stubCatalog();
        mockHall.findOne.mockImplementation((f) => queryOf(f.restaurant === TF.restaurant ? { basePrice: 20000 } : null));

        await loadBookingPrice({ body: hallBody(), tf: TF, userId: null });

        for (const m of [mockHall, mockPackage, mockMenuItem, mockDecor]) {
            expect(m.findOne.mock.calls[0][0]).toMatchObject({ restaurant: TF.restaurant });
        }
        expect(mockAddon.find.mock.calls[0][0]).toEqual({ _id: { $in: [PHOTO, BALLOON] }, restaurant: TF.restaurant });
    });

    test('ids that are not ObjectIds are never looked up', async () => {
        await loadBookingPrice({
            body: { bookingType: 'hall', selectedHallId: { $ne: null }, selectedPackageId: 'x', selectedFlavor: 'cake', selectedSize: 's', selectedDecorId: '1' },
            tf: TF,
        });
        for (const m of [mockHall, mockPackage, mockMenuItem, mockDecor]) expect(m.findOne).not.toHaveBeenCalled();
    });

    test('a cake size that is not on the item is not charged', async () => {
        stubCatalog();
        const r = await loadBookingPrice({ body: hallBody({ selectedSize: ID(99) }), tf: TF });
        expect(r.breakdown.cake).toBe(0);
    });

    test('a hall booking ignores parking; a table booking prices it from the config', async () => {
        const vehicles = [{ vehicleType: 'Car', count: 2 }, { vehicleType: 'bike', count: 1 }];

        const hall = await loadBookingPrice({ body: { bookingType: 'hall', parkingVehicles: vehicles, parkingDuration: 3 }, tf: TF, parkingConfig: PARKING });
        const table = await loadBookingPrice({ body: { bookingType: 'table', parkingVehicles: vehicles, parkingDuration: 3 }, tf: TF, parkingConfig: PARKING });

        expect(hall.breakdown.parking).toBe(0);
        expect(table.breakdown.parking).toBe(360); // (50×2 + 20) × 3
        expect(table.lines.parking.vehicles.map((v) => [v.vehicleType, v.count, v.rate])).toEqual([['car', 2, 50], ['bike', 1, 20]]);
    });

    test.each([
        ['an unknown vehicle type', { parkingVehicles: [{ vehicleType: 'truck', count: 1 }] }, /not available/],
        ['fractional hours', { parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 2.5 }, /whole number/],
        ['hours above the maximum', { parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 13 }, /cannot exceed 12/],
        ['a negative count', { parkingVehicles: [{ vehicleType: 'car', count: -1 }] }, /negative/],
    ])('%s is reported as a parking error and not charged', async (_label, extra, message) => {
        const r = await loadBookingPrice({ body: { bookingType: 'table', ...extra }, tf: TF, parkingConfig: PARKING });
        expect(r.parkingError).toMatch(message);
        expect(r.breakdown.parking).toBe(0);
    });

    test('skipped parking is free', async () => {
        const r = await loadBookingPrice({ body: { bookingType: 'table', parkingSkipped: true, parkingVehicles: [{ vehicleType: 'car', count: 5 }] }, tf: TF, parkingConfig: PARKING });
        expect(r.breakdown.parking).toBe(0);
        expect(r.parkingError).toBeNull();
    });

    test('wallet points are converted at the tenant rate and capped at the bill', async () => {
        mockDecor.findOne.mockReturnValue(queryOf({ _id: ID(5), basePrice: 1000, name: 'D' }));
        const body = { bookingType: 'table', selectedDecorId: ID(5) };

        expect((await loadBookingPrice({ body: { ...body, walletPointsUsed: 500 }, tf: TF, pointsToRupee: 0.25 })).total).toBe(875);
        expect((await loadBookingPrice({ body: { ...body, walletPointsUsed: 1e9 }, tf: TF, pointsToRupee: 0.25 })).total).toBe(0);
        expect((await loadBookingPrice({ body: { ...body, walletPointsUsed: -500 }, tf: TF, pointsToRupee: 0.25 })).total).toBe(1000);
    });

    describe('coupon re-validation', () => {
        const DAY = 86400000;
        const coupon = (fields = {}) => ({
            _id: ID(77), code: 'PARTY', isActive: true, discountType: 'percentage', discountValue: 10, maxDiscountAmount: 0,
            minOrderValue: 0, scope: 'all', usageLimit: 0, usageCount: 0, usagePerUser: 0,
            startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY), ...fields,
        });
        const price = async (c, { userId = ID(50), code = 'party' } = {}) => {
            mockDecor.findOne.mockReturnValue(queryOf({ _id: ID(5), basePrice: 2000, name: 'D' }));
            mockCoupon.findOne.mockResolvedValue(c);
            return loadBookingPrice({ body: { bookingType: 'table', selectedDecorId: ID(5), couponCode: code }, tf: TF, userId });
        };

        test('a valid percentage coupon is applied, looked up by normalised code in the tenant', async () => {
            const r = await price(coupon());
            expect(r.breakdown.discount).toBe(200);
            expect(r.total).toBe(1800);
            expect(mockCoupon.findOne).toHaveBeenCalledWith({ code: 'PARTY', isActive: true, restaurant: TF.restaurant });
        });

        test.each([
            ['a capped percentage', { discountValue: 50, maxDiscountAmount: 300 }, 300],
            ['a flat amount', { discountType: 'fixed_amount', discountValue: 250 }, 250],
            ['a flat amount above the bill', { discountType: 'fixed_amount', discountValue: 5000 }, 2000],
        ])('%s gives ₹%i off', async (_label, fields, discount) => {
            expect((await price(coupon(fields))).breakdown.discount).toBe(discount);
        });

        test.each([
            ['unknown', null],
            ['expired', coupon({ endDate: new Date(Date.now() - 1000) })],
            ['not yet started', coupon({ startDate: new Date(Date.now() + DAY) })],
            ['used up', coupon({ usageLimit: 10, usageCount: 10 })],
            ['below its minimum', coupon({ minOrderValue: 2000.01 })],
            ['scoped to food only', coupon({ scope: 'food' })],
        ])('a coupon that is %s gives no discount', async (_label, c) => {
            expect((await price(c)).breakdown.discount).toBe(0);
        });

        test('the per-user limit counts this customer\'s redemptions', async () => {
            mockRedemption.countDocuments.mockResolvedValue(1);
            expect((await price(coupon({ usagePerUser: 1 }))).breakdown.discount).toBe(0);
            expect(mockRedemption.countDocuments).toHaveBeenCalledWith({ coupon: ID(77), user: ID(50) });
        });

        test('no coupon lookup happens for an empty code', async () => {
            await price(coupon(), { code: '' });
            expect(mockCoupon.findOne).not.toHaveBeenCalled();
        });

        // Regression (fixed 2026-10): couponDiscountFor checks the coupon's startTime/endTime window like applyCoupon.
        test('a coupon outside its time-of-day window gives no discount', async () => {
            const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            const from = new Date(Date.now() + 2 * 3600 * 1000);
            const to = new Date(Date.now() + 3 * 3600 * 1000);
            if (hhmm(to) < hhmm(from)) return; // window would wrap midnight

            expect((await price(coupon({ startTime: hhmm(from), endTime: hhmm(to) }))).breakdown.discount).toBe(0);
        });

        // Regression (fixed 2026-10): loadBookingPrice takes the booking branch and couponDiscountFor refuses another branch's coupon.
        test('a coupon pinned to another branch gives no discount', async () => {
            mockDecor.findOne.mockReturnValue(queryOf({ _id: ID(5), basePrice: 2000, name: 'D' }));
            mockCoupon.findOne.mockResolvedValue(coupon({ branch: ID(201) }));

            const r = await loadBookingPrice({
                body: { bookingType: 'table', selectedDecorId: ID(5), couponCode: 'PARTY', branchId: ID(200) },
                tf: TF,
                userId: ID(50),
            });

            expect(r.breakdown.discount).toBe(0);
        });
    });
});

// ── applyBookingDetailsEdit ──────────────────────────────────────────
describe('applyBookingDetailsEdit', () => {
    const booking = (fields = {}) => ({
        bookingType: 'table',
        cakeDetails: { quantity: 1, isSkipped: false },
        addons: { otherAddons: [{ id: 'a1', title: 'Balloons', price: 800, options: ['gold'] }] },
        parkingDetails: { vehicles: [{ vehicleType: 'car', count: 2 }], timeDuration: '2hrs' },
        payment: { totalAmount: 5000, advancePaid: 2500, priceBreakdown: { cake: 1200, parking: 200 } },
        ...fields,
    });

    test('replacing add-ons keeps an unchanged line (with its id and options) and charges the difference', () => {
        const r = applyBookingDetailsEdit({
            booking: booking(),
            edit: { addons: [{ title: 'Balloons', price: 800 }, { title: 'Magician', price: 1499.999 }] },
        });

        expect(r.set['addons.otherAddons']).toEqual([
            { id: 'a1', title: 'Balloons', price: 800, options: ['gold'] },
            { title: 'Magician', price: 1500 },
        ]);
        expect(r.delta).toBe(1500);
        expect(r.total).toBe(6500);
        expect(r.set['payment.status']).toBe('Partial');
    });

    test('extra cakes are added as priced lines; omitting the original cake removes its charge', () => {
        const r = applyBookingDetailsEdit({
            booking: booking(),
            edit: { cakes: [{ name: 'Red Velvet', price: 650, quantity: 2.6 }] },
        });

        expect(r.set['addons.otherAddons']).toEqual([
            { id: 'a1', title: 'Balloons', price: 800, options: ['gold'] },
            { title: 'Cake: Red Velvet ×2', price: 1300 },
        ]);
        expect(r.set['cakeDetails.isSkipped']).toBe(true);
        expect(r.delta).toBe(100); // +1300 extra − 1200 original
        expect(r.total).toBe(5100);
    });

    test('keeping the original cake (a price-0 entry) keeps its charge', () => {
        const r = applyBookingDetailsEdit({ booking: booking(), edit: { cakes: [{ name: 'Original', price: 0 }] } });
        expect(r.set['cakeDetails.isSkipped']).toBeUndefined();
        expect(r.total).toBe(5000);
    });

    test('multi-vehicle parking is re-priced per type and the breakdown updated', () => {
        const r = applyBookingDetailsEdit({
            booking: booking(),
            edit: { parking: { vehicles: [{ vehicleType: 'Car', count: 1 }, { vehicleType: 'car', count: 1 }, { vehicleType: 'bike', count: 3 }], hours: 3 } },
            parkingRates: { car: 50, bike: 20 },
        });

        // (50×2 + 20×3) × 3 = 480; was 200
        expect(r.set['parkingDetails.vehicles']).toEqual([
            { vehicleType: 'car', count: 2, rate: 50, amount: 300 },
            { vehicleType: 'bike', count: 3, rate: 20, amount: 180 },
        ]);
        expect(r.set['parkingDetails.mode']).toBe('custom');
        expect(r.set['payment.priceBreakdown.parking']).toBe(480);
        expect(r.total).toBe(5280);
    });

    test('a legacy count-only edit re-counts the booking\'s vehicle type at the legacy rate', () => {
        const r = applyBookingDetailsEdit({
            booking: booking(),
            edit: { parking: { vehicleCount: 4, hours: 2 } },
            parkingRate: 40,
        });
        expect(r.set['parkingDetails.count']).toBe(4);
        expect(r.total).toBe(5000 - 200 + 320);
    });

    test('a legacy count-only edit on a multi-type booking keeps every row and changes only the hours', () => {
        const r = applyBookingDetailsEdit({
            booking: booking({ parkingDetails: { vehicles: [{ vehicleType: 'car', count: 2 }, { vehicleType: 'bike', count: 1 }], timeDuration: '2hrs' } }),
            edit: { parking: { vehicleCount: 99, hours: 4 } },
            parkingRates: { car: 50, bike: 20 },
        });
        expect(r.set['parkingDetails.count']).toBe(3);
        expect(r.total).toBe(5000 - 200 + 480); // (100 + 20) × 4
    });

    test('an older booking without a stored parking charge is re-priced from its rows', () => {
        const r = applyBookingDetailsEdit({
            booking: booking({ payment: { totalAmount: 5000, advancePaid: 0, priceBreakdown: {} } }),
            edit: { parking: { vehicles: [{ vehicleType: 'car', count: 3 }], hours: 2 } },
            parkingRates: { car: 50 },
        });
        // old charge 50×2×2 = 200, new 50×3×2 = 300
        expect(r.total).toBe(5100);
    });

    test('removing all vehicles skips parking and refunds its charge into the balance', () => {
        const r = applyBookingDetailsEdit({ booking: booking(), edit: { parking: { vehicles: [], hours: 2 } }, parkingRates: { car: 50 } });
        expect(r.set['parkingDetails.isSkipped']).toBe(true);
        expect(r.total).toBe(4800);
    });

    test('a hall booking never charges parking', () => {
        const r = applyBookingDetailsEdit({
            booking: booking({ bookingType: 'hall' }),
            edit: { parking: { vehicles: [{ vehicleType: 'car', count: 10 }], hours: 8 } },
            parkingRates: { car: 50 },
        });
        expect(r.total).toBe(5000);
    });

    test('the one-off discount is capped at the unpaid balance', () => {
        const r = applyBookingDetailsEdit({ booking: booking(), edit: { discount: 9999 } });
        expect(r.discount).toBe(2500);
        expect(r.total).toBe(2500);
        expect(r.set['payment.status']).toBe('Paid');
    });

    test('an edit can never take the total below what was already paid', () => {
        const r = applyBookingDetailsEdit({
            booking: booking({ payment: { totalAmount: 3000, advancePaid: 2800, priceBreakdown: { cake: 1200 } } }),
            edit: { cakes: [] },
        });
        expect(r.total).toBe(2800);
        expect(r.set['payment.status']).toBe('Paid');
    });

    test('an unpaid booking gets no payment status change', () => {
        const r = applyBookingDetailsEdit({ booking: booking({ payment: { totalAmount: 5000 } }), edit: { discount: 100 } });
        expect(r.total).toBe(4900);
        expect(r.set['payment.status']).toBeUndefined();
    });
});
