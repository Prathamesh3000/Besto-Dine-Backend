// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const PlanChangeRequest = require('../../models/planChangeRequest');
const { recordAudit } = require('../../utils/audit');
const { isBillingConfigured, cancelRazorpaySubscription } = require('../../utils/razorpayBilling');
const logger = require('../../utils/logger');
const { snapshotPlan, buildRestaurantPayload } = require('./_shared');

// POST /api/v1/superadmin/restaurants/:id/plan-change-request
// Body: { planId, note? }
// Records that the tenant wants to switch plans, awaiting offline
// payment confirmation. Approval runs the existing assignPlan flow.
exports.createPlanChangeRequest = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const { planId, note } = req.body || {};
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'A valid plan id is required' });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(id),
            SubscriptionPlan.findById(planId),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // Block stacking — at most one pending request per tenant.
        const existing = await PlanChangeRequest.findOne({
            restaurant: restaurant._id,
            status: 'pending',
        }).lean();
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'A pending plan change already exists for this tenant. Approve or reject it first.',
            });
        }

        const request = await PlanChangeRequest.create({
            restaurant: restaurant._id,
            requestedPlan: plan._id,
            requestedPlanName: plan.name,
            requestedPlanPrice: plan.price,
            currentPlan: restaurant.subscription?.plan || null,
            currentPlanName: restaurant.subscription?.planName || '',
            note: (note || '').trim(),
            requestedBy: req.user._id,
            requestedByEmail: req.user.email,
        });

        await recordAudit(req, {
            action: 'plan_change.request',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { from: request.currentPlanName, to: request.requestedPlanName, requestId: request._id },
        });

        return res.status(201).json({ success: true, data: request });
    } catch (err) {
        logger.error('createPlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create plan change request' });
    }
};

