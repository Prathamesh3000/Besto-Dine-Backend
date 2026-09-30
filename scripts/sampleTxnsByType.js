require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/transaction');
const Restaurant = require('../models/restaurant');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const t = await Restaurant.findOne({ slug: 'hotel-tip-top' }).lean();
    const types = ['wallet_recharge', 'refund', 'points_earned', 'points_redeemed', 'order_payment'];
    for (const type of types) {
        const sample = await Transaction.find({ restaurant: t._id, type }).limit(3).select('type amount description paymentMethod status').lean();
        console.log(`\n${type}:`);
        for (const s of sample) console.log(`  amount=${s.amount} pm=${s.paymentMethod} desc="${(s.description||'').slice(0,60)}"`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
