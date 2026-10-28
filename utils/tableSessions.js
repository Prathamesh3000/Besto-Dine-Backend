/**
 * tableSessions — end the customer sessions seated at a table.
 *
 * When staff free a table (one, or all), the diners who were seated there
 * must be signed out at the same moment:
 *
 *   1. `Table.sessionEpoch` is stamped. Every table scan token (X-Scan-Token,
 *      issued by GET /tables/token/:qr) carries an `iat`; middlewares/
 *      tableSessionGuard.js rejects a token issued before the epoch with
 *      401 TABLE_SESSION_ENDED, so a phone that is offline or ignores the
 *      push is still locked out on its next request.
 *   2. Logged-in customers who were seated (seat keys `u:<userId>`) or who own
 *      an open order on the table have their `tokenVersion` bumped, which
 *      revokes their access and refresh tokens (same mechanism as "log out of
 *      all devices"). Staff and superadmin accounts are never touched.
 *   3. `session:ended` (reason 'table-freed') is pushed to the table room (guest scan holders)
 *      and to each affected customer's own room, so open apps sign out at
 *      once and show "your table was closed".
 *
 * Call it BEFORE the seats are wiped (freeTableOrUnmergeGroup clears them).
 */
const Table = require('../models/table');
const Order = require('../models/order');
const User = require('../models/user');
const logger = require('./logger');
const EVENTS = require('../realtime/events');

const OPEN_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served'];

function userIdsFromSeatKeys(seats) {
    const ids = new Set();
    for (const seat of seats || []) {
        for (const k of seat.keys || []) {
            const m = /^u:([a-f0-9]{24})$/i.exec(String(k));
            if (m) ids.add(m[1]);
        }
    }
    return ids;
}

/**
 * @param {object}   args
 * @param {string[]} args.tableIds        tables being freed (merge groups: pass every member)
 * @param {object}   args.tenantFilter    tenantFilter(req) — { restaurant: … }
 * @param {object}   [args.io]            socket.io server (optional; best-effort)
 * @param {string}   [args.reason]        'table-freed' | 'all-tables-freed'
 * @returns {Promise<{ tables:number, customersSignedOut:number }>}
 */
async function endTableSessions({ tableIds, tenantFilter = {}, io = null, reason = 'table-freed' }) {
    const ids = [...new Set((tableIds || []).map(String))];
    if (ids.length === 0) return { tables: 0, customersSignedOut: 0 };
    const now = new Date();
    let signedOut = 0;
    try {
        const tables = await Table.find({ _id: { $in: ids }, ...tenantFilter }).select('+seats _id').lean();
        const userIds = new Set();
        for (const t of tables) for (const id of userIdsFromSeatKeys(t.seats)) userIds.add(id);

        // Owners of still-open orders on these tables (a seat can be pruned
        // while the diner's order is still open).
        const owners = await Order.find({
            table: { $in: ids },
            status: { $in: OPEN_STATUSES },
            user: { $ne: null },
            ...tenantFilter,
        }).select('user').lean();
        for (const o of owners) if (o.user) userIds.add(String(o.user));

        // 1. Revoke scan tokens issued before now.
        await Table.updateMany({ _id: { $in: ids }, ...tenantFilter }, { $set: { sessionEpoch: now } });
        try {
            const { forgetTableEpoch } = require('../middlewares/tableSessionGuard');
            for (const id of ids) forgetTableEpoch(id);
        } catch { /* cache is only an optimisation */ }

        // 2. Revoke logged-in CUSTOMER sessions (never staff / superadmin).
        const customerIds = [];
        if (userIds.size > 0) {
            const rows = await User.find({ _id: { $in: [...userIds] }, role: 'customer' }).select('_id').lean();
            for (const u of rows) customerIds.push(String(u._id));
            if (customerIds.length > 0) {
                await User.updateMany({ _id: { $in: customerIds }, role: 'customer' }, { $inc: { tokenVersion: 1 } });
                signedOut = customerIds.length;
            }
        }

        // 3. Push to the diners' devices.
        if (io) {
            const payload = { reason, at: now.toISOString() };
            for (const id of ids) io.to(`table:${id}`).emit(EVENTS.SESSION_ENDED, { ...payload, tableId: id });
            for (const uid of customerIds) io.to(uid).emit(EVENTS.SESSION_ENDED, payload);
        }
    } catch (err) {
        // Never block freeing a table on the sign-out step; the guard still
        // protects any table whose epoch was written.
        logger.error('endTableSessions failed', { error: err.message, tables: ids.length });
    }
    return { tables: ids.length, customersSignedOut: signedOut };
}

module.exports = { endTableSessions, userIdsFromSeatKeys };
