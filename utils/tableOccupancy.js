// Table occupancy helpers — "how many ordering parties are seated at
// this table right now" and "is this table still usable at all".
//
// A party is one customer session at the table:
//   • a logged-in customer        → keyed by user id
//   • a guest who scanned the QR  → keyed by scan sessionId
//   • staff-created walk-in orders (no user / no session) → one shared
//     "staff" party, so waiter orders still occupy a seat.
//
// A party stays seated while it has an order that is either still in
// the kitchen pipeline (new / preparing / ready) or served-but-unpaid.
// Once every order is paid+served (or cancelled) the seat frees up.
// Orders older than PARTY_WINDOW_MS are ignored so an abandoned,
// never-cleared order can't lock a table forever.
//
// The table's STATUS follows a different rule (releaseTableIfSettled
// below): it turns Free as soon as every order on it is paid or
// cancelled, even while a paid order is still being cooked.

const mongoose = require('mongoose');
const Table = require('../models/table');
const Order = require('../models/order');

const PARTY_WINDOW_MS = 12 * 60 * 60 * 1000;

function partyKeyOfOrder(order) {
    if (order.user) return 'u:' + String(order.user);
    if (order.scanSessionId) return 's:' + String(order.scanSessionId);
    return 'staff';
}

// Capacity is enforced by seat reservation — see utils/tableSeats.js
// (claimSeat). This module only answers "who is ordering here".

// Keys that identify the caller as an existing party. Returns null for
// staff callers — staff seat walk-ins and are never capacity-blocked.
function callerPartyKeys(req, scanSessionId) {
    const keys = [];
    if (req.user) {
        if (req.user.role !== 'customer') return null;
        keys.push('u:' + String(req.user._id || req.user.id));
    }
    if (scanSessionId) keys.push('s:' + String(scanSessionId));
    return keys;
}

// Group open orders into parties by shared identity. An order carries
// up to two identities (u:<user>, s:<session>); orders that share any
// identity belong to the same party (a guest who ordered, then logged
// in and ordered again on the same scan session is ONE party). Staff
// walk-in orders (no user, no session) form one shared 'staff' party.
// Pure — returns an array of identity arrays.
function groupPartyIdentities(orders) {
    const parent = new Map();
    const find = (k) => {
        while (parent.get(k) !== k) {
            parent.set(k, parent.get(parent.get(k)));
            k = parent.get(k);
        }
        return k;
    };
    const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    for (const o of orders || []) {
        const ids = [];
        if (o.user) ids.push('u:' + String(o.user));
        if (o.scanSessionId) ids.push('s:' + String(o.scanSessionId));
        if (!ids.length) ids.push('staff');
        ids.forEach(add);
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    }
    const groups = new Map();
    for (const k of parent.keys()) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(k);
    }
    return [...groups.values()];
}

// Returns { capacity, parties: Set<string>, members: Set<string>,
// orderParties: string[][], tableName }. Capacity sums
// the whole merge group so a merged 4+4 seats 8.
async function getTableOccupancy(table, tenantFilterObj = {}) {
    const groupIds = [table._id, ...(Array.isArray(table.mergedWith) ? table.mergedWith : [])];
    let capacity = Number(table.capacity) || 0;
    if (groupIds.length > 1) {
        const siblings = await Table.find({
            _id: { $in: groupIds.slice(1) },
            isDeleted: { $ne: true },
            ...tenantFilterObj,
        }).select('capacity').lean();
        capacity += siblings.reduce((sum, s) => sum + (Number(s.capacity) || 0), 0);
    }

    const orders = await Order.find({
        table: { $in: groupIds },
        ...tenantFilterObj,
        createdAt: { $gte: new Date(Date.now() - PARTY_WINDOW_MS) },
        $or: [
            { status: { $in: ['awaiting-payment', 'new', 'preparing', 'ready'] } },
            { status: 'served', paymentStatus: { $nin: ['Paid', 'Refunded'] } },
        ],
    }).select('user scanSessionId').lean();

    // `parties` counts each seated party once (primary key). `members`
    // holds every identity an order carries — a logged-in customer's
    // order is keyed by user but may also carry the scan sessionId, so
    // their unauthenticated re-scan (session key only) still matches.
    const parties = new Set(orders.map(partyKeyOfOrder));
    const members = new Set();
    for (const o of orders) {
        if (o.user) members.add('u:' + String(o.user));
        if (o.scanSessionId) members.add('s:' + String(o.scanSessionId));
    }
    return { capacity, parties, members, orderParties: groupPartyIdentities(orders), tableName: table.name };
}

