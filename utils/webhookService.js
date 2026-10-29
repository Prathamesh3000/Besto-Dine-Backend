/**
 * Outbound webhooks: event fan-out, signed delivery, retry/backoff and
 * auto-disable.
 *
 *   emitWebhookEvent(restaurantId, type, data)   fire-and-forget, never throws
 *   processDueDeliveries()                       the retry job body
 *   startScheduledWebhookDelivery()              registers the job (server.js)
 *
 * Flow: emit -> one WebhookDelivery row per active, subscribed endpoint of
 * a tenant that still has the `publicApi` feature -> first attempt right
 * away (background) -> on failure the row stays `pending` with a
 * `nextAttemptAt` from BACKOFF_MS until MAX_ATTEMPTS, then `failed`.
 * Every failed attempt bumps the endpoint's `consecutiveFailures`; at
 * MAX_CONSECUTIVE_FAILURES the endpoint is switched off (`active:false`,
 * `disabledAt`, `disabledReason`) and the UI shows it. A success resets
 * the counter.
 *
 * Delivery is at-least-once: receivers dedupe on the event id (the body
 * `id`; X-BestoDine-Delivery is the delivery row).
 */
'use strict';

const crypto = require('crypto');
const WebhookEndpoint = require('../models/webhookEndpoint');
const WebhookDelivery = require('../models/webhookDelivery');
const Restaurant = require('../models/restaurant');
const { hasFeature } = require('./featureAccess');
const { sign } = require('./webhookSigner');
const { safePost } = require('./safeHttpPost');
const { runWithoutContext } = require('./requestContext');
const logger = require('./logger');

const MAX_ATTEMPTS = 6;
// Wait after failed attempt N (1-based) before attempt N+1.
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 3600 * 1000, 6 * 3600 * 1000];
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const BATCH = 50;

