/**
 * Drop the legacy `one_active_order_per_table` unique index.
 *
 * Why: the independent-orders refactor allows multiple active unpaid
 * orders on the same table simultaneously (each Place Order =
 * a separate Order doc). The old unique index would block the
 * second customer Place Order with E11000.
 *
 * Mongoose schema change alone is not enough — Mongo keeps existing
 * indexes until they're explicitly dropped or `syncIndexes()` runs.
 * This script is a one-time migration; safe to re-run (it noops when
 * the index is already gone).
 *
 * Run:
 *   cd Backend
 *   node migrations/dropOneActiveOrderIndex.js
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

(async () => {
    try {
        if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set in Backend/.env');
        await mongoose.connect(process.env.MONGO_URL);
        console.log('✓ Connected to MongoDB');

        const coll = mongoose.connection.db.collection('orders');
        const indexes = await coll.indexes();
        const target = indexes.find(i => i.name === 'one_active_order_per_table');
        if (!target) {
            console.log('⚠  Index `one_active_order_per_table` not present — nothing to drop.');
        } else {
            await coll.dropIndex('one_active_order_per_table');
            console.log('✓ Dropped index `one_active_order_per_table`. Multiple active orders per table are now allowed.');
        }

        // Re-sync mongoose-managed indexes so the new compound
        // `orders_by_table_status` (added in models/order.js) is
        // built without waiting for the next app restart cycle.
        const Order = require('../models/order');
        await Order.syncIndexes();
        console.log('✓ Synced new indexes from the schema.');

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
})();