// An order whose bill is still owed: not cancelled and not settled
// (Paid / Refunded). Kitchen status is irrelevant — a paid order still
// being cooked does not keep the table occupied (it stays on the KDS).
const UNSETTLED_ORDER_MATCH = {
    status: { $ne: 'cancelled' },
    paymentStatus: { $nin: ['Paid', 'Refunded'] },
};

// Pay-first restaurants (operations profile): every round is paid up
// front, so "paid" says nothing about whether the party is done. A round
// still waiting for payment or in the kitchen keeps the table; it frees
// when the kitchen finishes (Ready → served) — design §5.3.
const PAY_FIRST_UNSETTLED_MATCH = {
    status: { $ne: 'cancelled' },
    $or: [
        { paymentStatus: { $nin: ['Paid', 'Refunded'] } },
        { status: { $in: ['awaiting-payment', 'new', 'preparing', 'ready'] } },
    ],
};

async function unsettledMatchFor(restaurantId) {
    if (!restaurantId) return UNSETTLED_ORDER_MATCH;
    // No live DB connection (unit tests with mocked models): a Restaurant
    // query would just buffer until it times out — keep today's rule.
    if (mongoose.connection.readyState !== 1) return UNSETTLED_ORDER_MATCH;
    try {
        const Restaurant = require('../models/restaurant');
        const r = await Restaurant.findById(restaurantId)
            .select('subscription featureOverrides addons operations').lean();
        if (!r?.operations) return UNSETTLED_ORDER_MATCH;   // today's rule
        const { resolveOperations } = require('./operationsProfile');
        return resolveOperations(r).payment.dineIn === 'payFirst'
            ? PAY_FIRST_UNSETTLED_MATCH
            : UNSETTLED_ORDER_MATCH;
    } catch {
        return UNSETTLED_ORDER_MATCH;
    }
}

const toIdString = (v) => (v == null ? null : String(v._id || v));

const timeOf = (d) => (d ? new Date(d).getTime() : 0);

// Pure: live seats (not idle since `cutoff`) of a party that sat down
// AFTER the table's bill was settled — i.e. somebody new is at the table.
//   • a seat whose keys (u:<user> / s:<scan session>) match a settled
//     order is that party's own seat unless it was claimed after that
//     order settled (the same person sitting down again);
//   • any other seat (a phone that scanned but never ordered) counts as
//     a new sitting only when it was claimed after the latest
//     settlement on the table. A companion who scanned before the bill
//     was paid leaves with the party that paid the table's bill.
function seatsOfOtherParties(seats, settledOrders, { cutoff } = {}) {
    const cut = cutoff ? timeOf(cutoff) : -Infinity;
    const settledAt = new Map(); // identity → latest settlement time
    let latest = -Infinity;
    for (const o of settledOrders || []) {
        const at = timeOf(o.paidAt || o.cancelledAt || o.updatedAt || o.createdAt);
        latest = Math.max(latest, at);
        const ids = [];
        if (o.user) ids.push('u:' + String(o.user));
        if (o.scanSessionId) ids.push('s:' + String(o.scanSessionId));
        for (const k of ids) settledAt.set(k, Math.max(settledAt.get(k) || 0, at));
    }
    return (seats || []).filter((s) => {
        if (timeOf(s.lastSeenAt || s.joinedAt) < cut) return false; // idle → prunable
        const times = (s.keys || []).map((k) => settledAt.get(k)).filter((t) => t !== undefined);
        const settledBy = times.length ? Math.max(...times) : latest;
        return timeOf(s.joinedAt) > settledBy;
    });
}

