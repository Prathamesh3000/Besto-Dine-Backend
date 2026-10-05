/**
 * 5.5 — utils/socket.js emit helpers + handshake auth + join gate,
 * realtime/events.js constants, services/orderNotifications.js fan-out
 * (and the orderHelpers emitOrderEvent / emitStaffTable helpers it uses).
 *
 * No DB, no network: models and authMiddleware are mocked, emits go to a
 * fake io that records { rooms, event, payload }. The handshake middleware
 * and the connection handler are pulled out of a real socket.io Server
 * attached to an http server that never listens.
 */
const http = require('http');

jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockBranchFind = jest.fn();
const mockOrderFindOne = jest.fn();
const mockTableFind = jest.fn();
const mockUserFind = jest.fn();
const mockWithdrawalFind = jest.fn();
// `.select().lean()` chain resolving to whatever the per-test fn returns.
const mockChain = (fn) => (...args) => ({ select: () => ({ lean: async () => fn(...args) }) });
jest.mock('../models/branch', () => ({ findById: (...a) => mockChain(mockBranchFind)(...a) }));
jest.mock('../models/order', () => ({ findOne: (...a) => mockChain(mockOrderFindOne)(...a) }));
jest.mock('../models/table', () => ({ findById: (...a) => mockChain(mockTableFind)(...a) }));
jest.mock('../models/user', () => ({ findById: (...a) => mockChain(mockUserFind)(...a) }));
jest.mock('../models/staffWithdrawal', () => ({ findById: (...a) => mockChain(mockWithdrawalFind)(...a) }));
jest.mock('../models/menuItem', () => ({ bulkWrite: jest.fn() }));

jest.mock('../middlewares/authMiddleware', () => ({
    TOKEN_TYPES: { USER: 'user', SCAN: 'scan', KIOSK: 'kiosk' },
    verifyUserToken: jest.fn(),
    verifyTypedToken: jest.fn(),
    loadUserForToken: jest.fn(),
    signTypedToken: jest.fn(() => 'signed'),
}));

jest.mock('../services/notificationService', () => ({
    notify: jest.fn(async () => ({ ok: true, docs: [] })),
}));
const mockFindWaiters = jest.fn();
jest.mock('../utils/staffAssignment', () => ({ findWaitersForTable: (...a) => mockFindWaiters(...a) }));

// Redis adapter path (#35) — no real Redis: fake clients + the in-memory
// adapter class standing in for the redis one.
const mockRedisClients = [];
jest.mock('redis', () => ({
    createClient: jest.fn(() => {
        const mk = () => {
            const c = {
                handlers: {},
                isOpen: true,
                isReady: false,
                on(ev, fn) { c.handlers[ev] = fn; return c; },
                connect: jest.fn(async () => { c.isReady = true; }),
                destroy: jest.fn(),
                close: jest.fn(async () => {}),
                duplicate: () => mk(),
            };
            mockRedisClients.push(c);
            return c;
        };
        return mk();
    }),
}));
jest.mock('@socket.io/redis-adapter', () => ({
    createAdapter: jest.fn(() => require('socket.io-adapter').Adapter),
}));

// Real emit helpers; only getIO is redirected to the per-test fake io so
// orderHelpers / orderNotifications route through the real tenant logic.
let mockIo = null;
jest.mock('../utils/socket', () => ({
    ...jest.requireActual('../utils/socket'),
    getIO: () => {
        if (!mockIo) throw new Error('Socket.io not initialized');
        return mockIo;
    },
}));

const logger = require('../utils/logger');
const auth = require('../middlewares/authMiddleware');
const { notify } = require('../services/notificationService');
const socket = require('../utils/socket');
const EVENTS = require('../realtime/events');
const on = require('../services/orderNotifications');
const MenuItem = require('../models/menuItem');
const helpers = require('../services/orderHelpers');
const { emitOrderEvent, emitStaffTable, runAfterResponse } = helpers;

const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const B1 = '111111111111111111111111'; // branch of T1
const B2 = '222222222222222222222222'; // other branch of T1
const BX = '999999999999999999999999'; // branch of T2
const U1 = 'cccccccccccccccccccccccc'; // customer
const U2 = 'dddddddddddddddddddddddd'; // another customer
const W1 = 'eeeeeeeeeeeeeeeeeeeeeeee'; // waiter
const TB = 'ffffffffffffffffffffffff'; // table

const branchTenants = { [B1]: T1, [B2]: T1, [BX]: T2 };

function fakeIO() {
    const sent = [];
    return {
        sent,
        to: jest.fn((rooms) => ({ emit: (event, payload) => sent.push({ rooms: [].concat(rooms), event, payload }) })),
    };
}
// Rooms that received `event` (flattened).
const roomsFor = (io, event) => io.sent.filter((s) => s.event === event).flatMap((s) => s.rooms);
const allRooms = (io) => io.sent.flatMap((s) => s.rooms);
const flush = () => new Promise((r) => setImmediate(r));
const staffRooms = (rid, bid) => {
    const out = [];
    for (const role of ['admin', 'waiter', 'kitchen']) {
        out.push(...(bid ? [`t:${rid}:${role}:${bid}`, `t:${rid}:${role}`] : [`t:${rid}:${role}`, `t:${rid}:${role}:unbranched`]));
    }
    return out;
};

