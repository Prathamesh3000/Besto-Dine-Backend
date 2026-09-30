/**
 * #35 — MongoDB lease semantics for utils/jobLock.js.
 * The model is an in-memory fake that mimics findOneAndUpdate+upsert on a
 * collection with a unique index on `name` (E11000 when the filter misses
 * but the name already exists).
 */
const { createJobLock, isDuplicateKeyError } = require('../utils/jobLock');

function makeFakeModel() {
    const docs = new Map(); // name → doc
    const matches = (doc, filter) => {
        if (filter.name !== undefined && doc.name !== filter.name) return false;
        if (filter.owner !== undefined && doc.owner !== filter.owner) return false;
        if (filter.lockedUntil && filter.lockedUntil.$lte !== undefined) {
            if (!(doc.lockedUntil.getTime() <= filter.lockedUntil.$lte.getTime())) return false;
        }
        return true;
    };
    return {
        docs,
        async findOneAndUpdate(filter, update, opts) {
            const existing = docs.get(filter.name);
            if (existing && matches(existing, filter)) {
                Object.assign(existing, update.$set);
                return { ...existing };
            }
            if (!opts.upsert) return null;
            if (existing) {
                const err = new Error('E11000 duplicate key error collection: joblocks index: name_1');
                err.code = 11000;
                throw err;
            }
            const doc = { name: filter.name, ...update.$set };
            docs.set(filter.name, doc);
            return { ...doc };
        },
        async updateOne(filter, update) {
            const existing = docs.get(filter.name);
            if (!existing || !matches(existing, filter)) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(existing, update.$set);
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
}

describe('jobLock acquire semantics', () => {
    let model;
    let clock;
    let a;
    let b;
    beforeEach(() => {
        model = makeFakeModel();
        clock = 1_000_000;
        const now = () => clock;
        a = createJobLock({ model, now, owner: 'A' });
        b = createJobLock({ model, now, owner: 'B' });
    });

    test('first acquire creates the lock (upsert) and wins', async () => {
        await expect(a.acquire('job', 60_000)).resolves.toBe(true);
        const doc = model.docs.get('job');
        expect(doc.owner).toBe('A');
        expect(doc.lockedUntil.getTime()).toBe(clock + 60_000);
    });

    test('a second instance cannot acquire while the lease is live (E11000 → false)', async () => {
        await a.acquire('job', 60_000);
        clock += 30_000;
        await expect(b.acquire('job', 60_000)).resolves.toBe(false);
        expect(model.docs.get('job').owner).toBe('A');
    });

    test('the holder itself does not re-acquire within its lease (once per window)', async () => {
        await a.acquire('job', 60_000);
        clock += 1_000;
        await expect(a.acquire('job', 60_000)).resolves.toBe(false);
    });

    test('after the lease expires another instance takes over', async () => {
        await a.acquire('job', 60_000);
        clock += 60_000; // lockedUntil <= now
        await expect(b.acquire('job', 60_000)).resolves.toBe(true);
        expect(model.docs.get('job').owner).toBe('B');
        await expect(a.acquire('job', 60_000)).resolves.toBe(false);
    });

    test('concurrent acquires: exactly one wins', async () => {
        const results = await Promise.all([a.acquire('job', 10_000), b.acquire('job', 10_000)]);
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('different job names are independent', async () => {
        await expect(a.acquire('job-1', 60_000)).resolves.toBe(true);
        await expect(b.acquire('job-2', 60_000)).resolves.toBe(true);
    });

    test('extend only works for the owner and pushes lockedUntil forward', async () => {
        await a.acquire('job', 10_000);
        clock += 8_000;
        await expect(b.extend('job', 10_000)).resolves.toBe(false);
        await expect(a.extend('job', 10_000)).resolves.toBe(true);
        expect(model.docs.get('job').lockedUntil.getTime()).toBe(clock + 10_000);
        clock += 5_000; // would have expired without the extend
        await expect(b.acquire('job', 10_000)).resolves.toBe(false);
    });

    test('release by the owner lets others acquire immediately; non-owner release is a no-op', async () => {
        await a.acquire('job', 60_000);
        await expect(b.release('job')).resolves.toBe(false);
        await expect(b.acquire('job', 60_000)).resolves.toBe(false);
        await expect(a.release('job')).resolves.toBe(true);
        await expect(b.acquire('job', 60_000)).resolves.toBe(true);
    });

    test('returns false (does not throw) when the DB is not connected', async () => {
        const lock = createJobLock({ model, owner: 'C', isConnected: () => false });
        await expect(lock.acquire('job', 60_000)).resolves.toBe(false);
        expect(model.docs.size).toBe(0);
    });

    test('non-duplicate DB errors propagate', async () => {
        const broken = { findOneAndUpdate: async () => { throw new Error('network'); } };
        const lock = createJobLock({ model: broken, owner: 'D' });
        await expect(lock.acquire('job', 1000)).rejects.toThrow('network');
    });

    test('validates arguments', async () => {
        await expect(a.acquire('', 1000)).rejects.toThrow();
        await expect(a.acquire('job', 0)).rejects.toThrow();
    });

    test('isDuplicateKeyError', () => {
        expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
        expect(isDuplicateKeyError({ message: 'E11000 duplicate key' })).toBe(true);
        expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
        expect(isDuplicateKeyError(null)).toBe(false);
    });
});
