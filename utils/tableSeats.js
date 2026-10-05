// Table seat reservations (QA #13 — "more diners ordering from one
// table than it seats").
//
// The old gate (tableOccupancy.checkTableCapacity, now removed) only counted
// parties that already had an ORDER, so:
//   1. scanning reserved nothing — any number of phones could scan a
//      4-seat table, browse and build carts, and were only stopped at
//      "Place order";
//   2. it was check-then-insert — several first orders (or scans)
//      arriving together all passed the count before any was saved.
//
// Now every diner party claims a SEAT on the table document when it
// scans the QR (and again — idempotently — when it claims the table
// after login or places an order). The claim is a single conditional
// findOneAndUpdate:
//     { _id, $expr: { $lt: [ { $size: '$seats' }, capacity - R ] } }
//     → $push: { seats: { keys, joinedAt, lastSeenAt } }
// MongoDB evaluates the condition and the push atomically per
// document, so N concurrent claims on a table with K free seats yield
// exactly K winners.
//
//   R = open-order parties that hold no seat (legacy orders placed
//       before seats existed, the shared 'staff' walk-in party, or a
//       party whose seat was released while it still had an order).
//
// Merge groups: seats live on the group leader (resolveMergeLeader,
// deterministic) and count against the group's summed capacity.
//
// Release: freeTableOrUnmergeGroup (settlement / staff free / sweepers),
// unmerge, disable, delete, status→free. When one party settles while
// others still have open orders, its seat is NOT removed immediately —
// it has no open order any more, so it is pruned once idle for
// TABLE_SEAT_IDLE_MINUTES (default 30). The same idle pruning reclaims
// seats of phones that scanned and walked away without ordering.
// Staff callers never claim or need seats.

const Table = require('../models/table');
const EVENTS = require('../realtime/events');
const logger = require('./logger');
const { getTableOccupancy, capacityReachedError } = require('./tableOccupancy');

const DEFAULT_IDLE_MINUTES = 30;

