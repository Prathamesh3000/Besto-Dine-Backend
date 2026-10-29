/**
 * Cookie-based web sessions (plan task 3A.4, decision D9).
 *
 * Everything here is behind USE_COOKIE_AUTH (default OFF). With the flag off
 * nothing in this module issues, reads or enforces anything, so bearer-token
 * clients (mobile-waiter, desktop shell, old web builds, scripts) are
 * unaffected either way: an Authorization header always wins over a cookie
 * and a header-authenticated request is exempt from CSRF.
 *
 * Cookies (one pair PER AUDIENCE, because the web app runs a platform
 * super-admin, a tenant-staff and a customer session side by side in one
 * browser — see Frontend/src/utils/authStorage.js):
 *
 *   bd_at_<aud>  access JWT          httpOnly  Path=/               Max-Age = absolute session cap left (JWT expiry is enforced server-side)
 *   bd_rt_<aud>  opaque refresh tok  httpOnly  Path=/api/v1/auth    Max-Age = absolute session cap left
 *   bd_csrf      signed CSRF token   NOT httpOnly  Path=/           Max-Age = absolute session cap left
 *
 * <aud> is platform | staff | customer, derived from the user's role exactly
 * like the frontend does. The access cookie is Path=/ (not /api) because the
 * socket.io handshake at /socket.io must carry it too.
 *
 * Which audience's cookie does a request use? The web client sends
 * `X-Auth-Audience: <aud>` (and `auth.audience` on the socket handshake).
 * Without that hint, a cookie is used only when exactly one audience has one.
 *
 * CSRF (cookie-authenticated, state-changing requests only):
 *   1. Origin (else Referer) must be in the CORS allowlist when present, and
 *   2. double-submit: `X-CSRF-Token` header must equal the `bd_csrf` cookie
 *      and carry a valid HMAC (so a cookie planted from a sibling subdomain
 *      is not accepted).
 */
const crypto = require('crypto');

const AUDIENCES = ['platform', 'staff', 'customer'];
const ACCESS_PREFIX = 'bd_at_';
const REFRESH_PREFIX = 'bd_rt_';
const CSRF_COOKIE = 'bd_csrf';
const CSRF_HEADER = 'x-csrf-token';
const AUDIENCE_HEADER = 'x-auth-audience';
const MODE_HEADER = 'x-auth-mode';
const LEGACY_COOKIE = 'bestodine_token';

function isEnabled() {
    const v = String(process.env.USE_COOKIE_AUTH || '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

/** Same mapping as Frontend audienceForUser(). */
function audienceForRole(role) {
    if (role === 'superadmin') return 'platform';
    if (role === 'customer') return 'customer';
    return 'staff';
}

function normaliseAudience(a) {
    const v = String(a || '').trim().toLowerCase();
    return AUDIENCES.includes(v) ? v : null;
}

/** Zero-dependency Cookie header parser (first occurrence wins). */
function parseCookies(header) {
    const out = {};
    if (!header || typeof header !== 'string') return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq).trim();
        if (!k || k in out) continue;
        let v = part.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        try { out[k] = decodeURIComponent(v); } catch { /* skip undecodable */ }
    }
    return out;
}

function sameSite() {
    const v = String(process.env.COOKIE_SAMESITE || 'lax').trim().toLowerCase();
    return ['lax', 'strict', 'none'].includes(v) ? v : 'lax';
}

function secureFlag() {
    const raw = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
    if (sameSite() === 'none') return true; // browsers reject SameSite=None without Secure
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return process.env.NODE_ENV === 'production';
}

function baseOptions(path, maxAgeMs, httpOnly) {
    const o = {
        httpOnly,
        secure: secureFlag(),
        sameSite: sameSite(),
        path,
        maxAge: Math.max(0, Math.floor(maxAgeMs)),
    };
    const domain = String(process.env.COOKIE_DOMAIN || '').trim();
    if (domain) o.domain = domain;
    return o;
}

const refreshPath = () => process.env.COOKIE_REFRESH_PATH || '/api/v1/auth';

