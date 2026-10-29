/**
 * Task 4.6 — tenant-isolation wrappers, context API, plugin write guards and
 * the raw-operation audit scanner. No database: models are fakes.
 */
const mongoose = require('mongoose');
const {
    runAsTenant, runAsSystem, isSystemContext,
    tenantBulkWrite, tenantInsertMany, tenantLookup, tenantUnionWith,
    tenantAggregate, tenantEstimatedCount,
    scopeBulkOps, scopeDocs, TenantMismatchError, TenantContextError,
} = require('../utils/tenantSafe');
const { getContext, runWithContext } = require('../utils/requestContext');
const tenantScopePlugin = require('../utils/tenantScopePlugin');
const { scanRawOps } = require('../scripts/lib/rawOpScan');

const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();

describe('tenantInsertMany', () => {
    test('stamps restaurant on docs lacking it and passes options through', async () => {
        const Model = { insertMany: jest.fn(async (d) => d) };
        const docs = [{ name: 'a' }, { name: 'b', restaurant: String(A) }];
        await tenantInsertMany(Model, docs, A, { ordered: false });
        expect(Model.insertMany).toHaveBeenCalledWith(docs, { ordered: false });
        expect(String(docs[0].restaurant)).toBe(String(A));
        expect(String(docs[1].restaurant)).toBe(String(A));
    });
    test('throws on a mismatching restaurant and never calls the model', () => {
        const Model = { insertMany: jest.fn() };
        expect(() => tenantInsertMany(Model, [{ restaurant: B }], A)).toThrow(TenantMismatchError);
        expect(Model.insertMany).not.toHaveBeenCalled();
    });
    test('throws on an invalid restaurant id', () => {
        expect(() => scopeDocs([{}], 'nope')).toThrow(TenantContextError);
    });
});

describe('tenantBulkWrite / scopeBulkOps', () => {
    test('injects restaurant into filters, insertOne docs and replacements', () => {
        const ops = scopeBulkOps([
            { updateOne: { filter: { _id: 1 }, update: { $set: { x: 1 } } } },
            { updateMany: { filter: {}, update: {} } },
            { deleteOne: { filter: { _id: 2 } } },
            { deleteMany: { filter: { restaurant: String(A), x: 1 } } },
            { replaceOne: { filter: { _id: 3 }, replacement: { y: 1 } } },
            { insertOne: { document: { z: 1 } } },
        ], A);
        expect(String(ops[0].updateOne.filter.restaurant)).toBe(String(A));
        expect(String(ops[1].updateMany.filter.restaurant)).toBe(String(A));
        expect(String(ops[2].deleteOne.filter.restaurant)).toBe(String(A));
        expect(ops[3].deleteMany.filter.x).toBe(1);
        expect(String(ops[4].replaceOne.filter.restaurant)).toBe(String(A));
        expect(String(ops[4].replaceOne.replacement.restaurant)).toBe(String(A));
        expect(String(ops[5].insertOne.document.restaurant)).toBe(String(A));
    });
    test('does not mutate the caller filters', () => {
        const filter = { _id: 1 };
        scopeBulkOps([{ updateOne: { filter, update: {} } }], A);
        expect(filter).toEqual({ _id: 1 });
    });
    test('mismatching restaurant in a filter or doc throws', () => {
        expect(() => scopeBulkOps([{ updateOne: { filter: { restaurant: B }, update: {} } }], A)).toThrow(TenantMismatchError);
        expect(() => scopeBulkOps([{ insertOne: { document: { restaurant: B } } }], A)).toThrow(TenantMismatchError);
    });
    test('operator-valued restaurant is ANDed with the tenant, not trusted', () => {
        const [op] = scopeBulkOps([{ deleteMany: { filter: { restaurant: { $in: [A, B] } } } }], A);
        expect(op.deleteMany.filter.$and[1]).toEqual({ restaurant: A });
    });
    test('unknown op kind is rejected', () => {
        expect(() => scopeBulkOps([{ weird: {} }], A)).toThrow(/unsupported/);
    });
    test('wrapper forwards scoped ops and options', async () => {
        const Model = { bulkWrite: jest.fn(async () => ({ ok: 1 })) };
        await tenantBulkWrite(Model, [{ deleteOne: { filter: { _id: 1 } } }], A, { ordered: false });
        const [ops, options] = Model.bulkWrite.mock.calls[0];
        expect(String(ops[0].deleteOne.filter.restaurant)).toBe(String(A));
        expect(options).toEqual({ ordered: false });
    });
});

