const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const logger = require('../utils/logger');
const cacheBus = require('../utils/cacheBus');
const {
    getContext,
    runWithContext,
    updateContext,
    contextFromRequest,
} = require('../utils/requestContext');

/**
 * BUGS_REPORT #30 — continue the chain inside a request-scoped
 * AsyncLocalStorage context carrying the resolved tenant/branch/user, so
 * utils/tenantScopePlugin.js can auto-scope queries that forgot
 * tenantFilter(req). Superadmin and exempt paths get tenantId: null
 * (plugin no-op). Route-level re-mounts of attachTenant update the
 * existing store instead of nesting a new one.
 */
function proceed(req, next) {
    const store = contextFromRequest(req);
    if (getContext()) {
        updateContext(store);
        return next();
    }
    return runWithContext(store, () => next());
}

/**
 * Tenant context resolution for the BestoDine SaaS platform.
 *
 * Every authenticated, tenant-scoped request needs to know "which
 * restaurant is this for?". This module exposes two flavors of the
 * resolver, both safe to mount on existing routes:
 *
 *   attachTenant     — populates req.restaurant; rejects non-exempt
 *                      requests with 400 TENANT_REQUIRED when no
 *                      tenant can be resolved (Phase 3 step 5).
 *   requireTenant    — identical behaviour; kept as an alias for
 *                      call sites that want the intent spelled out.
 *
 * Resolution order (first hit wins):
 *
 *   1. SUPER ADMIN:     never scoped — req.restaurant = null
 *   2. STAFF:           req.user.restaurant (set at login)
 *   3. CUSTOMER/GUEST:  X-Restaurant-Slug header (frontend writes this
 *                       after BranchSelection / ScanTable)
 *   4. CUSTOMER/GUEST:  ?restaurant=<slug> query-param fallback
 *
 * If none of those match and the path is NOT on the exempt list, the
 * request is rejected with 400 `TENANT_REQUIRED`. There is no longer
 * a "default tenant" fallback — that was a Phase 1 migration safety
 * net and was removed in Phase 3 step 5. The seed row and the
 * seedDefaultTenant.js backfill script are still around because the
 * script is useful for bootstrapping a fresh Mongo from legacy data.
 *
 * Suspended/cancelled tenants are HARD-blocked here so the platform-
 * level lockout from the Super Admin portal takes effect on every
 * authenticated API call without each controller having to remember.
 *
 * ── Exempt path prefixes ───────────────────────────────────────────────
 *
 * These routes legitimately operate without a tenant and are NEVER
 * rejected — even when no user/slug is present:
 *
 *   /public/*          — unauthenticated restaurant list / by-slug
 *   /auth/*            — login/register (tenant is not known yet)
 *   /superadmin/*      — platform-level
 *   /razorpay/webhook  — server-to-server, no tenant context
 *
 * The exempt list is centralized as STRICT_EXEMPT_PREFIXES so adding
 * a new unauthenticated route is a one-line change.
 *
 * ── Escape hatch: STRICT_TENANT_ENFORCEMENT=false ──────────────────────
 *
 * Setting the env var explicitly to `false` / `0` / `no` downgrades
 * the 400 rejects back to `req.restaurant = null` and lets the
 * request fall through. This is an emergency escape hatch ONLY — with
 * the field now `required: true` on every tenant-scoped model, any
 * write in that state will still throw a ValidationError. Meant for
 * one-off migration work or debugging, not normal operation.
 *
 * Cache: slug → restaurant lookups go through a 30-second in-process
 * LRU cache so high-traffic customer requests for the same slug only
 * hit Mongo once per window.
 */

// In-process micro-cache so we don't hit Mongo on every customer request
// for the same slug. Entries expire after 30s; the entire cache resets
// when the process restarts.
const slugCache = new Map();          // slug → { id, expires }
const SLUG_TTL_MS = 30 * 1000;

// Path prefixes that are exempt from tenant rejection. These are
// v1-relative (attachTenant runs on the v1 router, so req.path strips
// the /api/v1 prefix already).
// Each entry matches the exact path OR the path followed by '/'. Plain
// `startsWith` is NOT used — '/public' must not exempt '/publicXYZ'.
const STRICT_EXEMPT_PREFIXES = [
    '/public',
    '/auth',
    '/superadmin',
    '/razorpay/webhook',
    // QR scan is the tenant-discovery endpoint for the customer app.
    // The qrToken is cryptographically random and looked up globally;
    // the response establishes the tenant for all subsequent requests.
    // Requiring a tenant here causes a branch-selection redirect loop
    // after a QR scan clears the previous session's tenant.
    '/tables/scan',
];

