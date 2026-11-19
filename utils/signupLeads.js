/**
 * Signup Leads (TRIAL_SIGNUP_AND_LEADS_PLAN.md §8) — pure helpers.
 *
 * The tenant record IS the lead: a self-registered Restaurant that is on a
 * free plan, has/had a trial, or converted. Nothing here touches the
 * database; controllers/superadmin/signupLeads.js feeds these functions the
 * documents (and the SubscriptionPlan docs they reference) and turns the
 * same rules into Mongo filters through `leadFilter`.
 *
 * Every rule exists twice on purpose — once in JS (`isLead`, `segmentOf`,
 * `displayStage`) for payload rendering, once as a Mongo filter
 * (`leadFilter`) for listing/counting — and the unit test pins them to the
 * same fixtures so they cannot drift apart.
 */
'use strict';

const mongoose = require('mongoose');
const { availableCycles } = require('./billingCycles');
const trialLock = require('./trialLock');

const DAY_MS = 24 * 60 * 60 * 1000;

// Read-only grace after the trial end before the tenant locks (plan §6) —
// the single definition lives in utils/trialLock.js.
const { TRIAL_READONLY_GRACE_DAYS } = trialLock;

const LEAD_STAGES = ['new', 'contacted', 'interested', 'converted', 'lost'];
const SEGMENTS = ['paid', 'free', 'trial_active', 'trial_ended'];
const SELF_SOURCES = ['self_service', 'self_service_trial'];

const toDate = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

const isObjectIdValue = (v) => v instanceof mongoose.Types.ObjectId
    || (v && typeof v === 'object' && v._bsontype === 'ObjectId');

/**
 * Is the tenant's plan free (nothing to charge on any billing cycle)?
 *
 *   isFreePlan(subscription, plan)   plan doc known → it decides
 *   isFreePlan(subscription)         fall back to the snapshot price
 *   isFreePlan(plan)                 a SubscriptionPlan doc on its own
 *
 * Snapshot rules (no plan doc): a numeric price decides (<= 0 is free);
 * no price and no plan reference means there is nothing to charge.
 */
function isFreePlan(subscriptionOrPlan, plan) {
    if (plan) return availableCycles(plan).length === 0;
    const s = subscriptionOrPlan || {};
    // A SubscriptionPlan document (has `prices` or a required `price` with a slug and no `plan` ref).
    if (s.prices || (typeof s.price === 'number' && s.slug && s.plan === undefined)) {
        return availableCycles(s).length === 0;
    }
    if (s.plan && typeof s.plan === 'object' && !isObjectIdValue(s.plan)) {
        return isFreePlan(s, s.plan);           // populated plan
    }
    if (typeof s.price === 'number') return s.price <= 0;
    return !s.plan;
}

const hasPaid = (sub) => sub?.status === 'active' || !!sub?.lastChargedAt;
const hadTrial = (sub) => !!(sub?.trialStartDate || sub?.trialEndDate);
const isSelf = (r) => r?.signupSource === 'self' || SELF_SOURCES.includes(r?.registrationSource);

/** Plan §8 "who is a lead". Admin-created tenants never are. */
function isLead(restaurant, plan) {
    if (!restaurant || !isSelf(restaurant)) return false;
    const sub = restaurant.subscription || {};
    return isFreePlan(sub, plan) || hadTrial(sub) || hasPaid(sub);
}

/** 'paid' | 'free' | 'trial_active' | 'trial_ended' — derived at read time. */
function segmentOf(restaurant, now = new Date(), plan) {
    const r = restaurant || {};
    const sub = r.subscription || {};
    const free = isFreePlan(sub, plan);
    const end = toDate(sub.trialEndDate);
    if (sub.status === 'active' && !free) return 'paid';
    if (free && !end) return 'free';
    const onTrial = r.status === 'trial' || sub.status === 'trial';
    if (end && end.getTime() > now.getTime() && onTrial) return 'trial_active';
    return 'trial_ended';
}

/** Stored stage, except that a paid tenant always shows as 'converted'. */
function displayStage(restaurant, now = new Date(), plan) {
    if (segmentOf(restaurant, now, plan) === 'paid') return 'converted';
    const stage = restaurant?.lead?.stage;
    return LEAD_STAGES.includes(stage) ? stage : 'new';
}

function lockAtOf(trialEndDate) {
    const end = toDate(trialEndDate);
    return end ? new Date(end.getTime() + TRIAL_READONLY_GRACE_DAYS * DAY_MS) : null;
}

