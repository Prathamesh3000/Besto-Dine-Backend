/**
 * utils/trialReminderJob.dueReminder — pure, fixed clock (plan §7).
 *
 * The trial ends at 11:00 IST (05:30Z), so every "T±n days" instant below is
 * also 11:00 IST — inside the 09:00-18:00 send window of the default
 * Asia/Kolkata timezone.
 */
const { dueReminder, TYPES, inSendWindow, localHour, triggerAt } = require('../utils/trialReminderJob');
const { DAY_MS, TRIAL_READONLY_GRACE_DAYS } = require('../utils/trialLock');

const END = new Date('2026-11-20T05:30:00.000Z'); // 11:00 IST
const H = 60 * 60 * 1000;
const days = (n) => new Date(END.getTime() + n * DAY_MS);
const plus = (d, ms) => new Date(d.getTime() + ms);

const tenant = (over = {}, sub = {}) => ({
    status: 'trial',
    contactEmail: 'owner@hotels.test',
    subscription: { status: 'trial', trialEndDate: END, trialReminders: [], ...sub },
    ...over,
});
const sent = (...types) => types.map((type) => ({ type, queuedAt: END, sentAt: END }));

describe('types and trigger times', () => {
    test('four types, in order', () => {
        expect(TYPES).toEqual(['t-3', 't-1', 't+0', 't+2']);
        expect(triggerAt('t-3', END).getTime()).toBe(days(-3).getTime());
        expect(triggerAt('t+0', END).getTime()).toBe(END.getTime());
        // t+2 is the last read-only day: grace - 1 days after the end.
        expect(triggerAt('t+2', END).getTime()).toBe(days(TRIAL_READONLY_GRACE_DAYS - 1).getTime());
    });
});

describe('what is due when', () => {
    test('before T-3 nothing is due', () => {
        expect(dueReminder(tenant(), days(-5))).toBeNull();
        expect(dueReminder(tenant(), plus(days(-3), -1 * H))).toBeNull();
    });

    test('T-3, T-1, T+0, T+2 are due in turn when nothing was sent before', () => {
        expect(dueReminder(tenant(), days(-3))).toBe('t-3');
        expect(dueReminder(tenant(), days(-1))).toBe('t-1');
        expect(dueReminder(tenant(), days(0))).toBe('t+0');
        expect(dueReminder(tenant(), days(2))).toBe('t+2');
    });

    test('the normal sequence: each type is due once the previous one is recorded', () => {
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3') }), plus(days(-3), 2 * H))).toBeNull();
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3') }), days(-1))).toBe('t-1');
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3', 't-1') }), days(0))).toBe('t+0');
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3', 't-1', 't+0') }), days(2))).toBe('t+2');
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3', 't-1', 't+0', 't+2') }), plus(days(2), 3 * H))).toBeNull();
    });

    test('already sent (or merely claimed, sentAt null) -> null', () => {
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3') }), days(-3))).toBeNull();
        expect(dueReminder(tenant({}, { trialReminders: [{ type: 't+0', queuedAt: END, sentAt: null }] }), days(0))).toBeNull();
    });

    test('missed windows: only the latest applicable type, never a catch-up of earlier ones', () => {
        expect(dueReminder(tenant(), days(-1))).toBe('t-1');           // t-3 was missed; not sent
        expect(dueReminder(tenant(), plus(days(0), 5 * H))).toBe('t+0'); // t-3 / t-1 missed
        expect(dueReminder(tenant({}, { trialReminders: sent('t-3') }), days(2))).toBe('t+2');
        // The latest type already recorded: nothing, even though earlier ones never went out.
        expect(dueReminder(tenant({}, { trialReminders: sent('t+2') }), days(2))).toBeNull();
    });

    test('converted (paid) tenant -> null in every window', () => {
        for (const when of [days(-3), days(-1), days(0), days(2)]) {
            expect(dueReminder(tenant({}, { lastChargedAt: days(-4) }), when)).toBeNull();
            expect(dueReminder(tenant({ status: 'active' }, { status: 'active', trialEndDate: null }), when)).toBeNull();
            expect(dueReminder(tenant({}, { status: 'active' }), when)).toBeNull();
        }
    });

    test('cancelled, suspended for another reason, locked, or no owner email -> null', () => {
        expect(dueReminder(tenant({}, { status: 'cancelled' }), days(-1))).toBeNull();
        expect(dueReminder(tenant({ status: 'suspended', suspendedReason: 'Fraud' }), days(-1))).toBeNull();
        // Locked by the sweeper, or locked by the clock (past lockAt): nothing more to say.
        expect(dueReminder(tenant({ status: 'suspended' }, { status: 'expired' }), days(2))).toBeNull();
        expect(dueReminder(tenant(), plus(days(TRIAL_READONLY_GRACE_DAYS), 1 * H))).toBeNull();
        expect(dueReminder(tenant({ contactEmail: '' }), days(-1))).toBeNull();
        expect(dueReminder(tenant({ contactEmail: undefined }), days(-1))).toBeNull();
        expect(dueReminder(null, days(-1))).toBeNull();
    });

    test('extended trial (reminders cleared, new end date) -> due again relative to the new end', () => {
        const newEnd = days(10);
        const extended = tenant({}, { trialEndDate: newEnd, trialReminders: [] });
        // Would have been t+2 territory on the old dates; on the new ones nothing yet…
        expect(dueReminder(extended, days(2))).toBeNull();
        // …and t-3 again three days before the new end.
        expect(dueReminder(extended, plus(newEnd, -3 * DAY_MS))).toBe('t-3');
        expect(dueReminder(extended, plus(newEnd, -1 * DAY_MS))).toBe('t-1');
    });
});

