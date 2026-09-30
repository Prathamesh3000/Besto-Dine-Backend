/**
 * orderFormatters — pure response-shape mappers for the order read APIs.
 *
 * Extracted verbatim from controllers/orderController.js (BUGS_REPORT #31).
 * The frontend depends on these exact shapes — change with care.
 */
const {
  computePrepStartAt,
  computeQueueBucket,
  parsePickupAt,
  minutesToPickup,
  isUrgentTakeaway,
  totalPrepMinutes,
} = require('../utils/pickupTime');

// GET /orders/live — one row of the staff live board.
function formatLiveOrder(o) {
  // isUrgent: ready order that has been waiting more than 10 minutes
  const minutesWaiting = (Date.now() - new Date(o.updatedAt)) / 60000;
  const isUrgent = o.status === 'ready' && minutesWaiting > 10;

  return {
    _id: o._id,
    id: o.orderId,
    // tableId — short display name for the colored square in WaiterOrders
    tableId: o.table ? o.table.name : 'TA',
    // table — object with area for client-side floor filtering in WaiterOrders.jsx
    // o.table.area is the area ObjectId (serialised to string), matching activeFloor.
    // `_id` is shipped so a table-pinned waiter (assignedTables) can scope the
    // Orders tab to just their tables, the same way the Home tab does.
    // assignedWaiter — a table a captain assigned to this waiter stays
    // in their scope even when it's outside their configured areas.
    table: o.table
      ? { _id: o.table._id, name: o.table.name, area: o.table.area, assignedWaiter: o.table.assignedWaiter || null }
      : null,
    status: o.status,
    time: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    user: o.customerName,
    isRegistered: !!o.user,       // true if linked to a registered user
    phone: o.phone,
    createdAt: o.createdAt,
    orderDate: new Date(o.createdAt).toLocaleDateString('en-GB'),
    orderTime: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    amountPaid: o.amountPaid,
    items: o.items.map(i => ({
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      instructions: i.instructions || '',
      // Ship the timestamp so the waiter card can split "Original
      // order" items from items appended later. Legacy items
      // without this field fall back to the order's createdAt.
      addedAt: i.addedAt || o.createdAt,
    })),
    moreItems: o.items.length > 2 ? o.items.length - 2 : 0,
    totalItems: o.items.length,   // For ServedOrderCard in WaiterOrders.jsx
    isUrgent,                     // For ReadyOrderCard urgent glow
    note: o.note,
    total: o.total,
    type: o.type,
    pickupTime: o.pickupTime || null,
    pickupLocation: o.pickupLocation || null,
    // Home-delivery sub-doc so the admin Orders dashboard can show
    // the delivery badge + dispatch panel without a /detail round-trip.
    delivery: o.delivery || null,
    branch: o.branch || null,
    tipAmount: o.tipAmount || 0,
    // Surface coupon + wallet-redemption fields so the admin
    // OrderDetailsModal's Bill Summary can render the discount
    // lines without a second /detail round-trip. Without these
    // the modal collapses the breakdown into a single
    // "Adjustments" reconciliation row.
    couponCode: o.couponCode || '',
    couponDiscount: o.couponDiscount || 0,
    pointsRedeemed: o.pointsRedeemed || 0,
    updatedAt: o.updatedAt,
    preparationStartedAt: o.preparationStartedAt || null,
    preparationCompletedAt: o.preparationCompletedAt || null,
    // Channel that produced the order — admin dashboard shows a
    // "Kiosk" badge for source==='kiosk' so staff can spot
    // self-service orders at a glance.
    source: o.source || 'web-customer',
  };
}

