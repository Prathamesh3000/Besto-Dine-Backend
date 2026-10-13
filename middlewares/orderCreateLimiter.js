/**
 * Per-actor rate limit on POST /orders (CRIT-13).
 *
 * The global 200/min limiter in app.js is per-IP and too generous for
 * guest traffic on a QR flow where one scanToken could be shared (or
 * leaked) across devices. This keyed limiter caps order creates per
 * logical actor per minute:
 *
 *   staff (admin/manager/captain/waiter/chef) → 60/min per user  (STAFF_LIMIT)
 *   customers                                 →  5/min per user  (GUEST_LIMIT)
 *   guests at a table                         →  5/min per tableId
 *   anonymous takeaway / kiosk                →  5/min per IP (/56 for IPv6)
 *
 * Why two tiers: the original flat 5/min was meant for customers and
 * anonymous kiosk flood protection, but a cashier punching in takeaway
 * orders at the counter hits it on the 6th order of a busy minute
 * (desktop soak, 2026-10-13). 60/min is still a hard flood / brute-force
 * ceiling for a stolen staff token, but no human at a till reaches it.
 *
 * The limiter MUST run after optionalAuth — before it `req.user` is
 * unset, so every staff request fell through to the table / IP key and a
 * whole counter behind one NAT shared a single 5/min budget.
 *
 * Still memory-backed without REDIS_URL — see utils/rateLimitStore.
 */
'use strict';

const { ipKeyGenerator } = require('express-rate-limit');
const { makeLimiter } = require('../utils/rateLimitStore');

const STAFF_ROLES = Object.freeze(['admin', 'manager', 'captain', 'waiter', 'chef']);
const STAFF_LIMIT = 60;
const GUEST_LIMIT = 5;
const WINDOW_MS = 60 * 1000;

const isStaff = (req) => Boolean(req.user?.role && STAFF_ROLES.includes(req.user.role));

/** express-rate-limit `limit` option: per-request ceiling for the window. */
function orderCreateLimitFor(req) {
    return isStaff(req) ? STAFF_LIMIT : GUEST_LIMIT;
}

/** express-rate-limit `keyGenerator` option: the logical actor. */
function orderCreateLimitKey(req) {
    if (req.user?._id) return 'user:' + String(req.user._id);
    const tableId = req.body?.tableId || req.body?.table;
    if (tableId) return 'table:' + String(tableId);
    // IPv6-safe fallback. Raw req.ip would let an attacker rotate the
    // low 64 bits of an IPv6 address to bypass the limit; the helper
    // normalises to a /56 CIDR block per express-rate-limit v8.
    return 'ip:' + ipKeyGenerator(req.ip);
}

const orderCreateLimiter = makeLimiter({
    name: 'order-create',
    windowMs: WINDOW_MS,
    limit: orderCreateLimitFor,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: orderCreateLimitKey,
    message: {
        success: false,
        code: 'ORDER_RATE_LIMIT',
        message: 'Too many orders in a short time. Please wait a moment before trying again.',
    },
});

module.exports = {
    orderCreateLimiter,
    orderCreateLimitFor,
    orderCreateLimitKey,
    STAFF_ROLES,
    STAFF_LIMIT,
    GUEST_LIMIT,
    WINDOW_MS,
};
