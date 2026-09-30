const mongoose = require('mongoose');
require('dotenv').config();
const Settings = require('../models/settings');

const branches = [
  {
    name: 'BestoDine - FC Road',
    addressLine1: '2nd Floor, Maple Plaza, FC Road, Shivajinagar,',
    addressLine2: 'Pune, Maharashtra 411004',
    hours: 'Open Monday – Sunday: 11:00 AM – 11:30 PM',
    phone: '+91 20 2553 1100',
    isActive: true
  },
  {
    name: 'BestoDine - Baner',
    addressLine1: 'Prabhu Vertex, Near Balewadi High Street, Baner,',
    addressLine2: 'Pune, Maharashtra 411045',
    hours: 'Open Monday – Sunday: 11:00 AM – 11:00 PM',
    phone: '+91 20 2729 4500',
    isActive: true
  },
  {
    name: 'BestoDine - Viman Nagar',
    addressLine1: 'Ground Floor, Sky Vista, Near Phoenix Mall, Viman Nagar,',
    addressLine2: 'Pune, Maharashtra 411014',
    hours: 'Open Monday – Sunday: 10:00 AM – 11:30 PM',
    phone: '+91 20 2668 3200',
    isActive: true
  },
  {
    name: 'BestoDine - Koregaon Park',
    addressLine1: 'Lane 7, North Main Road, Koregaon Park,',
    addressLine2: 'Pune, Maharashtra 411001',
    hours: 'Open Monday – Sunday: 10:00 AM – 12:00 AM',
    phone: '+91 20 2615 7800',
    isActive: true
  },
];

const seedBranches = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB for branch seeding...');

    let settings = await Settings.findOne();

    if (!settings) {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      settings = await Settings.create({
        general: {
          cafeName: 'BestoDine',
          contactNumber: '+91 98765 43210',
          email: 'admin@bestodine.com',
          address: 'Pune, Maharashtra'
        },
        operatingHours: days.map(day => ({
          day,
          start: '09:00',
          end: '23:00',
          isOpen: true
        }))
      });
      console.log('Created default settings document.');
    }

    settings.branches = branches;
    await settings.save();

    console.log(`Successfully seeded ${branches.length} branches:`);
    branches.forEach(b => console.log(`  - ${b.name}`));

    process.exit();
  } catch (err) {
    console.error('Branch Seeding Error:', err);
    process.exit(1);
  }
};

seedBranches();
