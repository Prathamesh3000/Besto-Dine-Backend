// TEMP QA setup for Playwright — creates (or refreshes) a deletable captain
// with a KNOWN password + 2 assigned areas, in the populated hotel-tip-top
// branch, so we can exercise the captain area-scope + floor overview live.
// Run with `node Seed/_qaCaptainSetup.js`. Cleanup: `... cleanup`.
const mongoose = require('mongoose');
require('dotenv').config();
const { defaultPermissionsForRole } = require('../utils/staffDefaults');

const TENANT = '69f2eaaa2cd4f64efe65d88e';            // Hotel Tip Top
const BRANCH = '69f8300f24be77f6adbd9c75';            // populated branch
const AREA_INDOOR = '69f317ee597a7083ca37e9e6';       // Indoor
const AREA_AC = '69f31b61597a7083ca37eb00';           // AC Section
const EMAIL = 'qa.captain@test.local';
const PASSWORD = 'Captain@123';

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const User = require('../models/user');
    const Table = require('../models/table');
    const Order = require('../models/order');

    if (process.argv[2] === 'cleanup') {
        const r = await User.deleteOne({ email: EMAIL });
        console.log(`Cleanup: removed ${r.deletedCount} QA captain(s).`);
        await mongoose.connection.close();
        return;
    }

    let user = await User.findOne({ email: EMAIL });
    if (!user) {
        user = new User({ name: 'QA Captain', email: EMAIL, mobile: '9000000001' });
        console.log('Creating QA captain...');
    } else {
        console.log('Refreshing existing QA captain...');
    }
    user.password = PASSWORD;          // hashed by pre-save hook
    user.role = 'captain';
    user.restaurant = TENANT;
    user.branch = BRANCH;
    user.assignedAreas = [AREA_INDOOR, AREA_AC];
    user.assignedTables = [];          // captains use areas only
    user.permissions = defaultPermissionsForRole('captain');
    user.status = 'active';
    user.mustChangePassword = false;
    user.isTenantOwner = false;
    await user.save();

    // Report what's in those two areas so we know the test has real data.
    const tablesIndoor = await Table.countDocuments({ restaurant: TENANT, branch: BRANCH, area: AREA_INDOOR });
    const tablesAc = await Table.countDocuments({ restaurant: TENANT, branch: BRANCH, area: AREA_AC });
    const tableIds = (await Table.find({ restaurant: TENANT, branch: BRANCH, area: { $in: [AREA_INDOOR, AREA_AC] } }).select('_id').lean()).map(t => t._id);
    const activeOrders = await Order.countDocuments({ restaurant: TENANT, status: { $in: ['new', 'preparing', 'ready'] }, table: { $in: tableIds } });
    const takeaway = await Order.countDocuments({ restaurant: TENANT, branch: BRANCH, type: 'takeaway', status: { $in: ['new', 'preparing', 'ready'] } });

    console.log('\n=== QA CAPTAIN READY ===');
    console.log(`  email:    ${EMAIL}`);
    console.log(`  password: ${PASSWORD}`);
    console.log(`  tenant:   hotel-tip-top  branch: ${BRANCH}`);
    console.log(`  areas:    Indoor (${tablesIndoor} tables), AC Section (${tablesAc} tables)`);
    console.log(`  active orders in those areas: ${activeOrders}`);
    console.log(`  active takeaway in branch:    ${takeaway}`);

    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
