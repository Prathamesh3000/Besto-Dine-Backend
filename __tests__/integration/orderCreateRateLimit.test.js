/**
 * POST /orders rate limit through the REAL route (routes/orderRoute.js →
 * middlewares/orderCreateLimiter.js) and the real express-rate-limit
 * memory store.
 *
 * helpers/mocks.js turns every limiter into a pass-through for the other
 * suites; this file un-mocks utils/rateLimitStore so the limiter is live.
 * It is the only suite that does so, and it is kept well under the global
 * 200/min per-IP apiLimiter in app.js.
 *
 * Desktop soak 2026-10-13: a cashier creating takeaway orders at the
 * counter got 429 ORDER_RATE_LIMIT on the 6th order in a minute. The
 * limiter also ran BEFORE optionalAuth, so staff were keyed by IP (one
 * budget for the whole counter). Staff now get 60/min per user; the
 * customer / guest-table limits stay at 5/min.
 */
jest.unmock('../../utils/rateLimitStore');

const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));

const ctx = useIntegrationApp();
let A;
const rid = () => crypto.randomBytes(6).toString('hex');

const takeawayBody = (t) => ({
    type: 'takeaway', pickupLocation: 'Counter', customerName: 'Walk-in', phone: '9876543210',
    items: [{ menuItem: String(t.items.paneer._id), quantity: 1 }],
    total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(t.settings.taxes), orderType: 'takeaway' }).total,
    clientIdempotencyKey: `idem_${rid()}${rid()}`,
});

async function burst(send, n) {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await send()).status); // eslint-disable-line no-await-in-loop
    return statuses;
}

beforeAll(async () => {
    A = await seedTenant({ label: 'rl' });
});

afterAll(async () => { await settle(300); });

describe('staff tier (60/min per staff user)', () => {
    test('6 rapid takeaway orders from one waiter are all 201; the 61st within the minute is 429 ORDER_RATE_LIMIT', async () => {
        const send = () => ctx.api.as(A.users.waiter, A).post('/orders').send(takeawayBody(A));
        expect(await burst(send, 6)).toEqual(Array(6).fill(201));
        expect(await burst(send, 54)).toEqual(Array(54).fill(201));

        const blocked = await send();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ success: false, code: 'ORDER_RATE_LIMIT' });
        expect(blocked.headers['ratelimit-limit']).toBe('60');

        // keyed per user, not per IP: a colleague on the same network still works
        const other = await ctx.api.as(A.users.captain, A).post('/orders').send(takeawayBody(A));
        expect(other.status).toBe(201);
    }, 120000);
});

describe('customer / guest tier (5/min)', () => {
    test('logged-in customer: 5 takeaway orders pass, the 6th is 429', async () => {
        const cust = await createCustomer('rl-c1', { phone: '9111111111' });
        const send = () => ctx.api.as(cust, A).post('/orders').send(takeawayBody(A));
        expect(await burst(send, 5)).toEqual(Array(5).fill(201));
        const blocked = await send();
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('ORDER_RATE_LIMIT');
        expect(blocked.headers['ratelimit-limit']).toBe('5');
    });

    test('guest at a table: 5 dine-in orders pass, the 6th is 429; another table is unaffected', async () => {
        const table = await createTable(A, { name: 'RL-1' });
        const { scanToken } = await scanTable(ctx.api, table);
        const dineIn = () => ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }],
            total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'dine-in' }).total,
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(await burst(dineIn, 5)).toEqual(Array(5).fill(201));
        expect((await dineIn()).status).toBe(429);

        const table2 = await createTable(A, { name: 'RL-2' });
        const { scanToken: token2 } = await scanTable(ctx.api, table2);
        const res = await ctx.api.guest(A, token2).post('/orders').send({
            type: 'dine-in', tableId: String(table2._id),
            items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }],
            total: computeBill({ subtotal: 200, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'dine-in' }).total,
            clientIdempotencyKey: `idem_${rid()}${rid()}`,
        });
        expect(res.status).toBe(201);
    });
});
