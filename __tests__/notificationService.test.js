/**
 * BUG #32 — services/notificationService.notify(): persist + emit, never throws.
 * Notification model is mocked; io is a fake that records room emits and is
 * passed straight to the real utils/socket emit helpers.
 */
jest.mock('../models/notification', () => ({
    create: jest.fn(async (doc) => ({ _id: 'n1', ...doc })),
    insertMany: jest.fn(async (docs) => docs.map((d, i) => ({ _id: `n${i + 1}`, ...d }))),
}));
jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const Notification = require('../models/notification');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');

const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B1 = '111111111111111111111111';
const U1 = 'cccccccccccccccccccccccc';
const U2 = 'dddddddddddddddddddddddd';

function fakeIO() {
    const sent = [];
    return {
        sent,
        to(rooms) {
            return { emit: (event, payload) => sent.push({ rooms: [].concat(rooms), event, payload }) };
        },
    };
}

beforeEach(() => jest.clearAllMocks());

test('persists one admin row and emits notification:new to the branch admin rooms', async () => {
    const io = fakeIO();
    const res = await notify({
        io, restaurant: T1, branch: B1, audience: 'admin',
        notification: { recipientRole: 'admin', title: 'Hi', description: 'There', category: 'Payment', meta: { orderId: 'O1' } },
    });
    expect(res.ok).toBe(true);
    expect(res.persisted).toBe(true);
    expect(Notification.create).toHaveBeenCalledWith({
        recipientRole: 'admin', title: 'Hi', description: 'There', category: 'Payment',
        meta: { orderId: 'O1' }, restaurant: T1, branch: B1,
    });
    expect(io.sent).toEqual([{
        rooms: [`t:${T1}:admin:${B1}`, `t:${T1}:admin`],
        event: EVENTS.NOTIFICATION_NEW,
        payload: { title: 'Hi', description: 'There' },
    }]);
});

test('one row per recipient via insertMany, emits to each user room, then `also` events', async () => {
    const io = fakeIO();
    const res = await notify({
        io, restaurant: T1, branch: null, recipients: [U1, U2],
        notification: { recipientRole: 'waiter', title: 'Req', description: 'd' },
        payload: { title: 'New Request' },
        also: [{ event: EVENTS.REQUEST_NEW, payload: { id: 'r1' } }],
    });
    expect(res.docs).toHaveLength(2);
    expect(Notification.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({ recipient: U1, recipientRole: 'waiter', restaurant: T1, branch: null }),
        expect.objectContaining({ recipient: U2, recipientRole: 'waiter' }),
    ]);
    expect(io.sent.map((s) => [s.rooms[0], s.event])).toEqual([
        [U1, 'notification:new'], [U2, 'notification:new'],
        [U1, 'request:new'], [U2, 'request:new'],
    ]);
});

test('recipientRole array → one row per role; unbranched emit uses tenant from `restaurant`', async () => {
    const io = fakeIO();
    await notify({
        io, restaurant: T1, audience: ['admin', 'waiter'],
        notification: { recipientRole: ['admin', 'waiter'], title: 't', description: 'd' },
    });
    expect(Notification.insertMany.mock.calls[0][0].map((d) => d.recipientRole)).toEqual(['admin', 'waiter']);
    expect(io.sent.map((s) => s.rooms)).toEqual([
        [`t:${T1}:admin`, `t:${T1}:admin:unbranched`],
        [`t:${T1}:waiter`, `t:${T1}:waiter:unbranched`],
    ]);
});

test('persist:false only emits; staff audience covers admin+waiter+kitchen', async () => {
    const io = fakeIO();
    await notify({ io, restaurant: T1, branch: B1, audience: 'staff', persist: false,
        event: EVENTS.TABLE_UPDATED, payload: { tableId: 'x' } });
    expect(Notification.create).not.toHaveBeenCalled();
    expect(io.sent).toHaveLength(1);
    expect(io.sent[0].rooms).toEqual(expect.arrayContaining([
        `t:${T1}:admin:${B1}`, `t:${T1}:waiter:${B1}`, `t:${T1}:kitchen:${B1}`,
    ]));
});

test('invalid priority/category are coerced instead of failing', async () => {
    await notify({ io: fakeIO(), restaurant: T1, notification: {
        title: 't', description: 'd', priority: 'normal', category: 'Booking', recipientRole: 'admin' } });
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({ priority: 'medium', category: 'System' }));
    expect(logger.warn).toHaveBeenCalled();
});

test('never throws: persist failure is logged, emit still happens', async () => {
    Notification.create.mockRejectedValueOnce(new Error('db down'));
    const io = fakeIO();
    const res = await notify({ io, restaurant: T1, audience: 'admin',
        notification: { recipientRole: 'admin', title: 't', description: 'd' } });
    expect(res.ok).toBe(false);
    expect(res.error.message).toBe('db down');
    expect(res.persisted).toBe(false);
    expect(io.sent).toHaveLength(1);
});

test('never throws: io that explodes, missing restaurant, no io at all', async () => {
    const badIO = { to() { throw new Error('boom'); } };
    await expect(notify({ io: badIO, restaurant: T1, recipients: [U1], persist: false, payload: {} }))
        .resolves.toMatchObject({ ok: false });
    await expect(notify({ notification: { title: 't', description: 'd' } }))
        .resolves.toMatchObject({ ok: false, persisted: false });
    // utils/socket not initialised → getIO throws → emit skipped quietly
    await expect(notify({ restaurant: T1, audience: 'admin', persist: false, payload: {} }))
        .resolves.toMatchObject({ ok: true, emitted: false });
});

test('safe to call after the response without awaiting', async () => {
    const io = fakeIO();
    const p = notify({ io, restaurant: T1, branch: B1, audience: 'captain', persist: false, payload: { a: 1 } });
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(io.sent[0].rooms).toEqual([`t:${T1}:captain:${B1}`, `t:${T1}:captain`]);
});
