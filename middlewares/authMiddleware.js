const jwt = require('jsonwebtoken');
const User = require('../models/user');
const logger = require('../utils/logger');
const { updateContext } = require('../utils/requestContext');

// DB error names that indicate a connectivity problem, not an auth problem
const DB_ERRORS = new Set(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError']);

// ─── Token types (#15) ───────────────────────────────────────────────
// Every JWT this backend signs with JWT_SECRET carries a `typ` claim so a
// token minted for one purpose can never be replayed as another:
//   'user'  — session access token (login / refresh)
//   'scan'  — table QR scan session (tableController)
//   'kiosk' — kiosk order-tracking token (orderController)
//   'agent' — long-lived print-agent credential for one branch
//             (printController / utils/socket.js handshake)
// Tokens issued before `typ` existed are still accepted where their
// shape is unambiguous (see isLegacyUserPayload) until they expire.
const TOKEN_TYPES = Object.freeze({ USER: 'user', SCAN: 'scan', KIOSK: 'kiosk', AGENT: 'agent' });

// Short-lived access tokens; sessions are extended with /auth/refresh.
// ACCESS_TOKEN_TTL / SUPERADMIN_ACCESS_TOKEN_TTL accept jsonwebtoken
// `expiresIn` strings ('15m', '1h', …).
function accessTokenTtl(role) {
    if (role === 'superadmin') return process.env.SUPERADMIN_ACCESS_TOKEN_TTL || '15m';
    return process.env.ACCESS_TOKEN_TTL || '30m';
}

function signAccessToken(user) {
    return jwt.sign(
        {
            id: String(user._id),
            role: user.role,
            typ: TOKEN_TYPES.USER,
            tv: Number(user.tokenVersion) || 0,
        },
        process.env.JWT_SECRET,
        { expiresIn: accessTokenTtl(user.role) },
    );
}

// A pre-`typ` token is only treated as a user token when it has an `id`
// and none of the scan/kiosk markers.
function isLegacyUserPayload(decoded) {
    return !decoded.typ && !!decoded.id && !decoded.kind && !decoded.tableId && !decoded.orderId;
}

/** Verify a session access token. Throws on anything else. */
function verifyUserToken(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded && decoded.typ === TOKEN_TYPES.USER && decoded.id) return decoded;
    if (decoded && isLegacyUserPayload(decoded)) return decoded;
    const err = new Error('Token is not a user session token');
    err.name = 'JsonWebTokenError';
    throw err;
}

/**
 * Sign / verify helpers for scan & kiosk tokens, for the controllers
 * that own those flows. `verifyTypedToken` accepts legacy (typ-less)
 * tokens whose shape matches the expected type so already-issued QR /
 * kiosk tokens keep working until they expire.
 */
function signTypedToken(typ, payload, options) {
    return jwt.sign({ ...payload, typ }, process.env.JWT_SECRET, options);
}

function verifyTypedToken(token, typ) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ === typ) return decoded;
    if (!decoded.typ) {
        if (typ === TOKEN_TYPES.SCAN && decoded.tableId && !decoded.id) return decoded;
        if (typ === TOKEN_TYPES.KIOSK && decoded.kind === 'kiosk-track' && !decoded.id) return decoded;
    }
    const err = new Error(`Token is not a ${typ} token`);
    err.name = 'JsonWebTokenError';
    throw err;
}

/**
 * Resolve a verified user-token payload to a live user. Returns null when
 * the user is gone, or the token was revoked by a tokenVersion bump
 * (password change / reset / logout-all). Legacy tokens without `tv` are
 * treated as version 0.
 */
async function loadUserForToken(decoded) {
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return null;
    const tokenTv = Number(decoded.tv) || 0;
    const userTv = Number(user.tokenVersion) || 0;
    if (tokenTv !== userTv) return null;
    return user;
}

