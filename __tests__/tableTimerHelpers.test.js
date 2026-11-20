const {
    DEFAULTS, normalizeTableTimer, validateTableTimer, earliestStart, durationMinutesOf,
    orderStartsTimer, canSeeTimer, planBackfill,
} = require('../utils/tableTimer');

describe('normalizeTableTimer', () => {
    test('defaults 60/90 when absent or junk', () => {
        expect(DEFAULTS).toEqual({ amberMinutes: 60, redMinutes: 90 });
        expect(normalizeTableTimer(undefined)).toEqual(DEFAULTS);
        expect(normalizeTableTimer(null)).toEqual(DEFAULTS);
        expect(normalizeTableTimer({ amberMinutes: 'x' })).toEqual(DEFAULTS);
    });
    test('keeps valid values and fills the missing half', () => {
        expect(normalizeTableTimer({ amberMinutes: 30, redMinutes: 45 })).toEqual({ amberMinutes: 30, redMinutes: 45 });
        expect(normalizeTableTimer({ amberMinutes: 30 })).toEqual({ amberMinutes: 30, redMinutes: 90 });
    });
});

describe('validateTableTimer', () => {
    test('ok', () => expect(validateTableTimer({ amberMinutes: 1, redMinutes: 1440 })).toBeNull());
    test('bounds and integers', () => {
        expect(validateTableTimer({ amberMinutes: 0, redMinutes: 90 })).toMatch(/between 1 and 1440/);
        expect(validateTableTimer({ amberMinutes: 60, redMinutes: 1441 })).toMatch(/between 1 and 1440/);
        expect(validateTableTimer({ amberMinutes: 10.5, redMinutes: 90 })).toMatch(/whole number/);
    });
    test('red must be greater than amber', () => {
        expect(validateTableTimer({ amberMinutes: 60, redMinutes: 60 })).toMatch(/greater than/);
        expect(validateTableTimer({ amberMinutes: 90, redMinutes: 60 })).toMatch(/greater than/);
    });
});

describe('earliestStart / durationMinutesOf', () => {
    test('earliest of dates, ignoring nulls', () => {
        const a = new Date('2026-01-01T10:00:00Z');
        const b = new Date('2026-01-01T09:00:00Z');
        expect(earliestStart([a, null, b])).toEqual(b);
        expect(earliestStart([null, undefined])).toBeNull();
    });
    test('rounds to whole minutes', () => {
        const s = new Date('2026-01-01T10:00:00Z');
        expect(durationMinutesOf(s, new Date(s.getTime() + 89 * 1000))).toBe(1);
        expect(durationMinutesOf(s, new Date(s.getTime() + 29 * 1000))).toBe(0);
        expect(durationMinutesOf(s, new Date(s.getTime() - 5000))).toBe(0);
    });
});

describe('orderStartsTimer', () => {
    const base = { type: 'dine-in', table: 't1', status: 'new', items: [{ name: 'x' }] };
    test('confirmed dine-in order with items and a table', () => expect(orderStartsTimer(base)).toBe(true));
    test.each([
        ['no items', { items: [] }],
        ['awaiting-payment', { status: 'awaiting-payment' }],
        ['cancelled', { status: 'cancelled' }],
        ['takeaway', { type: 'takeaway' }],
        ['no table', { table: null }],
    ])('not for %s', (_n, patch) => expect(orderStartsTimer({ ...base, ...patch })).toBe(false));
});

describe('canSeeTimer', () => {
    test.each(['admin', 'manager', 'captain'])('%s sees it', (r) => expect(canSeeTimer({ role: r })).toBe(true));
    test.each(['waiter', 'chef', 'customer', 'superadmin'])('%s does not', (r) => expect(canSeeTimer({ role: r })).toBe(false));
    test('nobody', () => expect(canSeeTimer(null)).toBe(false));
});

describe('planBackfill', () => {
    const t = new Date('2026-01-01T10:00:00Z');
    const t2 = new Date('2026-01-01T10:30:00Z');
    test('earliest confirmed open order with items; awaiting-payment/cancelled/empty ignored', () => {
        const orders = [
            { status: 'awaiting-payment', items: [{}], createdAt: new Date('2026-01-01T08:00:00Z') },
            { status: 'cancelled', items: [{}], createdAt: new Date('2026-01-01T08:30:00Z') },
            { status: 'new', items: [], createdAt: new Date('2026-01-01T09:00:00Z') },
            { status: 'preparing', items: [{}], createdAt: t2, _id: 'b' },
            { status: 'new', items: [{}], createdAt: t, _id: 'a' },
        ];
        expect(planBackfill({ status: 'occupied', sessionStartedAt: null }, orders)).toEqual({ startedAt: t, firstOrder: 'a', orderCount: 2 });
    });
    test('null when already started, not occupied, or nothing qualifies', () => {
        const o = [{ status: 'new', items: [{}], createdAt: t, _id: 'a' }];
        expect(planBackfill({ status: 'occupied', sessionStartedAt: t2 }, o)).toBeNull();
        expect(planBackfill({ status: 'free' }, o)).toBeNull();
        expect(planBackfill({ status: 'occupied' }, [])).toBeNull();
    });
});
