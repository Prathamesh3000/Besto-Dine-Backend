/**
 * seedNonVegMenu.js
 *
 * Adds non-veg menu items to the categories where they're typically
 * served. Complements seedFullMenu.js (which is all-veg). Run after
 * seedFullCategories.js + seedFullMenu.js so the categories already
 * exist.
 *
 * Coverage:
 *   Starters · North Indian · Rice & Biryani · Chinese · Noodles ·
 *   Pizza · Burgers · Sandwiches · Wraps & Rolls · Pasta ·
 *   Healthy Food · Combos & Thali
 *
 * Idempotent — skips items already present (matched by
 * name + category + restaurant).
 *
 *   cd Backend && node Seed/seedNonVegMenu.js
 *   # optional: TENANT_SLUG=<slug> node Seed/seedNonVegMenu.js
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

const COMMON = {
    vegType: 'non-veg',
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    startTime: '11:00',
    endTime: '23:00',
    inStock: true,
    status: 'active',
};

const item = (name, price, description, ingredients, image, extras = {}) => ({
    name, price, description, ingredients, image, ...extras,
});

const MENU = {
    'Starters': {
        defaults: { unit: 'plate', cookingTime: '15-18 min', serveUpto: '1-2 person' },
        items: [
            item('Chicken Tikka', 280,
                'Boneless chicken cubes marinated in yogurt and tandoori spices, char-grilled in the tandoor. Served with mint chutney and onion rings.',
                ['Boneless chicken', 'Hung yogurt', 'Tandoori spices', 'Ginger-garlic', 'Lemon', 'Mustard oil'],
                'https://images.unsplash.com/photo-1606471191009-63994c53433b',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Half Plate', quantity: '4', price: 280 }, { name: 'Full Plate', quantity: '8', price: 480 }],
                    toppings: [{ name: 'Extra Chicken', type: 'non-veg', price: 80 }, { name: 'Tandoori Mint Mayo', type: 'veg', price: 20 }],
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['High Protein', 'Low Carb', 'Gluten Free', 'Post Workout'],
                    nutrition: { calories: 280, protein: 32, fat: 12, carbs: 6, fibre: 1, iron: 1.5 },
                    healthyIngredients: ['Chicken (lean protein)', 'Yogurt (probiotic)', 'Tandoori spice (digestive)'],
                }),
            item('Chicken Lollipop', 240,
                'Drumstick wings deep-fried golden and tossed in hot-and-spicy red sauce. The Indo-Chinese party classic.',
                ['Chicken winglets', 'Red chilli sauce', 'Soy sauce', 'Garlic', 'Cornflour'],
                'https://images.unsplash.com/photo-1626082929543-5bab6f0e1d72',
                {
                    sizes: [{ name: '6 pcs', quantity: '6', price: 240 }, { name: '12 pcs', quantity: '12', price: 440 }],
                }),
            item('Tandoori Chicken (Half)', 320,
                'Half chicken marinated overnight, slow-roasted in the tandoor. Smoky, juicy, served with onion-lemon.',
                ['Whole chicken', 'Hung yogurt', 'Tandoori masala', 'Kashmiri red chilli', 'Lemon'],
                'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0',
                {
                    sizes: [{ name: 'Half', quantity: '1', price: 320 }, { name: 'Full', quantity: '1', price: 580 }],
                }),
            item('Chicken 65', 240,
                'Crispy fried chicken cubes tossed with curry leaves, green chilli and yogurt-chilli sauce. Madras-style.',
                ['Chicken', 'Curry leaves', 'Green chilli', 'Yogurt', 'Red chilli powder'],
                'https://images.unsplash.com/photo-1626082929543-5bab6f0e1d72'),
            item('Fish Tikka', 320,
                'Boneless basa fish marinated in spiced yogurt, char-grilled till lightly smoky.',
                ['Basa fish', 'Hung yogurt', 'Carom seeds', 'Ginger-garlic', 'Lemon'],
                'https://images.unsplash.com/photo-1559847844-5315695dadae',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['High Protein', 'Omega-3 Rich', 'Heart Healthy'],
                    nutrition: { calories: 240, protein: 28, fat: 11, carbs: 4, fibre: 0, iron: 1 },
                }),
        ],
    },

    'North Indian': {
        defaults: { unit: 'bowl', cookingTime: '15-22 min', serveUpto: '2 person' },
        items: [
            item('Butter Chicken', 320,
                'Tandoor-cooked chicken in a rich tomato-cashew-butter gravy, finished with cream and kasuri methi.',
                ['Boneless chicken', 'Tomato', 'Cashew', 'Butter', 'Cream', 'Kasuri methi', 'Garam masala'],
                'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
                {
                    isFeatured: true, offerPercentage: 10,
                    sizes: [{ name: 'Half', quantity: '1', price: 220 }, { name: 'Full', quantity: '1', price: 320 }],
                    toppings: [{ name: 'Extra Chicken', type: 'non-veg', price: 100 }, { name: 'Extra Cream', type: 'veg', price: 30 }],
                }),
            item('Chicken Curry', 280,
                'Home-style chicken curry simmered in onion-tomato gravy with whole spices.',
                ['Chicken', 'Onion', 'Tomato', 'Whole spices', 'Coriander'],
                'https://images.unsplash.com/photo-1604908554049-1f308e3d2c70'),
            item('Mutton Rogan Josh', 380,
                'Slow-cooked Kashmiri mutton in a deep-red yogurt-chilli gravy with fennel and cardamom.',
                ['Mutton', 'Yogurt', 'Kashmiri chilli', 'Fennel', 'Cardamom', 'Onion'],
                'https://images.unsplash.com/photo-1545247181-516773cae754',
                {
                    cookingTime: '25-30 min',
                    sizes: [{ name: 'Half', quantity: '1', price: 260 }, { name: 'Full', quantity: '1', price: 380 }],
                }),
            item('Egg Curry', 180,
                'Boiled eggs in a tangy onion-tomato masala. Comfort food with parathas.',
                ['Eggs', 'Onion', 'Tomato', 'Garam masala', 'Coriander'],
                'https://images.unsplash.com/photo-1604908554049-1f308e3d2c70',
                {
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['High Protein', 'Calcium Rich'],
                    nutrition: { calories: 280, protein: 18, fat: 16, carbs: 12, fibre: 2, iron: 2 },
                }),
            item('Fish Curry', 320,
                'Coastal-style fish curry in a coconut-tamarind gravy with curry leaves and mustard.',
                ['Basa fish', 'Coconut', 'Tamarind', 'Curry leaves', 'Mustard seeds'],
                'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['High Protein', 'Omega-3 Rich', 'Heart Healthy'],
                    nutrition: { calories: 290, protein: 26, fat: 14, carbs: 10, fibre: 2, iron: 1.5 },
                }),
        ],
    },

    'Rice & Biryani': {
        defaults: { unit: 'plate', cookingTime: '20-25 min', serveUpto: '1-2 person' },
        items: [
            item('Chicken Biryani', 260,
                'Long-grain basmati layered with marinated chicken, saffron and fried onion. Dum-cooked for depth.',
                ['Basmati rice', 'Chicken', 'Saffron', 'Fried onion', 'Mint', 'Whole spices'],
                'https://images.unsplash.com/photo-1589302168068-964664d93dc0',
                {
                    isFeatured: true, offerPercentage: 10,
                    sizes: [{ name: 'Half Plate', quantity: '1', price: 180 }, { name: 'Full Plate', quantity: '1', price: 260 }, { name: 'Family Pack', quantity: '4', price: 920 }],
                    toppings: [{ name: 'Extra Raita', type: 'veg', price: 25 }, { name: 'Boiled Egg', type: 'non-veg', price: 30 }, { name: 'Extra Chicken', type: 'non-veg', price: 100 }],
                }),
            item('Hyderabadi Chicken Biryani', 300,
                'Dum-cooked Hyderabadi-style chicken biryani with deep-fried onions and rich spice blend.',
                ['Basmati rice', 'Chicken', 'Mint', 'Fried onion', 'Yogurt', 'Garam masala'],
                'https://images.unsplash.com/photo-1633945274405-b6c8069047b0'),
            item('Mutton Biryani', 360,
                'Slow-cooked mutton in dum biryani — every grain coated in spice and aroma.',
                ['Basmati rice', 'Mutton', 'Saffron', 'Fried onion', 'Mint', 'Whole spices'],
                'https://images.unsplash.com/photo-1589302168068-964664d93dc0',
                { cookingTime: '30-35 min' }),
            item('Egg Biryani', 200,
                'Layered rice biryani with hard-boiled eggs and fragrant whole spices.',
                ['Basmati rice', 'Eggs', 'Saffron', 'Fried onion', 'Mint'],
                'https://images.unsplash.com/photo-1633945274405-b6c8069047b0'),
            item('Chicken Fried Rice', 220,
                'Wok-fried rice with shredded chicken, vegetables and a touch of soy.',
                ['Rice', 'Chicken', 'Spring onion', 'Soy sauce', 'Egg'],
                'https://images.unsplash.com/photo-1603133872878-684f208fb84b'),
        ],
    },

    'Chinese': {
        defaults: { unit: 'plate', cookingTime: '14-16 min', serveUpto: '1-2 person' },
        items: [
            item('Chilli Chicken', 280,
                'Boneless chicken cubes wok-tossed with capsicum, onion and a sticky chilli-soy glaze.',
                ['Chicken', 'Capsicum', 'Onion', 'Soy sauce', 'Green chilli', 'Garlic'],
                'https://images.unsplash.com/photo-1626082929543-5bab6f0e1d72',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Dry', quantity: '1', price: 280 }, { name: 'Gravy', quantity: '1', price: 300 }],
                    toppings: [{ name: 'Extra Chicken', type: 'non-veg', price: 80 }, { name: 'Schezwan Twist', type: 'veg', price: 25 }],
                }),
            item('Chicken Manchurian', 260,
                'Crispy chicken balls tossed in a thick brown manchurian sauce with spring onion.',
                ['Chicken mince', 'Soy sauce', 'Garlic', 'Spring onion', 'Cornflour'],
                'https://images.unsplash.com/photo-1626804475297-41608ea09aeb'),
            item('Dragon Chicken', 280,
                'Spicy crispy chicken strips tossed in a hot-and-sweet chilli-garlic sauce.',
                ['Chicken', 'Red chilli sauce', 'Garlic', 'Honey', 'Cashew'],
                'https://images.unsplash.com/photo-1623653387945-2fd25214f8c0'),
        ],
    },

    'Noodles': {
        defaults: { unit: 'plate', cookingTime: '12-14 min', serveUpto: '1-2 person' },
        items: [
            item('Chicken Hakka Noodles', 220,
                'Stir-fried noodles with shredded chicken and vegetables — the Indo-Chinese street favourite.',
                ['Noodles', 'Chicken', 'Cabbage', 'Carrot', 'Soy sauce', 'Spring onion'],
                'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841',
                { isFeatured: true }),
            item('Chicken Schezwan Noodles', 240,
                'Spicy Schezwan-tossed noodles with chicken and peppers.',
                ['Noodles', 'Chicken', 'Schezwan sauce', 'Capsicum', 'Onion'],
                'https://images.unsplash.com/photo-1552611052-33e04de081de'),
            item('Chicken Singapore Noodles', 250,
                'Light curry-flavoured noodles with chicken, egg and vegetables.',
                ['Noodles', 'Chicken', 'Egg', 'Curry powder', 'Vegetables'],
                'https://images.unsplash.com/photo-1623653387945-2fd25214f8c0'),
        ],
    },

    'Pizza': {
        defaults: { unit: 'pieces', cookingTime: '16-20 min', serveUpto: '1-2 person' },
        items: [
            item('Chicken BBQ Pizza', 380,
                'Smoky BBQ-glazed chicken with onion, capsicum and mozzarella on a tomato base.',
                ['Pizza base', 'Chicken', 'BBQ sauce', 'Onion', 'Capsicum', 'Mozzarella'],
                'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Personal', quantity: '1', price: 380 }, { name: 'Medium', quantity: '1', price: 600 }, { name: 'Large', quantity: '1', price: 820 }],
                    toppings: [{ name: 'Extra Chicken', type: 'non-veg', price: 80 }, { name: 'Extra Cheese', type: 'veg', price: 60 }],
                }),
            item('Chicken Tikka Pizza', 380,
                'Tandoor-grilled chicken tikka cubes on a creamy makhani sauce base.',
                ['Pizza base', 'Chicken tikka', 'Makhani sauce', 'Onion', 'Capsicum', 'Mozzarella'],
                'https://images.unsplash.com/photo-1571066811602-716837d681de'),
            item('Peri Peri Chicken Pizza', 400,
                'Spicy peri-peri chicken with bell peppers, jalapeño and double cheese.',
                ['Chicken', 'Peri peri spice', 'Bell peppers', 'Jalapeño', 'Mozzarella', 'Cheddar'],
                'https://images.unsplash.com/photo-1574071318508-1cdbab80d002'),
        ],
    },

    'Burgers': {
        defaults: { unit: 'pieces', cookingTime: '10-12 min', serveUpto: '1 person' },
        items: [
            item('Chicken Burger', 180,
                'Grilled chicken patty with lettuce, onion and herbed mayo in a brioche bun.',
                ['Chicken patty', 'Lettuce', 'Onion', 'Mayonnaise', 'Bun'],
                'https://images.unsplash.com/photo-1568901346375-23c9450c58cd',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Single', quantity: '1', price: 180 }, { name: 'Double Patty', quantity: '1', price: 280 }],
                    toppings: [{ name: 'Extra Cheese Slice', type: 'veg', price: 30 }, { name: 'Extra Chicken Patty', type: 'non-veg', price: 80 }],
                }),
            item('Crispy Chicken Burger', 200,
                'Crunchy crumb-fried chicken patty with shredded cabbage and chipotle mayo.',
                ['Chicken patty', 'Cabbage', 'Chipotle mayo', 'Bun', 'Tomato'],
                'https://images.unsplash.com/photo-1571091718767-18b5b1457add'),
            item('Peri Peri Chicken Burger', 220,
                'Spicy peri-peri grilled chicken with lettuce, onion and tangy mayo.',
                ['Chicken patty', 'Peri peri spice', 'Lettuce', 'Onion', 'Mayonnaise'],
                'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9'),
        ],
    },

    'Sandwiches': {
        defaults: { unit: 'pieces', cookingTime: '8-10 min', serveUpto: '1 person' },
        items: [
            item('Chicken Club Sandwich', 220,
                'Three-tier sandwich with grilled chicken, cheese, tomato and lettuce.',
                ['Bread', 'Chicken', 'Cheese', 'Tomato', 'Lettuce', 'Mayonnaise'],
                'https://images.unsplash.com/photo-1567234669003-dce7a7a88821',
                { isFeatured: true }),
            item('Egg Sandwich', 100,
                'Soft-boiled egg slices with mayo, salt and pepper between buttered toast.',
                ['Bread', 'Eggs', 'Mayonnaise', 'Black pepper', 'Butter'],
                'https://images.unsplash.com/photo-1528735602780-2552fd46c7af',
                {
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['High Protein', 'Calcium Rich'],
                    nutrition: { calories: 320, protein: 18, fat: 14, carbs: 32, fibre: 2, iron: 2 },
                }),
            item('Chicken Tikka Sandwich', 200,
                'Smoky chicken tikka filling between grilled bread, with mint mayo.',
                ['Bread', 'Chicken tikka', 'Onion', 'Mint mayo', 'Cheese'],
                'https://images.unsplash.com/photo-1592415486689-125cbbfcbee2'),
        ],
    },

    'Wraps & Rolls': {
        defaults: { unit: 'pieces', cookingTime: '12-14 min', serveUpto: '1 person' },
        items: [
            item('Chicken Tikka Wrap', 200,
                'Smoky chicken tikka with onion, lettuce and mint mayo wrapped in a soft tortilla.',
                ['Tortilla', 'Chicken tikka', 'Onion', 'Lettuce', 'Mint mayo'],
                'https://images.unsplash.com/photo-1626700051175-6818013e1d4f',
                { isFeatured: true }),
            item('Chicken Kathi Roll', 180,
                'Calcutta-style egg-paratha rolled with chicken, onion and tangy chutney.',
                ['Paratha', 'Chicken', 'Egg', 'Onion', 'Mint chutney', 'Lemon'],
                'https://images.unsplash.com/photo-1565299585323-38d6b0865b47'),
            item('Egg Roll', 100,
                'Egg-coated paratha rolled with onion, chilli and chaat masala.',
                ['Paratha', 'Egg', 'Onion', 'Green chilli', 'Chaat masala'],
                'https://images.unsplash.com/photo-1565299585323-38d6b0865b47'),
        ],
    },

    'Pasta': {
        defaults: { unit: 'plate', cookingTime: '16-18 min', serveUpto: '1 person' },
        items: [
            item('Chicken Alfredo Pasta', 320,
                'Fettuccine in creamy alfredo sauce with grilled chicken strips and parmesan.',
                ['Pasta', 'Chicken', 'Cream', 'Parmesan', 'Garlic', 'Butter'],
                'https://images.unsplash.com/photo-1645112411341-6c4fd023714a',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Half Plate', quantity: '1', price: 220 }, { name: 'Full Plate', quantity: '1', price: 320 }],
                }),
            item('Peri Peri Chicken Pasta', 320,
                'Penne tossed in spicy peri-peri sauce with grilled chicken and bell peppers.',
                ['Penne', 'Chicken', 'Peri peri sauce', 'Bell peppers', 'Cream'],
                'https://images.unsplash.com/photo-1611270629569-8b357cb88da9'),
        ],
    },

    'Healthy Food': {
        defaults: { unit: 'bowl', cookingTime: '12-15 min', serveUpto: '1 person', isHealthy: true, healthLevel: 'High' },
        items: [
            item('Grilled Chicken Bowl', 320,
                'Lemon-pepper grilled chicken breast with steamed broccoli, sweet potato and quinoa.',
                ['Chicken breast', 'Broccoli', 'Sweet potato', 'Quinoa', 'Lemon', 'Black pepper'],
                'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
                {
                    isFeatured: true,
                    healthTags: ['High Protein', 'Post Workout', 'Heart Healthy', 'Low Carb'],
                    nutrition: { calories: 420, protein: 38, fat: 12, carbs: 36, fibre: 7, iron: 3 },
                    healthyIngredients: ['Chicken breast (lean protein)', 'Broccoli (vitamin K)', 'Quinoa (whole grain)'],
                }),
            item('Egg White Omelette', 140,
                'Three-egg-white omelette with spinach, mushroom and herbs. Zero yolk, full protein.',
                ['Egg whites', 'Spinach', 'Mushroom', 'Onion', 'Black pepper'],
                'https://images.unsplash.com/photo-1525351484163-7529414344d8',
                {
                    healthTags: ['High Protein', 'Low Calorie', 'Low Fat', 'Post Workout'],
                    nutrition: { calories: 140, protein: 18, fat: 3, carbs: 4, fibre: 1, iron: 2 },
                    healthyIngredients: ['Egg whites (pure protein)', 'Spinach (iron)', 'Mushroom (B vitamins)'],
                }),
        ],
    },

    'Combos & Thali': {
        defaults: { unit: 'plate', cookingTime: '20-25 min', serveUpto: '1 person' },
        items: [
            item('Chicken Thali', 320,
                'Butter chicken, dal, 2 roti, jeera rice, salad, papad and gulab jamun. Hearty non-veg meal.',
                ['Butter chicken', 'Dal', 'Roti', 'Jeera rice', 'Salad', 'Papad', 'Gulab jamun'],
                'https://images.unsplash.com/photo-1585937421612-70a008356fbe',
                { isFeatured: true }),
            item('Mutton Thali', 380,
                'Mutton curry, dal, 2 roti, jeera rice, salad, papad and dessert.',
                ['Mutton curry', 'Dal', 'Roti', 'Rice', 'Salad', 'Papad', 'Sweet'],
                'https://images.unsplash.com/photo-1545247181-516773cae754'),
        ],
    },
};

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

async function seedNonVegMenu() {
    try {
        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not set in Backend/.env');
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB');

        const tenant = await resolveTenant();
        console.log(`Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

        let totalCreated = 0;
        let totalSkipped = 0;
        const missingCategories = [];

        for (const [categoryName, block] of Object.entries(MENU)) {
            const category = await Category.findOne({
                restaurant: tenant._id,
                name: categoryName,
                status: { $ne: 'inactive' },
            });

            if (!category) {
                missingCategories.push(categoryName);
                console.warn(`  ! Category "${categoryName}" not found — skipping`);
                continue;
            }

            const defaults = block.defaults || {};

            for (const it of block.items) {
                const exists = await MenuItem.findOne({
                    restaurant: tenant._id,
                    category: category._id,
                    name: it.name,
                });
                if (exists) {
                    totalSkipped++;
                    continue;
                }

                const merged = { ...COMMON, ...defaults, ...it };

                const doc = {
                    restaurant: tenant._id,
                    name: merged.name,
                    category: category._id,
                    description: merged.description,
                    images: [merged.image],
                    cookingTime: merged.cookingTime,
                    serveUpto: merged.serveUpto,
                    ingredients: merged.ingredients || [],
                    vegType: merged.vegType,
                    isFeatured: !!merged.isFeatured,
                    availableDays: merged.availableDays,
                    startTime: merged.startTime,
                    endTime: merged.endTime,
                    basePrice: merged.price,
                    offerPercentage: merged.offerPercentage || 0,
                    unit: merged.unit,
                    sizes: (merged.sizes || []).map(s => ({
                        name: s.name,
                        price: Number(s.price),
                        quantity: String(s.quantity || ''),
                    })),
                    toppings: (merged.toppings || []).map(t => ({
                        name: t.name,
                        price: Number(t.price),
                        type: t.type || 'non-veg',
                    })),
                    isHealthy: !!merged.isHealthy,
                    inStock: merged.inStock,
                    status: merged.status,
                };

                if (merged.healthLevel)        doc.healthLevel        = merged.healthLevel;
                if (merged.healthTags)         doc.healthTags         = merged.healthTags;
                if (merged.nutrition)          doc.nutritionalInfo    = merged.nutrition;
                if (merged.healthyIngredients) doc.healthyIngredients = merged.healthyIngredients;

                await MenuItem.create(doc);
                totalCreated++;
            }

            console.log(`  + ${categoryName}: ${block.items.length} non-veg items ensured`);
        }

        console.log('');
        console.log(`Summary - created: ${totalCreated}, already existed: ${totalSkipped}`);
        if (missingCategories.length) {
            console.log(`Skipped (no category): ${missingCategories.join(', ')}`);
        }

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
}

seedNonVegMenu();
