const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const User = require('../models/user');

const seedChef = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB');

        const chefEmail = 'chef@example.com';
        const chefPassword = 'chef123';

        // Check if chef already exists
        const existingChef = await User.findOne({ email: chefEmail });
        if (existingChef) {
            console.log('Chef already exists. Updating...');
            existingChef.password = chefPassword;
            existingChef.role = 'chef';
            existingChef.kitchenResponsibility = 'both';
            existingChef.name = 'Chef Sharma';
            existingChef.status = 'active';
            await existingChef.save();
        } else {
            console.log('Creating new Chef user...');

            // Generate staffId
            const lastStaff = await User.findOne({ staffId: /^EMP-/ }).sort({ staffId: -1 });
            let nextNum = 1;
            if (lastStaff && lastStaff.staffId) {
                nextNum = parseInt(lastStaff.staffId.split('-')[1]) + 1;
            }
            const staffId = `EMP-${nextNum.toString().padStart(3, '0')}`;

            await User.create({
                name: 'Chef Sharma',
                email: chefEmail,
                password: chefPassword,
                mobile: '9876543210',
                role: 'chef',
                staffId,
                kitchenResponsibility: 'both',
                status: 'active'
            });
        }

        console.log('Chef seeded successfully!');
        console.log(`Email:    ${chefEmail}`);
        console.log(`Password: ${chefPassword}`);
        console.log(`Role:     chef`);
        console.log(`Kitchen:  both (veg + non-veg)`);

        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
    }
};

seedChef();
