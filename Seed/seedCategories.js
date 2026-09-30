const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Category = require('../models/category');

const categories = [
    {
        "name": "Pizza",
        "displayOrder": 1,
        "image": "https://images.unsplash.com/photo-1601924582975-7e2d6c82eab1",
        "status": "active"
    },
    {
        "name": "Burger",
        "displayOrder": 2,
        "image": "https://images.unsplash.com/photo-1550547660-d9450f859349",
        "status": "active"
    },
    {
        "name": "Biryani",
        "displayOrder": 3,
        "image": "https://images.unsplash.com/photo-1633945274405-b6c8069047b0",
        "status": "active"
    },
    {
        "name": "Chinese",
        "displayOrder": 4,
        "image": "https://images.unsplash.com/photo-1585032226651-759b368d7246",
        "status": "active"
    },
    {
        "name": "South Indian",
        "displayOrder": 5,
        "image": "https://images.unsplash.com/photo-1668236543090-82eba5ee5976",
        "status": "active"
    },
    {
        "name": "North Indian",
        "displayOrder": 6,
        "image": "https://images.unsplash.com/photo-1601050690597-df0568f70950",
        "status": "active"
    },
    {
        "name": "Sandwich",
        "displayOrder": 7,
        "image": "https://images.unsplash.com/photo-1553909489-cd47e0907980",
        "status": "active"
    },
    {
        "name": "Wraps",
        "displayOrder": 8,
        "image": "https://images.unsplash.com/photo-1606755962773-d324e0a13086",
        "status": "active"
    },
    {
        "name": "Salads",
        "displayOrder": 9,
        "image": "https://images.unsplash.com/photo-1546793665-c74683f339c1",
        "status": "active"
    },
    {
        "name": "Pasta",
        "displayOrder": 10,
        "image": "https://images.unsplash.com/photo-1525755662778-989d0524087e",
        "status": "active"
    },
    {
        "name": "Noodles",
        "displayOrder": 11,
        "image": "https://images.unsplash.com/photo-1612929633738-8fe44f7ec841",
        "status": "active"
    },
    {
        "name": "Starters",
        "displayOrder": 12,
        "image": "https://images.unsplash.com/photo-1600891964599-f61ba0e24092",
        "status": "active"
    },
    {
        "name": "Main Course",
        "displayOrder": 13,
        "image": "https://images.unsplash.com/photo-1604908176997-431dbcb0b7a4",
        "status": "active"
    },
    {
        "name": "Healthy Food",
        "displayOrder": 14,
        "image": "https://images.unsplash.com/photo-1490645935967-10de6ba17061",
        "status": "active"
    },
    {
        "name": "Desserts",
        "displayOrder": 15,
        "image": "https://images.unsplash.com/photo-1551024601-bec78aea704b",
        "status": "active"
    },
    {
        "name": "Ice Cream",
        "displayOrder": 16,
        "image": "https://images.unsplash.com/photo-1563805042-7684c019e1cb",
        "status": "active"
    },
    {
        "name": "Milkshakes",
        "displayOrder": 17,
        "image": "https://images.unsplash.com/photo-1577805947697-89e18249d767",
        "status": "active"
    },
    {
        "name": "Cold Drinks",
        "displayOrder": 18,
        "image": "https://images.unsplash.com/photo-1554866585-cd94860890b7",
        "status": "active"
    },
    {
        "name": "Coffee",
        "displayOrder": 19,
        "image": "https://images.unsplash.com/photo-1509042239860-f550ce710b93",
        "status": "active"
    },
    {
        "name": "Tea",
        "displayOrder": 20,
        "image": "https://images.unsplash.com/photo-1523906630133-f6934a1ab7a8",
        "status": "active"
    }
];

// Tenant resolution — TENANT_SLUG env var picks a specific tenant,
// otherwise we use the first Restaurant doc (matches seedRecipes /
// seedDefaultTenant). Categories are tenant-scoped post-Phase-1, so
// every row needs a `restaurant: <id>` link to validate.
async function resolveTenant() {
    const Restaurant = require('../models/restaurant');
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}". Run seedDefaultTenant first.`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant doc exists. Run "node Seed/seedDefaultTenant.js" first.');
    return t;
}

const seedCategories = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB for category seeding...');

        const tenant = await resolveTenant();
        console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

        // Only clear THIS tenant's categories — leaves other restaurants
        // (e.g. Test Cafe) untouched. Required because the per-tenant
        // unique index is { name + restaurant }, not just { name }.
        await Category.deleteMany({ restaurant: tenant._id });
        console.log("Cleared this tenant's existing categories.");

        const stamped = categories.map(c => ({ ...c, restaurant: tenant._id }));
        await Category.insertMany(stamped);
        console.log(`✔ Added ${stamped.length} categories for ${tenant.name}.`);

        process.exit();
    } catch (err) {
        console.error('Category Seeding Error:', err);
        process.exit(1);
    }
};

seedCategories();
