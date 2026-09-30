const mongoose = require('mongoose');
require('dotenv').config();
const Combo = require('./models/combo');
const MenuItem = require('./models/menuItem');
const Category = require('./models/category');

const comboThemes = [
    { name: 'Executive Lunch Platter', categories: ['Starters', 'Main Course', 'Desserts'] },
    { name: 'Happy Hour Snack Box', categories: ['Starters', 'Cold Drinks', 'Sandwich'] },
    { name: 'Italian Dinner for Two', categories: ['Pasta', 'Pizza', 'Salads'] },
    { name: 'Desi Feast Combo', categories: ['North Indian', 'Biryani', 'Desserts'] },
    { name: 'South Indian Breakfast', categories: ['South Indian', 'Coffee', 'Starters'] },
    { name: 'Healthy Morning Duo', categories: ['Healthy Food', 'Tea', 'Salads'] },
    { name: 'Movie Night Special', categories: ['Burger', 'Wraps', 'Cold Drinks'] },
    { name: 'Sweet & Chill Combo', categories: ['Desserts', 'Ice Cream', 'Milkshakes'] },
    { name: 'Oriental Express', categories: ['Chinese', 'Noodles', 'Starters'] },
    { name: 'The Sandwich Club', categories: ['Sandwich', 'Coffee', 'Milkshakes'] }
];

const descriptions = [
    'A perfectly balanced selection across our top categories.',
    'Carefully curated to give you a taste of everything you love.',
    'The ultimate value meal with handpicked items from our chef.',
    'Deliciously picked items grouped into a satisfying multi-course experience.',
    'Great taste, even better savings. The ultimate multi-item deal for you!'
];

const images = [
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
    'https://images.unsplash.com/photo-1513104890138-7c749659a591',
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
    'https://images.unsplash.com/photo-1567620905732-2d1ec7bb7445',
    'https://images.unsplash.com/photo-1484723088339-323833995221'
];

const seedCombos = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB for Multi-Category Combo seeding...');

        // 1. Fetch available menu items and categories
        const menuItems = await MenuItem.find({}).populate('category');
        const categories = await Category.find({});

        if (menuItems.length < 10) {
            console.log('Not enough menu items to create realistic combos. Please seed menu items first.');
            process.exit(1);
        }

        // 2. Group items by Category Name for easy picking
        const itemsByCategory = {};
        menuItems.forEach(item => {
            const catName = item.category?.name || 'Uncategorized';
            if (!itemsByCategory[catName]) itemsByCategory[catName] = [];
            itemsByCategory[catName].push(item);
        });

        // 3. Clear existing combos
        await Combo.deleteMany({});
        console.log('Cleared existing combos.');

        const combosToInsert = [];

        for (let i = 0; i < 50; i++) {
            const theme = comboThemes[i % comboThemes.length];
            const description = descriptions[i % descriptions.length];
            const serveUpto = ['1-2 person', '2-3 person', '4-6 person'][Math.floor(Math.random() * 3)];
            
            const comboCategories = [];
            let originalPrice = 0;
            let isAllVeg = true;

            // Pick 1 item from each category in the theme
            theme.categories.forEach(catName => {
                const availableItems = itemsByCategory[catName] || [];
                if (availableItems.length > 0) {
                    // Pick 1 or 2 items from this category
                    const numToPick = Math.random() > 0.7 ? 2 : 1;
                    const itemsInCat = [];
                    
                    for (let k = 0; k < numToPick; k++) {
                        const randomItem = availableItems[Math.floor(Math.random() * availableItems.length)];
                        itemsInCat.push({
                            menuItemId: randomItem._id,
                            name: randomItem.name,
                            price: randomItem.basePrice,
                            isVeg: randomItem.vegType === 'veg'
                        });
                        originalPrice += randomItem.basePrice;
                        if (randomItem.vegType !== 'veg') isAllVeg = false;
                    }

                    comboCategories.push({
                        name: catName,
                        items: itemsInCat
                    });
                }
            });

            // If some categories from theme were missing items, pick from random available categories
            if (comboCategories.length < 2) {
                const randomCatNames = Object.keys(itemsByCategory).filter(cn => !theme.categories.includes(cn));
                const extraCatName = randomCatNames[Math.floor(Math.random() * randomCatNames.length)];
                const extraItems = itemsByCategory[extraCatName] || [];
                if (extraItems.length > 0) {
                    const randomItem = extraItems[Math.floor(Math.random() * extraItems.length)];
                    comboCategories.push({
                        name: extraCatName,
                        items: [{
                            menuItemId: randomItem._id,
                            name: randomItem.name,
                            price: randomItem.basePrice,
                            isVeg: randomItem.vegType === 'veg'
                        }]
                    });
                    originalPrice += randomItem.basePrice;
                    if (randomItem.vegType !== 'veg') isAllVeg = false;
                }
            }

            const discount = Math.floor(Math.random() * 15) + 10; // 10% to 25% discount
            const price = Math.round(originalPrice * (1 - discount / 100));
            const savings = originalPrice - price;

            combosToInsert.push({
                name: i < 10 ? theme.name : `${theme.name} #${i + 1}`,
                serveUpto,
                description,
                images: [images[Math.floor(Math.random() * images.length)]],
                vegType: isAllVeg ? 'veg' : 'non-veg',
                isSpecial: Math.random() > 0.8,
                categories: comboCategories,
                price,
                originalPrice,
                discount,
                savings,
                availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                startTime: '09:00',
                endTime: '23:00',
                isHealthy: Math.random() > 0.7,
                status: 'active'
            });
        }

        // 4. Insert to DB
        await Combo.insertMany(combosToInsert);
        console.log(`Successfully seeded 50 Multi-Category Combo items!`);

        process.exit();
    } catch (err) {
        console.error('Combo Seeding Error:', err);
        process.exit(1);
    }
};

seedCombos();
