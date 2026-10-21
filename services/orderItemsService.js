/**
 * orderItemsService — adding items to orders: waiter/captain append
 * (POST /:id/append) and the customer repeat flows (repeat one item,
 * repeat a whole order).
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31).
 * appendOrderItems now recomputes the bill (GST / service charge /
 * additional charges) over the order's items — see
 * orderPricingService.applyAppendToBill.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const Table = require('../models/table');
const MenuItem = require('../models/menuItem');
const idGen = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { getIO, emitToAdmin, emitToKitchen } = require('../utils/socket');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { resolveMergeLeader } = require('../utils/tableMerge');
const { callerPartyKeys, tableUnavailableError } = require('../utils/tableOccupancy');
const { claimSeat } = require('../utils/tableSeats');
const { httpError, reply } = require('./orderErrors');
const {
  isValidObjectId,
  bumpMenuItemOrderCounts,
  revertStatusOnAppend,
  appendItemsMerging,
  partitionItemsByStation,
  emitOrderEvent,
  emitStaffTable,
  lineItemsSubtotal,
} = require('./orderHelpers');
const { scanSessionFromReq, orderAccessForCaller } = require('./orderAccess');
const pricing = require('./orderPricingService');
const { notifyCounterOrderReady } = require('./orderNotifications');
const { nextTokenNumber, tokenModeFor, tablesDisabledError } = require('../utils/orderToken');

// Token-number mode (operations profile tables.useTables:false, design
// §12.2): a repeat that creates a NEW dine-in order gets a token like
// createOrder does. One token per repeat call — the counter and kitchen
// docs of a mixed repeat share it — allocated lazily so a repeat that
// only appends to an open order consumes no number.
function tokenAllocator(req, sourceOrder, tokenMode) {
  let pending = null;
  return () => {
    if (!tokenMode || sourceOrder.type !== 'dine-in') return Promise.resolve(undefined);
    if (!pending) pending = nextTokenNumber(tenantId(req), sourceOrder.branch || null, new Date());
    return pending;
  };
}

// Persist a counter-side Order document for the bottled / packaged /
// no-prep portion of a cart. Saved with status='ready' from the start
// so it skips the chef KDS and lands directly in the waiter pickup
// queue. Returns the saved Order or null on failure.
//
// Mirrors the inline counter-side block inside createOrder; lifted out
// so the repeat-order endpoints can call it without duplicating the
// inventory + socket + notification plumbing.
async function persistCounterSideOrder({
  req,
  type,
  tableId,
  branchId,
  user,
  customerName,
  phone,
  items,
  pickupTime,
  pickupLocation,
  scanSessionId,
  paymentMethod,
  note,
  bare = false,
  tokenNumber,
}) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const counterOrderIdValue = type === 'takeaway' ? idGen.takeawayOrderId() : idGen.orderId();
  try {
    const draft = new Order({
      orderId: counterOrderIdValue,
      restaurant: tenantId(req),
      branch: branchId || null,
      user: user || null,
      type,
      table: tableId || null,
      // Token-number mode: a table-less dine-in repeat is collected by token.
      tokenNumber: tokenNumber || undefined,
      customerName: customerName || 'Guest',
      phone: phone || '',
      items,
      total: 0, // stamped by applyNewOrderBill below
      status: 'ready',
      preparationCompletedAt: new Date(),
      paymentMethod: paymentMethod || 'Not selected',
      pickupTime: type === 'takeaway' ? (pickupTime || null) : undefined,
      pickupLocation: type === 'takeaway' ? (pickupLocation || null) : undefined,
      scanSessionId: scanSessionId || null,
      note: note || '',
    });
    // Repeat orders are real bills — tax them like createOrder does
    // (they used to store the bare item subtotal). `bare`: the counter
    // half of a mixed repeat — like createOrder's split, the kitchen doc
    // carries the tax lines and this doc holds the bare item subtotal.
    if (bare) {
      draft.total = Math.round(lineItemsSubtotal(items) * 100) / 100;
    } else {
      await pricing.applyNewOrderBill(req, draft);
    }
    const doc = await draft.save();
    bumpMenuItemOrderCounts(doc.items, doc.restaurant);

    // Inventory deduct — counter side bypasses 'preparing', so the
    // status-transition hook never fires for it.
    try {
      const { deductInventoryForOrder } = require('../controllers/inventoryController');
      deductInventoryForOrder(doc, tenantId(req), req.user?._id)
        .catch((err) => logger.warn(`Counter-split inventory deduct failed for ${doc.orderId}: ${err.message}`));
    } catch (err) {
      logger.warn('Counter-split inventory setup failed:', err.message);
    }

    // Waiter bell row + order:ready to waiter / order / owner rooms
    // (notify() is best-effort and never throws).
    await notifyCounterOrderReady(doc, !!tableId);

    return doc;
  } catch (err) {
    logger.warn('persistCounterSideOrder save failed:', err.message);
    return null;
  }
}

// A bill that has been settled (or refunded) must never grow: the extra
// items would be cooked and served but never charged.
const SETTLED_PAYMENT_STATUSES = new Set(['Paid', 'Refunded']);
const isSettled = (order) => SETTLED_PAYMENT_STATUSES.has(order?.paymentStatus);

// Repeat endpoints are optionalAuth. The caller must be staff, the
// logged-in owner, or — for an ownerless guest order — hold the scan
// session that placed it (same rule as cancel / payment). Anonymous
// callers without a scan token get 401, everyone else 403.
/**
 * Operations profile: in a pay-first restaurant every dine-in order is
 * paid before it is created, so a customer "repeat" (which places an
 * order with no payment step) is refused — the customer adds the items
 * to the cart and pays. A restaurant that switched "add more items" off
 * refuses it outright. Staff repeats are unaffected.
 */
