/**
 * #35 — cross-instance cache invalidation bus.
 *
 * In-process caches (settingsCache, listCache, …) invalidate themselves
 * locally on a write. With several backend instances the OTHER instances
 * would keep serving the old value until their TTL expires. This bus
 * forwards invalidations to every other instance.
 *
 *   cacheBus.subscribe('settings', (msg) => applyLocally(msg));
 *   cacheBus.publish('settings', { tenantPrefix: '<rid>:' });
 *
 * Transport:
 *   - REDIS_URL set  → utils/socket.js installs a transport that uses
 *                      io.serverSideEmit() over the socket.io Redis
 *                      adapter (no extra Redis connection).
 *   - otherwise      → no transport; publish() is a no-op and caches rely
 *                      on their (short) TTLs. Correct for a single
 *                      instance, where local invalidation is enough.
 *
 * publish() never delivers to the local instance — callers invalidate
 * locally first, then publish. Messages must be plain JSON.
 */
const logger = require('./logger');

const handlers = new Map(); // channel → Set<fn>
let transport = null;

function subscribe(channel, fn) {
    if (!handlers.has(channel)) handlers.set(channel, new Set());
    handlers.get(channel).add(fn);
    return () => handlers.get(channel)?.delete(fn);
}

function publish(channel, msg) {
    if (!transport) return false;
    try {
        transport.publish(channel, msg);
        return true;
    } catch (err) {
        logger.warn('cacheBus publish failed', { channel, error: err.message });
        return false;
    }
}

/** Called by the transport when a message arrives from another instance. */
function deliver(channel, msg) {
    const set = handlers.get(channel);
    if (!set) return;
    for (const fn of set) {
        try { fn(msg); } catch (err) {
            logger.warn('cacheBus handler failed', { channel, error: err.message });
        }
    }
}

function setTransport(t) { transport = t || null; }
function hasTransport() { return !!transport; }

module.exports = { subscribe, publish, deliver, setTransport, hasTransport };
