/**
 * Provisions a temp Branch Admin for the playwright E2E test, prints
 * the credentials, and exits. Run `test-e2e-cleanup.js` afterwards to
 * remove the fixture.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');

const TENANT_SLUG = 'hotel-tip-top';
const TEMP_EMAIL = 'e2e-shift-test@bestodine.local';
const TEMP_PASSWORD = 'E2eShift!7Aa';
const TEMP_NAME = 'E2E Shift Test';

(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 30000, family: 4 });
    const tenant = await Restaurant.findOne({ slug: TENANT_SLUG });
    const mainBranch = await Branch.findOne({ restaurant: tenant._id, slug: 'main' });

    await User.deleteOne({ email: TEMP_EMAIL });            // any leftover from a prior run
    const tempStaffId = `EMP-${Date.now().toString().slice(-3)}`;
    const u = await User.create({
        name: TEMP_NAME,
        email: TEMP_EMAIL,
        password: TEMP_PASSWORD,
        role: 'admin',
        staffId: tempStaffId,
        restaurant: tenant._id,
        branch: mainBranch._id,
        status: 'active',
        mustChangePassword: false,
    });
    console.log(JSON.stringify({
        email: TEMP_EMAIL,
        password: TEMP_PASSWORD,
        userId: String(u._id),
        staffId: tempStaffId,
        tenantSlug: TENANT_SLUG,
        branchSlug: mainBranch.slug,
    }));
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(99); });