function assertRepeatAllowedByOps(req, sourceOrder) {
  if (!req.restaurant || sourceOrder.type !== 'dine-in') return;
  if (req.user && req.user.role !== 'customer') return;
  const { resolveOperations, orderIsPayFirst } = require('../utils/operationsProfile');
  const ops = resolveOperations(req.restaurant);
  if (!ops.customerApp.appendToOrder) {
    throw httpError(403, {
      success: false,
      code: 'APPEND_DISABLED',
      message: 'Adding items to an order is not available here. Please place a new order.',
    });
  }
  // Decided from the source round itself ('either' tenants mix both
  // kinds); tenant mode is the fallback for orders without a channel.
  if (orderIsPayFirst(sourceOrder, ops)) {
    throw httpError(409, {
      success: false,
      code: 'REPEAT_REQUIRES_PAYMENT',
      message: 'This restaurant takes payment before cooking. Add the items to your cart and pay to order again.',
    });
  }
}

function assertCanRepeat(req, sourceOrder) {
  const access = orderAccessForCaller(req, sourceOrder);
  if (access.allowed) return;
  if (!req.user && !req.headers['x-scan-token']) {
    throw httpError(401, { success: false, code: 'SCAN_TOKEN_REQUIRED', message: 'Please log in or re-scan the table QR code to repeat this order.' });
  }
  throw httpError(403, { success: false, message: 'Not authorized to repeat this order' });
}

// A dine-in order must have a table (createOrder's TABLE_REQUIRED rule).
// A past bill detached from its table (a later party ordered there) can't
// spawn a table-less "ghost" dine-in order. Kiosk "Eat Here" orders are
// table-less by design, and so is every dine-in order of a restaurant in
// token-number mode (`tokenMode`; a token order itself carries
// tokenNumber) — those are collected by token, not at a table.
function assertRepeatHasTable(sourceOrder, tableId, tokenMode = false) {
  if (tokenMode || sourceOrder.tokenNumber) return;
  if (sourceOrder.type === 'dine-in' && !tableId && sourceOrder.source !== 'kiosk') {
    throw httpError(400, {
      success: false,
      code: 'TABLE_REQUIRED',
      message: 'This order is no longer linked to a table. Scan your table QR code and order from the menu.',
    });
  }
}

// The party a repeat belongs to — the source order's owner, else its
// scan session (staff walk-ins: neither). Used so a repeat never folds
// into ANOTHER party's open bill at the same table.
function repeatPartyFilter(sourceOrder) {
  if (sourceOrder.user) return { user: sourceOrder.user };
  if (sourceOrder.scanSessionId) return { user: null, scanSessionId: sourceOrder.scanSessionId };
  return { user: null, scanSessionId: null };
}

// Merge repeated items into an existing order and recompute its bill with
// the same helper appendOrderItems uses (GST / service charge / additional
// charges on the added items). Returns the change in order.total.
async function appendRepeatItemsToOrder(req, order, items, bareDelta) {
  // Pin legacy items' addedAt before save (see appendOrderItems).
  for (const existing of order.items) {
    if (!existing.addedAt) existing.addedAt = order.createdAt;
  }
  const subtotalBefore = lineItemsSubtotal(order.items);
  const totalBefore = Number(order.total) || 0;
  appendItemsMerging(order.items, items);
  await pricing.applyAppendToBill(req, order, subtotalBefore, bareDelta);
  return Math.round((order.total - totalBefore) * 100) / 100;
}

