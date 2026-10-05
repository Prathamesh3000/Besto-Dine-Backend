/**
 * Floor-side flows:
 *   - controllers/reservationController.js — staff + customer table
 *     reservations (capacity, past dates, double booking via the atomic
 *     table claim, the 3-open-bookings cap, identity from the session),
 *     list scope, cancel, status, late-arrival deduction, stale sweep
 *   - controllers/requestController.js — guest table requests (water /
 *     waiter / bill): tenant + table validation, 30 s duplicate
 *     suppression, waiter pre-assignment, staff list / accept / complete,
 *     alert bookkeeping, branch scope
 *   - controllers/captainController.js — floor overview, assignable
 *     waiters, escalation
 *
 * Tests whose name starts with "BUG:" pin behaviour the handlers get
 * wrong today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Reservation = require(path.join(BACKEND, 'models/reservation'));
const Request = require(path.join(BACKEND, 'models/request'));
const Table = require(path.join(BACKEND, 'models/table'));
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Area = require(path.join(BACKEND, 'models/area'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;
let B;
let branch2;      // A's second branch
let area2;
let waiter2;      // waiter pinned to branch2
let captain2;     // captain pinned to branch2

const rid = () => crypto.randomBytes(4).toString('hex');
const dayStr = (days) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
    A = await seedTenant({ label: 'fl-a' });
    B = await seedTenant({ label: 'fl-b' });
    branch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: `second-${rid()}`, isActive: true });
    area2 = await Area.create({ restaurant: A.restaurant._id, branch: branch2._id, name: `Roof ${rid()}` });
    const staff2 = (role) => createUser({
        name: `${role} two`, email: `${role}2.${rid()}@staff.test`, role,
        restaurant: A.restaurant._id, branch: branch2._id, permissions: defaultPermissionsForRole(role),
    });
    waiter2 = await staff2('waiter');
    captain2 = await staff2('captain');
});

// ═════════════════════════════ Reservations ═════════════════════════════

const resBody = (table, extra = {}) => ({
    guestName: 'Walk-in Guest',
    contactNo: '9876543210',
    date: dayStr(1),
    time: '8:00 PM',
    guestCount: 2,
    selectedArea: String(table.area),
    selectedTable: String(table._id),
    notes: 'window seat',
    ...extra,
});

const staffCreate = (user, body) => ctx.api.as(user).post('/reservations').send(body);
const tableStatus = async (t) => (await Table.findById(t._id).lean()).status;

describe('POST /reservations (staff)', () => {
    test('captain reserves a free table: 201, table → reserved, bookedBy = the captain, tenant stamped', async () => {
        const t = await createTable(A, { capacity: 4 });
        const res = await staffCreate(A.users.captain, resBody(t));

        expect(res.status).toBe(201);
        expect(res.body.reservation.table).toMatchObject({ name: t.name, capacity: 4 });
        const doc = await Reservation.findById(res.body.reservation._id).lean();
        expect(doc).toMatchObject({ guestName: 'Walk-in Guest', contactNo: '9876543210', guestCount: 2, status: 'Pending', notes: 'window seat' });
        expect(String(doc.bookedBy)).toBe(String(A.users.captain._id));
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
        expect(await tableStatus(t)).toBe('reserved');
        await settle();
        expect(await Notification.countDocuments({ restaurant: A.restaurant._id, title: 'New Reservation', description: new RegExp(t.name) })).toBe(1);
    });

    test.each([
        ['more guests than the table seats', { guestCount: 5 }, 400],
        ['a date in the past', { date: dayStr(-1) }, 400],
        ['an unparsable date', { date: 'someday' }, 400],
        ['a missing contact number', { contactNo: '' }, 400],
        ['zero guests', { guestCount: 0 }, 400],
        ['201 guests', { guestCount: 201 }, 400],
        ['a malformed table id', { selectedTable: 'abc' }, 400],
    ])('refuses %s and leaves the table free', async (_label, extra, status) => {
        const t = await createTable(A, { capacity: 4 });
        const before = await Reservation.countDocuments({ restaurant: A.restaurant._id });
        const res = await staffCreate(A.users.captain, resBody(t, extra));
        expect(res.status).toBe(status);
        expect(await Reservation.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
        expect(await tableStatus(t)).toBe('free');
    });

    test('today is allowed; exactly the table capacity is allowed', async () => {
        const t = await createTable(A, { capacity: 4 });
        const res = await staffCreate(A.users.captain, resBody(t, { date: new Date().toISOString().slice(0, 10), guestCount: 4 }));
        expect(res.status).toBe(201);
    });

    test('another tenant’s table is a 404; a disabled table is refused', async () => {
        const tb = await createTable(B);
        expect((await staffCreate(A.users.captain, resBody(tb))).status).toBe(404);
        expect(await tableStatus(tb)).toBe('free');

        const off = await createTable(A);
        await Table.updateOne({ _id: off._id }, { $set: { status: 'disabled' } });
        const res = await staffCreate(A.users.captain, resBody(off));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Cannot reserve a disabled table.');
    });

    test('a reserved table cannot be reserved again (409); concurrent attempts: exactly one wins', async () => {
        const t = await createTable(A);
        expect((await staffCreate(A.users.captain, resBody(t))).status).toBe(201);
        const again = await staffCreate(A.users.captain, resBody(t, { guestName: 'Second Party' }));
        expect(again.status).toBe(409);

        const t2 = await createTable(A);
        const results = await Promise.all([1, 2, 3].map((i) => staffCreate(A.users.captain, resBody(t2, { guestName: `Racer ${i}` }))));
        expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
        expect(await Reservation.countDocuments({ table: t2._id })).toBe(1);
    });

    test('waiters (no reservation permission), chefs and customers cannot use the staff route', async () => {
        const t = await createTable(A);
        const cust = await createCustomer('fl-res-staffroute');
        expect((await staffCreate(A.users.waiter, resBody(t))).status).toBe(403);
        expect((await staffCreate(A.users.chef, resBody(t))).status).toBe(403);
        expect((await ctx.api.as(cust, A).post('/reservations').send(resBody(t))).status).toBe(403);
        expect(await tableStatus(t)).toBe('free');
    });
});

describe('POST /reservations/customer', () => {
    test('identity comes from the session, never from the body', async () => {
        const cust = await createCustomer('fl-res-cust', { mobile: '9000000001' });
        const t = await createTable(A);
        const res = await ctx.api.as(cust, A).post('/reservations/customer')
            .send(resBody(t, { guestName: 'Someone Else', contactNo: '1111111111', bookedBy: String(A.users.admin._id) }));

        expect(res.status).toBe(201);
        const doc = await Reservation.findById(res.body.reservation._id).lean();
        expect(doc.guestName).toBe(cust.name);
        expect(doc.contactNo).toBe('9000000001');
        expect(String(doc.bookedBy)).toBe(String(cust._id));
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
    });

    test('no mobile on the profile and none in the body → 400 CONTACT_REQUIRED', async () => {
        const cust = await createCustomer('fl-res-nomob');
        const t = await createTable(A);
        const res = await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t, { contactNo: undefined }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONTACT_REQUIRED');
    });

    test('a 4th upcoming booking is refused with 429; cancelled ones do not count', async () => {
        const cust = await createCustomer('fl-res-cap', { mobile: '9000000002' });
        for (let i = 0; i < 3; i += 1) {
            const t = await createTable(A);
            expect((await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t))).status).toBe(201);
        }
        const t4 = await createTable(A);
        const res = await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t4));
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('TOO_MANY_RESERVATIONS');
        expect(await tableStatus(t4)).toBe('free');

        const one = await Reservation.findOne({ bookedBy: cust._id });
        await Reservation.updateOne({ _id: one._id }, { $set: { status: 'Cancelled' } });
        expect((await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t4))).status).toBe(201);
    });

    test('a guest without login cannot book', async () => {
        const t = await createTable(A);
        expect((await ctx.api.guest(A).post('/reservations/customer').send(resBody(t))).status).toBe(401);
    });
});

describe('GET /reservations — scope', () => {
    let mine;
    let theirs;
    let cust;

    beforeAll(async () => {
        cust = await createCustomer('fl-res-list', { mobile: '9000000003' });
        const other = await createCustomer('fl-res-list2', { mobile: '9000000004' });
        const t1 = await createTable(A);
        const t2 = await createTable(A);
        mine = (await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t1))).body.reservation;
        theirs = (await ctx.api.as(other, A).post('/reservations/customer').send(resBody(t2))).body.reservation;
        expect(mine && theirs).toBeTruthy();
    });

    test('a customer sees only their own reservation', async () => {
        const res = await ctx.api.as(cust, A).get('/reservations');
        expect(res.status).toBe(200);
        expect(res.body.reservations.map((r) => String(r._id))).toEqual([String(mine._id)]);
    });

    test('the tenant owner sees every reservation of the tenant and none of another tenant', async () => {
        const res = await ctx.api.as(A.users.admin).get('/reservations');
        const ids = res.body.reservations.map((r) => String(r._id));
        expect(ids).toEqual(expect.arrayContaining([String(mine._id), String(theirs._id)]));
        const bRes = await ctx.api.as(B.users.admin).get('/reservations');
        expect(bRes.body.reservations.map((r) => String(r._id))).not.toContain(String(mine._id));
    });

    test('branch-pinned staff see the reservations of their own branch’s tables', async () => {
        // Regression (fixed 2026-10): createReservation stamps the reserved table’s branch on the reservation.
        const t = await createTable(A);   // main branch
        const made = await staffCreate(A.users.captain, resBody(t));
        expect(made.status).toBe(201);

        const res = await ctx.api.as(A.users.captain).get('/reservations');
        expect(res.status).toBe(200);
        expect(res.body.reservations.map((r) => String(r._id))).toContain(String(made.body.reservation._id));
    });
});

describe('cancel / status / late deduction', () => {
    test('staff cancel frees the table and its seats; another tenant gets 404', async () => {
        const t = await createTable(A);
        const made = await staffCreate(A.users.captain, resBody(t));
        const id = made.body.reservation._id;

        expect((await ctx.api.as(B.users.admin).put(`/reservations/${id}/cancel`).send({})).status).toBe(404);
        expect(await tableStatus(t)).toBe('reserved');

        const res = await ctx.api.as(A.users.captain).put(`/reservations/${id}/cancel`).send({});
        expect(res.status).toBe(200);
        expect((await Reservation.findById(id).lean()).status).toBe('Cancelled');
        const tbl = await Table.findById(t._id).select('+seats').lean();
        expect(tbl.status).toBe('free');
        expect(tbl.seats).toEqual([]);
    });

    test('the customer who made a reservation cannot cancel it (cancel is staff-only)', async () => {
        const cust = await createCustomer('fl-res-cxl', { mobile: '9000000005' });
        const t = await createTable(A);
        const made = await ctx.api.as(cust, A).post('/reservations/customer').send(resBody(t));
        const res = await ctx.api.as(cust, A).put(`/reservations/${made.body.reservation._id}/cancel`).send({});
        expect(res.status).toBe(403);
        expect(await tableStatus(t)).toBe('reserved');
    });

    test('status update validates the enum and is tenant scoped', async () => {
        const t = await createTable(A);
        const id = (await staffCreate(A.users.captain, resBody(t))).body.reservation._id;
        expect((await ctx.api.as(A.users.captain).put(`/reservations/${id}/status`).send({ status: 'Confirmed' })).status).toBe(400);
        expect((await ctx.api.as(B.users.admin).put(`/reservations/${id}/status`).send({ status: 'Approved' })).status).toBe(404);
        const ok = await ctx.api.as(A.users.captain).put(`/reservations/${id}/status`).send({ status: 'Approved' });
        expect(ok.status).toBe(200);
        expect((await Reservation.findById(id).lean()).status).toBe('Approved');
    });

    test('setting a reservation to Cancelled via PUT /:id/status frees its table', async () => {
        // Regression (fixed 2026-10): updateReservationStatus releases the reserved table on Cancelled / Completed.
        const t = await createTable(A);
        const id = (await staffCreate(A.users.captain, resBody(t))).body.reservation._id;
        const res = await ctx.api.as(A.users.captain).put(`/reservations/${id}/status`).send({ status: 'Cancelled' });
        expect(res.status).toBe(200);
        expect(await tableStatus(t)).toBe('free');
    });

    test('late deduction: ₹200 off a ₹500 advance → ₹300 advance, ₹700 balance; second deduction refused', async () => {
        const r = await Reservation.create({
            restaurant: A.restaurant._id, guestName: 'Late', contactNo: '1', time: '8 PM', guestCount: 2,
            payment: { total: 1000, advancePaid: 500, balance: 500, status: 'partial' },
        });
        const res = await ctx.api.as(A.users.admin).patch(`/reservations/${r._id}/late-deduction`).send({ deductionAmount: 200 });
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('₹200.00 deducted from advance payment');
        const doc = await Reservation.findById(r._id).lean();
        expect(doc.payment).toMatchObject({ advancePaid: 300, balance: 700 });
    });

    test('a late-arrival deduction can only be applied once', async () => {
        // Regression (fixed 2026-10): models/reservation.js has lateArrival and applyLateDeduction writes conditionally on deductedAt == null.
        const r = await Reservation.create({
            restaurant: A.restaurant._id, guestName: 'Late twice', contactNo: '1', time: '8 PM', guestCount: 2,
            payment: { total: 1000, advancePaid: 500, balance: 500 },
        });
        expect((await ctx.api.as(A.users.admin).patch(`/reservations/${r._id}/late-deduction`).send({ deductionAmount: 200 })).status).toBe(200);
        const again = await ctx.api.as(A.users.admin).patch(`/reservations/${r._id}/late-deduction`).send({ deductionAmount: 200 });

        const doc = await Reservation.findById(r._id).lean();
        expect({ status: again.status, advancePaid: doc.payment.advancePaid, lateArrival: doc.lateArrival })
            .toEqual({ status: 400, advancePaid: 300, lateArrival: expect.objectContaining({ isLate: true, deductionAmount: 200 }) });
    });

    test('late deduction is capped at the advance (₹800 asked, ₹250.50 taken) and refused for halls / non-admins / ≤ 0', async () => {
        const r = await Reservation.create({
            restaurant: A.restaurant._id, guestName: 'Late2', contactNo: '1', time: '8 PM', guestCount: 2,
            payment: { total: 1000, advancePaid: 250.5, balance: 749.5 },
        });
        const res = await ctx.api.as(A.users.admin).patch(`/reservations/${r._id}/late-deduction`).send({ deductionAmount: 800 });
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('₹250.50 deducted from advance payment');
        expect((await Reservation.findById(r._id).lean()).payment).toMatchObject({ advancePaid: 0, balance: 1000 });

        const hall = await Reservation.create({
            restaurant: A.restaurant._id, guestName: 'Hall', contactNo: '1', time: '8 PM', guestCount: 50, bookingType: 'hall',
            payment: { total: 1000, advancePaid: 500 },
        });
        expect((await ctx.api.as(A.users.admin).patch(`/reservations/${hall._id}/late-deduction`).send({ deductionAmount: 10 })).status).toBe(400);
        expect((await ctx.api.as(A.users.captain).patch(`/reservations/${hall._id}/late-deduction`).send({ deductionAmount: 10 })).status).toBe(403);
        expect((await ctx.api.as(A.users.admin).patch(`/reservations/${hall._id}/late-deduction`).send({ deductionAmount: 0 })).status).toBe(400);
        expect((await ctx.api.as(B.users.admin).patch(`/reservations/${r._id}/late-deduction`).send({ deductionAmount: 1 })).status).toBe(404);
    });

    test('listing sweeps past Pending reservations to Cancelled and frees their tables', async () => {
        const t = await createTable(A);
        await Table.updateOne({ _id: t._id }, { $set: { status: 'reserved' } });
        const stale = await Reservation.create({
            restaurant: A.restaurant._id, guestName: 'Ghost', contactNo: '1', time: '8 PM', guestCount: 2,
            table: t._id, date: new Date(Date.now() - 3 * 24 * 3600 * 1000), status: 'Pending',
        });
        const res = await ctx.api.as(A.users.admin).get('/reservations');
        expect(res.status).toBe(200);
        expect((await Reservation.findById(stale._id).lean()).status).toBe('Cancelled');
        expect(await tableStatus(t)).toBe('free');
    });
});

// ═════════════════════════════ Table requests ═════════════════════════════

const raise = (client, table, type = 'water', extra = {}) =>
    client.post('/requests').send({ tableId: String(table._id), type, ...extra });

describe('POST /requests (guest at a table)', () => {
    test('a scanned guest calls for water: 201 pending, branch stamped, table alert pushed, waiters notified', async () => {
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        expect(scanToken).toBeTruthy();

        const res = await raise(ctx.api.guest(A, scanToken), t, 'water', { items: [{ label: 'Chilled', qty: 2 }], priority: 'high' });

        expect(res.status).toBe(201);
        const doc = await Request.findById(res.body.request._id).lean();
        expect(doc).toMatchObject({ type: 'water', status: 'pending', priority: 'high' });
        expect(doc.items).toEqual([expect.objectContaining({ label: 'Chilled', qty: 2 })]);
        expect(String(doc.branch)).toBe(String(A.branch._id));
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
        await settle();
        expect(await Notification.countDocuments({ restaurant: A.restaurant._id, title: 'New WATER Request', description: new RegExp(t.name) })).toBeGreaterThanOrEqual(1);
    });

    test('a request pushes an "attention required" alert onto the table', async () => {
        // Regression (fixed 2026-10): models/table.js alerts.type is `{ type: String }`, so the pushed alert object persists.
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        const before = logger.__records.length;
        const res = await raise(ctx.api.guest(A, scanToken), t, 'water');
        expect(res.status).toBe(201);
        const warned = logger.__records.slice(before).filter((r) => r.level === 'warn' && String(r.args[0]).includes('Failed to push table alert'));
        expect(warned).toEqual([]);
        const tbl = await Table.findById(t._id).lean();
        expect(tbl.alerts).toEqual([expect.objectContaining({ type: 'water', reason: `${t.name} waiting for water` })]);
    });

    test('the same request again within 30 s is suppressed (429); a different type goes through', async () => {
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        const g = ctx.api.guest(A, scanToken);
        expect((await raise(g, t, 'bill')).status).toBe(201);
        const dup = await raise(g, t, 'bill');
        expect(dup.status).toBe(429);
        expect((await raise(g, t, 'waiter')).status).toBe(201);
        expect(await Request.countDocuments({ table: t._id, type: 'bill' })).toBe(1);
    });

    test('a completed request no longer blocks a new one of the same type', async () => {
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        const g = ctx.api.guest(A, scanToken);
        const first = await raise(g, t, 'water');
        await ctx.api.as(A.users.waiter).put(`/requests/${first.body.request._id}/status`).send({ status: 'completed' });
        expect((await raise(g, t, 'water')).status).toBe(201);
    });

    test.each([
        ['an unknown type', { type: 'pizza' }, 400],
        ['an unknown priority', { priority: 'asap' }, 400],
        ['no table', { tableId: '' }, 400],
        ['a malformed table id', { tableId: 'xyz' }, 400],
        ['non-array items', { items: 'water' }, 400],
    ])('refuses %s', async (_label, override, status) => {
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await ctx.api.guest(A, scanToken).post('/requests').send({ tableId: String(t._id), type: 'water', ...override });
        expect(res.status).toBe(status);
        expect(await Request.countDocuments({ table: t._id })).toBe(0);
    });

    test('a table of another tenant is TABLE_UNAVAILABLE', async () => {
        const tb = await createTable(B);
        const res = await raise(ctx.api.guest(A), tb);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_UNAVAILABLE');
        expect(await Request.countDocuments({ table: tb._id })).toBe(0);
    });

    test('a table with an assigned waiter is auto-accepted for that waiter', async () => {
        const t = await createTable(A);
        await Table.updateOne({ _id: t._id }, { $set: { assignedWaiter: A.users.waiter._id } });
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await raise(ctx.api.guest(A, scanToken), t, 'waiter');
        expect(res.status).toBe(201);
        const doc = await Request.findById(res.body.request._id).lean();
        expect(doc.status).toBe('accepted');
        expect(String(doc.waiter)).toBe(String(A.users.waiter._id));
        expect(doc.acceptedAt).toBeTruthy();
        await settle();
        expect(await Notification.countDocuments({ recipient: A.users.waiter._id, title: 'New WAITER Request', description: new RegExp(t.name) })).toBe(1);
    });

    test.each([
        ['no scan token at all', false],
        ['the scan token of a different table', true],
    ])('a guest with %s cannot raise a request for a table', async (_label, useOtherToken) => {
        // Regression (fixed 2026-10): createRequest requires an X-Scan-Token for this table (or its merge group) from guests / customers.
        const victim = await createTable(A);
        let token;
        if (useOtherToken) {
            const mine = await createTable(A);
            token = (await scanTable(ctx.api, mine)).scanToken;
            expect(token).toBeTruthy();
        }
        const res = await raise(ctx.api.guest(A, token), victim, 'bill');
        expect(res.status).toBe(403);
        expect(await Request.countDocuments({ table: victim._id })).toBe(0);
    });

    test('GET /requests/active/table/:id lists this sitting’s requests, only within the tenant', async () => {
        const t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        await raise(ctx.api.guest(A, scanToken), t, 'water');
        const res = await ctx.api.guest(A, scanToken).get(`/requests/active/table/${t._id}`);
        expect(res.status).toBe(200);
        expect(res.body.requests).toEqual([expect.objectContaining({ type: 'water', status: 'pending' })]);
        const other = await ctx.api.guest(B).get(`/requests/active/table/${t._id}`);
        expect(other.body.requests).toEqual([]);
    });
});

describe('staff handling of requests', () => {
    let t;
    let reqId;

    beforeEach(async () => {
        t = await createTable(A);
        const { scanToken } = await scanTable(ctx.api, t);
        const res = await raise(ctx.api.guest(A, scanToken), t, 'water');
        reqId = res.body.request._id;
    });

    test('waiters see the feed; chefs and customers do not; another tenant does not', async () => {
        const list = await ctx.api.as(A.users.waiter).get('/requests?status=pending');
        expect(list.status).toBe(200);
        expect(list.body.requests.map((r) => String(r._id))).toContain(String(reqId));
        expect((await ctx.api.as(A.users.waiter).get('/requests?status=bogus')).status).toBe(400);
        expect((await ctx.api.as(A.users.chef).get('/requests')).status).toBe(403);
        const cust = await createCustomer('fl-req-cust');
        expect((await ctx.api.as(cust, A).get('/requests')).status).toBe(403);
        const bList = await ctx.api.as(B.users.admin).get('/requests');
        expect(bList.body.requests.map((r) => String(r._id))).not.toContain(String(reqId));
        const b2 = await ctx.api.as(waiter2).get('/requests');
        expect(b2.body.requests.map((r) => String(r._id))).not.toContain(String(reqId));
    });

    test('a waiter accepts as themselves (body waiterId ignored), then completes; the table alert is cleared', async () => {
        const acc = await ctx.api.as(A.users.waiter).put(`/requests/${reqId}/status`)
            .send({ status: 'accepted', waiterId: String(A.users.captain._id) });
        expect(acc.status).toBe(200);
        let doc = await Request.findById(reqId).lean();
        expect(doc.status).toBe('accepted');
        expect(String(doc.waiter)).toBe(String(A.users.waiter._id));
        expect((await Table.findById(t._id).lean()).alerts).toEqual([]);

        const done = await ctx.api.as(A.users.waiter).put(`/requests/${reqId}/status`).send({ status: 'completed' });
        expect(done.status).toBe(200);
        doc = await Request.findById(reqId).lean();
        expect(doc.status).toBe('completed');
        expect(doc.completedAt).toBeTruthy();

        const back = await ctx.api.as(A.users.waiter).put(`/requests/${reqId}/status`).send({ status: 'accepted' });
        expect(back.status).toBe(400);
        expect(back.body.message).toBe('Cannot transition from completed to accepted');
    });

    test('status must be accepted/completed; another tenant gets 404', async () => {
        expect((await ctx.api.as(A.users.waiter).put(`/requests/${reqId}/status`).send({ status: 'pending' })).status).toBe(400);
        expect((await ctx.api.as(B.users.admin).put(`/requests/${reqId}/status`).send({ status: 'completed' })).status).toBe(404);
        expect((await Request.findById(reqId).lean()).status).toBe('pending');
    });

    test('an admin may assign to an active waiter of this tenant only', async () => {
        const bad = await ctx.api.as(A.users.admin).put(`/requests/${reqId}/status`)
            .send({ status: 'accepted', waiterId: String(B.users.waiter._id) });
        expect(bad.status).toBe(400);
        const ok = await ctx.api.as(A.users.admin).put(`/requests/${reqId}/status`)
            .send({ status: 'accepted', waiterId: String(A.users.waiter._id) });
        expect(ok.status).toBe(200);
        expect(String((await Request.findById(reqId).lean()).waiter)).toBe(String(A.users.waiter._id));
    });

    test('a waiter pinned to another branch cannot accept or complete this branch’s request', async () => {
        // Regression (fixed 2026-10): updateRequestStatus looks the request up with strictBranchFilter.
        const res = await ctx.api.as(waiter2).put(`/requests/${reqId}/status`).send({ status: 'completed' });
        expect(res.status).toBe(404);
        expect((await Request.findById(reqId).lean()).status).toBe('pending');
    });
});

// ═════════════════════════════ Captain ═════════════════════════════

describe('captain floor control', () => {
    let lateOrder;
    let tFloor;

    beforeAll(async () => {
        tFloor = await createTable(A, { name: `Floor-${rid()}` });
        await Table.updateOne({ _id: tFloor._id }, { $set: { status: 'occupied' } });
        lateOrder = await Order.create({
            restaurant: A.restaurant._id, branch: A.branch._id, orderId: `CAP-${rid()}`, type: 'dine-in',
            table: tFloor._id, waiter: A.users.waiter._id, status: 'new',
            items: [{ menuItem: A.items.paneer._id, name: 'Paneer Tikka', price: 200, quantity: 1 }], total: 200,
        });
        await Order.collection.updateOne({ _id: lateOrder._id }, { $set: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } });
    });

    test('captain gets the floor: tables, a 30-min-late order flagged, waiter workload — tenant scoped', async () => {
        const res = await ctx.api.as(A.users.captain).get('/captain/floor-overview');
        expect(res.status).toBe(200);
        const row = res.body.tables.find((x) => String(x._id) === String(tFloor._id));
        expect(row).toMatchObject({ status: 'occupied', activeOrders: 1, delayed: true });
        const late = res.body.delayedOrders.find((o) => o.orderId === lateOrder.orderId);
        expect(late).toMatchObject({ status: 'new', table: tFloor.name, waiter: A.users.waiter.name, total: 200 });
        expect(late.minutesLate).toBeGreaterThanOrEqual(30);
        expect(late.minutesLate).toBeLessThanOrEqual(31);
        const w = res.body.workload.find((x) => String(x._id) === String(A.users.waiter._id));
        expect(w).toMatchObject({ activeOrders: 1, delayedOrders: 1 });
        expect(res.body.thresholds).toEqual({ prepDelayMin: 20, readyWaitMin: 10 });
        const names = res.body.tables.map((x) => x.name);
        expect(names).not.toContain(B.tables.main.name);
    });

    test('a captain pinned to branch 2 sees none of branch 1’s tables or waiters', async () => {
        const t2 = await createTable(A, { branch: branch2._id, area: area2._id });
        const res = await ctx.api.as(captain2).get('/captain/floor-overview');
        expect(res.status).toBe(200);
        const ids = res.body.tables.map((x) => String(x._id));
        expect(ids).toContain(String(t2._id));
        expect(ids).not.toContain(String(tFloor._id));
        expect(res.body.delayedOrders.map((o) => o.orderId)).not.toContain(lateOrder.orderId);

        const w = await ctx.api.as(captain2).get('/captain/waiters');
        expect(w.status).toBe(200);
        expect(w.body.waiters.map((x) => String(x._id))).toEqual([String(waiter2._id)]);
    });

    test('waiters and customers cannot use captain endpoints', async () => {
        const cust = await createCustomer('fl-cap');
        expect((await ctx.api.as(A.users.waiter).get('/captain/floor-overview')).status).toBe(403);
        expect((await ctx.api.as(cust, A).get('/captain/waiters')).status).toBe(403);
        expect((await ctx.api.as(A.users.waiter).post('/captain/escalate').send({ reason: 'x' })).status).toBe(403);
    });

    test.each([
        [undefined, 'high'],
        ['urgent', 'urgent'],
        ['catastrophic', 'high'],
    ])('escalation with severity %s is stored for admins with priority %s', async (severity, priority) => {
        const reason = `Table needs manager ${rid()}`;
        const res = await ctx.api.as(A.users.captain).post('/captain/escalate').send({ reason, tableName: 'T9', severity });
        expect(res.status).toBe(201);
        const n = await Notification.findById(res.body.notification._id).lean();
        expect(n).toMatchObject({
            recipientRole: 'admin', priority, description: reason, category: 'Service',
            title: `Escalation from ${A.users.captain.name} · T9`,
        });
        expect(String(n.restaurant)).toBe(String(A.restaurant._id));
        expect(String(n.branch)).toBe(String(A.branch._id));
    });

    test('escalation without a reason is refused', async () => {
        const res = await ctx.api.as(A.users.captain).post('/captain/escalate').send({ reason: '   ' });
        expect(res.status).toBe(400);
    });
});
