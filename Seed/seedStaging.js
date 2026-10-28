/**
 * seedStaging.js — build the "Staging Cafe" tenant from scratch.
 *
 *   npm run seed:staging          (loads .env.staging, then runs this file)
 *
 * DESTRUCTIVE and idempotent: it DROPS the whole database and recreates
 * everything, so re-running always yields the same known state. That is
 * only acceptable because utils/stagingGuard.assertStagingDb() refuses
 * every MONGO_URL that is not the local staging database (db name
 * `bestodine_staging`, local host, never the production cluster) — the
 * check runs before mongoose even connects, and again on the live
 * connection before dropDatabase.
 *
 * What gets created
 *   plans        the public Silver / Gold / Premium / Enterprise line-up
 *                (config/planLineup.js), so the super-admin screens work
 *   tenant       "Staging Cafe" (slug staging-cafe) on Premium with every
 *                feature switched on and an ACTIVE subscription — no
 *                feature gate blocks any admin screen
 *   branch       the auto "Main" branch (utils/createMainBranch)
 *   settings     GST 5 %, service charge 0 (disabled), no extra charges,
 *                printers disabled; operations profile left absent
 *   users        admin / waiter / chef / captain (tenant staff) + one customer,
 *                all active, mustChangePassword: false, password Staging@123
 *   data         2 areas, 8 tables (QR tokens), 4 categories, 12 menu
 *                items, 5 orders in mixed statuses (incl. Paid + preparing),
 *                1 coupon, 3 notifications
 *
 * Table / QR helpers are reused from the integration-test seed
 * (__tests__/integration/helpers/seed.js) — plain Mongoose code with no
 * Jest dependency. Users go through User.create so the model's
 * pre('save') hook hashes the password exactly like the real signup path.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// 1. Guard FIRST — before any model, before any connection.
const { assertStagingDb, STAGING_DB_NAME } = require('../utils/stagingGuard');
const MONGO_URL = assertStagingDb(process.env.MONGO_URL, 'Seed/seedStaging.js');

// Register every model so indexes (unique email-per-tenant, qrToken, …)
// exist before we insert — same idea as the integration helpers' initModels.
const MODELS_DIR = path.join(__dirname, '..', 'models');
for (const file of fs.readdirSync(MODELS_DIR)) {
    if (file.endsWith('.js')) require(path.join(MODELS_DIR, file));
}

const Restaurant = require('../models/restaurant');
const SubscriptionPlan = require('../models/subscriptionPlan');
const Settings = require('../models/settings');
const Area = require('../models/area');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');
const Table = require('../models/table');
const User = require('../models/user');
const Order = require('../models/order');
const Coupon = require('../models/coupon');
const Notification = require('../models/notification');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { defaultPermissionsForRole } = require('../utils/staffDefaults');
const idGen = require('../utils/idGenerator');
const { LINEUP } = require('../config/planLineup');
// Reused from the integration suite: createTable() mints a unique QR token
// and returns the table WITH its (select:false) qrToken.
const { createTable } = require('../__tests__/integration/helpers/seed');

const TENANT = { name: 'Staging Cafe', slug: 'staging-cafe' };
const PASSWORD = 'Staging@123';
const LOGINS = [
    { role: 'admin',    email: 'admin@staging.bestodine.test',    name: 'Staging Admin' },
    { role: 'waiter',   email: 'waiter@staging.bestodine.test',   name: 'Staging Waiter' },
    { role: 'chef',     email: 'chef@staging.bestodine.test',     name: 'Staging Chef' },
    { role: 'captain',  email: 'captain@staging.bestodine.test',  name: 'Staging Captain' },
    { role: 'customer', email: 'customer@staging.bestodine.test', name: 'Staging Customer' },
];

const GST_PCT = 5;
const round2 = (n) => Math.round(n * 100) / 100;

/** Every boolean plan feature on + the top analytics tier. */
function allFeatures() {
    const features = Object.fromEntries(SubscriptionPlan.FEATURE_KEYS.map((k) => [k, true]));
    features.revenueAnalytics = 'advanced';
    return features;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a command while the replica set is still finishing a drop
 * (code 215 DatabaseDropPending) — on a replica set dropDatabase is
 * committed asynchronously and creates against the same db briefly fail.
 */
async function whileDropPending(fn, label) {
    for (let attempt = 0; ; attempt++) {
        try { return await fn(); } catch (err) {
            if (err?.code !== 215 || attempt >= 50) throw err;
            if (attempt === 0) console.log(`[seedStaging] waiting for the drop to finish (${label}) ...`);
            await sleep(200);
        }
    }
}

/**
 * Create every registered model's collection and build its indexes.
 * The connection is opened with autoIndex:false so nothing builds indexes
 * behind our back while the database is being dropped; indexes are built
 * explicitly here instead.
 */
async function initModels() {
    for (const name of mongoose.modelNames()) {
        const model = mongoose.model(name);
        await whileDropPending(async () => {
            try { await model.createCollection(); } catch (err) {
                if (err?.codeName !== 'NamespaceExists') throw err;
            }
        }, name);
        await whileDropPending(() => model.createIndexes(), `${name} indexes`);
    }
}

async function seedPlans() {
    const plans = {};
    for (const p of LINEUP) {
        plans[p.slug] = await SubscriptionPlan.findOneAndUpdate(
            { slug: p.slug },
            { $set: { ...p, isActive: true } },
            { upsert: true, returnDocument: 'after' },
        );
    }
    return plans;
}

async function seedTenant(plan) {
    const now = new Date();
    const restaurant = await Restaurant.create({
        name: TENANT.name,
        slug: TENANT.slug,
        contactEmail: LOGINS[0].email,
        contactPhone: '9000000001',
        city: 'Pune',
        status: 'active',
        signupSource: 'admin',
        signupStatus: 'approved',
        paymentStatus: 'na',
        subscription: {
            plan: plan._id,
            planName: plan.name,
            planSlug: plan.slug,
            price: plan.price,
            startDate: now,
            endDate: null,
            trialEndDate: null,
            status: 'active',
            features: allFeatures(),
            limits: plan.limits?.toObject ? plan.limits.toObject() : { ...plan.limits },
            currentPeriodEnd: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
        },
        // `operations` intentionally absent → default behaviour.
    });
    const branch = await createMainBranchFor(restaurant);
    const settings = await Settings.create({
        restaurant: restaurant._id,
        branch: null,
        general: {
            cafeName: TENANT.name,
            contactNumber: '9000000001',
            email: LOGINS[0].email,
            address: '1 Test Street, Pune',
            addressDetails: { line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', pincode: '411001', country: 'India' },
        },
        taxes: {
            gst: { enabled: true, value: GST_PCT },
            serviceCharge: { enabled: false, value: 0 },
            additionalCharges: [],
        },
        printers: { enabled: false, list: [] },
    });
    return { restaurant, branch, settings };
}

async function seedUsers({ restaurant, branch }) {
    const users = {};
    for (const login of LOGINS) {
        const isStaff = login.role !== 'customer';
        const isAdmin = login.role === 'admin';
        const doc = {
            name: login.name,
            email: login.email,
            password: PASSWORD,                // hashed by User pre('save')
            role: login.role,
            status: 'active',
            mustChangePassword: false,
            authProviders: ['password'],
        };
        if (isStaff) {
            doc.restaurant = restaurant._id;
            doc.branch = isAdmin ? null : branch._id;   // owner stays unpinned
            doc.isTenantOwner = isAdmin;
            doc.permissions = isAdmin ? {} : defaultPermissionsForRole(login.role);
            doc.staffId = `EMP-00${LOGINS.indexOf(login) + 1}`;
            if (login.role === 'chef') doc.kitchenResponsibility = 'both';
            if (login.role === 'waiter') doc.handlesTakeaway = true;
        } else {
            doc.mobile = '9876543210';
        }
        users[login.role] = await User.create(doc);
    }
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { owner: users.admin._id } });
    return users;
}