// ── Repeat one item ─────────────────────────────────────────────────
async function repeatOrderItem(req) {
  const { orderId, itemId } = req.params;
  const { quantity } = req.body;

  const sourceOrder = await Order.findOne({ _id: orderId, ...tenantFilter(req) });
  if (!sourceOrder) throw httpError(404, { success: false, message: 'Source order not found' });
  assertRepeatAllowedByOps(req, sourceOrder);

  // Ownership check — staff, the owner, or the guest's own scan session.
  assertCanRepeat(req, sourceOrder);

  const itemToRepeat = sourceOrder.items.id(itemId);
  if (!itemToRepeat) throw httpError(404, { success: false, message: 'Item not found in order' });

  // Token-number mode: no tables — a new order from this repeat is a
  // table-less token order, whatever table the source may once have had.
  const tokenMode = tokenModeFor(req);
  const repeatTable = tokenMode && sourceOrder.type === 'dine-in' ? null : sourceOrder.table;
  const tokenFor = tokenAllocator(req, sourceOrder, tokenMode);

  // A repeat is a new order on the source table — refuse it once the
  // admin has deleted / disabled that table, or when the bill was
  // detached from its table (TABLE_REQUIRED).
  assertRepeatHasTable(sourceOrder, repeatTable, tokenMode);
  if (sourceOrder.type === 'dine-in' && repeatTable) {
    const srcTable = await Table.findOne({ _id: sourceOrder.table, ...tenantFilter(req) })
      .select('isDeleted isActive status').lean();
    const unavailable = tableUnavailableError(srcTable);
    if (unavailable) throw httpError(unavailable.status, unavailable.body);
    // Seat capacity (QA #13) — same rule as createOrder: a party that
    // isn't seated at the table must claim a seat first.
    const seat = await claimSeat({
      table: { _id: sourceOrder.table },
      tenantFilterObj: tenantFilter(req),
      keys: callerPartyKeys(req, scanSessionFromReq(req)),
    });
    if (!seat.ok) throw httpError(seat.status, seat.body);
  }

  const parsedQty = parseInt(quantity, 10);
  const quantityToRepeat = (Number.isInteger(parsedQty) && parsedQty > 0) ? Math.min(parsedQty, 99) : 1;
  const itemData = {
    ...itemToRepeat.toObject(),
    _id: new mongoose.Types.ObjectId(),
    quantity: quantityToRepeat
  };

  // Re-classify the repeated item. Old source orders predate the
  // prepStation column so a bottled water repeated from a 2024 order
  // would otherwise default to 'kitchen' and end up on the chef KDS.
  const { counterItems: counterPart, kitchenItems: kitchenPart } = partitionItemsByStation([itemData]);
  const isCounterRepeat = counterPart.length === 1;

  // Counter-classified single repeat → never append to a kitchen
  // source. Always persist as a fresh ready order so the waiter
  // picks the bottle / packaged item from the cooler immediately.
  if (isCounterRepeat) {
    const counterDoc = await persistCounterSideOrder({
      req,
      type: sourceOrder.type,
      tableId: repeatTable,
      tokenNumber: await tokenFor(),
      branchId: sourceOrder.branch,
      user: sourceOrder.user,
      customerName: sourceOrder.customerName,
      phone: sourceOrder.phone,
      items: [{ ...counterPart[0], addedAt: new Date() }],
      pickupTime: sourceOrder.pickupTime,
      pickupLocation: sourceOrder.pickupLocation,
      scanSessionId: sourceOrder.scanSessionId,
      note: `Repeated from ${sourceOrder.orderId}`,
    });
    if (!counterDoc) {
      throw httpError(500, { success: false, message: 'Failed to create counter order' });
    }
    if (counterDoc.type === 'dine-in' && counterDoc.table) {
      try {
        await Table.findOneAndUpdate(
          { _id: counterDoc.table, ...tenantFilter(req) },
          { status: 'occupied', activeOrder: counterDoc._id },
        );
        emitStaffTable('table:updated', { tableId: counterDoc.table, status: 'occupied' }, counterDoc.branch);
      } catch (err) { logger.warn('Repeat-item counter table update failed:', err.message); }
    }
    try {
      emitToAdmin(getIO(), counterDoc.branch, 'notification:new', {
        title: 'New Order (Repeat · Counter)',
        description: `Order ${counterDoc.orderId} repeated from ${sourceOrder.orderId}`,
      });
    } catch { /* best-effort */ }
    return reply(200, {
      success: true,
      order: counterDoc,
      isSplit: true,
      splitOrder: counterDoc,
      message: 'Counter item ready — no kitchen prep required',
    });
  }

  const itemForKitchen = kitchenPart[0]; // single item — guaranteed by partition

  // If source order is ACTIVE (and not already paid — a prepaid order
  // still in the kitchen must not grow), add to it
  if (['new', 'preparing', 'ready'].includes(sourceOrder.status) && !isSettled(sourceOrder)) {
    // Stamp addedAt so the customer + chef views can split this
    // repeated item from the original batch on the timeline.
    const stampedItem = { ...itemForKitchen, addedAt: new Date() };
    // Same bill recompute as appendOrderItems — the repeated item
    // attracts GST / service charge / additional charges.
    const repeatDelta = await appendRepeatItemsToOrder(req, sourceOrder, [stampedItem], lineItemsSubtotal([stampedItem]));
    // Status revert on append — see createOrder's matching block
    // for the full rationale. ready → preparing because the new
    // repeated item still needs cooking; the order is no longer
    // "fully ready" until the kitchen finishes the new line.
    if (sourceOrder.status === 'ready') {
      sourceOrder.status = 'preparing';
      sourceOrder.preparationCompletedAt = undefined;
    }
    await sourceOrder.save();

    // Re-emit kitchen events so the chef KDS picks the order
    // back up out of the "Ready" column when status reverted.
    try {
      const io = getIO();
      emitToKitchen(io, sourceOrder.branch || null, 'order:new', { orderId: sourceOrder.orderId });
    } catch { /* socket best-effort */ }

    emitOrderEvent(
      'order:appended',
      { orderId: sourceOrder.orderId, addedItems: [stampedItem], deltaTotal: repeatDelta },
      sourceOrder
    );
    // Thermal "ADDED ITEMS" KOT for the repeated line (best-effort).
    require('./printService').enqueueKotJobs({ order: sourceOrder, items: [stampedItem], reason: 'append' }).catch(() => {});
    emitOrderEvent(
      'order:updated',
      { orderId: sourceOrder.orderId, status: sourceOrder.status },
      sourceOrder
    );

    return reply(200, { success: true, order: sourceOrder, message: 'Item added to existing order' });
  }

  // If source order is CLOSED, create a NEW order for the same table
  const newOrderId = sourceOrder.type === 'takeaway' ? idGen.takeawayOrderId() : idGen.orderId();

  const newOrder = new Order({
    orderId: newOrderId,
    restaurant: tenantId(req),
    user: sourceOrder.user,
    type: sourceOrder.type,
    table: repeatTable,
    tokenNumber: await tokenFor(),
    customerName: sourceOrder.customerName,
    phone: sourceOrder.phone,
    items: [itemForKitchen],
    total: 0, // stamped by applyNewOrderBill below
    scanSessionId: sourceOrder.scanSessionId || null,
    note: `Repeated from ${sourceOrder.orderId}`,
    waiter: req.user?.id, // Use current reporter as waiter
    pickupLocation: sourceOrder.pickupLocation,
    // Inherit the original order's branch ObjectId too so the
    // repeated order lands on the same per-branch dashboard.
    branch: sourceOrder.branch,
  });
  await pricing.applyNewOrderBill(req, newOrder);

  const savedOrder = await newOrder.save();
  bumpMenuItemOrderCounts(savedOrder.items, savedOrder.restaurant);

  // If it's a dine-in order and table exists, occupy it again (scoped)
  if (savedOrder.type === 'dine-in' && savedOrder.table) {
    await Table.findOneAndUpdate(
      { _id: savedOrder.table, ...tenantFilter(req) },
      { status: 'occupied', activeOrder: savedOrder._id }
    );
    emitStaffTable('table:updated', { tableId: savedOrder.table, status: 'occupied' }, savedOrder.branch);
  }

  // Notify kitchen
  try {
    const io = getIO();
    emitToKitchen(io, savedOrder.branch, 'order:new', { orderId: savedOrder.orderId });
    emitToAdmin(io, savedOrder.branch, 'notification:new', { title: 'New Order (Repeat)', description: `Order ${savedOrder.orderId} repeated from ${sourceOrder.orderId}` });
  } catch { }

  return reply(200, { success: true, order: savedOrder, message: 'New order created from repeat' });
}

