/**
 * utils/haltedSubscriptionSuspender.js — product decision 5 (2026-10):
 * a halted subscription gets a 24-hour grace period before the tenant is
 * suspended.
 *
 * Coverage:
 *   - grace deadline = halt time + 24 h
 *   - only past_due + halted tenants whose deadline passed are suspended
 *   - the suspend re-checks the same conditions atomically, so a charge
 *     that clears the schedule in between wins
 *   - post-suspend hook runs per tenant and its failure is swallowed
 *   - the job can be disabled by env
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockScheduleJob = jest.fn(() => ({ name: 'halted-subscription-suspender' }));
jest.mock('../utils/scheduler', () => ({ scheduleJob: (...a) => mockScheduleJob(...a) }));

const {
    GRACE_HOURS, SUSPEND_REASON, scheduledSuspendAtFor, runHaltedSuspension, startHaltedSubscriptionSuspender,
} = require('../utils/haltedSubscriptionSuspender');

// ── Helpers ──────────────────────────────────────────────────────────
const NOW = new Date('2026-10-03T12:00:00.000Z');

/** Minimal in-memory Restaurant model honouring the filters the job uses. */
function fakeModel(rows) {
    const matches = (r, f) => r.status === f.status
        && r.subscription.razorpayStatus === f['subscription.razorpayStatus']
        && r.subscription.scheduledSuspendAt
        && r.subscription.scheduledSuspendAt <= f['subscription.scheduledSuspendAt'].$lte
        && (!f._id || String(r._id) === String(f._id));
    return {
        rows,
        find: jest.fn((f) => ({ select: () => ({ lean: async () => rows.filter((r) => matches(r, f)).map((r) => ({ _id: r._id, slug: r.slug })) }) })),
        findOneAndUpdate: jest.fn(async (f, update) => {
            const r = rows.find((x) => matches(x, f));
            if (!r) return null;
            Object.assign(r, { status: update.$set.status, suspendedAt: update.$set.suspendedAt, suspendedReason: update.$set.suspendedReason });
            delete r.subscription.scheduledSuspendAt;
            return r;
        }),
    };
}

const tenant = (id, fields = {}, sub = {}) => ({
    _id: id, slug: `t-${id}`, status: 'past_due',
    subscription: { razorpayStatus: 'halted', scheduledSuspendAt: new Date(NOW.getTime() - 60 * 1000), ...sub },
    ...fields,
});

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HALTED_SUSPEND_DISABLED;
});

// ── Tests ────────────────────────────────────────────────────────────
describe('grace deadline', () => {
    test('a tenant halted now is locked out exactly 24 hours later', () => {
        expect(GRACE_HOURS).toBe(24);
        expect(scheduledSuspendAtFor(NOW).toISOString()).toBe('2026-10-04T12:00:00.000Z');
    });
});

describe('runHaltedSuspension', () => {
    test('suspends only past_due + halted tenants whose deadline has passed', async () => {
        const model = fakeModel([
            tenant('a'),                                                                      // due
            tenant('b', {}, { scheduledSuspendAt: new Date(NOW.getTime() + 60 * 60 * 1000) }), // still in grace
            tenant('c', {}, { razorpayStatus: 'active' }),                                   // charged since
            tenant('d', { status: 'active' }),                                               // reactivated
            tenant('e', {}, { scheduledSuspendAt: undefined }),                              // nothing scheduled
        ]);

        const r = await runHaltedSuspension({ now: NOW, model });

        expect(r).toEqual({ checked: 1, suspended: ['a'] });
        const a = model.rows.find((x) => x._id === 'a');
        expect(a).toMatchObject({ status: 'suspended', suspendedAt: NOW, suspendedReason: SUSPEND_REASON });
        expect(a.subscription.scheduledSuspendAt).toBeUndefined();
        for (const id of ['b', 'c', 'd', 'e']) expect(model.rows.find((x) => x._id === id).status).not.toBe('suspended');
    });

    test('a charge that clears the schedule between the read and the write wins', async () => {
        const model = fakeModel([tenant('a')]);
        const realUpdate = model.findOneAndUpdate;
        model.findOneAndUpdate = jest.fn(async (f, u) => {
            // subscription.charged lands first: back to active, schedule cleared.
            const row = model.rows[0];
            row.status = 'active';
            row.subscription.razorpayStatus = 'active';
            delete row.subscription.scheduledSuspendAt;
            return realUpdate(f, u);
        });

        const r = await runHaltedSuspension({ now: NOW, model });

        expect(r.suspended).toEqual([]);
        expect(model.rows[0].status).toBe('active');
    });

    test('the post-suspend hook runs per tenant and its failure does not stop the sweep', async () => {
        const model = fakeModel([tenant('a'), tenant('b')]);
        const onSuspended = jest.fn().mockRejectedValueOnce(new Error('cache down')).mockResolvedValue();

        const r = await runHaltedSuspension({ now: NOW, model, onSuspended });

        expect(r.suspended).toEqual(['a', 'b']);
        expect(onSuspended).toHaveBeenCalledTimes(2);
    });

    test('a second run is a no-op', async () => {
        const model = fakeModel([tenant('a')]);
        await runHaltedSuspension({ now: NOW, model });

        const again = await runHaltedSuspension({ now: NOW, model });

        expect(again).toEqual({ checked: 0, suspended: [] });
    });
});

describe('startHaltedSubscriptionSuspender', () => {
    test('schedules a cluster-locked job every 15 minutes by default', () => {
        startHaltedSubscriptionSuspender();
        expect(mockScheduleJob).toHaveBeenCalledWith('halted-subscription-suspender', 15 * 60 * 1000, expect.any(Function));
    });

    test('can be disabled by env', () => {
        process.env.HALTED_SUSPEND_DISABLED = 'true';
        expect(startHaltedSubscriptionSuspender()).toBeNull();
        expect(mockScheduleJob).not.toHaveBeenCalled();
    });
});
