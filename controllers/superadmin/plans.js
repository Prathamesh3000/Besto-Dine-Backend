// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');
const { publicPlansCache } = require('../../utils/publicPlans');
const {
    SLUG_REGEX,
    slugify,
    snapshotPlan,
    buildPlanPayload,
} = require('./_shared');

// GET /api/v1/superadmin/plans
exports.listPlans = async (req, res) => {
    try {
        const includeArchived = req.query.includeArchived === 'true';
        const filter = includeArchived ? {} : { isActive: true };
        const plans = await SubscriptionPlan.find(filter)
            .sort({ sortOrder: 1, price: 1 })
            .lean();
        return res.status(200).json({ success: true, data: plans.map(buildPlanPayload) });
    } catch (err) {
        logger.error('listPlans error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list plans' });
    }
};

// POST /api/v1/superadmin/plans
exports.createPlan = async (req, res) => {
    try {
        const { name, slug, description, price, billingCycle, trialDays, limits, features, sortOrder, isPublic } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Plan name is required' });
        }
        if (price === undefined || price === null || isNaN(+price) || +price < 0) {
            return res.status(400).json({ success: false, message: 'Plan price is required and must be >= 0' });
        }
        const finalSlug = slug ? slugify(slug) : slugify(name);
        if (!SLUG_REGEX.test(finalSlug)) {
            return res.status(400).json({ success: false, message: 'Invalid plan slug' });
        }
        if (await SubscriptionPlan.exists({ slug: finalSlug })) {
            return res.status(400).json({ success: false, message: 'A plan with this slug already exists' });
        }

        const plan = await SubscriptionPlan.create({
            name: name.trim(),
            slug: finalSlug,
            description: (description || '').trim(),
            price: +price,
            billingCycle: billingCycle || 'monthly',
            trialDays: Number.isFinite(+trialDays) ? +trialDays : 0,
            limits: limits || {},
            features: features || {},
            sortOrder: Number.isFinite(+sortOrder) ? +sortOrder : 0,
            isPublic: isPublic !== false,
            highlight: req.body.highlight === true,
        });

        await recordAudit(req, {
            action: 'plan.create',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, price: plan.price },
        });

        publicPlansCache.invalidate();
        return res.status(201).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'Plan slug already exists' });
        }
        logger.error('createPlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create plan' });
    }
};

// PUT /api/v1/superadmin/plans/:id
exports.updatePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        // Slug is immutable once created (it's referenced by tenant snapshots).
        const editable = ['name', 'description', 'price', 'billingCycle', 'trialDays', 'limits', 'features', 'sortOrder', 'isActive', 'isPublic', 'highlight'];
        // Capture what actually changed (old → new) for the audit log. Objects
        // (limits/features) are compared by JSON so a nested tweak still shows.
        const changes = {};
        const previewVal = (v) => {
            const s = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
            return s.length > 120 ? s.slice(0, 117) + '…' : s;
        };
        for (const key of editable) {
            if (req.body[key] === undefined) continue;
            const before = plan[key];
            const after = req.body[key];
            const beforeCmp = (before && typeof before === 'object') ? JSON.stringify(before) : String(before ?? '');
            const afterCmp = (after && typeof after === 'object') ? JSON.stringify(after) : String(after ?? '');
            if (beforeCmp !== afterCmp) changes[key] = { from: previewVal(before), to: previewVal(after) };
            plan[key] = after;
        }
        await plan.save();

        const changedFields = Object.keys(changes);
        await recordAudit(req, {
            action: 'plan.update',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: {
                slug: plan.slug,
                changedFields,
                ...(changedFields.length ? { changes } : { note: 'Saved with no field changes' }),
            },
        });

        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        logger.error('updatePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update plan' });
    }
};

// PATCH /api/v1/superadmin/plans/:id/archive
exports.archivePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        plan.isActive = false;
        await plan.save();

        await recordAudit(req, {
            action: 'plan.archive',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, isActive: false },
        });
        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, data: buildPlanPayload(plan) });
    } catch (err) {
        logger.error('archivePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to archive plan' });
    }
};

