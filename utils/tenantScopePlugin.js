/**
 * tenantScopePlugin — Mongoose safety net for BUGS_REPORT #30.
 *
 * Every tenant-owned model (schema has a required `restaurant` field)
 * registers this plugin. On find / findOne / count / distinct / update /
 * delete / replace queries and on aggregate(), when:
 *
 *   1. we are inside a request context (utils/requestContext.js) that has
 *      a resolved tenant, AND
 *   2. the query has not opted out (`{ skipTenantScope: true }`), AND
 *   3. the filter does NOT already carry a `restaurant` condition,
 *
 * the plugin adds `restaurant: <ctx tenant>` to the filter and logs a
 * `tenantScope.injected` warning so the gap becomes visible in logs
 * without breaking the request.
 *
 * It never overrides or double-applies an explicit `restaurant` filter.
 * When the explicit value is a different tenant than the context's, it
 * logs `tenantScope.explicit-mismatch` (no change to the query).
 *
 * No-op outside a request context (boot, seeds, scripts, setInterval
 * jobs, socket handlers) and for requests without a tenant (superadmin,
 * /public, /auth, /tables/scan, razorpay webhook).
 *
 * Opt-out (superadmin / deliberate cross-tenant code inside a tenant
 * request):
 *   Model.find(filter).setOptions({ skipTenantScope: true })
 *   Model.findOne(filter, null, { skipTenantScope: true })
 *   Model.aggregate(pipeline).option({ skipTenantScope: true })
 *
 * Mode (env TENANT_SCOPE_PLUGIN):
 *   enforce (default) — inject + warn
 *   warn              — warn only, query unchanged
 *   off               — disabled
 *
 * Known limits: $lookup / $unionWith sub-pipelines, bulkWrite, insertMany
 * and estimatedDocumentCount are not scoped. Populate sub-queries ARE
 * scoped (populated docs belong to the same tenant); those are logged at
 * debug level because their filter is always `{ _id: { $in: [...] } }`.
 */
'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');
const { getContext } = require('./requestContext');

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

// Stages that must be first in a pipeline — insert our $match after them.
const MUST_BE_FIRST = new Set(['$geoNear', '$search', '$searchMeta', '$vectorSearch']);
// Stages we cannot (or should not) scope — leave the pipeline alone.
const UNSCOPABLE_FIRST = new Set([
    '$collStats', '$indexStats', '$currentOp', '$listSessions',
    '$listLocalSessions', '$changeStream', '$documents', '$listSearchIndexes',
]);

function mode() {
    const m = String(process.env.TENANT_SCOPE_PLUGIN || 'enforce').toLowerCase();
    return m === 'off' || m === 'warn' ? m : 'enforce';
}

