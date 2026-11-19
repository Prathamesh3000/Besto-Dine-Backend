/**
 * Self-service signup — the one implementation behind
 * POST /public/register-restaurant and POST /public/start-trial
 * (TRIAL_SIGNUP_AND_LEADS_PLAN.md §4/§5).
 *
 * The two handlers differ in what they ACCEPT (form shape, plan/payment vs
 * nothing) and in their guards (limiter, messages). Everything after the
 * decision "this signup is a trial on plan P / an active free tenant / a
 * paid tenant" is identical and lives here: plan resolution, slug
 * generation, email/phone dedupe, the subscription snapshot, the
 * Restaurant + owner User + Main branch writes (with rollback), the audit
 * row, the notification emails and the 201/202 response with the session.
 *
 * Errors a handler should turn into a field-level 4xx are thrown as
 * SignupError({ status, field, code, message }); anything else is a real
 * failure and propagates to the handler's 500.
 */
'use strict';

const crypto = require('crypto');
const Razorpay = require('razorpay');
const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const User = require('../models/user');
const AuditLog = require('../models/auditLog');
const logger = require('../utils/logger');
const { skipScope } = require('../utils/tenantScopePlugin');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { isReservedSlug } = require('../utils/reservedSlugs');
const { slugFromName } = require('../utils/signupSlug');
const { sendEmail } = require('../utils/email');
const { signupApplicationReceived, signupAdminAlert, restaurantSelfSignupWelcome } = require('../utils/emailTemplates');
const { resolveRecipients: resolveAlertRecipients } = require('../utils/alerts');
const { createPaidInvoice } = require('../utils/planPaymentApply');
const {
    normalizeCycle, isCycle, addCycle, priceForPlan, priceWithGst, availableCycles,
} = require('../utils/billingCycles');
const {
    normalizeEmailForSignup,
    normalizePhoneForSignup,
    findSignupDuplicate,
    trialPlanSlug,
    trialDaysForPlan,
} = require('../utils/selfSignup');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Plans at or above this tier are quoted ("Contact Sales"), never self-served.
const SELF_SERVE_MAX_TIER = 30;

// Razorpay order notes.type for a signup payment. Distinct from the tenant
// billing 'plan_payment' so a paid upgrade order can never be replayed as a
// signup and vice versa.
const SIGNUP_PAYMENT_NOTE_TYPE = 'signup_plan_payment';

// A payment may differ from the computed price by this much (paise) —
// rounding on Razorpay's side, never a cheaper plan.
const PAYMENT_TOLERANCE_PAISE = 100;

