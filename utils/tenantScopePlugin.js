/**
 * tenantScopePlugin - Mongoose safety net for BUGS_REPORT #30.
 *
 * Every tenant-owned model (schema has a `restaurant` path) registers this
 * plugin. On find / findOne / count / distinct / update / delete / replace
 * queries and on aggregate(), when we are inside a tenant context
 * (utils/requestContext.js: an HTTP request with a resolved tenant, or
 * tenantSafe.runAsTenant) and the query has not been deliberately exempted,
 * the plugin ALWAYS ANDs `restaurant: <ctx tenant>` into the filter:
 *
 *   - no `restaurant` key            -> `restaurant: <tenant>` is added
 *   - `restaurant` exactly == tenant -> left alone
 *   - anything else (another tenant, $ne / $in / $exists, null, $or / $and
 *     wrappers, an explicit aggregate $match ...) -> the tenant condition is
 *     ANDed on top (`$and: [filter, { restaurant: <tenant> }]`), so a
 *     hand-built filter can never reach another tenant. A scalar mismatch is
 *     also logged as `tenantScope.explicit-mismatch`.
 *
 * Aggregations get a leading tenant $match, and every $lookup / $unionWith /
 * $graphLookup (also inside $facet and nested sub-pipelines) that reads a
 * tenant-owned collection is rewritten with tenantSafe.scopeLookupSpec.
 * Collections whose model has no strict scope (users, plans, restaurants,
 * unregistered collections) are left unrewritten.
 *
 * No-op for QUERIES outside any context (boot, seeds, scripts, jobs) and
 * inside runAsSystem(); also for requests without a tenant (superadmin,
 * /public, /auth, razorpay webhook).
 *
 * Opt-out (deliberate cross-tenant code inside a tenant context). The old
 * `{ skipTenantScope: true }` QUERY OPTION is no longer trusted (it could be
 * smuggled in from user input such as Model.find(f, null, req.body)); it is
 * stripped and only honoured inside runAsSystem(). Use:
 *   const { skipScope } = require('./tenantScopePlugin');
 *   skipScope(Model.find(filter))            // Query
 *   skipScope(Model.aggregate(pipeline))     // Aggregate
 * which records the query in a module-private WeakSet.
 *
 * Mode (env TENANT_SCOPE_PLUGIN): enforce (default) | warn | off.
 * In NODE_ENV=production `warn` / `off` are IGNORED (an error is logged and
 * the plugin enforces).
 *
 * Writes (insertMany / bulkWrite / save): inside a tenant context a missing
 * `restaurant` is stamped (insertMany / bulkWrite) and a DIFFERENT
 * `restaurant` is rejected with TenantMismatchError (create / save /
 * insertMany / bulkWrite). runAsSystem() is always accepted. With no tenant
 * context a restaurant-less write warns; it throws TenantContextError when
 * TENANT_STRICT_CONTEXT=true, or by default in production for models whose
 * `restaurant` is required.
 *
 * Nullable mode (`schema.plugin(tenantScopePlugin, { allowNull: true })`, used
 * by models/user.js): for collections where `restaurant` is legitimately null
 * (customers, superadmins) reads inside a tenant context are limited to
 * `restaurant in [tenant, null]`. Write hooks are not installed.
 *
 * Build-time tenant capture (2026-11): Mongoose has no query-creation hook, so
 * this module wraps the Query op methods (find, findOne, ...) and
 * Aggregate#model(m) ONCE to stamp the tenant context in force when the
 * query/aggregate was BUILT. At exec time: built under tenant A + executed
 * under tenant B throws TenantMismatchError; built under A + executed with no
 * tenant context (detached / runWithoutContext) is scoped by A; a query built
 * with no context / system / tenantless request, or executed in runAsSystem,
 * behaves exactly as before (scoped by the exec context, or not at all).
 *
 * Populate outside a tenant context (jobs, scripts, sockets): the populate
 * options of the parent query get a per-document `match` that ANDs
 * `restaurant in [parent.restaurant, null]` when the target model is
 * tenant-owned, so legacy cross-tenant refs hydrate to null. Run
 * scripts/repair-cross-tenant-refs.js to clean the stored data itself.
 *
 * Known limits: estimatedDocumentCount cannot be filtered (use
 * tenantSafe.tenantEstimatedCount); raw driver access (Model.collection.*) is
 * not covered. Populate sub-queries ARE scoped (logged at debug level).
 */
