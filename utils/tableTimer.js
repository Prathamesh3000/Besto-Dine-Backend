'use strict';

/**
 * utils/tableTimer.js - the table timer (docs/TABLE_TIMER.md).
 *
 * A timer starts when the FIRST CONFIRMED order of a table sitting exists and
 * stops when the table is released. Only a server timestamp is stored
 * (Table.sessionStartedAt + a TableSession row); elapsed time is computed by
 * the client from `serverTime`. Nothing here ticks.
 *
 *   startTableTimer(order)           every order-creation / confirmation path
 *   closeTableTimers(ids, tf, opts)  every table release (freeTableOrUnmergeGroup, manual paths)
 *   reconcileTableTimer(ids, tf)     after a cancel while the table stays occupied
 *   decorateTables / timerResponseExtras   staff list responses (admin / manager / captain only)
 *
 * Every async function is best-effort: it logs a warning and never throws
 * into the order flow.
 */
const mongoose = require('mongoose');
const logger = require('./logger');
const EVENTS = require('../realtime/events');

const DEFAULTS = Object.freeze({ amberMinutes: 60, redMinutes: 90 });
const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const TIMER_ROLES = ['admin', 'manager', 'captain'];
const OCCUPIED = ['occupied', 'merged', 'alert'];

const str = (v) => (v == null ? '' : String(v._id || v));

// ── pure helpers ─────────────────────────────────────────────────────────

const isWhole = (v) => typeof v === 'number' && Number.isInteger(v);

/** Stored/partial value -> { amberMinutes, redMinutes } with defaults filled in. */
function normalizeTableTimer(v) {
    const pick = (x, d) => (isWhole(x) ? x : d);
    const o = v && typeof v === 'object' ? v : {};
    return { amberMinutes: pick(o.amberMinutes, DEFAULTS.amberMinutes), redMinutes: pick(o.redMinutes, DEFAULTS.redMinutes) };
}

/** Error message for an invalid { amberMinutes, redMinutes }, else null. */
function validateTableTimer(v) {
    const { amberMinutes: a, redMinutes: r } = v || {};
    for (const [label, x] of [['Amber', a], ['Red', r]]) {
        if (typeof x !== 'number' || !Number.isFinite(x) || !Number.isInteger(x)) return `${label} minutes must be a whole number between ${MIN_MINUTES} and ${MAX_MINUTES}`;
        if (x < MIN_MINUTES || x > MAX_MINUTES) return `${label} minutes must be a whole number between ${MIN_MINUTES} and ${MAX_MINUTES}`;
    }
    if (r <= a) return 'Red minutes must be greater than amber minutes';
    return null;
}

function earliestStart(dates) {
    let best = null;
    for (const d of dates || []) {
        if (!d) continue;
        const t = new Date(d);
        if (Number.isNaN(t.getTime())) continue;
        if (!best || t < best) best = t;
    }
    return best;
}

const durationMinutesOf = (startedAt, endedAt) => Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000));

/** Does this order, as it stands, count as a confirmed first order? */
function orderStartsTimer(order) {
    if (!order || order.type !== 'dine-in' || !order.table) return false;
    if (!Array.isArray(order.items) || order.items.length === 0) return false;
    return order.status !== 'awaiting-payment' && order.status !== 'cancelled';
}

const canSeeTimer = (user) => !!user && TIMER_ROLES.includes(user.role);

/**
 * Backfill plan for one table: { startedAt, firstOrder, orderCount } from its
 * open confirmed orders with items (awaiting-payment / cancelled excluded), or
 * null when the table is not occupied, already has a timer or nothing counts.
 */
function planBackfill(table, orders) {
    if (!table || !OCCUPIED.includes(table.status) || table.sessionStartedAt) return null;
    const live = (orders || []).filter((o) => o && o.status !== 'cancelled' && o.status !== 'awaiting-payment'
        && Array.isArray(o.items) && o.items.length > 0);
    if (!live.length) return null;
    const sorted = [...live].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return { startedAt: new Date(sorted[0].createdAt), firstOrder: sorted[0]._id, orderCount: live.length };
}

// ── realtime ─────────────────────────────────────────────────────────────

function emitTimerEvent(event, branch, restaurant, payload) {
    try {
        const { getIO, emitToRoles } = require('./socket');
        emitToRoles(getIO(), TIMER_ROLES, branch || null, event, {
            ...payload, at: new Date().toISOString(), ...(restaurant ? { restaurant: str(restaurant) } : {}),
        });
    } catch { /* socket best-effort */ }
}

// ── start ────────────────────────────────────────────────────────────────

/**
 * Start the timer for `order`'s table when this is its first confirmed order.
 * Idempotent: a table (or merge group) that already has a timer is untouched.
 * `opts.at` overrides the start (a released held order starts at release time).
 * Returns the TableSession id or null. Never throws.
 */
