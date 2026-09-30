// TEMP QA setup — deletable WAITER with known password + 1 assigned area
// (Indoor), same branch as the QA captain, to test the waiter flow + that
// waiters are correctly BLOCKED from captain-only screens.
// Run: `node Seed/_qaWaiterSetup.js`  | cleanup: `... cleanup`.
const mongoose = require('mongoose');
require('dotenv').config();
const { defaultPermissionsForRole } = require('../utils/staffDefaults');

const TENANT = '69f2eaaa2cd4f64efe65d88e';
const BRANCH = '69f8300f24be77f6adbd9c75';
const AREA_INDOOR = '69f317ee597a7083ca37e9e6';
const EMAIL = 'qa.waiter@test.local';
const PASSWORD = 'Waiter@123';

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const User = require('../models/user');

    if (process.argv[2] === 'cleanup') {
        const r = await User.deleteOne({ email: EMAIL });
        console.log(`Cleanup: removed ${r.deletedCount} QA waiter(s).`);
        await mongoose.connection.close();
        return;
    }

    let user = await User.findOne({ email: EMAIL });
    if (!user) { user = new User({ name: 'QA Waiter', email: EMAIL, mobile: '9000000002' }); }
    user.password = PASSWORD;
    user.role = 'waiter';
    user.restaurant = TENANT;
    user.branch = BRANCH;
    user.assignedAreas = [AREA_INDOOR];
    user.assignedTables = [];
    user.permissions = defaultPermissionsForRole('waiter');
    user.status = 'active';
    user.mustChangePassword = false;
    user.isTenantOwner = false;
    await user.save();

    console.log('\n=== QA WAITER READY ===');
    console.log(`  email: ${EMAIL}  password: ${PASSWORD}`);
    console.log(`  area: Indoor only (should NOT see Floor Overview / captain screens)`);
    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