// CRIT-08 — zero-dep cookie reader. When USE_COOKIE_AUTH=true the JWT is
// also delivered in an httpOnly cookie. The Authorization header is
// checked FIRST: the frontend keeps separate staff and customer sessions
// side by side (utils/authStorage.js) and a single shared cookie must
// never override the session the tab explicitly asked for. Cookies are
// only read at all when the flag is on, so a stale cookie from an
// earlier rollout cannot authenticate cross-site requests.
const AUTH_COOKIE_NAME = 'bestodine_token';
function readAuthCookie(req) {
    const header = req.headers?.cookie;
    if (!header) return null;
    const parts = header.split(';');
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const k = p.slice(0, eq).trim();
        if (k === AUTH_COOKIE_NAME) {
            try { return decodeURIComponent(p.slice(eq + 1).trim()); } catch { return null; }
        }
    }
    return null;
}
function readBearerToken(req) {
    const h = req.headers?.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    if (isCookieAuthEnabled()) return readAuthCookie(req);
    return null;
}

/**
 * Middleware to protect routes - ensures user is logged in
 *
 * Phase 1 optimisation: if a globally-mounted `optionalAuth` has already
 * populated `req.user` for this request (which the v1 router does so
 * that `attachTenant` can read `req.user.restaurant`), this middleware
 * trusts that result and skips the JWT verify + DB lookup. optionalAuth
 * applies the same typ + tokenVersion checks.
 */
const protect = async (req, res, next) => {
    // Fast path — optionalAuth already validated the token and loaded the user.
    if (req.user) {
        if (req.user.status === 'inactive') {
            return res.status(401).json({ message: 'Account is deactivated. Contact your administrator.' });
        }
        return next();
    }

    // CRIT-08 — Authorization: Bearer header, or httpOnly cookie when enabled.
    const token = readBearerToken(req);
    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token provided' });
    }

    try {
        const decoded = verifyUserToken(token);
        req.user = await loadUserForToken(decoded);
        if (!req.user) {
            return res.status(401).json({ code: 'SESSION_REVOKED', message: 'Your session has ended. Please sign in again.' });
        }
        if (req.user.status === 'inactive') {
            return res.status(401).json({ message: 'Account is deactivated. Contact your administrator.' });
        }
        // #30 — record the user on the request context (no-op outside one).
        updateContext({ userId: req.user._id, role: req.user.role, isSuperadmin: req.user.role === 'superadmin' });
        return next();
    } catch (error) {
        if (DB_ERRORS.has(error.name)) {
            logger.error('Auth Middleware — DB unavailable: ' + error.message);
            return res.status(503).json({ success: false, message: 'Service temporarily unavailable. Please try again.' });
        }
        const isRoutine = ['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'].includes(error.name);
        if (!isRoutine) {
            logger.error('Auth Middleware Error: ' + error.message);
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Session expired' });
        }
        return res.status(401).json({ message: 'Not authorized, token failed' });
    }
};

/**
 * Middleware to restrict access based on roles
 * @param  {...string} roles - Allowed roles (e.g., 'admin', 'customer')
 */
const restrictTo = (...roles) => {
    return (req, res, next) => {
        // roles is an array ['admin']. req.user.role is 'customer'
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                message: 'You do not have permission to perform this action'
            });
        }
        return next();
    };
};

/**
 * Shorthand for admin-level access. Manager is included because per
 * the staff matrix it's "treated like an admin in most permission
 * paths" — the truly owner-only operations (billing, branch CRUD,
 * tenant export) are gated separately by `adminExclusive`, which
 * additionally requires `isTenantOwner === true` and so still keeps
 * managers out of those.
 */
const adminOnly = (req, res, next) => {
    if (req.user && ['admin', 'manager'].includes(req.user.role)) {
        return next();
    }
    return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
};

/**
 * Captain or admin/manager — used for table management, billing,
 * payment routes. Manager is included alongside admin per the same
 * rationale as `adminOnly` above.
 */