// ── Repeat a whole order: steps ─────────────────────────────────────
async function loadRepeatSource(req, tf) {
  const { id } = req.params;
  let sourceOrder = isValidObjectId(id)
    ? await Order.findOne({ _id: id, ...tf })
    : null;
  if (!sourceOrder) sourceOrder = await Order.findOne({ orderId: id, ...tf });
  if (!sourceOrder) {
    throw httpError(404, { success: false, message: 'Source order not found' });
  }

  // Staff, the owner, or the guest's own scan session only (the human
  // order number is printed on bills / KOTs, so it proves nothing).
  assertCanRepeat(req, sourceOrder);

  if (!sourceOrder.items || sourceOrder.items.length === 0) {
    throw httpError(400, { success: false, message: 'Source order has no items to repeat' });
  }
  return sourceOrder;
}

// Resolve the table (and branch) the repeat should land on + capacity.
async function resolveRepeatTarget(req, sourceOrder, tf, targetTableId, tokenMode = false) {
  // Token-number mode: there are no tables to land on. A target table is
  // a stale client (400 TABLES_DISABLED); otherwise the repeat is a
  // table-less token order — no table availability / seat checks.
  if (tokenMode && sourceOrder.type === 'dine-in') {
    if (targetTableId) throw httpError(400, tablesDisabledError());
    return { resolvedTargetTable: null, resolvedTargetBranch: sourceOrder.branch };
  }
  // Resolve the table the new order should land on. For dine-in:
  // prefer the customer's current table; resolve merge-leader so the
  // unique-active-order-per-table index targets the canonical group
  // holder. Fall back to the source's table when no override comes in
  // (back-compat for callers that haven't been updated yet).
  let resolvedTargetTable = sourceOrder.table;
  let resolvedTargetBranch = sourceOrder.branch;
  if (sourceOrder.type === 'dine-in' && targetTableId) {
    if (!isValidObjectId(targetTableId)) {
      throw httpError(400, { success: false, message: 'Invalid target table id' });
    }
    const targetTable = await Table.findOne({ _id: targetTableId, ...tf }).lean();
    const unavailable = tableUnavailableError(targetTable);
    if (unavailable) throw httpError(unavailable.status, unavailable.body);
    let leaderId = targetTable._id;
    try {
      const leader = await resolveMergeLeader(targetTable._id, tf);
      if (leader && leader._id) leaderId = leader._id;
    } catch { /* fall back to scanned id */ }
    resolvedTargetTable = leaderId;
    // Inherit branch from the target table (may differ from source for
    // multi-branch tenants where the customer dined at branch A
    // yesterday and is at branch B today).
    if (targetTable.branch) resolvedTargetBranch = targetTable.branch;
  } else if (sourceOrder.type === 'dine-in' && sourceOrder.table) {
    const srcTable = await Table.findOne({ _id: sourceOrder.table, ...tf })
      .select('isDeleted isActive status').lean();
    const unavailable = tableUnavailableError(srcTable);
    if (unavailable) throw httpError(unavailable.status, unavailable.body);
  }
  assertRepeatHasTable(sourceOrder, resolvedTargetTable);
  // Repeating onto a table the caller isn't seated at makes them a new
  // party there — they must claim a seat (same rule as createOrder).
  // This applies to the source's own table too: once that bill was
  // settled the table may have been re-seated by other parties (#13).
  // claimSeat just refreshes the seat of a party that is still seated.
  if (sourceOrder.type === 'dine-in' && resolvedTargetTable) {
    const seat = await claimSeat({
      table: { _id: resolvedTargetTable },
      tenantFilterObj: tf,
      keys: callerPartyKeys(req, scanSessionFromReq(req)),
    });
    if (!seat.ok) throw httpError(seat.status, seat.body);
  }
  return { resolvedTargetTable, resolvedTargetBranch };
}

// Copy (optionally trimmed / re-quantified) source items for the repeat.
function buildRepeatItems(sourceOrder, selections) {
  const now = new Date();
  let itemsToCopy;
  if (Array.isArray(selections) && selections.length > 0) {
    itemsToCopy = [];
    const seenIdx = new Set();
    for (const sel of selections) {
      const idx = Number(sel?.index);
      const qty = Math.floor(Number(sel?.quantity));
      if (!Number.isInteger(idx) || idx < 0 || idx >= sourceOrder.items.length) continue;
      if (seenIdx.has(idx)) continue;            // dedupe accidental dupes
      if (!Number.isFinite(qty) || qty <= 0) continue;
      seenIdx.add(idx);
      const sourceItem = sourceOrder.items[idx];
      const obj = sourceItem.toObject ? sourceItem.toObject() : { ...sourceItem };
      delete obj._id;
      const cleanInstructions = typeof sel.instructions === 'string'
        ? sel.instructions.trim().slice(0, 200)
        : undefined;
      itemsToCopy.push({
        ...obj,
        quantity: Math.min(99, qty),
        addedAt: now,
        ...(cleanInstructions ? { instructions: cleanInstructions } : {}),
      });
    }
    if (itemsToCopy.length === 0) {
      throw httpError(400, { success: false, message: 'Please pick at least one item to repeat.' });
    }
  } else {
    itemsToCopy = sourceOrder.items.map((item) => {
      const obj = item.toObject ? item.toObject() : { ...item };
      delete obj._id;
      return { ...obj, addedAt: now };
    });
  }
  return itemsToCopy;
}

