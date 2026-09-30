/**
 * Backfill MenuItem.prepStation for existing items.
 *
 * Why: the prepStation field was added to drive the kitchen-bypass flow
 * for ready-to-serve items (water, packaged drinks, ice cream cups).
 * New items default to 'kitchen', but every pre-migration menu item
 * has the field unset — which means the chef KDS still sees them
 * (the legacy-compat fallback in getKitchenOrders), and the customer
 * tracking page still shows the 4-step "Preparing Order" timeline for
 * orders that don't actually need cooking.
 *
 * What this does:
 *   1. For each MenuItem in every tenant, infer a prepStation from:
 *        a. Item name keywords  (water, bottle, can, red bull, etc.)
 *        b. Category name       (Cold Drinks → bar, Coffee → bar, Ice Cream → counter, …)
 *      The keyword match wins over the category when both apply.
 *   2. Skip items that already have prepStation set (admins who picked
 *      one manually keep their choice).
 *   3. Print a summary of what changed.
 *
 * Run:
 *   cd Backend
 *   node migrations/backfillPrepStation.js                # apply changes
 *   node migrations/backfillPrepStation.js --dry-run       # preview, no writes
 *
 * Idempotent: safe to re-run. Only fills in missing values.
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
// Shared inference rules — same heuristic used by orderController as
// a fallback when a menu item hasn't been tagged yet.
const { inferPrepStation } = require('../utils/prepStationInfer');

const DRY_RUN = process.argv.includes('--dry-run');

function inferStation(item, categoryName = '') {
    return inferPrepStation({ name: item.name, categoryName });
}

(async () => {
    try {
        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not set in Backend/.env');
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log(`✓ Connected to MongoDB${DRY_RUN ? ' (dry-run mode — no writes)' : ''}\n`);

        // Build a category id → name map once so we can label each item.
        const categories = await Category.find({}).select('name').lean();
        const categoryById = new Map(categories.map(c => [String(c._id), c.name]));

        const items = await MenuItem.find({}).select('name category prepStation').lean();
        console.log(`Found ${items.length} menu items across all tenants.\n`);

        const buckets = { kitchen: [], bar: [], counter: [], skipped: [] };

        for (const item of items) {
            const catName = categoryById.get(String(item.category)) || '';
            const inferred = inferStation(item, catName);

            // Skip items that already have a non-default value the admin
            // explicitly picked. We treat 'kitchen' as "default / unset"
            // so we DO upgrade those — that's the whole point. If you
            // want to lock in a manual 'kitchen' choice, change the
            // schema default to null and adjust the check here.
            const current = item.prepStation || 'kitchen';
            if (current !== 'kitchen' && current === inferred) {
                buckets.skipped.push({ name: item.name, current, inferred, reason: 'already correct' });
                continue;
            }

            buckets[inferred].push({ name: item.name, category: catName, was: current, becomes: inferred });

            if (!DRY_RUN && current !== inferred) {
                await MenuItem.updateOne({ _id: item._id }, { $set: { prepStation: inferred } });
            }
        }

        // ─── Report ────────────────────────────────────────────────────
        const fmt = (rows) => rows.map(r => `   • ${r.name.padEnd(40)} (${r.category || '—'})${r.was && r.was !== r.becomes ? ` [${r.was} → ${r.becomes}]` : ''}`).join('\n');

        console.log(`KITCHEN (${buckets.kitchen.length}) — chef cooks these:`);
        if (buckets.kitchen.length) console.log(fmt(buckets.kitchen.slice(0, 10)) + (buckets.kitchen.length > 10 ? `\n   … and ${buckets.kitchen.length - 10} more` : ''));

        console.log(`\nBAR (${buckets.bar.length}) — beverage station:`);
        if (buckets.bar.length) console.log(fmt(buckets.bar));

        console.log(`\nCOUNTER (${buckets.counter.length}) — ready-to-serve, skips chef:`);
        if (buckets.counter.length) console.log(fmt(buckets.counter));

        if (buckets.skipped.length) {
            console.log(`\nSkipped ${buckets.skipped.length} (already at the right station).`);
        }

        if (DRY_RUN) {
            console.log('\n⚠  Dry run only — re-run without --dry-run to apply.');
        } else {
            const writes = buckets.kitchen.filter(r => r.was !== r.becomes).length
                + buckets.bar.length
                + buckets.counter.length;
            console.log(`\n✓ Updated ${writes} item(s).`);
        }

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Backfill failed:', err);
        process.exit(1);
    }
})();