async function startTableTimer(order, opts = {}) {
    try {
        if (!orderStartsTimer(order)) return null;
        const Table = require('../models/table');
        const TableSession = require('../models/tableSession');
        const restaurant = order.restaurant && (order.restaurant._id || order.restaurant);
        if (!restaurant) return null;
        const tf = { restaurant };
        const tableId = order.table._id || order.table;

        const table = await Table.findOne({ _id: tableId, ...tf })
            .select('+sessionStartedAt +tableSession mergedWith status branch isDeleted').lean();
        if (!table || table.isDeleted || !OCCUPIED.includes(table.status)) return null;
        if (table.sessionStartedAt) return null;
        const group = Array.isArray(table.mergedWith) ? table.mergedWith : [];
        if (group.length && await Table.exists({ _id: { $in: group }, ...tf, sessionStartedAt: { $ne: null } })) return null;

        const startedAt = opts.at ? new Date(opts.at) : new Date();
        const branch = table.branch || order.branch || null;
        const _id = new mongoose.Types.ObjectId();
        try {
            await TableSession.create({ _id, restaurant, branch, table: table._id, startedAt, firstOrder: order._id || null, orderCount: 1 });
        } catch (err) {
            if (err && err.code === 11000) {
                // An open session exists but the table lost its pointer: re-attach it.
                const open = await TableSession.findOne({ table: table._id, endedAt: null, ...tf }).lean();
                if (!open) return null;
                const healed = await Table.updateOne({ _id: table._id, ...tf, sessionStartedAt: null },
                    { $set: { sessionStartedAt: open.startedAt, tableSession: open._id } });
                if (healed.modifiedCount) emitTimerEvent(EVENTS.TABLE_TIMER_STARTED, branch, restaurant, { tableId: str(table._id), startedAt: open.startedAt.toISOString() });
                return healed.modifiedCount ? open._id : null;
            }
            throw err;
        }
        const upd = await Table.updateOne(
            { _id: table._id, ...tf, sessionStartedAt: null, status: { $in: OCCUPIED } },
            { $set: { sessionStartedAt: startedAt, tableSession: _id } },
        );
        if (!upd.modifiedCount) {
            await TableSession.deleteOne({ _id, ...tf });
            return null;
        }
        emitTimerEvent(EVENTS.TABLE_TIMER_STARTED, branch, restaurant, { tableId: str(table._id), startedAt: startedAt.toISOString() });
        return _id;
    } catch (err) {
        logger.warn('table timer start failed: ' + (err && err.message));
        return null;
    }
}

// ── stop ─────────────────────────────────────────────────────────────────

async function liveOrderExists(groupIds, tf, since) {
    const Order = require('../models/order');
    return !!(await Order.exists({
        table: { $in: groupIds }, ...tf, status: { $ne: 'cancelled' }, 'items.0': { $exists: true },
        createdAt: { $gte: new Date(new Date(since).getTime() - 60 * 1000) },
    }));
}

/**
 * Close every open session on `tableIds` (a freed table / merge group): the
 * TableSession gets endedAt / durationMinutes / endReason, the tables lose
 * sessionStartedAt / tableSession and `table:timer-stopped` goes to
 * admin / manager / captain - one event per freed table id when something was
 * closed. opts: reason ('paid' | 'freed' | 'forced' | 'cleared', default
 * 'freed'), branch, restaurant, emit (default true), now. A 'paid' release
 * with no non-cancelled order with items left (everything was cancelled)
 * is recorded as 'cleared' with 0 minutes. Never throws.
 */
async function closeTableTimers(tableIds, tf = {}, opts = {}) {
    const result = { closed: 0, tableIds: [] };
    try {
        const ids = (tableIds || []).filter(Boolean);
        if (!ids.length) return result;
        const Table = require('../models/table');
        const TableSession = require('../models/tableSession');
        const restaurant = (tf && tf.restaurant) || opts.restaurant;
        if (!restaurant) return result;
        const scope = { restaurant: restaurant._id || restaurant };

        const holders = await Table.find({ _id: { $in: ids }, ...scope, $or: [{ sessionStartedAt: { $ne: null } }, { tableSession: { $ne: null } }] })
            .select('+sessionStartedAt +tableSession branch').lean();
        const open = await TableSession.find({ table: { $in: ids }, endedAt: null, ...scope }).lean();
        if (!holders.length && !open.length) return result;

        const now = opts.now ? new Date(opts.now) : new Date();
        let reason = opts.reason || 'freed';
        const sessions = new Map(open.map((s) => [str(s._id), s]));
        const startedAts = [...open.map((s) => s.startedAt), ...holders.map((h) => h.sessionStartedAt)];
        const startedAt = earliestStart(startedAts);
        if (reason === 'paid' && startedAt && !(await liveOrderExists(ids, scope, startedAt))) reason = 'cleared';

        let orderCount = null;
        if (reason !== 'cleared' && startedAt) {
            const Order = require('../models/order');
            orderCount = await Order.countDocuments({
                table: { $in: ids }, ...scope, status: { $ne: 'cancelled' }, 'items.0': { $exists: true },
                createdAt: { $gte: new Date(startedAt.getTime() - 60 * 1000) },
            });
        }
        for (const s of sessions.values()) {
            const upd = await TableSession.updateOne({ _id: s._id, endedAt: null, ...scope }, {
                $set: {
                    endedAt: now, open: false, endReason: reason,
                    durationMinutes: reason === 'cleared' ? 0 : durationMinutesOf(s.startedAt, now),
                    ...(orderCount != null ? { orderCount: Math.max(orderCount, 1) } : {}),
                },
            });
            if (upd.modifiedCount) result.closed += 1;
        }
        await Table.updateMany({ _id: { $in: ids }, ...scope }, { $set: { sessionStartedAt: null, tableSession: null } });

        const first = holders[0] || {};
        const branch = opts.branch !== undefined ? opts.branch : (first.branch || null);
        const durationMinutes = reason === 'cleared' ? 0 : durationMinutesOf(startedAt || now, now);
        if (opts.emit !== false && (result.closed || holders.length)) {
            result.tableIds = ids.map(str);
            for (const id of result.tableIds) {
                emitTimerEvent(EVENTS.TABLE_TIMER_STOPPED, branch, restaurant, {
                    tableId: id, endedAt: now.toISOString(), durationMinutes,
                    ...(reason === 'cleared' ? { cleared: true } : {}), endReason: reason,
                });
            }
        }
        result.reason = reason;
        return result;
    } catch (err) {
        logger.warn('table timer close failed: ' + (err && err.message));
        return result;
    }
}

