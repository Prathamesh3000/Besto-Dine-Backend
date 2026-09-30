/**
 * seedTipTopBonusCampaigns.js — populate Bonus Points campaigns
 * (Settings → Wallet → Bonus Points → Create Points Campaign) for the
 * "Hotel Tip Top" tenant.
 *
 * Creates a small set of sample campaigns covering every campaign type
 * the Campaign model supports (`birthday`, `custom`, `first_order`,
 * `referral`). The tenant admin sees them under the "Active Campaigns"
 * list in Settings → Wallet → Bonus Points.
 *
 * Idempotent: skips any campaign whose `name` already exists for this
 * tenant. Pass `--force` to delete and re-seed instead.
 *
 *     cd Backend && node Seed/seedTipTopBonusCampaigns.js
 *     cd Backend && node Seed/seedTipTopBonusCampaigns.js --force
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Restaurant = require('../models/restaurant');
const User       = require('../models/user');
const Campaign   = require('../models/campaign');

const TENANT_SLUG = 'hotel-tip-top';
const FORCE = process.argv.includes('--force');

// Sample campaigns. Dates are absolute so the seed is reproducible —
// adjust the `startDate` / `endDate` strings if you want them to align
// with the current calendar.
const CAMPAIGNS = [
    {
        name: 'Birthday Bonus',
        description: 'Auto-credited 100 points on the customer\'s birthday.',
        type: 'birthday',
        points: 100,
        // birthday campaigns run perpetually — no fixed window
    },
    {
        name: 'Welcome Bonus',
        description: 'One-time 50 points credited on the customer\'s first order.',
        type: 'first_order',
        points: 50,
    },
    {
        name: 'Refer & Earn',
        description: '150 points to both referrer and referee on a successful signup.',
        type: 'referral',
        points: 150,
    },
    {
        name: 'Anniversary Bonanza',
        description: 'Hotel Tip Top anniversary bonus — 200 points on every order in May 2026.',
        type: 'custom',
        points: 200,
        startDate: '2026-05-01',
        endDate:   '2026-05-31',
    },
    {
        name: 'Diwali Special 2026',
        description: '500 bonus points on every order during the Diwali fortnight.',
        type: 'custom',
        points: 500,
        startDate: '2026-10-20',
        endDate:   '2026-11-05',
    },
];

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB');
    if (FORCE) console.log('  --force passed: existing seeded campaigns will be deleted first\n');
    else console.log('  (idempotent mode: existing campaigns by name are preserved)\n');

    // 1. Resolve tenant
    const restaurant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!restaurant) {
        console.error(`✗ No tenant with slug "${TENANT_SLUG}" found.`);
        await mongoose.disconnect();
        process.exit(1);
    }
    console.log(`✔ Found tenant: ${restaurant.name} (${restaurant._id})`);

    // 2. Resolve a createdBy user — tenant owner if linked, else first admin of this tenant.
    let createdBy = restaurant.owner;
    if (!createdBy) {
        const admin = await User.findOne({ role: 'admin', restaurant: restaurant._id }).sort({ createdAt: 1 });
        createdBy = admin?._id;
    }
    if (createdBy) console.log(`  createdBy user: ${createdBy}`);
    else console.log('  (no admin user found for this tenant — campaigns will have createdBy=null)');

    // 3. Optional --force purge
    if (FORCE) {
        const names = CAMPAIGNS.map(c => c.name);
        const del = await Campaign.deleteMany({ restaurant: restaurant._id, name: { $in: names } });
        console.log(`  - removed ${del.deletedCount} prior seeded campaign(s)`);
    }

    // 4. Insert each campaign if it doesn't already exist for this tenant
    let inserted = 0;
    let skipped  = 0;
    for (const c of CAMPAIGNS) {
        const existing = await Campaign.findOne({ restaurant: restaurant._id, name: c.name });
        if (existing) {
            console.log(`  = "${c.name}" already exists — skipped`);
            skipped++;
            continue;
        }

        await Campaign.create({
            restaurant: restaurant._id,
            name:        c.name,
            description: c.description,
            type:        c.type,
            points:      c.points,
            startDate:   c.startDate ? new Date(c.startDate) : undefined,
            endDate:     c.endDate   ? new Date(c.endDate)   : undefined,
            enabled:     true,
            createdBy,
        });
        console.log(`  + created "${c.name}" (${c.type}, ${c.points} pts)`);
        inserted++;
    }

    console.log(`\n✔ Done. inserted=${inserted} skipped=${skipped}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('\nSeed failed:', err);
    process.exit(1);
});
