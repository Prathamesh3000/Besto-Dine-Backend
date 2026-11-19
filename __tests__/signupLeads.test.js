/**
 * utils/signupLeads — pure rules behind the Signup Leads module (plan §8):
 * who is a lead, which segment a tenant falls in, the displayed stage, the
 * trial clock helpers and the Mongo filter shape. Fixed dates throughout.
 */
const {
    isLead,
    isFreePlan,
    segmentOf,
    displayStage,
    lockAtOf,
    daysLeft,
    daysSinceTrialEnd,
    leadFilter,
    toLeadPayload,
    TRIAL_READONLY_GRACE_DAYS,
    DAY_MS,
} = require('../utils/signupLeads');

const NOW = new Date('2026-11-11T12:00:00.000Z');
const days = (n) => new Date(NOW.getTime() + n * DAY_MS);

const self = (sub = {}, extra = {}) => ({
    name: 'Lead', slug: 'lead', status: 'trial',
    signupSource: 'self', registrationSource: 'self_service_trial',
    subscription: { status: 'trial', planSlug: 'gold', price: 2999, ...sub },
    ...extra,
});

const trialActive = self({ trialStartDate: days(-3), trialEndDate: days(11) });
const trialEnded = self({ status: 'expired', trialStartDate: days(-19), trialEndDate: days(-5) }, { status: 'suspended' });
const freePlan = self({ status: 'active', planSlug: 'free', price: 0 }, { status: 'active', registrationSource: 'self_service' });
const paid = self({ status: 'active', trialStartDate: days(-20), trialEndDate: days(-6), lastChargedAt: days(-5) }, { status: 'active' });
const adminMade = { ...trialActive, signupSource: 'admin', registrationSource: 'admin' };

describe('isFreePlan', () => {
    test('plan doc decides when given: no sellable cycle = free', () => {
        expect(isFreePlan({ price: 2999 }, { price: 0, prices: {} })).toBe(true);
        expect(isFreePlan({ price: 0 }, { price: 2999, prices: {} })).toBe(false);
        expect(isFreePlan({ price: 0 }, { price: 0, prices: { annual: 9999 } })).toBe(false);
    });
    test('a plan doc on its own', () => {
        expect(isFreePlan({ slug: 'free', price: 0, prices: { monthly: null, annual: null, biennial: null } })).toBe(true);
        expect(isFreePlan({ slug: 'gold', price: 2999, prices: {} })).toBe(false);
    });
    test('snapshot price fallback: numeric decides, no plan + no price = free', () => {
        expect(isFreePlan({ price: 0 })).toBe(true);
        expect(isFreePlan({ price: 499 })).toBe(false);
        expect(isFreePlan({ price: null, plan: null })).toBe(true);
        expect(isFreePlan({})).toBe(true);
        expect(isFreePlan({ price: null, plan: '64b000000000000000000001' })).toBe(false);
    });
});

describe('isLead', () => {
    test('self-registered tenants on a trial, a free plan or paid are leads', () => {
        expect(isLead(trialActive)).toBe(true);
        expect(isLead(trialEnded)).toBe(true);
        expect(isLead(freePlan)).toBe(true);
        expect(isLead(paid)).toBe(true);
    });
    test('admin-created tenants never are', () => {
        expect(isLead(adminMade)).toBe(false);
        expect(isLead({ ...freePlan, signupSource: 'admin', registrationSource: 'admin' })).toBe(false);
    });
    test('registrationSource self_service alone also qualifies (legacy signupSource)', () => {
        expect(isLead({ ...trialActive, signupSource: 'admin', registrationSource: 'self_service_trial' })).toBe(true);
    });
    test('a self signup on a paid plan with no trial and no payment is not (yet) a lead', () => {
        expect(isLead(self({ status: 'trial' }))).toBe(false);
    });
    test('null / undefined', () => {
        expect(isLead(null)).toBe(false);
        expect(isLead(undefined)).toBe(false);
    });
});

