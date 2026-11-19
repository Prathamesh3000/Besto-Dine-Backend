/**
 * Free-trial lifecycle — the single definition of "where is this tenant's
 * trial" shared by the sweeper, the request-time backstop
 * (middlewares/tenantContext), login (authController), /auth/me and the
 * reminder job. Plan: TRIAL_SIGNUP_AND_LEADS_PLAN.md §6.
 *
 *   state      window                              API
 *   'none'     not on a trial (or has paid)        everything
 *   'active'   now < trialEndDate                  everything
 *   'read_only' trialEndDate <= now <= lockAt      GET/HEAD/OPTIONS pass,
 *                                                  writes 403 SUBSCRIPTION_READ_ONLY
 *   'locked'   now > lockAt                        403 SUBSCRIPTION_BLOCKED
 *
 * lockAt = trialEndDate + TRIAL_READONLY_GRACE_DAYS. A tenant in either
 * window keeps ALL its data. The owner (admin role) can always reach the
 * billing / data-export routes below, and /auth stays open for every role,
 * so paying restores everything. The state is derived from dates on every
 * request, so sweeper lag never matters.
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const TRIAL_DAYS = 14;
const TRIAL_READONLY_GRACE_DAYS = 3;

// `suspendedReason` the sweeper writes. Deliberately does NOT match /payment/i:
// superadmin/approvals.js and applyScheduledDowngrade lift suspensions whose
// reason mentions "payment"; the trial lock is lifted by the Restaurant
// pre-save hook when the subscription turns 'active' instead.
const TRIAL_LOCK_REASON = 'Free trial ended';

// v1-relative path prefixes that stay open in the read-only AND the locked
// window. Billing covers plan list, upgrade, upgrade/verify (payment
// confirmation), sync and invoices; export is the owner's data takeout;
// /auth covers me / logout / refresh for every role.
const LOCKED_ALLOWED_PREFIXES = ['/tenant/billing', '/tenant/export', '/auth'];
const ADMIN_ONLY_PREFIXES = ['/tenant/billing', '/tenant/export'];

// HTTP methods that pass in the read-only window.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hasPaid = (sub) => sub?.status === 'active' || !!sub?.lastChargedAt;

const toDate = (v) => (v ? new Date(v) : null);

function lockAtOf(trialEndDate) {
    const end = toDate(trialEndDate);
    return end ? new Date(end.getTime() + TRIAL_READONLY_GRACE_DAYS * DAY_MS) : null;
}

/**
 * Classify the tenant's trial at `now`.
 * @returns {{ state: 'none'|'active'|'read_only'|'locked', trialEndDate: Date|null,
 *             lockAt: Date|null, daysLeft: number|null }}
 *  - daysLeft: whole days until trialEndDate (ceil), 0 once over, null for 'none'.
 *  - A tenant the sweeper already flipped (status 'suspended' +
 *    subscription.status 'expired') is 'locked' whatever the dates say.
 *  - Anything that paid (hasPaid) or is not a trial tenant is 'none'.
 */
function trialState(restaurant, now = new Date()) {
    const none = { state: 'none', trialEndDate: null, lockAt: null, daysLeft: null };
    if (!restaurant) return none;
    const sub = restaurant.subscription || {};
    const end = toDate(sub.trialEndDate);
    const lockAt = lockAtOf(end);
    const t = now.getTime();

    if (restaurant.status === 'suspended') {
        if (sub.status !== 'expired') return none;
        return { state: 'locked', trialEndDate: end, lockAt, daysLeft: 0 };
    }
    if (restaurant.status !== 'trial' || !end || hasPaid(sub)) return none;

    const daysLeft = Math.max(0, Math.ceil((end.getTime() - t) / DAY_MS));
    if (t < end.getTime()) return { state: 'active', trialEndDate: end, lockAt, daysLeft };
    if (t <= lockAt.getTime()) return { state: 'read_only', trialEndDate: end, lockAt, daysLeft: 0 };
    return { state: 'locked', trialEndDate: end, lockAt, daysLeft: 0 };
}

/** Locked (past lockAt, or flipped by the sweeper) and unpaid. */
function isTrialLocked(restaurant, now = new Date()) {
    return trialState(restaurant, now).state === 'locked';
}