/** Whole days until the trial ends (0 once it has); null without a trial end. */
function daysLeft(trialEndDate, now = new Date()) {
    const end = toDate(trialEndDate);
    if (!end) return null;
    return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/** Whole days since the trial ended (0 while it is running); null without a trial end. */
function daysSinceTrialEnd(trialEndDate, now = new Date()) {
    const end = toDate(trialEndDate);
    if (!end) return null;
    return Math.max(0, Math.floor((now.getTime() - end.getTime()) / DAY_MS));
}

// ─── Mongo filters ──────────────────────────────────────────────────────
// `freePlanIds` / `paidPlanIds` are the SubscriptionPlan ids classified
// with isFreePlan(plan); the price snapshot only decides for tenants whose
// plan is unknown (deleted / legacy), mirroring the JS precedence above.

function freeCond({ freePlanIds = [], paidPlanIds = [] } = {}) {
    return {
        $or: [
            { 'subscription.plan': { $in: freePlanIds } },
            { 'subscription.plan': { $nin: paidPlanIds }, 'subscription.price': { $lte: 0 } },
            { 'subscription.plan': null, 'subscription.price': null },
        ],
    };
}

const paidCond = (plans) => ({ 'subscription.status': 'active', $nor: [freeCond(plans)] });

function segmentCond(segment, plans, now) {
    const FREE = freeCond(plans);
    const PAID = paidCond(plans);
    const FREE_SEG = { $and: [FREE, { 'subscription.trialEndDate': null }] };
    const TRIAL_ACTIVE = {
        $and: [
            { $nor: [PAID] },
            { 'subscription.trialEndDate': { $gt: now } },
            { $or: [{ status: 'trial' }, { 'subscription.status': 'trial' }] },
        ],
    };
    switch (segment) {
        case 'paid': return PAID;
        case 'free': return FREE_SEG;
        case 'trial_active': return TRIAL_ACTIVE;
        case 'trial_ended': return { $nor: [PAID, FREE_SEG, TRIAL_ACTIVE] };
        default: return null;
    }
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the Restaurant filter for a list/summary/export request.
 *
 *   query: { segment?, stage?, followUp?, search?, ownerIds? }
 *     ownerIds — User ids whose name/email/mobile matched `search`
 *                (the controller resolves them; owners live in another collection)
 *   opts:  { freePlanIds, paidPlanIds, now }
 */
function leadFilter(query = {}, opts = {}) {
    const now = opts.now || new Date();
    const plans = { freePlanIds: opts.freePlanIds || [], paidPlanIds: opts.paidPlanIds || [] };
    const and = [
        { $or: [{ signupSource: 'self' }, { registrationSource: { $in: SELF_SOURCES } }] },
        {
            $or: [
                freeCond(plans),
                { 'subscription.trialStartDate': { $ne: null } },
                { 'subscription.trialEndDate': { $ne: null } },
                { 'subscription.status': 'active' },
                { 'subscription.lastChargedAt': { $ne: null } },
            ],
        },
    ];

    if (query.segment && SEGMENTS.includes(query.segment)) {
        and.push(segmentCond(query.segment, plans, now));
    }

    if (query.stage && LEAD_STAGES.includes(query.stage)) {
        const PAID = paidCond(plans);
        if (query.stage === 'converted') {
            and.push({ $or: [{ 'lead.stage': 'converted' }, PAID] });
        } else {
            const stored = query.stage === 'new'
                ? { 'lead.stage': { $in: ['new', null] } }
                : { 'lead.stage': query.stage };
            and.push({ $and: [stored, { $nor: [PAID] }] });
        }
    }

    if (query.followUp === 'due') {
        and.push({ 'lead.nextFollowUpAt': { $ne: null, $lte: now } });
    }

    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        const or = [{ name: rx }, { slug: rx }, { contactEmail: rx }, { contactPhone: rx }];
        if (Array.isArray(query.ownerIds) && query.ownerIds.length) {
            or.push({ owner: { $in: query.ownerIds } });
        }
        and.push({ $or: or });
    }

    return { $and: and };
}

// ─── Payload ────────────────────────────────────────────────────────────

const byNewest = (key) => (a, b) => (toDate(b?.[key])?.getTime() || 0) - (toDate(a?.[key])?.getTime() || 0);

/**
 * Lead payload (plan §8). `owner` is the User doc (name/email/mobile) or
 * null, `counts` = { menuItemCount, staffCount }, `plan` the SubscriptionPlan
 * doc when known.
 */
function toLeadPayload(restaurant, owner, counts = {}, now = new Date(), plan) {
    const r = restaurant || {};
    const sub = r.subscription || {};
    const lead = r.lead || {};
    const notes = Array.isArray(lead.notes) ? lead.notes : [];
    const reminders = Array.isArray(sub.trialReminders) ? sub.trialReminders : [];
    const trialEndsAt = toDate(sub.trialEndDate);
    return {
        id: r._id,
        name: r.name,
        slug: r.slug,
        owner: owner?.name || '',
        ownerId: r.owner || null,
        email: owner?.email || r.contactEmail || '',
        phone: owner?.mobile || r.contactPhone || '',
        city: r.city || '',
        source: r.registrationSource || (r.signupSource === 'self' ? 'self_service' : 'admin'),
        plan: {
            name: plan?.name || sub.planName || '',
            slug: plan?.slug || sub.planSlug || '',
            isFree: isFreePlan(sub, plan),
        },
        subscriptionStatus: sub.status || null,
        status: r.status,
        segment: segmentOf(r, now, plan),
        signedUpAt: r.createdAt || null,
        trialEndsAt,
        lockAt: lockAtOf(trialEndsAt),
        daysLeft: daysLeft(trialEndsAt, now),
        daysSinceTrialEnd: daysSinceTrialEnd(trialEndsAt, now),
        menuItemCount: counts.menuItemCount || 0,
        staffCount: counts.staffCount || 0,
        stage: displayStage(r, now, plan),
        nextFollowUpAt: lead.nextFollowUpAt || null,
        lastContactedAt: lead.lastContactedAt || null,
        notes: notes
            .filter((n) => (n.kind || 'human') === 'human')
            .slice()
            .sort(byNewest('at'))
            .map((n) => ({ text: n.text, by: n.by || null, byName: n.byName || '', at: n.at, kind: n.kind || 'human' })),
        reminders: reminders
            .slice()
            .sort(byNewest('queuedAt'))
            .map((x) => ({ type: x.type, queuedAt: x.queuedAt || null, sentAt: x.sentAt || null })),
    };
}

module.exports = {
    DAY_MS,
    TRIAL_READONLY_GRACE_DAYS,
    LEAD_STAGES,
    SEGMENTS,
    SELF_SOURCES,
    isFreePlan,
    isLead,
    segmentOf,
    displayStage,
    lockAtOf,
    daysLeft,
    daysSinceTrialEnd,
    leadFilter,
    toLeadPayload,
    escapeRegex,
};