describe('segmentOf', () => {
    test('four segments', () => {
        expect(segmentOf(trialActive, NOW)).toBe('trial_active');
        expect(segmentOf(trialEnded, NOW)).toBe('trial_ended');
        expect(segmentOf(freePlan, NOW)).toBe('free');
        expect(segmentOf(paid, NOW)).toBe('paid');
    });
    test('the trial end boundary is exclusive — at the exact end it is over', () => {
        expect(segmentOf(self({ trialEndDate: NOW }), NOW)).toBe('trial_ended');
        expect(segmentOf(self({ trialEndDate: new Date(NOW.getTime() + 1) }), NOW)).toBe('trial_active');
    });
    test('a trial that ended but the sweeper has not flipped yet is trial_ended', () => {
        expect(segmentOf(self({ trialEndDate: days(-1) }), NOW)).toBe('trial_ended');
    });
    test('past_due / cancelled after a trial on a paid plan are trial_ended', () => {
        expect(segmentOf(self({ status: 'past_due', trialEndDate: days(-10) }, { status: 'past_due' }), NOW)).toBe('trial_ended');
        expect(segmentOf(self({ status: 'cancelled', trialEndDate: days(-10) }, { status: 'cancelled' }), NOW)).toBe('trial_ended');
    });
    test('an active subscription on a free plan is free, not paid', () => {
        expect(segmentOf(freePlan, NOW)).toBe('free');
    });
    test('a plan doc overrides the snapshot price', () => {
        const activeNoTrial = self({ status: 'active' }, { status: 'active' });
        expect(segmentOf(activeNoTrial, NOW)).toBe('paid');
        expect(segmentOf(activeNoTrial, NOW, { price: 0, prices: {} })).toBe('free');
        expect(segmentOf(freePlan, NOW, { price: 2999, prices: {} })).toBe('paid');
    });
});

describe('displayStage', () => {
    test('stored stage, default new', () => {
        expect(displayStage(trialActive, NOW)).toBe('new');
        expect(displayStage({ ...trialActive, lead: { stage: 'interested' } }, NOW)).toBe('interested');
        expect(displayStage({ ...trialActive, lead: { stage: 'bogus' } }, NOW)).toBe('new');
    });
    test('a paid tenant is always shown as converted whatever is stored', () => {
        expect(displayStage(paid, NOW)).toBe('converted');
        expect(displayStage({ ...paid, lead: { stage: 'lost' } }, NOW)).toBe('converted');
    });
});

describe('trial clock helpers', () => {
    test('lockAt = trialEndDate + grace days', () => {
        expect(TRIAL_READONLY_GRACE_DAYS).toBe(3);
        expect(lockAtOf(days(11)).toISOString()).toBe(days(14).toISOString());
        expect(lockAtOf(null)).toBeNull();
        expect(lockAtOf('not a date')).toBeNull();
    });
    test('daysLeft rounds up and floors at 0', () => {
        expect(daysLeft(days(11), NOW)).toBe(11);
        expect(daysLeft(new Date(NOW.getTime() + 1000), NOW)).toBe(1);
        expect(daysLeft(days(-5), NOW)).toBe(0);
        expect(daysLeft(null, NOW)).toBeNull();
    });
    test('daysSinceTrialEnd rounds down and is 0 while running', () => {
        expect(daysSinceTrialEnd(days(-5), NOW)).toBe(5);
        expect(daysSinceTrialEnd(new Date(NOW.getTime() - 1000), NOW)).toBe(0);
        expect(daysSinceTrialEnd(days(11), NOW)).toBe(0);
        expect(daysSinceTrialEnd(undefined, NOW)).toBeNull();
    });
});

describe('leadFilter', () => {
    test('always restricts to self signups that are free, trialled or paid', () => {
        const f = leadFilter({}, { now: NOW });
        expect(f.$and[0]).toEqual({ $or: [{ signupSource: 'self' }, { registrationSource: { $in: ['self_service', 'self_service_trial'] } }] });
        expect(f.$and[1].$or).toHaveLength(5);
        expect(f.$and).toHaveLength(2);
    });
    test('segment / stage / followUp / search each add one clause; unknown values are ignored', () => {
        expect(leadFilter({ segment: 'paid' }, { now: NOW }).$and).toHaveLength(3);
        expect(leadFilter({ segment: 'nope' }, { now: NOW }).$and).toHaveLength(2);
        expect(leadFilter({ stage: 'lost' }, { now: NOW }).$and).toHaveLength(3);
        expect(leadFilter({ stage: 'demoed' }, { now: NOW }).$and).toHaveLength(2);
        expect(leadFilter({ followUp: 'due' }, { now: NOW }).$and[2]).toEqual({ 'lead.nextFollowUpAt': { $ne: null, $lte: NOW } });
        expect(leadFilter({ followUp: 'all' }, { now: NOW }).$and).toHaveLength(2);
        expect(leadFilter({ search: '   ' }, { now: NOW }).$and).toHaveLength(2);
    });
    test('stage=converted also matches paid tenants; other stages exclude them', () => {
        const converted = leadFilter({ stage: 'converted' }, { now: NOW }).$and[2];
        expect(converted.$or[0]).toEqual({ 'lead.stage': 'converted' });
        expect(converted.$or[1]['subscription.status']).toBe('active');
        const fresh = leadFilter({ stage: 'new' }, { now: NOW }).$and[2];
        expect(fresh.$and[0]).toEqual({ 'lead.stage': { $in: ['new', null] } });
        expect(fresh.$and[1].$nor).toHaveLength(1);
    });
    test('search is escaped, case-insensitive and includes owner ids when given', () => {
        const f = leadFilter({ search: 'a.b(c', ownerIds: ['x'] }, { now: NOW });
        const or = f.$and[2].$or;
        expect(or[0].name).toBeInstanceOf(RegExp);
        expect(or[0].name.source).toBe('a\\.b\\(c');
        expect(or[0].name.flags).toBe('i');
        expect(or[4]).toEqual({ owner: { $in: ['x'] } });
    });
    test('free/paid plan ids feed the free-plan condition', () => {
        const f = leadFilter({ segment: 'free' }, { now: NOW, freePlanIds: ['free1'], paidPlanIds: ['gold1'] });
        const freeSeg = f.$and[2];
        expect(freeSeg.$and[0].$or[0]).toEqual({ 'subscription.plan': { $in: ['free1'] } });
        expect(freeSeg.$and[0].$or[1]['subscription.plan']).toEqual({ $nin: ['gold1'] });
        expect(freeSeg.$and[1]).toEqual({ 'subscription.trialEndDate': null });
    });
});

