// Load + validate configuration FIRST: config/index.js loads Backend/.env,
// and utils/logger (and everything below) reads process.env at require time.
const config = require('./config');

const http = require('http');
const mongoose = require('mongoose');
const logger = require('./utils/logger');

// console.log('MONGO_URL raw:', JSON.stringify(process.env.MONGO_URL));

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const port = process.env.PORT || 5000;

// ─── Boot-time configuration check ───────────────────────────────────────────
// JWT_SECRET and MONGO_URL are required in every environment. In
// production, config.assertProductionConfig() additionally fails fast on
// missing / placeholder secrets (Razorpay keys + webhook secret,
// ALLOWED_ORIGINS, FRONTEND_URL, JWT_SECRET length, ...) and on malformed
// typed values — listing every problem at once. Without it a missing
// RAZORPAY_WEBHOOK_SECRET would silently degrade webhook verification.
const missingAlways = ['JWT_SECRET', 'MONGO_URL'].filter((k) => !process.env[k]);
if (missingAlways.length) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: missing required env ${missingAlways.join(', ')}`);
    process.exit(1);
}
// A production deploy carrying RAZORPAY_MOCK=true would let anyone
// order without paying. Die loudly rather than ignore the flag —
// "quietly ignored" is one refactor away from "quietly honoured".
try {
    require('./utils/razorpayMock').assertMockSafe();
} catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
}

try {
    config.assertProductionConfig();
} catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FATAL (production): ${err.message}`);
    process.exit(1);
}
if (!config.isProduction && config.problems.length) {
    logger.warn(`Configuration problems (fatal in production): ${config.problems.join('; ')}`);
}

const isProduction = process.env.NODE_ENV === 'production';
if (!isProduction) {
    // NODE_ENV is not 'production'. That is correct for local dev, but a
    // live deployment MUST run with NODE_ENV=production: it turns on the
    // production env checks above, strict CORS (no LAN/localhost origins
    // unless CORS_ALLOW_LAN=true), Secure cookies, and generic 5xx error
    // messages (no internal details sent to clients).
    logger.warn(`NODE_ENV is "${process.env.NODE_ENV || 'undefined'}" — development safety defaults are active. Use NODE_ENV=production for any live deployment.`);
}

// ─── MongoDB connection ──────────────────────────────────────────────────────
const uri = process.env.MONGO_URL;

mongoose.connect(uri, {
    // Timeout & server selection
    serverSelectionTimeoutMS: 30000,   // Wait up to 30s to find a primary
    socketTimeoutMS: 45000,            // Close sockets after 45s of inactivity
    connectTimeoutMS: 30000,           // Initial TCP connect timeout

    // Resilience — survive transient Atlas ECONNRESET / failovers
    retryWrites: true,
    retryReads: true,
    heartbeatFrequencyMS: 10000,       // Poll servers every 10s

    // Connection pool
    maxPoolSize: 10,                   // Max simultaneous connections
    minPoolSize: 2,                    // Keep at least 2 connections warm
    maxIdleTimeMS: 30000,              // Recycle idle connections after 30s

    // Keep TCP alive across NAT/firewalls
    family: 4,                         // Force IPv4 (avoids IPv6 Atlas issues)
})
    .then(() => {
        console.log('MongoDB connected');
        logger.debug('Connected to MongoDB Atlas via Mongoose');
        runMigrations();
    })
    .catch((err) => {
        logger.error('MongoDB Connection Error: ' + err.message);
    });

mongoose.connection.on('error', err => {
    logger.error('Mongoose error: ' + err.message);
});
mongoose.connection.on('disconnected', () => {
    logger.warn('Mongoose disconnected — will auto-reconnect');
});
mongoose.connection.on('reconnected', () => {
    logger.info('Mongoose reconnected to MongoDB Atlas');
});

