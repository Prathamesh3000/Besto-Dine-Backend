/**
 * Runs before every integration test file, BEFORE any app module loads.
 *
 * Safety contract: the app must never see the developer's real .env
 * values (production MONGO_URL, Razorpay / SMTP / Cloudinary keys, ...).
 * config/index.js calls dotenv, and dotenv never overrides a variable
 * that is already present in process.env — so every key found in
 * Backend/.env is pre-set here (to '' or to a test value) and dotenv then
 * becomes a no-op for all of them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const baseUri = process.env.INTEGRATION_MONGO_URI;
if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(baseUri)) {
    throw new Error(
        'INTEGRATION_MONGO_URI is missing or not an in-memory server URI. '
        + 'Run the integration suites with `npm run test:integration`.',
    );
}

// 1. Neutralise every key from the real .env file.
const envFile = path.join(__dirname, '..', '..', '..', '.env');
if (fs.existsSync(envFile)) {
    const parsed = dotenv.parse(fs.readFileSync(envFile));
    for (const key of Object.keys(parsed)) process.env[key] = '';
}
// Also blank anything that would reach a real external service even if
// it is set in the shell environment.
for (const key of [
    'REDIS_URL', 'SENTRY_DSN', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET', 'SMS_PROVIDER', 'MSG91_AUTH_KEY', 'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CSE_KEY', 'OTP_SECRET', 'TRUST_PROXY',
    'TENANT_SCOPE_PLUGIN', 'USE_COOKIE_AUTH',
]) {
    process.env[key] = '';
}

// 2. Test values.
// One database per test file on the shared in-memory replica set.
const dbName = `bd_it_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const u = new URL(baseUri);
u.pathname = `/${dbName}`;
process.env.MONGO_URL = u.toString();
process.env.INTEGRATION_DB_NAME = dbName;

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = 'integration-test-jwt-secret-0123456789abcdefghijklmnop';
process.env.RAZORPAY_KEY_ID = 'rzp_test_integration_dummy';
process.env.RAZORPAY_KEY_SECRET = 'integration_dummy_razorpay_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'integration_dummy_webhook_secret';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.FRONTEND_URL = 'http://localhost:5173';

/** Throws unless MONGO_URL is the in-memory server. Call before connecting. */
global.assertInMemoryMongo = function assertInMemoryMongo(uri = process.env.MONGO_URL) {
    const expectedHost = new URL(baseUri).host;
    let parsed;
    try { parsed = new URL(uri); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'mongodb:' || parsed.host !== expectedHost
        || !/^127\.0\.0\.1:\d+$/.test(parsed.host)) {
        throw new Error(`Refusing to connect: ${uri} is not the in-memory MongoDB (${expectedHost}).`);
    }
};
global.assertInMemoryMongo();
