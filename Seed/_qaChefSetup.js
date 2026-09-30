// TEMP QA setup — deletable CHEF with known password + manageRecipe perm,
// same tenant/branch as the QA waiter/captain, to test the recipe flow.
// Run: `node Seed/_qaChefSetup.js`  | cleanup: `... cleanup`.
const mongoose = require('mongoose');
require('dotenv').config();
const { defaultPermissionsForRole } = require('../utils/staffDefaults');

const TENANT = '69f2eaaa2cd4f64efe65d88e';
const BRANCH = '69f8300f24be77f6adbd9c75';
const EMAIL = 'qa.chef@test.local';
const PASSWORD = 'Chef@123';

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const User = require('../models/user');

    if (process.argv[2] === 'cleanup') {
        const r = await User.deleteOne({ email: EMAIL });
        console.log(`Cleanup: removed ${r.deletedCount} QA chef(s).`);
        await mongoose.connection.close();
        return;
    }

    let user = await User.findOne({ email: EMAIL });
    if (!user) { user = new User({ name: 'QA Chef', email: EMAIL, mobile: '9000000003' }); }
    user.password = PASSWORD;
    user.role = 'chef';
    user.restaurant = TENANT;
    user.branch = BRANCH;
    user.assignedAreas = [];
    user.assignedTables = [];
    user.permissions = defaultPermissionsForRole('chef');
    user.status = 'active';
    user.mustChangePassword = false;
    user.isTenantOwner = false;
    await user.save();

    console.log('\n=== QA CHEF READY ===');
    console.log(`  email: ${EMAIL}  password: ${PASSWORD}`);
    console.log(`  permissions.manageRecipe: ${user.permissions.manageRecipe}`);
    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