async function runMigrations() {
    const MenuItem = require('./models/menuItem');
    const Category = require('./models/category');
    try {
        const itemsToMigrate = await MenuItem.find({ category: { $not: { $type: "objectId" } } });
        if (itemsToMigrate.length > 0) {
            logger.info(`Migrating ${itemsToMigrate.length} items to ObjectId categories...`);
            for (const item of itemsToMigrate) {
                const cat = await Category.findOne({ name: item.category });
                if (cat) {
                    item.category = cat._id;
                    await item.save();
                }
            }
            logger.info('Migration complete!');
        }
    } catch (err) {
        logger.warn('Migration failed or skipped: ' + err.message);
    }

    // Independent-orders model — drop the legacy
    // `one_active_order_per_table` unique index if it still exists
    // in the live collection. Mongoose schema removal alone doesn't
    // delete the existing index from MongoDB, so a server that
    // upgraded code without running the dropOneActiveOrderIndex.js
    // seed script would still get E11000 errors when a customer
    // tries to place a 2nd order on the same table — and silently
    // fall back to auto-append behavior. Auto-drop on boot guarantees
    // the index is gone the first time the new code starts.
    try {
        const coll = mongoose.connection.db.collection('orders');
        const indexes = await coll.indexes();
        if (indexes.some(i => i.name === 'one_active_order_per_table')) {
            await coll.dropIndex('one_active_order_per_table');
            logger.info('✓ Dropped legacy `one_active_order_per_table` index — multiple active orders per table now allowed.');
        }
    } catch (err) {
        logger.warn('Legacy index drop skipped: ' + err.message);
    }
}

// ─── Express app (middlewares, routes, health probes, error handlers) ──────
// See app.js. /readyz reports 503 once graceful shutdown has begun.
let isShuttingDown = false;
const { createApp } = require('./app');
const { app, isOriginAllowed } = createApp({ isShuttingDown: () => isShuttingDown });

// ─── Background jobs (#35) ───────────────────────────────────────────────────
// Every recurring job below goes through utils/scheduler.scheduleJob, which
// takes a MongoDB lease (utils/jobLock.js, `joblocks` collection) before each
// tick — so with N instances each tick runs on exactly one of them. The
// per-job *_DISABLED flags are no longer needed for multi-instance safety;
// they remain for turning a job off entirely (e.g. external cron).
//
// Phase 4 step 4 — start the scheduled dormancy scan. Runs every
// DORMANCY_SCAN_HOURS (default 6h), first run ~1 minute after boot
// so it doesn't block startup. Disabled via DORMANCY_SCAN_DISABLED=true
// on multi-instance setups that prefer an external cron poking the
// manual endpoint.
require('./utils/alerts').startScheduledDormancyScan();

// Advance-booking balance reminders. Sends a customer notification +
// socket emit when a confirmed booking is within
// BOOKING_REMINDER_WINDOW_HOURS (default 24h) of its event date and
// the balance is still unpaid. Same disable flag pattern as dormancy:
// set BOOKING_REMINDER_DISABLED=true on multi-instance setups.
require('./utils/bookingReminderScheduler').startScheduledBookingReminders();

// ADM-036 — auto-restore menu items whose temporary inactivation has
// expired. Runs every MENU_RESTORE_SCAN_MINUTES (default 15m).
// Disable on multi-instance setups via MENU_RESTORE_DISABLED=true.
require('./utils/menuAutoRestoreScheduler').startScheduledMenuAutoRestore();

// Auto-heal dead category hero images. Does a LIVE HEAD check on every
// category image and re-points any that 404/410 (or are empty/placeholder)
// to an accurate, name-matched, HEAD-verified replacement. Runs every
// CATEGORY_IMAGE_HEAL_HOURS (default 24h). Disable via
// CATEGORY_IMAGE_HEAL_DISABLED=true on multi-instance setups.
require('./utils/categoryImageHealer').startScheduledCategoryImageHeal();

// Same live-HEAD auto-heal for menu-item + combo images. Clears any image
// that 404/410s or is the legacy placeholder so the UI shows a blank box;
// never fills a stock photo in. Runs every MENU_IMAGE_HEAL_HOURS
// (default 24h). Disable via MENU_IMAGE_HEAL_DISABLED=true.
require('./utils/menuItemImageHealer').startScheduledMenuItemImageHeal();

// ─── Unhandled Rejection Handler ─────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { reason: reason?.message || reason });
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
    process.exit(1);
});

// ─── Create HTTP Server + Socket.io (M1) ────────────────────────────────────
const server = http.createServer(app);
const socketUtil = require('./utils/socket');
socketUtil.init(server, isOriginAllowed);
logger.debug('Socket.io initialized');

// ─── Payment Reconciliation — check stale Pending orders every 30 min ───────
// #35 — cluster-locked via utils/scheduler (one instance per interval).
// First run after one full interval, as before.
const { runScheduledReconciliation } = require('./controllers/razorpayController');
const scheduler = require('./utils/scheduler');
scheduler.scheduleJob('payment-reconciliation', 30 * 60 * 1000, runScheduledReconciliation);