// ─── CSRF token ──────────────────────────────────────────────────────────────
function csrfKey() {
    return process.env.CSRF_SECRET || process.env.JWT_SECRET || 'dev-only-csrf-secret';
}
const csrfSig = (rand) => crypto.createHmac('sha256', csrfKey()).update(`csrf:${rand}`).digest('base64url');

function newCsrfToken() {
    const rand = crypto.randomBytes(24).toString('base64url');
    return `${rand}.${csrfSig(rand)}`;
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isValidCsrfToken(token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const i = token.indexOf('.');
    if (i <= 0) return false;
    return safeEqual(token.slice(i + 1), csrfSig(token.slice(0, i)));
}

// ─── Reading ─────────────────────────────────────────────────────────────────
function pickByAudience(cookies, prefix, hint) {
    const aud = normaliseAudience(hint);
    if (aud) return cookies[prefix + aud] || null;
    const present = AUDIENCES.map((a) => cookies[prefix + a]).filter(Boolean);
    return present.length === 1 ? present[0] : null;
}

/** Access JWT from the audience cookie (null when the flag is off / none). */
function readAccessToken(req, hint) {
    if (!isEnabled()) return null;
    const cookies = parseCookies(req.headers && req.headers.cookie);
    return pickByAudience(cookies, ACCESS_PREFIX, hint || (req.headers && req.headers[AUDIENCE_HEADER]));
}

/** Opaque refresh token from the audience cookie. */
function readRefreshToken(req, hint) {
    if (!isEnabled()) return null;
    const cookies = parseCookies(req.headers && req.headers.cookie);
    return pickByAudience(cookies, REFRESH_PREFIX, hint || (req.headers && req.headers[AUDIENCE_HEADER]));
}

/** True when the request carries ANY of our ambient session cookies. */
function hasSessionCookie(req) {
    const cookies = parseCookies(req.headers && req.headers.cookie);
    return Object.keys(cookies).some((k) => k.startsWith(ACCESS_PREFIX) || k.startsWith(REFRESH_PREFIX) || k === LEGACY_COOKIE);
}

/** The web client opted into "tokens only in cookies" response bodies. */
function clientWantsCookieOnly(req) {
    return isEnabled() && String((req.headers && req.headers[MODE_HEADER]) || '').toLowerCase() === 'cookie';
}

// ─── Writing ─────────────────────────────────────────────────────────────────
/** { accessExpiresAt, sessionExpiresAt } (epoch ms, or null) read from the JWT's exp / sexp claims. */
function jwtExpiries(token) {
    try {
        const p = require('jsonwebtoken').decode(token) || {};
        return {
            accessExpiresAt: typeof p.exp === 'number' ? p.exp * 1000 : null,
            sessionExpiresAt: typeof p.sexp === 'number' ? p.sexp * 1000 : null,
        };
    } catch { return { accessExpiresAt: null, sessionExpiresAt: null }; }
}

/**
 * Set the audience's access + refresh cookies and a fresh CSRF cookie.
 * `sessionRemainingMs` is the time left to the login's ABSOLUTE ceiling
 * (SESSION_MAX_HOURS_*), so no cookie outlives the server-side cap.
 * Returns the CSRF token (also handed to the client body in cookie-only mode).
 */
function setSessionCookies(res, { role, accessToken, refreshToken, sessionRemainingMs, req }) {
    if (!isEnabled()) return null;
    const aud = audienceForRole(role);
    // The access cookie deliberately lives as long as the SESSION, not the
    // 30-minute JWT: when the JWT lapses the browser still sends it, the API
    // answers 401 (or the socket AUTH_EXPIRED) and the client's refresh flow
    // kicks in. A cookie that vanished with the JWT would look like "no
    // credentials" and skip that path.
    res.cookie(ACCESS_PREFIX + aud, accessToken, baseOptions('/', sessionRemainingMs, true));
    res.cookie(REFRESH_PREFIX + aud, refreshToken, baseOptions(refreshPath(), sessionRemainingMs, true));
    // Reuse the browser's current CSRF token when it is still valid: a refresh
    // in one tab must not invalidate the token another tab already holds.
    const existing = req && req.headers ? parseCookies(req.headers.cookie)[CSRF_COOKIE] : null;
    const csrf = isValidCsrfToken(existing) ? existing : newCsrfToken();
    res.cookie(CSRF_COOKIE, csrf, baseOptions('/', sessionRemainingMs, false));
    return csrf;
}

/** (Re)issue only the CSRF cookie — GET /auth/csrf. */
function setCsrfCookie(res, maxAgeMs = 12 * 60 * 60 * 1000) {
    const csrf = newCsrfToken();
    res.cookie(CSRF_COOKIE, csrf, baseOptions('/', maxAgeMs, false));
    return csrf;
}

/**
 * Clear an audience's cookies (all audiences when `aud` is falsy). Always
 * allowed, even with the flag off, so a stale cookie can be removed.
 */
function clearSessionCookies(res, aud) {
    const list = normaliseAudience(aud) ? [normaliseAudience(aud)] : AUDIENCES;
    for (const a of list) {
        const a1 = baseOptions('/', 0, true); delete a1.maxAge;
        const r1 = baseOptions(refreshPath(), 0, true); delete r1.maxAge;
        res.clearCookie(ACCESS_PREFIX + a, a1);
        res.clearCookie(REFRESH_PREFIX + a, r1);
    }
    if (!normaliseAudience(aud)) {
        const c = baseOptions('/', 0, false); delete c.maxAge;
        res.clearCookie(CSRF_COOKIE, c);
    }
}

// ─── CSRF middleware ─────────────────────────────────────────────────────────
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Entry points that CREATE a session (no ambient credential to abuse yet) plus
// logout (a forced logout is a nuisance, and must work when the CSRF cookie is
// lost). They still get the Origin/Referer check.
const DOUBLE_SUBMIT_EXEMPT = new Set([
    '/auth/login', '/auth/register', '/auth/send-otp', '/auth/verify-otp', '/auth/google',
    '/auth/forgot-password', '/auth/reset-password', '/auth/2fa/verify', '/auth/logout',
]);
// Presenting the refresh token itself in the body is proof of possession an
// attacker site cannot supply, so bearer-style callers keep working.
const BODY_TOKEN_PATHS = new Set(['/auth/refresh', '/auth/logout']);

function originOf(value) {
    try { return new URL(value).origin; } catch { return null; }
}

/**
 * csrfGuard(isOriginAllowed) — mount on /api/v1 BEFORE optionalAuth.
 * `isOriginAllowed` is app.js's CORS predicate (single source of truth).
 */
function csrfGuard(isOriginAllowed) {
    return function csrf(req, res, next) {
        if (!isEnabled() || SAFE_METHODS.has(req.method)) return next();
        const authz = req.headers.authorization;
        if (authz && authz.startsWith('Bearer ')) return next();   // header-authenticated: no ambient credential
        if (!hasSessionCookie(req)) return next();                 // nothing ambient to abuse

        const fail = (code, message) => res.status(403).json({ success: false, code, message });

        const origin = req.headers.origin;
        const referer = req.headers.referer;
        const claimed = origin !== undefined ? origin : (referer ? originOf(referer) : undefined);
        if (claimed !== undefined && !(claimed && typeof isOriginAllowed === 'function' && isOriginAllowed(claimed))) {
            return fail('CSRF_ORIGIN', 'Request origin not allowed.');
        }

        const p = req.path;
        if (DOUBLE_SUBMIT_EXEMPT.has(p)) return next();
        if (BODY_TOKEN_PATHS.has(p) && typeof req.body?.refreshToken === 'string' && req.body.refreshToken) return next();

        const header = req.headers[CSRF_HEADER];
        const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
        if (!header || !cookie || !safeEqual(header, cookie) || !isValidCsrfToken(header)) {
            return fail('CSRF_INVALID', 'Missing or invalid CSRF token. Refresh the page and try again.');
        }
        return next();
    };
}

module.exports = {
    AUDIENCES, ACCESS_PREFIX, REFRESH_PREFIX, CSRF_COOKIE, LEGACY_COOKIE,
    isEnabled, audienceForRole, normaliseAudience, parseCookies,
    readAccessToken, readRefreshToken, hasSessionCookie, clientWantsCookieOnly,
    setSessionCookies, setCsrfCookie, clearSessionCookies,
    newCsrfToken, isValidCsrfToken, csrfGuard, jwtExpiries,
};