// Counter side of a repeat — always a fresh ready order.
async function persistRepeatCounterSide(req, { sourceOrder, repeatCounter, resolvedTargetTable, resolvedTargetBranch, tf, bare = false, tokenFor }) {
  let counterSideOrder = null;
  if (repeatCounter.length > 0) {
    counterSideOrder = await persistCounterSideOrder({
      req,
      type: sourceOrder.type,
      tableId: sourceOrder.type === 'dine-in' ? resolvedTargetTable : null,
      tokenNumber: tokenFor ? await tokenFor() : undefined,
      branchId: resolvedTargetBranch,
      user: sourceOrder.user,
      customerName: sourceOrder.customerName,
      phone: sourceOrder.phone,
      items: repeatCounter,
      pickupTime: sourceOrder.pickupTime,
      pickupLocation: sourceOrder.pickupLocation,
      scanSessionId: sourceOrder.scanSessionId,
      note: `Repeated from ${sourceOrder.orderId}`,
      bare,
    });
    if (counterSideOrder && counterSideOrder.type === 'dine-in' && counterSideOrder.table) {
      try {
        await Table.findOneAndUpdate(
          { _id: counterSideOrder.table, ...tf },
          { status: 'occupied', activeOrder: counterSideOrder._id },
        );
        emitStaffTable('table:updated', { tableId: counterSideOrder.table, status: 'occupied' }, counterSideOrder.branch);
      } catch (err) { logger.warn('Repeat-all: counter table update failed:', err.message); }
    }
    try {
      if (counterSideOrder) {
        emitToAdmin(getIO(), counterSideOrder.branch, 'notification:new', {
          title: 'New Order (Repeat · Counter)',
          description: `Order ${counterSideOrder.orderId} repeated from ${sourceOrder.orderId}`,
        });
      }
    } catch { /* best-effort */ }
  }
  return counterSideOrder;
}

// Kitchen side: where should the repeated kitchen items go? Returns the
// still-active source (same table) or the caller's own open round on the
// target table, or null to create a fresh order. Also detaches a stale
// PAID bill from the target table.
async function findRepeatAppendTarget(req, { sourceOrder, resolvedTargetTable, tf }) {
  // Source still active AND on the same table the customer is at →
  // append the kitchen-side items to it. Skip when the customer has
  // moved tables (eg. came back next day at a different table) —
  // appending to the previous table's order would silently land items
  // on a table the customer isn't at, leaving them with a "Make
  // Payment" button that goes nowhere because the active-table poll
  // on their current table finds nothing. In that case, fall through
  // to the create-new path so the order lands where the customer
  // actually is. A source that is already PAID (prepaid online / kiosk
  // while still in the kitchen) is never reopened — the repeat becomes
  // a new unpaid order instead.
  const sourceIsActive = ['new', 'preparing', 'ready'].includes(sourceOrder.status) && !isSettled(sourceOrder);
  const sameTableAsSource = !sourceOrder.table
    || !resolvedTargetTable
    || String(sourceOrder.table) === String(resolvedTargetTable);
  if (sourceIsActive && sameTableAsSource) return sourceOrder;

  // Reconcile the target table BEFORE attempting to create a new
  // order. The legacy `one_active_order_per_table` unique index
  // considered every order whose status is in
  // [new, preparing, ready, served], so a previous round that's been
  // served + paid (but never structurally "closed") used to block
  // the create with E11000. The index has since been dropped (see
  // server.js runMigrations), but the same reconciliation logic is
  // still useful so the customer's "Repeat Order" tap doesn't append
  // to a stale paid bill.
  //
  //   • Existing order on table is already PAID → it's a stale closed
  //     bill. Detach it (`table = null`). The table itself is NOT freed
  //     here (freeTableOrUnmergeGroup would also wipe every seat, and
  //     other parties may be seated — #13); the repeat order re-occupies
  //     it right after.
  //   • The caller's OWN party has an unpaid active round → append the
  //     kitchen-side repeated items to it instead of creating a
  //     duplicate. Another party's open bill is never touched.
  if (sourceOrder.type === 'dine-in' && resolvedTargetTable) {
    // Only fold the repeat into a still-ACTIVE round (new/preparing/
    // ready) — that round is mid-flight, so adding to it is correct and
    // the kitchen hasn't finished it yet. A SERVED round is already
    // cooked and delivered; appending to it would revive the served
    // items into the chef KDS (chef sees "×2" and re-cooks the one
    // that's already on the table). So when the previous round is
    // served, we DON'T append here — we fall through to create a fresh
    // order for just the repeated items. The table's bill still sums
    // every unpaid round via getActiveOrdersListByTable, so nothing is
    // lost on the bill; the chef just sees only the new ×1 to cook.
    const existingOnTable = await Order.findOne({
      table: resolvedTargetTable,
      status: { $in: ['new', 'preparing', 'ready'] },
      paymentStatus: { $nin: [...SETTLED_PAYMENT_STATUSES] },
      ...repeatPartyFilter(sourceOrder),
      ...tf,
    });
    const stalePaidOnTable = await Order.findOne({
      table: resolvedTargetTable,
      status: { $in: ['new', 'preparing', 'ready', 'served'] },
      paymentStatus: 'Paid',
      ...tf,
    });
    if (stalePaidOnTable) {
      try {
        stalePaidOnTable.table = null;
        await stalePaidOnTable.save();
      } catch (err) {
        logger.warn('Repeat-all: failed to detach stale paid order from table:', err.message);
      }
    }
    if (existingOnTable) return existingOnTable;
  }
  return null;
}