function maxConsecutiveFailures() {
    const n = Number(process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Delay before the next attempt after `attempts` failed attempts, or null when out of attempts. */
function backoffAfter(attempts) {
    if (attempts >= MAX_ATTEMPTS) return null;
    return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
}

function newEventId() {
    return `evt_${crypto.randomBytes(12).toString('hex')}`;
}

function newSecret() {
    return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

function buildEnvelope(eventId, type, data) {
    return { id: eventId, type, created: Math.floor(Date.now() / 1000), data };
}

/**
 * Perform one delivery attempt and persist the outcome.
 * @param {object} delivery  WebhookDelivery doc
 * @param {object} endpoint  WebhookEndpoint doc WITH secret
 * @param {{ countFailure?: boolean, retry?: boolean, deps?: object }} [opts]
 */
async function attemptDelivery(delivery, endpoint, opts = {}) {
    const countFailure = opts.countFailure !== false;
    const retry = opts.retry !== false;
    const attempts = (delivery.attempts || 0) + 1;

    let result;
    if (!endpoint || endpoint.active === false) {
        result = { ok: false, status: null, error: 'Endpoint is disabled' };
    } else {
        const body = JSON.stringify(delivery.payload);
        const { header } = sign(endpoint.secret, body);
        result = await safePost(endpoint.url, {
            body,
            headers: {
                'X-BestoDine-Signature': header,
                'X-BestoDine-Event': delivery.type,
                'X-BestoDine-Delivery': String(delivery._id),
            },
        }, opts.deps);
    }

    const set = {
        attempts,
        responseCode: result.status ?? null,
        lastError: result.ok ? '' : String(result.error || 'Failed').slice(0, 300),
    };
    if (result.ok) {
        set.status = 'success';
        set.deliveredAt = new Date();
    } else {
        const wait = retry && endpoint && endpoint.active !== false ? backoffAfter(attempts) : null;
        if (wait == null) {
            set.status = 'failed';
        } else {
            set.status = 'pending';
            set.nextAttemptAt = new Date(Date.now() + wait);
        }
    }
    await WebhookDelivery.updateOne({ _id: delivery._id, restaurant: delivery.restaurant }, { $set: set });
    Object.assign(delivery, set);

    if (endpoint && endpoint.active !== false) {
        if (result.ok) {
            if (endpoint.consecutiveFailures) {
                await WebhookEndpoint.updateOne({ _id: endpoint._id, restaurant: endpoint.restaurant }, { $set: { consecutiveFailures: 0 } });
            }
        } else if (countFailure) {
            const upd = await WebhookEndpoint.findOneAndUpdate(
                { _id: endpoint._id, restaurant: endpoint.restaurant },
                { $inc: { consecutiveFailures: 1 } },
                { returnDocument: 'after' },
            );
            if (upd && upd.active && upd.consecutiveFailures >= maxConsecutiveFailures()) {
                await WebhookEndpoint.updateOne(
                    { _id: upd._id, restaurant: upd.restaurant, active: true },
                    { $set: {
                        active: false,
                        disabledAt: new Date(),
                        disabledReason: `Disabled after ${upd.consecutiveFailures} consecutive failed deliveries. Last error: ${set.lastError}`,
                    } },
                );
                logger.warn('webhook.endpoint.auto-disabled', { restaurant: String(upd.restaurant), endpoint: String(upd._id) });
            }
        }
    }
    return { ok: result.ok, status: result.status ?? null, error: result.ok ? null : set.lastError, delivery };
}

// Recently emitted keyed events (in-process guard against two settlers
// racing inside one tick; the DB check below covers other processes).
const RECENT_KEYS = new Set();
const RECENT_KEYS_MAX = 2000;

/** Deterministic event id for a business transition (receivers dedupe on it). */
function eventIdForKey(restaurantId, type, key) {
    return `evt_${crypto.createHash('sha256').update(`${restaurantId}|${type}|${key}`).digest('hex').slice(0, 24)}`;
}

async function _emit(restaurantId, type, data, opts = {}) {
    const eventKey = opts && opts.eventKey ? String(opts.eventKey) : null;
    const endpoints = await WebhookEndpoint.find({ restaurant: restaurantId, active: true, events: type })
        .select('+secret').lean();
    if (!endpoints.length) return 0;

    const restaurant = await Restaurant.findById(restaurantId).select('subscription featureOverrides addons').lean();
    if (!restaurant || !hasFeature(restaurant, 'publicApi')) return 0;

    const eventId = eventKey ? eventIdForKey(restaurantId, type, eventKey) : newEventId();
    const payload = buildEnvelope(eventId, type, data);
    // Created with a future nextAttemptAt so the retry job leaves it alone
    // while the immediate attempt below is in flight.
    const lease = new Date(Date.now() + CLAIM_LEASE_MS);
    for (const ep of endpoints) {
        if (eventKey) {
            // One business transition = one event per endpoint.
            const exists = await WebhookDelivery.findOne({ restaurant: restaurantId, endpoint: ep._id, eventId }).select('_id').lean();
            if (exists) continue;
        }
        const delivery = await WebhookDelivery.create({
            restaurant: restaurantId, endpoint: ep._id, eventId, type, payload, status: 'pending', nextAttemptAt: lease,
        });
        try {
            await attemptDelivery(delivery, ep);
        } catch (err) {
            logger.warn('webhook.deliver.error', { error: err.message });
        }
    }
    return endpoints.length;
}

/**
 * Queue + send a webhook event. Never throws and never blocks the caller:
 * all work happens on a later tick, outside the request's tenant context.
 */
function emitWebhookEvent(restaurantId, type, data, opts) {
    try {
        if (!restaurantId || !type) return;
        const eventKey = opts && opts.eventKey ? String(opts.eventKey) : null;
        if (eventKey) {
            const memo = `${restaurantId}|${type}|${eventKey}`;
            if (RECENT_KEYS.has(memo)) return;
            RECENT_KEYS.add(memo);
            if (RECENT_KEYS.size > RECENT_KEYS_MAX) RECENT_KEYS.delete(RECENT_KEYS.values().next().value);
        }
        setImmediate(() => {
            runWithoutContext(() => _emit(restaurantId, type, data, opts))
                .catch((err) => logger.warn('webhook.emit.failed', { type, error: err.message }));
        });
    } catch (err) {
        try { logger.warn('webhook.emit.failed', { type, error: err.message }); } catch { /* never throw */ }
    }
}

/**
 * `order.paid` for an order that just became paid, from ANY settlement path
 * (staff, Razorpay verify/webhook/reconcile, wallet, split siblings).
 * The event id is derived from the order id, so however many paths report
 * the same transition it is delivered once per endpoint. Never throws.
 */
function emitOrderPaid(order) {
    try {
        if (!order || !order._id || !order.restaurant) return;
        const { serializeOrder } = require('./publicApiSerializers');
        emitWebhookEvent(order.restaurant, 'order.paid', serializeOrder(order), { eventKey: `order:${order._id}:paid` });
    } catch { /* webhooks never affect the order */ }
}

/**
 * `refund.created` for one processed refund. The key is the order plus the
 * running refunded total after this refund (unique per refund), so a refund
 * reported by both the direct and the request-approval path is sent once.
 */
function emitRefundCreated(order, { amount, mode, refundRequestId, refundedAmount } = {}) {
    try {
        if (!order || !order._id || !order.restaurant) return;
        const total = refundedAmount != null ? refundedAmount : order.refundedAmount;
        emitWebhookEvent(order.restaurant, 'refund.created', {
            order_id: order.orderId, amount, mode: mode || null, refund_request_id: refundRequestId ? String(refundRequestId) : null,
        }, { eventKey: `order:${order._id}:refund:${total}` });
    } catch { /* webhooks never affect the refund */ }
}

/** Retry job body: send every due `pending` delivery (claimed atomically). */
async function processDueDeliveries({ limit = BATCH, now = new Date(), deps } = {}) {
    const due = await WebhookDelivery.find({ status: 'pending', nextAttemptAt: { $lte: now } })
        .setOptions({ skipTenantScope: true }).sort({ nextAttemptAt: 1 }).limit(limit).lean();
    let sent = 0;
    for (const row of due) {
        // Claim: only one instance wins; the lease protects against a crash mid-attempt.
        const claimed = await WebhookDelivery.findOneAndUpdate(
            { _id: row._id, restaurant: row.restaurant, status: 'pending', nextAttemptAt: { $lte: now } },
            { $set: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) } },
            { returnDocument: 'after' },
        );
        if (!claimed) continue;
        const endpoint = await WebhookEndpoint.findOne({ _id: claimed.endpoint, restaurant: claimed.restaurant }).select('+secret');
        try {
            await attemptDelivery(claimed, endpoint, { deps });
            sent += 1;
        } catch (err) {
            logger.warn('webhook.retry.error', { error: err.message });
        }
    }
    return sent;
}

function startScheduledWebhookDelivery() {
    if (String(process.env.WEBHOOK_DELIVERY_DISABLED).toLowerCase() === 'true') {
        logger.info('Webhook delivery job disabled via WEBHOOK_DELIVERY_DISABLED');
        return;
    }
    require('./scheduler').scheduleJob('webhook-delivery', 30 * 1000,
        () => runWithoutContext(() => processDueDeliveries()),
        { initialDelayMs: 20 * 1000 });
}

module.exports = {
    MAX_ATTEMPTS, BACKOFF_MS, backoffAfter, newSecret, newEventId, buildEnvelope,
    attemptDelivery, emitWebhookEvent, emitOrderPaid, emitRefundCreated, eventIdForKey, processDueDeliveries, startScheduledWebhookDelivery,
};