function seatIdleMs() {
    const mins = Number(process.env.TABLE_SEAT_IDLE_MINUTES);
    return (Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_IDLE_MINUTES) * 60 * 1000;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────

// Seats that may be pruned: idle since before `cutoff` and none of
// whose identities still has an open order at the table.
function selectStaleSeats(seats, { cutoff, activeMembers }) {
    const active = activeMembers instanceof Set ? activeMembers : new Set(activeMembers || []);
    const cut = new Date(cutoff).getTime();
    return (seats || []).filter((s) => {
        const seen = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0;
        if (seen >= cut) return false;
        return !(s.keys || []).some((k) => active.has(k));
    });
}

// Open-order parties (arrays of identities, see groupPartyIdentities)
// not covered by any seat and not the caller's own party.
function countUncoveredParties(orderParties, seats, callerKeys = []) {
    const seated = new Set();
    for (const s of seats || []) for (const k of s.keys || []) seated.add(k);
    const mine = new Set(callerKeys || []);
    return (orderParties || []).filter((ids) => !ids.some((k) => seated.has(k) || mine.has(k))).length;
}

// How many seats the seats[] array may hold: capacity minus seat-less
// ordering parties. Never negative.
function seatLimit(capacity, uncoveredParties) {
    return Math.max(0, (Number(capacity) || 0) - (Number(uncoveredParties) || 0));
}

function seatsTakenOf(table) {
    return Array.isArray(table?.seats) ? table.seats.length : 0;
}

// Replace the raw seats array (session ids!) on a lean table with a
// count, for staff listings.
function exposeSeats(table) {
    if (!table || typeof table !== 'object') return table;
    const { seats, ...rest } = table;
    return { ...rest, seatsTaken: Array.isArray(seats) ? seats.length : 0 };
}

// ── DB helpers ──────────────────────────────────────────────────────

function emitSeatChange(table, seatsTaken) {
    try {
        const { getIO, emitToStaff } = require('./socket');
        const restaurant = table.restaurant?._id || table.restaurant;
        emitToStaff(getIO(), table.branch?._id || table.branch || null, EVENTS.TABLE_UPDATED, {
            tableId: String(table._id),
            action: 'seats',
            seatsTaken,
            restaurant: restaurant ? String(restaurant) : undefined,
        });
    } catch (err) {
        logger.warn('tableSeats: socket emit failed: ' + err.message);
    }
}

const SEAT_FIELDS = '+seats name capacity mergedWith status branch restaurant';

// Touch the caller's existing seat (if any): refresh lastSeenAt and add
// any new identity (a guest who logged in adds u:<id>). Returns the
// updated table or null when the caller holds no seat.
function touchSeat(tableId, tenantFilterObj, keys, now) {
    return Table.findOneAndUpdate(
        { _id: tableId, ...tenantFilterObj, 'seats.keys': { $in: keys } },
        {
            $set: { 'seats.$.lastSeenAt': now },
            $addToSet: { 'seats.$.keys': { $each: keys } },
        },
        { returnDocument: 'after', projection: { seats: 1 } },
    ).lean();
}

/**
 * Claim (or refresh) a seat for the caller's party.
 *
 * @param {object}   args.table           leader table (doc or lean; needs _id)
 * @param {object}   args.tenantFilterObj { restaurant } scope
 * @param {string[]|null} args.keys       callerPartyKeys(...) — null = staff
 * @param {Date}     [args.now]
 * @returns {{ ok: true, seatCount, capacity } | { ok: false, status, body }}
 */
async function claimSeat({ table, tenantFilterObj = {}, keys, now = new Date() }) {
    // Staff never claim seats; an unidentifiable caller can't hold one.
    if (keys === null) return { ok: true, staff: true };
    const ids = [...new Set((keys || []).filter(Boolean))];
    if (!table || !table._id) return { ok: true, seatCount: 0 };
    const tf = tenantFilterObj;

    // a. Already seated → touch + merge identities.
    if (ids.length) {
        const touched = await touchSeat(table._id, tf, ids, now);
        if (touched) return { ok: true, seatCount: seatsTakenOf(touched), existing: true };
    }

    const fresh = await Table.findOne({ _id: table._id, ...tf }).select(SEAT_FIELDS).lean();
    if (!fresh) return { ok: true, seatCount: 0 };

    const { capacity, members, orderParties, tableName } = await getTableOccupancy(fresh, tf);
    if (!(capacity > 0)) return { ok: true, seatCount: seatsTakenOf(fresh), capacity };

    // b. Prune idle seats with no open order. The lastSeenAt guard in
    //    the $pull keeps a seat that was touched in the meantime.
    const cutoff = new Date(now.getTime() - seatIdleMs());
    const stale = selectStaleSeats(fresh.seats, { cutoff, activeMembers: members });
    let seats = fresh.seats || [];
    let changed = false;
    if (stale.length) {
        const pruned = await Table.findOneAndUpdate(
            { _id: table._id, ...tf },
            { $pull: { seats: { _id: { $in: stale.map((s) => s._id) }, lastSeenAt: { $lt: cutoff } } } },
            { returnDocument: 'after', projection: { seats: 1 } },
        ).lean();
        if (pruned) {
            changed = (pruned.seats || []).length !== seats.length;
            seats = pruned.seats || [];
        }
    }

    // c. Ordering parties without a seat still occupy a place. The
    //    caller's own party is excluded: if it already has an order it
    //    is converting from "order-only" to "seated", not adding a party.
    const uncovered = countUncoveredParties(orderParties, seats, ids);
    const limit = seatLimit(capacity, uncovered);

    // A caller with no identity (no scan session, not logged in — e.g.
    // a kiosk) can't hold a seat; just make sure the table has room.
    if (!ids.length) {
        if (changed) emitSeatChange(fresh, seats.length);
        return seats.length < limit ? { ok: true, seatCount: seats.length, capacity } : capacityReachedError(tableName, capacity);
    }

    // d. Atomic conditional push. `seats.keys $nin` also stops the same
    //    party taking two seats through concurrent requests.
    const pushed = await Table.findOneAndUpdate(
        {
            _id: table._id,
            ...tf,
            'seats.keys': { $nin: ids },
            $expr: { $lt: [{ $size: { $ifNull: ['$seats', []] } }, limit] },
        },
        { $push: { seats: { keys: ids, joinedAt: now, lastSeenAt: now } } },
        { returnDocument: 'after', projection: { seats: 1 } },
    ).lean();

    if (pushed) {
        const seatCount = seatsTakenOf(pushed);
        emitSeatChange(fresh, seatCount);
        return { ok: true, seatCount, capacity };
    }

    // Lost a race with our own concurrent request → we are seated now.
    const retouched = await touchSeat(table._id, tf, ids, now);
    if (retouched) {
        if (changed) emitSeatChange(fresh, seatsTakenOf(retouched));
        return { ok: true, seatCount: seatsTakenOf(retouched), capacity, existing: true };
    }
    if (changed) emitSeatChange(fresh, seats.length);
    return capacityReachedError(tableName, capacity);
}

// Release every seat on the given tables (leader + siblings).
async function releaseSeats(tableIds, tenantFilterObj = {}) {
    const list = (Array.isArray(tableIds) ? tableIds : [tableIds]).filter(Boolean);
    if (!list.length) return;
    await Table.updateMany({ _id: { $in: list }, ...tenantFilterObj }, { $set: { seats: [] } });
}

module.exports = {
    claimSeat,
    releaseSeats,
    exposeSeats,
    seatsTakenOf,
    seatIdleMs,
    selectStaleSeats,
    countUncoveredParties,
    seatLimit,
    DEFAULT_IDLE_MINUTES,
};