// Kitchen side: append the repeated items to `target` (see
// findRepeatAppendTarget) and reply.
async function appendRepeatToActiveOrder(req, { target, sourceOrder, repeatKitchen, kitchenTotal, counterSideOrder }) {
  const deltaTotal = await appendRepeatItemsToOrder(req, target, repeatKitchen, kitchenTotal);
  revertStatusOnAppend(target);
  await target.save();

  // Re-emit kitchen ping when status reverted so the chef sees
  // the order back in the active queue.
  try {
    const io = getIO();
    emitToKitchen(io, target.branch || null, 'order:new', { orderId: target.orderId });
  } catch { /* socket best-effort */ }

  emitOrderEvent('order:appended', { orderId: target.orderId, addedItems: repeatKitchen, deltaTotal }, target);
  emitOrderEvent('order:updated', { orderId: target.orderId, status: target.status }, target);
  // Thermal "ADDED ITEMS" KOT for the repeated lines (best-effort).
  require('./printService').enqueueKotJobs({ order: target, items: repeatKitchen, reason: 'append' }).catch(() => {});

  const isSource = target === sourceOrder;
  return reply(200, {
    success: true,
    order: target,
    appended: true,
    isSplit: !!counterSideOrder,
    splitOrder: counterSideOrder || null,
    message: counterSideOrder
      ? (isSource
        ? 'Items added — counter items ready, kitchen items added to your existing order.'
        : "Items added — counter items ready, kitchen items added to this table's existing order.")
      : (isSource ? 'Items added to your existing order.' : "Items added to this table's existing order."),
  });
}

// Kitchen side: create a fresh order for the repeated items.
async function createRepeatOrder(req, { sourceOrder, repeatKitchen, kitchenTotal, counterSideOrder, counterBare, resolvedTargetTable, resolvedTargetBranch, tf, tokenFor }) {
  // Source closed and no active order on the target table → create a fresh kitchen-side order.
  const newOrderId = sourceOrder.type === 'takeaway' ? idGen.takeawayOrderId() : idGen.orderId();
  const newOrder = new Order({
    orderId: newOrderId,
    restaurant: tenantId(req),
    branch: resolvedTargetBranch,
    user: sourceOrder.user,
    type: sourceOrder.type,
    table: resolvedTargetTable,
    tokenNumber: tokenFor ? await tokenFor() : undefined,
    customerName: sourceOrder.customerName,
    phone: sourceOrder.phone,
    items: repeatKitchen,
    total: kitchenTotal, // replaced by the taxed bill below
    scanSessionId: sourceOrder.scanSessionId || null,
    note: `Repeated from ${sourceOrder.orderId}`,
    pickupLocation: sourceOrder.pickupLocation,
  });
  // Mixed repeat: the counter doc holds its items' bare subtotal, so this
  // doc carries the tax lines of the whole repeat (createOrder's split).
  await pricing.applyNewOrderBill(req, newOrder, {
    bareSiblingSubtotal: counterSideOrder && counterBare ? counterSideOrder.total : 0,
  });
  const savedOrder = await newOrder.save();
  bumpMenuItemOrderCounts(savedOrder.items, savedOrder.restaurant);

  if (savedOrder.type === 'dine-in' && savedOrder.table) {
    try {
      await Table.findOneAndUpdate(
        { _id: savedOrder.table, ...tf },
        { status: 'occupied', activeOrder: savedOrder._id },
      );
      emitStaffTable('table:updated', { tableId: savedOrder.table, status: 'occupied' }, savedOrder.branch);
    } catch (err) { logger.warn('Repeat-all: table update failed:', err.message); }
  }

  try {
    const io = getIO();
    emitToKitchen(io, savedOrder.branch, 'order:new', { orderId: savedOrder.orderId });
    emitToAdmin(io, savedOrder.branch, 'notification:new', {
      title: 'New Order (Repeat)',
      description: `Order ${savedOrder.orderId} repeated from ${sourceOrder.orderId}`,
    });
  } catch { /* socket best-effort */ }

  emitOrderEvent('order:updated', { orderId: savedOrder.orderId, status: savedOrder.status }, savedOrder);

  return reply(201, {
    success: true,
    order: savedOrder,
    isSplit: !!counterSideOrder,
    splitOrder: counterSideOrder || null,
    message: counterSideOrder
      ? 'Two orders created — counter side ready, kitchen side queued.'
      : 'New order created from repeat',
  });
}

