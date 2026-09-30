/**
 * One-shot diagnostic — inspect a single menu item's pricing as the
 * server would resolve it for an order.
 *
 *   node Seed/inspectMenuItem.js 69f0152b947a1a74e33c696d
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MenuItem = require('../models/menuItem');
const { resolvePrice } = require('../utils/priceResolver');

async function main() {
    const id = process.argv[2];
    if (!id) { console.error('Usage: node Seed/inspectMenuItem.js <menuItemId>'); process.exit(1); }

    await mongoose.connect(process.env.MONGO_URL);
    const m = await MenuItem.findById(id).lean();
    if (!m) { console.log('No menu item with that id'); process.exit(0); }

    console.log('\nRaw menu document:');
    console.log({
        _id: m._id,
        name: m.name,
        restaurant: m.restaurant,
        branch: m.branch,
        basePrice: m.basePrice,
        offerPercentage: m.offerPercentage,
        finalPrice: m.finalPrice,
        offerExpiryDate: m.offerExpiryDate,
        branchPricesCount: (m.branchPrices || []).length,
        branchPrices: m.branchPrices || [],
        sizes: m.sizes,
        toppings: m.toppings?.length,
        status: m.status,
    });

    console.log('\nresolvePrice() with no branch (default):');
    console.log(resolvePrice(m, null));

    if ((m.branchPrices || []).length) {
        for (const bp of m.branchPrices) {
            console.log(`\nresolvePrice() for branch ${bp.branch}:`);
            console.log(resolvePrice(m, bp.branch));
        }
    }

    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('inspect failed:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
