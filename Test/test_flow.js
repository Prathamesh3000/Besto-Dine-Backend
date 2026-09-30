const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/user');
const Order = require('./models/order');
const Wallet = require('./models/wallet');
const Transaction = require('./models/transaction');
const Tip = require('./models/tip');

async function testFlow() {
  try {
    console.log('--- STARTING FLOW TEST ---');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    // 1. Setup Test Data
    const testEmail = 'tester@example.com';
    await User.deleteMany({ email: testEmail });
    const user = await User.create({
      name: 'Test Customer',
      email: testEmail,
      mobile: '9999999999',
      password: 'testpassword',
      role: 'customer'
    });
    console.log('✔ Test Customer created:', user._id);

    const waiter = await User.create({
      name: 'Test Waiter',
      email: 'waiter@test.com',
      mobile: '8888888888',
      password: 'testpassword',
      role: 'waiter'
    });
    console.log('✔ Test Waiter created:', waiter._id);

    // 2. Create Order
    const orderId = 'TEST-ORD-' + Date.now();
    const order = await Order.create({
      orderId,
      type: 'dine-in',
      user: user._id,
      customerName: user.name,
      phone: user.mobile,
      items: [{ name: 'Test Pizza', price: 500, quantity: 1 }],
      total: 500,
      paymentStatus: 'Pending',
      status: 'ready',
      waiter: waiter._id,
      tipAmount: 50
    });
    console.log('✔ Test Order created:', order.orderId);

    // 3. Update Order to PAID (Mimic Controller Logic)
    console.log('--- SIMULATING PAYMENT ---');
    
    // We fetch again to ensure we have the document
    const currentOrder = await Order.findById(order._id);
    const oldPaymentStatus = currentOrder.paymentStatus;
    
    // Update to Paid
    currentOrder.paymentStatus = 'Paid';
    currentOrder.status = 'served';
    const savedOrder = await currentOrder.save();
    console.log('✔ Order status updated to Paid');

    // SIDE EFFECTS (copied from controller)
    if (savedOrder.paymentStatus === 'Paid' && oldPaymentStatus !== 'Paid' && savedOrder.user) {
        const earnedPoints = Math.floor(savedOrder.total / 10);
        let wallet = await Wallet.findOne({ user: savedOrder.user });
        if (!wallet) {
            wallet = new Wallet({ user: savedOrder.user });
            await wallet.save();
        }

        const pointsBefore = wallet.loyaltyPoints;
        const balanceBefore = wallet.balance;

        wallet.loyaltyPoints += earnedPoints;
        await wallet.save();

        await new Transaction({
            user: savedOrder.user,
            order: savedOrder._id,
            type: 'points_earned',
            amount: earnedPoints,
            paymentMethod: 'points',
            transactionId: `TXN-P${Date.now()}`,
            description: `Earned from Order ${savedOrder.orderId}`,
            balanceBefore: pointsBefore,
            balanceAfter: wallet.loyaltyPoints
        }).save();
        console.log('✔ Loyalty Points & Transaction Recorded');

        await new Transaction({
            user: savedOrder.user,
            order: savedOrder._id,
            type: 'order_payment',
            amount: savedOrder.total,
            paymentMethod: 'cash',
            transactionId: `TXN-M${Date.now()}`,
            description: `Payment for Order ${savedOrder.orderId}`,
            balanceBefore: balanceBefore,
            balanceAfter: wallet.balance
        }).save();
        console.log('✔ Money Transaction Recorded');
    }

    if (savedOrder.paymentStatus === 'Paid' && savedOrder.tipAmount > 0 && savedOrder.waiter) {
        await new Tip({
            waiter: savedOrder.waiter,
            order: savedOrder._id,
            amount: savedOrder.tipAmount,
            status: 'pending'
        }).save();
        console.log('✔ Tip Recorded for Waiter');
    }

    // 4. VERIFICATION
    console.log('\n--- VERIFICATION ---');
    
    const finalWallet = await Wallet.findOne({ user: user._id });
    console.log('Wallet Points (Expected 50):', finalWallet.loyaltyPoints);
    
    const txns = await Transaction.find({ user: user._id });
    console.log('Transactions Count (Expected 2):', txns.length);
    
    const tip = await Tip.findOne({ order: order._id });
    console.log('Tip Found (Expected Yes):', tip ? 'YES' : 'NO', 'Amount:', tip?.amount);

    if (finalWallet.loyaltyPoints === 50 && txns.length === 2 && tip) {
        console.log('\n✅ ALL PROCESSES WORKING CORRECTLY!');
    } else {
        console.log('\n❌ ERROR IN PROCESS FLOW');
    }

    // Cleanup
    await User.findByIdAndDelete(user._id);
    await User.findByIdAndDelete(waiter._id);
    await Order.findByIdAndDelete(order._id);
    await Wallet.deleteMany({ user: user._id });
    await Transaction.deleteMany({ user: user._id });
    await Tip.deleteMany({ order: order._id });

    process.exit(0);
  } catch (err) {
    console.error('Test Failed:', err);
    process.exit(1);
  }
}

testFlow();
