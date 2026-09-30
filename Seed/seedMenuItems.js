const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Restaurant = require('../models/restaurant');

// Tenant resolution — TENANT_SLUG env var picks a specific tenant,
// otherwise we use the first Restaurant doc (matches seedRecipes /
// seedDefaultTenant). MenuItems are tenant-scoped, so every row
// needs a `restaurant: <id>` link to validate.
async function resolveTenant() {
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

const categoryItemNames = {
    'Pizza': ['Classic Margherita', 'Farmhouse Special', 'Spicy Paneer Pizza', 'Veggie Supreme', 'Double Cheese Pizza'],
    'Burger': ['Crunchy Veg Burger', 'Paneer Peri Peri Burger', 'Cheese Jumbo Burger', 'Classic Aloo Tikki', 'Double Patty Burger'],
    'Biryani': ['Hyderabadi Veg Biryani', 'Lucknowi Dum Biryani', 'Saffron Paneer Biryani', 'Mushroom Matka Biryani', 'Kashmiri Pulav'],
    'Chinese': ['Veg Manchurian Dry', 'Veg Fried Rice', 'Hakka Noodles', 'Schezwan Fried Rice', 'Honey Chilli Potato'],
    'South Indian': ['Masala Dosa', 'Rava Idli', 'Meduvada', 'Onion Uttapam', 'Paper Plain Dosa'],
    'North Indian': ['Paneer Tikka Masala', 'Dal Makhani Royale', 'Mix Veg Kadhai', 'Shahi Paneer', 'Malai Kofta'],
    'Sandwich': ['Bombay Grilled Sandwich', 'Cheese Chilli Toast', 'Paneer Club Sandwich', 'Veg Mayo Sandwich', 'Corn & Spinach Toast'],
    'Wraps': ['Paneer Tikka Wrap', 'Falafel Veggie Wrap', 'Cheese Corn Roll', 'Mexican Bean Wrap', 'Veggie Kathi Roll'],
    'Salads': ['Garden Fresh Salad', 'Greek Feta Salad', 'Sprouted Moong Salad', 'Caesar Veg Salad', 'Fruit Salad with Cream'],
    'Pasta': ['Penne Arrabbiata', 'White Sauce Pasta', 'Fusilli Pesto', 'Mixed Sauce Pasta', 'Mac & Cheese'],
    'Noodles': ['Classic Hakka Noodles', 'Schezwan Special Noodles', 'Garlic Noodles', 'Singapore Noodles', 'Paneer Noodles'],
    'Starters': ['Hara Bhara Kabab', 'Crispy Corn', 'Veg Lollipop', 'Spring Rolls', 'Mushroom Tikka'],
    'Main Course': ['Kadhai Paneer', 'Baingan Bharta', 'Jeera Aloo', 'Yellow Dal Tadka', 'Palak Paneer'],
    'Healthy Food': ['Quinoa Bowl', 'Boiled Veggies with Herbs', 'Protein Rich Sprouts', 'Oatmeal Porridge', 'Steamed Broccoli Salad'],
    'Desserts': ['Gulab Jamun', 'Chocolate Lava Cake', 'Rasmalai', 'Fruit Custard', 'Brownie with Fudge'],
    'Ice Cream': ['Vanilla Scoop', 'Chocolate Belgium', 'Strawberry Swirl', 'Butterscotch Crunch', 'Mango Delight'],
    'Milkshakes': ['Classic Vanilla Shake', 'Strong Cold Coffee', 'Oreo Shake', 'Chocolate Smoothie', 'Mango Shake'],
    'Cold Drinks': ['Lemon Iced Tea', 'Fresh Lime Soda', 'Coke / Pepsi', 'Cold Coffee with Ice Cream', 'Virgin Mojito'],
    'Coffee': ['Cappuccino', 'Cafe Latte', 'Espresso Shot', 'Irish Coffee', 'Mocha'],
    'Tea': ['Masala Chai', 'Ginger Lemon Tea', 'Green Tea', 'Honey Lemon Tea', 'Kullad Chai']
};

const images = [
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
    'https://images.unsplash.com/photo-1513104890138-7c749659a591',
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
    'https://images.unsplash.com/photo-1567620905732-2d1ec7bb7445',
    'https://images.unsplash.com/photo-1484723088339-323833995221'
];

// Stable hash → deterministic numbers per item name. Lets us re-run
// the seed without invalidating customer carts (random prices used to
// trigger TOTAL_TAMPERED on every reseed) and gives every item the
// same nutrition / size profile across runs.
function stableHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}
function pseudoRand(seed, idx) {
    return (stableHash(`${seed}:${idx}`) % 10000) / 10000; // [0..1)
}

const TOPPING_POOL = [
    { name: 'Extra Cheese',  price: 49, type: 'veg' },
    { name: 'Lettuce',       price: 39, type: 'veg' },
    { name: 'Cheese Slice',  price: 49, type: 'veg' },
    { name: 'Olives',        price: 35, type: 'veg' },
    { name: 'Chilli Flakes', price: 10, type: 'veg' },
    { name: 'Mushroom',      price: 45, type: 'veg' },
];

