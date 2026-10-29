const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Please provide your name'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    // Phase 1 SaaS: email is GLOBALLY unique for customers and super
    // admins (one identity, login from anywhere) but PER-TENANT unique
    // for restaurant staff (so two restaurants can both have a staff
    // member named "sk@gmail.com"). The two partial indexes at the
    // bottom of this file enforce that — there is no longer a single
    // global `unique: true` constraint on email.
    email: {
        type: String,
        required: [true, 'Please provide your email'],
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        // Conditional: a Google-authenticated account has no password and
        // never will unless the user deliberately sets one. Making this
        // unconditionally required would have forced us to invent a
        // random password for every Google signup — a credential nobody
        // knows, that still hashes and still satisfies a login attempt if
        // it ever leaked. Absent is safer than fake.
        required: [
            function () { return !this.googleId; },
            'Please provide a password',
        ],
        minlength: 8,
        select: false
    },

    // ── Google Sign-In ────────────────────────────────────────────────
    // Google's `sub` claim: a stable, unique, per-account identifier.
    // Matched on in preference to email because a Google account's email
    // CAN change, while `sub` never does.
    //
    // No default: a password-only user simply has no googleId field.
    // Uniqueness is enforced by the partial index `googleId_1` declared
    // at the bottom of this file, which only covers documents whose
    // googleId is a string. (The previous `default: null` + `sparse`
    // combination was broken: sparse only skips documents that LACK the
    // field, and the default stored null on every user, so the second
    // password-only user collided on googleId: null. Existing databases
    // are repaired by migrations/fixGoogleIdIndex.js.)
    googleId: {
        type: String,
    },

    // How this account can authenticate. An account that registered with
    // a password and later signed in with Google holds both, and either
    // route works from then on.
    authProviders: {
        type: [String],
        enum: ['password', 'google'],
        default: ['password'],
    },
    // Optional — required for customers during registration; staff accounts
    // created via /api/staff may omit it.
    mobile: {
        type: String,
        default: '',
        validate: {
            validator: function (v) {
                // Allow ANY empty form (null, undefined, '') OR a valid
                // 10-digit Indian mobile starting with 6-9. Tolerating
                // null/undefined here protects updateProfile (and any
                // other user.save()) from failing when an existing user
                // has a legacy null/missing mobile value in the DB.
                if (v === null || v === undefined || v === '') return true;
                return /^[6-9]\d{9}$/.test(v);
            },
            message: 'Please provide a valid 10-digit mobile number'
        }
    },
    // Allergy / dietary restrictions — sent from the customer register form.
    // Optional; customers may leave it blank.
    allergy: {
        type: String,
        trim: true,
        default: '',
        maxlength: [1000, 'Allergy text cannot exceed 1000 characters']
    },
    // Date of birth — used for birthday offers / loyalty campaigns.
    // GLOBAL identity field (lives on the customer's single account, not
    // per-tenant) — every restaurant the customer orders from gets the
    // same DOB. Optional; customers may leave it blank.
    dob: {
        type: Date,
        default: null,
        validate: {
            validator: function (v) {
                if (!v) return true;
                const d = new Date(v);
                if (Number.isNaN(d.getTime())) return false;
                return d < new Date() && d > new Date('1900-01-01');
            },
            message: 'Date of birth must be a past date after 1900'
        }
    },
    // Wedding / anniversary date — used for anniversary offers.
    // GLOBAL identity field. Optional.
    anniversary: {
        type: Date,
        default: null,
        validate: {
            validator: function (v) {
                if (!v) return true;
                const d = new Date(v);
                if (Number.isNaN(d.getTime())) return false;
                return d < new Date() && d > new Date('1950-01-01');
            },
            message: 'Anniversary must be a past date after 1950'
        }
    },
    // Gender (self-identified). Optional; customers may skip.
    gender: {
        type: String,
        enum: ['', 'male', 'female', 'other', 'prefer_not_to_say'],
        default: ''
    },
    // Dietary preference — replaces the localStorage-only veg/non-veg flags
    // on the customer profile so the choice survives device switches.
    // GLOBAL: a single customer is, say, vegetarian everywhere they eat.
    dietaryPreference: {
        type: String,
        enum: ['', 'veg', 'non_veg', 'vegan', 'eggetarian', 'jain'],
        default: ''
    },
    // UI language preference — 'en' / 'hi' / 'mr'. Empty string means
    // "no explicit choice, fall back to browser detection on the client".
    // Synced from /auth/me so the customer's choice follows them across
    // devices. Tenant-agnostic (global identity, like dob/gender).
    preferredLanguage: {
        type: String,
        enum: ['', 'en', 'hi', 'mr'],
        default: ''
    },
    // Default address — used to pre-fill takeaway / parcel order details.
    // All fields optional individually; customers may save just a city, or
    // nothing at all. Stored as an embedded subdoc rather than a separate
    // model because a customer has at most one default address.
    address: {
        line1:    { type: String, trim: true, default: '', maxlength: [200, 'Address line 1 cannot exceed 200 characters'] },
        line2:    { type: String, trim: true, default: '', maxlength: [200, 'Address line 2 cannot exceed 200 characters'] },
        city:     { type: String, trim: true, default: '', maxlength: [100, 'City cannot exceed 100 characters'] },
        state:    { type: String, trim: true, default: '', maxlength: [100, 'State cannot exceed 100 characters'] },
        pincode: {
            type: String,
            trim: true,
            default: '',
            validate: {
                validator: function (v) {
                    if (!v) return true;
                    return /^[1-9]\d{5}$/.test(v);
                },
                message: 'Pincode must be a valid 6-digit Indian pincode'
            }
        },
        landmark: { type: String, trim: true, default: '', maxlength: [200, 'Landmark cannot exceed 200 characters'] },
    },
    // URL to the user's profile picture.
    // Defaults to a generated avatar based on the user's name.
    avatar: {
        type: String,
        default: '',
        validate: {
            validator: function (v) {
                // Allow empty, http(s) URLs, protocol-relative URLs, or local upload paths.
                // Reject dangerous schemes like javascript:, data:, file:, vbscript:
                if (!v) return true;
                return /^(https?:)?\/\//i.test(v) || v.startsWith('/uploads/');
            },
            message: 'Avatar must be a valid HTTP(S) URL or uploaded file path'
        }
    },
    // Auto-generated ID for staff members (e.g. "EMP-001").
    // Not set for customer accounts.
    //
    // Phase 1 SaaS: staffId is unique PER TENANT — two restaurants can
    // both start fresh from EMP-001. Uniqueness is enforced by the
    // compound partial index at the bottom of this file. The legacy
    // global `unique: true` is gone; the migration script
    // `Seed/dropLegacyIndexes.js` drops the old `staffId_1` index from
    // the live MongoDB collection.
    staffId: {
        type: String
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    // 'captain' added — used by CAPTAIN_ROLES and STAFF_ROLES in the frontend
    // 'manager' = tenant-level supervisor role. Treated like an admin in
    // most permission paths but stored as a distinct role so the admin
    // UI can group / filter them and so per-staff permissions can revoke
    // sensitive capabilities (billing, branch CRUD) without taking away
    // their day-to-day controls.
    // 'superadmin' = platform-level operator (BestoDine staff). Not tied
    // to a single restaurant. Created only via seed script or by another
    // full superadmin. NEVER assignable through public registration.
    role: {
        type: String,
        enum: ['customer', 'admin', 'manager', 'chef', 'waiter', 'captain', 'superadmin'],
        default: 'customer'
    },
    // Super-admin sub-level. Only meaningful when role === 'superadmin'.
    //   'full'    — can manage restaurants, plans, billing, impersonation
    //   'support' — read-only impersonation + audit log; cannot mutate plans/billing
    superadminLevel: {
        type: String,
        enum: ['', 'full', 'support'],
        default: ''
    },
    // Tenant link. Set for restaurant-scoped staff (admin, manager, waiter,
    // captain, chef). Null for customers (they can order from any restaurant)
    // and for superadmins (they operate above the tenant boundary).
    //
    // This field is additive — existing single-tenant deployments continue
    // to work because every domain controller currently ignores it. Phase 1
    // of the SaaS migration will start filtering queries by this field.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        default: null,
        index: true
    },
    // Phase 6 step 4: optional branch assignment for staff.
    //   - null = tenant-level staff (sees orders from every branch).
    //   - ObjectId = pinned to that branch; dashboards and order
    //     queries auto-filter to this branch id.
    //
    // A tenant admin is expected to stay tenant-level (null) so they
    // can oversee all locations, but there's no schema enforcement —
    // the UI gates the picker by role, not the backend, because a
    // chain might legitimately want a per-branch manager with full
    // admin rights at their location.
    //
    // Not applicable to customers or super admins; the field stays
    // null for them by default.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // Chef-only: which items this chef handles in the kitchen.
    // 'veg' = vegetarian items only, 'nonveg' = non-veg only, 'both' = all items.
    kitchenResponsibility: {
        type: String,
        enum: ['veg', 'nonveg', 'both', ''],
        default: ''
    },
    // Waiter / Captain area & table assignments.
    //   - Waiter   → both arrays are meaningful. Empty arrays = "receive
    //                everything in their branch" (legacy behaviour).
    //   - Captain  → only `assignedAreas` is meaningful (a captain covers
    //                whole areas; we don't pin them to individual tables).
    //                `assignedTables` should stay empty for captains.
    //   - Other roles (chef / manager / admin / customer / superadmin)
    //                → both stay empty; consumers should ignore.
    //
    // Routing logic that wants to honour these assignments must treat an
    // empty array as "no filter" (= receive all), not as "receive none".
    // That preserves backwards compatibility — pre-migration staff with
    // no assignments keep seeing everything.
    assignedAreas: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Area',
    }],
    assignedTables: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table',
    }],
    // Waiter / Captain — does this staffer handle TAKEAWAY (counter) orders?
    // Takeaway has no table/area so it can't be pinned via assignedAreas;
    // it's offered in the admin "Assigned Areas" picker as a pseudo-area
    // ("Takeaway"). Visibility rule (frontend utils/waiterScope):
    //   - true                      → sees / handles takeaway
    //   - false + area|table pinned  → does NOT see takeaway (someone else's job)
    //   - no pin at all (catch-all)  → sees takeaway (legacy default)
    //   - captain/admin/manager      → always see takeaway (supervisors)
    handlesTakeaway: {
        type: Boolean,
        default: false,
    },
    // CRIT-06 — true ONLY for the single user who is Restaurant.owner.
    // Sub-admins (role='admin' pinned to a branch) keep FULL admin-panel
    // access within their branch — `checkPermission` still bypasses for
    // role='admin'. The flag gates truly tenant-level operations via
    // `adminExclusive`: billing, branding, branch CRUD, tenant export,
    // plan changes. Migrate existing data with Seed/backfillTenantOwner.js.
    isTenantOwner: {
        type: Boolean,
        default: false,
        index: true,
    },
    // When true the user MUST change their password on next login before
    // they can access any other page.  Set automatically when an admin
    // creates a staff account or resets a staff member's password.
    mustChangePassword: {
        type: Boolean,
        default: false
    },
    // #15 — session revocation counter. Embedded in every access token
    // (`tv` claim) and every refresh session; protect/optionalAuth reject
    // a token whose `tv` differs. Bump it ($inc) to log the user out of
    // every device: password change / reset, "log out everywhere", and
    // should also be bumped when an admin resets or deactivates staff.
    tokenVersion: {
        type: Number,
        default: 0
    },
    // Optional TOTP 2FA (admin / superadmin only — see utils/totp.js and
    // controllers/twoFactorController.js). The secret is AES-256-GCM
    // encrypted and, with the recovery-code hashes, excluded from queries
    // unless explicitly selected.
    twoFactor: {
        enabled: { type: Boolean, default: false },
        secretEnc: { type: String, select: false },
        recoveryHashes: { type: [String], select: false, default: undefined },
        verifiedAt: { type: Date },
        lastUsedStep: { type: Number, default: 0 },
    },
    // Granular feature flags per staff member.
    // Stored as a plain Object so JSON.stringify() round-trips correctly
    // (Map serialises to {} which loses all entries in localStorage).
    permissions: {
        type: Object,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Performance indexes
userSchema.index({ role: 1, status: 1 });
// Admin Staff page filter — list staff scoped to (tenant, branch, role).
// Covers the most common staff query (admin asks "show me waiters at
// branch X") without scanning the full per-tenant user collection.
userSchema.index({ restaurant: 1, branch: 1, role: 1 });

// Phase 6 step 4+: per-(tenant, branch) uniqueness on staffId.
// Sequence restarts at EMP-001 inside each branch so each branch's
// Sub Admin and team feel "self-contained" in the admin UI. Two staff
// in the same tenant can therefore share an EMP-001 if they sit at
// different branches — they are always paired with their branch
// in display surfaces (Staff table, badges, payslips).
//
// Tenant-level staff (branch=null, e.g. the tenant owner) form their
// own sequence under the null-branch bucket.
//
// Migration: drop the legacy `{staffId,restaurant}` unique partial
// index via Seed/dropLegacyIndexes.js before this index is built —
// MongoDB tolerates both at runtime but the legacy index would still
// reject branch-overlapping EMP-001 entries.
userSchema.index(
    { staffId: 1, restaurant: 1, branch: 1 },
    {
        name: 'staffId_per_branch_unique',
        unique: true,
        partialFilterExpression: { staffId: { $type: 'string' } },
    }
);

// ── Google `sub` uniqueness ─────────────────────────────────────────────
// Unique among users that HAVE a string googleId; users without one (the
// field absent, or a legacy null) are not indexed and never collide.
// Keep the name `googleId_1` so migrations/fixGoogleIdIndex.js can
// replace the legacy `{ unique, sparse }` index of the same name.
userSchema.index(
    { googleId: 1 },
    {
        name: 'googleId_1',
        unique: true,
        partialFilterExpression: { googleId: { $type: 'string' } },
    }
);

// ── Email uniqueness — split into two partial indexes ──────────────────
//
// Customers and super admins are global identities — one email, one
// account. They use the same login from any tenant.
//
// Restaurant staff (admin/manager/waiter/captain/chef) are per-tenant —
// the same email can be used across tenants because each tenant manages
// its own staff list independently. Login disambiguates by tenant slug.
//
// Both indexes are unique partials, so MongoDB only enforces uniqueness
// on the matching subset of documents.
userSchema.index(
    { email: 1 },
    {
        name: 'email_global_unique',
        unique: true,
        partialFilterExpression: { role: { $in: ['customer', 'superadmin'] } },
    }
);

userSchema.index(
    { email: 1, restaurant: 1 },
    {
        name: 'email_per_tenant_unique',
        unique: true,
        partialFilterExpression: {
            role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
        },
    }
);

// ─── Hooks ───────────────────────────────────────────────────────────────────

// Hash password before every save (only when it has been modified).
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 12);
});

// Set a default avatar from the user's name when none is provided.
userSchema.pre('save', async function () {
    if (!this.avatar) {
        this.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(this.name || 'User')}&background=FE8301&color=fff`;
    }
});

// ─── Serialisation ───────────────────────────────────────────────────────────
// `select: false` only applies to queries: a freshly created / saved
// document still carries the bcrypt hash in memory, and res.json() would
// ship it to the client. Strip credentials whenever a User document is
// serialised to JSON. (googleId / authProviders are identifiers, not
// secrets, and are left as they were.)
userSchema.set('toJSON', {
    transform(_doc, ret) {
        delete ret.password;
        if (ret.twoFactor) {
            delete ret.twoFactor.secretEnc;
            delete ret.twoFactor.recoveryHashes;
        }
        return ret;
    },
});

// ─── Instance methods ─────────────────────────────────────────────────────────

// Compare a plain-text candidate password against the stored bcrypt hash.
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;
