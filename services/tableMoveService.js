'use strict';

/**
 * services/tableMoveService.js - move a seated party to another table.
 *
 *   moveTable({ tf, actor, isOtherBranch, fromTableId, toTableId, preview, ip })
 *
 * See docs/MOVE_TABLE.md for the rules. In short: ALL open orders of the
 * source table (held pay-first ones included) get `table = destination` and a
 * tableMoves[] history entry - nothing else about an order changes. The table
 * state (activeOrder, seats, diner, waiter, alerts) travels with them, the
 * source is freed WITHOUT stamping sessionEpoch (the diners must not be signed
 * out), and the audit row is written in the same mongoose transaction.
 * Conditional atomic updates make concurrent moves exclusive: the loser gets
 * 409 MOVE_CONFLICT.
 *
 * Sockets (after commit): table:moved to staff, table:updated for both tables,
 * order:updated per order, and a table:moved to the moved diners' phones
 * carrying a fresh scan token for the new table (same sessionId).
 */
const mongoose = require('mongoose');
const Table = require('../models/table');
const Order = require('../models/order');
const Request = require('../models/request');
const TableSession = require('../models/tableSession');
const logger = require('../utils/logger');
const EVENTS = require('../realtime/events');
const { signTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const {
    OPEN_STATUSES, movedFromOf, orderBlocker, summarizeOrders, isInMergeGroup, mergeMovedSessions,
} = require('../utils/tableMove');

const SCAN_TOKEN_TTL = process.env.SCAN_TOKEN_TTL || '4h';
// A conflicting state that was created by another move within this window is
// reported as MOVE_CONFLICT ("someone else just moved it") instead of the
// plain state error, so two staff racing for the same tables get one answer.
const RECENT_MOVE_MS = 15 * 1000;
const EMPTY_DINER = Object.freeze({ user: null, name: '', phone: '', isRegistered: false, claimedAt: null });

class MoveError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.name = 'MoveError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const conflict = () => new MoveError(409, 'MOVE_CONFLICT',
    'These tables were just changed by someone else. Refresh and try again.');
const str = (v) => (v === null || v === undefined ? '' : String(v._id || v));
const sameBranch = (a, b) => str(a.branch) === str(b.branch);

