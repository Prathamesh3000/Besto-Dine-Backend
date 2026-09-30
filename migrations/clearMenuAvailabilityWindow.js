/**
 * One-shot — clear startTime / endTime on all MenuItems and Combos so
 * every item is visible 24x7 to customers. availableDays is left
 * untouched (most tenants keep it as Mon-Sun anyway, and a few items
 * that legitimately should be weekend-only stay that way).
 *
 *   node migrations/clearMenuAvailabilityWindow.js
 *
 * Run again any time after a bulk import re-stamps the fields.
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');

async function main() {
    await mongoose.connect(process.env.MONGO_URL);

    const beforeMenu = await MenuItem.countDocuments({
        $or: [
            { startTime: { $exists: true, $ne: '' } },
            { endTime:   { $exists: true, $ne: '' } },
        ],
    });
    const beforeCombo = await Combo.countDocuments({
        $or: [
            { startTime: { $exists: true, $ne: '' } },
            { endTime:   { $exists: true, $ne: '' } },
        ],
    });

    const menuRes = await MenuItem.updateMany(
        {},
        { $set: { startTime: '', endTime: '' } },
    );
    const comboRes = await Combo.updateMany(
        {},
        { $set: { startTime: '', endTime: '' } },
    );

    console.log(`MenuItems had time window:   ${beforeMenu}`);
    console.log(`MenuItems updated:           ${menuRes.modifiedCount}`);
    console.log(`Combos had time window:      ${beforeCombo}`);
    console.log(`Combos updated:              ${comboRes.modifiedCount}`);

    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('clear failed:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
