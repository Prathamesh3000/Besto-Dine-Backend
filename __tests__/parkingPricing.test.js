/**
 * QA N10 / N11 — multi-vehicle parking + customer-chosen parking time.
 *
 * utils/parkingConfig (config normalisation, request validation +
 * pricing, read-side normaliser for old single-type bookings) and the
 * parking parts of utils/advanceBookingPricing.
 */
const {
    normalizeParkingConfig,
    parkingConfigFromSettings,
    resolveParkingRequest,
    normalizeParkingDetails,
    DEFAULT_PARKING_VEHICLES,
} = require('../utils/parkingConfig');
const { computeBookingPrice, applyBookingDetailsEdit } = require('../utils/advanceBookingPricing');

const CONFIG = normalizeParkingConfig({
    vehicles: [
        { id: 'car', label: 'Car', pricePerHour: 60 },
        { id: 'bike', label: 'Bike', pricePerHour: 15 },
    ],
    maxDuration: 4,
    eventHours: 3,
});

describe('normalizeParkingConfig', () => {
    test('empty config falls back to the default vehicles and limits', () => {
        const c = normalizeParkingConfig({});
        expect(c.vehicles.map((v) => v.id)).toEqual(DEFAULT_PARKING_VEHICLES.map((v) => v.id));
        expect(c.maxDuration).toBe(6);
        expect(c.eventHours).toBe(3);
    });

    test('drops duplicate / nameless types, clamps junk numbers', () => {
        const c = normalizeParkingConfig({
            vehicles: [{ id: 'Car', label: 'Car', pricePerHour: -5 }, { id: 'car', label: 'Dup', pricePerHour: 1 }, { label: '' }],
            maxDuration: 99,
            eventHours: 0,
        });
        expect(c.vehicles).toEqual([{ id: 'car', label: 'Car', pricePerHour: 0 }]);
        expect(c.maxDuration).toBe(24);
        expect(c.eventHours).toBe(3);
    });

    test('reads Settings.reservation.parking, falls back to a legacy top-level parking', () => {
        expect(parkingConfigFromSettings({ reservation: { parking: { vehicles: [{ id: 'van', label: 'Van', pricePerHour: 70 }] } } }).vehicles)
            .toEqual([{ id: 'van', label: 'Van', pricePerHour: 70 }]);
        expect(parkingConfigFromSettings({ parking: { vehicles: [{ id: 'suv', label: 'SUV', pricePerHour: 80 }], maxDuration: 2 } }))
            .toMatchObject({ vehicles: [{ id: 'suv' }], maxDuration: 2 });
        expect(parkingConfigFromSettings(null).vehicles).toHaveLength(3);
    });
});

describe('resolveParkingRequest', () => {
    test('3 cars + 5 bikes for 2 hours → per-type pricing', () => {
        const r = resolveParkingRequest({
            bookingType: 'table',
            parkingVehicles: [{ vehicleType: 'car', count: 3 }, { vehicleType: 'bike', count: 5 }],
            parkingMode: 'custom', parkingDuration: 2, parkingStartTime: '19:30',
        }, CONFIG);
        expect(r).toEqual({
            vehicles: [
                { vehicleType: 'car', label: 'Car', count: 3, rate: 60, amount: 360 },
                { vehicleType: 'bike', label: 'Bike', count: 5, rate: 15, amount: 150 },
            ],
            hours: 2, mode: 'custom', startTime: '19:30', total: 510,
        });
    });

    test('whole-event mode bills the configured event hours and ignores parkingDuration', () => {
        const r = resolveParkingRequest({
            parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingMode: 'event', parkingDuration: 4, selectedStartTime: '13:00',
        }, CONFIG);
        expect(r).toMatchObject({ hours: 3, mode: 'event', startTime: '13:00', total: 180 });
    });

    test('duplicate rows merge; zero-count rows are dropped', () => {
        const r = resolveParkingRequest({
            parkingVehicles: [{ vehicleType: 'car', count: 1 }, { vehicleType: 'CAR', count: 2 }, { vehicleType: 'bike', count: 0 }],
            parkingDuration: 1,
        }, CONFIG);
        expect(r.vehicles).toEqual([{ vehicleType: 'car', label: 'Car', count: 3, rate: 60, amount: 180 }]);
    });

    test('legacy single-type body still prices', () => {
        expect(resolveParkingRequest({ selectedVehicle: 'car', vehicleCount: 2, parkingDuration: 3 }, CONFIG))
            .toMatchObject({ total: 360, hours: 3, vehicles: [{ vehicleType: 'car', count: 2 }] });
        // No duration → the old 2 hour default.
        expect(resolveParkingRequest({ selectedVehicle: 'bike' }, CONFIG)).toMatchObject({ total: 30, hours: 2 });
    });

    test('no parking: skipped, hall, nothing selected, all-zero rows', () => {
        expect(resolveParkingRequest({ parkingSkipped: true, parkingVehicles: [{ vehicleType: 'car', count: 1 }] }, CONFIG)).toBeNull();
        expect(resolveParkingRequest({ bookingType: 'hall', parkingVehicles: [{ vehicleType: 'car', count: 1 }] }, CONFIG)).toBeNull();
        expect(resolveParkingRequest({}, CONFIG)).toBeNull();
        expect(resolveParkingRequest({ parkingVehicles: [{ vehicleType: 'car', count: 0 }] }, CONFIG)).toBeNull();
    });

    test.each([
        [{ parkingVehicles: [{ vehicleType: 'bus', count: 1 }] }, /not available for vehicle type "bus"/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 5 }, /cannot exceed 4 hours/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 1.5 }, /whole number/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 0 }, /whole number/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: -1 }] }, /negative/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: 501 }] }, /At most 500/],
        [{ parkingVehicles: [{ count: 1 }] }, /needs a vehicle type/],
        [{ parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingStartTime: '25:00' }, /HH:MM/],
    ])('rejects %j', (body, msg) => {
        expect(resolveParkingRequest(body, CONFIG).error).toMatch(msg);
    });
});