describe('send window 09:00-18:00 in restaurant.timezone', () => {
    const IST = 5.5 * H;
    // 18 Nov = T-2: t-3 (triggered 17 Nov 11:00 IST) is applicable all day long.
    const istAt = (hour, minute = 0) => new Date(Date.UTC(2026, 10, 18, 0, 0) + hour * H + minute * 60 * 1000 - IST);

    test('hour arithmetic', () => {
        expect(localHour(istAt(9), 'Asia/Kolkata')).toBe(9);
        expect(localHour(istAt(17, 59), 'Asia/Kolkata')).toBe(17);
        expect(localHour(istAt(18), 'Asia/Kolkata')).toBe(18);
        expect(localHour(istAt(0), 'Asia/Kolkata')).toBe(0);
    });

    test('inside the window (default timezone) the reminder is due', () => {
        expect(inSendWindow(istAt(9), undefined)).toBe(true);
        expect(dueReminder(tenant(), istAt(9))).toBe('t-3');
        expect(dueReminder(tenant(), istAt(17, 59))).toBe('t-3');
    });

    test('outside the window -> null (not yet due; the next hourly run picks it up)', () => {
        expect(dueReminder(tenant(), istAt(8, 59))).toBeNull();
        expect(dueReminder(tenant(), istAt(18))).toBeNull();
        expect(dueReminder(tenant(), istAt(20))).toBeNull();
        expect(dueReminder(tenant(), istAt(2))).toBeNull();
    });

    test('uses the restaurant\'s own timezone', () => {
        // 11:00 IST is 00:30 in New York (EST): outside.
        expect(dueReminder(tenant({ timezone: 'America/New_York' }), days(-3))).toBeNull();
        // 15:30Z = 10:30 EST: inside.
        expect(dueReminder(tenant({ timezone: 'America/New_York' }), plus(days(-3), 10 * H))).toBe('t-3');
        // 11:00 IST = 06:30 in Berlin (CET): outside; 14:30Z = 15:30 CET: inside.
        expect(dueReminder(tenant({ timezone: 'Europe/Berlin' }), days(-3))).toBeNull();
        expect(dueReminder(tenant({ timezone: 'Europe/Berlin' }), plus(days(-3), 9 * H))).toBe('t-3');
    });

    test('an invalid timezone falls back to Asia/Kolkata instead of throwing', () => {
        expect(dueReminder(tenant({ timezone: 'Mars/Olympus_Mons' }), days(-3))).toBe('t-3');
        expect(dueReminder(tenant({ timezone: 'Mars/Olympus_Mons' }), istAt(20))).toBeNull();
    });
});