beforeEach(() => {
    jest.clearAllMocks();
    mockIo = fakeIO();
    const { caches } = socket._internals;
    caches.branch.clear(); caches.order.clear(); caches.table.clear();
    mockBranchFind.mockImplementation(async (id) => (branchTenants[id] ? { restaurant: branchTenants[id] } : null));
    mockOrderFindOne.mockResolvedValue(null);
    mockTableFind.mockResolvedValue(null);
    mockUserFind.mockResolvedValue(null);
    mockWithdrawalFind.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────
describe('realtime/events', () => {
    test('event names are unique, frozen and exposed both ways', () => {
        expect(new Set(EVENTS.ALL_EVENTS).size).toBe(EVENTS.ALL_EVENTS.length);
        expect(Object.isFrozen(EVENTS)).toBe(true);
        expect(Object.isFrozen(EVENTS.EVENTS)).toBe(true);
        expect(EVENTS.ORDER_NEW).toBe('order:new');
        expect(EVENTS.EVENTS.ORDER_NEW).toBe('order:new');
        expect(() => { 'use strict'; EVENTS.ORDER_NEW = 'x'; }).toThrow();
    });

    test.each([
        ['ORDER_UPDATED', 'order:updated'],
        ['ORDER_READY', 'order:ready'],
        ['ORDER_CANCELLED', 'order:cancelled'],
        ['TABLE_UPDATED', 'table:updated'],
        ['SESSION_ENDED', 'session:ended'],
        ['COUNTER_PAYMENT_REQUESTED', 'counter-payment:requested'],
        ['REFUND_REQUEST_DECIDED', 'refund-request:decided'],
        ['STALE_ORDERS_DETECTED', 'stale-orders:detected'],
        ['AUTH_RELOAD', 'auth:reload'],
    ])('wire name %s = %s', (k, v) => {
        expect(EVENTS[k]).toBe(v);
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('emit helpers — room naming + tenant guard', () => {
    test.each([
        ['emitToStaff', ['admin', 'waiter', 'kitchen']],
        ['emitToAdmin', ['admin']],
        ['emitToKitchen', ['kitchen']],
        ['emitToWaiter', ['waiter']],
        ['emitToCaptain', ['captain']],
    ])('%s with a populated branch → branch + tenant-level rooms of %j only', (fn, roles) => {
        const io = fakeIO();
        socket[fn](io, { _id: B1, restaurant: T1 }, 'x:event', { a: 1 });
        const expected = roles.flatMap((r) => [`t:${T1}:${r}:${B1}`, `t:${T1}:${r}`]);
        expect(io.sent).toEqual([{ rooms: expected, event: 'x:event', payload: { a: 1 } }]);
    });

    test('branch null + payload.restaurant → tenant-level + unbranched rooms', () => {
        const io = fakeIO();
        socket.emitToAdmin(io, null, 'e', { restaurant: T1 });
        expect(io.sent[0].rooms).toEqual([`t:${T1}:admin`, `t:${T1}:admin:unbranched`]);
    });

    test.each([['restaurant'], ['restaurantId'], ['tenantId']])('payload hint key %s is honoured', (key) => {
        const io = fakeIO();
        socket.emitToWaiter(io, null, 'e', { [key]: T2 });
        expect(io.sent[0].rooms).toEqual([`t:${T2}:waiter`, `t:${T2}:waiter:unbranched`]);
    });

    test('no tenant hint at all → dropped + warned, never broadcast', async () => {
        const io = fakeIO();
        socket.emitToStaff(io, null, 'order:updated', { orderId: 'ORD-NOPE', status: 'ready' });
        await flush();
        expect(io.to).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('socket emit dropped: tenant unresolved',
            expect.objectContaining({ event: 'order:updated', orderId: 'ORD-NOPE' }));
    });

    test.each([
        ['non-ObjectId hint', { restaurant: 'not-an-id' }],
        ['object without id', { restaurant: {} }],
        ['empty payload', {}],
        ['non-object payload', 'string-payload'],
        ['null payload', null],
    ])('%s → dropped', async (_label, payload) => {
        const io = fakeIO();
        socket.emitToAdmin(io, null, 'e', payload);
        await flush();
        expect(io.sent).toEqual([]);
    });

    test('branch id is authoritative: emits to the branch owner even if payload claims another tenant', async () => {
        const io = fakeIO();
        socket.emitToKitchen(io, B1, 'order:new', { orderId: 'O1', restaurant: T2 });
        await flush();
        expect(mockBranchFind).toHaveBeenCalledWith(B1);
        expect(io.sent).toEqual([{ rooms: [`t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen`], event: 'order:new', payload: { orderId: 'O1', restaurant: T2 } }]);
        expect(allRooms(io).some((r) => r.includes(T2))).toBe(false);
    });

    test('unknown branch id → dropped even with a payload tenant hint', async () => {
        const io = fakeIO();
        socket.emitToKitchen(io, '123456789012345678901234', 'order:new', { restaurant: T1 });
        await flush();
        expect(io.sent).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith('socket emit dropped: tenant unresolved', expect.any(Object));
    });

    test('non-ObjectId branch id → no DB lookup, dropped', async () => {
        const io = fakeIO();
        socket.emitToAdmin(io, 'main-branch', 'e', { restaurant: T1 });
        await flush();
        expect(mockBranchFind).not.toHaveBeenCalled();
        expect(io.sent).toEqual([]);
    });

    test('branch lookup is cached: second emit is synchronous and does not hit the DB', async () => {
        const io = fakeIO();
        socket.emitToAdmin(io, B2, 'e1', {});
        await flush();
        socket.emitToAdmin(io, B2, 'e2', {});
        // synchronous — no flush needed
        expect(io.sent.map((s) => s.event)).toEqual(['e1', 'e2']);
        expect(mockBranchFind).toHaveBeenCalledTimes(1);
    });

    test('branch cache expires after the 5 min TTL', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
        try {
            const io = fakeIO();
            socket.emitToAdmin(io, B1, 'e', {});
            await flush();
            jest.setSystemTime(new Date('2026-10-03T10:04:59Z'));
            socket.emitToAdmin(io, B1, 'e', {});
            expect(mockBranchFind).toHaveBeenCalledTimes(1);
            jest.setSystemTime(new Date('2026-10-03T10:05:01Z'));
            socket.emitToAdmin(io, B1, 'e', {});
            await flush();
            expect(mockBranchFind).toHaveBeenCalledTimes(2);
            expect(io.sent).toHaveLength(3);
        } finally {
            jest.useRealTimers();
        }
    });

    test('negative branch lookups are never cached', async () => {
        const io = fakeIO();
        const NEWB = '333333333333333333333333';
        socket.emitToAdmin(io, NEWB, 'e', {});
        await flush();
        expect(io.sent).toEqual([]);
        branchTenants[NEWB] = T2;
        socket.emitToAdmin(io, NEWB, 'e', {});
        await flush();
        expect(io.sent[0].rooms).toEqual([`t:${T2}:admin:${NEWB}`, `t:${T2}:admin`]);
        delete branchTenants[NEWB];
    });

    test('a DB error during lookup drops the emit (fails closed)', async () => {
        mockBranchFind.mockRejectedValueOnce(new Error('mongo down'));
        const io = fakeIO();
        socket.emitToStaff(io, B1, 'e', {});
        await flush();
        expect(io.sent).toEqual([]);
    });

    test('payload.orderId resolves the tenant via the order', async () => {
        mockOrderFindOne.mockResolvedValue({ restaurant: T2 });
        const io = fakeIO();
        socket.emitToAdmin(io, null, 'e', { orderId: 'ORD-77' });
        await flush();
        expect(mockOrderFindOne).toHaveBeenCalledWith({ orderId: 'ORD-77' });
        expect(io.sent[0].rooms).toEqual([`t:${T2}:admin`, `t:${T2}:admin:unbranched`]);
    });

    test.each([
        ['tableId', { tableId: TB }, () => mockTableFind.mockResolvedValue({ restaurant: T1 })],
        ['table', { table: TB }, () => mockTableFind.mockResolvedValue({ restaurant: T1 })],
        ['withdrawalId', { withdrawalId: TB }, () => mockWithdrawalFind.mockResolvedValue({ restaurant: T1 })],
        ['userId', { userId: W1 }, () => mockUserFind.mockResolvedValue({ restaurant: T1 })],
        ['staffId', { staffId: W1 }, () => mockUserFind.mockResolvedValue({ restaurant: T1 })],
    ])('payload.%s lookup resolves the tenant', async (_k, payload, setup) => {
        setup();
        const io = fakeIO();
        socket.emitToWaiter(io, null, 'e', payload);
        await flush();
        expect(io.sent[0].rooms).toEqual([`t:${T1}:waiter`, `t:${T1}:waiter:unbranched`]);
    });

    test('a null io is a no-op', () => {
        expect(() => socket.emitToStaff(null, B1, 'e', {})).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('request-context tenant (AsyncLocalStorage)', () => {
    const fakeRes = () => {
        const handlers = {};
        return { once: (ev, fn) => { handlers[ev] = fn; }, fire: (ev) => handlers[ev] && handlers[ev]() };
    };

    test('emit inside a request with no payload hint uses req.restaurant', () => {
        const io = fakeIO();
        socket.socketRequestContext({ restaurant: { _id: T2 } }, fakeRes(), () => {
            socket.emitToAdmin(io, null, 'notification:new', { title: 't' });
        });
        expect(io.sent[0].rooms).toEqual([`t:${T2}:admin`, `t:${T2}:admin:unbranched`]);
    });

    test('falls back to req.user.restaurant', () => {
        const io = fakeIO();
        socket.socketRequestContext({ user: { restaurant: T1 } }, fakeRes(), () => {
            socket.emitToAdmin(io, null, 'e', {});
        });
        expect(io.sent[0].rooms[0]).toBe(`t:${T1}:admin`);
    });

    test('a payload hint wins over the request tenant', () => {
        const io = fakeIO();
        socket.socketRequestContext({ restaurant: { _id: T1 } }, fakeRes(), () => {
            socket.emitToAdmin(io, null, 'e', { restaurant: T2 });
        });
        expect(io.sent[0].rooms[0]).toBe(`t:${T2}:admin`);
    });

    test('a timer that outlives the request by > 30s no longer trusts the request tenant', async () => {
        jest.useFakeTimers({ now: new Date('2026-10-03T10:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
        try {
            const io = fakeIO();
            const res = fakeRes();
            let later;
            socket.socketRequestContext({ restaurant: { _id: T1 } }, res, () => {
                later = () => socket.emitToAdmin(io, null, 'late', {});
            });
            res.fire('finish');
            jest.setSystemTime(new Date('2026-10-03T10:00:29Z'));
            // re-enter the same store as a timer created in the request would
            const store = socket._internals.requestStore;
            const captured = { req: { restaurant: { _id: T1 } }, finishedAt: new Date('2026-10-03T10:00:00Z').getTime() };
            store.run(captured, () => later());
            expect(io.sent).toHaveLength(1);
            jest.setSystemTime(new Date('2026-10-03T10:00:31Z'));
            store.run(captured, () => later());
            await flush();
            expect(io.sent).toHaveLength(1);
            expect(logger.warn).toHaveBeenCalledWith('socket emit dropped: tenant unresolved', expect.objectContaining({ event: 'late' }));
        } finally {
            jest.useRealTimers();
        }
    });

    test('a non-ObjectId request tenant is ignored', async () => {
        const io = fakeIO();
        socket.socketRequestContext({ restaurant: { _id: 'garbage' } }, fakeRes(), () => {
            socket.emitToAdmin(io, null, 'e', {});
        });
        await flush();
        expect(io.sent).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('legacy room translation + staffRoom', () => {
    const { translateRoom } = socket._internals;

    test.each(['kitchen', 'admin', 'waiter', 'captain', 'manager', `kitchen:${B1}`])(
        'legacy room %s with no tenant → dead room', (room) => {
            expect(translateRoom(room)).toBe('__tenant_unresolved__');
        },
    );

    test('legacy branch room uses the cached branch tenant', async () => {
        socket.emitToAdmin(fakeIO(), B1, 'warm', {});
        await flush();
        expect(translateRoom(`kitchen:${B1}`)).toBe(`t:${T1}:kitchen:${B1}`);
    });

    test('legacy room inside a request → that tenant', () => {
        let out;
        socket.socketRequestContext({ restaurant: { _id: T2 } }, null, () => { out = translateRoom('captain'); });
        expect(out).toBe(`t:${T2}:captain`);
    });

    test.each([`order:ORD-1`, `table:${TB}`, U1, `t:${T1}:admin`])('non-legacy room %s is untouched', (room) => {
        expect(translateRoom(room)).toBe(room);
    });

    test('staffRoom with explicit tenant targets the namespaced rooms; unresolved → dead room', () => {
        const io = fakeIO();
        socket.staffRoom(io, 'kitchen', B1, T1).emit('e', {});
        socket.staffRoom(io, 'kitchen', null, null).emit('e2', {});
        expect(io.sent[0].rooms).toEqual([`t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen`]);
        expect(io.sent[1].rooms).toEqual(['__tenant_unresolved__']);
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('socket.io server: handshake auth, auto-join, join gate', () => {
    let realIo;
    let server;
    let authMw;
    let onConnection;

    beforeAll(() => {
        delete process.env.REDIS_URL;
        server = http.createServer();
        realIo = socket.init(server, ['http://localhost']);
        authMw = realIo.sockets._fns[0];
        onConnection = realIo.sockets.listeners('connection')[0];
    });
    afterAll(async () => {
        await socket.close();
    });

    const handshake = (authObj) => new Promise((resolve) => {
        const s = { handshake: { auth: authObj }, data: {} };
        authMw(s, (err) => resolve({ err, data: s.data }));
    });

    function connectFake(data) {
        const handlers = {};
        const s = {
            data,
            join: jest.fn(),
            leave: jest.fn(),
            on: (ev, fn) => { handlers[ev] = fn; },
        };
        onConnection(s);
        return { s, handlers };
    }

    test('single-instance mode when REDIS_URL is unset', () => {
        expect(socket.isMultiInstance()).toBe(false);
    });

    test('valid staff token → identity from the DB user (DB role/branch win over token)', async () => {
        auth.verifyUserToken.mockReturnValue({ id: W1, role: 'admin', typ: 'user' });
        auth.loadUserForToken.mockResolvedValue({ _id: W1, role: 'waiter', branch: { _id: B1 }, restaurant: T1, status: 'active' });
        const { err, data } = await handshake({ token: 'tok' });
        expect(err).toBeUndefined();
        expect(data).toEqual({ userId: W1, role: 'waiter', branchId: B1, restaurant: T1 });
    });

    test('customer token → no branchId on the socket', async () => {
        auth.verifyUserToken.mockReturnValue({ id: U1, typ: 'user' });
        auth.loadUserForToken.mockResolvedValue({ _id: U1, role: 'customer', branch: B1, restaurant: T1 });
        const { data } = await handshake({ token: 'tok' });
        expect(data).toEqual({ userId: U1, role: 'customer', restaurant: T1 });
    });

    test('expired access token → AUTH_EXPIRED connect error', async () => {
        auth.verifyUserToken.mockImplementation(() => { const e = new Error('jwt expired'); e.name = 'TokenExpiredError'; throw e; });
        const { err } = await handshake({ token: 'old' });
        expect(err.message).toBe('AUTH_EXPIRED');
        expect(err.data).toEqual({ code: 'AUTH_EXPIRED' });
    });

    test('revoked token (loadUserForToken null) → AUTH_REVOKED', async () => {
        auth.verifyUserToken.mockReturnValue({ id: W1, typ: 'user' });
        auth.loadUserForToken.mockResolvedValue(null);
        const { err } = await handshake({ token: 'tok' });
        expect(err.message).toBe('AUTH_REVOKED');
    });

    test('wrong token type (scan token as access token) → treated as guest, no identity', async () => {
        auth.verifyUserToken.mockImplementation(() => { const e = new Error('Token is not a user session token'); e.name = 'JsonWebTokenError'; throw e; });
        const { err, data } = await handshake({ token: 'scan-token-as-user' });
        expect(err).toBeUndefined();
        expect(data).toEqual({});
        expect(auth.loadUserForToken).not.toHaveBeenCalled();
    });

    test('inactive user → connects with no identity', async () => {
        auth.verifyUserToken.mockReturnValue({ id: W1, typ: 'user' });
        auth.loadUserForToken.mockResolvedValue({ _id: W1, role: 'admin', restaurant: T1, status: 'inactive' });
        const { err, data } = await handshake({ token: 'tok' });
        expect(err).toBeUndefined();
        expect(data).toEqual({});
    });

    test('DB failure while loading the user → fail closed (no tenant)', async () => {
        auth.verifyUserToken.mockReturnValue({ id: W1, typ: 'user' });
        auth.loadUserForToken.mockRejectedValue(new Error('db down'));
        const { err, data } = await handshake({ token: 'tok' });
        expect(err).toBeUndefined();
        expect(data).toEqual({ userId: null, role: null, restaurant: null });
    });

    test('valid scan token → scan identity; verified as SCAN type', async () => {
        auth.verifyTypedToken.mockReturnValue({ tableId: TB, restaurantId: T1, sessionId: 's-1', typ: 'scan' });
        const { data } = await handshake({ scanToken: 'scan' });
        expect(auth.verifyTypedToken).toHaveBeenCalledWith('scan', 'scan');
        expect(data).toEqual({ scan: { tableId: TB, restaurantId: T1, sessionId: 's-1' } });
    });

    test.each([
        ['expired', () => { const e = new Error('jwt expired'); e.name = 'TokenExpiredError'; throw e; }],
        ['wrong type', () => { throw new Error('Token is not a scan token'); }],
    ])('%s scan token → ignored, still connects', async (_l, impl) => {
        auth.verifyTypedToken.mockImplementation(impl);
        const { err, data } = await handshake({ scanToken: 'bad' });
        expect(err).toBeUndefined();
        expect(data).toEqual({});
    });

    test('scan token without tableId → no scan identity', async () => {
        auth.verifyTypedToken.mockReturnValue({ restaurantId: T1, typ: 'scan' });
        const { data } = await handshake({ scanToken: 'x' });
        expect(data.scan).toBeUndefined();
    });

    test('no auth at all → anonymous connect', async () => {
        const { err, data } = await handshake(undefined);
        expect(err).toBeUndefined();
        expect(data).toEqual({});
    });

    test('connection auto-joins rooms from identity', () => {
        const { s } = connectFake({ userId: W1, role: 'chef', restaurant: T1, branchId: B1 });
        expect(s.join).toHaveBeenCalledWith(expect.arrayContaining([W1, `t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen:unbranched`, `t:${T1}:menu`]));
        const joined = s.join.mock.calls[0][0];
        expect(joined.some((r) => r.includes(T2))).toBe(false);
    });

    test('anonymous connection joins nothing', () => {
        const { s } = connectFake({});
        expect(s.join).not.toHaveBeenCalled();
    });

    test.each([
        ['other tenant kitchen', `t:${T2}:kitchen`],
        ['other tenant branch room', `t:${T2}:admin:${BX}`],
        ['legacy global kitchen', 'kitchen'],
        ['legacy branch room', `admin:${B1}`],
        ['own tenant, other branch (pinned)', `t:${T1}:kitchen:${B2}`],
        ['own tenant, role not listened', `t:${T1}:admin`],
        ['another user room', U2],
        ['superadmin', 'superadmin'],
        ['table room without scan', `table:${TB}`],
        ['non-string', { room: 'x' }],
    ])('join refused: %s', async (_l, room) => {
        const { s, handlers } = connectFake({ userId: W1, role: 'chef', restaurant: T1, branchId: B1 });
        s.join.mockClear();
        await handlers.join(room);
        expect(s.join).not.toHaveBeenCalled();
    });

    test('join for another tenant room is logged as a cross-tenant attempt', async () => {
        const { handlers } = connectFake({ userId: W1, role: 'admin', restaurant: T1 });
        await handlers.join(`t:${T2}:admin`);
        expect(logger.warn).toHaveBeenCalledWith('canJoin cross-tenant room attempt blocked', expect.any(Object));
    });

    test('unpinned admin may join a branch room only if the branch belongs to its tenant', async () => {
        const { s, handlers } = connectFake({ userId: W1, role: 'admin', restaurant: T1 });
        s.join.mockClear();
        await handlers.join(`t:${T1}:kitchen:${BX}`); // BX belongs to T2
        expect(s.join).not.toHaveBeenCalled();
        await handlers.join(`t:${T1}:kitchen:${B2}`);
        expect(s.join).toHaveBeenCalledWith(`t:${T1}:kitchen:${B2}`);
    });

    test('order room: owner may join; another customer may not; other tenant staff may not', async () => {
        mockOrderFindOne.mockResolvedValue({ user: U1, restaurant: T1, branch: B1, table: TB, scanSessionId: 's-1' });
        const owner = connectFake({ userId: U1, role: 'customer', restaurant: T1 });
        const other = connectFake({ userId: U2, role: 'customer', restaurant: T1 });
        const foreignStaff = connectFake({ userId: W1, role: 'admin', restaurant: T2 });
        const pinnedOtherBranch = connectFake({ userId: W1, role: 'waiter', restaurant: T1, branchId: B2 });
        for (const c of [owner, other, foreignStaff, pinnedOtherBranch]) c.s.join.mockClear();
        await owner.handlers.join('order:ORD-1');
        await other.handlers.join('order:ORD-1');
        await foreignStaff.handlers.join('order:ORD-1');
        await pinnedOtherBranch.handlers.join('order:ORD-1');
        expect(owner.s.join).toHaveBeenCalledWith('order:ORD-1');
        expect(other.s.join).not.toHaveBeenCalled();
        expect(foreignStaff.s.join).not.toHaveBeenCalled();
        expect(pinnedOtherBranch.s.join).not.toHaveBeenCalled();
    });

    test('order room: guest must hold the same scan session (same table is not enough)', async () => {
        mockOrderFindOne.mockResolvedValue({ user: null, restaurant: T1, branch: B1, table: TB, scanSessionId: 's-1' });
        const same = connectFake({ scan: { tableId: TB, restaurantId: T1, sessionId: 's-1' } });
        const otherParty = connectFake({ scan: { tableId: TB, restaurantId: T1, sessionId: 's-2' } });
        const otherTenantScan = connectFake({ scan: { tableId: TB, restaurantId: T2, sessionId: 's-1' } });
        for (const c of [same, otherParty, otherTenantScan]) c.s.join.mockClear();
        await same.handlers.join('order:ORD-1');
        await otherParty.handlers.join('order:ORD-1');
        await otherTenantScan.handlers.join('order:ORD-1');
        expect(same.s.join).toHaveBeenCalledWith('order:ORD-1');
        expect(otherParty.s.join).not.toHaveBeenCalled();
        expect(otherTenantScan.s.join).not.toHaveBeenCalled();
    });

    test('order lookup failure → join refused, no throw', async () => {
        mockOrderFindOne.mockRejectedValue(new Error('db'));
        const c = connectFake({ userId: U1, role: 'customer', restaurant: T1 });
        c.s.join.mockClear();
        await expect(c.handlers.join('order:ORD-1')).resolves.toBeUndefined();
        expect(c.s.join).not.toHaveBeenCalled();
    });

    test('leave only accepts non-empty strings', () => {
        const c = connectFake({});
        c.handlers.leave('');
        c.handlers.leave(null);
        c.handlers.leave('order:ORD-1');
        expect(c.s.leave).toHaveBeenCalledTimes(1);
    });

    test('real io.to() rewrites legacy global rooms to the dead room', () => {
        const op = realIo.to('kitchen');
        expect([...op.rooms]).toEqual(['__tenant_unresolved__']);
        const chained = realIo.to(`t:${T1}:admin`).to('waiter');
        expect([...chained.rooms]).toEqual([`t:${T1}:admin`, '__tenant_unresolved__']);
        const viaExcept = realIo.to(`order:X`).except('nobody').to('captain');
        expect([...viaExcept.rooms]).toContain('__tenant_unresolved__');
    });

    test('emitMenuUpdated → only that tenant menu room; unresolved tenant dropped', () => {
        const spy = jest.spyOn(realIo, 'to');
        socket.emitMenuUpdated(T1, { itemIds: ['m1'] });
        expect(spy).toHaveBeenCalledWith(`t:${T1}:menu`);
        spy.mockClear();
        socket.emitMenuUpdated(null, {});
        socket.emitMenuUpdated('junk', {});
        expect(spy).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('menu:updated dropped: tenant unresolved');
        spy.mockRestore();
    });

    test('notifyAuthReload targets the user room only; null user is a no-op', () => {
        const spy = jest.spyOn(realIo, 'to');
        socket.notifyAuthReload(U1, 'role-change');
        socket.notifyAuthReload(null);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(U1);
        spy.mockRestore();
    });

    test('emitToSuperadmin targets the superadmin room', () => {
        const spy = jest.spyOn(realIo, 'to');
        socket.emitToSuperadmin('x', {});
        expect(spy).toHaveBeenCalledWith('superadmin');
        spy.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('orderHelpers.emitOrderEvent / emitStaffTable', () => {
    test('order event → staff at the order branch + owner + order room; never another customer', async () => {
        emitOrderEvent('order:updated', { orderId: 'O1', status: 'ready' }, { orderId: 'O1', branch: B1, user: U1 });
        await flush();
        const rooms = allRooms(mockIo);
        expect(rooms).toEqual(expect.arrayContaining([...staffRooms(T1, B1), U1, 'order:O1']));
        expect(rooms).not.toContain(U2);
        expect(rooms.some((r) => r.includes(B2) || r.includes(T2))).toBe(false);
    });

    test('guest order (no user) → no user room', async () => {
        emitOrderEvent('order:cancelled', { orderId: 'O2' }, { orderId: 'O2', branch: B1, user: null });
        await flush();
        expect(allRooms(mockIo)).not.toContain('null');
        expect(allRooms(mockIo)).toContain('order:O2');
    });

    test('socket not initialised → swallowed', () => {
        mockIo = null;
        expect(() => emitOrderEvent('e', {}, { orderId: 'x' })).not.toThrow();
        expect(() => emitStaffTable('e', {}, B1)).not.toThrow();
    });

    test('emitStaffTable targets only staff of the branch tenant', async () => {
        emitStaffTable('table:updated', { tableId: TB, status: 'free' }, BX);
        await flush();
        expect(allRooms(mockIo)).toEqual(staffRooms(T2, BX));
    });

    test('runAfterResponse swallows + logs task failures', async () => {
        runAfterResponse('label-x', async () => { throw new Error('boom'); });
        await flush(); await flush();
        expect(logger.warn).toHaveBeenCalledWith('label-x failed (non-fatal):', { error: 'boom' });
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('orderNotifications', () => {
    const order = (over = {}) => ({
        orderId: 'ORD-9', restaurant: T1, branch: B1, user: U1, table: TB,
        type: 'dine-in', status: 'ready', paymentStatus: 'Pending', total: 525.5,
        items: [{ name: 'Paneer', quantity: 2 }], ...over,
    });
    const notifyCalls = () => notify.mock.calls.map((c) => c[0]);

    describe('notifyStatusTransition', () => {
        test('ready → waiter row for the order branch + customer row to the owner only', async () => {
            await on.notifyStatusTransition({ status: 'ready', oldOrder: { status: 'preparing' }, order: order() });
            const calls = notifyCalls();
            expect(calls).toHaveLength(2);
            expect(calls[0]).toMatchObject({ restaurant: T1, branch: B1, notification: { recipientRole: 'waiter', meta: { orderId: 'ORD-9', table: TB } } });
            expect(calls[0].recipients).toBeUndefined();
            expect(calls[1]).toMatchObject({ restaurant: T1, recipients: [U1], notification: { recipientRole: 'customer' } });
            expect(calls[1].notification.description).toMatch(/served to your table/);
        });

        test.each([
            ['preparing', 'Order Being Prepared'],
            ['served', 'Order Served'],
            ['cancelled', 'Order Cancelled'],
        ])('%s → one customer row "%s" to the owner', async (status, title) => {
            await on.notifyStatusTransition({ status, oldOrder: { status: 'new' }, order: order({ status }) });
            expect(notifyCalls()).toEqual([expect.objectContaining({ restaurant: T1, recipients: [U1], notification: expect.objectContaining({ title }) })]);
        });

        test('served takeaway says "picked up"', async () => {
            await on.notifyStatusTransition({ status: 'served', oldOrder: { status: 'ready' }, order: order({ type: 'takeaway' }) });
            expect(notifyCalls()[0].notification.title).toBe('Order Delivered');
        });

        test.each(['ready', 'preparing', 'served', 'cancelled'])('repeat %s → %s is a no-op', async (s) => {
            await on.notifyStatusTransition({ status: s, oldOrder: { status: s }, order: order({ status: s }) });
            expect(notify).not.toHaveBeenCalled();
        });

        test('guest order: no customer notifications, waiter still notified on ready', async () => {
            await on.notifyStatusTransition({ status: 'ready', oldOrder: { status: 'new' }, order: order({ user: null }) });
            await on.notifyStatusTransition({ status: 'preparing', oldOrder: { status: 'new' }, order: order({ user: null }) });
            const calls = notifyCalls();
            expect(calls).toHaveLength(1);
            expect(calls[0].notification.recipientRole).toBe('waiter');
        });
    });

    describe('emitStatusUpdateEvents', () => {
        test('order:updated to branch staff + owner + order room; ready pings waiter room, owner and order room', async () => {
            await on.emitStatusUpdateEvents({ io: mockIo, status: 'ready', order: order({ waiter: W1 }), settings: null });
            await flush();
            expect(roomsFor(mockIo, 'order:updated')).toEqual(expect.arrayContaining([...staffRooms(T1, B1), U1, 'order:ORD-9']));
            expect(roomsFor(mockIo, 'order:ready')).toEqual(expect.arrayContaining([`t:${T1}:waiter:${B1}`, `t:${T1}:waiter`, U1, 'order:ORD-9']));
            expect(roomsFor(mockIo, 'order:ready')).not.toContain(`t:${T1}:kitchen:${B1}`);
            expect(notifyCalls()).toEqual([expect.objectContaining({ recipients: [W1], restaurant: T1, branch: B1 })]);
            expect(allRooms(mockIo).some((r) => r.includes(T2) || r === U2)).toBe(false);
        });

        test('payload of order:updated carries only id/status/paymentStatus', async () => {
            await on.emitStatusUpdateEvents({ io: mockIo, status: 'preparing', order: order({ phone: '9999', customerName: 'X' }), settings: null });
            await flush();
            const p = mockIo.sent.find((s) => s.event === 'order:updated').payload;
            expect(p).toEqual({ orderId: 'ORD-9', status: 'ready', paymentStatus: 'Pending' });
        });

        test('settings.notifications.orderReady=false suppresses the ready pings', async () => {
            await on.emitStatusUpdateEvents({ io: mockIo, status: 'ready', order: order({ waiter: W1 }), settings: { notifications: { orderReady: false } } });
            await flush();
            expect(roomsFor(mockIo, 'order:ready')).toEqual([]);
            expect(notify).not.toHaveBeenCalled();
        });

        test('ready without assigned waiter → no personal notification', async () => {
            await on.emitStatusUpdateEvents({ io: mockIo, status: 'ready', order: order(), settings: {} });
            expect(notify).not.toHaveBeenCalled();
        });
    });

    describe('notifyCounterPaymentRequested', () => {
        const req = { restaurant: { _id: T1 } };
        const args = (over = {}) => ({ order: order({ status: 'served', counterPaymentRequestedAt: 'when' }), payableTotal: 412.75, tableLabel: 'Table T5', tableAreaName: 'Hall', responsibleWaiterId: W1, ...over });

        test('admin + captain + the table waiter, all under the request tenant + order branch', async () => {
            await on.notifyCounterPaymentRequested(req, args());
            const calls = notifyCalls();
            expect(calls.map((c) => c.audience || 'personal')).toEqual(['admin', 'captain', 'personal']);
            for (const c of calls) {
                expect(c.restaurant).toBe(T1);
                expect(c.branch).toBe(B1);
                expect(c.event).toBe('counter-payment:requested');
                expect(c.payload).toEqual({ orderId: 'ORD-9', amount: 412.75, table: 'Table T5' });
            }
            expect(calls[2].recipients).toEqual([W1]);
            expect(calls[1].notification.meta.table).toBe('T5');
            expect(calls[0].notification.description).toBe('Table T5 wants to settle the bill — ₹412.75 cash');
            await flush();
            expect(roomsFor(mockIo, 'order:updated')).toEqual(expect.arrayContaining([...staffRooms(T1, B1), U1, 'order:ORD-9']));
        });

        test('no responsible waiter → no personal row', async () => {
            await on.notifyCounterPaymentRequested(req, args({ responsibleWaiterId: null }));
            expect(notifyCalls()).toHaveLength(2);
        });

        test('a failure is swallowed and logged', async () => {
            notify.mockRejectedValueOnce(new Error('kaboom'));
            await expect(on.notifyCounterPaymentRequested(req, args())).resolves.toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith('counter-payment notification fanout failed:', 'kaboom');
        });
    });

    describe('notifyCustomerCancellation', () => {
        test('chef + admin rows, order:cancelled + table:updated to branch staff, owner confirmation', async () => {
            await on.notifyCustomerCancellation(order({ status: 'cancelled' }), 'changed mind');
            const calls = notifyCalls();
            expect(calls.map((c) => c.notification.recipientRole)).toEqual(['chef', 'admin', 'customer']);
            expect(calls[0].notification.description).toMatch(/Reason: changed mind/);
            expect(calls[2].recipients).toEqual([U1]);
            await flush();
            expect(roomsFor(mockIo, 'order:cancelled')).toEqual(expect.arrayContaining([...staffRooms(T1, B1), U1, 'order:ORD-9']));
            expect(roomsFor(mockIo, 'table:updated')).toEqual(staffRooms(T1, B1));
            expect(mockIo.sent.find((s) => s.event === 'table:updated').payload).toEqual({ tableId: TB, status: 'free' });
        });

        test('takeaway guest order: no table:updated, no customer row, reason defaults', async () => {
            await on.notifyCustomerCancellation(order({ type: 'takeaway', table: null, user: null }), '');
            expect(notifyCalls()).toHaveLength(2);
            expect(notifyCalls()[0].notification.description).toMatch(/Not provided/);
            await flush();
            expect(roomsFor(mockIo, 'table:updated')).toEqual([]);
        });
    });

    describe('notifyPaymentConfirmed', () => {
        test('admin row + points row + customer row with exact money strings', async () => {
            await on.notifyPaymentConfirmed({ order: order({ total: 1049.5 }), restaurant: T1, earnedPoints: 10, includePointsRow: true });
            const calls = notifyCalls();
            expect(calls).toHaveLength(3);
            expect(calls[0]).toMatchObject({ audience: 'admin', branch: B1, notification: { description: 'Payment of ₹1049.5 received for ORD-9', meta: { amount: 1049.5 } } });
            expect(calls[1]).toMatchObject({ recipients: [U1], event: null, notification: { category: 'Points' } });
            expect(calls[2]).toMatchObject({ recipients: [U1], payload: { description: 'Payment of ₹1049.5 confirmed. +10 points!' } });
        });

        test('guest order → admin row only (no customer recipients)', async () => {
            await on.notifyPaymentConfirmed({ order: order({ user: null }), restaurant: T1, earnedPoints: 5, includePointsRow: true });
            expect(notifyCalls()).toHaveLength(1);
            expect(notifyCalls()[0].recipients).toBeUndefined();
        });

        test('zero points → no points row and no "+points" text', async () => {
            await on.notifyPaymentConfirmed({ order: order(), restaurant: T1, earnedPoints: 0, includePointsRow: true });
            expect(notifyCalls()).toHaveLength(2);
            expect(notifyCalls()[1].payload.description).toBe('Payment of ₹525.5 confirmed.');
        });
    });

    describe('notifyCounterOrderReady', () => {
        test('waiter audience + order room + owner room', async () => {
            await on.notifyCounterOrderReady(order(), true);
            expect(notifyCalls()[0]).toMatchObject({ audience: 'waiter', rooms: ['order:ORD-9', U1], event: 'order:ready', notification: { meta: { table: 'Dine-in' } } });
        });
        test('guest takeaway → null owner room (filtered by notify)', async () => {
            await on.notifyCounterOrderReady(order({ user: null }), false);
            expect(notifyCalls()[0].rooms).toEqual(['order:ORD-9', null]);
            expect(notifyCalls()[0].notification.meta.table).toBe('Takeaway');
        });
    });

    describe('buildCreateOrderNotificationTasks', () => {
        const base = (over = {}) => ({
            savedOrder: order({ status: 'new', source: 'web-customer', items: [{ name: 'Soup', quantity: 2 }, { name: 'Tea', quantity: 1 }] }),
            counterSideOrder: null, settings: {}, hasKitchenWork: true, type: 'dine-in',
            validTableId: TB, resolvedTableId: TB, resolvedAreaId: 'area1', resolvedTableName: 'T5', authoritativeTotal: 300,
            ...over,
        });
        const runAll = async (tasks) => { for (const [, fn] of tasks) await fn(); await flush(); };

        test('newOrder notifications disabled → no tasks', () => {
            expect(on.buildCreateOrderNotificationTasks(base({ settings: { notifications: { newOrder: false } } }))).toEqual([]);
        });

        test('kitchen work: order:new to branch kitchen, matched waiters personally, customer row to owner', async () => {
            mockFindWaiters.mockResolvedValue([W1]);
            const tasks = on.buildCreateOrderNotificationTasks(base());
            expect(tasks.map((t) => t[0])).toEqual(['new-order notify']);
            await runAll(tasks);
            // kitchen emit resolves the branch tenant async, so ordering vs the
            // personal waiter emit is not guaranteed.
            expect(roomsFor(mockIo, 'order:new').sort()).toEqual([`t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen`, W1].sort());
            const payload = mockIo.sent.find((s) => s.event === 'order:new').payload;
            expect(payload).toEqual({ orderId: 'ORD-9', type: 'dine-in', table: TB, area: 'area1', tableName: 'T5', items: 'Soup ×2, Tea' });
            const roles = notifyCalls().map((c) => c.notification.recipientRole);
            expect(roles).toEqual(['chef', 'admin', 'customer']);
            expect(notifyCalls()[1].notification.description).toBe('Dine-in · Table T5 · Soup ×2, Tea · ₹300');
            expect(notifyCalls()[2].recipients).toEqual([U1]);
            expect(mockFindWaiters).toHaveBeenCalledWith({ restaurant: T1, branch: B1, tableId: TB, tableAreaId: 'area1' });
        });

        test('no matched waiters → branch waiter broadcast', async () => {
            mockFindWaiters.mockResolvedValue([]);
            await runAll(on.buildCreateOrderNotificationTasks(base()));
            expect(roomsFor(mockIo, 'order:new')).toEqual(expect.arrayContaining([`t:${T1}:waiter:${B1}`, `t:${T1}:waiter`]));
        });

        test('waiter lookup failure → broadcast + warn', async () => {
            mockFindWaiters.mockRejectedValue(new Error('x'));
            await runAll(on.buildCreateOrderNotificationTasks(base()));
            expect(roomsFor(mockIo, 'order:new')).toEqual(expect.arrayContaining([`t:${T1}:waiter:${B1}`]));
            expect(logger.warn).toHaveBeenCalledWith('findWaitersForTable failed on order:new; broadcasting', { error: 'x' });
        });

        test('counter-only order: order:ready to waiters + order room + owner, nothing to the kitchen', async () => {
            await runAll(on.buildCreateOrderNotificationTasks(base({ hasKitchenWork: false, type: 'takeaway', validTableId: null, resolvedTableId: null, savedOrder: order({ type: 'takeaway', table: null, source: 'web-customer' }) })));
            expect(roomsFor(mockIo, 'order:ready')).toEqual(expect.arrayContaining([`t:${T1}:waiter:${B1}`, 'order:ORD-9', U1]));
            expect(allRooms(mockIo).some((r) => r.includes(':kitchen'))).toBe(false);
            expect(notifyCalls().map((c) => c.notification.recipientRole)).toEqual(['admin', 'waiter', 'customer']);
        });

        test('kiosk order: no waiter ping at all', async () => {
            await runAll(on.buildCreateOrderNotificationTasks(base({ savedOrder: order({ source: 'kiosk', user: null }) })));
            expect(roomsFor(mockIo, 'order:new')).toEqual([`t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen`]);
            expect(mockFindWaiters).not.toHaveBeenCalled();
            expect(notifyCalls().some((c) => c.recipients)).toBe(false);
        });

        test('counter split adds a counter-ready task for the counter doc', async () => {
            const counterSideOrder = order({ orderId: 'ORD-9C', user: U1 });
            const tasks = on.buildCreateOrderNotificationTasks(base({ counterSideOrder, settings: null }));
            expect(tasks.map((t) => t[0])).toEqual(['counter-split notify', 'new-order notify']);
            await tasks[0][1]();
            expect(notifyCalls()[0]).toMatchObject({ rooms: ['order:ORD-9C', U1], event: 'order:ready' });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('orderHelpers pure helpers', () => {
    const M1 = '507f1f77bcf86cd799439011';
    const M2 = '507f1f77bcf86cd799439012';

    test('bumpMenuItemOrderCounts tallies per item, tenant-scoped, skips invalid ids', async () => {
        await helpers.bumpMenuItemOrderCounts([
            { menuItem: M1, quantity: 2 }, { menuItem: M1, quantity: 3 }, { menuItem: M2, quantity: 0 },
            { menuItem: 'mock-id', quantity: 5 }, null,
        ], T1);
        expect(MenuItem.bulkWrite).toHaveBeenCalledWith([
            { updateOne: { filter: { _id: M1, restaurant: T1 }, update: { $inc: { orderCount: 5 } } } },
            { updateOne: { filter: { _id: M2, restaurant: T1 }, update: { $inc: { orderCount: 1 } } } },
        ], { ordered: false });
    });

    test.each([
        ['no tenant', [{ menuItem: M1 }], null],
        ['empty items', [], T1],
        ['not an array', 'x', T1],
        ['only invalid ids', [{ menuItem: 'nope' }], T1],
    ])('bumpMenuItemOrderCounts no-op: %s', async (_l, items, rid) => {
        await helpers.bumpMenuItemOrderCounts(items, rid);
        expect(MenuItem.bulkWrite).not.toHaveBeenCalled();
    });

    test('bumpMenuItemOrderCounts never throws on DB failure', async () => {
        MenuItem.bulkWrite.mockRejectedValueOnce(new Error('w'));
        await expect(helpers.bumpMenuItemOrderCounts([{ menuItem: M1 }], T1)).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith('bumpMenuItemOrderCounts failed: w');
    });

    test.each([
        ['served', 'new'],
        ['ready', 'preparing'],
        ['preparing', 'preparing'],
        ['new', 'new'],
    ])('revertStatusOnAppend %s → %s', (from, to) => {
        const o = { status: from, servedAt: 1, preparationCompletedAt: 2 };
        helpers.revertStatusOnAppend(o);
        expect(o.status).toBe(to);
        if (from === 'served') expect(o.servedAt).toBeUndefined();
        if (from === 'ready') expect(o.preparationCompletedAt).toBeUndefined();
        expect(() => helpers.revertStatusOnAppend(null)).not.toThrow();
    });

    // Updated 2026-10: the merged line used to be silently capped at 99
    // (Tea 98 + 5 → 99), shrinking the KOT and the bill. It now holds up
    // to the 999 per-item limit createOrder enforces, and refuses beyond.
    test('appendItemsMerging merges identical lines (case/space-insensitive), keeps variants apart, no silent 99 cap', () => {
        const items = [{ name: 'Soup', price: 100, quantity: 2, instructions: '' }, { name: 'Tea', price: 20, quantity: 98 }];
        helpers.appendItemsMerging(items, [
            { name: ' soup ', price: 100, quantity: 1 },
            { name: 'Soup', price: 100, quantity: 1, instructions: 'no salt' },
            { name: 'Soup', price: 120, quantity: 1 },
            { name: 'Tea', price: 20, quantity: 5 },
            { name: 'Soup', price: 100, quantity: 'abc' },
        ]);
        expect(items.map((i) => [i.name, i.price, i.quantity, i.instructions || ''])).toEqual([
            ['Soup', 100, 4, ''],
            ['Tea', 20, 103, ''],
            ['Soup', 100, 1, 'no salt'],
            ['Soup', 120, 1, ''],
        ]);
    });

    test('appendItemsMerging refuses a merge beyond 999 per line and leaves the items untouched', () => {
        const items = [{ name: 'Tea', price: 20, quantity: 998 }];
        let err;
        try { helpers.appendItemsMerging(items, [{ name: 'Naan', price: 40, quantity: 1 }, { name: 'Tea', price: 20, quantity: 2 }]); } catch (e) { err = e; }
        expect(err.status).toBe(400);
        expect(err.body.code).toBe('QUANTITY_EXCEEDED');
        expect(items).toEqual([{ name: 'Tea', price: 20, quantity: 998 }]);
    });

    test.each([
        [[], ''],
        [[{ name: 'A', quantity: 1 }], 'A'],
        [[{ name: 'A', quantity: 3 }, { name: 'B' }], 'A ×3, B'],
        [[{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }], 'A, B, C +2 more'],
    ])('summariseItems %j → %s', (items, out) => {
        expect(helpers.summariseItems(items)).toBe(out);
    });

    test.each([
        [{ type: 'dine-in', items: [{ name: 'A' }] }, 'T1', 'Dine-in · Table T1 · A'],
        [{ type: 'takeaway', items: [{ name: 'A' }] }, 'T1', 'Takeaway · A'],
        [{ type: 'dine-in', items: [] }, null, 'Dine-in'],
    ])('newOrderAdminDescription %#', (o, t, out) => {
        expect(helpers.newOrderAdminDescription(o, t)).toBe(out);
    });

    test('partitionItemsByStation trusts stored counter/bar, re-infers kitchen/unset', () => {
        const { counterItems, kitchenItems, enriched } = helpers.partitionItemsByStation([
            { name: 'Paneer Curry', prepStation: 'kitchen' },
            { name: 'Anything', prepStation: 'counter' },
            { name: 'Mojito', prepStation: 'bar' },
            { name: 'Bisleri Water 1L' },
        ]);
        expect(enriched).toHaveLength(4);
        expect(counterItems.map((i) => i.name)).toContain('Anything');
        expect(kitchenItems.map((i) => i.name)).toEqual(expect.arrayContaining(['Paneer Curry', 'Mojito']));
        expect(helpers.partitionItemsByStation(null).enriched).toEqual([]);
    });

    test('signKioskTrackingToken binds orderId + tenant with a 2h expiry', () => {
        helpers.signKioskTrackingToken('ORD-1', T1);
        expect(auth.signTypedToken).toHaveBeenCalledWith('kiosk', { kind: 'kiosk-track', orderId: 'ORD-1', restaurant: T1 }, { expiresIn: '2h' });
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('multi-instance (Redis adapter) wiring', () => {
    const cacheBus = require('../utils/cacheBus');
    let io2;

    beforeAll(() => {
        process.env.REDIS_URL = 'redis://fake:6379';
        io2 = socket.init(http.createServer(), (origin) => origin === 'http://ok');
    });
    afterAll(async () => {
        delete process.env.REDIS_URL;
        await socket.close();
    });

    test('REDIS_URL set → multi-instance mode, pub/sub clients created and connected', async () => {
        expect(socket.isMultiInstance()).toBe(true);
        expect(mockRedisClients).toHaveLength(2);
        await flush();
        // (connect mocks' call counts are wiped by beforeEach clearAllMocks;
        // the fake flips isReady when connect() ran)
        expect(mockRedisClients.every((c) => c.isReady)).toBe(true);
    });

    test('redis error logging is throttled to one line per 30s', () => {
        const pubErr = mockRedisClients[0].handlers.error;
        pubErr(new Error('ECONNREFUSED'));
        pubErr(new Error('ECONNREFUSED'));
        expect(logger.error.mock.calls.filter((c) => /redis pub error/.test(c[0]))).toHaveLength(1);
    });

    test('cache-bus publishes ride serverSideEmit; inbound messages are delivered locally', () => {
        const spy = jest.spyOn(io2, 'serverSideEmit').mockImplementation(() => true);
        cacheBus.publish('menu', { id: 1 });
        expect(spy).toHaveBeenCalledWith('bd:cache-bus', { channel: 'menu', msg: { id: 1 } });
        const got = jest.fn();
        cacheBus.subscribe('menu-in', got);
        io2.sockets.listeners('bd:cache-bus').forEach((fn) => fn({ channel: 'menu-in', msg: 'x' }));
        io2.sockets.listeners('bd:cache-bus').forEach((fn) => fn({ channel: 42 })); // ignored
        expect(got).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    test('close() closes ready clients, destroys ones still connecting, clears the cache-bus transport', async () => {
        mockRedisClients[1].isReady = false;
        await socket.close();
        expect(mockRedisClients[0].close).toHaveBeenCalled();
        expect(mockRedisClients[1].destroy).toHaveBeenCalled();
        expect(cacheBus.hasTransport()).toBe(false);
    });
});
