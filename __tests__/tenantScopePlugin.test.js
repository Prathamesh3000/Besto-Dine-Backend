/**
 * BUGS_REPORT #30 — tenant-scope safety net.
 *
 * Covers (no DB — queries are built and their pre-hooks run, never executed):
 *   - pure filter / pipeline injection helpers
 *   - the Mongoose plugin under / outside a request context
 *   - opt-out via { skipTenantScope: true }
 *   - attachTenant opening the AsyncLocalStorage context
 *   - tenantFilter(req) warning (not throwing) when no tenant is resolved
 */

jest.mock('../utils/logger', () => ({
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
}));

const mockRestaurant = { findById: jest.fn(), findOne: jest.fn() };
const mockBranch = { findOne: jest.fn() };
jest.mock('../models/restaurant', () => mockRestaurant);
jest.mock('../models/branch', () => mockBranch);

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const plugin = require('../utils/tenantScopePlugin');
const { scopeFilter, scopePipeline, hasTenantCondition } = plugin;
const requestContext = require('../utils/requestContext');
const { tenantFilter } = require('../utils/tenantScope');
const { attachTenant } = require('../middlewares/tenantContext');

const T1 = new mongoose.Types.ObjectId();
const T2 = new mongoose.Types.ObjectId();

// ── Test models (compiled, never connected) ─────────────────────────
const tenantSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: String,
    status: String,
});
tenantSchema.plugin(plugin);
const Scoped = mongoose.model('TenantScopePluginTestScoped', tenantSchema);

const globalSchema = new mongoose.Schema({ name: String });
globalSchema.plugin(plugin); // no `restaurant` path → plugin must not hook
const Global = mongoose.model('TenantScopePluginTestGlobal', globalSchema);

async function runQueryPre(query) {
    await query._queryMiddleware.execPre(query.op, query, []);
    return [query]; // wrapped: a returned Query is thenable and would execute
}
async function runAggregatePre(model, agg) {
    await model.hooks.execPre('aggregate', agg, []);
    return [agg];
}
// Each call gets a unique path so the plugin's per-site log dedupe never
// hides a warning from a later test.
let _pathSeq = 0;
const inTenant = (tenantId, fn) => requestContext.runWithContext(
    { tenantId, method: 'GET', path: `/api/v1/test-${++_pathSeq}`, role: 'admin' }, fn);

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TENANT_SCOPE_PLUGIN;
});

// ─────────────────────────────────────────────────────────────────────
describe('scopeFilter (pure)', () => {
    test('injects restaurant when missing, without mutating input', () => {
        const input = { status: 'active' };
        const res = scopeFilter(input, T1);
        expect(res.action).toBe('inject');
        expect(res.filter).toEqual({ status: 'active', restaurant: T1 });
        expect(input).toEqual({ status: 'active' });
    });

    test('casts a string tenant id to ObjectId', () => {
        const res = scopeFilter({}, String(T1));
        expect(res.filter.restaurant).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(String(res.filter.restaurant)).toBe(String(T1));
    });

    test('never overrides an explicit restaurant (even another tenant)', () => {
        expect(scopeFilter({ restaurant: T2 }, T1)).toEqual({ action: 'explicit', filter: { restaurant: T2 } });
        expect(scopeFilter({ restaurant: { $in: [T1, T2] } }, T1).action).toBe('explicit');
        expect(scopeFilter({ restaurant: null }, T1).action).toBe('explicit');
    });

    test('restaurant: undefined counts as missing', () => {
        expect(scopeFilter({ restaurant: undefined, a: 1 }, T1).action).toBe('inject');
    });

    test('recognises restaurant inside $and / every $or branch', () => {
        expect(hasTenantCondition({ $and: [{ a: 1 }, { restaurant: T1 }] })).toBe(true);
        expect(hasTenantCondition({ $or: [{ restaurant: T1 }, { restaurant: T2 }] })).toBe(true);
        expect(hasTenantCondition({ $or: [{ restaurant: T1 }, { a: 1 }] })).toBe(false);
    });

    test('no tenant → noop', () => {
        expect(scopeFilter({ a: 1 }, null).action).toBe('noop');
    });
});

