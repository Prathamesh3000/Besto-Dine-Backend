/**
 * utils/tableOccupancy.releaseTableIfSettled — the table-status rule:
 * a dine-in table (whole merge group) is Free as soon as no order on it
 * (within PARTY_WINDOW_MS) is unsettled (not cancelled AND not Paid /
 * Refunded). Kitchen status does not matter. Otherwise the table stays
 * occupied and activeOrder is repointed to the newest unsettled order.
 *
 * Models, tableMerge and socket are mocked; the real-Mongo behaviour is
 * covered by __tests__/integration/tableStatus.test.js.
 */
const mockTableFindOne = jest.fn();
const mockTableFind = jest.fn();
const mockTableUpdateMany = jest.fn();
const mockOrderFind = jest.fn();
const mockFree = jest.fn();
const mockEmitToStaff = jest.fn();
let mockIoAvailable = true;

const chain = (fn, calls) => (...args) => {
    const q = {
        sort: (s) => { calls.sort = s; return q; },
        select: () => q,
        lean: () => Promise.resolve().then(() => fn(...args)),
    };
    return q;
};
const orderCalls = {};

jest.mock('../models/table', () => ({
    findOne: (...a) => chain(mockTableFindOne, {})(...a),
    updateMany: (...a) => mockTableUpdateMany(...a),
    find: (...a) => chain(mockTableFind, {})(...a),
}));
jest.mock('../models/order', () => ({
    find: (...a) => chain(mockOrderFind, orderCalls)(...a),
}));
jest.mock('../utils/tableMerge', () => ({ freeTableOrUnmergeGroup: (...a) => mockFree(...a) }));
jest.mock('../utils/socket', () => ({
    getIO: () => { if (!mockIoAvailable) throw new Error('no io'); return { io: true }; },
    emitToStaff: (...a) => mockEmitToStaff(...a),
}));

const { Types } = require('mongoose');
const {
    releaseTableIfSettled,
    releaseTableAfterOrderClosed,
    seatsOfOtherParties,
    UNSETTLED_ORDER_MATCH,
    PARTY_WINDOW_MS,
} = require('../utils/tableOccupancy');

const R = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BR = '111111111111111111111111';
const NOW = new Date('2026-10-06T10:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    mockIoAvailable = true;
    mockTableFindOne.mockResolvedValue({ _id: 't1', mergedWith: [], status: 'occupied', branch: BR, restaurant: R });
    mockOrderFind.mockResolvedValue([]);
    mockTableFind.mockResolvedValue([]);
    mockTableUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockFree.mockImplementation(async (id) => ({ freedIds: [id], branch: BR }));
});
afterEach(() => jest.useRealTimers());

