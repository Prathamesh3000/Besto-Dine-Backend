/**
 * Boot-time configuration guards (checklist 10.13-config):
 *
 *   config/index.js        typed env readers, development defaults, the
 *                          production requirement list (missing / placeholder /
 *                          weak secrets), assertProductionConfig() fail-fast,
 *                          deep-frozen export
 *   utils/razorpayMock.js  RAZORPAY_MOCK is refused in production
 *                          (assertMockSafe) and never activates there
 *
 * config/index.js reads process.env ONCE at require-time, so every case
 * loads a fresh copy inside jest.isolateModules with a controlled env.
 * dotenv is mocked so Backend/.env never leaks into the assertions.
 */
jest.mock('dotenv', () => ({ config: jest.fn(() => ({ parsed: {} })) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };

// Every variable config/index.js reads — cleared before each load.
const CONFIG_VARS = [
    'NODE_ENV', 'PORT', 'LOG_LEVEL', 'MONGO_URL', 'ALLOWED_ORIGINS', 'CORS_ALLOW_LAN', 'TRUST_PROXY', 'REDIS_URL',
    'JWT_SECRET', 'ACCESS_TOKEN_TTL', 'SUPERADMIN_ACCESS_TOKEN_TTL', 'REFRESH_TTL_HOURS_STAFF', 'REFRESH_TTL_HOURS_CUSTOMER',
    'CUSTOMER_IDLE_TIMEOUT_MINUTES', 'REFRESH_TTL_HOURS_SUPERADMIN', 'SCAN_TOKEN_TTL', 'USE_COOKIE_AUTH',
    'OTP_SECRET', 'OTP_DAILY_SEND_CAP', 'SMS_PROVIDER', 'SENTRY_DSN',
    'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_MOCK',
    'FRONTEND_URL', 'PUBLIC_BASE_URL', 'BACKEND_URL', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'SMTP_PORT',
    'EMPTY_ORDER_SWEEP_DISABLED', 'SHIFT_AUTOCLOSE_HOURS', 'APP_TIMEZONE', 'ANALYTICS_TIMEZONE', 'GOOGLE_CLIENT_ID',
];

const STRONG = 'x'.repeat(48);
const GOOD_PROD = {
    NODE_ENV: 'production',
    MONGO_URL: 'mongodb+srv://u:p@cluster0.mongo.net/bestodine',
    JWT_SECRET: STRONG,
    RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456',
    RAZORPAY_KEY_SECRET: 'live-secret-abcdef',
    RAZORPAY_WEBHOOK_SECRET: 'whsec-abcdef',
    FRONTEND_URL: 'https://app.bestodine.in',
    ALLOWED_ORIGINS: 'https://app.bestodine.in,https://bestodine.in',
};

function loadConfig(env = {}) {
    for (const k of CONFIG_VARS) delete process.env[k];
    Object.assign(process.env, env);
    let cfg;
    jest.isolateModules(() => { cfg = require('../config'); });
    return cfg;
}

function loadMock(env = {}) {
    delete process.env.NODE_ENV;
    delete process.env.RAZORPAY_MOCK;
    Object.assign(process.env, env);
    let mod;
    jest.isolateModules(() => { mod = require('../utils/razorpayMock'); });
    return mod;
}

afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
});

// ── development defaults ────────────────────────────────────────────

