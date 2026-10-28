// Captain (Head Waiter) controller — floor-control endpoints that back the
// Captain Floor Overview dashboard.
//
// The Captain is the service-side authority on the floor: they monitor every
// table/session, watch waiter workload, catch delayed orders, and escalate
// billing / service problems to an admin. None of these are write-heavy — the
// existing table-assign / free / merge endpoints already cover the mutations.
// This controller is the read-side aggregation + the escalation hop.
//
// Branch isolation: a branch-pinned captain is subject to the same
// strictBranchFilter enforcement as a branch-pinned admin — `?branch=`
// overrides from the client are ignored (see utils/tenantScope.js). An
// unpinned captain (single-branch tenant) sees the whole tenant.
const Area = require('../models/area');
const Table = require('../models/table');
const Order = require('../models/order');
const User = require('../models/user');
const Request = require('../models/request');
const Shift = require('../models/shift');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const logger = require('../utils/logger');
const { resolveOperationsForRequest } = require('../utils/operationsProfile');
const { billingStatesForTables } = require('../utils/paymentState');
const { seatsTakenOf } = require('../utils/tableSeats');

// Delay thresholds (minutes). A kitchen ticket sitting in new/preparing past
// PREP_DELAY_MIN, or a plated order waiting to be picked up past
// READY_WAIT_MIN, is "delayed" and surfaces in the captain's delayed-orders
// rail. READY_WAIT_MIN matches the existing `isUrgent` cutoff in
// orderController.getLiveOrders so the two views agree on what "late" means.
const PREP_DELAY_MIN = 20;
const READY_WAIT_MIN = 10;

// Resolve the branch a captain-authored record (notification) belongs to.
// A pinned captain → their pin; an unpinned captain → the request branch
// context if any; else tenant-level (null).
const branchForWrite = (req) => {
    const pin = pinnedBranchId(req);
    if (pin) return pin._id || pin;
    return req.branch?._id || null;
};

// The captain's area scope. Captains cover whole areas via `assignedAreas`
// (never individual tables — see user.js). Empty = tenant/branch-wide.
const captainAreaIds = (req) =>
    (req.user?.assignedAreas || []).map(a => String(a?._id || a));

const minutesSince = (d) => (Date.now() - new Date(d).getTime()) / 60000;

// Is this active order past its delay threshold for its current status?
const isOrderDelayed = (o) => {
    if (o.status === 'new' || o.status === 'preparing') {
        return minutesSince(o.createdAt) > PREP_DELAY_MIN;
    }
    if (o.status === 'ready') {
        return minutesSince(o.updatedAt) > READY_WAIT_MIN;
    }
    return false;
};

// Customer requests still open (pending + accepted) in the caller's scope:
// tenant, branch pin and the captain's areas (a request belongs to a table,
// the table to an area). `tableById` is the already-scoped table map.
async function openRequestsInScope(tf, bf, scopedTableIds) {
    const rows = await Request.find({ status: { $in: ['pending', 'accepted'] }, ...tf, ...bf })
        .select('table type status priority createdAt waiter')
        .sort({ createdAt: 1 })
        .lean();
    return rows.filter((r) => scopedTableIds.has(String(r.table)));
}

// The caller's active shift (or none) for the home screen.
async function myShiftOf(req, tf) {
    const shift = await Shift.findOne({ staff: req.user._id, status: 'active', ...tf }).select('clockIn').lean();
    return { active: !!shift, clockedInAt: shift ? shift.clockIn : null };
}

