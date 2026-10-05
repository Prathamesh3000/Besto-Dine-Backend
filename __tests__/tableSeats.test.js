// QA #13 — pure helpers behind seat reservation (utils/tableSeats.js,
// utils/tableOccupancy.groupPartyIdentities).
const {
    selectStaleSeats,
    countUncoveredParties,
    seatLimit,
    exposeSeats,
    seatIdleMs,
} = require('../utils/tableSeats');
const { groupPartyIdentities } = require('../utils/tableOccupancy');

const NOW = new Date('2026-10-03T12:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);
const cutoff = minsAgo(30);

describe('selectStaleSeats', () => {
    const seats = [
        { _id: 'fresh', keys: ['s:a'], lastSeenAt: minsAgo(5) },
        { _id: 'idle', keys: ['s:b'], lastSeenAt: minsAgo(45) },
        { _id: 'idle-ordering', keys: ['s:c', 'u:1'], lastSeenAt: minsAgo(90) },
        { _id: 'edge', keys: ['s:d'], lastSeenAt: cutoff },
        { _id: 'no-ts', keys: ['s:e'] },
    ];

    test('picks idle seats whose party has no open order', () => {
        const stale = selectStaleSeats(seats, { cutoff, activeMembers: new Set(['u:1']) });
        expect(stale.map((s) => s._id)).toEqual(['idle', 'no-ts']);
    });

    test('a seat seen exactly at the cutoff is kept', () => {
        expect(selectStaleSeats([seats[3]], { cutoff, activeMembers: [] })).toEqual([]);
    });

    test('accepts an array of active members and handles empty input', () => {
        expect(selectStaleSeats(seats, { cutoff, activeMembers: ['s:c'] }).map((s) => s._id)).toEqual(['idle', 'no-ts']);
        expect(selectStaleSeats(undefined, { cutoff })).toEqual([]);
    });
});

describe('groupPartyIdentities', () => {
    test('orders sharing an identity are one party; staff orders are one shared party', () => {
        const parties = groupPartyIdentities([
            { scanSessionId: 'A' },
            { user: 'U1', scanSessionId: 'A' }, // guest logged in on the same session
            { user: 'U1', scanSessionId: 'B' }, // same user, new phone
            { scanSessionId: 'C' },
            {}, {},                             // staff walk-ins
        ]);
        const norm = parties.map((p) => [...p].sort()).sort((x, y) => x[0].localeCompare(y[0]));
        expect(norm).toEqual([['s:A', 's:B', 'u:U1'], ['s:C'], ['staff']]);
    });

    test('no orders → no parties', () => {
        expect(groupPartyIdentities([])).toEqual([]);
    });
});

describe('remaining-capacity math', () => {
    const orderParties = [['s:A', 'u:1'], ['s:B'], ['staff']];

    test('parties covered by a seat are not counted twice', () => {
        const seats = [{ keys: ['s:A'] }, { keys: ['s:Z'] }];
        expect(countUncoveredParties(orderParties, seats)).toBe(2); // s:B + staff
    });

    test("the caller's own ordering party is excluded (converting, not adding)", () => {
        expect(countUncoveredParties(orderParties, [], ['s:B'])).toBe(2);
        expect(countUncoveredParties(orderParties, [], ['u:1'])).toBe(2);
    });

    test('seatLimit = capacity − seat-less ordering parties, never negative', () => {
        expect(seatLimit(4, 0)).toBe(4);
        expect(seatLimit(4, 1)).toBe(3);
        expect(seatLimit(2, 5)).toBe(0);
        expect(seatLimit(undefined, 0)).toBe(0);
    });

    test('4-seat table with 1 staff walk-in and 3 seats → full', () => {
        const seats = [{ keys: ['s:1'] }, { keys: ['s:2'] }, { keys: ['s:3'] }];
        const limit = seatLimit(4, countUncoveredParties([['staff']], seats, ['s:new']));
        expect(seats.length < limit).toBe(false);
    });
});

describe('exposeSeats / seatIdleMs', () => {
    test('replaces seat identities with a count', () => {
        const out = exposeSeats({ _id: 't', name: 'T1', seats: [{ keys: ['s:a'] }, { keys: ['s:b'] }] });
        expect(out).toEqual({ _id: 't', name: 'T1', seatsTaken: 2 });
        expect(exposeSeats({ _id: 't' }).seatsTaken).toBe(0);
    });

    test('idle timeout defaults to 30 minutes and honours TABLE_SEAT_IDLE_MINUTES', () => {
        const prev = process.env.TABLE_SEAT_IDLE_MINUTES;
        delete process.env.TABLE_SEAT_IDLE_MINUTES;
        expect(seatIdleMs()).toBe(30 * 60 * 1000);
        process.env.TABLE_SEAT_IDLE_MINUTES = '10';
        expect(seatIdleMs()).toBe(10 * 60 * 1000);
        process.env.TABLE_SEAT_IDLE_MINUTES = 'nonsense';
        expect(seatIdleMs()).toBe(30 * 60 * 1000);
        if (prev === undefined) delete process.env.TABLE_SEAT_IDLE_MINUTES; else process.env.TABLE_SEAT_IDLE_MINUTES = prev;
    });
});
