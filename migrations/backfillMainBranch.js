/**
 * backfillMainBranch.js — one-shot tenant repair.
 *
 * Ensures every Restaurant has a "Main" branch (slug='main'). The
 * Main branch is the well-known marker used by getMainBranchId,
 * the customer picker, and Settings inheritance — without it, a
 * tenant's primary location is invisible in the Branches tab and
 * customer-facing branch list.
 *
 * Two repair scenarios:
 *   1. Tenants with ZERO branches → create Main + reassign any
 *      leftover `branch=null` Order/Table/Inventory/Wallet/Recipe
 *      rows to it.
 *   2. Tenants with sub-branches but NO slug='main' branch → create
 *      Main alongside the existing sub-branches. Existing data is
 *      left where it is (the operator can later move historical
 *      rows to Main from the admin UI if needed).
 *
 * Tenants that already have a slug='main' branch are skipped.
 *
 * MenuItem is intentionally excluded from the null-reassignment:
 * `branch: null` on a MenuItem means "shared item visible to every
 * branch", which is correct semantics and not a bug.
 *
 * Usage:
 *     cd Backend && node migrations/backfillMainBranch.js          # apply
 *     cd Backend && node migrations/backfillMainBranch.js --dry    # preview
 *
 * Idempotent — safe to re-run.
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

const { createMainBranchFor } = require('../utils/createMainBranch');

const DRY = process.argv.includes('--dry');

const NULL_REASSIGN_MODELS = [
    { name: 'Order',     Model: Order },
    { name: 'Table',     Model: Table },
    { name: 'Inventory', Model: Inventory },
    { name: 'Wallet',    Model: Wallet },
    { name: 'Recipe',    Model: Recipe },
];

async function main() {
    if (!process.env.MONGO_URL) {
        console.error('FATAL: MONGO_URL is not set');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL, { family: 4 });
    console.log('Connected.');
    console.log(DRY ? 'DRY RUN — no writes will be made\n' : 'APPLYING changes\n');

    const tenants = await Restaurant.find({}).select('_id name slug city contactPhone contactEmail owner').lean();
    console.log(`Scanning ${tenants.length} tenant(s).\n`);

    let created = 0;
    let skipped = 0;
    let failed = 0;
    let totalReassigned = 0;

    for (const t of tenants) {
        const hasMain = await Branch.exists({ restaurant: t._id, slug: 'main' });
        if (hasMain) {
            console.log(`= ${t.slug.padEnd(40)} — Main branch already exists, skipping`);
            skipped++;
            continue;
        }

        const totalBranches = await Branch.countDocuments({ restaurant: t._id });
        const hasSubBranches = totalBranches > 0;

        console.log(
            `+ ${t.slug.padEnd(40)} — ${hasSubBranches
                ? `${totalBranches} sub-branch(es) but no Main, creating Main…`
                : 'no branches, creating Main…'}`
        );
        if (DRY) {
            console.log(
                `    (would create Main branch${hasSubBranches ? '' : ' + reassign branch=null rows'})`
            );
            continue;
        }

        let mainBranch;
        try {
            mainBranch = await createMainBranchFor(t, t.owner || null);
            console.log(`    ✔ Created Main "${mainBranch.name}" (${mainBranch._id})`);
            created++;
        } catch (err) {
            console.error(`    ✗ FAILED: ${err.message}`);
            failed++;
            continue;
        }

        // Reassign legacy branch=null rows to the new Main branch ONLY
        // for greenfield tenants. When sub-branches already exist, the
        // operator likely already migrated null-branch rows into one of
        // those sub-branches — silently moving them to a brand-new Main
        // would scramble data ownership. Leave them alone in that case.
        if (!hasSubBranches) {
            for (const { name, Model } of NULL_REASSIGN_MODELS) {
                const filter = { restaurant: t._id, branch: null };
                const count = await Model.countDocuments(filter);
                if (count === 0) {
                    console.log(`    ${name.padEnd(10)}: 0 to reassign`);
                    continue;
                }
                const result = await Model.updateMany(filter, { $set: { branch: mainBranch._id } });
                totalReassigned += result.modifiedCount;
                console.log(`    ${name.padEnd(10)}: reassigned ${result.modifiedCount}`);
            }
        } else {
            console.log(`    (sub-branches present — null-branch rows left untouched)`);
        }
        console.log('');
    }

    console.log('—');
    console.log(`Created Main branches:  ${created}`);
    console.log(`Skipped (had Main):     ${skipped}`);
    console.log(`Failed:                 ${failed}`);
    console.log(`Rows reassigned:        ${totalReassigned}`);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('backfillMainBranch failed:', err);
    process.exit(1);
});
