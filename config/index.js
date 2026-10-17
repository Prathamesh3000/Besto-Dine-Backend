/**
 * config/index.js — single, validated view of the process environment.
 *
 * Reads process.env ONCE (after loading Backend/.env), coerces each
 * variable to its type with a documented default, and exports a frozen
 * object. No new dependencies: the validator below is ~40 lines.
 *
 *   const config = require('../config');
 *   config.jwt.secret, config.razorpay.keyId, config.isProduction, ...
 *
 * `assertProductionConfig()` is exported for server.js to call at boot.
 * It throws (listing every problem at once) when NODE_ENV=production and
 * a required value is missing or still a placeholder from .env.example.
 *
 * See config/README.md for the migration path off direct process.env reads.
 */
const path = require('path');

// Load Backend/.env regardless of the cwd. dotenv never overrides values
// already present in process.env, so calling it again elsewhere is harmless.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;

// ─── Tiny typed readers ─────────────────────────────────────────────
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function str(name, def = '') {
    return isBlank(env[name]) ? def : String(env[name]).trim();
}

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
    if (isBlank(env[name])) return def;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${name} must be an integer in [${min}, ${max}] (got "${env[name]}")`);
        return def;
    }
    return n;
}

function bool(name, def = false) {
    if (isBlank(env[name])) return def;
    const v = String(env[name]).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    problems.push(`${name} must be a boolean (true/false) (got "${env[name]}")`);
    return def;
}

function list(name, def = []) {
    if (isBlank(env[name])) return def;
    return String(env[name]).split(',').map((s) => s.trim()).filter(Boolean);
}

function oneOf(name, allowed, def = '') {
    const v = str(name, def).toLowerCase();
    if (v && !allowed.includes(v)) {
        problems.push(`${name} must be one of ${allowed.join(' | ')} (got "${env[name]}")`);
        return def;
    }
    return v;
}

// Type errors found while reading. Reported by assertProductionConfig()
// (fatal in production) and available as config.problems in dev.
const problems = [];

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

const deepFreeze = (o) => {
    Object.values(o).forEach((v) => {
        if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    });
    return Object.freeze(o);
};

const config = {
    nodeEnv,
    isProduction,
    isTest: nodeEnv === 'test',
    port: int('PORT', 5000, { min: 1, max: 65535 }),
    logLevel: oneOf('LOG_LEVEL', ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'], 'info'),

    mongoUrl: str('MONGO_URL'),

    network: {
        allowedOrigins: list('ALLOWED_ORIGINS', ['http://localhost:5173']),
        // '' = use the default (on in dev, off in prod) — server.js decides.
        corsAllowLan: str('CORS_ALLOW_LAN'),
        // Raw string; server.js parses hop counts / address lists.
        trustProxy: str('TRUST_PROXY'),
        redisUrl: str('REDIS_URL'),
    },

    jwt: {
        secret: str('JWT_SECRET'),
        accessTokenTtl: str('ACCESS_TOKEN_TTL', '30m'),
        superadminAccessTokenTtl: str('SUPERADMIN_ACCESS_TOKEN_TTL', '15m'),
        refreshTtlHoursStaff: int('REFRESH_TTL_HOURS_STAFF', 168, { min: 1 }),
        // Legacy — no longer used: the customer login now ends a fixed
        // SESSION_MAX_HOURS_CUSTOMER (default 1) after sign-in; see
        // authController.refreshAbsoluteMs. Kept so old .env files validate.
        refreshTtlHoursCustomer: int('REFRESH_TTL_HOURS_CUSTOMER', 24, { min: 1 }),
        customerIdleTimeoutMinutes: int('CUSTOMER_IDLE_TIMEOUT_MINUTES', 60, { min: 1 }),
        refreshTtlHoursSuperadmin: int('REFRESH_TTL_HOURS_SUPERADMIN', 12, { min: 1 }),
        scanTokenTtl: str('SCAN_TOKEN_TTL', '4h'),
        useCookieAuth: bool('USE_COOKIE_AUTH', false),
    },

    otp: {
        secret: str('OTP_SECRET') || str('JWT_SECRET'),
        dailySendCap: int('OTP_DAILY_SEND_CAP', 10, { min: 1 }),
        smsProvider: oneOf('SMS_PROVIDER', ['msg91', 'twilio'], ''),
        msg91AuthKey: str('MSG91_AUTH_KEY'),
        msg91TemplateId: str('MSG91_TEMPLATE_ID'),
        twilioAccountSid: str('TWILIO_ACCOUNT_SID'),
        twilioAuthToken: str('TWILIO_AUTH_TOKEN'),
        twilioPhoneNumber: str('TWILIO_PHONE_NUMBER'),
    },

    sentryDsn: str('SENTRY_DSN'),

    razorpay: {
        keyId: str('RAZORPAY_KEY_ID'),
        keySecret: str('RAZORPAY_KEY_SECRET'),
        webhookSecret: str('RAZORPAY_WEBHOOK_SECRET'),
    },

    cloudinary: {
        cloudName: str('CLOUDINARY_CLOUD_NAME'),
        apiKey: str('CLOUDINARY_API_KEY'),
        apiSecret: str('CLOUDINARY_API_SECRET'),
    },

    images: {
        hostAllowlist: list('IMAGE_HOST_ALLOWLIST'),
        googleCseId: str('GOOGLE_CSE_ID'),
        googleCseKey: str('GOOGLE_CSE_KEY'),
    },

    google: {
        clientIds: list('GOOGLE_CLIENT_ID'),
    },

    frontendUrl: str('FRONTEND_URL', 'http://localhost:5173').replace(/\/+$/, ''),
    publicBaseUrl: str('PUBLIC_BASE_URL'),
    backendUrl: str('BACKEND_URL'),

    email: {
        provider: oneOf('EMAIL_PROVIDER', ['smtp', 'sendgrid', 'resend', 'mailgun'], ''),
        from: str('EMAIL_FROM', 'BestoDine <no-reply@example.com>'),
        sendgridApiKey: str('SENDGRID_API_KEY'),
        resendApiKey: str('RESEND_API_KEY'),
        mailgunApiKey: str('MAILGUN_API_KEY'),
        mailgunDomain: str('MAILGUN_DOMAIN'),
        smtp: {
            host: str('SMTP_HOST'),
            port: int('SMTP_PORT', 587, { min: 1, max: 65535 }),
            user: str('SMTP_USER'),
            pass: str('SMTP_PASS'),
            from: str('SMTP_FROM'),
            // '' = derive from port (465 → true) — utils/email.js decides.
            secure: str('SMTP_SECURE'),
        },
    },

    // Background jobs. `null` = use the default hard-coded in the job module.
    jobs: {
        emptyOrderGraceMinutes: int('EMPTY_ORDER_GRACE_MINUTES', 30, { min: 1 }),
        emptyOrderSweepMinutes: int('EMPTY_ORDER_SWEEP_MINUTES', 15, { min: 1 }),
        emptyOrderSweepDisabled: bool('EMPTY_ORDER_SWEEP_DISABLED', false),
        staleOrderStuckMinutes: int('STALE_ORDER_STUCK_MINUTES', 360, { min: 1 }),
        staleOrderSweepHours: int('STALE_ORDER_SWEEP_HOURS', 1, { min: 1 }),
        staleOrderSweepDisabled: bool('STALE_ORDER_SWEEP_DISABLED', false),
        shiftAutocloseHours: int('SHIFT_AUTOCLOSE_HOURS', null, { min: 1 }),
        shiftAutocloseSweepHours: int('SHIFT_AUTOCLOSE_SWEEP_HOURS', null, { min: 1 }),
        shiftAutocloseDisabled: bool('SHIFT_AUTOCLOSE_DISABLED', false),
        bookingReminderScanHours: int('BOOKING_REMINDER_SCAN_HOURS', null, { min: 1 }),
        bookingReminderWindowHours: int('BOOKING_REMINDER_WINDOW_HOURS', null, { min: 1 }),
        bookingReminderDisabled: bool('BOOKING_REMINDER_DISABLED', false),
        menuRestoreScanMinutes: int('MENU_RESTORE_SCAN_MINUTES', null, { min: 1 }),
        menuRestoreDisabled: bool('MENU_RESTORE_DISABLED', false),
        categoryImageHealHours: int('CATEGORY_IMAGE_HEAL_HOURS', null, { min: 1 }),
        categoryImageHealDisabled: bool('CATEGORY_IMAGE_HEAL_DISABLED', false),
        menuImageHealHours: int('MENU_IMAGE_HEAL_HOURS', null, { min: 1 }),
        menuImageHealDisabled: bool('MENU_IMAGE_HEAL_DISABLED', false),
        dormancyScanHours: int('DORMANCY_SCAN_HOURS', null, { min: 1 }),
        dormancyScanDisabled: bool('DORMANCY_SCAN_DISABLED', false),
    },

    timezone: {
        app: str('APP_TIMEZONE', 'Asia/Kolkata'),
        analytics: str('ANALYTICS_TIMEZONE') || str('APP_TIMEZONE', 'Asia/Kolkata'),
    },

    platform: {
        name: str('PLATFORM_NAME', 'BestoDine'),
        email: str('PLATFORM_EMAIL'),
        phone: str('PLATFORM_PHONE'),
        website: str('PLATFORM_WEBSITE'),
        gstin: str('PLATFORM_GSTIN'),
        addressLine1: str('PLATFORM_ADDRESS_LINE1'),
        addressLine2: str('PLATFORM_ADDRESS_LINE2'),
        city: str('PLATFORM_CITY'),
        country: str('PLATFORM_COUNTRY'),
        superadminAlertEmails: list('SUPERADMIN_ALERT_EMAILS'),
        marketingDeployHookUrl: str('MARKETING_DEPLOY_HOOK_URL'),
    },

    problems,
};

// ─── Production requirements ────────────────────────────────────────
// Values copied verbatim from .env.example are treated as missing.
const PLACEHOLDER = /^(change-me|your-|rzp_test_x+$)|example\.com/i;

const PRODUCTION_REQUIRED = [
    ['MONGO_URL', config.mongoUrl],
    ['JWT_SECRET', config.jwt.secret],
    ['RAZORPAY_KEY_ID', config.razorpay.keyId],
    ['RAZORPAY_KEY_SECRET', config.razorpay.keySecret],
    ['RAZORPAY_WEBHOOK_SECRET', config.razorpay.webhookSecret],
    ['FRONTEND_URL', str('FRONTEND_URL')],
    ['ALLOWED_ORIGINS', str('ALLOWED_ORIGINS')],
];

/**
 * Collect every production misconfiguration. Pure — no side effects.
 * @returns {string[]} human-readable problems (empty = OK)
 */
function productionConfigProblems() {
    const out = [...problems];
    for (const [name, value] of PRODUCTION_REQUIRED) {
        if (isBlank(value)) out.push(`${name} is required in production`);
        else if (PLACEHOLDER.test(value)) out.push(`${name} still holds the .env.example placeholder`);
    }
    if (config.jwt.secret && config.jwt.secret.length < 32) {
        out.push('JWT_SECRET must be at least 32 characters in production');
    }
    if (/localhost|127\.0\.0\.1/.test(config.frontendUrl)) {
        out.push('FRONTEND_URL points at localhost — password-reset links would be unusable');
    }
    return out;
}

/**
 * Boot-time guard for server.js. No-op outside production.
 * Throws an Error whose message lists every problem, so the operator can
 * fix them all in one pass instead of one restart per missing variable.
 */
function assertProductionConfig() {
    if (!isProduction) return;
    const issues = productionConfigProblems();
    if (issues.length) {
        throw new Error(`Invalid production configuration:\n  - ${issues.join('\n  - ')}`);
    }
}

config.assertProductionConfig = assertProductionConfig;
config.productionConfigProblems = productionConfigProblems;

module.exports = deepFreeze(config);