// Live seats on the group held by a party that is not one of the
// group's (all settled) orders.
async function liveSeatsOfOtherParties(groupIds, tf) {
    const tables = await Table.find({ _id: { $in: groupIds }, ...tf }).select('+seats').lean();
    const seats = (tables || []).flatMap((t) => t.seats || []);
    if (!seats.length) return [];
    // Lazy — tableSeats requires this module.
    const { seatIdleMs } = require('./tableSeats');
    const cutoff = new Date(Date.now() - seatIdleMs());
    if (!seats.some((s) => timeOf(s.lastSeenAt || s.joinedAt) >= cutoff.getTime())) return [];
    // The group's orders, plus settled bills of these seated identities
    // that were detached from the table (orderCreateService.
    // detachStalePaidBill sets table: null when the next party orders).
    const userIds = [];
    const sessionIds = [];
    for (const s of seats) {
        for (const k of s.keys || []) {
            if (k.startsWith('u:')) userIds.push(k.slice(2));
            else if (k.startsWith('s:')) sessionIds.push(k.slice(2));
        }
    }
    const identityMatch = [];
    if (userIds.length) identityMatch.push({ user: { $in: userIds.filter((id) => mongoose.isValidObjectId(id)) } });
    if (sessionIds.length) identityMatch.push({ scanSessionId: { $in: sessionIds } });
    const orders = await Order.find({
        ...tf,
        createdAt: { $gte: new Date(Date.now() - PARTY_WINDOW_MS) },
        $or: [
            { table: { $in: groupIds } },
            ...(identityMatch.length ? [{ table: null, $or: identityMatch }] : []),
        ],
    }).select('user scanSessionId status paymentStatus paidAt cancelledAt updatedAt createdAt').lean();
    const settledOrders = (orders || []).filter((o) => o.status === 'cancelled'
        || o.paymentStatus === 'Paid' || o.paymentStatus === 'Refunded');
    return seatsOfOtherParties(seats, settledOrders, { cutoff });
}