// GET /orders/past — one row of the past-orders feed.
function formatPastOrder(o) {
  return {
    _id: o._id,
    id: o.orderId,
    table: o.table ? o.table.name : 'Takeaway',
    status: o.status,
    time: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    user: o.customerName,
    isRegistered: !!o.user,
    phone: o.phone,
    createdAt: o.createdAt,
    orderDate: new Date(o.createdAt).toLocaleDateString('en-GB'),
    orderTime: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    amountPaid: o.amountPaid,
    items: o.items.map(i => ({
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      instructions: i.instructions || '',
      addedAt: i.addedAt || o.createdAt,
    })),
    moreItems: o.items.length > 2 ? o.items.length - 2 : 0,
    note: o.note,
    total: o.total,
    type: o.type,
    pickupTime: o.pickupTime || null,
    pickupLocation: o.pickupLocation || null,
    delivery: o.delivery || null,
    branch: o.branch || null,
    tipAmount: o.tipAmount || 0,
    // Mirror getLiveOrders — the admin Order Details modal expects
    // these on past orders too so the Coupon / Wallet Points lines
    // render in the Bill Summary breakdown.
    couponCode: o.couponCode || '',
    couponDiscount: o.couponDiscount || 0,
    pointsRedeemed: o.pointsRedeemed || 0,
    updatedAt: o.updatedAt,
    preparationStartedAt: o.preparationStartedAt || null,
    preparationCompletedAt: o.preparationCompletedAt || null,
    source: o.source || 'web-customer',
  };
}