describe('computeBookingPrice — parking lines', () => {
    test('Σ rate × count × hours across vehicle types', () => {
        const r = computeBookingPrice({
            bookingType: 'table', guests: 2,
            parking: { lines: [{ rate: 60, count: 3 }, { rate: 15, count: 5 }], hours: 2 },
        });
        expect(r.breakdown.parking).toBe(510);
        expect(r.total).toBe(510);
    });

    test('legacy single-row shape is unchanged', () => {
        expect(computeBookingPrice({ bookingType: 'table', guests: 1, parking: { rate: 50, count: 2, hours: 3 } }).total).toBe(300);
    });

    test('hall bookings never bill parking lines', () => {
        expect(computeBookingPrice({ bookingType: 'hall', guests: 1, parking: { lines: [{ rate: 60, count: 3 }], hours: 2 } }).total).toBe(0);
    });
});

describe('normalizeParkingDetails (read-side backward compatibility)', () => {
    test('old single-type booking gains a one-row vehicles list', () => {
        expect(normalizeParkingDetails({ vehicleType: 'car', count: 2, timeDuration: '3hrs', isSkipped: false }))
            .toMatchObject({ vehicles: [{ vehicleType: 'car', count: 2 }], mode: 'custom', startTime: null, timeDuration: '3hrs' });
    });

    test('new multi-vehicle booking is passed through', () => {
        const pd = { vehicleType: 'car', count: 8, vehicles: [{ vehicleType: 'car', count: 3 }, { vehicleType: 'bike', count: 5 }], mode: 'event' };
        expect(normalizeParkingDetails(pd).vehicles).toHaveLength(2);
        expect(normalizeParkingDetails(pd).mode).toBe('event');
    });

    test('skipped / empty parking → empty list', () => {
        expect(normalizeParkingDetails({ count: 0, isSkipped: true }).vehicles).toEqual([]);
        expect(normalizeParkingDetails(null)).toBeNull();
    });
});

describe('applyBookingDetailsEdit — multi-vehicle parking', () => {
    const booking = () => ({
        bookingType: 'table',
        parkingDetails: {
            vehicleType: 'car', count: 8, timeDuration: '2hrs', mode: 'custom',
            vehicles: [{ vehicleType: 'car', count: 3, rate: 60 }, { vehicleType: 'bike', count: 5, rate: 15 }],
        },
        payment: { totalAmount: 1510, advancePaid: 500, status: 'Partial', priceBreakdown: { parking: 510 } },
    });
    const rates = { car: 60, bike: 15 };

    test('re-prices every vehicle row by difference', () => {
        const r = applyBookingDetailsEdit({
            booking: booking(), parkingRates: rates,
            edit: { parking: { vehicles: [{ vehicleType: 'car', count: 2 }, { vehicleType: 'bike', count: 2 }], hours: 3 } },
        });
        // (2×60 + 2×15) × 3 = 450 vs 510 → −60
        expect(r.delta).toBe(-60);
        expect(r.total).toBe(1450);
        expect(r.set['parkingDetails.vehicles']).toEqual([
            { vehicleType: 'car', count: 2, rate: 60, amount: 360 },
            { vehicleType: 'bike', count: 2, rate: 15, amount: 90 },
        ]);
        expect(r.set['parkingDetails.count']).toBe(4);
        expect(r.set['parkingDetails.timeDuration']).toBe('3hrs');
        expect(r.set['payment.priceBreakdown.parking']).toBe(450);
    });

    test('removing every vehicle refunds the parking line (total floors at the amount paid)', () => {
        const r = applyBookingDetailsEdit({ booking: booking(), parkingRates: rates, edit: { parking: { vehicles: [], hours: 2 } } });
        expect(r.delta).toBe(-510);
        expect(r.total).toBe(1000);
        expect(r.set['parkingDetails.isSkipped']).toBe(true);
    });

    test('legacy vehicleCount edit on a multi-vehicle booking only changes the hours', () => {
        const r = applyBookingDetailsEdit({ booking: booking(), parkingRates: rates, edit: { parking: { vehicleCount: 1, hours: 1 } } });
        // (3×60 + 5×15) × 1 = 255 vs 510
        expect(r.delta).toBe(-255);
        expect(r.set['parkingDetails.count']).toBe(8);
    });

    test('a legacy single-type booking can gain a second vehicle type', () => {
        const b = {
            bookingType: 'table',
            parkingDetails: { vehicleType: 'car', count: 1, timeDuration: '2hrs', isSkipped: false },
            payment: { totalAmount: 1120, advancePaid: 0, priceBreakdown: { parking: 120 } },
        };
        const r = applyBookingDetailsEdit({
            booking: b, parkingRates: rates,
            edit: { parking: { vehicles: [{ vehicleType: 'car', count: 1 }, { vehicleType: 'bike', count: 4 }], hours: 2 } },
        });
        // 120 + 4×15×2 = 240 → +120
        expect(r.delta).toBe(120);
        expect(r.total).toBe(1240);
    });
});
