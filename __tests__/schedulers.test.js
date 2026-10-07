/**
 * 5.6 — background sweepers / schedulers, driven by Jest fake time:
 *   utils/emptyOrderSweeper.js, utils/staleOrderSweeper.js,
 *   utils/scheduledTakeawayReleaser.js, utils/pickupTime.js,
 *   utils/shiftAutoCloser.js, utils/bookingReminderScheduler.js,
 *   utils/menuAutoRestoreScheduler.js
 *
 * Models, socket helpers, tableMerge, notify and the cluster scheduler are
 * mocked; the tests assert the exact Mongo filters / updates each job
 * issues (thresholds, tenant scope, "never touch paid orders"), the
 * emitted rooms/payloads, idempotent re-runs and that DB errors are
 * swallowed + logged. Real-Mongo semantics of the same filters are
 * exercised in __tests__/integration/realtimeEvents.test.js.
 */
jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// `.select()` / `.select().lean()` chains around a per-test result fn.
const mockQuery = (fn) => (...args) => {
    const p = () => Promise.resolve().then(() => fn(...args));
    const q = {
        select: () => q,
        lean: () => p(),
        then: (res, rej) => p().then(res, rej),
    };
    return q;
};
const mockOrderFind = jest.fn();
const mockOrderUpdateOne = jest.fn();
const mockTableFind = jest.fn();
const mockTableFindOne = jest.fn();
const mockShiftFind = jest.fn();
const mockShiftUpdateOne = jest.fn();
const mockBookingFind = jest.fn();
const mockBookingUpdateOne = jest.fn();
const mockMenuUpdateMany = jest.fn();
jest.mock('../models/order', () => ({
    find: (...a) => mockQuery(mockOrderFind)(...a),
    updateOne: (...a) => mockOrderUpdateOne(...a),
}));
jest.mock('../models/table', () => ({
    find: (...a) => mockQuery(mockTableFind)(...a),
    findOne: (...a) => mockQuery(mockTableFindOne)(...a),
}));
jest.mock('../models/shift', () => ({
    find: (...a) => mockShiftFind(...a),
    updateOne: (...a) => mockShiftUpdateOne(...a),
}));
jest.mock('../models/advanceBooking', () => ({
    find: (...a) => mockQuery(mockBookingFind)(...a),
    updateOne: (...a) => mockBookingUpdateOne(...a),
}));
jest.mock('../models/menuItem', () => ({ updateMany: (...a) => mockMenuUpdateMany(...a) }));

// Updated 2026-10 (table-status rule): the empty-order sweeper releases
// tables through utils/tableOccupancy.releaseTableIfSettled, which checks
// for other unpaid orders, frees the group and emits `table:updated`
// itself (covered by __tests__/tableOccupancyRelease.test.js and the
// integration suite). Here it is mocked; mockFreeTable stands in for it.
const mockFreeTable = jest.fn();
jest.mock('../utils/tableOccupancy', () => ({ releaseTableIfSettled: (...a) => mockFreeTable(...a) }));

const mockRoomEmits = [];
const mockEmitToStaff = jest.fn();
const mockEmitToAdmin = jest.fn();
const mockEmitToKitchen = jest.fn();
let mockIoAvailable = true;
jest.mock('../utils/socket', () => ({
    getIO: () => {
        if (!mockIoAvailable) throw new Error('Socket.io not initialized');
        return { to: (room) => ({ emit: (event, payload) => mockRoomEmits.push({ room, event, payload }) }) };
    },
    emitToStaff: (...a) => mockEmitToStaff(...a),
    emitToAdmin: (...a) => mockEmitToAdmin(...a),
    emitToKitchen: (...a) => mockEmitToKitchen(...a),
}));

const mockNotify = jest.fn();
jest.mock('../services/notificationService', () => ({ notify: (...a) => mockNotify(...a) }));

const mockScheduleJob = jest.fn(() => ({ name: 'job' }));
jest.mock('../utils/scheduler', () => ({ scheduleJob: (...a) => mockScheduleJob(...a) }));

const logger = require('../utils/logger');
const requestContext = require('../utils/requestContext');
const { runEmptyOrderSweep, startScheduledEmptyOrderSweep } = require('../utils/emptyOrderSweeper');
const { runStaleOrderScan, startScheduledStaleOrderSweep } = require('../utils/staleOrderSweeper');
const { startScheduledTakeawayReleaser } = require('../utils/scheduledTakeawayReleaser');
const pickup = require('../utils/pickupTime');
const { runShiftAutoClose, startScheduledShiftAutoClose } = require('../utils/shiftAutoCloser');
const { runBookingReminderScan, startScheduledBookingReminders } = require('../utils/bookingReminderScheduler');
const { runMenuAutoRestoreScan, startScheduledMenuAutoRestore } = require('../utils/menuAutoRestoreScheduler');

