/**
 * orderLifecycleService — customer cancel, rating and the admin cleanup
 * endpoints (stale ready orders, empty-order sweep).
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31).
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const RefundRequest = require('../models/refundRequest');
const logger = require('../utils/logger');
const { getSettings } = require('../utils/settingsCache');
const { getIO, emitToStaff } = require('../utils/socket');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { releaseTableAfterOrderClosed } = require('../utils/tableOccupancy');
const { httpError, reply } = require('./orderErrors');
const { orderAccessForCaller } = require('./orderAccess');
const { notifyCustomerCancellation, notify } = require('./orderNotifications');

// Paid order cancelled by the customer → queue a RefundRequest for admin
// approval (never auto-refund). Returns the request doc or null.
async function queueRefundRequestOnCancel(order, reason) {
  // ─── Queue a refund request when a paid order is cancelled ─────────
  //
  // ADM-049 — we no longer auto-refund inside the cancel flow. The
  // tenant wants every refund (online, wallet, cash) to surface in
  // /admin/refunds as a pending RefundRequest the admin must approve
  // before money moves. This catches abusive cancel-then-refund cycles
  // and gives the tenant an audit trail of who decided what.
  //
  // We still NEVER block the cancel itself on a refund-request write —
  // the order has already been cancelled at this point.
  let refundRequest = null;
  if (order.paymentStatus === 'Paid' && Number(order.amountPaid || 0) > 0) {
    const balance = Number(order.amountPaid || 0) - Number(order.refundedAmount || 0);
    if (balance > 0) {
      try {
        // Idempotency — if a pending request already exists for this
        // order (e.g. customer hit cancel twice), surface it instead of
        // 11000-erroring on the unique index.
        refundRequest = await RefundRequest.findOne({
          order: order._id,
          status: 'pending',
          restaurant: order.restaurant,
        });
        if (!refundRequest) {
          refundRequest = await RefundRequest.create({
            restaurant: order.restaurant,
            branch: order.branch || null,
            order: order._id,
            orderIdRef: order.orderId,
            user: order.user || null,
            customerName: order.customerName || '',
            customerPhone: order.phone || '',
            amount: balance,
            reason: reason || 'Customer cancelled',
            source: 'customer-cancel',
            status: 'pending',
          });
        }

        if (order.user) {
          // Bell row only (no live toast), as before.
          await notify({
            restaurant: order.restaurant,
            recipients: [order.user],
            event: null,
            notification: {
              title: 'Refund Requested',
              description: `Your refund of ₹${balance} for order ${order.orderId} is pending admin approval. You'll be notified once it's processed.`,
              category: 'Wallet',
              recipientRole: 'customer',
              priority: 'medium',
              meta: { orderId: order.orderId, amount: balance, refundRequestId: refundRequest._id },
            },
          });
        }

        // Admin notification — keeps the visibility loop the old
        // auto-refund flow had on failure, but now fires on every
        // request instead of only on errors.
        await notify({
          restaurant: order.restaurant,
          branch: order.branch || null,
          notification: {
            title: 'Refund Request — Action Needed',
            description: `Order ${order.orderId} (₹${balance} ${order.paymentMethod || ''}) — customer cancelled. Reason: ${reason || 'Not provided'}`,
            category: 'Payment',
            recipientRole: 'admin',
            priority: 'high',
            meta: {
              orderId: order.orderId,
              amount: balance,
              paymentMethod: order.paymentMethod,
              refundRequestId: refundRequest._id,
            },
          },
        });
      } catch (rrErr) {
        logger.error('Failed to create RefundRequest on cancel', {
          orderId: order.orderId,
          error: rrErr.message,
        });
      }
    }
  }
  return refundRequest;
}

// Cancel an order (customer-facing)
async function cancelOrder(req) {
  const { id } = req.params;
  const { reason } = req.body;

  // Find order by _id or orderId string (scoped to tenant)
  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!order) order = await Order.findOne({ orderId: id, ...tf });
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // Ownership check (bug #7): only the owner, a guest holding the SAME
  // scan session the order was placed under, or staff may cancel.
  // Previously guests (no req.user) skipped the check entirely and
  // could cancel any order by id.
  // Branch-pinned staff get BRANCH_MISMATCH for another branch's order.
  const access = orderAccessForCaller(req, order);
  if (!access.allowed) {
    throw httpError(403, { success: false, code: access.reason, message: 'Not authorized to cancel this order' });
  }

  // Check admin setting: is early cancellation enabled? (per-tenant)
  const settings = await getSettings(req);
  if (settings && !settings.notifications?.earlyCancellation) {
    throw httpError(403, { success: false, message: 'Order cancellation is disabled by admin.' });
  }

  // Block cancellation once chef has started cooking
  if (['preparing', 'ready', 'served'].includes(order.status)) {
    throw httpError(403, {
      success: false,
      message: 'Cannot cancel — the chef has already started preparing your order.'
    });
  }

  // Only 'new' status orders can be cancelled
  if (order.status !== 'new') {
    throw httpError(403, { success: false, message: `Cannot cancel order with status "${order.status}".` });
  }

  order.status = 'cancelled';
  order.note = (order.note ? order.note + ' | ' : '') + `Cancelled by customer: ${reason || 'No reason'}`;
  await order.save();

  // Free the table if it was dine-in (scoped). Unmerges the group if
  // the table is part of a merge so all siblings go back to 'free'
  // together — leaving them in 'merged' after a cancel would ghost
  // the admin dashboard.
  // Another party's still-open order on the same table keeps it
  // occupied (releaseTableAfterOrderClosed repoints activeOrder instead).
  if (order.type === 'dine-in' && order.table) {
    try { await releaseTableAfterOrderClosed(order, tf); }
    catch (err) { logger.warn('Failed to free table on cancel:', err.message); }
  }

  const refundRequest = await queueRefundRequestOnCancel(order, reason);

  await notifyCustomerCancellation(order, reason);

  return reply(200, {
    success: true,
    message: 'Order cancelled successfully',
    order,
    // ADM-049 — when the order was paid, a pending RefundRequest has
    // been queued for admin approval. Surface enough info that the
    // client can show "Refund of ₹X requested — pending admin approval".
    refundRequest: refundRequest
      ? {
        id: refundRequest._id,
        status: refundRequest.status,
        amount: refundRequest.amount,
      }
      : null,
  });
}

// @desc    Rate an order
// @route   PATCH /api/orders/:id/rating
// @access  Customer (optionalAuth for guests)
async function rateOrder(req) {
  const { id } = req.params;
  const { rating, feedback } = req.body;

  // Numeric 1-5 only — a non-numeric string used to slip past the
  // range check and 500 on the Number cast at save.
  const ratingValue = typeof rating === 'string' && rating.trim() !== '' ? Number(rating) : rating;
  if (typeof ratingValue !== 'number' || !Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
    throw httpError(400, { success: false, message: 'Rating must be between 1 and 5' });
  }

  // Find order by _id or orderId string (scoped to tenant)
  const tf = tenantFilter(req);
  let order = mongoose.Types.ObjectId.isValid(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!order) order = await Order.findOne({ orderId: id, ...tf });
  if (!order) throw httpError(404, { success: false, message: 'Order not found' });

  // Ownership check: only the customer who placed the order, or — for
  // an ownerless guest order — the caller holding its scan session, may
  // rate it. Anonymous callers and other customers are refused.
  const access = orderAccessForCaller(req, order);
  if (!access.allowed || access.isStaff) {
    throw httpError(403, { success: false, code: access.reason, message: 'Not authorized to rate this order' });
  }

  // Only delivered/served orders can be rated
  if (!['served', 'ready'].includes(order.status)) {
    throw httpError(400, { success: false, message: 'Order must be served before rating' });
  }

  // Sanitize feedback (trim + length cap)
  const cleanFeedback = (feedback || '').toString().trim().slice(0, 500);

  order.rating = ratingValue;
  order.feedback = cleanFeedback;
  order.ratedAt = new Date();
  await order.save();

  return reply(200, { success: true, order });
}

// ── Admin: bulk-cancel stale "ready" takeaway orders ────────────────────
// Takeaway orders that the kitchen marked ready but nobody ever collected
// accumulate in the chef's "Ready for Pickup" column indefinitely, because
// the status flip to 'served' is a waiter-side action that only happens
// when the food is physically handed over. When the customer never comes
// back, there is no natural transition out of 'ready'.
//
// This endpoint lets an admin (or a scheduled cleanup job) flip those
// stuck rows to 'cancelled' in one call, scoped to the current tenant +
// branch. We do NOT auto-refund — a paid-but-uncollected order needs a
// human judgment call (store credit vs cash refund vs no-show forfeit),
// so paid orders are surfaced in the response for the admin to review
// manually via the refunds UI.
//
// Body:
//   minutesOld  (number, default 360)  — only orders whose last status
//                                       change is older than this cutoff
//   type        ('takeaway' | 'dine-in' | 'all', default 'takeaway')
//   dryRun      (boolean, default false) — return the candidates without
//                                         changing anything. Used by the
//                                         admin UI to show a preview.
async function cleanupStaleReadyOrders(req) {
  const minutesOld = Math.max(10, Number(req.body?.minutesOld) || 360);
  const typeParam = (req.body?.type || 'takeaway').toLowerCase();
  const dryRun = req.body?.dryRun === true;

  const cutoff = new Date(Date.now() - minutesOld * 60 * 1000);
  const filter = {
    status: 'ready',
    updatedAt: { $lt: cutoff },
    ...tenantFilter(req),
  };
  if (typeParam === 'takeaway' || typeParam === 'dine-in') {
    filter.type = typeParam;
  }
  // Branch-pinned admins only clean up their own branch.
  const pinned = pinnedBranchId(req);
  if (pinned) filter.branch = pinned;

  const candidates = await Order.find(filter).select('orderId type table branch paymentStatus amountPaid updatedAt total note');

  if (dryRun) {
    return reply(200, {
      success: true,
      dryRun: true,
      count: candidates.length,
      paidCount: candidates.filter(o => o.paymentStatus === 'Paid').length,
      cutoff,
      orders: candidates.map(o => ({
        orderId: o.orderId,
        type: o.type,
        paymentStatus: o.paymentStatus,
        amountPaid: o.amountPaid,
        total: o.total,
        stuckSinceMinutes: Math.round((Date.now() - new Date(o.updatedAt).getTime()) / 60000),
      })),
    });
  }

  if (candidates.length === 0) {
    return reply(200, { success: true, count: 0, message: 'No stale ready orders found.' });
  }

  const note = `Auto-cleaned by admin: ready > ${minutesOld} min, likely abandoned.`;
  // Per-order so we can preserve each order's existing note instead of
  // wiping it. The candidate set is usually small (stuck orders are
  // rare) so N sequential updates are fine.
  for (const o of candidates) {
    // Tenant-scoped even though `o` came from a tenant-filtered find —
    // the write itself must never be able to touch another tenant's row.
    await Order.updateOne(
      { _id: o._id, ...tenantFilter(req) },
      { $set: { status: 'cancelled', note: ((o.note ? o.note + ' | ' : '') + note) } }
    );
    // A cancelled dine-in order must release (or repoint) its table like
    // every other cancel path — otherwise the table stays occupied with
    // activeOrder pointing at a cancelled order.
    if (o.type === 'dine-in' && o.table) {
      try {
        const { freedIds } = await releaseTableAfterOrderClosed(o, tenantFilter(req));
        for (const tid of freedIds) {
          emitToStaff(getIO(), o.branch || null, 'table:updated', { tableId: tid, status: 'free' });
        }
      } catch (err) { logger.warn('Failed to free table on stale cleanup:', err.message); }
    }
  }

  // Audit log + admin notification. Paid orders go into a "needs refund"
  // bucket so the admin sees exactly which ones still owe money back.
  const paidOrders = candidates.filter(o => o.paymentStatus === 'Paid' && Number(o.amountPaid || 0) > 0);
  logger.info('Stale ready orders cleaned up', {
    tenant: String(tenantId(req) || ''),
    actor: req.user?.email || req.user?._id,
    count: candidates.length,
    paidCount: paidOrders.length,
    minutesOld,
    type: typeParam,
  });

  if (paidOrders.length > 0) {
    await notify({
      restaurant: tenantId(req),
      branch: pinned || null,
      notification: {
        title: 'Stale orders cancelled — refunds pending',
        description: `${paidOrders.length} paid takeaway order(s) were auto-cancelled (stuck >${minutesOld} min). Review in Refunds to issue manual refunds.`,
        category: 'Payment',
        recipientRole: 'admin',
        priority: 'high',
        meta: {
          paidOrderIds: paidOrders.map(o => o.orderId),
          totalAmount: paidOrders.reduce((s, o) => s + Number(o.amountPaid || 0), 0),
        },
      },
    });
  }

  // Socket: tell every open admin / chef / waiter dashboard to refresh.
  try {
    const io = getIO();
    for (const o of candidates) {
      emitToStaff(io, o.branch || null, 'order:cancelled', { orderId: o.orderId, reason: 'stale-cleanup' });
    }
  } catch { /* socket not critical */ }

  return reply(200, {
    success: true,
    count: candidates.length,
    paidCount: paidOrders.length,
    message: `Cancelled ${candidates.length} stale ready order(s).`,
    paidOrderIds: paidOrders.map(o => o.orderId),
  });
}

// POST /api/v1/orders/admin/cleanup-empty
// Admin-only. Runs the empty-order sweep synchronously and returns
// how many rows were fixed. Safe to call ad-hoc — the sweep itself
// only touches Pending-payment orders with empty items past the
// grace window, so no customer money is at risk.
async function cleanupEmptyOrdersNow(req) {
  const { runEmptyOrderSweep } = require('../utils/emptyOrderSweeper');
  // Tenant-scoped: an admin's "run now" only sweeps their own restaurant.
  // Superadmin (req.restaurant null) sweeps every tenant, as the scheduled job does.
  const result = await runEmptyOrderSweep({ restaurant: req.restaurant });
  return reply(200, {
    success: true,
    cancelled: result.cancelled || 0,
    freedTables: result.freedTables || 0,
    message: result.cancelled
      ? `Cancelled ${result.cancelled} empty order(s), freed ${result.freedTables} table(s).`
      : 'No empty orders needed cleanup.',
  });
}

module.exports = {
  cancelOrder,
  rateOrder,
  cleanupStaleReadyOrders,
  cleanupEmptyOrdersNow,
};
