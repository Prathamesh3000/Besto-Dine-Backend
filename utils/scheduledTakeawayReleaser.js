/**
 * Scheduled-takeaway releaser.
 *
 * Customer can place a takeaway order with a pickup time hours in the
 * future ("11 AM order, 2 PM pickup"). The chef KDS hides such orders
 * until pickup is within SCHEDULED_LEAD_MIN minutes — see the filter
 * in orderController.getKitchenOrders. Once a held order crosses into
 * the release window, the chef should see it without waiting for a
 * manual refresh.
 *
 * This periodic job (every 60 s) finds orders that just entered the
 * release window and emits a fresh `order:new` socket event so the
 * KDS pops them in live. Cheap fan-out, idempotent — re-emitting on
 * an already-displayed order is harmless because the chef KDS reads
 * the event as "refresh, something changed".
 *
 * Server restart resilience: nothing is persisted. On reboot the next
 * tick rediscovers the orders and emits — at worst a 60 s delay for a
 * scheduled order's KDS appearance, which is well inside the lead
 * window.
 */
const Order = require('../models/order');
const logger = require('./logger');
const { getIO, emitToKitchen } = require('./socket');
const { parsePickupAt, SCHEDULED_LEAD_MIN } = require('./pickupTime');

const TICK_INTERVAL_MS = 60 * 1000;        // 60 s — granularity of "release"
// Catches orders released between ticks. The extra 15 s covers tick
// jitter when the cluster lease (#35) hands the job between instances
// whose timers are out of phase — a duplicate order:new is harmless, a
// missed one is not.
const RELEASE_GRACE_MS = TICK_INTERVAL_MS + 15 * 1000;
// Max createdAt → release gap: parsePickupAt wraps a pickup at most one
// day past createdAt.
const CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function releaseTick() {
    try {
        const now = Date.now();
        // Pull every still-pending takeaway that could release now. The
        // release instant (pickup − lead), not createdAt, decides — and
        // parsePickupAt never places a pickup more than 24 h after
        // createdAt, so a 24 h createdAt window covers every order whose
        // release can be due (a 09:00 order for a 10:30 PM pickup
        // releases 13 h after creation). The window only bounds the scan.
        const windowStart = new Date(now - CANDIDATE_WINDOW_MS);
        const candidates = await Order.find({
            type: 'takeaway',
            status: 'new',
            pickupTime: { $exists: true, $ne: null },
            createdAt: { $gte: windowStart },
        }).select('_id orderId restaurant branch createdAt pickupTime').lean();

        const io = getIO();
        let released = 0;
        for (const o of candidates) {
            const pickupAt = parsePickupAt(o);
            if (!pickupAt) continue;
            const releaseAt = pickupAt.getTime() - SCHEDULED_LEAD_MIN * 60 * 1000;
            // Crossed into release window in the last tick → emit
            // exactly once. Orders that crossed earlier have already
            // been emitted on previous ticks (and the KDS state).
            if (releaseAt <= now && releaseAt > now - RELEASE_GRACE_MS) {
                try {
                    emitToKitchen(io, o.branch || null, 'order:new', { orderId: o.orderId, restaurant: o.restaurant ? String(o.restaurant) : undefined });
                    released += 1;
                } catch (err) {
                    logger.warn('Scheduled-release emit failed:', { orderId: o.orderId, error: err.message });
                }
            }
        }
        if (released > 0) {
            logger.info(`Scheduled takeaway releaser: surfaced ${released} order(s) to chef KDS.`);
        }
    } catch (err) {
        logger.warn('Scheduled-takeaway tick failed (will retry next interval):', err.message);
    }
}

let timerId = null;
function startScheduledTakeawayReleaser() {
    if (timerId) return;
    // First tick a few seconds after boot so it doesn't race with
    // socket / DB readiness; subsequent ticks every 60 s.
    // #35 — cluster-locked: one instance emits per tick (the emit fans out
    // to every instance's sockets through the socket.io adapter).
    timerId = require('./scheduler').scheduleJob('scheduled-takeaway-release', TICK_INTERVAL_MS, releaseTick, { initialDelayMs: 5000 });
    logger.debug(`Scheduled-takeaway releaser armed (every ${TICK_INTERVAL_MS / 1000}s, lead ${SCHEDULED_LEAD_MIN} min).`);
}

module.exports = { startScheduledTakeawayReleaser };
