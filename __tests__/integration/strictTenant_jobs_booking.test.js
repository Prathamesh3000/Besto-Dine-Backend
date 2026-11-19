/**
 * STRICT tenant campaign / jobs: advance-booking balance reminders
 * (utils/bookingReminderScheduler.runBookingReminderScan, 'booking-reminders').
 *
 * Two tenants, each with confirmed bookings owing a balance. Each customer
 * must get ONE reminder, persisted under their own tenant/branch with their
 * own booking id and amount, in nobody else's recipient list. Locked tenants
 * (suspended / cancelled) are skipped, past_due is not. A failing send for one
 * booking never stops the others, a second run does not re-notify, and the
 * JobLock keeps a second instance from running the same tick.
 */
const crypto = require('crypto');
const path = require('path');

jest.mock('../../services/notificationService', () => {
    const actual = jest.requireActual('../../services/notificationService');
    return { ...actual, notify: jest.fn(actual.notify) };
});

const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const AdvanceBooking = require(path.join(BACKEND, 'models/advanceBooking'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const JobLock = require(path.join(BACKEND, 'models/jobLock'));
const notificationService = require(path.join(BACKEND, 'services/notificationService'));
const { runBookingReminderScan } = require(path.join(BACKEND, 'utils/bookingReminderScheduler'));
const { runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { createScheduler } = require(path.join(BACKEND, 'utils/scheduler'));
const { createJobLock } = require(path.join(BACKEND, 'utils/jobLock'));

useIntegrationApp();
const rid = () => crypto.randomBytes(4).toString('hex');
const HOUR = 3600 * 1000;
const scan = () => runAsSystem('job:booking-reminders', () => runBookingReminderScan());
const reload = (b) => runAsSystem('r', () => AdvanceBooking.findById(b._id).lean());
const notesFor = (user) => runAsSystem('r', () => Notification.find({ recipient: user._id }).lean());

async function mkBooking(t, user, fields = {}) {
    return runAsSystem('seed', () => AdvanceBooking.create({
        restaurant: t.restaurant._id, branch: t.branch._id, bookingId: `BK-${rid()}`, user: user._id,
        bookingDate: new Date(Date.now() + 5 * HOUR), bookingTime: '19:00', timeSlot: 'Dinner', guestCount: 4,
        status: 'Confirmed', payment: { totalAmount: 1000, advancePaid: 300, status: 'Partial' },
        ...fields,
    }));
}

let A; let B; let custA; let custB;
beforeAll(async () => {
    A = await seedTenant({ label: 'bka' });
    B = await seedTenant({ label: 'bkb' });
    custA = await createCustomer('bka-c');
    custB = await createCustomer('bkb-c');
});
beforeEach(() => notificationService.notify.mockClear());

describe('booking reminders across two tenants', () => {
    let ba; let bb;
    test('each customer is reminded once, under their own tenant, with their own booking and amount', async () => {
        ba = await mkBooking(A, custA, { payment: { totalAmount: 1000, advancePaid: 300, status: 'Partial' } });
        bb = await mkBooking(B, custB, { payment: { totalAmount: 2500, advancePaid: 500, status: 'Partial' } });
        const r = await scan();
        expect(r.sent).toBeGreaterThanOrEqual(2);

        const na = await notesFor(custA); const nb = await notesFor(custB);
        expect(na).toHaveLength(1); expect(nb).toHaveLength(1);
        expect(String(na[0].restaurant)).toBe(String(A.restaurant._id));
        expect(String(nb[0].restaurant)).toBe(String(B.restaurant._id));
        expect(String(na[0].branch)).toBe(String(A.branch._id));
        expect(String(nb[0].branch)).toBe(String(B.branch._id));
        expect(na[0].description).toContain(ba.bookingId); expect(na[0].description).toContain('700');
        expect(na[0].description).not.toContain(bb.bookingId);
        expect(nb[0].description).toContain(bb.bookingId); expect(nb[0].description).toContain('2000');
        expect(nb[0].description).not.toContain(ba.bookingId);

        // notify() was always handed the booking's own tenant + single recipient
        const calls = notificationService.notify.mock.calls.map((c) => c[0]);
        const forA = calls.filter((c) => String(c.recipients[0]) === String(custA._id));
        expect(forA).toHaveLength(1);
        expect(String(forA[0].restaurant)).toBe(String(A.restaurant._id));
        for (const c of calls) expect(c.recipients).toHaveLength(1);
        expect(forA[0].notification.meta.remainingAmount).toBe(700);
        expect(forA[0].notification.meta.bookingId).toBe(ba.bookingId);

        expect((await reload(ba)).payment.balanceReminderSentAt).toBeTruthy();
        expect((await reload(bb)).payment.balanceReminderSentAt).toBeTruthy();
    });

    test('idempotent: a second scan sends nothing and creates no new notifications', async () => {
        const r = await scan();
        expect(r.sent).toBe(0);
        expect(notificationService.notify).not.toHaveBeenCalledWith(expect.objectContaining({ recipients: [custA._id] }));
        expect(await notesFor(custA)).toHaveLength(1);
        expect(await notesFor(custB)).toHaveLength(1);
    });
});

describe('what is eligible', () => {
    test('Pending, Paid, outside-window and past bookings are not reminded; fully paid is flagged without a notification', async () => {
        const c = await createCustomer('bk-elig');
        const pending = await mkBooking(A, c, { status: 'Pending' });
        const paid = await mkBooking(A, c, { payment: { totalAmount: 1000, advancePaid: 1000, status: 'Paid' } });
        const far = await mkBooking(A, c, { bookingDate: new Date(Date.now() + 72 * HOUR) });
        const past = await mkBooking(A, c, { bookingDate: new Date(Date.now() - 2 * HOUR) });
        const settled = await mkBooking(A, c, { payment: { totalAmount: 800, advancePaid: 800, status: 'Partial' } });
        await scan();
        expect((await reload(pending)).payment.balanceReminderSentAt).toBeNull();
        expect((await reload(paid)).payment.balanceReminderSentAt).toBeNull();
        expect((await reload(far)).payment.balanceReminderSentAt).toBeNull();
        expect((await reload(past)).payment.balanceReminderSentAt).toBeNull();
        expect((await reload(settled)).payment.balanceReminderSentAt).toBeTruthy();
        expect(await notesFor(c)).toHaveLength(0);
    });
});

describe('tenant status gating', () => {
    test('customers of suspended / cancelled tenants are not nudged; past_due tenants still are', async () => {
        const S = await seedTenant({ label: 'bks' });
        const C = await seedTenant({ label: 'bkc' });
        const P = await seedTenant({ label: 'bkp' });
        await Restaurant.updateOne({ _id: S.restaurant._id }, { $set: { status: 'suspended', 'subscription.status': 'expired' } });
        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status: 'cancelled' } });
        await Restaurant.updateOne({ _id: P.restaurant._id }, { $set: { status: 'past_due' } });
        const cs = await createCustomer('bks-c'); const cc = await createCustomer('bkc-c'); const cp = await createCustomer('bkp-c');
        const bs = await mkBooking(S, cs); const bc = await mkBooking(C, cc); const bp = await mkBooking(P, cp);
        await scan();
        expect(await notesFor(cs)).toHaveLength(0);
        expect(await notesFor(cc)).toHaveLength(0);
        expect((await reload(bs)).payment.balanceReminderSentAt).toBeNull();
        expect((await reload(bc)).payment.balanceReminderSentAt).toBeNull();
        expect(await notesFor(cp)).toHaveLength(1);
        expect((await reload(bp)).payment.balanceReminderSentAt).toBeTruthy();
    });
});

describe('failure isolation', () => {
    test('a throwing send for one tenant booking does not stop the other tenant', async () => {
        const ca = await createCustomer('bkf-a'); const cb = await createCustomer('bkf-b');
        const bA = await mkBooking(A, ca); const bB = await mkBooking(B, cb);
        notificationService.notify.mockImplementation(async (arg) => {
            if (String(arg.restaurant) === String(A.restaurant._id)) throw new Error('push gateway down');
            return jest.requireActual('../../services/notificationService').notify(arg);
        });
        try {
            const r = await scan();
            expect(r.scanned).toBeGreaterThanOrEqual(2);
        } finally {
            notificationService.notify.mockImplementation(jest.requireActual('../../services/notificationService').notify);
        }
        expect(await notesFor(cb)).toHaveLength(1);
        expect(String((await notesFor(cb))[0].restaurant)).toBe(String(B.restaurant._id));
        expect(await notesFor(ca)).toHaveLength(0);
        expect((await reload(bB)).payment.balanceReminderSentAt).toBeTruthy();
        expect(bA).toBeTruthy();
    });

    test('a DB failure in the scan is swallowed and reported as nothing sent', async () => {
        const spy = jest.spyOn(AdvanceBooking, 'find').mockImplementation(() => { throw new Error('db down'); });
        try { await expect(scan()).resolves.toEqual({ scanned: 0, sent: 0 }); } finally { spy.mockRestore(); }
    });
});

describe('JobLock', () => {
    test('only one of two instances runs the booking-reminders tick per interval', async () => {
        const fn = jest.fn(() => runBookingReminderScan());
        const s1 = createScheduler({ lock: createJobLock({ owner: 'bk-1' }) });
        const s2 = createScheduler({ lock: createJobLock({ owner: 'bk-2' }) });
        for (const s of [s1, s2]) s.scheduleJob('booking-reminders', 6 * HOUR, fn, { initialDelayMs: 24 * HOUR });
        await Promise.all([s1._runTick('booking-reminders'), s2._runTick('booking-reminders')]);
        await s1._runTick('booking-reminders'); await s2._runTick('booking-reminders');
        expect(fn).toHaveBeenCalledTimes(1);
        const lock = await JobLock.findOne({ name: 'booking-reminders' }).lean();
        expect(lock.lockedUntil.getTime()).toBeGreaterThan(Date.now());
        await Promise.all([s1.stopAll(), s2.stopAll()]);
    });
});