// Repeat ALL items from a past order in a single call.
//
// Customer-side "Repeat Order" button on the Orders page hits this. Same
// branch logic as repeatOrderItem (active source → append; closed source →
// new order), but copies every item instead of one. Lookup accepts either
// the Mongo _id or the human orderId ("ORD-0001") so the customer view —
// which only carries the display ID — can call directly.
async function repeatOrderAllItems(req) {
  const tf = tenantFilter(req);
  const sourceOrder = await loadRepeatSource(req, tf);
  assertRepeatAllowedByOps(req, sourceOrder);

  // Optional `selections` body lets the customer trim / re-quantify
  // the source items before placing the repeat:
  //   selections: [{ index: 0, quantity: 2, instructions?: '...' }, ...]
  // - index = position in the source order's items array
  // - quantity = desired qty for the repeat (capped 1..99). Items the
  //   customer drops are simply omitted from this array.
  // No `selections` → repeat every item at its original quantity
  // (the original one-tap behaviour).
  //
  // Optional `targetTableId` — for dine-in repeats this MUST be the
  // table the customer is currently sitting at, NOT the source order's
  // table. Otherwise a customer repeating an old order from a different
  // table would create a phantom order on the previous table that
  // their current bill-preview / active-table polling would never find,
  // and the bill page would fall back to the old paid order showing
  // "✓ Paid" instead of the freshly-placed "Pay Bill" button.
  const { selections, targetTableId } = req.body || {};

  // Token-number mode: no target table; a new order from this repeat is
  // a token order (one token shared by its counter / kitchen docs).
  const tokenMode = tokenModeFor(req);
  const tokenFor = tokenAllocator(req, sourceOrder, tokenMode);
  const { resolvedTargetTable, resolvedTargetBranch } = await resolveRepeatTarget(req, sourceOrder, tf, targetTableId, tokenMode);
  const itemsToCopy = buildRepeatItems(sourceOrder, selections);

  // Mixed-cart split — partition the repeated items into counter
  // (no-prep) vs kitchen/bar so a "Repeat Order" containing
  // Coca-Cola + a curry doesn't drag the bottle through the chef.
  // partitionItemsByStation re-runs the heuristic for items missing
  // prepStation (older sources predating the column).
  const { counterItems: repeatCounter, kitchenItems: repeatKitchen } = partitionItemsByStation(itemsToCopy);
  const kitchenTotal = Math.round(
    repeatKitchen.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
      0,
    ) * 100,
  ) / 100;

  // Decide where the kitchen items go BEFORE the counter doc exists, so
  // the (ready, unpaid) counter doc can never be picked as the table's
  // open round and get the kitchen items merged into it.
  const kitchenTarget = repeatKitchen.length > 0
    ? await findRepeatAppendTarget(req, { sourceOrder, resolvedTargetTable, tf })
    : null;
  // Mixed repeat creating a fresh kitchen order → split like createOrder:
  // counter doc at its bare subtotal, kitchen doc carries the tax lines.
  const counterBare = repeatKitchen.length > 0 && !kitchenTarget;
  const counterSideOrder = await persistRepeatCounterSide(req, {
    sourceOrder, repeatCounter, resolvedTargetTable, resolvedTargetBranch, tf, bare: counterBare, tokenFor,
  });

  // Counter-only repeat → done. Skip the kitchen-side append/create
  // entirely so the chef KDS doesn't see the order.
  if (repeatKitchen.length === 0) {
    if (!counterSideOrder) {
      // Counter-side save failed and we have nothing else to fall
      // back on — surface the failure rather than silently dropping
      // the customer's repeat tap.
      throw httpError(500, { success: false, message: 'Failed to repeat order' });
    }
    return reply(201, {
      success: true,
      order: counterSideOrder,
      isSplit: true,
      splitOrder: counterSideOrder,
      message: 'Counter items ready — no kitchen prep required',
    });
  }

  if (kitchenTarget) {
    return appendRepeatToActiveOrder(req, { target: kitchenTarget, sourceOrder, repeatKitchen, kitchenTotal, counterSideOrder });
  }

  return createRepeatOrder(req, { sourceOrder, repeatKitchen, kitchenTotal, counterSideOrder, counterBare, resolvedTargetTable, resolvedTargetBranch, tf, tokenFor });
}

// ── Append items (waiter / captain) ─────────────────────────────────
// Pre-flight stock check for the appended items. Same gate as
// createOrder — block the append at request time when an ingredient is
// short, so the chef doesn't end up trying to deduct for items that
// can't be made. Only the newly appended items are checked; whatever's
// already on the order has either been deducted (status >= preparing)
// or will be deducted along with these on the next "Start Preparing"
// transition.
async function preflightAppendStock(req, enrichedItems, branch) {
  let failureBody = null;
  try {
    const { checkInventoryForOrder } = require('../controllers/inventoryController');
    const stockCheck = await checkInventoryForOrder(
      enrichedItems,
      tenantId(req),
      branch || null,
    );
    if (!stockCheck.ok) failureBody = pricing.insufficientStockBody(stockCheck);
  } catch (err) {
    logger.warn('Pre-flight stock check failed on append (allowing):', err.message);
  }
  if (failureBody) throw httpError(400, failureBody);
}

