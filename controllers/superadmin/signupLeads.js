/**
 * Signup Leads — Super Admin follow-up on self-registered tenants
 * (TRIAL_SIGNUP_AND_LEADS_PLAN.md §8). The tenant record IS the lead; the
 * private CRM state lives in Restaurant.lead (select: false) and only this
 * module asks for `+lead`.
 *
 *   GET   /superadmin/signup-leads?segment=&stage=&followUp=due&search=&page=&limit=
 *   GET   /superadmin/signup-leads/summary
 *   GET   /superadmin/signup-leads/export.csv      (same filters, all pages)
 *   PATCH /superadmin/signup-leads/:slug           { stage?, nextFollowUpAt?, lastContactedAt? }
 *   POST  /superadmin/signup-leads/:slug/notes     { text }
 *
 * The marketing-site demo requests (/superadmin/leads, models/lead.js) are a
 * different thing and untouched.
 */
'use strict';

const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const User = require('../../models/user');
const MenuItem = require('../../models/menuItem');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');
const { csvCell } = require('../auditController');
const {
    LEAD_STAGES,
    SEGMENTS,
    isFreePlan,
    leadFilter,
    toLeadPayload,
    segmentOf,
    escapeRegex,
} = require('../../utils/signupLeads');

const PAGE_MAX = 100;
const EXPORT_CAP = 10000;
const HYDRATE_CHUNK = 500;

// ─── helpers ────────────────────────────────────────────────────────────

/** Every plan, classified once per request: { byId, freePlanIds, paidPlanIds }. */
async function loadPlanIndex() {
    // AUDIT-EXEMPT: platform catalogue, not tenant data.
    const plans = await SubscriptionPlan.find({}).select('name slug price prices billingCycle').lean();
    const byId = new Map();
    const freePlanIds = [];
    const paidPlanIds = [];
    for (const p of plans) {
        byId.set(String(p._id), p);
        (isFreePlan(p) ? freePlanIds : paidPlanIds).push(p._id);
    }
    return { byId, freePlanIds, paidPlanIds };
}

const planOf = (planIndex, restaurant) => {
    const id = restaurant?.subscription?.plan;
    return id ? planIndex.byId.get(String(id)) || null : null;
};

/** Owner ids whose name / email / mobile match the search text (empty when no search). */
async function searchOwnerIds(search) {
    const s = typeof search === 'string' ? search.trim() : '';
    if (!s) return [];
    const rx = new RegExp(escapeRegex(s), 'i');
    // AUDIT-EXEMPT: cross-tenant owner lookup on a superadmin route.
    const owners = await User.find({
        role: 'admin',
        isTenantOwner: true,
        $or: [{ name: rx }, { email: rx }, { mobile: rx }],
    }).select('_id').limit(500).lean();
    return owners.map((u) => u._id);
}

async function buildFilter(query, planIndex, now) {
    const ownerIds = await searchOwnerIds(query.search);
    return leadFilter({ ...query, ownerIds }, { ...planIndex, now });
}

/** Owners + per-tenant counts for a page of restaurants, then payloads. */
async function hydrate(restaurants, planIndex, now) {
    if (!restaurants.length) return [];
    const ids = restaurants.map((r) => r._id);
    const ownerIds = restaurants.map((r) => r.owner).filter(Boolean);

    const [owners, menuCounts, staffCounts] = await Promise.all([
        // AUDIT-EXEMPT: superadmin route, no tenant context — owners of the listed tenants only.
        ownerIds.length
            ? User.find({ _id: { $in: ownerIds } }).select('name email mobile').lean()
            : [],
        MenuItem.aggregate([
            { $match: { restaurant: { $in: ids } } },
            { $group: { _id: '$restaurant', n: { $sum: 1 } } },
        ]),
        User.aggregate([
            { $match: { restaurant: { $in: ids }, role: { $ne: 'customer' } } },
            { $group: { _id: '$restaurant', n: { $sum: 1 } } },
        ]),
    ]);

    const ownerById = new Map(owners.map((u) => [String(u._id), u]));
    const menuBy = new Map(menuCounts.map((x) => [String(x._id), x.n]));
    const staffBy = new Map(staffCounts.map((x) => [String(x._id), x.n]));

    return restaurants.map((r) => toLeadPayload(
        r,
        r.owner ? ownerById.get(String(r.owner)) || null : null,
        { menuItemCount: menuBy.get(String(r._id)) || 0, staffCount: staffBy.get(String(r._id)) || 0 },
        now,
        planOf(planIndex, r),
    ));
}

