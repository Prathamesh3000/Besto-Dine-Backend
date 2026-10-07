const User = require('../models/user');
const Otp = require('../models/otp');
const { OtpSendCounter } = require('../models/otp');
const RefreshSession = require('../models/refreshSession');
const Restaurant = require('../models/restaurant');
const Shift = require('../models/shift');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('../utils/logger');
const { setAuthCookie, clearAuthCookie, signAccessToken } = require('../middlewares/authMiddleware');

// Roles whose shift status should follow their auth session. Every
// tenant-side staff role — admin, manager, waiter, captain, chef —
// gets auto-opened on login and auto-closed on logout so the Staff
// Dashboard's On-Duty light reflects who is actually signed in.
//
// Idempotent: openShiftOnLogin skips when an active shift already
// exists, so the manual /shifts/clock-in flow (used from the waiter
// shift page) still works without colliding. Forgotten-logout
// safety net = runShiftAutoClose sweep in utils/shiftAutoCloser.
const SHIFT_AUTO_ROLES = new Set(['admin', 'manager', 'waiter', 'captain', 'chef']);

async function openShiftOnLogin(user) {
    if (!user || !SHIFT_AUTO_ROLES.has(user.role)) return;
    if (!user.restaurant) return;
    try {
        const existing = await Shift.findOne({
            staff: user._id,
            status: 'active',
            restaurant: user.restaurant,
        }).select('_id').lean();
        if (existing) return;
        await Shift.create({
            staff: user._id,
            restaurant: user.restaurant,
            clockIn: new Date(),
            status: 'active',
            note: '[Auto-opened on login]',
        });
    } catch (err) {
        logger.warn(`openShiftOnLogin: failed for user ${user._id}: ${err.message}`);
    }
}

async function closeShiftOnLogout(user) {
    if (!user || !SHIFT_AUTO_ROLES.has(user.role)) return;
    if (!user.restaurant) return;
    try {
        const shift = await Shift.findOne({
            staff: user._id,
            status: 'active',
            restaurant: user.restaurant,
        });
        if (!shift) return;
        const now = new Date();
        shift.clockOut = now;
        shift.status = 'completed';
        shift.totalHours = Math.round(((now - shift.clockIn) / 3600000) * 100) / 100;
        const audit = '[Auto-closed on logout]';
        shift.note = shift.note ? `${shift.note}\n${audit}` : audit;
        await shift.save();
    } catch (err) {
        logger.warn(`closeShiftOnLogout: failed for user ${user._id}: ${err.message}`);
    }
}

// Test-only exports — keep these out of production hot paths but expose
// the helpers so scripts/test-shift-and-staffid.js can exercise the
// real code path instead of re-implementing it.
if (process.env.NODE_ENV !== 'production') {
    exports.__openShiftOnLogin   = openShiftOnLogin;
    exports.__closeShiftOnLogout = closeShiftOnLogout;
    exports.__SHIFT_AUTO_ROLES   = SHIFT_AUTO_ROLES;
}

// ─── Session helpers (#15 / #28) ─────────────────────────────────────────────
//
// A session is a short-lived JWT access token (typ:'user', tv:<tokenVersion>,
// see middlewares/authMiddleware.signAccessToken — ACCESS_TOKEN_TTL, default
// 30m; super admin 15m) plus an opaque, rotating refresh token stored
// hashed in RefreshSession. The client swaps the refresh token for a new
// pair at POST /auth/refresh, so staff stay signed in for a whole shift
// without long-lived bearer tokens.
//
// Refresh lifetime is sliding (every rotation restarts it):
//   superadmin 12h · staff 7d  (hours; env-overridable)
//   customer   CUSTOMER_IDLE_TIMEOUT_MINUTES (default 60) — an INACTIVITY
//              timeout: each refresh extends the session by 60 min, and a
//              customer idle for longer must sign in again (QA N14).
const STAFF_SESSION_ROLES = new Set(['admin', 'manager', 'waiter', 'captain', 'chef']);

const envNumber = (envKey, dflt) => {
    const n = Number(process.env[envKey]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Customer inactivity timeout (ms). CUSTOMER_IDLE_TIMEOUT_MINUTES, default 60. */
function customerIdleMs() {
    return envNumber('CUSTOMER_IDLE_TIMEOUT_MINUTES', 60) * 60 * 1000;
}

const isCustomerRole = (role) => role !== 'superadmin' && !STAFF_SESSION_ROLES.has(role);

function refreshTtlMs(role) {
    const hours = (envKey, dflt) => envNumber(envKey, dflt) * 60 * 60 * 1000;
    if (role === 'superadmin') return hours('REFRESH_TTL_HOURS_SUPERADMIN', 12);
    if (STAFF_SESSION_ROLES.has(role)) return hours('REFRESH_TTL_HOURS_STAFF', 7 * 24);
    return customerIdleMs();
}

/**
 * Absolute session lifetime — the hard ceiling a session cannot exceed
 * no matter how active the user is.
 *
 * refreshTtlMs() above is PER TOKEN and resets on every rotation. That
 * alone is a sliding window with no ceiling: any client that refreshes
 * before the token lapses stays signed in indefinitely. The customer
 * app polls notifications every 15s and refreshes its access token
 * every ~30 minutes, so a browser tab left open overnight renews itself
 * forever — which is why a tester who signed in yesterday was still
 * signed in today.
 *
 * Defaults are chosen per role by how much damage an unattended session
 * can do:
 *   superadmin  8h  — platform-wide access; shortest leash
 *   staff      12h  — about one shift on a shared floor tablet
 *   customer   24h  — plus a 60-minute INACTIVITY timeout (see
 *                     customerIdleMs / refresh below)
 */
function refreshAbsoluteMs(role) {
    const hours = (envKey, dflt) => {
        const n = Number(process.env[envKey]);
        return (Number.isFinite(n) && n > 0 ? n : dflt) * 60 * 60 * 1000;
    };
    if (role === 'superadmin') return hours('SESSION_MAX_HOURS_SUPERADMIN', 8);
    if (STAFF_SESSION_ROLES.has(role)) return hours('SESSION_MAX_HOURS_STAFF', 12);
    // Customer absolute cap: SESSION_MAX_HOURS_CUSTOMER, else
    // REFRESH_TTL_HOURS_CUSTOMER (its meaning since the idle timeout took
    // over the per-token window), else 24h. Combined with the 60-minute
    // inactivity timeout, an active customer re-signs in at least daily.
    return hours('SESSION_MAX_HOURS_CUSTOMER', envNumber('REFRESH_TTL_HOURS_CUSTOMER', 24));
}

const sha256 = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// Two tabs of the same audience may refresh with the same token at the
// same instant. The loser of that race presents an already-rotated token;
// inside this window that is treated as benign rather than as theft.
const REFRESH_REUSE_GRACE_MS = 30 * 1000;

async function createRefreshSession(user, req, family, familyExpiresAt) {
    const raw = crypto.randomBytes(32).toString('base64url');
    // A rotation INHERITS the original ceiling; only a fresh login (no
    // familyExpiresAt passed) starts a new one. Recomputing it here
    // would reintroduce the unbounded-session bug this exists to fix.
    const ceiling = familyExpiresAt || new Date(Date.now() + refreshAbsoluteMs(user.role));
    await RefreshSession.create({
        user: user._id,
        tokenHash: sha256(raw),
        family: family || crypto.randomUUID(),
        tv: Number(user.tokenVersion) || 0,
        familyExpiresAt: ceiling,
        lastUsedAt: new Date(),
        // Per-token expiry; never later than the family ceiling.
        // For customers this IS the inactivity window (60 min default).
        expiresAt: new Date(Math.min(Date.now() + refreshTtlMs(user.role), ceiling.getTime())),
        userAgent: String(req.headers?.['user-agent'] || '').slice(0, 200),
        ip: String(req.ip || ''),
    });
    return raw;
}

// Exported for __tests__/sessionLifetime.test.js — the session ceiling
// is a security control, so its values are pinned by tests.
exports.refreshAbsoluteMs = refreshAbsoluteMs;
exports.refreshTtlMs = refreshTtlMs;
exports.customerIdleMs = customerIdleMs;

/** Mint an access token + refresh token for `user`. */
async function issueSession(req, res, user, family, familyExpiresAt) {
    const token = signAccessToken(user);
    const refreshToken = await createRefreshSession(user, req, family, familyExpiresAt);
    setAuthCookie(res, token);  // CRIT-08 — no-op unless USE_COOKIE_AUTH=true
    return { token, refreshToken };
}

/**
 * Log a user out of every device: bump tokenVersion (kills every access
 * token on its next request) and revoke every refresh session. Returns
 * the updated user document. Exported so staff/admin controllers can call
 * it on admin password reset / deactivation.
 */
async function revokeAllSessions(userId) {
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { tokenVersion: 1 } },
        { returnDocument: 'after' },
    );
    await RefreshSession.updateMany(
        { user: userId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
    );
    return updated;
}
exports.revokeAllSessions = revokeAllSessions;

// ─── Validation helpers ──────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { MOBILE_REGEX, normalizeMobile } = require('../utils/mobile'); // Indian mobile: 10 digits starting with 6-9
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=<>?]).{8,}$/;
// Customer self-service passwords (register + reset) must reach at
// least the "Good" rating the registration meter shows — 8+ characters
// with upper, lower, digit and special ("Strong" = 12+ is encouraged,
// not required). Mirrors Frontend/src/utils/passwordPolicy.js
// (MIN_LENGTH / MIN_PASSWORD_SCORE); change both together.
// Shared with hotel self-signup (publicController.registerRestaurant).
const {
    STRONG_PASSWORD_REGEX: CUSTOMER_PASSWORD_REGEX,
    STRONG_PASSWORD_MESSAGE: CUSTOMER_PASSWORD_MESSAGE,
} = require('../utils/passwordPolicy');

