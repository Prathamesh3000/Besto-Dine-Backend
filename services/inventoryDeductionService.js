/**
 * Inventory deduction reliability (plan task 2.4).
 *
 * deductInventoryForOrder (controllers/inventoryController.js) claims the
 * order atomically (`inventoryDeducted: true`) BEFORE touching stock, so it
 * can never double-deduct. The price of claim-first is that a crash or DB
 * error after the claim leaves the order marked but (partly) undeducted.
 * This service wraps that call and makes the outcome durable:
 *
 *   - clean result                      -> any open job is marked done
 *   - systemic failure, nothing taken   -> the claim is released and a
 *       retryable job is queued with exponential backoff
 *   - systemic failure, partial rows    -> job 'failed', NOT retryable (a
 *       retry would deduct the same ingredients twice) - needs a human
 *   - item-level errors (unit mismatch, missing inventory item, shortage)
 *       -> job 'failed', not retryable (data problem, retry cannot fix it)
 *
 * The retry worker (utils/inventoryDeductionRetryJob.js) calls
 * runDueRetries(). Restore-on-cancel is unchanged: it keys off the same
 * order.inventoryDeducted marker, which this service only ever clears when
 * no stock was taken.
 *
 * Env:
 *   INVENTORY_DEDUCTION_MAX_ATTEMPTS   default 6
 *   INVENTORY_DEDUCTION_BACKOFF_BASE_MS default 30000 (doubles per attempt, cap 1h)
 */
const Order = require('../models/order');
const Inventory = require('../models/inventory');
const InventoryDeductionJob = require('../models/inventoryDeductionJob');
const logger = require('../utils/logger');

const BACKOFF_CAP_MS = 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

function maxAttempts() {
    const n = Number(process.env.INVENTORY_DEDUCTION_MAX_ATTEMPTS);
    return n > 0 ? Math.floor(n) : 6;
}

/** Delay before the attempt that follows `attempts` failed attempts. */
function backoffMs(attempts) {
    const base = Number(process.env.INVENTORY_DEDUCTION_BACKOFF_BASE_MS) > 0
        ? Number(process.env.INVENTORY_DEDUCTION_BACKOFF_BASE_MS) : 30 * 1000;
    const n = Math.max(1, attempts);
    return Math.min(BACKOFF_CAP_MS, base * Math.pow(2, n - 1));
}

/** Systemic = the outer catch of deductInventoryForOrder (no item attached). */
function isSystemicError(e) {
    return !!e && !e.inventoryItem && !e.menuItem && !!e.reason;
}

function summarise(errors) {
    return (errors || []).map((e) => e.reason || String(e)).slice(0, 5).join('; ').slice(0, 500);
}

/** Has any stock already been taken for this order? */
async function hasDeductionRows(order, restaurantId) {
    const row = await Inventory.exists({
        restaurant: restaurantId,
        adjustmentHistory: { $elemMatch: { order: order._id, type: 'usage' } },
    });
    return !!row;
}

/** Undo the claim so a retry can run. Only called when no stock was taken. */
async function releaseClaim(order, restaurantId) {
    const r = await Order.findOneAndUpdate(
        { _id: order._id, restaurant: restaurantId, inventoryDeducted: true },
        { $set: { inventoryDeducted: false }, $unset: { inventoryDeductedAt: 1 } },
        { returnDocument: 'after' }
    );
    return !!r;
}

function alertAdmin(order, payload) {
    try {
        const { getIO, emitToAdmin } = require('../utils/socket');
        emitToAdmin(getIO(), order.branch || null, 'inventory:alert', {
            severity: 'deduction-failed',
            orderId: order.orderId,
            trigger: `Order ${order.orderId}`,
            ...payload,
        });
    } catch { /* socket best-effort */ }
}

/**
 * Record a failed attempt. Returns the saved job.
 * @param {{retryable:boolean, errors:Array, partial?:boolean}} info
 */
async function recordFailure(order, restaurantId, info) {
    const now = new Date();
    const lastError = (info.partial ? 'Partial deduction - manual review needed. ' : '') + summarise(info.errors);
    const job = await InventoryDeductionJob.findOneAndUpdate(
        { restaurant: restaurantId, order: order._id },
        {
            $setOnInsert: { branch: order.branch || null, orderId: order.orderId || '' },
            $inc: { attempts: 1 },
            $set: { lastError, errors: info.errors, lastAttemptAt: now, retryable: !!info.retryable, completedAt: null },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    const capped = info.retryable && job.attempts >= maxAttempts();
    if (info.retryable && !capped) {
        await InventoryDeductionJob.updateOne(
            { _id: job._id, restaurant: restaurantId },
            { $set: { state: 'pending', nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)) } }
        );
        job.state = 'pending';
    } else {
        await InventoryDeductionJob.updateOne(
            { _id: job._id, restaurant: restaurantId },
            { $set: { state: 'failed', retryable: false, nextAttemptAt: null } }
        );
        job.state = 'failed';
        alertAdmin(order, {
            errors: info.errors,
            message: capped
                ? `Stock deduction gave up after ${job.attempts} attempts`
                : 'Stock deduction needs manual review',
        });
    }
    return job;
}