class SignupError extends Error {
    constructor(status, field, message, code) {
        super(message);
        this.name = 'SignupError';
        this.status = status;
        this.field = field || null;
        this.code = code || null;
    }
    send(res) {
        return res.status(this.status).json({
            success: false,
            ...(this.field ? { field: this.field } : {}),
            ...(this.code ? { code: this.code } : {}),
            message: this.message,
        });
    }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const toPlain = (sub) => (sub ? (sub.toObject ? sub.toObject() : { ...sub }) : {});

function frontendBase() {
    return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

// ─── Plan rules ───────────────────────────────────────────────────────────

const planTier = (plan) => (plan && plan.tier !== undefined && plan.tier !== null ? Number(plan.tier) : 0);

function isTrialPlan(plan) {
    return !!(plan && plan.trial && plan.trial.enabled === true);
}

// Free = nothing to charge on any cycle and self-serve tier. An
// Enterprise-style plan is priced 0 because it is quoted, so tier decides.
function isFreePlan(plan) {
    if (!plan || planTier(plan) >= SELF_SERVE_MAX_TIER) return false;
    return !(Number(plan.price) > 0) && availableCycles(plan).length === 0;
}

function isPaidPlan(plan) {
    return !!plan && planTier(plan) < SELF_SERVE_MAX_TIER && availableCycles(plan).length > 0;
}

/**
 * Which kind of tenant a chosen plan produces (plan §5):
 *   'trial'  — trial-enabled plan (also the no-plan default)
 *   'free'   — price 0, tier < 30 → active, no trial, no payment
 *   'paid'   — sells at least one cycle, tier < 30 → payment required
 *   null     — not self-servable (Contact Sales)
 */
function signupModeForPlan(plan) {
    if (isTrialPlan(plan)) return 'trial';
    if (isFreePlan(plan)) return 'free';
    if (isPaidPlan(plan)) return 'paid';
    return null;
}

/**
 * The plan a self-service trial runs on: TRIAL_PLAN_SLUG / the legacy
 * SELF_SIGNUP_TRIAL_PLAN (default 'gold') when that plan is active, else
 * the first active public plan with the trial switch on (by sortOrder).
 * With `legacyFallback` (register-restaurant "decide later") the pre-plan
 * chain follows: cheapest priced active plan, then any active plan. Null
 * when nothing qualifies.
 */
async function resolveTrialPlan({ legacyFallback = false } = {}) {
    let plan = await SubscriptionPlan.findOne({ slug: trialPlanSlug(), isActive: true });
    if (!plan) {
        plan = await SubscriptionPlan.findOne({ isActive: true, isPublic: true, 'trial.enabled': true })
            .sort({ sortOrder: 1, price: 1 });
    }
    if (!plan && legacyFallback) {
        plan = await SubscriptionPlan.findOne({ isActive: true, price: { $gt: 0 } }).sort({ price: 1 });
        if (!plan) plan = await SubscriptionPlan.findOne({ isActive: true }).sort({ price: 1 });
    }
    return plan;
}

/** Public, active plan by id — the only plans a signup form may name. */
async function findPublicPlan(planId) {
    if (typeof planId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(planId)) return null;
    return SubscriptionPlan.findOne({ _id: planId, isPublic: true, isActive: true });
}

// ─── Slug ────────────────────────────────────────────────────────────────

/** Slug from the restaurant name, random suffix when reserved or taken. */
async function generateSlug(name) {
    let slug = slugFromName(name);
    if (!SLUG_REGEX.test(slug) || slug.length < 2) {
        slug = `restaurant-${crypto.randomBytes(3).toString('hex')}`;
    }
    if (isReservedSlug(slug) || await Restaurant.exists({ slug })) {
        slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    }
    return slug;
}

// ─── Dedupe ──────────────────────────────────────────────────────────────

const REGISTER_EMAIL_IN_USE = 'An account with this email already exists. Log in or use another email.';
const START_TRIAL_EMAIL_IN_USE = 'This email already has an account. Please sign in.';
const PHONE_IN_USE = 'A restaurant is already registered with this mobile number. Log in or use another number.';

/**
 * Refuse a signup whose email belongs to any existing user (customer,
 * staff, super admin) or whose email alias / phone already owns a
 * restaurant (one trial per person — gmail dots and +tags collapse).
 * `fields` maps the conflict to the caller's own field names.
 */
async function assertNoSignupConflict({ email, phone, emailMessage = REGISTER_EMAIL_IN_USE, fields = {} }) {
    const emailField = fields.email || 'contactEmail';
    const phoneField = fields.phone || 'contactPhone';
    if (await User.exists({ email })) {
        throw new SignupError(409, emailField, emailMessage, 'EMAIL_IN_USE');
    }
    const duplicate = await findSignupDuplicate(Restaurant, { email, phone });
    if (duplicate) {
        if (duplicate.code === 'EMAIL_IN_USE') throw new SignupError(409, emailField, emailMessage, 'EMAIL_IN_USE');
        throw new SignupError(409, phoneField, duplicate.message, duplicate.code);
    }
}

// ─── Payment (paid plan at signup) ───────────────────────────────────────

function razorpayClient() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** GST-inclusive charge for a plan cycle, or null when the cycle isn't sold. */
function signupCharge(plan, cycle) {
    const base = priceForPlan(plan, cycle);
    if (base === null) return null;
    return { base, ...priceWithGst(base) };
}

const PAYMENT_REVIEW_MESSAGE = 'We could not match this payment to the plan you chose. Please review your plan and billing cycle, or contact support if you were charged.';

/**
 * Verify a Razorpay payment pays for `plan` on `cycle` (plan §5):
 * HMAC(order_id|payment_id) with the key secret, then the fetched payment
 * must belong to the order, be captured/authorized, INR, carry the signup
 * notes for this plan + cycle and be within PAYMENT_TOLERANCE_PAISE of the
 * GST-inclusive price. Returns the payment entity; throws SignupError
 * 400 PAYMENT_MISMATCH (or 503 when Razorpay isn't configured, 502 when
 * the fetch fails).
 */
async function verifySignupPayment({ plan, cycle, payment }) {
    const orderId = str(payment && payment.razorpayOrderId);
    const paymentId = str(payment && payment.razorpayPaymentId);
    const signature = str(payment && payment.razorpaySignature);
    if (!orderId || !paymentId || !signature) {
        throw new SignupError(400, 'payment', 'Payment details are required for a paid plan.', 'PAYMENT_REQUIRED');
    }
    const client = razorpayClient();
    if (!client) {
        throw new SignupError(503, null, 'Online billing is temporarily unavailable. Please try again later.', 'BILLING_NOT_CONFIGURED');
    }
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEqual(expectedSig, signature)) {
        logger.warn(`signup payment: signature mismatch for order ${orderId}`);
        throw new SignupError(400, 'payment', PAYMENT_REVIEW_MESSAGE, 'PAYMENT_MISMATCH');
    }

    let rp;
    try {
        rp = await client.payments.fetch(paymentId);
    } catch (fetchErr) {
        logger.error(`signup payment: payments.fetch failed for ${paymentId}: ${fetchErr.message}`);
        throw new SignupError(502, 'payment', 'Could not verify the payment with Razorpay. Please try again in a moment.', 'RAZORPAY_FETCH_FAILED');
    }

    const charge = signupCharge(plan, cycle);
    const notes = (rp && rp.notes) || {};
    const problems = [];
    if (!rp || rp.order_id !== orderId) problems.push('order_id');
    if (!rp || !['captured', 'authorized'].includes(rp.status)) problems.push(`status ${rp && rp.status}`);
    if (rp && rp.currency && rp.currency !== 'INR') problems.push(`currency ${rp.currency}`);
    if (notes.type !== SIGNUP_PAYMENT_NOTE_TYPE) problems.push('notes.type');
    if (notes.planSlug !== plan.slug) problems.push('notes.planSlug');
    if (notes.billingCycle !== cycle) problems.push('notes.billingCycle');
    if (!charge || Math.abs(Number(rp && rp.amount) - charge.totalPaise) > PAYMENT_TOLERANCE_PAISE) problems.push('amount');
    if (problems.length) {
        logger.warn(`signup payment: payment ${paymentId} does not pay for ${plan.slug}/${cycle}: ${problems.join(', ')}`);
        throw new SignupError(400, 'payment', PAYMENT_REVIEW_MESSAGE, 'PAYMENT_MISMATCH');
    }
    return rp;
}

/** 409 when a SubscriptionInvoice already exists for this payment id. */
async function assertPaymentUnused(paymentId) {
    // AUDIT-EXEMPT: razorpayPaymentId is platform-unique; no tenant exists yet.
    const used = await skipScope(SubscriptionInvoice.findOne({ razorpayPaymentId: paymentId }).select('_id').lean());
    if (used) {
        throw new SignupError(409, 'payment', 'This payment has already been used for a registration. Please sign in.', 'PAYMENT_ALREADY_USED');
    }
}

// ─── Snapshot + provisioning ─────────────────────────────────────────────

/**
 * Restaurant.subscription for a new tenant.
 *   trial → status 'trial', trialStartDate now, trialEndDate now + days
 *   free  → status 'active', no trial dates, price 0
 *   paid  → status 'active', price/billingCycle, lastChargedAt now,
 *           currentPeriodEnd = now + cycle
 */
function buildSnapshot(plan, { mode, trialDays, cycle, now = new Date() }) {
    const base = {
        plan: plan._id,
        planName: plan.name,
        planSlug: plan.slug,
        features: toPlain(plan.features),
        limits: toPlain(plan.limits),
        startDate: now,
        endDate: null,
    };
    if (mode === 'trial') {
        return {
            ...base,
            status: 'trial',
            trialStartDate: now,
            trialEndDate: new Date(now.getTime() + trialDays * DAY_MS),
        };
    }
    if (mode === 'paid') {
        const c = normalizeCycle(cycle);
        return {
            ...base,
            status: 'active',
            price: priceForPlan(plan, c),
            billingCycle: c,
            trialEndDate: null,
            lastChargedAt: now,
            currentPeriodEnd: addCycle(now, c),
            razorpayStatus: 'active',
        };
    }
    return { ...base, status: 'active', price: 0, billingCycle: 'monthly', trialEndDate: null };
}

/**
 * Create Restaurant + owner User (+ Main branch, + audit row). Rolls the
 * restaurant back when the owner cannot be created. Unique-index races are
 * translated into the same 409s the pre-checks give.
 *
 * Returns { restaurant, ownerUser }.
 */
async function provisionTenant({
    name, slug, email, phone, city = '', ownerName, password,
    plan, snapshot, mode, trialDays = 0, needsApproval,
    registrationSource, requestedPlan = null, signupMeta,
    emailMessage = REGISTER_EMAIL_IN_USE, fields = {},
    audit = {}, req,
}) {
    const emailField = fields.email || 'contactEmail';
    const phoneField = fields.phone || 'contactPhone';
    const now = snapshot.startDate || new Date();
    const liveStatus = mode === 'trial' ? 'trial' : 'active';

    let restaurant;
    try {
        restaurant = await Restaurant.create({
            name,
            slug,
            contactEmail: email,
            contactPhone: phone || '',
            contactEmailNormalized: normalizeEmailForSignup(email),
            ...(phone ? { contactPhoneNormalized: normalizePhoneForSignup(phone) } : {}),
            city,
            ...(needsApproval ? {
                status: 'suspended',
                signupStatus: 'pending',
                suspendedAt: new Date(),
                suspendedReason: 'Awaiting Super Admin approval',
            } : {
                status: liveStatus,
                signupStatus: 'approved',
                signupReviewedAt: now,
            }),
            signupSource: 'self',
            registrationSource,
            subscription: snapshot,
            ...(requestedPlan ? {
                requestedPlan: { plan: requestedPlan._id, planName: requestedPlan.name, planSlug: requestedPlan.slug },
            } : {}),
            signupMeta: { ...signupMeta, ownerName },
        });
    } catch (createErr) {
        if (createErr && createErr.code === 11000) {
            const key = Object.keys(createErr.keyPattern || {})[0] || '';
            if (key === 'contactPhoneNormalized') throw new SignupError(409, phoneField, PHONE_IN_USE, 'PHONE_IN_USE');
            if (key === 'slug') throw new SignupError(409, 'slug', 'This restaurant URL is already taken. Please choose another.', 'SLUG_TAKEN');
            throw new SignupError(409, emailField, emailMessage, 'EMAIL_IN_USE');
        }
        throw createErr;
    }

    let ownerUser;
    try {
        ownerUser = await User.create({
            name: ownerName,
            email,
            password, // hashed by the userSchema.pre('save') hook
            mobile: phone || '',
            role: 'admin',
            restaurant: restaurant._id,
            // CRIT-06 — THIS user is the tenant owner. Sub-admins created
            // later via /staff leave this at its default (false).
            isTenantOwner: true,
            mustChangePassword: false, // they chose this password themselves
            status: 'active',
        });
        restaurant.owner = ownerUser._id;
        await restaurant.save();
    } catch (innerErr) {
        await Restaurant.findByIdAndDelete(restaurant._id).catch(() => {});
        if (innerErr && innerErr.code === 11000) throw new SignupError(409, emailField, emailMessage, 'EMAIL_IN_USE');
        throw innerErr;
    }

    // Main branch — non-fatal, the backfill script repairs a tenant later.
    try {
        await createMainBranchFor(restaurant, ownerUser._id);
    } catch (branchErr) {
        logger.error(`self-signup: createMainBranchFor failed for ${restaurant.slug}: ${branchErr.message}`);
    }

    // Audit entry (system actor — no req.user available). Mirror of the
    // Razorpay webhook + alerts pattern.
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
                mode,
                registrationSource,
                requestedPlan: (requestedPlan && requestedPlan.slug) || '',
                trialDays: mode === 'trial' ? trialDays : 0,
                instantStart: !needsApproval,
                ownerEmail: email,
                source: signupMeta.source,
                ...audit,
            },
            ip: (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || '',
            userAgent: (req && req.headers && req.headers['user-agent']) || '',
        });
    } catch (auditErr) {
        logger.warn(`self-signup audit write failed: ${auditErr.message}`);
    }

    return { restaurant, ownerUser };
}

