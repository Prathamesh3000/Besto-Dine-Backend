/**
 * Generic per-(tenant, branch) list cache for hot reads.
 *
 * Pattern mirrors utils/settingsCache.js — same key shape, same TTL,
 * same `invalidateCache` signature — but accepts an arbitrary loader
 * so you can plug it into any controller that reads frequently and
 * mutates rarely (categories, areas, addons, etc.).
 *
 * Usage in a controller:
 *
 *   const cache = require('../utils/listCache').create({
 *     name:    'categories',
 *     loader:  (req) => Category.find({ ...tenantFilter(req) }).lean(),
 *     ttlMs:   60_000,
 *   });
 *
 *   exports.getCategories = async (req, res) => {
 *     const data = await cache.get(req);
 *     res.json({ success: true, categories: data });
 *   };
 *
 *   exports.createCategory = async (req, res) => {
 *     // ... write ...
 *     cache.invalidate(req);
 *     res.json({ success: true });
 *   };
 *
 * Caches are intentionally local to each `create()` call so different
 * resources can't collide on key. The whole module exports a single
 * `invalidateAll()` helper for tests and admin escape hatches that
 * need to nuke every cache (e.g. tenant deleted).
 *
 * #35 multi-instance: every instance holds its own copy. invalidate()
 * clears the entry locally AND, when REDIS_URL is set, on every other
 * instance via utils/cacheBus (keyed by the cache name, so names must be
 * unique). Without Redis another instance may serve the old list for up
 * to ttlMs after a write — keep ttlMs short (default 60 s, capped at
 * MAX_TTL_MS). Each cache is capped at maxEntries keys (oldest evicted).
 */

const cacheBus = require('./cacheBus');

const KEY_LEGACY = '__legacy__';
const BUS_CHANNEL = 'listCache';
const MAX_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;
const _registry = new Set();
const _byName = new Map(); // name → handle (bus routing)

function resolveBranchIdFromReq(req) {
    const pinned = req?.user?.branch;
    if (pinned) return pinned._id || pinned;
    const role = req?.user?.role;
    const isStaff = role && role !== 'customer';
    if (isStaff) {
        // Tenant owner using the admin branch switcher passes
        // `?branch=<id>` (or 'all' / 'tenant-only'). Different values
        // produce different filtered results, so the cache key MUST
        // vary by the switcher value too — otherwise the first call's
        // result is served back for every subsequent switch. That was
        // the "areas show 0 after switching" bug.
        const raw = req?.query?.branch;
        if (raw === 'tenant-only' || raw === 'none') return 'tenant-only';
        if (raw === 'all') return 'all';
        if (raw && /^[a-f0-9]{24}$/i.test(String(raw))) return String(raw);
        return null;
    }
    const b = req?.branch?._id;
    return b || null;
}

function resolveKey(arg) {
    if (!arg) return KEY_LEGACY;
    if (typeof arg === 'object' && arg.restaurant) {
        const tenant = String(arg.restaurant._id);
        const branch = resolveBranchIdFromReq(arg);
        return `${tenant}:${branch ? String(branch) : 'null'}`;
    }
    if (typeof arg === 'object' && arg._id) {
        return `${String(arg._id)}:null`;
    }
    return `${String(arg)}:null`;
}

function create({ name, loader, ttlMs = 60_000, maxEntries = DEFAULT_MAX_ENTRIES }) {
    if (typeof loader !== 'function') {
        throw new Error('listCache.create({ loader }) must be a function');
    }
    ttlMs = Math.min(Math.max(0, Number(ttlMs) || 0), MAX_TTL_MS);
    const cache = new Map();   // key → { value, expires }
    const inflight = new Map(); // key → Promise — coalesces concurrent misses
    let generation = 0;        // bumped on invalidate; stale loads are not cached

    async function get(req) {
        const key = resolveKey(req);
        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) return hit.value;

        // Coalesce: if another request for the same key is already
        // loading, wait for it instead of firing a duplicate query.
        if (inflight.has(key)) return inflight.get(key);

        const gen = generation;
        const promise = (async () => {
            try {
                const value = await loader(req);
                if (gen === generation) {
                    cache.delete(key);
                    cache.set(key, { value, expires: Date.now() + ttlMs });
                    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
                }
                return value;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, promise);
        return promise;
    }

    // Local-only; a null key clears the whole cache.
    function invalidateLocal(key) {
        generation += 1;
        if (key === null || key === undefined) cache.clear();
        else cache.delete(key);
    }

    function invalidate(reqOrArg) {
        const key = reqOrArg === undefined ? null : resolveKey(reqOrArg);
        invalidateLocal(key);
        if (name) cacheBus.publish(BUS_CHANNEL, { name, key });
    }

    const handle = { name, get, invalidate, _invalidateLocal: invalidateLocal, _size: () => cache.size };
    _registry.add(handle);
    if (name) _byName.set(name, handle);
    return handle;
}

// Invalidations published by other instances.
cacheBus.subscribe(BUS_CHANNEL, (msg) => {
    if (!msg || typeof msg.name !== 'string') return;
    const h = _byName.get(msg.name);
    if (h) h._invalidateLocal(typeof msg.key === 'string' ? msg.key : null);
});

function invalidateAll() {
    for (const h of _registry) h.invalidate();
}

module.exports = { create, invalidateAll, MAX_TTL_MS };
