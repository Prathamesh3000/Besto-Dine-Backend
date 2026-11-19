/**
 * Hotel self-signup constants shared by publicController (signup) and
 * superadminController (approval restarts the trial clock), plus the
 * trial-abuse identity helpers (one free trial per email / phone).
 */
'use strict';

// Trial length when the tenant's snapshot plan has no trialDays of its own.
const SELF_SIGNUP_TRIAL_DAYS = 14;

/**
 * Slug of the plan a self-service trial runs on (plan §4). TRIAL_PLAN_SLUG
 * wins, the legacy SELF_SIGNUP_TRIAL_PLAN is honoured, default 'gold'.
 * Read at call time so a test (or a hot config reload) can change it.
 */
function trialPlanSlug() {
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : '');
    return pick(process.env.TRIAL_PLAN_SLUG) || pick(process.env.SELF_SIGNUP_TRIAL_PLAN) || 'gold';
}

/**
 * Trial length for a plan: its own `trial.durationDays` when the trial
 * switch is on and the length is > 0, else the platform constant. Accepts a
 * Mongoose doc or a lean object; a missing plan gives the constant.
 */
function trialDaysForPlan(plan) {
    const t = plan && plan.trial;
    if (t && t.enabled === true) {
        const d = Number(t.durationDays);
        if (Number.isFinite(d) && d > 0) return Math.round(d);
    }
    return SELF_SIGNUP_TRIAL_DAYS;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Collapse the aliases one mailbox can have: lowercase; `+tag` dropped on
 * every domain; dots dropped in the local part on Gmail (and googlemail.com
 * folded into gmail.com). 'A.B+x@Gmail.com' → 'ab@gmail.com'.
 */
function normalizeEmailForSignup(email) {
    const raw = String(email || '').trim().toLowerCase();
    const at = raw.lastIndexOf('@');
    if (at < 1) return raw;
    let local = raw.slice(0, at);
    let domain = raw.slice(at + 1);
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
    if (GMAIL_DOMAINS.has(domain)) {
        local = local.replace(/\./g, '');
        domain = 'gmail.com';
    }
    return `${local}@${domain}`;
}

/** Digits only, last 10 ('+91 98765-43210' → '9876543210'); '' if shorter. */
function normalizePhoneForSignup(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Self-signups start the trial immediately (no approval wait) unless
 * SELF_SIGNUP_REQUIRE_APPROVAL=true restores the Super Admin review queue.
 */
function signupRequiresApproval() {
    return String(process.env.SELF_SIGNUP_REQUIRE_APPROVAL || '').toLowerCase() === 'true';
}

/**
 * Has this email alias or phone already started a trial? Returns the
 * friendly conflict ({ field, code, message }) or null.
 */
async function findSignupDuplicate(RestaurantModel, { email, phone }) {
    const emailNorm = normalizeEmailForSignup(email);
    const phoneNorm = normalizePhoneForSignup(phone);
    if (emailNorm) {
        const hit = await RestaurantModel.exists({
            $or: [{ contactEmailNormalized: emailNorm }, { contactEmail: String(email).trim().toLowerCase() }],
        });
        if (hit) {
            return {
                field: 'contactEmail',
                code: 'EMAIL_IN_USE',
                message: 'An account with this email already exists. Log in or use another email.',
            };
        }
    }
    if (phoneNorm) {
        const hit = await RestaurantModel.exists({
            $or: [{ contactPhoneNormalized: phoneNorm }, { contactPhone: phoneNorm }],
        });
        if (hit) {
            return {
                field: 'contactPhone',
                code: 'PHONE_IN_USE',
                message: 'A restaurant is already registered with this mobile number. Log in or use another number.',
            };
        }
    }
    return null;
}

module.exports = {
    SELF_SIGNUP_TRIAL_DAYS,
    trialPlanSlug,
    trialDaysForPlan,
    normalizeEmailForSignup,
    normalizePhoneForSignup,
    signupRequiresApproval,
    findSignupDuplicate,
};
