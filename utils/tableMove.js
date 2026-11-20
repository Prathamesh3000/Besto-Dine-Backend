'use strict';

/**
 * Move table — pure helpers (no DB, no sockets) plus the one lookup the
 * scan-token paths share. The move itself lives in services/tableMoveService.js.
 *
 * Vocabulary
 *   open order     status in OPEN_STATUSES (held pay-first orders included)
 *   movedSessions  Table.movedSessions on the DESTINATION: [{ sessionId, fromTable, at }]
 *                  "this diner party (scan session) came here from <fromTable>". It lets a
 *                  phone that still holds a scan token for the old table keep ordering.
 */

const OPEN_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served'];
const MAX_MOVED_SESSIONS = 200;

const idStr = (v) => (v === null || v === undefined ? null : String(v._id || v));

/** { tableId, tableName, at } of the latest move's FROM side, or null. */
function movedFromOf(order) {
    const moves = order && order.tableMoves;
    if (!Array.isArray(moves) || moves.length === 0) return null;
    const last = moves[moves.length - 1];
    if (!last || typeof last !== 'object') return null;
    return {
        tableId: idStr(last.fromTable),
        tableName: last.fromTableName || '',
        at: last.at || null,
    };
}

/**
 * Why an open order stops the whole party from being moved, or null.
 * A counter-payment request is deliberately NOT a blocker (it carries over).
 */
function orderBlocker(order) {
    if (!order) return null;
    if (order.bill && order.bill.status === 'final') return 'BILL_FINAL';
    if (['Paid', 'Partially Paid', 'Refunded'].includes(order.paymentStatus)) return 'PAYMENT_ATTACHED';
    if (Number(order.amountPaid) > 0) return 'PAYMENT_ATTACHED';
    return null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** { orderCount, itemCount (sum of quantities), total (2dp) } over the given orders. */
function summarizeOrders(orders) {
    const list = Array.isArray(orders) ? orders : [];
    let itemCount = 0;
    let total = 0;
    for (const o of list) {
        for (const it of (o && o.items) || []) itemCount += Number(it && it.quantity) || 1;
        total += Number(o && o.total) || 0;
    }
    return { orderCount: list.length, itemCount, total: round2(total) };
}

/** True when the table is part of a merge group (own state, or listed by another table). */
function isInMergeGroup(table, listedByAnother = false) {
    if (!table) return false;
    return table.status === 'merged'
        || (Array.isArray(table.mergedWith) && table.mergedWith.length > 0)
        || !!listedByAnother;
}

/**
 * Destination's movedSessions after a move: what it already had, plus one
 * entry per moved session id (de-duplicated on sessionId + fromTable),
 * newest kept when the list is capped.
 */
function mergeMovedSessions(existing, sessionIds, fromTable, at) {
    const out = [];
    const seen = new Set();
    const push = (entry) => {
        if (!entry || !entry.sessionId) return;
        const key = `${entry.sessionId}|${idStr(entry.fromTable)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ sessionId: String(entry.sessionId), fromTable: entry.fromTable, at: entry.at });
    };
    for (const e of existing || []) push(e);
    for (const s of sessionIds || []) push({ sessionId: s, fromTable, at });
    return out.length > MAX_MOVED_SESSIONS ? out.slice(out.length - MAX_MOVED_SESSIONS) : out;
}

/**
 * Where did this scan session's party go? Looks for a destination table
 * carrying { sessionId, fromTable: <the token's table> } in movedSessions.
 * Returns the destination table id (string) or null. Tenant scoped.
 *
 * @param {object} args
 * @param {string} args.tableId       table the scan token was issued for
 * @param {string} args.sessionId     scan session id from the token
 * @param {object} args.tenantFilter  { restaurant: … }
 * @param {object} [args.session]     mongoose session (inside a transaction)
 */
async function findMovedDestination({ tableId, sessionId, tenantFilter = {}, session = null }) {
    if (!tableId || !sessionId) return null;
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(String(tableId))) return null;
    const Table = require('../models/table');
    const q = Table.findOne({
        ...tenantFilter,
        isDeleted: { $ne: true },
        movedSessions: { $elemMatch: { sessionId: String(sessionId), fromTable: String(tableId) } },
    }).select('_id');
    if (session) q.session(session);
    const dest = await q.lean();
    return dest ? String(dest._id) : null;
}

module.exports = {
    OPEN_STATUSES,
    MAX_MOVED_SESSIONS,
    movedFromOf,
    orderBlocker,
    summarizeOrders,
    isInMergeGroup,
    mergeMovedSessions,
    findMovedDestination,
};
