/**
 * seedFullCakes.js
 *
 * Seeds 8 popular cake flavours for the resolved tenant. The
 * customer-side AdvanceBooking → CakeDetails page calls
 * `GET /booking-info/cakes`, which under the hood returns
 * MenuItems whose category matches /cake|bakery/i AND that have
 * at least one entry in `sizes[]` (weight options like 500g / 1kg).
 *
 * So a cake row in the model is really:
 *   - a Category named "Cakes" (created if missing)
 *   - a MenuItem with category = that cake category, basePrice
 *     defaulting to the 500g price, and sizes[] for weight options.
 *
 * Idempotent — matches existing rows by (restaurant, name, category)
 * and skips anything already present, so re-running after admin
 * tweaks never overwrites manual edits.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullCakes.js
 *   TENANT_SLUG=<slug> node Seed/seedFullCakes.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

// ─────────────────────────────────────────────────────────────────────────────
// 8 popular cake flavours covering eggless + egg variants. Each ships
// with three weight options that match what most Indian bakeries
// quote: 500g, 1kg, 2kg. Prices are per-tenant defaults — admin can
// override any of these from the Menu admin tab afterwards.
// ─────────────────────────────────────────────────────────────────────────────
const CAKES = [
    {
        name: 'Black Forest',
        description: 'Classic chocolate sponge layered with cherries and whipped cream.',
        images: ['https://images.unsplash.com/photo-1571115177098-24ec42ed6d7d?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 500 },
            { name: '1kg',  price: 950 },
            { name: '2kg',  price: 1800 },
        ],
    },
    {
        name: 'Red Velvet',
        description: 'Rich red velvet sponge with cream cheese frosting.',
        images: ['https://images.unsplash.com/photo-1586788680434-30d324b2d46f?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 600 },
            { name: '1kg',  price: 1100 },
            { name: '2kg',  price: 2100 },
        ],
    },
    {
        name: 'Chocolate Truffle',
        description: 'Decadent dark chocolate truffle with a glossy ganache top.',
        images: ['https://images.unsplash.com/photo-1606890737304-57a1ca8a5b62?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'non-veg',
        sizes: [
            { name: '500g', price: 550 },
            { name: '1kg',  price: 1000 },
            { name: '2kg',  price: 1900 },
        ],
    },
    {
        name: 'Butterscotch',
        description: 'Buttery vanilla sponge studded with caramelised praline crunch.',
        images: ['https://images.unsplash.com/photo-1565958011703-44f9829ba187?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 480 },
            { name: '1kg',  price: 900 },
            { name: '2kg',  price: 1700 },
        ],
    },
    {
        name: 'Pineapple',
        description: 'Light vanilla sponge with fresh pineapple compote and cream.',
        images: ['https://images.unsplash.com/photo-1535254973040-607b474cb50d?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 450 },
            { name: '1kg',  price: 850 },
            { name: '2kg',  price: 1600 },
        ],
    },
    {
        name: 'Vanilla Strawberry',
        description: 'Vanilla bean sponge layered with fresh strawberries and cream.',
        images: ['https://images.unsplash.com/photo-1488477181946-6428a0291777?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 520 },
            { name: '1kg',  price: 980 },
            { name: '2kg',  price: 1850 },
        ],
    },
    {
        name: 'Choco Hazelnut',
        description: 'Belgian chocolate sponge with toasted hazelnut praline.',
        images: ['https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'non-veg',
        sizes: [
            { name: '500g', price: 650 },
            { name: '1kg',  price: 1200 },
            { name: '2kg',  price: 2300 },
        ],
    },
    {
        name: 'Mango Mousse',
        description: 'Light mango mousse cake — seasonal favourite for summer parties.',
        images: ['https://images.unsplash.com/photo-1565958011703-44f9829ba187?q=80&w=1200&auto=format&fit=crop'],
        vegType: 'veg',
        sizes: [
            { name: '500g', price: 580 },
            { name: '1kg',  price: 1080 },
            { name: '2kg',  price: 2050 },
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

// Ensures the "Cakes" category exists for this tenant. Returns the
// Category doc — the controller's regex (/cake|bakery/i) keys off the
// name field, so any name containing "cake" works; we use "Cakes".
async function ensureCakeCategory(tenant) {
    let cat = await Category.findOne({
        restaurant: tenant._id,
        name: { $regex: /^cakes$/i },
    });
    if (!cat) {
        cat = await Category.create({
            restaurant: tenant._id,
            name: 'Cakes',
            image: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=800&auto=format&fit=crop',
            status: 'active',
            displayOrder: 50,
        });
        console.log(`✔ Created Cakes category (${cat._id})`);
    }
    return cat;
}

async function ensureCakes(tenant, category) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const c of CAKES) {
        const existing = await MenuItem.findOne({
            restaurant: tenant._id,
            name: c.name,
            category: category._id,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            const basePrice = c.sizes[0].price;
            const offerPercentage = 0;
            const finalPrice = basePrice;
            await MenuItem.create({
                restaurant: tenant._id,
                name: c.name,
                description: c.description,
                images: c.images,
                category: category._id,
                vegType: c.vegType,
                basePrice,
                offerPercentage,
                finalPrice,
                sizes: c.sizes,
                status: 'active',
            });
            created += 1;
            const v = c.vegType === 'veg' ? 'V' : 'NV';
            console.log(`  + [${v}] ${c.name.padEnd(22)} ₹${c.sizes[0].price}/500g`);
        } catch (err) {
            failed.push({ name: c.name, error: err.message });
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

    const category = await ensureCakeCategory(tenant);
    console.log(`✔ Cake category: ${category.name}`);

    console.log(`\n⏳ Ensuring ${CAKES.length} cakes...`);
    const result = await ensureCakes(tenant, category);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.name}: ${f.error}`);
    }

    const total = await MenuItem.countDocuments({
        restaurant: tenant._id,
        category: category._id,
    });
    console.log(`\n📊 Total cakes for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullCakes failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
