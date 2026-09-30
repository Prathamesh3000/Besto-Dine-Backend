const Settings = require('../models/settings');

/**
 * Per-(tenant, branch) settings cache.
 *
 * Each Settings document is keyed by (restaurant, branch). The branch
 * is resolved from req.user.branch (staff pin). Customer/guest requests
 * with no pin fall through to the tenant-level (branch=null) document.
 *
 * Backwards-compatible call signatures:
 *
 *   getSettings(req)            — preferred. Reads req.restaurant._id
 *                                 and the pinned branch from req.user.
 *   getSettings(restaurantId)   — explicit tenant id (ObjectId or string),
 *                                 tenant-level (branch=null) doc.
 *   getSettings()               — legacy single-tenant fallback.
 *
 * invalidateCache(req) clears every entry for the caller's tenant (see
 * below). invalidateCache() with no args clears everything.
 *
 * #35 multi-instance: each backend instance has its own copy of this
 * cache. A settings write invalidates locally AND, when REDIS_URL is set,
 * on every other instance via utils/cacheBus (socket.io Redis adapter).
 * Without Redis, another instance can serve the old settings for up to
 * TTL_MS (60 s) after a write — that bounded staleness is the reason the
 * TTL is short. Entry count is capped at MAX_ENTRIES (oldest evicted).
 */

const cacheBus = require('./cacheBus');

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;
const BUS_CHANNEL = 'settings';
const cache = new Map();   // key → { value, expires }
// Bumped on every invalidation so a load that started before a write
// does not re-cache the pre-write value after the invalidation.
let generation = 0;

const KEY_LEGACY = '__legacy__';

// Resolve the branch for cache-keying. Staff pin (req.user.branch) wins;
// for customers/guests we fall back to the X-Branch-Id resolved by
// attachTenant (req.branch._id) so per-branch settings cache hits the
// right document. Tenant-owner staff (no pin) explicitly bypass the
// fallback so they always see/edit the tenant-level (branch=null) doc.
function resolveBranchIdFromReq(req) {
    const pinned = req?.user?.branch;
    if (pinned) return pinned._id || pinned;
    const role = req?.user?.role;
    const isStaff = role && role !== 'customer';
    if (isStaff) return null;
    const b = req?.branch?._id;
    return b || null;
}

function resolveKey(arg) {
    if (!arg) return KEY_LEGACY;
    // Express req object with attachTenant middleware applied.
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

// Sections that a sub-branch / customer view inherits from the tenant-level
// (branch:null) doc. Mirrors INHERITED_SECTIONS in settingsController.js — the
// GET endpoint already merges these for customer reads, but server-side
// consumers (notification gates in orderController, requestController, etc.)
// were reading the raw branch doc and silently bypassing toggles the
// tenant-owner had saved at the tenant level.
const INHERITED_SECTIONS = ['taxes', 'reservation', 'wallet', 'notifications', 'operatingHours', 'delivery'];

async function loadSettings(key) {
    if (key === KEY_LEGACY) {
        return Settings.findOne().lean();
    }
    const [restaurant, branchPart] = key.split(':');
    const branch = branchPart === 'null' ? null : branchPart;
    const branchDoc = await Settings.findOne({ restaurant, branch }).lean();

    // Tenant-level reads return as-is.
    if (branch === null) return branchDoc;

    // Branch-scoped reads inherit INHERITED_SECTIONS from the
    // authoritative tenant-wide doc. The admin who edits notifications
    // may have written either to the tenant-level (branch:null) doc
    // (tenant owner with no pin) or to the main-branch doc (main-branch
    // admin). Prefer tenant-level when present, then fall back to the
    // main branch doc. Without this fallback, a customer/guest order
    // placement reads only the branch:<X> doc — which is either missing
    // or carries schema defaults — and the notification gate silently
    // bypasses the toggle the admin saved elsewhere.
    const tenantDoc = await Settings.findOne({ restaurant, branch: null }).lean();
    let authoritative = tenantDoc;
    if (!authoritative) {
        const { getMainBranchId } = require('./mainBranch');
        const mainBranchId = await getMainBranchId({ restaurant: { _id: restaurant } });
        if (mainBranchId && String(mainBranchId) !== String(branch)) {
            authoritative = await Settings.findOne({ restaurant, branch: mainBranchId }).lean();
        }
    }
    if (!authoritative) return branchDoc;
    if (!branchDoc) return authoritative;

    const merged = { ...branchDoc };
    for (const section of INHERITED_SECTIONS) {
        if (authoritative[section] !== undefined) {
            merged[section] = authoritative[section];
        }
    }
    return merged;
}

exports.getSettings = async (arg) => {
    const key = resolveKey(arg);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const gen = generation;
    const value = await loadSettings(key);
    if (gen !== generation) return value;
    cache.delete(key); // re-insert at the end → Map order ≈ LRU-by-write
    cache.set(key, { value, expires: Date.now() + TTL_MS });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return value;
};

// Apply an invalidation descriptor to THIS instance's cache.
//   { all: true } | { key } | { tenantPrefix }
function applyInvalidation(d) {
    if (!d || typeof d !== 'object') return;
    generation += 1;
    if (d.all) { cache.clear(); return; }
    if (typeof d.key === 'string') { cache.delete(d.key); return; }
    if (typeof d.tenantPrefix === 'string' && d.tenantPrefix) {
        for (const k of cache.keys()) {
            if (k.startsWith(d.tenantPrefix)) cache.delete(k);
        }
    }
}

// Invalidations published by other instances.
cacheBus.subscribe(BUS_CHANNEL, applyInvalidation);

function invalidateEverywhere(d) {
    applyInvalidation(d);
    cacheBus.publish(BUS_CHANNEL, d);
}

exports.invalidateCache = (arg) => {
    if (arg === undefined) {
        invalidateEverywhere({ all: true });
        return;
    }
    // Settings inheritance means a write at one scope (tenant-level or
    // main-branch) flows into reads at every other branch scope under
    // the same tenant. Clear every cache entry for the tenant so the
    // next read picks up the fresh authoritative doc instead of a
    // stale inherited copy.
    const key = resolveKey(arg);
    if (key === KEY_LEGACY) {
        invalidateEverywhere({ key });
        return;
    }
    invalidateEverywhere({ tenantPrefix: key.split(':')[0] + ':' });
};

exports._internals = { cache, applyInvalidation, TTL_MS, MAX_ENTRIES };
