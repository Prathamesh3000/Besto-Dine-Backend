#!/usr/bin/env node
/**
 * staging-seed-heavy.js — bulk "heavy data" for the desktop stability checks
 * (desktop/e2e check 42: menu / orders / dashboard / export under load).
 *
 *   node scripts/with-env.js .env.staging node scripts/staging-seed-heavy.js
 *   node scripts/with-env.js .env.staging node scripts/staging-seed-heavy.js --items 5000 --orders 5000 --days 90
 *
 * Adds to the tenant `staging-cafe` (never to any other tenant):
 *   - 20 categories      HEAVY-CAT-1 … HEAVY-CAT-20 (tenant-level, kind food/beverages alternating)
 *   - 5,000 menu items   HEAVY-1 … HEAVY-5000, spread over those categories, every odd one
 *                        `inStock: false` (half unavailable), prices ₹50–₹499
 *   - 5,000 orders       orderId HEAVY-ORD-1 … HEAVY-ORD-5000, status served + paymentStatus Paid,
 *                        createdAt spread evenly over the last --days (default 90), 1–3 HEAVY items
 *                        each, GST 5 % like Seed/seedStaging.js, 25 % takeaway / 75 % dine-in
 *
 * IDEMPOTENT and ADDITIVE: it looks up what already exists by name / orderId and inserts only
 * the missing rows (bulk insertMany, chunks of 1,000). It never drops a collection, never deletes
 * and never touches rows that are not HEAVY-*. Re-running prints the counts and exits.
 *
 * SAFETY: utils/stagingGuard.assertStagingDb(MONGO_URL) runs before any model is loaded and
 * again on the live connection; GET <api>/health must say appEnv === 'staging' when the server
 * is reachable (a reachable server that is NOT staging aborts the run).
 *
 * Model code is the same as Seed/seedStaging.js / __tests__/integration/helpers/seed.js: every
 * model file is registered first so the tenant-scope plugin, indexes and defaults apply; items
 * carry finalPrice explicitly because insertMany does not run the pre('save') price hook.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// 1. Guard FIRST — before any model, before any connection.
const { assertStagingDb, STAGING_DB_NAME } = require('../utils/stagingGuard');
const MONGO_URL = assertStagingDb(process.env.MONGO_URL, 'scripts/staging-seed-heavy.js');

const argValue = (name, dflt) => {
    const eq = process.argv.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const WANT_ITEMS = Math.max(0, parseInt(argValue('--items', '5000'), 10) || 0);
const WANT_ORDERS = Math.max(0, parseInt(argValue('--orders', '5000'), 10) || 0);
const DAYS = Math.max(1, parseInt(argValue('--days', '90'), 10) || 90);
const CATEGORIES = 20;
const TENANT_SLUG = process.env.STAGING_TENANT_SLUG || 'staging-cafe';
const API_BASE = (process.env.STAGING_API_URL || `http://127.0.0.1:${process.env.PORT || 5001}`).replace(/\/$/, '');
const GST_PCT = 5;
const CHUNK = 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const TAG = '[seed-heavy]';

// Register every model (indexes, tenant-scope plugin) exactly like Seed/seedStaging.js.
const MODELS_DIR = path.join(__dirname, '..', 'models');
for (const file of fs.readdirSync(MODELS_DIR)) if (file.endsWith('.js')) require(path.join(MODELS_DIR, file));
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');
const Table = require('../models/table');
const User = require('../models/user');
const Order = require('../models/order');

/** 2. Second guard: the API that serves this database must call itself staging (when reachable). */
async function assertStagingApi() {
    let res;
    try { res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) }); } catch (err) {
        console.warn(`${TAG} ${API_BASE}/health unreachable (${err.cause?.message || err.message}) — continuing on the MONGO_URL guard alone`);
        return;
    }
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok || !body || body.appEnv !== 'staging') {
        throw new Error(`${API_BASE}/health answered HTTP ${res.status} appEnv=${body ? body.appEnv : '(no json)'} — not a staging server, refusing to seed`);
    }
    console.log(`${TAG} ${API_BASE}/health → appEnv=${body.appEnv} dbName=${body.dbName}`);
}

async function ensureCategories(restaurant) {
    const cats = [];
    let created = 0;
    for (let n = 1; n <= CATEGORIES; n++) {
        const name = `HEAVY-CAT-${n}`;
        let cat = await Category.findOne({ restaurant: restaurant._id, branch: null, name });
        if (!cat) {
            cat = await Category.create({ restaurant: restaurant._id, branch: null, name, kind: n % 4 === 0 ? 'beverages' : 'food', displayOrder: 100 + n, status: 'active' });
            created++;
        }
        cats.push(cat);
    }
    return { cats, created };
}