/**
 * Invoice for the payment a paid signup was created from. Returns the
 * invoice number ('' when another path already materialised the payment —
 * the pre-check makes that a race, not a normal case).
 */
async function invoiceSignupPayment({ restaurant, payment, cycle }) {
    const periodStart = restaurant.subscription.startDate || new Date();
    const periodEnd = restaurant.subscription.currentPeriodEnd || addCycle(periodStart, cycle);
    const created = await createPaidInvoice({
        restaurant, payment, logTag: 'signup-payment',
        billingCycle: cycle, periodStart, periodEnd,
    });
    if (created.deduped) {
        logger.warn(`signup-payment: payment ${payment.id} was invoiced elsewhere while provisioning ${restaurant.slug}`);
        return '';
    }
    return created.invoiceNumber;
}

// ─── Attribution + emails ────────────────────────────────────────────────

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

/** Owner welcome / "application received" + Super Admin alert. Never throws. */
function notifySignupReceived({ restaurant, ownerName, requestedPlanName, source, instant = false, trialDays }) {
    setImmediate(async () => {
        try {
            await sendEmail({
                to: restaurant.contactEmail,
                ...(instant
                    ? restaurantSelfSignupWelcome({
                        restaurantName: restaurant.name,
                        ownerName,
                        email: restaurant.contactEmail,
                        planName: (restaurant.subscription && restaurant.subscription.planName) || '',
                        trialDays,
                        slug: restaurant.slug,
                    })
                    : signupApplicationReceived({
                        restaurantName: restaurant.name,
                        ownerName,
                        email: restaurant.contactEmail,
                        slug: restaurant.slug,
                    })),
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

// ─── Response ────────────────────────────────────────────────────────────

/**
 * The signup response. Instant (no approval): 201 with the same body a
 * login returns (user + tenant + token/refreshToken or cookie hints) so
 * the SPA signs the owner in without a second request. Approval mode:
 * 202, no session — the owner logs in at /staff-login once approved.
 */
async function respondSignup(req, res, {
    restaurant, ownerUser, plan, mode, trialDays = 0, needsApproval,
    requestedPlan = null, logTag, invoiceNumber = '',
}) {
    const email = restaurant.contactEmail;
    const pageUrl = `${frontendBase()}/${restaurant.slug}`;
    const sub = restaurant.subscription || {};
    const isTrial = mode === 'trial';

    if (!needsApproval) {
        logger.info(`${logTag} ${isTrial ? 'TRIAL STARTED' : 'ACTIVE'} ${restaurant.slug} (${email})`);
        const message = isTrial
            ? `Welcome to BestoDine! Your ${trialDays}-day free trial of ${plan.name} has started.`
            : `Welcome to BestoDine! Your ${plan.name} plan is active.`;
        // A session failure must not lose the signup: the owner can still
        // log in at /staff-login.
        let session = {};
        try {
            session = await require('./authController').issueSignupSession(req, res, ownerUser);
        } catch (sessErr) {
            logger.warn(`${logTag} auto-login failed for ${restaurant.slug}: ${sessErr.message}`);
        }
        return res.status(201).json({
            success: true,
            data: {
                restaurant: { _id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
                owner: { _id: ownerUser._id, name: ownerUser.name, email: ownerUser.email },
                signupStatus: 'approved',
                registrationSource: restaurant.registrationSource,
                subscriptionStatus: sub.status,
                trialStarted: isTrial,
                autoLogin: !!(session.token || session.cookieAuth),
                trialStartDate: isTrial ? sub.trialStartDate : null,
                trialEndDate: isTrial ? sub.trialEndDate : null,
                trialDays: isTrial ? trialDays : 0,
                planName: plan.name,
                planSlug: plan.slug,
                billingCycle: mode === 'paid' ? sub.billingCycle : null,
                currentPeriodEnd: mode === 'paid' ? sub.currentPeriodEnd : null,
                invoiceNumber: invoiceNumber || null,
                pageUrl,
                requestedPlan: requestedPlan ? { _id: requestedPlan._id, name: requestedPlan.name } : null,
                message,
            },
            message,
            ...session,
        });
    }

    logger.info(`${logTag} PENDING ${restaurant.slug} (${email})`);
    const message = `Thanks for signing up! Your application is being reviewed — usually within 1 business day. We'll email ${email} once it's approved.`;
    return res.status(202).json({
        success: true,
        data: {
            restaurant: { _id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
            owner: { _id: ownerUser._id, name: ownerUser.name, email: ownerUser.email },
            signupStatus: 'pending',
            registrationSource: restaurant.registrationSource,
            pageUrl,
            requestedPlan: requestedPlan ? { _id: requestedPlan._id, name: requestedPlan.name } : null,
            message,
        },
        message,
    });
}

/**
 * One self-service signup, end to end, after the handler has validated its
 * own form and decided the mode. Throws SignupError for 4xx outcomes.
 *
 *   mode 'trial'  → plan + trialDays
 *   mode 'free'   → plan
 *   mode 'paid'   → plan + cycle + verified `payment` entity
 */
async function completeSignup(req, res, {
    name, email, phone, city, ownerName, password, slug: explicitSlug,
    plan, mode, cycle, payment, trialDays, needsApproval,
    requestedPlan, signupMeta, registrationSource,
    emailMessage, fields, logTag,
}) {
    const days = mode === 'trial' ? (trialDays || trialDaysForPlan(plan)) : 0;
    const c = mode === 'paid' ? normalizeCycle(cycle) : undefined;
    const slug = explicitSlug || await generateSlug(name);
    const snapshot = buildSnapshot(plan, { mode, trialDays: days, cycle: c });

    const { restaurant, ownerUser } = await provisionTenant({
        name, slug, email, phone, city, ownerName, password,
        plan, snapshot, mode, trialDays: days, needsApproval,
        registrationSource, requestedPlan, signupMeta,
        emailMessage, fields, req,
        audit: mode === 'paid' ? {
            billingCycle: c,
            razorpayPaymentId: payment.id,
            razorpayOrderId: payment.order_id,
            amountPaise: payment.amount,
        } : {},
    });

    let invoiceNumber = '';
    if (mode === 'paid') {
        try {
            invoiceNumber = await invoiceSignupPayment({ restaurant, payment, cycle: c });
        } catch (invErr) {
            // The tenant is live and the charge happened; an operator can
            // reconcile from the audit row. Never fail the signup here.
            logger.error(`${logTag}: invoice failed for ${restaurant.slug} (payment ${payment.id}): ${invErr.message}`);
        }
    }

    notifySignupReceived({
        restaurant,
        ownerName,
        requestedPlanName: (requestedPlan && requestedPlan.name) || (mode !== 'trial' ? plan.name : ''),
        source: signupMeta.source || signupMeta.utmSource,
        instant: !needsApproval,
        trialDays: days,
    });

    return respondSignup(req, res, {
        restaurant, ownerUser, plan, mode, trialDays: days, needsApproval,
        requestedPlan, logTag, invoiceNumber,
    });
}

module.exports = {
    SignupError,
    EMAIL_REGEX,
    SLUG_REGEX,
    SELF_SERVE_MAX_TIER,
    SIGNUP_PAYMENT_NOTE_TYPE,
    PAYMENT_TOLERANCE_PAISE,
    REGISTER_EMAIL_IN_USE,
    START_TRIAL_EMAIL_IN_USE,
    str,
    frontendBase,
    isTrialPlan,
    isFreePlan,
    isPaidPlan,
    signupModeForPlan,
    resolveTrialPlan,
    findPublicPlan,
    generateSlug,
    assertNoSignupConflict,
    razorpayClient,
    signupCharge,
    verifySignupPayment,
    assertPaymentUnused,
    buildSnapshot,
    provisionTenant,
    buildSignupMeta,
    notifySignupReceived,
    respondSignup,
    completeSignup,
    isCycle,
};