// GET /api/v1/captain/floor-overview
// One round-trip that powers the whole dashboard: areas in scope, every
// table with its assigned waiter + live-order summary, per-waiter workload,
// and the delayed-order rail.
exports.getFloorOverview = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = strictBranchFilter(req);
        const scopeAreaIds = captainAreaIds(req);

        // ── Areas in scope ──────────────────────────────────────────────
        let areas = await Area.find({ ...tf, ...bf }).select('name').sort({ name: 1 }).lean();
        if (scopeAreaIds.length) {
            areas = areas.filter(a => scopeAreaIds.includes(String(a._id)));
        }
        const scopedAreaSet = new Set(areas.map(a => String(a._id)));

        // ── Tables (sessions) ───────────────────────────────────────────
        // Soft-deleted tables stay in the collection for referential
        // integrity but must never show on the floor (same rule as
        // tableController.getTables).
        let tables = await Table.find({ ...tf, ...bf, isDeleted: { $ne: true } })
            .select('name capacity status area assignedWaiter mergedWith seats')
            .populate('assignedWaiter', 'name staffId')
            .sort({ name: 1 })
            .lean();
        if (scopeAreaIds.length) {
            tables = tables.filter(t => t.area && scopedAreaSet.has(String(t.area)));
        }

        // ── Active orders (new / preparing / ready) ─────────────────────
        // Branch-pinned floor staff must ALSO see takeaway/counter-pickup
        // orders that carry no branch routing (`branch: null`) — same rule as
        // orderController.getLiveOrders. strictBranchFilter alone would pin to
        // `{ branch: <id> }` and hide unrouted takeaways, so a branch captain
        // would undercount takeaway vs the Tables page. Widen to
        // "(my branch) OR (any takeaway with no branch)" when a pin is active.
        const activeStatuses = ['new', 'preparing', 'ready'];
        const orderBranchScope = Object.keys(bf).length
            ? { $or: [bf, { type: 'takeaway', branch: null }] }
            : {};
        let orders = await Order.find({ status: { $in: activeStatuses }, ...tf, ...orderBranchScope })
            .select('orderId status total createdAt updatedAt table waiter customerName type')
            .populate('table', 'name area')
            .populate('waiter', 'name staffId')
            .sort({ createdAt: 1 })
            .lean();
        // Keep dine-in orders for in-scope areas + always keep takeaway
        // (no table) so a captain doesn't lose sight of counter pickups.
        if (scopeAreaIds.length) {
            orders = orders.filter(o => !o.table || (o.table.area && scopedAreaSet.has(String(o.table.area))));
        }

        // Index active orders by table for the per-table summary.
        const ordersByTable = new Map();
        for (const o of orders) {
            const key = o.table ? String(o.table._id) : null;
            if (!key) continue;
            if (!ordersByTable.has(key)) ordersByTable.set(key, []);
            ordersByTable.get(key).push(o);
        }

        // Seats of a merge group live on its leader; report the group's
        // seated parties against the group's summed capacity.
        const tableById = new Map(tables.map(t => [String(t._id), t]));
        const seatsOfGroup = (t) => {
            const ids = [String(t._id), ...((t.mergedWith || []).map(String))];
            const members = ids.map(id => tableById.get(id)).filter(Boolean);
            return {
                taken: members.reduce((n, m) => n + seatsTakenOf(m), 0),
                capacity: members.reduce((n, m) => n + (Number(m.capacity) || 0), 0),
            };
        };

        const billing = await billingStatesForTables(tables.map(t => t._id), tf);
        const tablesOut = tables.map(t => {
            const seatGroup = seatsOfGroup(t);
            const tableOrders = ordersByTable.get(String(t._id)) || [];
            const oldest = tableOrders.reduce(
                (acc, o) => (!acc || new Date(o.createdAt) < new Date(acc) ? o.createdAt : acc),
                null,
            );
            return {
                _id: t._id,
                name: t.name,
                capacity: t.capacity,
                // QA #13 — diner parties holding a seat (QR scan) and the
                // capacity they count against (summed over a merge group).
                seatsTaken: seatGroup.taken,
                seatCapacity: seatGroup.capacity,
                status: t.status,
                area: t.area ? String(t.area) : null,
                merged: Array.isArray(t.mergedWith) && t.mergedWith.length > 0,
                assignedWaiter: t.assignedWaiter
                    ? { _id: t.assignedWaiter._id, name: t.assignedWaiter.name, staffId: t.assignedWaiter.staffId }
                    : null,
                activeOrders: tableOrders.length,
                oldestOrderAt: oldest,
                delayed: tableOrders.some(isOrderDelayed),
                // Derived (Phase 4): billing_pending | payment_pending | payment_failed | print_failed | null
                billingState: billing.get(String(t._id)) || null,
            };
        });

        // ── Delayed-order rail ──────────────────────────────────────────
        const delayedOrders = orders.filter(isOrderDelayed).map(o => ({
            _id: o._id,
            orderId: o.orderId,
            status: o.status,
            table: o.table ? o.table.name : (o.type === 'takeaway' ? 'Takeaway' : '—'),
            waiter: o.waiter ? o.waiter.name : null,
            customerName: o.customerName,
            total: o.total,
            minutesLate: Math.round(
                o.status === 'ready' ? minutesSince(o.updatedAt) : minutesSince(o.createdAt),
            ),
            since: o.status === 'ready' ? o.updatedAt : o.createdAt,
        }));

        // ── Waiter workload ─────────────────────────────────────────────
        const waiters = await User.find({ role: 'waiter', status: 'active', ...tf, ...bf })
            .select('name staffId assignedAreas assignedTables')
            .lean();
        const workload = waiters.map(w => {
            const mine = orders.filter(o => o.waiter && String(o.waiter._id) === String(w._id));
            return {
                _id: w._id,
                name: w.name,
                staffId: w.staffId,
                activeOrders: mine.filter(o => o.status === 'new' || o.status === 'preparing').length,
                readyOrders: mine.filter(o => o.status === 'ready').length,
                delayedOrders: mine.filter(isOrderDelayed).length,
                assignedTables: (w.assignedTables || []).length,
                assignedAreas: (w.assignedAreas || []).length,
            };
        }).sort((a, b) => (b.activeOrders + b.readyOrders) - (a.activeOrders + a.readyOrders));

        // ── Summary ─────────────────────────────────────────────────────
        const summary = {
            totalTables: tablesOut.length,
            occupied: tablesOut.filter(t => t.status === 'occupied' || t.status === 'merged').length,
            alerts: tablesOut.filter(t => t.status === 'alert').length,
            activeOrders: orders.filter(o => o.status === 'new' || o.status === 'preparing').length,
            readyOrders: orders.filter(o => o.status === 'ready').length,
            delayedOrders: delayedOrders.length,
            waitersOnFloor: waiters.length,
            // Captain home priorities (Phase 6): additive.
            openRequests: (await openRequestsInScope(tf, bf, new Set(tables.map(t => String(t._id))))).length,
            unassignedTables: tablesOut.filter(t => !t.assignedWaiter).length,
            myShift: await myShiftOf(req, tf),
        };

        res.status(200).json({
            success: true,
            areas,
            tables: tablesOut,
            delayedOrders,
            workload,
            summary,
            thresholds: { prepDelayMin: PREP_DELAY_MIN, readyWaitMin: READY_WAIT_MIN },
        });
    } catch (error) {
        logger.error('captain.floor-overview failed:', error);
        res.status(500).json({ success: false, message: 'Failed to load floor overview' });
    }
};

