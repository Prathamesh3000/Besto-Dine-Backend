/**
 * Express app wiring — middlewares, /api/v1 routes, health probes and
 * error handlers. NO side effects beyond building the app: no MongoDB
 * connect, no listen, no background jobs, no process handlers. Those
 * live in server.js (production boot) — the integration tests build the
 * real app through createApp() (__tests__/integration/helpers/createTestApp.js).
 *
 *   const { createApp } = require('./app');
 *   const { app, isOriginAllowed } = createApp({ isShuttingDown: () => false });
 *   const server = http.createServer(app);
 *   require('./utils/socket').init(server, isOriginAllowed);
 *
 * Options:
 *   isShuttingDown  () => boolean — read by /readyz (503 while draining).
 */
// Load + validate configuration FIRST: config/index.js loads Backend/.env,
// and utils/logger (and everything below) reads process.env at require time.
require('./config');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const Sentry = require('@sentry/node');
const path = require('path');
const logger = require('./utils/logger');

function createApp({ isShuttingDown = () => false } = {}) {
    const app = express();
    const isProduction = process.env.NODE_ENV === 'production';

    // ─── Trust proxy — env-driven (TRUST_PROXY) ──────────────────────────────────
    // req.ip (and therefore every rate limiter) is derived from
    // X-Forwarded-For only for hops Express is told to trust. Trusting a proxy
    // that is not there lets any client spoof its IP and dodge rate limits.
    //   TRUST_PROXY=1            exactly one reverse proxy (nginx / a PaaS router)
    //   TRUST_PROXY=2            e.g. Cloudflare → nginx → node
    //   TRUST_PROXY=false        node is exposed directly (no proxy)
    //   TRUST_PROXY=loopback,10.0.0.0/8   trust specific proxy addresses
    // Unset: production assumes 1 hop (the previous hard-coded value) and logs
    // a warning; development trusts only loopback (e.g. the Vite dev proxy).
    function parseTrustProxy(raw) {
        if (raw === undefined || String(raw).trim() === '') return undefined;
        const v = String(raw).trim().toLowerCase();
        if (v === 'true') return true;
        if (v === 'false' || v === '0') return false;
        if (/^\d+$/.test(v)) return Number(v);
        return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
    }
    let trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
    if (trustProxy === undefined) {
        trustProxy = isProduction ? 1 : 'loopback';
        if (isProduction) {
            logger.warn('TRUST_PROXY is not set — assuming exactly one reverse proxy. Set TRUST_PROXY explicitly (false if Node is exposed directly).');
        }
    } else if (trustProxy === true && isProduction) {
        logger.warn('TRUST_PROXY=true trusts every X-Forwarded-For hop — clients can spoof their IP. Prefer a hop count.');
    }
    app.set('trust proxy', trustProxy);

    // ─── Sentry — Error Tracking (H8) ───────────────────────────────────────────
    // Set SENTRY_DSN in .env to enable. Without it, Sentry silently does nothing.
    if (process.env.SENTRY_DSN) {
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',
            tracesSampleRate: 0.2, // Capture 20% of transactions for performance monitoring
        });
        // @sentry/node v8+ instruments incoming requests automatically after
        // init(); the old Sentry.Handlers.requestHandler() no longer exists.
        logger.info('Sentry error tracking initialized');
    }

    // ─── Security Headers ────────────────────────────────────────────────────────
    app.use(helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: false,
    }));

    // ─── CORS — restrict to allowed origins ──────────────────────────────────────
    const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'])
        .map((o) => o.trim())
        .filter(Boolean);
    const isDev = !isProduction;
    // CORS_ALLOW_LAN — also accept any localhost / 127.0.0.1 / private-LAN origin so
    // a dev machine reached via a different host or IP (e.g. a phone on the LAN)
    // isn't blocked. Explicit flag; when unset it defaults to ON in development
    // and OFF in production. Setting it true in production is honoured but
    // logged — credentialed CORS for arbitrary LAN origins is not a prod setting.
    const corsAllowLan = (() => {
        const v = process.env.CORS_ALLOW_LAN;
        if (v === undefined || String(v).trim() === '') return isDev;
        return ['true', '1', 'yes'].includes(String(v).trim().toLowerCase());
    })();
    if (isProduction && corsAllowLan) {
        logger.warn('CORS_ALLOW_LAN=true in production — localhost and private-LAN origins are allowed with credentials.');
    }
    const isDevLocalOrigin = (origin) => {
        try {
            const { hostname } = new URL(origin);
            return (
                hostname === 'localhost' ||
                hostname === '127.0.0.1' ||
                hostname === '::1' ||
                /^10\./.test(hostname) ||
                /^192\.168\./.test(hostname) ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
            );
        } catch {
            return false;
        }
    };
    // Shared with socket.io (server.js → utils/socket.init) so a phone on
    // the LAN can open the realtime connection too, not just REST calls.
    const isOriginAllowed = (origin) =>
        !origin || allowedOrigins.includes(origin) || (corsAllowLan && isDevLocalOrigin(origin));
    app.use(cors({
        origin: (origin, callback) => {
            if (isOriginAllowed(origin)) return callback(null, true);
            logger.warn(`CORS: Origin not allowed: ${origin}`);
            const corsErr = new Error('CORS: Origin not allowed');
            corsErr.status = 403;
            corsErr.expose = true;
            callback(corsErr);
        },
        credentials: true,
        // Browsers hide non-simple response headers from JS unless they're
        // explicitly exposed. Attachment downloads (tenant data export,
        // report .xlsx, invoice PDFs) read the server's suggested filename
        // from Content-Disposition — without this the frontend can't see it
        // and falls back to a generic name.
        exposedHeaders: ['Content-Disposition'],
    }));

    // ─── Body parsing with size limits ───────────────────────────────────────────
    // Razorpay webhooks must be signed against the EXACT raw request bytes.
    // `express.json()` reparses & reserializes, and any key reordering or
    // whitespace change will break signature verification. Mount a raw-body
    // parser ahead of express.json() for just the webhook path so the handler
    // can verify the HMAC and then parse the payload itself.
    app.use('/api/v1/razorpay/webhook', express.raw({ type: 'application/json', limit: '2mb' }));
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: true, limit: '2mb' }));

    // ─── NoSQL operator-injection guard (#21) ────────────────────────────────────
    // Strip `$`-prefixed keys (and prototype-pollution keys) from request
    // bodies so a client can't smuggle `{ "password": { "$ne": null } }` or
    // `{ "$set": {...} }` into a filter/update built from req.body.
    //
    // Why not mongoose.set('sanitizeFilter', true)? It is global and cannot
    // tell user input from server code: it wraps EVERY nested `$` operator in
    // a filter object in `$eq` (so server-built `{ role: { $in: [...] } }`
    // becomes a literal match) and throws on `$where`/`$expr`, unless every
    // legitimate query is wrapped in mongoose.trusted(). That would break
    // hundreds of queries. Sanitising the untrusted input instead is precise.
    //
    // req.query needs no treatment: Express 5 uses the 'simple' query parser
    // (node:querystring), which only produces strings / string arrays, never
    // nested objects. req.params are always strings. The raw Razorpay webhook
    // body is a Buffer and is skipped.
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    function stripMongoOperators(value, depth = 0) {
        if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
        if (depth > 32) return value;
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) value[i] = stripMongoOperators(value[i], depth + 1);
            return value;
        }
        for (const key of Object.keys(value)) {
            if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) {
                delete value[key];
                continue;
            }
            value[key] = stripMongoOperators(value[key], depth + 1);
        }
        return value;
    }
    app.use((req, res, next) => {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
            stripMongoOperators(req.body);
        }
        next();
    });

    // ─── 5xx response scrubber (#21) ─────────────────────────────────────────────
    // ~130 controller catch blocks answer `res.status(500).json({ message:
    // err.message, error: err.message })`, leaking Mongo / stack internals.
    // Rather than edit each one, wrap res.json: in production, any 5xx JSON
    // body loses its `error` / `stack` / `details` fields, and a 500/502/504
    // `message` is replaced with a generic one. The original text is logged.
    // 503 messages are kept — they are deliberate "try again" notices.
    // Development responses are untouched so debugging stays easy.
    const GENERIC_5XX_MESSAGE = 'Something went wrong on the server. Please try again.';
    const LEAKY_KEYS = ['error', 'err', 'stack', 'details', 'errors', 'reason'];
    app.use((req, res, next) => {
        if (!isProduction) return next();
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body)) {
                const clean = { ...body };
                const removed = {};
                for (const k of LEAKY_KEYS) {
                    if (k in clean) {
                        removed[k] = typeof clean[k] === 'string' ? clean[k] : '[object]';
                        delete clean[k];
                    }
                }
                if (res.statusCode !== 503 && typeof clean.message === 'string' && clean.message !== GENERIC_5XX_MESSAGE) {
                    removed.message = clean.message;
                    clean.message = GENERIC_5XX_MESSAGE;
                }
                if (Object.keys(removed).length) {
                    logger.warn('response.5xx.scrubbed', {
                        status: res.statusCode,
                        method: req.method,
                        path: req.originalUrl,
                        removed,
                    });
                }
                return originalJson(clean);
            }
            return originalJson(body);
        };
        next();
    });

    // ─── Compression ─────────────────────────────────────────────────────────────
    // gzip is good enough for our JSON response sizes — Brotli would shave a
    // further ~15% but the standard `compression` package is gzip-only and a
    // custom zlib.createBrotliCompress() pipeline has too many edge cases
    // (streaming, Vary headers, fallback). The cleaner path in production is
    // to terminate Brotli at the reverse proxy (nginx `brotli on;` or
    // Cloudflare auto-Brotli) and keep this Express middleware as the
    // in-process gzip fallback for local dev / direct-to-Node hits.
    app.use(compression());

    // ─── Disable HTTP caching for /api responses ─────────────────────────────────
    // Browsers cache responses to disk by default — per RFC 7234, 410 Gone
    // (and several other status codes) are explicitly cacheable without an
    // explicit Cache-Control header. We hit this in production: a brief window
    // where /api/v1/refund-requests returned 410 (route existed locally but
    // hadn't deployed yet) was cached to disk by every admin who loaded the
    // page, and Chrome kept replaying the stale 410 from disk long after the
    // backend was fixed. `no-store` forbids storage entirely so every request
    // re-validates against the server. Applies to every /api/* response —
    // successes, 4xx, 5xx, and the unversioned-/api catch-all alike.
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    // ─── Rate Limiting ───────────────────────────────────────────────────────────
    // utils/rateLimitStore.makeLimiter: Redis-backed (shared across instances)
    // when REDIS_URL is set, in-memory otherwise.
    const { makeLimiter } = require('./utils/rateLimitStore');
    const authLimiter = makeLimiter({
        name: 'auth',
        windowMs: 15 * 60 * 1000,
        max: 50,
        message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use('/api/v1/auth/login', authLimiter);
    app.use('/api/v1/auth/register', authLimiter);
    app.use('/api/v1/auth/send-otp', authLimiter);
    app.use('/api/v1/auth/verify-otp', authLimiter);
    app.use('/api/v1/auth/change-password', authLimiter);

    const apiLimiter = makeLimiter({
        name: 'api',
        windowMs: 60 * 1000,
        max: 200,
        message: { success: false, message: 'Too many requests. Please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use('/api/v1/', apiLimiter);

    // ─── Static files ────────────────────────────────────────────────────────────
    app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

    // ─── API v1 Routes ───────────────────────────────────────────────────────────
    const v1 = express.Router();

    // ── Phase 1 SaaS context ────────────────────────────────────────────────
    // Every v1 request runs through optionalAuth → attachTenant BEFORE any
    // individual route's `protect` middleware fires. This populates:
    //   req.user        — if a valid Bearer token is present
    //   req.restaurant  — derived from req.user.restaurant, the X-Restaurant-Slug
    //                     header, ?restaurant=<slug>, or the default tenant fallback
    // Both middlewares gracefully degrade (no token / no slug → req stays bare)
    // so unauthenticated public routes continue to work unchanged.
    const { optionalAuth, requirePasswordCurrent } = require('./middlewares/authMiddleware');
    const { attachTenant } = require('./middlewares/tenantContext');
    v1.use(optionalAuth);
    v1.use(attachTenant);
    // CRIT-05 — enforce mustChangePassword server-side. Runs after
    // optionalAuth so req.user is available, before any controller.
    v1.use(requirePasswordCurrent);
    // Plan gate for the role-specific staff apps: chefs need the
    // kitchenDisplay module, waiters / captains need waiterDashboard.
    // Auth endpoints stay open (see middlewares/featureGate.js).
    v1.use(require('./middlewares/featureGate').staffAppGate);

    v1.use('/public', require('./routes/publicRoute'));   // Unauthenticated landing-page endpoints
    v1.use('/auth', require('./routes/authRoute'));
    v1.use('/menu', require('./routes/menuRoute'));
    v1.use('/categories', require('./routes/categoryRoute'));
    v1.use('/combos', require('./routes/comboRoute'));
    v1.use('/upload', require('./routes/uploadRoute'));
    v1.use('/areas', require('./routes/areaRoute'));
    v1.use('/tables', require('./routes/tableRoute'));
    v1.use('/captain', require('./routes/captainRoute'));   // Captain floor-overview / workload / escalation
    v1.use('/reservations', require('./routes/reservationRoute'));
    v1.use('/orders', require('./routes/orderRoute'));
    v1.use('/wallet', require('./routes/walletRoute'));
    v1.use('/halls', require('./routes/hallRoute'));
    v1.use('/booking-info', require('./routes/bookingInfoRoute'));
    v1.use('/decoration-packages', require('./routes/decorationPackageRoute'));
    v1.use('/staff', require('./routes/staffRoute'));
    v1.use('/tips', require('./routes/tipRoute'));
    v1.use('/staff-wallet', require('./routes/staffWalletRoute'));
    v1.use('/settings', require('./routes/settingsRoute'));
    v1.use('/print', require('./routes/printRoute'));          // Thermal printers: agent key, test page, bill
    v1.use('/telemetry', require('./routes/telemetryRoute'));
    v1.use('/notifications', require('./routes/notificationRoute'));
    v1.use('/requests', require('./routes/requestRoute'));
    v1.use('/promotions', require('./routes/promotionRoute'));
    v1.use('/crm', require('./routes/crmRoute'));
    v1.use('/invoices', require('./routes/invoiceRoute'));
    v1.use('/analytics', require('./routes/analyticsRoute'));
    v1.use('/advance-booking', require('./routes/advanceBookingRoute'));
    v1.use('/payments', require('./routes/paymentRoute'));
    v1.use('/razorpay', require('./routes/razorpayRoute'));
    v1.use('/refund-requests', require('./routes/refundRequestRoute'));
    v1.use('/inventory', require('./routes/inventoryRoute'));
    v1.use('/suppliers', require('./routes/supplierRoute'));        // Vendor master (10.3.2)
    v1.use('/purchase-orders', require('./routes/purchaseRoute'));  // PO + GRN + payments (10.4, 10.9)
    v1.use('/production', require('./routes/productionRoute'));     // Batch cooking (10.6.2)
    v1.use('/shifts', require('./routes/shiftRoute'));
    v1.use('/campaigns', require('./routes/campaignRoute'));
    // Aggregated first-paint bundle for admin dashboards — single round trip
    // in place of 5 parallel calls (tables, areas, reservations, staff,
    // settings). See controllers/adminBootstrapController.js.
    v1.use('/admin/bootstrap', require('./routes/adminBootstrapRoute'));
    // Phase 5 step 4 — tenant self-service billing (view + upgrade plan).
    v1.use('/tenant/billing', require('./routes/tenantBillingRoute'));
    // Phase 7.1 — tenant data export (GDPR compliance).
    v1.use('/tenant/export', require('./routes/tenantExportRoute'));
    // Phase 6 step 1 — branches (multi-location CRUD, gated by multiBranch feature).
    v1.use('/branches', require('./routes/branchRoute'));
    v1.use('/superadmin', require('./routes/superadminRoute'));

    app.use('/api/v1', v1);

    // CRIT-29 — the legacy un-versioned /api mount has been removed. Any
    // client that hasn't migrated to /api/v1 gets a clear 410 Gone so the
    // failure is visible rather than silently breaking future /api/v2 work.
    //
    // The handler distinguishes two cases by inspecting `req.path` (which
    // is relative to the '/api' mount, so '/api/v1/foo' arrives as '/v1/foo'):
    //
    //   /api/vN/anything-unmatched → 404 ROUTE_NOT_FOUND
    //     The request DID hit a versioned router but no route inside it
    //     matched. Returning 410 here was actively misleading because the
    //     caller was already using /api/v1; the "use /api/v1" message
    //     pointed them at a URL they were already on.
    //
    //   /api  or  /api/some-other-path  → 410 GONE
    //     Legacy unversioned clients. The retire message is correct and
    //     actionable for them.
    app.use('/api', (req, res) => {
        if (/^\/v\d+(\/|$)/.test(req.path)) {
            return res.status(404).json({
                success: false,
                code: 'ROUTE_NOT_FOUND',
                message: `No route matched ${req.method} ${req.originalUrl}.`,
            });
        }
        return res.status(410).json({
            success: false,
            code: 'GONE',
            message: 'The unversioned /api endpoint has been retired. Please use /api/v1.',
        });
    });

    // Phase 3 hardening — install the pre('save') tenant assertion hook on
    // every tenant-scoped model. Must run AFTER every route has been
    // required (that's when models are registered via their controllers).
    // The hook only warns — it never rejects — so it can't break in-flight
    // traffic. See utils/tenantAssertions.js for the soak-window exit plan.
    require('./utils/tenantAssertions').installTenantAssertions();

    // ─── Basic Route ─────────────────────────────────────────────────────────────
    app.get('/', (req, res) => {
        res.send('Cafe Management Server is running');
    });

    // ─── Health Check with DB Status ─────────────────────────────────────────────
    app.get('/health', (req, res) => {
        const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
        res.json({
            status: 'ok',
            db: dbState[mongoose.connection.readyState],
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    // ─── #35 — liveness / readiness probes for load balancers & orchestrators ───
    // /healthz: the process is up and the event loop answers (never touches
    //           the DB — a Mongo blip must not get the pod killed).
    // /readyz:  send traffic here? 200 only when Mongo is connected and the
    //           process is not draining for shutdown.
    app.get('/healthz', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ status: 'ok', uptime: process.uptime() });
    });
    app.get('/readyz', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const mongoReady = mongoose.connection.readyState === 1;
        const shuttingDown = !!isShuttingDown();
        const ready = mongoReady && !shuttingDown;
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not-ready',
            mongo: mongoReady ? 'connected' : 'not-connected',
            shuttingDown,
            socketAdapter: require('./utils/socket').isMultiInstance() ? 'redis' : 'in-memory',
        });
    });

    // ─── Sentry Error Handler (must be before global error handler) ──────────────
    if (process.env.SENTRY_DSN) {
        Sentry.setupExpressErrorHandler(app);
    }

    // ─── Global Error Handler ────────────────────────────────────────────────────
    // Honours the status of well-known client errors (malformed JSON, body
    // too large, CORS rejection) instead of turning them into 500s. 5xx
    // responses are always generic for clients; details go to the log (and
    // to the response only outside production).
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        // multer limit errors (file too large, unexpected field, too many
        // files) are the uploader's fault: answer 400 with a usable
        // message instead of the generic 500. fileFilter rejections in
        // middlewares/csvUpload.js / uploadMiddleware.js set status 400
        // themselves.
        if (err && err.name === 'MulterError') {
            const multerMessages = {
                LIMIT_FILE_SIZE: 'File is too large',
                LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
                LIMIT_FILE_COUNT: 'Too many files',
                LIMIT_PART_COUNT: 'Too many form parts',
            };
            err.status = 400;
            err.expose = true;
            err.message = multerMessages[err.code] || err.message || 'Invalid upload';
        }
        let status = Number(err?.status || err?.statusCode) || 500;
        if (status < 400 || status > 599) status = 500;

        if (status >= 500) {
            logger.error('SERVER ERROR: ' + (err?.message || err), {
                stack: err?.stack,
                method: req.method,
                path: req.originalUrl,
            });
            const body = { success: false, message: 'Something went wrong on the server' };
            if (!isProduction && err?.message) body.error = err.message;
            return res.status(status).json(body);
        }

        let message = 'Bad request';
        if (err?.type === 'entity.parse.failed') message = 'Malformed JSON in request body';
        else if (err?.type === 'entity.too.large') message = 'Request body is too large';
        else if (err?.expose && err?.message) message = err.message;
        else if (status === 403) message = 'Forbidden';
        else if (status === 404) message = 'Not found';
        logger.warn('CLIENT ERROR: ' + (err?.message || err), { status, method: req.method, path: req.originalUrl });
        return res.status(status).json({ success: false, message });
    });

    return { app, allowedOrigins, isOriginAllowed };
}

module.exports = { createApp };
