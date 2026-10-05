/**
 * dropLegacyIndexes.js — one-shot index migration for Phase 1.
 *
 * Some collections had global unique indexes that conflict with the new
 * tenant-scoped uniqueness rules. Mongoose creates the new compound
 * indexes automatically when the model loads, but it will NOT drop
 * pre-existing indexes from the live collection — those have to be
 * dropped explicitly.
 *
 * This script is FULLY IDEMPOTENT — re-running it after the legacy
 * indexes are gone is a no-op.
 *
 * Currently dropped:
 *   - wallets.user_1   → replaced by `{ user: 1, restaurant: 1 }`
 *                        so each customer can have one wallet per tenant.
 *   - tables.name_1_area_1 → replaced by the partial `name_area_unique_live`
 *                        so soft-deleted table names can be reused.
 *   (full list in LEGACY_INDEXES below)
 *
 * Run from the Backend directory:
 *
 *     node migrations/dropLegacyIndexes.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const LEGACY_INDEXES = [
    // Wave 1 — wallet per-tenant fix (already shipped)
    { collection: 'wallets',         index: 'user_1',           reason: 'replaced by compound { user, restaurant } unique — per-tenant wallets' },

    // Wave 2 — pre-emptive uniqueness fixes for fields generated/scoped per tenant
    { collection: 'advancebookings', index: 'bookingId_1',      reason: 'replaced by compound { bookingId, restaurant } — TBL-001/HALL-001 generated per tenant' },
    { collection: 'areas',           index: 'name_1',           reason: 'replaced by compound { name, restaurant } — two restaurants can both have an "Indoor" area' },
    { collection: 'categories',      index: 'name_1',           reason: 'replaced by compound { name, restaurant } — same category names across tenants are fine' },
    { collection: 'coupons',         index: 'code_1',           reason: 'replaced by compound { code, restaurant } — two restaurants can both run "WELCOME10"' },
    { collection: 'invoices',        index: 'invoiceNumber_1',  reason: 'replaced by compound { invoiceNumber, restaurant } — INV-001 generated per tenant' },
    { collection: 'transactions',    index: 'transactionId_1',  reason: 'replaced by compound { transactionId, restaurant } — per-tenant TXN sequences' },
    { collection: 'users',           index: 'staffId_1',        reason: 'replaced by partial compound { staffId, restaurant } — EMP-001 generated per tenant' },
    { collection: 'addons',          index: 'slug_1',           reason: 'replaced by compound { slug, restaurant } — addon slugs unique per tenant' },

    // Wave 3 — per-tenant staff emails
    { collection: 'users',           index: 'email_1',          reason: 'replaced by partial { email_global_unique } and partial { email_per_tenant_unique } — staff emails are unique per tenant, customers/superadmins remain global' },

    // Wave 4 — per-branch staff IDs (Phase 6 step 4+).
    // Mongoose creates the new index under the explicit name
    // `staffId_per_branch_unique`. The implicit fallback name from the
    // old definition was `staffId_1_restaurant_1` — drop it so each
    // branch can restart its own EMP-001 sequence.
    { collection: 'users',           index: 'staffId_1_restaurant_1', reason: 'replaced by partial compound { staffId, restaurant, branch } — EMP-001 restarts per branch (Phase 6+)' },

    // Wave 5 — soft-deleted tables must not block their name (2026-10).
    // models/table.js now declares the unique { name, area } index as
    // `name_area_unique_live` with partialFilterExpression isDeleted:false.
    // The old implicit index still counts deleted tables, so re-creating a
    // deleted table's name fails until it is dropped.
    { collection: 'tables',          index: 'name_1_area_1',    reason: 'replaced by partial unique name_area_unique_live (isDeleted:false) — deleted table names are reusable' },
];

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    const db = mongoose.connection.db;

    for (const { collection, index, reason } of LEGACY_INDEXES) {
        try {
            const indexes = await db.collection(collection).indexes();
            const found = indexes.find(i => i.name === index);
            if (!found) {
                console.log(`= ${collection}.${index} already dropped — skipping`);
                continue;
            }

            await db.collection(collection).dropIndex(index);
            console.log(`+ ${collection}.${index} dropped`);
            console.log(`  reason: ${reason}`);
        } catch (err) {
            console.error(`! ${collection}.${index} drop failed: ${err.message}`);
        }
    }

    console.log('\n✔ Done. The new compound indexes are created automatically');
    console.log('  on the next backend boot when Mongoose loads the schemas.');

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
