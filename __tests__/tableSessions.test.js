/**
 * utils/tableSessions.js — ending the customer sessions seated at a table
 * (models, logger and the guard cache are mocked).
 */
const mockTableFind = jest.fn();
const mockTableUpdateMany = jest.fn();
const mockOrderFind = jest.fn();
const mockUserFind = jest.fn();
const mockUserUpdateMany = jest.fn();
const mockForget = jest.fn();
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.mock('../models/table', () => ({ find: (...a) => mockTableFind(...a), updateMany: (...a) => mockTableUpdateMany(...a) }));
jest.mock('../models/order', () => ({ find: (...a) => mockOrderFind(...a) }));
jest.mock('../models/user', () => ({ find: (...a) => mockUserFind(...a), updateMany: (...a) => mockUserUpdateMany(...a) }));
jest.mock('../middlewares/tableSessionGuard', () => ({ forgetTableEpoch: (...a) => mockForget(...a) }));
jest.mock('../utils/logger', () => mockLogger);

const { endTableSessions, userIdsFromSeatKeys } = require('../utils/tableSessions');
const EVENTS = require('../realtime/events');

const U1 = 'a'.repeat(24);
const U2 = 'b'.repeat(24);
const U3 = 'c'.repeat(24);
const T1 = '1'.repeat(24);
const T2 = '2'.repeat(24);

const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });
const mkIo = () => {
    const emitted = [];
    return { emitted, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTableFind.mockReturnValue(chain([]));
    mockOrderFind.mockReturnValue(chain([]));
    mockUserFind.mockReturnValue(chain([]));
    mockTableUpdateMany.mockResolvedValue({});
    mockUserUpdateMany.mockResolvedValue({});
});

describe('userIdsFromSeatKeys', () => {
    test('collects only u:<24-hex> keys, de-duplicated', () => {
        const ids = userIdsFromSeatKeys([
            { keys: [`s:sess1`, `u:${U1}`] },
            { keys: [`u:${U1}`, `u:${U2.toUpperCase()}`, 'u:short', 'g:phone'] },
            { keys: [`x:u:${U3}`] },
        ]);
        expect([...ids].sort()).toEqual([U1, U2.toUpperCase()].sort());
    });

    test('tolerates null / empty / malformed input', () => {
        expect(userIdsFromSeatKeys(null).size).toBe(0);
        expect(userIdsFromSeatKeys([]).size).toBe(0);
        expect(userIdsFromSeatKeys([{}, { keys: null }, { keys: [null, 5] }]).size).toBe(0);
    });
});

