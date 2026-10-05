// Singleton Socket.io instance + tenant-scoped emit helpers.
//   const { getIO, emitToStaff, emitToAdmin, emitToKitchen, emitToWaiter } = require('./utils/socket');
//
// BUG #6 — every staff room is tenant-namespaced (see utils/socketRooms.js
// for the full scheme). There are no global 'admin' / 'kitchen' / 'waiter'
// rooms: sockets are auto-joined on connect from their authenticated
// identity (JWT or QR scan token), and every emit helper resolves the
// tenant before sending. If the tenant can't be determined the event is
// logged and DROPPED — never broadcast platform-wide.
let io = null;

const { AsyncLocalStorage } = require('async_hooks');
const logger = require('./logger');
const rooms = require('./socketRooms');

const { STAFF_ROLES, toId, isObjectId, emitRoomsFor, autoRoomsFor, canJoinWith, parseLegacyStaffRoom, menuRoom, tenantRoom } = rooms;

// ── Small TTL caches for id → tenant lookups ───────────────────────────
// Branch / order / table → restaurant links never change in practice, so
// a short TTL is only there to bound memory and pick up manual DB surgery.
//
// #35 multi-instance note: each instance has its own copy. Because the
// cached value (which tenant owns a branch/order/table) is immutable
// after creation, per-instance copies cannot disagree in normal
// operation; only negative results are never cached, so a freshly
// created branch is picked up immediately everywhere. Worst case after
// manual DB surgery: one TTL (5 min) of stale routing per instance.
// Bounded by the max-entry caps below.
function makeCache(max, ttlMs) {
    const m = new Map();
    return {
        get(k) {
            const hit = m.get(k);
            if (!hit) return undefined;
            if (Date.now() - hit.ts > ttlMs) { m.delete(k); return undefined; }
            return hit.v;
        },
        set(k, v) {
            m.set(k, { v, ts: Date.now() });
            if (m.size > max) m.delete(m.keys().next().value);
        },
        clear() { m.clear(); },
    };
}
const TENANT_LOOKUP_TTL_MS = 5 * 60 * 1000;
const _branchTenant = makeCache(1000, TENANT_LOOKUP_TTL_MS);
const _orderTenant = makeCache(5000, TENANT_LOOKUP_TTL_MS);
const _tableTenant = makeCache(2000, TENANT_LOOKUP_TTL_MS);

async function lookupTenant(cache, key, loader) {
    if (!key) return null;
    const k = String(key);
    const cached = cache.get(k);
    if (cached !== undefined) return cached;
    try {
        const rid = await loader(k);
        const v = rid ? String(rid) : null;
        if (v) cache.set(k, v);
        return v;
    } catch {
        return null;
    }
}

function getBranchTenant(branchId) {
    if (!isObjectId(String(branchId || ''))) return Promise.resolve(null);
    return lookupTenant(_branchTenant, branchId, async (id) => {
        const Branch = require('../models/branch');
        const b = await Branch.findById(id).select('restaurant').lean();
        return b?.restaurant;
    });
}
function getOrderTenant(orderId) {
    return lookupTenant(_orderTenant, orderId, async (id) => {
        const Order = require('../models/order');
        const o = await Order.findOne({ orderId: String(id) }).select('restaurant').lean();
        return o?.restaurant;
    });
}
function getTableTenant(tableId) {
    if (!isObjectId(String(tableId || ''))) return Promise.resolve(null);
    return lookupTenant(_tableTenant, tableId, async (id) => {
        const Table = require('../models/table');
        const t = await Table.findById(id).select('restaurant').lean();
        return t?.restaurant;
    });
}
async function getWithdrawalTenant(id) {
    if (!isObjectId(String(id || ''))) return null;
    try {
        const W = require('../models/staffWithdrawal');
        const w = await W.findById(id).select('restaurant').lean();
        return w?.restaurant ? String(w.restaurant) : null;
    } catch { return null; }
}
async function getUserTenant(id) {
    if (!isObjectId(String(id || ''))) return null;
    try {
        const User = require('../models/user');
        const u = await User.findById(id).select('restaurant').lean();
        return u?.restaurant ? String(u.restaurant) : null;
    } catch { return null; }
}

