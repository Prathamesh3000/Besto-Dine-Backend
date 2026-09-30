/**
 * renumberStaffPerBranch.js — one-shot fix to give every BRANCH its
 * own EMP-001..EMP-N sequence.
 *
 * Why this exists:
 *   - The DB index on `users` was tightened to
 *     `{ staffId, restaurant, branch }` (per-branch unique), but the
 *     ID generator was still querying tenant-wide for the next
 *     EMP-NNN. Effect: branches started numbering wherever the
 *     tenant-wide max was sitting (e.g. FC Road 2's first hire got
 *     EMP-007 because Main had reached EMP-006), and same-branch
 *     duplicates slipped in whenever the generator's existence
 *     check raced or the per-branch index never finished building.
 *
 * What this script does, per tenant:
 *   1. Verifies the `staffId_per_branch_unique` index exists. If it
 *      doesn't, builds it (mongoose normally does this on boot, but
 *      that only fires when the schema file is reloaded).
 *   2. Reports any (tenant, branch) bucket that currently has
 *      duplicate EMP-IDs so an operator can see the damage before
 *      it's healed.
 *   3. Renumbers each (tenant, branch) bucket sequentially by
 *      createdAt: branch A → EMP-001..EMP-N, branch B → EMP-001..EMP-M,
 *      tenant-level (branch=null) → EMP-001..EMP-K.
 *
 * Two-pass per bucket (unset then assign) so the rename can't
 * collide with itself.
 *
 * The Default Restaurant ('the-coffee-house') is skipped — its
 * historical sequence is referenced by old orders / tips / payslips.
 *
 * Run from the Backend directory:
 *
 *     node migrations/renumberStaffPerBranch.js
 *
 * Idempotent — re-running after the data is clean is a no-op
 * beyond confirming each bucket already starts at EMP-001.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const User = require('../models/user');

const STAFF_ROLES = ['admin', 'manager', 'waiter', 'captain', 'chef'];
const STAFF_INDEX_NAME = 'staffId_per_branch_unique';

async function ensurePerBranchIndex(db) {
    const indexes = await db.collection('users').indexes();
    const present = indexes.find(i => i.name === STAFF_INDEX_NAME);
    if (present) {
        console.log(`= users.${STAFF_INDEX_NAME} already present`);
        return;
    }
    console.log(`+ users.${STAFF_INDEX_NAME} missing — building now`);
    await db.collection('users').createIndex(
        { staffId: 1, restaurant: 1, branch: 1 },
        {
            name: STAFF_INDEX_NAME,
            unique: true,
            partialFilterExpression: { staffId: { $type: 'string' } },
        }
    );
    console.log(`  built`);
}

function bucketKey(staff) {
    return staff.branch ? String(staff.branch) : '__tenant-level__';
}

async function renumberTenant(tenant) {
    const staff = await User.find({
        restaurant: tenant._id,
        role: { $in: STAFF_ROLES },
    }).sort({ branch: 1, createdAt: 1 });

    if (staff.length === 0) {
        console.log(`= ${tenant.name.padEnd(30)} (${tenant.slug}) — no staff`);
        return 0;
    }

    const buckets = new Map();
    for (const s of staff) {
        const key = bucketKey(s);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(s);
    }

    const branchNames = new Map();
    const branchDocs = await Branch.find({ restaurant: tenant._id }).select('_id name slug').lean();
    for (const b of branchDocs) branchNames.set(String(b._id), `${b.name} (${b.slug})`);

    let totalRenamed = 0;
    let duplicatesFound = 0;

    for (const [key, members] of buckets.entries()) {
        const label = key === '__tenant-level__' ? 'tenant-level (no branch)' : (branchNames.get(key) || `branch ${key}`);

        const idCount = new Map();
        for (const m of members) {
            if (!m.staffId) continue;
            idCount.set(m.staffId, (idCount.get(m.staffId) || 0) + 1);
        }
        for (const [id, n] of idCount.entries()) {
            if (n > 1) {
                duplicatesFound += n;
                console.log(`  ! ${label}: ${id} appears ${n} times — will be renumbered`);
            }
        }

        await User.updateMany(
            { _id: { $in: members.map(m => m._id) } },
            { $unset: { staffId: '' } }
        );

        for (let i = 0; i < members.length; i++) {
            const newId = `EMP-${(i + 1).toString().padStart(3, '0')}`;
            await User.updateOne({ _id: members[i]._id }, { $set: { staffId: newId } });
        }

        console.log(`  + ${label.padEnd(40)} → ${members.length} staff renumbered EMP-001..EMP-${members.length.toString().padStart(3, '0')}`);
        totalRenamed += members.length;
    }

    console.log(`  Σ ${tenant.name} — ${totalRenamed} staff renumbered across ${buckets.size} bucket(s)${duplicatesFound ? `, ${duplicatesFound} duplicate row(s) healed` : ''}`);
    return totalRenamed;
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    const db = mongoose.connection.db;

    console.log('— Verifying per-branch unique index —');
    await ensurePerBranchIndex(db);
    console.log('');

    console.log('— Renumbering staff per (tenant, branch) —');
    const tenants = await Restaurant.find({ slug: { $ne: 'the-coffee-house' } }).sort({ createdAt: 1 });
    if (tenants.length === 0) {
        console.log('No non-default tenants found.');
        await mongoose.disconnect();
        return;
    }

    let grandTotal = 0;
    for (const tenant of tenants) {
        const n = await renumberTenant(tenant);
        grandTotal += n;
    }

    console.log(`\n✔ Done. Total staff renumbered: ${grandTotal}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
