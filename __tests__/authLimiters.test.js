/**
 * utils/authLimiters.js — the per-IP /auth limiters after the NAT retune
 * (LOGIN_THROTTLING_PROPOSAL.md part b).
 *
 * Pins the key choice (ip + sha256(email)) and "only failures count",
 * through express-rate-limit's real in-memory store on a tiny express app
 * (the integration suites mock the store away). Thresholds are lowered
 * via the exported constants only where the test would otherwise need
 * hundreds of requests — the real numbers are asserted separately.
 */
process.env.REDIS_URL = '';
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const {
    createAuthLimiters, loginLimitKey, emailHash,
    WINDOW_MS, LOGIN_IP_EMAIL_LIMIT, LOGIN_IP_LIMIT, AUTH_IP_LIMIT, FORGOT_IP_LIMIT,
} = require('../utils/authLimiters');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('limiter table', () => {
    test('15-minute window; login 300 per (ip,email) + 1000 per ip; other auth 50; forgot 30', () => {
        expect(WINDOW_MS).toBe(15 * 60 * 1000);
        expect(LOGIN_IP_EMAIL_LIMIT).toBe(300);
        expect(LOGIN_IP_LIMIT).toBe(1000);
        expect(AUTH_IP_LIMIT).toBe(50);
        expect(FORGOT_IP_LIMIT).toBe(30);
    });
});

describe('loginLimitKey', () => {
    test('ip + sha256(lowercased, trimmed email)', () => {
        const key = loginLimitKey({ ip: '203.0.113.7', body: { email: '  Waiter@Cafe.Test ' } });
        expect(key).toBe(`203.0.113.7:${sha('waiter@cafe.test')}`);
        expect(key).toBe(loginLimitKey({ ip: '203.0.113.7', body: { email: 'waiter@cafe.test' } }));
        expect(key).not.toContain('waiter'); // the key never carries the address itself
        expect(emailHash('X@Y.Z')).toBe(sha('x@y.z'));
    });
    test('same ip, different email → different key; same email, different ip → different key', () => {
        const a = loginLimitKey({ ip: '203.0.113.7', body: { email: 'a@cafe.test' } });
        const b = loginLimitKey({ ip: '203.0.113.7', body: { email: 'b@cafe.test' } });
        const c = loginLimitKey({ ip: '203.0.113.8', body: { email: 'a@cafe.test' } });
        expect(new Set([a, b, c]).size).toBe(3);
    });
    test('non-string / missing email hashes the empty string (then fails validation and counts)', () => {
        const empty = `1.2.3.4:${sha('')}`;
        expect(loginLimitKey({ ip: '1.2.3.4', body: {} })).toBe(empty);
        expect(loginLimitKey({ ip: '1.2.3.4', body: { email: { $ne: null } } })).toBe(empty);
        expect(loginLimitKey({ ip: '1.2.3.4' })).toBe(empty);
    });
    test('IPv6 collapses to its /56 so rotating host bits does not reset the budget', () => {
        const a = loginLimitKey({ ip: '2001:db8:0:1:aaaa::1', body: { email: 'a@cafe.test' } });
        const b = loginLimitKey({ ip: '2001:db8:0:1:bbbb::2', body: { email: 'a@cafe.test' } });
        expect(a).toBe(b);
    });
});

/**
 * Tiny app: the handler answers 200 when the password is "right" and 401
 * otherwise, so skipSuccessfulRequests has something to skip. The client
 * IP comes from X-Forwarded-For (trust proxy on) so one test can play
 * several addresses.
 */
function buildApp(limiters) {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    const handler = (req, res) => (req.body.password === 'right'
        ? res.status(200).json({ success: true })
        : res.status(401).json({ success: false, message: 'Invalid email or password' }));
    app.post('/login', limiters.loginIpBackstop, limiters.loginLimiter, handler);
    app.post('/register', limiters.authLimiter, handler);
    return app;
}

const post = (app, path, ip, body) => request(app).post(path).set('X-Forwarded-For', ip).send(body);

describe('through express-rate-limit', () => {
    let app;
    beforeEach(() => { app = buildApp(createAuthLimiters()); });

    test('successful logins never consume budget: 350 correct logins from one IP all pass', async () => {
        for (let i = 0; i < 350; i++) {
            const res = await post(app, '/login', '203.0.113.7', { email: 'w@cafe.test', password: 'right' }); // eslint-disable-line no-await-in-loop
            expect(res.status).toBe(200);
        }
    });

    test('the (ip, email) budget is 300 failures; the 301st is 429 with Retry-After; a colleague on the same IP is unaffected', async () => {
        const ip = '203.0.113.7';
        for (let i = 0; i < 300; i++) {
            const res = await post(app, '/login', ip, { email: 'w@cafe.test', password: 'wrong' }); // eslint-disable-line no-await-in-loop
            expect(res.status).toBe(401);
        }
        const blocked = await post(app, '/login', ip, { email: 'W@Cafe.Test', password: 'right' });
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ success: false });
        expect(blocked.headers['retry-after']).toBeDefined();
        expect(blocked.headers['ratelimit-limit']).toBe('300');
        // same IP, another account → its own budget, logs in fine
        expect((await post(app, '/login', ip, { email: 'chef@cafe.test', password: 'right' })).status).toBe(200);
        expect((await post(app, '/login', ip, { email: 'chef@cafe.test', password: 'wrong' })).status).toBe(401);
        // same account from another IP → its own budget too
        expect((await post(app, '/login', '203.0.113.8', { email: 'w@cafe.test', password: 'right' })).status).toBe(200);
    }, 30000);

    test('worse day: 25 staff × (3 wrong + 1 right) from one IP → 25 logins, 0 legitimate 429s', async () => {
        const ip = '198.51.100.4';
        let ok = 0;
        let legit429 = 0;
        for (let s = 1; s <= 25; s++) {
            const email = `staff${s}@cafe.test`;
            for (let t = 1; t <= 3; t++) expect((await post(app, '/login', ip, { email, password: `typo${t}` })).status).toBe(401); // eslint-disable-line no-await-in-loop
            const res = await post(app, '/login', ip, { email, password: 'right' }); // eslint-disable-line no-await-in-loop
            if (res.status === 200) ok += 1;
            if (res.status === 429) legit429 += 1;
        }
        expect(ok).toBe(25);
        expect(legit429).toBe(0);
    });

    test('register / otp / change-password: 50 failures per IP, successes free', async () => {
        const ip = '203.0.113.9';
        for (let i = 0; i < 20; i++) expect((await post(app, '/register', ip, { password: 'right' })).status).toBe(200); // eslint-disable-line no-await-in-loop
        for (let i = 0; i < 50; i++) expect((await post(app, '/register', ip, { password: 'wrong' })).status).toBe(401); // eslint-disable-line no-await-in-loop
        const blocked = await post(app, '/register', ip, { password: 'right' });
        expect(blocked.status).toBe(429);
        expect(blocked.headers['ratelimit-limit']).toBe('50');
        expect((await post(app, '/register', '203.0.113.10', { password: 'right' })).status).toBe(200);
    });
});
