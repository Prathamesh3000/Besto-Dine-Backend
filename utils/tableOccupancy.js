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

// Returns { capacity, parties: Set<string>, members: Set<string>, tableName }. Capacity sums
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
    return { capacity, parties, members, tableName: table.name };
}

// Decide whether the caller may join / order at the table.
// `keys` = callerPartyKeys(...) result. null keys (staff) always pass.
async function checkTableCapacity(table, tenantFilterObj, keys) {
    if (keys === null) return { ok: true };
    const { capacity, parties, members, tableName } = await getTableOccupancy(table, tenantFilterObj);
    if (capacity <= 0) return { ok: true };
    if (keys.some((k) => members.has(k))) return { ok: true };
    if (parties.size < capacity) return { ok: true };
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
    callerPartyKeys,
    getTableOccupancy,
    checkTableCapacity,
    tableUnavailableError,
};
