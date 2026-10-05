/**
 * Phase 3 hardening — pre-save observability for tenant-scoped models.
 *
 * Every model whose schema declares a `restaurant` field is considered
 * tenant-scoped. This helper walks `mongoose.models` at startup and
 * attaches a `pre('save')` hook to each such model. The hook REJECTS
 * (CRIT-04, error code TENANT_FIELD_MISSING) a new document saved without
 * the `restaurant` field set. Models whose restaurant is optional by
 * design are listed in PLATFORM_MODELS and skipped.
 *
 * Usage:
 *   Call `installTenantAssertions()` once, AFTER all routes have been
 *   mounted (which is when every model has been `require()`d into
 *   mongoose.models). Safe to call multiple times — it skips schemas
 *   and models that already have the hook installed.
 *
 * Exit criteria:
 *   When `tenant.assertion.missing` log lines stop appearing for a
 *   full soak window, we can tighten the restaurant field on each
 *   tenant-scoped model to `required: true` and delete this helper.
 */

const mongoose = require('mongoose');
const logger = require('./logger');

// Models that legitimately never carry a restaurant field — or carry an
// OPTIONAL one that is null by design. Keep this in sync with
// PHASE_1_SCOPING_NOTES.md §1 (Skipped intentionally).
const PLATFORM_MODELS = new Set([
    'User',              // user.restaurant may be null for customers/superadmins
    'Restaurant',        // is the tenant
    'SubscriptionPlan',  // platform-level billing tier
    'AuditLog',          // platform-level audit trail
    'Otp',               // short-lived, no tenant context
    // restaurant: { default: null } on purpose — written on tenant-less
    // routes too (/auth, the Razorpay webhook, platform billing):
    'IdempotencyRecord',
    'PasswordResetToken',
    'PaymentClaim',
]);

const HOOK_MARKER = '__tenantAssertionInstalled__';

function hasRestaurantField(schema) {
    // `paths` is a flat map of top-level + nested paths keyed by dotted
    // name. We only care about the top-level `restaurant` field.
    return Boolean(schema?.paths?.restaurant);
}

// CRIT-04 — reject, don't just warn. Saving a document without
// `restaurant` either orphans it out of every tenant's view or, combined
// with a query that forgets to filter on `restaurant`, leaks data across
// tenants. The schema-level `required: true` is the primary guarantee;
// this hook catches models whose field is optional.
//
// Mongoose 9 / kareem 3 pre hooks receive no `next` callback (the first
// argument is the save options): reject by throwing, accept by returning.
function rejectIfMissingTenant() {
    if (this.isNew && (this.restaurant === undefined || this.restaurant === null)) {
        const name = this.constructor?.modelName || 'document';
        logger.error('tenant.assertion.reject save without restaurant', {
            model: name,
            docId: this._id?.toString?.() || null,
        });
        const err = new Error(
            `Refusing to save ${name} without restaurant field (CRIT-04 enforcement).`
        );
        err.code = 'TENANT_FIELD_MISSING';
        err.statusCode = 500;
        throw err;
    }
}

function hasHook(kareem) {
    return Boolean(kareem?._pres?.get?.('save')?.some((h) => h.fn === rejectIfMissingTenant));
}

/**
 * Install the save assertion on every tenant-scoped model.
 *
 * Mongoose 9 snapshots document middleware when a model is compiled
 * (model.prototype.$__middleware / model._middleware), so a hook added to
 * the schema afterwards never runs for models that already exist. The
 * hook is therefore added in both places: on the schema (models compiled
 * later, e.g. useDb() / re-registration) and on each already-compiled
 * model's own middleware. Idempotent.
 */
function installTenantAssertions() {
    let installed = 0;
    let skipped = 0;
    for (const [name, model] of Object.entries(mongoose.models)) {
        if (PLATFORM_MODELS.has(name)) { skipped++; continue; }
        const schema = model.schema;
        if (!hasRestaurantField(schema)) { skipped++; continue; }

        let added = false;
        if (!schema[HOOK_MARKER]) {
            schema.pre('save', rejectIfMissingTenant);
            schema[HOOK_MARKER] = true;
            added = true;
        }
        // Document.save() runs the prototype's snapshot ($__middleware);
        // model._middleware is the model-level copy. Hook both.
        for (const kareem of new Set([model.prototype?.$__middleware, model._middleware])) {
            if (kareem && typeof kareem.pre === 'function' && !hasHook(kareem)) {
                kareem.pre('save', rejectIfMissingTenant);
                added = true;
            }
        }
        if (added) installed++;
    }

    logger.debug(`tenant.assertion.installed hooks=${installed} skipped=${skipped}`);
    return { installed, skipped };
}

module.exports = { installTenantAssertions };
