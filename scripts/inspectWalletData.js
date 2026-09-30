// Quick read-only DB inspection for wallet/loyalty data
require('dotenv').config();
const mongoose = require('mongoose');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const User = require('../models/user');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);

    const tenants = await Restaurant.find().select('name slug').lean();
    console.log('Tenants:', tenants.length);
    for (const t of tenants) {
        const wallets = await Wallet.find({ restaurant: t._id }).lean();
        const txns = await Transaction.countDocuments({ restaurant: t._id });
        const typeBreak = await Transaction.aggregate([
            { $match: { restaurant: t._id } },
            { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$amount' } } },
        ]);
        console.log(`\n-- ${t.name} (${t.slug}) [${t._id}]`);
        console.log(`   wallets: ${wallets.length}, total balance: ${wallets.reduce((s,w)=>s+(w.balance||0),0)}, total points: ${wallets.reduce((s,w)=>s+(w.loyaltyPoints||0),0)}`);
        console.log(`   transactions: ${txns}`);
        for (const t2 of typeBreak) console.log(`     ${t2._id}: ${t2.count} (sum ${t2.total})`);
        const branches = await Branch.find({ restaurant: t._id }).select('name slug').lean();
        for (const b of branches) {
            const bTxns = await Transaction.countDocuments({ restaurant: t._id, branch: b._id });
            const bNoBranch = await Transaction.countDocuments({ restaurant: t._id, branch: null });
            console.log(`   • ${b.name}: ${bTxns} txns (${bNoBranch} tenant-level)`);
        }
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
