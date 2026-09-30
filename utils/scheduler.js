/**
 * #35 — tiny in-process job scheduler that is safe to run on N instances.
 *
 *   const { scheduleJob } = require('./scheduler');
 *   scheduleJob('empty-order-sweep', 15 * 60_000, runEmptyOrderSweep, { initialDelayMs: 10_000 });
 *
 * Every tick:
 *   1. Overlap guard (per instance) — if the previous run of this job is
 *      still going on this instance, the tick is skipped.
 *   2. Cluster lock — utils/jobLock.js lease in MongoDB. Only the
 *      instance that wins the lease runs the tick; the lease lasts just
 *      under one interval so a second instance whose timer fires a bit
 *      later sees "already ran this interval" and skips. While a run is
 *      in progress the lease is extended (heartbeat) so a slow run is
 *      never picked up by another instance mid-flight.
 *   3. Errors are caught and logged; a failing job never kills the timer.
 *
 * Timers are unref()'d so they never keep a process alive on their own
 * (scripts / tests exit cleanly). stopAll() clears every timer and waits
 * (bounded) for in-flight runs — called from the SIGTERM handler.
 *
 * Single-server dev needs no config: the lock collection is created on
 * first use and a lone instance always wins the lease.
 */
const logger = require('./logger');

function unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
}

// Lease just under one interval: at most 10% (capped at 60s) of slack so
// instances whose timers are slightly out of phase don't double-run.
function defaultLeaseMs(intervalMs) {
    const slack = Math.min(intervalMs * 0.1, 60 * 1000);
    return Math.max(1000, Math.floor(intervalMs - slack));
}

/**
 * @param {object} [deps]
 * @param {object} [deps.lock]   { acquire, extend, markFinished } — defaults to utils/jobLock.
 * @param {object} [deps.logger]
 */