describe('tenantLookup / tenantUnionWith / tenantAggregate', () => {
    test('localField/foreignField is rewritten to a tenant-matched pipeline', () => {
        const { $lookup } = tenantLookup({ from: 'tables', localField: 'table', foreignField: '_id', as: 'tableDoc' }, A);
        expect($lookup.localField).toBeUndefined();
        expect($lookup.from).toBe('tables');
        expect($lookup.as).toBe('tableDoc');
        expect($lookup.let.__tenantLookupLocal).toBe('$table');
        expect($lookup.pipeline[0]).toEqual({ $match: { restaurant: A } });
        expect(JSON.stringify($lookup.pipeline[1])).toContain('$_id');
    });
    test('pipeline form gets a leading tenant $match; existing own-tenant match is kept', () => {
        const a = tenantLookup({ from: 'orders', let: { u: '$_id' }, pipeline: [{ $match: { x: 1 } }], as: 'o' }, A).$lookup;
        expect(a.pipeline[0]).toEqual({ $match: { restaurant: A } });
        expect(a.pipeline).toHaveLength(2);
        const b = tenantLookup({ from: 'orders', pipeline: [{ $match: { restaurant: A } }], as: 'o' }, A).$lookup;
        expect(b.pipeline).toHaveLength(1);
        expect(() => tenantLookup({ from: 'orders', pipeline: [{ $match: { restaurant: B } }], as: 'o' }, A)).toThrow(TenantMismatchError);
    });
    test('$unionWith sub-pipeline is scoped', () => {
        const { $unionWith } = tenantUnionWith({ coll: 'orders_archive', pipeline: [{ $match: { s: 1 } }] }, A);
        expect($unionWith.coll).toBe('orders_archive');
        expect($unionWith.pipeline[0]).toEqual({ $match: { restaurant: A } });
    });
    test('tenantAggregate prepends / merges a tenant $match and verifies mismatches', () => {
        const Model = { aggregate: jest.fn((p) => ({ p, option: jest.fn() })) };
        tenantAggregate(Model, [{ $group: { _id: null } }], A);
        expect(Model.aggregate.mock.calls[0][0][0]).toEqual({ $match: { restaurant: A } });
        tenantAggregate(Model, [{ $match: { s: 1 } }, { $count: 'n' }], A);
        expect(Model.aggregate.mock.calls[1][0][0].$match.restaurant).toEqual(A);
        expect(() => tenantAggregate(Model, [{ $match: { restaurant: B } }], A)).toThrow(TenantMismatchError);
    });
    test('tenantEstimatedCount counts documents for the tenant', async () => {
        const Model = { countDocuments: jest.fn(async () => 3) };
        expect(await tenantEstimatedCount(Model, A)).toBe(3);
        expect(Model.countDocuments).toHaveBeenCalledWith({ restaurant: A });
    });
});

describe('runAsTenant / runAsSystem', () => {
    test('runAsTenant sets the tenant for the whole async call chain', async () => {
        const seen = await runAsTenant(String(A), async () => {
            await Promise.resolve();
            return getContext();
        });
        expect(String(seen.tenantId)).toBe(String(A));
        expect(seen.system).toBe(false);
        expect(getContext()).toBeNull();
    });
    test('runAsTenant rejects a bad id and a non-function', () => {
        expect(() => runAsTenant('bad', () => 1)).toThrow(TenantContextError);
        expect(() => runAsTenant(A)).toThrow(TypeError);
    });
    test('runAsSystem needs a reason, has no tenant, and is detectable', async () => {
        expect(() => runAsSystem('', () => 1)).toThrow(TypeError);
        const r = await runAsSystem('nightly sweep', async () => ({ ctx: getContext(), sys: isSystemContext() }));
        expect(r.ctx.tenantId).toBeNull();
        expect(r.ctx.systemReason).toBe('nightly sweep');
        expect(r.sys).toBe(true);
        expect(isSystemContext()).toBe(false);
    });
    test('runAsSystem inside a tenant request drops the tenant; runAsTenant overrides it', () => {
        runWithContext({ tenantId: A }, () => {
            expect(runAsSystem('x', () => getContext().tenantId)).toBeNull();
            expect(String(runAsTenant(B, () => getContext().tenantId))).toBe(String(B));
        });
    });
});

