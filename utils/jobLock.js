/**
 * #35 — MongoDB-backed distributed lock (lease) for scheduled jobs.
 *
 * Lets several backend instances share one database without every
 * instance running every background job on every tick. No Redis needed:
 * the lock lives in the `joblocks` collection (models/jobLock.js).
 *
 * Semantics (lease, not mutex):
 *   acquire(name, leaseMs)  — atomically claims `name` when its lease has
 *                             expired (lockedUntil <= now) and sets
 *                             lockedUntil = now + leaseMs. Returns true
 *                             for exactly one caller per lease window.
 *                             The first-ever acquire upserts the doc; a
 *                             concurrent upsert loses on the unique index
 *                             (E11000) and returns false.
 *   extend(name, leaseMs)   — the holder pushes lockedUntil forward while
 *                             a long run is still going.
 *   release(name)           — the holder expires its lease immediately.
 *   markFinished(name, err) — diagnostics (lastFinishedAt / lastError).
 *
 * The scheduler deliberately does NOT release after a successful run: the
 * lease is sized to just under the job interval, so it doubles as "this
 * job already ran in this interval, cluster-wide" and an instance whose
 * timer fires a few seconds later skips instead of running it again.
 *
 * Clocks: lease times come from each instance's own clock. Keep hosts on
 * NTP — a skew of a few seconds only shortens/lengthens a lease slightly
 * and never lets two instances hold it at once by more than the skew.
 *
 * Tests inject a fake model via createJobLock({ model, now, owner }).
 */
const os = require('os');
const crypto = require('crypto');

// Unique per process: host + pid + random suffix (pids repeat across
// containers, hostnames repeat across restarts of the same pod).
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

function isDuplicateKeyError(err) {
    return !!err && (err.code === 11000 || err.code === 11001 || /E11000/.test(String(err.message || '')));
}

/**
 * @param {object}   [opts]
 * @param {object}   [opts.model]       Mongoose-like model (findOneAndUpdate / updateOne).
 * @param {function} [opts.isConnected] () => boolean; acquire short-circuits to false when it returns false.
 * @param {function} [opts.now]         () => epoch ms.
 * @param {string}   [opts.owner]       lock owner id (defaults to INSTANCE_ID).
 */
function createJobLock(opts = {}) {
    const owner = opts.owner || INSTANCE_ID;
    const now = opts.now || Date.now;
    const getModel = () => opts.model || require('../models/jobLock');
    const isConnected = opts.isConnected || (() => {
        if (opts.model) return true;
        // readyState 1 = connected. Skip the tick instead of letting
        // mongoose buffer the command for 10s during boot / a failover.
        return require('mongoose').connection.readyState === 1;
    });

    async function acquire(name, leaseMs) {
        if (!name) throw new Error('jobLock.acquire: name is required');
        if (!(leaseMs > 0)) throw new Error('jobLock.acquire: leaseMs must be > 0');
        if (!isConnected()) return false;

        const t = now();
        try {
            const doc = await getModel().findOneAndUpdate(
                { name, lockedUntil: { $lte: new Date(t) } },
                {
                    $set: {
                        owner,
                        lockedUntil: new Date(t + leaseMs),
                        lockedAt: new Date(t),
                        lastRunAt: new Date(t),
                    },
                },
                { upsert: true, returnDocument: 'after', lean: true },
            );
            return !!doc && doc.owner === owner;
        } catch (err) {
            // Lease held by someone else: the filter matched nothing, so
            // the upsert tried to insert a second doc with the same name.
            if (isDuplicateKeyError(err)) return false;
            throw err;
        }
    }

    async function extend(name, leaseMs) {
        const res = await getModel().updateOne(
            { name, owner },
            { $set: { lockedUntil: new Date(now() + leaseMs) } },
        );
        return (res?.matchedCount ?? res?.n ?? 0) > 0;
    }

    async function release(name) {
        const res = await getModel().updateOne(
            { name, owner },
            { $set: { lockedUntil: new Date(now()) } },
        );
        return (res?.matchedCount ?? res?.n ?? 0) > 0;
    }

    async function markFinished(name, err) {
        await getModel().updateOne(
            { name, owner },
            { $set: { lastFinishedAt: new Date(now()), lastError: err ? String(err.message || err).slice(0, 500) : null } },
        );
    }

    return { owner, acquire, extend, release, markFinished };
}

const defaultLock = createJobLock();

module.exports = {
    INSTANCE_ID,
    createJobLock,
    isDuplicateKeyError,
    acquire: defaultLock.acquire,
    extend: defaultLock.extend,
    release: defaultLock.release,
    markFinished: defaultLock.markFinished,
    defaultLock,
};
