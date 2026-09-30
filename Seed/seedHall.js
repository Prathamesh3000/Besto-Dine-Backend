const mongoose = require('mongoose');
const Hall = require('./models/hall');
require('dotenv').config();

const seedHall = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB');

    await Hall.deleteMany({}); // Clear existing

    const sampleHall = await Hall.create({
      name: 'Grand Royal Banquet',
      type: 'Banquet Hall',
      description: 'Elegant hall perfect for weddings, anniversaries and corporate events.',
      minCapacity: 50,
      maxCapacity: 500,
      optimalCapacity: 300,
      basePrice: 75000,
      cleaningCharges: 5000,
      securityDeposit: 10000,
      floorLevel: '1st Floor',
      amenities: {
        soundSystem: true,
        projector: true,
        wifi: true,
        ledScreen: true,
        airConditioning: true,
        parking: true,
        kitchen: true
      },
      images: ['https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=2000']
    });

    console.log('Seed Hall created:', sampleHall.name);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

seedHall();
