/**
 * One-off: re-price the four standard public plans to the 2026 Pune/India
 * market research tiers (Basic ₹499 / Standard ₹999 / Premium ₹1,999 /
 * Enterprise custom). Updates price + limits + description, and moves online
 * payments into Basic. Uses dot-notation $set so other feature/limit keys are
 * left untouched. Does NOT affect existing tenants (they carry plan snapshots).
 *
 *   cd Backend && node migrations/applyPlanPricing2026.js
 */
const mongoose = require('mongoose');
require('dotenv').config();
const SubscriptionPlan = require('../models/subscriptionPlan');

const UPDATES = [
    {
        slug: 'basic',
        $set: {
            price: 499,
            description: 'For a single cafe or QSR getting started — billing, QR ordering and online payments.',
            'limits.maxStaff': 8,
            'limits.maxMenuItems': 150,
            'limits.maxTables': 20,
            'features.paymentGateway': true,
        },
    },
    {
        slug: 'standard',
        $set: {
            price: 999,
            description: 'For growing restaurants — loyalty, coupons, tips and multi-branch.',
            'limits.maxStaff': 20,
            'limits.maxMenuItems': 400,
            'limits.maxTables': 50,
        },
    },
    {
        slug: 'premium',
        $set: {
            price: 1999,
            description: 'For established restaurants & chains — inventory, CRM, events and self-order kiosk.',
            'limits.maxStaff': 60,
            'limits.maxTables': 150,
        },
    },
    {
        slug: 'enterprise',
        $set: {
            price: 0, // custom / quoted individually
            description: 'Custom contracts for large chains. Dedicated support + API access.',
        },
    },
];

(async () => {
    const uri = process.env.MONGO_URL;
    if (!uri) { console.error('MONGO_URL not set'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected');
    for (const u of UPDATES) {
        const r = await SubscriptionPlan.updateOne({ slug: u.slug }, { $set: u.$set });
        console.log(`• ${u.slug}: matched=${r.matchedCount} modified=${r.modifiedCount}`);
    }
    const after = await SubscriptionPlan.find({ slug: { $in: ['basic', 'standard', 'premium', 'enterprise'] } })
        .select('slug price').sort({ sortOrder: 1 }).lean();
    console.log('After:', after.map(p => `${p.slug}=₹${p.price}`).join(', '));
    await mongoose.disconnect();
    console.log('✔ Done');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
