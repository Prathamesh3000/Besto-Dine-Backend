const crypto = require('crypto');
const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const User = require('../models/user');
const AuditLog = require('../models/auditLog');
const Branch = require('../models/branch');
const Lead = require('../models/lead');
const MarketingSetting = require('../models/marketingSetting');
const logger = require('../utils/logger');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { publicOperationsOf } = require('../utils/operationsProfile');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { isReservedSlug, checkExplicitRestaurantSlug } = require('../utils/reservedSlugs');
const mongoose = require('mongoose');
const Settings = require('../models/settings');
const { sendEmail } = require('../utils/email');
const { signupApplicationReceived, signupAdminAlert } = require('../utils/emailTemplates');
const { resolveRecipients: resolveAlertRecipients } = require('../utils/alerts');
const { isStrongPassword, STRONG_PASSWORD_MESSAGE } = require('../utils/passwordPolicy');
const { normalizeMobile } = require('../utils/mobile');
const { slugify, slugFromName, slugIssue, suggestSlugs } = require('../utils/signupSlug');
const { getPublicPlans } = require('../utils/publicPlans');
const { SELF_SIGNUP_TRIAL_DAYS } = require('../utils/selfSignup');

// ─── Shared validation helpers (mirrors superadminController) ──────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Plan a self-signup trials on (see registerRestaurant). Override per
// deployment with SELF_SIGNUP_TRIAL_PLAN.
const SELF_SIGNUP_TRIAL_PLAN_SLUG = process.env.SELF_SIGNUP_TRIAL_PLAN || 'gold';
const SLUG_REGEX  = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Public, unauthenticated endpoints intended for the customer-facing
 * landing / branch selection flow. Anything served from here is safe to
 * expose without a login — DO NOT add admin or PII data to these
 * responses.
 *
 * The customer-facing feature map returned on each restaurant lets the
 * frontend hide UI for modules the tenant hasn't paid for. The
 * resolution logic lives in `utils/publicFeatureFlags.js` so
 * tableController (QR scan) and anything else the customer touches uses
 * the exact same rules.
 */

/**
 * GET /api/v1/public/restaurants
 *
 * Returns the list of active, non-suspended tenants so the customer
 * landing page can render a "Pick a restaurant" screen. Cancelled and
 * suspended tenants are filtered out.
 *
 * The response intentionally omits subscription/billing/feature flag
 * details — those are platform-internal.
 */
exports.listRestaurants = async (req, res) => {
    try {
        const hasQ = typeof req.query.q === 'string';
        const hasLimit = req.query.limit !== undefined;

        // ── Directory mode (?q= and/or ?limit=) ───────────────────────
        // Platform home "find your restaurant" search. Only tenants whose
        // public landing page is enabled, only { name, slug, city, logo }.
        // Without either param the legacy full list below is returned
        // unchanged (BranchSelection + Login rely on it).
        if (hasQ || hasLimit) {
            const q = hasQ ? req.query.q.trim().slice(0, 60) : '';
            let limit = parseInt(req.query.limit, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 12;
            limit = Math.min(limit, 30);

            // Settings.landingPage lives on the tenant-level doc
            // (branch: null); default is enabled, so only explicit
            // `enabled: false` hides a restaurant.
            // AUDIT-EXEMPT: public directory — cross-tenant by design.
            const hidden = await Settings.distinct('restaurant', { branch: null, 'landingPage.enabled': false });

            const filter = { status: { $in: ['active', 'trial'] } };
            if (hidden.length) filter._id = { $nin: hidden };
            if (q) {
                const rx = new RegExp(escapeRegex(q), 'i');
                filter.$or = [{ name: rx }, { city: rx }];
            }
            const rows = await Restaurant.find(filter)
                .select('name slug city logo')
                .sort({ name: 1 })
                .limit(limit)
                .lean();

            res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
            return res.status(200).json({
                success: true,
                count: rows.length,
                data: rows.map((r) => ({
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    logo: r.logo || '',
                })),
            });
        }

        const restaurants = await Restaurant.find({
            status: { $in: ['active', 'trial'] },
        })
            .select('name slug city contactPhone logo branding createdAt subscription featureOverrides addons operations')
            .sort({ name: 1 })
            .lean();

        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return res.status(200).json({
            success: true,
            count: restaurants.length,
            data: restaurants.map(r => ({
                _id: r._id,
                name: r.name,
                slug: r.slug,
                city: r.city || '',
                phone: r.contactPhone || '',
                logo: r.logo || '',
                features: publicFeaturesOf(r),
                operations: publicOperationsOf(r),
            })),
        });
    } catch (err) {
        logger.error('public.listRestaurants error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list restaurants' });
    }
};

