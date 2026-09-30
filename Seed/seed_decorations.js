const mongoose = require('mongoose');
const DecorationPackage = require('./models/decorationPackage');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/cafe-management';

const seedDecorations = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB for seeding decorations...');

        // Clear existing packages
        await DecorationPackage.deleteMany({});

        const packages = [
            {
                name: 'Royal Wedding Package',
                category: 'Wedding',
                description: 'A luxurious and elegant setup designed specifically for grand weddings. This package includes a majestic floral stage, crystal chandeliers, and premium seating arrangements to make your special day truly royal.',
                themeStyle: 'Royal / Elegant',
                primaryColor: '#FFD700',
                secondaryColor: '#FFFFFF',
                accentColor: '#B22222',
                suitableFor: {
                    Indoor: true, Outdoor: false, Hall: true, Banquet: true,
                    Garden: false, Terrace: false, Beach: false, Restaurant: false
                },
                minArea: 2000,
                maxArea: 5000,
                ceilingHeight: 15,
                searchTags: ['Wedding', 'Luxury', 'Grand', 'Stage Decoration'],
                isFeatured: true,
                isPopular: true,
                categories: [
                    {
                        name: 'Stage Decoration',
                        items: [
                            { name: 'Crystal Chandelier', quantity: 2, unit: 'Sets' },
                            { name: 'Red Velvet Backdrop', quantity: 1, unit: 'Sets' },
                            { name: 'Fresh Flower Archway', quantity: 1, unit: 'Sets' }
                        ]
                    },
                    {
                        name: 'Entrance',
                        items: [
                            { name: 'LED Welcome Board', quantity: 1, unit: 'Pieces' },
                            { name: 'Carpet Path (Red)', quantity: 50, unit: 'Sq Ft' }
                        ]
                    }
                ],
                materialsUsed: ['Fresh Flowers', 'Silk Fabric', 'Crystals', 'LED Lights'],
                setupTime: '8 Hours',
                advanceBookingDays: 30,
                waterRequired: true,
                technicalSupport: true,
                onSiteSupervision: true,
                numberOfCaretakers: 4,
                basePrice: 75000,
                dismantlingCharges: 5000,
                setupCharges: 10000,
                transportCharges: 2500,
                isCustomizable: true,
                images: ['https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&q=80&w=1000'],
                vendorName: 'Royal Decorators Pvt Ltd',
                vendorEmail: 'contact@royaldecorators.com',
                vendorPhone: '9876543210',
                vendorRating: 5
            },
            {
                name: 'Ultimate Birthday Party Package',
                category: 'Birthday',
                description: 'Celebrate your birthday with a vibrant and fun setup! Includes personalized balloon arches, colorful lighting, and a themed stage perfect for photos and cake cutting.',
                themeStyle: 'Vibrant / Fun',
                primaryColor: '#FF6B6B',
                secondaryColor: '#4ECDC4',
                accentColor: '#FFD93D',
                suitableFor: {
                    Indoor: true, Outdoor: true, Hall: true, Banquet: false,
                    Garden: true, Terrace: true, Beach: false, Restaurant: true
                },
                minArea: 500,
                maxArea: 2000,
                ceilingHeight: 10,
                searchTags: ['Birthday', 'Party', 'Balloons', 'Kids'],
                isFeatured: false,
                isPopular: true,
                categories: [
                    {
                        name: 'Main Stage',
                        items: [
                            { name: 'Themed Banner', quantity: 1, unit: 'Pieces' },
                            { name: 'Balloon Arch (300 balloons)', quantity: 1, unit: 'Sets' },
                            { name: 'Cake Table (Decorated)', quantity: 1, unit: 'Pieces' }
                        ]
                    }
                ],
                materialsUsed: ['Latex Balloons', 'Foil Balloons', 'Ribbons', 'LED Strips'],
                setupTime: '3 Hours',
                advanceBookingDays: 7,
                waterRequired: false,
                technicalSupport: false,
                onSiteSupervision: true,
                numberOfCaretakers: 2,
                basePrice: 15000,
                dismantlingCharges: 1500,
                setupCharges: 3000,
                transportCharges: 1000,
                isCustomizable: true,
                images: ['https://images.unsplash.com/photo-1533294485618-f57a700d7934?auto=format&fit=crop&q=80&w=1000'],
                vendorName: 'Party Planners Co.',
                vendorEmail: 'hello@partyplanners.com',
                vendorPhone: '9876543211',
                vendorRating: 4.5
            },
            {
                name: 'Professional Corporate Package',
                category: 'Corporate',
                description: 'Sleek, professional, and minimalistic decoration package for corporate events, seminars, and product launches. High-quality materials and subtle branding integration.',
                themeStyle: 'Minimalistic / Professional',
                primaryColor: '#2D3436',
                secondaryColor: '#DFE6E9',
                accentColor: '#0984E3',
                suitableFor: {
                    Indoor: true, Outdoor: false, Hall: true, Banquet: true,
                    Garden: false, Terrace: false, Beach: false, Restaurant: false
                },
                minArea: 1000,
                maxArea: 4000,
                ceilingHeight: 12,
                searchTags: ['Corporate', 'Business', 'Seminar', 'Conference'],
                isFeatured: false,
                isPopular: false,
                categories: [
                    {
                        name: 'Podium & Stage',
                        items: [
                            { name: 'Corporate Backdrop (Matte)', quantity: 1, unit: 'Sets' },
                            { name: 'Podium Branding', quantity: 1, unit: 'Pieces' }
                        ]
                    }
                ],
                materialsUsed: ['Flex Branding', 'ACP Sheets', 'LED Focus Lights'],
                setupTime: '5 Hours',
                advanceBookingDays: 15,
                waterRequired: false,
                technicalSupport: true,
                onSiteSupervision: true,
                numberOfCaretakers: 3,
                basePrice: 35000,
                dismantlingCharges: 3000,
                setupCharges: 5000,
                transportCharges: 2000,
                isCustomizable: false,
                images: ['https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80&w=1000'],
                vendorName: 'Corporate Decor Experts',
                vendorEmail: 'events@corporateexperts.com',
                vendorPhone: '9876543212',
                vendorRating: 4.8
            }
        ];

        await DecorationPackage.insertMany(packages);
        console.log('Successfully seeded decorations!');
        process.exit();
    } catch (err) {
        console.error('Seeding error:', err);
        process.exit(1);
    }
};

seedDecorations();
