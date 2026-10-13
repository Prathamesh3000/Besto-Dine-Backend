/**
 * utils/loginAttempts.js — per-account login lockout semantics.
 *
 * The model is an in-memory fake that mimics the four collection calls the
 * module makes (findOneAndUpdate with `_id` + `firstFailAt: {$gt}` filters
 * and upsert, updateOne with the `$or lockedUntil` filter, findOne,
 * deleteOne). The real collection path is exercised end-to-end by
 * __tests__/integration/loginLockout.test.js.
 */
const { createLoginAttempts, accountKey, isExempt, maskKey, maxFails, lockMs } = require('../utils/loginAttempts');

const MIN = 60 * 1000;

function makeFakeModel() {
    const docs = new Map(); // _id → doc
    const matches = (doc, filter) => {
        if (!doc) return false;
        if (filter._id !== undefined && doc._id !== filter._id) return false;
        if (filter.firstFailAt?.$gt !== undefined) {
            if (!(doc.firstFailAt && doc.firstFailAt.getTime() > filter.firstFailAt.$gt.getTime())) return false;
        }
        if (filter.$or) {
            const ok = filter.$or.some((alt) => {
                if (alt.lockedUntil === null) return doc.lockedUntil == null;
                if (alt.lockedUntil?.$lte) return doc.lockedUntil != null && doc.lockedUntil.getTime() <= alt.lockedUntil.$lte.getTime();
                return false;
            });
            if (!ok) return false;
        }
        return true;
    };
    const apply = (doc, update) => {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    };
    return {
        docs,
        calls: [],
        async findOne(filter) {
            this.calls.push('findOne');
            const d = docs.get(filter._id);
            return d ? { ...d } : null;
        },
        async findOneAndUpdate(filter, update, opts = {}) {
            this.calls.push('findOneAndUpdate');
            const existing = docs.get(filter._id);
            if (existing && matches(existing, filter)) {
                apply(existing, update);
                return { ...existing };
            }
            if (!opts.upsert) return null;
            if (existing) {
                const err = new Error('E11000 duplicate key error collection: login_attempts');
                err.code = 11000;
                throw err;
            }
            const doc = { _id: filter._id };
            apply(doc, update);
            docs.set(filter._id, doc);
            return { ...doc };
        },
        async updateOne(filter, update) {
            this.calls.push('updateOne');
            const existing = docs.get(filter._id);
            if (!existing || !matches(existing, filter)) return { matchedCount: 0, modifiedCount: 0 };
            apply(existing, update);
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(filter) {
            this.calls.push('deleteOne');
            const had = docs.delete(filter._id);
            return { deletedCount: had ? 1 : 0 };
        },
    };
}

const KEY = '65f000000000000000000001:waiter@cafe.test';

describe('defaults', () => {
    test('10 fails, 15-minute window / lock; env overrides; garbage falls back', () => {
        expect(maxFails()).toBe(10);
        expect(lockMs()).toBe(15 * MIN);
        process.env.LOGIN_LOCK_MAX_FAILS = '3';
        process.env.LOGIN_LOCK_MINUTES = '2';
        expect(maxFails()).toBe(3);
        expect(lockMs()).toBe(2 * MIN);
        process.env.LOGIN_LOCK_MAX_FAILS = 'ten';
        process.env.LOGIN_LOCK_MINUTES = '0';
        expect(maxFails()).toBe(10);
        expect(lockMs()).toBe(15 * MIN);
        delete process.env.LOGIN_LOCK_MAX_FAILS;
        delete process.env.LOGIN_LOCK_MINUTES;
    });
});

describe('accountKey / isExempt / maskKey', () => {
    test('staff → restaurantId:email, lowercased + trimmed', () => {
        const user = { role: 'waiter', restaurant: '65f000000000000000000001', email: 'Waiter@Cafe.Test' };
        expect(accountKey({ user, email: '  Waiter@Cafe.Test ' })).toBe(KEY);
        expect(accountKey({ user })).toBe(KEY);
        // the same email at another tenant is a different account
        expect(accountKey({ user: { ...user, restaurant: '65f000000000000000000002' } })).not.toBe(KEY);
    });
    test('customer / superadmin keys are global', () => {
        expect(accountKey({ user: { role: 'customer', email: 'Diner@X.test' } })).toBe('customer:diner@x.test');
        expect(accountKey({ user: { role: 'superadmin', email: 'root@bestodine.test' } })).toBe('superadmin:root@bestodine.test');
        // a superadmin with a stray restaurant field is still global
        expect(accountKey({ user: { role: 'superadmin', email: 'r@x.test', restaurant: 'abc' } })).toBe('superadmin:r@x.test');
    });
    test('only superadmin is exempt', () => {
        expect(isExempt({ role: 'superadmin' })).toBe(true);
        for (const role of ['admin', 'manager', 'waiter', 'captain', 'chef', 'customer']) expect(isExempt({ role })).toBe(false);
        expect(isExempt(null)).toBe(false);
    });
    test('maskKey hides the local part of the email, keeps the scope prefix', () => {
        expect(maskKey(KEY)).toBe('65f000000000000000000001:w***@cafe.test');
        expect(maskKey('customer:diner@x.test')).toBe('customer:d***@x.test');
        expect(maskKey('superadmin:root@bestodine.test')).toBe('superadmin:r***@bestodine.test');
        expect(maskKey('')).toBe('');
    });
});

describe('counting and locking', () => {
    let model;
    let clock;
    let la;
    beforeEach(() => {
        model = makeFakeModel();
        clock = Date.UTC(2026, 9, 13, 9, 0, 0);
        la = createLoginAttempts({ model, now: () => clock });
    });
    const fail = (n, opts) => {
        const out = [];
        return n === 1 ? la.recordFailure(KEY, opts) : (async () => {
            for (let i = 0; i < n; i++) out.push(await la.recordFailure(KEY, opts)); // eslint-disable-line no-await-in-loop
            return out;
        })();
    };

    test('a fresh account is not locked and failures count up', async () => {
        expect(await la.getLock(KEY)).toMatchObject({ locked: false, retryAfterSec: 0, fails: 0 });
        const r1 = await fail(1, { ip: '10.0.0.9' });
        expect(r1).toMatchObject({ fails: 1, lockedUntil: null, justLocked: false });
        expect(model.docs.get(KEY).lastIp).toBe('10.0.0.9');
        const r = await fail(8);
        expect(r.map((x) => x.fails)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        expect(r.every((x) => !x.justLocked && x.lockedUntil === null)).toBe(true);
        expect(await la.getLock(KEY)).toMatchObject({ locked: false, fails: 9 });
        // the row's TTL is the end of the counting window
        expect(model.docs.get(KEY).expiresAt.getTime()).toBe(clock + 15 * MIN);
    });

    test('the 10th failure locks for 15 minutes, exactly once, and getLock reports Retry-After', async () => {
        await fail(9);
        const tenth = await fail(1, { ip: '10.0.0.9' });
        expect(tenth).toMatchObject({ fails: 10, justLocked: true });
        expect(tenth.lockedUntil.getTime()).toBe(clock + 15 * MIN);
        // TTL follows the lock so the lock cannot outlive the row
        expect(model.docs.get(KEY).expiresAt.getTime()).toBe(clock + 15 * MIN);

        clock += 5 * MIN;
        const lock = await la.getLock(KEY);
        expect(lock.locked).toBe(true);
        expect(lock.lockedUntil.getTime()).toBe(clock + 10 * MIN);
        expect(lock.retryAfterSec).toBe(600);

        // an 11th failure (e.g. a race) does not re-lock / extend
        const eleventh = await fail(1);
        expect(eleventh.justLocked).toBe(false);
        expect(eleventh.fails).toBe(11);
        expect(model.docs.get(KEY).lockedUntil.getTime()).toBe(clock + 10 * MIN);
    });

    test('the lock expires on its own; the next failure starts a fresh window', async () => {
        await fail(10);
        clock += 15 * MIN + 1;
        expect(await la.getLock(KEY)).toMatchObject({ locked: false });
        const r = await fail(1);
        expect(r).toMatchObject({ fails: 1, lockedUntil: null, justLocked: false });
        expect(model.docs.get(KEY).lockedUntil).toBeNull();
    });

    test('failures spread over more than the window never lock (window resets)', async () => {
        await fail(6);
        clock += 15 * MIN + 1;
        const r = await fail(6);
        expect(r.map((x) => x.fails)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(await la.getLock(KEY)).toMatchObject({ locked: false });
    });

    test('a successful login (clear) resets the counter; 9 + success + 9 never locks', async () => {
        await fail(9);
        expect(await la.clear(KEY)).toBe(true);
        expect(await la.clear(KEY)).toBe(false); // idempotent
        const r = await fail(9);
        expect(r[8]).toMatchObject({ fails: 9, justLocked: false, lockedUntil: null });
        expect(await la.getLock(KEY)).toMatchObject({ locked: false });
    });

    test('clear() also removes an active lock (admin unlock)', async () => {
        await fail(10);
        expect((await la.getLock(KEY)).locked).toBe(true);
        expect(await la.clear(KEY)).toBe(true);
        expect((await la.getLock(KEY)).locked).toBe(false);
    });

    test('superadmin (exempt) is counted but never locked', async () => {
        const key = 'superadmin:root@bestodine.test';
        let last;
        for (let i = 0; i < 25; i++) last = await la.recordFailure(key, { exempt: true }); // eslint-disable-line no-await-in-loop
        expect(last).toMatchObject({ fails: 25, lockedUntil: null, justLocked: false, exempt: true });
        expect(await la.getLock(key)).toMatchObject({ locked: false, fails: 25 });
        expect(model.docs.get(key).lockedUntil).toBeNull();
        expect(model.calls.filter((c) => c === 'updateOne')).toHaveLength(0);
    });

    test('env knobs change the threshold and duration', async () => {
        process.env.LOGIN_LOCK_MAX_FAILS = '3';
        process.env.LOGIN_LOCK_MINUTES = '2';
        try {
            const r = await fail(3);
            expect(r[1].justLocked).toBe(false);
            expect(r[2].justLocked).toBe(true);
            expect(r[2].lockedUntil.getTime()).toBe(clock + 2 * MIN);
            clock += 2 * MIN;
            expect((await la.getLock(KEY)).locked).toBe(false);
        } finally {
            delete process.env.LOGIN_LOCK_MAX_FAILS;
            delete process.env.LOGIN_LOCK_MINUTES;
        }
    });

    test('a duplicate-key race on the first failure is retried as an increment', async () => {
        // Simulate: the row appears between the miss and the upsert.
        const real = model.findOneAndUpdate.bind(model);
        let armed = true;
        model.findOneAndUpdate = async (filter, update, opts) => {
            if (opts?.upsert && armed) {
                armed = false;
                model.docs.set(KEY, { _id: KEY, fails: 1, firstFailAt: new Date(clock), lockedUntil: null, expiresAt: new Date(clock + 15 * MIN) });
                const err = new Error('E11000'); err.code = 11000; throw err;
            }
            return real(filter, update, opts);
        };
        const r = await la.recordFailure(KEY);
        expect(r.fails).toBe(2);
    });

    test('other DB errors propagate (the caller decides how to degrade)', async () => {
        model.findOneAndUpdate = async () => { throw new Error('boom'); };
        await expect(la.recordFailure(KEY)).rejects.toThrow('boom');
    });
});
