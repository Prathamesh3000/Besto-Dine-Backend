// ADM-036 — auto-restore menu items whose temporary inactivation has
// expired. When an admin clicks "Inactivate" on an item and picks a
// duration (24h, 1 week, or a custom date range), updateMenuItem stamps
// `inactivationUntil` on the document. This scheduler scans every
// MENU_RESTORE_SCAN_MINUTES and flips any item whose window has elapsed
// back to status: 'active' (clearing inactivationUntil / inactivationReason).
//
// Permanent inactivations leave inactivationUntil = null so they're
// invisible to this scan — they only come back via the admin toggle.
//
// Disable in multi-instance setups via MENU_RESTORE_DISABLED=true and
// trigger from an external cron poking runMenuAutoRestoreScan() if needed.

const MenuItem = require('../models/menuItem');
const logger = require('./logger');

const INTERVAL_MIN = Number(process.env.MENU_RESTORE_SCAN_MINUTES) || 15;
const DELAY_MS = 30 * 1000; // first run ~30s after boot

let _timer = null;

async function runMenuAutoRestoreScan() {
    const now = new Date();
    try {
        const result = await MenuItem.updateMany(
            {
                status: 'archived',
                inactivationUntil: { $ne: null, $lte: now },
            },
            {
                $set: {
                    status: 'active',
                    inactivationUntil: null,
                    inactivationReason: '',
                    inStock: true,
                },
            }
        );
        const restored = result.modifiedCount || 0;
        if (restored > 0) {
            logger.info(`menu auto-restore: ${restored} item(s) reactivated`);
        }
        return { restored };
    } catch (err) {
        logger.error('menu auto-restore scan error:', { error: err.message });
        return { restored: 0 };
    }
}

function startScheduledMenuAutoRestore() {
    if (_timer) return;

    if (process.env.MENU_RESTORE_DISABLED === 'true') {
        logger.info('menu auto-restore disabled via MENU_RESTORE_DISABLED');
        return;
    }

    const intervalMs = INTERVAL_MIN * 60 * 1000;
    // #35 — cluster-locked: runs on one instance per interval.
    _timer = require('./scheduler').scheduleJob('menu-auto-restore', intervalMs, runMenuAutoRestoreScan, { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled menu auto-restore every ${INTERVAL_MIN}m (first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    runMenuAutoRestoreScan,
    startScheduledMenuAutoRestore,
};
