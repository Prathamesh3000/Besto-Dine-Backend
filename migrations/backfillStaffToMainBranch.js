/**
 * backfillStaffToMainBranch.js
 *
 * One-shot fix for staff who landed with `branch: null` because they
 * were created BEFORE the tenant added any branches. Once branches
 * exist, the Staff Management UI groups by branch and these legacy
 * users fall into an "Unassigned" bucket forever — even though they
 * were really meant to belong to the tenant's primary location.
 *
 * Companion to migrateLegacyBranchNulls.js, which intentionally
 * EXCLUDED the User collection (admins should stay unpinned). This
 * script handles the non-admin half: waiter / captain / chef / manager.
 *
 * Resolution order for "main branch" matches utils/mainBranch.js:
 *   1. The branch with slug === 'main' (auto-Main marker).
 *   2. Fallback: the oldest active branch for the tenant.
 *
 * Admin role is intentionally skipped — per utils/createMainBranch.js,
 * the tenant owner stays `branch: null` so they can manage every
 * branch including Main. Sub Admins are already pinned at creation
 * time by branchController.createBranch, so they won't match the
 * `branch: null` filter anyway.
 *
 * Tenants without any branches are skipped — null is still meaningful
 * there (single-location install, no multi-branch yet).
 *
 * Usage:
 *   cd Backend && node migrations/backfillStaffToMainBranch.js          # apply
 *   cd Backend && node migrations/backfillStaffToMainBranch.js --dry    # preview only
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Restaurant = require('../models/restaurant');
const Branch     = require('../models/branch');
const User       = require('../models/user');

const DRY = process.argv.includes('--dry');

// Roles that must be pinned to a branch when branches exist.
// `admin` is excluded by design (tenant owner stays unpinned).
const PINNABLE_ROLES = ['waiter', 'captain', 'chef', 'manager'];

async function backfill() {
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
        // Prefer the slug='main' branch; fall back to oldest active.
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
            summary.push({ tenant: t.name, mainBranch: '—', migrated: 0, kept: 0 });
            continue;
        }

        console.log(`▶ Tenant "${t.name}" → main: "${mainBranch.name}" (${resolvedVia})`);

        // Pinnable staff with branch:null get migrated.
        const pinnableFilter = {
            restaurant: t._id,
            branch: null,
            role: { $in: PINNABLE_ROLES },
        };
        const pinnableDocs = await User.find(pinnableFilter)
            .select('_id name email role')
            .lean();

        // Admins with branch:null stay unpinned — log them for visibility
        // so the operator can sanity-check the design intent.
        const adminUnpinnedCount = await User.countDocuments({
            restaurant: t._id,
            branch: null,
            role: 'admin',
        });

        if (pinnableDocs.length === 0) {
            console.log(`    pinnable staff with branch:null  → 0`);
        } else {
            console.log(`    pinnable staff with branch:null  → ${pinnableDocs.length}`);
            for (const u of pinnableDocs) {
                console.log(`      · ${(u.role || '').padEnd(7)} ${u.name} <${u.email}>`);
            }
            if (!DRY) {
                const r = await User.updateMany(
                    pinnableFilter,
                    { $set: { branch: mainBranch._id } }
                );
                console.log(`    ✓ migrated ${r.modifiedCount}`);
            } else {
                console.log(`    would migrate ${pinnableDocs.length}`);
            }
        }

        if (adminUnpinnedCount > 0) {
            console.log(`    admin(s) kept unpinned (by design): ${adminUnpinnedCount}`);
        }

        summary.push({
            tenant: t.name,
            mainBranch: mainBranch.name,
            migrated: pinnableDocs.length,
            kept: adminUnpinnedCount,
        });
        console.log();
    }

    console.log('━'.repeat(70));
    console.log('SUMMARY');
    console.log('━'.repeat(70));
    for (const s of summary) {
        console.log(
            `  ${s.tenant.padEnd(30)} main: ${String(s.mainBranch).padEnd(20)}` +
            ` migrated=${s.migrated} admin-kept=${s.kept}`
        );
    }
    if (DRY) console.log('\n🔍 DRY RUN — re-run without --dry to apply.');

    await mongoose.disconnect();
}

backfill().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
