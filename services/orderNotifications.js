/**
 * orderNotifications — order-domain notification / socket fan-out.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31) and
 * migrated to the single notification entry point
 * services/notificationService.notify() (BUGS_REPORT #32). Each persisted
 * row keeps its exact fields (title, description, category, priority,
 * recipientRole, recipient, meta, branch) and each live toast keeps its
 * exact target, event name and payload. notify() persists first and then
 * emits, and never throws — a failed Notification write no longer aborts
 * the rest of the fan-out (or, for awaited callers, fails the request).
 *
 * Pure socket events that carry no Notification row (order:new,
 * order:ready, order:updated, table:updated …) are still emitted directly.
 */
const logger = require('../utils/logger');
const { getIO, emitToKitchen, emitToWaiter } = require('../utils/socket');
const { tenantId } = require('../utils/tenantScope');
const { notify } = require('./notificationService');
const EVENTS = require('../realtime/events');
const { summariseItems, newOrderAdminDescription, emitOrderEvent, emitStaffTable } = require('./orderHelpers');

// Counter-side (no-prep) order is ready: waiter bell row + order:ready to
// the waiter room, the per-order guest room and the owner's room. Used by
// createOrder's mixed-cart split and the repeat flows.
function notifyCounterOrderReady(doc, hasTable) {
  return notify({
    restaurant: doc.restaurant,
    branch: doc.branch || null,
    audience: 'waiter',
    rooms: [`order:${doc.orderId}`, doc.user ? doc.user.toString() : null],
    event: EVENTS.ORDER_READY,
    payload: { orderId: doc.orderId },
    notification: {
      title: 'Counter Order Ready',
      description: `Order ${doc.orderId} is ready (no preparation needed) — ${doc.items.length} item(s)`,
      category: 'Order', recipientRole: 'waiter', priority: 'high',
      meta: { orderId: doc.orderId, table: hasTable ? 'Dine-in' : 'Takeaway' },
    },
  });
}

