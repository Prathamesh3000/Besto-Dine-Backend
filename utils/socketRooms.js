// Tenant-namespaced Socket.io room scheme + join authorization (BUG #6).
//
// Pure module: no DB / socket.io imports, so it can be unit-tested with
// injected lookups. utils/socket.js wires it to Mongo + socket.io.
//
// Room scheme
// ───────────
//   t:<restaurantId>:<role>               tenant-level (unpinned) staff of <role>
//   t:<restaurantId>:<role>:<branchId>    staff of <role> pinned to <branchId>
//   t:<restaurantId>:<role>:unbranched    branch-pinned staff also listen here so
//                                         events with NO branch (legacy rows) still
//                                         reach them — without hearing other branches
//   t:<restaurantId>:menu                 public menu-change pings (menu:updated)
//   superadmin                            platform operators only
//   <userId>                              a single user's own sockets
//   order:<orderId>                       order owner / same scan session / same-tenant staff
//   table:<tableId>                       the guest holding a scan token for that table
//
// <role> ∈ admin | waiter | kitchen | captain | manager. There are NO global
// 'admin' / 'kitchen' / 'waiter' rooms any more — every staff room carries the
// tenant id, and the server auto-joins sockets from their authenticated
// identity so clients can't pick rooms for another tenant.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const ROOM_ROLES = ['admin', 'waiter', 'kitchen', 'captain', 'manager'];
const STAFF_ROLES = new Set(['admin', 'manager', 'captain', 'waiter', 'chef']);
const UNBRANCHED = 'unbranched';
const SUPERADMIN_ROOM = 'superadmin';

const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v);

/** Normalise an id-ish value (ObjectId, populated doc, string) → string | null. */
function toId(v) {
    if (!v) return null;
    if (typeof v === 'object' && v._id) return String(v._id);
    const s = String(v);
    return s && s !== '[object Object]' ? s : null;
}

function tenantRoom(restaurantId, role, branchId = null) {
    const t = toId(restaurantId);
    if (!t) return null;
    const b = branchId === UNBRANCHED ? UNBRANCHED : toId(branchId);
    return b ? `t:${t}:${role}:${b}` : `t:${t}:${role}`;
}

function menuRoom(restaurantId) {
    const t = toId(restaurantId);
    return t ? `t:${t}:menu` : null;
}

/**
 * Rooms an emit for (tenant, role, branch) must target.
 *   branch set  → the branch room + the tenant-level room (unpinned staff)
 *   branch null → the tenant-level room + the "unbranched" room (pinned staff)
 */
function emitRoomsFor(restaurantId, role, branchId) {
    const t = toId(restaurantId);
    if (!t) return [];
    const b = toId(branchId);
    return b
        ? [tenantRoom(t, role, b), tenantRoom(t, role)]
        : [tenantRoom(t, role), tenantRoom(t, role, UNBRANCHED)];
}

/** Staff role → the room roles that user listens on. */
function listenRolesFor(role) {
    switch (role) {
        case 'admin': return ['admin'];
        case 'manager': return ['admin', 'manager', 'waiter'];
        case 'chef': return ['kitchen'];
        case 'captain': return ['captain', 'waiter'];
        case 'waiter': return ['waiter'];
        default: return [];
    }
}

/**
 * Rooms the server auto-joins for an authenticated socket identity
 * (`socket.data`). Clients never have to (and can't) choose these.
 */
function autoRoomsFor(data = {}) {
    const rooms = new Set();
    const { userId, role, restaurant, branchId, scan } = data;
    if (userId) rooms.add(String(userId));
    if (role === 'superadmin') rooms.add(SUPERADMIN_ROOM);
    if (restaurant && STAFF_ROLES.has(role)) {
        for (const r of listenRolesFor(role)) {
            if (branchId) {
                rooms.add(tenantRoom(restaurant, r, branchId));
                rooms.add(tenantRoom(restaurant, r, UNBRANCHED));
            } else {
                rooms.add(tenantRoom(restaurant, r));
            }
        }
        rooms.add(menuRoom(restaurant));
    }
    if (scan && scan.tableId) {
        rooms.add(`table:${scan.tableId}`);
        if (scan.restaurantId) rooms.add(menuRoom(scan.restaurantId));
    }
    rooms.delete(null);
    return [...rooms];
}

/** Parse `t:<rid>:<role>[:<branchId>|:unbranched]` or `t:<rid>:menu`. */
function parseTenantRoom(room) {
    if (typeof room !== 'string') return null;
    const m = /^t:([a-f0-9]{24}):(admin|waiter|kitchen|captain|manager|menu)(?::([a-f0-9]{24}|unbranched))?$/i.exec(room);
    if (!m) return null;
    if (m[2].toLowerCase() === 'menu' && m[3]) return null;
    return { restaurantId: m[1].toLowerCase(), role: m[2].toLowerCase(), branch: m[3] ? m[3].toLowerCase() : null };
}

