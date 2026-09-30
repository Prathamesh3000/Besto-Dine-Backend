const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/user');
const Wallet = require('./models/wallet');
const Transaction = require('./models/transaction');

async function seedTestData() {
  try {
    console.log('--- SEEDING PERSISTENT TEST DATA ---');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    const customers = [
      { name: 'Rahul Sharma', email: 'rahul@test.com', mobile: '9876543210' },
      { name: 'Priya Patel', email: 'priya@test.com', mobile: '9876543211' },
      { name: 'Amit Verma', email: 'amit@test.com', mobile: '9876543212' },
      { name: 'Sonal Singh', email: 'sonal@test.com', mobile: '9876543213' },
      { name: 'Vikram Jha', email: 'vikram@test.com', mobile: '9876543214' }
    ];

    for (const c of customers) {
      // 1. Create or Update User
      let user = await User.findOne({ email: c.email });
      if (!user) {
        user = await User.create({
          ...c,
          password: 'password123',
          role: 'customer'
        });
        console.log(`✔ Created User: ${user.name}`);
      }

      // 2. Create or Update Wallet
      let wallet = await Wallet.findOne({ user: user._id });
      if (!wallet) {
        const initialBalance = Math.floor(Math.random() * 5000) + 500;
        const initialPoints = Math.floor(Math.random() * 500) + 50;
        
        wallet = await Wallet.create({
          user: user._id,
          balance: initialBalance,
          loyaltyPoints: initialPoints,
          status: 'active'
        });

        // 3. Create initial recharge transaction
        await Transaction.create({
          user: user._id,
          type: 'wallet_recharge',
          amount: initialBalance,
          paymentMethod: 'upi',
          transactionId: 'TXN-INIT-' + user._id.toString().slice(-6),
          description: 'Initial balance for testing',
          balanceBefore: 0,
          balanceAfter: initialBalance,
          status: 'completed'
        });
        
        console.log(`✔ Seeded Wallet & Txn for ${user.name}: ₹${initialBalance}`);
      } else {
        console.log(`ℹ Wallet already exists for ${user.name}`);
      }
    }

    console.log('\n✅ TEST DATA SEEDED SUCCESSFULLY!');
    console.log('You can now see these customers in the Wallet Dashboard.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding Failed:', err);
    process.exit(1);
  }
}

seedTestData();
