/**
 * seedFullPackages.js
 *
 * Seeds the 10 most-common combo packages an Indian cafe / restaurant /
 * banquet hall offers, each with:
 *   - realistic Pune mid-range pricing
 *   - starters / mainCourse / drinks lists pulled from authentic Indian
 *     menus so the package detail panel is meaningful out of the box
 *   - features (Wi-Fi, setup, DJ, etc.) per package's intended use
 *   - badge + badgeColor (tailwind classes — schema's existing format)
 *   - sensible min / max people for each tier
 *
 * Idempotent — matches existing rows by (restaurant, name) and skips
 * anything already present, so re-running after the admin has tweaked
 * a package from the UI never overwrites their changes.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullPackages.js
 *   TENANT_SLUG=<slug> node Seed/seedFullPackages.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Package = require('../models/package');

// Helper — wraps plain strings in {name} since the schema's starters /
// mainCourse / drinks are sub-document arrays of {name: String}.
const m = (...names) => names.map(name => ({ name }));

// ─────────────────────────────────────────────────────────────────────────────
// 10 most-common combo packages, ordered cheap → premium per veg / non-veg
// track, then specialised packages last.
// ─────────────────────────────────────────────────────────────────────────────
const PACKAGES = [
    // ── Silver Veg ──────────────────────────────────────────────────────
    {
        name: 'Silver Veg Combo',
        price: 299,
        description: 'Budget-friendly pure-veg combo for casual gatherings — 2 starters, 3 main-course, 1 dessert and a soft drink per person.',
        category: 'Classic',
        badge: 'Silver',
        badgeColor: 'bg-gray-100 text-gray-700',
        minPeople: 10,
        maxPeople: 50,
        starters: m('Veg Manchurian Dry', 'Hara Bhara Kebab'),
        mainCourse: m('Paneer Butter Masala', 'Dal Tadka', 'Jeera Rice', 'Tandoori Roti'),
        drinks: m('Soft Drink (300 ml)', 'Mineral Water (500 ml)'),
        features: ['Pure Veg', 'Buffet Setup', 'Disposables Included'],
    },

    // ── Gold Veg ────────────────────────────────────────────────────────
    {
        name: 'Gold Veg Combo',
        price: 499,
        description: 'Mid-tier pure-veg combo with extra variety — 3 starters, 4 main-course, 2 desserts and a mocktail per person.',
        category: 'Gold',
        badge: 'Gold',
        badgeColor: 'bg-amber-100 text-amber-700',
        minPeople: 20,
        maxPeople: 100,
        starters: m('Paneer Tikka', 'Veg Spring Roll', 'Crispy Corn'),
        mainCourse: m('Shahi Paneer', 'Dal Makhani', 'Veg Biryani', 'Butter Naan', 'Mixed Vegetable'),
        drinks: m('Fresh Lime Soda', 'Cold Coffee', 'Mineral Water'),
        features: ['Pure Veg', 'Buffet Setup', 'Live Counter (1)', 'Welcome Drink'],
    },

    // ── Platinum Veg ────────────────────────────────────────────────────
    {
        name: 'Platinum Veg Combo',
        price: 799,
        description: 'Premium pure-veg combo with full variety — 5 starters, 6 main-course, 3 desserts, mocktails and live counters.',
        category: 'Royal',
        badge: 'Platinum',
        badgeColor: 'bg-slate-100 text-slate-700',
        minPeople: 30,
        maxPeople: 200,
        starters: m('Paneer Tikka', 'Hara Bhara Kebab', 'Veg Manchurian', 'Honey Chilli Potato', 'Mushroom Tikka'),
        mainCourse: m('Paneer Butter Masala', 'Shahi Paneer', 'Dal Makhani', 'Hyderabadi Veg Biryani', 'Garlic Naan', 'Tandoori Roti'),
        drinks: m('Virgin Mojito', 'Mango Mocktail', 'Fresh Juice', 'Mineral Water'),
        features: ['Pure Veg', 'Buffet + Live Counters (2)', 'Welcome Drink', 'Decorated Tables', 'Soft Music'],
    },

    // ── Silver Non-Veg ──────────────────────────────────────────────────
    {
        name: 'Silver Non-Veg Combo',
        price: 399,
        description: 'Budget non-veg combo — 2 non-veg starters, 3 main-course (mix of veg + non-veg), 1 dessert and a soft drink per person.',
        category: 'Classic',
        badge: 'Silver',
        badgeColor: 'bg-gray-100 text-gray-700',
        minPeople: 10,
        maxPeople: 50,
        starters: m('Chicken Tikka', 'Chicken Lollipop'),
        mainCourse: m('Butter Chicken', 'Dal Fry', 'Jeera Rice', 'Butter Naan'),
        drinks: m('Soft Drink (300 ml)', 'Mineral Water (500 ml)'),
        features: ['Veg + Non-Veg', 'Buffet Setup', 'Disposables Included'],
    },

    // ── Gold Non-Veg ────────────────────────────────────────────────────
    {
        name: 'Gold Non-Veg Combo',
        price: 699,
        description: 'Mid-tier non-veg combo — 3 non-veg starters, 4 main-course, 2 desserts and mocktails per person.',
        category: 'Gold',
        badge: 'Gold',
        badgeColor: 'bg-amber-100 text-amber-700',
        minPeople: 20,
        maxPeople: 100,
        starters: m('Chicken Tikka', 'Fish Tikka', 'Chilli Chicken'),
        mainCourse: m('Butter Chicken', 'Chicken Curry', 'Hyderabadi Chicken Biryani', 'Butter Naan', 'Dal Tadka'),
        drinks: m('Fresh Lime Soda', 'Cold Coffee', 'Mineral Water'),
        features: ['Veg + Non-Veg', 'Buffet Setup', 'Live Counter (1)', 'Welcome Drink'],
    },

    // ── Royal Non-Veg ───────────────────────────────────────────────────
    {
        name: 'Royal Non-Veg Combo',
        price: 999,
        description: 'Premium non-veg combo with mutton & seafood — 5 starters, 6 main-course, 3 desserts, mocktails and live counters.',
        category: 'Royal',
        badge: 'Royal',
        badgeColor: 'bg-purple-100 text-purple-700',
        minPeople: 30,
        maxPeople: 250,
        starters: m('Tandoori Chicken', 'Fish Tikka', 'Chicken Lollipop', 'Mutton Seekh Kebab', 'Paneer Tikka'),
        mainCourse: m('Butter Chicken', 'Mutton Rogan Josh', 'Fish Curry', 'Hyderabadi Chicken Biryani', 'Garlic Naan', 'Dal Makhani'),
        drinks: m('Virgin Mojito', 'Mango Mocktail', 'Fresh Juice', 'Mineral Water'),
        features: ['Veg + Non-Veg', 'Buffet + Live Counters (2)', 'Welcome Drink', 'Decorated Tables', 'Soft Music'],
    },

    // ── Birthday Bash ───────────────────────────────────────────────────
    {
        name: 'Birthday Bash Combo',
        price: 599,
        description: 'Kid-friendly birthday combo with cake, decoration and a balanced veg menu — perfect for birthday parties up to 80 guests.',
        category: 'Classic',
        badge: 'Special',
        badgeColor: 'bg-pink-100 text-pink-700',
        minPeople: 15,
        maxPeople: 80,
        starters: m('Veg Spring Roll', 'Crispy Corn', 'Cheese Balls'),
        mainCourse: m('Pasta in Red Sauce', 'Veg Hakka Noodles', 'Schezwan Fried Rice', 'Margherita Pizza'),
        drinks: m('Strawberry Milkshake', 'Chocolate Milkshake', 'Soft Drinks'),
        features: ['Pure Veg', '1 kg Cake Included', 'Birthday Decoration', 'Return Gifts (Optional)', 'Music System'],
    },

    // ── Corporate Lunch ─────────────────────────────────────────────────
    {
        name: 'Corporate Lunch Combo',
        price: 399,
        description: 'Working-lunch combo for offices and conferences — quick service, balanced veg menu, mineral water and tea / coffee.',
        category: 'Classic',
        badge: 'Business',
        badgeColor: 'bg-blue-100 text-blue-700',
        minPeople: 20,
        maxPeople: 150,
        starters: m('Hara Bhara Kebab', 'Veg Manchurian Dry'),
        mainCourse: m('Paneer Butter Masala', 'Dal Fry', 'Veg Pulao', 'Tandoori Roti', 'Curd / Salad'),
        drinks: m('Tea / Coffee', 'Mineral Water (500 ml)'),
        features: ['Pure Veg', 'Quick Service', 'Wi-Fi Included', 'Projector / AV on request', 'Disposables Included'],
    },

    // ── High Tea ────────────────────────────────────────────────────────
    {
        name: 'High Tea Combo',
        price: 349,
        description: 'High-tea combo for kitty parties and ladies meets — assorted savouries, sweets and a tea / coffee selection.',
        category: 'Classic',
        badge: 'Casual',
        badgeColor: 'bg-emerald-100 text-emerald-700',
        minPeople: 8,
        maxPeople: 40,
        starters: m('Veg Sandwich', 'Cheese Chilli Toast', 'Pakora Platter', 'Samosa'),
        mainCourse: m('Pav Bhaji', 'Mini Dosa Platter'),
        drinks: m('Masala Chai', 'Filter Coffee', 'Green Tea', 'Cold Coffee'),
        features: ['Pure Veg', 'Theme Decor (Optional)', 'Background Music', 'Buffet Setup'],
    },

    // ── Wedding Grand ───────────────────────────────────────────────────
    {
        name: 'Wedding Grand Combo',
        price: 1499,
        description: 'Top-tier wedding reception combo — full multi-cuisine spread with starters, mains, live counters, desserts, mocktails and stage decoration.',
        category: 'Elite',
        badge: 'Elite',
        badgeColor: 'bg-indigo-100 text-indigo-700',
        minPeople: 100,
        maxPeople: 500,
        starters: m('Paneer Tikka', 'Tandoori Chicken', 'Fish Tikka', 'Mutton Seekh Kebab', 'Veg Spring Roll', 'Chilli Chicken'),
        mainCourse: m('Paneer Butter Masala', 'Butter Chicken', 'Mutton Rogan Josh', 'Hyderabadi Chicken Biryani', 'Veg Biryani', 'Dal Makhani', 'Assorted Naan'),
        drinks: m('Welcome Mocktail', 'Virgin Mojito', 'Fresh Juice', 'Soft Drinks', 'Mineral Water'),
        features: [
            'Veg + Non-Veg',
            'Stage Decoration',
            'Live Counters (3)',
            'Welcome Drink',
            'Wedding-Theme Setup',
            'Sound + Lighting',
        ],
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

async function ensurePackages(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const pkg of PACKAGES) {
        const existing = await Package.findOne({
            restaurant: tenant._id,
            name: pkg.name,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Package.create({
                ...pkg,
                restaurant: tenant._id,
                isActive: true,
            });
            created += 1;
            console.log(`  + [${pkg.badge.padEnd(8)}] ${pkg.name}  ₹${pkg.price}/pp  (${pkg.minPeople}-${pkg.maxPeople} ppl)`);
        } catch (err) {
            failed.push({ name: pkg.name, error: err.message });
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

    console.log(`\n⏳ Ensuring ${PACKAGES.length} combo packages...`);
    const result = await ensurePackages(tenant);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.name}: ${f.error}`);
    }

    const total = await Package.countDocuments({ restaurant: tenant._id });
    console.log(`\n📊 Total packages for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullPackages failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