// createOrder: post-response notification + socket tasks, as
// [label, asyncFn] pairs for runAfterResponse.
function buildCreateOrderNotificationTasks({
  savedOrder, counterSideOrder, settings, hasKitchenWork, type, validTableId,
  resolvedTableId, resolvedAreaId, resolvedTableName, authoritativeTotal,
}) {
  const postResponseTasks = [];
  if (counterSideOrder) {
    const counterDoc = counterSideOrder;
    postResponseTasks.push(['counter-split notify', async () => {
      await notifyCounterOrderReady(counterDoc, !!validTableId);
    }]);
  }

  // settings was already fetched above for the loyalty-points
  // calculation; reuse it here for the notification gate.
  if (!settings || settings.notifications?.newOrder !== false) {
    postResponseTasks.push(['new-order notify', async () => {
      const io = getIO();
      const tenant = savedOrder.restaurant;
      const orderBranch = savedOrder.branch || null;
      // Bell rows (+ their toasts), written in parallel.
      const notifs = [];
      // Chef notification only when there's actual kitchen work. A
      // counter-only order (water + ice cream) is already 'ready' —
      // pinging the chef would make their KDS show a card they have
      // nothing to do on.
      if (hasKitchenWork) {
        notifs.push(notify({
          restaurant: tenant, branch: orderBranch,
          notification: {
            title: 'New Order Received',
            description: `New ${type} order ${savedOrder.orderId} with ${savedOrder.items.length} items.`,
            category: 'Order', recipientRole: 'chef',
            meta: { orderId: savedOrder.orderId, itemCount: savedOrder.items.length, table: validTableId ? 'Dine-in' : 'Takeaway' },
          },
        }));
      }
      // Admin bell row carries the total; the toast is the glanceable
      // "type · table · items" line.
      notifs.push(notify({
        restaurant: tenant, branch: orderBranch,
        audience: 'admin', io,
        payload: { title: 'New Order', description: newOrderAdminDescription(savedOrder, resolvedTableName) },
        notification: {
          title: 'New Order',
          description: `${newOrderAdminDescription(savedOrder, resolvedTableName)} · ₹${authoritativeTotal}`,
          category: 'Order', recipientRole: 'admin',
          meta: { orderId: savedOrder.orderId },
        },
      }));
      // Counter-only orders are immediately ready — ping the waiter
      // queue so they collect from the cooler / counter.
      if (!hasKitchenWork) {
        notifs.push(notify({
          restaurant: tenant, branch: orderBranch,
          notification: {
            title: 'Order Ready for Pickup',
            description: `Order ${savedOrder.orderId} is ready (no preparation needed)`,
            category: 'Order', recipientRole: 'waiter', priority: 'high',
            meta: { orderId: savedOrder.orderId, table: validTableId ? 'Dine-in' : 'Takeaway' },
          },
        }));
      }
      if (savedOrder.user) {
        // Customer notification stays tenant-level (branch: null).
        notifs.push(notify({
          restaurant: tenant, branch: null,
          recipients: [savedOrder.user], io,
          payload: { title: 'Order Placed', description: `Your order ${savedOrder.orderId} is confirmed!` },
          notification: {
            title: 'Order Placed Successfully',
            description: hasKitchenWork
              ? `Your order ${savedOrder.orderId} has been placed. We're preparing it now!`
              : `Your order ${savedOrder.orderId} is ready for pickup!`,
            category: 'Order', recipientRole: 'customer',
            meta: { orderId: savedOrder.orderId, amount: authoritativeTotal },
          },
        }));
      }
      await Promise.all(notifs);

      // Shared new-order payload — carries enough for every staff toast
      // (chef / waiter / captain / manager) to read
      // "Dine-in · Table PD-01 · Sample soup ×2" without a follow-up
      // fetch. `tableName` is null and `items` is '' for takeaway/no-table,
      // which the frontend handles gracefully.
      const orderPayload = {
        orderId: savedOrder.orderId,
        type: savedOrder.type,
        table: resolvedTableId,
        area: resolvedAreaId,
        tableName: resolvedTableName,
        items: summariseItems(savedOrder.items),
      };
      // Only ping the kitchen when there's actual kitchen work to do.
      if (hasKitchenWork) {
        emitToKitchen(io, orderBranch, EVENTS.ORDER_NEW, orderPayload);
      } else {
        // Counter-only path: tell the waiter room directly + the
        // per-order room so the customer's tracking page lights up.
        emitToWaiter(io, orderBranch, EVENTS.ORDER_READY, { orderId: savedOrder.orderId });
        io.to(`order:${savedOrder.orderId}`).emit(EVENTS.ORDER_READY, { orderId: savedOrder.orderId });
        if (savedOrder.user) io.to(savedOrder.user.toString()).emit(EVENTS.ORDER_READY, { orderId: savedOrder.orderId });
      }
      // Skip the waiter ping on kiosk orders — kiosk is self-service,
      // there is no waiter to assign or table to walk to.
      if (savedOrder.source !== 'kiosk') {
        // For dine-in orders that resolved to a real table, honour the
        // waiter-assignment filter so a waiter pinned to "Outdoor" doesn't
        // get pings for "Indoor" tables. Takeaway / pickup / counter
        // orders have no table context so they keep the branch broadcast.
        if (savedOrder.type === 'dine-in' && resolvedTableId) {
          try {
            const { findWaitersForTable } = require('../utils/staffAssignment');
            const matchedWaiterIds = await findWaitersForTable({
              restaurant: tenant,
              branch: orderBranch,
              tableId: resolvedTableId,
              tableAreaId: resolvedAreaId,
            });
            if (matchedWaiterIds.length > 0) {
              for (const wid of matchedWaiterIds) {
                io.to(wid).emit(EVENTS.ORDER_NEW, orderPayload);
              }
            } else {
              emitToWaiter(io, orderBranch, EVENTS.ORDER_NEW, orderPayload);
            }
          } catch (err) {
            logger.warn('findWaitersForTable failed on order:new; broadcasting', { error: err.message });
            emitToWaiter(io, orderBranch, EVENTS.ORDER_NEW, orderPayload);
          }
        } else {
          emitToWaiter(io, orderBranch, EVENTS.ORDER_NEW, orderPayload);
        }
      }
    }]);
  }
  return postResponseTasks;
}

