const mongoose = require('mongoose');
require('dotenv').config();
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

const mongoUrl = process.env.MONGO_URL;

const seedCakes = async () => {
    try {
        await mongoose.connect(mongoUrl);
        console.log('✔ Connected to MongoDB');

        // 1. Create/Find Cake Category
        let cakeCategory = await Category.findOne({ name: 'Cakes' });
        if (!cakeCategory) {
            cakeCategory = await Category.create({
                name: 'Cakes',
                image: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=1989&auto=format&fit=crop',
                status: 'active'
            });
            console.log('✔ Created Cakes category');
        }

        // 2. Add some cakes
        const cakes = [
            {
                name: 'Black Forest',
                category: cakeCategory._id,
                description: 'Classic chocolate cake with cherries and whipped cream',
                images: ['https://images.unsplash.com/photo-1571115177098-24ec42ed6d7d?q=80&w=1887&auto=format&fit=crop'],
                basePrice: 500,
                vegType: 'veg',
                sizes: [
                    { name: '500g', price: 500 },
                    { name: '1kg', price: 950 },
                    { name: '2kg', price: 1800 }
                ],
                status: 'active'
            },
            {
                name: 'Red Velvet',
                category: cakeCategory._id,
                description: 'Rich red velvet cake with cream cheese frosting',
                images: ['https://images.unsplash.com/photo-1586788680434-30d324b2d46f?q=80&w=1902&auto=format&fit=crop'],
                basePrice: 600,
                vegType: 'veg',
                sizes: [
                    { name: '500g', price: 600 },
                    { name: '1kg', price: 1100 },
                    { name: '2kg', price: 2100 }
                ],
                status: 'active'
            },
            {
                name: 'Chocolate Truffle',
                category: cakeCategory._id,
                description: 'Decadent dark chocolate truffle cake',
                images: ['https://images.unsplash.com/photo-1606890737304-57a1ca8a5b62?q=80&w=2003&auto=format&fit=crop'],
                basePrice: 550,
                vegType: 'non-veg',
                sizes: [
                    { name: '500g', price: 550 },
                    { name: '1kg', price: 1000 },
                    { name: '2kg', price: 1900 }
                ],
                status: 'active'
            }
        ];

        // Only insert if they don't exist
        for (const cake of cakes) {
            const exists = await MenuItem.findOne({ name: cake.name, category: cake.category });
            if (!exists) {
                await MenuItem.create(cake);
                console.log(`✔ Added ${cake.name}`);
            }
        }

        console.log('✔ Successfully seeded Cakes');
        mongoose.connection.close();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

seedCakes();