const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const B1 = '111111111111111111111111';
const NOW = new Date('2026-10-03T08:00:00.000Z'); // 13:30 IST
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const ENV_KEYS = [
    'EMPTY_ORDER_GRACE_MINUTES', 'EMPTY_ORDER_SWEEP_DISABLED', 'EMPTY_ORDER_SWEEP_MINUTES',
    'STALE_ORDER_STUCK_MINUTES', 'STALE_ORDER_SWEEP_DISABLED', 'STALE_ORDER_SWEEP_HOURS',
    'SHIFT_AUTOCLOSE_HOURS', 'SHIFT_AUTOCLOSE_DISABLED', 'SHIFT_AUTOCLOSE_SWEEP_HOURS',
    'BOOKING_REMINDER_DISABLED', 'MENU_RESTORE_DISABLED',
];
const savedEnv = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    for (const k of ENV_KEYS) delete process.env[k];
    mockRoomEmits.length = 0;
    mockIoAvailable = true;
    mockOrderFind.mockResolvedValue([]);
    mockOrderUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockTableFind.mockResolvedValue([]);
    mockTableFindOne.mockResolvedValue(null);
    mockFreeTable.mockResolvedValue({ freedIds: [] });
    mockShiftFind.mockResolvedValue([]);
    mockShiftUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockBookingFind.mockResolvedValue([]);
    mockBookingUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockMenuUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockNotify.mockResolvedValue({ ok: true });
});
afterEach(() => {
    jest.useRealTimers();
});
afterAll(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
});