// updateOrderStatus: per-transition waiter / customer notifications.
async function notifyStatusTransition({ status, oldOrder, order }) {
  // Notify waiter when chef marks order as ready
  if (status === 'ready' && oldOrder.status !== 'ready') {
    await notify({
      restaurant: order.restaurant,
      branch: order.branch || null,
      notification: {
        title: 'Order Ready for Pickup',
        description: `Order ${order.orderId} is ready to be served`,
        category: 'Order',
        recipientRole: 'waiter',
        priority: 'high',
        meta: { orderId: order.orderId, table: order.table?.toString() },
      },
    });

    // Notify Customer - Order Ready
    if (order.user) {
      await notify({
        restaurant: order.restaurant,
        recipients: [order.user],
        payload: { title: 'Order Ready!', description: `Your order ${order.orderId} is ready!` },
        notification: {
          title: 'Your Order is Ready!',
          description: `Order ${order.orderId} is ready. ${order.type === 'dine-in' ? 'It will be served to your table shortly.' : 'Please collect it from the counter.'}`,
          category: 'Order',
          recipientRole: 'customer',
          priority: 'high',
          meta: { orderId: order.orderId },
        },
      });
    }
  }

  // Notify Customer - Order Preparing
  if (status === 'preparing' && oldOrder.status !== 'preparing' && order.user) {
    await notify({
      restaurant: order.restaurant,
      recipients: [order.user],
      payload: { title: 'Preparing', description: `Your order ${order.orderId} is being prepared!` },
      notification: {
        title: 'Order Being Prepared',
        description: `Your order ${order.orderId} is now being prepared by our chef.`,
        category: 'Order',
        recipientRole: 'customer',
        meta: { orderId: order.orderId },
      },
    });
  }

  // Notify Customer - Order Served/Delivered
  if (status === 'served' && oldOrder.status !== 'served' && order.user) {
    const servedMsg = order.type === 'takeaway' ? 'has been picked up' : 'has been served';
    await notify({
      restaurant: order.restaurant,
      recipients: [order.user],
      payload: { title: order.type === 'takeaway' ? 'Delivered' : 'Served', description: `Your order ${order.orderId} ${servedMsg}!` },
      notification: {
        title: order.type === 'takeaway' ? 'Order Delivered' : 'Order Served',
        description: `Your order ${order.orderId} ${servedMsg}. Enjoy your meal!`,
        category: 'Order',
        recipientRole: 'customer',
        meta: { orderId: order.orderId },
      },
    });
  }

  // Notify Customer - Order Cancelled by Admin
  if (status === 'cancelled' && oldOrder.status !== 'cancelled' && order.user) {
    await notify({
      restaurant: order.restaurant,
      recipients: [order.user],
      payload: { title: 'Order Cancelled', description: `Your order ${order.orderId} was cancelled by Admin.` },
      notification: {
        title: 'Order Cancelled',
        description: `Your order ${order.orderId} was cancelled by the administrator.`,
        category: 'Order',
        recipientRole: 'customer',
        priority: 'high',
        meta: { orderId: order.orderId },
      },
    });
  }
}

// updateOrderStatus: order:updated fan-out + the gated order-ready ping
// (and the assigned waiter's personal notification).
async function emitStatusUpdateEvents({ io, status, order, settings }) {
  emitOrderEvent(
    EVENTS.ORDER_UPDATED,
    { orderId: order.orderId, status: order.status, paymentStatus: order.paymentStatus },
    order
  );

  // Gate Order Ready notification with settings
  if (status === 'ready' && (!settings || settings.notifications?.orderReady !== false)) {
    emitToWaiter(io, order.branch, EVENTS.ORDER_READY, { orderId: order.orderId });
    // Also notify the order owner + per-order room so the customer
    // tracking page lights up immediately.
    if (order.user) io.to(String(order.user)).emit(EVENTS.ORDER_READY, { orderId: order.orderId });
    io.to(`order:${order.orderId}`).emit(EVENTS.ORDER_READY, { orderId: order.orderId });
    // Also create a DB notification for the waiter if assigned
    if (order.waiter) {
      await notify({
        io,
        restaurant: order.restaurant,
        branch: order.branch || null,
        recipients: [order.waiter],
        payload: { title: 'Order Ready', description: `Order ${order.orderId} is ready!` },
        notification: {
          title: 'Order Ready',
          description: `Order ${order.orderId} is ready for pickup!`,
          category: 'Order',
          recipientRole: 'waiter',
          meta: { orderId: order.orderId },
        },
      });
    }
  }
}

