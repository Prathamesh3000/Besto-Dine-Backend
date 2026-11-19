const Restaurant = require('../models/restaurant');
const { isTrialLocked } = require('../utils/trialLock');
const Branch = require('../models/branch');
const Lead = require('../models/lead');
const MarketingSetting = require('../models/marketingSetting');
const logger = require('../utils/logger');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { publicOperationsOf } = require('../utils/operationsProfile');
const { checkExplicitRestaurantSlug } = require('../utils/reservedSlugs');
const mongoose = require('mongoose');
const Settings = require('../models/settings');
const { isStrongPassword, STRONG_PASSWORD_MESSAGE } = require('../utils/passwordPolicy');
const { normalizeMobile } = require('../utils/mobile');
const { slugify, slugFromName, slugIssue, suggestSlugs } = require('../utils/signupSlug');
const { getPublicPlans } = require('../utils/publicPlans');
const { isBillingConfigured } = require('../utils/razorpayBilling');
const { signupRequiresApproval, trialDaysForPlan } = require('../utils/selfSignup');
// Everything a signup does after "this is a trial / free / paid tenant"
// (slug, dedupe, snapshot, Restaurant + owner + branch, audit, emails,
// session) is shared by registerRestaurant and startTrial.
const {
    SignupError,
    EMAIL_REGEX,
    SIGNUP_PAYMENT_NOTE_TYPE,
    START_TRIAL_EMAIL_IN_USE,
    str,
    signupModeForPlan,
    resolveTrialPlan,
    findPublicPlan,
    assertNoSignupConflict,
    razorpayClient,
    signupCharge,
    verifySignupPayment,
    assertPaymentUnused,
    buildSignupMeta,
    completeSignup,
    isCycle,
} = require('./publicSignupShared');