// ─── Halted subscriptions — suspend after the 24h grace period ─────────────
// subscription.halted marks the tenant past_due and schedules the lockout
// (decision 5, 2026-10); this job applies it once the grace period ends.
require('./utils/haltedSubscriptionSuspender').startHaltedSubscriptionSuspender();

// ─── Stale takeaway order sweeper — observe-only, notifies admins ───────────
// Flags takeaway orders stuck in 'ready' for longer than the threshold
// (default 6h) so admins can clean them up from the Orders dashboard.
// Never modifies orders — cleanup is a deliberate admin action.
require('./utils/staleOrderSweeper').startScheduledStaleOrderSweep();

// ─── Scheduled-takeaway releaser — pushes future-pickup orders to ──────────
// the chef KDS when they cross the release window. Customer can order
// at 11 AM for 2 PM pickup; chef sees the card around 1:30 PM, not
// at 11 AM. See utils/scheduledTakeawayReleaser.js for the rationale.
require('./utils/scheduledTakeawayReleaser').startScheduledTakeawayReleaser();

// ─── Empty-order sweeper — auto-cancels orphan orders + frees tables ───────
// Closes the class of bugs where an Order shell is created on QR scan
// / first KOT but items[] is never populated — locking the table
// indefinitely. Only touches rows with empty items, Pending payment,
// and an open status past the grace window, so customer money is
// never at risk.
require('./utils/emptyOrderSweeper').startScheduledEmptyOrderSweep();

// ─── Held-order sweeper — cancels pay-first orders never paid ──────────────
// Operations profile (pay first, held until paid): an order waiting for
// cash at the counter that never arrives is cancelled at its deadline and
// its table released. See utils/heldOrderSweeper.js.
require('./utils/heldOrderSweeper').startScheduledHeldOrderSweep();

// ─── Incentive reconcile — hourly safety net for staff incentives ──────────
// Reverses entries of cancelled / refunded orders and re-runs the (idempotent)
// accrual for recently served-or-paid orders of tenants that have campaigns,
// covering paths that bypass the request-time hooks. See
// services/incentiveService.js. INCENTIVE_RECONCILE_DISABLED=true to turn off.
require('./services/incentiveService').startScheduledIncentiveReconcile();

// ─── Shift auto-closer — closes abandoned waiter shifts ────────────────────
// A shift left in status='active' for longer than SHIFT_AUTOCLOSE_HOURS
// (default 16h) gets marked 'missed' with a capped clockOut + audit note,
// preventing the staff member from being blocked on next clock-in.
require('./utils/shiftAutoCloser').startScheduledShiftAutoClose();

// ─── Start Server ────────────────────────────────────────────────────────────
server.listen(port, () => {
    logger.info(`Server is running on port: ${port}`);
    // ^ Intentionally kept at info — one-line boot confirmation that the
    //   process is healthy. Everything else (cron arms, socket init, DB
    //   connect, scheduler heartbeats) is demoted to debug.
});

// ─── #35 — graceful shutdown (SIGTERM from the orchestrator, Ctrl+C) ────────
// 1. mark not-ready (/readyz → 503) and stop accepting new connections
// 2. stop the job scheduler, waiting (bounded) for in-flight job runs
// 3. close socket.io (disconnects clients so they reconnect to another
//    instance) and its Redis adapter clients
// 4. close mongoose, exit 0
// A hard deadline (SHUTDOWN_TIMEOUT_MS, default 25s — under Kubernetes'
// 30s default grace period) force-exits if anything hangs.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25000;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);
    const force = setTimeout(() => {
        logger.error(`Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    try {
        const httpClosed = new Promise((resolve) => server.close(() => resolve()));
        // Drop idle keep-alive sockets so server.close() can finish.
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

        await scheduler.stopAll({ timeoutMs: Math.max(1000, SHUTDOWN_TIMEOUT_MS - 8000) });
        await socketUtil.close();
        await require('./utils/rateLimitStore').close();
        // In-flight HTTP requests get a short window to finish.
        await Promise.race([httpClosed, new Promise((r) => setTimeout(r, 5000).unref())]);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        // Bounded: a connection still stuck in its initial connect would
        // otherwise hold close() until serverSelectionTimeoutMS.
        await Promise.race([
            mongoose.connection.close(false),
            new Promise((r) => setTimeout(r, 5000).unref()),
        ]);
        logger.info('Shutdown complete');
        clearTimeout(force);
        process.exit(0);
    } catch (err) {
        logger.error('Error during graceful shutdown: ' + (err?.message || err));
        process.exit(1);
    }
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });