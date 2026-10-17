/**
 * migrations/applyOperationsDefaults — A10: a restaurant stored with
 * `operations: null` must be written (and counted) like a missing field;
 * the guarded write's filter must match null as well as "absent"; the
 * dry run writes nothing; counts reflect what the database changed.
 *
 * No Mongo: a tiny in-memory "model" that applies the filter semantics
 * the migration relies on ($exists / null equality inside $or).
 */
const { applyOperationsDefaults, NO_PROFILE_FILTER } = require('../migrations/applyOperationsDefaults');
const { DEFAULT_PROFILE } = require('../utils/operationsProfile');

/** Minimal matcher for { _id, $or: [{ operations: { $exists: false } }, { operations: null }] }. */
function matches(doc, filter) {
    for (const [k, v] of Object.entries(filter)) {
        if (k === '$or') {
            if (!v.some((alt) => matches(doc, alt))) return false;
        } else if (v && typeof v === 'object' && '$exists' in v) {
            const has = Object.prototype.hasOwnProperty.call(doc, k) && doc[k] !== undefined;
            if (has !== v.$exists) return false;
        } else if (v === null) {
            // Mongo: { field: null } matches null AND missing
            if (doc[k] !== null && doc[k] !== undefined) return false;
        } else if (String(doc[k]) !== String(v)) return false;
    }
    return true;
}

function fakeModel(docs) {
    const updates = [];
    return {
        docs,
        updates,
        find: () => ({ select: () => ({ lean: async () => docs.map((d) => ({ ...d })) }) }),
        updateOne: async (filter, update) => {
            updates.push({ filter, update });
            const hit = docs.find((d) => matches(d, filter));
            if (!hit) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(hit, update.$set);
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
}

const silent = () => {};

describe('applyOperationsDefaults — null / missing / set', () => {
    const seed = () => [
        { _id: 'a', name: 'missing' },                                  // no field at all
        { _id: 'b', name: 'null', operations: null },                   // explicit null (A10)
        { _id: 'c', name: 'set', operations: { preset: 'hotelPayFirstSelfOrder', modules: { waiter: false } } },
    ];

    test('NO_PROFILE_FILTER matches a missing field and an explicit null, not a profile', () => {
        expect(matches({ _id: 'a' }, NO_PROFILE_FILTER)).toBe(true);
        expect(matches({ _id: 'b', operations: null }, NO_PROFILE_FILTER)).toBe(true);
        expect(matches({ _id: 'c', operations: { preset: 'custom' } }, NO_PROFILE_FILTER)).toBe(false);
        // the old filter alone would have skipped the null row
        expect(matches({ _id: 'b', operations: null }, { operations: { $exists: false } })).toBe(false);
    });

    test('dry run: counts both candidates, writes nothing', async () => {
        const M = fakeModel(seed());
        const report = await applyOperationsDefaults({ Restaurant: M }, { dryRun: true, log: silent });
        expect(report).toEqual({ scanned: 3, alreadySet: 1, written: 2, raced: 0 });
        expect(M.updates).toHaveLength(0);
        expect(M.docs[1].operations).toBeNull();
    });

    test('real run: the null row IS written and counted; the set profile is untouched', async () => {
        const M = fakeModel(seed());
        const report = await applyOperationsDefaults({ Restaurant: M }, { log: silent });
        expect(report).toEqual({ scanned: 3, alreadySet: 1, written: 2, raced: 0 });
        expect(M.updates).toHaveLength(2);
        for (const u of M.updates) expect(u.filter).toMatchObject(NO_PROFILE_FILTER);
        expect(M.docs[0].operations).toMatchObject({ preset: DEFAULT_PROFILE.preset, modules: DEFAULT_PROFILE.modules });
        expect(M.docs[1].operations).toMatchObject({ preset: DEFAULT_PROFILE.preset, modules: DEFAULT_PROFILE.modules });
        expect(M.docs[1].operations.updatedAt).toBeInstanceOf(Date);
        expect(M.docs[2].operations.preset).toBe('hotelPayFirstSelfOrder');

        // re-run → nothing to do
        const again = await applyOperationsDefaults({ Restaurant: M }, { log: silent });
        expect(again).toEqual({ scanned: 3, alreadySet: 3, written: 0, raced: 0 });
    });

    test('a profile saved between the read and the guarded write is not clobbered and not counted as written', async () => {
        const M = fakeModel(seed());
        const realUpdate = M.updateOne;
        M.updateOne = async (filter, update) => {
            // Super Admin saves a profile on "b" just before the migration writes it
            const b = M.docs.find((d) => d._id === 'b');
            if (b.operations === null) b.operations = { preset: 'custom', modules: {} };
            return realUpdate(filter, update);
        };
        const report = await applyOperationsDefaults({ Restaurant: M }, { log: silent });
        expect(report).toEqual({ scanned: 3, alreadySet: 1, written: 1, raced: 1 });
        expect(M.docs[1].operations.preset).toBe('custom');
    });
});