async function insertChunks(Model, docs, label) {
    let inserted = 0;
    for (let i = 0; i < docs.length; i += CHUNK) {
        const slice = docs.slice(i, i + CHUNK);
        try {
            const res = await Model.insertMany(slice, { ordered: false });
            inserted += res.length;
        } catch (err) {
            // ordered:false → duplicates (a concurrent run) are reported, the rest is inserted.
            const n = err && err.insertedDocs ? err.insertedDocs.length : 0;
            inserted += n;
            console.warn(`${TAG} ${label}: chunk ${i / CHUNK + 1} partially inserted (${n}/${slice.length}): ${err.message.slice(0, 200)}`);
        }
        process.stdout.write(`${TAG} ${label}: ${Math.min(i + CHUNK, docs.length)}/${docs.length}\r`);
    }
    if (docs.length) process.stdout.write('\n');
    return inserted;
}

async function ensureItems(restaurant, cats) {
    const existing = new Set((await MenuItem.find({ restaurant: restaurant._id, name: /^HEAVY-\d+$/ }).select('name').lean()).map((d) => d.name));
    const docs = [];
    for (let n = 1; n <= WANT_ITEMS; n++) {
        const name = `HEAVY-${n}`;
        if (existing.has(name)) continue;
        const basePrice = 50 + ((n * 37) % 450);
        const prepStation = n % 5 === 0 ? 'counter' : 'kitchen';
        docs.push({
            restaurant: restaurant._id,
            branch: null,
            category: cats[(n - 1) % cats.length]._id,
            name,
            description: `${name} — heavy-data item for the desktop stability checks`,
            vegType: n % 3 === 0 ? 'non-veg' : 'veg',
            basePrice,
            offerPercentage: 0,
            finalPrice: basePrice,            // pre('save') does not run under insertMany
            prepStation,
            prepTimeMinutes: prepStation === 'kitchen' ? 15 : 5,
            inStock: n % 2 === 0,             // half unavailable
            status: 'active',
            unit: 'plate',
            isFeatured: false,
        });
    }
    const inserted = await insertChunks(MenuItem, docs, 'items');
    return { existing: existing.size, inserted };
}

async function ensureOrders(restaurant, branch, users, tables, cats) {
    const existing = new Set((await Order.find({ restaurant: restaurant._id, orderId: /^HEAVY-ORD-\d+$/ }).select('orderId').lean()).map((d) => d.orderId));
    const items = await MenuItem.find({ restaurant: restaurant._id, name: /^HEAVY-\d+$/, inStock: true }).select('name finalPrice basePrice category vegType prepStation prepTimeMinutes').lean();
    if (!items.length) throw new Error('no HEAVY-* items to put on the orders (run with --items first)');
    const catById = new Map(cats.map((c) => [String(c._id), c]));
    const now = Date.now();
    const span = DAYS * 24 * 3600 * 1000;
    const docs = [];
    for (let n = 1; n <= WANT_ORDERS; n++) {
        const orderId = `HEAVY-ORD-${n}`;
        if (existing.has(orderId)) continue;
        // Even spread over the last DAYS days, oldest first, plus a deterministic jitter inside the slot.
        const createdAt = new Date(now - span + Math.floor(((n - 1) / Math.max(1, WANT_ORDERS)) * span) + ((n * 7919) % 3600) * 1000);
        const lineCount = 1 + (n % 3);
        const lines = [];
        for (let k = 0; k < lineCount; k++) {
            const it = items[(n * 31 + k * 17) % items.length];
            const cat = catById.get(String(it.category));
            lines.push({
                menuItem: String(it._id), name: it.name, price: it.finalPrice ?? it.basePrice, quantity: 1 + ((n + k) % 2),
                category: cat ? cat.name : '', categoryKind: cat ? cat.kind : '', vegType: it.vegType, prepStation: it.prepStation, prepTimeMinutes: it.prepTimeMinutes,
            });
        }
        const subtotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
        const gst = round2(subtotal * GST_PCT / 100);
        const total = round2(subtotal + gst);
        const takeaway = n % 4 === 0;
        const table = tables.length ? tables[n % tables.length] : null;
        const t = createdAt.getTime();
        docs.push({
            restaurant: restaurant._id,
            branch: branch ? branch._id : undefined,
            orderId,
            type: takeaway ? 'takeaway' : 'dine-in',
            source: 'staff',
            ...(takeaway ? { pickupLocation: branch ? branch.name : 'Main', pickupTime: '07:30 PM' } : (table ? { table: table._id } : {})),
            customerName: `Heavy Guest ${n}`,
            items: lines,
            subtotal, gst, gstPercentage: GST_PCT,
            serviceCharge: 0, serviceChargePercentage: 0, additionalCharges: [], additionalChargesTotal: 0,
            total,
            status: 'served',
            paymentStatus: 'Paid',
            paymentMethod: n % 2 ? 'Cash' : 'UPI',
            amountPaid: total,
            waiter: users.waiter ? users.waiter._id : undefined,
            chef: users.chef ? users.chef._id : undefined,
            preparationStartedAt: new Date(t + 2 * 60000),
            preparationCompletedAt: new Date(t + 18 * 60000),
            servedAt: new Date(t + 22 * 60000),
            paidAt: new Date(t + 35 * 60000),
            createdAt,
            updatedAt: new Date(t + 35 * 60000),
        });
    }
    const inserted = await insertChunks(Order, docs, 'orders');
    // Mongoose may stamp createdAt itself on insertMany; re-apply the spread if that happened.
    if (inserted) {
        const [agg] = await Order.aggregate([{ $match: { restaurant: restaurant._id, orderId: /^HEAVY-ORD-\d+$/ } }, { $group: { _id: null, min: { $min: '$createdAt' }, max: { $max: '$createdAt' } } }]);
        if (agg && agg.min && (now - agg.min.getTime()) < (span * 0.5)) {
            console.log(`${TAG} orders: createdAt was stamped by the model (min ${agg.min.toISOString()}); re-applying the ${DAYS}-day spread`);
            const ops = docs.map((d) => ({ updateOne: { filter: { restaurant: restaurant._id, orderId: d.orderId }, update: { $set: { createdAt: d.createdAt, updatedAt: d.updatedAt } }, timestamps: false } }));
            for (let i = 0; i < ops.length; i += CHUNK) await Order.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
        }
    }
    return { existing: existing.size, inserted };
}

