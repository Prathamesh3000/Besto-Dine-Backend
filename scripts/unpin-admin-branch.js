/**
 * One-off: un-pin an `admin` user from a branch so they regain
 * cross-branch (global) access. The StaffDashboard relabels them from
 * "Branch Admin" → "Admin" automatically once `user.branch` is null.
 *
 * Usage (from Backend/):
 *   node scripts/unpin-admin-branch.js <email>
 *
 * Example:
 *   node scripts/unpin-admin-branch.js rohitbansode1600@gmail.com
 *
 * Safe to run on production:
 *   - Touches exactly ONE user document, matched by exact email
 *   - Only proceeds if the user already has role='admin' (refuses to
 *     un-pin a waiter / chef / captain — those need a branch)
 *   - Logs the before/after diff so you have an audit trail
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

const [, , emailArg] = process.argv;

if (!emailArg) {
    console.error('Usage: node scripts/unpin-admin-branch.js <email>');
    process.exit(1);
}

(async () => {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log(`✓ Connected to MongoDB`);

    const email = emailArg.trim().toLowerCase();
    const user = await User.findOne({ email }).select('+branch');
    if (!user) {
        console.error(`✗ No user found with email "${email}"`);
        await mongoose.disconnect();
        process.exit(2);
    }

    console.log('\nBefore:');
    console.log({
        _id:    user._id.toString(),
        name:   user.name,
        email:  user.email,
        role:   user.role,
        branch: user.branch ? user.branch.toString() : null,
    });

    if (user.role !== 'admin') {
        console.error(`\n✗ Refusing to un-pin a "${user.role}" — only admin role can run cross-branch.`);
        console.error('   Non-admin roles need a branch assignment to function.');
        await mongoose.disconnect();
        process.exit(3);
    }

    if (!user.branch) {
        console.log('\n→ User already has no branch pinned. Nothing to do.');
        await mongoose.disconnect();
        return;
    }

    user.branch = undefined;
    await user.save();

    console.log('\nAfter:');
    console.log({
        _id:    user._id.toString(),
        name:   user.name,
        email:  user.email,
        role:   user.role,
        branch: user.branch || null,
    });
    console.log('\n✓ Branch un-pinned. Reload Staff Management and the role should now show "Admin".');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('✗ Script failed:', err);
    process.exit(99);
});
