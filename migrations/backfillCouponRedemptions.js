/**
 * backfillCouponRedemptions.js
 *
 * One-shot reconciliation for the gap between `Coupon.usageCount` and
 * the `CouponRedemption` collection.
 *
 * Background:
 *   Pre-fix, orderController only wrote a CouponRedemption row when the
 *   order had a logged-in `validUserId`. Guest / QR-scan diners still
 *   incremented `Coupon.usageCount` (because the cap has to count them)
 *   but their redemption was never logged, so the admin Redemption page
 *   showed 0 rows while the parent Offers page stat read e.g. 12.
 *
 *   Going forward, orderController writes a redemption row for both
 *   guests (user: null) and customers, keyed by `order` for idempotency.
 *   This script backfills the historical orders that were missed.
 *
 * What it does:
 *   1. Finds every Order with a non-empty couponCode + couponDiscount > 0
 *   2. For each, checks if a CouponRedemption with that `order` ref
 *      already exists. If yes, skip.
 *   3. Looks up the Coupon by (code + restaurant) to fill in title /
 *      discountType / discountValue / branch.
 *   4. Creates a CouponRedemption row stamped with the order's
 *      createdAt so the Redemption page chronology matches the orders.
 *
 * Idempotent: safe to re-run. Uses the new `order` field on
 * CouponRedemption as the dedup key.
 *
 * Usage:
 *   cd Backend && node migrations/backfillCouponRedemptions.js
 *   cd Backend && node migrations/backfillCouponRedemptions.js --dry   # report only
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/order');
const Coupon = require('../models/coupon');
const CouponRedemption = require('../models/couponRedemption');

const DRY = process.argv.includes('--dry');

async function run() {
    const mongoUrl = process.env.MONGO_URL;
    if (!mongoUrl) {
        console.error('MONGO_URL missing from env'); process.exit(1);
    }
    await mongoose.connect(mongoUrl);
    console.log(`Connected. Mode: ${DRY ? 'DRY-RUN (no writes)' : 'WRITE'}\n`);

    const orders = await Order.find({
        couponCode: { $exists: true, $ne: '' },
        couponDiscount: { $gt: 0 },
    }).sort({ createdAt: 1 }).lean();

    console.log(`Found ${orders.length} orders with a coupon applied.`);

    let created = 0;
    let skippedExisting = 0;
    let skippedNoCoupon = 0;

    for (const order of orders) {
        const existing = await CouponRedemption.findOne({ order: order._id }).lean();
        if (existing) { skippedExisting++; continue; }

        const coupon = await Coupon.findOne({
            code: order.couponCode.toUpperCase(),
            restaurant: order.restaurant,
        }).lean();
        if (!coupon) {
            skippedNoCoupon++;
            console.warn(`  ⚠ Order ${order.orderId || order._id}: no matching coupon for code "${order.couponCode}"`);
            continue;
        }

        // order.total is post-discount; the pre-discount subtotal is approx
        // total + couponDiscount. Good enough for the Redemption table —
        // exact pre-discount subtotals weren't stored on legacy orders.
        const orderValue = (order.total || 0) + (order.couponDiscount || 0);

        if (DRY) {
            created++;
            continue;
        }

        await CouponRedemption.create({
            coupon: coupon._id,
            couponCode: coupon.code,
            couponTitle: coupon.title,
            user: order.user || null,
            order: order._id,
            restaurant: order.restaurant,
            branch: coupon.branch || order.branch || null,
            orderValue,
            discountAmount: order.couponDiscount,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
            createdAt: order.createdAt,
            updatedAt: order.createdAt,
        });
        created++;
    }

    console.log('\n── Summary ───────────────────────────────────────────');
    console.log(`Orders scanned:        ${orders.length}`);
    console.log(`Redemptions created:   ${created}${DRY ? ' (would be)' : ''}`);
    console.log(`Skipped (already in):  ${skippedExisting}`);
    console.log(`Skipped (no coupon):   ${skippedNoCoupon}`);
    console.log('──────────────────────────────────────────────────────\n');

    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
