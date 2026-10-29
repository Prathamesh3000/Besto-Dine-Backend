// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const User = require('../../models/user');
const { recordAudit } = require('../../utils/audit');
const { sendEmail } = require('../../utils/email');
const { restaurantWelcome } = require('../../utils/emailTemplates');
const logger = require('../../utils/logger');
const { invalidateTenant } = require('../../middlewares/tenantContext');
const { createMainBranchFor } = require('../../utils/createMainBranch');
const { isReservedSlug, checkExplicitRestaurantSlug } = require('../../utils/reservedSlugs');
const {
    EMAIL_REGEX,
    SLUG_REGEX,
    PINCODE_REGEX,
    FSSAI_REGEX,
    GSTIN_REGEX,
    PAN_REGEX,
    slugify,
    generateTempPassword,
    snapshotPlan,
    buildRestaurantPayload,
} = require('./_shared');

// POST /api/v1/superadmin/restaurants
// Body: {
//   name, contactEmail, contactPhone?, city?, ownerName,
//   addressLine1, addressLine2?, state, pincode, country?,
//   legalBusinessName, fssaiLicense, gstin?, pan?,
//   timezone?, planId, trialDays?,
//   priceOverride?, paymentReceived?, paymentMethod?, paymentNote?
// }
//
// Offline payment capture (walk-in onboarding): when the owner pays the
// Super Admin directly (cash / UPI / etc.) at registration, the operator
// can record it inline — `paymentReceived` marks it collected, with the
// `paymentMethod` and an optional `paymentNote`. `priceOverride` lets the
// operator agree a custom price instead of the plan's catalog price.
exports.createRestaurant = async (req, res) => {
    try {
        const {
            name, contactEmail, contactPhone, city, ownerName,
            addressLine1, addressLine2, state, pincode, country,
            legalBusinessName, fssaiLicense, gstin, pan,
            timezone,
            planId, trialDays,
            priceOverride, paymentReceived, paymentMethod, paymentNote,
        } = req.body;

        // ── Validation ─────────────────────────────────────────────────
        // Length caps mirror the Restaurant model (which is itself
        // bounded by Branch's stricter caps so the auto-Main branch
        // can never throw ValidationError on copy). Catching long
        // values here gives Super Admin a clear field-level error
        // rather than a generic 500.
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Restaurant name is required' });
        }
        if (name.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'name', message: 'Restaurant name cannot exceed 80 characters' });
        }
        if (!contactEmail || !EMAIL_REGEX.test(contactEmail.trim())) {
            return res.status(400).json({ success: false, message: 'Valid contact email is required' });
        }
        if (contactEmail.trim().length > 120) {
            return res.status(400).json({ success: false, field: 'contactEmail', message: 'Email cannot exceed 120 characters' });
        }
        if (contactPhone && String(contactPhone).trim().length > 30) {
            return res.status(400).json({ success: false, field: 'contactPhone', message: 'Phone number cannot exceed 30 characters' });
        }
        if (!ownerName || !ownerName.trim()) {
            return res.status(400).json({ success: false, message: 'Owner name is required' });
        }
        if (ownerName.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'ownerName', message: 'Owner name cannot exceed 80 characters' });
        }
        if (!planId || !mongoose.isValidObjectId(planId)) {
            return res.status(400).json({ success: false, message: 'A valid subscription plan is required' });
        }

        // ── Address (required) ─────────────────────────────────────────
        if (!addressLine1 || !addressLine1.trim()) {
            return res.status(400).json({ success: false, message: 'Address line 1 is required' });
        }
        if (addressLine1.trim().length > 200) {
            return res.status(400).json({ success: false, field: 'addressLine1', message: 'Address line 1 cannot exceed 200 characters' });
        }
        if (addressLine2 && String(addressLine2).trim().length > 200) {
            return res.status(400).json({ success: false, field: 'addressLine2', message: 'Address line 2 cannot exceed 200 characters' });
        }
        if (!city || !city.trim()) {
            return res.status(400).json({ success: false, message: 'City is required' });
        }
        if (city.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'city', message: 'City cannot exceed 80 characters' });
        }
        if (!state || !state.trim()) {
            return res.status(400).json({ success: false, message: 'State is required' });
        }
        if (state.trim().length > 80) {
            return res.status(400).json({ success: false, field: 'state', message: 'State cannot exceed 80 characters' });
        }
        if (!pincode || !PINCODE_REGEX.test(String(pincode).trim())) {
            return res.status(400).json({ success: false, message: 'Pincode must be a 6-digit number' });
        }
        if (country && String(country).trim().length > 80) {
            return res.status(400).json({ success: false, field: 'country', message: 'Country cannot exceed 80 characters' });
        }

        // ── Licenses ───────────────────────────────────────────────────
        if (!legalBusinessName || !legalBusinessName.trim()) {
            return res.status(400).json({ success: false, message: 'Legal business name is required' });
        }
        const cleanFssai = (fssaiLicense || '').trim();
        if (!cleanFssai || !FSSAI_REGEX.test(cleanFssai)) {
            return res.status(400).json({ success: false, message: 'FSSAI license must be a 14-digit number' });
        }
        const cleanGstin = (gstin || '').trim().toUpperCase();
        if (cleanGstin && !GSTIN_REGEX.test(cleanGstin)) {
            return res.status(400).json({ success: false, message: 'GSTIN must be a valid 15-character identifier' });
        }
        const cleanPan = (pan || '').trim().toUpperCase();
        if (cleanPan && !PAN_REGEX.test(cleanPan)) {
            return res.status(400).json({ success: false, message: 'PAN must be a valid 10-character identifier' });
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan || !plan.isActive) {
            return res.status(400).json({ success: false, message: 'Selected plan is not available' });
        }

        // ── Offline payment / price-override capture ───────────────────
        // Optional. `priceOverride` (when a finite, non-negative number)
        // replaces the plan's catalog price for this tenant's snapshot.
        let effectivePrice = typeof plan.price === 'number' ? plan.price : 0;
        if (priceOverride !== undefined && priceOverride !== null && priceOverride !== '') {
            const n = Number(priceOverride);
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ success: false, field: 'priceOverride', message: 'Price must be a non-negative number' });
            }
            effectivePrice = Math.round(n);
        }

        const VALID_PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'];
        const cleanMethod = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : '';
        if (paymentMethod && !cleanMethod) {
            return res.status(400).json({ success: false, field: 'paymentMethod', message: 'Invalid payment method' });
        }
        const markPaid = paymentReceived === true || paymentReceived === 'true';
        const cleanPaymentNote = (paymentNote || '').toString().trim().slice(0, 500);
        // received → operator collected it now; pending → paid plan still
        // owing (shows in the offline-payments queue); na → nothing to collect.
        const resolvedPaymentStatus = markPaid
            ? 'received'
            : (effectivePrice > 0 ? 'pending' : 'na');

        // ── Slug uniqueness ────────────────────────────────────────────
        // Generate a slug from the restaurant name and append a short
        // suffix if it already exists to avoid blocking onboarding.
        // Capped at 55 so a "-xxxx" collision suffix still fits the 2-60
        // char range the tenant resolver accepts (tenantContext SLUG_REGEX)
        // — a longer slug would make the restaurant's /r/<slug> link dead.
        //
        // Reserved slugs (utils/reservedSlugs.js) would collide with a
        // top-level frontend route at /<slug>: an explicit `slug` is
        // refused (400 SLUG_RESERVED), a generated one is auto-suffixed
        // exactly like a uniqueness collision.
        let slug;
        if (req.body.slug !== undefined && req.body.slug !== null && req.body.slug !== '') {
            const checked = checkExplicitRestaurantSlug(req.body.slug);
            if (checked.error) {
                return res.status(checked.error.status).json({
                    success: false, field: 'slug', code: checked.error.code, message: checked.error.message,
                });
            }
            slug = checked.slug;
            if (await Restaurant.exists({ slug })) {
                return res.status(400).json({
                    success: false, field: 'slug', code: 'SLUG_TAKEN',
                    message: 'A restaurant with this slug already exists',
                });
            }
        } else {
            slug = slugify(name).slice(0, 55).replace(/-+$/, '');
            if (!SLUG_REGEX.test(slug) || slug.length < 2) {
                slug = `restaurant-${crypto.randomBytes(3).toString('hex')}`;
            }
            if (isReservedSlug(slug) || await Restaurant.exists({ slug })) {
                slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
            }
        }

        // ── Duplicate owner email guard ────────────────────────────────
        const cleanEmail = contactEmail.toLowerCase().trim();
        const existingUser = await User.findOne({ email: cleanEmail });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'A user with this email already exists. Use a different email or transfer ownership manually.'
            });
        }

        // ── Build subscription snapshot ────────────────────────────────
        const startDate = new Date();
        const trialPeriod = Number.isFinite(+trialDays) ? Math.max(0, +trialDays) : (plan.trialDays || 0);
        const trialEndDate = trialPeriod > 0
            ? new Date(startDate.getTime() + trialPeriod * 24 * 60 * 60 * 1000)
            : null;

        const subscription = {
            ...snapshotPlan(plan),
            price: effectivePrice,
            startDate,
            endDate: null,
            trialEndDate,
            status: trialPeriod > 0 ? 'trial' : 'active',
        };

        // ── Create restaurant + admin user ─────────────────────────────
        // We do not use a multi-document transaction here because the
        // existing deployment uses a single MongoDB Atlas connection
        // without an explicit replica session — instead we roll back
        // on failure manually.
        const restaurant = await Restaurant.create({
            name: name.trim(),
            slug,
            contactEmail: cleanEmail,
            contactPhone: (contactPhone || '').trim(),
            city: city.trim(),
            address: {
                line1: addressLine1.trim(),
                line2: (addressLine2 || '').trim(),
                state: state.trim(),
                pincode: String(pincode).trim(),
                country: (country || 'India').trim(),
            },
            legal: {
                legalBusinessName: legalBusinessName.trim(),
                fssaiLicense: cleanFssai,
                gstin: cleanGstin,
                pan: cleanPan,
            },
            timezone: (timezone || 'Asia/Kolkata').trim(),
            status: trialPeriod > 0 ? 'trial' : 'active',
            subscription,
            paymentStatus: resolvedPaymentStatus,
            paymentMethod: markPaid ? cleanMethod : '',
            paymentNote: cleanPaymentNote,
            paymentConfirmedAt: markPaid ? new Date() : undefined,
            paymentConfirmedBy: markPaid ? req.user._id : undefined,
            createdBy: req.user._id,
        });

        let adminUser;
        const tempPassword = generateTempPassword();
        try {
            adminUser = await User.create({
                name: ownerName.trim(),
                email: cleanEmail,
                password: tempPassword,
                mobile: (contactPhone || '').trim(),
                role: 'admin',
                restaurant: restaurant._id,
                // CRIT-06 — THIS user is the tenant owner. Sub-admins
                // created later via /staff must NOT inherit this flag.
                isTenantOwner: true,
                mustChangePassword: true,
                status: 'active',
            });
            restaurant.owner = adminUser._id;
            await restaurant.save();
        } catch (innerErr) {
            // Roll back the restaurant if user creation failed
            await Restaurant.findByIdAndDelete(restaurant._id).catch(() => {});
            invalidateTenant(restaurant._id);
            throw innerErr;
        }

        // ── Auto-provision the "Main" branch ──────────────────────────
        // Every tenant starts with one Branch document representing the
        // original/HQ location. Future sub-branches added by the owner
        // become siblings of Main, leaving Main's data untouched.
        // Failure here is non-fatal: the backfill script can be re-run
        // to repair the tenant later.
        try {
            await createMainBranchFor(restaurant, adminUser._id);
        } catch (branchErr) {
            logger.error(`superadmin.createRestaurant: createMainBranchFor failed for ${restaurant.slug}: ${branchErr.message}`);
        }

        await recordAudit(req, {
            action: 'restaurant.create',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                plan: plan.slug,
                trialDays: trialPeriod,
                ownerEmail: cleanEmail,
                price: effectivePrice,
                paymentStatus: resolvedPaymentStatus,
                paymentMethod: markPaid ? cleanMethod : undefined,
            },
        });

        // Fire-and-forget welcome email. We do NOT await this inside
        // the critical path — if the email provider is slow or flaky,
        // the super admin's "create restaurant" request must still
        // return quickly. `sendEmail` catches all errors internally
        // and logs them, so a rejected promise is never thrown here.
        const emailResult = await sendEmail({
            to: cleanEmail,
            ...restaurantWelcome({
                restaurantName: restaurant.name,
                ownerName: adminUser.name,
                email: cleanEmail,
                tempPassword,
                planName: plan.name,
                trialDays: trialPeriod,
            }),
        });

        await recordAudit(req, {
            action: 'restaurant.welcome_email',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { provider: emailResult.provider, sent: emailResult.sent, dev: emailResult.dev },
        });

        return res.status(201).json({
            success: true,
            data: {
                restaurant: buildRestaurantPayload(restaurant),
                admin: {
                    _id: adminUser._id,
                    name: adminUser.name,
                    email: adminUser.email,
                    mustChangePassword: true,
                },
                // The temporary password is returned once so the operator
                // can hand it to the customer through a secure channel.
                // It is intentionally NOT persisted anywhere readable.
                temporaryPassword: tempPassword,
                email: {
                    sent: emailResult.sent,
                    provider: emailResult.provider,
                    dev: emailResult.dev,
                },
            },
            message: emailResult.sent
                ? `Restaurant created. Welcome email sent to ${cleanEmail}.`
                : 'Restaurant created. Share the temporary password with the owner via a secure channel.',
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'Restaurant slug or owner email already exists' });
        }
        logger.error('createRestaurant error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create restaurant' });
    }
};