describe('config defaults (development)', () => {
    test('empty env → documented defaults, no problems, assert is a no-op', () => {
        const c = loadConfig({});
        expect(c.nodeEnv).toBe('development');
        expect(c.isProduction).toBe(false);
        expect(c.isTest).toBe(false);
        expect(c.port).toBe(5000);
        expect(c.logLevel).toBe('info');
        expect(c.network.allowedOrigins).toEqual(['http://localhost:5173']);
        expect(c.jwt).toEqual(expect.objectContaining({
            secret: '', accessTokenTtl: '30m', superadminAccessTokenTtl: '15m',
            refreshTtlHoursStaff: 168, refreshTtlHoursCustomer: 24, customerIdleTimeoutMinutes: 60,
            refreshTtlHoursSuperadmin: 12, scanTokenTtl: '4h', useCookieAuth: false,
        }));
        expect(c.frontendUrl).toBe('http://localhost:5173');
        expect(c.email.smtp.port).toBe(587);
        expect(c.jobs.shiftAutocloseHours).toBeNull();
        expect(c.timezone).toEqual({ app: 'Asia/Kolkata', analytics: 'Asia/Kolkata' });
        expect(c.problems).toEqual([]);
        expect(() => c.assertProductionConfig()).not.toThrow();
    });

    test('dev with weak/missing secrets still boots (guard is production-only)', () => {
        const c = loadConfig({ NODE_ENV: 'development', JWT_SECRET: 'short' });
        expect(() => c.assertProductionConfig()).not.toThrow();
        // …but productionConfigProblems() would still report them.
        expect(c.productionConfigProblems()).toEqual(expect.arrayContaining([
            'JWT_SECRET must be at least 32 characters in production',
            'MONGO_URL is required in production',
        ]));
    });

    test('NODE_ENV=test sets isTest', () => {
        expect(loadConfig({ NODE_ENV: 'test' }).isTest).toBe(true);
    });

    test('OTP secret falls back to JWT secret; analytics TZ falls back to app TZ', () => {
        const c = loadConfig({ JWT_SECRET: 'jwt-s', APP_TIMEZONE: 'Europe/London' });
        expect(c.otp.secret).toBe('jwt-s');
        expect(c.timezone.analytics).toBe('Europe/London');
        expect(loadConfig({ JWT_SECRET: 'a', OTP_SECRET: 'b' }).otp.secret).toBe('b');
    });

    test('strings are trimmed; FRONTEND_URL trailing slashes stripped; lists split + trimmed', () => {
        const c = loadConfig({ JWT_SECRET: '  s  ', FRONTEND_URL: 'https://x.test///', ALLOWED_ORIGINS: ' a , ,b ,', GOOGLE_CLIENT_ID: 'id1,id2' });
        expect(c.jwt.secret).toBe('s');
        expect(c.frontendUrl).toBe('https://x.test');
        expect(c.network.allowedOrigins).toEqual(['a', 'b']);
        expect(c.google.clientIds).toEqual(['id1', 'id2']);
    });

    test('whitespace-only values count as blank', () => {
        expect(loadConfig({ PORT: '   ', JWT_SECRET: '   ' })).toEqual(expect.objectContaining({ port: 5000 }));
    });
});

// ── typed readers ───────────────────────────────────────────────────

