// Scheduled sweeper — cancels "orphan empty" orders and frees the
// tables they were locking.
//
// Why this exists:
//   An Order document can legitimately exist with an empty items[]
//   array for a brief window — the waiter/admin UI creates the shell
//   before the first KOT is sent, and the customer QR flow creates it
//   on scan. Normally the next save fills items[]. But if the flow is
//   abandoned (browser closed, navigation, dropped network) the order
//   stays `status: 'new' | 'preparing'` with items=[] forever, AND
//   table.activeOrder still points at it — so the table is stuck
//   "occupied" with a ₹0 bill indefinitely.
//
//   Unlike the takeaway stale sweeper (observe-only — paid orders
//   need human review before refund), empty-cart orders have zero
//   customer money on them, so auto-cancelling is safe.
//
// Scope: cancel the order + free its table (or unmerge the whole
// group). Never touches orders with items, with any payment captured,
// or that have already been cancelled.
//
// Disabled via EMPTY_ORDER_SWEEP_DISABLED=true for external-cron
// deployments.

const Order = require('../models/order');
const Table = require('../models/table');
const logger = require('./logger');
const { getIO, emitToStaff } = require('./socket');
const { freeTableOrUnmergeGroup } = require('./tableMerge');
const { runWithoutContext } = require('./requestContext');

// Accepts a Restaurant doc, an ObjectId, or an id string; null = all tenants.
function restaurantIdOf(restaurant) {
    if (!restaurant) return null;
    return restaurant._id || restaurant;
}

// Default: 30 min grace. Long enough that a real customer mid-order
// (browsing menu, picking add-ons, adding items slowly) isn't hit,
// short enough that a stuck table gets unstuck within one shift.
const GRACE_MINUTES_DEFAULT = 30;
// How often the check runs. Cheap (partial indexed filter) — every
// 15 min so the worst-case stuck duration is grace + 15m.
const SWEEP_INTERVAL_MINUTES_DEFAULT = 15;

/**
 * @param {object} [opts]
 * @param {object|string} [opts.restaurant] limit the sweep to one tenant
 *   (tenant-admin "run now"). Omitted = every tenant (scheduled job).
 */