/**
 * GET /api/v1/public/restaurants/:slug
 *
 * Returns a single restaurant's public profile by slug. Used by the
 * customer flow to verify a slug is valid (e.g. when restoring from
 * localStorage on app load) and to render the tenant name in the header.
 */
exports.getRestaurantBySlug = async (req, res) => {
    try {
        const { slug } = req.params;
        if (!slug) {
            return res.status(400).json({ success: false, message: 'Slug is required' });
        }

        const restaurant = await Restaurant.findOne({
            slug: String(slug).toLowerCase().trim(),
            status: { $in: ['active', 'trial'] },
        }).select('name slug city contactPhone logo branding subscription featureOverrides addons operations').lean();

        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        // Tenant profile rarely changes — let the browser cache it for
        // 60s with a 5-minute stale-while-revalidate window. `private`
        // because feature flags here can vary across plans (we don't
        // want a CDN serving cached copy across tenants).
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
        return res.status(200).json({
            success: true,
            data: {
                _id: restaurant._id,
                name: restaurant.name,
                slug: restaurant.slug,
                city: restaurant.city || '',
                phone: restaurant.contactPhone || '',
                logo: restaurant.logo || '',
                features: publicFeaturesOf(restaurant),
                operations: publicOperationsOf(restaurant),
            },
        });
    } catch (err) {
        logger.error('public.getRestaurantBySlug error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch restaurant' });
    }
};

/**
 * GET /api/v1/public/restaurants/:slug/branches  (Phase 6 step 5)
 *
 * Customer-facing list of active branches for a tenant. Used by the
 * BranchSelection page so a customer can pick which physical location
 * they're ordering from BEFORE they hit any menu endpoint. Returns
 * empty array for tenants without any branches (single-location
 * installs see no branch picker).
 *
 * Response intentionally omits internal fields (createdBy, sortOrder
 * details, etc.) — only what the customer needs to render a card.
 */
exports.getRestaurantBranches = async (req, res) => {
    try {
        const { slug } = req.params;
        if (!slug) {
            return res.status(400).json({ success: false, message: 'Slug is required' });
        }

        // Resolve the tenant first so we never leak branches across
        // tenants — even via a stale slug. Suspended tenants get an
        // empty array (same as a missing tenant) so the customer
        // never gets a confusing 403 from the picker page.
        const tenant = await Restaurant.findOne({
            slug: String(slug).toLowerCase().trim(),
            status: { $in: ['active', 'trial'] },
        }).select('_id name').lean();
        if (!tenant) {
            return res.status(200).json({ success: true, data: [] });
        }

        const branches = await Branch.find({
            restaurant: tenant._id,
            isActive: true,
        })
            .select('name slug city addressLine1 addressLine2 state postalCode country contactPhone sortOrder')
            .sort({ sortOrder: 1, name: 1 })
            .lean();

        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return res.status(200).json({
            success: true,
            // Brand label = the tenant identity. Surfaced alongside the
            // branch list so the customer picker can render
            // "<Brand> – <full address>" cards in one render pass
            // (no extra request to /public/restaurants/:slug).
            brand: tenant.name,
            data: branches.map(b => ({
                _id: b._id,
                name: b.name,
                slug: b.slug,
                city: b.city || '',
                addressLine1: b.addressLine1 || '',
                addressLine2: b.addressLine2 || '',
                state: b.state || '',
                postalCode: b.postalCode || '',
                country: b.country || '',
                contactPhone: b.contactPhone || '',
            })),
        });
    } catch (err) {
        logger.error('public.getRestaurantBranches error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch branches' });
    }
};

/**
 * POST /api/v1/public/register-restaurant   (Phase 5 step 2)
 *
 * Self-service tenant signup. Unauthenticated endpoint that creates a
 * Restaurant + owner User in one atomic-ish operation. The owner
 * supplies their own password during signup; the tenant stays
 * suspended (signupStatus 'pending') until a Super Admin approves it,
 * and staff login answers 403 SIGNUP_PENDING until then.
 *
 * Flow:
 *   1. Validate input (restaurantName, ownerName, contactEmail, 10-digit
 *      mobile, city, strong password — utils/passwordPolicy,
 *      acceptTerms === true, optional public planId, source/utm)
 *   2. Resolve a default plan (first active plan with price === 0,
 *      or explicitly slug === 'free')
 *   3. Conflict check: slug uniqueness, email uniqueness
 *   4. Create Restaurant with N-day trial (default 14)
 *   5. Create owner User (role: 'admin') with user-supplied password
 *   6. Link owner → restaurant
 *   7. Write a system audit entry (actor=null, role=system)
 *   8. Fire-and-forget "application received" email to the owner and a
 *      new-signup alert to Super Admins (welcome email goes on approval)
 *   9. 202 { restaurant, owner, signupStatus, pageUrl, message } — NOT a
 *      token. After approval the owner logs in at /staff-login.
 *
 * Anti-abuse: the route this handler is mounted on carries a dedicated
 * rate limiter (server.js: `signupLimiter` — 3 requests per hour per
 * IP) so the cost of spam is bounded even if a bot finds the endpoint.
 *
 * Audit shape (mirror of the Razorpay webhook + alerts pattern):
 *   { actor: null, actorEmail: 'self-signup', actorRole: 'system',
 *     action: 'restaurant.self_signup', targetType: 'restaurant', ... }
 */
exports.registerRestaurant = async (req, res) => {
    try {
        const body = req.body || {};
        const {
            restaurantName,
            contactEmail,
            contactPhone,
            city,
            ownerName,
            password,
            planId,
            acceptTerms,
        } = body;

        const fail = (status, field, message, code) => res.status(status).json({
            success: false, ...(field ? { field } : {}), ...(code ? { code } : {}), message,
        });
        const str = (v) => (typeof v === 'string' ? v.trim() : '');

        // ── Validation ─────────────────────────────────────────────────
        // Length caps below are deliberately ≤ Branch schema caps so the
        // auto-provisioned Main branch can never fail validation on
        // copy. Catching it here gives the customer a clear field-level
        // error instead of the generic 500 they'd see from a Mongoose
        // ValidationError thrown deep in createMainBranchFor.
        const cleanName = str(restaurantName);
        if (!cleanName) return fail(400, 'restaurantName', 'Restaurant name is required');
        if (cleanName.length < 2) return fail(400, 'restaurantName', 'Restaurant name must be at least 2 characters');
        if (cleanName.length > 80) return fail(400, 'restaurantName', 'Restaurant name cannot exceed 80 characters');

        const cleanOwner = str(ownerName);
        if (!cleanOwner) return fail(400, 'ownerName', 'Your name is required');
        if (cleanOwner.length > 80) return fail(400, 'ownerName', 'Your name cannot exceed 80 characters');

        const cleanEmail = str(contactEmail).toLowerCase();
        if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) return fail(400, 'contactEmail', 'A valid email address is required');
        if (cleanEmail.length > 120) return fail(400, 'contactEmail', 'Email cannot exceed 120 characters');

        // 10-digit Indian mobile, normalised exactly like OTP login
        // ('+91 98765-43210' → '9876543210').
        if (!str(String(contactPhone ?? ''))) return fail(400, 'contactPhone', 'Mobile number is required');
        const cleanPhone = normalizeMobile(contactPhone);
        if (!cleanPhone) return fail(400, 'contactPhone', 'Please enter a valid 10-digit mobile number');

        const cleanCity = str(city);
        if (!cleanCity) return fail(400, 'city', 'City is required');
        if (cleanCity.length > 80) return fail(400, 'city', 'City cannot exceed 80 characters');

        if (typeof password !== 'string' || !password) return fail(400, 'password', 'Password is required');
        if (!isStrongPassword(password)) return fail(400, 'password', STRONG_PASSWORD_MESSAGE, 'WEAK_PASSWORD');

        if (acceptTerms !== true && acceptTerms !== 'true') {
            return fail(400, 'acceptTerms', 'Please accept the Terms of Service and Privacy Policy to continue.', 'TERMS_REQUIRED');
        }

        // ── Optional requested plan (informational — billing NOT activated) ──
        let requestedPlan = null;
        if (planId !== undefined && planId !== null && planId !== '') {
            if (typeof planId !== 'string' || !mongoose.isValidObjectId(planId)) {
                return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
            }
            // AUDIT-EXEMPT: platform-global plan catalogue.
            requestedPlan = await SubscriptionPlan.findOne({ _id: planId, isPublic: true, isActive: true })
                .select('name slug').lean();
            if (!requestedPlan) return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
        }

        const signupMeta = buildSignupMeta(body, { ownerName: cleanOwner, ip: req.ip });

        // ── Resolve default plan ───────────────────────────────────────
        // Prefer a plan explicitly slug'd 'free'; then the trial plan
        // (Gold — "14 days of Gold", PRICING_PACKAGING §3); then the
        // cheapest active plan that has a list price. Enterprise is priced
        // 0 because it is quoted, so a plain cheapest-first pick handed
        // every trial the full Enterprise module set. If no plans exist at
        // all, the platform isn't set up yet — 503 and let the operator know.
        let plan = await SubscriptionPlan.findOne({ slug: 'free', isActive: true });
        if (!plan) {
            plan = await SubscriptionPlan.findOne({ slug: SELF_SIGNUP_TRIAL_PLAN_SLUG, isActive: true });
        }
        if (!plan) {
            plan = await SubscriptionPlan.findOne({ isActive: true, price: { $gt: 0 } }).sort({ price: 1 });
        }
        if (!plan) {
            plan = await SubscriptionPlan.findOne({ isActive: true }).sort({ price: 1 });
        }
        if (!plan) {
            logger.error('public.registerRestaurant: no active subscription plans found');
            return res.status(503).json({
                success: false,
                message: 'Self-service signup is temporarily unavailable. Please contact support.',
            });
        }

        // ── Slug generation + uniqueness ───────────────────────────────
        // Reserved slugs (utils/reservedSlugs.js) would collide with a
        // top-level frontend route at /<slug>: an explicit one is refused
        // (400 SLUG_RESERVED), a generated one is auto-suffixed exactly
        // like a uniqueness collision.
        let slug;
        if (body.slug !== undefined && body.slug !== null && body.slug !== '') {
            const checked = checkExplicitRestaurantSlug(body.slug);
            if (checked.error) {
                return fail(checked.error.status, 'slug', checked.error.message, checked.error.code);
            }
            slug = checked.slug;
            if (await Restaurant.exists({ slug })) {
                return fail(409, 'slug', 'This restaurant URL is already taken. Please choose another.', 'SLUG_TAKEN');
            }
        } else {
            slug = slugFromName(cleanName);
            if (!SLUG_REGEX.test(slug) || slug.length < 2) {
                slug = `restaurant-${crypto.randomBytes(3).toString('hex')}`;
            }
            if (isReservedSlug(slug) || await Restaurant.exists({ slug })) {
                slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
            }
        }

        // ── Email uniqueness ───────────────────────────────────────────
        // Any existing user with this email (customer, staff at another
        // tenant, super admin) blocks self-signup — the owner must log in
        // or pick another email. Same restaurant name + city is fine:
        // the slug differs.
        const existingUser = await User.exists({ email: cleanEmail });
        if (existingUser) {
            return fail(409, 'contactEmail',
                'An account with this email already exists. Log in or use another email.', 'EMAIL_IN_USE');
        }

        // ── Build subscription snapshot ────────────────────────────────
        // Trial dates are pre-computed; the tenant stays suspended until
        // a Super Admin approves the signup.
        // Provisional — approveSignup restarts the trial from the approval date.
        const TRIAL_DAYS = SELF_SIGNUP_TRIAL_DAYS;
        const startDate = new Date();
        const trialEndDate = new Date(startDate.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

        const snapshot = {
            plan: plan._id,
            planName: plan.name,
            planSlug: plan.slug,
            features: plan.features
                ? (plan.features.toObject ? plan.features.toObject() : { ...plan.features })
                : {},
            limits: plan.limits
                ? (plan.limits.toObject ? plan.limits.toObject() : { ...plan.limits })
                : {},
            startDate,
            endDate: null,
            trialEndDate,
            status: 'trial',
        };

        // ── Create restaurant (PENDING APPROVAL) ───────────────────────
        // signupSource='self' + signupStatus='pending' tags this for the
        // Super Admin's Pending Approvals queue. status='suspended' keeps
        // staff locked out until the operator clicks Approve (staff login
        // answers 403 SIGNUP_PENDING meanwhile).
        const restaurant = await Restaurant.create({
            name: cleanName,
            slug,
            contactEmail: cleanEmail,
            contactPhone: cleanPhone,
            city: cleanCity,
            status: 'suspended',
            signupSource: 'self',
            signupStatus: 'pending',
            suspendedAt: new Date(),
            suspendedReason: 'Awaiting Super Admin approval',
            subscription: snapshot,
            ...(requestedPlan ? {
                requestedPlan: { plan: requestedPlan._id, planName: requestedPlan.name, planSlug: requestedPlan.slug },
            } : {}),
            signupMeta,
        });

        // ── Create owner user ──────────────────────────────────────────
        // Roll back the restaurant if user creation fails, so we don't
        // leave a dangling tenant with no owner.
        let ownerUser;
        try {
            ownerUser = await User.create({
                name: cleanOwner,
                email: cleanEmail,
                password, // hashed by the userSchema.pre('save') hook
                mobile: cleanPhone,
                role: 'admin',
                restaurant: restaurant._id,
                // CRIT-06 — THIS user is the tenant owner. Sub-admins
                // created later via /staff leave this at its default (false).
                isTenantOwner: true,
                mustChangePassword: false, // they chose this password themselves
                status: 'active',
            });
            restaurant.owner = ownerUser._id;
            await restaurant.save();
        } catch (innerErr) {
            await Restaurant.findByIdAndDelete(restaurant._id).catch(() => {});
            if (innerErr?.code === 11000) {
                return fail(409, 'contactEmail',
                    'An account with this email already exists. Log in or use another email.', 'EMAIL_IN_USE');
            }
            throw innerErr;
        }

        // ── Auto-provision the "Main" branch ──────────────────────────
        // Failure here is non-fatal: the backfill script can be re-run
        // to repair the tenant later.
        try {
            await createMainBranchFor(restaurant, ownerUser._id);
        } catch (branchErr) {
            logger.error(`public.registerRestaurant: createMainBranchFor failed for ${restaurant.slug}: ${branchErr.message}`);
        }

        // ── Audit entry (system actor — no req.user available) ────────
        try {
            await AuditLog.create({
                actor: null,
                actorEmail: 'self-signup',
                actorRole: 'system',
                action: 'restaurant.self_signup',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: {
                    plan: plan.slug,
                    requestedPlan: requestedPlan?.slug || '',
                    trialDays: TRIAL_DAYS,
                    ownerEmail: cleanEmail,
                    source: signupMeta.source,
                },
                ip: req.ip || req.headers['x-forwarded-for'] || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (auditErr) {
            logger.warn(`self-signup audit write failed: ${auditErr.message}`);
        }

        // ── Notifications (fire-and-forget) ───────────────────────────
        // Owner: "Application received". Super Admins: new signup alert.
        // The welcome / "you can log in" email goes out on approval.
        notifySignupReceived({
            restaurant,
            ownerName: cleanOwner,
            requestedPlanName: requestedPlan?.name || '',
            source: signupMeta.source || signupMeta.utmSource,
        });

        logger.info(`self-signup PENDING ${restaurant.slug} (${cleanEmail})`);

        const pageUrl = `${frontendBase()}/${restaurant.slug}`;
        const message = `Thanks for signing up! Your application is being reviewed — usually within 1 business day. We'll email ${cleanEmail} once it's approved.`;
        return res.status(202).json({
            success: true,
            data: {
                restaurant: {
                    _id: restaurant._id,
                    name: restaurant.name,
                    slug: restaurant.slug,
                },
                owner: {
                    _id: ownerUser._id,
                    name: ownerUser.name,
                    email: ownerUser.email,
                },
                signupStatus: 'pending',
                pageUrl,
                requestedPlan: requestedPlan ? { _id: requestedPlan._id, name: requestedPlan.name } : null,
                message,
            },
            message,
        });
    } catch (err) {
        logger.error('public.registerRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to register restaurant' });
    }
};

function frontendBase() {
    return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

const META_MAX = 100;
const metaStr = (v) => (typeof v === 'string' ? v.trim().slice(0, META_MAX) : '');

/**
 * Marketing attribution from the signup body. Accepts `source` plus
 * either a `utm` object ({ source, medium, campaign, term, content }) or
 * flat `utm_source` / `utmSource` style keys. Strings only, each ≤ 100.
 */
function buildSignupMeta(body, { ownerName, ip }) {
    const utm = (body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm)) ? body.utm : {};
    const pick = (key) => metaStr(utm[key]) || metaStr(body[`utm_${key}`])
        || metaStr(body[`utm${key[0].toUpperCase()}${key.slice(1)}`]);
    return {
        ownerName,
        source: metaStr(body.source),
        utmSource: pick('source'),
        utmMedium: pick('medium'),
        utmCampaign: pick('campaign'),
        utmTerm: pick('term'),
        utmContent: pick('content'),
        termsAcceptedAt: new Date(),
        ip: metaStr(ip || ''),
    };
}

/** Owner "application received" + Super Admin alert. Never throws. */
function notifySignupReceived({ restaurant, ownerName, requestedPlanName, source }) {
    setImmediate(async () => {
        try {
            await sendEmail({
                to: restaurant.contactEmail,
                ...signupApplicationReceived({
                    restaurantName: restaurant.name,
                    ownerName,
                    email: restaurant.contactEmail,
                    slug: restaurant.slug,
                }),
            });
        } catch (e) {
            logger.warn(`self-signup application email failed for ${restaurant.contactEmail}: ${e.message}`);
        }
        try {
            // SUPERADMIN_ALERT_EMAILS (comma list), else every superadmin user.
            const recipients = await resolveAlertRecipients();
            const mail = signupAdminAlert({
                restaurantName: restaurant.name,
                slug: restaurant.slug,
                ownerName,
                email: restaurant.contactEmail,
                phone: restaurant.contactPhone,
                city: restaurant.city,
                planName: requestedPlanName,
                source,
            });
            for (const to of recipients) {
                await sendEmail({ to, ...mail });
            }
        } catch (e) {
            logger.warn(`self-signup superadmin alert failed for ${restaurant.slug}: ${e.message}`);
        }
    });
}

/**
 * GET /api/v1/public/slug-availability?slug=<s>&name=<restaurantName>[&city=<c>]
 *
 * Live check for the signup form's "your page URL" field. `slug` is
 * normalised with the same slugify signup uses; with only `name`, the
 * slug signup would generate is checked instead.
 *
 * → { success, data: { slug, available, reason: null|'reserved'|'taken'|'invalid'|'too_short', suggestions: [≤3] } }
 */
exports.slugAvailability = async (req, res) => {
    try {
        const rawSlug = typeof req.query.slug === 'string' ? req.query.slug.slice(0, 200) : '';
        const rawName = typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : '';
        const rawCity = typeof req.query.city === 'string' ? req.query.city.slice(0, 80) : '';
        if (!rawSlug.trim() && !rawName.trim()) {
            return res.status(400).json({ success: false, message: 'Provide a slug or a restaurant name' });
        }

        const slug = rawSlug.trim() ? slugify(rawSlug) : slugFromName(rawName);
        let reason = slugIssue(slug);
        if (!reason && await Restaurant.exists({ slug })) reason = 'taken';

        const findTaken = async (slugs) => {
            const rows = await Restaurant.find({ slug: { $in: slugs } }).select('slug').lean();
            return new Set(rows.map((r) => r.slug));
        };
        let suggestions = [];
        if (reason) {
            // Base for alternatives: the slug itself when it has usable
            // content, else the name.
            const base = slug.length >= 2 ? slug : slugFromName(rawName) || slug;
            suggestions = await suggestSlugs(base, findTaken, { city: rawCity, limit: 3 });
        }

        res.set('Cache-Control', 'no-store');
        return res.status(200).json({
            success: true,
            data: { slug, available: !reason, reason: reason || null, suggestions },
        });
    } catch (err) {
        logger.error('public.slugAvailability error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to check availability' });
    }
};

/**
 * GET /api/v1/public/plans
 *
 * Public, active subscription plans (isPublic && isActive) sorted by
 * sortOrder — pricing on the platform home + plan picker on signup.
 * Public-safe fields only; cached 5 minutes (utils/publicPlans.js).
 */
exports.listPublicPlans = async (_req, res) => {
    try {
        const plans = await getPublicPlans();
        res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        return res.status(200).json({ success: true, count: plans.length, data: plans });
    } catch (err) {
        logger.error('public.listPublicPlans error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load plans' });
    }
};

/**
 * POST /api/v1/public/lead
 *
 * Unauthenticated lead capture from the standalone marketing site
 * (BestoDine-Marketing). This is the ONLY wire between the marketing site
 * and the SaaS product — it stores a prospect for the Super Admin "Leads"
 * tab to follow up on. It does NOT create a Restaurant or User; real
 * onboarding happens later, after a sales conversation.
 *
 * Rate-limited by `leadLimiter` (5/hour/IP) in publicRoute.js.
 */
exports.submitLead = async (req, res) => {
    try {
        const {
            name,
            restaurantName,
            phone,
            email,
            message,
            source,
            meta,
        } = req.body || {};

        // ── Required-field validation ──────────────────────────────
        // Text fields only — a number / object / array is a client error,
        // not a TypeError (500) on .trim().
        const textFields = { name, restaurantName, phone, email, message, source };
        for (const [key, value] of Object.entries(textFields)) {
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return res.status(400).json({ success: false, message: `Invalid ${key}.` });
            }
        }
        const cleanName = (name || '').trim();
        const cleanRestaurant = (restaurantName || '').trim();
        const cleanPhone = (phone || '').trim();

        if (!cleanName || cleanName.length < 2 || cleanName.length > 100) {
            return res.status(400).json({ success: false, message: 'Please enter your name.' });
        }
        if (!cleanRestaurant || cleanRestaurant.length < 2 || cleanRestaurant.length > 100) {
            return res.status(400).json({ success: false, message: 'Please enter your restaurant name.' });
        }
        // Indian mobile: 10 digits 6-9 leading, tolerating +91 / spaces / dashes.
        const phoneDigits = cleanPhone.replace(/[^\d]/g, '').replace(/^91(?=\d{10}$)/, '');
        if (!/^[6-9]\d{9}$/.test(phoneDigits)) {
            return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit mobile number.' });
        }

        // ── Optional fields ────────────────────────────────────────
        const cleanEmail = (email || '').trim().toLowerCase();
        if (cleanEmail && !EMAIL_REGEX.test(cleanEmail)) {
            return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
        }
        const cleanMessage = (message || '').trim().slice(0, 500);

        // meta is free-form but must be a plain object; ignore anything else.
        const safeMeta = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : undefined;

        // AUDIT-EXEMPT: global pre-tenant lead — Lead has no restaurant scope by design.
        const lead = await Lead.create({
            name: cleanName,
            restaurantName: cleanRestaurant,
            phone: phoneDigits,
            email: cleanEmail || undefined,
            message: cleanMessage || undefined,
            source: (source || 'unknown').toString().trim().slice(0, 60),
            meta: safeMeta,
            ip: req.ip,
            userAgent: (req.get('user-agent') || '').slice(0, 400),
        });

        return res.status(202).json({
            success: true,
            data: { leadId: lead._id, submittedAt: lead.createdAt },
            message: "Thanks! We'll reach out within 24 hours.",
        });
    } catch (err) {
        logger.error('public.submitLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Could not submit right now — please try again.' });
    }
};