describe('endTableSessions', () => {
    test('empty / missing tableIds is a no-op (no DB, no emit)', async () => {
        const io = mkIo();
        expect(await endTableSessions({ tableIds: [], io })).toEqual({ tables: 0, customersSignedOut: 0 });
        expect(await endTableSessions({ io })).toEqual({ tables: 0, customersSignedOut: 0 });
        expect(mockTableFind).not.toHaveBeenCalled();
        expect(mockTableUpdateMany).not.toHaveBeenCalled();
        expect(io.emitted).toEqual([]);
    });

    test('stamps the epoch (tenant-scoped), clears the guard cache, de-duplicates ids', async () => {
        const tf = { restaurant: 'R1' };
        const res = await endTableSessions({ tableIds: [T1, T1, T2], tenantFilter: tf });
        expect(res).toEqual({ tables: 2, customersSignedOut: 0 });
        const [filter, update] = mockTableUpdateMany.mock.calls[0];
        expect(filter).toEqual({ _id: { $in: [T1, T2] }, restaurant: 'R1' });
        expect(update.$set.sessionEpoch).toBeInstanceOf(Date);
        expect(mockForget.mock.calls.map((c) => c[0]).sort()).toEqual([T1, T2]);
        expect(mockTableFind.mock.calls[0][0]).toMatchObject({ restaurant: 'R1' });
        expect(mockOrderFind.mock.calls[0][0]).toMatchObject({ restaurant: 'R1' });
    });

    test('bumps tokenVersion for seated + order-owning CUSTOMERS only and emits to table and user rooms', async () => {
        mockTableFind.mockReturnValue(chain([{ _id: T1, seats: [{ keys: [`s:x`, `u:${U1}`] }, { keys: [`u:${U2}`] }] }]));
        mockOrderFind.mockReturnValue(chain([{ user: U3 }, { user: U1 }, { user: null }]));
        // U2 is a staff account: the role:'customer' query leaves it out.
        mockUserFind.mockReturnValue(chain([{ _id: U1 }, { _id: U3 }]));
        const io = mkIo();

        const res = await endTableSessions({ tableIds: [T1], tenantFilter: { restaurant: 'R1' }, io, reason: 'all-tables-freed' });

        expect(res).toEqual({ tables: 1, customersSignedOut: 2 });
        const [uFilter] = mockUserFind.mock.calls[0];
        expect(uFilter.role).toBe('customer');
        expect(uFilter._id.$in.sort()).toEqual([U1, U2, U3].sort());
        const [bFilter, bUpdate] = mockUserUpdateMany.mock.calls[0];
        expect(bFilter).toEqual({ _id: { $in: [U1, U3] }, role: 'customer' });
        expect(bUpdate).toEqual({ $inc: { tokenVersion: 1 } });

        const tableMsg = io.emitted.find((e) => e.room === `table:${T1}`);
        expect(tableMsg.event).toBe(EVENTS.SESSION_ENDED);
        expect(tableMsg.payload).toMatchObject({ reason: 'all-tables-freed', tableId: T1 });
        expect(typeof tableMsg.payload.at).toBe('string');
        const userRooms = io.emitted.filter((e) => e.room === U1 || e.room === U3);
        expect(userRooms).toHaveLength(2);
        userRooms.forEach((e) => {
            expect(e.event).toBe(EVENTS.SESSION_ENDED);
            expect(e.payload.reason).toBe('all-tables-freed');
            expect(e.payload.tableId).toBeUndefined();
        });
        expect(io.emitted.some((e) => e.room === U2)).toBe(false);
    });

    test('default reason is table-freed and works without io', async () => {
        mockTableFind.mockReturnValue(chain([{ _id: T1, seats: [{ keys: [`u:${U1}`] }] }]));
        mockUserFind.mockReturnValue(chain([{ _id: U1 }]));
        const res = await endTableSessions({ tableIds: [T1] });
        expect(res.customersSignedOut).toBe(1);

        const io = mkIo();
        await endTableSessions({ tableIds: [T1], io });
        expect(io.emitted[0].payload.reason).toBe('table-freed');
    });

    test('no customers found → no tokenVersion update', async () => {
        mockTableFind.mockReturnValue(chain([{ _id: T1, seats: [{ keys: [`u:${U1}`] }] }]));
        mockUserFind.mockReturnValue(chain([]));
        const res = await endTableSessions({ tableIds: [T1], io: mkIo() });
        expect(res.customersSignedOut).toBe(0);
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
    });

    test('never throws when a model call fails (logs, returns counts)', async () => {
        mockTableFind.mockImplementation(() => { throw new Error('db down'); });
        await expect(endTableSessions({ tableIds: [T1, T2], io: mkIo() })).resolves.toEqual({ tables: 2, customersSignedOut: 0 });
        expect(mockLogger.error).toHaveBeenCalled();

        mockTableFind.mockReturnValue(chain([]));
        mockUserFind.mockReturnValue(chain([{ _id: U1 }]));
        mockOrderFind.mockReturnValue(chain([{ user: U1 }]));
        mockUserUpdateMany.mockRejectedValue(new Error('write failed'));
        const res = await endTableSessions({ tableIds: [T1] });
        expect(res.customersSignedOut).toBe(0);
    });

    test('an emit failure does not throw', async () => {
        const io = { to: () => { throw new Error('socket'); } };
        await expect(endTableSessions({ tableIds: [T1], io })).resolves.toMatchObject({ tables: 1 });
    });
});
