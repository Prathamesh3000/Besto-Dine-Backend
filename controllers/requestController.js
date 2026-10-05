const mongoose = require('mongoose');
const Request = require('../models/request');
const Table = require('../models/table');
const User = require('../models/user');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { getIO, emitToStaff, emitToAdmin } = require('../utils/socket');
const { getSettings } = require('../utils/settingsCache');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { findWaitersForTable } = require('../utils/staffAssignment');
const { devError } = require('../utils/AppError');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');

// Valid request types and priorities (centralized)
const VALID_TYPES = ['water', 'waiter', 'bill', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Create a new request from customer side
exports.createRequest = async (req, res) => {
  try {
    const { tableId, type, items, priority } = req.body;

    // Validate input
    if (!tableId) {
      return res.status(400).json({ success: false, message: 'Table ID is required' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: `Invalid request type. Must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
    }
    if (items && !Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    // Validate table and populate assignedWaiter (scoped to tenant)
    const tf = tenantFilter(req);
    // `area` is populated so the notifications this request raises can
    // carry the floor name. Without it the waiter's notification list
    // has no way to group by section (Indoor / Outdoor), which is how
    // waiters actually work a floor.
    const table = await Table.findOne({ _id: tableId, ...tf })
        .populate('assignedWaiter', 'name')
        .populate('area', 'name');
    if (!table || table.isDeleted) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_UNAVAILABLE',
        message: 'This table is no longer available. Please re-scan the QR code at your table.',
      });
    }

    // Guests (and logged-in customers) must prove they are at THIS table:
    // a signed X-Scan-Token issued by the QR scan for this table (or a
    // table of its merge group) and this tenant — same proof dine-in
    // orders require (orderCreateService.verifyDineInScan). Without it
    // anyone holding a table id could page waiters / ask for the bill
    // for any table. Staff may raise requests without a scan.
    if (!req.user || req.user.role === 'customer') {
      const scanToken = req.headers['x-scan-token'];
      if (!scanToken) {
        return res.status(403).json({ success: false, code: 'SCAN_TOKEN_REQUIRED', message: 'Please scan the QR code at your table to send a request.' });
      }
      let decoded;
      try {
        decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
      } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
          success: false,
          code: expired ? 'SCAN_TOKEN_EXPIRED' : 'SCAN_TOKEN_INVALID',
          message: expired ? 'Your table session has expired. Please re-scan the QR code.' : 'Invalid table session. Please re-scan the QR code.',
        });
      }
      // Scan tokens of a merged group are bound to the group leader, so
      // accept the leader's token for a member table too.
      const groupIds = [String(table._id), ...((table.mergedWith || []).map(String))];
      let sameGroup = groupIds.includes(String(decoded.tableId));
      if (!sameGroup && mongoose.Types.ObjectId.isValid(String(decoded.tableId))) {
        sameGroup = !!(await Table.exists({ _id: decoded.tableId, mergedWith: table._id, ...tf }));
      }
      const currentTenant = tenantId(req);
      if (!sameGroup
          || (currentTenant && decoded.restaurantId && String(decoded.restaurantId) !== String(currentTenant))) {
        return res.status(403).json({ success: false, code: 'SCAN_TOKEN_MISMATCH', message: 'Scan token does not match this table. Re-scan the QR code.' });
      }
    }

    // Rate limit: prevent spam — block if same table created same type request in last 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    const recent = await Request.findOne({
      table: tableId,
      type,
      status: { $in: ['pending', 'accepted'] },
      createdAt: { $gte: thirtySecondsAgo },
      ...tf,
    });
    if (recent) {
      return res.status(429).json({
        success: false,
        message: 'A similar request was just sent. Please wait a moment.'
      });
    }

    const assignedWaiterId = table.assignedWaiter?._id || null;

    const tenant = tenantId(req);
    const newRequest = new Request({
      table: tableId,
      type,
      items: items || [],
      priority: priority || 'medium',
      // Pre-assign to the table's waiter if one exists
      waiter: assignedWaiterId || undefined,
      status: assignedWaiterId ? 'accepted' : 'pending',
      acceptedAt: assignedWaiterId ? new Date() : undefined,
      restaurant: tenant,
      // Stamp the request with the table's branch so the admin
      // dashboard's Customer Requests card filters correctly when the
      // tenant owner picks a specific branch from the dropdown.
      // Without this every request stayed branch:null and showed up
      // under every branch view.
      branch: table.branch || null,
    });

    const savedRequest = await newRequest.save();

    // Push the alert into table.alerts so the admin Tables grid + drawer
    // reflect the live "Attention Required" state. The frontend computes
    // delay live from the timestamp — we just store the trigger.
    const alertReasonMap = {
        water:  `${table.name} waiting for water`,
        waiter: `${table.name} waiting for waiter`,
        bill:   `${table.name} requested bill`,
        other:  `${table.name} attention requested`,
    };
    try {
        await Table.updateOne(
            { _id: tableId, ...tf },
            {
                $push: {
                    alerts: {
                        reason: alertReasonMap[type] || alertReasonMap.other,
                        type,
                        requestId: savedRequest._id,
                        timestamp: savedRequest.createdAt || new Date(),
                    },
                },
            },
        );
    } catch (err) {
        logger.warn('Failed to push table alert:', { error: err.message });
    }

    // Fetch settings to check if notifications are enabled (per-tenant)
    const settings = await getSettings(req);

    // Tell the admin Tables dashboard that this table changed (alerts
    // array updated). useAdminBootstrap listens for `table:updated` and
    // refetches the bootstrap, which repaints the grid + drawer.
    await notify({
        restaurant: tenant, branch: table.branch, audience: 'admin', persist: false,
        event: EVENTS.TABLE_UPDATED, payload: { tableId: tableId.toString() },
    });

    if (!settings || settings.notifications?.waiterCall !== false) {
        const reqBranch = table.branch || null;
        const waiterDoc = {
            title: `New ${type.toUpperCase()} Request`,
            description: `Table ${table.name} requested ${type}. Priority: ${priority || 'medium'}`,
            category: 'Service',
            recipientRole: 'waiter',
            meta: { table: table.name, area: table.area?.name || null },
            priority: priority || 'medium',
        };
        const waiterPayload = { title: 'New Request', description: `Table ${table.name} — ${type}` };
        const waiterAlso = [{ event: EVENTS.REQUEST_NEW, payload: savedRequest }];

        if (assignedWaiterId) {
            // Targeted notification to the assigned waiter
            await notify({
                restaurant: tenant, branch: reqBranch,
                recipients: assignedWaiterId,
                notification: waiterDoc,
                payload: waiterPayload,
                also: waiterAlso,
            });
        } else {
            // No waiter assigned to table — find waiters whose area / table
            // assignments cover this table and notify them individually so
            // a waiter who's only responsible for "Indoor" doesn't see
            // pings from "Outdoor". Waiters with empty assignments still
            // get every ping (legacy behaviour preserved by the helper).
            //
            // If no waiter matches (e.g. brand-new tenant with no waiters
            // assigned to this area), fall back to the branch-wide
            // broadcast so the request doesn't vanish into a black hole.
            let matchedWaiterIds = [];
            try {
                matchedWaiterIds = await findWaitersForTable({
                    restaurant: tenant,
                    branch: reqBranch,
                    tableId: tableId,
                    // area is populated above — pass the id, not the doc.
                    tableAreaId: table.area?._id || table.area,
                });
            } catch (err) {
                logger.warn('findWaitersForTable failed; falling back to broadcast', { error: err.message });
            }

            // Persisted notifications follow the same targeting as the
            // socket fan-out: one row per matched waiter (emitted to each
            // waiter's user room), otherwise one role-wide row broadcast to
            // the branch waiter room. Previously the stored row was always
            // role-wide, so every waiter's bell list filled with other
            // floors' requests.
            if (matchedWaiterIds.length > 0) {
                await notify({
                    restaurant: tenant, branch: reqBranch,
                    recipients: matchedWaiterIds,
                    notification: waiterDoc,
                    payload: waiterPayload,
                    also: waiterAlso,
                });
            } else {
                await notify({
                    restaurant: tenant, branch: reqBranch,
                    audience: 'waiter',
                    notification: waiterDoc,
                    payload: waiterPayload,
                    also: waiterAlso,
                });
            }
        }

        // Also notify admin at the same branch only. `request:new` is
        // mirrored to admin so the dashboard's Customer Requests panel
        // refreshes in real time (otherwise admins waited up to 30s for
        // the telemetry polling cycle to surface a new ping).
        await notify({
            restaurant: tenant, branch: reqBranch,
            audience: 'admin',
            notification: {
                title: `${type.toUpperCase()} Request — ${table.name}`,
                description: `Table ${table.name} requested ${type}.${assignedWaiterId ? ` Assigned to ${table.assignedWaiter.name}.` : ' No waiter assigned.'}`,
                category: 'Service',
                recipientRole: 'admin',
                meta: { table: table.name, area: table.area?.name || null },
            },
            payload: { title: 'Request Received', description: `Table ${table.name} — ${type}` },
            also: [{ event: EVENTS.REQUEST_NEW, payload: savedRequest }],
        });

        // Echo the created request to the table's customer socket so the
        // poller can baseline immediately and any UI can reflect the
        // auto-accept (pre-assigned waiter).
        await notify({
            persist: false, rooms: `table:${tableId}`,
            event: EVENTS.REQUEST_UPDATED, payload: savedRequest,
        });
    }

    res.status(201).json({ success: true, request: savedRequest });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create request', ...devError(error) });
  }
};

// Get requests for Waiter (Differentiate between Pending, Accepted, Completed)
exports.getRequests = async (req, res) => {
  try {
    const { status, floor, waiterId } = req.query;
    // Branch-pinned admin/waiter sees ONLY their branch's customer
    // requests. createRequest stamps `branch` on the Request when the
    // table is scanned, so strict filtering is safe — tenant owner
    // (no pin) still sees everything.
    const query = { ...tenantFilter(req), ...strictBranchFilter(req) };

    // Validate status enum
    if (status && !['pending', 'accepted', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be pending, accepted, or completed' });
    }
    if (status) query.status = status;

    // Scope by waiter
    if (waiterId) {
      if (status === 'pending') {
        query.waiter = { $eq: null };
      } else if (status === 'accepted' || status === 'completed') {
        query.waiter = waiterId;
      }
    }

    const requests = await Request.find(query)
      .populate({
        path: 'table',
        populate: { path: 'area', select: 'name' },
        // assignedWaiter lets the waiter app keep captain-assigned tables
        // in scope (utils/waiterScope.inWaiterScope).
        select: 'name area assignedWaiter'
      })
      .populate('waiter', 'name')
      .sort({ createdAt: -1 })
      .lean();

    // Filter by floor/area — done after populate since area is nested
    const filtered = floor
      ? requests.filter(r => r.table?.area?._id?.toString() === floor || r.table?.area?.name === floor)
      : requests;

    res.status(200).json({ success: true, count: filtered.length, requests: filtered });
  } catch (error) {
    logger.error('Fetch requests error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch requests' });
  }
};

// Guest-accessible: active + recently-completed requests for a table.
// Returned to the customer app so it can toast "your water is on the way"
// when a waiter accepts, and "completed" when it's delivered. Same
// unauth-with-tenant-header pattern as getActiveOrderByTable.
exports.getActiveRequestsForTable = async (req, res) => {
  try {
    const { tableId } = req.params;
    if (!tableId) {
      return res.status(400).json({ success: false, message: 'Table ID is required' });
    }
    // Limit the window so the client only sees requests from this sitting,
    // not every water call the table has ever made.
    const windowStart = new Date(Date.now() - 30 * 60 * 1000);
    const requests = await Request.find({
      table: tableId,
      createdAt: { $gte: windowStart },
      ...tenantFilter(req),
    })
      .select('type status priority items createdAt acceptedAt completedAt')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, count: requests.length, requests });
  } catch (error) {
    logger.error('Fetch active requests for table error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch requests' });
  }
};

// Update request status (Accept or Complete)
exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, waiterId } = req.body;

    if (!['accepted', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be accepted or completed' });
    }

    // Same branch scope as getRequests: staff pinned to another branch
    // cannot accept / close this branch's requests by id.
    const request = await Request.findOne({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });

    // State machine: pending -> accepted -> completed (no reverse, no skip)
    const VALID_TRANSITIONS = {
      pending:   ['accepted', 'completed'],
      accepted:  ['completed'],
      completed: []
    };
    if (!VALID_TRANSITIONS[request.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from ${request.status} to ${status}`
      });
    }

    // Who is accepting. Waiters / captains always accept as themselves —
    // a body waiterId is ignored so one waiter cannot pin a request on
    // (or steal credit from) another. Admins / managers may assign it to
    // another staff member, but only an ACTIVE staff member of this
    // tenant (and of their branch when they are branch-pinned).
    let acceptingWaiter = req.user._id;
    if (status === 'accepted' && ['admin', 'manager'].includes(req.user.role)
        && waiterId && String(waiterId) !== String(req.user._id)) {
      const pinned = pinnedBranchId(req);
      const staff = await User.findOne({
        _id: waiterId,
        restaurant: tenantId(req),
        role: { $in: ['waiter', 'captain', 'manager', 'admin'] },
        status: 'active',
        ...(pinned ? { branch: pinned } : {}),
      }).select('_id').lean();
      if (!staff) {
        return res.status(400).json({ success: false, message: 'Selected staff member is not an active staff member of this restaurant' });
      }
      acceptingWaiter = staff._id;
    }

    if (status === 'accepted') {
        request.status = 'accepted';
        request.waiter = acceptingWaiter;
        request.acceptedAt = new Date();
    } else if (status === 'completed') {
        request.status = 'completed';
        request.completedAt = new Date();
    }

    await request.save();

    // When the waiter completes the request, drop the matching entry from
    // table.alerts so the admin's "Attention Required" drawer/badge clears
    // automatically. Pull on accept too — accepting means a waiter has
    // taken ownership, so the urgent alert can come down.
    if (status === 'completed' || status === 'accepted') {
        try {
            await Table.updateOne(
                { _id: request.table, ...tenantFilter(req) },
                { $pull: { alerts: { requestId: request._id } } },
            );
        } catch (err) {
            logger.warn('Failed to pull table alert:', { error: err.message });
        }
    }
    // Service-request updates go to (a) staff rooms at the owning branch
    // and (b) the customer's table room so a guest sees "on the way" /
    // "completed" feedback instantly — not 15s later via poll.
    try {
        const io = getIO();
        const populated = await request.populate('table', 'branch');
        const reqBranch = populated?.table?.branch || null;
        const payload = {
            _id: request._id,
            id: request._id,
            type: request.type,
            status: request.status,
            table: request.table,
            priority: request.priority,
            acceptedAt: request.acceptedAt,
            completedAt: request.completedAt,
        };
        emitToStaff(io, reqBranch, EVENTS.REQUEST_UPDATED, payload);
        io.to(`table:${request.table}`).emit(EVENTS.REQUEST_UPDATED, payload);
        // Tell the admin grid to refetch — alerts array just changed.
        emitToAdmin(io, reqBranch, EVENTS.TABLE_UPDATED, { tableId: request.table?.toString?.() });
    } catch (err) {
        logger.warn('Socket emit failed for request update:', { error: err.message });
    }
    res.status(200).json({ success: true, request });
  } catch (error) {
    logger.error('Update request status error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update request' });
  }
};
