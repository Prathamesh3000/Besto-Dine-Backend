/**
 * seedFullCategories.js
 *
 * Adds the 24 most commonly used menu categories for an Indian
 * cafe / restaurant — single dishes, combos, and packaged beverages —
 * with curated Unsplash hero images per category.
 *
 * Tenant resolution mirrors seedMenuItems.js / seedAreaTables.js:
 *   TENANT_SLUG=<slug> node Seed/seedFullCategories.js
 *   # default = first Restaurant doc by createdAt
 *
 * Idempotent: categories whose `name` already exists for this tenant
 * are skipped (per-tenant unique index on `name + restaurant`). Safe to
 * re-run after the menu has been edited from the Admin UI — nothing
 * gets deleted or overwritten.
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Category = require('../models/category');

// Unsplash hero photo per category. Pulled from the existing
// seedCategories.js where they overlap (those have been verified
// working for months) and curated for the new categories. The Category
// model has a default placeholder image, so a 404 on any single URL
// just falls back gracefully — categories don't break.
const CATEGORIES = [
    // Single Dish — savoury
    { name: 'Starters',          image: 'https://images.unsplash.com/photo-1600891964599-f61ba0e24092' },
    { name: 'Soups',             image: 'https://images.unsplash.com/photo-1547592180-85f173990554' },
    { name: 'South Indian',      image: 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976' },
    { name: 'North Indian',      image: 'https://images.unsplash.com/photo-1601050690597-df0568f70950' },
    { name: 'Breads',            image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38' },
    { name: 'Rice & Biryani',    image: 'https://images.unsplash.com/photo-1633945274405-b6c8069047b0' },
    { name: 'Chinese',           image: 'https://images.unsplash.com/photo-1585032226651-759b368d7246' },
    { name: 'Noodles',           image: 'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841' },
    { name: 'Pizza',             image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591' },
    { name: 'Burgers',           image: 'https://images.unsplash.com/photo-1550547660-d9450f859349' },
    { name: 'Sandwiches',        image: 'https://images.unsplash.com/photo-1553909489-cd47e0907980' },
    { name: 'Wraps & Rolls',     image: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086' },
    { name: 'Pasta',             image: 'https://images.unsplash.com/photo-1525755662778-989d0524087e' },
    { name: 'Salads',            image: 'https://images.unsplash.com/photo-1546793665-c74683f339c1' },
    { name: 'Healthy Food',      image: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061' },

    // Combos / Thali
    { name: 'Combos & Thali',    image: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe' },

    // Sweet / Desserts
    { name: 'Desserts',          image: 'https://images.unsplash.com/photo-1551024601-bec78aea704b' },
    { name: 'Ice Cream',         image: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb' },

    // Beverages — fresh / made-to-order
    { name: 'Coffee',            image: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93' },
    { name: 'Tea',               image: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3' },
    { name: 'Milkshakes',        image: 'https://images.unsplash.com/photo-1577805947697-89e18249d767' },
    { name: 'Fresh Juices',      image: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba' },
    { name: 'Cold Drinks',       image: 'https://images.unsplash.com/photo-1554866585-cd94860890b7' },

    // Beverages — packaged / MRP-printed
    { name: 'Mineral Water',     image: 'https://images.unsplash.com/photo-1564419320461-6870880221ad' },
    { name: 'Packaged Beverages',image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97' },
];

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}".`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant doc exists.');
    return t;
}

const seedFullCategories = async () => {
    try {
        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not set in Backend/.env');
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB');

        const tenant = await resolveTenant();
        console.log(`Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

        // Compute the next displayOrder so newly inserted categories
        // append to the existing menu instead of fighting for slots
        // 1..N. Existing categories keep their position.
        const last = await Category.findOne({ restaurant: tenant._id })
            .sort({ displayOrder: -1 })
            .select('displayOrder');
        let nextOrder = (last?.displayOrder || 0) + 1;

        let created = 0;
        let skipped = 0;

        for (const c of CATEGORIES) {
            const existing = await Category.findOne({
                restaurant: tenant._id,
                name: c.name,
            });
            if (existing) {
                skipped++;
                continue;
            }

            await Category.create({
                restaurant: tenant._id,
                name: c.name,
                image: c.image,
                displayOrder: nextOrder++,
                status: 'active',
            });
            created++;
            console.log(`  + ${c.name}`);
        }

        console.log('');
        console.log(`Summary - created: ${created}, already existed: ${skipped}`);

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
};

seedFullCategories();
