const mongoose = require('mongoose');
const Cake = require('./models/cake');
const Decoration = require('./models/decoration');
const Package = require('./models/package');
const Addon = require('./models/addon');
require('dotenv').config();

const seedData = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB');

    // Clear existing
    await Cake.deleteMany({});
    await Decoration.deleteMany({});
    await Package.deleteMany({});
    await Addon.deleteMany({});

    // 1. Seed Cakes
    const cakes = [
      { flavor: 'Chocolate', subtitle: 'Rich Indulgence', pricePerKg: 500, image: '/chocolate.png' },
      { flavor: 'Vanilla', subtitle: 'Classic Bliss', pricePerKg: 400, image: '/vanilla.png' },
      { flavor: 'Butterscotch', subtitle: 'Caramel Crunch', pricePerKg: 450, image: '/butterscotch.png' },
      { flavor: 'Red Velvet', subtitle: 'Velvet Love', pricePerKg: 600, image: '/redvelvet.png' },
      { flavor: 'Fruit Cake', subtitle: 'Fresh Delight', pricePerKg: 550, image: '/fruitcake.png' },
      { flavor: 'Cheesecake', subtitle: 'Creamy Dream', pricePerKg: 800, image: '/cheesecake.png' }
    ];
    await Cake.insertMany(cakes);
    console.log('Cakes seeded');

    // 2. Seed Decorations
    const decorations = [
      {
        title: 'Royal Wedding Package',
        description: 'Luxurious wedding decoration with gold and cream theme, perfect for grand celebrations',
        category: 'Wedding',
        price: 150000,
        image: '/Decoration1.svg',
        tags: ['Wedding', 'Customization'],
        details: {
          includedItems: [
            { group: 'Stage Decoration', items: ['Main Stage Backdrop (1 set)', 'Floral Arrangements (10 pieces)', 'Crystal Chandeliers (2 pieces)'] },
            { group: 'Lightings', items: ['LED Par Lights (20 pieces)', 'Moving Lights (4 pieces)', 'Fairy Lights (100 meters)'] }
          ],
          materials: ['Fresh Flowers', 'Fabric Draping', 'LED Lights'],
          colors: [{ label: 'Primary', hex: '#F9D0E0' }, { label: 'Secondary', hex: '#C47EC0' }, { label: 'Accent', hex: '#8B1A5E' }]
        }
      },
      {
        title: 'Premium Birthday Set',
        description: 'Colorful and vibrant balloon decor with custom theme backdrops.',
        category: 'Birthday',
        price: 25000,
        image: '/Decoration2.svg',
        tags: ['Birthday', 'Balloons'],
        details: {
          includedItems: [
            { group: 'Theme Setup', items: ['Custom Backdrop', 'Balloon Arch', 'Character Cutouts'] }
          ],
          materials: ['Balloons', 'Cardboard', 'Vinyl'],
          colors: [{ label: 'Primary', hex: '#FFCCE5' }, { label: 'Secondary', hex: '#FFE5CC' }]
        }
      }
    ];
    await Decoration.insertMany(decorations);
    console.log('Decorations seeded');

    // 3. Seed Packages
    const packages = [
      {
        name: 'Silver Package',
        price: 699,
        description: 'Quality starters and main course for intimate gatherings.',
        items: ['2 Starters', '2 Main Course', 'Breads & Rice', '1 Dessert', 'Salads'],
        image: '/party.svg'
      },
      {
        name: 'Gold Package',
        price: 999,
        description: 'Premium spread with welcome drinks and variety of courses.',
        items: ['Welcome Drink', '4 Starters', '4 Main Course', '3 Breads & Rice', '3 Dessert'],
        image: '/party.svg'
      },
      {
        name: 'Platinum Package',
        price: 1499,
        description: 'The ultimate luxury experience with live counters.',
        items: ['4 Welcome Drinks', '6 Starters', '5 Main Course', 'Live Counter', '8 Desserts'],
        image: '/party.svg'
      }
    ];
    await Package.insertMany(packages);
    console.log('Packages seeded');

    // 4. Seed Addons
    const addons = [
      { slug: 'photographer', title: 'Photographer', price: 5000, icon: '/camera.svg', category: 'Photography' },
      { slug: 'dj', title: 'DJ / Music', price: 5000, icon: '/music.svg', category: 'Audio/Visual' },
      { slug: 'lighting', title: 'Special Lighting', price: 5000, icon: '/bulb.svg', category: 'Audio/Visual' },
      { slug: 'live', title: 'Live Counter', price: 8000, icon: '/fcounter.svg', category: 'Service' },
      { slug: 'kids', title: 'Kids Play Area', price: 7000, icon: '/kids.svg', category: 'Service' },
      { slug: 'host', title: 'Host / Emcee', price: 4000, icon: '/mike.svg', category: 'Service' }
    ];
    await Addon.insertMany(addons);
    console.log('Addons seeded');

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

seedData();
