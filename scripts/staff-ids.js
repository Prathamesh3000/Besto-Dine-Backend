/**
 * List every staffId in the tenant grouped by branch. Used to diagnose
 * "A staff member with this email already exists" errors that turn out
 * to actually be staffId-collision errors masquerading as the email
 * dup-key catch in createBranchSubAdmin (both throw Mongo 11000).
 *
 * Usage:
 *   node scripts/staff-ids.js <restaurantSlug>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');

const [, , slug] = process.argv;
if (!slug) { console.error('Usage: node scripts/staff-ids.js <restaurantSlug>'); process.exit(1); }

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const restaurant = await Restaurant.findOne({ slug });
    if (!restaurant) { console.error(`No restaurant with slug "${slug}"`); process.exit(2); }
    const users = await User.find({ restaurant: restaurant._id }).lean();
    const branches = await Branch.find({ restaurant: restaurant._id }).lean();
    const branchById = new Map(branches.map(b => [String(b._id), b]));

    console.log(`\nTenant: ${restaurant.name} (${restaurant.slug})  · ${users.length} staff total\n`);

    // Group by (staffId, branch) — the per-branch unique index allows
    // EMP-001 to legitimately exist in every branch, so only same-branch
    // duplicates are real collisions.
    const byBucket = new Map();
    for (const u of users) {
        const branchKey = u.branch ? String(u.branch) : '__unpinned__';
        const k = `${u.staffId || '(none)'}|${branchKey}`;
        if (!byBucket.has(k)) byBucket.set(k, []);
        byBucket.get(k).push(u);
    }

    console.log('  staffId        branch              count  users');
    console.log('  ──────────────────────────────────────────────────────────────');
    const sortedKeys = Array.from(byBucket.keys()).sort();
    for (const k of sortedKeys) {
        const list = byBucket.get(k);
        const dup = list.length > 1 ? '  ⚠ COLLISION (same branch)' : '';
        for (const u of list) {
            const b = u.branch ? branchById.get(String(u.branch)) : null;
            const branchLabel = b ? b.slug : 'unpinned';
            console.log(`  ${(u.staffId || '(none)').padEnd(13)}  ${branchLabel.padEnd(18)}  ${list.length}      ${u.name || '—'}  ·  ${u.email}  ·  ${u.role}${dup}`);
        }
    }

    // Next-up calculation per branch — matches the per-branch generator.
    console.log('\nPer-branch next staffId:');
    const branchScopes = [
        ...branches.map(b => ({ id: b._id, label: `${b.name} (${b.slug})` })),
        { id: null, label: 'tenant-level (unpinned)' },
    ];
    for (const scope of branchScopes) {
        const lastStaff = await User.findOne({
            staffId: /^EMP-/,
            restaurant: restaurant._id,
            branch: scope.id,
        }).sort({ staffId: -1 });
        let nextNum = 1;
        if (lastStaff && lastStaff.staffId) {
            nextNum = parseInt(lastStaff.staffId.split('-')[1]) + 1;
        }
        const candidate = `EMP-${nextNum.toString().padStart(3, '0')}`;
        const collision = await User.findOne({
            staffId: candidate,
            restaurant: restaurant._id,
            branch: scope.id,
        });
        const flag = collision
            ? `  ⚠ ${candidate} ALREADY EXISTS in this branch (orphan record?)`
            : '  ✓ safe to assign';
        console.log(`  ${scope.label.padEnd(34)} next = ${candidate}${flag}`);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(99); });