// ── Request-scoped tenant context ──────────────────────────────────────
// Many callers emit with branchId = null and a payload like
// { title, description } that carries no tenant hint. Inside an HTTP
// request the tenant is known (req.restaurant from attachTenant), so we
// capture the request in AsyncLocalStorage and read it at emit time.
//
// init() installs this automatically by prepending a listener on the
// http server's 'request' event (EventEmitter listeners run in the same
// synchronous execution, so enterWith() carries into Express). The
// exported `socketRequestContext` middleware does the same explicitly
// for apps that prefer mounting it.
//
// Safety: a timer created during a request inherits its store forever,
// so the ALS tenant is only trusted while the response is in flight or
// within ALS_GRACE_MS of it finishing.
const requestStore = new AsyncLocalStorage();
const ALS_GRACE_MS = 30 * 1000;

function enterRequest(req, res) {
    const store = { req, finishedAt: null };
    if (res && typeof res.once === 'function') {
        const done = () => { if (!store.finishedAt) store.finishedAt = Date.now(); };
        res.once('finish', done);
        res.once('close', done);
    }
    return store;
}

exports.socketRequestContext = (req, res, next) => {
    requestStore.run(enterRequest(req, res), next);
};

function tenantFromRequestContext() {
    const store = requestStore.getStore();
    if (!store || !store.req) return null;
    if (store.finishedAt && Date.now() - store.finishedAt > ALS_GRACE_MS) return null;
    const req = store.req;
    const rid = toId(req.restaurant) || toId(req.user?.restaurant);
    return rid && isObjectId(rid) ? rid : null;
}

// ── Tenant resolution for emit helpers ─────────────────────────────────
function payloadTenantHint(payload) {
    if (!payload || typeof payload !== 'object') return null;
    for (const key of ['restaurant', 'restaurantId', 'tenantId']) {
        const v = toId(payload[key]);
        if (v && isObjectId(v)) return v;
    }
    return null;
}

/**
 * Synchronous best-effort tenant resolution. Returns a restaurant id, or
 * undefined when an async lookup is required.
 */
function resolveTenantSync(branchArg, payload) {
    // A populated branch doc carries its tenant.
    if (branchArg && typeof branchArg === 'object' && branchArg.restaurant) {
        const r = toId(branchArg.restaurant);
        if (r && isObjectId(r)) return r;
    }
    const branchId = toId(branchArg);
    if (branchId) {
        const cached = _branchTenant.get(branchId);
        if (cached) return cached;
        return undefined; // branch is authoritative → look it up
    }
    const hint = payloadTenantHint(payload);
    if (hint) return hint;
    const fromReq = tenantFromRequestContext();
    if (fromReq) return fromReq;
    if (payload && payload.orderId) {
        const c = _orderTenant.get(String(payload.orderId));
        if (c) return c;
    }
    if (payload && payload.tableId) {
        const c = _tableTenant.get(String(toId(payload.tableId)));
        if (c) return c;
    }
    return undefined;
}

async function resolveTenantAsync(branchArg, payload) {
    const branchId = toId(branchArg);
    if (branchId) return getBranchTenant(branchId);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.orderId) {
        const r = await getOrderTenant(payload.orderId);
        if (r) return r;
    }
    const tableId = toId(payload.tableId) || toId(payload.table);
    if (tableId) {
        const r = await getTableTenant(tableId);
        if (r) return r;
    }
    if (payload.withdrawalId) {
        const r = await getWithdrawalTenant(payload.withdrawalId);
        if (r) return r;
    }
    const staffId = toId(payload.userId) || toId(payload.staffId);
    if (staffId) {
        const r = await getUserTenant(staffId);
        if (r) return r;
    }
    return null;
}