async function main() {
    await assertStagingApi();
    console.log(`${TAG} connecting to ${MONGO_URL}`);
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 15000, family: 4 });
    const live = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
    assertStagingDb(live, 'scripts/staging-seed-heavy.js (connected)');
    if (mongoose.connection.name !== STAGING_DB_NAME) throw new Error(`connected to "${mongoose.connection.name}", expected ${STAGING_DB_NAME}`);

    const restaurant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!restaurant) throw new Error(`tenant "${TENANT_SLUG}" not found — run npm run seed:staging first`);
    const branch = (await Branch.findOne({ restaurant: restaurant._id, slug: 'main' })) || (await Branch.findOne({ restaurant: restaurant._id }));
    const users = {};
    for (const role of ['admin', 'waiter', 'chef']) users[role] = await User.findOne({ restaurant: restaurant._id, role }).select('_id');
    const tables = await Table.find({ restaurant: restaurant._id }).select('_id name').lean();
    console.log(`${TAG} tenant "${restaurant.name}" (${restaurant.slug}) id=${restaurant._id}; branch=${branch ? branch.name : '(none)'}; tables=${tables.length}`);

    const t0 = Date.now();
    const { cats, created: catsCreated } = await ensureCategories(restaurant);
    const items = await ensureItems(restaurant, cats);
    const orders = await ensureOrders(restaurant, branch, users, tables, cats);

    const counts = {
        heavyCategories: await Category.countDocuments({ restaurant: restaurant._id, name: /^HEAVY-CAT-\d+$/ }),
        heavyItems: await MenuItem.countDocuments({ restaurant: restaurant._id, name: /^HEAVY-\d+$/ }),
        heavyItemsUnavailable: await MenuItem.countDocuments({ restaurant: restaurant._id, name: /^HEAVY-\d+$/, inStock: false }),
        heavyOrders: await Order.countDocuments({ restaurant: restaurant._id, orderId: /^HEAVY-ORD-\d+$/ }),
        tenantCategories: await Category.countDocuments({ restaurant: restaurant._id }),
        tenantItems: await MenuItem.countDocuments({ restaurant: restaurant._id }),
        tenantOrders: await Order.countDocuments({ restaurant: restaurant._id }),
    };
    const [range] = await Order.aggregate([{ $match: { restaurant: restaurant._id, orderId: /^HEAVY-ORD-\d+$/ } }, { $group: { _id: null, min: { $min: '$createdAt' }, max: { $max: '$createdAt' } } }]);
    console.log(`${TAG} done in ${Date.now() - t0} ms — categories created ${catsCreated}; items: ${items.existing} existed, ${items.inserted} inserted; orders: ${orders.existing} existed, ${orders.inserted} inserted`);
    console.log(`${TAG} counts ${JSON.stringify({ ...counts, heavyOrderCreatedAt: range ? { min: range.min, max: range.max } : null })}`);
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(`\n${TAG} FAILED:`, err && err.message ? err.message : err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