async function seedFloor(tenant) {
    const { restaurant, branch } = tenant;
    const indoor = await Area.create({ restaurant: restaurant._id, branch: branch._id, name: 'Indoor', description: 'Air-conditioned hall' });
    const terrace = await Area.create({ restaurant: restaurant._id, branch: branch._id, name: 'Terrace', description: 'Open-air seating' });
    const plan = [
        ['T1', indoor, 2], ['T2', indoor, 4], ['T3', indoor, 4], ['T4', indoor, 6], ['T5', indoor, 8],
        ['T6', terrace, 2], ['T7', terrace, 4], ['T8', terrace, 6],
    ];
    const tables = [];
    for (const [name, area, capacity] of plan) {
        tables.push(await createTable(tenant, { name, capacity, branch: branch._id, area: area._id }));
    }
    return { areas: [indoor, terrace], tables };
}

const MENU = [
    // [category, name, vegType, basePrice, prepStation, extra]
    ['Starters', 'Paneer Tikka',        'veg',     220, 'kitchen', { isFeatured: true }],
    ['Starters', 'Chicken 65',          'non-veg', 260, 'kitchen', {}],
    ['Starters', 'Veg Spring Rolls',    'veg',     180, 'kitchen', { offerPercentage: 10 }],
    ['Mains',    'Dal Makhani',         'veg',     240, 'kitchen', {}],
    ['Mains',    'Butter Chicken',      'non-veg', 340, 'kitchen', { isFeatured: true }],
    ['Mains',    'Mutton Rogan Josh',   'non-veg', 420, 'kitchen', { inStock: false }],
    ['Mains',    'Veg Biryani',         'veg',     260, 'kitchen', { sizes: [{ name: 'Half', price: 160 }, { name: 'Full', price: 260 }] }],
    ['Breads',   'Butter Naan',         'veg',      50, 'kitchen', {}],
    ['Breads',   'Garlic Naan',         'veg',      60, 'kitchen', {}],
    ['Beverages','Masala Chai',         'veg',      40, 'counter', {}],
    ['Beverages','Cold Coffee',         'veg',     120, 'counter', { offerPercentage: 15 }],
    ['Beverages','Fresh Lime Soda',     'veg',      80, 'bar',     { status: 'draft' }],
];

