const mongoose = require('mongoose');
const Notification = require('../models/notification');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');

const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const { resolveOwnedBranch } = require('../utils/branchOwnership');

// Build the standard recipient query from authenticated user, scoped to
// the current tenant AND (for branch-pinned staff) to their branch.
//
// Reach rule — a notification reaches this user when EITHER:
//   (a) it was addressed personally (recipient = this user), OR
//   (b) it was broadcast to this user's role (recipient is null and
//       recipientRole ∈ [this.role, 'all']).
//
// The `recipient: null` gate on (b) is what fixed CUS-084: customer
// notifications are stamped with BOTH `recipient: <customerId>` AND
// `recipientRole: 'customer'`, so without the gate every customer
// matched every other customer's notifications via clause (b). That
// produced wrong unread counts and a count that never dropped (A
// could only delete A's items; B's and C's kept refetching). Same
// leak affected waiters' personal withdrawal pings.
//
// Branch rule: a Branch Admin pinned to "FC Road" must never see a
// notification from "Camp" — role-based broadcasts are filtered to the
// pinned branch only; personal notifications bypass the branch filter
// (they're addressed TO this user, even on legacy rows without branch).
const buildRecipientQuery = (req) => {
    const user = req.user;
    const uid = user.id || user._id;
    const roleMatches = [user.role, 'all'];
    const pinned = pinnedBranchId(req);

    if (pinned) {
        return {
            ...tenantFilter(req),
            $or: [
                { recipient: uid },
                { recipient: null, recipientRole: { $in: roleMatches }, branch: pinned },
            ],
        };
    }

    // Tenant owner: honor the admin branch switcher (`?branch=<id>`)
    // so flipping to "Main" in the header narrows role-based pings to
    // that branch. Personal notifications still always reach the
    // addressee regardless of the switcher.
    const raw = req?.query?.branch;
    const branchClause = (() => {
        if (raw === 'tenant-only' || raw === 'none') return { branch: null };
        if (raw && raw !== 'all' && mongoose.isValidObjectId(raw)) return { branch: raw };
        return null;
    })();
    if (branchClause) {
        return {
            ...tenantFilter(req),
            $or: [
                { recipient: uid },
                { recipient: null, recipientRole: { $in: roleMatches }, ...branchClause },
            ],
        };
    }

    return {
        ...tenantFilter(req),
        $or: [
            { recipient: uid },
            { recipient: null, recipientRole: { $in: roleMatches } },
        ],
    };
};

// @desc    Get notifications for current user
// @route   GET /api/notifications
// @access  Protected
exports.getNotifications = async (req, res) => {
  try {
    const query = buildRecipientQuery(req);

    const notifications = await Notification.find(query)
      .select('title description category status priority meta recipient recipientRole createdAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json({ success: true, notifications });
  } catch (error) {
    logger.error('Fetch notifications error:', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
};

// @desc    Mark a single notification as read
// @route   PUT /api/notifications/:id/read
// @access  Protected
exports.markRead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notification ID' });
    }

    // Reuse the list-level recipient scope so a customer can't mark
    // another customer's notification as read just by guessing the id —
    // and so a Branch Admin can't reach across branches. findOneAndUpdate
    // silently no-ops when nothing matches, which is the right semantic
    // here (200 stays idempotent for clients that retry).
    const scope = { ...buildRecipientQuery(req), _id: id };
    await Notification.findOneAndUpdate(scope, { status: 'read' });
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Mark read error:', { error: error.message, id: req.params.id });
    res.status(500).json({ success: false, message: 'Failed to mark notification as read' });
  }
};

// @desc    Mark ALL notifications as read for current user
// @route   PUT /api/notifications/all/read
// @access  Protected
exports.markAllRead = async (req, res) => {
  try {
    const query = buildRecipientQuery(req);
    query.status = 'unread'; // Only update unread ones
    await Notification.updateMany(query, { status: 'read' });
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Mark all read error:', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
};

// @desc    Clear all notifications for current user
// @route   DELETE /api/notifications/clear
// @access  Protected
exports.clearAll = async (req, res) => {
  try {
    const query = buildRecipientQuery(req);
    const result = await Notification.deleteMany(query);
    res.status(200).json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    logger.error('Clear all error:', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, message: 'Failed to clear notifications' });
  }
};

// @desc    Delete a single notification
// @route   DELETE /api/notifications/:id
// @access  Protected
exports.deleteOne = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notification ID' });
    }

    const scope = { ...buildRecipientQuery(req), _id: id };
    await Notification.findOneAndDelete(scope);
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Delete notification error:', { error: error.message, id: req.params.id });
    res.status(500).json({ success: false, message: 'Failed to delete notification' });
  }
};

// @desc    Create a notification (system-internal)
// @route   POST /api/notifications
// @access  Protected
exports.createNotification = async (req, res) => {
  try {
    const { title, description, recipient, recipientRole, category, priority, meta } = req.body;

    // Defence in depth — the route is already staffOnly.
    if (!['admin', 'manager', 'captain', 'waiter', 'chef'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Staff only.' });
    }

    // Validate required fields
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    if (!description?.trim()) {
      return res.status(400).json({ success: false, message: 'Description is required' });
    }
    if (recipient && !mongoose.Types.ObjectId.isValid(recipient)) {
      return res.status(400).json({ success: false, message: 'Invalid recipient ID' });
    }

    // Branch-pinned staff can only create branch-level notifications (their
    // own branch — a different body.branch is refused). Tenant owners can
    // pass an explicit branch of THIS tenant, or leave it null for
    // tenant-wide notifications.
    const branchCheck = await resolveOwnedBranch(req, req.body.branch);
    if (!branchCheck.ok) {
      return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
    }
    const branch = branchCheck.branchId;

    // Persist only (this endpoint never pushed a live event).
    const result = await notify({
      restaurant: tenantId(req),
      branch,
      notification: {
        title: title.trim(),
        description: description.trim(),
        category: category || 'System',
        priority: priority || 'medium',
        recipient: recipient || null,
        recipientRole: recipientRole || 'admin',
        meta,
        status: 'unread',
      },
    });
    const notification = result.docs[0];
    if (!notification) throw result.error || new Error('Notification was not saved');

    res.status(201).json({ success: true, notification });
  } catch (error) {
    logger.error('Create notification error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create notification', ...devError(error) });
  }
};
