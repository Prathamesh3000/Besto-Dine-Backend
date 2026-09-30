/**
 * Print a snapshot of one tenant: restaurant doc, subscription, branches,
 * staff counts. Read-only — safe on production. Useful for support /
 * audit ("what does this tenant look like right now?").
 *
 * Usage (from Backend/):
 *   node scripts/tenant-info.js <ownerEmail|tenantSlug>
 *
 * Example:
 *   node scripts/tenant-info.js rohitbansode1600@gmail.com
 *   node scripts/tenant-info.js hotel-tip-top
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const User = require('../models/user');

const [, , identifier] = process.argv;
if (!identifier) {
    console.error('Usage: node scripts/tenant-info.js <ownerEmail|tenantSlug>');
    process.exit(1);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const dash = (n = 76) => '─'.repeat(n);

(async () => {
    const uri = process.env.MONGO_URL;
    if (!uri) { console.error('MONGO_URL not set in .env'); process.exit(1); }

    await mongoose.connect(uri);

    // Look up either by owner email or by tenant slug.
    let restaurant = null;
    if (identifier.includes('@')) {
        const user = await User.findOne({ email: identifier.trim().toLowerCase() });
        if (!user) { console.error(`✗ No user with email "${identifier}"`); await mongoose.disconnect(); process.exit(2); }
        restaurant = await Restaurant.findById(user.restaurant);
    } else {
        restaurant = await Restaurant.findOne({ slug: identifier.trim().toLowerCase() });
    }
    if (!restaurant) { console.error(`✗ Tenant not found`); await mongoose.disconnect(); process.exit(2); }

    const r = restaurant.toObject();
    console.log('\n' + dash());
    console.log('  RESTAURANT (tenant)');
    console.log(dash());
    console.log(`  _id              : ${r._id}`);
    console.log(`  name             : ${r.name}`);
    console.log(`  slug             : ${r.slug}`);
    console.log(`  contactEmail     : ${r.contactEmail || '—'}`);
    console.log(`  contactPhone     : ${r.contactPhone || '—'}`);
    console.log(`  city             : ${r.city || '—'}`);
    console.log(`  state            : ${r.state || '—'}`);
    console.log(`  country          : ${r.country || '—'}`);
    console.log(`  legalBusinessName: ${r.legalBusinessName || '—'}`);
    console.log(`  gstin            : ${r.gstin || '—'}`);
    console.log(`  pan              : ${r.pan || '—'}`);
    console.log(`  fssaiLicense     : ${r.fssaiLicense || '—'}`);
    console.log(`  status           : ${r.status || '—'}`);
    console.log(`  owner            : ${r.owner || '—'}`);
    console.log(`  createdAt        : ${r.createdAt?.toISOString?.() || '—'}`);

    if (r.subscription) {
        console.log('\n  SUBSCRIPTION');
        console.log(`  ${pad('plan name', 20)} : ${r.subscription.planName || '—'}`);
        console.log(`  ${pad('plan slug', 20)} : ${r.subscription.planSlug || '—'}`);
        console.log(`  ${pad('status', 20)} : ${r.subscription.status || '—'}`);
        console.log(`  ${pad('currentPeriodEnd', 20)} : ${r.subscription.currentPeriodEnd?.toISOString?.() || '—'}`);
        console.log(`  ${pad('trialEndsAt', 20)} : ${r.subscription.trialEndsAt?.toISOString?.() || '—'}`);
        console.log(`  ${pad('razorpaySubId', 20)} : ${r.subscription.razorpaySubscriptionId || '—'}`);
    }

    // ── Branches ─────────────────────────────────────────────────────
    const branches = await Branch.find({ restaurant: r._id }).sort({ slug: 1, name: 1 }).lean();
    console.log('\n' + dash());
    console.log(`  BRANCHES (${branches.length})`);
    console.log(dash());
    console.log(`  ${pad('slug', 22)}  ${pad('name', 28)}  ${pad('city', 14)}  active`);
    branches.forEach(b => {
        console.log(`  ${pad(b.slug, 22)}  ${pad(b.name, 28)}  ${pad(b.city, 14)}  ${b.isActive ? '✓' : '✗'}`);
    });

    // ── Staff ────────────────────────────────────────────────────────
    const users = await User.find({ restaurant: r._id }).lean();
    const byRole = users.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {});
    const branchById = new Map(branches.map(b => [String(b._id), b]));
    const pinned = users.filter(u => u.branch).length;
    const unpinned = users.filter(u => !u.branch).length;

    console.log('\n' + dash());
    console.log(`  STAFF (${users.length})`);
    console.log(dash());
    console.log(`  by role         : ${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`);
    console.log(`  pinned to branch: ${pinned}`);
    console.log(`  unpinned        : ${unpinned}  (these have cross-branch access)`);
    console.log('');
    console.log(`  ${pad('name', 22)}  ${pad('role', 10)}  ${pad('email', 32)}  branch`);
    users.forEach(u => {
        const b = u.branch ? branchById.get(String(u.branch)) : null;
        console.log(`  ${pad(u.name || '—', 22)}  ${pad(u.role, 10)}  ${pad(u.email || '—', 32)}  ${b ? b.slug : '—'}`);
    });

    console.log('\n' + dash() + '\n');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('✗ Script failed:', err);
    process.exit(99);
});
