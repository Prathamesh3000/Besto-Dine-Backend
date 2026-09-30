// Scheduled sweeper — surfaces takeaway orders that are stuck in
// "ready" status for longer than a safe threshold.
//
// Why this exists:
//   Takeaway "ready" orders are only cleared when a waiter manually
//   hands the food over (ready → served). If the customer never comes
//   to pick up, the row stays ready indefinitely — the chef's "Ready
//   for Pickup" column fills with days-old orders and the admin dashboard
//   silently overcounts "pending pickups".
//
// Scope: this sweeper ONLY observes + notifies. It never modifies
// orders. The actual cleanup (flip to cancelled) is a deliberate admin
// action via POST /api/v1/orders/admin/cleanup-stale, because paid
// orders need human review before being refunded.
//
// Disabled via STALE_ORDER_SWEEP_DISABLED=true on multi-instance setups
// that want to run the check from external cron instead.

const Order = require('../models/order');
const logger = require('./logger');
const { getIO, emitToAdmin } = require('./socket');

// Default: alert when a takeaway order has been ready for over 6 hours.
// Override per environment via STALE_ORDER_STUCK_MINUTES.
const STUCK_MINUTES_DEFAULT = 360;
// How often the check runs. Cheap query (indexed filter on status +
// updatedAt) so running every hour is fine.
const SWEEP_INTERVAL_HOURS_DEFAULT = 1;

async function runStaleOrderScan() {
    const stuckMinutes = Number(process.env.STALE_ORDER_STUCK_MINUTES) || STUCK_MINUTES_DEFAULT;
    const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000);

    try {
        const stale = await Order.find({
            status: 'ready',
            type: 'takeaway',
            updatedAt: { $lt: cutoff },
        }).select('orderId restaurant branch updatedAt total paymentStatus');

        if (stale.length === 0) return { count: 0 };

        // Group by tenant so we emit one socket event per restaurant
        // admin room instead of one event per order (which would flood
        // the dashboards on a large chain).
        const byTenant = new Map();
        for (const o of stale) {
            const key = String(o.restaurant || 'unknown');
            if (!byTenant.has(key)) byTenant.set(key, []);
            byTenant.get(key).push(o);
        }

        try {
            const io = getIO();
            for (const [tenantId, orders] of byTenant.entries()) {
                // Emit a tenant-wide admin notification summarising the
                // stuck set. Per-branch scoping is not applied here on
                // purpose — branch admins still benefit from seeing that
                // another branch is piling up stale orders.
                if (tenantId === 'unknown') continue;
                emitToAdmin(io, null, 'stale-orders:detected', {
                    tenantId,
                    restaurant: tenantId,
                    count: orders.length,
                    oldestMinutes: Math.max(
                        ...orders.map(o => Math.round((Date.now() - new Date(o.updatedAt).getTime()) / 60000))
                    ),
                    orderIds: orders.map(o => o.orderId),
                });
            }
        } catch { /* socket not critical */ }

        logger.warn('Stale takeaway orders detected', {
            total: stale.length,
            tenants: byTenant.size,
            stuckMinutes,
        });

        return { count: stale.length, tenants: byTenant.size };
    } catch (err) {
        logger.error('Stale order sweeper error', { error: err.message });
        return { count: 0, error: err.message };
    }
}

function startScheduledStaleOrderSweep() {
    if (String(process.env.STALE_ORDER_SWEEP_DISABLED).toLowerCase() === 'true') {
        logger.info('Stale order sweeper disabled via STALE_ORDER_SWEEP_DISABLED');
        return;
    }
    const hours = Number(process.env.STALE_ORDER_SWEEP_HOURS) || SWEEP_INTERVAL_HOURS_DEFAULT;
    const intervalMs = hours * 60 * 60 * 1000;
    // First run 2 minutes after boot so startup isn't slowed and Mongo
    // connection has already settled (runMigrations runs on the same
    // connection).
    // #35 — cluster-locked: runs on one instance per interval.
    require('./scheduler').scheduleJob('stale-order-sweep', intervalMs, runStaleOrderScan, { initialDelayMs: 2 * 60 * 1000 });
    logger.debug(`Stale order sweeper scheduled every ${hours}h (threshold ${process.env.STALE_ORDER_STUCK_MINUTES || STUCK_MINUTES_DEFAULT}m)`);
}

module.exports = {
    runStaleOrderScan,
    startScheduledStaleOrderSweep,
};
