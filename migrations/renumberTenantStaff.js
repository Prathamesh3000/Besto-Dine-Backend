/**
 * renumberTenantStaff.js — one-shot fix for staff that inherited
 * staffIds from the legacy global EMP- sequence.
 *
 * Run this AFTER `dropLegacyIndexes.js` (which removes the global
 * `staffId_1` unique index and lets the per-tenant compound index
 * take over).
 *
 * What it does:
 *   1. For every Restaurant other than `default`, find every staff
 *      member whose staffId is set.
 *   2. Renumber them sequentially: EMP-001, EMP-002, ... ordered by
 *      createdAt.
 *   3. Skip the Default Restaurant entirely — its existing EMP-001..N
 *      sequence is correct and renumbering would invalidate any
 *      historical references.
 *
 * Usage:
 *
 *     cd Backend
 *     node migrations/renumberTenantStaff.js
 *
 * Idempotent — re-running it after staff are correctly numbered just
 * confirms each tenant starts at EMP-001.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Restaurant = require('../models/restaurant');
const User = require('../models/user');

const STAFF_ROLES = ['admin', 'waiter', 'captain', 'chef'];

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    // Find every tenant EXCEPT the legacy primary tenant
    // (originally seeded with slug='default', renamed to
    // 'the-coffee-house'). Its existing sequence is sacred —
    // historical orders, audit trails, tip settlements may reference it.
    const tenants = await Restaurant.find({ slug: { $ne: 'the-coffee-house' } }).sort({ createdAt: 1 });

    if (tenants.length === 0) {
        console.log('No non-default tenants found. Nothing to renumber.');
        await mongoose.disconnect();
        return;
    }

    let totalRenumbered = 0;

    for (const tenant of tenants) {
        const staff = await User.find({
            restaurant: tenant._id,
            role: { $in: STAFF_ROLES },
        }).sort({ createdAt: 1 });

        if (staff.length === 0) {
            console.log(`= ${tenant.name.padEnd(30)} (${tenant.slug}) — no staff to renumber`);
            continue;
        }

        // Two-pass renumbering to avoid duplicate-key collisions during
        // the rename. We first clear all staffIds in this tenant, then
        // assign the new sequence.
        await User.updateMany(
            { restaurant: tenant._id, role: { $in: STAFF_ROLES } },
            { $unset: { staffId: '' } }
        );

        let renamed = 0;
        for (let i = 0; i < staff.length; i++) {
            const newId = `EMP-${(i + 1).toString().padStart(3, '0')}`;
            await User.updateOne({ _id: staff[i]._id }, { $set: { staffId: newId } });
            renamed++;
        }

        console.log(`+ ${tenant.name.padEnd(30)} (${tenant.slug}) — renumbered ${renamed} staff to EMP-001..EMP-${renamed.toString().padStart(3, '0')}`);
        totalRenumbered += renamed;
    }

    console.log(`\n✔ Done. Total staff renumbered: ${totalRenumbered}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Renumber failed:', err);
    process.exit(1);
});
