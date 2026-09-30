const mongoose = require('mongoose');
const Addon = require('./models/addon');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/cafe-management';

const seedAddons = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB for seeding addons...');

        await Addon.deleteMany({});

        // IMPORTANT: slugs MUST match the 'type' cases in AddonDetailModal.jsx
        // photographer | dj | photobooth | live | kids | host
        const addons = [
            {
                title: 'Photography Coverage',
                slug: 'photographer',          // matches AddonDetailModal case 'photographer'
                description: 'Best for small gatherings',
                price: 5000,
                icon: '/camera.svg',
                category: 'Media',
                options: [],
                isFeatured: true,
                isActive: true
            },
            {
                title: 'Music & DJ',
                slug: 'dj',                    // matches AddonDetailModal case 'dj'
                description: 'Music & DJ Services',
                price: 3000,
                icon: '/music.svg',
                category: 'Entertainment',
                options: [],
                isPopular: true,
                isActive: true
            },
            {
                title: 'Live Food Stations',
                slug: 'live',                  // matches AddonDetailModal case 'live'
                description: 'Freshly prepared, right in front of your guests.',
                price: 10000,
                icon: '/fcounter.svg',
                category: 'Catering',
                options: [],
                isActive: true
            },
            {
                title: 'Kids Entertainment Zone',
                slug: 'kids',                  // matches AddonDetailModal case 'kids'
                description: 'Safe fun for little guests.',
                price: 8000,
                icon: '/kids.svg',
                category: 'Entertainment',
                options: [],
                isActive: true
            },
            {
                title: 'Photo Booth',
                slug: 'photobooth',            // matches AddonDetailModal case 'photobooth'
                description: 'Capture the Moments That Matter',
                price: 4000,
                icon: '/photobooth.png',
                category: 'Media',
                options: [],
                isActive: true
            },
            {
                title: 'Professional Event Host',
                slug: 'host',                  // matches AddonDetailModal case 'host'
                description: 'Professional emcee to manage your event flow',
                price: 6000,
                icon: '/mike.svg',
                category: 'Service',
                options: [],
                isActive: true
            }
        ];

        await Addon.insertMany(addons);
        console.log('✅ Successfully seeded 6 addons with correct slugs!');
        process.exit();
    } catch (err) {
        console.error('Seeding error:', err);
        process.exit(1);
    }
};

seedAddons();
