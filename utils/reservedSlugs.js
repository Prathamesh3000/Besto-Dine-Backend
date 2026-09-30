/**
 * Reserved restaurant slugs.
 *
 * Every restaurant gets a public landing page at `/<restaurantSlug>`
 * (and `/<restaurantSlug>/<branchSlug>`). The frontend mounts that
 * `/:slug` route AFTER every app route, so a restaurant whose slug equals
 * a top-level app path (e.g. `admin`, `login`, `kiosk`) would never be
 * reachable — worse, a future app route could silently shadow a live
 * restaurant page. Restaurant creation therefore refuses these slugs:
 *
 *   - generated slug (from the name) is reserved → auto-suffixed
 *     (`admin` → `admin-1a2b`, same style as the collision handling)
 *   - explicitly supplied slug is reserved      → 400 SLUG_RESERVED
 *
 * The list covers every first path segment of the <Route path>s in
 * Frontend/src/App.jsx plus infrastructure / marketing / SEO paths that
 * could be added later. When a new top-level frontend route is added,
 * add its first segment here too, then run
 * `node scripts/check-reserved-slugs.js` to find existing tenants that
 * now collide.
 *
 * Branch slugs are NOT checked: branches live under /:slug/:branchSlug,
 * so they can never shadow a top-level app path.
 */

// First path segment of every top-level <Route> in Frontend/src/App.jsx.
const APP_ROUTE_SEGMENTS = [
    'admin', 'bill-preview', 'bill', 'branch-selection', 'chef', 'customer',
    'force-change-password', 'health', 'home', 'kiosk', 'login',
    'notifications', 'otp', 'privacy', 'r', 'register-restaurant',
    'request-demo', 'reset-password', 'scan', 'search', 'splash', 'staff-login',
    'superadmin', 'switch-restaurant', 'terms', 'unauthorized', 'waiter',
];

// Platform / infrastructure / marketing / SEO paths (current + likely future).
const PLATFORM_SEGMENTS = [
    'logout', 'register', 'signup', 'signin', 'sign-in', 'sign-up',
    'captain', 'kitchen', 'legal', 'forgot-password', 'verify', 'verify-email',
    'api', 'assets', 'static', 'public', 'uploads', 'images', 'img', 'fonts', 'media',
    'blog', 'pricing', 'features', 'about', 'contact', 'demo', 'help', 'support',
    'docs', 'faq', 'careers', 'www', 'app', 'dashboard', 'settings', 'profile',
    'account', 'orders', 'menu', 'cart', 'checkout', 'payment', 'payments',
    'wallet', 'booking', 'bookings', 'book', 'restaurants', 'restaurant',
    'favicon.ico', 'robots.txt', 'sitemap.xml', 'manifest.json', 'sw.js',
    'index.html', 'healthz', 'readyz', '404', '500', 'null', 'undefined',
    'bestodine', 'staff', 'manager', 'owner', 'auth', 'oauth', 'callback',
    'webhook', 'webhooks', 'socket.io', 'status',
    // Platform home / hotel onboarding paths.
    'register-hotel', 'join', 'partners',
];

const RESERVED_SLUGS = new Set(
    [...APP_ROUTE_SEGMENTS, ...PLATFORM_SEGMENTS].map((s) => s.toLowerCase()),
);

/** True when `slug` (case/whitespace-insensitive) is reserved. */
function isReservedSlug(slug) {
    if (slug === null || slug === undefined) return false;
    const s = String(slug).trim().toLowerCase();
    if (!s) return false;
    return RESERVED_SLUGS.has(s);
}

// Same shape the tenant resolver accepts (middlewares/tenantContext.js).
const RESTAURANT_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate an explicitly supplied restaurant slug. Pure — does NOT check
 * uniqueness (the caller owns the DB lookup).
 *
 * Returns { slug } on success or { error: { status, code, message } }.
 */
function checkExplicitRestaurantSlug(raw) {
    if (typeof raw !== 'string') {
        return { error: { status: 400, code: 'INVALID_SLUG', message: 'Slug must be text' } };
    }
    const slug = raw.trim().toLowerCase();
    if (slug.length < 2 || slug.length > 60 || !RESTAURANT_SLUG_REGEX.test(slug)) {
        return {
            error: {
                status: 400,
                code: 'INVALID_SLUG',
                message: 'Slug must be 2-60 characters: lowercase letters, digits and single hyphens',
            },
        };
    }
    if (isReservedSlug(slug)) {
        return {
            error: {
                status: 400,
                code: 'SLUG_RESERVED',
                message: `"${slug}" is reserved and cannot be used as a restaurant URL. Please choose another.`,
            },
        };
    }
    return { slug };
}

module.exports = {
    RESERVED_SLUGS,
    isReservedSlug,
    checkExplicitRestaurantSlug,
    RESTAURANT_SLUG_REGEX,
};
