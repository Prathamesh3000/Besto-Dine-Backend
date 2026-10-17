/**
 * Rate limiters that hold across backend instances.
 *
 *   const { makeLimiter } = require('../utils/rateLimitStore');
 *   const loginLimiter = makeLimiter({ name: 'auth', windowMs: 15 * 60 * 1000, limit: 50, ... });
 *
 * `makeLimiter(options)` takes exactly the express-rate-limit options plus
 * an optional `name` (the Redis key prefix — give every limiter its own,
 * otherwise two limiters would share counters). Without REDIS_URL it is
 * plain `rateLimit(options)` with the in-memory store (correct for a
 * single instance).
 *
 * With REDIS_URL set, counters live in Redis (rate-limit-redis) so N
 * instances enforce ONE shared budget instead of N separate ones. All
 * limiters share a single Redis connection (separate from socket.io's
 * pub/sub pair — a subscriber connection cannot run commands).
 *
 * Redis outage behaviour: each limiter falls back to its own in-memory
 * counters while Redis is unreachable (per-instance limiting, never "no
 * limiting" and never a hung request), and switches back once the client
 * reconnects. Commands fail fast instead of queueing (disableOfflineQueue).
 */
'use strict';

const { rateLimit, MemoryStore } = require('express-rate-limit');
const logger = require('./logger');

let client = null;       // shared node-redis client (lazy)
let clientUrl = null;
let seq = 0;

function redisUrl() {
    return (process.env.REDIS_URL || '').trim();
}

function throttledLog(label) {
    let last = 0;
    return (msg) => {
        const now = Date.now();
        if (now - last < 30 * 1000) return;
        last = now;
        logger.error(`rate-limit redis ${label}: ${msg}`);
    };
}

function getClient() {
    const url = redisUrl();
    if (!url) return null;
    if (client && clientUrl === url) return client;
    const { createClient } = require('redis');
    client = createClient({ url, disableOfflineQueue: true });
    clientUrl = url;
    client.setMaxListeners(100); // one "ready" listener per limiter
    client.on('error', (() => {
        const log = throttledLog('error');
        return (err) => log(err?.message || String(err));
    })());
    client.connect()
        .then(() => { if (client?.isReady) logger.info('rate-limit: Redis store connected (limits shared across instances)'); })
        .catch((err) => logger.error(`rate-limit: Redis connect failed: ${err.message} — using per-instance memory counters until Redis is reachable`));
    return client;
}

/**
 * express-rate-limit Store that uses Redis while the shared client is
 * ready and an in-memory store otherwise.
 */
class ResilientRedisStore {
    constructor(redisClient, prefix) {
        const { RedisStore } = require('rate-limit-redis');
        this.client = redisClient;
        this.prefix = prefix;
        this.localKeys = false;
        this.memory = new MemoryStore();
        this.redis = new RedisStore({
            prefix,
            sendCommand: (...args) => redisClient.sendCommand(args),
        });
        this.redisReady = false;
        this.logFailure = throttledLog(`store ${prefix}`);
    }

    init(options) {
        this.memory.init(options);
        const load = () => {
            this.redis.init(options)
                .then(() => { this.redisReady = true; })
                .catch((err) => {
                    this.redisReady = false;
                    this.logFailure(`script load failed: ${err.message}`);
                });
        };
        // Re-load the Lua scripts on every (re)connect — a failed load at
        // boot would otherwise leave the RedisStore permanently broken.
        this.client.on('ready', load);
        if (this.client.isReady) load();
    }

    async call(method, ...args) {
        if (this.redisReady && this.client.isReady) {
            try {
                return await this.redis[method](...args);
            } catch (err) {
                this.logFailure(`${method} failed, using memory: ${err.message}`);
            }
        }
        return this.memory[method](...args);
    }

    get(key) { return this.call('get', key); }
    increment(key) { return this.call('increment', key); }
    decrement(key) { return this.call('decrement', key); }
    resetKey(key) { return this.call('resetKey', key); }
    shutdown() { this.memory.shutdown(); }
}

/**
 * @param {object} options express-rate-limit options, plus optional
 *   `name` — unique per limiter; becomes the Redis key prefix `rl:<name>:`.
 */
let warnedMemoryInProduction = false;

function makeLimiter(options = {}) {
    const { name, ...rlOptions } = options;
    const redisClient = rlOptions.store ? null : getClient();
    if (!redisClient) {
        if (process.env.NODE_ENV === 'production' && !warnedMemoryInProduction) {
            warnedMemoryInProduction = true;
            logger.warn('rate-limit store is in-memory in production — per-IP limits reset on restart and are per-instance. Set REDIS_URL. (The per-account login lockout lives in MongoDB `login_attempts` and is shared regardless.)');
        }
        return rateLimit(rlOptions);
    }
    seq += 1;
    const id = name || `anon${seq}-${rlOptions.windowMs || 60000}-${rlOptions.limit ?? rlOptions.max ?? 5}`;
    if (!name) logger.warn(`rate-limit: limiter created without a name — using Redis prefix "rl:${id}:". Pass { name } for stable keys.`);
    return rateLimit({ ...rlOptions, store: new ResilientRedisStore(redisClient, `rl:${id}:`) });
}

/** Close the shared Redis client (graceful shutdown). Safe to call twice. */
async function close() {
    const c = client;
    client = null;
    clientUrl = null;
    if (!c || !c.isOpen) return;
    try {
        if (!c.isReady) {
            if (typeof c.destroy === 'function') c.destroy(); else await c.disconnect();
            return;
        }
        await (typeof c.close === 'function' ? c.close() : c.quit());
    } catch { /* ignore */ }
}

function isShared() { return !!client; }

module.exports = { makeLimiter, close, isShared, ResilientRedisStore };