// ─── Shared helpers ─────────────────────────────────────────────────────

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
                .select('name slug city logo subscription status')
                .sort({ name: 1 })
                .limit(limit)
                .lean();

            res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
            const open = rows.filter((r) => !isTrialLocked(r));
            return res.status(200).json({
                success: true,
                count: open.length,
                data: open.map((r) => ({
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    logo: r.logo || '',
                })),
            });
        }

        const restaurants = (await Restaurant.find({
            status: { $in: ['active', 'trial'] },
        })
            .select('name slug status city contactPhone logo branding createdAt subscription featureOverrides addons operations')
            .sort({ name: 1 })
            .lean()).filter((r) => !isTrialLocked(r));

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
        }).select('name slug status city contactPhone logo branding subscription featureOverrides addons operations').lean();

        if (!restaurant || isTrialLocked(restaurant)) {
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
        }).select('_id name status subscription').lean();
        if (!tenant || isTrialLocked(tenant)) {
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
 * POST /api/v1/public/register-restaurant   (Phase 5 step 2, plan §5)
 *
 * Self-service tenant signup from the multi-step form (details, optional
 * plan, payment for a paid plan). Unauthenticated; creates Restaurant +
 * owner User + Main branch in one request through publicSignupShared.
 * The owner supplies their own password.
 *
 * What the chosen plan decides (TRIAL_SIGNUP_AND_LEADS_PLAN.md §5):
 *   - no planId ("decide later") → trial on the default trial plan
 *     (TRIAL_PLAN_SLUG / SELF_SIGNUP_TRIAL_PLAN, default Gold), 14 days or
 *     the plan's own trial length; registrationSource 'self_service_trial'
 *   - trial-enabled plan → trial on THAT plan, same as /start-trial
 *   - free plan (price 0, tier < 30) → status 'active', no trial dates,
 *     registrationSource 'self_service'
 *   - paid plan (sells a cycle, tier < 30) → `payment` is required
 *     ({ razorpayOrderId, razorpayPaymentId, razorpaySignature } from the
 *     /public/register-order checkout) and is verified server-side
 *     (signature, order, status, INR, notes, amount ±100 paise → else 400
 *     PAYMENT_MISMATCH; reused payment → 409 PAYMENT_ALREADY_USED). The
 *     tenant starts 'active' with price / billingCycle / lastChargedAt /
 *     currentPeriodEnd and a SubscriptionInvoice; registrationSource
 *     'self_service'
 *   - Contact-Sales plan (tier >= 30) → 400 PLAN_NOT_SELF_SERVE
 *
 * INSTANT START (default): the tenant is usable at once and the response
 * logs the owner in (201 + session). With SELF_SIGNUP_REQUIRE_APPROVAL=true
 * every path instead creates a pending signup (tenant 'suspended',
 * signupStatus 'pending', 202, no tokens) until a Super Admin approves it.
 *
 * Anti-abuse: `signupLimiter` on the route (SIGNUP_RATE_LIMIT_PER_HOUR,
 * default 3 successful signups per hour per IP); email + phone dedupe with
 * gmail alias folding (utils/selfSignup).
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
            billingCycle,
            payment,
        } = body;

        const fail = (status, field, message, code) => res.status(status).json({
            success: false, ...(field ? { field } : {}), ...(code ? { code } : {}), message,
        });

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

        // ── Chosen plan → signup mode ──────────────────────────────────
        let chosenPlan = null;
        if (planId !== undefined && planId !== null && planId !== '') {
            if (typeof planId !== 'string' || !mongoose.isValidObjectId(planId)) {
                return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
            }
            chosenPlan = await findPublicPlan(planId);
            if (!chosenPlan) return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
        }

        let mode = 'trial';
        let plan = chosenPlan;
        let cycle;
        let verifiedPayment = null;
        if (chosenPlan) {
            mode = signupModeForPlan(chosenPlan);
            if (!mode) {
                return fail(400, 'planId',
                    `${chosenPlan.name} is set up with our sales team. Please contact us and we will get you started.`,
                    'PLAN_NOT_SELF_SERVE');
            }
            if (mode === 'paid') {
                cycle = billingCycle === undefined || billingCycle === null || billingCycle === '' ? 'monthly' : billingCycle;
                if (!isCycle(cycle) || signupCharge(chosenPlan, cycle) === null) {
                    return fail(400, 'billingCycle', 'Please choose a billing cycle offered on this plan.', 'INVALID_CYCLE');
                }
                if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
                    return fail(400, 'payment', `${chosenPlan.name} is a paid plan — please complete the payment to continue.`, 'PAYMENT_REQUIRED');
                }
            }
        } else {
            // "Decide later": today's behaviour — a trial on the default
            // trial plan. Enterprise is priced 0 because it is quoted, so
            // the legacy fallback never picks it by cheapest-first alone.
            plan = await resolveTrialPlan({ legacyFallback: true });
            if (!plan) {
                logger.error('public.registerRestaurant: no active subscription plans found');
                return res.status(503).json({
                    success: false,
                    message: 'Self-service signup is temporarily unavailable. Please contact support.',
                });
            }
        }
        // Dedupe happens BEFORE the payment is checked so a duplicate email
        // never gets as far as consuming a payment id.
        const needsApproval = signupRequiresApproval();
        const registrationSource = mode === 'trial' ? 'self_service_trial' : 'self_service';
        const signupMeta = buildSignupMeta(body, { ownerName: cleanOwner, ip: req.ip });

        // ── Explicit slug (optional) ───────────────────────────────────
        // Reserved slugs (utils/reservedSlugs.js) would collide with a
        // top-level frontend route at /<slug>: an explicit one is refused
        // (400 SLUG_RESERVED); a generated one is auto-suffixed instead.
        let explicitSlug = null;
        if (body.slug !== undefined && body.slug !== null && body.slug !== '') {
            const checked = checkExplicitRestaurantSlug(body.slug);
            if (checked.error) {
                return fail(checked.error.status, 'slug', checked.error.message, checked.error.code);
            }
            explicitSlug = checked.slug;
            if (await Restaurant.exists({ slug: explicitSlug })) {
                return fail(409, 'slug', 'This restaurant URL is already taken. Please choose another.', 'SLUG_TAKEN');
            }
        }

        // ── Email / phone uniqueness (one trial per person) ────────────
        await assertNoSignupConflict({ email: cleanEmail, phone: cleanPhone });

        // ── Paid plan: verify the payment, refuse a reused one ─────────
        if (mode === 'paid') {
            await assertPaymentUnused(str(payment.razorpayPaymentId));
            verifiedPayment = await verifySignupPayment({ plan, cycle, payment });
        }

        return await completeSignup(req, res, {
            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,
            city: cleanCity,
            ownerName: cleanOwner,
            password,
            slug: explicitSlug,
            plan,
            mode,
            cycle,
            payment: verifiedPayment,
            needsApproval,
            // The chosen plan IS the plan on every path now; requestedPlan
            // stays populated for the Pending Approvals queue + alert mail.
            requestedPlan: chosenPlan ? { _id: chosenPlan._id, name: chosenPlan.name, slug: chosenPlan.slug } : null,
            signupMeta,
            registrationSource,
            logTag: 'self-signup',
        });
    } catch (err) {
        if (err instanceof SignupError) return err.send(res);
        logger.error('public.registerRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to register restaurant' });
    }
};