/** The lead for a slug (with +lead), or null when the slug is not a lead. */
async function findLead(slug, planIndex, now) {
    const filter = leadFilter({}, { ...planIndex, now });
    filter.$and.push({ slug });
    return Restaurant.findOne(filter).select('+lead').lean();
}

async function payloadFor(restaurant, planIndex, now) {
    const [payload] = await hydrate([restaurant], planIndex, now);
    return payload;
}

const notALead = (res) => res.status(404).json({
    success: false,
    code: 'NOT_A_LEAD',
    message: 'No signup lead with that slug',
});

const parseDateOrNull = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
};

// ─── GET /superadmin/signup-leads ───────────────────────────────────────
exports.listSignupLeads = async (req, res) => {
    try {
        const now = new Date();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const planIndex = await loadPlanIndex();
        const filter = await buildFilter(req.query, planIndex, now);

        const [items, total] = await Promise.all([
            Restaurant.find(filter)
                .select('+lead')
                .sort({ createdAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Restaurant.countDocuments(filter),
        ]);

        const data = await hydrate(items, planIndex, now);
        return res.status(200).json({
            success: true,
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
        });
    } catch (err) {
        logger.error('listSignupLeads error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load signup leads' });
    }
};

// ─── GET /superadmin/signup-leads/summary ───────────────────────────────
exports.signupLeadsSummary = async (req, res) => {
    try {
        const now = new Date();
        const planIndex = await loadPlanIndex();
        const count = (q) => Restaurant.countDocuments(leadFilter(q, { ...planIndex, now }));

        const [total, free, trialActive, trialEnded, paid, followUpsDue] = await Promise.all([
            count({}),
            count({ segment: 'free' }),
            count({ segment: 'trial_active' }),
            count({ segment: 'trial_ended' }),
            count({ segment: 'paid' }),
            count({ followUp: 'due' }),
        ]);

        const conversionRate = total ? Math.round((paid / total) * 1000) / 10 : 0;
        return res.status(200).json({
            success: true,
            data: { total, free, trialActive, trialEnded, paid, followUpsDue, conversionRate },
        });
    } catch (err) {
        logger.error('signupLeadsSummary error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load signup lead summary' });
    }
};

// ─── PATCH /superadmin/signup-leads/:slug ───────────────────────────────
exports.updateSignupLead = async (req, res) => {
    try {
        const now = new Date();
        const planIndex = await loadPlanIndex();
        const lead = await findLead(req.params.slug, planIndex, now);
        if (!lead) return notALead(res);

        const body = req.body || {};
        const set = {};

        if (body.stage !== undefined) {
            if (!LEAD_STAGES.includes(body.stage)) {
                return res.status(400).json({ success: false, message: `stage must be one of ${LEAD_STAGES.join(', ')}` });
            }
            set['lead.stage'] = body.stage;
            if (body.stage === 'contacted') set['lead.lastContactedAt'] = now;
        }
        for (const field of ['nextFollowUpAt', 'lastContactedAt']) {
            if (body[field] === undefined) continue;
            const d = parseDateOrNull(body[field]);
            if (d === undefined) {
                return res.status(400).json({ success: false, message: `${field} must be an ISO date or null` });
            }
            // An explicit lastContactedAt wins over the 'contacted' auto-stamp.
            set[`lead.${field}`] = d;
        }
        if (!Object.keys(set).length) {
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        await Restaurant.updateOne({ _id: lead._id }, { $set: set });

        const before = lead.lead?.stage || 'new';
        if (set['lead.stage'] && set['lead.stage'] !== before) {
            await recordAudit(req, {
                action: 'superadmin.signup_lead_stage',
                targetType: 'restaurant',
                targetId: lead._id,
                targetName: lead.name,
                details: { from: before, to: set['lead.stage'], segment: segmentOf(lead, now, planOf(planIndex, lead)) },
            });
        }

        const updated = await Restaurant.findById(lead._id).select('+lead').lean();
        return res.status(200).json({ success: true, data: await payloadFor(updated, planIndex, now) });
    } catch (err) {
        logger.error('updateSignupLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update signup lead' });
    }
};