async function runEmptyOrderSweep({ restaurant } = {}) {
    const restaurantId = restaurantIdOf(restaurant);
    const tenantScope = restaurantId ? { restaurant: restaurantId } : {};
    const graceMinutes = Number(process.env.EMPTY_ORDER_GRACE_MINUTES) || GRACE_MINUTES_DEFAULT;
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

    let cancelled = 0;
    let freedTables = 0;

    try {
        // Only sweep orders where nothing else in the system is going
        // to close them naturally: empty cart, still in an open status,
        // no payment taken, untouched for the grace window.
        const orphans = await Order.find({
            ...tenantScope,
            'items.0': { $exists: false },
            status: { $in: ['new', 'preparing', 'ready'] },
            paymentStatus: 'Pending',
            updatedAt: { $lt: cutoff },
        }).select('_id orderId restaurant branch table type updatedAt');

        // Don't early-return on empty orphans: we still need to run
        // the ghost-table pass below (occupied tables with no activeOrder).

        for (const order of orphans) {
            try {
                // Mark cancelled with structured audit fields so
                // reports can distinguish system cleanups from real
                // walkouts / customer cancels. An empty cart means
                // no customer money was ever on this row.
                await Order.updateOne(
                    { _id: order._id, status: { $ne: 'cancelled' } },
                    {
                        $set: {
                            status: 'cancelled',
                            cancelReason: 'auto-sweeper',
                            cancelReasonNote: 'Empty-order sweeper: untouched past grace window',
                            cancelledAt: new Date(),
                            // cancelledBy left null — this is a system action.
                        },
                    }
                );
                cancelled += 1;

                // Free the table (or unmerge its group) — but only if
                // the table still points AT THIS order. If the admin
                // already manually reset the table and a new order is
                // now attached, we leave it alone.
                if (order.table) {
                    const table = await Table.findOne({
                        _id: order.table,
                        activeOrder: order._id,
                    }).select('_id branch');

                    if (table) {
                        const { freedIds } = await freeTableOrUnmergeGroup(
                            order.table,
                            { restaurant: order.restaurant }
                        );
                        freedTables += freedIds.length;

                        try {
                            const io = getIO();
                            for (const id of freedIds) {
                                emitToStaff(io, order.branch, 'table:updated', {
                                    tableId: id,
                                    status: 'free',
                                    restaurant: order.restaurant ? String(order.restaurant) : undefined,
                                });
                                // Kick the customer-side guest session: any
                                // browser in the `table:<id>` socket room
                                // (guest who scanned the QR) gets this event
                                // and runs exitGuestMode.
                                io.to(`table:${id}`).emit('session:ended', {
                                    tableId: String(id),
                                    reason: 'inactivity',
                                    graceMinutes,
                                });
                            }
                        } catch { /* socket best-effort */ }
                    }
                }
            } catch (err) {
                logger.error('Empty order cleanup failed for one order', {
                    orderId: order.orderId,
                    error: err.message,
                });
            }
        }

        // ── Second pass: tables that are 'occupied' but have NO
        //    activeOrder at all. This is the pure-QR-scan case —
        //    table.status was flipped to 'occupied' on the first scan
        //    (see tableController.getTableByToken) but no order doc
        //    was ever created. Without this sweep, such tables stay
        //    red on the dashboard indefinitely.
        //
        //    We use `updatedAt` on the table itself as the grace
        //    anchor — it was last touched when QR-scan flipped the
        //    status, so if nothing has happened since then it's safe
        //    to free.
        let freedGhostTables = 0;
        try {
            const ghostTables = await Table.find({
                ...tenantScope,
                status: 'occupied',
                $or: [{ activeOrder: null }, { activeOrder: { $exists: false } }],
                updatedAt: { $lt: cutoff },
            }).select('_id branch restaurant');

            for (const t of ghostTables) {
                try {
                    const { freedIds } = await freeTableOrUnmergeGroup(
                        t._id,
                        { restaurant: t.restaurant }
                    );
                    freedGhostTables += freedIds.length;

                    try {
                        const io = getIO();
                        for (const id of freedIds) {
                            emitToStaff(io, t.branch, 'table:updated', {
                                tableId: id,
                                status: 'free',
                                restaurant: t.restaurant ? String(t.restaurant) : undefined,
                            });
                            io.to(`table:${id}`).emit('session:ended', {
                                tableId: String(id),
                                reason: 'inactivity',
                                graceMinutes,
                            });
                        }
                    } catch { /* socket best-effort */ }
                } catch (err) {
                    logger.error('Ghost table cleanup failed', {
                        tableId: String(t._id),
                        error: err.message,
                    });
                }
            }
        } catch (err) {
            logger.error('Ghost table scan error', { error: err.message });
        }

        freedTables += freedGhostTables;

        if (cancelled > 0 || freedTables > 0) {
            logger.info('Empty order sweeper finished', {
                candidates: orphans.length,
                cancelled,
                freedTables,
                freedGhostTables,
                graceMinutes,
                restaurant: restaurantId ? String(restaurantId) : 'all',
            });
        } else {
            logger.debug('Empty order sweeper finished', {
                candidates: orphans.length,
                cancelled,
                freedTables,
                freedGhostTables,
                graceMinutes,
            });
        }

        return { cancelled, freedTables };
    } catch (err) {
        logger.error('Empty order sweeper error', { error: err.message });
        return { cancelled: 0, freedTables: 0, error: err.message };
    }
}

function startScheduledEmptyOrderSweep() {
    if (String(process.env.EMPTY_ORDER_SWEEP_DISABLED).toLowerCase() === 'true') {
        logger.info('Empty order sweeper disabled via EMPTY_ORDER_SWEEP_DISABLED');
        return;
    }
    const minutes = Number(process.env.EMPTY_ORDER_SWEEP_MINUTES) || SWEEP_INTERVAL_MINUTES_DEFAULT;
    const intervalMs = minutes * 60 * 1000;

    // Fire an immediate pass ~10s after boot so an operator who just
    // restarted to fix a stuck table sees the effect without waiting
    // a full interval. Then run on the regular cadence forever.
    // #35 — cluster-locked via utils/scheduler. With several instances the
    // boot pass only runs when this instance wins the lease (i.e. no other
    // instance swept within the last interval).
    let bootPass = true;
    // The scheduled pass sweeps every tenant, so it must never inherit a
    // request's tenant context (tenantScopePlugin would narrow it).
    require('./scheduler').scheduleJob('empty-order-sweep', intervalMs, async () => {
        const r = await runWithoutContext(() => runEmptyOrderSweep());
        if (bootPass) {
            bootPass = false;
            const c = r.cancelled || 0;
            const f = r.freedTables || 0;
            if (c > 0 || f > 0) {
                logger.info(`Empty order sweeper boot pass: cancelled=${c}, freedTables=${f}`);
            } else {
                logger.debug(`Empty order sweeper boot pass: cancelled=0, freedTables=0`);
            }
        }
        return r;
    }, { initialDelayMs: 10 * 1000 });

    logger.debug(
        `Empty order sweeper scheduled every ${minutes}m (grace ${process.env.EMPTY_ORDER_GRACE_MINUTES || GRACE_MINUTES_DEFAULT}m, first pass in 10s)`
    );
}

module.exports = {
    runEmptyOrderSweep,
    startScheduledEmptyOrderSweep,
};
