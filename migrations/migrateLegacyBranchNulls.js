/**
 * migrateLegacyBranchNulls.js
 *
 * Phase 6 hardening — one-shot migration to fix branch isolation leaks
 * caused by legacy data created BEFORE branches existed.
 *
 * Problem: collections like Order / Table / Inventory / Wallet were
 * stamped with `branch: null` for everything created before the multi-
 * branch feature was introduced. The previous read filters treated null
 * as "shared with all branches", so every Sub Admin saw every legacy
 * record — exactly as if they were the main-branch admin.
 *
 * Fix:
 *   1. For each tenant, pick the "main" branch — the OLDEST active
 *      branch (the one created first when multi-branch was enabled).
 *   2. Reassign every {branch:null, restaurant:<tenant>} record to that
 *      main branch in: Order, Table, Inventory, Wallet, Recipe.
 *   3. MenuItem is INTENTIONALLY excluded — there `branch:null` means
 *      "shared item", which is the correct semantic.
 *
 * Idempotent: running it twice is a no-op (no records will have
 * branch:null after the first run for any tenant that owns branches).
 *
 * Tenants without any branches yet are skipped — null is still
 * meaningful for them ("not using multi-branch yet"), and the read
 * filters don't apply since they have no Sub Admins.
 *
 * Usage:
 *   cd Backend && node migrations/migrateLegacyBranchNulls.js          # apply
 *   cd Backend && node migrations/migrateLegacyBranchNulls.js --dry    # preview only
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Restaurant = require('../models/restaurant');
const Branch     = require('../models/branch');
const Order      = require('../models/order');
const Table      = require('../models/table');
const Inventory  = require('../models/inventory');
const Wallet     = require('../models/wallet');
const Recipe     = require('../models/recipe');

const DRY = process.argv.includes('--dry');

const COLLECTIONS = [
    { name: 'Order',     Model: Order },
    { name: 'Table',     Model: Table },
    { name: 'Inventory', Model: Inventory },
    { name: 'Wallet',    Model: Wallet },
    { name: 'Recipe',    Model: Recipe },
];

async function migrate() {
    if (!process.env.MONGO_URL) {
        console.error('❌ MONGO_URL not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✓ Connected to MongoDB');
    console.log(DRY ? '🔍 DRY RUN — no writes will be made\n' : '✏️  APPLYING changes\n');

    const tenants = await Restaurant.find({}).select('_id name').lean();
    console.log(`Found ${tenants.length} tenant(s).\n`);

    const summary = [];

    for (const t of tenants) {
        // Pick the "main" branch — match utils/mainBranch.js resolution:
        //   1. Prefer slug === 'main' (the auto-provisioned marker from
        //      utils/createMainBranch.js — authoritative for any tenant
        //      created after multi-branch landed).
        //   2. Fallback: the oldest active branch (legacy convention,
        //      kept for tenants that pre-date auto-Main and have not
        //      been backfilled).
        //
        // The previous implementation always took the oldest branch,
        // which silently re-attributed legacy data to whichever sub-
        // branch happened to be created first — e.g. "FC Road" — even
        // when the tenant already had an explicit slug='main' branch.
        let mainBranch = await Branch.findOne({
            restaurant: t._id,
            isActive: true,
            slug: 'main',
        }).select('_id name slug').lean();
        let resolvedVia = 'slug=main';
        if (!mainBranch) {
            mainBranch = await Branch.findOne({
                restaurant: t._id,
                isActive: true,
            }).sort({ createdAt: 1 }).select('_id name slug').lean();
            resolvedVia = 'oldest-active';
        }

        if (!mainBranch) {
            console.log(`— Skipping "${t.name}" — no active branches yet.`);
            summary.push({ tenant: t.name, mainBranch: '—', updates: {} });
            continue;
        }

        console.log(`▶ Tenant "${t.name}" → main branch: "${mainBranch.name}" (${resolvedVia})`);

        const updates = {};
        for (const { name, Model } of COLLECTIONS) {
            const filter = { restaurant: t._id, branch: null };
            const count = await Model.countDocuments(filter);
            updates[name] = count;
            if (count === 0) {
                console.log(`    ${name.padEnd(10)}: 0 to migrate`);
                continue;
            }
            if (DRY) {
                console.log(`    ${name.padEnd(10)}: would migrate ${count}`);
            } else {
                const r = await Model.updateMany(filter, { $set: { branch: mainBranch._id } });
                console.log(`    ${name.padEnd(10)}: migrated ${r.modifiedCount}`);
            }
        }

        summary.push({
            tenant: t.name,
            mainBranch: mainBranch.name,
            updates,
        });
        console.log();
    }

    console.log('━'.repeat(60));
    console.log('SUMMARY');
    console.log('━'.repeat(60));
    for (const s of summary) {
        const totals = Object.entries(s.updates)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        console.log(`  ${s.tenant.padEnd(30)} main: ${s.mainBranch.padEnd(20)} ${totals}`);
    }
    if (DRY) console.log('\n🔍 DRY RUN — re-run without --dry to apply.');

    await mongoose.disconnect();
}

migrate().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
