/**
 * Unit tests for utils/openingHours.computeOpenNow — the "Open now ·
 * closes 11:00 PM" badge on the public restaurant landing page.
 *
 * Dates are fixed UTC instants; 2026-09-28 is a Monday.
 * Asia/Kolkata = UTC+5:30, America/New_York = UTC-4 (EDT) on these dates.
 */
const {
    computeOpenNow,
    formatTime,
    parseTime,
    defaultOperatingHours,
    isValidTimeZone,
} = require('../utils/openingHours');

const HOURS = [
    { day: 'Monday', start: '09:00', end: '23:00', isOpen: true },
    { day: 'Tuesday', start: '18:00', end: '02:00', isOpen: true }, // overnight
    { day: 'Wednesday', start: '09:00', end: '17:00', isOpen: false }, // closed day
    // Thursday..Sunday missing → closed
];
const at = (iso) => new Date(iso);
const IST = 'Asia/Kolkata';

describe('computeOpenNow', () => {
    test('open inside a regular window, with the closing time', () => {
        // Mon 17:30 IST
        expect(computeOpenNow(HOURS, IST, at('2026-09-28T12:00:00Z')))
            .toEqual({ isOpen: true, label: 'Open now · closes 11:00 PM' });
    });

    test('before opening today → opens later today', () => {
        // Mon 07:30 IST
        expect(computeOpenNow(HOURS, IST, at('2026-09-28T02:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed · opens 9:00 AM' });
    });

    test('after closing → opens tomorrow', () => {
        // Mon 23:30 IST → Tuesday opens 18:00
        expect(computeOpenNow(HOURS, IST, at('2026-09-28T18:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed · opens 6:00 PM tomorrow' });
    });

    test('overnight window 18:00–02:00: open in the evening part', () => {
        // Tue 23:30 IST
        expect(computeOpenNow(HOURS, IST, at('2026-09-29T18:00:00Z')))
            .toEqual({ isOpen: true, label: 'Open now · closes 2:00 AM' });
    });

    test('overnight window spills past midnight into a CLOSED day', () => {
        // Wed 00:30 IST — Wednesday is closed but Tuesday's window runs to 02:00
        expect(computeOpenNow(HOURS, IST, at('2026-09-29T19:00:00Z')))
            .toEqual({ isOpen: true, label: 'Open now · closes 2:00 AM' });
    });

    test('overnight window: closed after it ends; closed day skipped to next open day', () => {
        // Wed 11:30 IST — Wed closed, Thu–Sun missing → next is Monday
        expect(computeOpenNow(HOURS, IST, at('2026-09-30T06:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed · opens 9:00 AM Monday' });
    });

    test('evaluated in the tenant timezone, not the server clock', () => {
        // 12:00Z is Mon 17:30 in IST (open) but Mon 08:00 in New York (not yet open)
        const t = at('2026-09-28T12:00:00Z');
        expect(computeOpenNow(HOURS, IST, t).isOpen).toBe(true);
        expect(computeOpenNow(HOURS, 'America/New_York', t))
            .toEqual({ isOpen: false, label: 'Closed · opens 9:00 AM' });
        // 02:00Z is Sun 22:00 in New York → Sunday closed, Monday tomorrow
        expect(computeOpenNow(HOURS, 'America/New_York', at('2026-09-28T02:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed · opens 9:00 AM tomorrow' });
    });

    test('invalid / missing timezone falls back to Asia/Kolkata', () => {
        const t = at('2026-09-28T12:00:00Z');
        expect(computeOpenNow(HOURS, 'Not/AZone', t)).toEqual(computeOpenNow(HOURS, IST, t));
        expect(computeOpenNow(HOURS, undefined, t)).toEqual(computeOpenNow(HOURS, IST, t));
    });

    test('start === end means open all day', () => {
        const allDay = [{ day: 'Mon', start: '00:00', end: '00:00', isOpen: true }];
        expect(computeOpenNow(allDay, IST, at('2026-09-28T12:00:00Z')))
            .toEqual({ isOpen: true, label: 'Open 24 hours' });
    });

    test('no open day at all → "Closed"', () => {
        const closed = HOURS.map((h) => ({ ...h, isOpen: false }));
        expect(computeOpenNow(closed, IST, at('2026-09-28T12:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed' });
        expect(computeOpenNow([], IST, at('2026-09-28T12:00:00Z')))
            .toEqual({ isOpen: false, label: 'Closed' });
        expect(computeOpenNow(null, IST, at('2026-09-28T12:00:00Z')).isOpen).toBe(false);
    });

    test('closing boundary is exclusive, opening boundary inclusive', () => {
        // Mon 09:00 IST = 03:30Z; Mon 23:00 IST = 17:30Z
        expect(computeOpenNow(HOURS, IST, at('2026-09-28T03:30:00Z')).isOpen).toBe(true);
        expect(computeOpenNow(HOURS, IST, at('2026-09-28T17:30:00Z')).isOpen).toBe(false);
    });

    test('short / lowercase day names are accepted; malformed entries ignored', () => {
        const hours = [
            { day: 'mon', start: '09:00', end: '23:00' },
            { day: 'Funday', start: '09:00', end: '23:00' },
            { day: 'Tue', start: 'nine', end: '23:00' },
        ];
        expect(computeOpenNow(hours, IST, at('2026-09-28T12:00:00Z')).isOpen).toBe(true);
        // Mon 23:30 → Tue malformed (closed) → next Monday
        expect(computeOpenNow(hours, IST, at('2026-09-28T18:00:00Z')).label)
            .toBe('Closed · opens 9:00 AM Monday');
    });

    test('default week is open every day 09:00–23:00', () => {
        const week = defaultOperatingHours();
        expect(week).toHaveLength(7);
        expect(computeOpenNow(week, IST, at('2026-09-28T12:00:00Z')).isOpen).toBe(true);
    });
});

describe('helpers', () => {
    test('formatTime renders 12-hour clock', () => {
        expect(formatTime(0)).toBe('12:00 AM');
        expect(formatTime(9 * 60)).toBe('9:00 AM');
        expect(formatTime(12 * 60 + 30)).toBe('12:30 PM');
        expect(formatTime(23 * 60)).toBe('11:00 PM');
    });

    test('parseTime', () => {
        expect(parseTime('09:30')).toBe(570);
        expect(parseTime('24:00')).toBe(1440);
        expect(parseTime('25:00')).toBeNull();
        expect(parseTime('9:60')).toBeNull();
        expect(parseTime('')).toBeNull();
    });

    test('isValidTimeZone', () => {
        expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
        expect(isValidTimeZone('Nope/Nope')).toBe(false);
        expect(isValidTimeZone('')).toBe(false);
    });
});
