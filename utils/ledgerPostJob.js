'use strict';
/**
 * Scheduled ledger "post day" (Plan 3B.3). Every tick, for each live tenant,
 * posts yesterday and today (restaurant time zone). Posting is idempotent, so
 * overlapping or repeated runs are harmless.
 *
 * Opt-in: nothing is scheduled unless LEDGER_AUTO_POST=true. The on-demand
 * endpoint POST /api/v1/ledger/post-day works regardless.
 */
const Restaurant = require('../models/restaurant');
const ledger = require('../services/ledgerService');
const { businessDateOf, addDays, safeTz } = require('./businessDate');
const LedgerEntry = require('../models/ledgerEntry');
const Order = require('../models/order');
const logger = require('./logger');

const MAX_CATCHUP_DAYS = 31;

const INTERVAL_MS = 60 * 60 * 1000;

async function runLedgerPostJob({ now = new Date() } = {}) {
    // AUDIT-EXEMPT: platform-wide job, iterates every live tenant by design
    const restaurants = await Restaurant.find({ status: { $in: ['trial', 'active', 'past_due'] } }).select('_id timezone').lean();
    let inserted = 0;
    for (const r of restaurants) {
        try {
            const tz = safeTz(r.timezone);
            const today = businessDateOf(now, tz);
            // Catch up: from the day after the last posted day (at most
            // MAX_CATCHUP_DAYS back, at minimum yesterday). Idempotent.
            const floor = addDays(today, -(MAX_CATCHUP_DAYS - 1));
            let from = addDays(today, -1);
            const last = await LedgerEntry.findOne({ restaurant: r._id }).sort({ businessDate: -1 }).select('businessDate').lean();
            if (last?.businessDate) {
                const next = addDays(last.businessDate, 1);
                if (next < from) from = next;
            } else {
                // Never posted: back-fill only when the tenant has recent sales.
                const since = new Date(Date.parse(floor + 'T00:00:00Z') - 86400000);
                const any = await Order.exists({ restaurant: r._id, $or: [{ paidAt: { $gte: since } }, { createdAt: { $gte: since } }] });
                if (any) from = floor;
            }
            if (from < floor) from = floor;
            const res = await ledger.postRange(r._id, from, today, { timeZone: tz });
            inserted += res.inserted;
        } catch (err) {
            logger.error('ledger-post-day failed for tenant', { restaurant: String(r._id), error: err?.message });
        }
    }
    return { restaurants: restaurants.length, inserted };
}

function startLedgerPostJob(scheduler) {
    if (String(process.env.LEDGER_AUTO_POST || '').toLowerCase() !== 'true') return null;
    return scheduler.scheduleJob('ledger-post-day', INTERVAL_MS, runLedgerPostJob, { initialDelayMs: 5 * 60 * 1000 });
}

module.exports = { runLedgerPostJob, startLedgerPostJob, INTERVAL_MS };
