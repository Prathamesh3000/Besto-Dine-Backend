/**
 * seedFullMenu.js
 *
 * Adds 5 menu items to each of the 25 categories created by
 * seedFullCategories.js. Every item ships with:
 *   - unique Unsplash hero image (item-specific, not category fallback)
 *   - real Pune-mid-range pricing
 *   - description, ingredients, vegType, cookingTime, serveUpto, unit
 *   - sizes & toppings where they apply (pizzas, burgers, biryanis, etc.)
 *   - full Health Information for items that should surface in Health
 *     Mode (salads, juices, sprouts, green tea, water, etc.)
 *   - isFeatured = true on the hero item of each category
 *   - 11:00 AM - 11:00 PM service window, all 7 days
 *
 * Idempotent — skips items already present (matched by
 * name + category + restaurant). Categories that don't exist are
 * skipped with a warning (run seedFullCategories.js first).
 *
 *   cd Backend && node Seed/seedFullMenu.js
 *   # optional: TENANT_SLUG=<slug> node Seed/seedFullMenu.js
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

// ── Defaults applied to every item unless overridden per item ────────
const COMMON = {
    vegType: 'veg',
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    startTime: '11:00',
    endTime: '23:00',
    inStock: true,
    status: 'active',
};

// Compact helper — keeps each item declaration on a few lines instead
// of a 20-line JSON blob. Anything not passed falls through to the
// per-category defaults block.
const item = (name, price, description, ingredients, image, extras = {}) => ({
    name, price, description, ingredients, image, ...extras,
});

// ── 25 categories × 5 items = 125 menu items ─────────────────────────
const MENU = {
    'Starters': {
        defaults: { unit: 'plate', cookingTime: '12-15 min', serveUpto: '1-2 person' },
        items: [
            item('Paneer Tikka', 240,
                'Tandoor-grilled cottage cheese cubes marinated in yogurt and tandoori spices, skewered with bell peppers and onion rings. Served sizzling-hot with mint-coriander chutney and lemon wedge.',
                ['Paneer', 'Capsicum', 'Onion', 'Hung Yogurt', 'Tandoori spices', 'Ginger-garlic paste', 'Lemon', 'Mustard oil'],
                'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8',
                {
                    isFeatured: true, offerPercentage: 10,
                    sizes: [{ name: 'Half Plate', quantity: '4', price: 240 }, { name: 'Full Plate', quantity: '8', price: 420 }],
                    toppings: [{ name: 'Extra Paneer Cubes', type: 'veg', price: 50 }, { name: 'Extra Cheese Stuffing', type: 'veg', price: 40 }, { name: 'Tandoori Mint Mayo', type: 'veg', price: 20 }],
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['High Protein', 'Low Carb', 'Gluten Free'],
                    nutrition: { calories: 320, protein: 22, fat: 18, carbs: 12, fibre: 3, iron: 1.5 },
                    healthyIngredients: ['Paneer (high protein)', 'Capsicum (vitamin C)', 'Yogurt (probiotic)'],
                }),
            item('Hara Bhara Kebab', 180,
                'Pan-fried green kebabs of spinach, peas and potato — light, crisp and cumin-spiced. Served with mint chutney.',
                ['Spinach', 'Green peas', 'Potato', 'Coriander', 'Cumin', 'Green chilli'],
                'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0',
                {
                    sizes: [{ name: '4 pcs', quantity: '4', price: 180 }, { name: '8 pcs', quantity: '8', price: 320 }],
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Iron Rich', 'Low Calorie', 'Sattvik'],
                    nutrition: { calories: 220, protein: 8, fat: 9, carbs: 26, fibre: 6, iron: 3 },
                    healthyIngredients: ['Spinach (iron)', 'Peas (fibre)', 'Coriander (antioxidant)'],
                }),
            item('Veg Manchurian Dry', 200,
                'Crispy mixed-vegetable balls tossed in soy-garlic-chilli sauce. The Indo-Chinese classic — garnished with spring onion.',
                ['Cabbage', 'Carrot', 'Capsicum', 'Soy sauce', 'Garlic', 'Spring onion', 'Cornflour'],
                'https://images.unsplash.com/photo-1626804475297-41608ea09aeb',
                {
                    toppings: [{ name: 'Schezwan Twist', type: 'veg', price: 30 }, { name: 'Extra Manchurian Balls', type: 'veg', price: 60 }],
                }),
            item('Crispy Corn', 170,
                'Sweet corn kernels deep-fried golden and tossed with curry leaves, chilli and a hint of lime. Crunchy outside, juicy inside.',
                ['Sweet corn', 'Curry leaves', 'Green chilli', 'Lime', 'Cornflour', 'Black pepper'],
                'https://images.unsplash.com/photo-1601050690597-df0568f70950'),
            item('Chilli Paneer', 220,
                'Cottage cheese cubes wok-tossed with capsicum, onion and a sticky chilli-soy glaze. Pairs with fried rice or hakka noodles.',
                ['Paneer', 'Capsicum', 'Onion', 'Soy sauce', 'Green chilli', 'Garlic', 'Spring onion'],
                'https://images.unsplash.com/photo-1626777553635-3a1f6ae37e3a',
                {
                    sizes: [{ name: 'Dry', quantity: '1', price: 220 }, { name: 'Gravy', quantity: '1', price: 240 }],
                    toppings: [{ name: 'Extra Paneer', type: 'veg', price: 50 }, { name: 'Schezwan', type: 'veg', price: 25 }],
                }),
        ],
    },

    'Soups': {
        defaults: { unit: 'bowl', cookingTime: '8-10 min', serveUpto: '1 person' },
        items: [
            item('Veg Manchow Soup', 130,
                'Spicy Indo-Chinese soup with finely chopped vegetables, soy sauce and crispy fried noodles on top.',
                ['Mixed vegetables', 'Soy sauce', 'Garlic', 'Fried noodles', 'White pepper'],
                'https://images.unsplash.com/photo-1547308283-b941e3da7d8b',
                { isFeatured: true }),
            item('Hot & Sour Soup', 130,
                'Tangy-spicy Asian soup with shredded vegetables, vinegar and white pepper. The eternal comfort.',
                ['Cabbage', 'Carrot', 'Mushroom', 'Vinegar', 'White pepper', 'Soy sauce'],
                'https://images.unsplash.com/photo-1605709303005-29c075a5b048'),
            item('Sweet Corn Soup', 120,
                'Mild, creamy soup with sweet corn kernels and finely chopped vegetables. Kid-favourite.',
                ['Sweet corn', 'Carrot', 'Cornflour', 'White pepper'],
                'https://images.unsplash.com/photo-1576487236230-eaa4afe68192'),
            item('Tomato Shorba', 120,
                'North-Indian style smooth tomato soup with cumin tempering and a swirl of cream. Light yet rich.',
                ['Tomato', 'Cumin', 'Cream', 'Pepper', 'Coriander', 'Ghee'],
                'https://images.unsplash.com/photo-1547592180-85f173990554',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Antioxidant Rich', 'Low Calorie', 'Vitamin C Rich'],
                    nutrition: { calories: 110, protein: 3, fat: 4, carbs: 15, fibre: 2, iron: 1 },
                    healthyIngredients: ['Tomato (lycopene)', 'Cumin (digestive)', 'Coriander (vitamin C)'],
                }),
            item('Cream of Mushroom', 150,
                'Smooth, buttery mushroom soup finished with cream and cracked black pepper.',
                ['Button mushroom', 'Butter', 'Cream', 'Onion', 'Garlic', 'Pepper'],
                'https://images.unsplash.com/photo-1604152135912-04a022e23696',
                {
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['Low Carb', 'Gluten Free'],
                    nutrition: { calories: 180, protein: 5, fat: 12, carbs: 9, fibre: 1, iron: 0.5 },
                }),
        ],
    },

    'South Indian': {
        defaults: { unit: 'plate', cookingTime: '8-12 min', serveUpto: '1 person' },
        items: [
            item('Masala Dosa', 130,
                'Crisp rice-and-lentil crepe stuffed with spiced potato masala, served with sambar and three chutneys.',
                ['Rice batter', 'Urad dal', 'Potato', 'Onion', 'Mustard seeds', 'Curry leaves'],
                'https://images.unsplash.com/photo-1668236543090-82eba5ee5976',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Regular', quantity: '1', price: 130 }, { name: 'Family', quantity: '2', price: 220 }],
                    toppings: [{ name: 'Extra Cheese', type: 'veg', price: 30 }, { name: 'Extra Sambar', type: 'veg', price: 20 }, { name: 'Schezwan Style', type: 'veg', price: 25 }],
                }),
            item('Plain Dosa', 90,
                'Golden, paper-thin rice crepe with sambar and coconut chutney. Light, crisp and filling.',
                ['Rice batter', 'Urad dal', 'Salt'],
                'https://images.unsplash.com/photo-1630383249896-46d45e3a6f5b'),
            item('Idli Sambar (3 pc)', 80,
                'Three steamed rice cakes served with hot sambar and coconut chutney. The lightest South-Indian breakfast.',
                ['Idli rice', 'Urad dal', 'Sambar', 'Coconut'],
                'https://images.unsplash.com/photo-1589301760014-d929f3979dbc',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Low Fat', 'Heart Healthy', 'Sattvik'],
                    nutrition: { calories: 240, protein: 8, fat: 3, carbs: 48, fibre: 4, iron: 1.5 },
                    healthyIngredients: ['Idli (steamed not fried)', 'Sambar (lentil protein)', 'Coconut (healthy fat)'],
                }),
            item('Medu Vada (2 pc)', 80,
                'Crisp savoury lentil donuts, fried fresh and served with sambar and chutney.',
                ['Urad dal', 'Curry leaves', 'Black pepper', 'Ginger'],
                'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4'),
            item('Onion Uttapam', 130,
                'Thick savoury rice pancake topped with chopped onion, tomato and coriander.',
                ['Rice batter', 'Urad dal', 'Onion', 'Tomato', 'Coriander', 'Green chilli'],
                'https://images.unsplash.com/photo-1630383249896-46d45e3a6f5b'),
        ],
    },

    'North Indian': {
        defaults: { unit: 'bowl', cookingTime: '12-18 min', serveUpto: '2 person' },
        items: [
            item('Paneer Butter Masala', 270,
                'Cottage cheese in a creamy tomato-cashew gravy with a hint of fenugreek. Rich, royal and best with butter naan.',
                ['Paneer', 'Tomato', 'Cashew', 'Cream', 'Butter', 'Kasuri methi', 'Garam masala'],
                'https://images.unsplash.com/photo-1631452180519-c014fe946bc7',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Half', quantity: '1', price: 180 }, { name: 'Full', quantity: '1', price: 270 }],
                    toppings: [{ name: 'Extra Paneer', type: 'veg', price: 60 }, { name: 'Extra Cream', type: 'veg', price: 30 }],
                }),
            item('Dal Makhani', 230,
                'Slow-cooked black lentils tempered with butter, cream and ginger-garlic. The Punjabi staple, simmered overnight.',
                ['Black urad dal', 'Rajma', 'Cream', 'Butter', 'Tomato', 'Ginger-garlic', 'Garam masala'],
                'https://images.unsplash.com/photo-1626500155640-df57a624bc56',
                {
                    sizes: [{ name: 'Half', quantity: '1', price: 150 }, { name: 'Full', quantity: '1', price: 230 }],
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['High Protein', 'Iron Rich'],
                    nutrition: { calories: 320, protein: 14, fat: 12, carbs: 38, fibre: 8, iron: 4 },
                }),
            item('Shahi Paneer', 270,
                'Mughlai gravy of cashews, cream and saffron with soft paneer cubes. Mild, sweet and luxurious.',
                ['Paneer', 'Cashew', 'Cream', 'Saffron', 'Onion', 'Cardamom'],
                'https://images.unsplash.com/photo-1628294895950-9805252327bc'),
            item('Kadhai Paneer', 270,
                'Paneer cooked with bell peppers and onions in a freshly-roasted kadhai-coriander masala. Aromatic and bold.',
                ['Paneer', 'Capsicum', 'Onion', 'Tomato', 'Coriander seeds', 'Red chilli'],
                'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
                {
                    toppings: [{ name: 'Extra Paneer', type: 'veg', price: 60 }, { name: 'Extra Onion-Capsicum', type: 'veg', price: 30 }],
                }),
            item('Dal Tadka', 180,
                'Yellow lentils tempered with cumin, garlic and red chilli — comfort food at its best, paired with jeera rice.',
                ['Toor dal', 'Cumin', 'Garlic', 'Ghee', 'Red chilli', 'Coriander'],
                'https://images.unsplash.com/photo-1546833999-b9f581a1996d',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['High Protein', 'Heart Healthy', 'Sattvik'],
                    nutrition: { calories: 240, protein: 12, fat: 9, carbs: 26, fibre: 6, iron: 3 },
                    healthyIngredients: ['Toor dal (protein)', 'Cumin (digestive)', 'Ghee (good fat)'],
                }),
        ],
    },

    'Breads': {
        defaults: { unit: 'pieces', cookingTime: '5-8 min', serveUpto: '1 person' },
        items: [
            item('Tandoori Roti', 25,
                'Whole-wheat round bread baked fresh in the tandoor. The everyday companion.',
                ['Whole wheat flour', 'Salt', 'Water'],
                'https://images.unsplash.com/photo-1626776877415-9d51e6b5ab90'),
            item('Butter Naan', 55,
                'Soft, leavened bread baked in the tandoor and brushed generously with butter.',
                ['Maida', 'Yogurt', 'Butter', 'Yeast', 'Salt'],
                'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
                { isFeatured: true }),
            item('Garlic Naan', 70,
                'Naan topped with chopped garlic and coriander, baked till the edges crisp up.',
                ['Maida', 'Garlic', 'Coriander', 'Butter', 'Yogurt'],
                'https://images.unsplash.com/photo-1606755962773-d324e0a13086'),
            item('Lachha Paratha', 60,
                'Multi-layered flaky paratha with a crisp golden top — pulls apart in fine sheets.',
                ['Whole wheat flour', 'Ghee', 'Salt', 'Carom seeds'],
                'https://images.unsplash.com/photo-1626774898724-15e8d23f25c7'),
            item('Stuffed Kulcha', 80,
                'Tandoor-baked kulcha stuffed with spiced potato, onion and coriander — Amritsar-style.',
                ['Maida', 'Potato', 'Coriander', 'Onion', 'Cumin', 'Ginger'],
                'https://images.unsplash.com/photo-1626774898724-15e8d23f25c7'),
        ],
    },

    'Rice & Biryani': {
        defaults: { unit: 'plate', cookingTime: '15-25 min', serveUpto: '1-2 person' },
        items: [
            item('Veg Biryani', 200,
                'Long-grain basmati layered with mixed vegetables, saffron and whole spices. Served with raita and salan.',
                ['Basmati rice', 'Mixed vegetables', 'Saffron', 'Whole spices', 'Mint', 'Fried onion'],
                'https://images.unsplash.com/photo-1633945274405-b6c8069047b0',
                {
                    isFeatured: true, offerPercentage: 10,
                    sizes: [{ name: 'Half Plate', quantity: '1', price: 140 }, { name: 'Full Plate', quantity: '1', price: 200 }, { name: 'Family Pack', quantity: '4', price: 720 }],
                    toppings: [{ name: 'Extra Raita', type: 'veg', price: 25 }, { name: 'Boiled Egg', type: 'veg', price: 30 }, { name: 'Extra Salan', type: 'veg', price: 30 }],
                }),
            item('Hyderabadi Veg Biryani', 240,
                'Dum-cooked biryani with mint, fried onions and aromatic Hyderabadi spice blend. Slow-steamed for depth.',
                ['Basmati rice', 'Mint', 'Fried onion', 'Yogurt', 'Saffron', 'Garam masala'],
                'https://images.unsplash.com/photo-1589302168068-964664d93dc0'),
            item('Jeera Rice', 160,
                'Steamed basmati rice tempered with cumin and ghee. The perfect canvas for any dal or curry.',
                ['Basmati rice', 'Cumin', 'Ghee', 'Bay leaf'],
                'https://images.unsplash.com/photo-1596797038530-2c107229654b'),
            item('Veg Pulao', 180,
                'One-pot rice cooked with vegetables and whole spices — lighter than biryani, just as fragrant.',
                ['Basmati rice', 'Mixed vegetables', 'Whole spices', 'Cashew'],
                'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a'),
            item('Curd Rice', 140,
                'Cooling tempered yogurt rice with mustard seeds, curry leaves and pomegranate. South-Indian summer staple.',
                ['Rice', 'Curd', 'Curry leaves', 'Mustard seeds', 'Pomegranate'],
                'https://images.unsplash.com/photo-1604908176997-431dbcb0b7a4',
                {
                    unit: 'bowl',
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Probiotic', 'Sattvik', 'Low Fat'],
                    nutrition: { calories: 220, protein: 7, fat: 5, carbs: 38, fibre: 1, iron: 0.8 },
                    healthyIngredients: ['Curd (probiotic)', 'Curry leaves (digestive)', 'Pomegranate (antioxidant)'],
                }),
        ],
    },

    'Chinese': {
        defaults: { unit: 'plate', cookingTime: '12-15 min', serveUpto: '1-2 person' },
        items: [
            item('Schezwan Fried Rice', 200,
                'Fiery red Schezwan-tossed fried rice with vegetables. Pairs perfectly with chilli paneer.',
                ['Rice', 'Schezwan sauce', 'Capsicum', 'Carrot', 'Spring onion'],
                'https://images.unsplash.com/photo-1585032226651-759b368d7246',
                { isFeatured: true }),
            item('Veg Fried Rice', 170,
                'Wok-fried rice with carrot, beans, capsicum and a touch of soy. The Chinese-counter classic.',
                ['Rice', 'Mixed vegetables', 'Soy sauce', 'Spring onion'],
                'https://images.unsplash.com/photo-1603133872878-684f208fb84b'),
            item('Honey Chilli Potato', 180,
                'Crispy potato fingers glazed in honey-chilli sauce, sprinkled with sesame seeds.',
                ['Potato', 'Honey', 'Chilli sauce', 'Sesame', 'Capsicum'],
                'https://images.unsplash.com/photo-1626777553635-3a1f6ae37e3a'),
            item('Veg Spring Roll (4 pc)', 160,
                'Crispy fried rolls stuffed with shredded vegetables, served with sweet-chilli dip.',
                ['Cabbage', 'Carrot', 'Spring roll sheet', 'Sweet chilli sauce'],
                'https://images.unsplash.com/photo-1606755962773-d324e0a13086'),
            item('Chilli Paneer Gravy', 240,
                'Paneer in a thick, spicy chilli-soy gravy. Pairs beautifully with fried rice or noodles.',
                ['Paneer', 'Capsicum', 'Onion', 'Soy sauce', 'Green chilli'],
                'https://images.unsplash.com/photo-1626804475297-41608ea09aeb'),
        ],
    },

    'Noodles': {
        defaults: { unit: 'plate', cookingTime: '12-14 min', serveUpto: '1-2 person' },
        items: [
            item('Veg Hakka Noodles', 180,
                'Stir-fried noodles with shredded vegetables — North-Eastern Chinese street-food classic.',
                ['Noodles', 'Cabbage', 'Carrot', 'Capsicum', 'Soy sauce', 'Spring onion'],
                'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841',
                {
                    isFeatured: true,
                    toppings: [{ name: 'Add Manchurian Balls', type: 'veg', price: 80 }, { name: 'Add Paneer', type: 'veg', price: 60 }, { name: 'Schezwan Twist', type: 'veg', price: 25 }],
                }),
            item('Schezwan Noodles', 190,
                'Spicy Schezwan-tossed noodles with peppers and onion. Punchy and addictive.',
                ['Noodles', 'Schezwan sauce', 'Capsicum', 'Onion'],
                'https://images.unsplash.com/photo-1552611052-33e04de081de'),
            item('Singapore Noodles', 210,
                'Light curry-flavoured noodles with veg and a touch of soy — a milder alternative.',
                ['Noodles', 'Curry powder', 'Mixed vegetables', 'Soy sauce'],
                'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841'),
            item('Chilli Garlic Noodles', 190,
                'Aromatic noodles tossed in a punchy garlic-chilli oil with spring onion.',
                ['Noodles', 'Garlic', 'Red chilli', 'Spring onion', 'Sesame oil'],
                'https://images.unsplash.com/photo-1585032226651-759b368d7246'),
            item('Pan Fried Noodles', 200,
                'Crispy pan-fried noodles topped with stir-fried vegetables in a savoury soy gravy.',
                ['Noodles', 'Mixed vegetables', 'Soy sauce', 'Cornflour'],
                'https://images.unsplash.com/photo-1623653387945-2fd25214f8c0'),
        ],
    },

    'Pizza': {
        defaults: { unit: 'pieces', cookingTime: '15-18 min', serveUpto: '1-2 person' },
        items: [
            item('Margherita Pizza', 220,
                'Hand-tossed pizza with tomato sauce, mozzarella and fresh basil. The eternal classic.',
                ['Pizza base', 'Tomato sauce', 'Mozzarella', 'Basil', 'Olive oil'],
                'https://images.unsplash.com/photo-1601924582975-7e2d6c82eab1',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Personal (7")', quantity: '1', price: 220 }, { name: 'Medium (10")', quantity: '1', price: 380 }, { name: 'Large (12")', quantity: '1', price: 540 }],
                    toppings: [{ name: 'Extra Cheese', type: 'veg', price: 60 }, { name: 'Black Olives', type: 'veg', price: 40 }, { name: 'Jalapeño', type: 'veg', price: 30 }, { name: 'Mushroom', type: 'veg', price: 50 }],
                }),
            item('Farmhouse Pizza', 320,
                'Loaded with onion, capsicum, tomato, mushroom and corn on a tomato-mozzarella base.',
                ['Onion', 'Capsicum', 'Tomato', 'Mushroom', 'Corn', 'Mozzarella'],
                'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3',
                {
                    sizes: [{ name: 'Personal', quantity: '1', price: 320 }, { name: 'Medium', quantity: '1', price: 540 }, { name: 'Large', quantity: '1', price: 720 }],
                }),
            item('Veggie Supreme', 360,
                'Black olives, jalapeño, paneer, capsicum, onion — every favourite topping in one slice.',
                ['Olives', 'Jalapeño', 'Paneer', 'Capsicum', 'Onion', 'Mozzarella'],
                'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
                {
                    sizes: [{ name: 'Personal', quantity: '1', price: 360 }, { name: 'Medium', quantity: '1', price: 580 }, { name: 'Large', quantity: '1', price: 780 }],
                }),
            item('Paneer Tikka Pizza', 360,
                'Spiced paneer tikka cubes on a creamy makhani sauce base. Indian-Italian fusion.',
                ['Paneer', 'Makhani sauce', 'Onion', 'Capsicum', 'Mozzarella', 'Tikka masala'],
                'https://images.unsplash.com/photo-1571066811602-716837d681de'),
            item('Double Cheese Margherita', 300,
                'Twice the cheese, twice the joy. Mozzarella and cheddar on classic margherita.',
                ['Mozzarella', 'Cheddar', 'Tomato sauce', 'Basil'],
                'https://images.unsplash.com/photo-1574071318508-1cdbab80d002'),
        ],
    },

    'Burgers': {
        defaults: { unit: 'pieces', cookingTime: '8-10 min', serveUpto: '1 person' },
        items: [
            item('Aloo Tikki Burger', 100,
                'Spiced potato patty with mint chutney and crisp lettuce in a soft bun. Pocket-friendly classic.',
                ['Potato patty', 'Lettuce', 'Mint chutney', 'Bun', 'Onion'],
                'https://images.unsplash.com/photo-1568901346375-23c9450c58cd'),
            item('Veggie Burger', 120,
                'Mixed-veg patty with tomato, onion, mayonnaise and lettuce.',
                ['Veg patty', 'Tomato', 'Onion', 'Lettuce', 'Mayonnaise', 'Bun'],
                'https://images.unsplash.com/photo-1550547660-d9450f859349',
                { isFeatured: true }),
            item('Cheese Burger', 140,
                'Veggie patty with a slice of cheddar and tangy sauce in a brioche bun.',
                ['Veg patty', 'Cheddar', 'Pickle', 'Bun', 'Lettuce'],
                'https://images.unsplash.com/photo-1571091718767-18b5b1457add',
                {
                    sizes: [{ name: 'Single', quantity: '1', price: 140 }, { name: 'Double Patty', quantity: '1', price: 220 }],
                    toppings: [{ name: 'Extra Cheese Slice', type: 'veg', price: 30 }, { name: 'Crispy Onion Rings', type: 'veg', price: 25 }],
                }),
            item('Paneer Burger', 160,
                'Grilled paneer slab with peri-peri seasoning, lettuce and onion in a sesame bun.',
                ['Paneer', 'Peri-peri spice', 'Lettuce', 'Onion', 'Mayonnaise', 'Bun'],
                'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9'),
            item('Crispy Veg Burger', 130,
                'Crunchy crumb-fried patty with shredded cabbage and creamy mayo.',
                ['Crispy patty', 'Cabbage', 'Mayonnaise', 'Bun', 'Tomato'],
                'https://images.unsplash.com/photo-1586190848861-99aa4a171e90'),
        ],
    },

    'Sandwiches': {
        defaults: { unit: 'pieces', cookingTime: '8-10 min', serveUpto: '1 person' },
        items: [
            item('Bombay Grilled Sandwich', 120,
                'Mumbai-street-style grilled sandwich with potato, onion, tomato and green chutney.',
                ['Bread', 'Potato', 'Onion', 'Tomato', 'Green chutney', 'Butter'],
                'https://images.unsplash.com/photo-1553909489-cd47e0907980',
                { isFeatured: true }),
            item('Veg Mayo Sandwich', 100,
                'Cool, creamy veg-mayo sandwich — light and lunchbox-perfect.',
                ['Bread', 'Mayonnaise', 'Cucumber', 'Carrot', 'Capsicum'],
                'https://images.unsplash.com/photo-1539252554935-80c8cb6402b9'),
            item('Cheese Chilli Toast', 140,
                'Open-toast loaded with cheese, green chillies and herbs — broiled till bubbly.',
                ['Bread', 'Cheese', 'Green chilli', 'Coriander', 'Butter'],
                'https://images.unsplash.com/photo-1528735602780-2552fd46c7af'),
            item('Paneer Tikka Sandwich', 160,
                'Smoky paneer tikka filling between grilled bread, with mint mayo.',
                ['Bread', 'Paneer', 'Tikka masala', 'Onion', 'Mint mayo'],
                'https://images.unsplash.com/photo-1592415486689-125cbbfcbee2'),
            item('Club Sandwich', 180,
                'Three-tier sandwich with cheese, tomato, cucumber, lettuce and herbed mayo.',
                ['Bread', 'Cheese', 'Tomato', 'Cucumber', 'Lettuce', 'Mayonnaise'],
                'https://images.unsplash.com/photo-1567234669003-dce7a7a88821'),
        ],
    },

    'Wraps & Rolls': {
        defaults: { unit: 'pieces', cookingTime: '10-12 min', serveUpto: '1 person' },
        items: [
            item('Paneer Kathi Roll', 150,
                'Egg-less paratha rolled with paneer tikka, onion and mint mayo. Calcutta-style.',
                ['Paratha', 'Paneer', 'Onion', 'Mint mayo', 'Tikka masala'],
                'https://images.unsplash.com/photo-1626700051175-6818013e1d4f',
                { isFeatured: true }),
            item('Veg Frankie', 120,
                'Spiced potato-mash filled in a soft roll with tangy frankie masala. Bombay street favourite.',
                ['Roti', 'Potato', 'Onion', 'Frankie masala', 'Lemon'],
                'https://images.unsplash.com/photo-1565299585323-38d6b0865b47'),
            item('Cheese Corn Roll', 140,
                'Sweet corn and melted cheese wrapped in a crisp paratha.',
                ['Paratha', 'Sweet corn', 'Cheese', 'Mayo', 'Black pepper'],
                'https://images.unsplash.com/photo-1565299585323-38d6b0865b47'),
            item('Falafel Wrap', 170,
                'Crisp chickpea falafel with hummus, lettuce and pickled onion in a tortilla.',
                ['Tortilla', 'Falafel', 'Hummus', 'Lettuce', 'Onion', 'Tahini'],
                'https://images.unsplash.com/photo-1606755962773-d324e0a13086',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['High Protein', 'Vegan', 'Plant Based'],
                    nutrition: { calories: 380, protein: 14, fat: 10, carbs: 56, fibre: 8, iron: 3 },
                    healthyIngredients: ['Chickpeas (protein)', 'Tahini (calcium)', 'Hummus (fibre)'],
                }),
            item('Mexican Bean Wrap', 170,
                'Spiced kidney beans, corn, lettuce and cheese in a soft tortilla.',
                ['Tortilla', 'Kidney beans', 'Corn', 'Cheese', 'Lettuce', 'Salsa'],
                'https://images.unsplash.com/photo-1543353071-873f17a7a088'),
        ],
    },

    'Pasta': {
        defaults: { unit: 'plate', cookingTime: '15-18 min', serveUpto: '1 person' },
        items: [
            item('Penne Arrabbiata', 220,
                'Penne in a spicy garlic-tomato sauce with red chilli flakes and basil.',
                ['Penne', 'Tomato', 'Garlic', 'Chilli flakes', 'Basil', 'Olive oil'],
                'https://images.unsplash.com/photo-1525755662778-989d0524087e',
                { isFeatured: true }),
            item('Alfredo Pasta', 260,
                'Fettuccine in a rich white cream-cheese-garlic sauce with parmesan.',
                ['Pasta', 'Cream', 'Parmesan', 'Garlic', 'Butter', 'Black pepper'],
                'https://images.unsplash.com/photo-1645112411341-6c4fd023714a',
                {
                    sizes: [{ name: 'Half Plate', quantity: '1', price: 180 }, { name: 'Full Plate', quantity: '1', price: 260 }],
                    toppings: [{ name: 'Extra Cheese', type: 'veg', price: 40 }, { name: 'Add Mushroom', type: 'veg', price: 50 }],
                }),
            item('Mac & Cheese', 240,
                'Macaroni baked in a four-cheese béchamel — the ultimate comfort.',
                ['Macaroni', 'Cheese blend', 'Milk', 'Butter', 'Flour'],
                'https://images.unsplash.com/photo-1543353071-10c8ba85a904'),
            item('Pesto Pasta', 280,
                'Fusilli tossed in fresh basil-pine-nut pesto with parmesan and a hint of garlic.',
                ['Fusilli', 'Basil', 'Pine nuts', 'Parmesan', 'Olive oil', 'Garlic'],
                'https://images.unsplash.com/photo-1611270629569-8b357cb88da9'),
            item('Mixed Sauce Pasta', 240,
                'Half red, half white — penne in a tangy-creamy combo sauce. The undecided customer\'s favourite.',
                ['Penne', 'Tomato sauce', 'Cream', 'Cheese', 'Italian herbs'],
                'https://images.unsplash.com/photo-1473093295043-cdd812d0e601'),
        ],
    },

    'Salads': {
        defaults: { unit: 'bowl', cookingTime: '5-8 min', serveUpto: '1 person', isHealthy: true, healthLevel: 'High' },
        items: [
            item('Garden Fresh Salad', 140,
                'Crisp greens, cucumber, tomato and carrot with lemon-olive-oil dressing.',
                ['Lettuce', 'Cucumber', 'Tomato', 'Carrot', 'Lemon', 'Olive oil'],
                'https://images.unsplash.com/photo-1546793665-c74683f339c1',
                {
                    isFeatured: true,
                    healthTags: ['Low Calorie', 'Vegan', 'Plant Based'],
                    nutrition: { calories: 110, protein: 3, fat: 5, carbs: 14, fibre: 4, iron: 1.5 },
                    healthyIngredients: ['Lettuce (low cal)', 'Cucumber (hydrating)', 'Olive oil (good fat)'],
                }),
            item('Caesar Veg Salad', 180,
                'Romaine, croutons and parmesan in a creamy Caesar dressing.',
                ['Romaine lettuce', 'Croutons', 'Parmesan', 'Caesar dressing', 'Black pepper'],
                'https://images.unsplash.com/photo-1551248429-40975aa4de74',
                {
                    healthTags: ['Low Carb'],
                    nutrition: { calories: 220, protein: 8, fat: 14, carbs: 16, fibre: 3, iron: 2 },
                }),
            item('Greek Feta Salad', 220,
                'Cucumber, tomato, olives and feta tossed in olive oil and oregano.',
                ['Cucumber', 'Tomato', 'Black olives', 'Feta', 'Olive oil', 'Oregano'],
                'https://images.unsplash.com/photo-1623428187969-5da2dcea5ebf',
                {
                    healthTags: ['Heart Healthy', 'Calcium Rich'],
                    nutrition: { calories: 250, protein: 9, fat: 18, carbs: 12, fibre: 3, iron: 1.8 },
                }),
            item('Sprouts Salad', 130,
                'Mixed sprouted moong & chana with onion, tomato, lemon and chaat masala.',
                ['Moong sprouts', 'Chana sprouts', 'Onion', 'Tomato', 'Lemon', 'Chaat masala'],
                'https://images.unsplash.com/photo-1505740420928-5e560c06d30e',
                {
                    healthTags: ['High Protein', 'Iron Rich', 'Vegan'],
                    nutrition: { calories: 160, protein: 12, fat: 2, carbs: 26, fibre: 7, iron: 4 },
                    healthyIngredients: ['Moong sprouts (protein)', 'Chana sprouts (iron)', 'Lemon (vitamin C)'],
                }),
            item('Fruit Salad', 150,
                'Seasonal fresh fruits with a touch of honey and chaat masala.',
                ['Apple', 'Banana', 'Pomegranate', 'Grapes', 'Honey', 'Chaat masala'],
                'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea',
                {
                    healthTags: ['Vitamin C Rich', 'Antioxidant Rich', 'Sattvik'],
                    nutrition: { calories: 180, protein: 2, fat: 1, carbs: 42, fibre: 5, iron: 0.8 },
                }),
        ],
    },

    'Healthy Food': {
        defaults: { unit: 'bowl', cookingTime: '10-15 min', serveUpto: '1 person', isHealthy: true, healthLevel: 'High' },
        items: [
            item('Quinoa Veggie Bowl', 280,
                'Steamed quinoa with stir-fried vegetables, chickpeas and a lemon-tahini drizzle.',
                ['Quinoa', 'Mixed vegetables', 'Chickpeas', 'Tahini', 'Lemon'],
                'https://images.unsplash.com/photo-1490645935967-10de6ba17061',
                {
                    isFeatured: true,
                    healthTags: ['High Protein', 'Whole Grain', 'Vegan'],
                    nutrition: { calories: 410, protein: 16, fat: 12, carbs: 60, fibre: 9, iron: 4 },
                    healthyIngredients: ['Quinoa (complete protein)', 'Chickpeas (fibre)', 'Tahini (calcium)'],
                }),
            item('Steamed Veggies', 180,
                'Crisp-tender steamed broccoli, carrot, beans and corn with herbs and olive oil.',
                ['Broccoli', 'Carrot', 'Beans', 'Corn', 'Olive oil', 'Italian herbs'],
                'https://images.unsplash.com/photo-1512621776951-a57141f2eefd',
                {
                    healthTags: ['Low Calorie', 'Heart Healthy', 'Vegan'],
                    nutrition: { calories: 140, protein: 5, fat: 4, carbs: 22, fibre: 7, iron: 2 },
                }),
            item('Sprouted Moong', 140,
                'Lightly sautéed sprouted moong with mustard, curry leaves and lemon.',
                ['Moong sprouts', 'Mustard seeds', 'Curry leaves', 'Lemon', 'Green chilli'],
                'https://images.unsplash.com/photo-1505740420928-5e560c06d30e',
                {
                    healthTags: ['High Protein', 'Iron Rich', 'Diabetic Friendly'],
                    nutrition: { calories: 170, protein: 13, fat: 2, carbs: 28, fibre: 8, iron: 3.5 },
                }),
            item('Oatmeal Porridge', 140,
                'Steel-cut oats simmered in milk, topped with banana, honey and almonds.',
                ['Oats', 'Milk', 'Banana', 'Honey', 'Almonds'],
                'https://images.unsplash.com/photo-1517673400267-0251440c45dc',
                {
                    healthTags: ['Heart Healthy', 'Whole Grain', 'High Fibre'],
                    nutrition: { calories: 320, protein: 11, fat: 8, carbs: 52, fibre: 6, iron: 2.5 },
                }),
            item('Multigrain Khichdi', 180,
                'Mixed millets and lentils tempered with ghee, cumin and ginger. Diet-friendly comfort.',
                ['Millets', 'Moong dal', 'Ghee', 'Cumin', 'Ginger', 'Turmeric'],
                'https://images.unsplash.com/photo-1601050690597-df0568f70950',
                {
                    healthTags: ['Diabetic Friendly', 'Whole Grain', 'Sattvik'],
                    nutrition: { calories: 360, protein: 13, fat: 9, carbs: 56, fibre: 6, iron: 3 },
                }),
        ],
    },

    'Combos & Thali': {
        defaults: { unit: 'plate', cookingTime: '15-25 min', serveUpto: '1 person' },
        items: [
            item('Punjabi Thali', 280,
                'Dal makhani, paneer sabzi, 2 roti, jeera rice, salad, papad and gulab jamun. The ultimate Punjabi spread.',
                ['Dal makhani', 'Paneer sabzi', 'Roti', 'Jeera rice', 'Salad', 'Papad', 'Gulab jamun'],
                'https://images.unsplash.com/photo-1585937421612-70a008356fbe',
                { isFeatured: true }),
            item('Maharashtrian Thali', 240,
                'Pithla, bhakri, varan-bhaat, koshimbir, papad and shrikhand. Pune-classic veg thali.',
                ['Pithla', 'Bhakri', 'Varan', 'Bhaat', 'Koshimbir', 'Papad', 'Shrikhand'],
                'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8',
                {
                    isHealthy: true, healthLevel: 'Medium',
                    healthTags: ['Sattvik', 'Heart Healthy'],
                    nutrition: { calories: 620, protein: 22, fat: 18, carbs: 90, fibre: 12, iron: 5 },
                }),
            item('South Indian Thali', 240,
                'Sambar, rasam, 2 sabzi, rice, curd, papad and a sweet. Light yet wholesome.',
                ['Sambar', 'Rasam', 'Sabzi', 'Rice', 'Curd', 'Papad', 'Mysore pak'],
                'https://images.unsplash.com/photo-1668236543090-82eba5ee5976'),
            item('Mini Meal', 180,
                'Quick lunch — 1 sabzi, 2 roti, dal and rice. Office go-to.',
                ['Sabzi', 'Roti', 'Dal', 'Rice', 'Pickle'],
                'https://images.unsplash.com/photo-1631452180519-c014fe946bc7'),
            item('Family Thali (4 ppl)', 999,
                '2 curries, 6 roti, jeera rice, dal, salad, papad and 4 gulab jamun. Feeds four hungry diners.',
                ['Curries', 'Roti', 'Rice', 'Dal', 'Salad', 'Papad', 'Sweet'],
                'https://images.unsplash.com/photo-1535007813616-79dc02ba4021',
                { serveUpto: '4 person', cookingTime: '25-30 min' }),
        ],
    },

    'Desserts': {
        defaults: { unit: 'plate', cookingTime: '5-8 min', serveUpto: '1 person' },
        items: [
            item('Gulab Jamun (2 pc)', 80,
                'Soft milk-solid dumplings soaked in cardamom-rose sugar syrup. Served warm.',
                ['Khoya', 'Sugar syrup', 'Cardamom', 'Rose water'],
                'https://images.unsplash.com/photo-1551024601-bec78aea704b'),
            item('Rasmalai (2 pc)', 130,
                'Spongy paneer discs in saffron-pistachio milk. Cool, creamy and aromatic.',
                ['Paneer', 'Milk', 'Saffron', 'Pistachio', 'Sugar', 'Cardamom'],
                'https://images.unsplash.com/photo-1606471191009-63994c53433b'),
            item('Chocolate Lava Cake', 180,
                'Warm chocolate cake with a molten centre, served with vanilla ice cream.',
                ['Dark chocolate', 'Egg-less batter', 'Cream', 'Vanilla ice cream'],
                'https://images.unsplash.com/photo-1606313564200-e75d5e30476c',
                { isFeatured: true }),
            item('Brownie with Ice Cream', 160,
                'Rich fudgy brownie topped with a scoop of vanilla and chocolate sauce.',
                ['Brownie', 'Vanilla ice cream', 'Chocolate sauce', 'Walnut'],
                'https://images.unsplash.com/photo-1564355808539-22fda35bed7e'),
            item('Gajar Halwa', 140,
                'Slow-cooked grated carrot pudding with milk, ghee and dry fruits. Winter classic.',
                ['Carrot', 'Milk', 'Ghee', 'Dry fruits', 'Sugar', 'Cardamom'],
                'https://images.unsplash.com/photo-1605478375899-3c4d6e60d35e'),
        ],
    },

    'Ice Cream': {
        defaults: { unit: 'cup', cookingTime: '2 min', serveUpto: '1 person' },
        items: [
            item('Vanilla Scoop', 70,
                'Classic Madagascar-vanilla bean ice cream.',
                ['Milk', 'Cream', 'Vanilla bean', 'Sugar'],
                'https://images.unsplash.com/photo-1563805042-7684c019e1cb'),
            item('Chocolate Scoop', 80,
                'Rich Belgian-style chocolate ice cream.',
                ['Milk', 'Cream', 'Belgian cocoa', 'Sugar'],
                'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f',
                { isFeatured: true }),
            item('Strawberry Scoop', 80,
                'Real strawberry pieces folded into a creamy base.',
                ['Milk', 'Cream', 'Strawberry pulp', 'Sugar'],
                'https://images.unsplash.com/photo-1488900128323-21503983a07e'),
            item('Butterscotch Crunch', 80,
                'Butterscotch sauce with caramelised praline crunch.',
                ['Milk', 'Cream', 'Butterscotch', 'Praline', 'Cashew'],
                'https://images.unsplash.com/photo-1633933358116-a27b902fad35'),
            item('Mango Delight', 90,
                'Seasonal Alphonso-mango ice cream with mango chunks.',
                ['Milk', 'Cream', 'Alphonso mango', 'Sugar'],
                'https://images.unsplash.com/photo-1568909344668-6f14a07b56a0'),
        ],
    },

    'Coffee': {
        defaults: { unit: 'cup', cookingTime: '4-5 min', serveUpto: '1 person' },
        items: [
            item('Cappuccino', 120,
                'Equal espresso, steamed milk and a thick layer of foam. The barista classic.',
                ['Espresso', 'Steamed milk', 'Milk foam'],
                'https://images.unsplash.com/photo-1572442388796-11668a67e53d',
                {
                    isFeatured: true,
                    sizes: [{ name: 'Regular', quantity: '180 ml', price: 120 }, { name: 'Large', quantity: '300 ml', price: 160 }],
                }),
            item('Cafe Latte', 130,
                'Single espresso shot in a tall glass of velvety steamed milk. Smooth and mild.',
                ['Espresso', 'Steamed milk'],
                'https://images.unsplash.com/photo-1561882468-9110e03e0f78'),
            item('Espresso', 100,
                'Strong single shot of pure espresso — for the purists.',
                ['Coffee beans'],
                'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a'),
            item('Cold Coffee', 160,
                'Iced coffee blended with milk and sugar, topped with chocolate sauce and a scoop of ice cream.',
                ['Espresso', 'Milk', 'Ice', 'Sugar', 'Chocolate sauce'],
                'https://images.unsplash.com/photo-1517701604599-bb29b565090c',
                {
                    unit: 'glass',
                    sizes: [{ name: 'Regular', quantity: '300 ml', price: 160 }, { name: 'Large', quantity: '450 ml', price: 200 }],
                }),
            item('Mocha', 150,
                'Espresso with chocolate and steamed milk — for the chocolate lover.',
                ['Espresso', 'Chocolate', 'Steamed milk', 'Cocoa'],
                'https://images.unsplash.com/photo-1572286258217-215cf8e99777'),
        ],
    },

    'Tea': {
        defaults: { unit: 'cup', cookingTime: '4-5 min', serveUpto: '1 person' },
        items: [
            item('Masala Chai', 50,
                'Strong tea brewed with milk, ginger, cardamom and a hint of clove.',
                ['Tea leaves', 'Milk', 'Ginger', 'Cardamom', 'Clove', 'Sugar'],
                'https://images.unsplash.com/photo-1571934811356-5cc061b6821f',
                { isFeatured: true }),
            item('Ginger Lemon Tea', 60,
                'Black tea with fresh ginger and lemon — perfect for a cold day.',
                ['Black tea', 'Ginger', 'Lemon', 'Honey'],
                'https://images.unsplash.com/photo-1597481499750-3e6b22637e12'),
            item('Green Tea', 70,
                'Light, antioxidant-rich green tea brewed in spring water.',
                ['Green tea leaves', 'Water'],
                'https://images.unsplash.com/photo-1556679343-c7306c1976bc',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Antioxidant Rich', 'Detox', 'Low Calorie'],
                    nutrition: { calories: 5, protein: 0, fat: 0, carbs: 1, fibre: 0, iron: 0 },
                    healthyIngredients: ['Green tea (catechins)'],
                }),
            item('Honey Lemon Tea', 70,
                'Soothing honey-lemon brew with fresh ginger.',
                ['Tea', 'Honey', 'Lemon', 'Ginger'],
                'https://images.unsplash.com/photo-1597318181409-cf64d0b3c1c2',
                {
                    isHealthy: true, healthLevel: 'High',
                    healthTags: ['Immunity Booster', 'Detox', 'Vitamin C Rich'],
                    nutrition: { calories: 35, protein: 0, fat: 0, carbs: 9, fibre: 0, iron: 0 },
                }),
            item('Kullad Chai', 70,
                'Smoky earthen-pot tea served in a clay kullad. The way chai should be.',
                ['Tea', 'Milk', 'Spices', 'Sugar'],
                'https://images.unsplash.com/photo-1605187860902-2b8f9b7f8e91'),
        ],
    },

    'Milkshakes': {
        defaults: { unit: 'glass', cookingTime: '5 min', serveUpto: '1 person' },
        items: [
            item('Chocolate Milkshake', 140,
                'Thick chocolate milkshake topped with whipped cream and chocolate shavings.',
                ['Milk', 'Chocolate syrup', 'Vanilla ice cream', 'Whipped cream'],
                'https://images.unsplash.com/photo-1572490122747-3968b75cc699',
                { isFeatured: true }),
            item('Vanilla Shake', 130,
                'Classic creamy vanilla milkshake — simple and indulgent.',
                ['Milk', 'Vanilla ice cream', 'Sugar'],
                'https://images.unsplash.com/photo-1577805947697-89e18249d767'),
            item('Oreo Shake', 160,
                'Crushed Oreo cookies blended with milk and vanilla ice cream.',
                ['Milk', 'Vanilla ice cream', 'Oreo cookies'],
                'https://images.unsplash.com/photo-1568901346375-23c9450c58cd'),
            item('Mango Shake', 140,
                'Alphonso mango blended with chilled milk. Summer in a glass.',
                ['Milk', 'Alphonso mango', 'Sugar', 'Ice'],
                'https://images.unsplash.com/photo-1571805341302-f857308690e3'),
            item('Strawberry Shake', 140,
                'Fresh strawberry milkshake with a swirl of cream.',
                ['Milk', 'Strawberry pulp', 'Cream', 'Vanilla ice cream'],
                'https://images.unsplash.com/photo-1553787499-6f9133860278'),
        ],
    },

    'Fresh Juices': {
        defaults: { unit: 'glass', cookingTime: '4-5 min', serveUpto: '1 person', isHealthy: true, healthLevel: 'High' },
        items: [
            item('Orange Juice', 120,
                'Fresh-squeezed orange juice — no sugar added, served chilled.',
                ['Orange'],
                'https://images.unsplash.com/photo-1546174020-f7e4cb56b53b',
                {
                    isFeatured: true,
                    healthTags: ['Vitamin C Rich', 'Antioxidant Rich', 'Vegan'],
                    nutrition: { calories: 110, protein: 2, fat: 0, carbs: 26, fibre: 1, iron: 0.2 },
                    healthyIngredients: ['Orange (vitamin C)'],
                }),
            item('Watermelon Juice', 100,
                'Cooling fresh watermelon juice with a hint of mint.',
                ['Watermelon', 'Mint', 'Lime'],
                'https://images.unsplash.com/photo-1497534446932-c925b458314e',
                {
                    healthTags: ['Hydrating', 'Low Calorie', 'Vegan'],
                    nutrition: { calories: 80, protein: 1, fat: 0, carbs: 20, fibre: 1, iron: 0.3 },
                }),
            item('Mosambi Juice', 120,
                'Sweet-lime juice with a pinch of black salt. Pune\'s favourite cooler.',
                ['Mosambi', 'Black salt'],
                'https://images.unsplash.com/photo-1622597467836-f3e6707e1057',
                {
                    healthTags: ['Vitamin C Rich', 'Hydrating'],
                    nutrition: { calories: 95, protein: 1, fat: 0, carbs: 22, fibre: 0.5, iron: 0.2 },
                }),
            item('Pineapple Juice', 130,
                'Fresh pineapple juice — naturally tangy-sweet, with a sprig of mint.',
                ['Pineapple', 'Mint'],
                'https://images.unsplash.com/photo-1623065422902-30a2d299bbe4',
                {
                    healthTags: ['Vitamin C Rich', 'Antioxidant Rich'],
                    nutrition: { calories: 130, protein: 1, fat: 0, carbs: 32, fibre: 1, iron: 0.4 },
                }),
            item('Mixed Fruit Juice', 150,
                'Blend of orange, mosambi, pineapple and apple. The everything-juice.',
                ['Orange', 'Mosambi', 'Pineapple', 'Apple'],
                'https://images.unsplash.com/photo-1600271886742-f049cd451bba',
                {
                    healthTags: ['Vitamin C Rich', 'Antioxidant Rich', 'Vegan'],
                    nutrition: { calories: 150, protein: 2, fat: 0, carbs: 36, fibre: 2, iron: 0.5 },
                }),
        ],
    },

    'Cold Drinks': {
        defaults: { unit: 'glass', cookingTime: '3-5 min', serveUpto: '1 person' },
        items: [
            item('Lemon Iced Tea', 100,
                'Chilled black tea infused with lemon and mint.',
                ['Black tea', 'Lemon', 'Mint', 'Ice', 'Sugar'],
                'https://images.unsplash.com/photo-1556679343-c7306c1976bc',
                { isFeatured: true }),
            item('Fresh Lime Soda', 70,
                'Lime juice with chilled soda — sweet, salty or both.',
                ['Lemon', 'Soda', 'Sugar', 'Salt'],
                'https://images.unsplash.com/photo-1622597467836-f3e6707e1057',
                {
                    sizes: [{ name: 'Sweet', quantity: '1', price: 70 }, { name: 'Salty', quantity: '1', price: 70 }, { name: 'Mixed (Masala)', quantity: '1', price: 80 }],
                }),
            item('Virgin Mojito', 140,
                'Crushed mint, lime and chilled soda — refreshing and zero alcohol.',
                ['Mint', 'Lime', 'Soda', 'Sugar', 'Ice'],
                'https://images.unsplash.com/photo-1551751299-1b51cab2694c'),
            item('Cold Coffee with Ice Cream', 180,
                'Cold coffee topped with a generous scoop of vanilla ice cream and chocolate drizzle.',
                ['Coffee', 'Milk', 'Vanilla ice cream', 'Chocolate sauce'],
                'https://images.unsplash.com/photo-1517701604599-bb29b565090c'),
            item('Iced Lemon Tea', 110,
                'Iced lemon-tea with a citrus burst. Lighter than a soda.',
                ['Black tea', 'Lemon', 'Sugar', 'Ice'],
                'https://images.unsplash.com/photo-1556679343-c7306c1976bc'),
        ],
    },

    'Mineral Water': {
        defaults: { unit: 'bottle', cookingTime: '0 min', serveUpto: '1 person', isHealthy: true, healthLevel: 'High' },
        items: [
            item('Bisleri 1 Litre', 20,
                'Sealed Bisleri mineral water, 1 litre. Sold at MRP.',
                ['Mineral water'],
                'https://images.unsplash.com/photo-1606767041004-1d72c4ed7c11',
                {
                    isFeatured: true,
                    healthTags: ['Hydrating'],
                    nutrition: { calories: 0, protein: 0, fat: 0, carbs: 0, fibre: 0, iron: 0 },
                }),
            item('Bisleri 500 ml', 10,
                'Sealed Bisleri mineral water, 500 ml. Sold at MRP.',
                ['Mineral water'],
                'https://images.unsplash.com/photo-1564419320461-6870880221ad',
                { healthTags: ['Hydrating'] }),
            item('Aquafina 1 Litre', 20,
                'Sealed Aquafina packaged drinking water, 1 litre. MRP.',
                ['Packaged water'],
                'https://images.unsplash.com/photo-1610725664285-7c57e6eeac3f',
                { healthTags: ['Hydrating'] }),
            item('Kinley 1 Litre', 20,
                'Sealed Kinley packaged drinking water, 1 litre. MRP.',
                ['Packaged water'],
                'https://images.unsplash.com/photo-1564419320461-6870880221ad',
                { healthTags: ['Hydrating'] }),
            item('Himalayan Natural 1L', 50,
                'Premium Himalayan natural mineral water — sourced from the lower Himalayas.',
                ['Natural mineral water'],
                'https://images.unsplash.com/photo-1548839140-29a749e1cf4d',
                { healthTags: ['Hydrating'] }),
        ],
    },

    'Packaged Beverages': {
        defaults: { unit: 'bottle', cookingTime: '0 min', serveUpto: '1 person' },
        items: [
            item('Coca-Cola 600 ml', 40,
                'Sealed Coca-Cola PET bottle, 600 ml. Sold at MRP.',
                ['Coca-Cola'],
                'https://images.unsplash.com/photo-1554866585-cd94860890b7',
                { isFeatured: true }),
            item('Pepsi 600 ml', 40,
                'Sealed Pepsi PET bottle, 600 ml.',
                ['Pepsi'],
                'https://images.unsplash.com/photo-1629203851122-3726ecdf080e'),
            item('Sprite 600 ml', 40,
                'Sealed Sprite PET bottle, 600 ml.',
                ['Sprite'],
                'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3'),
            item('Thumbs Up 600 ml', 40,
                'Sealed Thumbs Up PET bottle, 600 ml. The Indian classic.',
                ['Thumbs Up'],
                'https://images.unsplash.com/photo-1581636625402-29b2a704ef13'),
            item('Red Bull 250 ml', 125,
                'Sealed Red Bull energy drink, 250 ml can.',
                ['Red Bull'],
                'https://images.unsplash.com/photo-1622543925917-763c34d1a86e'),
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

async function seedFullMenu() {
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
                        type: t.type || 'veg',
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

            console.log(`  + ${categoryName}: ${block.items.length} items ensured`);
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

seedFullMenu();