/**
 * GET /api/v1/public/site-config
 *
 * Editable content for the standalone marketing site (brand name, contact
 * details, social links, optional hero copy). Unauthenticated + cacheable.
 * The marketing site reads this at load and merges it over its built-in
 * defaults, so an empty/never-edited config leaves the site unchanged.
 */
exports.getSiteConfig = async (_req, res) => {
    try {
        // AUDIT-EXEMPT: platform-global marketing config — no tenant scope.
        const s = await MarketingSetting.getSingleton();
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return res.status(200).json({
            success: true,
            data: {
                brandName: s.brandName,
                tagline: s.tagline,
                logoUrl: s.logoUrl,
                demoVideoUrl: s.demoVideoUrl,
                heroHeadline: s.heroHeadline,
                heroSubtitle: s.heroSubtitle,
                platformShots: (s.platformShots || []).map(p => ({
                    url:   p.url   || '',
                    title: p.title || '',
                    desc:  p.desc  || '',
                })),
                supportPhone: s.supportPhone,
                supportEmail: s.supportEmail,
                whatsappNumber: s.whatsappNumber,
                address: s.address,
                social: {
                    instagram: s.social?.instagram || '',
                    facebook:  s.social?.facebook  || '',
                    linkedin:  s.social?.linkedin  || '',
                    youtube:   s.social?.youtube   || '',
                    twitter:   s.social?.twitter   || '',
                },
            },
        });
    } catch (err) {
        logger.error('public.getSiteConfig error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load site config' });
    }
};
