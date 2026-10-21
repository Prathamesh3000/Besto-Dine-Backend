const mongoose = require('mongoose');

/**
 * Restaurant (Tenant) Model
 *
 * Each Restaurant document represents a paying tenant on the BestoDine
 * SaaS platform. A Super Admin creates a Restaurant, assigns a SubscriptionPlan,
 * and links the initial admin user to it (User.restaurant).
 *
 * This document is the *source of truth* for the tenant's plan, limits and
 * feature flags. The plan snapshot is intentionally embedded so that future
 * plan edits do NOT silently change a paying tenant's contract — only an
 * explicit re-assignment by Super Admin updates the snapshot.
 *
 * NOTE: Wiring `tenantScope` middleware on every existing route + adding a
 * `restaurant` field to every domain model (Order, MenuItem, Table, etc.) is
 * Phase 1 of the SUPER_ADMIN_ARCHITECTURE doc and must be delivered as a
 * separate, dedicated migration. This file only establishes the tenant model.
 */
const restaurantSchema = new mongoose.Schema({
    // NOTE on caps below: every tenant carries an auto-provisioned
    // "Main" branch (utils/createMainBranch.js) that mirrors these
    // fields. Branch's schema enforces stricter limits (name ≤ 80,
    // city ≤ 80, contactPhone ≤ 30, contactEmail ≤ 120). The Restaurant
    // caps here MUST stay ≤ Branch caps so the Main branch creation
    // can never throw ValidationError on copy. Don't relax these
    // without also relaxing Branch.
    name: {
        type: String,
        required: [true, 'Restaurant name is required'],
        trim: true,
        maxlength: [80, 'Restaurant name cannot exceed 80 characters'],
    },
    // URL-safe identifier — used for tenant lookup by host/header/slug
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug may only contain lowercase letters, digits and hyphens'],
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        // Set after the initial admin user is created during onboarding.
        // Optional so the Restaurant document can be created first and the
        // admin user linked back to it in the same transaction.
    },
    contactEmail: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        maxlength: [120, 'Contact email cannot exceed 120 characters'],
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },
    contactPhone: {
        type: String,
        default: '',
        trim: true,
        maxlength: [30, 'Contact phone cannot exceed 30 characters'],
    },
    city: {
        type: String,
        default: '',
        trim: true,
        maxlength: [80, 'City cannot exceed 80 characters'],
    },

    // ─── Physical address ─────────────────────────────────────────────
    // Captured at onboarding. `city` above is kept as a denormalised
    // copy (used by list filters / search) so existing queries don't
    // need to reach into the nested path.
    address: {
        line1:   { type: String, default: '', trim: true, maxlength: 200 },
        line2:   { type: String, default: '', trim: true, maxlength: 200 },
        state:   { type: String, default: '', trim: true, maxlength: 80 },
        pincode: {
            type: String,
            default: '',
            trim: true,
            maxlength: [20, 'Pincode cannot exceed 20 characters'],
            validate: {
                validator: (v) => !v || /^[0-9]{6}$/.test(v),
                message: 'Pincode must be a 6-digit number',
            },
        },
        country: { type: String, default: 'India', trim: true, maxlength: 80 },
    },

    // ─── Regulatory / tax identifiers ─────────────────────────────────
    // Required for compliant invoicing. FSSAI is mandatory for any
    // food business in India; GSTIN is required only if the tenant
    // issues GST invoices; legalBusinessName appears on receipts and
    // may differ from the brand `name` above.
    legal: {
        legalBusinessName: { type: String, default: '', trim: true, maxlength: 160 },
        fssaiLicense: {
            type: String,
            default: '',
            trim: true,
            validate: {
                validator: (v) => !v || /^[0-9]{14}$/.test(v),
                message: 'FSSAI license must be a 14-digit number',
            },
        },
        gstin: {
            type: String,
            default: '',
            trim: true,
            uppercase: true,
            validate: {
                validator: (v) => !v || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(v),
                message: 'GSTIN must be a valid 15-character identifier',
            },
        },
        pan: {
            type: String,
            default: '',
            trim: true,
            uppercase: true,
            validate: {
                validator: (v) => !v || /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v),
                message: 'PAN must be a valid 10-character identifier',
            },
        },
    },

    // IANA timezone. Used for daily reports, order cutoffs and
    // scheduled jobs — a wrong value silently skews every date-based
    // aggregation, so it's captured at onboarding rather than
    // inferred later.
    timezone: {
        type: String,
        default: 'Asia/Kolkata',
        trim: true,
        maxlength: 64,
    },

    logo: {
        type: String,
        default: '',
    },
    status: {
        type: String,
        enum: ['trial', 'active', 'past_due', 'suspended', 'cancelled'],
        default: 'trial',
        index: true,
    },

    // ─── Subscription snapshot ─────────────────────────────────────────
    // The plan snapshot lives on the Restaurant so that:
    //   1. Tenant feature/limit lookups are a single document read.
    //   2. Editing a SubscriptionPlan never silently changes a tenant's
    //      contract — only an explicit re-assignment overwrites this.
    subscription: {
        plan: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SubscriptionPlan',
        },
        planName: { type: String, default: '' },   // denormalised for fast UI rendering
        planSlug: { type: String, default: '' },
        // Agreed price at assignment time (per billingCycle). Snapshotted so
        // editing the plan's catalog price later never retroactively changes
        // this tenant's revenue/MRR — they keep paying what they signed up for
        // until they're re-assigned. null = legacy tenant (fall back to live
        // plan price for metrics).
        price: { type: Number, default: null },
        startDate: { type: Date, default: Date.now },
        endDate: { type: Date },                    // null = no fixed end
        trialEndDate: { type: Date },               // null = no trial
        // When the current trial window started. For self-signups this is
        // the Super Admin approval date (the clock restarts on approval).
        trialStartDate: { type: Date },
        status: {
            type: String,
            enum: ['trial', 'active', 'past_due', 'cancelled'],
            default: 'trial',
        },
        // Snapshot of plan.features at assignment time (immutable until
        // Super Admin reassigns the plan).
        features: { type: Object, default: {} },
        // Snapshot of plan.limits at assignment time.
        limits: { type: Object, default: {} },

        // ── Razorpay billing (Phase 2) ─────────────────────────────
        // razorpayCustomerId is created once per tenant and re-used
        // across every subscription this tenant ever has. The
        // subscription id + short url are replaced every time the
        // tenant upgrades/downgrades. shortUrl is the page the owner
        // visits to authorize recurring payments with their card/UPI.
        razorpayCustomerId:     { type: String, default: '' },
        razorpaySubscriptionId: { type: String, default: '' },
        shortUrl:               { type: String, default: '' },
        // Most-recent webhook state, so the UI can show "paid until X"
        // without re-querying Razorpay on every render.
        razorpayStatus:    { type: String, default: '' },   // 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed'
        currentPeriodEnd: { type: Date },                    // updated on every subscription.charged webhook
        lastChargedAt:    { type: Date },

        // ── CRIT-18 — halted grace period ──────────────────────────
        // A single `subscription.halted` webhook (spurious or real)
        // no longer locks a paying tenant out instantly. Handler marks
        // the tenant `past_due`, schedules a delayed suspend 24h out,
        // and fires an alert. A later `subscription.charged` resets
        // these counters.
        haltedCount:        { type: Number, default: 0 },
        firstHaltedAt:      { type: Date },   // first halted in the current streak
        scheduledSuspendAt: { type: Date },   // actual lockout time

        // ── ADM-105 — pending upgrade pre-payment ──────────────────
        // When a tenant clicks "Upgrade Plan" the new plan's features
        // are NOT applied until Razorpay confirms the first charge —
        // otherwise the tenant could get the upgraded plan without
        // ever paying. We stash the chosen plan + Razorpay handles
        // here; the webhook moves these into the live subscription
        // fields on `subscription.charged` (or on `payment.captured`
        // for the fallback Orders path).
        pendingUpgrade: {
            plan:                   { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
            planName:               { type: String, default: '' },
            planSlug:               { type: String, default: '' },
            price:                  { type: Number, default: null },
            features:               { type: Object, default: {} },
            limits:                 { type: Object, default: {} },
            razorpaySubscriptionId: { type: String, default: '' },
            razorpayOrderId:        { type: String, default: '' },
            shortUrl:               { type: String, default: '' },
            fallbackOrder:          { type: Boolean, default: false },
            previousPlanSlug:       { type: String, default: '' },
            previousSubscriptionId: { type: String, default: '' },
            createdAt:              { type: Date },
        },

        // ── Scheduled downgrade (ADM-106 follow-up) ────────────────
        // When the Super Admin approves a tenant downgrade request,
        // the new plan is NOT applied immediately. Instead we:
        //   1. Cancel the Razorpay subscription with
        //      `cancel_at_cycle_end: true` so the tenant keeps paying
        //      for what they already paid for until the cycle ends.
        //   2. Stash the target plan snapshot here with the cycle-end
        //      date as `effectiveAt`.
        //   3. On `subscription.completed` webhook (Razorpay subs
        //      path) or on a lazy check at page load (fallback Orders
        //      path), we swap the plan + clear this block.
        // This avoids any refund / proration logic — the tenant
        // doesn't lose money and Razorpay handles the timing.
        scheduledDowngrade: {
            plan:        { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
            planName:    { type: String, default: '' },
            planSlug:    { type: String, default: '' },
            price:       { type: Number, default: null },
            features:    { type: Object, default: {} },
            limits:      { type: Object, default: {} },
            // Snapshot of the cycle end the tenant already paid for —
            // the switch happens at this moment.
            effectiveAt: { type: Date },
            // PlanChangeRequest id, for audit trail back to the
            // original request that triggered this schedule.
            requestId:   { type: mongoose.Schema.Types.ObjectId, ref: 'PlanChangeRequest' },
            // Snapshot of the plan they're moving FROM so we can show
            // "Premium -> Basic" in the UI even after the swap.
            fromPlanName: { type: String, default: '' },
            scheduledAt:  { type: Date },
        },
    },

    // Per-tenant overrides — Super Admin can grant or revoke specific
    // features beyond the base plan (e.g. trial of Advance Booking).
    // featureOverrides[key] = true | false → wins over subscription.features[key].
    featureOverrides: { type: Object, default: {} },

    // Paid add-ons — single modules bought on top of the base plan (e.g.
    // hall bookings on Gold). An active add-on switches its feature key on
    // (see utils/featureAccess). Kept outside `subscription` on purpose:
    // plan assignment rewrites the subscription block wholesale, and a
    // plan change must not silently drop an add-on the tenant paid for.
    addons: [{
        key:       { type: String, required: true, trim: true },
        // Agreed monthly price (INR, before GST) — catalog default unless
        // the Super Admin negotiated something else. Feeds MRR.
        price:     { type: Number, default: 0, min: 0 },
        status:    { type: String, enum: ['active', 'cancelled'], default: 'active' },
        startDate: { type: Date, default: Date.now },
        endDate:   { type: Date },          // null = until cancelled
        note:      { type: String, default: '', maxlength: 300 },
        addedBy:   { type: String, default: '' },   // super admin email
        cancelledAt: { type: Date },
        cancelledBy: { type: String, default: '' },
    }],

    // Operations profile — HOW this tenant runs (which operating modules
    // it uses, who serves, when the customer pays). Super Admin owned;
    // shape and rules live in utils/operationsProfile (normaliseProfile
    // validates every write). Absent = today's behaviour, so no default
    // is stored here. It can only switch things OFF within what the plan
    // allows (featureAccess stays the "may" layer).
    operations: { type: Object, default: undefined },

    // Per-branch operations overrides (design §12.1). `overrides` is a
    // PARTIAL stored profile (same shape as `operations`: preset /
    // modules / answers / advanced) deep-merged over the tenant profile
    // by utils/operationsProfile.resolveOperations(r, { branchId }).
    // No entry for a branch → the tenant profile, exactly as before.
    // Written only by the Super Admin (operationsController).
    operationsByBranch: {
        type: [{
            _id: false,
            branch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
            overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
            updatedAt: { type: Date },
        }],
        default: [],
    },

    // ─── Phase 7.3 — Custom domains ────────────────────────────────────
    // Optional vanity hostname (e.g. order.joescafe.com). When the
    // frontend's origin matches this domain, attachTenant resolves the
    // tenant by hostname instead of slug. The verification flow
    // requires the tenant to set a DNS CNAME pointing at the
    // platform's main domain, then hit a "verify" endpoint that
    // checks the record exists.
    //
    // `domainVerified` is set to true by the verification endpoint
    // and false when the domain is changed. Only verified domains
    // are used for tenant resolution — unverified ones are ignored
    // so a typo in the domain field can't accidentally steal another
    // tenant's traffic.
    customDomain: {
        type: String,
        default: '',
        trim: true,
        lowercase: true,
        maxlength: 253,
        index: { sparse: true },
    },
    domainVerified: {
        type: Boolean,
        default: false,
    },

    // ─── Phase 7.4 — White-label / branding ──────────────────────────
    // Per-tenant visual identity surfaced to customers AND used as the
    // From: identity on transactional email. Optional in every field;
    // null/empty falls back to the platform defaults so single-tenant
    // installs and tenants who haven't bothered to brand still look
    // correct.
    //
    // Validation note: we DON'T enforce file size / format on logoUrl
    // here — that's the upload pipeline's job. The model only stores
    // the URL string.
    //
    // primaryColor must be a 7-char hex (#RRGGBB) so the customer-side
    // CSS variable can plug it directly into Tailwind arbitrary
    // values without sanitisation. The format check stops a tenant
    // from injecting `red; }/* …` into a stylesheet.
    branding: {
        // Primary brand colour shown on the customer landing page,
        // header, and CTA buttons. Defaults to '' which falls through
        // to the BestoDine orange in the customer UI.
        primaryColor: {
            type: String,
            default: '',
            trim: true,
            validate: {
                validator: (v) => !v || /^#[0-9a-fA-F]{6}$/.test(v),
                message: 'primaryColor must be a 7-character hex code (e.g. #FE8301)',
            },
        },
        // Custom favicon shown in the browser tab when a customer is
        // on this tenant's pages. Falls back to the default
        // BestoDine favicon when empty.
        faviconUrl: { type: String, default: '', trim: true },
        // Display name + reply-to address used as the From: identity
        // on transactional email (welcome, plan changes, etc.). When
        // empty, the email module uses the EMAIL_FROM env var as
        // before — so unconfigured tenants don't break.
        emailFromName:    { type: String, default: '', trim: true, maxlength: 80 },
        emailFromAddress: {
            type: String,
            default: '',
            trim: true,
            lowercase: true,
            validate: {
                validator: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
                message: 'emailFromAddress must be a valid email',
            },
        },
        // Optional one-liner shown on the customer landing card and
        // in the email footer.
        tagline: { type: String, default: '', trim: true, maxlength: 140 },
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    suspendedAt: { type: Date },
    suspendedReason: { type: String, default: '' },

    // Last successful tenant data export (GET /tenant/export). Backs the
    // 5-minute export cooldown across instances via an atomic
    // findOneAndUpdate guard in controllers/tenantExportController.js.
    lastExportAt: { type: Date, default: null },

    // ─── Self-signup approval gate (Pending Approvals feature) ───────
    // Tracks WHERE this tenant came from and WHETHER it has been
    // reviewed by a Super Admin. Flow:
    //   - Admin-created tenant      → source: 'admin',  status: 'approved'
    //   - Marketing-site self-signup → source: 'self',  status: 'pending'
    // While pending, the tenant's `status` is 'suspended' so staff
    // cannot log in. Approval flips signupStatus to 'approved' AND
    // releases the lock by moving status to 'trial' / 'active'.
    signupSource: {
        type: String,
        enum: ['admin', 'self'],
        default: 'admin',
    },
    signupStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'approved',
        index: true,
    },
    signupNote: { type: String, default: '', maxlength: 1000 },
    signupRejectedReason: { type: String, default: '', maxlength: 500 },
    signupReviewedAt: { type: Date },
    signupReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Internal Super Admin review note on a self-signup application
    // (Pending Approvals → signup detail page). Never shown to the
    // tenant: `select: false` keeps it out of every query that doesn't
    // explicitly ask for `+signupReviewNote` (only the superadmin
    // approval-detail endpoint does).
    signupReviewNote: { type: String, default: '', maxlength: 1000, select: false },
    signupReviewNoteUpdatedAt: { type: Date },
    signupReviewNoteUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Self-signup extras. `requestedPlan` is the public plan the owner
    // picked on the signup form — informational only (billing is NOT
    // activated; the Super Admin assigns the real plan after review).
    // `signupMeta` carries marketing attribution (source / utm_*).
    requestedPlan: {
        plan:     { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
        planName: { type: String, default: '' },
        planSlug: { type: String, default: '' },
    },
    signupMeta: {
        ownerName:   { type: String, default: '', maxlength: 80 },
        source:      { type: String, default: '', maxlength: 100 },
        utmSource:   { type: String, default: '', maxlength: 100 },
        utmMedium:   { type: String, default: '', maxlength: 100 },
        utmCampaign: { type: String, default: '', maxlength: 100 },
        utmTerm:     { type: String, default: '', maxlength: 100 },
        utmContent:  { type: String, default: '', maxlength: 100 },
        termsAcceptedAt: { type: Date },
        ip:          { type: String, default: '', maxlength: 100 },
    },

    // ─── Manual payment confirmation gate ────────────────────────────
    // Independent of Razorpay. When a paid plan is assigned but
    // payment will arrive offline (cash / bank transfer / manual UPI),
    // the operator marks paymentStatus 'pending'. The tenant stays
    // suspended until 'received' is set, at which point status flips
    // to active/trial.
    //   - 'na'       — free plan, or Razorpay handles billing
    //   - 'pending'  — awaiting manual confirmation; tenant locked
    //   - 'received' — confirmed; tenant unlocked
    paymentStatus: {
        type: String,
        enum: ['na', 'pending', 'received'],
        default: 'na',
        index: true,
    },
    // How an offline payment was collected. Only meaningful when
    // paymentStatus is 'received' via the manual/walk-in flow — Razorpay
    // charges never set this. '' = not recorded.
    paymentMethod: {
        type: String,
        enum: ['', 'cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'],
        default: '',
    },
    paymentConfirmedAt: { type: Date },
    paymentConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paymentNote: { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

// ─── Indexes ─────────────────────────────────────────────────────────────
restaurantSchema.index({ status: 1, createdAt: -1 });
restaurantSchema.index({ contactEmail: 1 });

// ─── Instance helpers ────────────────────────────────────────────────────

/**
 * Resolves whether a feature is enabled for this tenant (overrides →
 * paid add-ons → plan snapshot; see utils/featureAccess).
 */
restaurantSchema.methods.hasFeature = function (key) {
    return require('../utils/featureAccess').hasFeature(this, key);
};

/**
 * Returns the numeric limit for a key (0 if undefined). Used by feature
 * gating middleware before allowing a create operation.
 */
restaurantSchema.methods.getLimit = function (key) {
    const value = this.subscription?.limits?.[key];
    return typeof value === 'number' ? value : 0;
};

module.exports = mongoose.model('Restaurant', restaurantSchema);