/** In the read-only grace window (trial ended, not yet locked). */
function isTrialReadOnly(restaurant, now = new Date()) {
    return trialState(restaurant, now).state === 'read_only';
}

/** Fields the frontend renders the trial banner / upgrade modal / lock screen from. */
function trialInfo(restaurant, now = new Date()) {
    const sub = restaurant?.subscription || {};
    const st = trialState(restaurant, now);
    let daysLeft = st.daysLeft;
    if (st.state === 'none' && sub.trialEndDate && !hasPaid(sub)) {
        // Not a 'trial' tenant but carrying a trial end date (e.g. a Super
        // Admin created tenant that is 'active' with a trial window): keep the
        // countdown for the banner, enforce nothing.
        daysLeft = Math.max(0, Math.ceil((new Date(sub.trialEndDate).getTime() - now.getTime()) / DAY_MS));
    }
    return {
        trialStartDate: sub.trialStartDate || null,
        trialEndDate: sub.trialEndDate || null,
        trialState: st.state,
        lockAt: st.lockAt,
        readOnly: st.state === 'read_only',
        trialExpired: st.state === 'locked',
        daysLeft,
    };
}

/**
 * May this request pass a read-only / locked tenant regardless of method?
 * /auth for every caller; billing and export for the owner (admin) only.
 */
function allowedWhileLocked(user, v1Path) {
    const p = String(v1Path || '');
    const under = (x) => p === x || p.startsWith(x + '/');
    if (under('/auth')) return true;
    if (!user || user.role !== 'admin') return false;
    return ADMIN_ONLY_PREFIXES.some(under);
}

/** Request path relative to /api/v1, stable across nested router mounts. */
function v1PathOf(req) {
    const url = String(req.originalUrl || req.url || '').split('?')[0];
    return url.replace(/^\/api\/v\d+/, '') || '/';
}

function isReadMethod(method) {
    return READ_METHODS.has(String(method || 'GET').toUpperCase());
}

/** 403 body for a write in the read-only window. */
function readOnlyBody(restaurant, now = new Date()) {
    const st = trialState(restaurant, now);
    return {
        success: false,
        code: 'SUBSCRIPTION_READ_ONLY',
        message: 'Your free trial has ended. Your account is read-only until it locks; upgrade your plan to keep making changes. All your data is safe.',
        lockAt: st.lockAt || lockAtOf(restaurant?.subscription?.trialEndDate),
        trialEndDate: restaurant?.subscription?.trialEndDate || null,
    };
}

/** 403 body once the tenant is locked. */
function blockedBody(restaurant, now = new Date()) {
    const st = trialState(restaurant, now);
    return {
        success: false,
        code: 'SUBSCRIPTION_BLOCKED',
        message: 'Your free trial has ended and your account is locked. Upgrade your plan to continue — all your data is safe.',
        lockAt: st.lockAt || lockAtOf(restaurant?.subscription?.trialEndDate),
        trialEndDate: restaurant?.subscription?.trialEndDate || null,
    };
}

/**
 * Request-time verdict for a tenant: null = pass, otherwise the 403 body.
 * Exempt routes (allowedWhileLocked) pass in both windows.
 */
function trialVerdict(restaurant, { user, method, v1Path } = {}, now = new Date()) {
    const st = trialState(restaurant, now);
    if (st.state === 'none' || st.state === 'active') return null;
    if (allowedWhileLocked(user, v1Path)) return null;
    if (st.state === 'read_only') return isReadMethod(method) ? null : readOnlyBody(restaurant, now);
    return blockedBody(restaurant, now);
}

module.exports = {
    DAY_MS,
    TRIAL_DAYS,
    TRIAL_READONLY_GRACE_DAYS,
    TRIAL_LOCK_REASON,
    LOCKED_ALLOWED_PREFIXES,
    hasPaid,
    lockAtOf,
    trialState,
    isTrialLocked,
    isTrialReadOnly,
    trialInfo,
    allowedWhileLocked,
    isReadMethod,
    v1PathOf,
    readOnlyBody,
    blockedBody,
    trialVerdict,
    // Legacy name kept for callers outside this module (controllers/tableController);
    // answers the locked body (SUBSCRIPTION_BLOCKED) — TRIAL_EXPIRED is gone.
    trialExpiredBody: blockedBody,
};
