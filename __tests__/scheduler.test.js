/**
 * #35 — utils/scheduler.js: overlap prevention, cluster-lock gating,
 * error isolation and stopAll(), driven by Jest fake timers.
 */
const { createScheduler, defaultLeaseMs } = require('../utils/scheduler');

const quietLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function alwaysLock() {
    return {
        acquire: jest.fn(async () => true),
        extend: jest.fn(async () => true),
        markFinished: jest.fn(async () => {}),
    };
}

// Let pending promise callbacks run between timer advances.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
// Advance in 1s steps, flushing between, so each run settles before the
// next tick (otherwise back-to-back ticks look like overlaps).
const advance = async (ms, step = 1000) => {
    for (let t = 0; t < ms; t += step) {
        jest.advanceTimersByTime(Math.min(step, ms - t));
        await flush();
    }
};

describe('scheduler', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('runs after the initial delay, then every interval', async () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        const fn = jest.fn(async () => {});
        sched.scheduleJob('tick', 1000, fn, { initialDelayMs: 500 });

        jest.advanceTimersByTime(499);
        await flush();
        expect(fn).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1000);
        await flush();
        expect(fn).toHaveBeenCalledTimes(2);

        await advance(3000);
        expect(fn).toHaveBeenCalledTimes(5);
        await sched.stopAll();
    });

    test('initial delay defaults to one interval', async () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        const fn = jest.fn(async () => {});
        sched.scheduleJob('tick', 1000, fn);
        jest.advanceTimersByTime(999);
        await flush();
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        await sched.stopAll();
    });

    test('a slow run is never overlapped on the same instance', async () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        let active = 0;
        let maxActive = 0;
        const resolvers = [];
        const fn = jest.fn(() => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            return new Promise((resolve) => resolvers.push(() => { active -= 1; resolve(); }));
        });
        const job = sched.scheduleJob('slow', 1000, fn, { initialDelayMs: 0 });

        jest.advanceTimersByTime(0);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);

        // Three more ticks while the first run is still pending → skipped.
        jest.advanceTimersByTime(3000);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(job.stats.skippedOverlap).toBe(3);

        // Finish the run; the next tick runs again.
        resolvers.shift()();
        await flush();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(fn).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1);

        resolvers.shift()();
        await sched.stopAll();
    });

    test('tick is skipped when another instance holds the lease', async () => {
        const lock = alwaysLock();
        lock.acquire.mockResolvedValue(false);
        const sched = createScheduler({ lock, logger: quietLogger });
        const fn = jest.fn(async () => {});
        const job = sched.scheduleJob('locked', 1000, fn, { initialDelayMs: 0 });

        await advance(2000);
        expect(lock.acquire).toHaveBeenCalledWith('locked', defaultLeaseMs(1000));
        expect(fn).not.toHaveBeenCalled();
        expect(job.stats.skippedLocked).toBeGreaterThanOrEqual(2);
        await sched.stopAll();
    });

    test('lock acquire errors skip the tick without killing the timer', async () => {
        const lock = alwaysLock();
        lock.acquire
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(true);
        const sched = createScheduler({ lock, logger: quietLogger });
        const fn = jest.fn(async () => {});
        sched.scheduleJob('flaky-lock', 1000, fn, { initialDelayMs: 0 });

        jest.advanceTimersByTime(0);
        await flush();
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        await sched.stopAll();
    });

    test('lock: false bypasses the cluster lease', async () => {
        const lock = alwaysLock();
        const sched = createScheduler({ lock, logger: quietLogger });
        const fn = jest.fn(async () => {});
        sched.scheduleJob('local', 1000, fn, { initialDelayMs: 0, lock: false });
        jest.advanceTimersByTime(0);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(lock.acquire).not.toHaveBeenCalled();
        await sched.stopAll();
    });

    test('a throwing job is logged and keeps its schedule', async () => {
        const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const lock = alwaysLock();
        const sched = createScheduler({ lock, logger });
        const fn = jest.fn(async () => { throw new Error('boom'); });
        const job = sched.scheduleJob('boom', 1000, fn, { initialDelayMs: 0 });

        jest.advanceTimersByTime(0);
        await flush();
        await advance(2000);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(job.stats.errors).toBe(3);
        expect(logger.error).toHaveBeenCalled();
        expect(lock.markFinished).toHaveBeenCalledWith('boom', expect.any(Error));
        await sched.stopAll();
    });

    test('heartbeat extends the lease while a long run is in progress', async () => {
        const lock = alwaysLock();
        const sched = createScheduler({ lock, logger: quietLogger });
        let finish;
        const fn = jest.fn(() => new Promise((r) => { finish = r; }));
        sched.scheduleJob('long', 60_000, fn, { initialDelayMs: 0, leaseMs: 10_000 });

        jest.advanceTimersByTime(0);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(15_000); // heartbeat every leaseMs/2 = 5s
        await flush();
        expect(lock.extend).toHaveBeenCalledTimes(3);

        finish();
        await flush();
        jest.advanceTimersByTime(20_000);
        await flush();
        expect(lock.extend).toHaveBeenCalledTimes(3); // stopped after the run
        await sched.stopAll();
    });

    test('scheduleJob is idempotent per name', () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        const a = sched.scheduleJob('same', 1000, async () => {});
        const b = sched.scheduleJob('same', 5000, async () => {});
        expect(b).toBe(a);
        expect(sched.getJobs()).toHaveLength(1);
        return sched.stopAll();
    });

    test('stopAll clears timers and waits for in-flight runs', async () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        let finish;
        const fn = jest.fn(() => new Promise((r) => { finish = r; }));
        sched.scheduleJob('drain', 1000, fn, { initialDelayMs: 0 });
        jest.advanceTimersByTime(0);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);

        let stopped = false;
        const stopping = sched.stopAll({ timeoutMs: 10_000 }).then((r) => { stopped = true; return r; });
        await flush();
        expect(stopped).toBe(false);

        finish();
        const result = await stopping;
        expect(result.drained).toBe(true);

        jest.advanceTimersByTime(10_000);
        await flush();
        expect(fn).toHaveBeenCalledTimes(1); // no more ticks after stop
        expect(sched.scheduleJob('late', 1000, async () => {})).toBeNull();
    });

    test('stopAll gives up after timeoutMs on a stuck run', async () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        sched.scheduleJob('stuck', 1000, () => new Promise(() => {}), { initialDelayMs: 0 });
        jest.advanceTimersByTime(0);
        await flush();
        const stopping = sched.stopAll({ timeoutMs: 500 });
        jest.advanceTimersByTime(500);
        const result = await stopping;
        expect(result).toEqual({ drained: false, pending: 1 });
    });

    test('defaultLeaseMs is just under the interval', () => {
        expect(defaultLeaseMs(60_000)).toBe(54_000);
        expect(defaultLeaseMs(30 * 60_000)).toBe(29 * 60_000);
        expect(defaultLeaseMs(24 * 3600_000)).toBe(24 * 3600_000 - 60_000);
        expect(defaultLeaseMs(500)).toBe(1000);
    });

    test('rejects invalid arguments', () => {
        const sched = createScheduler({ lock: alwaysLock(), logger: quietLogger });
        expect(() => sched.scheduleJob('', 1000, () => {})).toThrow();
        expect(() => sched.scheduleJob('x', 0, () => {})).toThrow();
        expect(() => sched.scheduleJob('x', 1000, null)).toThrow();
    });
});
