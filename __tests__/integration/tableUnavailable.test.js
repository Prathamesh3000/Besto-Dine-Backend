/**
 * QA #14 — "After deleting a table the user can still order".
 *
 * Server-side ordering on a deleted table is already refused (see
 * orderFlow.test.js "deleted tables"). These tests cover the remaining
 * piece: diners bound to the table are told immediately, so the customer
 * app can lock ordering instead of failing at Place Order —
 *   • a `table:unavailable` push to the table's room on delete / disable
 *   • GET /tables/:id/availability for a client that missed the push.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));

const ctx = useIntegrationApp();
let A;
let B;
const sockets = [];

beforeAll(async () => {
    A = await seedTenant({ label: 'tu-a' });
    B = await seedTenant({ label: 'tu-b' });
});

afterAll(() => {
    for (const s of sockets) s.close();
});

function connect(auth) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, {
            auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => reject(err));
    });
}

function recorder(socket) {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
}

const waitFor = (events, predicate, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
        const hit = events.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() - started > ms) return reject(new Error('event not received in time'));
        return setTimeout(tick, 25);
    };
    tick();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const availability = (t, tableId) => ctx.api.guest(t).get(`/tables/${tableId}/availability`);

describe('GET /tables/:id/availability', () => {
    test('available table → available:true', async () => {
        const table = await createTable(A, { name: 'TU-Avail-1' });
        const res = await availability(A, table._id);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, available: true });
    });

    test('deleted table → available:false TABLE_UNAVAILABLE', async () => {
        const table = await createTable(A, { name: 'TU-Avail-2' });
        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(200);
        const res = await availability(A, table._id);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ available: false, code: 'TABLE_UNAVAILABLE' });
    });

    test('disabled table → available:false TABLE_DISABLED', async () => {
        const table = await createTable(A, { name: 'TU-Avail-3' });
        const put = await ctx.api.as(A.users.admin).put(`/tables/${table._id}`).send({ status: 'disabled' });
        expect(put.status).toBe(200);
        const res = await availability(A, table._id);
        expect(res.body).toMatchObject({ available: false, code: 'TABLE_DISABLED' });
    });

    test("another tenant's table id is reported unavailable (no cross-tenant leak)", async () => {
        const tableB = await createTable(B, { name: 'TU-Avail-B' });
        const res = await availability(A, tableB._id);
        expect(res.body).toMatchObject({ available: false });
    });

    test('malformed id → 400', async () => {
        const res = await availability(A, 'not-an-id');
        expect(res.status).toBe(400);
    });
});

describe('table:unavailable push to seated diners', () => {
    test('admin deletes a freed table → the guest bound to it is told immediately', async () => {
        const table = await createTable(A, { name: 'TU-Push-1' });
        const { scanToken } = await scanTable(ctx.api, table);
        const guest = await connect({ scanToken });
        const events = recorder(guest);

        // An occupied table can't be deleted (see orderFlow "deleted
        // tables"); staff free it first, then delete.
        const free = await ctx.api.as(A.users.admin).post(`/tables/${table._id}/free`).send({ force: true });
        expect(free.status).toBe(200);
        const del = await ctx.api.as(A.users.admin).delete(`/tables/${table._id}`);
        expect(del.status).toBe(200);

        const hit = await waitFor(events, (e) => e.event === 'table:unavailable');
        expect(hit.payload).toMatchObject({ tableId: String(table._id), reason: 'deleted' });
    });

    test('admin disables the table → the guest is told immediately', async () => {
        const table = await createTable(A, { name: 'TU-Push-2' });
        const { scanToken } = await scanTable(ctx.api, table);
        const guest = await connect({ scanToken });
        const events = recorder(guest);

        const put = await ctx.api.as(A.users.admin).put(`/tables/${table._id}`).send({ status: 'disabled' });
        expect(put.status).toBe(200);

        const hit = await waitFor(events, (e) => e.event === 'table:unavailable');
        expect(hit.payload).toMatchObject({ tableId: String(table._id), reason: 'disabled' });
    });

    test('diners at OTHER tables are not told', async () => {
        const tableX = await createTable(A, { name: 'TU-Push-3x' });
        const tableY = await createTable(A, { name: 'TU-Push-3y' });
        const { scanToken } = await scanTable(ctx.api, tableY);
        const guestY = await connect({ scanToken });
        const events = recorder(guestY);

        const del = await ctx.api.as(A.users.admin).delete(`/tables/${tableX._id}`);
        expect(del.status).toBe(200);
        await sleep(400);
        expect(events.find((e) => e.event === 'table:unavailable')).toBeUndefined();
        expect((await Table.findById(tableY._id).lean()).isDeleted).not.toBe(true);
    });
});
