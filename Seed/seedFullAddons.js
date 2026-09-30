/**
 * seedFullAddons.js
 *
 * Seeds the 6 add-ons that the customer-side AdvanceBooking → AddOns
 * page knows how to render. The slugs below are LOAD-BEARING — they
 * must match the case statements in AddonDetailModal.jsx, otherwise
 * the customer modal falls back to a generic empty config and shows
 * no options:
 *
 *   slug          modal renderer
 *   ─────────     ─────────────────────────
 *   photographer  PhotographyContent  (single-select duration)
 *   dj            MusicContent        (single-select duration)
 *   photobooth    PhotoBoothContent   (duration + multi themes)
 *   live          LiveFoodContent     (multi-select stations)
 *   kids          KidsZoneContent     (multi-select activities)
 *   host          HostContent         (single-select duration)
 *
 * Idempotent — matches existing rows by (restaurant, slug) and skips
 * anything already present. The unique index on { slug, restaurant }
 * guards against duplicates if the seed is re-run.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullAddons.js
 *   TENANT_SLUG=<slug> node Seed/seedFullAddons.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Addon = require('../models/addon');

// ─────────────────────────────────────────────────────────────────────────────
// 6 add-ons covering the categories the customer modal supports.
// `slug` MUST match an AddonDetailModal case (see header).
// `icon` paths are relative to /Frontend/public — Vite serves them
// at the same path in production. SVGs from the existing public dir
// are reused so the seed doesn't introduce new asset dependencies.
// ─────────────────────────────────────────────────────────────────────────────
const ADDONS = [
    {
        title: 'Photography Coverage',
        slug: 'photographer',
        description: 'Professional photographer to capture every moment of your event.',
        price: 5000,
        icon: '/camera.svg',
        category: 'Media',
        options: [],
        isFeatured: true,
        isPopular: true,
    },
    {
        title: 'Music & DJ',
        slug: 'dj',
        description: 'Curated playlist + live DJ to keep your guests on the dance floor.',
        price: 3000,
        icon: '/music.svg',
        category: 'Entertainment',
        options: [],
        isPopular: true,
    },
    {
        title: 'Photo Booth',
        slug: 'photobooth',
        description: 'Themed photo booth with instant prints — capture the moments that matter.',
        price: 4000,
        icon: '/photobooth.png',
        category: 'Media',
        options: [],
        isPopular: true,
    },
    {
        title: 'Live Food Stations',
        slug: 'live',
        description: 'Interactive live counters — pasta, chaat, tandoor — prepared in front of your guests.',
        price: 10000,
        icon: '/fcounter.svg',
        category: 'Catering',
        options: [],
        isFeatured: true,
    },
    {
        title: 'Kids Entertainment Zone',
        slug: 'kids',
        description: 'Bouncy castle, face painting and arts & crafts — safe fun for little guests.',
        price: 8000,
        icon: '/kids.svg',
        category: 'Entertainment',
        options: [],
    },
    {
        title: 'Professional Event Host',
        slug: 'host',
        description: 'Anchor / emcee to run the show — introductions, games and event flow management.',
        price: 6000,
        icon: '/mike.svg',
        category: 'Service',
        options: [],
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

async function ensureAddons(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const a of ADDONS) {
        const existing = await Addon.findOne({
            restaurant: tenant._id,
            slug: a.slug,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Addon.create({
                ...a,
                restaurant: tenant._id,
                isActive: true,
            });
            created += 1;
            console.log(`  + [${a.slug.padEnd(13)}] ${a.title.padEnd(28)} ₹${a.price}`);
        } catch (err) {
            failed.push({ title: a.title, error: err.message });
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

    console.log(`\n⏳ Ensuring ${ADDONS.length} add-ons...`);
    const result = await ensureAddons(tenant);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.title}: ${f.error}`);
    }

    const total = await Addon.countDocuments({ restaurant: tenant._id });
    console.log(`\n📊 Total add-ons for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullAddons failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
