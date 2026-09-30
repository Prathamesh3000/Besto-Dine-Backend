const mongoose = require('mongoose');
const Reservation = require('./models/reservation');
const Package = require('./models/package');
const Hall = require('./models/hall');
const Decoration = require('./models/decoration');
const EventType = require('./models/eventType');
const User = require('./models/user');
require('dotenv').config();

const seedBookings = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    // --- 1. Event Types ---
    await EventType.deleteMany({});
    await EventType.insertMany([
      {
        title: 'Birthday Celebration',
        description: 'Perfect for kid or adult birthdays with special cake and decor options.',
        guests: '10-100',
        icon: 'Cake',
        color: 'border-purple-500',
        iconColor: 'text-purple-500',
        services: ['Cake provided', 'Balloon Decor', 'Music System'],
        tags: ['Birthday', 'Celebration']
      },
      {
        title: 'Wedding / Anniversary',
        description: 'Grand celebrations with premium halls and catering packages.',
        guests: '50-500',
        icon: 'Sparkles',
        color: 'border-pink-500',
        iconColor: 'text-pink-500',
        services: ['Stage Decor', 'Premium Menu', 'Photography'],
        tags: ['Wedding', 'Grand']
      }
    ]);

    // --- 2. Packages ---
    await Package.deleteMany({});
    await Package.insertMany([
      {
        name: 'Royal Banquet Package',
        price: 1500,
        description: 'Premium dining experience with hall access',
        starters: [{name: 'Paneer Tikka'}, {name: 'Crispy Corn'}],
        mainCourse: [{name: 'Dal Makhani'}, {name: 'Kadhai Paneer'}, {name: 'Butter Naan'}],
        drinks: [{name: 'Mocktails'}, {name: 'Soft Drinks'}],
        features: ['Hall Included', 'Music System', 'Full Service'],
        category: 'Royal',
        badge: 'Featured',
        badgeColor: 'bg-blue-100 text-blue-600',
        minPeople: 50,
        maxPeople: 200
      },
      {
        name: 'Classic Birthday Combo',
        price: 850,
        description: 'Fun snacks and birthday fun for all ages',
        starters: [{name: 'French Fries'}, {name: 'Spring Rolls'}],
        mainCourse: [{name: 'Pizza Buffet'}, {name: 'White Sauce Pasta'}],
        drinks: [{name: 'Fruit Punch'}, {name: 'Cold Coffee'}],
        features: ['Balloon Setup', 'Bouncy Castle (Extra)', 'E-Invites'],
        category: 'Classic',
        badge: 'Popular',
        badgeColor: 'bg-orange-100 text-orange-600',
        minPeople: 15,
        maxPeople: 50
      }
    ]);

    // --- 3. Halls ---
    await Hall.deleteMany({});
    await Hall.insertMany([
      {
        name: 'The Grand Ballroom',
        type: 'Banquet Hall',
        description: 'Our largest space, perfect for grand weddings and corporate events.',
        minCapacity: 100,
        maxCapacity: 500,
        basePrice: 50000,
        features: ['Central AC', 'Soundproof Walls', 'VIP Lounge'],
        audioVisual: ['4K Projector', 'JBL Sound System', 'Wireless Mics'],
        policies: ['No alcohol allowed', 'Check-in: 10:00 AM', 'Max occupancy: 500'],
        bestFor: ['Weddings', 'Corporate Gala', 'Concerts'],
        badges: ['Featured', 'AC Indoor'],
        contact: { name: 'Rajesh Manager', phone: '+91 99999 88888', email: 'rajesh@thecafe.com' },
        images: ['https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=2000']
      },
      {
        name: 'Roof Garden Terrace',
        type: 'Outdoor Space',
        description: 'Beautiful open-air terrace with a city view.',
        minCapacity: 30,
        maxCapacity: 150,
        basePrice: 25000,
        features: ['Under-the-stars setup', 'Live BBQ station', 'Ambient Lighting'],
        bestFor: ['Anniversaries', 'Private Parties', 'Sundowners'],
        badges: ['Active'],
        contact: { name: 'Priya Event Lead', phone: '+91 77777 66666', email: 'priya@thecafe.com' },
        images: ['https://images.unsplash.com/photo-1527529482837-4698179dc6ce?auto=format&fit=crop&q=80&w=2000']
      }
    ]);

    // --- 4. Decorations ---
    await Decoration.deleteMany({});
    await Decoration.insertMany([
      {
        title: 'Classic Floral Birthday',
        description: 'Elegant fresh flower decoration with balloon arc and lighting.',
        category: 'Birthday',
        price: 5000,
        tag: 'Classic',
        tagColor: 'bg-purple-100 text-purple-600',
        setupTime: '2 hours',
        teamSize: '2 Team',
        featured: true,
        image: 'https://images.unsplash.com/photo-1533219057257-4bb9ed5d2cc6?auto=format&fit=crop&q=80&w=2000'
      },
      {
        title: 'Premium Wedding Stage',
        description: 'Royal stage setup with velvet backdrop, fresh orchids, and fog machine.',
        category: 'Wedding',
        price: 25000,
        tag: 'Premium',
        tagColor: 'bg-pink-100 text-pink-600',
        setupTime: '6 hours',
        teamSize: '5-8 Team',
        featured: false,
        image: 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&q=80&w=2000'
      }
    ]);

    // --- 5. Test Reservations ---
    await Reservation.deleteMany({ bookingType: 'hall' });
    const testUser = await User.findOne();
    const testHall = await Hall.findOne();

    await Reservation.insertMany([
      {
        guestName: 'Alex Johnson',
        contactNo: '9876543210',
        date: new Date(),
        time: '11:00 AM',
        guestCount: 75,
        bookingType: 'hall',
        hall: testHall ? testHall._id : null,
        user: testUser ? testUser._id : null,
        status: 'Approved',
        payment: { total: 12500, advancePaid: 5000, status: 'partial', method: 'upi' }
      },
      {
        guestName: 'Sarah Smith',
        contactNo: '9988776655',
        date: new Date(Date.now() + 86400000),
        time: '07:00 PM',
        guestCount: 25,
        bookingType: 'table',
        status: 'Pending',
        payment: { total: 4500, advancePaid: 0, status: 'pending' }
      }
    ]);

    console.log('✔ All booking resources seeded successfully!');
    await mongoose.connection.close();
  } catch (error) {
    console.error('✘ Seeding error:', error);
  }
};

seedBookings();
