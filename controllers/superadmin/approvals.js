// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const PlanChangeRequest = require('../../models/planChangeRequest');
const { recordAudit } = require('../../utils/audit');
const { sendEmail } = require('../../utils/email');
const { signupRejected } = require('../../utils/emailTemplates');
const logger = require('../../utils/logger');
const { invalidateTenant } = require('../../middlewares/tenantContext');
const { SELF_SIGNUP_TRIAL_DAYS } = require('../../utils/selfSignup');
const { buildRestaurantPayload } = require('./_shared');

// GET /api/v1/superadmin/pending-approvals
// Returns all three queues in a single payload so the frontend page
// can render its three tabs without three separate round-trips.
exports.listPendingApprovals = async (_req, res) => {
    try {
        const [signups, planChanges, paymentPending, plans] = await Promise.all([
            Restaurant.find({ signupStatus: 'pending' })
                .select('name slug contactEmail contactPhone city signupNote subscription.planName requestedPlan signupMeta owner createdAt')
                .populate({ path: 'owner', select: 'name' })
                .sort({ createdAt: -1 })
                .lean()
                // Flat, display-ready shape for the Pending Approvals page.
                .then(list => list.map(r => ({
                    _id: r._id,
                    name: r.name,
                    slug: r.slug,
                    city: r.city || '',
                    contactPhone: r.contactPhone || '',
                    contactEmail: r.contactEmail || '',
                    ownerName: r.signupMeta?.ownerName || r.owner?.name || '',
                    requestedPlan: r.requestedPlan?.plan
                        ? { _id: r.requestedPlan.plan, name: r.requestedPlan.planName || '' }
                        : null,
                    signupMeta: {
                        source:      r.signupMeta?.source || '',
                        utmSource:   r.signupMeta?.utmSource || '',
                        utmMedium:   r.signupMeta?.utmMedium || '',
                        utmCampaign: r.signupMeta?.utmCampaign || '',
                        utmTerm:     r.signupMeta?.utmTerm || '',
                        utmContent:  r.signupMeta?.utmContent || '',
                        termsAcceptedAt: r.signupMeta?.termsAcceptedAt || null,
                    },
                    signupNote: r.signupNote || '',
                    subscription: { planName: r.subscription?.planName || '' },
                    createdAt: r.createdAt,
                }))),
            // Pull price + name for both sides so the frontend can
            // detect "this is a downgrade" and tweak the approve
            // dialog copy ("scheduled" vs "immediate"). currentPlan
            // is the ObjectId of the plan they had at request-time.
            PlanChangeRequest.find({ status: 'pending' })
                .populate({ path: 'restaurant', select: 'name slug contactEmail' })
                .populate({ path: 'currentPlan',   select: 'name price' })
                .populate({ path: 'requestedPlan', select: 'name price' })
                .sort({ createdAt: -1 })
                .lean()
                .then(list => list.map(r => ({
                    ...r,
                    // Flatten so the frontend doesn't have to dig into populated docs
                    currentPlanPrice:   r.currentPlan?.price   ?? null,
                    requestedPlanPrice: r.requestedPlan?.price ?? r.requestedPlanPrice ?? null,
                }))),
            Restaurant.find({ paymentStatus: 'pending' })
                .select('name slug contactEmail contactPhone city subscription.planName subscription.plan subscription.price paymentNote status updatedAt')
                .sort({ updatedAt: -1 })
                .lean(),
            // Plan price map so the offline-payments queue can show the
            // operator exactly how much to collect.
            SubscriptionPlan.find({}).select('price currency').lean(),
        ]);

        // Agreed snapshot price first (priceOverride at create time) —
        // same amount getPaymentApprovalDetail shows; catalogue price is
        // only a fallback for legacy rows without a snapshot.
        const priceById = new Map(plans.map(p => [String(p._id), p.price || 0]));
        const paymentPendingEnriched = paymentPending.map(r => ({
            ...r,
            planPrice: typeof r.subscription?.price === 'number'
                ? r.subscription.price
                : (r.subscription?.plan ? (priceById.get(String(r.subscription.plan)) || 0) : 0),
        }));

        return res.status(200).json({
            success: true,
            data: {
                signups,
                planChanges,
                paymentPending: paymentPendingEnriched,
                counts: {
                    signups: signups.length,
                    planChanges: planChanges.length,
                    paymentPending: paymentPending.length,
                    total: signups.length + planChanges.length + paymentPending.length,
                },
            },
        });
    } catch (err) {
        logger.error('listPendingApprovals error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load pending approvals' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/approve-signup
// Approves a self-signup. Flips signupStatus → approved, releases the
// suspension lock, and sends the welcome email so the owner knows they
// can log in.
exports.approveSignup = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.signupStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot approve — signup is already '${restaurant.signupStatus}'.`,
            });
        }

        // Restart the trial clock from the approval date — a hotel must
        // not lose trial days while its application waits for review.
        // Length = the snapshot plan's trialDays, else the self-signup
        // default (SELF_SIGNUP_TRIAL_DAYS, 14).
        const now = new Date();
        let trialDays = SELF_SIGNUP_TRIAL_DAYS;
        if (restaurant.subscription?.plan) {
            const snapPlan = await SubscriptionPlan.findById(restaurant.subscription.plan).select('trialDays').lean();
            if (snapPlan && Number(snapPlan.trialDays) > 0) trialDays = Number(snapPlan.trialDays);
        }
        restaurant.subscription.startDate = now;
        restaurant.subscription.trialStartDate = now;
        restaurant.subscription.trialEndDate = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
        restaurant.subscription.status = 'trial';

        restaurant.signupStatus = 'approved';
        restaurant.signupReviewedAt = now;
        restaurant.signupReviewedBy = req.user._id;
        restaurant.status = 'trial';
        restaurant.suspendedAt = undefined;
        restaurant.suspendedReason = '';
        await restaurant.save();
        // Drop the cached (suspended) tenant so the public landing page
        // and staff requests see the unlocked tenant immediately.
        invalidateTenant(restaurant._id);

        await recordAudit(req, {
            action: 'restaurant.signup_approve',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { newStatus: restaurant.status, trialDays, trialEndDate: restaurant.subscription.trialEndDate },
        });

        // Welcome email — uses self-signup template (no temp password,
        // they set their own). trialDays = the full, freshly started trial.
        try {
            const { restaurantSelfSignupWelcome } = require('../utils/emailTemplates');
            await sendEmail({
                to: restaurant.contactEmail,
                ...restaurantSelfSignupWelcome({
                    restaurantName: restaurant.name,
                    ownerName: restaurant.signupMeta?.ownerName || '',
                    email: restaurant.contactEmail,
                    planName: restaurant.subscription?.planName || '',
                    trialDays,
                    // Email carries the staff login URL and the public
                    // page URL (<FRONTEND_URL>/<slug>).
                    slug: restaurant.slug,
                }),
            });
        } catch (mailErr) {
            logger.warn(`approve-signup email failed for ${restaurant.contactEmail}: ${mailErr.message}`);
        }

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('approveSignup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to approve signup' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/reject-signup
// Body: { reason }  — required
// Marks the signup rejected. Tenant stays suspended forever (we keep
// the document for audit). Sends the owner a polite rejection email.
exports.rejectSignup = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const reason = (req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }
        if (reason.length > 500) {
            return res.status(400).json({ success: false, message: 'Rejection reason cannot exceed 500 characters' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.signupStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject — signup is already '${restaurant.signupStatus}'.`,
            });
        }

        restaurant.signupStatus = 'rejected';
        restaurant.signupRejectedReason = reason;
        restaurant.signupReviewedAt = new Date();
        restaurant.signupReviewedBy = req.user._id;
        restaurant.suspendedReason = `Signup rejected: ${reason}`;
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.signup_reject',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { reason },
        });

        res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });

        // Owner rejection email — after the response; a mail failure
        // never affects the (already committed) rejection.
        const to = restaurant.contactEmail;
        const mail = signupRejected({
            restaurantName: restaurant.name,
            ownerName: restaurant.signupMeta?.ownerName || '',
            reason,
        });
        setImmediate(() => {
            Promise.resolve()
                .then(() => sendEmail({ to, ...mail }))
                .catch((mailErr) => logger.warn(`reject-signup email failed for ${to}: ${mailErr.message}`));
        });
        return undefined;
    } catch (err) {
        logger.error('rejectSignup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reject signup' });
    }
};