// DELETE /api/v1/superadmin/plans/:id
// Permanently removes a plan. Blocked when any tenant is currently on it —
// deleting a live plan would orphan their billing reference. The caller is
// told the count so it can suggest "Archive instead".
exports.deletePlan = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        // Safety check on live state: don't delete a plan tenants are using.
        const assignedCount = await Restaurant.countDocuments({ 'subscription.plan': plan._id });
        if (assignedCount > 0) {
            return res.status(400).json({
                success: false,
                code: 'PLAN_IN_USE',
                message: `${assignedCount} restaurant(s) are currently on "${plan.name}". Move them to another plan or Archive this one instead of deleting.`,
                assignedCount,
            });
        }

        await plan.deleteOne();

        await recordAudit(req, {
            action: 'plan.delete',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, price: plan.price },
        });
        publicPlansCache.invalidate();
        return res.status(200).json({ success: true, message: 'Plan deleted' });
    } catch (err) {
        logger.error('deletePlan error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete plan' });
    }
};

function planSnapshotParts(plan) {
    const snap = snapshotPlan(plan);
    return { features: snap.features, limits: snap.limits };
}

// Stable JSON for comparing snapshots regardless of key order.
function stableJson(obj) {
    if (!obj || typeof obj !== 'object') return JSON.stringify(obj ?? null);
    return JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {}));
}

// GET /api/v1/superadmin/plans/:id/tenant-impact
// How many restaurants are on this plan and how many of them still carry
// an older copy of its modules/limits (i.e. would change on a push).
exports.getPlanTenantImpact = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const { features, limits } = planSnapshotParts(plan);
        const wantF = stableJson(features);
        const wantL = stableJson(limits);
        const tenants = await Restaurant.find({ 'subscription.plan': plan._id })
            .select('name slug subscription.features subscription.limits')
            .lean();
        const outOfSync = tenants.filter(t =>
            stableJson(t.subscription?.features || {}) !== wantF
            || stableJson(t.subscription?.limits || {}) !== wantL);

        const [pendingUpgrades, scheduledDowngrades] = await Promise.all([
            Restaurant.countDocuments({ 'subscription.pendingUpgrade.plan': plan._id }),
            Restaurant.countDocuments({ 'subscription.scheduledDowngrade.plan': plan._id }),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                planId: plan._id,
                planName: plan.name,
                assignedCount: tenants.length,
                outOfSyncCount: outOfSync.length,
                outOfSync: outOfSync.slice(0, 50).map(t => ({ _id: t._id, name: t.name, slug: t.slug })),
                pendingUpgrades,
                scheduledDowngrades,
            },
        });
    } catch (err) {
        logger.error('getPlanTenantImpact error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load plan impact' });
    }
};

// POST /api/v1/superadmin/plans/:id/push   Body: { confirm: true }
//
// Copies the plan's CURRENT modules and limits onto every restaurant
// assigned to it (plus any pending upgrade / scheduled downgrade that
// targets it). Editing a plan never does this on its own — tenants keep
// the snapshot they signed up with until the Super Admin pushes.
//
// The agreed price is deliberately NOT touched (price protection), and
// per-tenant featureOverrides / add-ons keep winning over the plan.
exports.pushPlanToTenants = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
        }
        if (req.body?.confirm !== true) {
            return res.status(400).json({
                success: false,
                code: 'CONFIRM_REQUIRED',
                message: 'Send { "confirm": true } to push this plan to its restaurants.',
            });
        }
        const plan = await SubscriptionPlan.findById(id);
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const { features, limits } = planSnapshotParts(plan);

        const [live, pending, scheduled] = await Promise.all([
            Restaurant.updateMany(
                { 'subscription.plan': plan._id },
                { $set: {
                    'subscription.features': features,
                    'subscription.limits': limits,
                    'subscription.planName': plan.name,
                } },
            ),
            Restaurant.updateMany(
                { 'subscription.pendingUpgrade.plan': plan._id },
                { $set: {
                    'subscription.pendingUpgrade.features': features,
                    'subscription.pendingUpgrade.limits': limits,
                    'subscription.pendingUpgrade.planName': plan.name,
                } },
            ),
            Restaurant.updateMany(
                { 'subscription.scheduledDowngrade.plan': plan._id },
                { $set: {
                    'subscription.scheduledDowngrade.features': features,
                    'subscription.scheduledDowngrade.limits': limits,
                    'subscription.scheduledDowngrade.planName': plan.name,
                } },
            ),
        ]);

        const result = {
            matched: live.matchedCount,
            updated: live.modifiedCount,
            pendingUpgradesUpdated: pending.modifiedCount,
            scheduledDowngradesUpdated: scheduled.modifiedCount,
        };

        await recordAudit(req, {
            action: 'plan.push',
            targetType: 'plan',
            targetId: plan._id,
            targetName: plan.name,
            details: { slug: plan.slug, ...result },
        });

        return res.status(200).json({ success: true, data: result });
    } catch (err) {
        logger.error('pushPlanToTenants error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to push plan to restaurants' });
    }
};