describe('toLeadPayload', () => {
    test('shape, owner fallbacks, notes newest-first and human only, reminders newest-first', () => {
        const r = {
            ...trialActive,
            _id: 'id1', city: 'Pune', contactEmail: 'contact@x.test', contactPhone: '111', owner: 'u1',
            createdAt: days(-3),
            lead: {
                stage: 'contacted', nextFollowUpAt: days(2), lastContactedAt: days(-1),
                notes: [
                    { text: 'old', byName: 'A', at: days(-2), kind: 'human' },
                    { text: 'sys', byName: '', at: days(-1), kind: 'system' },
                    { text: 'new', byName: 'B', at: days(-0.5), kind: 'human' },
                ],
            },
            subscription: {
                ...trialActive.subscription,
                trialReminders: [{ type: 't-3', queuedAt: days(-2), sentAt: days(-2) }, { type: 't-1', queuedAt: days(-1), sentAt: null }],
            },
        };
        const p = toLeadPayload(r, { name: 'Owner', email: 'owner@x.test', mobile: '999' }, { menuItemCount: 7, staffCount: 2 }, NOW);
        expect(p).toMatchObject({
            id: 'id1', name: 'Lead', slug: 'lead', owner: 'Owner', ownerId: 'u1',
            email: 'owner@x.test', phone: '999', city: 'Pune', source: 'self_service_trial',
            plan: { name: '', slug: 'gold', isFree: false },
            subscriptionStatus: 'trial', status: 'trial', segment: 'trial_active',
            daysLeft: 11, daysSinceTrialEnd: 0, menuItemCount: 7, staffCount: 2, stage: 'contacted',
        });
        expect(p.trialEndsAt.toISOString()).toBe(days(11).toISOString());
        expect(p.lockAt.toISOString()).toBe(days(14).toISOString());
        expect(p.notes.map((n) => n.text)).toEqual(['new', 'old']);
        expect(p.reminders.map((x) => x.type)).toEqual(['t-1', 't-3']);

        const q = toLeadPayload(r, null, {}, NOW);
        expect(q.owner).toBe('');
        expect(q.email).toBe('contact@x.test');
        expect(q.phone).toBe('111');
        expect(q.menuItemCount).toBe(0);
    });
    test('paid tenant: converted, no daysLeft once over', () => {
        const p = toLeadPayload({ ...paid, _id: 'p' }, null, {}, NOW);
        expect(p.segment).toBe('paid');
        expect(p.stage).toBe('converted');
        expect(p.daysLeft).toBe(0);
        expect(p.daysSinceTrialEnd).toBe(6);
    });
    test('free plan: no trial clock', () => {
        const p = toLeadPayload({ ...freePlan, _id: 'f' }, null, {}, NOW);
        expect(p.segment).toBe('free');
        expect(p.plan.isFree).toBe(true);
        expect(p.trialEndsAt).toBeNull();
        expect(p.lockAt).toBeNull();
        expect(p.daysLeft).toBeNull();
        expect(p.daysSinceTrialEnd).toBeNull();
    });
});
