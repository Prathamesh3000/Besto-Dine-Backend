// One-shot migration — CRIT-06.
//
// Sets `isTenantOwner = true` on every user who is currently
// `Restaurant.owner`. Everyone else (sub-admins, waiters, chefs)
// keeps the default `false`.
//
// Run once after deploying the CRIT-06 changes:
//   node migrations/backfillTenantOwner.js
//
// Idempotent — safe to re-run.
require('dotenv').config();
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const User = require('../models/user');

async function main() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('FATAL: MONGO_URL is not set');
        process.exit(1);
    }
    await mongoose.connect(uri, { family: 4 });
    console.log('Connected. Scanning restaurants…');

    const restaurants = await Restaurant.find({ owner: { $ne: null } })
        .select('_id slug owner')
        .lean();

    let promoted = 0;
    let alreadyOwner = 0;
    let missingUser = 0;

    for (const r of restaurants) {
        if (!r.owner) continue;
        const user = await User.findById(r.owner).select('_id email isTenantOwner role');
        if (!user) {
            console.warn(`Restaurant ${r.slug} (${r._id}) references missing user ${r.owner}`);
            missingUser++;
            continue;
        }
        if (user.isTenantOwner === true) {
            alreadyOwner++;
            continue;
        }
        user.isTenantOwner = true;
        await user.save({ validateModifiedOnly: true });
        promoted++;
        console.log(`  Promoted ${user.email} (role=${user.role}) → tenant owner of ${r.slug}`);
    }

    console.log('—');
    console.log(`Promoted:      ${promoted}`);
    console.log(`Already owner: ${alreadyOwner}`);
    console.log(`Missing user:  ${missingUser}`);
    console.log(`Scanned:       ${restaurants.length}`);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('backfillTenantOwner failed:', err);
    process.exit(1);
});
