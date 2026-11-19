/**
 * utils/trialLock — the trial state machine (plan §6), pure, fixed clock.
 */
const {
    DAY_MS, TRIAL_DAYS, TRIAL_READONLY_GRACE_DAYS,
    trialState, isTrialLocked, isTrialReadOnly, trialInfo, trialVerdict,
    allowedWhileLocked, readOnlyBody, blockedBody, trialExpiredBody, lockAtOf,
} = require('../utils/trialLock');

const START = new Date('2026-11-01T06:00:00.000Z');
const END = new Date(START.getTime() + TRIAL_DAYS * DAY_MS);
const LOCK_AT = new Date(END.getTime() + TRIAL_READONLY_GRACE_DAYS * DAY_MS);
const at = (base, ms) => new Date(base.getTime() + ms);
const H = 60 * 60 * 1000;
const M = 60 * 1000;

const trial = (over = {}, sub = {}) => ({
    status: 'trial',
    subscription: { status: 'trial', trialStartDate: START, trialEndDate: END, ...sub },
    ...over,
});

describe('constants', () => {
    test('14-day trial, 3-day read-only grace', () => {
        expect(TRIAL_DAYS).toBe(14);
        expect(TRIAL_READONLY_GRACE_DAYS).toBe(3);
        expect(lockAtOf(END).getTime()).toBe(LOCK_AT.getTime());
    });
});

describe('trialState', () => {
    test('day 1: active, 14 days left', () => {
        const s = trialState(trial(), at(START, 1 * H));
        expect(s.state).toBe('active');
        expect(s.daysLeft).toBe(14);
        expect(s.trialEndDate.getTime()).toBe(END.getTime());
        expect(s.lockAt.getTime()).toBe(LOCK_AT.getTime());
    });

    test('day 14 (12h before the end): still active, 1 day left', () => {
        const s = trialState(trial(), at(END, -12 * H));
        expect(s.state).toBe('active');
        expect(s.daysLeft).toBe(1);
    });

    test('trialEnd + 1h: read_only, 0 days left, lockAt = end + grace', () => {
        const s = trialState(trial(), at(END, 1 * H));
        expect(s).toMatchObject({ state: 'read_only', daysLeft: 0 });
        expect(s.lockAt.getTime()).toBe(LOCK_AT.getTime());
        expect(isTrialReadOnly(trial(), at(END, 1 * H))).toBe(true);
        expect(isTrialLocked(trial(), at(END, 1 * H))).toBe(false);
    });

    test('exactly at trialEnd the read-only window has started', () => {
        expect(trialState(trial(), END).state).toBe('read_only');
    });

    test('lockAt - 1 minute: still read_only', () => {
        expect(trialState(trial(), at(LOCK_AT, -1 * M)).state).toBe('read_only');
    });

    test('lockAt + 1 minute: locked', () => {
        const s = trialState(trial(), at(LOCK_AT, 1 * M));
        expect(s).toMatchObject({ state: 'locked', daysLeft: 0 });
        expect(isTrialLocked(trial(), at(LOCK_AT, 1 * M))).toBe(true);
        expect(isTrialReadOnly(trial(), at(LOCK_AT, 1 * M))).toBe(false);
    });

    test('hasPaid (subscription active, or ever charged) -> none even past lockAt', () => {
        const paidActive = trial({}, { status: 'active' });
        const charged = trial({}, { lastChargedAt: at(START, 2 * DAY_MS) });
        for (const r of [paidActive, charged]) {
            const s = trialState(r, at(LOCK_AT, DAY_MS));
            expect(s).toEqual({ state: 'none', trialEndDate: null, lockAt: null, daysLeft: null });
        }
    });

    test('a tenant the sweeper locked (suspended + expired) is locked whatever the clock says', () => {
        const r = trial({ status: 'suspended' }, { status: 'expired' });
        expect(trialState(r, at(START, 1 * H)).state).toBe('locked');
    });

    test('suspended for another reason, cancelled, active without a trial, or no restaurant -> none', () => {
        expect(trialState(trial({ status: 'suspended' }, { status: 'trial' }), at(LOCK_AT, DAY_MS)).state).toBe('none');
        expect(trialState(trial({ status: 'cancelled' }), at(LOCK_AT, DAY_MS)).state).toBe('none');
        expect(trialState({ status: 'active', subscription: { status: 'active' } }, END).state).toBe('none');
        expect(trialState({ status: 'trial', subscription: { status: 'trial' } }, END).state).toBe('none');
        expect(trialState(null, END).state).toBe('none');
    });
});

describe('trialInfo (auth responses)', () => {
    test('read-only window', () => {
        const info = trialInfo(trial(), at(END, 1 * H));
        expect(info).toMatchObject({
            trialState: 'read_only', readOnly: true, trialExpired: false, daysLeft: 0,
            trialStartDate: START, trialEndDate: END,
        });
        expect(info.lockAt.getTime()).toBe(LOCK_AT.getTime());
    });

    test('locked window: trialExpired = true', () => {
        expect(trialInfo(trial(), at(LOCK_AT, 1 * H))).toMatchObject({
            trialState: 'locked', readOnly: false, trialExpired: true, daysLeft: 0,
        });
    });

    test('active: countdown, nothing flagged', () => {
        expect(trialInfo(trial(), at(START, 1 * H))).toMatchObject({
            trialState: 'active', readOnly: false, trialExpired: false, daysLeft: 14,
        });
    });

    test('paid tenant: none, no countdown', () => {
        expect(trialInfo(trial({}, { status: 'active' }), END)).toMatchObject({
            trialState: 'none', readOnly: false, trialExpired: false, daysLeft: null, lockAt: null,
        });
    });
});