const captainOrAdmin = (req, res, next) => {
    if (req.user && ['captain', 'admin', 'manager'].includes(req.user.role)) {
        return next();
    }
    return res.status(403).json({ success: false, message: 'Access denied. Captain or Admin only.' });
};

/**
 * Any staff role — waiter, captain, chef, manager, admin
 */
const staffOnly = (req, res, next) => {
    if (req.user && ['waiter', 'captain', 'chef', 'manager', 'admin'].includes(req.user.role)) {
        return next();
    }
    return res.status(403).json({ success: false, message: 'Access denied. Staff only.' });
};

/**
 * Optional auth — attaches req.user if a valid token is present, but does NOT
 * reject the request when no token is provided (allows guest access).
 */
const optionalAuth = async (req, res, next) => {
    // CRIT-08 — read from cookie OR Authorization: Bearer header.
    const token = readBearerToken(req);
    if (token) {
        try {
            const decoded = verifyUserToken(token);
            const user = await loadUserForToken(decoded);
            if (user && user.status === 'active') {
                req.user = user;
            } else {
                // A well-formed session token whose session was revoked
                // (tokenVersion bump / user gone) or whose account is
                // deactivated. Continue as guest, but remember why so
                // attachTenant can answer 401 instead of 400
                // TENANT_REQUIRED when no tenant can be resolved — the
                // client must log the user out, not show the picker.
                req.authFailure = user
                    ? { code: 'ACCOUNT_DEACTIVATED', message: 'Account is deactivated. Contact your administrator.' }
                    : { code: 'SESSION_REVOKED', message: 'Your session has ended. Please sign in again.' };
            }
        } catch {
            // Token invalid/expired/revoked/wrong type — continue as guest
        }
    }
    return next();
};

/**
 * Granular permission check — verifies a specific permission flag on the user's
 * permissions object (e.g. 'editMenu', 'accessKitchen', 'manageStaff').
 * Admins bypass all permission checks automatically.
 *
 * Usage:  router.put('/menu/:id', protect, checkPermission('editMenu'), handler)
 */
const checkPermission = (permissionKey) => {
    return (req, res, next) => {
        // Admins always pass
        if (req.user && req.user.role === 'admin') return next();

        const perms = req.user?.permissions || {};
        if (perms[permissionKey] === true) return next();

        return res.status(403).json({
            success: false,
            message: `Access denied. Missing permission: ${permissionKey}`
        });
    };
};

/**
 * Admin-exclusive gate — ONLY the restaurant OWNER may pass.
 *
 * CRIT-06 — sub-admins (role='admin' pinned to a branch) are blocked
 * here; this gate is for TRULY tenant-level operations only:
 *   - Subscription billing / plan changes
 *   - Tenant branding (logo, custom domain, email sender)
 *   - Branch CRUD
 *   - Tenant data export / GDPR delete
 *   - Hiring/firing other sub-admins
 *
 * Everything else (menu, orders, staff, wallet, analytics…) is a
 * normal admin operation and uses `adminOnly` + `checkPermission`,
 * which sub-admins still pass.
 */
const adminExclusive = (req, res, next) => {
    if (req.user && req.user.role === 'admin' && req.user.isTenantOwner === true) {
        return next();
    }
    return res.status(403).json({
        success: false,
        code: 'OWNER_ONLY',
        message: 'Access denied. This action is available only to the restaurant owner.',
    });
};

/**
 * Super Admin gate — any superadmin (full or support) is allowed through.
 * Mount AFTER `protect`. Use for read-only or shared super-admin endpoints
 * (dashboard analytics, audit log viewer, restaurant list).
 */
const superAdminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Access denied. Super Admin only.'
    });
};

/**
 * Full Super Admin gate — only `superadminLevel === 'full'` may pass.
 * Use for state-changing endpoints: create restaurant, change plan,
 * suspend tenant, edit billing, create other superadmin accounts.
 *
 * Support-tier superadmins are explicitly blocked here.
 */
