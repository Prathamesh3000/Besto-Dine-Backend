/**
 * Free-trial lock — the single definition of "this tenant's trial ended
 * unpaid" shared by the sweeper, the request-time backstop
 * (middlewares/tenantContext), login (authController) and /auth/me.
 *
 * A locked tenant keeps ALL its data. Staff apps, customer ordering and the
 * kitchen stop; the owner (admin role) can still sign in and reach only the
 * billing / data-export routes below, so paying restores everything.
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// `suspendedReason` the sweeper writes. Deliberately does NOT match /payment/i:
// superadmin/approvals.js and applyScheduledDowngrade lift suspensions whose
// reason mentions "payment"; the trial lock is lifted by the Restaurant
// pre-save hook when the subscription turns 'active' instead.
const TRIAL_LOCK_REASON = 'Free trial ended';

// v1-relative path prefixes the owner may still use while locked. Billing
// covers plan list, upgrade, upgrade/verify (payment confirmation), sync and
// invoices; /auth covers me / logout / refresh.
const LOCKED_ALLOWED_PREFIXES = ['/tenant/billing', '/tenant/export', '/auth'];

const hasPaid = (sub) => sub?.status === 'active' || !!sub?.lastChargedAt;

/**
 * Is the tenant locked because its free trial ended without payment?
 *  - the sweeper's state: status 'suspended' + subscription.status 'expired'
 *  - the backstop for sweeper lag: status 'trial', trialEndDate in the past
 *    and nothing paid yet.
 */
function isTrialLocked(restaurant, now = new Date()) {
    if (!restaurant) return false;
    const sub = restaurant.subscription || {};
    if (restaurant.status === 'suspended') return sub.status === 'expired';
    if (restaurant.status === 'trial' && sub.trialEndDate && !hasPaid(sub)) {
        return new Date(sub.trialEndDate).getTime() < now.getTime();
    }
    return false;
}

/** Fields the frontend renders the trial banner / lock screen from. */
function trialInfo(restaurant, now = new Date()) {
    const sub = restaurant?.subscription || {};
    const end = sub.trialEndDate ? new Date(sub.trialEndDate) : null;
    const onTrial = !!end && !hasPaid(sub);
    const locked = isTrialLocked(restaurant, now);
    return {
        trialStartDate: sub.trialStartDate || null,
        trialEndDate: sub.trialEndDate || null,
        trialExpired: locked,
        // Whole days remaining (ceil), 0 once over; null when not on a trial.
        daysLeft: onTrial || locked
            ? (end ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS)) : 0)
            : null,
    };
}

/** May this request pass a locked tenant? Owner (admin) on an allowed route only. */
function allowedWhileLocked(user, v1Path) {
    if (!user || user.role !== 'admin') return false;
    const p = String(v1Path || '');
    return LOCKED_ALLOWED_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
}

/** Request path relative to /api/v1, stable across nested router mounts. */
function v1PathOf(req) {
    const url = String(req.originalUrl || req.url || '').split('?')[0];
    return url.replace(/^\/api\/v\d+/, '') || '/';
}

function trialExpiredBody(restaurant) {
    const end = restaurant?.subscription?.trialEndDate || null;
    return {
        success: false,
        code: 'TRIAL_EXPIRED',
        message: 'Your free trial has ended. Upgrade your plan to continue — all your data is safe.',
        trialEndDate: end,
    };
}

module.exports = {
    DAY_MS,
    TRIAL_LOCK_REASON,
    LOCKED_ALLOWED_PREFIXES,
    isTrialLocked,
    trialInfo,
    allowedWhileLocked,
    v1PathOf,
    trialExpiredBody,
};