// Append items to an existing active order (second / third KOT round).
//
// Rationale: once a dine-in order is fired to the kitchen, the diners
// frequently want to add a drink, a dessert, "one more naan". Today the
// flow forces the waiter to wait for the order to close, then place a
// new one — the single-active-order-per-table unique index blocks a
// second create. This endpoint lets the waiter / captain append items
// to the still-open order. Kitchen sees a dedicated `order:appended`
// socket event carrying just the delta so it can print a fresh KOT
// ticket for the new items without reprinting the whole order.
//
// Captain or waiter only. Chef / customer / guest explicitly excluded.
async function appendOrderItems(req) {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, { success: false, message: 'At least one item is required' });
  }

  const order = await Order.findOne({ _id: id, ...tenantFilter(req) });
  if (!order) {
    throw httpError(404, { success: false, message: 'Order not found' });
  }

  // Only active orders accept new items. 'served' orders are about
  // to be billed — appending to them is the "one more round before
  // the bill closes" use case, still legal. 'cancelled' is not.
  const APPENDABLE_STATUSES = new Set(['new', 'preparing', 'ready', 'served']);
  if (!APPENDABLE_STATUSES.has(order.status)) {
    throw httpError(400, {
      success: false,
      code: 'ORDER_NOT_APPENDABLE',
      message: `Cannot add items to a ${order.status} order.`,
    });
  }

  // A settled bill must not grow — items added after payment would be
  // cooked and served but never charged (and the freed table silently
  // re-occupied by a closed bill). Start a new order instead.
  if (isSettled(order)) {
    throw httpError(409, {
      success: false,
      code: 'ORDER_ALREADY_PAID',
      message: `Order ${order.orderId} is already ${String(order.paymentStatus).toLowerCase()} — place a new order for the extra items.`,
    });
  }

  // Branch-pinned staff cannot append to an order at another branch.
  const pinned = pinnedBranchId(req);
  if (pinned && order.branch && String(order.branch) !== String(pinned)) {
    throw httpError(403, {
      success: false,
      code: 'BRANCH_SCOPE_VIOLATION',
      message: 'You can only modify orders for your assigned branch.',
    });
  }

  // Appending re-opens a served order and sends it back to the kitchen,
  // so the table must still be usable — same rule createOrder and the
  // repeat flows apply. Without this, items could be added to an order
  // on a table the admin had deleted or disabled.
  if (order.table) {
    const orderTable = await Table.findOne({ _id: order.table, ...tenantFilter(req) })
      .select('isDeleted isActive status').lean();
    const unavailable = tableUnavailableError(orderTable);
    if (unavailable) throw httpError(unavailable.status, unavailable.body);
  }

  // Validate menu ids against stock + canonical toppings, same path
  // as createOrder — don't trust client-supplied prices or addons.
  const menuItemIds = items
    .map(i => i.menuItem)
    .filter(mid => mid && mongoose.Types.ObjectId.isValid(mid));

  if (menuItemIds.length > 0) {
    const outOfStock = await MenuItem.find(
      { _id: { $in: menuItemIds }, inStock: false, ...tenantFilter(req) },
      'name'
    ).lean();
    if (outOfStock.length > 0) {
      const names = outOfStock.map(m => m.name).join(', ');
      throw httpError(400, { success: false, message: `Out of stock: ${names}` });
    }
  }

  const menuDocs = menuItemIds.length
    ? await MenuItem.find({ _id: { $in: menuItemIds }, ...tenantFilter(req) })
      .populate('category', 'name kind').lean()
    : [];
  const menuById = new Map(menuDocs.map(m => [String(m._id), m]));

  // Every line must resolve to an orderable menu item of this tenant
  // (buildAppendItems refuses unknown / foreign / archived / out-of-
  // window items — never a client-priced line).
  const { enrichedItems, deltaTotal } = pricing.buildAppendItems(items, menuById, order.branch);

  await preflightAppendStock(req, enrichedItems, order.branch);

  // Status revert on append. Same pattern as the customer-side
  // append (createOrder) and the customer Repeat Order flow:
  //   served → new       (table re-opens, kitchen restarts)
  //   ready  → preparing (chef must cook the new items; the
  //                       earlier batch stays effectively ready
  //                       but the order is no longer "fully ready"
  //                       until the new items are cooked too)
  //   preparing / new    (no change — already in the queue)
  revertStatusOnAppend(order);

  // Back-fill `addedAt` on any existing items that predate this field
  // BEFORE the save. Without this, Mongoose's `default: Date.now` on
  // orderItemSchema.addedAt fires during save() and retroactively
  // stamps every legacy subdoc with `now` — which would then make the
  // chef / waiter / bill "Added later" splits misclassify the entire
  // original order as appended alongside the actual new item. Pinning
  // the fallback to `order.createdAt` keeps originals in the right
  // bucket and leaves today's newly enriched items (which we already
  // stamped explicitly above) alone.
  for (const existing of order.items) {
    if (!existing.addedAt) existing.addedAt = order.createdAt;
  }

  // Bill before the append — the recompute applies the difference.
  const subtotalBefore = lineItemsSubtotal(order.items);
  appendItemsMerging(order.items, enrichedItems);
  // BUG FIX: recompute GST / service charge / additional charges over
  // the order's items instead of adding the bare item price to total.
  await pricing.applyAppendToBill(req, order, subtotalBefore, deltaTotal);
  await order.save();
  bumpMenuItemOrderCounts(enrichedItems, order.restaurant);

  // Emit an appended-specific event carrying just the delta so every
  // audience can react precisely:
  //   - chef: print a fresh KOT for the new items + flash "NEW ITEMS"
  //   - waiter: refresh the running table view + toast
  //   - customer (logged-in or guest in the order room): refresh the
  //     bill view + toast "Waiter added X to your bill"
  // emitOrderEvent targets staff-at-branch + owner userId + order room,
  // which covers all three groups in a single fan-out. `order:updated`
  // still fires for any generic listeners that don't care about the
  // delta (e.g. the admin live-orders dashboard).
  try {
    // Re-ping the kitchen room as a "new order" so a chef who'd
    // already cleared this card off the KDS (status was 'ready')
    // sees it back in the live queue. Without this the card stays
    // in the Ready column and the new items are silently waiting.
    const io = getIO();
    emitToKitchen(io, order.branch || null, 'order:new', { orderId: order.orderId });

    emitOrderEvent(
      'order:appended',
      {
        orderId: order.orderId,
        addedItems: enrichedItems,
        deltaTotal,
      },
      order
    );
    // Thermal "ADDED ITEMS" KOT with only the new lines (best-effort).
    require('./printService').enqueueKotJobs({ order, items: enrichedItems, reason: 'append' }).catch(() => {});
    emitOrderEvent(
      'order:updated',
      { orderId: order.orderId, status: order.status },
      order
    );
  } catch { /* socket not critical */ }

  // If the order was previously 'served' the table status was already
  // toggled back to 'free' — flip it back to 'occupied' so the floor
  // map reflects reality.
  if (order.type === 'dine-in' && order.table) {
    // Clear any active service alerts on the table — the customer
    // adding more items implicitly satisfies the earlier "call
    // waiter / water" ping, mirroring createOrder above.
    await Table.findOneAndUpdate(
      { _id: order.table, ...tenantFilter(req) },
      { status: 'occupied', activeOrder: order._id, alerts: [] }
    );
    emitStaffTable('table:updated', { tableId: order.table, status: 'occupied' }, order.branch);
  }

  return reply(200, {
    success: true,
    order,
    addedCount: enrichedItems.length,
    deltaTotal,
    message: `${enrichedItems.length} item(s) added to order`,
  });
}

module.exports = {
  persistCounterSideOrder,
  repeatOrderItem,
  repeatOrderAllItems,
  appendOrderItems,
  buildRepeatItems,
  appendRepeatItemsToOrder,
};
