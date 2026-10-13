/**
 * middlewares/orderCreateLimiter.js — the per-actor POST /orders limiter.
 *
 * Pins the two tiers (staff 60/min per user, everyone else 5/min per
 * user / table / IP) and the key choice, through express-rate-limit's
 * real in-memory store on a tiny express app. The real route is covered
 * by __tests__/integration/orderCreateRateLimit.test.js.
 */
process.env.REDIS_URL = '';
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const {
    orderCreateLimiter, orderCreateLimitFor, orderCreateLimitKey, STAFF_ROLES, STAFF_LIMIT, GUEST_LIMIT,
} = require('../middlewares/orderCreateLimiter');

const { Types } = require('mongoose');

function buildApp() {
    const app = express();
    app.use(express.json());
    // Stand-in for optionalAuth: the test sends the "logged-in" user as a header.
    app.use((req, res, next) => {
        const u = req.get('x-test-user');
        if (u) req.user = JSON.parse(u);
        next();
    });
    app.post('/orders', orderCreateLimiter, (req, res) => res.status(201).json({ success: true }));
    return app;
}

const user = (role) => ({ _id: String(new Types.ObjectId()), role });
const post = (app, { user: u, body = {} } = {}) => {
    let r = request(app).post('/orders');
    if (u) r = r.set('x-test-user', JSON.stringify(u));
    return r.send(body);
};
async function burst(app, n, opts) {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await post(app, opts)).status); // eslint-disable-line no-await-in-loop
    return statuses;
}

describe('tier + key helpers', () => {
    test('every staff role gets the staff ceiling; customers and guests get the guest ceiling', () => {
        expect(STAFF_ROLES).toEqual(['admin', 'manager', 'captain', 'waiter', 'chef']);
        expect(STAFF_LIMIT).toBe(60);
        expect(GUEST_LIMIT).toBe(5);
        for (const role of STAFF_ROLES) expect(orderCreateLimitFor({ user: { role } })).toBe(60);
        expect(orderCreateLimitFor({ user: { role: 'customer' } })).toBe(5);
        expect(orderCreateLimitFor({ user: { role: 'superadmin' } })).toBe(5);
        expect(orderCreateLimitFor({})).toBe(5);
        expect(orderCreateLimitFor({ body: { source: 'kiosk' } })).toBe(5);
    });

    test('key: user id beats table id beats IP', () => {
        expect(orderCreateLimitKey({ user: { _id: 'u1' }, body: { tableId: 't1' }, ip: '1.2.3.4' })).toBe('user:u1');
        expect(orderCreateLimitKey({ body: { tableId: 't1' }, ip: '1.2.3.4' })).toBe('table:t1');
        expect(orderCreateLimitKey({ body: { table: 't2' }, ip: '1.2.3.4' })).toBe('table:t2');
        expect(orderCreateLimitKey({ body: {}, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
        // IPv6 collapses to its /56 so rotating the host bits does not reset the budget
        expect(orderCreateLimitKey({ ip: '2001:db8:0:1:aaaa::1' })).toBe(orderCreateLimitKey({ ip: '2001:db8:0:1:bbbb::2' }));
    });
});

describe('through express-rate-limit', () => {
    test('staff: 6 rapid orders all pass; the 61st in the window is 429 ORDER_RATE_LIMIT', async () => {
        const app = buildApp();
        const waiter = user('waiter');
        expect(await burst(app, 6, { user: waiter })).toEqual(Array(6).fill(201));
        expect(await burst(app, 54, { user: waiter })).toEqual(Array(54).fill(201));
        const blocked = await post(app, { user: waiter });
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ success: false, code: 'ORDER_RATE_LIMIT' });
        expect(blocked.headers['ratelimit-limit']).toBe('60');
        expect(blocked.headers['retry-after']).toBeDefined();
        // per user — a colleague at the next till is unaffected
        expect((await post(app, { user: user('captain') })).status).toBe(201);
    });

    test('customer: 5 pass, the 6th is 429; the budget is per customer, not shared', async () => {
        const app = buildApp();
        const cust = user('customer');
        expect(await burst(app, 5, { user: cust })).toEqual(Array(5).fill(201));
        const blocked = await post(app, { user: cust });
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('ORDER_RATE_LIMIT');
        expect(blocked.headers['ratelimit-limit']).toBe('5');
        expect((await post(app, { user: user('customer') })).status).toBe(201);
    });

    test('guest at a table: 5 per tableId; a different table has its own budget', async () => {
        const app = buildApp();
        expect(await burst(app, 5, { body: { tableId: 'tbl-1' } })).toEqual(Array(5).fill(201));
        expect((await post(app, { body: { tableId: 'tbl-1' } })).status).toBe(429);
        expect((await post(app, { body: { tableId: 'tbl-2' } })).status).toBe(201);
    });

    test('anonymous takeaway / kiosk: 5 per IP', async () => {
        const app = buildApp();
        expect(await burst(app, 5, { body: { type: 'takeaway', source: 'kiosk' } })).toEqual(Array(5).fill(201));
        expect((await post(app, { body: { type: 'takeaway', source: 'kiosk' } })).status).toBe(429);
    });
});