const superAdminFull = (req, res, next) => {
    if (
        req.user &&
        req.user.role === 'superadmin' &&
        req.user.superadminLevel === 'full'
    ) {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Access denied. Full Super Admin privileges required.'
    });
};

// CRIT-05 — server-side enforcement of mustChangePassword.
//
// Previously this flag was only honored by the frontend ProtectedRoute,
// which meant a staff member with a temp password could call any API
// directly (via curl) for the full token lifetime. Now every v1
// request passes through this gate: if `user.mustChangePassword` is
// true, every endpoint returns 403 PASSWORD_CHANGE_REQUIRED EXCEPT the
// two paths the user needs to actually complete the change.
//
// Paths are matched against `req.path` which, because this middleware
// is mounted on the `/api/v1` router (not a sub-router), is the path
// relative to that mount (e.g. `/auth/change-password`).
const PASSWORD_CHANGE_ALLOWED = new Set([
    '/auth/me',               // GET — read current session / tenant state
    '/auth/change-password',  // PUT — perform the actual change
    '/auth/refresh',          // POST — keep the session alive while changing
    '/auth/logout',           // POST — let the user bail out
    '/auth/logout-all',
]);

const requirePasswordCurrent = (req, res, next) => {
    // No user on this request → nothing to enforce (guest / public).
    if (!req.user?.mustChangePassword) return next();

    if (PASSWORD_CHANGE_ALLOWED.has(req.path)) return next();

    return res.status(403).json({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must change your password before continuing.',
    });
};

// CRIT-08 — helpers for login/logout handlers to issue or clear the
// httpOnly cookie symmetrically. `USE_COOKIE_AUTH=true` turns on cookie
// issuance AND cookie reading.
//
// #15 assessment — keep USE_COOKIE_AUTH OFF for now. The cookie path is
// not complete enough to switch on:
//   * one cookie name is shared by the staff and customer audiences, but
//     the frontend deliberately runs both sessions side by side in one
//     browser (utils/authStorage.js) — a single cookie cannot represent
//     that;
//   * the frontend still stores the token in localStorage and never sends
//     withCredentials, so the cookie adds CSRF surface without removing
//     the XSS exposure;
//   * socket.io auth does not read the cookie;
//   * there is no CSRF token — only SameSite.
// When enabled anyway, cookies are httpOnly, SameSite=Strict (the API is
// never the target of a top-level navigation), Secure in production, and
// scoped to /api.
function isCookieAuthEnabled() {
    const v = String(process.env.USE_COOKIE_AUTH || '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

function cookieOptions(maxAgeMs) {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: maxAgeMs,
        path: '/api',
    };
}

function setAuthCookie(res, token) {
    if (!isCookieAuthEnabled()) return;
    // Match the access-token lifetime — the cookie must not outlive the JWT.
    let maxAgeMs = 30 * 60 * 1000;
    try {
        const exp = jwt.decode(token)?.exp;
        if (exp) maxAgeMs = Math.max(0, exp * 1000 - Date.now());
    } catch { /* keep default */ }
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions(maxAgeMs));
}

function clearAuthCookie(res) {
    // Always allow clearing, even when the flag is off — a user who had
    // a cookie set in an earlier session must be able to log out. Clear
    // both the current (/api) and the legacy (/) cookie paths.
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/api' });
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
}

module.exports = {
    protect,
    restrictTo,
    adminOnly,
    adminExclusive,
    captainOrAdmin,
    staffOnly,
    optionalAuth,
    checkPermission,
    superAdminOnly,
    superAdminFull,
    requirePasswordCurrent,
    // #15 token helpers
    TOKEN_TYPES,
    signAccessToken,
    verifyUserToken,
    loadUserForToken,
    signTypedToken,
    verifyTypedToken,
    readBearerToken,
    // CRIT-08 cookie helpers
    AUTH_COOKIE_NAME,
    isCookieAuthEnabled,
    setAuthCookie,
    clearAuthCookie,
};