// Table-status rule (QA): a dine-in table — the whole merge group — is
// Free as soon as no order on the group (within PARTY_WINDOW_MS) is
// unsettled. Call this after any order on a table is paid, refunded or
// cancelled (or served while already paid).
//
//   • every order settled → free the table / unmerge the group
//     (utils/tableMerge.freeTableOrUnmergeGroup, which keeps seat
//     reservations while a paid order is still in the kitchen) and emit
//     `table:updated` { tableId, status: 'free' } to the tenant's staff
//     for every freed id;
//   • an unsettled order remains (another party has not paid yet) → the
//     table stays occupied and any activeOrder pointing at a settled /
//     cancelled order is repointed to the newest unsettled one;
//   • every order settled but a new party is SEATED (a live seat claimed
//     after the bill was settled — someone scanned in and has not
//     ordered yet; see seatsOfOtherParties) → the table stays occupied
//     and nothing is emitted.
//
// `orderOrTableId` is an order (doc or lean object carrying `table`) or a
// table id. `tenantFilterObj` scopes every query; when empty, the
// restaurant from opts / the order is used instead (webhooks and
// background jobs have no req). opts:
//   branch, restaurant — emit routing (default: the order's, then the table's)
//   emit               — false to skip the socket emit (default true)
//   force              — free even while another party is seated
// Returns { freedIds, repointedTo } (+ seatedParties when kept for seats).
async function releaseTableIfSettled(orderOrTableId, tenantFilterObj = {}, opts = {}) {
    const none = { freedIds: [], repointedTo: null };
    if (!orderOrTableId) return none;
    // A string or an ObjectId is a table id; any other object is an order.
    const isOrder = typeof orderOrTableId === 'object' && !orderOrTableId._bsontype;
    const order = isOrder ? orderOrTableId : null;
    const tableId = order ? (order.table?._id || order.table) : orderOrTableId;
    if (!tableId) return none;

    const restaurant = opts.restaurant || order?.restaurant || null;
    let tf = tenantFilterObj || {};
    if (!Object.keys(tf).length && restaurant) tf = { restaurant: restaurant._id || restaurant };

    const table = await Table.findOne({ _id: tableId, ...tf })
        .select('mergedWith status branch restaurant')
        .lean();
    if (!table) return none;
    const groupIds = [table._id, ...(Array.isArray(table.mergedWith) ? table.mergedWith : [])];

    const unsettled = await Order.find({
        table: { $in: groupIds },
        ...tf,
        createdAt: { $gte: new Date(Date.now() - PARTY_WINDOW_MS) },
        ...(await unsettledMatchFor(table.restaurant || restaurant?._id || restaurant)),
    }).sort({ createdAt: -1 }).select('_id').lean();

    if (unsettled.length) {
        const newest = unsettled[0]._id;
        await Table.updateMany(
            {
                _id: { $in: groupIds },
                ...tf,
                activeOrder: { $nin: [null, ...unsettled.map((o) => o._id)] },
            },
            { $set: { activeOrder: newest } },
        );
        return { freedIds: [], repointedTo: newest };
    }

    // A new party is seated (scanned in after the bill was settled, no
    // order yet) — e.g. party A paid while its food was cooking, party B
    // sat down, then A's order was served. Freeing now would wipe B's seat and show the
    // table Free with B sitting at it. Keep it as it is; the settled
    // parties' seats are pruned once idle (utils/tableSeats). opts.force
    // skips this guard.
    if (!opts.force) {
        const others = await liveSeatsOfOtherParties(groupIds, tf);
        if (others.length) return { freedIds: [], repointedTo: null, seatedParties: others.length };
    }

    // Lazy require — tableMerge is a sibling helper; keeps load order flat.
    const { freeTableOrUnmergeGroup } = require('./tableMerge');
    const { freedIds } = await freeTableOrUnmergeGroup(tableId, tf);

    if (opts.emit !== false && freedIds.length) {
        try {
            const { getIO, emitToStaff } = require('./socket');
            const io = getIO();
            const branch = opts.branch !== undefined ? opts.branch : (order?.branch || table.branch || null);
            const rid = toIdString(restaurant || table.restaurant);
            for (const id of freedIds) {
                emitToStaff(io, branch || null, 'table:updated', {
                    tableId: id,
                    status: 'free',
                    ...(rid ? { restaurant: rid } : {}),
                });
            }
        } catch { /* socket best-effort */ }
    }
    return { freedIds, repointedTo: null };
}

// Kept for existing callers/tests — same rule as releaseTableIfSettled.
async function releaseTableAfterOrderClosed(order, tenantFilterObj = {}, opts = {}) {
    return releaseTableIfSettled(order, tenantFilterObj, opts);
}

// The 409 payload every capacity gate returns (scan, claim, order).
function capacityReachedError(tableName, capacity) {
    return {
        ok: false,
        status: 409,
        body: {
            success: false,
            code: 'TABLE_CAPACITY_REACHED',
            message: `Table ${tableName} is full (seats ${capacity}). Please ask a staff member to seat you at another table.`,
        },
    };
}

// A table can take new orders only while it exists, isn't soft-deleted,
// is active and isn't disabled. Returns null when usable, otherwise a
// { status, body } error payload.
function tableUnavailableError(t) {
    if (!t || t.isDeleted) {
        return {
            status: 409,
            body: {
                success: false,
                code: 'TABLE_UNAVAILABLE',
                message: 'This table is no longer available. Please re-scan the QR code at your table.',
            },
        };
    }
    if (t.isActive === false || t.status === 'disabled') {
        return {
            status: 409,
            body: {
                success: false,
                code: 'TABLE_DISABLED',
                message: 'This table is out of service. Please ask a staff member for help.',
            },
        };
    }
    return null;
}

module.exports = {
    partyKeyOfOrder,
    groupPartyIdentities,
    capacityReachedError,
    callerPartyKeys,
    getTableOccupancy,
    tableUnavailableError,
    releaseTableAfterOrderClosed,
    releaseTableIfSettled,
    seatsOfOtherParties,
    UNSETTLED_ORDER_MATCH,
    PARTY_WINDOW_MS,
};