function createScheduler(deps = {}) {
    const log = deps.logger || logger;
    const getLock = () => deps.lock || require('./jobLock');
    const jobs = new Map(); // name → job
    let stopped = false;

    async function runTick(job) {
        if (stopped) return;
        if (job.running) {
            job.stats.skippedOverlap += 1;
            log.debug(`job ${job.name}: previous run still in progress on this instance — tick skipped`);
            return;
        }
        job.running = true;
        let heartbeat = null;
        let runError = null;
        let ran = false;
        const lock = job.useLock ? getLock() : null;
        const run = (async () => {
            try {
                if (lock) {
                    let acquired = false;
                    try {
                        acquired = await lock.acquire(job.name, job.leaseMs);
                    } catch (err) {
                        log.warn(`job ${job.name}: lock acquire failed — tick skipped`, { error: err.message });
                        return;
                    }
                    if (!acquired) {
                        job.stats.skippedLocked += 1;
                        log.debug(`job ${job.name}: lease held elsewhere (or DB not ready) — tick skipped`);
                        return;
                    }
                    if (typeof lock.extend === 'function' && job.leaseMs >= 2000) {
                        heartbeat = unref(setInterval(() => {
                            Promise.resolve(lock.extend(job.name, job.leaseMs)).catch((err) =>
                                log.warn(`job ${job.name}: lease extend failed`, { error: err.message }));
                        }, Math.floor(job.leaseMs / 2)));
                    }
                }
                if (stopped) return;
                ran = true;
                job.stats.runs += 1;
                job.lastStartedAt = new Date();
                await job.fn();
            } catch (err) {
                runError = err;
                job.stats.errors += 1;
                log.error(`job ${job.name} failed`, { error: err?.message || String(err), stack: err?.stack });
            } finally {
                if (heartbeat) clearInterval(heartbeat);
                if (ran && lock && typeof lock.markFinished === 'function') {
                    Promise.resolve(lock.markFinished(job.name, runError)).catch(() => {});
                }
                job.lastFinishedAt = ran ? new Date() : job.lastFinishedAt;
                job.running = false;
                job.current = null;
            }
        })();
        job.current = run;
        return run;
    }

    /**
     * Register a recurring job. Idempotent per name (a second call with
     * the same name is ignored and returns the existing job).
     *
     * @param {string}   name
     * @param {number}   intervalMs
     * @param {function} fn                     async () => any
     * @param {object}   [opts]
     * @param {number}   [opts.initialDelayMs]  first run delay (default: intervalMs)
     * @param {boolean}  [opts.lock=true]       take the cluster lease before each run
     * @param {number}   [opts.leaseMs]         override lease length
     */
    function scheduleJob(name, intervalMs, fn, opts = {}) {
        if (!name) throw new Error('scheduleJob: name is required');
        if (!(intervalMs > 0)) throw new Error(`scheduleJob(${name}): intervalMs must be > 0`);
        if (typeof fn !== 'function') throw new Error(`scheduleJob(${name}): fn must be a function`);
        if (jobs.has(name)) return jobs.get(name);
        if (stopped) {
            log.warn(`scheduleJob(${name}) called after stopAll — ignored`);
            return null;
        }

        const initialDelayMs = opts.initialDelayMs ?? intervalMs;
        const job = {
            name,
            intervalMs,
            initialDelayMs,
            fn,
            useLock: opts.lock !== false,
            leaseMs: opts.leaseMs || defaultLeaseMs(intervalMs),
            running: false,
            current: null,
            startTimer: null,
            intervalTimer: null,
            lastStartedAt: null,
            lastFinishedAt: null,
            stats: { runs: 0, errors: 0, skippedOverlap: 0, skippedLocked: 0 },
        };
        job.startTimer = unref(setTimeout(() => {
            job.startTimer = null;
            if (stopped) return;
            runTick(job);
            job.intervalTimer = unref(setInterval(() => runTick(job), intervalMs));
        }, initialDelayMs));
        jobs.set(name, job);
        log.debug(`job ${name} scheduled every ${Math.round(intervalMs / 1000)}s (first run in ${Math.round(initialDelayMs / 1000)}s, lease ${Math.round(job.leaseMs / 1000)}s${job.useLock ? '' : ', unlocked'})`);
        return job;
    }

    /** Stop every timer; wait up to timeoutMs for in-flight runs. */
    async function stopAll({ timeoutMs = 15000 } = {}) {
        stopped = true;
        const inflight = [];
        for (const job of jobs.values()) {
            if (job.startTimer) clearTimeout(job.startTimer);
            if (job.intervalTimer) clearInterval(job.intervalTimer);
            job.startTimer = null;
            job.intervalTimer = null;
            if (job.current) inflight.push(job.current);
        }
        if (!inflight.length) return { drained: true, pending: 0 };
        let timer = null;
        const timedOut = new Promise((resolve) => {
            timer = unref(setTimeout(() => resolve('timeout'), timeoutMs));
        });
        const result = await Promise.race([Promise.allSettled(inflight).then(() => 'drained'), timedOut]);
        clearTimeout(timer);
        if (result === 'timeout') {
            log.warn(`scheduler stop: ${inflight.length} job run(s) still in progress after ${timeoutMs}ms`);
        }
        return { drained: result === 'drained', pending: result === 'drained' ? 0 : inflight.length };
    }

    function getJobs() {
        return [...jobs.values()].map((j) => ({
            name: j.name,
            intervalMs: j.intervalMs,
            leaseMs: j.leaseMs,
            locked: j.useLock,
            running: j.running,
            lastStartedAt: j.lastStartedAt,
            lastFinishedAt: j.lastFinishedAt,
            ...j.stats,
        }));
    }

    return {
        scheduleJob,
        stopAll,
        getJobs,
        isStopped: () => stopped,
        // exposed for tests
        _runTick: (name) => (jobs.has(name) ? runTick(jobs.get(name)) : Promise.resolve()),
    };
}

const defaultScheduler = createScheduler();

module.exports = {
    createScheduler,
    defaultLeaseMs,
    scheduleJob: defaultScheduler.scheduleJob,
    stopAll: defaultScheduler.stopAll,
    getJobs: defaultScheduler.getJobs,
};