describe('plugin native insertMany / bulkWrite hooks', () => {
    const hooks = {};
    tenantScopePlugin({
        path: () => true,
        pre: (name, a, b) => { hooks[Array.isArray(name) ? 'query' : name] = typeof a === 'function' ? a : b; },
    });
    const self = { modelName: 'Thing' };
    const savedStrict = process.env.TENANT_STRICT_CONTEXT;
    afterEach(() => {
        if (savedStrict === undefined) delete process.env.TENANT_STRICT_CONTEXT;
        else process.env.TENANT_STRICT_CONTEXT = savedStrict;
    });

    test('hooks are registered', () => {
        expect(typeof hooks.insertMany).toBe('function');
        expect(typeof hooks.bulkWrite).toBe('function');
    });
    test('in a tenant context docs / ops are stamped in place', () => {
        const docs = [{ n: 1 }];
        const ops = [{ updateOne: { filter: { _id: 1 }, update: {} } }];
        runAsTenant(A, () => { hooks.insertMany.call(self, docs); hooks.bulkWrite.call(self, ops); });
        expect(String(docs[0].restaurant)).toBe(String(A));
        expect(String(ops[0].updateOne.filter.restaurant)).toBe(String(A));
    });
    test('mismatch is only logged by default, thrown in strict mode', () => {
        const mk = () => [{ restaurant: B }];
        expect(() => runAsTenant(A, () => hooks.insertMany.call(self, mk()))).not.toThrow();
        process.env.TENANT_STRICT_CONTEXT = 'true';
        expect(() => runAsTenant(A, () => hooks.insertMany.call(self, mk()))).toThrow(TenantMismatchError);
    });
    test('no tenant + no restaurant: warn by default, throw in strict, system always allowed', () => {
        const docs = () => [{ n: 1 }];
        expect(() => hooks.insertMany.call(self, docs())).not.toThrow();
        process.env.TENANT_STRICT_CONTEXT = 'true';
        expect(() => hooks.insertMany.call(self, docs())).toThrow(TenantContextError);
        expect(() => hooks.bulkWrite.call(self, [{ deleteOne: { filter: { _id: 1 } } }])).toThrow(TenantContextError);
        expect(() => runAsSystem('migration', () => hooks.insertMany.call(self, docs()))).not.toThrow();
        // docs that already name their tenant need no context even in strict mode
        expect(() => hooks.insertMany.call(self, [{ restaurant: A }])).not.toThrow();
    });
});

describe('audit scanner raw-operation check', () => {
    test('flags raw bulkWrite / insertMany / $lookup / $unionWith / estimatedDocumentCount', () => {
        const src = [
            'await Order.bulkWrite(ops);',
            'await Table.insertMany(rows, { ordered: false });',
            'const p = [{ $lookup: { from: "x" } }, { $unionWith: "y" }];',
            'const n = await Order.estimatedDocumentCount();',
        ].join('\n');
        const kinds = scanRawOps(src, 'controllers/fixture.js').map(f => f.kind);
        expect(kinds).toEqual(['bulkWrite', 'insertMany', '$lookup', '$unionWith', 'estimatedDocumentCount']);
        expect(scanRawOps(src, 'f.js')[0]).toMatchObject({ file: 'f.js', line: 1 });
        expect(scanRawOps(src, 'f.js')[0].hint).toMatch(/tenantBulkWrite/);
    });
    test('wrappers, AUDIT-EXEMPT and comments are not flagged', () => {
        const src = [
            'await tenantBulkWrite(Order, ops, rid);',
            'await tenantInsertMany(Table, rows, rid);',
            '// AUDIT-EXEMPT: global plans',
            'await Plan.insertMany(plans);',
            'await Plan.insertMany(more); // AUDIT-EXEMPT: global',
            '// a comment mentioning Model.insertMany( and $lookup',
            ' * jsdoc bulkWrite(',
            'const s = tenantLookup({ from: "a" }, rid);',
        ].join('\n');
        expect(scanRawOps(src, 'f.js')).toEqual([]);
    });
});