describe('releaseTableIfSettled', () => {
    test('unsettled = not cancelled AND payment not Paid/Refunded (kitchen status ignored)', () => {
        expect(UNSETTLED_ORDER_MATCH).toEqual({
            status: { $ne: 'cancelled' },
            paymentStatus: { $nin: ['Paid', 'Refunded'] },
        });
    });

    test('every order settled → frees the table and emits table:updated free to the tenant staff', async () => {
        const order = { _id: 'o1', table: 't1', branch: BR, restaurant: R, status: 'new', paymentStatus: 'Paid' };
        const r = await releaseTableIfSettled(order, { restaurant: R });
        expect(r).toEqual({ freedIds: ['t1'], repointedTo: null });
        expect(mockOrderFind).toHaveBeenCalledWith({
            table: { $in: ['t1'] },
            restaurant: R,
            createdAt: { $gte: new Date(NOW.getTime() - PARTY_WINDOW_MS) },
            ...UNSETTLED_ORDER_MATCH,
        });
        expect(mockFree).toHaveBeenCalledWith('t1', { restaurant: R });
        expect(mockEmitToStaff).toHaveBeenCalledWith({ io: true }, BR, 'table:updated', { tableId: 't1', status: 'free', restaurant: R });
        expect(mockTableUpdateMany).not.toHaveBeenCalled();
    });

    test('an unsettled order remains → stays occupied, activeOrder repointed to the newest unsettled order, no emit', async () => {
        mockOrderFind.mockResolvedValue([{ _id: 'o3' }, { _id: 'o2' }]);
        const r = await releaseTableIfSettled({ _id: 'o1', table: 't1', restaurant: R }, { restaurant: R });
        expect(r).toEqual({ freedIds: [], repointedTo: 'o3' });
        expect(orderCalls.sort).toEqual({ createdAt: -1 });
        expect(mockTableUpdateMany).toHaveBeenCalledWith(
            { _id: { $in: ['t1'] }, restaurant: R, activeOrder: { $nin: [null, 'o3', 'o2'] } },
            { $set: { activeOrder: 'o3' } },
        );
        expect(mockFree).not.toHaveBeenCalled();
        expect(mockEmitToStaff).not.toHaveBeenCalled();
    });

    test('merged group: the whole group is checked and every freed sibling gets an event', async () => {
        mockTableFindOne.mockResolvedValue({ _id: 't1', mergedWith: ['t2', 't3'], status: 'occupied', branch: BR, restaurant: R });
        mockFree.mockResolvedValue({ freedIds: ['t1', 't2', 't3'] });
        const r = await releaseTableIfSettled({ _id: 'o1', table: 't1', restaurant: R }, { restaurant: R });
        expect(mockOrderFind.mock.calls[0][0].table).toEqual({ $in: ['t1', 't2', 't3'] });
        expect(r.freedIds).toEqual(['t1', 't2', 't3']);
        expect(mockEmitToStaff.mock.calls.map((c) => c[3].tableId)).toEqual(['t1', 't2', 't3']);
    });

    test('merged group with one unsettled order anywhere → nothing freed', async () => {
        mockTableFindOne.mockResolvedValue({ _id: 't2', mergedWith: ['t1'], status: 'merged', branch: BR, restaurant: R });
        mockOrderFind.mockResolvedValue([{ _id: 'oX' }]);
        const r = await releaseTableIfSettled('t2', { restaurant: R });
        expect(r).toEqual({ freedIds: [], repointedTo: 'oX' });
        expect(mockFree).not.toHaveBeenCalled();
    });

    test('accepts a table id (string or ObjectId)', async () => {
        const id = new Types.ObjectId();
        mockTableFindOne.mockResolvedValue({ _id: id, mergedWith: [], branch: null, restaurant: R });
        await releaseTableIfSettled(id, { restaurant: R });
        expect(mockTableFindOne.mock.calls[0][0]).toEqual({ _id: id, restaurant: R });
        expect(mockFree).toHaveBeenCalledWith(id, { restaurant: R });
        // No branch → emit routed by the tenant hint.
        expect(mockEmitToStaff).toHaveBeenCalledWith({ io: true }, null, 'table:updated', { tableId: id, status: 'free', restaurant: R });
    });

    test('no tenant filter (webhook / background job) → scoped by the order\'s restaurant', async () => {
        await releaseTableIfSettled({ _id: 'o1', table: 't1', restaurant: R, branch: BR }, {});
        expect(mockTableFindOne.mock.calls[0][0]).toEqual({ _id: 't1', restaurant: R });
        expect(mockOrderFind.mock.calls[0][0].restaurant).toBe(R);
        expect(mockFree).toHaveBeenCalledWith('t1', { restaurant: R });
    });

    test('opts.branch / opts.restaurant override the emit routing; emit:false skips the emit', async () => {
        await releaseTableIfSettled({ _id: 'o1', table: 't1' }, { restaurant: R }, { branch: 'b9', restaurant: 'r9' });
        expect(mockEmitToStaff).toHaveBeenCalledWith({ io: true }, 'b9', 'table:updated', { tableId: 't1', status: 'free', restaurant: 'r9' });
        mockEmitToStaff.mockClear();
        await releaseTableIfSettled({ _id: 'o1', table: 't1' }, { restaurant: R }, { emit: false });
        expect(mockEmitToStaff).not.toHaveBeenCalled();
    });

    test('takeaway / no table / unknown table → no-op', async () => {
        expect(await releaseTableIfSettled({ _id: 'o1', table: null }, { restaurant: R })).toEqual({ freedIds: [], repointedTo: null });
        // Token-number mode: a dine-in order with a token and no table
        // touches no table at all (no lookup, no update, no emit).
        const token = { _id: 'o2', type: 'dine-in', tokenNumber: 'T-007', restaurant: R, status: 'served', paymentStatus: 'Paid' };
        expect(await releaseTableIfSettled(token, { restaurant: R })).toEqual({ freedIds: [], repointedTo: null });
        expect(mockTableFindOne).not.toHaveBeenCalled();
        expect(mockTableUpdateMany).not.toHaveBeenCalled();
        expect(mockEmitToStaff).not.toHaveBeenCalled();
        expect(await releaseTableIfSettled(null)).toEqual({ freedIds: [], repointedTo: null });
        mockTableFindOne.mockResolvedValue(null);
        expect(await releaseTableIfSettled({ _id: 'o1', table: 'gone' }, { restaurant: R })).toEqual({ freedIds: [], repointedTo: null });
        expect(mockFree).not.toHaveBeenCalled();
    });

    test('socket unavailable → table is still freed', async () => {
        mockIoAvailable = false;
        const r = await releaseTableIfSettled({ _id: 'o1', table: 't1' }, { restaurant: R });
        expect(r.freedIds).toEqual(['t1']);
    });

    test('releaseTableAfterOrderClosed is an alias with the same rule', async () => {
        mockOrderFind.mockResolvedValue([{ _id: 'o2' }]);
        expect(await releaseTableAfterOrderClosed({ _id: 'o1', table: 't1' }, { restaurant: R }))
            .toEqual({ freedIds: [], repointedTo: 'o2' });
    });
});

