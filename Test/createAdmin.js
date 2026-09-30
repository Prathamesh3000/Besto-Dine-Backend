const mongoose = require('mongoose');
const User = require('./models/user');
require('dotenv').config();

const createAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('Connected to MongoDB');

        const adminData = {
            name: 'System Admin',
            email: 'admin@cafe.com',
            password: 'adminpassword123', // This will be hashed by the User model's pre-save hook
            mobile: '1234567890',
            role: 'admin'
        };

        // Check if admin already exists
        const adminExists = await User.findOne({ email: adminData.email });
        if (adminExists) {
            console.log('Admin already exists');
            process.exit();
        }

        const admin = await User.create(adminData);
        console.log('Admin user created successfully:');
        console.log('Email: admin@cafe.com');
        console.log('Password: adminpassword123');

        process.exit();
    } catch (error) {
        console.error('Error creating admin:', error);
        process.exit(1);
    }
};

createAdmin();
