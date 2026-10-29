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
const logger = require('./logger');

const INTERVAL_MS = 60 * 60 * 1000;

async function runLedgerPostJob({ now = new Date() } = {}) {
    // AUDIT-EXEMPT: platform-wide job, iterates every live tenant by design
    const restaurants = await Restaurant.find({ status: { $in: ['trial', 'active', 'past_due'] } }).select('_id timezone').lean();
    let inserted = 0;
    for (const r of restaurants) {
        try {
            const tz = safeTz(r.timezone);
            const today = businessDateOf(now, tz);
            const res = await ledger.postRange(r._id, addDays(today, -1), today, { timeZone: tz });
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
