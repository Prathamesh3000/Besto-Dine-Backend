/**
 * One-time migration for Phase 6 step 4 — rename Order.branch (string)
 * → Order.pickupLocation (string).
 *
 * Before Phase 6, Order.branch was a free-text label for the takeaway
 * pickup location (tenant name). Phase 6 introduced a real
 * Branch model and repurposed `branch` on Order to be an ObjectId
 * reference. To avoid Mongoose cast failures on existing rows, we
 * rename the legacy string field to `pickupLocation`.
 *
 * The script uses MongoDB's native `$rename` aggregation update,
 * applied only to documents where `branch` is currently a string
 * (not already an ObjectId, not already migrated). Idempotent —
 * safe to re-run.
 *
 * Usage:
 *   cd Backend
 *   node migrations/migrateOrderPickupLocation.js
 *
 * After running, Order.pickupLocation holds the legacy labels and
 * Order.branch is null for every migrated row (the new ObjectId
 * field gets populated going forward by the createOrder flow).
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { family: 4 });
    console.log('✔ Connected to MongoDB');

    const Order = mongoose.model(
        'Order',
        new mongoose.Schema({}, { strict: false, collection: 'orders' })
    );

    // Find orders whose `branch` is a string (the pre-migration state).
    // Orders created AFTER the migration will either have branch:null
    // or branch:ObjectId and should be left alone.
    const filter = { branch: { $type: 'string' } };

    const count = await Order.countDocuments(filter);
    if (count === 0) {
        console.log('✔ No orders need migration (all clean or already done)');
        await mongoose.disconnect();
        return;
    }
    console.log(`→ Found ${count} orders with legacy branch string`);

    // Use an aggregation pipeline update so we can copy `branch` to
    // `pickupLocation` AND clear `branch` to null in one pass.
    // Use the underlying collection so Mongoose doesn't complain about
    // passing an aggregation pipeline to updateMany (Mongoose 9+).
    const result = await Order.collection.updateMany(filter, [
        {
            $set: {
                pickupLocation: '$branch',
                branch: null,
            },
        },
    ]);

    console.log(`✔ Migrated ${result.modifiedCount}/${count} orders`);
    console.log('  branch: "Downtown" (string)  →  pickupLocation: "Downtown", branch: null');

    // Sanity check: no strings should remain
    const remaining = await Order.countDocuments({ branch: { $type: 'string' } });
    if (remaining > 0) {
        console.warn(`⚠ ${remaining} orders still have branch as string — re-run?`);
    } else {
        console.log('✔ Verified: zero orders have branch as string');
    }

    await mongoose.disconnect();
    console.log('✔ Disconnected');
}

main().catch(err => {
    console.error('✗ Migration failed:', err);
    process.exit(1);
});
