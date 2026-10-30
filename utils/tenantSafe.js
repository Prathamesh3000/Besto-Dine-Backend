/**
 * tenantSafe — tenant-isolation helpers for the operations the Mongoose
 * tenantScopePlugin cannot scope by query middleware (task 4.6).
 *
 *   Explicit context API
 *     runAsTenant(restaurantId, fn)   work for ONE tenant (jobs, sockets, scripts)
 *     runAsSystem(reason, fn)         deliberate cross-tenant work (needs a reason)
 *
 *   Safe wrappers (pass the restaurant explicitly)
 *     tenantBulkWrite(Model, ops, restaurantId, options?)
 *     tenantInsertMany(Model, docs, restaurantId, options?)
 *     tenantLookup(spec, restaurantId)          -> { $lookup: ... } stage
 *     tenantUnionWith(spec, restaurantId)       -> { $unionWith: ... } stage
 *     tenantAggregate(Model, pipeline, restaurantId, options?)
 *     tenantEstimatedCount(Model, restaurantId) (estimatedDocumentCount cannot filter)
 *
 *   Pure helpers (also used by the plugin's native bulkWrite / insertMany hooks)
 *     scopeBulkOps, scopeDocs, scopeLookupSpec, scopePipelineStrict
 *
 * Verification semantics shared by every helper: a missing `restaurant` is
 * stamped / injected; a `restaurant` equal to the expected tenant is left
 * alone; a DIFFERENT `restaurant` throws TenantMismatchError (never silently
 * rewritten — that would hide a cross-tenant write bug).
 *
 * See docs/tenant-isolation.md.
 */
'use strict';

const mongoose = require('mongoose');
const { runWithContext, getContext } = require('./requestContext');

const FIELD = 'restaurant';

class TenantMismatchError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'TenantMismatchError';
        this.code = 'TENANT_MISMATCH';
        Object.assign(this, meta);
    }
}

class TenantContextError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'TenantContextError';
        this.code = 'TENANT_CONTEXT_REQUIRED';
        Object.assign(this, meta);
    }
}

function strictContext() {
    const v = String(process.env.TENANT_STRICT_CONTEXT || '').toLowerCase();
    return v === 'true' || v === '1' || v === 'on';
}

function toObjectId(id) {
    if (id == null) return null;
    if (id instanceof mongoose.Types.ObjectId) return id;
    if (id._id instanceof mongoose.Types.ObjectId) return id._id;
    const s = String(id._id != null ? id._id : id);
    return mongoose.isValidObjectId(s) && /^[a-f0-9]{24}$/i.test(s) ? new mongoose.Types.ObjectId(s) : null;
}

function requireTenantId(restaurantId, what) {
    const oid = toObjectId(restaurantId);
    if (!oid) throw new TenantContextError(`${what}: a valid restaurantId is required`, { restaurantId: String(restaurantId) });
    return oid;
}

const same = (a, b) => String(a?._id != null ? a._id : a) === String(b?._id != null ? b._id : b);

function isPlainOperatorObject(v) {
    return v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId)
        && !Array.isArray(v) && Object.keys(v).some(k => k.startsWith('$'));
}

// ── Explicit context API ─────────────────────────────────────────────

/**
 * Run `fn` scoped to one tenant. The Mongoose plugin then auto-scopes every
 * query / aggregate inside `fn` (including timers and promises it starts).
 * Works from anywhere: a job, a socket handler, a script, or nested inside
 * another context (the inner context replaces the outer one).
 */
function runAsTenant(restaurantId, fn) {
    if (typeof fn !== 'function') throw new TypeError('runAsTenant(restaurantId, fn): fn must be a function');
    const tenantId = requireTenantId(restaurantId, 'runAsTenant');
    return runWithContext({
        tenantId,
        branchId: null,
        userId: null,
        role: null,
        isSuperadmin: false,
        system: false,
        method: 'runAsTenant',
        path: String(tenantId),
    }, fn);
}

/**
 * Run `fn` as a deliberate cross-tenant system job. No tenant is injected
 * (so legitimate platform-wide sweeps keep working) but the context is
 * explicit and carries a mandatory human-readable `reason`, which makes the
 * native bulkWrite / insertMany guard accept it even in strict mode.
 */
