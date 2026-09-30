// TEMP comprehensive QA scenario for the takeaway / area-scope feature.
// Sets up multiple waiters + captains with varied assignments, plus dine-in
// and takeaway orders in several statuses, so we can test the full matrix.
//   node Seed/_qaScenario.js          → build scenario
//   node Seed/_qaScenario.js cleanup  → remove all QA staff + QA orders
const mongoose = require('mongoose');
require('dotenv').config();
const { defaultPermissionsForRole } = require('../utils/staffDefaults');

const TENANT = '69f2eaaa2cd4f64efe65d88e';   // Hotel Tip Top
const BRANCH = '69f8300f24be77f6adbd9c75';
const INDOOR = '69f317ee597a7083ca37e9e6';
const AC     = '69f31b61597a7083ca37eb00';
const PASS   = 'Test@123';

// role, email, name, areas[], handlesTakeaway
const STAFF = [
    ['waiter',  'qa.w.indoor@test.local',    'QA W Indoor',      [INDOOR],       false],
    ['waiter',  'qa.w.ac@test.local',        'QA W AC',          [AC],           false],
    ['waiter',  'qa.w.indoorta@test.local',  'QA W Indoor+TA',   [INDOOR],       true ],
    ['waiter',  'qa.w.catchall@test.local',  'QA W Catchall',    [],             false],
    ['captain', 'qa.c.indoor@test.local',    'QA C Indoor',      [INDOOR],       false],
    ['captain', 'qa.c.all@test.local',       'QA C All',         [],             false],
];

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const User = require('../models/user');
    const Table = require('../models/table');
    const Order = require('../models/order');

    const emails = STAFF.map(s => s[1]);

    if (process.argv[2] === 'cleanup') {
        const u = await User.deleteMany({ email: { $in: emails } });
        const o = await Order.deleteMany({ orderId: /^QA-/ });
        console.log(`Cleanup: removed ${u.deletedCount} staff, ${o.deletedCount} QA orders.`);
        await mongoose.connection.close();
        return;
    }

    // ── Staff ───────────────────────────────────────────────────────────
    let mobileSeq = 9100000010;
    for (const [role, email, name, areas, ta] of STAFF) {
        let u = await User.findOne({ email });
        if (!u) u = new User({ email, mobile: String(mobileSeq++) });
        u.name = name;
        u.password = PASS;
        u.role = role;
        u.restaurant = TENANT;
        u.branch = BRANCH;
        u.assignedAreas = areas;
        u.assignedTables = [];
        u.handlesTakeaway = ta;
        u.permissions = defaultPermissionsForRole(role);
        u.status = 'active';
        u.mustChangePassword = false;
        u.isTenantOwner = false;
        await u.save();
    }
    console.log(`Upserted ${STAFF.length} QA staff (password: ${PASS}).`);

    // ── Tables (need ids + mark occupied for the dine-in ones) ───────────
    const tables = await Table.find({ restaurant: TENANT, branch: BRANCH, name: { $in: ['IN-01', 'IN-02', 'AC-01', 'AC-02'] } });
    const tById = {};
    tables.forEach(t => { tById[t.name] = t; });

    // ── Orders — wipe prior QA orders, recreate ─────────────────────────
    await Order.deleteMany({ orderId: /^QA-/ });
    const item = (name, price) => ({ name, price, quantity: 1, prepStation: 'kitchen' });
    const mk = (orderId, extra) => ({
        orderId, restaurant: TENANT, branch: BRANCH, total: 250,
        items: [item('Paneer Tikka', 250)], paymentStatus: 'Paid',
        customerName: 'QA Diner', ...extra,
    });

    const dineSpecs = [
        ['QA-DINE-IN01', 'IN-01', 'new'],
        ['QA-DINE-IN02', 'IN-02', 'ready'],
        ['QA-DINE-AC01', 'AC-01', 'preparing'],
        ['QA-DINE-AC02', 'AC-02', 'ready'],
    ];
    for (const [orderId, tname, status] of dineSpecs) {
        const t = tById[tname];
        if (!t) { console.log(`  ! table ${tname} not found, skipping ${orderId}`); continue; }
        await Order.create(mk(orderId, { type: 'dine-in', table: t._id, status }));
        if (t.status !== 'occupied') { t.status = 'occupied'; await t.save(); }
    }

    // Takeaway (no table) — branch-routed.
    await Order.create(mk('QA-TA-NEW', { type: 'takeaway', status: 'new', pickupLocation: 'Counter' }));
    await Order.create(mk('QA-TA-READY', { type: 'takeaway', status: 'ready', pickupLocation: 'Counter' }));

    console.log('Created 4 dine-in (IN-01 new, IN-02 ready, AC-01 preparing, AC-02 ready) + 2 takeaway (new, ready).');
    console.log('\n=== EXPECTED VISIBILITY MATRIX ===');
    console.log('  QA W Indoor      → Indoor dine-in only,  NO takeaway');
    console.log('  QA W AC          → AC dine-in only,      NO takeaway');
    console.log('  QA W Indoor+TA   → Indoor dine-in,       takeaway YES');
    console.log('  QA W Catchall    → all areas dine-in,    takeaway YES');
    console.log('  QA C Indoor      → Indoor (floor), takeaway YES (supervisor)');
    console.log('  QA C All         → all areas (floor), takeaway YES (supervisor)');
    console.log('  login password for all: ' + PASS);

    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
