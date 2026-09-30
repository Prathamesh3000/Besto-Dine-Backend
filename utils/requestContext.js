/**
 * Request-scoped context (AsyncLocalStorage) — BUGS_REPORT #30 safety net.
 *
 * `attachTenant` (middlewares/tenantContext.js) opens a context for every
 * v1 request once it knows the tenant; everything that runs "inside" that
 * request (controllers, utils, Mongoose middleware, promise chains,
 * setImmediate callbacks scheduled by the handler) can then read the
 * current tenant without having `req` in hand. The Mongoose tenant-scope
 * plugin (utils/tenantScopePlugin.js) uses it to auto-scope queries that
 * forgot `tenantFilter(req)`.
 *
 * Store shape:
 *   {
 *     tenantId:     ObjectId | null   — req.restaurant._id (null for
 *                                       superadmin / exempt paths)
 *     branchId:     ObjectId | null   — req.branch._id
 *     userId:       ObjectId | null
 *     role:         string   | null
 *     isSuperadmin: boolean
 *     method, path: string            — for log context only
 *   }
 *
 * Outside a request (boot, seeds, scripts, setInterval jobs started at
 * boot, socket.io handlers) there is no store: getContext() returns null
 * and the plugin is a no-op.
 *
 * NOTE for background work started from inside a request that must run
 * platform-wide (e.g. an admin endpoint that kicks a cross-tenant sweep):
 * wrap it in `runWithoutContext(fn)` — timers/promises created inside a
 * request otherwise inherit that request's tenant.
 */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function getContext() {
    return als.getStore() || null;
}

function getTenantId() {
    const s = als.getStore();
    return (s && s.tenantId) || null;
}

/** Run `fn` inside a fresh context built from `store`. */
function runWithContext(store, fn) {
    return als.run(store, fn);
}

/**
 * Merge `patch` into the current store (if any). Returns the store or
 * null when called outside a request context. Used by authMiddleware to
 * record the user once `protect` resolves it, and by nested attachTenant
 * calls (route-level re-mounts) so we don't stack contexts.
 */
function updateContext(patch) {
    const s = als.getStore();
    if (!s) return null;
    Object.assign(s, patch);
    return s;
}

/** Run `fn` with NO request context (plugin becomes a no-op inside). */
function runWithoutContext(fn) {
    return als.exit(fn);
}

/** Build a store object from an Express req (tenant/branch/user). */
function contextFromRequest(req) {
    const user = req.user || null;
    return {
        tenantId: req.restaurant?._id || null,
        branchId: req.branch?._id || null,
        userId: user?._id || null,
        role: user?.role || null,
        isSuperadmin: user?.role === 'superadmin',
        method: req.method,
        path: `${req.baseUrl || ''}${req.path || ''}`,
    };
}

module.exports = {
    getContext,
    getTenantId,
    runWithContext,
    updateContext,
    runWithoutContext,
    contextFromRequest,
    // exposed for tests only
    _als: als,
};
