/**
 * showOrder.js — READ-ONLY. Prints one order's stored totals, items and the
 * other recent orders on the same table.
 *
 *   node Seed/showOrder.js <restaurant-slug> <orderId>      e.g. ORD-261030-FDC34F
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Order = require('../models/order');

(async () => {
    const [slug, orderId] = process.argv.slice(2);
    if (!slug || !orderId) {
        console.error('Usage: node Seed/showOrder.js <restaurant-slug> <orderId>');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000, family: 4, autoIndex: false });
    const restaurant = await Restaurant.findOne({ slug }).lean();
    if (!restaurant) throw new Error(`No restaurant "${slug}"`);
    const o = await Order.findOne({ restaurant: restaurant._id, orderId }).lean();
    if (!o) throw new Error(`No order ${orderId}`);
    console.log({
        orderId: o.orderId, status: o.status, type: o.type, source: o.source, table: String(o.table || ''),
        createdAt: o.createdAt, subtotalFromItems: (o.items || []).reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0),
        gst: o.gst, gstPercentage: o.gstPercentage, serviceCharge: o.serviceCharge,
        serviceChargePercentage: o.serviceChargePercentage, additionalChargesTotal: o.additionalChargesTotal, total: o.total,
        couponDiscount: o.couponDiscount, tipAmount: o.tipAmount, splitParent: o.splitParent && String(o.splitParent),
    });
    console.table((o.items || []).map((i) => ({ name: i.name, price: i.price, qty: i.quantity, kotNo: i.kotNo })));
    if (o.table) {
        const sibs = await Order.find({ restaurant: restaurant._id, table: o.table, _id: { $ne: o._id } })
            .sort({ createdAt: -1 }).limit(5).lean();
        console.log('Other recent orders on this table:');
        console.table(sibs.map((s) => ({ orderId: s.orderId, status: s.status, total: s.total, created: s.createdAt && s.createdAt.toISOString() })));
    }
    await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