// POST /api/v1/superadmin/plan-change-requests/:requestId/approve
// Behaviour depends on whether this is an UPGRADE or a DOWNGRADE:
//
//   Upgrade / same-tier operator-recorded swap (operator-source or
//     tenant-source where target plan >= current price):
//       Plan is applied immediately — same as before. Operator's
//       offline payment is the source of truth.
//
//   Tenant-source DOWNGRADE (target plan price < current price):
//       Plan is NOT applied now. Instead we schedule the switch for
//       the end of the current billing cycle so the tenant keeps the
//       features they already paid for. Razorpay subscription is
//       cancelled with cancel_at_cycle_end:true; the
//       subscription.completed webhook (or a lazy check at page load
//       for the fallback Orders path) applies the new plan when the
//       cycle ends. Zero refunds, zero proration math.
exports.approvePlanChangeRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!mongoose.isValidObjectId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const request = await PlanChangeRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request already '${request.status}'.` });
        }

        const [restaurant, plan] = await Promise.all([
            Restaurant.findById(request.restaurant),
            SubscriptionPlan.findById(request.requestedPlan),
        ]);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant no longer exists' });
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Plan no longer available — reject this request and create a new one.' });
        }

        // Is this an actual downgrade? Compare new plan price against
        // the current plan's snapshotted price on the restaurant. We
        // only schedule downgrades for tenant-source requests; the
        // operator path is for offline-payment swaps that the operator
        // wants to apply right away.
        // Prefer the snapshot (what the tenant pays); the catalogue price
        // may have been edited since. Fall back to it only for legacy
        // tenants without a snapshotted price.
        let currentPrice = 0;
        if (typeof restaurant.subscription?.price === 'number') {
            currentPrice = restaurant.subscription.price;
        } else if (restaurant.subscription?.plan) {
            const currentPlanDoc = await SubscriptionPlan.findById(restaurant.subscription.plan).select('price');
            currentPrice = currentPlanDoc?.price ?? 0;
        }
        const isDowngrade = request.requestSource === 'tenant'
            && currentPrice > 0
            && plan.price < currentPrice;

        // A tenant request is only ever a downgrade. Anything else
        // (same price or pricier) must go through paid self-service
        // upgrade — approving it here would hand out the plan for free.
        if (request.requestSource === 'tenant' && !isDowngrade) {
            return res.status(400).json({
                success: false,
                code: 'NOT_A_DOWNGRADE',
                message: `${plan.name} is not cheaper than what this tenant currently pays — reject this request; upgrades must be paid via self-service.`,
            });
        }

        if (isDowngrade) {
            // ── Schedule, don't swap ────────────────────────────────
            // Cancel the live Razorpay subscription with cycle-end
            // timing. Razorpay will keep charging until the cycle
            // ends (if applicable) and then stop. The
            // subscription.completed webhook will apply the new plan
            // server-side.
            const currentPeriodEnd = restaurant.subscription?.currentPeriodEnd;
            const effectiveAt = currentPeriodEnd
                ? new Date(currentPeriodEnd)
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // safety fallback: +30d

            const liveSubId = restaurant.subscription?.razorpaySubscriptionId;
            let cancelResult = { attempted: false, ok: false };
            if (liveSubId && isBillingConfigured()) {
                try {
                    await cancelRazorpaySubscription(liveSubId, true /* cancelAtCycleEnd */);
                    cancelResult = { attempted: true, ok: true };
                    logger.info(`Scheduled cancel-at-cycle-end for ${restaurant.slug} sub ${liveSubId}`);
                } catch (cancelErr) {
                    // Non-fatal — record the failure but still schedule
                    // the local downgrade. Operator can manually cancel
                    // in the Razorpay dashboard if needed.
                    cancelResult = { attempted: true, ok: false, error: cancelErr?.message || 'cancel failed' };
                    logger.warn(`Failed to cancel Razorpay sub ${liveSubId}: ${cancelErr.message}`);
                }
            }

            restaurant.subscription = restaurant.subscription || {};
            restaurant.subscription.scheduledDowngrade = {
                plan: plan._id,
                planName: plan.name,
                planSlug: plan.slug,
                price: typeof plan.price === 'number' ? plan.price : 0,
                features: plan.features?.toObject ? plan.features.toObject() : { ...(plan.features || {}) },
                limits:   plan.limits?.toObject   ? plan.limits.toObject()   : { ...(plan.limits   || {}) },
                effectiveAt,
                requestId: request._id,
                fromPlanName: restaurant.subscription.planName || request.currentPlanName || '',
                scheduledAt: new Date(),
            };
            await restaurant.save();

            request.status = 'approved';
            request.reviewedAt = new Date();
            request.reviewedBy = req.user._id;
            request.reviewedByEmail = req.user.email;
            await request.save();

            await recordAudit(req, {
                action: 'plan_change.approve.scheduled',
                targetType: 'restaurant',
                targetId: restaurant._id,
                targetName: restaurant.name,
                details: {
                    from: request.currentPlanName,
                    to: request.requestedPlanName,
                    requestId: request._id,
                    effectiveAt,
                    razorpayCancel: cancelResult,
                },
            });

            return res.status(200).json({
                success: true,
                data: {
                    request,
                    restaurant: buildRestaurantPayload(restaurant),
                    scheduled: true,
                    effectiveAt,
                    razorpayCancel: cancelResult,
                },
            });
        }

        // ── Same-tier or upgrade swap (operator path) ───────────────
        // Apply the plan snapshot immediately. We deliberately do NOT
        // touch the Razorpay subscription here — the operator's
        // offline payment is the source of truth for this flow.
        const trialEndDate = (plan.trialDays || 0) > 0
            ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000)
            : null;
        restaurant.subscription = {
            ...(restaurant.subscription?.toObject ? restaurant.subscription.toObject() : restaurant.subscription || {}),
            ...snapshotPlan(plan),
            startDate: new Date(),
            endDate: null,
            trialEndDate,
            status: trialEndDate ? 'trial' : 'active',
        };
        if (trialEndDate) restaurant.status = 'trial';
        else restaurant.status = restaurant.status === 'suspended' ? 'active' : restaurant.status;
        await restaurant.save();

        request.status = 'approved';
        request.reviewedAt = new Date();
        request.reviewedBy = req.user._id;
        request.reviewedByEmail = req.user.email;
        await request.save();

        await recordAudit(req, {
            action: 'plan_change.approve',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { from: request.currentPlanName, to: request.requestedPlanName, requestId: request._id },
        });

        return res.status(200).json({ success: true, data: { request, restaurant: buildRestaurantPayload(restaurant), scheduled: false } });
    } catch (err) {
        logger.error('approvePlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to approve plan change' });
    }
};

// POST /api/v1/superadmin/plan-change-requests/:requestId/reject
// Body: { reason }  — required
exports.rejectPlanChangeRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!mongoose.isValidObjectId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }
        const request = await PlanChangeRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request already '${request.status}'.` });
        }

        request.status = 'rejected';
        request.rejectedReason = reason;
        request.reviewedAt = new Date();
        request.reviewedBy = req.user._id;
        request.reviewedByEmail = req.user.email;
        await request.save();

        await recordAudit(req, {
            action: 'plan_change.reject',
            targetType: 'restaurant',
            targetId: request.restaurant,
            targetName: request.currentPlanName + ' → ' + request.requestedPlanName,
            details: { reason, requestId: request._id },
        });

        return res.status(200).json({ success: true, data: request });
    } catch (err) {
        logger.error('rejectPlanChangeRequest error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reject plan change' });
    }
};
