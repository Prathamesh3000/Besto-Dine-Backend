/**
 * Seed Script: Tip Transactions
 *
 * Creates realistic tip data with full transaction flow:
 *   - Waiter & Chef accounts (if not existing)
 *   - Orders with tip amounts assigned to waiters/chefs
 *   - Pending Tip records linked to orders
 *   - Some already-settled tips with TipSettlement records
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedTipTransactions.js
 *
 * Safe to run multiple times — skips existing data, generates unique IDs.
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/user');
const Order = require('../models/order');
const Table = require('../models/table');
const Tip = require('../models/tip');
const TipSettlement = require('../models/tipSettlement');

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(randomBetween(10, 22), randomBetween(0, 59), 0, 0);
    return d;
}

async function getNextStaffId() {
    const last = await User.findOne({ staffId: /^EMP-/ }).sort({ staffId: -1 });
    let num = 1;
    if (last?.staffId) num = parseInt(last.staffId.split('-')[1]) + 1;
    return `EMP-${num.toString().padStart(3, '0')}`;
}

let _orderCounter = null;
async function getNextOrderId() {
    if (_orderCounter === null) {
        const count = await Order.countDocuments();
        _orderCounter = count + 5000; // offset to avoid collisions
    }
    _orderCounter++;
    return `ORD-${_orderCounter.toString().padStart(4, '0')}`;
}

// ── Staff Data ───────────────────────────────────────────────────────────────

const STAFF_TO_SEED = [
    { name: 'Rajesh Kumar',   email: 'rajesh@cafe.com',   role: 'waiter',  mobile: '9876500001' },
    { name: 'Priya Sharma',   email: 'priya@cafe.com',    role: 'waiter',  mobile: '9876500002' },
    { name: 'Amit Patel',     email: 'amit@cafe.com',     role: 'captain', mobile: '9876500003' },
    { name: 'Sneha Reddy',    email: 'sneha@cafe.com',    role: 'waiter',  mobile: '9876500004' },
    { name: 'Chef Vikram',    email: 'vikram@cafe.com',   role: 'chef',    mobile: '9876500005', kitchenResponsibility: 'both' },
];

const MENU_ITEMS = [
    { name: 'Margherita Pizza',     price: 299, vegType: 'veg',     category: 'Main Course' },
    { name: 'Butter Chicken',       price: 349, vegType: 'non-veg', category: 'Main Course' },
    { name: 'Paneer Tikka',         price: 220, vegType: 'veg',     category: 'Starters' },
    { name: 'Chicken Wings',        price: 280, vegType: 'non-veg', category: 'Starters' },
    { name: 'Veg Manchurian',       price: 180, vegType: 'veg',     category: 'Chinese' },
    { name: 'Hakka Noodles',        price: 160, vegType: 'veg',     category: 'Chinese' },
    { name: 'Double Cheese Burger', price: 199, vegType: 'non-veg', category: 'Burgers' },
    { name: 'Masala Dosa',          price: 120, vegType: 'veg',     category: 'South Indian' },
    { name: 'Cold Coffee',          price: 90,  vegType: 'veg',     category: 'Beverages' },
    { name: 'Chocolate Brownie',    price: 130, vegType: 'veg',     category: 'Desserts' },
];

const TIP_AMOUNTS = [20, 30, 40, 50, 60, 80, 100, 150];

// ── Main Seed Function ───────────────────────────────────────────────────────

async function seed() {
    try {
        console.log('\n🚀 SEEDING TIP TRANSACTIONS');
        console.log('─'.repeat(50));

        await mongoose.connect(process.env.MONGO_URL);
        console.log('✔ Connected to MongoDB\n');

        // ── 1. Ensure staff accounts exist ──────────────────────────────
        console.log('📋 Step 1: Creating staff accounts...');
        const staffMembers = [];

        for (const s of STAFF_TO_SEED) {
            let user = await User.findOne({ email: s.email });
            if (!user) {
                const staffId = await getNextStaffId();
                user = await User.create({
                    name: s.name,
                    email: s.email,
                    password: 'Staff@123',
                    mobile: s.mobile,
                    role: s.role,
                    staffId,
                    kitchenResponsibility: s.kitchenResponsibility || '',
                    status: 'active',
                    permissions: s.role === 'waiter'
                        ? { tables: true, addOrders: true, editMenu: false, crm: false, updateOrderStatus: false, reservation: false, viewPayments: false, accessKitchen: false, refund: false, manageStaff: false }
                        : s.role === 'captain'
                            ? { tables: true, addOrders: true, editMenu: false, crm: false, updateOrderStatus: true, reservation: true, viewPayments: true, accessKitchen: false, refund: false, manageStaff: false }
                            : {}
                });
                console.log(`   ✔ Created ${s.role}: ${s.name} (${staffId})`);
            } else {
                console.log(`   ⏩ Exists: ${s.name}`);
            }
            staffMembers.push(user);
        }

        // Separate waiters/captains (tip receivers) from chefs
        const tipReceivers = staffMembers.filter(s => ['waiter', 'captain'].includes(s.role));
        const chefs = staffMembers.filter(s => s.role === 'chef');

        // Get an admin for settlements
        const admin = await User.findOne({ role: 'admin' });
        if (!admin) {
            console.log('   ⚠ No admin account found — settlements will be skipped');
        }

        // Get tables
        const tables = await Table.find({ isActive: true }).limit(10).lean();

        // ── 2. Create orders with tips ──────────────────────────────────
        console.log('\n📦 Step 2: Creating orders with tips...');

        const ordersToCreate = 30;
        let orderCounter = 0;
        const createdOrders = [];

        for (let i = 0; i < ordersToCreate; i++) {
            const waiter = randomFrom(tipReceivers);
            const chef = chefs.length > 0 ? randomFrom(chefs) : null;
            const table = tables.length > 0 ? randomFrom(tables) : null;
            const dayOffset = randomBetween(0, 14); // Spread over last 2 weeks
            const createdAt = daysAgo(dayOffset);

            // Random items
            const numItems = randomBetween(1, 4);
            const items = [];
            let total = 0;
            for (let j = 0; j < numItems; j++) {
                const item = randomFrom(MENU_ITEMS);
                const qty = randomBetween(1, 3);
                items.push({
                    name: item.name,
                    price: item.price,
                    quantity: qty,
                    category: item.category,
                    vegType: item.vegType,
                });
                total += item.price * qty;
            }

            const tipAmount = randomFrom(TIP_AMOUNTS);
            const orderId = await getNextOrderId();

            // Preparation timestamps for performance tracking
            const prepStarted = new Date(createdAt.getTime() + randomBetween(2, 10) * 60000); // 2-10 min after order
            const prepDuration = randomBetween(8, 35); // 8-35 min prep time
            const prepCompleted = new Date(prepStarted.getTime() + prepDuration * 60000);

            const order = await Order.create({
                orderId,
                type: 'dine-in',
                user: null, // guest orders
                customerName: randomFrom(['Guest', 'Ravi', 'Meera', 'Arjun', 'Kavita', 'Suresh', 'Deepa']),
                table: table?._id || null,
                items,
                total: total + tipAmount,
                tipAmount,
                status: 'served',
                paymentStatus: 'Paid',
                paymentMethod: randomFrom(['Cash', 'Online', 'UPI']),
                amountPaid: total + tipAmount,
                waiter: waiter._id,
                chef: chef?._id || null,
                preparationStartedAt: prepStarted,
                preparationCompletedAt: prepCompleted,
                createdAt,
                updatedAt: prepCompleted,
            });

            createdOrders.push({ order, waiter, tipAmount });
            orderCounter++;
        }
        console.log(`   ✔ Created ${orderCounter} orders with tips`);

        // ── 3. Create Tip records ───────────────────────────────────────
        console.log('\n💰 Step 3: Creating tip records...');

        let pendingCount = 0;
        let settledCount = 0;
        const pendingTips = [];
        const tipsForSettlement = {}; // grouped by waiter ID

        for (const { order, waiter, tipAmount } of createdOrders) {
            // Skip if tip already exists for this order
            const exists = await Tip.findOne({ order: order._id });
            if (exists) continue;

            const tip = await Tip.create({
                waiter: waiter._id,
                order: order._id,
                amount: tipAmount,
                status: 'pending',
                createdAt: order.createdAt,
            });

            pendingTips.push(tip);

            // Group some tips for settlement (older ones)
            const daysOld = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysOld > 3) {
                // Mark these for settlement
                const wId = waiter._id.toString();
                if (!tipsForSettlement[wId]) {
                    tipsForSettlement[wId] = { waiter, tips: [], totalAmount: 0 };
                }
                tipsForSettlement[wId].tips.push(tip);
                tipsForSettlement[wId].totalAmount += tipAmount;
            }
            pendingCount++;
        }
        console.log(`   ✔ Created ${pendingCount} tip records`);

        // ── 4. Create settlements for older tips (with transactions) ────
        if (admin && Object.keys(tipsForSettlement).length > 0) {
            console.log('\n✅ Step 4: Settling older tips (using transactions)...');

            for (const [waiterId, data] of Object.entries(tipsForSettlement)) {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    // Create settlement record
                    const settlement = await TipSettlement.create([{
                        waiter: waiterId,
                        amount: data.totalAmount,
                        tipsSettledCount: data.tips.length,
                        paymentMethod: randomFrom(['Cash', 'Online']),
                        settledBy: admin._id,
                        note: `Auto-settled by seed script`,
                        createdAt: daysAgo(1), // settled yesterday
                    }], { session });

                    // Update tips to settled
                    await Tip.updateMany(
                        { _id: { $in: data.tips.map(t => t._id) }, status: 'pending' },
                        { status: 'settled', settlement: settlement[0]._id },
                        { session }
                    );

                    await session.commitTransaction();
                    session.endSession();

                    settledCount += data.tips.length;
                    console.log(`   ✔ Settled ${data.tips.length} tips (₹${data.totalAmount}) for ${data.waiter.name}`);
                } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                    console.log(`   ⚠ Settlement failed for ${data.waiter.name}: ${err.message}`);
                }
            }
        } else {
            console.log('\n⏩ Step 4: Skipped settlements (no admin or no old tips)');
        }

        // ── Summary ─────────────────────────────────────────────────────
        const finalPending = await Tip.countDocuments({ status: 'pending' });
        const finalSettled = await Tip.countDocuments({ status: 'settled' });
        const finalSettlements = await TipSettlement.countDocuments();

        console.log('\n' + '═'.repeat(50));
        console.log('📊 SEED COMPLETE — SUMMARY');
        console.log('═'.repeat(50));
        console.log(`   Staff created/verified : ${STAFF_TO_SEED.length}`);
        console.log(`   Orders created         : ${orderCounter}`);
        console.log(`   Tips (pending)         : ${finalPending}`);
        console.log(`   Tips (settled)         : ${finalSettled}`);
        console.log(`   Settlement records     : ${finalSettlements}`);
        console.log('');
        console.log('🔑 Staff Login Credentials:');
        console.log('─'.repeat(50));
        for (const s of STAFF_TO_SEED) {
            console.log(`   ${s.role.padEnd(8)} | ${s.email.padEnd(22)} | Staff@123`);
        }
        console.log('');

        await mongoose.connection.close();
        console.log('✔ Database connection closed');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ SEED FAILED:', err.message);
        console.error(err.stack);
        await mongoose.connection.close();
        process.exit(1);
    }
}

seed();
