/**
 * Per-account login lockout (LOGIN_THROTTLING_PROPOSAL.md, part a).
 *
 * The per-IP limiter cannot tell a brute-forcer from a restaurant whose
 * 25 staff share one NAT address. This module counts FAILED password
 * checks per ACCOUNT instead:
 *
 *   - `LOGIN_LOCK_MAX_FAILS` (default 10) failures inside a
 *     `LOGIN_LOCK_MINUTES` (default 15) window lock the account for
 *     `LOGIN_LOCK_MINUTES`. The lock auto-expires (TTL index on the
 *     row) — there is no permanent lockout and nothing to "fix" in the
 *     database.
 *   - A successful login deletes the row (counter reset).
 *   - Super admins are never locked; the caller logs a warning instead.
 *   - Only failures count: a correct password never consumes budget.
 *
 * State lives in MongoDB (`login_attempts`, models/loginAttempt.js) so
 * every backend instance enforces the same count.
 *
 *   const loginAttempts = require('../utils/loginAttempts');
 *   const key = loginAttempts.accountKey({ user, email });
 *   const lock = await loginAttempts.getLock(key);          // { locked, lockedUntil, retryAfterSec }
 *   const r = await loginAttempts.recordFailure(key, { ip, exempt }); // { fails, lockedUntil, justLocked }
 *   await loginAttempts.clear(key);                          // on success / admin unlock
 *
 * `createLoginAttempts({ model, now })` builds an instance over any
 * collection-like object (findOneAndUpdate / updateOne / findOne /
 * deleteOne) — the unit tests use an in-memory fake, the app uses the
 * Mongoose model.
 */
'use strict';

const MINUTE = 60 * 1000;

function envInt(name, def, min = 1) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min ? n : def;
}

/** Failures that trigger the lock (LOGIN_LOCK_MAX_FAILS, default 10). */
const maxFails = () => envInt('LOGIN_LOCK_MAX_FAILS', 10);
/** Counting window AND lock duration in ms (LOGIN_LOCK_MINUTES, default 15). */
const lockMs = () => envInt('LOGIN_LOCK_MINUTES', 15) * MINUTE;

const normEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * The counter key for a resolved account.
 *   staff      → `<restaurantId>:<email>`
 *   customer   → `customer:<email>`
 *   superadmin → `superadmin:<email>`
 * `email` defaults to the user's stored email.
 */
function accountKey({ user, email, restaurantId } = {}) {
    const e = normEmail(email || user?.email);
    const role = user?.role;
    if (role === 'superadmin') return `superadmin:${e}`;
    if (role === 'customer' || (!role && !restaurantId && !user?.restaurant)) return `customer:${e}`;
    const rid = restaurantId || user?.restaurant;
    return `${String(rid)}:${e}`;
}

/** Super admins are counted and warned about, never locked. */
const isExempt = (user) => user?.role === 'superadmin';

/** `abc@example.com` → `a***@example.com`; keys keep their prefix. */
function maskKey(key) {
    const s = String(key || '');
    const i = s.lastIndexOf(':');
    const prefix = i >= 0 ? s.slice(0, i + 1) : '';
    const email = i >= 0 ? s.slice(i + 1) : s;
    const at = email.indexOf('@');
    if (at <= 0) return prefix + (email ? email[0] + '***' : '');
    return `${prefix}${email[0]}***${email.slice(at)}`;
}

function createLoginAttempts({ model, now = () => Date.now() } = {}) {
    if (!model) throw new Error('createLoginAttempts: model is required');
    const t = () => new Date(now());

    /** Current lock state: `{ locked, lockedUntil, retryAfterSec, fails }`. */
    async function getLock(key) {
        const doc = await model.findOne({ _id: key });
        const n = t().getTime();
        const until = doc?.lockedUntil ? new Date(doc.lockedUntil).getTime() : 0;
        if (!doc || until <= n) return { locked: false, lockedUntil: null, retryAfterSec: 0, fails: doc?.fails || 0 };
        return {
            locked: true,
            lockedUntil: new Date(until),
            retryAfterSec: Math.max(1, Math.ceil((until - n) / 1000)),
            fails: doc.fails || 0,
        };
    }

    /**
     * Count one failed password check. Returns `{ fails, lockedUntil,
     * justLocked, exempt }`; `justLocked` is true for exactly one caller
     * per lock (log the warning there). With `exempt: true` the count is
     * kept but `lockedUntil` is never set.
     */
    async function recordFailure(key, { ip = '', exempt = false } = {}) {
        const nowD = t();
        const windowStart = new Date(nowD.getTime() - lockMs());
        const bump = {
            $inc: { fails: 1 },
            $set: { lastFailAt: nowD, lastIp: String(ip || '') },
        };
        // 1. Inside a live window → atomic increment.
        let doc = await model.findOneAndUpdate(
            { _id: key, firstFailAt: { $gt: windowStart } },
            bump,
            { returnDocument: 'after', lean: true },
        );
        // 2. No row, or the window has lapsed → start a fresh window.
        if (!doc) {
            try {
                doc = await model.findOneAndUpdate(
                    { _id: key },
                    {
                        $set: {
                            fails: 1,
                            firstFailAt: nowD,
                            lastFailAt: nowD,
                            lockedUntil: null,
                            lastIp: String(ip || ''),
                            expiresAt: new Date(nowD.getTime() + lockMs()),
                        },
                    },
                    { upsert: true, returnDocument: 'after', lean: true },
                );
            } catch (err) {
                // Two first-failures raced on the upsert; the loser retries the increment.
                if (err?.code !== 11000) throw err;
                doc = await model.findOneAndUpdate(
                    { _id: key, firstFailAt: { $gt: windowStart } },
                    bump,
                    { returnDocument: 'after', lean: true },
                );
            }
        }
        const fails = doc?.fails || 0;
        const existingLock = doc?.lockedUntil && new Date(doc.lockedUntil).getTime() > nowD.getTime()
            ? new Date(doc.lockedUntil) : null;
        if (exempt || fails < maxFails()) {
            return { fails, lockedUntil: existingLock, justLocked: false, exempt: !!exempt };
        }
        // 3. Threshold reached → lock, once. The TTL (`expiresAt`) follows
        //    the lock so the row — and the lock — vanish on their own.
        const lockedUntil = new Date(nowD.getTime() + lockMs());
        const r = await model.updateOne(
            { _id: key, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: nowD } }] },
            { $set: { lockedUntil, expiresAt: lockedUntil } },
        );
        const justLocked = (r?.modifiedCount ?? r?.nModified ?? 0) > 0;
        return { fails, lockedUntil: justLocked ? lockedUntil : existingLock, justLocked, exempt: false };
    }

    /** Reset the counter / lock (successful login, admin unlock, password reset). */
    async function clear(key) {
        const r = await model.deleteOne({ _id: key });
        return (r?.deletedCount || 0) > 0;
    }

    return { getLock, recordFailure, clear, accountKey, isExempt, maskKey, maxFails, lockMs };
}

// Default instance over the real collection. Required lazily so the
// unit tests can load this module without a Mongo connection.
let defaultInstance = null;
function getDefault() {
    if (!defaultInstance) {
        defaultInstance = createLoginAttempts({ model: require('../models/loginAttempt') });
    }
    return defaultInstance;
}

module.exports = {
    createLoginAttempts,
    accountKey,
    isExempt,
    maskKey,
    maxFails,
    lockMs,
    getLock: (key) => getDefault().getLock(key),
    recordFailure: (key, opts) => getDefault().recordFailure(key, opts),
    clear: (key) => getDefault().clear(key),
};
