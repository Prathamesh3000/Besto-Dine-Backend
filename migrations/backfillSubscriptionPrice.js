/**
 * One-off backfill: stamp `subscription.price` (the agreed price) onto every
 * existing tenant that doesn't have it yet — so MRR reflects what each tenant
 * actually pays and stops moving when the plan catalog is edited.
 *
 * Source of truth, in order of preference:
 *   1. The tenant's most recent PAID SubscriptionInvoice amount (paise → ₹).
 *      This is the real money they were charged — most accurate.
 *   2. Their current plan's catalog price (best available for never-charged
 *      / trial tenants).
 *   3. 0 (no plan).
 *
 *   cd Backend && node migrations/backfillSubscriptionPrice.js
 */
const mongoose = require('mongoose');
require('dotenv').config();
const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const SubscriptionInvoice = require('../models/subscriptionInvoice');

(async () => {
    const uri = process.env.MONGO_URL;
    if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected');

    const plans = await SubscriptionPlan.find({}).select('price').lean();
    const priceById = new Map(plans.map(p => [String(p._id), p.price || 0]));

    // Only tenants missing a snapshot price.
    const tenants = await Restaurant.find({
        $or: [{ 'subscription.price': { $exists: false } }, { 'subscription.price': null }],
    }).select('name slug subscription.plan subscription.price').lean();

    console.log(`Found ${tenants.length} tenant(s) to backfill`);
    let updated = 0;

    for (const t of tenants) {
        // 1. latest paid invoice amount (paise → rupees)
        const lastPaid = await SubscriptionInvoice.findOne({ restaurant: t._id, status: 'paid' })
            .sort({ createdAt: -1 }).select('amount').lean();
        let price = null;
        if (lastPaid && typeof lastPaid.amount === 'number') {
            price = Math.round(lastPaid.amount / 100);
        } else if (t.subscription?.plan) {
            price = priceById.get(String(t.subscription.plan)) ?? 0;
        } else {
            price = 0;
        }

        await Restaurant.updateOne({ _id: t._id }, { $set: { 'subscription.price': price } });
        updated++;
        console.log(`• ${t.slug || t.name}: subscription.price = ₹${price}`);
    }

    console.log(`✔ Backfilled ${updated} tenant(s)`);
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
