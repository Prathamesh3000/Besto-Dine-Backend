/**
 * STRICT tenant campaign / infra: tenantScopePlugin edge cases against a real
 * (in-memory) Mongo. Everything runs inside runAsTenant(A) and asserts tenant
 * B's data is neither visible nor changed.
 *
 * Tests named "Regression (fixed 2026-11)" were "BUG:" tests: each documented a way
 * tenant A's context could touch tenant B's rows; the plugin now blocks them.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));
const { runAsTenant, runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { getContext } = require(path.join(BACKEND, 'utils/requestContext'));
const { skipScope } = require(path.join(BACKEND, 'utils/tenantScopePlugin'));

useIntegrationApp();

let A; let B; let aIds; let bIds;
const oid = (t) => t.restaurant._id;
const inA = (fn) => runAsTenant(oid(A), fn);
const rawB = () => runAsSystem('verify B', () => Table.find({ restaurant: oid(B) }).lean());
const rawA = () => runAsSystem('verify A', () => Table.find({ restaurant: oid(A) }).lean());
const sameTenantA = (docs) => docs.every((d) => String(d.restaurant) === String(oid(A)));

beforeEach(async () => {
    A = await seedTenant({ label: 'pa' });
    B = await seedTenant({ label: 'pb' });
    await createTable(A, { name: 'A-extra' });
    await createTable(B, { name: 'B-extra' });
    aIds = (await rawA()).map((t) => String(t._id));
    bIds = (await rawB()).map((t) => String(t._id));
});

const ids = (docs) => docs.map((d) => String(d._id)).sort();

describe('plain filters are scoped to the context tenant', () => {
    test('find / lean / session / findOne / findById / count / distinct', async () => {
        await inA(async () => {
            expect(ids(await Table.find({}))).toEqual([...aIds].sort());
            expect(ids(await Table.find({}).lean())).toEqual([...aIds].sort());
            const s = await mongoose.startSession();
            try { expect(ids(await Table.find({}).session(s).lean())).toEqual([...aIds].sort()); } finally { await s.endSession(); }
            expect(await Table.findOne({ _id: bIds[0] })).toBeNull();
            expect(await Table.findById(bIds[0])).toBeNull();
            expect(await Table.countDocuments({})).toBe(aIds.length);
            expect(await Table.countDocuments({ _id: { $in: bIds } })).toBe(0);
            const names = await Table.distinct('name');
            expect(names.some((n) => /-pb|^B-/.test(n))).toBe(false);
        });
    });

    test('findOneAndUpdate / updateOne / updateMany / findOneAndDelete / deleteOne / replaceOne on B ids change nothing', async () => {
        const before = JSON.stringify(await rawB());
        await inA(async () => {
            expect(await Table.findOneAndUpdate({ _id: bIds[0] }, { $set: { name: 'HACK' } })).toBeNull();
            expect((await Table.updateOne({ _id: bIds[0] }, { $set: { name: 'HACK' } })).matchedCount).toBe(0);
            expect((await Table.updateMany({ _id: { $in: bIds } }, { $set: { name: 'HACK' } })).matchedCount).toBe(0);
            expect(await Table.findOneAndDelete({ _id: bIds[0] })).toBeNull();
            expect((await Table.deleteOne({ _id: bIds[1] })).deletedCount).toBe(0);
            expect((await Table.replaceOne({ _id: bIds[1] }, { name: 'x' })).matchedCount).toBe(0);
        });
        expect(JSON.stringify(await rawB())).toBe(before);
    });

    test('unfiltered updateMany / deleteMany only touch A', async () => {
        const before = JSON.stringify(await rawB());
        await inA(async () => {
            expect((await Table.updateMany({}, { $set: { capacity: 9 } })).matchedCount).toBe(aIds.length);
            expect((await Table.deleteMany({})).deletedCount).toBe(aIds.length);
        });
        expect(JSON.stringify(await rawB())).toBe(before);
    });

    test('upsert whose filter matches only a B row never modifies that B row', async () => {
        const target = (await rawB())[0];
        await inA(async () => {
            await Table.updateOne({ _id: target._id }, { $set: { name: 'UPS' } }, { upsert: true }).catch(() => {});
        });
        const after = (await rawB()).find((t) => String(t._id) === String(target._id));
        expect(after.name).toBe(target.name);
    });

    test('aggregate: leading $match injected; $group / $facet see only A', async () => {
        await inA(async () => {
            const r = await Table.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
            expect(r[0].n).toBe(aIds.length);
            const f = await Table.aggregate([{ $facet: { all: [{ $count: 'n' }], some: [{ $match: { capacity: { $gte: 0 } } }, { $count: 'n' }] } }]);
            expect(f[0].all[0].n).toBe(aIds.length);
            expect(f[0].some[0].n).toBe(aIds.length);
        });
    });

    test('populate of a ref that points into B yields null under A', async () => {
        const t = await runAsSystem('seed', () => Table.create({
            restaurant: oid(A), branch: A.branch._id, area: B.area._id, name: 'A-with-B-area', capacity: 2, qrToken: `x-${Date.now()}`,
        }));
        await inA(async () => {
            const got = await Table.findById(t._id).populate('area');
            expect(got.area).toBeNull();
            const lean = await Table.findById(t._id).populate('area').lean();
            expect(lean.area).toBeNull();
        });
    });

    test('$or / $nor with a branch lacking restaurant stay confined to A', async () => {
        await inA(async () => {
            expect(sameTenantA(await Table.find({ $or: [{ restaurant: oid(B) }, { name: /./ }] }).lean())).toBe(true);
            expect(sameTenantA(await Table.find({ $nor: [{ capacity: 9999 }] }).lean())).toBe(true);
            expect(await Table.find({ $or: [{ _id: bIds[0] }, { _id: bIds[1] }] }).lean()).toHaveLength(0);
        });
    });

    test('async hops (timers, setImmediate, nextTick, Promise.all) keep the tenant', async () => {
        await inA(async () => {
            const viaTimer = await new Promise((res) => setTimeout(() => Table.find({}).lean().then(res), 5));
            const viaImm = await new Promise((res) => setImmediate(() => Table.find({}).lean().then(res)));
            const viaTick = await new Promise((res) => process.nextTick(() => Table.find({}).lean().then(res)));
            const [x, y] = await Promise.all([Table.find({}).lean(), Table.countDocuments({})]);
            for (const set of [viaTimer, viaImm, viaTick, x]) expect(ids(set)).toEqual([...aIds].sort());
            expect(y).toBe(aIds.length);
        });
    });

    test('a transaction callback keeps the tenant context', async () => {
        await inA(async () => {
            const s = await mongoose.startSession();
            try {
                await s.withTransaction(async () => {
                    const r = await Table.find({}).session(s).lean();
                    expect(ids(r)).toEqual([...aIds].sort());
                    expect(String(getContext().tenantId)).toBe(String(oid(A)));
                });
            } finally { await s.endSession(); }
        });
    });

    test('EventEmitter hop never yields a mix of tenants', async () => {
        const EE = require('events');
        const ee = new EE();
        let seen = [];
        await inA(async () => { ee.on('x', async () => { seen = await Table.find({}).lean(); }); });
        await runAsTenant(oid(B), async () => { ee.emit('x'); await new Promise((r) => setTimeout(r, 80)); });
        expect(new Set(seen.map((d) => String(d.restaurant))).size).toBeLessThanOrEqual(1);
    });
});

describe('explicit restaurant filters (ANDed with the context tenant)', () => {
    // Fixed 2026-11: hasTenantCondition() used to treat ANY `restaurant` key as "already
    // scoped", so a filter naming another tenant, or an operator, passed through. The
    // plugin now always ANDs the context tenant unless the filter is exactly that tenant.
    test('Regression (fixed 2026-11): restaurant: <B> inside A context must not return B rows (plugin only warns)', async () => {
        await inA(async () => { expect(await Table.find({ restaurant: oid(B) }).lean()).toHaveLength(0); });
    });
    test('Regression (fixed 2026-11): restaurant: {$ne: A} inside A context must not return B rows', async () => {
        await inA(async () => { expect(await Table.find({ restaurant: { $ne: oid(A) } }).lean()).toHaveLength(0); });
    });
    test('Regression (fixed 2026-11): restaurant: {$in:[A,B]} must not return B rows', async () => {
        await inA(async () => { expect(sameTenantA(await Table.find({ restaurant: { $in: [oid(A), oid(B)] } }).lean())).toBe(true); });
    });
    test('Regression (fixed 2026-11): restaurant: {$exists:true} must not return B rows', async () => {
        await inA(async () => { expect(sameTenantA(await Table.find({ restaurant: { $exists: true } }).lean())).toBe(true); });
    });
    test('Regression (fixed 2026-11): $and:[{restaurant:{$ne:A}}] must not return B rows', async () => {
        await inA(async () => { expect(await Table.find({ $and: [{ restaurant: { $ne: oid(A) } }] }).lean()).toHaveLength(0); });
    });
    test('Regression (fixed 2026-11): $or where every branch names B must not return B rows', async () => {
        await inA(async () => { expect(await Table.find({ $or: [{ restaurant: oid(B) }, { restaurant: oid(B) }] }).lean()).toHaveLength(0); });
    });
    test('Regression (fixed 2026-11): updateMany({restaurant:B}) from A context must not modify B', async () => {
        await inA(async () => { await Table.updateMany({ restaurant: oid(B) }, { $set: { capacity: 77 } }); });
        expect((await rawB()).some((t) => t.capacity === 77)).toBe(false);
    });
    test('Regression (fixed 2026-11): deleteMany({restaurant:B}) from A context must not delete B', async () => {
        const n = (await rawB()).length;
        await inA(async () => { await Table.deleteMany({ restaurant: oid(B) }); });
        expect(await rawB()).toHaveLength(n);
    });
    test('Regression (fixed 2026-11): aggregate with explicit $match restaurant:B from A context must not return B rows', async () => {
        await inA(async () => { expect(await Table.aggregate([{ $match: { restaurant: oid(B) } }])).toHaveLength(0); });
    });
});

describe('writes that carry a foreign restaurant', () => {
    test('Regression (fixed 2026-11): insertMany([{restaurant:B}]) in A context must not create a B row (default mode only warns)', async () => {
        const before = (await rawB()).length;
        await inA(async () => {
            await Table.insertMany([{ restaurant: oid(B), branch: B.branch._id, area: B.area._id, name: 'planted', capacity: 1, qrToken: `p-${Date.now()}` }]).catch(() => {});
        });
        expect(await rawB()).toHaveLength(before);
    });
    test('Regression (fixed 2026-11): bulkWrite insertOne with restaurant B in A context must not create a B row', async () => {
        const before = (await rawB()).length;
        await inA(async () => {
            await Table.bulkWrite([{ insertOne: { document: { restaurant: oid(B), branch: B.branch._id, area: B.area._id, name: 'planted2', capacity: 1, qrToken: `q-${Date.now()}` } } }]).catch(() => {});
        });
        expect(await rawB()).toHaveLength(before);
    });
    test('Regression (fixed 2026-11): bulkWrite updateMany filter restaurant:B in A context must not modify B', async () => {
        await inA(async () => {
            await Table.bulkWrite([{ updateMany: { filter: { restaurant: oid(B) }, update: { $set: { capacity: 55 } } } }]).catch(() => {});
        });
        expect((await rawB()).some((t) => t.capacity === 55)).toBe(false);
    });
    test('bulkWrite with filters lacking restaurant is confined to A', async () => {
        const before = JSON.stringify(await rawB());
        await inA(async () => {
            await Table.bulkWrite([
                { updateMany: { filter: { capacity: { $gte: 0 } }, update: { $set: { capacity: 12 } } } },
                { deleteMany: { filter: { name: /./ } } },
            ]);
        });
        expect(JSON.stringify(await rawB())).toBe(before);
    });
    test('insertMany without restaurant is stamped with the context tenant', async () => {
        await inA(async () => {
            const [d] = await Table.insertMany([{ branch: A.branch._id, area: A.area._id, name: 'stamped', capacity: 1, qrToken: `s-${Date.now()}` }]);
            expect(String(d.restaurant)).toBe(String(oid(A)));
        });
    });
    test('Regression (fixed 2026-11): Model.create({restaurant:B}) in A context must not write into B', async () => {
        const before = (await rawB()).length;
        await inA(async () => {
            await Table.create({ restaurant: oid(B), branch: B.branch._id, area: B.area._id, name: 'created', capacity: 1, qrToken: `c-${Date.now()}` }).catch(() => {});
        });
        expect(await rawB()).toHaveLength(before);
    });
    test('Regression (fixed 2026-11): doc loaded in A, restaurant re-assigned to B and save()d must not move into B', async () => {
        const doc = await inA(async () => Table.findOne({}));
        await inA(async () => { doc.restaurant = oid(B); await doc.save().catch(() => {}); });
        const moved = await runAsSystem('verify', () => Table.findById(doc._id).lean());
        expect(String(moved.restaurant)).toBe(String(oid(A)));
    });
});

describe('$lookup / $unionWith (rewritten by the plugin for tenant-owned collections)', () => {
    test('Regression (fixed 2026-11): $lookup into the same collection returns B rows in the joined array', async () => {
        await inA(async () => {
            const r = await Table.aggregate([{ $limit: 1 }, { $lookup: { from: 'tables', pipeline: [], as: 'all' } }]);
            expect(sameTenantA(r[0].all)).toBe(true);
        });
    });
    test('Regression (fixed 2026-11): $lookup inside $facet returns B rows', async () => {
        await inA(async () => {
            const r = await Table.aggregate([{ $facet: { x: [{ $limit: 1 }, { $lookup: { from: 'tables', pipeline: [], as: 'all' } }] } }]);
            expect(sameTenantA(r[0].x[0].all)).toBe(true);
        });
    });
    test('Regression (fixed 2026-11): $unionWith returns B rows', async () => {
        await inA(async () => { expect(sameTenantA(await Table.aggregate([{ $unionWith: { coll: 'tables' } }]))).toBe(true); });
    });
});

describe('skipTenantScope option and system context', () => {
    test('skipScope() deliberately escapes (sanity)', async () => {
        await inA(async () => {
            const r = await skipScope(Table.find({ _id: { $in: [...aIds, ...bIds] } }).lean());
            expect(r.length).toBe(aIds.length + bIds.length);
        });
    });
    test('Regression (fixed 2026-11): user-controlled query options must not be able to disable scoping (options.skipTenantScope is trusted blindly)', async () => {
        // A controller doing Model.find(filter, null, req.body.options) used to let a
        // tenant caller switch scoping off; the option is now stripped and ignored.
        await inA(async () => {
            const userOptions = JSON.parse('{"skipTenantScope":true}');
            expect(sameTenantA(await Table.find({}, null, userOptions).lean())).toBe(true);
        });
    });
    test('runAsSystem inside a tenant context drops the tenant; back in A scoping resumes', async () => {
        await inA(async () => {
            const sys = await runAsSystem('x', async () => Table.find({ _id: { $in: [...aIds, ...bIds] } }).lean());
            expect(sys.length).toBe(aIds.length + bIds.length);
            expect((await Table.find({ _id: { $in: [...aIds, ...bIds] } }).lean()).length).toBe(aIds.length);
        });
    });
});
