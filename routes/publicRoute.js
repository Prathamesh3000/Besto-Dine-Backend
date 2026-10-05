const express = require('express');
const { makeLimiter } = require('../utils/rateLimitStore');
const router = express.Router();

const {
    listRestaurants,
    getRestaurantBySlug,
    getRestaurantBranches,
    registerRestaurant,
    submitLead,
    getSiteConfig,
    slugAvailability,
    listPublicPlans,
} = require('../controllers/publicController');
const { validate, body, query } = require('../middlewares/validate');
const { getMenuBootstrap } = require('../controllers/publicMenuBootstrapController');
const { getRestaurantLanding } = require('../controllers/publicLandingController');
const { listPublicBlogPosts, getPublicBlogPost } = require('../controllers/blogController');

// All routes here are intentionally unauthenticated. They serve the
// customer landing / branch selection flow before the customer has
// picked a tenant or logged in.

// ?q=<name/city search, ≤60 chars>&limit=<1-30, default 12> switches to the
// platform-home directory shape ({ name, slug, city, logo }); without
// either param the legacy full list is returned unchanged.
router.get('/restaurants', validate([
    query('q').optional().isString().withMessage('q must be text'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('limit must be a positive number'),
]), listRestaurants);
router.get('/restaurants/:slug',            getRestaurantBySlug);
// Phase 6 step 5 — public list of a tenant's active branches so the
// customer can pick a physical location after picking the tenant.
router.get('/restaurants/:slug/branches',   getRestaurantBranches);
// Per-restaurant landing page (/<restaurantSlug>[/<branchSlug>]) —
// public-safe profile, hours, featured dishes, branches, CTAs.
router.get('/restaurants/:slug/landing',    getRestaurantLanding);

// Single round-trip first-paint bundle for the customer menu page.
// Returns categories + menu + combos + settings + promotions + coupons
// in one response, with public Cache-Control so a CDN edge can serve
// hot reads at <50ms. Replaces the legacy 5-call chain that fired on
// every QR scan and tab switch into the menu page.
router.get('/menu-bootstrap',               getMenuBootstrap);

// Phase 5 step 2 — self-service tenant signup. Dedicated rate limiter
// is STRICTER than the global apiLimiter (3/hour/IP) because each
// successful call creates a Restaurant + User + fires a welcome email.
// The generic apiLimiter alone (200/min) would let a single bot
// create thousands of ghost tenants before anyone noticed.
const signupLimiter = makeLimiter({ name: 'public-signup',
    windowMs: 60 * 60 * 1000,   // 1 hour
    // 3 successful signups per hour per IP (SIGNUP_RATE_LIMIT_PER_HOUR).
    // Rejected attempts (4xx/5xx — typo'd phone, taken email, weak
    // password) no longer count: they create nothing, and counting them
    // locked owners (and QA) out after a few validation errors, so the
    // final valid submit answered 429 instead of "Application received".
    max: Math.max(1, Number(process.env.SIGNUP_RATE_LIMIT_PER_HOUR) || 3),
    skipFailedRequests: true,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many signup attempts from this network. Please try again in an hour.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});
// Type checks only — the controller owns required-ness, lengths and the
// business rules so it can answer with field-level codes (WEAK_PASSWORD,
// TERMS_REQUIRED, EMAIL_IN_USE, SLUG_*).
const optStr = (field, max = 500) => body(field).optional({ values: 'null' })
    .isString().withMessage(`${field} must be text`).bail()
    .isLength({ max }).withMessage(`${field} is too long`);
const registerRules = validate([
    optStr('restaurantName'),
    optStr('ownerName'),
    optStr('contactEmail'),
    body('contactPhone').optional({ values: 'null' })
        .custom((v) => typeof v === 'string' || typeof v === 'number').withMessage('contactPhone must be text'),
    optStr('city'),
    optStr('password', 128),
    optStr('slug', 200),
    optStr('planId', 64),
    body('acceptTerms').optional({ values: 'null' })
        .custom((v) => typeof v === 'boolean' || v === 'true' || v === 'false').withMessage('acceptTerms must be true or false'),
    body('source').optional({ values: 'null' }).isString().withMessage('source must be text'),
    body('utm').optional({ values: 'null' })
        .custom((v) => typeof v === 'object' && !Array.isArray(v)).withMessage('utm must be an object'),
    ...['source', 'medium', 'campaign', 'term', 'content'].flatMap((k) => [
        body(`utm.${k}`).optional({ values: 'null' }).isString().withMessage(`utm.${k} must be text`),
        body(`utm_${k}`).optional({ values: 'null' }).isString().withMessage(`utm_${k} must be text`),
    ]),
]);
router.post('/register-restaurant', signupLimiter, registerRules, registerRestaurant);

// Live "is this page URL free?" check for the signup form. Cheap read,
// but capped so it can't be used to enumerate tenants at speed.
const slugCheckLimiter = makeLimiter({ name: 'slug-check',
    windowMs: 60 * 1000,   // 1 minute
    max: 60,               // 60 checks per minute per IP
    message: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many checks. Please wait a moment and try again.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});
router.get('/slug-availability', slugCheckLimiter, validate([
    query('slug').optional().isString().withMessage('slug must be text'),
    query('name').optional().isString().withMessage('name must be text'),
    query('city').optional().isString().withMessage('city must be text'),
]), slugAvailability);

// Public, active subscription plans (platform home pricing + signup plan
// picker). Public-safe fields only, cached 5 minutes.
router.get('/plans', listPublicPlans);

// Marketing-site lead capture. Looser than signupLimiter (a lead is just a
// contact request, not a tenant creation) but still capped to defang spam
// from a leaked form / bot. This is the single wire between the standalone
// marketing site (BestoDine-Marketing) and the SaaS backend.
const leadLimiter = makeLimiter({ name: 'public-lead',
    windowMs: 60 * 60 * 1000,   // 1 hour
    max: 5,                      // 5 submissions per hour per IP
    message: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many submissions from this network. Please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});
router.post('/lead', leadLimiter, submitLead);

// Editable marketing-site content (brand name, contact, socials). Read by
// the standalone marketing site at load; edited from Super Admin → Marketing.
router.get('/site-config', getSiteConfig);

// Published blog posts for the marketing site. Fetched at BUILD time to
// prerender /blog + each /blog/:slug to static HTML (SEO). Authored from
// Super Admin → Blog.
router.get('/blog',        listPublicBlogPosts);
router.get('/blog/:slug',  getPublicBlogPost);

module.exports = router;
