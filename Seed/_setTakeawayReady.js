// TEMP — mark one branch-routed takeaway 'ready' to test waiter serve flow.
// `node Seed/_setTakeawayReady.js` (sets ready) | `... new` (reset to new).
const mongoose = require('mongoose');
require('dotenv').config();
const ORDER = 'ORT-260606-6528DD';
(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const Order = require('../models/order');
    const status = process.argv[2] === 'new' ? 'new' : 'ready';
    const o = await Order.findOne({ orderId: ORDER });
    if (!o) { console.log('order not found'); await mongoose.connection.close(); return; }
    o.status = status;
    await o.save();
    console.log(`Set ${ORDER} → ${status} (type=${o.type}, paymentStatus=${o.paymentStatus})`);
    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
