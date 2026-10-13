/**
 * Per-IP limiters for the /auth routes (LOGIN_THROTTLING_PROPOSAL.md, part b).
 *
 * A restaurant's whole staff shares ONE public IP, so a per-IP budget
 * that counts successes locks a venue out on a busy morning. Rules:
 *
 *   - Only FAILED requests count (`skipSuccessfulRequests`) — a correct
 *     login never consumes budget.
 *   - /auth/login is keyed on `ip + sha256(lowercased email)`, so brute
 *     force against one account from one IP is contained (300 fails /
 *     15 min) without one colleague's typos spending another's budget.
 *     The per-account lock (utils/loginAttempts.js, 10 fails) is the
 *     real stop; this is the backstop.
 *   - A plain per-IP backstop on /auth/login (1000 fails / 15 min)
 *     bounds email spraying from one address — far above anything a
 *     venue produces, so it never fires on legitimate traffic.
 *   - register / send-otp / verify-otp / change-password stay on a
 *     plain per-IP limiter (50 fails / 15 min).
 *
 * `createAuthLimiters()` is called once from app.js. The integration
 * suites mock utils/rateLimitStore so every limiter is pass-through
 * there; __tests__/authLimiters.test.js drives the real store.
 */
'use strict';

const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const { makeLimiter } = require('./rateLimitStore');

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_EMAIL_LIMIT = 300;   // failed logins per (ip, email) / 15 min
const LOGIN_IP_LIMIT = 1000;        // failed logins per ip (any email) / 15 min
const AUTH_IP_LIMIT = 50;           // failed register / otp / change-password per ip / 15 min
const FORGOT_IP_LIMIT = 30;         // forgot-password requests per ip / 15 min (always 200 → all count)

/** sha256 of the normalised email (hex). Never the email itself. */
function emailHash(email) {
    const e = String(email ?? '').trim().toLowerCase();
    return crypto.createHash('sha256').update(e).digest('hex');
}

/** `ip:sha256(email)` — IPv6 collapses to its /56 like every other limiter. */
function loginLimitKey(req) {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email : '';
    return `${ipKeyGenerator(req.ip)}:${emailHash(email)}`;
}

const MESSAGE = { success: false, message: 'Too many attempts. Try again in 15 minutes.' };

function createAuthLimiters() {
    const loginLimiter = makeLimiter({
        name: 'auth-login',
        windowMs: WINDOW_MS,
        max: LOGIN_IP_EMAIL_LIMIT,
        skipSuccessfulRequests: true,
        keyGenerator: loginLimitKey,
        message: MESSAGE,
        standardHeaders: true,
        legacyHeaders: false,
    });
    const loginIpBackstop = makeLimiter({
        name: 'auth-login-ip',
        windowMs: WINDOW_MS,
        max: LOGIN_IP_LIMIT,
        skipSuccessfulRequests: true,
        message: MESSAGE,
        standardHeaders: true,
        legacyHeaders: false,
    });
    const authLimiter = makeLimiter({
        name: 'auth',
        windowMs: WINDOW_MS,
        max: AUTH_IP_LIMIT,
        skipSuccessfulRequests: true,
        message: MESSAGE,
        standardHeaders: true,
        legacyHeaders: false,
    });
    return { loginLimiter, loginIpBackstop, authLimiter };
}

module.exports = {
    createAuthLimiters,
    loginLimitKey,
    emailHash,
    WINDOW_MS,
    LOGIN_IP_EMAIL_LIMIT,
    LOGIN_IP_LIMIT,
    AUTH_IP_LIMIT,
    FORGOT_IP_LIMIT,
};