// CRIT-01 — strict mode is ALWAYS on. The previous
// `STRICT_TENANT_ENFORCEMENT=false` escape hatch has been removed; it
// downgraded missing-tenant requests to `req.restaurant = null`, and
// any controller using `tenantFilter(req)` then got an empty Mongo
// filter that returned every tenant's documents at once.

function isStrictExempt(req) {
    // Segment-boundary match: '/public' and '/public/...' are exempt,
    // '/publicXYZ' is not.
    const path = req.path || '';
    for (const prefix of STRICT_EXEMPT_PREFIXES) {
        if (path === prefix || path.startsWith(prefix + '/')) {
            return true;
        }
    }
    return false;
}

function rejectStrict(req, res, reason) {
    logger.warn('tenant.resolve.strict-reject', {
        reason,
        method: req.method,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        userRole: req.user?.role || 'anonymous',
        slug: readSlugFromRequest(req) || null,
    });
    return res.status(400).json({
        success: false,
        code: 'TENANT_REQUIRED',
        message: 'This request could not be associated with a restaurant. Please pick a restaurant first.',
    });
}

// ── Phase 3 hardening telemetry ────────────────────────────────────────
// Counter for the "soft" null-restaurant fallback (which is now only
// reachable when STRICT_TENANT_ENFORCEMENT has been explicitly turned
// off). Kept so the /superadmin/tenant-fallback-stats probe can report
// zero if the escape hatch hasn't been used.
const tenantFallbackStats = {
    nullRestaurantHits: 0,
    byRoute: new Map(),
};