async function seedMenu({ restaurant }) {
    const categories = {};
    const defs = [['Starters', 'food'], ['Mains', 'food'], ['Breads', 'food'], ['Beverages', 'beverages']];
    for (const [i, [name, kind]] of defs.entries()) {
        categories[name] = await Category.create({ restaurant: restaurant._id, branch: null, name, kind, displayOrder: i + 1 });
    }
    const items = [];
    for (const [cat, name, vegType, basePrice, prepStation, extra] of MENU) {
        items.push(await MenuItem.create({
            restaurant: restaurant._id,
            branch: null,
            category: categories[cat]._id,
            name,
            description: `${name} — staging demo item`,
            vegType,
            basePrice,
            prepStation,
            prepTimeMinutes: prepStation === 'kitchen' ? 20 : 5,
            inStock: true,
            status: 'active',
            ...extra,
        }));
    }
    return { categories, items };
}

/** Build an order document with a GST-only bill (service charge 0). */
function buildOrder({ restaurant, branch, users, categories }, table, lines, overrides) {
    const items = lines.map(([item, quantity]) => ({
        menuItem: String(item._id),
        name: item.name,
        price: item.finalPrice ?? item.basePrice,
        quantity,
        category: Object.values(categories).find((c) => String(c._id) === String(item.category))?.name || '',
        categoryKind: Object.values(categories).find((c) => String(c._id) === String(item.category))?.kind || '',
        vegType: item.vegType,
        prepStation: item.prepStation,
        prepTimeMinutes: item.prepTimeMinutes,
    }));
    const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
    const gst = round2(subtotal * GST_PCT / 100);
    return {
        restaurant: restaurant._id,
        branch: branch._id,
        orderId: idGen.orderId(),
        type: 'dine-in',
        source: 'staff',
        table: table?._id,
        customerName: 'Walk-in Guest',
        items,
        subtotal,
        gst,
        gstPercentage: GST_PCT,
        serviceCharge: 0,
        serviceChargePercentage: 0,
        additionalCharges: [],
        additionalChargesTotal: 0,
        total: round2(subtotal + gst),
        waiter: users.waiter._id,
        ...overrides,
    };
}

