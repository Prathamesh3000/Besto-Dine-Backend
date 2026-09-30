/**
 * listBranches.js
 *
 * Quick utility: print every branch's _id, name, tenant, and createdAt,
 * so you can easily identify which id to pass to moveBranchData.js.
 *
 * Usage (from Backend/):
 *     node Seed/listBranches.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Branch = require('../models/branch');
const Restaurant = require('../models/restaurant');

async function run() {
    if (!process.env.MONGO_URL) {
        console.error('MONGO_URL not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);

    const tenants = await Restaurant.find({}).select('_id name').lean();
    for (const t of tenants) {
        console.log(`\nTenant: ${t.name} (${t._id})`);
        const branches = await Branch.find({ restaurant: t._id })
            .sort({ createdAt: 1 })
            .select('_id name slug isActive createdAt')
            .lean();
        if (!branches.length) {
            console.log('  (no branches)');
            continue;
        }
        console.log('  idx  _id                        name                  created');
        branches.forEach((b, i) => {
            const ts = new Date(b.createdAt).toISOString().slice(0, 10);
            const flag = b.isActive ? '  ' : ' *'; // * = inactive
            console.log(
                `  ${String(i + 1).padStart(2, ' ')}${flag} ${String(b._id)} ${b.name.padEnd(22, ' ')}${ts}`
            );
        });
        console.log('       (the oldest branch — idx 1 — is where migrateLegacyBranchNulls.js');
        console.log('        swept every legacy null-branch record; that is usually the one to');
        console.log('        move data OUT of.)');
    }

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
