/**
 * QA #13 — seat reservation. Only up to a table's capacity of diner
 * parties can scan into / order at a table, including under concurrent
 * scans and orders; seats are released when the table is freed and idle
 * seats are pruned.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const { groupPartyIdentities } = require(path.join(BACKEND, 'utils/tableOccupancy'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => {
    A = await seedTenant({ label: 'seats' });
});

const cart = (t) => [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }];
const cartTotal = (t) => computeBill({ subtotal: 200, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'dine-in' }).total;

const seatsOf = async (tableId) => (await Table.findById(tableId).select('+seats').lean()).seats || [];

// Age every seat on a table past the idle timeout (default 30 min).
const ageSeats = (tableId, minutes = 31) => Table.updateOne(
    { _id: tableId },
    { $set: { 'seats.$[].lastSeenAt': new Date(Date.now() - minutes * 60 * 1000) } },
);

const order = (scanToken, table) => ctx.api.guest(A, scanToken).post('/orders')
    .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: cartTotal(A) });

describe('seat reservation at QR scan', () => {
    test('4-seat table: 4 guests scan in, the 5th gets 409 TABLE_CAPACITY_REACHED', async () => {
        const table = await createTable(A, { name: 'Seat-4', capacity: 4 });
        for (let i = 0; i < 4; i++) {
            const s = await scanTable(ctx.api, table);
            expect(s.res.status).toBe(200);
            // Seat identities never reach the customer.
            expect(s.res.body.seats).toBeUndefined();
        }
        expect(await seatsOf(table._id)).toHaveLength(4);

        const fifth = await scanTable(ctx.api, table);
        expect(fifth.res.status).toBe(409);
        expect(fifth.res.body.code).toBe('TABLE_CAPACITY_REACHED');
        expect(fifth.res.body.message).toMatch(/is full \(seats 4\)/);
        expect(await seatsOf(table._id)).toHaveLength(4);
    });

    test('a guest re-scanning with their prior token keeps their seat (no second seat), even when full', async () => {
        const table = await createTable(A, { name: 'Seat-Rescan', capacity: 2 });
        const first = await scanTable(ctx.api, table);
        await scanTable(ctx.api, table);
        expect(await seatsOf(table._id)).toHaveLength(2);

        const again = await scanTable(ctx.api, table, { 'X-Scan-Token': first.scanToken });
        expect(again.res.status).toBe(200);
        expect(again.sessionId).toBe(first.sessionId);
        expect(await seatsOf(table._id)).toHaveLength(2);
    });

    test('a guest who then logs in keeps the same seat (user id added to it)', async () => {
        const table = await createTable(A, { name: 'Seat-Login', capacity: 2 });
        const guest = await scanTable(ctx.api, table);
        await scanTable(ctx.api, table); // table now full
        const cust = await createCustomer('seatlogin');

        const claim = await ctx.api.customerAtTable(cust, A, guest.scanToken).post(`/tables/${table._id}/claim`).send({});
        expect(claim.status).toBe(200);
        expect(claim.body.table.seats).toBeUndefined();

        const seats = await seatsOf(table._id);
        expect(seats).toHaveLength(2);
        const mine = seats.find((s) => s.keys.includes(`s:${guest.sessionId}`));
        expect(mine.keys).toEqual(expect.arrayContaining([`s:${guest.sessionId}`, `u:${cust._id}`]));

        // ...and can order on the same seat.
        const res = await ctx.api.customerAtTable(cust, A, guest.scanToken).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: cartTotal(A) });
        expect(res.status).toBe(201);
        expect(await seatsOf(table._id)).toHaveLength(2);
    });

    test('6 CONCURRENT scans on a 2-seat table → exactly 2 succeed', async () => {
        const table = await createTable(A, { name: 'Seat-Race', capacity: 2 });
        const results = await Promise.all(Array.from({ length: 6 }, () => scanTable(ctx.api, table)));
        const statuses = results.map((r) => r.res.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(2);
        expect(statuses.filter((s) => s === 409)).toHaveLength(4);
        expect(await seatsOf(table._id)).toHaveLength(2);
    });
});

describe('seat reservation at order time', () => {
    test('concurrent first orders from parties whose seats were pruned never exceed capacity', async () => {
        const table = await createTable(A, { name: 'Seat-OrderRace', capacity: 2 });
        // 4 parties hold valid scan tokens: two scan, go idle (pruned by
        // the next scans), two more scan, then everyone goes idle.
        const p1 = await scanTable(ctx.api, table);
        const p2 = await scanTable(ctx.api, table);
        await ageSeats(table._id);
        const p3 = await scanTable(ctx.api, table);
        const p4 = await scanTable(ctx.api, table);
        expect([p1, p2, p3, p4].map((p) => p.res.status)).toEqual([200, 200, 200, 200]);
        await ageSeats(table._id);

        const results = await Promise.all([p1, p2, p3, p4].map((p) => order(p.scanToken, table)));
        const ok = results.filter((r) => r.status === 201);
        const full = results.filter((r) => r.status === 409);
        expect(ok).toHaveLength(2);
        expect(full).toHaveLength(2);
        full.forEach((r) => expect(r.body.code).toBe('TABLE_CAPACITY_REACHED'));

        const open = await Order.find({ table: table._id, status: { $ne: 'cancelled' } }).select('user scanSessionId').lean();
        expect(groupPartyIdentities(open).length).toBeLessThanOrEqual(2);
        expect(await seatsOf(table._id)).toHaveLength(2);
    });

    test('a seated party keeps ordering; staff orders are never capacity-blocked', async () => {
        const table = await createTable(A, { name: 'Seat-Staff', capacity: 1 });
        const g = await scanTable(ctx.api, table);
        expect((await order(g.scanToken, table)).status).toBe(201);
        expect((await order(g.scanToken, table)).status).toBe(201);

        const staff = await ctx.api.as(A.users.waiter).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: cartTotal(A) });
        expect(staff.status).toBe(201);
        // Staff never take a seat.
        expect(await seatsOf(table._id)).toHaveLength(1);
    });

    test('a staff walk-in party occupies a place: a 1-seat table with a staff order refuses a new guest', async () => {
        const table = await createTable(A, { name: 'Seat-Walkin', capacity: 1 });
        const staff = await ctx.api.as(A.users.waiter).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: cart(A), total: cartTotal(A) });
        expect(staff.status).toBe(201);
        const s = await scanTable(ctx.api, table);
        expect(s.res.status).toBe(409);
    });
});

describe('seat release', () => {
    test('an idle seat is pruned after the timeout and frees space', async () => {
        const table = await createTable(A, { name: 'Seat-Idle', capacity: 1 });
        expect((await scanTable(ctx.api, table)).res.status).toBe(200);
        expect((await scanTable(ctx.api, table)).res.status).toBe(409);

        await ageSeats(table._id, 29); // not idle long enough yet
        expect((await scanTable(ctx.api, table)).res.status).toBe(409);

        await ageSeats(table._id, 31);
        const late = await scanTable(ctx.api, table);
        expect(late.res.status).toBe(200);
        const seats = await seatsOf(table._id);
        expect(seats).toHaveLength(1);
        expect(seats[0].keys).toEqual([`s:${late.sessionId}`]);
    });

    test('an idle seat whose party still has an open order is NOT pruned', async () => {
        const table = await createTable(A, { name: 'Seat-IdleOrder', capacity: 1 });
        const g = await scanTable(ctx.api, table);
        expect((await order(g.scanToken, table)).status).toBe(201);
        await ageSeats(table._id);
        expect((await scanTable(ctx.api, table)).res.status).toBe(409);
    });

    test('staff "free table" clears every seat', async () => {
        const table = await createTable(A, { name: 'Seat-Free', capacity: 2 });
        await scanTable(ctx.api, table);
        await scanTable(ctx.api, table);
        expect((await scanTable(ctx.api, table)).res.status).toBe(409);

        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true });
        expect(free.status).toBe(200);
        expect(await seatsOf(table._id)).toHaveLength(0);
        expect((await scanTable(ctx.api, table)).res.status).toBe(200);
        await settle();
    });

    test('settling the bill frees the table and clears the seats', async () => {
        const table = await createTable(A, { name: 'Seat-Settle', capacity: 2 });
        const g = await scanTable(ctx.api, table);
        await scanTable(ctx.api, table);
        const placed = await order(g.scanToken, table);
        expect(placed.status).toBe(201);
        const id = placed.body.order._id;

        await Order.updateOne({ _id: id }, { $set: { status: 'served' } });
        const pay = await ctx.api.as(A.users.admin).patch(`/orders/${id}/status`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: cartTotal(A) });
        expect(pay.status).toBe(200);
        const t = await Table.findById(table._id).select('+seats').lean();
        expect(t.status).toBe('free');
        expect(t.seats).toHaveLength(0);
        await settle();
    });

    test('setting a table to free / disabled via PUT releases its seats', async () => {
        const table = await createTable(A, { name: 'Seat-Put', capacity: 2 });
        await scanTable(ctx.api, table);
        const put = await ctx.api.as(A.users.admin).put(`/tables/${table._id}`).send({ status: 'free' });
        expect(put.status).toBe(200);
        expect(await seatsOf(table._id)).toHaveLength(0);
    });
});

describe('merge groups', () => {
    test('a merged 2+2 group seats 4 parties across both stickers, all on the leader', async () => {
        const t1 = await createTable(A, { name: 'Seat-M1', capacity: 2 });
        const t2 = await createTable(A, { name: 'Seat-M2', capacity: 2 });
        const merge = await ctx.api.as(A.users.admin).post('/tables/merge').send({ tableIds: [String(t2._id), String(t1._id)] });
        expect(merge.status).toBe(200);

        const scans = [];
        for (const t of [t1, t2, t2, t1]) scans.push(await scanTable(ctx.api, t));
        expect(scans.map((s) => s.res.status)).toEqual([200, 200, 200, 200]);
        // Every sticker resolves to the same (deterministic) leader.
        expect(new Set(scans.map((s) => String(s.res.body._id))).size).toBe(1);

        expect((await scanTable(ctx.api, t2)).res.status).toBe(409);
        expect((await scanTable(ctx.api, t1)).res.status).toBe(409);

        const leaderId = scans[0].res.body._id;
        const otherId = String(t1._id) === leaderId ? t2._id : t1._id;
        expect(await seatsOf(leaderId)).toHaveLength(4);
        expect(await seatsOf(otherId)).toHaveLength(0);

        // Unmerge (no active order) releases the seats.
        const un = await ctx.api.as(A.users.admin).post('/tables/unmerge').send({ tableId: String(t1._id) });
        expect(un.status).toBe(200);
        expect(await seatsOf(leaderId)).toHaveLength(0);
        await settle();
    });
});

describe('staff views expose seatsTaken (count only)', () => {
    test('GET /tables, /admin bootstrap and the captain floor show seatsTaken without seat identities', async () => {
        const table = await createTable(A, { name: 'Seat-View', capacity: 3 });
        await scanTable(ctx.api, table);
        await scanTable(ctx.api, table);

        const findRow = (node) => {
            if (!node || typeof node !== 'object') return null;
            if (node._id === String(table._id) && 'seatsTaken' in node) return node;
            for (const v of Object.values(node)) { const f = findRow(v); if (f) return f; }
            return null;
        };

        const list = await ctx.api.as(A.users.admin).get('/tables');
        expect(list.status).toBe(200);
        const row = list.body.tables.find((t) => t._id === String(table._id));
        expect(row.seatsTaken).toBe(2);
        expect(row.seats).toBeUndefined();

        const boot = await ctx.api.as(A.users.admin).get('/admin/bootstrap?sections=tables');
        expect(boot.status).toBe(200);
        expect(JSON.stringify(boot.body)).not.toMatch(/"seats":/);
        expect(findRow(boot.body).seatsTaken).toBe(2);

        const floor = await ctx.api.as(A.users.captain).get('/captain/floor-overview');
        expect(floor.status).toBe(200);
        const fr = JSON.stringify(floor.body);
        expect(fr).not.toMatch(/"seats":/);
        expect(findRow(floor.body).seatsTaken).toBe(2);
    });
});