async function markDone(order, restaurantId) {
    await InventoryDeductionJob.updateOne(
        { restaurant: restaurantId, order: order._id, state: { $in: ['pending', 'failed'] } },
        { $set: { state: 'done', completedAt: new Date(), nextAttemptAt: null, retryable: false } }
    );
}

/**
 * Deduct with durable failure handling. Same return shape as
 * deductInventoryForOrder. Never throws.
 */
async function runDeductionWithRecovery(order, restaurantId, userId = null) {
    const { deductInventoryForOrder } = require('../controllers/inventoryController');
    let result;
    try {
        result = await deductInventoryForOrder(order, restaurantId, userId);
    } catch (err) {
        result = { deducted: [], skipped: [], errors: [{ reason: err.message }] };
    }
    try {
        const errors = result.errors || [];
        if (errors.length === 0) {
            await markDone(order, restaurantId);
        } else if (errors.some(isSystemicError)) {
            const partial = await hasDeductionRows(order, restaurantId);
            if (!partial) {
                await releaseClaim(order, restaurantId);
                await recordFailure(order, restaurantId, { retryable: true, errors });
            } else {
                await recordFailure(order, restaurantId, { retryable: false, partial: true, errors });
            }
        } else {
            await recordFailure(order, restaurantId, { retryable: false, errors });
        }
    } catch (err) {
        logger.warn(`Inventory deduction job bookkeeping failed for ${order.orderId}: ${err.message}`);
    }
    return result;
}

/**
 * One retry of one job. `force` ignores the due time (manual retry).
 * Returns { outcome: 'done'|'retried'|'skipped'|'failed', ... }.
 */
async function retryJob(job, { force = false, userId = null } = {}) {
    const now = new Date();
    const due = force ? {} : { nextAttemptAt: { $lte: now } };
    // Lease the job so two instances / a manual click can't run it together.
    const leased = await InventoryDeductionJob.findOneAndUpdate(
        { _id: job._id, restaurant: job.restaurant, state: 'pending', retryable: true, ...due },
        { $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) } },
        { returnDocument: 'after' }
    );
    if (!leased) return { outcome: 'skipped', reason: 'not due or already being retried' };

    const order = await Order.findOne({ _id: job.order, restaurant: job.restaurant });
    if (!order || order.status === 'cancelled' || order.inventoryDeducted) {
        await InventoryDeductionJob.updateOne(
            { _id: job._id, restaurant: job.restaurant },
            { $set: {
                state: 'done', completedAt: now, nextAttemptAt: null, retryable: false,
                lastError: !order ? 'Order no longer exists' : order.status === 'cancelled' ? 'Order cancelled - nothing to deduct' : 'Already deducted',
            } }
        );
        return { outcome: 'done', reason: 'nothing to do' };
    }

    const result = await runDeductionWithRecovery(order, job.restaurant, userId);
    if ((result.errors || []).length) {
        const after = await InventoryDeductionJob.findOne({ _id: job._id, restaurant: job.restaurant }).lean();
        return { outcome: after?.state === 'failed' ? 'failed' : 'retried', errors: result.errors };
    }

    // Cancel raced the retry: give back what the retry just took.
    const fresh = await Order.findOne({ _id: order._id, restaurant: job.restaurant }).select('status inventoryDeducted orderId branch items').lean();
    if (fresh?.status === 'cancelled' && fresh.inventoryDeducted) {
        try {
            const { restoreInventoryForOrder } = require('../controllers/inventoryController');
            await restoreInventoryForOrder(order, job.restaurant, userId);
        } catch (err) {
            logger.warn(`Restore after retried deduction failed for ${order.orderId}: ${err.message}`);
        }
    }
    return { outcome: 'done' };
}

/** Worker body: retry every due job (bounded per tick). Cross-tenant by design. */
async function runDueRetries({ limit = 50, now = new Date() } = {}) {
    const stats = { scanned: 0, done: 0, retried: 0, failed: 0, skipped: 0 };
    // AUDIT-EXEMPT: system sweep across all tenants; each job is then handled with its own restaurant filter
    const jobs = await InventoryDeductionJob.find({
        state: 'pending', retryable: true, nextAttemptAt: { $lte: now },
    }).sort({ nextAttemptAt: 1 }).limit(limit).lean();
    for (const job of jobs) {
        stats.scanned += 1;
        try {
            const r = await retryJob(job);
            stats[r.outcome] = (stats[r.outcome] || 0) + 1;
        } catch (err) {
            logger.warn(`Inventory deduction retry crashed for ${job.orderId}: ${err.message}`);
            stats.failed += 1;
        }
    }
    return stats;
}

module.exports = {
    runDeductionWithRecovery,
    retryJob,
    runDueRetries,
    recordFailure,
    backoffMs,
    maxAttempts,
    isSystemicError,
    hasDeductionRows,
};