function isTransient(err) {
    if (!err) return false;
    if (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')) return true;
    return err.code === 112 || err.codeName === 'WriteConflict';
}

/** Another move touched this table a moment ago (see RECENT_MOVE_MS). */
async function movedRecently(kind, table, tf, session) {
    const cutoff = new Date(Date.now() - RECENT_MOVE_MS);
    const side = kind === 'source' ? 'fromTable' : 'toTable';
    const q = Order.exists({
        ...tf,
        ...(kind === 'dest' ? { table: table._id } : {}),
        tableMoves: { $elemMatch: { [side]: table._id, at: { $gte: cutoff } } },
    });
    if (session) q.session(session);
    return !!(await q);
}

/**
 * Validate everything. Returns { src, dst, orders } or throws MoveError.
 * `session` is the transaction session (null for a preview).
 */
async function validate({ tf, fromTableId, toTableId, isOtherBranch, session }) {
    const load = (id) => {
        const q = Table.findOne({ _id: id, ...tf }).select('+seats +movedSessions +sessionStartedAt +tableSession');
        if (session) q.session(session);
        return q.lean();
    };
    // Sequential: operations of one transaction session must not overlap.
    const src = await load(fromTableId);
    const dst = await load(toTableId);
    if (!src || src.isDeleted || !dst || dst.isDeleted) {
        throw new MoveError(404, 'TABLE_NOT_FOUND', 'Table not found.');
    }
    if (isOtherBranch(src) || isOtherBranch(dst) || !sameBranch(src, dst)) {
        throw new MoveError(403, 'BRANCH_MISMATCH', 'This table belongs to another branch.');
    }

    const listedBy = async (t) => {
        const q = Table.exists({ mergedWith: t._id, ...tf });
        if (session) q.session(session);
        return !!(await q);
    };
    if (isInMergeGroup(src, await listedBy(src)) || isInMergeGroup(dst, await listedBy(dst))) {
        throw new MoveError(409, 'TABLE_MERGED', 'Unmerge tables first');
    }

    const openOf = (tableId) => {
        const q = Order.find({ table: tableId, status: { $in: OPEN_STATUSES }, ...tf });
        if (session) q.session(session);
        return q.sort({ createdAt: 1 }).lean();
    };
    const orders = await openOf(src._id);
    const sourceOk = ['occupied', 'alert'].includes(src.status) && src.isActive !== false && orders.length > 0;
    if (!sourceOk) {
        if (await movedRecently('source', src, tf, session)) throw conflict();
        throw new MoveError(409, 'SOURCE_NOT_OCCUPIED', 'The source table has no open order to move.');
    }

    if (dst.status === 'disabled' || dst.isActive === false) {
        throw new MoveError(409, 'DEST_DISABLED', 'The destination table is disabled.', { destinationStatus: dst.status });
    }
    if (dst.status === 'reserved') {
        throw new MoveError(409, 'DEST_RESERVED', 'The destination table is reserved.', { destinationStatus: dst.status });
    }
    const destOrders = dst.status === 'free' && !dst.activeOrder ? await openOf(dst._id) : [{}];
    if (dst.status !== 'free' || dst.activeOrder || destOrders.length > 0) {
        if (await movedRecently('dest', dst, tf, session)) throw conflict();
        throw new MoveError(409, 'DEST_NOT_FREE', 'The destination table is not free.', { destinationStatus: dst.status });
    }

    for (const o of orders) {
        const why = orderBlocker(o);
        if (why === 'BILL_FINAL') {
            throw new MoveError(409, 'BILL_FINAL', 'A bill has been finalized on this table. Reopen the bill before moving.');
        }
        if (why === 'PAYMENT_ATTACHED') {
            throw new MoveError(409, 'PAYMENT_ATTACHED', 'A payment is already attached to an order on this table.');
        }
    }
    return { src, dst, orders };
}

/** The write phase - runs inside the transaction. */
async function applyMove(session, { tf, actor, ip, src, dst, orders, now, summary }) {
    const orderIds = orders.map((o) => o._id);
    const sessionIds = new Set(orders.map((o) => o.scanSessionId).filter(Boolean));
    for (const seat of src.seats || []) {
        for (const k of seat.keys || []) {
            const m = /^s:(.+)$/.exec(String(k));
            if (m) sessionIds.add(m[1]);
        }
    }
    const activeOrder = orderIds.some((id) => str(id) === str(src.activeOrder))
        ? src.activeOrder : orderIds[orderIds.length - 1];

    const set = {
        status: src.status,
        activeOrder,
        seats: [...(dst.seats || []), ...(src.seats || [])],
        currentDiner: src.currentDiner ? { ...EMPTY_DINER, ...src.currentDiner } : { ...EMPTY_DINER },
        alerts: src.alerts || [],
        movedSessions: mergeMovedSessions(
            [...(dst.movedSessions || []), ...(src.movedSessions || [])], [...sessionIds], src._id, now,
        ),
    };
    if (src.assignedWaiter) set.assignedWaiter = src.assignedWaiter;
    // Table timer: the party keeps its start time (docs/TABLE_TIMER.md).
    const hasTimer = !!(src.sessionStartedAt || src.tableSession);
    if (hasTimer) {
        set.sessionStartedAt = src.sessionStartedAt || null;
        set.tableSession = src.tableSession || null;
    }

    const live = { isDeleted: { $ne: true }, isActive: { $ne: false }, 'mergedWith.0': { $exists: false } };
    const newDst = await Table.findOneAndUpdate(
        { _id: dst._id, ...tf, ...live, status: 'free', activeOrder: null },
        { $set: set },
        { session, returnDocument: 'after' },
    ).lean();
    if (!newDst) throw conflict();

    const freed = await Table.findOneAndUpdate(
        { _id: src._id, ...tf, 'mergedWith.0': { $exists: false }, status: { $in: ['occupied', 'alert'] } },
        {
            $set: {
                status: 'free', activeOrder: null, seats: [], currentDiner: { ...EMPTY_DINER }, alerts: [],
                ...(hasTimer ? { sessionStartedAt: null, tableSession: null } : {}),
            },
            $unset: { assignedWaiter: 1, movedSessions: 1 },
        },
        { session, returnDocument: 'after' },
    ).lean();
    if (!freed) throw conflict();

    const entry = {
        fromTable: src._id, fromTableName: src.name, toTable: dst._id, toTableName: dst.name,
        at: now, by: actor._id || actor.id || null, byName: actor.name || '',
    };
    const upd = await Order.updateMany(
        {
            _id: { $in: orderIds }, table: src._id, ...tf,
            status: { $in: OPEN_STATUSES },
            'bill.status': { $ne: 'final' },
            paymentStatus: { $nin: ['Paid', 'Partially Paid', 'Refunded'] },
            amountPaid: { $not: { $gt: 0 } },
        },
        { $set: { table: dst._id }, $push: { tableMoves: entry } },
        { session },
    );
    if (upd.modifiedCount !== orderIds.length) throw conflict();

    if (src.tableSession) {
        await TableSession.updateOne({ _id: src.tableSession, ...tf, endedAt: null }, { $set: { table: dst._id } }, { session });
    }

    // A waiter call / bill request / counter-payment request raised at the old
    // table must show up where the party now is.
    await Request.updateMany(
        { table: src._id, status: { $in: ['pending', 'accepted'] }, ...tf },
        { $set: { table: dst._id } },
        { session },
    );

    const { auditTableMove } = require('./tenantAuditHooks');
    await auditTableMove(
        { user: actor, restaurant: tf.restaurant, branch: src.branch || null, ip },
        {
            from: { id: src._id, name: src.name }, to: { id: dst._id, name: dst.name },
            orderIds: orders.map((o) => o.orderId), itemCount: summary.itemCount, total: summary.total, at: now,
        },
        session,
    );
    return { sessionIds: [...sessionIds], newStatus: src.status, activeOrder };
}

/** After commit: staff rooms, both tables, each order, and the diners' phones. Never throws. */
async function announce({ tf, actor, src, dst, orders, summary, now, sessionIds, newStatus }) {
    let io;
    try { io = require('../utils/socket').getIO(); } catch { return; }
    const { emitToStaff } = require('../utils/socket');
    const branch = src.branch || null;
    const restaurant = str(tf.restaurant);
    const orderIds = orders.map((o) => o.orderId);

    try {
        emitToStaff(io, branch, EVENTS.TABLE_MOVED, {
            fromTableId: str(src._id), toTableId: str(dst._id),
            fromTableName: src.name, toTableName: dst.name,
            orderIds, itemCount: summary.itemCount, total: summary.total,
            movedBy: { id: str(actor._id || actor.id), name: actor.name || '' },
            at: now.toISOString(),
            restaurant,
        });
        emitToStaff(io, branch, EVENTS.TABLE_UPDATED, { tableId: str(src._id), status: 'free', billingState: null, restaurant });
        emitToStaff(io, branch, EVENTS.TABLE_UPDATED, { tableId: str(dst._id), status: newStatus, restaurant });
        for (const o of orders) {
            emitToStaff(io, o.branch || branch, EVENTS.ORDER_UPDATED, {
                orderId: o.orderId, _id: str(o._id), type: o.type, status: o.status,
                table: str(dst._id), tableName: dst.name,
                movedFrom: movedFromOf({ tableMoves: [{ fromTable: src._id, fromTableName: src.name, at: now }] }),
                restaurant,
            });
        }
    } catch (err) {
        logger.warn('table move: staff emit failed: ' + err.message);
    }

    // Diners' phones: same sessionId, new table. Sockets are moved to the new
    // table room so the later session:ended for the freed old table cannot
    // reach them.
    try {
        if (!sessionIds.length) return;
        const wanted = new Set(sessionIds);
        const oldRoom = `table:${str(src._id)}`;
        const newRoom = `table:${str(dst._id)}`;
        const fresh = await Table.findOne({ _id: dst._id, ...tf }).select('+qrToken').lean();
        const sockets = await io.in(oldRoom).fetchSockets();
        for (const s of sockets) {
            const scan = s.data && s.data.scan;
            if (!scan || !wanted.has(String(scan.sessionId))) continue;
            let scanToken = null;
            try {
                scanToken = signTypedToken(TOKEN_TYPES.SCAN, {
                    tableId: str(dst._id), restaurantId: restaurant,
                    qrToken: fresh && fresh.qrToken, sessionId: scan.sessionId,
                }, { expiresIn: SCAN_TOKEN_TTL });
            } catch (err) {
                logger.warn('table move: scan token sign failed: ' + err.message);
            }
            io.to(s.id).emit(EVENTS.TABLE_MOVED, {
                toTableId: str(dst._id), toTableName: dst.name, scanToken, sessionId: scan.sessionId,
            });
            try {
                s.leave(oldRoom);
                s.join(newRoom);
                if (s.data) s.data.scan = { ...scan, tableId: str(dst._id) };
            } catch (err) {
                logger.warn('table move: room switch failed: ' + err.message);
            }
        }
    } catch (err) {
        logger.warn('table move: diner push failed: ' + err.message);
    }
}

/**
 * @param {object}   args
 * @param {object}   args.tf             tenantFilter(req)
 * @param {object}   args.actor          req.user
 * @param {Function} args.isOtherBranch  (table) => boolean, the caller's branch pin
 * @param {string}   args.fromTableId
 * @param {string}   args.toTableId
 * @param {boolean}  [args.preview]
 * @param {string}   [args.ip]
 * @returns {Promise<{preview:object}|{moved:object}>}
 * @throws {MoveError}
 */
async function moveTable({ tf, actor, isOtherBranch, fromTableId, toTableId, preview = false, ip = '' }) {
    if (String(fromTableId) === String(toTableId)) {
        throw new MoveError(400, 'MOVE_SAME_TABLE', 'Pick a different table to move to.');
    }

    if (preview) {
        const { src, dst, orders } = await validate({ tf, fromTableId, toTableId, isOtherBranch, session: null });
        const summary = summarizeOrders(orders);
        return {
            preview: {
                from: { id: str(src._id), name: src.name },
                to: { id: str(dst._id), name: dst.name },
                orderCount: summary.orderCount, itemCount: summary.itemCount, total: summary.total,
            },
        };
    }

    const session = await mongoose.startSession();
    let attempt = 0;
    let out = null;
    try {
        await session.withTransaction(async () => {
            attempt += 1;
            try {
                const { src, dst, orders } = await validate({ tf, fromTableId, toTableId, isOtherBranch, session });
                const now = new Date();
                const summary = summarizeOrders(orders);
                const applied = await applyMove(session, { tf, actor, ip, src, dst, orders, now, summary });
                out = { src, dst, orders, now, summary, ...applied };
            } catch (err) {
                // A retry means another transaction touched these tables first;
                // whatever validation now objects to is the result of that race.
                if (attempt > 1 && err instanceof MoveError && err.code !== 'MOVE_CONFLICT') throw conflict();
                throw err;
            }
        });
    } catch (err) {
        if (err instanceof MoveError) throw err;
        if (isTransient(err)) throw conflict();
        throw err;
    } finally {
        await session.endSession();
    }

    // announce() reads the committed tables; do not await the socket fan-out in the response path.
    announce({ tf, actor, ...out }).catch((err) => logger.warn('table move: announce failed: ' + err.message));

    return {
        moved: {
            fromTableId: str(out.src._id), toTableId: str(out.dst._id),
            fromName: out.src.name, toName: out.dst.name,
            orderIds: out.orders.map((o) => o.orderId),
            orderCount: out.summary.orderCount, itemCount: out.summary.itemCount, total: out.summary.total,
        },
    };
}

module.exports = { moveTable, MoveError, RECENT_MOVE_MS };