/**
 * POST /api/v1/public/start-trial   (plan §4)
 *
 * Why a separate route from /register-restaurant:
 *   - different funnel: one short form (name, your name, email, mobile,
 *     password) instead of the multi-step details → plan → payment flow;
 *   - different trust model: the client sends NO plan, price or trial
 *     length — the server decides all three (TRIAL_PLAN_SLUG, the plan's
 *     trial.durationDays, SELF_SIGNUP_TRIAL_DAYS);
 *   - different guards: its own rate limit (`public-start-trial`,
 *     TRIAL_START_LIMIT_PER_HOUR), its own dedupe messages
 *     ("This email already has an account. Please sign in.");
 *   - different data: registrationSource 'self_service_trial' for
 *     analytics, the trial lifecycle and the Signup Leads module;
 *   - keeps /register-restaurant strict: a change to how trials start can
 *     never loosen the payment validation on the paid path.
 *
 * Body: { orgName, email, phone?, adminName, adminPassword }
 * (restaurantName / contactEmail / contactPhone / ownerName / password
 * are accepted as aliases). Password ≥ 8 characters.
 *
 * Plan: TRIAL_PLAN_SLUG → legacy SELF_SIGNUP_TRIAL_PLAN → first active
 * public plan with trial.enabled by sortOrder → 503 TRIAL_UNAVAILABLE.
 * Trial length: plan.trial.durationDays when enabled and > 0, else 14.
 *
 * Response: identical in shape to the instant /register-restaurant
 * response (201 + session). With SELF_SIGNUP_REQUIRE_APPROVAL=true the
 * same pending signup is created (202, no session) — the approval gate is
 * never bypassed by this route.
 */
exports.startTrial = async (req, res) => {
    try {
        const body = req.body || {};
        const fail = (status, field, message, code) => res.status(status).json({
            success: false, ...(field ? { field } : {}), ...(code ? { code } : {}), message,
        });
        const first = (...keys) => {
            for (const k of keys) {
                if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
            }
            return undefined;
        };

        const orgName = str(first('orgName', 'restaurantName'));
        if (!orgName) return fail(400, 'orgName', 'Restaurant name is required');
        if (orgName.length < 2) return fail(400, 'orgName', 'Restaurant name must be at least 2 characters');
        if (orgName.length > 80) return fail(400, 'orgName', 'Restaurant name cannot exceed 80 characters');

        const adminName = str(first('adminName', 'ownerName'));
        if (!adminName) return fail(400, 'adminName', 'Your name is required');
        if (adminName.length > 80) return fail(400, 'adminName', 'Your name cannot exceed 80 characters');

        const email = str(first('email', 'contactEmail')).toLowerCase();
        if (!email || !EMAIL_REGEX.test(email)) return fail(400, 'email', 'A valid email address is required');
        if (email.length > 120) return fail(400, 'email', 'Email cannot exceed 120 characters');

        const rawPhone = first('phone', 'contactPhone');
        let phone = '';
        if (rawPhone !== undefined && str(String(rawPhone)) !== '') {
            phone = normalizeMobile(rawPhone);
            if (!phone) return fail(400, 'phone', 'Please enter a valid 10-digit mobile number');
        }

        const password = first('adminPassword', 'password');
        if (typeof password !== 'string' || !password) return fail(400, 'adminPassword', 'Password is required');
        if (password.length < 8) return fail(400, 'adminPassword', 'Password must be at least 8 characters', 'WEAK_PASSWORD');
        if (password.length > 128) return fail(400, 'adminPassword', 'Password cannot exceed 128 characters', 'WEAK_PASSWORD');

        // ── Server-chosen plan + length ───────────────────────────────
        const plan = await resolveTrialPlan();
        if (!plan) {
            logger.error('public.startTrial: no trial plan available (TRIAL_PLAN_SLUG / trial.enabled)');
            return fail(503, null, 'Free trials are temporarily unavailable', 'TRIAL_UNAVAILABLE');
        }
        const trialDays = trialDaysForPlan(plan);

        // ── Dedupe ───────────────────────────────────────────────────
        const fields = { email: 'email', phone: 'phone' };
        await assertNoSignupConflict({ email, phone, emailMessage: START_TRIAL_EMAIL_IN_USE, fields });

        const needsApproval = signupRequiresApproval();
        const signupMeta = buildSignupMeta(body, { ownerName: adminName, ip: req.ip });

        return await completeSignup(req, res, {
            name: orgName,
            email,
            phone,
            city: str(body.city).slice(0, 80),
            ownerName: adminName,
            password,
            plan,
            mode: 'trial',
            trialDays,
            needsApproval,
            requestedPlan: null,
            signupMeta,
            registrationSource: 'self_service_trial',
            emailMessage: START_TRIAL_EMAIL_IN_USE,
            fields,
            logTag: 'start-trial',
        });
    } catch (err) {
        if (err instanceof SignupError) return err.send(res);
        logger.error('public.startTrial error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to start your trial' });
    }
};

