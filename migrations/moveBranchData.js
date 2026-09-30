/**
 * moveBranchData.js
 *
 * Repair tool for the branch-leak symptom where selecting a specific
 * branch on the admin dashboard surfaces data that clearly belongs to
 * a different branch. Root cause: migrateLegacyBranchNulls.js swept
 * every legacy `branch: null` record into the OLDEST active branch
 * when multiBranch was first enabled — so that branch now holds data
 * that was never really "its".
 *
 * This script moves Orders, Tables, Inventory, Wallets, Recipes,
 * Transactions, Coupons, CouponRedemptions, AdvanceBookings, Promotions,
 * Areas, and Settings from one branch to another within the same tenant.
 *
 * Safety rails:
 *   - --from and --to are required and must both belong to the same tenant.
 *   - --before=YYYY-MM-DD limits the move to records with createdAt
 *     strictly BEFORE that date (so your genuinely new-at-destination
 *     activity isn't disturbed).
 *   - --dry prints counts but writes nothing.
 *   - Records whose branch is something OTHER than --from are untouched.
 *
 * Usage (from Backend/):
 *     node Seed/listBranches.js                                # find ids
 *     node migrations/moveBranchData.js --from=<oldId> --to=<newId> --dry
 *     node migrations/moveBranchData.js --from=<oldId> --to=<newId>
 *     node migrations/moveBranchData.js --from=<oldId> --to=<newId> --before=2026-04-01
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Branch            = require('../models/branch');
const Order             = require('../models/order');
const Table             = require('../models/table');
const Inventory         = require('../models/inventory');
const Wallet            = require('../models/wallet');
const Recipe            = require('../models/recipe');
const Transaction       = require('../models/transaction');
const Coupon            = require('../models/coupon');
const CouponRedemption  = require('../models/couponRedemption');
const AdvanceBooking    = require('../models/advanceBooking');
const Promotion         = require('../models/promotion');
const Area              = require('../models/area');
const Settings          = require('../models/settings');

function parseArgs() {
    const out = { from: null, to: null, before: null, dry: false };
    for (const arg of process.argv.slice(2)) {
        if (arg === '--dry') out.dry = true;
        else if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length);
        else if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length);
        else if (arg.startsWith('--before=')) out.before = arg.slice('--before='.length);
    }
    return out;
}

const COLLECTIONS = [
    { name: 'Order',            Model: Order },
    { name: 'Table',            Model: Table },
    { name: 'Inventory',        Model: Inventory },
    { name: 'Wallet',           Model: Wallet },
    { name: 'Recipe',           Model: Recipe },
    { name: 'Transaction',      Model: Transaction },
    { name: 'Coupon',           Model: Coupon },
    { name: 'CouponRedemption', Model: CouponRedemption },
    { name: 'AdvanceBooking',   Model: AdvanceBooking },
    { name: 'Promotion',        Model: Promotion },
    { name: 'Area',             Model: Area },
    { name: 'Settings',         Model: Settings },
];

async function run() {
    const { from, to, before, dry } = parseArgs();
    if (!from || !to) {
        console.error('Usage: node migrations/moveBranchData.js --from=<id> --to=<id> [--before=YYYY-MM-DD] [--dry]');
        process.exit(1);
    }
    if (!mongoose.isValidObjectId(from) || !mongoose.isValidObjectId(to)) {
        console.error('--from and --to must be valid ObjectIds. Run `node Seed/listBranches.js` to find them.');
        process.exit(1);
    }
    if (String(from) === String(to)) {
        console.error('--from and --to cannot be the same branch.');
        process.exit(1);
    }
    if (!process.env.MONGO_URL) {
        console.error('MONGO_URL not set in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log(dry ? 'DRY RUN — no writes' : 'APPLYING changes');

    const fromDoc = await Branch.findById(from).lean();
    const toDoc = await Branch.findById(to).lean();
    if (!fromDoc || !toDoc) {
        console.error('Could not find one of the branches. Run listBranches.js to confirm ids.');
        await mongoose.disconnect();
        process.exit(1);
    }
    if (String(fromDoc.restaurant) !== String(toDoc.restaurant)) {
        console.error('--from and --to belong to different tenants. Refusing to move across tenants.');
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`  from: ${fromDoc.name} (${fromDoc._id})`);
    console.log(`  to:   ${toDoc.name} (${toDoc._id})`);
    if (before) console.log(`  before: records with createdAt < ${before}`);
    console.log();

    const fromId = new mongoose.Types.ObjectId(from);
    const toId = new mongoose.Types.ObjectId(to);
    const tenantId = fromDoc.restaurant;

    const filterBase = { restaurant: tenantId, branch: fromId };
    if (before) {
        const beforeDate = new Date(before);
        if (isNaN(beforeDate.getTime())) {
            console.error('Invalid --before date. Use YYYY-MM-DD.');
            await mongoose.disconnect();
            process.exit(1);
        }
        filterBase.createdAt = { $lt: beforeDate };
    }

    let grandTotal = 0;
    for (const { name, Model } of COLLECTIONS) {
        const count = await Model.countDocuments(filterBase);
        grandTotal += count;
        if (count === 0) {
            console.log(`  ${name.padEnd(18)} 0`);
            continue;
        }
        if (dry) {
            console.log(`  ${name.padEnd(18)} would move ${count}`);
        } else {
            // Settings has a unique index on (restaurant, branch). If the
            // destination already has a Settings doc, merging would fail —
            // delete the source's Settings instead of moving it.
            if (name === 'Settings') {
                const destExists = await Settings.exists({ restaurant: tenantId, branch: toId });
                if (destExists) {
                    const r = await Settings.deleteMany(filterBase);
                    console.log(`  ${name.padEnd(18)} deleted ${r.deletedCount} (destination already has one)`);
                    continue;
                }
            }
            const r = await Model.updateMany(filterBase, { $set: { branch: toId } });
            console.log(`  ${name.padEnd(18)} moved ${r.modifiedCount}`);
        }
    }

    console.log('\nTotal records touched:', grandTotal);
    if (dry) console.log('\nRe-run without --dry to apply.');

    await mongoose.disconnect();
    console.log('Done.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
