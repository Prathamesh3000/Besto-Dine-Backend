/**
 * QR scan response: `openBill` is true only when a previous party left an
 * unpaid order on the table. The scan itself auto-occupies a free table, and
 * the customer app used to read that as "Table has an open bill".
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));

const ctx = useIntegrationApp();
let T;

beforeAll(async () => {
    T = await seedTenant({ label: 'scanbill' });
});

describe('QR scan openBill flag', () => {
    test('first scan of a free table: occupied in the response, but no open bill', async () => {
        const table = await createTable(T, { name: 'OB-1', capacity: 4 });
        const { res } = await scanTable(ctx.api, table);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('occupied');
        expect(res.body.openBill).toBe(false);
        // a re-scan of the now-occupied table with no order is still not a bill
        const again = await scanTable(ctx.api, table);
        expect(again.res.body.openBill).toBe(false);
    });

    test('occupied table holding an unpaid order reports openBill', async () => {
        const table = await createTable(T, { name: 'OB-2', capacity: 4 });
        const first = await scanTable(ctx.api, table);
        const place = await ctx.api.guest(T, first.scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(T.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
        });
        expect(place.status).toBe(201);
        const next = await scanTable(ctx.api, table);
        expect(next.res.body.openBill).toBe(true);
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');
    });
});
