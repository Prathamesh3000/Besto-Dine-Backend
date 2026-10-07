/**
 * seedSuperAdmin.js
 *
 * One-shot seed script for the BestoDine Super Admin module.
 *
 * What it creates (idempotent — re-running is safe):
 *   1. The four default subscription plans (silver, gold, premium, enterprise).
 *   2. The first `superadmin` user with `superadminLevel: 'full'`.
 *
 * Usage:
 *   cd Backend
 *   SUPERADMIN_EMAIL=ops@bestodine.in SUPERADMIN_PASSWORD='<strong-password>' node Seed/seedSuperAdmin.js
 *
 * Defaults (only used if env vars are missing — DO NOT use in production):
 *   email:    superadmin@bestodine.local
 *   password: ChangeMe!2026
 *
 * The seeded super admin is forced to change their password on first login.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const SubscriptionPlan = require('../models/subscriptionPlan');
const User = require('../models/user');

// Silver / Gold / Premium / Enterprise — shared with
// migrations/applyPlanLineup2026.js so fresh installs and migrated
// databases end up with the same catalog.
const { LINEUP: PLANS } = require('../config/planLineup');

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB');

    // ── 1. Plans ──────────────────────────────────────────────────────
    for (const planSpec of PLANS) {
        const existing = await SubscriptionPlan.findOne({ slug: planSpec.slug });
        if (existing) {
            console.log(`• Plan "${planSpec.slug}" already exists — skipping`);
            continue;
        }
        await SubscriptionPlan.create(planSpec);
        console.log(`✔ Created plan: ${planSpec.name}`);
    }

    // ── 2. Bootstrap super admin ─────────────────────────────────────
    const email    = (process.env.SUPERADMIN_EMAIL    || 'superadmin@bestodine.local').toLowerCase();
    const password =  process.env.SUPERADMIN_PASSWORD || 'ChangeMe!2026';
    const name     =  process.env.SUPERADMIN_NAME     || 'BestoDine Operator';

    const existingAdmin = await User.findOne({ email });
    if (existingAdmin) {
        if (existingAdmin.role !== 'superadmin') {
            console.warn(`⚠ User ${email} exists but is not a superadmin. Refusing to overwrite.`);
        } else {
            console.log(`• Super admin ${email} already exists — skipping`);
        }
    } else {
        await User.create({
            name,
            email,
            password,                  // pre-save hook hashes it
            role: 'superadmin',
            superadminLevel: 'full',
            mustChangePassword: true,
            status: 'active',
        });
        console.log(`✔ Created super admin: ${email}`);
        if (!process.env.SUPERADMIN_PASSWORD) {
            console.log('');
            console.log('  ⚠ DEFAULT PASSWORD IN USE — change immediately on first login.');
            console.log(`    email:    ${email}`);
            console.log(`    password: ${password}`);
            console.log('');
        }
    }

    await mongoose.disconnect();
    console.log('✔ Done');
}

run().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
