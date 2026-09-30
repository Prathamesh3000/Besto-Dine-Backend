const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/user');
const Order = require('./models/order');
const Table = require('./models/table');

async function seedOrders() {
  try {
    console.log('--- SEEDING REALISTIC TEST ORDERS ---');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    // 1. Get some existing data to link to
    const customers = await User.find({ role: 'customer' }).limit(5);
    const tables = await Table.find({ isActive: true }).limit(5);

    if (customers.length === 0) {
        console.log('❌ No customers found. Run test_wallet.js first to create test users.');
        process.exit(1);
    }

    const statuses = ['new', 'preparing', 'ready', 'served', 'cancelled'];
    const types = ['dine-in', 'takeaway'];
    const itemsPool = [
        { name: 'Margherita Pizza', price: 299 },
        { name: 'Double Cheese Burger', price: 189 },
        { name: 'Veg Manchurian', price: 150 },
        { name: 'Hakka Noodles', price: 140 },
        { name: 'Paneer Tikka', price: 220 },
        { name: 'Chocolate Lava Cake', price: 99 },
        { name: 'Iced Lemon Tea', price: 80 }
    ];

    // Clear existing orders to avoid duplicate ID errors if you want a clean start
    // await Order.deleteMany({});
    // console.log('✔ Existing orders cleared');

    let createdCount = 0;
    const startCount = await Order.countDocuments();

    for (let i = 1; i <= 15; i++) {
        const customer = customers[Math.floor(Math.random() * customers.length)];
        const table = tables.length > 0 ? tables[Math.floor(Math.random() * tables.length)] : null;
        const type = types[Math.floor(Math.random() * types.length)];
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        
        // Random items for this order
        const numItems = Math.floor(Math.random() * 3) + 1;
        const orderItems = [];
        let total = 0;
        for (let j = 0; j < numItems; j++) {
            const item = itemsPool[Math.floor(Math.random() * itemsPool.length)];
            const qty = Math.floor(Math.random() * 2) + 1;
            orderItems.push({
                name: item.name,
                price: item.price,
                quantity: qty,
                instructions: j === 0 ? 'No spicy' : ''
            });
            total += item.price * qty;
        }

        const prefix = type === 'takeaway' ? 'ORD-T' : 'ORD-';
        const orderId = `${prefix}${(startCount + i).toString().padStart(4, '0')}`;

        await Order.create({
            orderId,
            user: customer._id,
            customerName: customer.name,
            phone: customer.mobile,
            type,
            table: type === 'dine-in' ? table?._id : null,
            items: orderItems,
            total,
            status,
            paymentStatus: status === 'served' ? 'Paid' : 'Pending',
            paymentMethod: status === 'served' ? 'cash' : 'Not selected',
            createdAt: new Date(Date.now() - Math.floor(Math.random() * 100000000)) // Random time in last day
        });
        createdCount++;
    }

    console.log(`\n✅ SUCCESSFULLY SEEDED ${createdCount} TEST ORDERS!`);
    console.log('Check your Orders Dashboard tabs (Live, Takeaway, Past) now.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding Failed:', err);
    process.exit(1);
  }
}

seedOrders();
