const mongoose = require('mongoose');
require('dotenv').config();
const Promotion = require('./models/promotion');
const Coupon = require('./models/coupon');

const seedData = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB...');

        // Clear existing
        await Promotion.deleteMany({});
        await Coupon.deleteMany({});

        // Seed Promotions (Banners)
        const promotions = [
            {
                title: 'Summer Rooftop Fest',
                description: 'Enjoy 20% off on all mocktails at our rooftop area every weekend!',
                image: 'https://images.unsplash.com/photo-1533777857889-4be7c70b33f7?auto=format&fit=crop&w=800&q=80',
                type: 'banner',
                endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
                displayOrder: 1
            },
            {
                title: 'Happy Hours',
                description: 'Buy 1 Get 1 Free on all Coffees between 4 PM to 6 PM.',
                image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&q=80',
                type: 'offer',
                endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
                displayOrder: 2
            },
            {
                title: 'New Combo Launch',
                description: 'Try our new Burger + Fries + Coke combo at just ₹299!',
                image: 'https://images.unsplash.com/photo-1594212699903-ec8a3ecc50f1?auto=format&fit=crop&w=800&q=80',
                type: 'featured_item',
                endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
                displayOrder: 3
            }
        ];

        // Seed Coupons
        const coupons = [
            {
                code: 'WELCOME50',
                title: 'First Order Discount',
                description: 'Get Flat ₹50 off on your first order above ₹200',
                discountType: 'fixed_amount',
                discountValue: 50,
                minOrderValue: 200,
                endDate: new Date('2026-12-31'),
                usageLimit: 100,
                couponCategory: 'first_order'
            },
            {
                code: 'CAFE10',
                title: 'Loyalty Discount',
                description: '10% OFF on your entire bill!',
                discountType: 'percentage',
                discountValue: 10,
                minOrderValue: 500,
                maxDiscountAmount: 200,
                endDate: new Date('2026-06-30'),
                usageLimit: 500,
                couponCategory: 'all'
            }
        ];

        await Promotion.insertMany(promotions);
        await Coupon.insertMany(coupons);

        console.log('✅ Promotions and Coupons seeded successfully!');
        process.exit();
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seedData();
