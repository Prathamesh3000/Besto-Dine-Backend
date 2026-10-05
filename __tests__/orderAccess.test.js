/**
 * services/orderAccess.js — who may act on an order, staff branch
 * scoping and the guest/customer session scope for table-order lists.
 *
 * authMiddleware is replaced by a thin real-JWT implementation so the
 * expiry / signature / type paths are exercised with genuine tokens.
 */
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const SECRET = 'unit-order-access-secret';

jest.mock('../middlewares/authMiddleware', () => {
    const jwtLib = require('jsonwebtoken');
    const TOKEN_TYPES = { SCAN: 'scan', KIOSK: 'kiosk' };
    return {
        TOKEN_TYPES,
        verifyTypedToken: (token, typ) => {
            const decoded = jwtLib.verify(token, 'unit-order-access-secret');
            if (decoded.typ === typ) return decoded;
            const err = new Error(`Token is not a ${typ} token`);
            err.name = 'JsonWebTokenError';
            throw err;
        },
    };
});
jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
    orderAccessForCaller,
    staffBranchFilter,
    scanSessionFromReq,
    applySessionScope,
    ORDER_STAFF_ROLES,
} = require('../services/orderAccess');

const TENANT = '64a000000000000000000001';
const OTHER_TENANT = '64a000000000000000000002';
const OWNER = '64b000000000000000000001';
const STRANGER = '64b000000000000000000002';

const scanToken = (payload, opts = { expiresIn: '1h' }) =>
    jwt.sign({ typ: 'scan', restaurantId: TENANT, tableId: 't1', ...payload }, SECRET, opts);
const req = ({ user = null, token, query } = {}) => ({
    user,
    headers: token ? { 'x-scan-token': token } : {},
    query: query || {},
});
const ownedOrder = { user: OWNER, restaurant: TENANT, scanSessionId: 'sess-1' };
const guestOrder = { user: null, restaurant: TENANT, scanSessionId: 'sess-1' };

describe('orderAccessForCaller matrix', () => {
    test.each([...ORDER_STAFF_ROLES])('staff role %s may act on any order', (role) => {
        expect(orderAccessForCaller(req({ user: { _id: STRANGER, role } }), ownedOrder))
            .toEqual({ allowed: true, isStaff: true });
        expect(orderAccessForCaller(req({ user: { _id: STRANGER, role } }), guestOrder).allowed).toBe(true);
    });

    test('owner allowed; another customer refused; a scan token does not unlock an owned order', () => {
        expect(orderAccessForCaller(req({ user: { _id: OWNER, role: 'customer' } }), ownedOrder).allowed).toBe(true);
        expect(orderAccessForCaller(req({ user: { _id: STRANGER, role: 'customer' } }), ownedOrder).allowed).toBe(false);
        // Even the matching scan session is not enough once the order has an owner.
        const same = scanToken({ sessionId: 'sess-1' });
        expect(orderAccessForCaller(req({ token: same }), ownedOrder).allowed).toBe(false);
    });

    test('guest order: same scan session allowed', () => {
        const res = orderAccessForCaller(req({ token: scanToken({ sessionId: 'sess-1' }) }), guestOrder);
        expect(res.allowed).toBe(true);
        expect(res.isStaff).toBe(false);
    });

    test.each([
        ['no token', () => undefined, 'SCAN_TOKEN_REQUIRED'],
        ['other session', () => scanToken({ sessionId: 'sess-2' }), 'SCAN_SESSION_MISMATCH'],
        ['token without session', () => scanToken({}), 'SCAN_SESSION_MISMATCH'],
        ['other tenant, same session id', () => scanToken({ sessionId: 'sess-1', restaurantId: OTHER_TENANT }), 'SCAN_SESSION_MISMATCH'],
        ['expired token', () => scanToken({ sessionId: 'sess-1', exp: Math.floor(Date.now() / 1000) - 5 }, {}), 'SCAN_TOKEN_EXPIRED'],
        ['wrong signature', () => jwt.sign({ typ: 'scan', sessionId: 'sess-1' }, 'attacker-secret'), 'SCAN_TOKEN_INVALID'],
        ['a user token, not a scan token', () => jwt.sign({ id: OWNER, sessionId: 'sess-1' }, SECRET), 'SCAN_TOKEN_INVALID'],
        ['garbage', () => 'garbage', 'SCAN_TOKEN_INVALID'],
    ])('guest order refused: %s → %s', (_l, mk, reason) => {
        const res = orderAccessForCaller(req({ token: mk() }), guestOrder);
        expect(res).toEqual({ allowed: false, isStaff: false, reason });
    });

    test('a guest order without a recorded scanSessionId is never reachable by a token', () => {
        const res = orderAccessForCaller(req({ token: scanToken({ sessionId: 'sess-1' }) }), { ...guestOrder, scanSessionId: null });
        expect(res).toEqual({ allowed: false, isStaff: false, reason: 'SCAN_SESSION_MISMATCH' });
    });

    test('a logged-in customer acting on a guest order needs the matching scan session', () => {
        const cust = { _id: STRANGER, role: 'customer' };
        expect(orderAccessForCaller(req({ user: cust }), guestOrder).allowed).toBe(false);
        expect(orderAccessForCaller(req({ user: cust, token: scanToken({ sessionId: 'sess-1' }) }), guestOrder).allowed).toBe(true);
    });

    test('a token with no restaurantId is accepted on session match alone (legacy tokens)', () => {
        const legacy = scanToken({ sessionId: 'sess-1', restaurantId: undefined });
        expect(orderAccessForCaller(req({ token: legacy }), guestOrder).allowed).toBe(true);
    });
});