describe('typed readers record problems instead of throwing', () => {
    test.each([
        ['PORT', '0', /PORT must be an integer in \[1, 65535\]/],
        ['PORT', '70000', /PORT must be an integer/],
        ['PORT', '80.5', /PORT must be an integer/],
        ['PORT', 'abc', /PORT must be an integer/],
        ['REFRESH_TTL_HOURS_STAFF', '0', /REFRESH_TTL_HOURS_STAFF/],
        ['USE_COOKIE_AUTH', 'maybe', /USE_COOKIE_AUTH must be a boolean/],
        ['LOG_LEVEL', 'loud', /LOG_LEVEL must be one of/],
        ['SMS_PROVIDER', 'carrier-pigeon', /SMS_PROVIDER must be one of msg91 \| twilio/],
        ['EMAIL_PROVIDER', 'ses', /EMAIL_PROVIDER must be one of/],
    ])('%s=%p → problem, default kept', (name, value, re) => {
        const c = loadConfig({ [name]: value });
        expect(c.problems.some((p) => re.test(p))).toBe(true);
    });

    test('invalid PORT falls back to default; a valid one is coerced to a number', () => {
        expect(loadConfig({ PORT: 'abc' }).port).toBe(5000);
        expect(loadConfig({ PORT: '8080', SHIFT_AUTOCLOSE_HOURS: '12' })).toEqual(expect.objectContaining({ port: 8080 }));
        expect(loadConfig({ SHIFT_AUTOCLOSE_HOURS: '12' }).jobs.shiftAutocloseHours).toBe(12);
    });

    test.each([
        ['true', true], ['1', true], ['YES', true], ['on', true],
        ['false', false], ['0', false], ['No', false], ['off', false],
    ])('bool %p → %p', (v, expected) => {
        expect(loadConfig({ USE_COOKIE_AUTH: v }).jwt.useCookieAuth).toBe(expected);
    });

    test('oneOf is case-insensitive', () => {
        expect(loadConfig({ LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
    });

    test('type problems are fatal in production even when everything else is fine', () => {
        const c = loadConfig({ ...GOOD_PROD, PORT: 'eighty' });
        expect(() => c.assertProductionConfig()).toThrow(/PORT must be an integer/);
    });
});

// ── production requirements ─────────────────────────────────────────

describe('assertProductionConfig (production)', () => {
    test('a complete, strong production config boots', () => {
        const c = loadConfig(GOOD_PROD);
        expect(c.isProduction).toBe(true);
        expect(c.productionConfigProblems()).toEqual([]);
        expect(() => c.assertProductionConfig()).not.toThrow();
    });

    test.each([
        'MONGO_URL', 'JWT_SECRET', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET', 'FRONTEND_URL', 'ALLOWED_ORIGINS',
    ])('missing %s → refused', (name) => {
        const env = { ...GOOD_PROD };
        delete env[name];
        const c = loadConfig(env);
        expect(() => c.assertProductionConfig()).toThrow(new RegExp(`${name} is required in production`));
    });

    test.each([
        ['JWT_SECRET', 'change-me-to-a-long-random-string-please-xxxx'],
        ['RAZORPAY_KEY_ID', 'rzp_test_xxxxxxxx'],
        ['RAZORPAY_KEY_SECRET', 'your-razorpay-secret'],
        ['RAZORPAY_WEBHOOK_SECRET', 'Change-Me'],
        ['FRONTEND_URL', 'https://app.example.com'],
        ['ALLOWED_ORIGINS', 'https://example.com'],
        ['MONGO_URL', 'your-mongo-url'],
    ])('%s holding the .env.example placeholder %p → refused', (name, value) => {
        const c = loadConfig({ ...GOOD_PROD, [name]: value });
        expect(() => c.assertProductionConfig()).toThrow(new RegExp(`${name} still holds the .env.example placeholder`));
    });

    test.each([
        ['31 chars', 'a'.repeat(31), true],
        ['32 chars', 'a'.repeat(32), false],
    ])('JWT_SECRET %s → refused: %p', (_l, secret, refused) => {
        const c = loadConfig({ ...GOOD_PROD, JWT_SECRET: secret });
        const issues = c.productionConfigProblems();
        expect(issues.includes('JWT_SECRET must be at least 32 characters in production')).toBe(refused);
    });

    test.each([
        'http://localhost:5173',
        'http://127.0.0.1:3000',
    ])('FRONTEND_URL=%s → refused (reset links unusable)', (url) => {
        const c = loadConfig({ ...GOOD_PROD, FRONTEND_URL: url });
        expect(() => c.assertProductionConfig()).toThrow(/FRONTEND_URL points at localhost/);
    });

    test('every problem is listed in ONE error (not one per restart)', () => {
        const c = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short', PORT: 'x' });
        let msg = '';
        try { c.assertProductionConfig(); } catch (e) { msg = e.message; }
        expect(msg).toMatch(/^Invalid production configuration:/);
        for (const needle of ['PORT must be', 'MONGO_URL is required', 'JWT_SECRET must be at least 32', 'RAZORPAY_KEY_ID is required', 'FRONTEND_URL is required', 'ALLOWED_ORIGINS is required']) {
            expect(msg).toContain(needle);
        }
    });

    test('FRONTEND_URL is checked as set, not via the localhost default', () => {
        // config.frontendUrl defaults to localhost; with FRONTEND_URL unset
        // both "required" and "points at localhost" are reported.
        const env = { ...GOOD_PROD };
        delete env.FRONTEND_URL;
        const issues = loadConfig(env).productionConfigProblems();
        expect(issues).toEqual(expect.arrayContaining([
            'FRONTEND_URL is required in production',
            'FRONTEND_URL points at localhost — password-reset links would be unusable',
        ]));
    });

    test('a weak but non-placeholder webhook secret is NOT checked for length (only JWT is)', () => {
        // Characterisation: RAZORPAY_WEBHOOK_SECRET / KEY_SECRET = "a" pass the guard.
        const c = loadConfig({ ...GOOD_PROD, RAZORPAY_WEBHOOK_SECRET: 'a', RAZORPAY_KEY_SECRET: 'b' });
        expect(c.productionConfigProblems()).toEqual([]);
    });

    test('.env.example localhost MONGO_URL / ALLOWED_ORIGINS and real rzp_test_ keys are NOT refused', () => {
        // Characterisation (risk): only FRONTEND_URL is checked for localhost
        // and only the literal rzp_test_xxxx placeholder is refused, so a
        // production boot with Razorpay TEST-mode keys (fake money) passes.
        const c = loadConfig({
            ...GOOD_PROD,
            MONGO_URL: 'mongodb://localhost:27017/bestodine',
            ALLOWED_ORIGINS: 'http://localhost:5173',
            RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456',
        });
        expect(c.productionConfigProblems()).toEqual([]);
    });

    test('OTP_SECRET is not required in production (silently reuses JWT_SECRET)', () => {
        const c = loadConfig(GOOD_PROD);
        expect(c.otp.secret).toBe(STRONG);
        expect(c.productionConfigProblems()).toEqual([]);
    });

    test('RAZORPAY_MOCK=true is NOT part of productionConfigProblems — only razorpayMock.assertMockSafe catches it', () => {
        const c = loadConfig({ ...GOOD_PROD, RAZORPAY_MOCK: 'true' });
        expect(c.productionConfigProblems()).toEqual([]);
    });
});

describe('exported config is deep-frozen', () => {
    test('top-level and nested objects cannot be mutated', () => {
        'use strict';
        const c = loadConfig(GOOD_PROD);
        expect(Object.isFrozen(c)).toBe(true);
        expect(Object.isFrozen(c.jwt)).toBe(true);
        expect(Object.isFrozen(c.email.smtp)).toBe(true);
        expect(Object.isFrozen(c.network.allowedOrigins)).toBe(true);
        expect(() => { c.jwt.secret = 'pwned'; }).toThrow(TypeError);
        expect(c.jwt.secret).toBe(STRONG);
    });

    test('the problems list is frozen too (no late push from a reader)', () => {
        const c = loadConfig({ PORT: 'bad' });
        expect(Object.isFrozen(c.problems)).toBe(true);
    });
});

// ── razorpay mock guard ─────────────────────────────────────────────

describe('razorpayMock guards', () => {
    test.each([
        ['production + RAZORPAY_MOCK=true', { NODE_ENV: 'production', RAZORPAY_MOCK: 'true' }, true],
        ['production, flag off', { NODE_ENV: 'production' }, false],
        ['development + RAZORPAY_MOCK=true', { NODE_ENV: 'development', RAZORPAY_MOCK: 'true' }, false],
        ['test + RAZORPAY_MOCK=true', { NODE_ENV: 'test', RAZORPAY_MOCK: 'true' }, false],
    ])('assertMockSafe: %s → throws: %p', (_l, env, throws) => {
        const m = loadMock(env);
        if (throws) expect(() => m.assertMockSafe()).toThrow(/RAZORPAY_MOCK=true is set in production/);
        else expect(() => m.assertMockSafe()).not.toThrow();
    });

    test.each([
        [{ NODE_ENV: 'production', RAZORPAY_MOCK: 'true' }, false],
        [{ NODE_ENV: 'development', RAZORPAY_MOCK: 'true' }, true],
        [{ NODE_ENV: 'development', RAZORPAY_MOCK: 'TRUE' }, false],
        [{ NODE_ENV: 'development', RAZORPAY_MOCK: '1' }, false],
        [{ NODE_ENV: 'development' }, false],
        [{ RAZORPAY_MOCK: 'true' }, true],
    ])('isMockEnabled(%p) → %p', (env, expected) => {
        expect(loadMock(env).isMockEnabled()).toBe(expected);
    });

    test('flag variants other than exact "true" never trip the production guard either', () => {
        // 'TRUE' / '1' are ignored consistently by both isMockEnabled and assertMockSafe.
        const m = loadMock({ NODE_ENV: 'production', RAZORPAY_MOCK: 'TRUE' });
        expect(() => m.assertMockSafe()).not.toThrow();
        expect(m.isMockEnabled()).toBe(false);
    });

    test('NODE_ENV "Production" (wrong case) is NOT treated as production by either guard', () => {
        // Characterisation: both guards compare NODE_ENV === 'production'
        // exactly. A mis-cased NODE_ENV turns the mock ON and also skips
        // assertProductionConfig — see config tests below.
        const m = loadMock({ NODE_ENV: 'Production', RAZORPAY_MOCK: 'true' });
        expect(() => m.assertMockSafe()).not.toThrow();
        expect(m.isMockEnabled()).toBe(true);
        const c = loadConfig({ NODE_ENV: 'Production' });
        expect(c.isProduction).toBe(false);
        expect(() => c.assertProductionConfig()).not.toThrow();
    });

    test('shouldBypassSignature needs mock mode AND both mock-prefixed ids', () => {
        const on = loadMock({ NODE_ENV: 'development', RAZORPAY_MOCK: 'true' });
        expect(on.shouldBypassSignature('order_mock_1', 'pay_mock_1')).toBe(true);
        expect(on.shouldBypassSignature('order_real', 'pay_mock_1')).toBe(false);
        expect(on.shouldBypassSignature('order_mock_1', 'pay_real')).toBe(false);
        expect(on.shouldBypassSignature(undefined, null)).toBe(false);
        const prod = loadMock({ NODE_ENV: 'production', RAZORPAY_MOCK: 'true' });
        expect(prod.shouldBypassSignature('order_mock_1', 'pay_mock_1')).toBe(false);
    });

    test('mock order / payment shapes carry the _mock_ prefixes', () => {
        const m = loadMock({});
        const o = m.createMockOrder({ amount: 12345, receipt: 'r1' });
        expect(o).toEqual(expect.objectContaining({ amount: 12345, amount_due: 12345, currency: 'INR', status: 'created', mock: true, notes: {} }));
        expect(m.isMockOrderId(o.id)).toBe(true);
        const p = m.createMockPaymentResult(o.id);
        expect(p.razorpay_order_id).toBe(o.id);
        expect(m.isMockPaymentId(p.razorpay_payment_id)).toBe(true);
        expect(p.razorpay_signature).toBe('mock_signature_not_verified');
    });

    test('server.js wires both guards at boot', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
        expect(src).toMatch(/require\('\.\/utils\/razorpayMock'\)\.assertMockSafe\(\)/);
        expect(src).toMatch(/config\.assertProductionConfig\(\)/);
    });
});
