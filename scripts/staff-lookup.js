/**
 * Read-only probe: looks up a staff user by email and prints their
 * full record + which branch (if any) they're pinned to. Used when
 * the UI says "A staff member with this email already exists" but
 * the admin thought they had deleted them.
 *
 * Usage (from Backend/):
 *   node scripts/staff-lookup.js <email>
 *
 * Example:
 *   node scripts/staff-lookup.js durga@gmail.com
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Branch = require('../models/branch');
const Restaurant = require('../models/restaurant');

const [, , emailArg] = process.argv;
if (!emailArg) {
    console.error('Usage: node scripts/staff-lookup.js <email>');
    process.exit(1);
}

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const email = emailArg.trim().toLowerCase();
    const users = await User.find({ email });

    if (users.length === 0) {
        console.log(`✓ No user found with email "${email}". This email is FREE to use.`);
        await mongoose.disconnect();
        return;
    }

    console.log(`\n✗ Found ${users.length} user(s) with email "${email}":\n`);
    for (const u of users) {
        const branch = u.branch ? await Branch.findById(u.branch).lean() : null;
        const rest   = u.restaurant ? await Restaurant.findById(u.restaurant).select('name slug').lean() : null;
        console.log('  ─────────────────────────────────────────');
        console.log(`  _id            : ${u._id}`);
        console.log(`  name           : ${u.name}`);
        console.log(`  email          : ${u.email}`);
        console.log(`  role           : ${u.role}`);
        console.log(`  status         : ${u.status}     ${u.status !== 'active' ? '← soft-deleted (record still exists)' : ''}`);
        console.log(`  staffId        : ${u.staffId || '—'}`);
        console.log(`  mobile         : ${u.mobile || '—'}`);
        console.log(`  restaurant     : ${rest ? `${rest.name} (${rest.slug})` : (u.restaurant || '—')}`);
        console.log(`  branch (pinned): ${branch ? `${branch.name} (${branch.slug})` : '— unpinned —'}`);
        console.log(`  createdAt      : ${u.createdAt?.toISOString?.() || '—'}`);
        console.log(`  updatedAt      : ${u.updatedAt?.toISOString?.() || '—'}`);
    }

    console.log('\n────────────────────────────────────────────');
    console.log('  Why this blocks creating a new staff member:');
    console.log('  Backend validateStaffEmail() rejects ANY existing User with this email,');
    console.log('  even if status="inactive". The email stays globally reserved.');
    console.log('');
    console.log('  Options:');
    console.log('   1. Hard-delete:  node scripts/staff-hard-delete.js ' + email);
    console.log('      (Frees the email completely. Use only if the person is genuinely gone.)');
    console.log('');
    console.log('   2. Reactivate + reassign: edit the existing record instead of creating new.');
    console.log('      Staff Management → find the inactive user → toggle status → reassign branch.');
    console.log('────────────────────────────────────────────\n');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('✗ Script failed:', err);
    process.exit(99);
});