/**
 * Resolve the tenant for an emit and run `send(restaurantId)`. Synchronous
 * when possible (keeps event ordering), otherwise after a cached lookup.
 * Unresolvable → logged + dropped.
 */
function withTenant(branchArg, payload, event, send) {
    const dropped = () => logger.warn('socket emit dropped: tenant unresolved', {
        event, branch: toId(branchArg), orderId: payload?.orderId,
    });
    const sync = resolveTenantSync(branchArg, payload);
    if (sync) { send(sync); return; }
    resolveTenantAsync(branchArg, payload)
        .then((rid) => (rid ? send(rid) : dropped()))
        .catch((err) => logger.warn('socket emit failed:', err.message));
}

function emitToRoles(ioInstance, roles, branchArg, event, payload) {
    if (!ioInstance) return;
    const branchId = toId(branchArg);
    withTenant(branchArg, payload, event, (rid) => {
        const targets = [];
        for (const role of roles) targets.push(...emitRoomsFor(rid, role, branchId));
        if (targets.length) ioInstance.to(targets).emit(event, payload);
    });
}

// ── Legacy raw-room safety net ─────────────────────────────────────────
// A few callers still do `io.to('captain')` / `io.to('kitchen:<branch>')`
// directly. Translate those names to the tenant-namespaced rooms using
// the request context; if the tenant is unknown the name is rewritten to
// a room nobody can join, so a legacy call can never broadcast globally.
const DEAD_ROOM = '__tenant_unresolved__';
function translateRoom(room) {
    if (typeof room !== 'string') return room;
    const legacy = parseLegacyStaffRoom(room);
    if (!legacy) return room;
    let rid = null;
    if (legacy.branchId) rid = _branchTenant.get(legacy.branchId) || null;
    if (!rid) rid = tenantFromRequestContext();
    if (!rid) {
        logger.warn('socket legacy room emit dropped: tenant unresolved', { room });
        return DEAD_ROOM;
    }
    return legacy.branchId
        ? tenantRoom(rid, legacy.role, legacy.branchId)
        : tenantRoom(rid, legacy.role);
}
function translateRooms(r) {
    return Array.isArray(r) ? r.map(translateRoom) : translateRoom(r);
}
function wrapOperator(op) {
    return new Proxy(op, {
        get(target, prop, receiver) {
            if (prop === 'to' || prop === 'in') {
                return (r) => wrapOperator(target[prop](translateRooms(r)));
            }
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== 'function') return v;
            return (...args) => {
                const out = v.apply(target, args);
                // except()/timeout()/compress() return a new operator — keep guarding it.
                const isOperator = out && out !== target && typeof out === 'object'
                    && typeof out.to === 'function' && typeof out.emit === 'function';
                return isOperator ? wrapOperator(out) : out;
            };
        },
    });
}
function guardServer(server) {
    for (const m of ['to', 'in']) {
        const orig = server[m].bind(server);
        server[m] = (r) => wrapOperator(orig(translateRooms(r)));
    }
}

// ── Join authorization ────────────────────────────────────────────────
async function findOrderForJoin(orderId) {
    const Order = require('../models/order');
    return Order.findOne({ orderId: String(orderId) })
        .select('user table scanSessionId restaurant branch')
        .lean();
}

async function canJoin(socket, room) {
    return canJoinWith(socket.data, room, {
        getBranchTenant,
        findOrder: findOrderForJoin,
        warn: (msg, meta) => logger.warn(msg, meta),
    });
}

// ── #35 — multi-instance adapter ──────────────────────────────────────
// REDIS_URL set   → @socket.io/redis-adapter: every io.to(room).emit()
//                   reaches sockets connected to ANY instance, and
//                   io.serverSideEmit() carries cache invalidations
//                   (utils/cacheBus.js) between instances.
// REDIS_URL unset → socket.io's default in-memory adapter. Correct for a
//                   single instance only: with 2+ instances an emit
//                   reaches only sockets on the emitting instance.
// Room helpers above only use io.to()/socket.join(), which every adapter
// implements, so nothing else changes between the two modes.
let _redisClients = [];
let _multiInstance = false;
const CACHE_BUS_EVENT = 'bd:cache-bus';