// POST /api/v1/superadmin/restaurants/:id/confirm-payment
// Body: { note? }  — optional context
// Marks an offline payment as received and unlocks the tenant.
exports.confirmPayment = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        if (restaurant.paymentStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm — payment status is '${restaurant.paymentStatus}'.`,
            });
        }

        const trialStillValid = restaurant.subscription?.trialEndDate
            && new Date(restaurant.subscription.trialEndDate) > new Date();

        restaurant.paymentStatus = 'received';
        restaurant.paymentConfirmedAt = new Date();
        restaurant.paymentConfirmedBy = req.user._id;
        restaurant.paymentNote = (req.body?.note || '').trim();
        // Only flip status from suspended → trial/active if the
        // suspension was specifically due to payment-pending. Don't
        // accidentally unsuspend a tenant suspended for ToS violation.
        if (restaurant.status === 'suspended' && /payment/i.test(restaurant.suspendedReason || '')) {
            restaurant.status = trialStillValid ? 'trial' : 'active';
            restaurant.suspendedAt = undefined;
            restaurant.suspendedReason = '';
        }
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.payment_confirm',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { note: restaurant.paymentNote },
        });

        return res.status(200).json({ success: true, data: buildRestaurantPayload(restaurant) });
    } catch (err) {
        logger.error('confirmPayment error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to confirm payment' });
    }
};