// ─── SMS Provider Hook ───────────────────────────────────────────────────────
// Configure your SMS provider here. Set SMS_PROVIDER in .env to enable.
// Supported: 'twilio', 'msg91', or leave unset for console-only (dev mode).
async function sendOtpSms(mobile, code) {
    const provider = process.env.SMS_PROVIDER; // 'twilio' | 'msg91' | undefined

    if (provider === 'twilio') {
        try {
            const twilio = require('twilio');
            const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            await client.messages.create({
                body: `Your BestoDine verification code is: ${code}. Valid for 5 minutes.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: `+91${mobile}`,  // mobile is normalised to 10 digits
            });
            return true;
        } catch (err) {
            logger.error('Twilio SMS error: ' + err.message);
            return false;
        }
    }

    if (provider === 'msg91') {
        try {
            const https = require('https');
            const payload = JSON.stringify({
                template_id: process.env.MSG91_TEMPLATE_ID,
                short_url: '0',
                // mobile is normalised to 10 digits — always prefix the
                // country code (a number like 91xxxxxxxx is a valid mobile).
                recipients: [{ mobiles: `91${mobile}`, otp: code }],
            });
            await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'control.msg91.com',
                    path: '/api/v5/otp',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'authkey': process.env.MSG91_AUTH_KEY,
                    },
                }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
            return true;
        } catch (err) {
            logger.error('MSG91 SMS error: ' + err.message);
            return false;
        }
    }

    // No provider configured — dev mode, OTP printed to console only
    return false;
}

// ─── Response shape helper ────────────────────────────────────────────────────
// Builds the user payload that AuthContext stores in localStorage.
// AuthContext destructures: const { token, ...userData } = response.data
// So every field here (except token) becomes part of the stored user object.
//
// Fields consumed by the frontend:
//   _id          — NotificationContext (/notifications?userId=), WalletDashboard
//   name         — display, avatar fallback
//   email        — display, staff edit form
//   mobile       — display, staff edit form (also accessed as .phone || .mobile)
//   allergy      — customer profile display
//   role         — ProtectedRoute, AuthContext role helpers, page redirects
//   avatar       — StaffDashboard, AddStaffModal image preview
//   staffId      — StaffDashboard edit form pre-fill
//   permissions  — StaffDashboard edit form pre-fill (must survive JSON round-trip)
//   status       — optional guard; admin can check if account is active

const buildUserPayload = (user) => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    allergy: user.allergy,
    // Global customer-identity fields — used by Profile / EditProfile to
    // surface birthday-anniversary offers, default dietary preference, and
    // pre-filled takeaway address. Empty / null for staff and superadmins.
    dob: user.dob || null,
    anniversary: user.anniversary || null,
    gender: user.gender || '',
    dietaryPreference: user.dietaryPreference || '',
    preferredLanguage: user.preferredLanguage || '',
    address: user.address ? {
        line1:    user.address.line1    || '',
        line2:    user.address.line2    || '',
        city:     user.address.city     || '',
        state:    user.address.state    || '',
        pincode:  user.address.pincode  || '',
        landmark: user.address.landmark || '',
    } : null,
    role: user.role,
    avatar: user.avatar,
    staffId: user.staffId || undefined,
    permissions: user.permissions || {},
    kitchenResponsibility: user.kitchenResponsibility || '',
    status: user.status,
    mustChangePassword: user.mustChangePassword || false,
    // CRIT-06 — tenant owner bit so the FE can show owner-only UI
    // sections (billing, branches, plan upgrade). Sub-admins still
    // see every regular admin tab; this bit only gates tenant-level
    // controls.
    isTenantOwner: user.isTenantOwner === true,
    // SaaS fields — empty / null for legacy users, populated for tenants and platform staff
    superadminLevel: user.superadminLevel || '',
    restaurant: user.restaurant || null,
    // Phase 6 — branch assignment for Sub Admins / branch-pinned staff.
    // Populated to { _id, name, slug } by buildAuthResponse below.
    branch: user.branch || null,
    // CAP-010 — floor-scope assignment for Waiter / Captain. Empty
    // array means "covers the whole branch" (default). When populated,
    // the waiter home grid filters areas + tables to just these refs so
    // a waiter only sees the tables they actually own.
    assignedAreas: Array.isArray(user.assignedAreas) ? user.assignedAreas : [],
    assignedTables: Array.isArray(user.assignedTables) ? user.assignedTables : [],
    // Whether this waiter/captain handles takeaway (counter) orders. Drives
    // the takeaway visibility rule in the frontend floor scope.
    handlesTakeaway: user.handlesTakeaway === true,
});

/**
 * assertTenantNotLocked — guard rail used during login and session
 * refresh (`/auth/me`).
 *
 * If the user belongs to a Restaurant whose lifecycle status is
 * 'suspended' or 'cancelled', this returns a structured 401 payload
 * that the caller should send back to the client. Returns null when
 * the user is allowed to proceed (no tenant link, super admin, or
 * tenant active/trial/past_due).
 *
 * Returning a payload (instead of throwing) keeps both call sites
 * uniform and lets the caller decide whether to short-circuit.
 */
const assertTenantNotLocked = async (user) => {
    if (!user || !user.restaurant) return null;
    if (user.role === 'superadmin') return null;

    const restaurant = await Restaurant.findById(user.restaurant).select('status name signupSource signupStatus signupRejectedReason');
    if (!restaurant) {
        // Integrity failure — the user references a deleted tenant.
        // Treat the same as suspension so they cannot get a working session.
        logger.warn(`assertTenantNotLocked: user ${user._id} references missing restaurant ${user.restaurant}`);
        return {
            status: 401,
            body: {
                success: false,
                code: 'TENANT_MISSING',
                message: 'Your restaurant account is no longer available. Contact BestoDine support.',
            },
        };
    }

    // Self-signup approval gate: a pending / rejected hotel registration
    // is technically a suspended tenant, but the owner needs to know WHY
    // — not "contact support". Only applies while the signup itself is
    // unresolved; an approved tenant suspended later falls through to the
    // generic TENANT_SUSPENDED below.
    if (restaurant.status === 'suspended' || restaurant.status === 'cancelled') {
        if (restaurant.signupStatus === 'pending') {
            return {
                status: 403,
                body: {
                    success: false,
                    code: 'SIGNUP_PENDING',
                    message: "Your hotel registration is awaiting approval. We'll email you once it's approved.",
                },
            };
        }
        if (restaurant.signupStatus === 'rejected') {
            const reason = restaurant.signupRejectedReason || '';
            return {
                status: 403,
                body: {
                    success: false,
                    code: 'SIGNUP_REJECTED',
                    reason,
                    message: reason
                        ? `Your hotel registration was not approved: ${reason}`
                        : 'Your hotel registration was not approved. Contact BestoDine support for details.',
                },
            };
        }
    }

    if (restaurant.status === 'suspended' || restaurant.status === 'cancelled') {
        return {
            status: 401,
            body: {
                success: false,
                code: 'TENANT_SUSPENDED',
                message: `Your restaurant "${restaurant.name}" is currently suspended. Contact BestoDine support.`,
            },
        };
    }

    return null;
};

/**
 * buildAuthResponse — async wrapper around buildUserPayload that
 * additionally resolves the user's restaurant context (status, plan name,
 * features, limits, override flags) when the user has one.
 *
 * The frontend uses this snapshot to drive `hasFeature(key)` checks and
 * to render lock badges in the admin sidebar without making a second
 * round-trip on every page load.
 *
 * Failures here are non-fatal: if the restaurant lookup throws or the
 * restaurant document is missing, the user still logs in normally and
 * the frontend simply behaves as a legacy single-tenant client (every
 * feature unlocked).
 */
const { effectiveFeatures, activeAddonKeys } = require('../utils/featureAccess');
const ALL_FEATURE_KEYS = [...require('../models/subscriptionPlan').FEATURE_KEYS, 'revenueAnalytics'];

const buildAuthResponse = async (user) => {
    const payload = buildUserPayload(user);

    if (!user?.restaurant) return payload;

    try {
        const r = await Restaurant.findById(user.restaurant)
            .select('name slug status subscription featureOverrides addons')
            .lean();
        if (!r) return payload;

        payload.tenant = {
            _id: r._id,
            name: r.name,
            slug: r.slug,
            status: r.status,
            planName: r.subscription?.planName || '',
            planSlug: r.subscription?.planSlug || '',
            subscriptionStatus: r.subscription?.status || '',
            trialEndDate: r.subscription?.trialEndDate || null,
            // Fully-resolved module map (plan snapshot + paid add-ons +
            // legacy fallbacks) so the UI applies exactly the backend's
            // rules. The raw plan snapshot stays available as planFeatures.
            features: effectiveFeatures(r, ALL_FEATURE_KEYS),
            planFeatures: r.subscription?.features || {},
            addons: [...activeAddonKeys(r)],
            limits: r.subscription?.limits || {},
            featureOverrides: r.featureOverrides || {},
        };
    } catch (err) {
        logger.warn('buildAuthResponse: failed to load tenant for user ' + user._id + ': ' + err.message);
    }

    // Phase 6 — resolve branch name for Sub Admins so the frontend
    // can display "Branch: FC Road" and lock the dashboard scope.
    if (user.branch) {
        try {
            const Branch = require('../models/branch');
            const b = await Branch.findById(user.branch).select('name slug').lean();
            if (b) payload.branch = { _id: b._id, name: b.name, slug: b.slug };
        } catch (err) {
            logger.warn('buildAuthResponse: failed to load branch for user ' + user._id + ': ' + err.message);
        }
    }

    return payload;
};

// ─── POST /api/auth/register ─────────────────────────────────────────────────
// Public registration — always creates a 'customer' account.
// Staff accounts are created exclusively via POST /api/staff (admin only).
//
// Request body: { name, email, password, mobile, allergy }
// Response:     { success, ...userPayload, token, refreshToken }

exports.register = async (req, res) => {
    try {
        const { name, email, password, mobile, allergy } = req.body;

        // ── Validation ──────────────────────────────────────────────────────
        const notString = (v) => v !== undefined && v !== null && typeof v !== 'string';
        if ([name, email, password, mobile, allergy].some(notString)) {
            return res.status(400).json({ success: false, message: 'Invalid registration details' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }
        if (!email || !email.trim()) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }
        if (!EMAIL_REGEX.test(email.trim())) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
        }
        if (!password || !CUSTOMER_PASSWORD_REGEX.test(password)) {
            return res.status(400).json({
                success: false,
                code: 'WEAK_PASSWORD',
                message: CUSTOMER_PASSWORD_MESSAGE,
            });
        }
        if (!mobile || !mobile.trim()) {
            return res.status(400).json({ success: false, message: 'Mobile number is required' });
        }
        if (!MOBILE_REGEX.test(mobile.trim())) {
            return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit mobile number' });
        }

        // CRIT-07 (Option A) — do NOT confirm whether the email is
        // already registered. Returning a specific "Email already
        // registered" message lets any attacker enumerate the platform's
        // customer base via /register. Use the same generic response
        // for both the pre-check and the Mongoose E11000 race path; it
        // still steers legitimate users towards the login screen without
        // confirming account existence.
        const GENERIC_REGISTER_FAIL = 'Unable to register with the details provided. If you already have an account, please sign in.';

        // ── Duplicate check ──────────────────────────────────────────────────
        const existing = await User.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            return res.status(400).json({ success: false, code: 'REGISTER_FAILED', message: GENERIC_REGISTER_FAIL });
        }

        // ── Create user ──────────────────────────────────────────────────────
        const user = await User.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password,          // hashed by pre-save hook
            mobile: mobile.trim(),
            allergy: allergy ? allergy.trim() : '',
            role: 'customer',  // public registration always → customer
        });

        const session = await issueSession(req, res, user);
        return res.status(201).json({
            success: true,
            ...(await buildAuthResponse(user)),
            ...session,
        });
    } catch (err) {
        // Mongoose duplicate-key error (race condition fallback) — same
        // generic message as the pre-check above.
        const GENERIC_REGISTER_FAIL = 'Unable to register with the details provided. If you already have an account, please sign in.';
        if (err.code === 11000) {
            return res.status(400).json({ success: false, code: 'REGISTER_FAILED', message: GENERIC_REGISTER_FAIL });
        }
        logger.error('Register error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Registration failed' });
    }
};

// ─── POST /api/auth/login ────────────────────────────────────────────────────
// Shared login for ALL roles (customer, waiter, captain, chef, manager, admin).
// Optional loginType param enforces role-based separation:
//   loginType: 'customer' → only customer accounts allowed
//   loginType: 'staff'    → only staff accounts allowed (waiter, captain, chef, manager, admin)
//   omitted               → any role allowed (backward-compatible)
//
// Request body: { email, password, loginType? }
// Response:     { success, ...userPayload, token }

// Super admins log in via the same /staff-login form as restaurant staff,
// so they are included in STAFF_ROLES for the role-separation guard below.
// Routing the user to the right portal happens on the frontend based on
// the returned `role` field.
const STAFF_ROLES = ['waiter', 'captain', 'chef', 'manager', 'admin', 'superadmin'];

exports.login = async (req, res) => {
    try {
        const { email, password, loginType, expectedRole } = req.body;

        // ── Validation ──────────────────────────────────────────────────────
        // Non-strings (e.g. `{ "$ne": null }`, reduced to `{}` by the
        // operator sanitizer) are a client error — bcrypt.compare would
        // otherwise throw and turn them into a 500.
        if (typeof email !== 'string' || typeof password !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // ── Find user (include password for comparison) ──────────────────────
        // Phase 1 SaaS: email is no longer globally unique for staff. The
        // same email can belong to a customer (global), a super admin
        // (global), AND a staff member at one or more tenants. We
        // resolve which "user" the caller meant by combining the
        // requested loginType with the active tenant context (set by
        // attachTenant middleware via the X-Restaurant-Slug header).
        const cleanEmail = email.toLowerCase().trim();
        const STAFF_DB_ROLES = ['admin', 'manager', 'waiter', 'captain', 'chef'];
        let user = null;

        // attachTenant short-circuits for /auth/* (strict-exempt) and never
        // resolves the X-Restaurant-Slug header into req.restaurant, so we
        // resolve it here ourselves. Without this, the per-tenant staff
        // lookup below is skipped and a staff email that exists at more than
        // one tenant always falls through to the global disambiguation 409 —
        // i.e. a valid staffer can't log in even with the correct restaurant
        // selected and the correct password.
        let activeRestaurant = req.restaurant || null;
        if (!activeRestaurant && loginType !== 'customer') {
            const rawSlug = req.headers['x-restaurant-slug'] || req.headers['x-restaurant'] || req.query?.restaurant;
            const slug = rawSlug ? String(rawSlug).trim().toLowerCase() : null;
            if (slug && /^[a-z0-9][a-z0-9-]{1,59}$/.test(slug)) {
                activeRestaurant = await Restaurant.findOne({ slug }).select('_id').lean();
            }
        }

        if (loginType === 'customer') {
            // Customers are a global identity — exactly one match expected.
            user = await User.findOne({ email: cleanEmail, role: 'customer' }).select('+password');
        } else {
            // Staff/super-admin login (or omitted loginType for legacy callers).
            // Priority order:
            //   1. Super admin with this email (global, no tenant)
            //   2. Staff in the active tenant (if one is set via header)
            //   3. ANY staff with this email — only allowed when no tenant
            //      slug was provided AND there's exactly one match (we
            //      reject ambiguous matches with a clear error).
            user = await User.findOne({ email: cleanEmail, role: 'superadmin' }).select('+password');

            if (!user && activeRestaurant) {
                user = await User.findOne({
                    email: cleanEmail,
                    restaurant: activeRestaurant._id,
                    role: { $in: STAFF_DB_ROLES },
                }).select('+password');
            }

            if (!user) {
                // No tenant context (or no match in the picked tenant).
                // Try a global staff lookup; if multiple tenants have the
                // same email, return a clear "pick a restaurant" error.
                const candidates = await User.find({
                    email: cleanEmail,
                    role: { $in: STAFF_DB_ROLES },
                }).select('+password');

                if (candidates.length > 1) {
                    return res.status(409).json({
                        success: false,
                        code: 'TENANT_DISAMBIGUATION_REQUIRED',
                        message: 'This email exists at multiple restaurants. Please pick a restaurant before logging in.',
                    });
                }
                user = candidates[0] || null;
            }

            // Final fallback: customer login that came through the staff
            // form by mistake. Lookup the customer record so the existing
            // role-mismatch guard below can return the same generic 401.
            if (!user) {
                user = await User.findOne({ email: cleanEmail, role: 'customer' }).select('+password');
            }
        }

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // ── Password check ───────────────────────────────────────────────────
        // A Google-only account has NO stored password. Without this
        // guard bcrypt.compare(candidate, undefined) is reached, which
        // throws and surfaces as a 500 — telling the user "server error"
        // when the real answer is "you signed up with Google". Steer
        // them to the door that actually works.
        if (!user.password) {
            return res.status(401).json({
                success: false,
                code: 'USE_GOOGLE_SIGNIN',
                message: 'This account uses Google Sign-In. Tap "Continue with Google" to log in.',
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // ── Account status guard ─────────────────────────────────────────────
        if (user.status === 'inactive') {
            return res.status(401).json({
                success: false,
                message: 'Account is deactivated. Contact your administrator.'
            });
        }

        // ── Role-based login separation ──────────────────────────────────────
        // Use the same generic message for all role mismatches to avoid
        // leaking whether the credentials belong to a valid account.
        // Note: superadmins are allowed to satisfy any staff role pick on
        // the unified staff-login form because the form has no dedicated
        // "Super Admin" button — the post-login redirect routes them to
        // the correct portal based on their actual role.
        const isSuperAdmin = user.role === 'superadmin';
        if (
            (loginType === 'customer' && user.role !== 'customer') ||
            (loginType === 'staff' && !STAFF_ROLES.includes(user.role)) ||
            (expectedRole && STAFF_ROLES.includes(expectedRole) && user.role !== expectedRole && !isSuperAdmin)
        ) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // ── Tenant lockout ───────────────────────────────────────────────
        // If the user belongs to a Restaurant the Super Admin has
        // suspended/cancelled, refuse to issue a new session token.
        const tenantLock = await assertTenantNotLocked(user);
        if (tenantLock) return res.status(tenantLock.status).json(tenantLock.body);

        const session = await issueSession(req, res, user);

        // Every staff role's shift mirrors the auth session: opens a
        // Shift record so the Staff Dashboard's "On Duty" light turns
        // green immediately. Manual clock-in from the waiter shift
        // page still works (the helper is idempotent).
        await openShiftOnLogin(user);

        return res.status(200).json({
            success: true,
            ...(await buildAuthResponse(user)),
            ...session,
        });
    } catch (err) {
        logger.error('Login error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Login failed' });
    }
};

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
// Protected — requires valid Bearer token (applied in the route file).
// Refreshes user data from the database so the client can detect account
// changes (role updates, deactivation) without requiring a new login.
//
// Request:  Authorization: Bearer <token>
// Response: { success, user: { ...userPayload } }

exports.getMe = async (req, res) => {
    try {
        // req.user is attached by the protect middleware
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.status === 'inactive') {
            return res.status(401).json({
                success: false,
                message: 'Account is deactivated. Contact your administrator.'
            });
        }

        // Mid-session tenant lockout: if Super Admin suspended this user's
        // restaurant after they logged in, kill the session here.
        const tenantLock = await assertTenantNotLocked(user);
        if (tenantLock) return res.status(tenantLock.status).json(tenantLock.body);

        return res.status(200).json({
            success: true,
            user: await buildAuthResponse(user),
        });
    } catch (err) {
        logger.error('GetMe error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to fetch user' });
    }
};

// ─── PUT /api/auth/profile ──────────────────────────────────────────────────
// Protected — allows a customer to update their own profile fields.
// Updatable: name, mobile, allergy, avatar
// NOT updatable: email, role, password (use dedicated endpoints for those)
//
// Request body: { name?, mobile?, allergy?, avatar? }
// Response:     { success, user: { ...userPayload } }

// ─── OTP (#11) ───────────────────────────────────────────────────────────────
// 6-digit codes (1,000,000 options), stored as an HMAC, compared in
// constant time. Each code allows OTP_MAX_ATTEMPTS guesses — enforced by an
// atomic $inc guarded by `attempts < MAX` in the filter, so parallel
// guesses cannot exceed it — and is then burned. Sends are capped per
// mobile per UTC day (OTP_DAILY_SEND_CAP, default 10) and at 3 per 5 min.
// Worst case for an attacker: 10 codes × 5 guesses = 50 guesses/day,
// i.e. ~1 in 20,000 per day per account.
const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const otpDailyCap = () => {
    const n = Number(process.env.OTP_DAILY_SEND_CAP);
    return Number.isFinite(n) && n > 0 ? n : 10;
};

// normalizeMobile — utils/mobile.js (shared with hotel self-signup).

const otpKey = () => process.env.OTP_SECRET || process.env.JWT_SECRET;
const hashOtp = (mobile, code) =>
    crypto.createHmac('sha256', otpKey()).update(`${mobile}:${code}`).digest('hex');

function otpMatches(record, mobile, code) {
    const candidate = Buffer.from(hashOtp(mobile, code), 'hex');
    // Rows written before #11 store the plain 4-digit code.
    const storedHex = /^[0-9a-f]{64}$/.test(record.code) ? record.code : hashOtp(mobile, record.code);
    const expected = Buffer.from(storedHex, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ─── POST /api/auth/send-otp ───────────────────────────────────────────────
// Public — sends a 6-digit OTP to the given mobile number via the
// configured SMS provider. The code is never returned in the response.

exports.sendOtp = async (req, res) => {
    try {
        const cleanMobile = normalizeMobile(req.body?.mobile);
        if (!cleanMobile) {
            return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit mobile number' });
        }

        // Short-window limit (3 sends / 5 min). Otp rows are TTL-reaped at
        // expiry (5 min), so this is the longest window they can count.
        const windowStart = new Date(Date.now() - OTP_TTL_MS);
        const recentSends = await Otp.countDocuments({
            mobile: cleanMobile,
            createdAt: { $gt: windowStart },
        });
        if (recentSends >= 3) {
            return res.status(429).json({
                success: false,
                code: 'OTP_SEND_RATE_LIMIT',
                message: 'Too many OTP requests. Please wait a few minutes before trying again.',
            });
        }

        // Per-mobile daily cap — atomic $inc on a (mobile, day) counter.
        const day = new Date().toISOString().slice(0, 10);
        const counterExpiry = new Date(`${day}T00:00:00.000Z`);
        counterExpiry.setUTCDate(counterExpiry.getUTCDate() + 2);
        let counter;
        try {
            counter = await OtpSendCounter.findOneAndUpdate(
                { mobile: cleanMobile, day },
                { $inc: { count: 1 }, $setOnInsert: { expiresAt: counterExpiry } },
                { upsert: true, returnDocument: 'after' },
            );
        } catch (e) {
            if (e?.code !== 11000) throw e;
            // Concurrent first send of the day — the other upsert won.
            counter = await OtpSendCounter.findOneAndUpdate(
                { mobile: cleanMobile, day },
                { $inc: { count: 1 } },
                { returnDocument: 'after' },
            );
        }
        if (!counter || counter.count > otpDailyCap()) {
            return res.status(429).json({
                success: false,
                code: 'OTP_DAILY_LIMIT',
                message: 'Too many OTP requests for this number today. Please try again tomorrow or sign in with email.',
            });
        }

        // Supersede any unverified OTPs for this mobile (mark them
        // verified=true so verifyOtp can only find the newest one)
        // instead of deleting — we need the history for rate counting.
        await Otp.updateMany(
            { mobile: cleanMobile, verified: false },
            { $set: { verified: true } }
        );

        const code = crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');

        await Otp.create({
            mobile: cleanMobile,
            code: hashOtp(cleanMobile, code),
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
        });

        const smsSent = await sendOtpSms(cleanMobile, code);
        if (!smsSent && process.env.NODE_ENV !== 'production') {
            // Dev convenience only — no SMS provider configured locally.
            logger.info(`[DEV] OTP for ${cleanMobile}: ${code}`);
        }

        return res.status(200).json({
            success: true,
            message: smsSent ? 'OTP sent to your mobile' : 'OTP generated (SMS not configured)',
        });
    } catch (err) {
        logger.error('SendOTP error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
};

// ─── POST /api/auth/verify-otp ─────────────────────────────────────────────
// Public — verifies the OTP. If valid, finds or creates a customer account
// linked to that mobile number, then returns a session.

// Name given to a customer created by a first-time OTP login (no name is
// collected on that screen). See `needsName` in the verifyOtp response.
const OTP_PLACEHOLDER_NAME = 'Guest';

exports.verifyOtp = async (req, res) => {
    try {
        const cleanMobile = normalizeMobile(req.body?.mobile);
        const code = typeof req.body?.code === 'string' || typeof req.body?.code === 'number'
            ? String(req.body.code).trim()
            : '';

        if (!cleanMobile || !code) {
            return res.status(400).json({ success: false, message: 'Mobile number and OTP are required' });
        }
        if (!/^\d{4,6}$/.test(code)) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        const now = new Date();
        const otpRecord = await Otp.findOne({
            mobile: cleanMobile,
            expiresAt: { $gt: now },
            verified: false,
        }).sort({ createdAt: -1 });

        if (!otpRecord) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        // Legacy lockout rows (pre-#11) — honour until they expire.
        if (otpRecord.lockedUntil && otpRecord.lockedUntil > now) {
            return res.status(429).json({
                success: false,
                code: 'OTP_LOCKED',
                message: 'Too many wrong attempts. Please request a new code.',
            });
        }

        // Reserve one attempt atomically BEFORE comparing. The
        // `attempts < MAX` guard in the filter means N parallel requests
        // can never get more than MAX comparisons against one code.
        const reserved = await Otp.findOneAndUpdate(
            { _id: otpRecord._id, verified: false, attempts: { $lt: OTP_MAX_ATTEMPTS } },
            { $inc: { attempts: 1 } },
            { returnDocument: 'after' },
        );
        if (!reserved) {
            return res.status(429).json({
                success: false,
                code: 'OTP_ATTEMPTS_EXCEEDED',
                message: 'Too many wrong attempts. Please request a new code.',
            });
        }

        if (!otpMatches(reserved, cleanMobile, code)) {
            const remaining = OTP_MAX_ATTEMPTS - reserved.attempts;
            if (remaining <= 0) {
                // Burn the code — a fresh one must be requested (and sends
                // are capped per day).
                await Otp.updateOne(
                    { _id: reserved._id, verified: false },
                    { $set: { verified: true, lockedUntil: new Date() } },
                );
                return res.status(429).json({
                    success: false,
                    code: 'OTP_ATTEMPTS_EXCEEDED',
                    message: 'Too many wrong attempts. Please request a new code.',
                });
            }
            return res.status(401).json({ success: false, code: 'OTP_INVALID', message: 'Invalid OTP' });
        }

        // Consume atomically so two concurrent correct submissions can't
        // both mint a session from one code.
        const consumed = await Otp.findOneAndUpdate(
            { _id: reserved._id, verified: false },
            { $set: { verified: true } },
        );
        if (!consumed) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        // Staff / super-admin accounts are never allowed to authenticate
        // through the customer OTP flow. If this mobile belongs to a
        // non-customer user, refuse to mint a token — even though the
        // OTP was valid — so staff can't slip into the customer portal
        // (and, worse, end up holding a JWT with their staff role).
        const staffMatch = await User.findOne({
            mobile: cleanMobile,
            role: { $ne: 'customer' },
        }).select('_id');
        if (staffMatch) {
            return res.status(403).json({
                success: false,
                code: 'STAFF_OTP_BLOCKED',
                message: 'This number is registered to a staff account. Please sign in from the Staff Portal.',
            });
        }

        // Find existing customer by mobile or create a new one
        let user = await User.findOne({ mobile: cleanMobile, role: 'customer' });

        if (!user) {
            try {
                user = await User.create({
                    // User.name is required, so an empty name failed
                    // validation (500 on every first-time OTP login).
                    // 'Guest' is the same fallback the UI already shows
                    // for nameless customers; `needsName` in the
                    // response tells the client to ask for the real one
                    // (Profile -> updateProfile).
                    name: OTP_PLACEHOLDER_NAME,
                    email: `${cleanMobile}@phone.local`, // placeholder email
                    password: crypto.randomBytes(16).toString('hex'), // random password
                    mobile: cleanMobile,
                    role: 'customer',
                });
            } catch (createErr) {
                // Two simultaneous verifications for the same number —
                // the other one created the customer. Customer-scoped so
                // a collision can never hand out a staff session.
                if (createErr?.code !== 11000) throw createErr;
                user = await User.findOne({ mobile: cleanMobile, role: 'customer' });
                if (!user) throw createErr;
            }
        }

        if (user.status === 'inactive') {
            return res.status(401).json({
                success: false,
                message: 'Account is deactivated. Contact your administrator.',
            });
        }

        const session = await issueSession(req, res, user);
        return res.status(200).json({
            success: true,
            ...(await buildAuthResponse(user)),
            ...session,
            // True while the account still carries the OTP-signup
            // placeholder name (never set a real one via /auth/profile).
            needsName: user.name === OTP_PLACEHOLDER_NAME
                && String(user.email || '').endsWith('@phone.local'),
        });
    } catch (err) {
        logger.error('VerifyOTP error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'OTP verification failed' });
    }
};

// ─── POST /api/auth/logout ────────────────────────────────────────────────
// Revokes the presented refresh token (body.refreshToken) and clears the
// CRIT-08 cookie. Safe to call without either (no-op). Always returns 200
// so the FE can call it unconditionally from its logout flow.
exports.logout = async (req, res) => {
    try {
        const raw = req.body?.refreshToken;
        if (typeof raw === 'string' && raw && raw.length <= 200) {
            await RefreshSession.updateOne(
                { tokenHash: sha256(raw), revokedAt: null },
                { $set: { revokedAt: new Date() } },
            );
        }
        // Close the auto-opened staff shift. `req.user` is populated by
        // the globally-mounted optionalAuth middleware (see server.js —
        // v1.use(optionalAuth)). No-op for any role outside
        // SHIFT_AUTO_ROLES or for unauth'd hits.
        await closeShiftOnLogout(req.user);
        clearAuthCookie(res);
        return res.status(200).json({ success: true, message: 'Logged out' });
    } catch (err) {
        logger.error('Logout error:', { error: err.message });
        clearAuthCookie(res);
        return res.status(200).json({ success: true, message: 'Logged out' });
    }
};

// ─── POST /api/auth/logout-all ─────────────────────────────────────────────
// Protected — ends every session of the current user on every device.
exports.logoutAll = async (req, res) => {
    try {
        await revokeAllSessions(req.user._id);
        await closeShiftOnLogout(req.user);
        clearAuthCookie(res);
        return res.status(200).json({ success: true, message: 'Logged out of all devices' });
    } catch (err) {
        logger.error('LogoutAll error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Could not log out of all devices' });
    }
};

// ─── POST /api/auth/refresh ────────────────────────────────────────────────
// Public (the access token may already be expired). Body: { refreshToken }.
// Rotates the refresh token and returns { token, refreshToken }.
exports.refresh = async (req, res) => {
    const invalid = (code = 'REFRESH_INVALID') => res.status(401).json({
        success: false,
        code,
        message: 'Your session has ended. Please sign in again.',
    });
    try {
        const raw = req.body?.refreshToken;
        if (typeof raw !== 'string' || !raw || raw.length > 200) return invalid();

        const tokenHash = sha256(raw);
        const now = new Date();

        // Atomically claim the live session (revoke-on-use).
        let session = await RefreshSession.findOneAndUpdate(
            { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
            { $set: { revokedAt: now, rotatedAt: now } },
            { returnDocument: 'before' },
        );

        if (!session) {
            const prior = await RefreshSession.findOne({ tokenHash }).lean();
            if (!prior) return invalid();
            if (prior.expiresAt <= now) {
                // A customer token that lapsed = the inactivity timeout
                // (N14) — tell the client so it can say "session expired".
                const owner = await User.findById(prior.user).select('role').lean();
                return invalid(owner && isCustomerRole(owner.role) ? 'SESSION_IDLE_TIMEOUT' : 'REFRESH_INVALID');
            }
            const inGrace = prior.rotatedAt && (now - new Date(prior.rotatedAt)) < REFRESH_REUSE_GRACE_MS;
            if (!inGrace) {
                // A rotated/revoked token came back: assume it was stolen
                // and kill the whole chain.
                await RefreshSession.updateMany(
                    { family: prior.family, revokedAt: null },
                    { $set: { revokedAt: now } },
                );
                logger.warn('auth.refresh.reuse-detected', { userId: String(prior.user) });
                return invalid('REFRESH_REUSED');
            }
            session = prior;
        }

        const user = await User.findById(session.user);
        if (!user || user.status !== 'active') return invalid();
        if ((Number(user.tokenVersion) || 0) !== (Number(session.tv) || 0)) return invalid('SESSION_REVOKED');

        // ── Customer inactivity timeout (QA N14) ──────────────────
        // Two signals, either ends the session:
        //   1. server: time since this token was issued (lastUsedAt —
        //      every refresh issues a new row, so this is "time since
        //      the session was last used"). `expiresAt` already enforces
        //      it; this catches rows from before the change (30-day
        //      expiresAt) and clock-edge cases.
        //   2. client: `idleMs` — time since the customer last touched
        //      the app. The customer app polls in the background, and a
        //      poll that renews the token is not the customer "using"
        //      the session; the browser reports real interaction.
        if (isCustomerRole(user.role)) {
            const idleLimit = customerIdleMs();
            const lastUsed = new Date(session.lastUsedAt || session.createdAt || now).getTime();
            const reportedIdle = Number(req.body?.idleMs);
            const idleServer = now.getTime() - lastUsed;
            const idleClient = Number.isFinite(reportedIdle) && reportedIdle > 0 ? reportedIdle : 0;
            if (idleServer >= idleLimit || idleClient >= idleLimit) {
                // Expire (not just revoke) the family so a replay reads as
                // a lapsed session, not as token theft.
                await RefreshSession.updateMany(
                    { family: session.family, revokedAt: null },
                    { $set: { revokedAt: now } },
                );
                await RefreshSession.updateMany(
                    { family: session.family },
                    { $set: { expiresAt: now } },
                );
                logger.info('auth.refresh.idle-timeout', {
                    userId: String(user._id),
                    idleMs: Math.max(idleServer, idleClient),
                });
                return invalid('SESSION_IDLE_TIMEOUT');
            }
        }

        // ── Absolute session ceiling ──────────────────────────────
        // The check that actually ends a session. `expiresAt` resets on
        // every rotation, so without this a client that keeps
        // refreshing is never signed out — a tab left open overnight
        // renews itself indefinitely.
        //
        // Rows written before this field existed carry no ceiling.
        // Backfill one from the row's own creation time using the
        // USER's role (the session row has no role of its own), so
        // existing logins age out on the correct schedule instead of
        // living forever.
        const ceiling = session.familyExpiresAt
            || new Date(new Date(session.createdAt || now).getTime() + refreshAbsoluteMs(user.role));

        if (ceiling <= now) {
            // Kill the whole family: the ceiling applies to the login,
            // not to any one token within it.
            await RefreshSession.updateMany(
                { family: session.family, revokedAt: null },
                { $set: { revokedAt: now } },
            );
            logger.info('auth.refresh.session-expired', {
                userId: String(user._id),
                role: user.role,
                family: session.family,
            });
            return invalid('SESSION_EXPIRED');
        }

        const tenantLock = await assertTenantNotLocked(user);
        if (tenantLock) return res.status(tenantLock.status).json(tenantLock.body);

        // Pass the ceiling through so the new token inherits it rather
        // than starting a fresh one.
        const tokens = await issueSession(req, res, user, session.family, ceiling);
        return res.status(200).json({ success: true, ...tokens });
    } catch (err) {
        logger.error('Refresh error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Could not refresh session' });
    }
};

// ─── PUT /api/auth/change-password ──────────────────────────────────────────
// Protected — allows any authenticated user to change their own password.
// Requires current password for verification.
//
// Request body: { currentPassword, newPassword }
// Response:     { success, message }

exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string'
            || !currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        if (!PASSWORD_REGEX.test(newPassword)) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 8 characters with uppercase, lowercase, number, and special character'
            });
        }

        // Fetch user with password field included
        const user = await User.findById(req.user._id).select('+password');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify current password
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        // Update password (hashed by pre-save hook) and clear forced-change flag.
        // Only validate modified fields so legacy users with stale data
        // (e.g. pre-validator mobile values) can still change their password.
        user.password = newPassword;
        user.mustChangePassword = false;
        await user.save({ validateModifiedOnly: true });

        // #15 — a password change ends every other session (a thief
        // holding an old token is locked out). The caller gets a fresh
        // session so this device stays signed in.
        const updated = await revokeAllSessions(user._id);
        const session = await issueSession(req, res, updated || user);

        return res.status(200).json({ success: true, message: 'Password changed successfully', ...session });
    } catch (err) {
        logger.error('ChangePassword error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to change password' });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const {
            name, mobile, allergy, avatar,
            dob, anniversary, gender, dietaryPreference, address,
            preferredLanguage,
        } = req.body || {};

        // Text fields must be strings (null clears) — a number / object /
        // array is a client error, not a TypeError (500) on .trim().
        for (const [key, value] of Object.entries({ name, mobile, allergy, avatar })) {
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return res.status(400).json({ success: false, message: `${key} must be text` });
            }
        }

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // ── Validate inputs ─────────────────────────────────────────────
        if (name !== undefined) {
            const trimmed = (name || '').trim();
            if (!trimmed) {
                return res.status(400).json({ success: false, message: 'Name cannot be empty' });
            }
            if (trimmed.length > 100) {
                return res.status(400).json({ success: false, message: 'Name cannot exceed 100 characters' });
            }
            user.name = trimmed;
        }

        if (mobile !== undefined) {
            const cleaned = (mobile || '').trim();
            // Allow empty (clears the field) or valid Indian mobile format
            if (cleaned && !MOBILE_REGEX.test(cleaned)) {
                return res.status(400).json({ success: false, message: 'Please provide a valid 10-digit mobile number' });
            }
            user.mobile = cleaned;
        }

        if (allergy !== undefined) {
            const trimmed = (allergy || '').trim();
            if (trimmed.length > 1000) {
                return res.status(400).json({ success: false, message: 'Allergy text cannot exceed 1000 characters' });
            }
            user.allergy = trimmed;
        }

        if (avatar !== undefined) {
            // Reject dangerous URL schemes (XSS prevention)
            const trimmed = (avatar || '').trim();
            if (trimmed && !/^(https?:)?\/\//i.test(trimmed) && !trimmed.startsWith('/uploads/')) {
                return res.status(400).json({ success: false, message: 'Avatar must be a valid HTTP(S) URL or uploaded file path' });
            }
            user.avatar = trimmed;
        }

        // ── Global customer-identity fields ─────────────────────────────
        // Each accepts an empty string / null to clear the value. Done
        // string-equality first so client can send '' to wipe a saved
        // value without tripping schema validation.
        if (dob !== undefined) {
            if (dob === null || dob === '') {
                user.dob = null;
            } else {
                const d = new Date(dob);
                if (Number.isNaN(d.getTime()) || d >= new Date() || d <= new Date('1900-01-01')) {
                    return res.status(400).json({ success: false, message: 'Please provide a valid date of birth' });
                }
                user.dob = d;
            }
        }

        if (anniversary !== undefined) {
            if (anniversary === null || anniversary === '') {
                user.anniversary = null;
            } else {
                const d = new Date(anniversary);
                if (Number.isNaN(d.getTime()) || d >= new Date() || d <= new Date('1950-01-01')) {
                    return res.status(400).json({ success: false, message: 'Please provide a valid anniversary date' });
                }
                user.anniversary = d;
            }
        }

        if (gender !== undefined) {
            const allowed = ['', 'male', 'female', 'other', 'prefer_not_to_say'];
            if (!allowed.includes(gender)) {
                return res.status(400).json({ success: false, message: 'Invalid gender value' });
            }
            user.gender = gender;
        }

        if (dietaryPreference !== undefined) {
            const allowed = ['', 'veg', 'non_veg', 'vegan', 'eggetarian', 'jain'];
            if (!allowed.includes(dietaryPreference)) {
                return res.status(400).json({ success: false, message: 'Invalid dietary preference' });
            }
            user.dietaryPreference = dietaryPreference;
        }

        if (preferredLanguage !== undefined) {
            const allowed = ['', 'en', 'hi', 'mr'];
            if (!allowed.includes(preferredLanguage)) {
                return res.status(400).json({ success: false, message: 'Invalid language' });
            }
            user.preferredLanguage = preferredLanguage;
        }

        if (address !== undefined && address !== null && typeof address === 'object') {
            // Per-field length / format checks happen in the schema; here
            // we just trim and copy the keys we know about. Anything else
            // sent in the address blob is silently dropped.
            const a = user.address || {};
            const fields = ['line1', 'line2', 'city', 'state', 'pincode', 'landmark'];
            const trimmedPincode = (address.pincode ?? '').toString().trim();
            if (trimmedPincode && !/^[1-9]\d{5}$/.test(trimmedPincode)) {
                return res.status(400).json({ success: false, message: 'Pincode must be a valid 6-digit Indian pincode' });
            }
            for (const k of fields) {
                if (address[k] !== undefined) {
                    a[k] = (address[k] ?? '').toString().trim();
                }
            }
            user.address = a;
        }

        // Only validate fields that the user actually modified in this
        // request. Without this, Mongoose re-validates every field on the
        // document, which fails for legacy users whose stored mobile (or
        // any other field) predates a stricter validator.
        await user.save({ validateModifiedOnly: true });

        return res.status(200).json({
            success: true,
            user: await buildAuthResponse(user),
        });
    } catch (err) {
        logger.error('UpdateProfile error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
};

// ─── Avatar upload (any authenticated user) ──────────────────────────────────
// Customers can't hit /api/v1/upload (admin-only). This route lets any
// authenticated user upload their own avatar via multipart/form-data.
// Compresses the buffer with Sharp and pushes it to Cloudinary so the
// deploy host doesn't need a writable disk.
exports.uploadAvatar = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an image file' });
        }

        const { compressAndUpload } = require('../utils/cloudinaryUploader');
        const result = await compressAndUpload({
            buffer:       req.file.buffer,
            mimetype:     req.file.mimetype,
            originalname: req.file.originalname,
            folder:       'bestodine/avatars',
            maxWidth:     512,                   // matches the legacy disk pipeline
        });

        // Persist the full Cloudinary URL on the user record. Frontend's
        // resolveAvatar / resolveImageUrl passes any URL not starting
        // with /uploads/ through unchanged — including the Cloudinary
        // CDN URL — so no frontend code needs touching.
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        user.avatar = result.secure_url;
        // Only validate the modified field — don't re-trigger validators
        // on legacy mobile/email values stored before the schema tightened.
        await user.save({ validateModifiedOnly: true });

        return res.status(200).json({
            success: true,
            url: result.secure_url,
            user: await buildAuthResponse(user),
        });
    } catch (err) {
        logger.error('UploadAvatar error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to upload avatar' });
    }
};

// ─────────────────────────────────────────────────────────────────────
// Password reset (customer accounts)
// ─────────────────────────────────────────────────────────────────────
//
// There was previously no reset path at all. The customer login page's
// "Forgot password?" link called a handler that popped a toast reading
// "Password reset link will be sent to your email" and did nothing
// else — no endpoint, no token, no mail. A customer who forgot their
// password had no way back into their account.
//
// The uniform 200 from forgotPassword is not laziness. Answering "no
// such account" turns the endpoint into an account-existence oracle:
// anyone could submit a list of addresses and learn which of them dine
// here. That is a privacy leak about real people, so the response is
// identical either way and the real signal lives only in the inbox.

const RESET_TOKEN_TTL_MINUTES = 30;

/** SHA-256. The DB stores only this; the raw token exists in the email. */
const hashResetToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

exports.forgotPassword = async (req, res) => {
    // Generic reply used on every path — success, unknown address,
    // staff account, or send failure. Declared once so a future edit
    // cannot accidentally make one branch distinguishable.
    const genericOk = () => res.status(200).json({
        success: true,
        message: 'If an account exists for that email, a reset link is on its way.',
    });

    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!email || !EMAIL_REGEX.test(email)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
        }

        const PasswordResetToken = require('../models/passwordResetToken');
        const user = await User.findOne({ email });

        // Unknown address, or a staff account: staff passwords are
        // rotated by an admin through the staff console, so a
        // self-service email reset would be a second, weaker way into
        // a privileged account.
        if (!user || (user.role && user.role !== 'customer')) {
            return genericOk();
        }

        // Rate limit per account. Without it this endpoint is a free
        // mail cannon pointed at any address the attacker names.
        const recentCount = await PasswordResetToken.countDocuments({
            user: user._id,
            createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) },
        });
        if (recentCount >= 3) {
            logger.warn('auth.forgot-password.throttled', { userId: String(user._id) });
            return genericOk();
        }

        // Invalidate outstanding tokens — requesting a new link should
        // retire the old one, so an intercepted earlier mail dies.
        await PasswordResetToken.updateMany(
            { user: user._id, usedAt: null },
            { $set: { usedAt: new Date() } },
        );

        const rawToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

        await new PasswordResetToken({
            user: user._id,
            restaurant: user.restaurant || null,
            tokenHash: hashResetToken(rawToken),
            expiresAt,
            requestedIp: req.ip,
        }).save();

        const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
        const resetUrl = frontend + '/reset-password?token=' + rawToken;

        let restaurantName = 'BestoDine';
        try {
            if (user.restaurant) {
                const r = await Restaurant.findById(user.restaurant).select('name').lean();
                if (r && r.name) restaurantName = r.name;
            }
        } catch { /* branding is cosmetic — never block the reset on it */ }

        const { sendEmail } = require('../utils/email');
        const { customerPasswordReset } = require('../utils/emailTemplates');
        const mail = customerPasswordReset({
            customerName: user.name,
            resetUrl,
            restaurantName,
            expiryMinutes: RESET_TOKEN_TTL_MINUTES,
        });

        const result = await sendEmail({
            to: user.email,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
        });

        if (result && !result.sent && !result.dev) {
            // Log loudly — a silently-failing reset flow looks fine to
            // the user and generates support tickets nobody can trace.
            logger.error('auth.forgot-password.send-failed', {
                userId: String(user._id),
                error: result.error,
            });
        }

        return genericOk();
    } catch (err) {
        logger.error('ForgotPassword error:', { error: err.message });
        // Still generic: an error must not reveal existence either.
        return res.status(200).json({
            success: true,
            message: 'If an account exists for that email, a reset link is on its way.',
        });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || typeof token !== 'string') {
            return res.status(400).json({ success: false, code: 'TOKEN_REQUIRED', message: 'Reset token is missing.' });
        }
        // Same policy as registration and change-password. Enforced
        // here too: a reset must not be a back door to a weak password.
        if (!newPassword || !CUSTOMER_PASSWORD_REGEX.test(newPassword)) {
            return res.status(400).json({
                success: false,
                code: 'WEAK_PASSWORD',
                message: CUSTOMER_PASSWORD_MESSAGE,
            });
        }

        const PasswordResetToken = require('../models/passwordResetToken');
        const record = await PasswordResetToken.findOne({ tokenHash: hashResetToken(token) });

        // One message for missing / used / expired. Distinguishing them
        // tells a token-guesser which guesses were once valid.
        const invalid = () => res.status(400).json({
            success: false,
            code: 'TOKEN_INVALID',
            message: 'This reset link is invalid or has expired. Please request a new one.',
        });

        if (!record || record.usedAt || record.expiresAt < new Date()) return invalid();

        const user = await User.findById(record.user);
        if (!user) return invalid();

        // Burn the token BEFORE saving the password. If the save fails,
        // a spent token is the safe failure mode; a live one is not.
        record.usedAt = new Date();
        await record.save();

        // The User model pre-save hook hashes this — assigning the
        // plaintext is correct here, matching changePassword.
        user.password = newPassword;
        // A Google-only user who completes a reset has just gained a
        // second way in. Record it, so authProviders stays an honest
        // description of how this account can authenticate.
        if (!user.authProviders?.includes('password')) {
            user.authProviders = [...(user.authProviders || []), 'password'];
        }
        await user.save({ validateModifiedOnly: true });

        // #15 — whoever knew the old password is logged out everywhere.
        await revokeAllSessions(user._id);

        logger.info('auth.reset-password.success', { userId: String(user._id) });

        return res.status(200).json({
            success: true,
            message: 'Password updated. You can now log in with your new password.',
        });
    } catch (err) {
        logger.error('ResetPassword error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Could not reset password. Please try again.' });
    }
};

// ─────────────────────────────────────────────────────────────────────
// Google Sign-In (customer accounts)
// ─────────────────────────────────────────────────────────────────────
//
// POST /auth/google  { credential: "<Google ID token>" }
//
// The browser obtains the ID token from Google Identity Services and
// posts it here. utils/googleAuth verifies the signature, the audience
// (that it was minted for US, not some other Google app) and the
// issuer. Everything below assumes that verification passed.
//
// ── The account-linking decision ─────────────────────────────────────
//
// The hard case: somebody already registered a@b.com with a password,
// and now clicks "Sign in with Google" on a Google account whose email
// is also a@b.com. Do we hand them the existing account?
//
// We link ONLY when Google asserts email_verified === true.
//
// Why that condition is load-bearing: anyone can create a Google
// Workspace on a domain they control and mint a token claiming any
// address at it. Without email_verified, "sign in with Google" becomes
// a way to take over any account whose email address you can guess.
// With it, Google is vouching that this person controls this mailbox —
// which is exactly the assurance a password-reset email provides, so
// linking is no weaker than the recovery path we already trust.
//
// If email_verified is false we do not link, do not create, and do not
// explain which of the two it was. The user is told to sign in with
// their password.
//
// ── Why staff are excluded ───────────────────────────────────────────
//
// Staff credentials are issued and rotated by an admin through the
// staff console. Letting a chef attach a personal Gmail to their
// account would create a second, weaker door into a privileged account
// that the restaurant owner cannot see or revoke. Same reasoning as
// forgotPassword, which is customer-only for identical reasons.

exports.googleLogin = async (req, res) => {
    const { verifyGoogleIdToken, isGoogleAuthConfigured } = require('../utils/googleAuth');

    // A deployment that hasn't set GOOGLE_CLIENT_ID shouldn't render the
    // button at all (the frontend checks too), but answer honestly if
    // the endpoint is hit anyway.
    if (!isGoogleAuthConfigured()) {
        return res.status(503).json({
            success: false,
            code: 'GOOGLE_AUTH_UNAVAILABLE',
            message: 'Google Sign-In is not enabled for this restaurant.',
        });
    }

    // One generic failure for every rejection below. The specific
    // reason goes to the log, never to the client: "this email belongs
    // to a staff account" and "that account exists but Google hasn't
    // verified the address" are both useful to an attacker mapping the
    // platform. Mirrors the CRIT-07 reasoning on /register.
    const GENERIC_FAIL = 'Could not sign you in with Google. Please use your email and password.';
    const reject = (logCode, detail) => {
        logger.warn('auth.google.rejected', { code: logCode, detail });
        return res.status(401).json({ success: false, code: 'GOOGLE_AUTH_FAILED', message: GENERIC_FAIL });
    };

    try {
        const idToken = req.body.credential || req.body.idToken;

        let profile;
        try {
            profile = await verifyGoogleIdToken(idToken);
        } catch (err) {
            // Covers a forged token, an expired one, a token minted for
            // a different app, and a Google outage. All indistinguishable
            // to the caller by design.
            return reject('TOKEN_INVALID', err.message);
        }

        const { googleId, email, emailVerified, name, picture } = profile;
        // Defensive: `{ googleId: undefined/null }` would match every
        // password-only user (they have no googleId field at all).
        if (typeof googleId !== 'string' || !googleId) {
            return reject('TOKEN_NO_SUBJECT', 'missing sub');
        }

        // ── Match on googleId FIRST ──────────────────────────────────
        // `sub` is permanent; a Google account's email address is not.
        // Someone who changes their Gmail address must still land on
        // their own account, not a new one.
        let user = await User.findOne({ googleId });

        if (!user) {
            // No googleId match — fall back to email, which is either a
            // first-ever Google sign-in or a brand-new customer.
            const existing = await User.findOne({ email });

            if (existing) {
                // Staff accounts never authenticate via Google.
                if (existing.role && existing.role !== 'customer') {
                    return reject('STAFF_ACCOUNT', `role=${existing.role}`);
                }
                // THE linking gate. See the header comment.
                if (!emailVerified) {
                    return reject('EMAIL_UNVERIFIED', email);
                }

                existing.googleId = googleId;
                if (!existing.authProviders.includes('google')) {
                    existing.authProviders.push('google');
                }
                // Fill in an avatar only if they have none of their own —
                // never overwrite a picture the customer chose.
                if (picture && !existing.avatar) existing.avatar = picture;

                // validateModifiedOnly so a legacy row with, say, a null
                // mobile doesn't fail validation on an unrelated save.
                await existing.save({ validateModifiedOnly: true });
                user = existing;
            } else {
                // Brand-new customer. Refuse to create an account from an
                // unverified address — an unverified signup would let
                // someone squat an email they don't own, and then block
                // the real owner from ever registering it.
                if (!emailVerified) {
                    return reject('EMAIL_UNVERIFIED_NEW', email);
                }

                user = await User.create({
                    name: (name || email.split('@')[0]).trim(),
                    email,
                    googleId,
                    authProviders: ['google'],
                    // No password. The schema makes it conditional on
                    // googleId precisely so we don't have to invent one.
                    avatar: picture || undefined,
                    // Google never supplies a phone number. Left blank;
                    // `needsMobile` below tells the client to ask.
                    mobile: '',
                    role: 'customer',
                });
                logger.info('auth.google.registered', { userId: String(user._id) });
            }
        }

        // ── Account status ───────────────────────────────────────────
        if (user.status === 'inactive') {
            return res.status(401).json({
                success: false,
                message: 'Account is deactivated. Contact your administrator.',
            });
        }

        // A staff account that somehow carries a googleId (e.g. a
        // customer later promoted to staff) still may not use this door.
        if (user.role !== 'customer') {
            return reject('STAFF_ACCOUNT_BY_ID', `role=${user.role}`);
        }

        // Same tenant suspension check every other login path runs.
        const tenantLock = await assertTenantNotLocked(user);
        if (tenantLock) return res.status(tenantLock.status).json(tenantLock.body);

        const session = await issueSession(req, res, user);

        return res.status(200).json({
            success: true,
            ...(await buildAuthResponse(user)),
            ...session,
            // Google supplies no phone number, and orders need one. The
            // client uses this to prompt for a mobile after sign-in
            // rather than discovering the gap at checkout.
            needsMobile: !user.mobile,
        });
    } catch (err) {
        logger.error('GoogleLogin error:', { error: err.message });
        return res.status(500).json({
            success: false,
            message: 'Could not complete Google Sign-In. Please try again.',
        });
    }
};
