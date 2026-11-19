/**
 * STRICT tenant isolation: reservations, advance bookings, halls,
 * decoration packages, booking info catalogue, customer requests,
 * captain and shift routes.
 *
 * Tests whose name starts with "BUG:" document a real cross-tenant
 * reference leak and are EXPECTED TO FAIL until the source is fixed.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, createTable } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const Hall = model('hall');
const DecorationPackage = model('decorationPackage');
const EventType = model('eventType');
const Package = model('package');
const Addon = model('addon');
const AdvanceBooking = model('advanceBooking');
const Reservation = model('reservation');
const Request = model('request');
const Shift = model('shift');
const Table = model('table');
const Area = model('area');
const Order = model('order');
const Notification = model('notification');
const Branch = model('branch');
const User = model('user');

const ctx = useIntegrationApp();
let A; let B; let custA; let custB; let branchA2; const rec = {};
const DENIED = [400, 403, 404];
const DAY = 24 * 3600 * 1000;
const adminA = () => ctx.api.as(A.users.admin);
const text = (res) => JSON.stringify(res.body || {});
const lean = (M, id) => M.findById(id).lean();
const snapOf = async (M, id) => JSON.stringify(await lean(M, id));
const future = (d = 10) => new Date(Date.now() + d * DAY);

beforeAll(async () => {
    A = await seedTenant({ label: 'bk-a' });
    B = await seedTenant({ label: 'bk-b' });
    custA = await createCustomer('bk-a');
    custB = await createCustomer('bk-b', { name: 'B-Booking-Customer', mobile: '9111122222' });
    branchA2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A2', slug: 'a2', isActive: true });
    const ownB = { restaurant: B.restaurant._id, branch: B.branch._id };
    const ownA = { restaurant: A.restaurant._id, branch: A.branch._id };

    rec.hallB = await Hall.create({ ...ownB, name: 'B-Secret-Hall', type: 'Banquet Hall', maxCapacity: 100, basePrice: 5000 });
    rec.hallA = await Hall.create({ ...ownA, name: 'A-Hall', type: 'Banquet Hall', maxCapacity: 100, basePrice: 1000 });
    rec.decorB = await DecorationPackage.create({ ...ownB, name: 'B-Secret-Decor', category: 'Birthday', basePrice: 900 });
    rec.decorA = await DecorationPackage.create({ ...ownA, name: 'A-Decor', category: 'Birthday', basePrice: 100 });
    rec.eventB = await EventType.create({ ...ownB, title: 'B-Secret-Event' });
    rec.eventA = await EventType.create({ ...ownA, title: 'A-Event' });
    rec.pkgB = await Package.create({ ...ownB, name: 'B-Secret-Package', price: 700 });
    rec.pkgA = await Package.create({ ...ownA, name: 'A-Package', price: 70 });
    rec.addonB = await Addon.create({ ...ownB, title: 'B-Secret-Addon', slug: 'b-secret-addon', price: 70 });
    rec.addonA = await Addon.create({ ...ownA, title: 'A-Addon', slug: 'a-addon', price: 7 });
    rec.areaB = await Area.create({ restaurant: B.restaurant._id, branch: B.branch._id, name: 'B-Secret-Area' });
    rec.tableB = await createTable(B, { name: 'B-Secret-Table' });
    rec.tableA = await createTable(A, { name: 'A-Bookable-Table', capacity: 6 });

    rec.bookingB = await AdvanceBooking.create({
        ...ownB, bookingId: 'ADV-BK-B-001', user: custB._id, bookingDate: future(), bookingTime: '20:00', timeSlot: 'Dinner',
        guestCount: 4, payment: { totalAmount: 2000 }, notes: 'B-secret-booking-note',
    });
    rec.resB = await Reservation.create({
        ...ownB, guestName: 'B-Secret-Guest', contactNo: '9222233333', date: future(2), time: '19:00', guestCount: 2,
        table: rec.tableB._id, area: rec.areaB._id, bookedBy: B.users.admin._id,
    });
    rec.reqB = await Request.create({ ...ownB, table: B.tables.main._id, type: 'water' });
    rec.shiftB = await Shift.create({ restaurant: B.restaurant._id, staff: B.users.waiter._id, clockIn: new Date(Date.now() - 3600 * 1000), status: 'active' });
    await settle();
});

// ── Halls ─────────────────────────────────────────────────────────────
describe('hallRoute', () => {
    test("B's halls are not listed for A (admin, customer, guest)", async () => {
        for (const res of [await adminA().get('/halls'), await ctx.api.as(custA, A).get('/halls'), await ctx.api.guest(A).get('/halls')]) {
            expect(res.status).toBe(200);
            expect(text(res)).not.toContain('B-Secret-Hall');
            expect(text(res)).not.toContain(String(rec.hallB._id));
            expect(text(res)).toContain('A-Hall');
        }
    });

    test('PUT / DELETE of a B hall → 404 and B unchanged', async () => {
        const before = await snapOf(Hall, rec.hallB._id);
        expect((await adminA().put(`/halls/${rec.hallB._id}`).send({ name: 'Hijacked', basePrice: 1 })).status).toBe(404);
        expect((await adminA().delete(`/halls/${rec.hallB._id}`)).status).toBe(404);
        expect(await snapOf(Hall, rec.hallB._id)).toBe(before);
    });

    test('creating a hall with restaurant / B branch: stays in A or refused', async () => {
        const ok = await adminA().post('/halls').send({ name: 'A-New-Hall', type: 'Banquet Hall', maxCapacity: 10, basePrice: 10, restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(ok.status).toBe(201);
        expect(String(ok.body.hall.restaurant)).toBe(String(A.restaurant._id));
        const bad = await adminA().post('/halls').send({ name: 'A-Bad-Hall', type: 'Banquet Hall', maxCapacity: 10, basePrice: 10, branch: String(B.branch._id) });
        expect(DENIED).toContain(bad.status);
        expect(await Hall.exists({ name: 'A-Bad-Hall' })).toBeFalsy();
    });

    test("moving A's hall to B's branch / restaurant is refused", async () => {
        const res = await adminA().put(`/halls/${rec.hallA._id}`).send({ branch: String(B.branch._id), restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(DENIED).toContain(res.status);
        const row = await lean(Hall, rec.hallA._id);
        expect(String(row.restaurant)).toBe(String(A.restaurant._id));
        expect(String(row.branch)).toBe(String(A.branch._id));
    });

    test('update with operator keys cannot rewrite the tenant', async () => {
        const res = await adminA().put(`/halls/${rec.hallA._id}`).send({ $set: { restaurant: String(B.restaurant._id) }, 'restaurant': String(B.restaurant._id) });
        expect(res.status).toBeLessThan(500);
        expect(String((await lean(Hall, rec.hallA._id)).restaurant)).toBe(String(A.restaurant._id));
    });

    test('hall CSV import lands in A; B branch field refused; no cross-write', async () => {
        const csv = Buffer.from('name,type,maxCapacity,basePrice\nA-Csv-Hall,Banquet Hall,50,1000');
        const ok = await adminA().post('/halls/import').field('restaurant', String(B.restaurant._id)).attach('file', csv, 'h.csv');
        expect(ok.status).toBeLessThan(500);
        const bad = await adminA().post('/halls/import').field('branch', String(B.branch._id)).attach('file', Buffer.from('name,type,maxCapacity,basePrice\nA-Csv-Bad,Banquet Hall,50,1000'), 'h.csv');
        expect(DENIED).toContain(bad.status);
        expect(await Hall.exists({ name: 'A-Csv-Bad' })).toBeFalsy();
        expect(await Hall.exists({ name: 'A-Csv-Hall', restaurant: B.restaurant._id })).toBeFalsy();
    });

    test('malformed hall ids do not 500', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D']) {
            const r = await adminA().delete(`/halls/${id}`);
            expect(r.status).toBeLessThan(500);
        }
        expect(await Hall.exists({ _id: rec.hallB._id })).toBeTruthy();
    });

    test('positive control: B admin sees its hall', async () => {
        expect(text(await ctx.api.as(B.users.admin).get('/halls'))).toContain('B-Secret-Hall');
    });
});

// ── Decoration packages ───────────────────────────────────────────────
describe('decorationPackageRoute', () => {
    test('list / by-id never expose B decorations', async () => {
        const list = await adminA().get('/decoration-packages');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain('B-Secret-Decor');
        const one = await adminA().get(`/decoration-packages/${rec.decorB._id}`);
        expect(one.status).toBe(404);
        expect(text(one)).not.toContain('B-Secret-Decor');
        expect((await ctx.api.guest(A).get(`/decoration-packages/${rec.decorB._id}`)).status).toBe(404);
    });

    test('PUT / PATCH status / DELETE on a B decoration → 404, B unchanged', async () => {
        const before = await snapOf(DecorationPackage, rec.decorB._id);
        expect((await adminA().put(`/decoration-packages/${rec.decorB._id}`).send({ name: 'X', basePrice: 1 })).status).toBe(404);
        expect((await adminA().patch(`/decoration-packages/${rec.decorB._id}/status`)).status).toBe(404);
        expect((await adminA().delete(`/decoration-packages/${rec.decorB._id}`)).status).toBe(404);
        expect(await snapOf(DecorationPackage, rec.decorB._id)).toBe(before);
    });

    test('create ignores body restaurant', async () => {
        const res = await adminA().post('/decoration-packages').send({ name: 'A-Mass', category: 'Birthday', basePrice: 5, restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(res.status).toBe(201);
        expect(String(res.body.decorPackage.restaurant)).toBe(String(A.restaurant._id));
    });

    test("Regression (fixed 2026-11): creating a decoration package with B's branch id is accepted (branch ref not validated against tenant)", async () => {
        // controllers/decorationPackageController.js createDecorationPackage:
        //   const ownerBranch = pinned || req.body.branch || null;   (no ownership check)
        const res = await adminA().post('/decoration-packages').send({ name: 'A-BBranch-Decor', category: 'Birthday', basePrice: 5, branch: String(B.branch._id) });
        const row = await DecorationPackage.findOne({ name: 'A-BBranch-Decor' }).lean();
        expect(row ? String(row.branch) : null).not.toBe(String(B.branch._id));
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): updating a decoration package to B's branch id is accepted", async () => {
        // controllers/decorationPackageController.js updateDecorationPackage: body.branch passed straight to findOneAndUpdate
        await adminA().put(`/decoration-packages/${rec.decorA._id}`).send({ branch: String(B.branch._id) });
        const row = await lean(DecorationPackage, rec.decorA._id);
        expect(String(row.branch)).not.toBe(String(B.branch._id));
    });

    test('decoration CSV import cannot target B', async () => {
        const res = await adminA().post('/decoration-packages/import').field('restaurant', String(B.restaurant._id)).field('branch', String(B.branch._id))
            .attach('file', Buffer.from('name,category,basePrice\nA-Csv-Decor,Birthday,10'), 'd.csv');
        expect(res.status).toBeLessThan(500);
        expect(await DecorationPackage.exists({ name: 'A-Csv-Decor', restaurant: B.restaurant._id })).toBeFalsy();
        expect(await DecorationPackage.exists({ name: 'A-Csv-Decor', branch: B.branch._id })).toBeFalsy();
    });
});

// ── Booking info (event types / packages / add-ons) ───────────────────
describe('bookingInfoRoute', () => {
    test('catalogue reads never include B rows (admin + customer + guest)', async () => {
        for (const p of ['/booking-info/event-types', '/booking-info/packages', '/booking-info/addons', '/booking-info/addons/admin', '/booking-info/addons/slugs', '/booking-info/decorations', '/booking-info/resources', '/booking-info/cakes', '/booking-info/parking']) {
            for (const res of [await adminA().get(p), await ctx.api.as(custA, A).get(p), await ctx.api.guest(A).get(p)]) {
                expect(res.status).toBeLessThan(500);
                const t = text(res);
                for (const n of ['B-Secret-Event', 'B-Secret-Package', 'B-Secret-Addon', 'b-secret-addon', 'B-Secret-Decor', 'B-Secret-Hall', String(rec.eventB._id), String(rec.pkgB._id), String(rec.addonB._id)]) expect(t).not.toContain(n);
            }
        }
    });

    test('PUT / DELETE on B event types, packages and add-ons → 404 and unchanged', async () => {
        const b = [await snapOf(EventType, rec.eventB._id), await snapOf(Package, rec.pkgB._id), await snapOf(Addon, rec.addonB._id)];
        const rs = [
            await adminA().put(`/booking-info/event-types/${rec.eventB._id}`).send({ title: 'X' }),
            await adminA().delete(`/booking-info/event-types/${rec.eventB._id}`),
            await adminA().put(`/booking-info/packages/${rec.pkgB._id}`).send({ name: 'X', price: 1 }),
            await adminA().delete(`/booking-info/packages/${rec.pkgB._id}`),
            await adminA().put(`/booking-info/addons/${rec.addonB._id}`).send({ title: 'X', price: 1 }),
            await adminA().delete(`/booking-info/addons/${rec.addonB._id}`),
        ];
        for (const r of rs) expect(r.status).toBe(404);
        expect([await snapOf(EventType, rec.eventB._id), await snapOf(Package, rec.pkgB._id), await snapOf(Addon, rec.addonB._id)]).toEqual(b);
    });

    test('create with body restaurant stays in A', async () => {
        const e = await adminA().post('/booking-info/event-types').send({ title: 'A-Mass-Event', restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) });
        expect(e.status).toBe(201);
        expect(String(e.body.eventType.restaurant)).toBe(String(A.restaurant._id));
        const p = await adminA().post('/booking-info/packages').send({ name: 'A-Mass-Pkg', price: 1, restaurant: String(B.restaurant._id) });
        expect(p.status).toBe(201);
        expect(String(p.body.package.restaurant)).toBe(String(A.restaurant._id));
        const a = await adminA().post('/booking-info/addons').send({ title: 'A-Mass-Addon', slug: 'a-mass-addon', price: 1, restaurant: String(B.restaurant._id) });
        expect(a.status).toBe(201);
        expect(String(a.body.addon.restaurant)).toBe(String(A.restaurant._id));
    });

    test("same add-on slug as B's is allowed in A (slug uniqueness is per tenant)", async () => {
        const res = await adminA().post('/booking-info/addons').send({ title: 'A-Same-Slug', slug: 'b-secret-addon', price: 1 });
        expect(res.status).toBe(201);
        expect(String((await lean(Addon, rec.addonB._id)).title)).toBe('B-Secret-Addon');
    });

    test("Regression (fixed 2026-11): event type created with B's branch id is accepted", async () => {
        // controllers/bookingInfoController.js createEventType: ownerBranch = pinned || req.body.branch || null (no ownership check)
        const res = await adminA().post('/booking-info/event-types').send({ title: 'A-BBranch-Event', branch: String(B.branch._id) });
        const row = await EventType.findOne({ title: 'A-BBranch-Event' }).lean();
        expect(row ? String(row.branch) : null).not.toBe(String(B.branch._id));
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): package created with B's branch id is accepted", async () => {
        // controllers/bookingInfoController.js createPackage: same unvalidated body.branch
        const res = await adminA().post('/booking-info/packages').send({ name: 'A-BBranch-Pkg', price: 1, branch: String(B.branch._id) });
        const row = await Package.findOne({ name: 'A-BBranch-Pkg' }).lean();
        expect(row ? String(row.branch) : null).not.toBe(String(B.branch._id));
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): add-on created with B's branch id is accepted", async () => {
        // controllers/bookingInfoController.js createAddon: same unvalidated body.branch
        const res = await adminA().post('/booking-info/addons').send({ title: 'A-BBranch-Addon', slug: 'a-bbranch-addon', price: 1, branch: String(B.branch._id) });
        const row = await Addon.findOne({ slug: 'a-bbranch-addon', restaurant: A.restaurant._id }).lean();
        expect(row ? String(row.branch) : null).not.toBe(String(B.branch._id));
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): updating an event type / package / add-on to B's branch id is accepted", async () => {
        // controllers/bookingInfoController.js updateEventType / updatePackage / updateAddon: body.branch not validated
        await adminA().put(`/booking-info/event-types/${rec.eventA._id}`).send({ branch: String(B.branch._id) });
        await adminA().put(`/booking-info/packages/${rec.pkgA._id}`).send({ branch: String(B.branch._id) });
        await adminA().put(`/booking-info/addons/${rec.addonA._id}`).send({ branch: String(B.branch._id) });
        const rows = [await lean(EventType, rec.eventA._id), await lean(Package, rec.pkgA._id), await lean(Addon, rec.addonA._id)];
        for (const r of rows) expect(String(r.branch)).not.toBe(String(B.branch._id));
    });

    test('CSV imports (event types / packages) cannot write into B', async () => {
        const e = await adminA().post('/booking-info/event-types/import').field('restaurant', String(B.restaurant._id)).field('branch', String(B.branch._id))
            .attach('file', Buffer.from('title\nA-Csv-Event'), 'e.csv');
        const p = await adminA().post('/booking-info/packages/import').field('restaurant', String(B.restaurant._id)).field('branch', String(B.branch._id))
            .attach('file', Buffer.from('name,price\nA-Csv-Pkg,10'), 'p.csv');
        expect(e.status).toBeLessThan(500);
        expect(p.status).toBeLessThan(500);
        expect(await EventType.exists({ title: 'A-Csv-Event', $or: [{ restaurant: B.restaurant._id }, { branch: B.branch._id }] })).toBeFalsy();
        expect(await Package.exists({ name: 'A-Csv-Pkg', $or: [{ restaurant: B.restaurant._id }, { branch: B.branch._id }] })).toBeFalsy();
    });

    test('positive control: B admin sees its catalogue', async () => {
        expect(text(await ctx.api.as(B.users.admin).get('/booking-info/event-types'))).toContain('B-Secret-Event');
    });
});

// ── Advance bookings ──────────────────────────────────────────────────
describe('advanceBookingRoute', () => {
    const body = (extra) => ({
        bookingType: 'table', selectedDate: future(5).toISOString(), selectedTime: '7:00 PM', guests: 2,
        selectedTableIds: [String(rec.tableA._id)], paymentMethod: 'cash', ...extra,
    });
    const create = (user, tenant, b, key) => ctx.api.as(user, tenant).post('/advance-booking/create').set('Idempotency-Key', key || `k-${Math.random().toString(36).slice(2)}`).send(b);

    test("B's bookings are not listed / readable by A admin", async () => {
        const list = await adminA().get('/advance-booking/all');
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain('ADV-BK-B-001');
        expect(text(list)).not.toContain('B-secret-booking-note');
        const one = await adminA().get(`/advance-booking/${rec.bookingB._id}`);
        expect(one.status).toBe(404);
        expect(text(one)).not.toContain('B-Booking-Customer');
    });

    test('status / details / delete on a B booking → 404 and B unchanged', async () => {
        const before = await snapOf(AdvanceBooking, rec.bookingB._id);
        const rs = [
            await adminA().patch(`/advance-booking/${rec.bookingB._id}/status`).send({ status: 'Cancelled' }),
            await adminA().patch(`/advance-booking/${rec.bookingB._id}/details`).send({ discount: 9999 }),
            await adminA().delete(`/advance-booking/${rec.bookingB._id}`),
        ];
        for (const r of rs) expect(DENIED).toContain(r.status);
        expect(await snapOf(AdvanceBooking, rec.bookingB._id)).toBe(before);
    });

    test("an A customer cannot preview / cancel / pay B's booking, nor see it in my-bookings", async () => {
        const before = await snapOf(AdvanceBooking, rec.bookingB._id);
        const c = ctx.api.as(custA, A);
        for (const r of [
            await c.get(`/advance-booking/${rec.bookingB._id}/cancel-preview`),
            await c.post(`/advance-booking/${rec.bookingB._id}/cancel`).send({}),
            await c.post(`/advance-booking/${rec.bookingB._id}/create-remaining-payment`).send({}),
            await c.post(`/advance-booking/${rec.bookingB._id}/verify-remaining-payment`).send({ razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' }),
        ]) expect(DENIED).toContain(r.status);
        expect(text(await c.get('/advance-booking/my-bookings'))).not.toContain('ADV-BK-B-001');
        expect(await snapOf(AdvanceBooking, rec.bookingB._id)).toBe(before);
    });

    test("B's own customer with the A slug cannot reach B's booking", async () => {
        const c = ctx.api.as(custB, A);
        const r = await c.post(`/advance-booking/${rec.bookingB._id}/cancel`).send({});
        expect(DENIED).toContain(r.status);
        expect((await lean(AdvanceBooking, rec.bookingB._id)).status).not.toBe('Cancelled');
    });

    test('positive control: A customer can book A table', async () => {
        const res = await create(custA, A, body());
        expect(res.status).toBe(201);
        rec.bookingA = res.body.booking || res.body.data || res.body;
        const row = await AdvanceBooking.findOne({ user: custA._id, restaurant: A.restaurant._id }).lean();
        expect(row).toBeTruthy();
    });

    test("hall booking with B's hall id → 404 and nothing created", async () => {
        const res = await create(custA, A, { bookingType: 'hall', selectedDate: future(6).toISOString(), selectedTime: '7:00 PM', guests: 10, selectedHallId: String(rec.hallB._id) });
        expect(res.status).toBe(404);
        expect(await AdvanceBooking.countDocuments({ hall: rec.hallB._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test('mass-assigned restaurant in the create body does not move the booking to B', async () => {
        const res = await create(custA, A, body({ selectedDate: future(7).toISOString(), restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id) }));
        expect(res.status).toBeLessThan(500);
        expect(await AdvanceBooking.countDocuments({ user: custA._id, restaurant: B.restaurant._id })).toBe(0);
    });

    test("Regression (fixed 2026-11): a table booking naming B's table id is accepted and stores the foreign table ref", async () => {
        // controllers/advanceBookingController.js createAdvanceBooking: `tables: selectedTableIds.filter(isValid)`
        // is stored without verifying each table belongs to this tenant (only the FIRST id is read, for the branch).
        const res = await create(custA, A, body({ selectedDate: future(8).toISOString(), selectedTableIds: [String(rec.tableB._id)] }));
        const stored = await AdvanceBooking.findOne({ tables: rec.tableB._id, restaurant: A.restaurant._id }).lean();
        expect(stored).toBeFalsy();
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): a table booking mixing A's and B's table ids stores the foreign id", async () => {
        // same root cause: ids after the first are never checked
        const res = await create(custA, A, body({ selectedDate: future(9).toISOString(), selectedTableIds: [String(rec.tableA._id), String(rec.tableB._id)] }));
        const stored = await AdvanceBooking.findOne({ tables: rec.tableB._id, restaurant: A.restaurant._id }).lean();
        expect(stored).toBeFalsy();
        expect(DENIED).toContain(res.status);
    });

    test("Regression (fixed 2026-11): a hall booking naming B's package id stores the foreign package ref", async () => {
        // controllers/advanceBookingController.js: `package: selectedPackage?._id || selectedPackage?.id` stored unchecked
        // (price lookup is tenant-scoped, the reference itself is not validated).
        const res = await create(custA, A, { bookingType: 'hall', selectedDate: future(11).toISOString(), selectedTime: '7:00 PM', guests: 10, selectedHallId: String(rec.hallA._id), selectedPackage: { _id: String(rec.pkgB._id) } });
        const stored = await AdvanceBooking.findOne({ package: rec.pkgB._id, restaurant: A.restaurant._id }).lean();
        expect(stored).toBeFalsy();
        expect(DENIED).toContain(res.status);
    });

    test("B's decoration / add-on ids in a booking are not priced or echoed", async () => {
        const res = await create(custA, A, { bookingType: 'hall', selectedDate: future(12).toISOString(), selectedTime: '7:00 PM', guests: 10, selectedHallId: String(rec.hallA._id), selectedDecor: { id: String(rec.decorB._id) }, selectedAddons: [String(rec.addonB._id)] });
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain('B-Secret-Decor');
        expect(text(res)).not.toContain('B-Secret-Addon');
        const row = await AdvanceBooking.findOne({ user: custA._id, hall: rec.hallA._id, bookingDate: { $gte: future(11.5) } }).lean();
        if (row) {
            expect(row.payment.totalAmount).toBe(1000);
            expect(JSON.stringify(row.addons)).not.toContain('B-Secret');
        }
    });
});

// ── Reservations ──────────────────────────────────────────────────────
describe('reservationRoute', () => {
    test("B's reservations are not listed for A admin / A waiter / A customer", async () => {
        for (const u of [A.users.admin, A.users.waiter]) {
            const res = await ctx.api.as(u).get('/reservations');
            expect(res.status).toBe(200);
            expect(text(res)).not.toContain('B-Secret-Guest');
            expect(text(res)).not.toContain('9222233333');
            expect(text(res)).not.toContain('B-Secret-Table');
        }
        expect(text(await ctx.api.as(custA, A).get('/reservations'))).not.toContain('B-Secret-Guest');
    });

    test('status / cancel / late-deduction on a B reservation → 404 and unchanged', async () => {
        const before = await snapOf(Reservation, rec.resB._id);
        const tBefore = await snapOf(Table, rec.tableB._id);
        const rs = [
            await adminA().put(`/reservations/${rec.resB._id}/status`).send({ status: 'Cancelled' }),
            await adminA().put(`/reservations/${rec.resB._id}/cancel`).send({}),
            await adminA().patch(`/reservations/${rec.resB._id}/late-deduction`).send({ deductionAmount: 10 }),
        ];
        for (const r of rs) expect(DENIED).toContain(r.status);
        expect(await snapOf(Reservation, rec.resB._id)).toBe(before);
        expect(await snapOf(Table, rec.tableB._id)).toBe(tBefore);
    });

    test("staff reservation on B's table → 404, B table not claimed", async () => {
        const tBefore = await snapOf(Table, rec.tableB._id);
        const res = await adminA().post('/reservations').send({ guestName: 'Intruder', contactNo: '9333344444', date: future(3).toISOString(), time: '8:00 PM', guestCount: 2, selectedArea: String(A.area._id), selectedTable: String(rec.tableB._id) });
        expect(DENIED).toContain(res.status);
        expect(await snapOf(Table, rec.tableB._id)).toBe(tBefore);
        expect(await Reservation.countDocuments({ table: rec.tableB._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test("customer reservation on B's table → refused, B table not claimed", async () => {
        const tBefore = await snapOf(Table, rec.tableB._id);
        const res = await ctx.api.as(custA, A).post('/reservations/customer').send({ date: future(3).toISOString(), time: '8:00 PM', guestCount: 2, selectedArea: String(A.area._id), selectedTable: String(rec.tableB._id) });
        expect(DENIED).toContain(res.status);
        expect(await snapOf(Table, rec.tableB._id)).toBe(tBefore);
    });

    test('positive control: staff reservation on an A table works and is tenant A', async () => {
        const res = await adminA().post('/reservations').send({ guestName: 'A-Guest', contactNo: '9444455555', date: future(3).toISOString(), time: '8:00 PM', guestCount: 2, selectedArea: String(A.area._id), selectedTable: String(A.tables.main._id), restaurant: String(B.restaurant._id) });
        expect(res.status).toBe(201);
        const row = await Reservation.findOne({ guestName: 'A-Guest' }).lean();
        expect(String(row.restaurant)).toBe(String(A.restaurant._id));
    });

    test("Regression (fixed 2026-11): reservation on an A table with B's area id stores the foreign area ref", async () => {
        // controllers/reservationController.js createReservation: `area: selectedArea` saved without checking the
        // area belongs to this tenant (only selectedTable is looked up).
        const res = await adminA().post('/reservations').send({ guestName: 'A-XArea', contactNo: '9555566666', date: future(4).toISOString(), time: '9:00 PM', guestCount: 2, selectedArea: String(rec.areaB._id), selectedTable: String((await createTable(A, { name: 'A-XArea-Table', capacity: 4 }))._id) });
        const row = await Reservation.findOne({ guestName: 'A-XArea' }).lean();
        expect(row ? String(row.area) : null).not.toBe(String(rec.areaB._id));
        expect(DENIED).toContain(res.status);
    });

    test('non-ObjectId ids are rejected', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D']) {
            expect((await adminA().put(`/reservations/${id}/cancel`).send({})).status).toBeLessThan(500);
            expect((await adminA().put(`/reservations/${id}/status`).send({ status: 'Approved' })).status).toBeLessThan(500);
        }
    });
});

// ── Customer requests ─────────────────────────────────────────────────
describe('requestRoute', () => {
    test("A waiter cannot list or accept B's table requests", async () => {
        const list = await ctx.api.as(A.users.waiter).get('/requests');
        expect(text(list)).not.toContain(String(rec.reqB._id));
        const before = await snapOf(Request, rec.reqB._id);
        const res = await ctx.api.as(A.users.waiter).put(`/requests/${rec.reqB._id}/status`).send({ status: 'accepted' });
        expect(DENIED).toContain(res.status);
        expect(await snapOf(Request, rec.reqB._id)).toBe(before);
    });

    test("a guest at A cannot raise a request on B's table", async () => {
        const res = await ctx.api.guest(A).post('/requests').send({ tableId: String(B.tables.main._id), type: 'water' });
        expect(DENIED.concat([401, 409])).toContain(res.status);
        expect(await Request.countDocuments({ table: B.tables.main._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test("a B scan token replayed on A's slug cannot raise a request on B's table", async () => {
        const { scanTable } = require('./helpers/http');
        const { scanToken } = await scanTable(ctx.api, B.tables.main, { 'X-Restaurant-Slug': B.slug });
        const res = await ctx.api.guest(A, scanToken).post('/requests').send({ tableId: String(B.tables.main._id), type: 'water' });
        expect(DENIED.concat([401, 409])).toContain(res.status);
        expect(await Request.countDocuments({ table: B.tables.main._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test("polling B's table requests from A's slug returns nothing", async () => {
        const res = await ctx.api.guest(A).get(`/requests/active/table/${B.tables.main._id}`);
        expect(text(res)).not.toContain(String(rec.reqB._id));
    });

    test('Regression (fixed 2026-11): a non-ObjectId tableId on the public table-requests poll is a 500 (CastError), not a 400', async () => {
        // controllers/requestController.js getActiveRequestsForTable: params.tableId goes straight into
        // Request.find({ table }) with no ObjectId validation in routes/requestRoute.js (unauthenticated route).
        const inj = await ctx.api.guest(A).get('/requests/active/table/%7B%22%24ne%22%3Anull%7D');
        expect(inj.status).toBeLessThan(500);
        const abc = await ctx.api.guest(A).get('/requests/active/table/abc');
        expect(abc.status).toBeLessThan(500);
    });

    test("admin assigning a B waiter on accept is refused", async () => {
        const mine = await Request.create({ restaurant: A.restaurant._id, branch: A.branch._id, table: A.tables.main._id, type: 'water' });
        const res = await adminA().put(`/requests/${mine._id}/status`).send({ status: 'accepted', waiterId: String(B.users.waiter._id) });
        expect(res.status).toBe(400);
        expect((await lean(Request, mine._id)).waiter || null).toBeFalsy();
    });
});

// ── Captain / shift ───────────────────────────────────────────────────
describe('captainRoute + shiftRoute', () => {
    test('floor overview and waiters list contain only A people and tables', async () => {
        const cap = ctx.api.as(A.users.captain);
        for (const p of ['/captain/floor-overview', '/captain/waiters']) {
            const res = await cap.get(p);
            expect(res.status).toBeLessThan(500);
            const t = text(res);
            for (const n of [String(B.users.waiter._id), String(B.tables.main._id), `waiter ${B.label}`, String(rec.reqB._id)]) expect(t).not.toContain(n);
        }
    });

    test("escalation by A's captain is stored on A only and never delivered to B admin", async () => {
        const res = await ctx.api.as(A.users.captain).post('/captain/escalate').send({ reason: 'A-escalation-xyz', orderId: String(B.users.admin._id) });
        expect(res.status).toBe(201);
        expect(await Notification.countDocuments({ title: /Escalation/, restaurant: B.restaurant._id })).toBe(0);
        expect(text(await ctx.api.as(B.users.admin).get('/notifications'))).not.toContain('A-escalation-xyz');
    });

    test("force clock-out of B's shift by A admin → 404; B shift stays active", async () => {
        const before = await snapOf(Shift, rec.shiftB._id);
        const res = await adminA().post(`/shifts/${rec.shiftB._id}/force-clockout`).send({ note: 'x' });
        expect(DENIED).toContain(res.status);
        expect(await snapOf(Shift, rec.shiftB._id)).toBe(before);
    });

    test("A admin reading B waiter's shifts by user id gets nothing of B's", async () => {
        const res = await adminA().get(`/shifts/staff/${B.users.waiter._id}`);
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain(String(rec.shiftB._id));
        const sub = await createUser({ name: 'A sub', email: `sub.bk.${A.slug}@staff.test`, role: 'admin', restaurant: A.restaurant._id, branch: branchA2._id, permissions: {} });
        const r2 = await ctx.api.as(sub).get(`/shifts/staff/${B.users.waiter._id}`);
        expect(DENIED).toContain(r2.status);
    });

    test("/shifts/my and handover show only A's shifts and orders", async () => {
        await Order.create({ restaurant: B.restaurant._id, branch: B.branch._id, orderId: 'ORD-BK-HANDOVER', type: 'dine-in', table: B.tables.main._id, items: [{ menuItem: String(B.items.paneer._id), name: 'B-handover-item', price: 9, quantity: 1 }], total: 9, status: 'preparing', paymentStatus: 'Pending' });
        const cap = ctx.api.as(A.users.captain);
        const h = await cap.get('/shifts/handover');
        expect(h.status).toBeLessThan(500);
        expect(text(h)).not.toContain('ORD-BK-HANDOVER');
        expect(text(h)).not.toContain('B-handover-item');
        const my = await ctx.api.as(A.users.waiter).get('/shifts/my');
        expect(text(my)).not.toContain(String(rec.shiftB._id));
    });

    test('run-autoclose by A admin does not close B shifts', async () => {
        const res = await adminA().post('/shifts/admin/run-autoclose').send({});
        expect(res.status).toBeLessThan(500);
        expect((await lean(Shift, rec.shiftB._id)).status).toBe('active');
    });

    test('A waiter clock-in / clock-out creates and closes only A shifts', async () => {
        await ctx.api.as(A.users.waiter).post('/shifts/clock-in').send({ note: 'hi', restaurant: String(B.restaurant._id) });
        await ctx.api.as(A.users.waiter).post('/shifts/clock-out').send({ note: 'bye', restaurant: String(B.restaurant._id) });
        expect(await Shift.countDocuments({ staff: A.users.waiter._id, restaurant: B.restaurant._id })).toBe(0);
        expect((await lean(Shift, rec.shiftB._id)).status).toBe('active');
    });

    test('malformed shift ids do not 500', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D']) {
            expect((await adminA().post(`/shifts/${id}/force-clockout`).send({})).status).toBeLessThan(500);
            expect((await adminA().get(`/shifts/staff/${id}`)).status).toBeLessThan(500);
        }
    });
});