const seedMenuItems = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB for full menu seeding...');

        const tenant = await resolveTenant();
        console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

        // 1. Fetch categories scoped to this tenant.
        const categories = await Category.find({ restaurant: tenant._id });
        if (categories.length === 0) {
            console.log('No categories found for this tenant. Run "node Seed/seedCategories.js" first.');
            process.exit(1);
        }

        // 2. Clear THIS tenant's menu items only.
        await MenuItem.deleteMany({ restaurant: tenant._id });
        console.log("Cleared this tenant's existing menu items.");

        // 3. Insert EVERY named item from categoryItemNames (5 × 20 =
        //    100 items). Names are exact (no trailing counter) so they
        //    line up 1:1 with seedRecipes.js RECIPE_BLUEPRINTS keys —
        //    every item gets a recipe linked. Prices and other random-
        //    looking fields are derived from a stable hash of the
        //    item name so re-runs never change them.
        const itemsToInsert = [];

        for (const category of categories) {
            const nameList = categoryItemNames[category.name];
            if (!nameList || nameList.length === 0) {
                console.log(`  ⚠ No item list defined for category "${category.name}" — skipping`);
                continue;
            }

            for (const itemName of nameList) {
                const seed = itemName;
                const basePrice = 100 + (stableHash(seed) % 300);                       // ₹100–399, stable
                const offerPercentage = pseudoRand(seed, 'offer') > 0.5
                    ? 5 + Math.floor(pseudoRand(seed, 'offerPct') * 20)
                    : 0;

                const sampleSizes = [
                    { name: 'Regular', price: basePrice,       quantity: '1' },
                    { name: 'Medium',  price: basePrice + 150, quantity: '2' },
                    { name: 'Large',   price: basePrice + 300, quantity: '3' },
                ];

                // Pick a stable subset of toppings — 2 to 4 per item.
                const toppingCount = 2 + Math.floor(pseudoRand(seed, 'topCount') * 3);
                const ranked = TOPPING_POOL
                    .map((t, i) => ({ t, score: pseudoRand(seed, `top${i}`) }))
                    .sort((a, b) => b.score - a.score);
                const sampleToppings = ranked.slice(0, toppingCount).map(r => r.t);

                const nutritionalInfo = {
                    calories: 150 + Math.floor(pseudoRand(seed, 'kcal') * 400),
                    protein:  5  + Math.floor(pseudoRand(seed, 'protein') * 25),
                    fat:      3  + Math.floor(pseudoRand(seed, 'fat') * 22),
                    carbs:    10 + Math.floor(pseudoRand(seed, 'carbs') * 50),
                    fibre:    1  + Math.floor(pseudoRand(seed, 'fibre') * 10),
                    iron:     Math.floor(pseudoRand(seed, 'iron') * 5),
                };

                const healthTags = [];
                if (nutritionalInfo.protein >= 15) healthTags.push('High Protein');
                if (nutritionalInfo.fat <= 12)     healthTags.push('Healthy Fats');
                if (nutritionalInfo.calories <= 350) healthTags.push('Balanced Calories');
                if (nutritionalInfo.fibre >= 6)    healthTags.push('High Fibre');

                const healthLevel = nutritionalInfo.calories <= 300
                    ? 'High'
                    : nutritionalInfo.calories <= 450 ? 'Medium' : 'Low';

                itemsToInsert.push({
                    restaurant: tenant._id,
                    name: itemName,                            // exact name — matches RECIPE_BLUEPRINTS
                    category: category._id,
                    description: `Delicious ${itemName} prepared fresh in our kitchen with the finest ingredients.`,
                    images: [images[stableHash(seed) % images.length]],
                    cookingTime: `${10 + Math.floor(pseudoRand(seed, 'cook') * 20)} mins`,
                    serveUpto: ['1 person', '1-2 person', '2-3 person', '3-4 person'][stableHash(seed) % 4],
                    ingredients: ['Fresh Dough', 'Secret Spices', 'Organic Herbs'],
                    vegType: pseudoRand(seed, 'veg') > 0.3 ? 'veg' : 'non-veg',
                    isFeatured: pseudoRand(seed, 'featured') > 0.8,
                    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                    startTime: '09:00',
                    endTime: '23:00',
                    basePrice,
                    offerPercentage,
                    finalPrice: basePrice - (basePrice * (offerPercentage / 100)),
                    sizes: sampleSizes,
                    toppings: sampleToppings,
                    isHealthy: pseudoRand(seed, 'healthy') > 0.7,
                    nutritionalInfo,
                    healthTags,
                    healthLevel,
                    status: 'active',
                });
            }
        }
        const totalItems = itemsToInsert.length;

        // 3. Insert to DB
        await MenuItem.insertMany(itemsToInsert);
        console.log(`Successfully seeded ${totalItems} MenuItems across all categories!`);

        process.exit();
    } catch (err) {
        console.error('Seeding Error:', err);
        process.exit(1);
    }
};

seedMenuItems();
