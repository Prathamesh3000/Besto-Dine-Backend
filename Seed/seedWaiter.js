const mongoose = require('mongoose');
const User = require('./models/user');
require('dotenv').config();

const seedWaiter = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('✔ Connected to MongoDB');

        const waiterEmail = 'waiter@example.com';
        const waiterPassword = 'waiter123';

        // Check if waiter already exists
        const existingWaiter = await User.findOne({ email: waiterEmail });
        if (existingWaiter) {
            console.log('ℹ Waiter already exists. Updating password/role...');
            existingWaiter.password = waiterPassword;
            existingWaiter.role = 'waiter';
            await existingWaiter.save();
        } else {
            console.log('➕ Creating new Waiter user...');
            await User.create({
                name: 'Test Waiter',
                email: waiterEmail,
                password: waiterPassword,
                mobile: '1234567890',
                role: 'waiter'
            });
        }

        console.log('✔ Waiter seeded successfully!');
        console.log(`📧 Email: ${waiterEmail}`);
        console.log(`🔑 Password: ${waiterPassword}`);

        await mongoose.connection.close();
    } catch (error) {
        console.error('✘ Error:', error);
    }
};

seedWaiter();
