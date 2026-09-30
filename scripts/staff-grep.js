/**
 * Wider lookup: regex-matches an email fragment OR a name fragment and
 * prints ALL User documents that match — useful when an exact-email
 * lookup says "free" but Mongo's unique-index still rejects an insert
 * (suggests a stale index entry, casing mismatch, or whitespace).
 *
 * Usage:
 *   node scripts/staff-grep.js <fragment>
 *
 * Example:
 *   node scripts/staff-grep.js durga
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Branch = require('../models/branch');

const [, , frag] = process.argv;
if (!frag) {
    console.error('Usage: node scripts/staff-grep.js <fragment>');
    process.exit(1);
}

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const re = new RegExp(frag, 'i');
    const users = await User.find({ $or: [{ email: re }, { name: re }, { staffId: re }] }).lean();
    console.log(`\nFound ${users.length} match(es) for /${frag}/i\n`);
    for (const u of users) {
        const branch = u.branch ? await Branch.findById(u.branch).select('name slug').lean() : null;
        console.log('  ─────────────────────────────────────────');
        console.log(`  _id            : ${u._id}`);
        console.log(`  email          : "${u.email}"  ${u.email !== (u.email || '').trim() ? '⚠ WHITESPACE' : ''}`);
        console.log(`  name           : ${u.name}`);
        console.log(`  role           : ${u.role}`);
        console.log(`  status         : ${u.status}`);
        console.log(`  staffId        : ${u.staffId || '—'}`);
        console.log(`  restaurant     : ${u.restaurant || '—'}`);
        console.log(`  branch         : ${branch ? `${branch.name} (${branch.slug})` : '— unpinned —'}`);
        console.log(`  createdAt      : ${u.createdAt?.toISOString?.() || '—'}`);
    }

    // Also list the index entries that match this fragment — bypasses
    // the soft-delete filter completely and shows truly orphaned keys.
    console.log('\nMongoDB index entries for users.email matching this fragment:');
    const col = mongoose.connection.collection('users');
    const indexed = await col.find({ email: re }).project({ _id: 1, email: 1, role: 1, status: 1, restaurant: 1 }).toArray();
    console.log(`  ${indexed.length} raw record(s) in the collection:`);
    for (const r of indexed) {
        console.log(`    _id=${r._id}  email="${r.email}"  role=${r.role}  status=${r.status}  rest=${r.restaurant}`);
    }

    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(99); });
