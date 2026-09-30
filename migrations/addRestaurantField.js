/**
 * addRestaurantField.js — one-shot codemod for Phase 1 tenant scoping.
 *
 * Walks every domain Mongoose model file and inserts a tenant link field:
 *
 *     restaurant: {
 *         type: mongoose.Schema.Types.ObjectId,
 *         ref: 'Restaurant',
 *         default: null,
 *         index: true,
 *     },
 *
 * The insertion is fully idempotent — re-running this script is a no-op
 * once every model already has the field.
 *
 * Insertion strategy:
 *   We look for the LAST `new mongoose.Schema({` token in each file
 *   and insert the field on the next line, right inside that schema
 *   definition. The top-level model schema is always defined LAST,
 *   after any embedded sub-document schemas (e.g. orderItemSchema in
 *   order.js, sizeSchema in menuItem.js). Picking the last schema
 *   ensures the tenant link is on the model itself, not on a sub-doc.
 *
 * Models intentionally SKIPPED (these are platform-level / not tenant-scoped):
 *   - user.js          (already has restaurant field, added in Phase 0)
 *   - restaurant.js    (this IS the tenant)
 *   - subscriptionPlan.js  (platform-level billing tier)
 *   - auditLog.js      (platform-level audit trail)
 *   - otp.js           (phone-based, no tenant context — OTPs are short-lived)
 *
 * Run from the Backend directory:
 *
 *     node migrations/addRestaurantField.js
 *
 * The script does NOT touch the database. It only edits source files.
 */
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'models');

const SKIP = new Set([
    'user.js',          // already extended in Phase 0
    'restaurant.js',    // is the tenant
    'subscriptionPlan.js',
    'auditLog.js',
    'otp.js',
]);

const FIELD_BLOCK = `    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        default: null,
        index: true,
    },
`;

const MARKER = 'restaurant: {';

function processFile(filePath) {
    const original = fs.readFileSync(filePath, 'utf8');

    if (original.includes(MARKER) && original.includes("ref: 'Restaurant'")) {
        return { status: 'skipped-already', file: path.basename(filePath) };
    }

    // Find ALL `new mongoose.Schema({` matches and pick the LAST one —
    // that's always the top-level model schema (sub-document schemas
    // like orderItemSchema are declared earlier in the file).
    const schemaRegex = /new\s+mongoose\.Schema\s*\(\s*\{\s*\n/g;
    const matches = [...original.matchAll(schemaRegex)];
    if (matches.length === 0) {
        return { status: 'no-schema', file: path.basename(filePath) };
    }

    const last = matches[matches.length - 1];
    const insertAt = last.index + last[0].length;
    const next = original.slice(0, insertAt) + FIELD_BLOCK + original.slice(insertAt);

    fs.writeFileSync(filePath, next, 'utf8');
    return { status: 'updated', file: path.basename(filePath) };
}

function main() {
    const files = fs.readdirSync(MODELS_DIR)
        .filter(f => f.endsWith('.js') && !SKIP.has(f));

    const results = files.map(f => processFile(path.join(MODELS_DIR, f)));

    const updated = results.filter(r => r.status === 'updated');
    const skipped = results.filter(r => r.status === 'skipped-already');
    const failed  = results.filter(r => r.status === 'no-schema');

    console.log(`\nPhase 1 model migration summary:`);
    console.log(`  Updated: ${updated.length}`);
    updated.forEach(r => console.log(`    + ${r.file}`));
    console.log(`  Already had field: ${skipped.length}`);
    skipped.forEach(r => console.log(`    = ${r.file}`));
    if (failed.length) {
        console.log(`  Could not parse: ${failed.length}`);
        failed.forEach(r => console.log(`    ! ${r.file}`));
    }
    console.log('');
    console.log('Skipped (platform-level / not tenant-scoped):');
    [...SKIP].forEach(f => console.log(`    - ${f}`));
}

main();
