const mongoose = require('mongoose');
const Notification = require('./models/notification');
require('dotenv').config();

const seedNotifications = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    // Clear existing notifications
    await Notification.deleteMany({});
    console.log('🗑 Cleared old notifications');

    const testNotifications = [
      {
        title: 'New Order Received',
        description: 'Rohit Sharma placed order ORD-5521 for ₹1,250',
        category: 'Order',
        recipientRole: 'admin',
        meta: { orderId: 'ORD-5521', amount: 1250 }
      },
      {
        title: 'Wallet Recharged',
        description: 'Customer wallet credited with ₹500. New balance: ₹1,200',
        category: 'Wallet',
        recipientRole: 'admin',
        meta: { amount: 500 }
      },
      {
        title: 'Payment Successful',
        description: 'Payment of ₹850 received for Order #ORD-1232',
        category: 'Payment',
        recipientRole: 'admin',
        meta: { orderId: 'ORD-1232', amount: 850 }
      },
      {
        title: 'Points Expiring Soon!',
        description: '100 points worth ₹100 will expire on Feb 20, 2026',
        category: 'Points',
        recipientRole: 'admin'
      }
    ];

    await Notification.insertMany(testNotifications);
    console.log('✔ Seeded 4 test notifications');

    await mongoose.connection.close();
    console.log('✔ Connection closed');
  } catch (error) {
    console.error('✘ Error:', error);
  }
};

seedNotifications();