// GET /api/v1/captain/waiters
// Active waiters the captain can assign to a table. Scoped to the captain's
// branch (and tenant). Used to populate the Assign/Reassign picker — the
// admin-only /staff list endpoint isn't reachable by a captain.
exports.getAssignableWaiters = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = strictBranchFilter(req);
        const waiters = await User.find({ role: 'waiter', status: 'active', ...tf, ...bf })
            .select('name staffId assignedAreas')
            .sort({ name: 1 })
            .lean();

        // Workload (D7): live tables each waiter holds + the Operations
        // limit (0 = no limit). Additive per-waiter field.
        const limit = Number(resolveOperationsForRequest(req).tables.maxTablesPerWaiter) || 0;
        const held = waiters.length
            ? await Table.find({ assignedWaiter: { $in: waiters.map(w => w._id) }, isDeleted: { $ne: true }, ...tf })
                .select('assignedWaiter').lean()
            : [];
        const counts = new Map();
        for (const t of held) counts.set(String(t.assignedWaiter), (counts.get(String(t.assignedWaiter)) || 0) + 1);
        for (const w of waiters) w.workload = { tables: counts.get(String(w._id)) || 0, limit };

        res.status(200).json({ success: true, waiters });
    } catch (error) {
        logger.error('captain.waiters failed:', error);
        res.status(500).json({ success: false, message: 'Failed to load waiters' });
    }
};

// POST /api/v1/captain/escalate
// Raise a floor issue to the admins. Persists an admin-recipient notification
// (so it shows in the admin notification centre + unread badge) and pushes a
// live socket event to the admin room. Body: { reason, orderId?, tableName?,
// severity? }.
exports.escalateToAdmin = async (req, res) => {
    try {
        const { reason, orderId, tableName, severity } = req.body || {};
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'A reason is required' });
        }

        const priority = ['low', 'medium', 'high', 'urgent'].includes(severity) ? severity : 'high';
        const branch = branchForWrite(req);
        const who = req.user?.name || 'Captain';
        const where = tableName ? ` · ${tableName}` : '';

        // Persist first — the escalation must be stored before anyone is
        // pinged, and a failed write is reported to the captain (500).
        const saved = await notify({
            restaurant: tenantId(req),
            branch,
            notification: {
                recipientRole: 'admin',
                title: `Escalation from ${who}${where}`,
                description: String(reason).trim().slice(0, 500),
                category: 'Service',
                priority,
                meta: { orderId: orderId ? String(orderId) : undefined, table: tableName || undefined },
            },
        });
        const notification = saved.docs[0];
        if (!notification) throw saved.error || new Error('Escalation notification was not saved');

        await notify({
            restaurant: tenantId(req),
            branch,
            audience: 'admin',
            persist: false,
            event: EVENTS.NOTIFICATION_NEW,
            payload: {
                title: notification.title,
                description: notification.description,
                priority,
            },
            also: [{
                event: EVENTS.CAPTAIN_ESCALATION,
                payload: {
                    _id: notification._id,
                    reason: notification.description,
                    tableName: tableName || null,
                    orderId: orderId || null,
                    by: who,
                    priority,
                },
            }],
        });

        res.status(201).json({ success: true, message: 'Escalated to admin', notification });
    } catch (error) {
        logger.error('captain.escalate failed:', error);
        res.status(500).json({ success: false, message: 'Failed to escalate' });
    }
};