// ─── POST /superadmin/signup-leads/:slug/notes ──────────────────────────
exports.addSignupLeadNote = async (req, res) => {
    try {
        const now = new Date();
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text || text.length > 1000) {
            return res.status(400).json({ success: false, message: 'Note text must be 1–1000 characters' });
        }

        const planIndex = await loadPlanIndex();
        const lead = await findLead(req.params.slug, planIndex, now);
        if (!lead) return notALead(res);

        const note = {
            text,
            by: req.user._id,
            byName: String(req.user.name || '').slice(0, 80),
            at: now,
            kind: 'human',
        };
        await Restaurant.updateOne(
            { _id: lead._id },
            { $push: { 'lead.notes': note }, $set: { 'lead.lastContactedAt': now } },
        );

        const updated = await Restaurant.findById(lead._id).select('+lead').lean();
        return res.status(201).json({ success: true, data: await payloadFor(updated, planIndex, now) });
    } catch (err) {
        logger.error('addSignupLeadNote error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to add note' });
    }
};

// ─── GET /superadmin/signup-leads/export.csv ────────────────────────────
const CSV_COLUMNS = [
    'name', 'slug', 'owner', 'email', 'phone', 'city', 'source',
    'plan', 'planSlug', 'planIsFree', 'subscriptionStatus', 'status', 'segment',
    'signedUpAt', 'trialEndsAt', 'lockAt', 'daysLeft', 'daysSinceTrialEnd',
    'menuItemCount', 'staffCount', 'stage', 'nextFollowUpAt', 'lastContactedAt',
    'notesCount', 'lastNote', 'remindersSent',
];

const iso = (d) => (d ? new Date(d).toISOString() : '');

function csvRow(l) {
    const lastNote = l.notes[0];
    return [
        l.name, l.slug, l.owner, l.email, l.phone, l.city, l.source,
        l.plan.name, l.plan.slug, l.plan.isFree ? 'yes' : 'no', l.subscriptionStatus, l.status, l.segment,
        iso(l.signedUpAt), iso(l.trialEndsAt), iso(l.lockAt), l.daysLeft, l.daysSinceTrialEnd,
        l.menuItemCount, l.staffCount, l.stage, iso(l.nextFollowUpAt), iso(l.lastContactedAt),
        l.notes.length, lastNote ? lastNote.text : '',
        l.reminders.filter((r) => r.sentAt).map((r) => r.type).join(' '),
    ].map(csvCell).join(',');
}

exports.exportSignupLeadsCsv = async (req, res) => {
    try {
        const now = new Date();
        const planIndex = await loadPlanIndex();
        const filter = await buildFilter(req.query, planIndex, now);

        const items = await Restaurant.find(filter)
            .select('+lead')
            .sort({ createdAt: -1, _id: -1 })
            .limit(EXPORT_CAP)
            .lean();

        const lines = [CSV_COLUMNS.map(csvCell).join(',')];
        for (let i = 0; i < items.length; i += HYDRATE_CHUNK) {
            const leads = await hydrate(items.slice(i, i + HYDRATE_CHUNK), planIndex, now);
            for (const l of leads) lines.push(csvRow(l));
        }

        // UTF-8 BOM so Excel opens non-ASCII restaurant names correctly.
        const body = '﻿' + lines.join('\r\n') + '\r\n';
        const stamp = now.toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="signup-leads-${stamp}.csv"`);
        if (items.length === EXPORT_CAP) res.setHeader('X-Export-Truncated', 'true');
        return res.status(200).send(body);
    } catch (err) {
        logger.error('exportSignupLeadsCsv error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to export signup leads' });
    }
};

exports.SIGNUP_LEAD_STAGES = LEAD_STAGES;
exports.SIGNUP_LEAD_SEGMENTS = SEGMENTS;