describe('scopePipeline (pure)', () => {
    test('merges into a leading $match without mutating the caller stage', () => {
        const match = { status: 'paid' };
        const pipeline = [{ $match: match }, { $group: { _id: null } }];
        const res = scopePipeline(pipeline, T1);
        expect(res.action).toBe('inject');
        expect(res.pipeline[0]).toEqual({ $match: { status: 'paid', restaurant: T1 } });
        expect(match).toEqual({ status: 'paid' });
        expect(pipeline[0].$match).toBe(match);
    });

    test('prepends a $match when the first stage is not $match', () => {
        const res = scopePipeline([{ $group: { _id: '$x' } }], T1);
        expect(res.pipeline[0]).toEqual({ $match: { restaurant: T1 } });
        expect(res.pipeline).toHaveLength(2);
    });

    test('keeps $geoNear first', () => {
        const res = scopePipeline([{ $geoNear: { near: [0, 0] } }], T1);
        expect(Object.keys(res.pipeline[0])[0]).toBe('$geoNear');
        expect(res.pipeline[1]).toEqual({ $match: { restaurant: T1 } });
    });

    test('explicit restaurant in any top-level $match → untouched', () => {
        const p = [{ $match: { restaurant: T2 } }];
        expect(scopePipeline(p, T1)).toEqual({ action: 'explicit', pipeline: p });
    });

    test('$collStats-style first stage → unscopable', () => {
        expect(scopePipeline([{ $collStats: {} }], T1).action).toBe('unscopable');
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('tenantScopePlugin on Mongoose queries', () => {
    test('outside a request context the query is untouched', async () => {
        const [q] = await runQueryPre(Scoped.find({ status: 'x' }));
        expect(q.getFilter()).toEqual({ status: 'x' });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('inside a tenant context a missing restaurant is injected + warned', async () => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ status: 'x' }));
            expect(q.getFilter()).toEqual({ status: 'x', restaurant: T1 });
        });
        expect(logger.warn).toHaveBeenCalledWith('tenantScope.injected', expect.objectContaining({
            model: 'TenantScopePluginTestScoped', op: 'find', filterKeys: ['status'],
        }));
    });

    test.each([
        ['findOne', () => Scoped.findOne({ _id: new mongoose.Types.ObjectId() })],
        ['findById', () => Scoped.findById(new mongoose.Types.ObjectId())],
        ['countDocuments', () => Scoped.countDocuments({ status: 'x' })],
        ['distinct', () => Scoped.distinct('name', { status: 'x' })],
        ['updateOne', () => Scoped.updateOne({ status: 'x' }, { $set: { name: 'n' } })],
        ['updateMany', () => Scoped.updateMany({ status: 'x' }, { $set: { name: 'n' } })],
        ['findOneAndUpdate', () => Scoped.findOneAndUpdate({ status: 'x' }, { $set: { name: 'n' } })],
        ['deleteOne', () => Scoped.deleteOne({ status: 'x' })],
        ['deleteMany', () => Scoped.deleteMany({ status: 'x' })],
    ])('%s is scoped', async (_label, build) => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(build());
            expect(String(q.getFilter().restaurant)).toBe(String(T1));
        });
    });

    test('explicit restaurant filter is never overridden or doubled', async () => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ restaurant: T1, status: 'x' }));
            expect(q.getFilter()).toEqual({ restaurant: T1, status: 'x' });
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('explicit OTHER tenant is kept but logged as a mismatch', async () => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ restaurant: T2 }));
            expect(q.getFilter()).toEqual({ restaurant: T2 });
        });
        expect(logger.warn).toHaveBeenCalledWith('tenantScope.explicit-mismatch', expect.any(Object));
    });

    test('skipTenantScope opt-out (options arg and setOptions) and is stripped', async () => {
        await inTenant(T1, async () => {
            const [q1] = await runQueryPre(Scoped.findOne({ name: 'x' }, null, { skipTenantScope: true }));
            expect(q1.getFilter()).toEqual({ name: 'x' });
            expect(q1.getOptions().skipTenantScope).toBeUndefined();

            const [q2] = await runQueryPre(Scoped.find({ name: 'x' }).setOptions({ skipTenantScope: true }));
            expect(q2.getFilter()).toEqual({ name: 'x' });
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('context without a tenant (superadmin / exempt path) → no-op', async () => {
        await requestContext.runWithContext({ tenantId: null, isSuperadmin: true }, async () => {
            const [q] = await runQueryPre(Scoped.find({ status: 'x' }));
            expect(q.getFilter()).toEqual({ status: 'x' });
        });
    });

    test('runWithoutContext escapes the request tenant', async () => {
        await inTenant(T1, async () => {
            await requestContext.runWithoutContext(async () => {
                const [q] = await runQueryPre(Scoped.find({ status: 'x' }));
                expect(q.getFilter()).toEqual({ status: 'x' });
            });
        });
    });

    test('TENANT_SCOPE_PLUGIN=warn logs but does not change the filter', async () => {
        process.env.TENANT_SCOPE_PLUGIN = 'warn';
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ status: 'warn-mode' }));
            expect(q.getFilter()).toEqual({ status: 'warn-mode' });
        });
        expect(logger.warn).toHaveBeenCalledWith('tenantScope.injected', expect.objectContaining({ mode: 'warn' }));
    });

    test('TENANT_SCOPE_PLUGIN=off disables the plugin', async () => {
        process.env.TENANT_SCOPE_PLUGIN = 'off';
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ status: 'off' }));
            expect(q.getFilter()).toEqual({ status: 'off' });
        });
    });

    test('populate-shaped filters are scoped but only logged at debug', async () => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Scoped.find({ _id: { $in: [new mongoose.Types.ObjectId()] } }));
            expect(String(q.getFilter().restaurant)).toBe(String(T1));
        });
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith('tenantScope.injected (populate)', expect.any(Object));
    });

    test('models without a restaurant path are not hooked', async () => {
        await inTenant(T1, async () => {
            const [q] = await runQueryPre(Global.find({ name: 'x' }));
            expect(q.getFilter()).toEqual({ name: 'x' });
        });
    });
});