// ═════════════════════════════════════════════════════════════════════
describe('emptyOrderSweeper', () => {
    const orphan = (over = {}) => ({ _id: 'o1', orderId: 'ORD-1', restaurant: T1, branch: B1, table: 'tbl1', type: 'dine-in', ...over });

    test('orphan query: empty cart, open status, unpaid only, untouched past the 30 min default grace, all tenants', async () => {
        await runEmptyOrderSweep();
        expect(mockOrderFind).toHaveBeenCalledWith({
            'items.0': { $exists: false },
            status: { $in: ['new', 'preparing', 'ready'] },
            paymentStatus: 'Pending',
            updatedAt: { $lt: new Date(NOW.getTime() - 30 * MIN) },
        });
        expect(mockTableFind).toHaveBeenCalledWith({
            status: 'occupied',
            $or: [{ activeOrder: null }, { activeOrder: { $exists: false } }],
            updatedAt: { $lt: new Date(NOW.getTime() - 30 * MIN) },
        });
    });

    test.each([
        ['doc', { _id: T2, name: 'x' }],
        ['id string', T2],
    ])('tenant-scoped run (restaurant as %s) narrows both passes to that tenant', async (_l, restaurant) => {
        await runEmptyOrderSweep({ restaurant });
        expect(mockOrderFind.mock.calls[0][0].restaurant).toBe(T2);
        expect(mockTableFind.mock.calls[0][0].restaurant).toBe(T2);
    });

    test.each([
        ['45', 45],
        ['abc', 30],
        ['0', 30],
    ])('EMPTY_ORDER_GRACE_MINUTES=%s → cutoff %i min', async (env, minutes) => {
        process.env.EMPTY_ORDER_GRACE_MINUTES = env;
        await runEmptyOrderSweep();
        expect(mockOrderFind.mock.calls[0][0].updatedAt.$lt).toEqual(new Date(NOW.getTime() - minutes * MIN));
    });

    test('cancels the orphan with audit fields, guarded against already-cancelled, frees its table, emits to staff + table guests', async () => {
        mockOrderFind.mockResolvedValue([orphan()]);
        mockTableFindOne.mockResolvedValue({ _id: 'tbl1', branch: B1 });
        mockFreeTable.mockResolvedValue({ freedIds: ['tbl1', 'tbl2'] });
        const r = await runEmptyOrderSweep();
        expect(r).toEqual({ cancelled: 1, freedTables: 2 });
        expect(mockOrderUpdateOne).toHaveBeenCalledWith(
            { _id: 'o1', status: { $ne: 'cancelled' } },
            { $set: { status: 'cancelled', cancelReason: 'auto-sweeper', cancelReasonNote: expect.any(String), cancelledAt: NOW } },
        );
        expect(mockTableFindOne).toHaveBeenCalledWith({ _id: 'tbl1', activeOrder: 'o1' });
        // Updated 2026-10: the release goes through releaseTableIfSettled
        // (order + tenant scope + emit routing); the staff `table:updated`
        // emit now happens inside that helper.
        expect(mockFreeTable).toHaveBeenCalledWith(
            expect.objectContaining({ _id: 'o1', table: 'tbl1' }), { restaurant: T1 }, { branch: B1, restaurant: T1 },
        );
        expect(mockRoomEmits).toEqual([
            { room: 'table:tbl1', event: 'session:ended', payload: { tableId: 'tbl1', reason: 'inactivity', graceMinutes: 30 } },
            { room: 'table:tbl2', event: 'session:ended', payload: { tableId: 'tbl2', reason: 'inactivity', graceMinutes: 30 } },
        ]);
    });

    test('table already re-assigned to another order is left alone', async () => {
        mockOrderFind.mockResolvedValue([orphan()]);
        mockTableFindOne.mockResolvedValue(null);
        const r = await runEmptyOrderSweep();
        expect(r).toEqual({ cancelled: 1, freedTables: 0 });
        expect(mockFreeTable).not.toHaveBeenCalled();
        expect(mockEmitToStaff).not.toHaveBeenCalled();
    });

    test('takeaway orphan (no table) → cancel only', async () => {
        mockOrderFind.mockResolvedValue([orphan({ table: null, type: 'takeaway' })]);
        expect(await runEmptyOrderSweep()).toEqual({ cancelled: 1, freedTables: 0 });
        expect(mockTableFindOne).not.toHaveBeenCalled();
    });

    test('ghost tables (occupied, no order) are freed per their own tenant', async () => {
        mockTableFind.mockResolvedValue([{ _id: 'g1', branch: B1, restaurant: T1 }, { _id: 'g2', branch: null, restaurant: T2 }]);
        mockFreeTable.mockImplementation(async (id) => ({ freedIds: [id] }));
        const r = await runEmptyOrderSweep();
        expect(r).toEqual({ cancelled: 0, freedTables: 2 });
        // Updated 2026-10: released via releaseTableIfSettled (which emits
        // table:updated with this branch / tenant routing itself).
        expect(mockFreeTable.mock.calls).toEqual([
            ['g1', { restaurant: T1 }, { branch: B1, restaurant: T1 }],
            ['g2', { restaurant: T2 }, { branch: null, restaurant: T2 }],
        ]);
        expect(logger.info).toHaveBeenCalledWith('Empty order sweeper finished', expect.objectContaining({ freedGhostTables: 2, restaurant: 'all' }));
    });

    test('one failing order does not stop the others; error logged', async () => {
        mockOrderFind.mockResolvedValue([orphan({ _id: 'bad', orderId: 'ORD-BAD' }), orphan({ _id: 'ok', orderId: 'ORD-OK', table: null })]);
        mockOrderUpdateOne.mockImplementation(async (f) => { if (f._id === 'bad') throw new Error('write conflict'); return {}; });
        const r = await runEmptyOrderSweep();
        expect(r.cancelled).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('Empty order cleanup failed for one order', { orderId: 'ORD-BAD', error: 'write conflict' });
    });

    test('ghost-table failures are isolated and logged', async () => {
        mockTableFind.mockResolvedValue([{ _id: 'g1', restaurant: T1 }]);
        mockFreeTable.mockRejectedValue(new Error('nope'));
        expect(await runEmptyOrderSweep()).toEqual({ cancelled: 0, freedTables: 0 });
        expect(logger.error).toHaveBeenCalledWith('Ghost table cleanup failed', { tableId: 'g1', error: 'nope' });
    });

    test('ghost-table scan error is logged but the orphan pass result stands', async () => {
        mockOrderFind.mockResolvedValue([orphan({ table: null })]);
        mockTableFind.mockRejectedValue(new Error('scan'));
        expect(await runEmptyOrderSweep()).toEqual({ cancelled: 1, freedTables: 0 });
        expect(logger.error).toHaveBeenCalledWith('Ghost table scan error', { error: 'scan' });
    });

    test('top-level DB error is swallowed and reported', async () => {
        mockOrderFind.mockRejectedValue(new Error('mongo down'));
        await expect(runEmptyOrderSweep()).resolves.toEqual({ cancelled: 0, freedTables: 0, error: 'mongo down' });
        expect(logger.error).toHaveBeenCalledWith('Empty order sweeper error', { error: 'mongo down' });
    });

    test('socket not initialised → cleanup still happens', async () => {
        mockIoAvailable = false;
        mockOrderFind.mockResolvedValue([orphan()]);
        mockTableFindOne.mockResolvedValue({ _id: 'tbl1' });
        mockFreeTable.mockResolvedValue({ freedIds: ['tbl1'] });
        expect(await runEmptyOrderSweep()).toEqual({ cancelled: 1, freedTables: 1 });
    });

    test('idempotent: a second run with nothing left does nothing', async () => {
        mockOrderFind.mockResolvedValueOnce([orphan({ table: null })]);
        await runEmptyOrderSweep();
        const second = await runEmptyOrderSweep();
        expect(second).toEqual({ cancelled: 0, freedTables: 0 });
        expect(mockOrderUpdateOne).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith('Empty order sweeper finished', expect.objectContaining({ cancelled: 0 }));
    });

    test('scheduled: 15 min interval, 10 s boot pass, runs OUTSIDE any request tenant context', async () => {
        startScheduledEmptyOrderSweep();
        const [name, interval, fn, opts] = mockScheduleJob.mock.calls[0];
        expect([name, interval, opts]).toEqual(['empty-order-sweep', 15 * MIN, { initialDelayMs: 10 * 1000 }]);
        let seenCtx = 'unset';
        mockOrderFind.mockImplementation(async () => { seenCtx = requestContext.getContext(); return []; });
        await requestContext.runWithContext({ tenantId: T1 }, () => fn());
        expect(seenCtx).toBeNull();
        expect(mockOrderFind.mock.calls[0][0].restaurant).toBeUndefined();
        // boot-pass log only on the first run
        await fn();
        expect(logger.debug.mock.calls.filter((c) => /boot pass/.test(c[0]))).toHaveLength(1);
    });

    test('boot pass with work logs at info', async () => {
        startScheduledEmptyOrderSweep();
        const fn = mockScheduleJob.mock.calls[0][2];
        mockOrderFind.mockResolvedValue([orphan({ table: null })]);
        await fn();
        expect(logger.info).toHaveBeenCalledWith('Empty order sweeper boot pass: cancelled=1, freedTables=0');
    });

    test.each([['true'], ['TRUE']])('EMPTY_ORDER_SWEEP_DISABLED=%s → not scheduled', (v) => {
        process.env.EMPTY_ORDER_SWEEP_DISABLED = v;
        startScheduledEmptyOrderSweep();
        expect(mockScheduleJob).not.toHaveBeenCalled();
    });

    test('custom sweep interval', () => {
        process.env.EMPTY_ORDER_SWEEP_MINUTES = '5';
        startScheduledEmptyOrderSweep();
        expect(mockScheduleJob.mock.calls[0][1]).toBe(5 * MIN);
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('staleOrderSweeper', () => {
    test('query: ready takeaway orders older than 6 h (default); observe-only', async () => {
        await runStaleOrderScan();
        expect(mockOrderFind).toHaveBeenCalledWith({ status: 'ready', type: 'takeaway', updatedAt: { $lt: new Date(NOW.getTime() - 360 * MIN) } });
        expect(mockOrderUpdateOne).not.toHaveBeenCalled();
    });

    test('STALE_ORDER_STUCK_MINUTES override', async () => {
        process.env.STALE_ORDER_STUCK_MINUTES = '90';
        await runStaleOrderScan();
        expect(mockOrderFind.mock.calls[0][0].updatedAt.$lt).toEqual(new Date(NOW.getTime() - 90 * MIN));
    });

    test('nothing stale → {count:0}, no emit', async () => {
        expect(await runStaleOrderScan()).toEqual({ count: 0 });
        expect(mockEmitToAdmin).not.toHaveBeenCalled();
    });

    test('one admin event per tenant with only that tenant\'s order ids; tenantless rows skipped', async () => {
        mockOrderFind.mockResolvedValue([
            { orderId: 'A1', restaurant: T1, updatedAt: new Date(NOW.getTime() - 7 * HOUR) },
            { orderId: 'A2', restaurant: T1, updatedAt: new Date(NOW.getTime() - 400 * MIN) },
            { orderId: 'B1', restaurant: T2, updatedAt: new Date(NOW.getTime() - 9 * HOUR) },
            { orderId: 'X1', restaurant: null, updatedAt: new Date(NOW.getTime() - 9 * HOUR) },
        ]);
        const r = await runStaleOrderScan();
        expect(r).toEqual({ count: 4, tenants: 3 });
        expect(mockEmitToAdmin.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
            [null, 'stale-orders:detected', { tenantId: T1, restaurant: T1, count: 2, oldestMinutes: 420, orderIds: ['A1', 'A2'] }],
            [null, 'stale-orders:detected', { tenantId: T2, restaurant: T2, count: 1, oldestMinutes: 540, orderIds: ['B1'] }],
        ]);
    });

    test('socket failure does not fail the scan', async () => {
        mockIoAvailable = false;
        mockOrderFind.mockResolvedValue([{ orderId: 'A1', restaurant: T1, updatedAt: NOW }]);
        expect(await runStaleOrderScan()).toEqual({ count: 1, tenants: 1 });
    });

    test('DB error swallowed + logged', async () => {
        mockOrderFind.mockRejectedValue(new Error('boom'));
        expect(await runStaleOrderScan()).toEqual({ count: 0, error: 'boom' });
        expect(logger.error).toHaveBeenCalledWith('Stale order sweeper error', { error: 'boom' });
    });

    test('scheduling: hourly, first run after 2 min; disable flag honoured', () => {
        startScheduledStaleOrderSweep();
        expect(mockScheduleJob).toHaveBeenCalledWith('stale-order-sweep', HOUR, runStaleOrderScan, { initialDelayMs: 2 * MIN });
        mockScheduleJob.mockClear();
        process.env.STALE_ORDER_SWEEP_DISABLED = 'true';
        startScheduledStaleOrderSweep();
        expect(mockScheduleJob).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('pickupTime', () => {
    // 2026-10-03 in IST (UTC+05:30, no DST).
    const at = (iso) => new Date(iso);
    const ord = (pickupTime, createdAt, over = {}) => ({ type: 'takeaway', pickupTime, createdAt, ...over });

    test('default timezone is Asia/Kolkata and lead is 30 min', () => {
        expect(pickup.APP_TIMEZONE).toBe(process.env.APP_TIMEZONE || 'Asia/Kolkata');
        expect(pickup.SCHEDULED_LEAD_MIN).toBe(30);
        expect(pickup.URGENT_THRESHOLD_MIN).toBe(10);
    });

    test.each([
        ['02:30 PM', '2026-10-03T09:00:00.000Z'],
        ['2:30 pm', '2026-10-03T09:00:00.000Z'],
        ['14:30', '2026-10-03T09:00:00.000Z'],
        ['14.30', '2026-10-03T09:00:00.000Z'],
        ['10:45 PM', '2026-10-03T17:15:00.000Z'],
    ])('"%s" on an order placed 13:30 IST → %s (IST wall clock, not server tz)', (pt, iso) => {
        expect(pickup.parsePickupAt(ord(pt, NOW)).toISOString()).toBe(iso);
    });

    test.each([['UTC'], ['Asia/Kolkata'], ['America/Los_Angeles'], ['Pacific/Kiritimati']])(
        'result is independent of the server TZ=%s', (tz) => {
            const prev = process.env.TZ;
            process.env.TZ = tz;
            try {
                expect(pickup.parsePickupAt(ord('02:30 PM', NOW)).toISOString()).toBe('2026-10-03T09:00:00.000Z');
                expect(pickup.parsePickupAt(ord('01:00 AM', at('2026-10-03T17:30:00.000Z'))).toISOString())
                    .toBe('2026-10-03T19:30:00.000Z');
            } finally {
                if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
            }
        },
    );

    test('calendar day comes from the IST date of createdAt (23:30 UTC is already the next IST day)', () => {
        // 2026-10-03 23:30 UTC = 2026-10-04 05:00 IST → "06:00 AM" is 2026-10-04 06:00 IST
        expect(pickup.parsePickupAt(ord('06:00 AM', at('2026-10-03T23:30:00.000Z'))).toISOString()).toBe('2026-10-04T00:30:00.000Z');
    });

    test('late-night order with an early-morning pickup wraps to the next day', () => {
        // 23:00 IST order, "01:00 AM" pickup → next day 01:00 IST
        expect(pickup.parsePickupAt(ord('01:00 AM', at('2026-10-03T17:30:00.000Z'))).toISOString()).toBe('2026-10-03T19:30:00.000Z');
    });

    test('12:00 AM is midnight, 12:00 PM is noon', () => {
        expect(pickup.parsePickupAt(ord('12:00 AM', at('2026-10-03T18:00:00.000Z'))).toISOString()).toBe('2026-10-03T18:30:00.000Z');
        // order at 10:00 IST
        expect(pickup.parsePickupAt(ord('12:00 PM', at('2026-10-03T04:30:00.000Z'))).toISOString()).toBe('2026-10-03T06:30:00.000Z');
    });

    test.each([
        [null], [''], ['soon'], ['25:00'], ['13:00 PM'], ['10:60 AM'], ['10:5 AM'], ['10:00 XM'],
    ])('malformed pickup %p → null', (pt) => {
        expect(pickup.parsePickupAt(ord(pt, NOW))).toBeNull();
    });

    test('missing order / createdAt → null', () => {
        expect(pickup.parsePickupAt(null)).toBeNull();
        expect(pickup.parsePickupAt({ pickupTime: '10:00 AM' })).toBeNull();
    });

    test('a same-day slot that passed a few minutes before the order was saved stays TODAY (overdue)', () => {
        // Regression (fixed 2026-10): only a slot more than PAST_SLOT_GRACE_MS before createdAt wraps to tomorrow.
        const created = at('2026-10-03T08:01:00.000Z'); // 13:31 IST
        const p = pickup.parsePickupAt(ord('01:30 PM', created));
        // Today, 1 min overdue (was 2026-10-04T08:00:00.000Z — tomorrow).
        expect(p.toISOString()).toBe('2026-10-03T08:00:00.000Z');
    });

    test('isScheduledTakeaway: true only while release (pickup − lead) is in the future, takeaway only', () => {
        const o = ord('02:30 PM', NOW); // pickup 14:30 IST, release 14:00 IST (08:30Z)
        expect(pickup.isScheduledTakeaway(o)).toBe(true);
        jest.setSystemTime(at('2026-10-03T08:29:59.000Z'));
        expect(pickup.isScheduledTakeaway(o)).toBe(true);
        jest.setSystemTime(at('2026-10-03T08:30:00.000Z'));
        expect(pickup.isScheduledTakeaway(o)).toBe(false);
        expect(pickup.isScheduledTakeaway({ ...o, type: 'dine-in' })).toBe(false);
        expect(pickup.isScheduledTakeaway(ord('garbage', NOW))).toBe(false);
        expect(pickup.isScheduledTakeaway(null)).toBe(false);
    });

    test.each([
        [[], 30],
        [[{ prepTimeMinutes: 10, quantity: 2 }, { prepTimeMinutes: 5 }], 25],
        [[{ prepTimeMinutes: -3, quantity: 1 }, { prepTimeMinutes: 'x', quantity: 2 }], 45],
        [[{ prepTimeMinutes: 0, quantity: 3 }], 0],
    ])('totalPrepMinutes %j → %i', (items, mins) => {
        expect(pickup.totalPrepMinutes({ items })).toBe(mins);
    });

    test('computePrepStartAt = pickup − Σ prep × qty', () => {
        const o = ord('02:30 PM', NOW, { items: [{ prepTimeMinutes: 20, quantity: 2 }] });
        expect(pickup.computePrepStartAt(o).toISOString()).toBe('2026-10-03T08:20:00.000Z');
        expect(pickup.computePrepStartAt(ord(null, NOW))).toBeNull();
    });

    test.each([
        ['preparing', 'takeaway', '02:30 PM', NOW.getTime(), 'preparing'],
        ['ready', 'takeaway', '02:30 PM', NOW.getTime(), 'ready_for_pickup'],
        ['new', 'dine-in', '02:30 PM', NOW.getTime(), 'ready_to_prepare'],
        ['new', 'takeaway', null, NOW.getTime(), 'ready_to_prepare'],
        ['new', 'takeaway', '02:30 PM', at('2026-10-03T08:19:59.000Z').getTime(), 'scheduled'],
        ['new', 'takeaway', '02:30 PM', at('2026-10-03T08:20:00.000Z').getTime(), 'ready_to_prepare'],
    ])('computeQueueBucket status=%s type=%s pickup=%s → %s', (status, type, pt, now, bucket) => {
        const o = { status, type, pickupTime: pt, createdAt: NOW, items: [{ prepTimeMinutes: 20, quantity: 2 }] };
        expect(pickup.computeQueueBucket(o, now)).toBe(bucket);
    });

    test('computeQueueBucket(null) → ready_to_prepare', () => {
        expect(pickup.computeQueueBucket(null)).toBe('ready_to_prepare');
    });

    test('minutesToPickup / isUrgentTakeaway around the 10 min threshold', () => {
        const o = ord('02:30 PM', NOW); // 09:00Z
        expect(pickup.minutesToPickup(o, at('2026-10-03T08:49:00.000Z').getTime())).toBe(11);
        expect(pickup.isUrgentTakeaway(o, at('2026-10-03T08:49:00.000Z').getTime())).toBe(false);
        expect(pickup.isUrgentTakeaway(o, at('2026-10-03T08:50:00.000Z').getTime())).toBe(true);
        expect(pickup.minutesToPickup(o, at('2026-10-03T09:05:00.000Z').getTime())).toBe(-5);
        expect(pickup.isUrgentTakeaway(o, at('2026-10-03T09:05:00.000Z').getTime())).toBe(true);
        expect(pickup.isUrgentTakeaway({ ...o, type: 'dine-in' })).toBe(false);
        expect(pickup.minutesToPickup(ord(null, NOW))).toBeNull();
        expect(pickup.isUrgentTakeaway(ord(null, NOW))).toBe(false);
    });

    test('APP_TIMEZONE override (e.g. Asia/Dubai, UTC+4) shifts the parse', () => {
        const prev = process.env.APP_TIMEZONE;
        process.env.APP_TIMEZONE = 'Asia/Dubai';
        try {
            jest.isolateModules(() => {
                const p2 = require('../utils/pickupTime');
                expect(p2.APP_TIMEZONE).toBe('Asia/Dubai');
                expect(p2.parsePickupAt(ord('02:30 PM', NOW)).toISOString()).toBe('2026-10-03T10:30:00.000Z');
            });
        } finally {
            if (prev === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = prev;
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('scheduledTakeawayReleaser', () => {
    // The tick fn is module-private; grab it from the scheduleJob call.
    let tick;
    beforeAll(() => {
        startScheduledTakeawayReleaser();
        tick = mockScheduleJob.mock.calls[0][2];
    });

    test('armed once: 60 s cadence, 5 s boot delay, idempotent start', () => {
        // (first call happened in beforeAll, before beforeEach's clearAllMocks)
        startScheduledTakeawayReleaser();
        expect(mockScheduleJob).not.toHaveBeenCalled();
        expect(typeof tick).toBe('function');
    });

    // Updated 2026-10: the window was 6 h, which missed long same-day
    // gaps; it is now 24 h (parsePickupAt never wraps a pickup further).
    test('candidate query: pending takeaways with a pickup time created in the last 24 h', async () => {
        await tick();
        expect(mockOrderFind).toHaveBeenCalledWith({
            type: 'takeaway', status: 'new', pickupTime: { $exists: true, $ne: null },
            createdAt: { $gte: new Date(NOW.getTime() - 24 * HOUR) },
        });
    });

    const cand = (orderId, pickupTime, over = {}) => ({ _id: orderId, orderId, restaurant: T1, branch: B1, createdAt: new Date(NOW.getTime() - HOUR), pickupTime, ...over });

    test('emits order:new to the kitchen exactly when the release instant falls in the last tick window', async () => {
        // now = 13:30 IST. release = pickup − 30 min.
        mockOrderFind.mockResolvedValue([
            cand('JUST', '02:00 PM'),               // release 13:30:00 → now        ✔
            cand('EDGE', '01:58 PM'),               // release 13:28 → 120 s ago     ✘ (> 75 s grace)
            cand('IN_GRACE', '01:59 PM'),           // release 13:29 → 60 s ago      ✔
            cand('FUTURE', '02:01 PM'),             // release 13:31                ✘
            cand('BAD', 'whenever'),                // unparseable                  ✘
            cand('NOBRANCH', '02:00 PM', { branch: null, restaurant: T2 }), // ✔ tenant-level
        ]);
        await tick();
        expect(mockEmitToKitchen.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
            [B1, 'order:new', { orderId: 'JUST', restaurant: T1 }],
            [B1, 'order:new', { orderId: 'IN_GRACE', restaurant: T1 }],
            [null, 'order:new', { orderId: 'NOBRANCH', restaurant: T2 }],
        ]);
        expect(logger.info).toHaveBeenCalledWith('Scheduled takeaway releaser: surfaced 3 order(s) to chef KDS.');
    });

    test('re-running the tick a minute later does not re-emit the same order', async () => {
        mockOrderFind.mockResolvedValue([cand('JUST', '02:00 PM')]);
        await tick();
        jest.setSystemTime(new Date(NOW.getTime() + 76 * 1000));
        await tick();
        expect(mockEmitToKitchen).toHaveBeenCalledTimes(1);
    });

    test('an order placed > 6 h before its release is surfaced live', async () => {
        // Regression (fixed 2026-10): the candidate window is 24 h (max createdAt → pickup gap), not 6 h.
        jest.setSystemTime(new Date('2026-10-03T16:30:00.000Z')); // 22:00 IST
        const created = new Date('2026-10-03T03:30:00.000Z');     // 09:00 IST
        mockOrderFind.mockImplementation(async (filter) => (created >= filter.createdAt.$gte
            ? [cand('LONG', '10:30 PM', { createdAt: created })] : []));
        await tick();
        expect(mockEmitToKitchen).toHaveBeenCalledWith(expect.anything(), B1, 'order:new', { orderId: 'LONG', restaurant: T1 });
    });

    test('per-order emit error is logged and other orders still go out', async () => {
        mockOrderFind.mockResolvedValue([cand('A', '02:00 PM'), cand('B', '02:00 PM')]);
        mockEmitToKitchen.mockImplementationOnce(() => { throw new Error('emit'); });
        await tick();
        expect(mockEmitToKitchen).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith('Scheduled-release emit failed:', { orderId: 'A', error: 'emit' });
    });

    test('DB / socket errors are swallowed (retry next tick)', async () => {
        mockOrderFind.mockRejectedValue(new Error('db'));
        await expect(tick()).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith('Scheduled-takeaway tick failed (will retry next interval):', 'db');
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('shiftAutoCloser', () => {
    const shift = (id, clockIn, note = '') => ({ _id: id, clockIn, note });

    test('query: active shifts clocked in > 16 h ago (default), all tenants', async () => {
        await runShiftAutoClose();
        expect(mockShiftFind).toHaveBeenCalledWith({ status: 'active', clockIn: { $lt: new Date(NOW.getTime() - 16 * HOUR) } });
    });

    test('tenant-scoped run accepts a doc or an id', async () => {
        await runShiftAutoClose({ restaurant: { _id: T2 } });
        await runShiftAutoClose({ restaurant: T1 });
        expect(mockShiftFind.mock.calls.map((c) => c[0].restaurant)).toEqual([T2, T1]);
    });

    test('marks missed, caps clockOut at clockIn + threshold, appends the audit note', async () => {
        const ci1 = new Date(NOW.getTime() - 20 * HOUR);
        const ci2 = new Date(NOW.getTime() - 40 * HOUR);
        mockShiftFind.mockResolvedValue([shift('s1', ci1), shift('s2', ci2, 'left early?')]);
        const r = await runShiftAutoClose();
        expect(r).toEqual({ count: 2, thresholdHours: 16 });
        const audit = '[Auto-closed after 16h — shift not manually clocked out]';
        expect(mockShiftUpdateOne.mock.calls).toEqual([
            [{ _id: 's1' }, { $set: { status: 'missed', clockOut: new Date(ci1.getTime() + 16 * HOUR), totalHours: 16, note: audit } }],
            [{ _id: 's2' }, { $set: { status: 'missed', clockOut: new Date(ci2.getTime() + 16 * HOUR), totalHours: 16, note: `left early?\n${audit}` } }],
        ]);
        expect(logger.warn).toHaveBeenCalledWith('Shift auto-closer marked abandoned shifts as missed', { count: 2, thresholdHours: 16, restaurant: 'all' });
    });

    test('SHIFT_AUTOCLOSE_HOURS override', async () => {
        process.env.SHIFT_AUTOCLOSE_HOURS = '10';
        mockShiftFind.mockResolvedValue([shift('s1', new Date(NOW.getTime() - 11 * HOUR))]);
        await runShiftAutoClose();
        expect(mockShiftFind.mock.calls[0][0].clockIn.$lt).toEqual(new Date(NOW.getTime() - 10 * HOUR));
        expect(mockShiftUpdateOne.mock.calls[0][1].$set.totalHours).toBe(10);
    });

    test('none abandoned → count 0, no writes; idempotent', async () => {
        expect(await runShiftAutoClose()).toEqual({ count: 0 });
        expect(mockShiftUpdateOne).not.toHaveBeenCalled();
    });

    test('DB error swallowed + logged', async () => {
        mockShiftFind.mockRejectedValue(new Error('x'));
        expect(await runShiftAutoClose()).toEqual({ count: 0, error: 'x' });
        expect(logger.error).toHaveBeenCalledWith('Shift auto-closer error', { error: 'x' });
    });

    test('scheduled job runs outside the request context; disable flag honoured', async () => {
        startScheduledShiftAutoClose();
        const [name, interval, fn, opts] = mockScheduleJob.mock.calls[0];
        expect([name, interval, opts]).toEqual(['shift-auto-close', HOUR, { initialDelayMs: 3 * MIN }]);
        let ctx = 'unset';
        mockShiftFind.mockImplementation(async () => { ctx = requestContext.getContext(); return []; });
        await requestContext.runWithContext({ tenantId: T1 }, () => fn());
        expect(ctx).toBeNull();
        mockScheduleJob.mockClear();
        process.env.SHIFT_AUTOCLOSE_DISABLED = 'true';
        startScheduledShiftAutoClose();
        expect(mockScheduleJob).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('bookingReminderScheduler', () => {
    const booking = (over = {}) => ({
        _id: { toString: () => 'bk1' }, bookingId: 'BK-1', user: 'u1', restaurant: T1, branch: B1,
        bookingDate: new Date('2026-10-04T00:00:00.000Z'),
        payment: { totalAmount: 5000, advancePaid: 1500.5 }, ...over,
    });

    test('query: confirmed, unpaid, not yet reminded, booking within the next 24 h', async () => {
        await runBookingReminderScan();
        expect(mockBookingFind).toHaveBeenCalledWith({
            status: 'Confirmed',
            'payment.status': { $ne: 'Paid' },
            'payment.balanceReminderSentAt': { $in: [null, undefined] },
            bookingDate: { $gte: NOW, $lte: new Date(NOW.getTime() + 24 * HOUR) },
        });
    });

    test('stamps atomically then notifies the booking owner in the booking tenant/branch with the exact balance', async () => {
        mockBookingFind.mockResolvedValue([booking()]);
        const r = await runBookingReminderScan();
        expect(r).toEqual({ scanned: 1, sent: 1 });
        expect(mockBookingUpdateOne).toHaveBeenCalledWith(
            { _id: expect.anything(), $or: [{ 'payment.balanceReminderSentAt': null }, { 'payment.balanceReminderSentAt': { $exists: false } }] },
            { $set: { 'payment.balanceReminderSentAt': NOW } },
        );
        expect(mockNotify).toHaveBeenCalledTimes(1);
        const n = mockNotify.mock.calls[0][0];
        expect(n).toMatchObject({ restaurant: T1, branch: B1, recipients: ['u1'] });
        expect(n.notification.meta).toEqual({ bookingId: 'BK-1', bookingDocId: 'bk1', remainingAmount: 3499.5 });
        expect(n.notification.description).toBe('Your booking BK-1 is on 4 Oct 2026. ₹3499.5 balance is still pending — please pay before the event.');
        expect(n.audience).toBeUndefined();
    });

    test('nothing owed → stamped silently, not notified', async () => {
        mockBookingFind.mockResolvedValue([booking({ payment: { totalAmount: 1000, advancePaid: 1000 } })]);
        expect(await runBookingReminderScan()).toEqual({ scanned: 1, sent: 0 });
        expect(mockBookingUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, { $set: { 'payment.balanceReminderSentAt': NOW } });
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('another instance already stamped it (modifiedCount 0) → no duplicate reminder', async () => {
        mockBookingFind.mockResolvedValue([booking()]);
        mockBookingUpdateOne.mockResolvedValue({ modifiedCount: 0 });
        expect(await runBookingReminderScan()).toEqual({ scanned: 1, sent: 0 });
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('booking without a user is stamped and counted but nobody is notified', async () => {
        mockBookingFind.mockResolvedValue([booking({ user: null })]);
        expect(await runBookingReminderScan()).toEqual({ scanned: 1, sent: 1 });
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('per-booking failure skipped + warned, the rest continue', async () => {
        mockBookingFind.mockResolvedValue([booking({ bookingId: 'BAD' }), booking({ bookingId: 'OK', user: 'u2' })]);
        mockBookingUpdateOne.mockRejectedValueOnce(new Error('wc'));
        expect(await runBookingReminderScan()).toEqual({ scanned: 2, sent: 1 });
        expect(logger.warn).toHaveBeenCalledWith('booking reminder skipped (BAD): wc');
        expect(mockNotify.mock.calls[0][0].recipients).toEqual(['u2']);
    });

    test('scan error swallowed + logged', async () => {
        mockBookingFind.mockRejectedValue(new Error('down'));
        expect(await runBookingReminderScan()).toEqual({ scanned: 0, sent: 0 });
        expect(logger.error).toHaveBeenCalledWith('booking-reminder scan error:', { error: 'down' });
    });

    test('scheduler: disabled flag → not armed; then armed once (6 h, 1 min delay) and idempotent', () => {
        process.env.BOOKING_REMINDER_DISABLED = 'true';
        startScheduledBookingReminders();
        expect(mockScheduleJob).not.toHaveBeenCalled();
        delete process.env.BOOKING_REMINDER_DISABLED;
        startScheduledBookingReminders();
        startScheduledBookingReminders();
        expect(mockScheduleJob).toHaveBeenCalledTimes(1);
        expect(mockScheduleJob).toHaveBeenCalledWith('booking-reminders', 6 * HOUR, runBookingReminderScan, { initialDelayMs: MIN });
    });
});

// ═════════════════════════════════════════════════════════════════════
describe('menuAutoRestoreScheduler', () => {
    test('restores only archived items whose temporary window has elapsed (permanent = null untouched)', async () => {
        mockMenuUpdateMany.mockResolvedValue({ modifiedCount: 3 });
        expect(await runMenuAutoRestoreScan()).toEqual({ restored: 3 });
        expect(mockMenuUpdateMany).toHaveBeenCalledWith(
            { status: 'archived', inactivationUntil: { $ne: null, $lte: NOW } },
            { $set: { status: 'active', inactivationUntil: null, inactivationReason: '', inStock: true } },
        );
        expect(logger.info).toHaveBeenCalledWith('menu auto-restore: 3 item(s) reactivated');
    });

    test('idempotent: nothing due → restored 0, no info log', async () => {
        expect(await runMenuAutoRestoreScan()).toEqual({ restored: 0 });
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('DB error swallowed + logged', async () => {
        mockMenuUpdateMany.mockRejectedValue(new Error('e'));
        expect(await runMenuAutoRestoreScan()).toEqual({ restored: 0 });
        expect(logger.error).toHaveBeenCalledWith('menu auto-restore scan error:', { error: 'e' });
    });

    test('scheduler: disabled flag → not armed; then armed once (15 min, 30 s delay)', () => {
        process.env.MENU_RESTORE_DISABLED = 'true';
        startScheduledMenuAutoRestore();
        expect(mockScheduleJob).not.toHaveBeenCalled();
        delete process.env.MENU_RESTORE_DISABLED;
        startScheduledMenuAutoRestore();
        startScheduledMenuAutoRestore();
        expect(mockScheduleJob).toHaveBeenCalledTimes(1);
        expect(mockScheduleJob).toHaveBeenCalledWith('menu-auto-restore', 15 * MIN, runMenuAutoRestoreScan, { initialDelayMs: 30 * 1000 });
    });
});