function recordFallback(kind, req) {
    tenantFallbackStats[kind]++;
    const routeKey = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path || ''}`.trim();
    const existing = tenantFallbackStats.byRoute.get(routeKey) || { null: 0 };
    existing.null++;
    tenantFallbackStats.byRoute.set(routeKey, existing);
    if (tenantFallbackStats.byRoute.size > 100) {
        const oldest = tenantFallbackStats.byRoute.keys().next().value;
        tenantFallbackStats.byRoute.delete(oldest);
    }
}

/** Snapshot of the fallback counters. Used by the /internal admin probe. */
function getTenantFallbackStats() {
    return {
        nullRestaurantHits: tenantFallbackStats.nullRestaurantHits,
        byRoute: Object.fromEntries(tenantFallbackStats.byRoute),
    };
}

function getCached(slug) {
    const hit = slugCache.get(slug);
    if (hit && hit.expires > Date.now()) return hit.id;
    if (hit) slugCache.delete(slug);
    return null;
}

function setCached(slug, id) {
    slugCache.set(slug, { id, expires: Date.now() + SLUG_TTL_MS });
    // Bound the cache so a malicious header can't grow it forever.
    if (slugCache.size > 200) {
        const oldest = slugCache.keys().next().value;
        slugCache.delete(oldest);
    }
}

// ── Cross-instance invalidation (utils/cacheBus.js, channel 'tenantSlug') ──
// Call after a restaurant's slug changes (rename) or it is suspended /
// cancelled / deleted, so an old slug stops resolving immediately on every
// instance instead of after SLUG_TTL_MS.
const SLUG_BUS_CHANNEL = 'tenantSlug';

function clearSlugLocal(slug) {
    if (!slug) return 0;
    return slugCache.delete(String(slug).trim().toLowerCase()) ? 1 : 0;
}

function clearTenantLocal(restaurantId) {
    if (!restaurantId) return 0;
    const id = String(restaurantId);
    let n = 0;
    for (const [slug, entry] of slugCache) {
        if (String(entry.id) === id) { slugCache.delete(slug); n++; }
    }
    return n;
}

/** Drop one slug from the cache here and on every other instance. */
function invalidateSlug(slug) {
    if (!slug) return;
    clearSlugLocal(slug);
    cacheBus.publish(SLUG_BUS_CHANNEL, { slug: String(slug).trim().toLowerCase() });
}

/** Drop every cached slug that maps to `restaurantId`, on every instance. */
function invalidateTenant(restaurantId) {
    if (!restaurantId) return;
    clearTenantLocal(restaurantId);
    cacheBus.publish(SLUG_BUS_CHANNEL, { restaurantId: String(restaurantId) });
}

cacheBus.subscribe(SLUG_BUS_CHANNEL, (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.slug) clearSlugLocal(msg.slug);
    if (msg.restaurantId) clearTenantLocal(msg.restaurantId);
});

// Restaurant slugs are lowercase kebab-case (`a-z`, `0-9`, `-`) and 2-60 chars.
// Rejecting anything else before the DB lookup guards against:
//   - Mongo operator injection (e.g. `{$regex:'.'}` style payloads)
//   - Wasted query time on garbage headers from scrapers / misconfigured proxies
//   - Cache pollution (a bad header can't evict good entries)
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,59}$/;

async function resolveBySlug(slug) {
    if (!slug) return null;
    if (!SLUG_REGEX.test(slug)) return null;
    const cached = getCached(slug);
    if (cached) {
        const r = await Restaurant.findById(cached);
        if (r) return r;
        slugCache.delete(slug);
    }
    const r = await Restaurant.findOne({ slug }).exec();
    if (r) setCached(slug, r._id);
    return r;
}

function readSlugFromRequest(req) {
    const fromHeader = req.headers['x-restaurant-slug'] || req.headers['x-restaurant'];
    if (fromHeader) return String(fromHeader).trim().toLowerCase();
    if (req.query?.restaurant) return String(req.query.restaurant).trim().toLowerCase();
    return null;
}

function ensureNotLocked(restaurant, res) {
    if (!restaurant) return true;
    if (restaurant.status === 'suspended' || restaurant.status === 'cancelled') {
        res.status(403).json({
            success: false,
            code: 'TENANT_SUSPENDED',
            message: `Restaurant "${restaurant.name}" is currently unavailable. Contact BestoDine support.`,
        });
        return false;
    }
    return true;
}

/**
 * CRIT-02 — populate `req.branch` with FAIL-CLOSED semantics.
 *
 * Sources in order:
 *   1. Staff user's user.branch (pinned at login)
 *   2. Customer / tenant-owner header `X-Branch-Id`
 *
 * Previously, an unresolvable staff branch or an invalid X-Branch-Id
 * silently fell through to `req.branch = null`. That opened the door
 * to a branch-pinned sub-admin (e.g. Mumbai) reading every branch's
 * data in the tenant when any controller used `tenantFilter` without
 * `strictBranchFilter`. We now return an error shape instead; the
 * caller (attachTenant) translates it into a 403 response.
 *
 * Returns either:
 *   { ok: true, branch }                    — resolved or legitimately null
 *   { ok: false, status, code, message }    — caller must respond with this
 */
async function resolveActiveBranch(req) {
    if (!req.restaurant) return { ok: true, branch: null };

    // 1. Staff branch wins. A conflicting X-Branch-Id header from a
    //    branch-pinned staff member is REJECTED — they cannot pivot
    //    to a different branch by tampering with a header.
    const staffBranchId = req.user?.branch;
    if (staffBranchId) {
        const headerBranch = req.headers['x-branch-id'];
        if (headerBranch && String(headerBranch) !== String(staffBranchId)) {
            return {
                ok: false,
                status: 403,
                code: 'BRANCH_MISMATCH',
                message: 'You are pinned to a branch and cannot act on another.',
            };
        }
        try {
            const b = await Branch.findOne({
                _id: staffBranchId,
                restaurant: req.restaurant._id,
                isActive: true,
            }).lean();
            if (b) return { ok: true, branch: b };
        } catch (err) {
            logger.warn('resolveActiveBranch: staff branch lookup error', { err: err.message });
            return {
                ok: false,
                status: 503,
                code: 'BRANCH_LOOKUP_FAILED',
                message: 'Could not verify your branch assignment. Please try again.',
            };
        }
        return {
            ok: false,
            status: 403,
            code: 'BRANCH_INACTIVE',
            message: 'Your assigned branch is no longer active. Contact your admin.',
        };
    }

    // 2. Customer / tenant-owner header. Invalid or wrong-tenant branch
    //    is rejected instead of silently null.
    const rawHeader = req.headers['x-branch-id'];
    if (rawHeader) {
        if (!mongoose.isValidObjectId(rawHeader)) {
            return {
                ok: false,
                status: 400,
                code: 'BRANCH_ID_INVALID',
                message: 'X-Branch-Id header is malformed.',
            };
        }
        try {
            const b = await Branch.findOne({
                _id: rawHeader,
                restaurant: req.restaurant._id,
                isActive: true,
            }).lean();
            if (b) return { ok: true, branch: b };
        } catch (err) {
            logger.warn('resolveActiveBranch: header branch lookup error', { err: err.message });
            return {
                ok: false,
                status: 503,
                code: 'BRANCH_LOOKUP_FAILED',
                message: 'Could not verify the requested branch. Please try again.',
            };
        }
        return {
            ok: false,
            status: 404,
            code: 'BRANCH_NOT_FOUND',
            message: 'The requested branch is not part of this restaurant or is inactive.',
        };
    }

    // No pin and no header — tenant-level (tenant owner default).
    return { ok: true, branch: null };
}

/**
 * attachTenant — populate req.restaurant for every request type.
 *
 * Strict by default: non-exempt requests that fail to resolve a
 * tenant are rejected with 400 TENANT_REQUIRED. Set
 * STRICT_TENANT_ENFORCEMENT=false to downgrade to the legacy
 * null-restaurant fall-through (see module docstring).
 */
const attachTenant = async (req, res, next) => {
    try {
        // Exempt paths (/auth, /public, /superadmin, /razorpay/webhook)
        // bypass ALL tenant resolution — including the staff-tenant
        // validation below. Otherwise a stale JWT pointing at a deleted
        // or suspended tenant would 403 even on /auth/login, locking
        // the user out of their own account with no way to recover.
        if (isStrictExempt(req)) {
            req.restaurant = null;
            req.branch = null;
            return proceed(req, next);
        }

        // Super admins are never scoped to a single tenant.
        if (req.user?.role === 'superadmin') {
            req.restaurant = null;
            req.branch = null;
            return proceed(req, next);
        }

        // 1. Staff user with explicit tenant link.
        if (req.user?.restaurant) {
            const r = await Restaurant.findById(req.user.restaurant);
            if (!r) {
                logger.warn(`attachTenant: user ${req.user._id} references missing restaurant ${req.user.restaurant}`);
                return res.status(403).json({
                    success: false,
                    code: 'TENANT_MISSING',
                    message: 'Your restaurant account is no longer available.',
                });
            }
            if (!ensureNotLocked(r, res)) return;
            req.restaurant = r;
            const bres = await resolveActiveBranch(req);
            if (!bres.ok) {
                return res.status(bres.status).json({ success: false, code: bres.code, message: bres.message });
            }
            req.branch = bres.branch;
            return proceed(req, next);
        }

        // 2. Phase 7.3 — custom domain resolution. If the request
        // carries an Origin or Host header that matches a tenant's
        // verified customDomain, resolve the tenant from that. This
        // runs BEFORE the slug check so customers on a vanity domain
        // don't need to send X-Restaurant-Slug at all.
        const origin = req.headers.origin || req.headers.host || '';
        // Strip the protocol + port to get the bare hostname.
        const hostname = origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase().trim();
        if (hostname && hostname !== 'localhost' && !hostname.endsWith('.localhost')) {
            const byDomain = await Restaurant.findOne({
                customDomain: hostname,
                domainVerified: true,
            });
            if (byDomain) {
                if (!ensureNotLocked(byDomain, res)) return;
                req.restaurant = byDomain;
                const bres = await resolveActiveBranch(req);
                if (!bres.ok) {
                    return res.status(bres.status).json({ success: false, code: bres.code, message: bres.message });
                }
                req.branch = bres.branch;
                return proceed(req, next);
            }
        }

        // 3. & 4. Customer / guest with a slug header or query param.
        const slug = readSlugFromRequest(req);
        if (slug) {
            const r = await resolveBySlug(slug);
            if (r) {
                if (!ensureNotLocked(r, res)) return;
                req.restaurant = r;
                const bres = await resolveActiveBranch(req);
                if (!bres.ok) {
                    return res.status(bres.status).json({ success: false, code: bres.code, message: bres.message });
                }
                req.branch = bres.branch;
                return proceed(req, next);
            }
        }

        // A revoked / deactivated session token (flagged by optionalAuth)
        // is an auth failure, not a missing tenant: answer 401 so the
        // client logs out instead of redirecting to the restaurant picker.
        if (req.authFailure) {
            return res.status(401).json({ success: false, code: req.authFailure.code, message: req.authFailure.message });
        }

        // No tenant context at all — reject. The escape hatch that
        // used to fall through to req.restaurant = null was removed
        // for CRIT-01. Fail closed.
        return rejectStrict(req, res, 'no-tenant-resolved');
    } catch (err) {
        logger.error('attachTenant error: ' + err.message);
        // A transient Mongo hiccup during resolution must NOT mask a
        // real tenant mismatch. Fail closed.
        return rejectStrict(req, res, 'resolve-error');
    }
};

/**
 * requireTenant — alias for attachTenant now that attachTenant is
 * strict by default. Kept as a separate export so route files that
 * want to spell out "this absolutely needs a tenant" still read
 * cleanly.
 */
const requireTenant = attachTenant;

module.exports = {
    attachTenant,
    requireTenant,
    getTenantFallbackStats,
    isStrictExempt,
    invalidateSlug,
    invalidateTenant,
};