// requestCounterPayment: admin + captain role notifications and the
// table's own waiter, plus the live dashboard events.
async function notifyCounterPaymentRequested(req, { order, payableTotal, tableLabel, tableAreaName, responsibleWaiterId }) {
  try {
    const tenant = tenantId(req);
    const orderBranch = order.branch || null;
    // tableId lets the admin's "Settle cash" CTA open that table's drawer
    // in the admin Tables screen (the label alone can be ambiguous).
    const payload = {
      orderId: order.orderId,
      amount: payableTotal,
      table: tableLabel,
      tableId: order.table ? order.table.toString() : null,
    };
    await notify({
      restaurant: tenant,
      branch: orderBranch,
      audience: 'admin',
      event: EVENTS.COUNTER_PAYMENT_REQUESTED,
      payload,
      notification: {
        title: 'Counter Payment Requested',
        description: `${tableLabel} wants to settle the bill — ₹${payableTotal} cash`,
        category: 'Payment',
        recipientRole: 'admin',
        priority: 'high',
        meta: { orderId: order.orderId, amount: payableTotal, table: order.table?.toString() || null },
      },
    });
    // Captains own bill settlement on the floor — role broadcast
    // (branch-scoped by the notification list query), via the captain
    // rooms (tenant-scoped, branch + tenant-level) rather than the whole
    // waiter room.
    const floorMeta = {
      orderId: order.orderId,
      amount: payableTotal,
      table: tableLabel.replace(/^Table\s+/i, ''),
      area: tableAreaName,
    };
    await notify({
      restaurant: tenant,
      branch: orderBranch,
      audience: 'captain',
      event: EVENTS.COUNTER_PAYMENT_REQUESTED,
      payload,
      notification: {
        title: 'Counter Payment Requested',
        description: `${tableLabel} — please collect ₹${payableTotal} cash`,
        category: 'Payment',
        recipientRole: 'captain',
        priority: 'high',
        meta: floorMeta,
      },
    });
    // …and the table's own waiter only (personal notification), not
    // every waiter at the branch.
    if (responsibleWaiterId) {
      await notify({
        restaurant: tenant,
        branch: orderBranch,
        recipients: [responsibleWaiterId],
        event: EVENTS.COUNTER_PAYMENT_REQUESTED,
        payload,
        also: [{ event: EVENTS.NOTIFICATION_NEW, payload: { title: 'Counter Payment Requested', description: `${tableLabel} — ₹${payableTotal}` } }],
        notification: {
          title: 'Counter Payment Requested',
          description: `${tableLabel} — please collect ₹${payableTotal} cash`,
          category: 'Payment',
          recipientRole: 'waiter',
          priority: 'high',
          meta: floorMeta,
        },
      });
    }

    // Refresh dashboards so the new flag renders without a manual reload.
    emitOrderEvent(
      EVENTS.ORDER_UPDATED,
      { orderId: order.orderId, status: order.status, paymentStatus: order.paymentStatus, counterPaymentRequestedAt: order.counterPaymentRequestedAt },
      order
    );
  } catch (socketErr) {
    logger.warn('counter-payment notification fanout failed:', socketErr.message);
  }
}