/** Legacy un-namespaced staff room names (`kitchen`, `admin:<branchId>`…). */
function parseLegacyStaffRoom(room) {
    const m = /^(admin|waiter|kitchen|manager|captain)(?::([a-f0-9]{24}))?$/i.exec(room || '');
    if (!m) return null;
    return { role: m[1].toLowerCase(), branchId: m[2] || null };
}

function roleMayListen(socketRole, roomRole) {
    if (socketRole === 'admin' || socketRole === 'manager') return true;
    return listenRolesFor(socketRole).includes(roomRole);
}

/**
 * Authorize a client `join` request.
 *
 * @param {object} data  socket.data ({ userId, role, restaurant, branchId, scan })
 * @param {string} room
 * @param {object} deps  { getBranchTenant(branchId) → Promise<rid|null>,
 *                         findOrder(orderId) → Promise<{user,table,scanSessionId,restaurant,branch}|null>,
 *                         warn?(msg, meta) }
 * @returns {Promise<boolean>}
 */
async function canJoinWith(data, room, deps = {}) {
    if (!room || typeof room !== 'string') return false;
    data = data || {};
    const warn = deps.warn || (() => {});

    if (room === SUPERADMIN_ROOM) return data.role === 'superadmin';

    const tr = parseTenantRoom(room);
    if (tr) {
        // Menu pings carry only public menu info — anyone may listen.
        if (tr.role === 'menu') return true;
        const role = data.role;
        const myTenant = data.restaurant ? String(data.restaurant).toLowerCase() : null;
        if (!role || !STAFF_ROLES.has(role) || !myTenant) return false;
        if (myTenant !== tr.restaurantId) {
            warn('canJoin cross-tenant room attempt blocked', { userId: data.userId, role, room });
            return false;
        }
        if (!roleMayListen(role, tr.role)) return false;
        const myBranch = data.branchId ? String(data.branchId).toLowerCase() : null;
        if (myBranch) {
            // Pinned: only their own branch room or the unbranched room.
            return tr.branch === myBranch || tr.branch === UNBRANCHED;
        }
        // Unpinned (tenant-level) staff.
        if (!tr.branch || tr.branch === UNBRANCHED) return true;
        const branchTenant = deps.getBranchTenant ? await deps.getBranchTenant(tr.branch) : null;
        return !!branchTenant && String(branchTenant).toLowerCase() === myTenant;
    }

    // Legacy global / branch rooms are no longer joinable (tenant leak).
    if (parseLegacyStaffRoom(room)) return false;

    // User room — must be the authenticated user.
    if (OBJECT_ID_RE.test(room)) {
        return !!data.userId && String(data.userId) === String(room);
    }

    const tableMatch = /^table:([a-f0-9]{24})$/i.exec(room);
    if (tableMatch) {
        const scan = data.scan;
        if (!scan || !scan.tableId) return false;
        if (String(scan.tableId) !== String(tableMatch[1])) return false;
        if (data.restaurant && scan.restaurantId && String(scan.restaurantId) !== String(data.restaurant)) {
            return false;
        }
        return true;
    }

    if (room.startsWith('order:')) {
        const orderId = room.slice('order:'.length);
        if (!orderId || orderId.length > 64) return false;
        let order;
        try {
            order = deps.findOrder ? await deps.findOrder(orderId) : null;
        } catch (err) {
            warn('canJoin order lookup failed', { err: err.message });
            return false;
        }
        if (!order) return false;
        const orderTenant = order.restaurant ? String(order.restaurant) : null;
        const scan = data.scan;
        const callerTenant = data.restaurant || scan?.restaurantId || null;
        if (callerTenant && orderTenant && String(callerTenant) !== orderTenant) return false;

        // Same-tenant staff (branch-pinned staff only for their branch /
        // unbranched orders).
        if (STAFF_ROLES.has(data.role) && data.restaurant && orderTenant
            && String(data.restaurant) === orderTenant) {
            if (data.branchId && order.branch && String(order.branch) !== String(data.branchId)) return false;
            return true;
        }
        if (data.userId && order.user && String(order.user) === String(data.userId)) return true;
        if (
            scan && order.table && order.scanSessionId && scan.sessionId &&
            String(scan.tableId) === String(order.table) &&
            String(scan.sessionId) === String(order.scanSessionId)
        ) {
            return true;
        }
        return false;
    }

    return false;
}

module.exports = {
    ROOM_ROLES,
    STAFF_ROLES,
    UNBRANCHED,
    SUPERADMIN_ROOM,
    isObjectId,
    toId,
    tenantRoom,
    menuRoom,
    emitRoomsFor,
    listenRolesFor,
    autoRoomsFor,
    parseTenantRoom,
    parseLegacyStaffRoom,
    canJoinWith,
};