// GET /orders/:id/detail — customer tracking view.
function formatOrderDetail(order) {
  return {
    _id: order._id,
    orderId: order.orderId,
    id: order.orderId,
    table: order.table ? order.table.name : 'Takeaway',
    status: order.status,
    user: order.customerName,
    phone: order.phone,
    orderDate: new Date(order.createdAt).toLocaleDateString('en-GB'),
    orderTime: new Date(order.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    amountPaid: order.amountPaid,
    // Refund snapshot so the customer-facing tracking page can render
    // "₹X refunded to your wallet/original payment method on <date>"
    // when an admin issues a refund. Without these the tracker had
    // paymentStatus='Refunded' but no detail to show — leaving the
    // customer unaware their refund had been processed.
    refundedAmount: Number(order.refundedAmount) || 0,
    refunds: Array.isArray(order.refunds)
      ? order.refunds.map(r => ({
        amount: Number(r.amount) || 0,
        reason: r.reason || '',
        // Razorpay refund id presence is how the customer tells
        // an online-method refund apart from a wallet/cash refund.
        // Actor identity is intentionally omitted — not customer-facing.
        hasGatewayRefund: Boolean(r.razorpayRefundId),
        createdAt: r.createdAt,
      }))
      : [],
    items: order.items.map(i => ({
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      selectedSizes: i.selectedSizes || [],
      selectedToppings: i.selectedToppings || [],
      instructions: i.instructions || '',
      prepStation: i.prepStation || 'kitchen',
      addedAt: i.addedAt || order.createdAt,
    })),
    note: order.note,
    total: order.total,
    type: order.type,
    // Bill-breakdown fields — needed by the customer Order Summary so
    // the math (subtotal + tax − coupon − wallet = total) reconciles
    // visually. Without these the OrderConfirmed page showed taxes
    // adding up to MORE than Total, leaving the customer confused.
    tipAmount: Number(order.tipAmount) || 0,
    couponCode: order.couponCode || '',
    couponDiscount: Number(order.couponDiscount) || 0,
    pointsRedeemed: Number(order.pointsRedeemed) || 0,
    walletAmountPaid: Number(order.walletAmountPaid) || 0,
    pickupTime: order.pickupTime || null,
    pickupLocation: order.pickupLocation || null,
    branch: order.branch || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    // Status-transition timestamps so the customer tracking timeline
    // can show "Preparing started at 8:50 PM" etc. without a second
    // round-trip. paidAt is also returned because the customer-facing
    // "Order Confirmed" moment correlates with payment time when the
    // order is created post-payment (takeaway flow).
    preparationStartedAt: order.preparationStartedAt || null,
    preparationCompletedAt: order.preparationCompletedAt || null,
    servedAt: order.servedAt || null,
    cancelledAt: order.cancelledAt || null,
    paidAt: order.paidAt || null,
    counterPaymentRequestedAt: order.counterPaymentRequestedAt || null,
    // Scheduled-takeaway exposure for the customer tracking page.
    // `isScheduled` flips false the moment the order crosses its
    // prep-start moment so the tracking page can swap "Kitchen starts
    // at X PM" for the normal "Preparing Order" text. `kitchenStartAt`
    // is computed from the actual item prep times (Σ prepTime × qty)
    // — not a flat 30 min — so a long-prep order (e.g. biryani 35 min)
    // shows the right honest start time.
    isScheduled: (() => {
      const p = computePrepStartAt(order);
      return p ? p.getTime() > Date.now() : false;
    })(),
    kitchenStartAt: (() => {
      const p = computePrepStartAt(order);
      return p ? p.toISOString() : null;
    })(),
    totalPrepMinutes: totalPrepMinutes(order),
  };
}

// GET /orders/my-orders — one row of the customer's history.
function formatMyOrder(o) {
  return {
    _id: o._id,
    id: o.orderId,
    table: o.table ? o.table.name : 'Takeaway',
    status: o.status,
    time: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    user: o.customerName,
    phone: o.phone,
    createdAt: o.createdAt,
    orderDate: new Date(o.createdAt).toLocaleDateString('en-GB'),
    orderTime: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    amountPaid: o.amountPaid,
    // menuItem is required by the customer's "Repeat Order" flow —
    // takeaway repeats rebuild the cart by id and the cart-checkout
    // payload validates each line against the live menu. Stripping
    // it here used to make every takeaway repeat fail with the
    // "Some items can't be repeated" toast.
    items: o.items.map(i => ({
      menuItem: i.menuItem || null,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      selectedSizes: i.selectedSizes || [],
      selectedToppings: i.selectedToppings || [],
      instructions: i.instructions || '',
    })),
    moreItems: o.items.length > 2 ? o.items.length - 2 : 0,
    note: o.note,
    total: o.total,
    type: o.type,
    // Bill-breakdown fields — needed by the takeaway confirmation
    // view in Orders.jsx so the line ledger reconciles to total.
    tipAmount: Number(o.tipAmount) || 0,
    couponCode: o.couponCode || '',
    couponDiscount: Number(o.couponDiscount) || 0,
    pointsRedeemed: Number(o.pointsRedeemed) || 0,
    walletAmountPaid: Number(o.walletAmountPaid) || 0,
    pickupTime: o.pickupTime || null,
    pickupLocation: o.pickupLocation || null,
    branch: o.branch || null,
  };
}

// GET /orders/kitchen — one chef KDS card. `mergedLabelFor` renders a
// merged table group as "5, 6, 7".
function formatKitchenOrder(o, now, mergedLabelFor) {
  // "Waiting on the pass" is measured from when the kitchen marked it
  // ready — updatedAt drifts on every unrelated save.
  const minutesWaiting = (now - new Date(o.preparationCompletedAt || o.updatedAt)) / 60000;
  const queueBucket = computeQueueBucket(o, now);
  // Urgent rule: takeaway pickup ≤ 10 min away (spec) OR the
  // legacy "ready > 10 min" wait that already flagged dine-in
  // orders left sitting on the pass.
  const isUrgent = isUrgentTakeaway(o, now)
    || (o.status === 'ready' && minutesWaiting > 10);
  const prepStartAt = computePrepStartAt(o);
  const pickupAtIso = (() => {
    const p = parsePickupAt(o);
    return p ? p.toISOString() : null;
  })();
  const minutesToPickupVal = minutesToPickup(o, now);

  // Normalise table.area so it is ALWAYS either null or an object
  // with a readable name. Previously we passed through whatever
  // populate returned (ObjectId when shallow, object when nested),
  // which caused the admin / QR modals to render a raw ObjectId
  // like "65f1a2..." in place of an area label.
  const areaObj = o.table?.area && typeof o.table.area === 'object'
    ? { _id: o.table.area._id, name: o.table.area.name }
    : null;

  const tableLabel = o.table ? mergedLabelFor(o.table) : null;
  return {
    _id: o._id,
    id: o.orderId,
    tableId: tableLabel || 'TA',
    table: o.table ? { name: tableLabel, area: areaObj } : null,
    status: o.status,
    time: new Date(o.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    user: o.customerName,
    phone: o.phone,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    // Dedicated per-status stamps. The chef card anchors its
    // Preparing / Ready-for-Pickup timers on these; without them it
    // fell back to updatedAt, which ANY save bumps (payment, rating,
    // table move…) so the "ready for" timer kept resetting to 0.
    preparationStartedAt: o.preparationStartedAt || null,
    preparationCompletedAt: o.preparationCompletedAt || null,
    orderDate: new Date(o.createdAt).toLocaleDateString('en-GB'),
    items: o.items.map(i => ({
      _id: i._id,
      // menuItem id + size/topping snapshot let the chef card tell
      // "Pizza (Large, extra cheese)" apart from a plain "Pizza".
      // They were dropped here, so the card's same-dish merge keyed
      // on name alone and collapsed different variants of a dish
      // into one line, losing the customisation entirely.
      menuItem: i.menuItem || '',
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      instructions: i.instructions || '',
      category: i.category || '',
      vegType: i.vegType || '',
      prepStation: i.prepStation || 'kitchen',
      selectedSizes: (i.selectedSizes || []).map(s => ({ name: s?.name })).filter(s => s.name),
      selectedToppings: (i.selectedToppings || []).map(t => ({ name: t?.name })).filter(t => t.name),
      prepTimeMinutes: typeof i.prepTimeMinutes === 'number' ? i.prepTimeMinutes : 15,
      // Ship the timestamp so the chef card can separate
      // "Original order" items from items appended later.
      addedAt: i.addedAt || o.createdAt,
    })),
    totalItems: o.items.length,
    isUrgent,
    note: o.note,
    total: o.total,
    type: o.type,
    // Takeaway-queue fields. Used by the chef dashboard to file
    // each card into Upcoming / Prepare Now / Preparing / Ready
    // for Pickup and to render the countdown timer + urgent
    // highlight. Dine-in orders are always 'ready_to_prepare'
    // with no pickup metadata.
    queueBucket,
    pickupTime: o.pickupTime || null,
    pickupAt: pickupAtIso,
    prepStartAt: prepStartAt ? prepStartAt.toISOString() : null,
    minutesToPickup: minutesToPickupVal,
    pickupLocation: o.pickupLocation || null,
    chef: o.chef ? { _id: o.chef._id, name: o.chef.name } : null
  };
}

// Chef KDS ordering (sorts in place).
function sortKitchenOrders(formattedOrders) {
  // Sort: takeaway orders first by ascending pickupAt (nearest pickup
  // at the top — matches the spec). Within tied pickup times, urgent
  // wins, then prep-start ascending. Dine-in keeps a flat "newest
  // first" order at the bottom so the chef sees the new arrivals.
  formattedOrders.sort((a, b) => {
    if (a.type === 'takeaway' && b.type !== 'takeaway') return -1;
    if (a.type !== 'takeaway' && b.type === 'takeaway') return 1;
    if (a.type === 'takeaway') {
      const aPick = a.pickupAt ? new Date(a.pickupAt).getTime() : Infinity;
      const bPick = b.pickupAt ? new Date(b.pickupAt).getTime() : Infinity;
      if (aPick !== bPick) return aPick - bPick;
      if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;
      const aPrep = a.prepStartAt ? new Date(a.prepStartAt).getTime() : Infinity;
      const bPrep = b.prepStartAt ? new Date(b.prepStartAt).getTime() : Infinity;
      return aPrep - bPrep;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return formattedOrders;
}

// GET /orders/kitchen/completed — one row of the completed drawer.
function formatCompletedKitchenOrder(o) {
  return {
    _id: o._id,
    orderId: o.orderId,
    type: o.type,
    total: o.total,
    customerName: o.customerName,
    tableName: o.table?.name || null,
    areaName: o.table?.area?.name || null,
    itemCount: (o.items || []).reduce((s, it) => s + (Number(it.quantity) || 1), 0),
    items: (o.items || []).map((it) => ({ name: it.name, quantity: it.quantity })),
    createdAt: o.createdAt,
    completedAt: o.preparationCompletedAt || null,
    servedAt: o.servedAt || o.updatedAt,
    // Minutes from order placed to kitchen done. Null when the
    // order predates per-status timestamps rather than guessed
    // from updatedAt, which any unrelated save would have skewed.
    prepMinutes: o.preparationCompletedAt
      ? Math.max(0, Math.round((new Date(o.preparationCompletedAt) - new Date(o.createdAt)) / 60000))
      : null,
  };
}

module.exports = {
  formatLiveOrder,
  formatPastOrder,
  formatOrderDetail,
  formatMyOrder,
  formatKitchenOrder,
  sortKitchenOrders,
  formatCompletedKitchenOrder,
};