// cancelOrder (customer): kitchen + admin + customer notifications and the
// order:cancelled / table:updated fan-out.
async function notifyCustomerCancellation(order, reason) {
  // Notify kitchen + admin
  await notify({
    restaurant: order.restaurant,
    branch: order.branch || null,
    notification: {
      title: 'Order Cancelled',
      description: `Order ${order.orderId} was cancelled by the customer. Reason: ${reason || 'Not provided'}`,
      category: 'Order',
      recipientRole: 'chef',
      priority: 'high',
      meta: { orderId: order.orderId },
    },
  });

  await notify({
    restaurant: order.restaurant,
    branch: order.branch || null,
    notification: {
      title: 'Order Cancelled',
      description: `Order ${order.orderId} cancelled. Reason: ${reason || 'Not provided'}`,
      category: 'Order',
      recipientRole: 'admin',
      meta: { orderId: order.orderId },
    },
  });

  // Socket.io — notify dashboards of cancellation + table freed.
  // order:cancelled goes to staff + owning customer + per-order room so the
  // customer's tracking page can react even if they're a guest.
  try {
    emitOrderEvent(EVENTS.ORDER_CANCELLED, { orderId: order.orderId, table: order.table }, order);
    if (order.type === 'dine-in' && order.table) {
      emitStaffTable(EVENTS.TABLE_UPDATED, { tableId: order.table, status: 'free' }, order.branch);
    }
  } catch { /* socket not critical */ }

  // Notify Customer - Order Cancelled confirmation (bell row + toast)
  if (order.user) {
    await notify({
      restaurant: order.restaurant,
      recipients: [order.user],
      payload: { title: 'Order Cancelled', description: `Order ${order.orderId} has been cancelled.` },
      notification: {
        title: 'Order Cancelled',
        description: `Your order ${order.orderId} has been cancelled successfully.`,
        category: 'Order',
        recipientRole: 'customer',
        meta: { orderId: order.orderId },
      },
    });
  }
}

// A paid order's staff + customer payment notifications (updateOrderStatus
// mark-paid and the wallet-finalize path share the same rows / toasts).
//   • admin bell row + admin toast ("Payment Confirmed")
//   • optional customer "Points Earned!" row (no toast)
//   • customer "Payment Successful" row + "Payment Confirmed" toast
async function notifyPaymentConfirmed({ order, restaurant, earnedPoints, includePointsRow }) {
  const notifs = [
    notify({
      restaurant,
      branch: order.branch || null,
      audience: 'admin',
      notification: {
        title: 'Payment Confirmed',
        description: `Payment of ₹${order.total} received for ${order.orderId}`,
        category: 'Payment', recipientRole: 'admin',
        meta: { orderId: order.orderId, amount: order.total },
      },
    }),
  ];
  if (includePointsRow && earnedPoints > 0 && order.user) {
    notifs.push(notify({
      restaurant,
      recipients: [order.user],
      // Row only — the points are announced inside the payment toast.
      event: null,
      notification: {
        title: 'Points Earned!',
        description: `You earned ${earnedPoints} loyalty points from order ${order.orderId}`,
        category: 'Points', recipientRole: 'customer',
        meta: { orderId: order.orderId, amount: earnedPoints },
      },
    }));
  }
  if (order.user) {
    notifs.push(notify({
      restaurant,
      recipients: [order.user],
      payload: { title: 'Payment Confirmed', description: `Payment of ₹${order.total} confirmed.${earnedPoints > 0 ? ` +${earnedPoints} points!` : ''}` },
      notification: {
        title: 'Payment Successful',
        description: `Payment of ₹${order.total} confirmed for order ${order.orderId}. ${earnedPoints > 0 ? `You earned ${earnedPoints} loyalty points!` : ''}`,
        category: 'Payment', recipientRole: 'customer',
        meta: { orderId: order.orderId, amount: order.total },
      },
    }));
  }
  await Promise.all(notifs);
}

module.exports = {
  notifyCounterOrderReady,
  notifyCustomerCancellation,
  buildCreateOrderNotificationTasks,
  notifyStatusTransition,
  emitStatusUpdateEvents,
  notifyCounterPaymentRequested,
  notifyPaymentConfirmed,
  notify,
  EVENTS,
};