/**
 * The table (group) stays occupied after a cancel: when no non-cancelled
 * order with items is left the timer is cleared (session 'cleared'); while
 * another counts, nothing changes. Never throws.
 */
async function reconcileTableTimer(groupIds, tf = {}, opts = {}) {
    try {
        const ids = (groupIds || []).filter(Boolean);
        if (!ids.length) return false;
        const Table = require('../models/table');
        const scope = { restaurant: (tf && tf.restaurant) || opts.restaurant };
        if (!scope.restaurant) return false;
        const holders = await Table.find({ _id: { $in: ids }, ...scope, sessionStartedAt: { $ne: null } })
            .select('+sessionStartedAt').lean();
        if (!holders.length) return false;
        const since = earliestStart(holders.map((h) => h.sessionStartedAt));
        const Order = require('../models/order');
        const remaining = await Order.exists({
            table: { $in: ids }, ...scope, status: { $nin: ['cancelled', 'awaiting-payment'] }, 'items.0': { $exists: true },
            createdAt: { $gte: new Date(since.getTime() - 60 * 1000) },
        });
        if (remaining) return false;
        const out = await closeTableTimers(ids, scope, { ...opts, reason: 'cleared' });
        return out.closed > 0 || out.tableIds.length > 0;
    } catch (err) {
        logger.warn('table timer reconcile failed: ' + (err && err.message));
        return false;
    }
}

// ── staff list responses ─────────────────────────────────────────────────

/** Tenant thresholds for this request (settings cache; defaults when unset). */
async function thresholdsFor(req) {
    try {
        const { getSettings } = require('./settingsCache');
        const s = await getSettings(req);
        return normalizeTableTimer(s && s.tableTimer);
    } catch {
        return { ...DEFAULTS };
    }
}

/**
 * For staff table-list responses. Returns null for roles that must not see
 * the timer; otherwise { serverTime, tableTimer } to spread into the response
 * and `decorate(table)` to add sessionStartedAt (earliest across a merge
 * group). `tables` are lean/plain rows carrying `sessionStartedAt` (select it)
 * and `mergedWith`.
 */
async function timerView(req, tables) {
    if (!canSeeTimer(req && req.user)) return null;
    const byId = new Map((tables || []).map((t) => [str(t._id), t]));
    // Merge-group members outside the listed set (filtered out by area /
    // status) still count towards the group's earliest start.
    const missing = new Set();
    for (const t of tables || []) for (const m of (t.mergedWith || [])) if (!byId.has(str(m))) missing.add(str(m));
    if (missing.size) {
        try {
            const Table = require('../models/table');
            const { tenantFilter } = require('./tenantScope');
            const extra = await Table.find({ _id: { $in: [...missing] }, ...tenantFilter(req) }).select('+sessionStartedAt').lean();
            for (const m of extra) byId.set(str(m._id), m);
        } catch (err) { logger.warn('table timer: group lookup failed: ' + err.message); }
    }
    const startOf = (t) => {
        const ids = [str(t._id), ...((t.mergedWith || []).map(str))];
        return earliestStart(ids.map((id) => byId.get(id)).filter(Boolean).map((m) => m.sessionStartedAt));
    };
    const tableTimer = await thresholdsFor(req);
    return {
        extras: { serverTime: new Date().toISOString(), tableTimer },
        decorate: (row, source) => {
            const d = startOf(source || row);
            const { tableSession: _ts, ...rest } = row;
            return { ...rest, sessionStartedAt: d ? d.toISOString() : null };
        },
    };
}

module.exports = {
    DEFAULTS, MIN_MINUTES, MAX_MINUTES, TIMER_ROLES,
    normalizeTableTimer, validateTableTimer, earliestStart, durationMinutesOf, orderStartsTimer, canSeeTimer, planBackfill,
    startTableTimer, closeTableTimers, reconcileTableTimer, timerView, thresholdsFor,
};