async function seedOrders(tenant, { items, tables }) {
    const by = (name) => items.find((i) => i.name === name);
    const now = Date.now();
    const ago = (min) => new Date(now - min * 60 * 1000);

    const specs = [
        // Paid + served: the "done" order.
        { table: tables[0], lines: [[by('Paneer Tikka'), 1], [by('Butter Naan'), 2], [by('Masala Chai'), 2]],
          o: { status: 'served', paymentStatus: 'Paid', paymentMethod: 'Cash', servedAt: ago(90), paidAt: ago(80), customerName: 'Asha Rao',
               chef: tenant.users.chef._id, preparationStartedAt: ago(110), preparationCompletedAt: ago(95) } },
        // Preparing in the kitchen.
        { table: tables[1], lines: [[by('Butter Chicken'), 1], [by('Garlic Naan'), 3]],
          o: { status: 'preparing', paymentStatus: 'Pending', chef: tenant.users.chef._id, preparationStartedAt: ago(8) } },
        // Freshly placed.
        { table: tables[6], lines: [[by('Dal Makhani'), 2], [by('Veg Biryani'), 1]],
          o: { status: 'new', paymentStatus: 'Pending', customerName: 'Vikram S', phone: '9876500001' } },
        // Ready to serve.
        { table: tables[3], lines: [[by('Chicken 65'), 1], [by('Cold Coffee'), 2]],
          o: { status: 'ready', paymentStatus: 'Pending', chef: tenant.users.chef._id, preparationStartedAt: ago(25), preparationCompletedAt: ago(3) } },
        // Cancelled.
        { table: tables[7], lines: [[by('Veg Spring Rolls'), 1]],
          o: { status: 'cancelled', paymentStatus: 'Pending', cancelReason: 'customer-cancel', cancelledAt: ago(40), cancelledBy: tenant.users.waiter._id } },
    ];

    const orders = [];
    for (const spec of specs) {
        const order = await Order.create(buildOrder(tenant, spec.table, spec.lines, spec.o));
        orders.push(order);
        // Live orders occupy their table; served / cancelled ones leave it free.
        if (['new', 'preparing', 'ready'].includes(order.status)) {
            await Table.updateOne({ _id: spec.table._id }, { $set: { status: 'occupied', activeOrder: order._id, assignedWaiter: tenant.users.waiter._id } });
        }
    }
    // Backdate createdAt so the list has a sensible timeline.
    await Promise.all(orders.map((o, i) => Order.updateOne({ _id: o._id }, { $set: { createdAt: ago([120, 15, 2, 30, 45][i]) } }, { timestamps: false })));
    return orders;
}

async function seedOffers({ restaurant }) {
    const year = 365 * 24 * 3600 * 1000;
    return Coupon.create({
        restaurant: restaurant._id,
        branch: null,
        code: 'STAGING10',
        title: '10% off your bill',
        description: 'Staging demo coupon — 10% off orders above ₹300, max ₹100.',
        discountType: 'percentage',
        discountValue: 10,
        minOrderValue: 300,
        maxDiscountAmount: 100,
        startDate: new Date(Date.now() - 24 * 3600 * 1000),
        endDate: new Date(Date.now() + year),
        usageLimit: 1000,
        usagePerUser: 5,
        isActive: true,
        couponCategory: 'all',
        scope: 'all',
    });
}