function toObjectId(id) {
    if (id == null) return null;
    if (id instanceof mongoose.Types.ObjectId) return id;
    if (id._id instanceof mongoose.Types.ObjectId) return id._id;
    const s = String(id);
    return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * True when the filter already constrains `restaurant` — directly, inside
 * a top-level $and, or in EVERY branch of a top-level $or. A key whose
 * value is `undefined` counts as absent (Mongoose drops it anyway).
 */
function hasTenantCondition(filter) {
    if (!filter || typeof filter !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(filter, FIELD) && filter[FIELD] !== undefined) return true;
    if (Array.isArray(filter.$and) && filter.$and.some(hasTenantCondition)) return true;
    if (Array.isArray(filter.$or) && filter.$or.length > 0 && filter.$or.every(hasTenantCondition)) return true;
    return false;
}

/** Explicit scalar tenant value that differs from ctx (for logging only). */
function isExplicitMismatch(filter, tenantId) {
    if (!filter || !Object.prototype.hasOwnProperty.call(filter, FIELD)) return false;
    const v = filter[FIELD];
    if (v == null || (typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId))) return false;
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
 * Never mutates the input.
 */
function scopeFilter(filter, tenantId) {
    const tid = toObjectId(tenantId);
    if (!tid) return { action: 'noop', filter };
    if (hasTenantCondition(filter)) return { action: 'explicit', filter };
    return { action: 'inject', filter: { ...(filter || {}), [FIELD]: tid } };
}

/**
 * Pure: decide what to do with an aggregation pipeline.
 * Returns { action: 'noop' | 'explicit' | 'inject' | 'unscopable', pipeline }
 * Never mutates the input array or its stage objects.
 */
function scopePipeline(pipeline, tenantId) {
    const tid = toObjectId(tenantId);
    const stages = Array.isArray(pipeline) ? pipeline : [];
    if (!tid) return { action: 'noop', pipeline: stages };

    // Any top-level $match already constraining restaurant → explicit.
    if (stages.some(s => s && s.$match && hasTenantCondition(s.$match))) {
        return { action: 'explicit', pipeline: stages };
    }

    const first = stages[0];
    const firstOp = first && typeof first === 'object' ? Object.keys(first)[0] : null;
    if (firstOp && UNSCOPABLE_FIRST.has(firstOp)) {
        return { action: 'unscopable', pipeline: stages };
    }

    const out = stages.slice();
    if (firstOp === '$match') {
        out[0] = { ...first, $match: { ...first.$match, [FIELD]: tid } };
    } else if (firstOp && MUST_BE_FIRST.has(firstOp)) {
        out.splice(1, 0, { $match: { [FIELD]: tid } });
    } else {
        out.unshift({ $match: { [FIELD]: tid } });
    }
    return { action: 'inject', pipeline: out };
}

// ── Logging (deduped: 1st, 10th, 100th, … occurrence per site) ───────
const stats = { injected: 0, mismatches: 0, unscopable: 0, bySite: new Map() };

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

/** Returns true if the query/aggregate should be left alone. */
function readAndStripSkip(options) {
    if (!options || !options.skipTenantScope) return false;
    delete options.skipTenantScope; // don't forward a custom option to the driver
    return true;
}

function queryHook() {
    if (mode() === 'off') return;
    if (readAndStripSkip(this.options)) return;
    const ctx = getContext();
    if (!ctx || !ctx.tenantId) return;

    const filter = this.getFilter();
    const res = scopeFilter(filter, ctx.tenantId);
    const model = this.model?.modelName;
    if (res.action === 'explicit') {
        if (isExplicitMismatch(filter, ctx.tenantId)) {
            stats.mismatches += 1;
            report('explicit-mismatch', { model, op: this.op, ctx, filter });
        }
        return;
    }
    if (res.action !== 'inject') return;

    stats.injected += 1;
    report('injected', { model, op: this.op, ctx, filter, populate: looksLikePopulate(filter) });
    if (mode() === 'enforce') this.where({ [FIELD]: res.filter[FIELD] });
}

function aggregateHook() {
    if (mode() === 'off') return;
    if (readAndStripSkip(this.options)) return;
    const ctx = getContext();
    if (!ctx || !ctx.tenantId) return;

    const pipeline = this.pipeline();
    const res = scopePipeline(pipeline, ctx.tenantId);
    const model = this._model?.modelName;
    if (res.action === 'unscopable') {
        stats.unscopable += 1;
        report('unscopable', { model, op: 'aggregate', ctx, filter: null });
        return;
    }
    if (res.action !== 'inject') return;

    stats.injected += 1;
    report('injected', { model, op: 'aggregate', ctx, filter: pipeline[0]?.$match || null });
    if (mode() === 'enforce') {
        // Replace in place — this.pipeline() returns the Aggregate's own array.
        pipeline.splice(0, pipeline.length, ...res.pipeline);
    }
}

function tenantScopePlugin(schema) {
    if (!schema.path(FIELD)) return; // not a tenant-owned schema
    schema.pre(QUERY_OPS, { document: false, query: true }, queryHook);
    schema.pre('aggregate', aggregateHook);
}

function getTenantScopeStats() {
    return {
        injected: stats.injected,
        mismatches: stats.mismatches,
        unscopable: stats.unscopable,
        bySite: Object.fromEntries(stats.bySite),
    };
}

module.exports = tenantScopePlugin;
module.exports.tenantScopePlugin = tenantScopePlugin;
module.exports.scopeFilter = scopeFilter;
module.exports.scopePipeline = scopePipeline;
module.exports.hasTenantCondition = hasTenantCondition;
module.exports.getTenantScopeStats = getTenantScopeStats;
module.exports.QUERY_OPS = QUERY_OPS;
