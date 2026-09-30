/**
 * Phase 3 hardening — pre-save observability for tenant-scoped models.
 *
 * Every model whose schema declares a `restaurant` field is considered
 * tenant-scoped. This helper walks `mongoose.models` at startup and
 * attaches a `pre('save')` hook to each such schema. The hook WARNS
 * (does not reject) when a new document is being saved without the
 * `restaurant` field set.
 *
 * Why warn, not throw?
 *   - We want to catch gaps in the migration without breaking any
 *     in-flight requests. The Phase 1 backfill means every existing
 *     doc has a tenant, and the controllers all stamp new writes —
 *     but a missed code path would previously have silently created
 *     a tenant-less doc. This hook surfaces those cases in the logs so
 *     we can fix them before flipping the field to `required: true`.
 *
 * Usage:
 *   Call `installTenantAssertions()` once, AFTER all routes have been
 *   mounted (which is when every model has been `require()`d into
 *   mongoose.models). Safe to call multiple times — it skips schemas
 *   that already have the hook installed.
 *
 * Exit criteria:
 *   When `tenant.assertion.missing` log lines stop appearing for a
 *   full soak window, we can tighten the restaurant field on each
 *   tenant-scoped model to `required: true` and delete this helper.
 */

const mongoose = require('mongoose');
const logger = require('./logger');

// Models that legitimately never carry a restaurant field. Keep this in
// sync with PHASE_1_SCOPING_NOTES.md §1 (Skipped intentionally).
const PLATFORM_MODELS = new Set([
    'User',              // user.restaurant may be null for customers/superadmins
    'Restaurant',        // is the tenant
    'SubscriptionPlan',  // platform-level billing tier
    'AuditLog',          // platform-level audit trail
    'Otp',               // short-lived, no tenant context
]);

const HOOK_MARKER = '__tenantAssertionInstalled__';

function hasRestaurantField(schema) {
    // `paths` is a flat map of top-level + nested paths keyed by dotted
    // name. We only care about the top-level `restaurant` field.
    return Boolean(schema?.paths?.restaurant);
}

function installTenantAssertions() {
    let installed = 0;
    let skipped = 0;
    for (const [name, model] of Object.entries(mongoose.models)) {
        if (PLATFORM_MODELS.has(name)) { skipped++; continue; }
        const schema = model.schema;
        if (!hasRestaurantField(schema)) { skipped++; continue; }
        if (schema[HOOK_MARKER])         { continue; }

        schema.pre('save', function rejectIfMissingTenant(next) {
            // CRIT-04 — reject, don't just warn. Saving a document
            // without `restaurant` either orphans it out of every
            // tenant's view or, combined with a query that forgets to
            // filter on `restaurant`, leaks data across tenants. The
            // schema-level `required: true` is the primary guarantee;
            // this hook catches the bulk-insert / direct-save paths.
            if (this.isNew && (this.restaurant === undefined || this.restaurant === null)) {
                logger.error('tenant.assertion.reject save without restaurant', {
                    model: name,
                    docId: this._id?.toString?.() || null,
                });
                const err = new Error(
                    `Refusing to save ${name} without restaurant field (CRIT-04 enforcement).`
                );
                err.code = 'TENANT_FIELD_MISSING';
                err.statusCode = 500;
                return next(err);
            }
            return next();
        });

        schema[HOOK_MARKER] = true;
        installed++;
    }

    logger.debug(`tenant.assertion.installed hooks=${installed} skipped=${skipped}`);
    return { installed, skipped };
}

module.exports = { installTenantAssertions };
