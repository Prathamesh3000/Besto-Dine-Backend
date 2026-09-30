/**
 * seedOffers.js
 *
 * Seeds a complete set of customer-facing offers for a tenant:
 *   1. Promotions  — banners, popups, featured-item cards, offer cards
 *      that surface on the customer home screen.
 *   2. Coupons     — discount codes with proper validation rules
 *      (min order, usage caps, time-of-day windows, percentage caps,
 *      first-order, etc.) so customers can actually redeem them.
 *
 * Every coupon here passes the validation pipeline in
 * controllers/promotionController.js → applyCoupon():
 *   - isActive: true
 *   - startDate ≤ now ≤ endDate
 *   - startTime/endTime time-of-day window (where set)
 *   - usageCount < usageLimit
 *   - per-user usage tracked via CouponRedemption
 *   - orderValue ≥ minOrderValue
 *   - percentage discount capped at maxDiscountAmount
 *   - branch: null (tenant-level — visible to ALL branches' customers
 *     because customerBranchFilter widens with $or branch:null)
 *
 * Idempotent — matches existing rows by:
 *   - Coupon:    (restaurant, code, branch)
 *   - Promotion: (restaurant, title)
 * Already-present docs are skipped so re-runs are safe.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedOffers.js
 *   TENANT_SLUG=<slug> node Seed/seedOffers.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Coupon = require('../models/coupon');
const Promotion = require('../models/promotion');

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — every offer seeded today should be live RIGHT NOW.
// startDate is one minute in the past so "now ≥ startDate" is always true
// even with clock skew.
// ─────────────────────────────────────────────────────────────────────────────
const NOW = new Date();
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
const START = new Date(NOW.getTime() - 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// COUPONS — 14 customer-redeemable codes covering every common offer
// type. branch: null means tenant-level (visible to every branch's
// customers). Codes are upper-cased by the schema's `uppercase: true`.
// ─────────────────────────────────────────────────────────────────────────────
const COUPONS = [
    // ── First order / welcome ──────────────────────────────────────────
    {
        code: 'WELCOME50',
        title: 'Welcome Offer — Flat ₹50 OFF',
        description: 'Flat ₹50 off on your first order above ₹200. New customers only.',
        discountType: 'fixed_amount',
        discountValue: 50,
        minOrderValue: 200,
        endDate: days(180),
        usageLimit: 5000,
        usagePerUser: 1,
        couponCategory: 'first_order',
    },
    {
        code: 'NEW100',
        title: 'New Customer ₹100 OFF',
        description: 'Get ₹100 off on orders above ₹499. First-timers only.',
        discountType: 'fixed_amount',
        discountValue: 100,
        minOrderValue: 499,
        endDate: days(180),
        usageLimit: 2000,
        usagePerUser: 1,
        couponCategory: 'first_order',
    },

    // ── Percentage off — sitewide ──────────────────────────────────────
    {
        code: 'CAFE10',
        title: '10% OFF — Order ₹500+',
        description: 'Get 10% off on orders above ₹500. Maximum discount ₹200.',
        discountType: 'percentage',
        discountValue: 10,
        minOrderValue: 500,
        maxDiscountAmount: 200,
        endDate: days(120),
        usageLimit: 5000,
        usagePerUser: 5,
        couponCategory: 'all',
    },
    {
        code: 'SAVE15',
        title: '15% OFF — Save Big',
        description: '15% off on bills above ₹799. Maximum discount ₹250.',
        discountType: 'percentage',
        discountValue: 15,
        minOrderValue: 799,
        maxDiscountAmount: 250,
        endDate: days(90),
        usageLimit: 3000,
        usagePerUser: 3,
        couponCategory: 'all',
    },
    {
        code: 'LOYAL20',
        title: 'Loyalty Reward — 20% OFF',
        description: '20% off for our regulars. Min order ₹999, max discount ₹400.',
        discountType: 'percentage',
        discountValue: 20,
        minOrderValue: 999,
        maxDiscountAmount: 400,
        endDate: days(120),
        usageLimit: 2000,
        usagePerUser: 2,
        couponCategory: 'all',
    },

    // ── Flat amount off — bigger orders ────────────────────────────────
    {
        code: 'FLAT100',
        title: 'Flat ₹100 OFF',
        description: 'Flat ₹100 off on orders above ₹599. No upper cap.',
        discountType: 'fixed_amount',
        discountValue: 100,
        minOrderValue: 599,
        endDate: days(60),
        usageLimit: 2000,
        usagePerUser: 3,
        couponCategory: 'all',
    },
    {
        code: 'MEGA500',
        title: 'Mega Saver — ₹500 OFF',
        description: 'Flat ₹500 off on orders above ₹2999. Best for family bookings.',
        discountType: 'fixed_amount',
        discountValue: 500,
        minOrderValue: 2999,
        endDate: days(90),
        usageLimit: 500,
        usagePerUser: 2,
        couponCategory: 'all',
    },
    {
        code: 'FAMILY200',
        title: 'Family Feast ₹200 OFF',
        description: 'Flat ₹200 off on family thali orders above ₹1499.',
        discountType: 'fixed_amount',
        discountValue: 200,
        minOrderValue: 1499,
        endDate: days(120),
        usageLimit: 1000,
        usagePerUser: 3,
        couponCategory: 'all',
    },

    // ── Time-of-day specific — happy hours ─────────────────────────────
    {
        code: 'HAPPY40',
        title: 'Happy Hours 40% OFF',
        description: '40% off between 4 PM and 7 PM. Min order ₹300, max discount ₹250.',
        discountType: 'percentage',
        discountValue: 40,
        minOrderValue: 300,
        maxDiscountAmount: 250,
        startTime: '16:00',
        endTime: '19:00',
        endDate: days(60),
        usageLimit: 3000,
        usagePerUser: 5,
        couponCategory: 'all',
    },
    {
        code: 'TEATIME10',
        title: 'Tea-Time 10% OFF',
        description: '10% off on every order placed between 8 AM and 11 AM. Light bites only.',
        discountType: 'percentage',
        discountValue: 10,
        minOrderValue: 150,
        maxDiscountAmount: 80,
        startTime: '08:00',
        endTime: '11:00',
        endDate: days(60),
        usageLimit: 5000,
        usagePerUser: 10,
        couponCategory: 'all',
    },
    {
        code: 'LATENIGHT15',
        title: 'Late-Night 15% OFF',
        description: '15% off on dinner orders placed between 9 PM and 11 PM.',
        discountType: 'percentage',
        discountValue: 15,
        minOrderValue: 400,
        maxDiscountAmount: 200,
        startTime: '21:00',
        endTime: '23:00',
        endDate: days(60),
        usageLimit: 2000,
        usagePerUser: 5,
        couponCategory: 'all',
    },

    // ── Category-specific (the controller doesn't enforce category yet,
    // but `couponCategory` is stored for the upcoming filter; copy still
    // mentions the category so customers know the intent). ─────────────
    {
        code: 'PIZZA15',
        title: 'Pizza Lovers — 15% OFF',
        description: '15% off on every Pizza. Min ₹400, max discount ₹150.',
        discountType: 'percentage',
        discountValue: 15,
        minOrderValue: 400,
        maxDiscountAmount: 150,
        endDate: days(90),
        usageLimit: 3000,
        usagePerUser: 5,
        couponCategory: 'specific_category',
    },
    {
        code: 'BIRYANI20',
        title: 'Biryani Special — 20% OFF',
        description: '20% off on every Biryani. Min ₹400, max discount ₹120.',
        discountType: 'percentage',
        discountValue: 20,
        minOrderValue: 400,
        maxDiscountAmount: 120,
        endDate: days(90),
        usageLimit: 2000,
        usagePerUser: 4,
        couponCategory: 'specific_category',
    },

    // ── Student / weekday specials ─────────────────────────────────────
    {
        code: 'STUDENT15',
        title: 'Student Special 15% OFF',
        description: '15% off for students. Min ₹250, max discount ₹100. Show ID at counter.',
        discountType: 'percentage',
        discountValue: 15,
        minOrderValue: 250,
        maxDiscountAmount: 100,
        endDate: days(180),
        usageLimit: 5000,
        usagePerUser: 10,
        couponCategory: 'all',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTIONS — 10 banner / popup / featured-item / offer cards that
// surface on the customer home screen. type drives placement:
//   - banner          → top hero carousel
//   - offer           → secondary offers strip
//   - featured_item   → spotlighted dish card
//   - popup           → modal on first home visit
// ─────────────────────────────────────────────────────────────────────────────
const PROMOTIONS = [
    {
        title: 'Summer Rooftop Fest',
        description: 'Cooling mocktails, breezy evenings — every weekend on our rooftop. Use HAPPY40 for 40% off between 4-7 PM.',
        image: 'https://images.unsplash.com/photo-1533777857889-4be7c70b33f7?auto=format&fit=crop&w=1200&q=80',
        type: 'banner',
        endDate: days(60),
        displayOrder: 1,
        targetAudience: 'all',
    },
    {
        title: 'Happy Hours — 40% OFF',
        description: 'Every day, 4 PM to 7 PM. Use code HAPPY40 on bills above ₹300.',
        image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=80',
        type: 'offer',
        link: 'HAPPY40',
        endDate: days(60),
        displayOrder: 2,
        targetAudience: 'all',
    },
    {
        title: 'New Family Combo — ₹999',
        description: '2 Curries + 6 Roti + Jeera Rice + Dal + Salad + Papad + 4 Gulab Jamun. Feeds four.',
        image: 'https://images.unsplash.com/photo-1535007813616-79dc02ba4021?auto=format&fit=crop&w=1200&q=80',
        type: 'featured_item',
        link: '/menu',
        endDate: days(90),
        displayOrder: 3,
        targetAudience: 'all',
    },
    {
        title: 'Welcome Offer — ₹50 OFF',
        description: 'First time here? Use code WELCOME50 for ₹50 off on your first order above ₹200.',
        image: 'https://images.unsplash.com/photo-1551024601-bec78aea704b?auto=format&fit=crop&w=1200&q=80',
        type: 'popup',
        link: 'WELCOME50',
        endDate: days(180),
        displayOrder: 4,
        targetAudience: 'new_customers',
    },
    {
        title: 'Loyalty Reward — 20% OFF',
        description: 'For our regulars. Code LOYAL20 — 20% off on every order above ₹999, max ₹400.',
        image: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1200&q=80',
        type: 'offer',
        link: 'LOYAL20',
        endDate: days(120),
        displayOrder: 5,
        targetAudience: 'loyal_customers',
    },
    {
        title: 'Pizza Lovers Festival',
        description: 'Every pizza, 15% off. Use code PIZZA15. Margherita to Paneer Tikka — all in.',
        image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=1200&q=80',
        type: 'banner',
        link: 'PIZZA15',
        endDate: days(90),
        displayOrder: 6,
        targetAudience: 'all',
    },
    {
        title: 'Biryani Tuesdays',
        description: 'Every Biryani — 20% off with code BIRYANI20. Veg, Chicken, Mutton — all in.',
        image: 'https://images.unsplash.com/photo-1633945274405-b6c8069047b0?auto=format&fit=crop&w=1200&q=80',
        type: 'offer',
        link: 'BIRYANI20',
        endDate: days(90),
        displayOrder: 7,
        targetAudience: 'all',
    },
    {
        title: 'Tea-Time Mornings',
        description: '8 AM to 11 AM — 10% off on chai, coffee and breakfast. Use TEATIME10.',
        image: 'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?auto=format&fit=crop&w=1200&q=80',
        type: 'offer',
        link: 'TEATIME10',
        endDate: days(60),
        displayOrder: 8,
        targetAudience: 'all',
    },
    {
        title: 'Mega Saver — ₹500 OFF',
        description: 'Group booking? Use MEGA500 for ₹500 off on bills above ₹2999.',
        image: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1200&q=80',
        type: 'banner',
        link: 'MEGA500',
        endDate: days(90),
        displayOrder: 9,
        targetAudience: 'all',
    },
    {
        title: 'Student Special',
        description: '15% off, every order. Code STUDENT15. Show your ID at the counter.',
        image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80',
        type: 'offer',
        link: 'STUDENT15',
        endDate: days(180),
        displayOrder: 10,
        targetAudience: 'all',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}"`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant document exists. Run seedDefaultTenant first.');
    return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Coupons
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCoupons(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const c of COUPONS) {
        const code = c.code.toUpperCase();
        const existing = await Coupon.findOne({
            restaurant: tenant._id,
            code,
            branch: null,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Coupon.create({
                ...c,
                code,
                restaurant: tenant._id,
                branch: null,             // tenant-level — visible to every branch
                startDate: START,
                isActive: true,
                usageCount: 0,
            });
            created += 1;
        } catch (err) {
            failed.push({ code, error: err.message });
        }
    }
    return { created, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Promotions
// ─────────────────────────────────────────────────────────────────────────────
async function ensurePromotions(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const p of PROMOTIONS) {
        const existing = await Promotion.findOne({
            restaurant: tenant._id,
            title: p.title,
            branch: null,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Promotion.create({
                ...p,
                restaurant: tenant._id,
                branch: null,             // tenant-level
                startDate: START,
                isActive: true,
            });
            created += 1;
        } catch (err) {
            failed.push({ title: p.title, error: err.message });
        }
    }
    return { created, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.MONGO_URL) {
        console.error('❌ MONGO_URL is not set. Add it to Backend/.env first.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    const tenant = await resolveTenant();
    console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

    // ── Phase 1: Coupons ───────────────────────────────────────────────
    console.log(`\n⏳ Phase 1 / 2 — ensuring ${COUPONS.length} coupons...`);
    const cResult = await ensureCoupons(tenant);
    console.log(`   ✔ Created:  ${cResult.created}`);
    console.log(`   ✔ Existing: ${cResult.skipped}`);
    if (cResult.failed.length) {
        console.log(`   ⚠ Failed:   ${cResult.failed.length}`);
        for (const f of cResult.failed) console.log(`     - ${f.code}: ${f.error}`);
    }

    // ── Phase 2: Promotions ────────────────────────────────────────────
    console.log(`\n⏳ Phase 2 / 2 — ensuring ${PROMOTIONS.length} promotions...`);
    const pResult = await ensurePromotions(tenant);
    console.log(`   ✔ Created:  ${pResult.created}`);
    console.log(`   ✔ Existing: ${pResult.skipped}`);
    if (pResult.failed.length) {
        console.log(`   ⚠ Failed:   ${pResult.failed.length}`);
        for (const f of pResult.failed) console.log(`     - ${f.title}: ${f.error}`);
    }

    // ── Final state ────────────────────────────────────────────────────
    const totalCoupons = await Coupon.countDocuments({ restaurant: tenant._id });
    const activeCoupons = await Coupon.countDocuments({
        restaurant: tenant._id,
        isActive: true,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
    });
    const totalPromos = await Promotion.countDocuments({ restaurant: tenant._id });
    const activePromos = await Promotion.countDocuments({
        restaurant: tenant._id,
        isActive: true,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
    });

    console.log('\n📊 Final state for tenant:');
    console.log(`   Coupons:     ${totalCoupons}  (active right now: ${activeCoupons})`);
    console.log(`   Promotions:  ${totalPromos}  (active right now: ${activePromos})`);

    console.log('\n💡 Customer redemption rules wired (enforced by promotionController.applyCoupon):');
    console.log('   ✓ Date validity      — startDate ≤ now ≤ endDate');
    console.log('   ✓ Time-of-day window — startTime / endTime (HAPPY40, TEATIME10, LATENIGHT15)');
    console.log('   ✓ Min order value    — minOrderValue gate');
    console.log('   ✓ Global usage cap   — atomic usageCount < usageLimit');
    console.log('   ✓ Per-user cap       — usagePerUser via CouponRedemption count');
    console.log('   ✓ Percentage cap     — maxDiscountAmount upper bound');
    console.log('   ✓ Tenant + branch    — branch:null = visible to every branch');

    console.log('\nDone.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedOffers failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
