/**
 * Held-order sweeper — cancels pay-first orders that were never paid.
 *
 * A restaurant whose operations profile holds unpaid pay-first orders
 * from the kitchen (status 'awaiting-payment', see
 * services/orderHoldService.js) gives each one a deadline
 * (holdExpiresAt = created + payment.holdExpiryMinutes). Past it, the
 * customer clearly isn't coming to the counter, so the order is
 * cancelled ('payment-timeout') and its table released. Nothing was
 * cooked, printed or deducted, so no money or stock is involved.
 *
 * Disabled via HELD_ORDER_SWEEP_DISABLED=true (external cron);
 * cadence via HELD_ORDER_SWEEP_MINUTES (default 2).
 */
const logger = require('./logger');
const { runWithoutContext } = require('./requestContext');

const SWEEP_INTERVAL_MINUTES_DEFAULT = 2;

async function runHeldOrderSweep() {
    try {
        const { cancelExpiredHolds } = require('../services/orderHoldService');
        const r = await cancelExpiredHolds();
        if (r.cancelled > 0) logger.info(`Held-order sweeper: cancelled ${r.cancelled} unpaid pay-first order(s)`);
        return r;
    } catch (err) {
        logger.error('Held-order sweeper error', { error: err.message });
        return { scanned: 0, cancelled: 0, error: err.message };
    }
}

function startScheduledHeldOrderSweep() {
    if (String(process.env.HELD_ORDER_SWEEP_DISABLED).toLowerCase() === 'true') {
        logger.info('Held-order sweeper disabled via HELD_ORDER_SWEEP_DISABLED');
        return;
    }
    const minutes = Number(process.env.HELD_ORDER_SWEEP_MINUTES) || SWEEP_INTERVAL_MINUTES_DEFAULT;
    // Sweeps every tenant — must never inherit a request's tenant context.
    require('./scheduler').scheduleJob('held-order-sweep', minutes * 60 * 1000,
        () => runWithoutContext(() => runHeldOrderSweep()),
        { initialDelayMs: 15 * 1000 });
    logger.debug(`Held-order sweeper scheduled every ${minutes}m`);
}

module.exports = { runHeldOrderSweep, startScheduledHeldOrderSweep };
