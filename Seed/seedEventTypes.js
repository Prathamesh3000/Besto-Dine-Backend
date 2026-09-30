const mongoose = require('mongoose');
require('dotenv').config();
const EventType = require('../models/eventType');

const mongoUrl = process.env.MONGO_URL;

const eventTypes = [
  { title: 'Birthday', icon: '/cake.svg', description: 'Celebrate your birthday with us', guests: '10-200' },
  { title: 'Anniversary', icon: '/ring.svg', description: 'Make your anniversary memorable', guests: '2-50' },
  { title: 'Business Event', icon: '/Business.svg', description: 'Professional meeting space', guests: '5-100' },
  { title: 'Reunion Party', icon: '/reunion.svg', description: 'Gather with old friends', guests: '10-150' },
  { title: 'Proposal', icon: '/heart.svg', description: 'A romantic space for your big moment', guests: '2' },
  { title: 'Other', icon: '/party.svg', description: 'Any other celebration', guests: '5-500' }
];

const seedData = async () => {
    try {
        await mongoose.connect(mongoUrl);
        console.log('✔ Connected to MongoDB');

        // Delete existing ones to avoid duplicates
        await EventType.deleteMany({});
        console.log('✔ Existing EventTypes cleared');

        const docs = await EventType.insertMany(eventTypes);
        console.log(`✔ Successfully seeded ${docs.length} EventTypes`);

        mongoose.connection.close();
    } catch (err) {
        console.error('✘ Seeding error:', err);
        process.exit(1);
    }
};

seedData();