describe('request verdicts', () => {
    const admin = { role: 'admin' };
    const waiter = { role: 'waiter' };
    const RO = at(END, 1 * H);
    const LOCKED = at(LOCK_AT, 1 * H);

    test('active: everything passes', () => {
        expect(trialVerdict(trial(), { user: waiter, method: 'POST', v1Path: '/orders' }, at(START, H))).toBeNull();
    });

    test('read-only: GET/HEAD/OPTIONS pass, writes answer SUBSCRIPTION_READ_ONLY with lockAt + trialEndDate', () => {
        for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
            expect(trialVerdict(trial(), { user: waiter, method: m, v1Path: '/orders/live' }, RO)).toBeNull();
        }
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const v = trialVerdict(trial(), { user: admin, method: m, v1Path: '/staff' }, RO);
            expect(v).toMatchObject({ success: false, code: 'SUBSCRIPTION_READ_ONLY' });
            expect(v.lockAt.getTime()).toBe(LOCK_AT.getTime());
            expect(v.trialEndDate.getTime()).toBe(END.getTime());
            expect(v.message).toMatch(/read-only/);
        }
        // Guests (no user) are writes-blocked too.
        expect(trialVerdict(trial(), { user: null, method: 'POST', v1Path: '/orders' }, RO).code).toBe('SUBSCRIPTION_READ_ONLY');
    });

    test('read-only exemptions: owner billing/export writes pass, /auth passes for everyone', () => {
        expect(trialVerdict(trial(), { user: admin, method: 'POST', v1Path: '/tenant/billing/upgrade' }, RO)).toBeNull();
        expect(trialVerdict(trial(), { user: admin, method: 'POST', v1Path: '/tenant/export' }, RO)).toBeNull();
        expect(trialVerdict(trial(), { user: waiter, method: 'POST', v1Path: '/auth/logout' }, RO)).toBeNull();
        expect(trialVerdict(trial(), { user: null, method: 'POST', v1Path: '/auth/login' }, RO)).toBeNull();
        // Billing is owner-only: a waiter's billing write is still refused.
        expect(trialVerdict(trial(), { user: waiter, method: 'POST', v1Path: '/tenant/billing/upgrade' }, RO).code).toBe('SUBSCRIPTION_READ_ONLY');
    });

    test('locked: everything answers SUBSCRIPTION_BLOCKED except the owner billing/export and /auth', () => {
        const v = trialVerdict(trial(), { user: admin, method: 'GET', v1Path: '/orders/live' }, LOCKED);
        expect(v).toMatchObject({ success: false, code: 'SUBSCRIPTION_BLOCKED' });
        expect(v.lockAt.getTime()).toBe(LOCK_AT.getTime());
        expect(v.trialEndDate.getTime()).toBe(END.getTime());
        expect(trialVerdict(trial(), { user: waiter, method: 'GET', v1Path: '/tenant/billing/current' }, LOCKED).code).toBe('SUBSCRIPTION_BLOCKED');
        expect(trialVerdict(trial(), { user: null, method: 'GET', v1Path: '/menu' }, LOCKED).code).toBe('SUBSCRIPTION_BLOCKED');
        expect(trialVerdict(trial(), { user: admin, method: 'GET', v1Path: '/tenant/billing/current' }, LOCKED)).toBeNull();
        expect(trialVerdict(trial(), { user: admin, method: 'GET', v1Path: '/tenant/export' }, LOCKED)).toBeNull();
        expect(trialVerdict(trial(), { user: waiter, method: 'GET', v1Path: '/auth/me' }, LOCKED)).toBeNull();
    });

    test('allowedWhileLocked: prefix match on segment boundaries', () => {
        expect(allowedWhileLocked(admin, '/tenant/billing')).toBe(true);
        expect(allowedWhileLocked(admin, '/tenant/billingX')).toBe(false);
        expect(allowedWhileLocked(waiter, '/auth/refresh')).toBe(true);
        expect(allowedWhileLocked(waiter, '/tenant/export')).toBe(false);
        expect(allowedWhileLocked(null, '/orders')).toBe(false);
    });

    test('bodies never use the removed TRIAL_EXPIRED code; the legacy name maps to SUBSCRIPTION_BLOCKED', () => {
        expect(readOnlyBody(trial(), RO).code).toBe('SUBSCRIPTION_READ_ONLY');
        expect(blockedBody(trial(), LOCKED).code).toBe('SUBSCRIPTION_BLOCKED');
        expect(trialExpiredBody(trial(), LOCKED).code).toBe('SUBSCRIPTION_BLOCKED');
        expect(JSON.stringify([readOnlyBody(trial(), RO), blockedBody(trial(), LOCKED)])).not.toMatch(/TRIAL_EXPIRED/);
    });
});
