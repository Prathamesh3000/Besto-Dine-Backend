/**
 * QA N10 / N11 — multi-vehicle parking with a customer-chosen parking
 * time, end to end:
 *   admin config (PATCH /settings/reservation) → customer offer
 *   (GET /booking-info/parking) → server-priced booking
 *   (POST /advance-booking/create) → read-side normalisation of old
 *   single-type bookings → admin re-price (PATCH /:id/details).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const AdvanceBooking = require(path.join(BACKEND, 'models/advanceBooking'));

const ctx = useIntegrationApp();
let A;
let customer;

// Each booking gets its own date: one table cannot be advance-booked
// twice for the same slot, and these tests are about parking, not
// availability. (Previously every booking used the same date and table.)
let bookingDay = 2;
const tomorrow = () => {
    const d = new Date(Date.now() + bookingDay++ * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
};

const PARKING = {
    vehicles: [
        { id: 'car', label: 'Car', pricePerHour: 60 },
        { id: 'bike', label: 'Bike', pricePerHour: 15 },
    ],
    maxDuration: 4,
    eventHours: 3,
};

const bookingBody = (extra = {}) => ({
    bookingType: 'table',
    selectedDate: tomorrow(),
    selectedTime: '7-8 PM',
    selectedStartTime: '19:00',
    selectedTimeType: 'Dinner',
    guests: 2,
    selectedTypes: [String(A.area._id)],
    selectedTableIds: [String(A.tables.main._id)],
    paymentMethod: 'cash',
    ...extra,
});

const create = (body) => ctx.api.as(customer, A).post('/advance-booking/create').send(body);

beforeAll(async () => {
    A = await seedTenant({ label: 'park' });
    customer = await createCustomer('park');
    const res = await ctx.api.as(A.users.admin).patch('/settings/reservation').send({
        enableLateArrival: true, gracePeriod: '10 min', deductionType: 'flat', priceDeduction: 0,
        parking: PARKING,
    });
    expect(res.status).toBe(200);
});

describe('parking settings', () => {
    test('customer sees the admin-configured vehicle types, max duration and whole-event hours', async () => {
        const res = await ctx.api.as(customer, A).get('/booking-info/parking');
        expect(res.status).toBe(200);
        expect(res.body.parking).toEqual(PARKING);
    });

    test('admin parking settings are validated', async () => {
        const bad = await ctx.api.as(A.users.admin).patch('/settings/reservation').send({
            parking: { vehicles: [{ id: 'car', label: 'Car', pricePerHour: -1 }], maxDuration: 4, eventHours: 3 },
        });
        expect(bad.status).toBe(400);
        const dup = await ctx.api.as(A.users.admin).patch('/settings/reservation').send({
            parking: { vehicles: [{ label: 'Car', pricePerHour: 1 }, { label: 'car', pricePerHour: 2 }] },
        });
        expect(dup.status).toBe(400);
        const hours = await ctx.api.as(A.users.admin).patch('/settings/reservation').send({
            parking: { vehicles: PARKING.vehicles, maxDuration: 30 },
        });
        expect(hours.status).toBe(400);
    });
});

describe('POST /advance-booking/create — multi-vehicle parking', () => {
    test('3 cars + 5 bikes for a chosen 2 hours is priced per type on the server', async () => {
        const res = await create(bookingBody({
            parkingVehicles: [{ vehicleType: 'car', count: 3 }, { vehicleType: 'bike', count: 5 }],
            parkingMode: 'custom', parkingStartTime: '19:30', parkingDuration: 2,
            total: 1, // display-only; the server never trusts it
        }));
        expect(res.status).toBe(201);
        const doc = await AdvanceBooking.findById(res.body.booking._id).lean();
        expect(doc.payment.totalAmount).toBe(510);
        expect(doc.payment.priceBreakdown.parking).toBe(510);
        expect(doc.parkingDetails).toMatchObject({
            vehicleType: 'car', count: 8, timeDuration: '2hrs', mode: 'custom', startTime: '19:30', isSkipped: false,
            vehicles: [
                { vehicleType: 'car', label: 'Car', count: 3, rate: 60, amount: 360 },
                { vehicleType: 'bike', label: 'Bike', count: 5, rate: 15, amount: 150 },
            ],
        });
    });

    test('"whole event" parking is billed at the configured event hours', async () => {
        const res = await create(bookingBody({
            parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingMode: 'event', parkingDuration: 4,
        }));
        expect(res.status).toBe(201);
        const doc = await AdvanceBooking.findById(res.body.booking._id).lean();
        expect(doc.payment.totalAmount).toBe(180);
        expect(doc.parkingDetails).toMatchObject({ mode: 'event', timeDuration: '3hrs', startTime: '19:00' });
    });

    test('legacy single-type request still works', async () => {
        const res = await create(bookingBody({ selectedVehicle: 'bike', vehicleCount: 2, parkingDuration: 1 }));
        expect(res.status).toBe(201);
        const doc = await AdvanceBooking.findById(res.body.booking._id).lean();
        expect(doc.payment.totalAmount).toBe(30);
        expect(doc.parkingDetails.vehicles).toEqual([{ vehicleType: 'bike', label: 'Bike', count: 2, rate: 15, amount: 30 }]);
    });

    test('skipped parking is free and stored as skipped', async () => {
        const res = await create(bookingBody({
            parkingSkipped: true, parkingVehicles: [{ vehicleType: 'car', count: 3 }],
        }));
        expect(res.status).toBe(201);
        const doc = await AdvanceBooking.findById(res.body.booking._id).lean();
        expect(doc.payment.totalAmount).toBe(0);
        expect(doc.parkingDetails.isSkipped).toBe(true);
    });

    test.each([
        ['an unknown vehicle type', { parkingVehicles: [{ vehicleType: 'bus', count: 1 }] }, 'INVALID_PARKING'],
        ['more hours than the admin allows', { parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingDuration: 5 }, 'INVALID_PARKING'],
        ['a non-list parkingVehicles', { parkingVehicles: 'car' }, undefined],
        ['a negative count', { parkingVehicles: [{ vehicleType: 'car', count: -2 }] }, undefined],
        ['too many vehicles of one type', { parkingVehicles: [{ vehicleType: 'car', count: 501 }] }, undefined],
        ['a bad parking mode', { parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingMode: 'forever' }, undefined],
        ['a bad start time', { parkingVehicles: [{ vehicleType: 'car', count: 1 }], parkingStartTime: '7pm' }, undefined],
    ])('rejects %s with 400 and creates nothing', async (_label, extra, code) => {
        const before = await AdvanceBooking.countDocuments({ restaurant: A.restaurant._id });
        const res = await create(bookingBody(extra));
        expect(res.status).toBe(400);
        if (code) expect(res.body.code).toBe(code);
        expect(await AdvanceBooking.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });
});

describe('reading + editing parking', () => {
    let legacy;

    beforeAll(async () => {
        // A booking saved before multi-vehicle parking existed.
        legacy = await AdvanceBooking.create({
            restaurant: A.restaurant._id,
            bookingId: `TBL-LEGACY-${Date.now()}`,
            user: customer._id,
            bookingType: 'table',
            bookingDate: new Date(Date.now() + 3 * 24 * 3600 * 1000),
            bookingTime: '1-2 PM',
            timeSlot: 'Lunch',
            guestCount: 2,
            tables: [A.tables.main._id],
            parkingDetails: { vehicleType: 'car', count: 2, timeDuration: '2hrs', isSkipped: false },
            payment: { totalAmount: 240, priceBreakdown: { parking: 240 } },
            status: 'Confirmed',
        });
    });

    test('old single-type bookings are normalised to a vehicles list on read', async () => {
        const mine = await ctx.api.as(customer, A).get('/advance-booking/my-bookings');
        expect(mine.status).toBe(200);
        const row = mine.body.bookings.find((b) => String(b._id) === String(legacy._id));
        expect(row.parkingDetails.vehicles).toEqual([{ vehicleType: 'car', count: 2 }]);

        const admin = await ctx.api.as(A.users.admin).get(`/advance-booking/${legacy._id}`);
        expect(admin.status).toBe(200);
        expect(admin.body.booking.parkingDetails.vehicles).toEqual([{ vehicleType: 'car', count: 2 }]);
    });

    test('admin edit re-prices every vehicle type by difference', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${legacy._id}/details`).send({
            parking: { vehicles: [{ vehicleType: 'car', count: 2 }, { vehicleType: 'bike', count: 4 }], hours: 3 },
        });
        expect(res.status).toBe(200);
        // (2×60 + 4×15) × 3 = 540 vs 240 → +300
        const doc = await AdvanceBooking.findById(legacy._id).lean();
        expect(doc.payment.totalAmount).toBe(540);
        expect(doc.payment.priceBreakdown.parking).toBe(540);
        expect(doc.parkingDetails).toMatchObject({ count: 6, timeDuration: '3hrs' });
        expect(doc.parkingDetails.vehicles).toHaveLength(2);
    });

    test('admin edit rejects an unknown vehicle type / bad shape', async () => {
        const unknown = await ctx.api.as(A.users.admin).patch(`/advance-booking/${legacy._id}/details`).send({
            parking: { vehicles: [{ vehicleType: 'bus', count: 1 }], hours: 2 },
        });
        expect(unknown.status).toBe(400);
        const shape = await ctx.api.as(A.users.admin).patch(`/advance-booking/${legacy._id}/details`).send({
            parking: { hours: 2 },
        });
        expect(shape.status).toBe(400);
    });
});