describe('scanSessionFromReq / applySessionScope', () => {
    test('scanSessionFromReq returns the session or null for absent / expired / bad tokens', () => {
        expect(scanSessionFromReq(req({ token: scanToken({ sessionId: 'abc' }) }))).toBe('abc');
        expect(scanSessionFromReq(req())).toBeNull();
        expect(scanSessionFromReq(req({ token: 'nope' }))).toBeNull();
        expect(scanSessionFromReq(req({ token: scanToken({ sessionId: 'abc', exp: 1 }, {}) }))).toBeNull();
        expect(scanSessionFromReq(req({ token: scanToken({}) }))).toBeNull();
    });

    test.each(['admin', 'manager', 'captain', 'waiter', 'chef'])('staff %s: filter unchanged', (role) => {
        const f = { table: 't1' };
        expect(applySessionScope(f, req({ user: { _id: STRANGER, role } }))).toEqual({ table: 't1' });
    });

    test('guest: scoped to their token session; fail-closed sentinel without one', () => {
        expect(applySessionScope({}, req({ token: scanToken({ sessionId: 'S9' }) }))).toEqual({ scanSessionId: 'S9' });
        expect(applySessionScope({}, req())).toEqual({ scanSessionId: '__no_session__' });
        expect(applySessionScope({}, req({ token: 'garbage' }))).toEqual({ scanSessionId: '__no_session__' });
    });

    test('customer: scoped to own orders, scan token ignored', () => {
        const f = applySessionScope({}, req({ user: { _id: OWNER, role: 'customer' }, token: scanToken({ sessionId: 'S9' }) }));
        expect(f).toEqual({ user: OWNER });
    });
});

describe('staffBranchFilter', () => {
    const BR = '64c000000000000000000001';
    test('a pinned user is forced to their branch (as ObjectId) whatever ?branch says', () => {
        for (const q of [{}, { branch: 'all' }, { branch: '64c000000000000000000009' }]) {
            const f = staffBranchFilter(req({ user: { role: 'chef', branch: BR }, query: q }));
            expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
            expect(String(f.branch)).toBe(BR);
        }
        const populated = staffBranchFilter(req({ user: { role: 'admin', branch: { _id: BR } } }));
        expect(String(populated.branch)).toBe(BR);
    });

    test.each([
        [{}, {}],
        [{ branch: 'all' }, {}],
        [{ branch: 'tenant-only' }, { branch: null }],
        [{ branch: 'none' }, { branch: null }],
        [{ branch: 'typo' }, {}],
    ])('unpinned owner with query %j → %j', (query, expected) => {
        expect(staffBranchFilter(req({ user: { role: 'admin', branch: null }, query }))).toEqual(expected);
    });

    test('unpinned owner ?branch=<id> narrows to that branch as an ObjectId', () => {
        const f = staffBranchFilter(req({ user: { role: 'admin' }, query: { branch: BR } }));
        expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(String(f.branch)).toBe(BR);
    });
});
