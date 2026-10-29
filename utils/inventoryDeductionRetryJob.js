/**
 * Inventory deduction retry worker - re-runs deductions that failed when an
 * order moved to 'preparing' (services/inventoryDeductionService.js), with
 * exponential backoff, until done or the attempt cap (then an admin alert).
 *
 * Cluster-locked through utils/scheduler (+ utils/jobLock). Disabled via
 * INVENTORY_DEDUCTION_RETRY_DISABLED=true; cadence via
 * INVENTORY_DEDUCTION_RETRY_SECONDS (default 60).
 */
const logger = require('./logger');
const { runWithoutContext } = require('./requestContext');

const INTERVAL_SECONDS_DEFAULT = 60;

/**
 * Tenant context for the sweep. Follows the other sweepers: no request
 * context, cross-tenant reads, and every per-job query carries its own
 * explicit `restaurant` filter. Kept in this one function so a shared
 * runAsTenant helper can replace it later.
 */
function inSystemContext(fn) {
    return runWithoutContext(fn);
}

async function runInventoryDeductionRetry() {
    try {
        const { runDueRetries } = require('../services/inventoryDeductionService');
        const r = await runDueRetries();
        if (r.scanned > 0) logger.info(`Inventory deduction retry: ${JSON.stringify(r)}`);
        return r;
    } catch (err) {
        logger.error('Inventory deduction retry error', { error: err.message });
        return { scanned: 0, error: err.message };
    }
}

function startInventoryDeductionRetry() {
    if (String(process.env.INVENTORY_DEDUCTION_RETRY_DISABLED).toLowerCase() === 'true') {
        logger.info('Inventory deduction retry disabled via INVENTORY_DEDUCTION_RETRY_DISABLED');
        return;
    }
    const seconds = Number(process.env.INVENTORY_DEDUCTION_RETRY_SECONDS) || INTERVAL_SECONDS_DEFAULT;
    require('./scheduler').scheduleJob('inventory-deduction-retry', seconds * 1000,
        () => inSystemContext(() => runInventoryDeductionRetry()),
        { initialDelayMs: 30 * 1000 });
    logger.debug(`Inventory deduction retry scheduled every ${seconds}s`);
}

module.exports = { runInventoryDeductionRetry, startInventoryDeductionRetry, inSystemContext };
