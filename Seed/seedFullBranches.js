/**
 * seedFullBranches.js
 *
 * Seeds 5 realistic Pune branches for the resolved tenant. Targets the
 * proper Branch model (Phase 6 multi-branch foundation) — NOT the
 * legacy `Settings.branches` array used by the older seedBranches.js.
 *
 * Each branch ships with:
 *   - unique tenant-scoped slug for QR codes / deep links
 *   - flat address fields (addressLine1/2, city, state, postalCode, country)
 *   - branch-specific contact phone + email
 *   - sortOrder for the admin / customer picker
 *   - isActive flag (all start active)
 *
 * Idempotent — matches existing rows by (restaurant, slug) and skips
 * anything already present, so re-running after admin tweaks never
 * overwrites manual edits. Re-runs are safe.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullBranches.js
 *   TENANT_SLUG=<slug> node Seed/seedFullBranches.js
 *
 * Note: the `multiBranch` feature flag is enforced at the CONTROLLER
 * level, not the model. Direct DB writes (this seed) bypass that gate.
 * To surface the seeded branches in the admin UI / customer picker the
 * tenant's plan must include `multiBranch` (or a Super Admin override).
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');

// ─────────────────────────────────────────────────────────────────────────────
// 5 realistic Pune branches across the busiest food zones — FC Road,
// Baner, Viman Nagar, Koregaon Park, Hinjewadi. Slugs are kebab-case
// of the area for predictable QR / deep-link URLs.
// ─────────────────────────────────────────────────────────────────────────────
const BRANCHES = [
    {
        name: 'FC Road',
        slug: 'fc-road',
        addressLine1: '2nd Floor, Maple Plaza, FC Road',
        addressLine2: 'Shivajinagar',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411004',
        country: 'India',
        contactPhone: '+91 20 2553 1100',
        contactEmail: 'fcroad@hoteltiptop.in',
        sortOrder: 1,
        isActive: true,
    },
    {
        name: 'Baner',
        slug: 'baner',
        addressLine1: 'Prabhu Vertex, Near Balewadi High Street, Baner',
        addressLine2: 'Behind ICICI Bank',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411045',
        country: 'India',
        contactPhone: '+91 20 2729 4500',
        contactEmail: 'baner@hoteltiptop.in',
        sortOrder: 2,
        isActive: true,
    },
    {
        name: 'Viman Nagar',
        slug: 'viman-nagar',
        addressLine1: 'Ground Floor, Sky Vista, Near Phoenix Mall',
        addressLine2: 'Viman Nagar',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411014',
        country: 'India',
        contactPhone: '+91 20 2668 3200',
        contactEmail: 'vimannagar@hoteltiptop.in',
        sortOrder: 3,
        isActive: true,
    },
    {
        name: 'Koregaon Park',
        slug: 'koregaon-park',
        addressLine1: 'Lane 7, North Main Road, Koregaon Park',
        addressLine2: 'Opposite German Bakery',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        country: 'India',
        contactPhone: '+91 20 2615 7800',
        contactEmail: 'koregaonpark@hoteltiptop.in',
        sortOrder: 4,
        isActive: true,
    },
    {
        name: 'Hinjewadi',
        slug: 'hinjewadi',
        addressLine1: 'Phase 1, Rajiv Gandhi Infotech Park',
        addressLine2: 'Near Wipro Circle, Hinjewadi',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411057',
        country: 'India',
        contactPhone: '+91 20 4012 6700',
        contactEmail: 'hinjewadi@hoteltiptop.in',
        sortOrder: 5,
        isActive: true,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}"`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant document exists. Run seedDefaultTenant first.');
    return t;
}

async function ensureBranches(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const b of BRANCHES) {
        const existing = await Branch.findOne({
            restaurant: tenant._id,
            slug: b.slug,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Branch.create({
                ...b,
                restaurant: tenant._id,
            });
            created += 1;
            console.log(`  + [${b.slug.padEnd(15)}] ${b.name}  ·  ${b.city} ${b.postalCode}`);
        } catch (err) {
            failed.push({ name: b.name, error: err.message });
        }
    }
    return { created, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.MONGO_URL) {
        console.error('❌ MONGO_URL is not set. Add it to Backend/.env first.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    const tenant = await resolveTenant();
    console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

    console.log(`\n⏳ Ensuring ${BRANCHES.length} branches...`);
    const result = await ensureBranches(tenant);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.name}: ${f.error}`);
    }

    const total = await Branch.countDocuments({ restaurant: tenant._id });
    const active = await Branch.countDocuments({ restaurant: tenant._id, isActive: true });
    console.log(`\n📊 Total branches for tenant: ${total}  (active: ${active})`);

    if (!tenant.features?.multiBranch && !tenant.featureOverrides?.multiBranch) {
        console.log('\n⚠ Heads-up: tenant\'s plan does not include `multiBranch`.');
        console.log('  The branches were saved to the DB, but the admin UI / customer');
        console.log('  picker will not surface them until the plan is upgraded or a');
        console.log('  Super Admin sets featureOverrides.multiBranch = true.');
    }

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullBranches failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
