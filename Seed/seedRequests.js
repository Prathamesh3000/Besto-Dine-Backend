const mongoose = require('mongoose');
require('dotenv').config();
const Request = require('./models/request');
const Table = require('./models/table');

const seedRequests = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('✔ Connected to MongoDB for seeding requests');

        // Clear existing requests
        await Request.deleteMany();

        const tables = await Table.find();
        if (tables.length < 2) {
            console.log('✘ Need at least 2 tables to seed requests. Run seedMenuItems first.');
            process.exit(1);
        }

        const sampleRequests = [
            {
                table: tables[0]._id,
                type: 'water',
                items: [{ label: 'Normal', qty: 2 }],
                priority: 'low',
                status: 'pending'
            },
            {
                table: tables[1]._id,
                type: 'waiter',
                priority: 'high',
                status: 'accepted'
            },
            {
                table: tables[0]._id,
                type: 'bill',
                priority: 'urgent',
                status: 'pending'
            }
        ];

        await Request.insertMany(sampleRequests);
        console.log('✔ Seeded 3 sample requests');
        process.exit(0);
    } catch (error) {
        console.error('✘ Seeding failed:', error);
        process.exit(1);
    }
};

seedRequests();