describe('tenantScopePlugin on aggregate()', () => {
    test('injects into the leading $match inside a tenant context', async () => {
        await inTenant(T1, async () => {
            const [agg] = await runAggregatePre(Scoped, Scoped.aggregate([{ $match: { status: 'x' } }, { $count: 'n' }]));
            expect(agg.pipeline()[0]).toEqual({ $match: { status: 'x', restaurant: T1 } });
            expect(agg.pipeline()).toHaveLength(2);
        });
    });

    test('no-op outside context and with skipTenantScope', async () => {
        const [a1] = await runAggregatePre(Scoped, Scoped.aggregate([{ $match: { status: 'x' } }]));
        expect(a1.pipeline()[0]).toEqual({ $match: { status: 'x' } });
        await inTenant(T1, async () => {
            const [a2] = await runAggregatePre(Scoped,
                Scoped.aggregate([{ $match: { status: 'x' } }]).option({ skipTenantScope: true }));
            expect(a2.pipeline()[0]).toEqual({ $match: { status: 'x' } });
            expect(a2.options.skipTenantScope).toBeUndefined();
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
describe('attachTenant opens the request context', () => {
    const mkRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

    test('staff request: next() runs with the tenant in context', async () => {
        mockRestaurant.findById.mockResolvedValue({ _id: T1, name: 'R1', status: 'active' });
        const req = { path: '/orders', method: 'GET', headers: {}, query: {}, user: { _id: 'u1', role: 'admin', restaurant: T1 } };
        let seen;
        await attachTenant(req, mkRes(), () => { seen = requestContext.getContext(); });
        expect(seen).toEqual(expect.objectContaining({ tenantId: T1, role: 'admin', isSuperadmin: false }));
        expect(requestContext.getContext()).toBeNull(); // does not leak past the request
    });

    test('superadmin request: context exists but has no tenant', async () => {
        const req = { path: '/orders', method: 'GET', headers: {}, query: {}, user: { _id: 'sa', role: 'superadmin' } };
        let seen;
        await attachTenant(req, mkRes(), () => { seen = requestContext.getContext(); });
        expect(seen).toEqual(expect.objectContaining({ tenantId: null, isSuperadmin: true }));
    });

    test('route-level re-mount updates the existing store instead of nesting', async () => {
        mockRestaurant.findById.mockResolvedValue({ _id: T2, name: 'R2', status: 'active' });
        const outer = { tenantId: null, path: '/x' };
        const req = { path: '/inventory', method: 'GET', headers: {}, query: {}, user: { _id: 'u2', role: 'admin', restaurant: T2 } };
        let seen;
        await requestContext.runWithContext(outer, () =>
            attachTenant(req, mkRes(), () => { seen = requestContext.getContext(); }));
        expect(seen).toBe(outer);
        expect(outer.tenantId).toBe(T2);
    });
});

describe('tenantFilter(req)', () => {
    test('returns the tenant filter when resolved', () => {
        expect(tenantFilter({ restaurant: { _id: T1 } })).toEqual({ restaurant: T1 });
    });

    test('warns (does not throw) for a non-superadmin request without a tenant', () => {
        expect(tenantFilter({ method: 'GET', path: '/nope-1', user: { role: 'admin' } })).toEqual({});
        expect(logger.warn).toHaveBeenCalledWith('tenantScope.tenantFilter.no-tenant', expect.objectContaining({ role: 'admin' }));
    });

    test('stays silent for superadmin', () => {
        expect(tenantFilter({ method: 'GET', path: '/nope-2', user: { role: 'superadmin' } })).toEqual({});
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