async function seedNotifications({ restaurant, branch, users }, orders) {
    const paid = orders.find((o) => o.paymentStatus === 'Paid');
    const prep = orders.find((o) => o.status === 'preparing');
    return Notification.insertMany([
        { restaurant: restaurant._id, branch: branch._id, recipientRole: 'admin', category: 'Order', priority: 'medium',
          title: 'New order placed', description: `Order ${prep.orderId} is being prepared.`, meta: { orderId: prep.orderId, table: 'T2' } },
        { restaurant: restaurant._id, branch: branch._id, recipientRole: 'admin', category: 'Payment', priority: 'low',
          title: 'Payment received', description: `₹${paid.total} received in cash for ${paid.orderId}.`, meta: { orderId: paid.orderId, amount: paid.total, table: 'T1' } },
        { restaurant: restaurant._id, branch: branch._id, recipient: users.customer._id, recipientRole: 'customer', category: 'Offer', priority: 'low',
          title: 'Welcome to Staging Cafe', description: 'Use STAGING10 for 10% off your first order.' },
    ]);
}

async function main() {
    console.log(`[seedStaging] connecting to ${MONGO_URL}`);
    // autoIndex:false — index builds are done explicitly in initModels(),
    // AFTER the drop, instead of racing it in the background.
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 15000, family: 4, autoIndex: false });

    // 2. Guard again on the LIVE connection (host + db name actually in use).
    const live = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
    assertStagingDb(live, 'Seed/seedStaging.js (connected)');
    if (mongoose.connection.name !== STAGING_DB_NAME) throw new Error(`connected to "${mongoose.connection.name}", expected ${STAGING_DB_NAME}`);

    console.log(`[seedStaging] dropping database "${mongoose.connection.name}" on ${mongoose.connection.host}:${mongoose.connection.port}`);
    await mongoose.connection.db.dropDatabase();
    await initModels();

    const plans = await seedPlans();
    console.log(`[seedStaging] plans: ${Object.keys(plans).join(', ')}`);

    const tenant = await seedTenant(plans.premium);
    console.log(`[seedStaging] tenant "${tenant.restaurant.name}" (${tenant.restaurant.slug}) id=${tenant.restaurant._id}, main branch id=${tenant.branch._id}`);

    tenant.users = await seedUsers(tenant);
    tenant.area = { _id: null }; // createTable() default — every call below passes an explicit area
    const floor = await seedFloor(tenant);
    const menu = await seedMenu(tenant);
    tenant.categories = menu.categories;
    const orders = await seedOrders(tenant, { items: menu.items, tables: floor.tables });
    const coupon = await seedOffers(tenant);
    const notifications = await seedNotifications(tenant, orders);

    console.log(`[seedStaging] areas=${floor.areas.length} tables=${floor.tables.length} categories=${Object.keys(menu.categories).length} items=${menu.items.length} orders=${orders.length} coupons=1 notifications=${notifications.length}`);
    console.log('\nOrders:');
    console.table(orders.map((o) => ({ orderId: o.orderId, status: o.status, payment: o.paymentStatus, total: o.total })));
    console.log('Tables (QR tokens):');
    console.table(floor.tables.map((t) => ({ table: t.name, capacity: t.capacity, qrToken: t.qrToken })));
    console.log(`Coupon: ${coupon.code} (${coupon.discountValue}% off, min ₹${coupon.minOrderValue})`);

    console.log('\nLogins (tenant slug: staging-cafe, password for all: Staging@123):');
    console.table(LOGINS.map((l) => ({ role: l.role, email: l.email, password: PASSWORD })));
    console.log(`API: http://localhost:${process.env.PORT || 5001}/api/v1  —  staff login header X-Restaurant-Slug: ${TENANT.slug}`);

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error('\n[seedStaging] FAILED:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