// Another party still seated (2026-10): A paid while its food cooked, B
// scanned in (seat, no order yet), then A's order is served → the release
// must not free the table or wipe B's seat.
describe('seated-party guard', () => {
    const MIN = 60 * 1000;
    const at = (minAgo) => new Date(NOW.getTime() - minAgo * MIN);
    const paidA = { user: 'uA', scanSessionId: 'sA', paidAt: at(20), status: 'served', paymentStatus: 'Paid' };

    test('seatsOfOtherParties: the settled party own seat is not "other"; a foreign or later seat is; idle seats ignored', () => {
        const seats = [
            { keys: ['s:sA'], joinedAt: at(40), lastSeenAt: at(25) },     // A, before paying
            { keys: ['s:sB'], joinedAt: at(5), lastSeenAt: at(5) },       // B, new party
            { keys: ['u:uA'], joinedAt: at(2), lastSeenAt: at(2) },       // A again, after settling
            { keys: ['s:sC'], joinedAt: at(90), lastSeenAt: at(60) },     // idle walk-away
            { keys: ['s:sD'], joinedAt: at(28), lastSeenAt: at(22) },     // companion, scanned before A paid
        ]
        const out = seatsOfOtherParties(seats, [paidA], { cutoff: at(30) });
        expect(out.map((s) => s.keys[0])).toEqual(['s:sB', 'u:uA']);
        // No settled order at all → any live seat is someone seated.
        expect(seatsOfOtherParties([seats[1]], [], { cutoff: at(30) })).toHaveLength(1);
        expect(seatsOfOtherParties([], [paidA], { cutoff: at(30) })).toEqual([]);
    });

    test('a live seat of another party keeps the table: not freed, no emit', async () => {
        mockTableFind.mockResolvedValue([{ _id: 't1', seats: [
            { keys: ['s:sA'], joinedAt: at(40), lastSeenAt: at(10) },
            { keys: ['s:sB'], joinedAt: at(3), lastSeenAt: at(3) },
        ] }]);
        mockOrderFind.mockResolvedValueOnce([]).mockResolvedValueOnce([paidA]);
        const r = await releaseTableIfSettled({ _id: 'oA', table: 't1', restaurant: R }, { restaurant: R });
        expect(r).toEqual({ freedIds: [], repointedTo: null, seatedParties: 1 });
        expect(mockFree).not.toHaveBeenCalled();
        expect(mockEmitToStaff).not.toHaveBeenCalled();
    });

    test('only the settled party is seated → frees as usual', async () => {
        mockTableFind.mockResolvedValue([{ _id: 't1', seats: [{ keys: ['s:sA'], joinedAt: at(40), lastSeenAt: at(10) }] }]);
        mockOrderFind.mockResolvedValueOnce([]).mockResolvedValueOnce([paidA]);
        const r = await releaseTableIfSettled({ _id: 'oA', table: 't1', restaurant: R }, { restaurant: R });
        expect(r.freedIds).toEqual(['t1']);
    });

    test('only idle seats → frees without even reading the orders again', async () => {
        mockTableFind.mockResolvedValue([{ _id: 't1', seats: [{ keys: ['s:sZ'], joinedAt: at(120), lastSeenAt: at(100) }] }]);
        const r = await releaseTableIfSettled('t1', { restaurant: R });
        expect(r.freedIds).toEqual(['t1']);
        expect(mockOrderFind).toHaveBeenCalledTimes(1);
    });

    test('force: true skips the guard', async () => {
        mockTableFind.mockResolvedValue([{ _id: 't1', seats: [{ keys: ['s:sB'], joinedAt: at(3), lastSeenAt: at(3) }] }]);
        const r = await releaseTableIfSettled('t1', { restaurant: R }, { force: true });
        expect(r.freedIds).toEqual(['t1']);
        expect(mockTableFind).not.toHaveBeenCalled();
    });
});
