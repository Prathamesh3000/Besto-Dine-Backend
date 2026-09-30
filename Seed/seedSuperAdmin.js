/**
 * seedSuperAdmin.js
 *
 * One-shot seed script for the BestoDine Super Admin module.
 *
 * What it creates (idempotent — re-running is safe):
 *   1. The four default subscription plans (basic, standard, premium, enterprise).
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

const PLANS = [
    {
        name: 'Basic',
        slug: 'basic',
        description: 'For a single cafe or QSR getting started — billing, QR ordering and online payments.',
        price: 499,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 1,
        limits:   { maxBranches: 1, maxStaff: 8,  maxMenuItems: 150,   maxTables: 20,  apiRateLimit: 100 },
        features: {
            dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
            advanceBookingTable: false, advanceBookingHall: false,
            walletLoyalty: false, couponPromotions: false,
            inventory: false, crm: false, tipManagement: false,
            multiBranch: false, staffPerformance: false, paymentGateway: true,
            dataExport: false, webhooks: false, kiosk: false,
            revenueAnalytics: 'basic',
        },
    },
    {
        name: 'Standard',
        slug: 'standard',
        description: 'For growing restaurants — loyalty, coupons, tips and multi-branch.',
        price: 999,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 2,
        limits:   { maxBranches: 3, maxStaff: 20, maxMenuItems: 400,   maxTables: 50,  apiRateLimit: 300 },
        features: {
            dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
            advanceBookingTable: true, advanceBookingHall: false,
            walletLoyalty: true, couponPromotions: true,
            inventory: false, crm: false, tipManagement: true,
            multiBranch: true, staffPerformance: false, paymentGateway: true,
            dataExport: false, webhooks: false, kiosk: false,
            revenueAnalytics: 'standard',
        },
    },
    {
        name: 'Premium',
        slug: 'premium',
        description: 'For established restaurants & chains — inventory, CRM, events and self-order kiosk.',
        price: 1999,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 3,
        limits:   { maxBranches: 10, maxStaff: 60, maxMenuItems: 100000, maxTables: 150, apiRateLimit: 1000 },
        features: {
            dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
            advanceBookingTable: true, advanceBookingHall: true,
            walletLoyalty: true, couponPromotions: true,
            inventory: true, crm: true, tipManagement: true,
            multiBranch: true, staffPerformance: true, paymentGateway: true,
            dataExport: true, webhooks: false, kiosk: true,
            revenueAnalytics: 'advanced',
        },
    },
    {
        name: 'Enterprise',
        slug: 'enterprise',
        description: 'Custom contracts for large chains. Includes dedicated support.',
        price: 0,                    // priced individually
        billingCycle: 'monthly',
        trialDays: 0,
        sortOrder: 4,
        limits:   { maxBranches: 100000, maxStaff: 100000, maxMenuItems: 100000, maxTables: 100000, apiRateLimit: 5000 },
        features: {
            dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
            advanceBookingTable: true, advanceBookingHall: true,
            walletLoyalty: true, couponPromotions: true,
            inventory: true, crm: true, tipManagement: true,
            multiBranch: true, staffPerformance: true, paymentGateway: true,
            dataExport: true, webhooks: true, kiosk: true,
            revenueAnalytics: 'advanced',
        },
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
