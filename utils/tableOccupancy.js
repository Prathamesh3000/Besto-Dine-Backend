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
            { status: { $in: ['new', 'preparing', 'ready'] } },
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

// An order still holding its party at the table: in the kitchen
// pipeline, or served but not yet paid.
const OPEN_ORDER_MATCH = {
    $or: [
        { status: { $in: ['new', 'preparing', 'ready'] } },
        { status: 'served', paymentStatus: { $nin: ['Paid', 'Refunded'] } },
    ],
};

// `order` just closed (cancelled, or served + paid). Free its table (or
// unmerge the whole group) only when no OTHER open order remains on the
// table / merge group — independent-orders model: another party may
// still be waiting for food. When one does remain, the table stays
// occupied and an activeOrder pointing at the closed order is repointed
// to the remaining one. Returns { freedIds, repointedTo }.
async function releaseTableAfterOrderClosed(order, tenantFilterObj = {}) {
    const tableId = order?.table?._id || order?.table;
    if (!tableId) return { freedIds: [], repointedTo: null };
    const table = await Table.findOne({ _id: tableId, ...tenantFilterObj })
        .select('mergedWith status')
        .lean();
    if (!table) return { freedIds: [], repointedTo: null };
    const groupIds = [table._id, ...(Array.isArray(table.mergedWith) ? table.mergedWith : [])];

    const remaining = await Order.findOne({
        table: { $in: groupIds },
        _id: { $ne: order._id },
        ...tenantFilterObj,
        createdAt: { $gte: new Date(Date.now() - PARTY_WINDOW_MS) },
        ...OPEN_ORDER_MATCH,
    }).sort({ createdAt: -1 }).select('_id').lean();

    if (remaining) {
        await Table.updateMany(
            { _id: { $in: groupIds }, ...tenantFilterObj, activeOrder: order._id },
            { $set: { activeOrder: remaining._id } },
        );
        return { freedIds: [], repointedTo: remaining._id };
    }

    // Lazy require — tableMerge is a sibling helper; keeps load order flat.
    const { freeTableOrUnmergeGroup } = require('./tableMerge');
    const { freedIds } = await freeTableOrUnmergeGroup(tableId, tenantFilterObj);
    return { freedIds: freedIds.length ? freedIds : [tableId], repointedTo: null };
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
};