function runAsSystem(reason, fn) {
    if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('runAsSystem(reason, fn): a non-empty reason is required');
    if (typeof fn !== 'function') throw new TypeError('runAsSystem(reason, fn): fn must be a function');
    return runWithContext({
        tenantId: null,
        branchId: null,
        userId: null,
        role: null,
        isSuperadmin: false,
        system: true,
        systemReason: reason.trim(),
        method: 'runAsSystem',
        path: reason.trim(),
    }, fn);
}

function isSystemContext() {
    const c = getContext();
    return !!(c && c.system);
}

// ── Pure scoping helpers ─────────────────────────────────────────────

/**
 * Return a filter that is guaranteed to be restricted to `tid`.
 * Throws TenantMismatchError when it explicitly names another tenant.
 */
function scopeFilterStrict(filter, tid, where = 'filter') {
    const f = filter && typeof filter === 'object' ? filter : {};
    if (Object.prototype.hasOwnProperty.call(f, FIELD) && f[FIELD] !== undefined) {
        const v = f[FIELD];
        if (isPlainOperatorObject(v)) {
            // e.g. { $in: [...] } — cannot prove it, so AND our tenant on top.
            return { $and: [f, { [FIELD]: tid }] };
        }
        if (!same(v, tid)) {
            throw new TenantMismatchError(`${where}: restaurant ${String(v)} does not match tenant ${String(tid)}`, { where });
        }
        return f;
    }
    return { ...f, [FIELD]: tid };
}

function scopeDoc(doc, tid, where = 'document') {
    if (doc == null || typeof doc !== 'object') {
        throw new TenantContextError(`${where}: expected an object`);
    }
    const cur = doc[FIELD];
    if (cur !== undefined && cur !== null) {
        if (!same(cur, tid)) {
            throw new TenantMismatchError(`${where}: restaurant ${String(cur?._id || cur)} does not match tenant ${String(tid)}`, { where });
        }
        return doc;
    }
    doc[FIELD] = tid; // works for plain objects and Mongoose documents
    return doc;
}

/**
 * Stamp / verify `restaurant` on every doc. Mutates the passed docs (plain
 * objects or Mongoose documents) and returns the same array.
 */
function scopeDocs(docs, restaurantId) {
    const tid = requireTenantId(restaurantId, 'scopeDocs');
    const arr = Array.isArray(docs) ? docs : [docs];
    arr.forEach((d, i) => scopeDoc(d, tid, `docs[${i}]`));
    return Array.isArray(docs) ? docs : arr[0];
}

const FILTER_OPS = ['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne'];

/**
 * Inject / verify `restaurant` on every bulkWrite op. Returns a NEW ops
 * array (filters are rebuilt; insertOne docs / replacements are stamped in
 * place). Throws on any mismatching restaurant or unknown op shape.
 */
function scopeBulkOps(ops, restaurantId) {
    const tid = requireTenantId(restaurantId, 'scopeBulkOps');
    if (!Array.isArray(ops)) throw new TypeError('bulkWrite ops must be an array');
    return ops.map((op, i) => {
        if (!op || typeof op !== 'object') throw new TypeError(`ops[${i}] must be an object`);
        const kind = Object.keys(op)[0];
        const body = op[kind];
        const where = `ops[${i}].${kind}`;
        if (kind === 'insertOne') {
            scopeDoc(body.document, tid, `${where}.document`);
            return op;
        }
        if (FILTER_OPS.includes(kind)) {
            const out = { ...body, filter: scopeFilterStrict(body.filter, tid, `${where}.filter`) };
            if (kind === 'replaceOne' && body.replacement) scopeDoc(body.replacement, tid, `${where}.replacement`);
            return { [kind]: out };
        }
        throw new TypeError(`${where}: unsupported bulkWrite operation "${kind}"`);
    });
}