'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');
const { getContext } = require('./requestContext');
const tenantSafe = require('./tenantSafe');

const FIELD = 'restaurant';

const QUERY_OPS = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'distinct',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
];

// Stages that must be first in a pipeline - insert our $match after them.
const MUST_BE_FIRST = new Set(['$geoNear', '$search', '$searchMeta', '$vectorSearch']);
// Stages we cannot (or should not) scope - leave the pipeline alone.
const UNSCOPABLE_FIRST = new Set([
    '$collStats', '$indexStats', '$currentOp', '$listSessions',
    '$listLocalSessions', '$changeStream', '$documents', '$listSearchIndexes',
]);

let warnedProdOverride = false;
function mode() {
    const m = String(process.env.TENANT_SCOPE_PLUGIN || 'enforce').toLowerCase();
    if (m === 'off' || m === 'warn') {
        if (process.env.NODE_ENV === 'production') {
            if (!warnedProdOverride) {
                warnedProdOverride = true;
                logger.error(`tenantScope: TENANT_SCOPE_PLUGIN=${m} is ignored in production; enforcing`);
            }
            return 'enforce';
        }
        return m;
    }
    return 'enforce';
}

function toObjectId(id) {
    if (id == null) return null;
    if (id instanceof mongoose.Types.ObjectId) return id;
    if (id._id instanceof mongoose.Types.ObjectId) return id._id;
    const s = String(id);
    return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

const isScalar = (v) => v != null && (typeof v !== 'object' || v instanceof mongoose.Types.ObjectId);
const hasKey = (f) => !!f && typeof f === 'object'
    && Object.prototype.hasOwnProperty.call(f, FIELD) && f[FIELD] !== undefined;

/**
 * True when the filter pins `restaurant` to ONE specific tenant - directly or
 * inside a top-level $and. With `tenantId` it must be exactly that tenant;
 * without it any scalar restaurant counts. Operator conditions ($ne / $in /
 * $exists ...), null and $or branches never count (they cannot prove
 * confinement).
 */
function hasTenantCondition(filter, tenantId) {
    if (!filter || typeof filter !== 'object') return false;
    if (hasKey(filter)) {
        const v = filter[FIELD];
        if (!isScalar(v)) return false;
        return tenantId == null || String(v) === String(tenantId);
    }
    if (Array.isArray(filter.$and) && filter.$and.some(c => hasTenantCondition(c, tenantId))) return true;
    return false;
}

/** Explicit scalar tenant value that differs from ctx (for logging only). */
function isExplicitMismatch(filter, tenantId) {
    if (!hasKey(filter)) return false;
    const v = filter[FIELD];
    if (!isScalar(v)) return false;
    return String(v) !== String(tenantId);
}

function looksLikePopulate(filter) {
    if (!filter || typeof filter !== 'object') return false;
    const keys = Object.keys(filter);
    return keys.length === 1 && keys[0] === '_id'
        && filter._id && typeof filter._id === 'object' && Array.isArray(filter._id.$in);
}

/**
 * Pure: decide what to do with a query filter.
 * Returns { action: 'noop' | 'explicit' | 'inject', filter }
 * where `filter` is the (new) filter to use when action === 'inject'.
 * 'explicit' only when the filter already pins exactly this tenant.
 * Never mutates the input.
 */
function scopeFilter(filter, tenantId) {
    const tid = toObjectId(tenantId);
    if (!tid) return { action: 'noop', filter };
    if (hasTenantCondition(filter, tid)) return { action: 'explicit', filter };
    if (hasKey(filter)) return { action: 'inject', filter: { $and: [filter, { [FIELD]: tid }] } };
    return { action: 'inject', filter: { ...(filter || {}), [FIELD]: tid } };
}

// ── $lookup / $unionWith / $graphLookup rewriting ────────────────────
let collModeCache = { count: -1, map: new Map() };

/** Scope mode ('strict' | 'nullable' | undefined) of the model owning a collection. */
function collectionMode(coll) {
    if (typeof coll !== 'string') return undefined;
    const names = mongoose.modelNames();
    if (collModeCache.count !== names.length) {
        const map = new Map();
        for (const n of names) {
            try {
                const m = mongoose.model(n);
                const mode = m.schema && m.schema.options && m.schema.options.tenantScopeMode;
                if (mode && m.collection) map.set(m.collection.name, mode);
            } catch (_) { /* ignore */ }
        }
        collModeCache = { count: names.length, map };
    }
    return collModeCache.map.get(coll);
}

const ownedByTenant = (coll) => collectionMode(coll) === 'strict';
const collName = (from) => (from && typeof from === 'object' ? from.coll : from);

/**
 * Rewrite cross-collection stages (recursively, incl. $facet and nested
 * pipelines). Returns the same array when nothing changed. Never mutates.
 */
function rewriteStages(stages, tid) {
    let changed = false;
    const out = stages.map((st) => {
        if (!st || typeof st !== 'object') return st;
        const op = Object.keys(st)[0];
        const body = st[op];
        if (op === '$lookup' && body && typeof body === 'object') {
            let spec = body;
            if (ownedByTenant(collName(spec.from))) spec = tenantSafe.scopeLookupSpec(spec, tid, '$lookup');
            if (Array.isArray(spec.pipeline)) {
                const np = rewriteStages(spec.pipeline, tid);
                if (np !== spec.pipeline) spec = { ...spec, pipeline: np };
            }
            if (spec !== body) { changed = true; return { ...st, $lookup: spec }; }
            return st;
        }
        if (op === '$unionWith' && body) {
            let spec = typeof body === 'string' ? { coll: body } : body;
            const wasString = typeof body === 'string';
            if (ownedByTenant(spec.coll)) spec = tenantSafe.scopeLookupSpec(spec, tid, '$unionWith');
            if (Array.isArray(spec.pipeline)) {
                const np = rewriteStages(spec.pipeline, tid);
                if (np !== spec.pipeline) spec = { ...spec, pipeline: np };
            }
            if (wasString && spec.pipeline === undefined) return st;
            if (spec !== body) { changed = true; return { ...st, $unionWith: spec }; }
            return st;
        }
        if (op === '$graphLookup' && body && typeof body === 'object' && ownedByTenant(collName(body.from))) {
            changed = true;
            const orig = body.restrictSearchWithMatch;
            const tenantCond = { [FIELD]: tid };
            return {
                ...st,
                $graphLookup: {
                    ...body,
                    restrictSearchWithMatch: hasKey(orig) && hasTenantCondition(orig, tid) ? orig
                        : (orig && Object.keys(orig).length ? { $and: [orig, tenantCond] } : tenantCond),
                },
            };
        }
        if (op === '$facet' && body && typeof body === 'object') {
            let facetChanged = false;
            const nf = {};
            for (const [k, v] of Object.entries(body)) {
                const nv = Array.isArray(v) ? rewriteStages(v, tid) : v;
                if (nv !== v) facetChanged = true;
                nf[k] = nv;
            }
            if (facetChanged) { changed = true; return { ...st, $facet: nf }; }
            return st;
        }
        return st;
    });
    return changed ? out : stages;
}

/**
 * Pure: decide what to do with an aggregation pipeline.
 * Returns { action: 'noop' | 'explicit' | 'inject' | 'unscopable', pipeline }
 * 'explicit' only when nothing had to change (leading $match already pins this
 * tenant and no cross-collection stage needed rewriting).
 * Never mutates the input array or its stage objects.
 */
function scopePipeline(pipeline, tenantId) {
    const tid = toObjectId(tenantId);
    const stages = Array.isArray(pipeline) ? pipeline : [];
    if (!tid) return { action: 'noop', pipeline: stages };

    const first = stages[0];
    const firstOp = first && typeof first === 'object' ? Object.keys(first)[0] : null;
    if (firstOp && UNSCOPABLE_FIRST.has(firstOp)) {
        return { action: 'unscopable', pipeline: stages };
    }

    let out = stages;
    if (firstOp === '$match' && first.$match && typeof first.$match === 'object') {
        if (!hasTenantCondition(first.$match, tid)) {
            out = stages.slice();
            const m = first.$match;
            out[0] = { ...first, $match: hasKey(m) ? { $and: [m, { [FIELD]: tid }] } : { ...m, [FIELD]: tid } };
        }
    } else if (firstOp && MUST_BE_FIRST.has(firstOp)) {
        out = stages.slice();
        out.splice(1, 0, { $match: { [FIELD]: tid } });
    } else {
        out = stages.slice();
        out.unshift({ $match: { [FIELD]: tid } });
    }

    const rewritten = rewriteStages(out, tid);
    if (rewritten === stages) return { action: 'explicit', pipeline: stages };
    return { action: 'inject', pipeline: rewritten };
}

// ── Logging (deduped: 1st, 10th, 100th, ... occurrence per site) ─────
const stats = { injected: 0, mismatches: 0, unscopable: 0, unscopedWrites: 0, bySite: new Map() };

function shouldLog(key) {
    const n = (stats.bySite.get(key) || 0) + 1;
    stats.bySite.set(key, n);
    if (stats.bySite.size > 500) stats.bySite.delete(stats.bySite.keys().next().value);
    return n === 1 || Number.isInteger(Math.log10(n));
}

function report(kind, { model, op, ctx, filter, populate }) {
    const site = `${kind} ${model}.${op} ${ctx?.method || ''} ${ctx?.path || ''}`;
    if (!shouldLog(site)) return;
    const meta = {
        model,
        op,
        method: ctx?.method,
        path: ctx?.path,
        role: ctx?.role,
        filterKeys: filter && typeof filter === 'object' ? Object.keys(filter) : [],
        occurrences: stats.bySite.get(site),
        mode: mode(),
    };
    if (populate) logger.debug(`tenantScope.${kind} (populate)`, meta);
    else logger.warn(`tenantScope.${kind}`, meta);
}

// ── Opt-out ──────────────────────────────────────────────────────────
// Module-private: only code that calls skipScope() can exempt a query. Unlike
// an options key it cannot arrive through user-controlled JSON / spreads.
const skipped = new WeakSet();

/** Exempt ONE Query / Aggregate from tenant scoping (deliberate cross-tenant read). */
function skipScope(queryOrAggregate) {
    if (queryOrAggregate && typeof queryOrAggregate === 'object') skipped.add(queryOrAggregate);
    return queryOrAggregate;
}

/**
 * True if the query/aggregate should be left alone. The legacy
 * `skipTenantScope` option is always stripped (never forwarded to the
 * driver) but only honoured inside runAsSystem().
 */
function readAndStripSkip(target, options) {
    let legacy = false;
    if (options && Object.prototype.hasOwnProperty.call(options, 'skipTenantScope')) {
        legacy = !!options.skipTenantScope;
        delete options.skipTenantScope;
    }
    if (skipped.has(target)) return true;
    if (legacy) {
        const ctx = getContext();
        if (ctx && ctx.system) return true;
        if (ctx && ctx.tenantId) {
            logger.debug('tenantScope.legacy-skip-ignored (use skipScope() or runAsSystem())', { path: ctx.path });
        }
    }
    return false;
}

// ── Build-time tenant capture ────────────────────────────────────────
const BUILT = Symbol.for('bestodine.tenantScope.builtCtx');

function snapshotCtx() {
    const c = getContext();
    return { tenantId: c && !c.system && c.tenantId ? String(c.tenantId) : null, system: !!(c && c.system) };
}

function stamp(target) {
    if (!target || typeof target !== 'object' || target[BUILT]) return;
    try { Object.defineProperty(target, BUILT, { value: snapshotCtx(), enumerable: false, configurable: true }); } catch (_) { /* frozen */ }
}

let patched = false;
function patchBuilders() {
    if (patched) return;
    patched = true;
    const Q = mongoose.Query && mongoose.Query.prototype;
    if (Q) {
        for (const op of QUERY_OPS) {
            const orig = Q[op];
            if (typeof orig !== 'function' || orig.__tenantStamp) continue;
            const wrapped = function (...args) { stamp(this); return orig.apply(this, args); };
            wrapped.__tenantStamp = true;
            Q[op] = wrapped;
        }
    }
    const A = mongoose.Aggregate && mongoose.Aggregate.prototype;
    if (A && typeof A.model === 'function' && !A.model.__tenantStamp) {
        const orig = A.model;
        const wrapped = function (...args) { if (args.length) stamp(this); return orig.apply(this, args); };
        wrapped.__tenantStamp = true;
        A.model = wrapped;
    }
}

/**
 * Tenant to scope by at exec time, or null for "do not scope".
 * Throws TenantMismatchError when built under tenant A and run under tenant B.
 */
function effectiveTenant(target, ctx, what) {
    const built = target && target[BUILT];
    const execTenant = ctx && !ctx.system && ctx.tenantId ? ctx.tenantId : null;
    if (!built || !built.tenantId || (ctx && ctx.system)) return execTenant;
    if (!execTenant) return built.tenantId; // detached exec: stay with the builder's tenant
    if (String(execTenant) === built.tenantId) return execTenant;
    stats.mismatches += 1;
    report('explicit-mismatch', { model: what, op: 'exec-context', ctx, filter: null });
    if (mode() === 'enforce') {
        throw new tenantSafe.TenantMismatchError(
            `${what}: query built under tenant ${built.tenantId} but executed under tenant ${String(execTenant)}`,
            { where: 'exec-context' });
    }
    return execTenant;
}

// ── Populate without a tenant context ────────────────────────────────
const POP_WRAPPED = Symbol.for('bestodine.tenantScope.popWrapped');

function targetModelOf(parentModel, popOpts) {
    try {
        let m = popOpts.model;
        if (!m) {
            const sp = parentModel.schema.path(popOpts.path);
            const ref = sp && ((sp.options && sp.options.ref)
                || (sp.caster && sp.caster.options && sp.caster.options.ref)
                || (sp.$embeddedSchemaType && sp.$embeddedSchemaType.options && sp.$embeddedSchemaType.options.ref));
            m = typeof ref === 'function' ? null : ref;
        }
        if (!m) return null;
        return typeof m === 'string' ? mongoose.model(m) : m;
    } catch (_) { return null; }
}

function wrapPopulate(parentModel, popOpts) {
    if (!popOpts || typeof popOpts !== 'object' || popOpts[POP_WRAPPED]) return;
    popOpts[POP_WRAPPED] = true;
    const target = targetModelOf(parentModel, popOpts);
    const tmode = target && target.schema && target.schema.options && target.schema.options.tenantScopeMode;
    if (tmode && parentModel.schema.path(FIELD)) {
        const orig = popOpts.match;
        popOpts.match = function (doc, ...rest) {
            const base = typeof orig === 'function' ? orig.call(this, doc, ...rest) : orig;
            const pr = doc && (doc.$__ ? doc.get(FIELD) : doc[FIELD]);
            const pid = toObjectId(pr);
            if (!pid) return base || {};
            const cond = { [FIELD]: { $in: [pid, null] } };
            return base && Object.keys(base).length ? { $and: [base, cond] } : cond;
        };
    }
    if (popOpts.populate && target) {
        const nested = Array.isArray(popOpts.populate) ? popOpts.populate : [popOpts.populate];
        for (const n of nested) if (n && typeof n === 'object') wrapPopulate(target, n);
    }
}

/** No tenant scope applies: make populate refuse refs that cross a tenant boundary. */
function populateGuard(query, ctx) {
    if (ctx && ctx.system) return; // deliberate cross-tenant work
    const pops = query._mongooseOptions && query._mongooseOptions.populate;
    if (!pops || !query.model) return;
    for (const p of Object.values(pops)) wrapPopulate(query.model, p);
}

function queryHook() {
    if (mode() === 'off') return;
    if (readAndStripSkip(this, this.options)) return;
    const ctx = getContext();
    const tenant = effectiveTenant(this, ctx, this.model && this.model.modelName);
    if (!tenant) { populateGuard(this, ctx); return; }

    const tid = toObjectId(tenant);
    if (!tid) return;
    const nullable = this.model?.schema?.options?.tenantScopeMode === 'nullable';
    const filter = this.getFilter();
    const model = this.model?.modelName;

    if (!nullable) {
        const res = scopeFilter(filter, tid);
        if (res.action !== 'inject') return;
        if (isExplicitMismatch(filter, tid)) {
            stats.mismatches += 1;
            report('explicit-mismatch', { model, op: this.op, ctx, filter });
        }
        stats.injected += 1;
        report('injected', { model, op: this.op, ctx, filter, populate: looksLikePopulate(filter) });
        if (mode() === 'enforce') {
            if (hasKey(filter)) this.and([{ [FIELD]: tid }]);
            else this.where({ [FIELD]: tid });
        }
        return;
    }

    // nullable: tenant rows plus rows with no tenant (customers, superadmins)
    const cond = { $in: [tid, null] };
    stats.injected += 1;
    report('injected', { model, op: this.op, ctx, filter, populate: looksLikePopulate(filter) });
    if (mode() === 'enforce') {
        if (hasKey(filter)) this.and([{ [FIELD]: cond }]);
        else this.where({ [FIELD]: cond });
    }
}

function aggregateHook() {
    if (mode() === 'off') return;
    if (readAndStripSkip(this, this.options)) return;
    const ctx = getContext();
    const tenant = effectiveTenant(this, ctx, this._model && this._model.modelName);
    if (!tenant) return;

    const tid = toObjectId(tenant);
    if (!tid) return;
    const pipeline = this.pipeline();
    const nullable = this._model?.schema?.options?.tenantScopeMode === 'nullable';
    const model = this._model?.modelName;

    let res;
    if (nullable) {
        const first = pipeline[0];
        const firstOp = first && typeof first === 'object' ? Object.keys(first)[0] : null;
        if (firstOp && UNSCOPABLE_FIRST.has(firstOp)) res = { action: 'unscopable' };
        else {
            const cond = { $match: { [FIELD]: { $in: [tid, null] } } };
            const base = firstOp && MUST_BE_FIRST.has(firstOp)
                ? [first, cond, ...pipeline.slice(1)] : [cond, ...pipeline];
            res = { action: 'inject', pipeline: rewriteStages(base, tid) };
        }
    } else {
        res = scopePipeline(pipeline, tid);
    }
    if (res.action === 'unscopable') {
        stats.unscopable += 1;
        report('unscopable', { model, op: 'aggregate', ctx, filter: null });
        return;
    }
    if (res.action !== 'inject') return;

    stats.injected += 1;
    report('injected', { model, op: 'aggregate', ctx, filter: pipeline[0]?.$match || null });
    if (mode() === 'enforce') {
        // Replace in place - this.pipeline() returns the Aggregate's own array.
        pipeline.splice(0, pipeline.length, ...res.pipeline);
    }
}

// ── insertMany / bulkWrite / save native guards ──────────────────────
function hasRestaurant(v) {
    return v !== undefined && v !== null;
}

/** Does this bulkWrite op carry a restaurant (doc / filter)? */
function opHasRestaurant(op) {
    if (!op || typeof op !== 'object') return true; // let mongoose reject it
    const kind = Object.keys(op)[0];
    const body = op[kind] || {};
    if (kind === 'insertOne') return hasRestaurant(body.document && body.document[FIELD]);
    return hasTenantCondition(body.filter);
}

function failOrWarn(kind, model, op, ctx, message, required) {
    stats.unscopedWrites += 1;
    report(kind, { model, op, ctx, filter: null });
    // Explicit TENANT_STRICT_CONTEXT=true always throws; the production
    // default only applies to models whose `restaurant` is required (models
    // with an optional restaurant legitimately write tenant-less rows).
    if (tenantSafe.strictContextExplicit() || (required && tenantSafe.strictContext())) {
        throw new tenantSafe.TenantContextError(message, { model, op });
    }
}

function guardWrite(model, op, items, ctx, scopeOne, hasOne, required) {
    if (mode() === 'off') return;
    if (ctx && ctx.system) return; // runAsSystem - deliberate cross-tenant work
    if (ctx && ctx.tenantId) {
        const tid = ctx.tenantId;
        for (let i = 0; i < items.length; i++) {
            try {
                const before = hasOne(items[i]);
                if (mode() === 'enforce') items[i] = scopeOne(items[i], tid, i);
                if (!before) {
                    stats.injected += 1;
                    report('injected', { model, op, ctx, filter: null });
                }
            } catch (err) {
                if (err instanceof tenantSafe.TenantMismatchError) {
                    stats.mismatches += 1;
                    report('explicit-mismatch', { model, op, ctx, filter: null });
                    if (mode() === 'enforce') throw err;
                } else if (!(err instanceof TypeError)) {
                    throw err;
                }
            }
        }
        return;
    }
    // No tenant resolvable (no context, superadmin, public route).
    if (items.some(it => !hasOne(it))) {
        failOrWarn('no-tenant-context', model, op, ctx,
            `${model}.${op}: no tenant context and the write carries no restaurant; wrap in runAsTenant(id, fn) or runAsSystem(reason, fn), or use the utils/tenantSafe wrappers`,
            required);
    }
}

function makeInsertManyHook(required) {
    return function insertManyHook(docs) {
        const arr = Array.isArray(docs) ? docs : [docs];
        guardWrite(this.modelName, 'insertMany', arr, getContext(),
            (d, tid) => tenantSafe.scopeDoc(d, tid),
            (d) => !!d && typeof d === 'object' && hasRestaurant(d[FIELD]), required);
    };
}

function makeBulkWriteHook(required) {
    return function bulkWriteHook(ops) {
        if (!Array.isArray(ops)) return;
        guardWrite(this.modelName, 'bulkWrite', ops, getContext(),
            (op, tid) => tenantSafe.scopeBulkOps([op], tid)[0],
            opHasRestaurant, required);
    };
}

/** Document#save / Model.create: a doc may not be written under another tenant. */
function saveGuard() {
    if (mode() === 'off') return;
    const ctx = getContext();
    if (!ctx || !ctx.tenantId || ctx.system) return;
    const cur = this.get ? this.get(FIELD) : this[FIELD];
    const id = cur && cur._id ? cur._id : cur;
    if (!hasRestaurant(id)) return; // missing: the required validator decides
    if (String(id) === String(ctx.tenantId)) return;
    stats.mismatches += 1;
    report('explicit-mismatch', { model: this.constructor?.modelName, op: 'save', ctx, filter: null });
    if (mode() === 'enforce') {
        throw new tenantSafe.TenantMismatchError(
            `${this.constructor?.modelName}.save: restaurant ${String(id)} does not match tenant ${String(ctx.tenantId)}`,
            { where: 'save' });
    }
}

function tenantScopePlugin(schema, opts = {}) {
    const p = schema.path(FIELD);
    if (!p) return; // not a tenant-owned schema
    patchBuilders();
    const nullable = !!(opts && opts.allowNull);
    if (schema.options) schema.options.tenantScopeMode = nullable ? 'nullable' : 'strict';
    schema.pre(QUERY_OPS, { document: false, query: true }, queryHook);
    schema.pre('aggregate', aggregateHook);
    if (nullable) return;
    const required = !!p.isRequired;
    schema.pre('insertMany', makeInsertManyHook(required));
    schema.pre('bulkWrite', makeBulkWriteHook(required));
    schema.pre('save', saveGuard);
}

function getTenantScopeStats() {
    return {
        injected: stats.injected,
        mismatches: stats.mismatches,
        unscopable: stats.unscopable,
        unscopedWrites: stats.unscopedWrites,
        bySite: Object.fromEntries(stats.bySite),
    };
}

module.exports = tenantScopePlugin;
module.exports.tenantScopePlugin = tenantScopePlugin;
module.exports.scopeFilter = scopeFilter;
module.exports.scopePipeline = scopePipeline;
module.exports.hasTenantCondition = hasTenantCondition;
module.exports.skipScope = skipScope;
module.exports.getTenantScopeStats = getTenantScopeStats;
module.exports.QUERY_OPS = QUERY_OPS;