/**
 * POST /api/v1/public/register-order   { planId, billingCycle }   (plan §5)
 *
 * Razorpay order for the payment step of a PAID plan signup. The plan must
 * be active, public, self-serve (tier < 30), sell the cycle, and not be
 * trial-enabled (a trial-enabled plan starts a trial — the owner must not
 * be charged for it). Amount = priceWithGst(priceForPlan(plan, cycle)),
 * INR, notes { type: 'signup_plan_payment', planSlug, billingCycle } which
 * registerRestaurant later checks against the request.
 *
 * → 200 { orderId, amount, currency, keyId, plan: { _id, slug, name },
 *         billingCycle, baseAmount, gstAmount, gstRate }  (money in paise)
 * → 503 BILLING_NOT_CONFIGURED when Razorpay keys are missing.
 */
exports.createRegisterOrder = async (req, res) => {
    try {
        const { planId, billingCycle } = req.body || {};
        const fail = (status, field, message, code) => res.status(status).json({
            success: false, ...(field ? { field } : {}), ...(code ? { code } : {}), message,
        });

        if (typeof planId !== 'string' || !mongoose.isValidObjectId(planId)) {
            return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
        }
        const plan = await findPublicPlan(planId);
        if (!plan) return fail(400, 'planId', 'Please choose a valid plan', 'INVALID_PLAN');
        const mode = signupModeForPlan(plan);
        if (mode === 'trial') {
            return fail(400, 'planId', `${plan.name} starts with a free trial — no payment is needed to sign up.`, 'PLAN_NOT_PAYABLE');
        }
        if (mode === 'free') {
            return fail(400, 'planId', `${plan.name} is free — no payment is needed to sign up.`, 'PLAN_NOT_PAYABLE');
        }
        if (mode !== 'paid') {
            return fail(400, 'planId', `${plan.name} is set up with our sales team. Please contact us.`, 'PLAN_NOT_SELF_SERVE');
        }
        const cycle = billingCycle === undefined || billingCycle === null || billingCycle === '' ? 'monthly' : billingCycle;
        if (!isCycle(cycle)) return fail(400, 'billingCycle', 'Please choose a billing cycle offered on this plan.', 'INVALID_CYCLE');
        const charge = signupCharge(plan, cycle);
        if (!charge) return fail(400, 'billingCycle', 'Please choose a billing cycle offered on this plan.', 'INVALID_CYCLE');

        if (!isBillingConfigured()) {
            return res.status(503).json({
                success: false,
                code: 'BILLING_NOT_CONFIGURED',
                message: 'Online payment is temporarily unavailable. Please try again later or contact support.',
            });
        }

        let order;
        try {
            order = await razorpayClient().orders.create({
                amount: charge.totalPaise,
                currency: 'INR',
                receipt: `s_${plan.slug.slice(0, 8)}_${Date.now()}`.slice(0, 40),
                notes: {
                    type: SIGNUP_PAYMENT_NOTE_TYPE,
                    planSlug: plan.slug,
                    planName: plan.name,
                    billingCycle: cycle,
                    basePaise: String(charge.basePaise),
                    gstRate: String(charge.gstRate),
                },
            });
        } catch (rzpErr) {
            const description = (rzpErr && rzpErr.error && rzpErr.error.description) || (rzpErr && rzpErr.message) || 'Unknown error';
            logger.error(`public.createRegisterOrder: orders.create failed for ${plan.slug}/${cycle}: ${description}`);
            return res.status(502).json({
                success: false,
                code: 'BILLING_SETUP_FAILED',
                message: 'We could not set up the payment with Razorpay. Please try again.',
            });
        }

        res.set('Cache-Control', 'no-store');
        return res.status(200).json({
            success: true,
            data: {
                orderId: order.id,
                amount: charge.totalPaise,
                currency: 'INR',
                keyId: process.env.RAZORPAY_KEY_ID,
                plan: { _id: plan._id, slug: plan.slug, name: plan.name },
                billingCycle: cycle,
                baseAmount: charge.basePaise,
                gstAmount: charge.gstPaise,
                gstRate: charge.gstRate,
            },
        });
    } catch (err) {
        logger.error('public.createRegisterOrder error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to start the payment' });
    }
};

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