/** Rewrite a $lookup / $unionWith spec so the foreign side is tenant-matched. */
function scopeLookupSpec(spec, restaurantId, stageName = '$lookup') {
    const tid = requireTenantId(restaurantId, 'tenantLookup');
    if (!spec || typeof spec !== 'object') throw new TypeError(`${stageName} spec must be an object`);
    const tenantMatch = { $match: { [FIELD]: tid } };

    if (stageName === '$unionWith') {
        const coll = typeof spec === 'string' ? spec : spec.coll;
        const pipeline = Array.isArray(spec.pipeline) ? spec.pipeline : [];
        return { coll, pipeline: scopeLeadingMatch(pipeline, tid, tenantMatch) };
    }

    const { localField, foreignField } = spec;
    if (localField != null || foreignField != null) {
        if (localField == null || foreignField == null) throw new TypeError('$lookup needs both localField and foreignField');
        // MongoDB variable names must start with a lowercase letter.
        const lv = 'tenantLookupLocal';
        const join = {
            $match: {
                $expr: {
                    $in: [
                        `$${foreignField}`,
                        { $cond: [{ $isArray: `$$${lv}` }, `$$${lv}`, [`$$${lv}`]] },
                    ],
                },
            },
        };
        const out = {
            from: spec.from,
            let: { ...(spec.let || {}), [lv]: `$${localField}` },
            pipeline: [tenantMatch, join, ...(Array.isArray(spec.pipeline) ? spec.pipeline : [])],
            as: spec.as,
        };
        return out;
    }
    const pipeline = Array.isArray(spec.pipeline) ? spec.pipeline : [];
    return { ...spec, pipeline: scopeLeadingMatch(pipeline, tid, tenantMatch) };
}

function matchHasRestaurant(stage) {
    return stage && stage.$match && Object.prototype.hasOwnProperty.call(stage.$match, FIELD) && stage.$match[FIELD] !== undefined;
}

function scopeLeadingMatch(pipeline, tid, tenantMatch) {
    const first = pipeline[0];
    if (matchHasRestaurant(first)) {
        const v = first.$match[FIELD];
        if (!isPlainOperatorObject(v) && !same(v, tid)) {
            throw new TenantMismatchError(`pipeline $match restaurant ${String(v)} does not match tenant ${String(tid)}`);
        }
        if (!isPlainOperatorObject(v)) return pipeline;
    }
    return [tenantMatch, ...pipeline];
}

/** Strict pipeline scoping: leading $match on restaurant (or merge/verify). */
function scopePipelineStrict(pipeline, restaurantId) {
    const tid = requireTenantId(restaurantId, 'tenantAggregate');
    const stages = Array.isArray(pipeline) ? pipeline : [];
    const first = stages[0];
    if (first && first.$match && typeof first.$match === 'object') {
        const m = scopeFilterStrict(first.$match, tid, 'pipeline[0].$match');
        return [{ ...first, $match: m }, ...stages.slice(1)];
    }
    // $geoNear / $search must remain first
    const firstOp = first && typeof first === 'object' ? Object.keys(first)[0] : null;
    const mustBeFirst = ['$geoNear', '$search', '$searchMeta', '$vectorSearch'];
    if (firstOp && mustBeFirst.includes(firstOp)) {
        return [first, { $match: { [FIELD]: tid } }, ...stages.slice(1)];
    }
    return [{ $match: { [FIELD]: tid } }, ...stages];
}

// ── Wrappers ─────────────────────────────────────────────────────────

function tenantBulkWrite(Model, ops, restaurantId, options) {
    return Model.bulkWrite(scopeBulkOps(ops, restaurantId), options);
}

function tenantInsertMany(Model, docs, restaurantId, options) {
    return Model.insertMany(scopeDocs(docs, restaurantId), options);
}

function tenantLookup(spec, restaurantId) {
    return { $lookup: scopeLookupSpec(spec, restaurantId, '$lookup') };
}

function tenantUnionWith(spec, restaurantId) {
    return { $unionWith: scopeLookupSpec(spec, restaurantId, '$unionWith') };
}

/**
 * Model.aggregate with a tenant $match guaranteed first. $lookup /
 * $unionWith stages inside `pipeline` are NOT rewritten — build them with
 * tenantLookup() / tenantUnionWith().
 */
function tenantAggregate(Model, pipeline, restaurantId, options) {
    const agg = Model.aggregate(scopePipelineStrict(pipeline, restaurantId));
    if (options && typeof agg.option === 'function') agg.option(options);
    return agg;
}

/** Tenant-scoped replacement for estimatedDocumentCount (which cannot filter). */
function tenantEstimatedCount(Model, restaurantId) {
    return Model.countDocuments({ [FIELD]: requireTenantId(restaurantId, 'tenantEstimatedCount') });
}

module.exports = {
    runAsTenant,
    runAsSystem,
    isSystemContext,
    tenantBulkWrite,
    tenantInsertMany,
    tenantLookup,
    tenantUnionWith,
    tenantAggregate,
    tenantEstimatedCount,
    scopeBulkOps,
    scopeDoc,
    scopeDocs,
    scopeFilterStrict,
    scopeLookupSpec,
    scopePipelineStrict,
    strictContext,
    TenantMismatchError,
    TenantContextError,
};