function throttledErrorLogger(label) {
    let last = 0;
    return (err) => {
        const now = Date.now();
        if (now - last < 30 * 1000) return; // reconnect loops fire this constantly
        last = now;
        logger.error(`socket.io redis ${label} error: ${err?.message || err}`);
    };
}

function attachAdapter(ioServer) {
    const url = (process.env.REDIS_URL || '').trim();
    if (!url) {
        _multiInstance = false;
        logger.info('socket.io: REDIS_URL not set — in-memory adapter (single-instance mode). Set REDIS_URL before running more than one backend instance.');
        return false;
    }
    const { createClient } = require('redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pub = createClient({ url });
    const sub = pub.duplicate();
    pub.on('error', throttledErrorLogger('pub'));
    sub.on('error', throttledErrorLogger('sub'));
    // connect() marks the clients open synchronously, so the adapter's
    // SUBSCRIBE calls below are queued until the connection is up.
    Promise.all([pub.connect(), sub.connect()])
        .then(() => {
            // connect() also settles when the client is closed during shutdown.
            if (pub.isReady && sub.isReady) logger.info('socket.io: Redis adapter connected (multi-instance mode)');
        })
        .catch((err) => logger.error(`socket.io: Redis adapter connect failed: ${err.message} — live updates will not cross instances until Redis is reachable`));
    ioServer.adapter(createAdapter(pub, sub));
    _redisClients = [pub, sub];
    _multiInstance = true;

    // Cross-instance cache invalidation over the same Redis channel.
    const cacheBus = require('./cacheBus');
    cacheBus.setTransport({
        publish: (channel, msg) => ioServer.serverSideEmit(CACHE_BUS_EVENT, { channel, msg }),
    });
    ioServer.on(CACHE_BUS_EVENT, (payload) => {
        if (payload && typeof payload.channel === 'string') cacheBus.deliver(payload.channel, payload.msg);
    });
    return true;
}

exports.isMultiInstance = () => _multiInstance;

/**
 * Graceful shutdown: disconnect sockets, close the engine (and the
 * attached http server), then close the Redis adapter clients.
 */
exports.close = async () => {
    const instance = io;
    if (instance) {
        await new Promise((resolve) => {
            try { instance.close(() => resolve()); } catch { resolve(); }
        });
    }
    io = null;
    try { require('./cacheBus').setTransport(null); } catch { /* ignore */ }
    const clients = _redisClients;
    _redisClients = [];
    await Promise.allSettled(clients.map(async (c) => {
        if (!c.isOpen) return;
        // A client still retrying its connection never settles close()/quit();
        // destroy() drops it immediately.
        if (!c.isReady) {
            if (typeof c.destroy === 'function') c.destroy(); else await c.disconnect();
            return;
        }
        await (typeof c.close === 'function' ? c.close() : c.quit());
    }));
};

exports.init = (server, allowedOrigins) => {
    const { Server } = require('socket.io');

    // Request-context capture (see socketRequestContext above).
    if (server && typeof server.prependListener === 'function') {
        server.prependListener('request', (req, res) => {
            try { requestStore.enterWith(enterRequest(req, res)); } catch { /* ignore */ }
        });
    }

    io = new Server(server, {
        cors: {
            // Either the explicit origin list, or app.js's isOriginAllowed
            // predicate (honours CORS_ALLOW_LAN — LAN phones in dev).
            origin: typeof allowedOrigins === 'function'
                ? (origin, cb) => cb(null, allowedOrigins(origin))
                : allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true,
        },
    });
    try {
        attachAdapter(io);
    } catch (err) {
        // Never block boot on Redis — fall back to in-memory and say so.
        _multiInstance = false;
        logger.error(`socket.io: Redis adapter setup failed (${err.message}) — falling back to in-memory adapter (single-instance mode)`);
    }
    guardServer(io);

    // Connection-time auth — read JWT / scan token from handshake.auth
    // (set by Frontend/src/utils/socket.js). Populate socket.data so the
    // auto-join + `join` gate can check identity without hitting the DB.
    io.use(async (socket, next) => {
        try {
            const { token, scanToken } = socket.handshake.auth || {};
            // Lazy require — authMiddleware pulls in models; keep this
            // module loadable in isolation (tests, scripts).
            const auth = require('../middlewares/authMiddleware');
            if (token) {
                let decoded = null;
                try {
                    // Only USER session tokens (typ:'user' or legacy
                    // {id, role}) are accepted — a scan / kiosk token
                    // presented here is ignored.
                    decoded = auth.verifyUserToken(token);
                } catch (err) {
                    if (err && err.name === 'TokenExpiredError') {
                        // Tell the client to refresh its access token and
                        // reconnect (Frontend utils/socket.js handles it).
                        const e = new Error('AUTH_EXPIRED');
                        e.data = { code: 'AUTH_EXPIRED' };
                        return next(e);
                    }
                    decoded = null; // malformed / wrong type → guest
                }
                if (decoded && decoded.id) {
                    try {
                        // Rejects tokens whose tokenVersion was revoked
                        // (logout-all / password change).
                        const u = await auth.loadUserForToken(decoded);
                        if (!u) {
                            const e = new Error('AUTH_REVOKED');
                            e.data = { code: 'AUTH_REVOKED' };
                            return next(e);
                        }
                        if (u.status === 'inactive') {
                            // deactivated → no authenticated identity
                        } else {
                            socket.data.userId = String(u._id);
                            // DB role wins over a stale token role.
                            socket.data.role = u.role || decoded.role || null;
                            if (STAFF_ROLES.has(socket.data.role)) {
                                socket.data.branchId = u.branch ? String(u.branch._id || u.branch) : null;
                            }
                            socket.data.restaurant = u.restaurant ? String(u.restaurant._id || u.restaurant) : null;
                        }
                    } catch {
                        // DB hiccup — no verified identity, so no tenant
                        // rooms (fail closed); the client can still use
                        // its scan token below.
                        socket.data.userId = null;
                        socket.data.role = null;
                        socket.data.restaurant = null;
                    }
                }
            }
            if (scanToken) {
                try {
                    // verifyTypedToken enforces `exp` (R-09) and the scan
                    // type (legacy untyped scan tokens still accepted).
                    const decoded = auth.verifyTypedToken(scanToken, auth.TOKEN_TYPES.SCAN);
                    if (decoded.tableId) {
                        socket.data.scan = {
                            tableId: String(decoded.tableId),
                            restaurantId: decoded.restaurantId ? String(decoded.restaurantId) : null,
                            sessionId: decoded.sessionId || null,
                        };
                    }
                } catch { /* invalid/expired scan token → ignore */ }
            }
            next();
        } catch (err) {
            logger.warn('Socket auth error:', err.message);
            next();
        }
    });

    io.on('connection', (socket) => {
        // Server-side auto-join from the authenticated identity. Runs on
        // every (re)connection, so a dropped socket is back in its rooms
        // as soon as it reconnects (BUG #12).
        try {
            const auto = autoRoomsFor(socket.data);
            if (auto.length) socket.join(auto);
        } catch (err) {
            logger.warn('Socket auto-join failed:', err.message);
        }

        // Clients may still ask for per-resource rooms (order:<id>,
        // table:<id>, t:<rid>:menu, explicit tenant rooms for admins).
        socket.on('join', async (room) => {
            try {
                if (await canJoin(socket, room)) socket.join(room);
            } catch (err) {
                logger.warn('Socket join failed:', err.message);
            }
        });
        socket.on('leave', (room) => {
            if (typeof room === 'string' && room) socket.leave(room);
        });
        socket.on('disconnect', () => {});
    });

    return io;
};

exports.getIO = () => {
    if (!io) throw new Error('Socket.io not initialized — call init(server) first');
    return io;
};

// ── Emit helpers (signatures unchanged) ────────────────────────────────
// branchId may be an id, a populated branch doc, or null. The tenant is
// derived from: the branch → payload.restaurant/restaurantId/tenantId →
// the current HTTP request's tenant → payload.orderId / tableId /
// withdrawalId / userId lookups. Unresolvable → dropped + logged.

/**
 * Chainable emitter for one role at a branch. Only works when the tenant
 * is synchronously known (request context / cached branch / explicit
 * restaurantId); otherwise returns an operator on a dead room.
 */
exports.staffRoom = (ioInstance, role, branchId, restaurantId = null) => {
    const rid = toId(restaurantId) || resolveTenantSync(branchId, null);
    if (!rid) {
        logger.warn('staffRoom: tenant unresolved, emit will be dropped', { role, branch: toId(branchId) });
        return ioInstance.to(DEAD_ROOM);
    }
    return ioInstance.to(emitRoomsFor(rid, role, toId(branchId)));
};

/** admin + waiter + kitchen at a branch (null = tenant-level). */
exports.emitToStaff = (ioInstance, branchId, event, payload) =>
    emitToRoles(ioInstance, ['admin', 'waiter', 'kitchen'], branchId, event, payload);

exports.emitToAdmin = (ioInstance, branchId, event, payload) =>
    emitToRoles(ioInstance, ['admin'], branchId, event, payload);

exports.emitToKitchen = (ioInstance, branchId, event, payload) =>
    emitToRoles(ioInstance, ['kitchen'], branchId, event, payload);

exports.emitToWaiter = (ioInstance, branchId, event, payload) =>
    emitToRoles(ioInstance, ['waiter'], branchId, event, payload);

/** New: captain rooms (replaces raw io.to('captain') / 'captain:<branch>'). */
exports.emitToCaptain = (ioInstance, branchId, event, payload) =>
    emitToRoles(ioInstance, ['captain'], branchId, event, payload);

/**
 * BUG #24 — public menu change ping for one tenant. Payload should carry
 * only public info ({ itemIds, branch, reason }).
 */
exports.emitMenuUpdated = (restaurantId, payload = {}) => {
    if (!io) return;
    const rid = toId(restaurantId) || tenantFromRequestContext();
    if (!rid || !isObjectId(rid)) {
        logger.warn('menu:updated dropped: tenant unresolved');
        return;
    }
    try {
        io.to(menuRoom(rid)).emit('menu:updated', { ...payload, restaurant: rid, at: Date.now() });
    } catch (err) {
        logger.warn('menu:updated emit failed:', err.message);
    }
};

/** Platform-operator room. Never receives tenant data unless sent here explicitly. */
exports.emitToSuperadmin = (event, payload) => {
    if (!io) return;
    try { io.to(rooms.SUPERADMIN_ROOM).emit(event, payload); } catch { /* ignore */ }
};

/**
 * CRIT-23/24 — tell a user's connected sockets to refresh their auth.
 * Safe to call before io is initialised (no-op) or with a null userId.
 */
exports.notifyAuthReload = (userId, reason = 'server-change') => {
    if (!userId || !io) return;
    try {
        io.to(String(userId)).emit('auth:reload', { reason });
    } catch (err) {
        logger.warn('notifyAuthReload emit failed:', err.message);
    }
};

// Exposed for tests / diagnostics.
exports._internals = {
    canJoin,
    resolveTenantSync,
    resolveTenantAsync,
    translateRoom,
    requestStore,
    enterRequest,
    caches: { branch: _branchTenant, order: _orderTenant, table: _tableTenant },
};
